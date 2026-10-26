//! Join islands into nets, the way paper-model unfolders do. Blender's Paper Model add-on joins faces edge by
//! edge, flattest edges first (concave ones penalised), refusing any join that would overlap. Here the units
//! are whole islands, already flat: a join only turns and moves the child so it hangs off its parent along one
//! shared edge, so it never adds stretch. Growth is Prim-like from the biggest island: flattest hinge first,
//! then nearest the root, so ties grow breadth-first and nets come out compact (a cube's faces make the cross,
//! a cylinder's caps hang off the middle of its strip).
//!
//!
//! Two islands flattened apart rarely have matching edges along a long shared border, so a rigid hinge there
//! overlaps a little away from the hinge. Then the child is laid out again as a book page (`chart::book`): flattened
//! with its copy of one unbroken stretch of that border (the straightest long one that works; gluing every stretch
//! could close a tube) pinned onto the parent's, so it opens out on the far side of that spine. A flank, the strip
//! along its top and the other flank come out as one book-like net (the flanks "butterflied").
use crate::chart::{book, Island};
use crate::mesh::*;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// One edge two islands share: its local endpoints in the parent (la→lb), where that edge sits along the
/// parent's border, and the matching endpoints in the child.
#[derive(Clone, Copy)]
struct Hinge { la: u32, lb: u32, ja: u32, jb: u32, len: f64, pos: usize }

type Seg = [f64; 4];

/// How many books and fills one part's islands may take before joining runs once more as is.
const STITCHES: usize = 96;
/// An island under this share of its part's area that can't hang is an orphan, filled back into its neighbour.
/// How much longer one copy of a shared border may be than the other before a rigid hinge would stretch it.
const HINGE_DENSITY: f64 = 1.05;
const ORPHAN: f64 = 0.03;
/// Least share of an orphan's outline (holes too) it must share with one bigger island to be filled into it first.
const ENCLOSED: f64 = 0.5;
/// An island whose area is under this share of a disc's with its outline's length (4πA/P²) is a sliver: filled into
/// whatever it shares an edge with.
const SLIVER: f64 = 0.05;
/// An orphan thinner than this share of √(part area) (mean width 2A/P) is too narrow to carry texture detail: like a
/// hidden one, it's worth more as part of a neighbour (paint and bakes run on across, one seam fewer) than on its own,
/// so it's filled into any neighbour it shares an edge with. (Atlas space isn't the reason: the packer drops small
/// islands into gaps, and shrinking every net under 1% of a gun part to nothing freed none.)
const THIN: f64 = 0.012;
/// Least share of the part's area each of two islands must have to be stitched.
const STITCH_AREA: f64 = 0.05;
/// Least share of the smaller island's outline a border must make up to be stitched.
const STITCH_SHARE: f64 = 0.2;

/// Returns each island's net (dense ids) and rewrites the joined islands' UVs into their net's frame. Stitched
/// islands become one (see the module notes), so `isl` can come back shorter.
pub fn join(m: &Mesh, isl: &mut Vec<Island>, tol: f64) -> Vec<usize> {
    // what was tried already, so a restart doesn't try it again: a page per pair of islands (by first triangle, which
    // stays as they grow), a fill per orphan (by first triangle and size)
    let mut tried: Set<[(u32, usize); 2]> = Set::default();
    for _ in 0..STITCHES {
        match join_once(m, isl, Some((tol, &mut tried))) {
            Ok(net) => return net,
            Err(merges) => {
                // each parent and child turns up once a pass: apply them all, then drop the children
                let mut gone = Set::default();
                for (i, j, both) in merges {
                    isl[i] = both;
                    gone.insert(j);
                }
                let mut k = 0;
                isl.retain(|_| { k += 1; !gone.contains(&(k - 1)) });
            }
        }
    }
    join_once(m, isl, None).unwrap_or_default()
}

/// One joining pass. With `redo` (the stretch tolerance and the pairs already tried), collects the rejected joins
/// that a book or a fill fixes, at most one per island: Err(parent, child, the two as one island) for each. A book
/// changes the net's shape, so the pass stops at the first.
#[allow(clippy::type_complexity)]
fn join_once(m: &Mesh, isl: &mut [Island], mut redo: Option<(f64, &mut Set<[(u32, usize); 2]>)>) -> Result<Vec<usize>, Vec<(usize, usize, Island)>> {
    let n = isl.len();
    if n < 2 { return Ok(vec![0; n]); }
    let (mut merges, mut busy): (Vec<(usize, usize, Island)>, Set<usize>) = (Vec::new(), Set::default());
    let mut owner = vec![usize::MAX; m.f.len()];
    for (i, s) in isl.iter().enumerate() { for &t in &s.l.tris { owner[t as usize] = i; } }

    // border edges by welded key: (island, local a, local b) as that island winds it, where along its outline (holes'
    // edges past the end: they glue, they don't hang)
    let mut border: Map<u64, Vec<(usize, u32, u32, usize)>> = Map::default();
    let mut edge_len = (0., 0usize);
    for (i, s) in isl.iter().enumerate() {
        let n0 = s.l.loops[0].len();
        for (h, lp) in s.l.loops.iter().enumerate() {
            for k in 0..lp.len() {
                let (la, lb) = (lp[k], lp[(k + 1) % lp.len()]);
                let (a, b) = (s.l.orig[la as usize], s.l.orig[lb as usize]);
                border.entry(ek(a, b)).or_default().push((i, la, lb, if h == 0 { k } else { n0 }));
                edge_len = (edge_len.0 + dist(m.pt(a), m.pt(b)), edge_len.1 + 1);
            }
        }
    }
    let mean_edge = edge_len.0 / edge_len.1.max(1) as f64;
    let mut pairs: Map<(usize, usize), (Vec<Hinge>, f64)> = Map::default();
    // every edge two islands share, holes' included: what a fill glues
    let mut glued: Map<(usize, usize), Vec<Hinge>> = Map::default();
    let mut keys: Vec<&u64> = border.keys().collect();
    keys.sort();
    for key in keys {
        let list = &border[key];
        if list.len() != 2 || list[0].0 == list[1].0 { continue; }
        let tri = |i: usize| m.edges[key].iter().copied().find(|&t| owner[t as usize] == i);
        for (x, y) in [(list[0], list[1]), (list[1], list[0])] {
            let (i, la, lb, pos) = x;
            let (j, p, q, jpos) = y;
            let (a, b) = (isl[i].l.orig[la as usize], isl[i].l.orig[lb as usize]);
            // j winds the edge the other way: its p is our b
            let (ja, jb) = if isl[j].l.orig[p as usize] == a { (p, q) } else { (q, p) };
            let (Some(ti), Some(tj)) = (tri(i), tri(j)) else { continue };
            let (ni, nj) = (m.n[ti as usize], m.n[tj as usize]);
            let angle = dot(ni, nj).clamp(-1., 1.).acos();
            let convex = dot(sub(m.centroid(tj), m.centroid(ti)), ni) < 0.;
            let cost = if convex { 0.5 } else { 1. } * angle / std::f64::consts::PI;
            let h = Hinge { la, lb, ja, jb, len: dist(m.pt(a), m.pt(b)), pos };
            glued.entry((i, j)).or_default().push(h);
            if pos == isl[i].l.loops[0].len() || jpos == isl[j].l.loops[0].len() { continue; }
            let e = pairs.entry((i, j)).or_default();
            e.0.push(h);
            e.1 += cost;
        }
    }
    let mut nbrs: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut ordered: Vec<&(usize, usize)> = pairs.keys().collect();
    ordered.sort();
    for &(i, j) in ordered { nbrs[i].push(j); }

    let tol = mean_edge * 1e-4;
    let cell = mean_edge * 4.;
    let mut interior: Vec<(f64, f64)> = isl.iter().map(|s| {
        let i = (0..s.l.t.len()).max_by(|&x, &y| tri_area(s, x).total_cmp(&tri_area(s, y))).unwrap();
        let t = s.l.t[i].map(|q| q as usize);
        ((s.f.u[t[0]] + s.f.u[t[1]] + s.f.u[t[2]]) / 3., (s.f.v[t[0]] + s.f.v[t[1]] + s.f.v[t[2]]) / 3.)
    }).collect();

    let part_area: f64 = isl.iter().flat_map(|s| s.l.tris.iter()).map(|&t| m.a[t as usize]).sum();
    let mut order: Vec<usize> = (0..n).collect();
    let area = |s: &Island| s.l.tris.iter().map(|&t| m.a[t as usize]).sum::<f64>();
    order.sort_by(|&x, &y| area(&isl[y]).total_cmp(&area(&isl[x])).then(x.cmp(&y)));
    // Orphans first: a small island lying in a notch or a hole of a bigger one (a groove wall carved off its face, a
    // sliver left between cuts) goes back in, pinned along every edge they share, before anything hangs. Hung by
    // one edge it would leave the notch open: a slit in the face.
    if let Some((stretch, tried)) = redo.as_mut() {
        let around = |s: &Island| s.l.loops.iter().flat_map(|lp| (0..lp.len()).map(move |k| (lp[k], lp[(k + 1) % lp.len()])))
            .map(|(a, b)| dist(m.pt(s.l.orig[a as usize]), m.pt(s.l.orig[b as usize]))).sum::<f64>();
        let key = |s: &Island| (s.l.tris[0], s.l.tris.len());
        for &j in order.iter().rev() {
            if area(&isl[j]) >= ORPHAN * part_area || busy.contains(&j) { continue; }
            let shared = |i: usize| glued.get(&(i, j)).map_or(0., |hs| hs.iter().map(|h| h.len).sum::<f64>());
            let Some(i) = (0..n).filter(|&i| area(&isl[i]) > area(&isl[j])).max_by(|&x, &y| shared(x).total_cmp(&shared(y))) else { continue };
            // in a notch (most of its outline shared), or a sliver (far thinner than it is long) along any shared edge
            let (a, p) = (area(&isl[j]), around(&isl[j]));
            let sliver = 4. * std::f64::consts::PI * a < SLIVER * p * p && shared(i) > 0.;
            // or worth no texels of its own: hidden inside the model, or too thin to hold detail (a groove wall, a bevel
            // strip): any shared edge will do
            let hidden = m.hidden.get().is_some_and(|h| isl[j].l.tris.iter().filter(|&&t| h[t as usize]).count() * 2 > isl[j].l.tris.len());
            let idle = (hidden || 2. * a / p < THIN * part_area.sqrt()) && shared(i) > 0.;
            if busy.contains(&i) || (shared(i) < ENCLOSED * p && !sliver && !idle) || !tried.insert([(u32::MAX - 1, 0), key(&isl[j])]) { continue; }
            let glue: Vec<(u32, u32)> = glued[&(i, j)].iter().flat_map(|h| [(h.la, h.ja), (h.lb, h.jb)]).collect();
            if let Some(both) = book(m, &isl[i], &isl[j], &glue, *stretch, false) {
                busy.extend([i, j]);
                merges.push((i, j, both));
            }
        }
        if !merges.is_empty() { return Err(merges); }
    }
    let (mut net, mut nets) = (vec![usize::MAX; n], 0);
    for &root in &order {
        if net[root] != usize::MAX { continue; }
        let g = nets;
        nets += 1;
        net[root] = g;
        let mut grid: Map<(i64, i64), Vec<Seg>> = Map::default();
        let mut members = vec![root];
        // compactness: the net's own area, and its outline points for the convex hull
        let mut net_area = uv_area(&isl[root]);
        let mut pts: Vec<(f64, f64)> = outline(&isl[root], None).iter().map(|s| (s[0], s[1])).collect();
        add_segs(&mut grid, cell, &outline(&isl[root], None));
        let mut heap = BinaryHeap::new();
        let push = |heap: &mut BinaryHeap<_>, net: &[usize], i: usize, depth: i64| {
            for &j in &nbrs[i] {
                if net[j] != usize::MAX { continue; }
                let (hs, cost) = &pairs[&(i, j)];
                let len: f64 = hs.iter().map(|h| h.len).sum();
                // Flattest first (in steps of ~4°, so near-equal folds tie), then the longest shared border: a
                // join is worth the seam it removes, so a flank opens onto the long strip along its top, not onto a
                // short strap. Ties then grow breadth-first. Rounded, so float noise can't decide.
                let c = (cost / hs.len() as f64 * 50.).round() as i64;
                heap.push(Reverse((c, -(len / mean_edge).round() as i64, depth, j, i)));
            }
        };
        push(&mut heap, &net, root, 1);
        while let Some(Reverse((_, _, depth, j, i))) = heap.pop() {
            if net[j] != usize::MAX { continue; }
            let Some((u, v)) = hang(&isl[i], &isl[j], &pairs[&(i, j)].0) else { continue };
            // The two copies of the shared border have to be the same length: hanging the child rigidly on a
            // border that is 5% longer stretches (or shrinks) it along the seam, and one atlas scale can't hide
            // that. A pair that close still gives, through `book`, which lays the child out against the spine.
            let (hs, _) = &pairs[&(i, j)];
            let (pa, ch) = (border_uv(&isl[i], hs, 0), border_uv(&isl[j], hs, 1));
            if pa > 0. && ch > 0. && pa.max(ch) > HINGE_DENSITY * pa.min(ch) { continue; }
            let seg = outline(&isl[j], Some((&u, &v)));
            let pt = transform_point(&isl[j], &u, &v, interior[j]);
            if crosses(&grid, cell, &seg, tol) || members.iter().any(|&k| contains(&isl[k], interior[k], &seg, pt)) {
                // a long shared border (a fair share of the smaller outline) that just doesn't line up: stitch it
                let (hs, _) = &pairs[&(i, j)];
                let shared: f64 = hs.iter().map(|h| h.len).sum();
                // big pieces only (flanks and the strips between them): small ones hang rigidly well enough
                let big = |s: &Island| s.l.tris.iter().map(|&t| m.a[t as usize]).sum::<f64>() >= STITCH_AREA * part_area;
                let long = big(&isl[i]) && big(&isl[j]) && shared >= STITCH_SHARE * perimeter(m, &isl[i]).min(perimeter(m, &isl[j]));
                if let (true, Some((stretch, tried))) = (long, redo.as_mut()) {
                    let key = |s: &Island| (s.l.tris[0], 0);
                    if tried.insert([key(&isl[i]), key(&isl[j])]) {
                        // glued along one stretch only: a strip touching a flank along its top and its underside
                        // would close into a tube; the other stretch stays a seam
                        // the straightest long stretch (a spine wants to be straight); a pair that folds along that one
                        // folds along the shorter ones too
                        if let (Some(run), false) = (spines(m, &isl[i], hs).first(), busy.contains(&i) || busy.contains(&j)) {
                            let glue: Vec<(u32, u32)> = run.iter().flat_map(|h| [(h.la, h.ja), (h.lb, h.jb)]).collect();
                            let Some(both) = book(m, &isl[i], &isl[j], &glue, *stretch, true) else { continue };
                            // a book has to pack as well as a join does: the page it opens out leaves a box
                            // the packer can't use, which is what the seam it saves would have cost doubled
                            let bpts: Vec<(f64, f64)> = outline(&both, None).iter().map(|s| (s[0], s[1])).collect();
                            if uv_area(&both) / min_box(&bpts) < MIN_FILL { continue; }
                            merges.push((i, j, both));
                            return Err(merges);
                        }
                    }
                }
                // a small orphan (a groove wall carved off this face): fill it back into its notch, pinned all round
                let small = isl[j].l.tris.iter().map(|&t| m.a[t as usize]).sum::<f64>() < ORPHAN * part_area;
                if let (true, false, Some((stretch, tried))) = (small, busy.contains(&i) || busy.contains(&j), redo.as_mut()) {
                    // once: `refill` opens a notch up itself, so a parent grown since makes no difference
                    if tried.insert([(u32::MAX, 0), (isl[j].l.tris[0], isl[j].l.tris.len())]) {
                        let glue: Vec<(u32, u32)> = glued[&(i, j)].iter().flat_map(|h| [(h.la, h.ja), (h.lb, h.jb)]).collect();
                        if let Some(both) = book(m, &isl[i], &isl[j], &glue, *stretch, false) {
                            busy.extend([i, j]);
                            merges.push((i, j, both));
                        }
                    }
                }
                continue;
            }
            // A join must keep the net compact enough to pack: the net, as it will lie, has to fill MIN_FILL of
            // its smallest box — the box is all the packer can place, and the space a net leaves inside its own
            // box is dead. Paper nets can sprawl; a texture atlas pays for every empty corner.
            let mut more = pts.clone();
            more.extend(seg.iter().map(|s| (s[0], s[1])));
            let after = (net_area + uv_area(&isl[j])) / min_box(&more);
            if after < MIN_FILL { continue; }
            // snap the copies along every edge shared with the net, so it really is one piece
            let (mut u, mut v) = (u, v);
            for &k in &members {
                if let Some((hs, _)) = pairs.get(&(k, j)) {
                    for h in hs {
                        for (lk, lj) in [(h.la, h.ja), (h.lb, h.jb)] {
                            let (pk, pj) = ((isl[k].f.u[lk as usize], isl[k].f.v[lk as usize]), (u[lj as usize], v[lj as usize]));
                            if (pk.0 - pj.0).hypot(pk.1 - pj.1) < tol * 100. { u[lj as usize] = pk.0; v[lj as usize] = pk.1; }
                        }
                    }
                }
            }
            interior[j] = pt;
            isl[j].f.u = u;
            isl[j].f.v = v;
            add_segs(&mut grid, cell, &seg);
            net[j] = g;
            members.push(j);
            net_area += uv_area(&isl[j]);
            pts = more;
            push(&mut heap, &net, j, depth + 1);
        }
    }
    if merges.is_empty() { Ok(net) } else { Err(merges) }
}

/// Spines to open a book along: the longest straight part of each unbroken stretch of shared edges, longest
/// first. Two pages only meet without stretching along a straight crease (a flank's top edge); where a stretch
/// bends round a strap, the bend stays a seam.
fn spines(m: &Mesh, p: &Island, hs: &[Hinge]) -> Vec<Vec<Hinge>> {
    let at = |v: u32| m.pt(p.l.orig[v as usize]);
    let mut out: Vec<Vec<Hinge>> = runs(p.l.loops[0].len(), hs).into_iter().map(|r| {
        // vertices along the run; the longest stretch i..j whose vertices all lie near the line through its ends
        let pts: Vec<V3> = std::iter::once(at(r[0].la)).chain(r.iter().map(|h| at(h.lb))).collect();
        let near = |i: usize, j: usize| {
            let (a, d) = (pts[i], sub(pts[j], pts[i]));
            let l2 = dot(d, d).max(1e-300);
            (i..=j).all(|k| {
                let w = sub(pts[k], a);
                let t = dot(w, d) / l2;
                dist(pts[k], [0, 1, 2].map(|c| a[c] + t * d[c])) <= STRAIGHT * l2.sqrt()
            })
        };
        let mut best = (0., 0, 1);
        for i in 0..pts.len() {
            for j in i + 1..pts.len() {
                let len = dist(pts[i], pts[j]);
                if len > best.0 && near(i, j) { best = (len, i, j); }
            }
        }
        r[best.1..best.2].to_vec()
    }).collect();
    let span = |r: &[Hinge]| dist(at(r[0].la), at(r[r.len() - 1].lb));
    out.sort_by(|a, b| span(b).total_cmp(&span(a)));
    out
}

/// How far (share of its length) a spine's vertices may stray from a straight line.
const STRAIGHT: f64 = 0.02;

/// The unbroken stretches of shared edges along the parent's outline (`n` edges round; one may wrap), longest
/// first.
fn runs(n: usize, hs: &[Hinge]) -> Vec<Vec<Hinge>> {
    let mut hs: Vec<Hinge> = hs.to_vec();
    hs.sort_by_key(|h| h.pos);
    // start after a gap, so a run that wraps past the outline's first edge isn't cut in two
    if let Some(g) = (0..hs.len()).find(|&k| (hs[(k + 1) % hs.len()].pos + n - hs[k].pos) % n != 1) { let k = (g + 1) % hs.len(); hs.rotate_left(k); }
    let mut out: Vec<Vec<Hinge>> = Vec::new();
    for h in hs {
        match out.last_mut() {
            Some(r) if (h.pos + n - r.last().unwrap().pos) % n == 1 => r.push(h),
            _ => out.push(vec![h]),
        }
    }
    let len = |r: &[Hinge]| r.iter().map(|h| h.len).sum::<f64>();
    out.sort_by(|a, b| len(b).total_cmp(&len(a)));
    out
}

/// Total UV length of the shared border, on the parent (`side` 0) or the child (1).
fn border_uv(s: &Island, hs: &[Hinge], side: usize) -> f64 {
    hs.iter().map(|h| {
        let (a, b) = if side == 0 { (h.la, h.lb) } else { (h.ja, h.jb) };
        (s.f.u[a as usize] - s.f.u[b as usize]).hypot(s.f.v[a as usize] - s.f.v[b as usize])
    }).sum()
}

/// Length of an island's outline in 3D.
fn perimeter(m: &Mesh, s: &Island) -> f64 {
    let lp = &s.l.loops[0];
    (0..lp.len()).map(|k| dist(m.pt(s.l.orig[lp[k] as usize]), m.pt(s.l.orig[lp[(k + 1) % lp.len()] as usize]))).sum()
}


/// Least share of its smallest box a net must fill to take another island. The box is what the packer places —
/// the space a net leaves inside its own box is dead — and the smallest box is the one the packer finds when it
/// turns the net, so this is what a join really costs. A Latin cross fills half of it; a band that folds back
/// across itself fills a third, and packs better as two islands.
const MIN_FILL: f64 = 0.45;

fn uv_area(s: &Island) -> f64 { (0..s.l.t.len()).map(|i| tri_area(s, i)).sum::<f64>() / 2. }

/// Area of the smallest box round the points: rotating calipers over the hull, one turn per hull edge.
fn min_box(pts: &[(f64, f64)]) -> f64 {
    let h = hull(pts);
    if h.len() < 3 { return f64::MIN_POSITIVE; }
    let mut best = f64::MAX;
    for i in 0..h.len() {
        let (a, b) = (h[i], h[(i + 1) % h.len()]);
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let l = dx.hypot(dy);
        if l < 1e-12 { continue; }
        let (ux, uy) = (dx / l, dy / l);
        let (mut lo, mut hi) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN));
        for &(x, y) in &h {
            let (p, q) = (x * ux + y * uy, -x * uy + y * ux);
            lo = (lo.0.min(p), lo.1.min(q));
            hi = (hi.0.max(p), hi.1.max(q));
        }
        best = best.min((hi.0 - lo.0) * (hi.1 - lo.1));
    }
    best.max(f64::MIN_POSITIVE)
}

/// The convex hull of the points (monotone chain).
fn hull(pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut p = pts.to_vec();
    p.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    if p.len() < 3 { return p; }
    let turn = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0);
    let mut h: Vec<(f64, f64)> = Vec::with_capacity(p.len() * 2);
    for pass in 0..2 {
        let start = h.len();
        for &q in p.iter() {
            while h.len() >= start + 2 && turn(h[h.len() - 2], h[h.len() - 1], q) <= 0. { h.pop(); }
            h.push(q);
        }
        h.pop();
        if pass == 0 { p.reverse(); }
    }
    h
}

fn tri_area(s: &Island, i: usize) -> f64 {
    let t = s.l.t[i].map(|q| q as usize);
    ((s.f.u[t[1]] - s.f.u[t[0]]) * (s.f.v[t[2]] - s.f.v[t[0]]) - (s.f.u[t[2]] - s.f.u[t[0]]) * (s.f.v[t[1]] - s.f.v[t[0]])).abs()
}

/// The child's UVs turned and moved so the hinge halfway along the shared stretch of the parent's border lands
/// on the parent's copy (midpoints together, directions lined up). A straight shared border then lines up along
/// its whole length; a curved one (a cylinder's rim) touches at that one edge, like a tin-can net.
fn hang(parent: &Island, child: &Island, hs: &[Hinge]) -> Option<(Vec<f64>, Vec<f64>)> {
    // the shared edges in order along the parent's border, starting after the biggest gap (the run may wrap)
    let n = parent.l.loops[0].len();
    let mut run: Vec<&Hinge> = hs.iter().collect();
    run.sort_by_key(|h| h.pos);
    let gap = (0..run.len()).max_by_key(|&k| (run[(k + 1) % run.len()].pos + n - run[k].pos - 1) % n)?;
    let start = (gap + 1) % run.len();
    run.rotate_left(start);
    let half = run.iter().map(|h| h.len).sum::<f64>() / 2.;
    let (mut acc, mut h) = (0., run[0]);
    for x in &run { h = x; acc += x.len; if acc >= half { break; } }
    Some(hang_at(parent, child, h))
}

/// The child's UVs turned and moved so its copy of hinge `h` lands on the parent's (midpoints together,
/// directions lined up).
fn hang_at(parent: &Island, child: &Island, h: &Hinge) -> (Vec<f64>, Vec<f64>) {
    let (pu, pv, cu, cv) = (&parent.f.u, &parent.f.v, &child.f.u, &child.f.v);
    let p = ((pu[h.la as usize], pv[h.la as usize]), (pu[h.lb as usize], pv[h.lb as usize]));
    let q = ((cu[h.ja as usize], cv[h.ja as usize]), (cu[h.jb as usize], cv[h.jb as usize]));
    let th = (p.1 .1 - p.0 .1).atan2(p.1 .0 - p.0 .0) - (q.1 .1 - q.0 .1).atan2(q.1 .0 - q.0 .0);
    let (cs, sn) = (th.cos(), th.sin());
    let pm = ((p.0 .0 + p.1 .0) / 2., (p.0 .1 + p.1 .1) / 2.);
    let qm = ((q.0 .0 + q.1 .0) / 2., (q.0 .1 + q.1 .1) / 2.);
    cu.iter().zip(cv).map(|(&x, &y)| {
        let (dx, dy) = (x - qm.0, y - qm.1);
        (pm.0 + cs * dx - sn * dy, pm.1 + sn * dx + cs * dy)
    }).unzip()
}

fn outline(s: &Island, uv: Option<(&Vec<f64>, &Vec<f64>)>) -> Vec<Seg> {
    let (u, v) = uv.unwrap_or((&s.f.u, &s.f.v));
    let lp = &s.l.loops[0];
    (0..lp.len()).map(|k| {
        let (a, b) = (lp[k] as usize, lp[(k + 1) % lp.len()] as usize);
        [u[a], v[a], u[b], v[b]]
    }).collect()
}

/// Where the child's interior point lands after the move (same rigid map, read off two of its vertices).
fn transform_point(s: &Island, u: &[f64], v: &[f64], p: (f64, f64)) -> (f64, f64) {
    let lp = &s.l.loops[0];
    let (a, b) = (lp[0] as usize, lp[1] as usize);
    let (o0, o1) = ((s.f.u[a], s.f.v[a]), (s.f.u[b], s.f.v[b]));
    let (n0, n1) = ((u[a], v[a]), (u[b], v[b]));
    let th = (n1.1 - n0.1).atan2(n1.0 - n0.0) - (o1.1 - o0.1).atan2(o1.0 - o0.0);
    let (cs, sn, dx, dy) = (th.cos(), th.sin(), p.0 - o0.0, p.1 - o0.1);
    (n0.0 + cs * dx - sn * dy, n0.1 + sn * dx + cs * dy)
}

fn cells(cell: f64, s: &Seg) -> impl Iterator<Item = (i64, i64)> {
    let (x0, x1) = ((s[0].min(s[2]) / cell).floor() as i64, (s[0].max(s[2]) / cell).floor() as i64);
    let (y0, y1) = ((s[1].min(s[3]) / cell).floor() as i64, (s[1].max(s[3]) / cell).floor() as i64);
    (x0..=x1).flat_map(move |x| (y0..=y1).map(move |y| (x, y)))
}

fn add_segs(grid: &mut Map<(i64, i64), Vec<Seg>>, cell: f64, segs: &[Seg]) {
    for s in segs { for c in cells(cell, s) { grid.entry(c).or_default().push(*s); } }
}

/// Any proper crossing between the new outline and the net's. Points within `tol` of a line count as on it,
/// and touching never counts: the hinge and edges that merely meet are fine.
fn crosses(grid: &Map<(i64, i64), Vec<Seg>>, cell: f64, segs: &[Seg], tol: f64) -> bool {
    let side = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| {
        let l = (b.0 - a.0).hypot(b.1 - a.1).max(1e-300);
        let s = ((b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)) / l;
        if s.abs() < tol { 0. } else { s.signum() }
    };
    segs.iter().any(|s| cells(cell, s).any(|c| grid.get(&c).is_some_and(|list| list.iter().any(|t| {
        let (a, b, c2, d) = ((s[0], s[1]), (s[2], s[3]), (t[0], t[1]), (t[2], t[3]));
        side(a, b, c2) * side(a, b, d) < 0. && side(c2, d, a) * side(c2, d, b) < 0.
    }))))
}

/// One piece lying wholly inside the other (no crossing to catch it).
fn contains(k: &Island, k_pt: (f64, f64), j_segs: &[Seg], j_pt: (f64, f64)) -> bool {
    inside(&outline(k, None), j_pt) || inside(j_segs, k_pt)
}

fn inside(segs: &[Seg], p: (f64, f64)) -> bool {
    let mut odd = false;
    for s in segs {
        if (s[1] > p.1) != (s[3] > p.1) && p.0 < s[0] + (p.1 - s[1]) / (s[3] - s[1]) * (s[2] - s[0]) { odd = !odd; }
    }
    odd
}

/// Share of its smallest box a net fills: the measure `join_once` uses before it lets a net grow, so a net that
/// slipped through (a book, a fill) can be judged afterwards the same way.
pub(crate) fn net_fill(isl: &[Island], ms: &[usize]) -> f64 {
    let (mut pts, mut area) = (Vec::new(), 0.);
    for &i in ms {
        let s = &isl[i];
        for lp in &s.l.loops { for &k in lp { pts.push((s.f.u[k as usize], s.f.v[k as usize])); } }
        area += uv_area(s);
    }
    area / min_box(&pts)
}