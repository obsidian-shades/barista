//! Charts: cut along sharp edges, read a chart's topology, add seams, split charts that won't flatten.
use crate::flatten::{flatten, flatten_slim, Flat};
use crate::mesh::*;
use crate::Params;
use rayon::prelude::*;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[derive(Clone)]
pub struct Island {
    /// Which input part the island belongs to (set by the caller).
    pub part: usize,
    pub l: Local,
    pub f: Flat,
    /// A book's spine, as its two end vertices (local): packing turns the net so it runs along an axis.
    pub spine: Option<[u32; 2]>,
}

/// The whole loop: charts by the side they face (`region`) → (open up | seam | carve | split) until every chart
/// flattens well, splitting only where the stretch saved is worth the extra seam.
pub fn unwrap(m: &Mesh, seams: &Set<u64>, p: &Params) -> Vec<Island> {
    islands(m, crate::region::charts(m, p.sharp, seams), seams, p)
}

/// Each chart solved into islands, their quads straightened, at one texel density.
pub(crate) fn islands(m: &Mesh, cs: Vec<Vec<u32>>, seams: &Set<u64>, p: &Params) -> Vec<Island> {
    let mut out: Vec<Island> = cs.into_par_iter().flat_map(|t| solve(m, t, seams.clone(), p).0)
        .map(|mut s| { cool(m, &mut s, p.tol); crate::quads::straighten(m, &mut s, p.tol); s }).collect();
    normalise(m, &mut out);
    out
}

/// One texel scale for every island of a part: each is scaled about its own centre so that UV area over 3D area
/// is the same on all of them. The flattener anchors scale by itself (ARAP's right-hand side is built from the
/// rest edges, so a chart can't drift), but nothing guarantees it, and a chart that came out a few percent off
/// would carry a different texel density to the atlas for good — the packer has one scale for the lot.
pub(crate) fn normalise(m: &Mesh, isl: &mut [Island]) {
    let (mut uv, mut a3) = (0., 0.);
    let areas: Vec<(f64, f64)> = isl.iter().map(|s| {
        let u = layout_area(&s.l, &s.f);
        let a = s.l.tris.iter().map(|&t| m.a[t as usize]).sum::<f64>();
        (u, a)
    }).collect();
    for &(u, a) in &areas { uv += u; a3 += a; }
    if !(uv > 0. && a3 > 0.) { return; }
    let want = uv / a3;
    for (s, &(u, a)) in isl.iter_mut().zip(&areas) {
        if !(u > 0. && a > 0.) { continue; }
        let k = (want * a / u).sqrt();
        if !k.is_finite() || (k - 1.).abs() < 1e-6 { continue; }
        let (cu, cv) = (s.f.u.iter().sum::<f64>() / s.f.u.len() as f64, s.f.v.iter().sum::<f64>() / s.f.v.len() as f64);
        for i in 0..s.f.u.len() { s.f.u[i] = cu + (s.f.u[i] - cu) * k; s.f.v[i] = cv + (s.f.v[i] - cv) * k; }
    }
}

/// Area of a layout's triangles in UV.
fn layout_area(l: &Local, f: &Flat) -> f64 {
    l.t.iter().map(|t| {
        let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
        ((f.u[b] - f.u[a]) * (f.v[c] - f.v[a]) - (f.u[c] - f.u[a]) * (f.v[b] - f.v[a])).abs() / 2.
    }).sum()
}

/// Stretch at which the editor's Stretch view is fully red (50%).
const HOT: f64 = 0.405_465;

/// Area of the triangles stretched past `HOT`.
fn hot_area(m: &Mesh, l: &Local, f: &Flat) -> f64 {
    l.tris.iter().zip(&f.e).filter(|(_, &e)| e >= HOT).map(|(&t, _)| m.a[t as usize]).sum()
}

/// A red patch inside an island that's fine on average (a cone point the mean hides, whatever path made the
/// island): OptCuts' interior split. Cut from the vertex carrying the most red to the border, lay it out again, and
/// keep it if it's clean, no worse on average and less red; up to 4 cuts.
fn cool(m: &Mesh, s: &mut Island, tol: f64) {
    // a whole closed tube is the seamless torus layout, whose stretch buys seams carrying the texture straight across
    if hot_area(m, &s.l, &s.f) == 0. || { let w = local_mesh(m, &s.l.tris, &Set::default()); w.loops.is_empty() && w.chi() == 0 } { return; }
    for _ in 0..4 {
        let h = hot_area(m, &s.l, &s.f);
        if h == 0. { return; }
        let mut heat = vec![0.; s.l.nv];
        for (i, tri) in s.l.t.iter().enumerate() {
            if s.f.e[i] >= HOT { for &q in tri { heat[q as usize] += s.f.e[i] * m.a[s.l.tris[i] as usize]; } }
        }
        let Some(tip) = (0..s.l.nv).filter(|&v| !s.l.on_b[v] && heat[v] > 0.).max_by(|&a, &b| heat[a].total_cmp(&heat[b])) else { return };
        // the island's own seams (edges its triangles share in the mesh but not in the layout), plus the new cut
        let mut sides: Map<u64, Set<u64>> = Map::default();
        for tri in &s.l.t {
            for k in 0..3 {
                let (a, b) = (tri[k], tri[(k + 1) % 3]);
                sides.entry(ek(s.l.orig[a as usize], s.l.orig[b as usize])).or_default().insert(ek(a, b));
            }
        }
        let mut cut: Set<u64> = sides.into_iter().filter(|(_, x)| x.len() > 1).map(|(k, _)| k).collect();
        cut.extend(cut_path(m, &s.l, &[tip as u32], &s.l.loops[0].iter().copied().collect()));
        // the layout as it is with the cut opened, relaxed from there (SLIM: no flips or overlap); else laid out afresh
        let opened = sub_island(m, &s.l, &s.f, &s.l.tris, &cut).map(|(l, f)| { let g = crate::flatten::relax(m, &l, &f); (l, g) });
        let afresh = || { let l = local_mesh(m, &s.l.tris, &cut); let f = if l.is_disk() { Some(flatten(m, &l)) } else { flatten_slim(m, &l) }; f.map(|f| (l, f)) };
        let ok = |(l, f): &(Local, Flat)| f.flips == 0 && !f.self_overlap && f.mean_e <= s.f.mean_e.max(tol) && hot_area(m, l, f) < h;
        let Some((mut l, f)) = opened.filter(ok).or_else(|| afresh().filter(ok)) else { return };
        outer_first(&mut l, &f);
        (s.l, s.f) = (l, f);
    }
}

/// Mean stretch a seamless tube layout may have and still be kept whole (0.5 ≈ 50%).
const MAX_TUBE_STRETCH: f64 = 0.5;

/// Returns the islands and their cost: Σ stretch × area, plus `seam_weight` × length of every split seam.
pub(crate) fn solve(m: &Mesh, tris: Vec<u32>, mut cut: Set<u64>, p: &Params) -> (Vec<Island>, f64) {
    let area: f64 = tris.iter().map(|&t| m.a[t as usize]).sum();
    let (mut cuts, mut holes, mut whole) = (0, 0, None);
    loop {
        let l = local_mesh(m, &tris, &cut);
        // A closed tube (torus, knot): one seamless rectangle from harmonic one-forms. Its seams carry the
        // texture straight across, which splitting would lose, so it wins over the seam-cost trade unless
        // its stretch is extreme.
        if cuts == 0 && l.loops.is_empty() && l.chi() == 0 {
            if let Some((l, f)) = crate::torus::torus_map(m, &tris, &l) {
                let (clean, cost) = (f.flips == 0 && !f.self_overlap, f.mean_e * area);
                if clean && f.mean_e <= MAX_TUBE_STRETCH { return (vec![Island { part: 0, l, f, spine: None }], cost); }
                if clean { whole = Some((Island { part: 0, l, f, spine: None }, cost)); }
                break;
            }
        }
        // closed: a torus opens along its two shortest loops into one rectangle; a sphere along one path
        if l.loops.is_empty() {
            if cuts >= 4 { break; }
            cut.extend(if l.chi() <= 0 { loop_cut(m, &l) } else { far_cut(m, &l) });
            cuts += 1;
            continue;
        }
        // open with handles: split
        if l.chi() != 2 - l.loops.len() as i64 {
            // pieces held together only by edges that can't glue (non-manifold, or windings that can't agree):
            // each is a chart of its own
            let mut par: Vec<usize> = (0..l.nv).collect();
            for t in &l.t { for k in 1..3 { let (x, y) = (find(&mut par, t[0] as usize), find(&mut par, t[k] as usize)); par[x] = y; } }
            let mut parts: Map<usize, Vec<u32>> = Map::default();
            for (i, t) in l.t.iter().enumerate() { parts.entry(find(&mut par, t[0] as usize)).or_default().push(l.tris[i]); }
            if parts.len() > 1 {
                let kids: Vec<(Vec<Island>, f64)> = parts.into_values().collect::<Vec<_>>().into_par_iter().map(|t| solve(m, t, cut.clone(), p)).collect();
                let cost = kids.iter().map(|k| k.1).sum();
                return (kids.into_iter().flat_map(|k| k.0).collect(), cost);
            }
            break;
        }
        // as it is: a disk by LSCM + ARAP, or projected and relaxed (holes and all), whichever is clean
        // as it is: a disk by LSCM + ARAP; a chart with holes (before any is cut) projected onto its plane and
        // relaxed without overlap, so a flank keeps its ports without seams cut to them
        let arap = l.is_disk().then(|| flatten(m, &l));
        let laid = if arap.is_some() { arap.clone() } else if holes == 0 { flatten_slim(m, &l) } else { None };
        if let Some(f) = laid {
            let clean = f.flips == 0 && !f.self_overlap;
            let cost = f.mean_e * area;
            // good enough, or a lone triangle (always a disk, always accepted, so splitting ends)
            if (clean && f.mean_e <= p.tol) || tris.len() <= 1 {
                let mut l = l;
                outer_first(&mut l, &f);
                return (vec![Island { part: 0, l, f, spine: None }], cost);
            }
            if clean && whole.as_ref().is_none_or(|w: &(Island, f64)| cost < w.1) {
                let mut l = l.clone();
                outer_first(&mut l, &f);
                whole = Some((Island { part: 0, l, f, spine: None }, cost));
            }
        }
        // Unfolds without stretch but folds over itself (groove walls opening onto the face beside them): keep
        // the unfolding and carve it into pieces that don't overlap themselves.
        if let Some(a) = arap.as_ref().filter(|a| tris.len() > 1 && (a.flips > 0 || a.self_overlap)) {
            if let Some(pieces) = Some(carve(m, &l, a)).filter(|x| x.len() > 1) {
                let seam = p.seam_weight * seam_length(m, &pieces);
                // each piece keeps the unfolding it was grown on, relaxed on its own from there (SLIM: still
                // no flips or overlap); the flipped rest, or a piece too stretched, is solved again
                let kids: Vec<(Vec<Island>, f64)> = pieces.into_par_iter().map(|t| match sub_island(m, &l, a, &t, &cut) {
                    Some((mut kl, mut kf)) if kf.mean_e <= p.tol => {
                        let g = crate::flatten::relax(m, &kl, &kf);
                        if g.flips == 0 && !g.self_overlap && g.mean_e < kf.mean_e { kf = g; outer_first(&mut kl, &kf); }
                        let c = kf.mean_e * t.iter().map(|&q| m.a[q as usize]).sum::<f64>();
                        (vec![Island { part: 0, l: kl, f: kf, spine: None }], c)
                    }
                    _ => solve(m, t, cut.clone(), p),
                }).collect();
                let cost = seam + kids.iter().map(|k| k.1).sum::<f64>();
                let (kids, cost) = reattach(m, kids.into_iter().flat_map(|k| k.0).collect(), cost, p);
                if whole.as_ref().is_none_or(|w| cost < w.1) { return (kids, cost); }
            }
        }
        // a hole (a ring's inside, a port through a flank): seam it to the nearest other border
        if l.loops.len() > 1 && holes < 32 {
            cut.extend(join_loops(m, &l));
            holes += 1;
            continue;
        }
        // a cone tip can't flatten without a seam to the border (when the layout is clean, just stretched)
        if cuts < 4 && arap.as_ref().is_some_and(|a| a.flips == 0 && !a.self_overlap) {
            if let Some(tip) = worst_defect(m, &l) {
                let to = l.loops[0].iter().copied().collect();
                cut.extend(cut_path(m, &l, &[tip], &to));
                cuts += 1;
                continue;
            }
        }
        break;
    }
    // split, then keep whichever is cheaper: the whole stretched island, or the halves plus their new seam
    let halves = split(m, &tris);
    let seam = p.seam_weight * seam_length(m, &halves);
    let kids: Vec<(Vec<Island>, f64)> = halves.into_par_iter().map(|t| solve(m, t, cut.clone(), p)).collect();
    let kids_cost = seam + kids.iter().map(|k| k.1).sum::<f64>();
    match whole {
        Some((isl, c)) if c <= kids_cost => (vec![isl], c),
        _ => (kids.into_iter().flat_map(|k| k.0).collect(), kids_cost),
    }
}

/// Paper-model growth over a finished unfolding: from the biggest triangle, take neighbours flattest edge first,
/// skipping any that flipped or that would overlap the piece (an edge crossing one of its edges, or one triangle's
/// centre inside the other); then the next piece from what's left, until all is taken.
/// Returns the grown pieces (biggest first) and the edge-connected pieces of the flipped triangles.
fn carve(m: &Mesh, l: &Local, f: &Flat) -> Vec<Vec<u32>> {
    let nt = l.t.len();
    let mut et: Map<u64, Vec<usize>> = Map::default();
    for (i, t) in l.t.iter().enumerate() { for k in 0..3 { et.entry(ek(t[k], t[(k + 1) % 3])).or_default().push(i); } }
    let p = |i: usize| l.t[i].map(|q| (f.u[q as usize], f.v[q as usize]));
    let (mut lo, mut hi, mut len) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN), 0.);
    for i in 0..nt {
        for (k, q) in p(i).iter().enumerate() {
            (lo, hi) = ((lo.0.min(q.0), lo.1.min(q.1)), (hi.0.max(q.0), hi.1.max(q.1)));
            let r = p(i)[(k + 1) % 3];
            len += (r.0 - q.0).hypot(r.1 - q.1);
        }
    }
    // the same tolerance `measure` reads outline crossings with
    let size = (hi.0 - lo.0).max(hi.1 - lo.1).max(1e-300);
    let tol = size * size * 1e-7;
    let side = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| {
        let s = (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0);
        if s.abs() < tol { 0. } else { s.signum() }
    };
    let inside = |t: [(f64, f64); 3], c: (f64, f64)| { let s = side(t[0], t[1], t[2]); s != 0. && (0..3).all(|k| side(t[k], t[(k + 1) % 3], c) == s) };
    let centre = |t: [(f64, f64); 3]| ((t[0].0 + t[1].0 + t[2].0) / 3., (t[0].1 + t[1].1 + t[2].1) / 3.);
    let overlap = |x: [(f64, f64); 3], y: [(f64, f64); 3]| {
        (0..3).any(|i| (0..3).any(|j| {
            let (a, b, c, d) = (x[i], x[(i + 1) % 3], y[j], y[(j + 1) % 3]);
            side(a, b, c) * side(a, b, d) < 0. && side(c, d, a) * side(c, d, b) < 0.
        })) || inside(x, centre(y)) || inside(y, centre(x))
    };
    // triangles bucketed by bounding box on a grid about a mean edge across
    let cell = (len / (3 * nt) as f64).max(size * 1e-4);
    let cells = |t: [(f64, f64); 3]| {
        let (x0, x1) = (t.iter().map(|q| q.0).fold(f64::MAX, f64::min), t.iter().map(|q| q.0).fold(f64::MIN, f64::max));
        let (y0, y1) = (t.iter().map(|q| q.1).fold(f64::MAX, f64::min), t.iter().map(|q| q.1).fold(f64::MIN, f64::max));
        let k = |x: f64, o: f64| ((x - o) / cell) as i64;
        (k(x0, lo.0)..=k(x1, lo.0)).flat_map(move |x| (k(y0, lo.1)..=k(y1, lo.1)).map(move |y| (x, y)))
    };
    let (mut taken, mut out) = (vec![false; nt], Vec::new());
    // piece after piece, each grown on its own over what the ones before left, biggest triangle first
    while let Some(seed) = (0..nt).filter(|&i| !taken[i] && f.e[i].is_finite()).max_by(|&x, &y| m.a[l.tris[x] as usize].total_cmp(&m.a[l.tris[y] as usize])) {
        let (mut piece, mut done, mut grid, mut heap) = (vec![seed], taken.clone(), Map::<(i64, i64), Vec<usize>>::default(), BinaryHeap::new());
        heap.push(Item(0., seed as u32));
        while let Some(Item(_, j)) = heap.pop() {
            let j = j as usize;
            if done[j] { continue; }
            done[j] = true;
            if !f.e[j].is_finite() { continue; }
            let tj = p(j);
            if cells(tj).any(|c| grid.get(&c).is_some_and(|ts| ts.iter().any(|&i| overlap(p(i), tj)))) { continue; }
            for c in cells(tj) { grid.entry(c).or_default().push(j); }
            taken[j] = true;
            if j != seed { piece.push(j); }
            let (n, t) = (m.n[l.tris[j] as usize], l.t[j]);
            for k in 0..3 {
                for &i in &et[&ek(t[k], t[(k + 1) % 3])] {
                    if !done[i] { heap.push(Item(dot(n, m.n[l.tris[i] as usize]).clamp(-1., 1.).acos(), i as u32)); }
                }
            }
        }
        out.push(piece.iter().map(|&i| l.tris[i]).collect());
    }
    // flipped triangles: edge-connected pieces, solved again
    let rest: Vec<u32> = (0..nt).filter(|&i| !taken[i]).map(|i| l.tris[i]).collect();
    if !rest.is_empty() { out.extend(components(m, &rest, |_| true)); }
    whole(m, out)
}

/// Carved pieces put back where they were carved from: smallest first, each filled into the bigger piece it shares
/// the most border with (`book` as a fill: the notch opened round it, the piece squashed in), kept whenever the
/// stretch that adds costs less than the seam it takes away. A groove wall stays on its face with a little stretch
/// instead of leaving a notch there and a sliver elsewhere. Returns the pieces and their new cost.
fn reattach(m: &Mesh, mut isl: Vec<Island>, mut cost: f64, p: &Params) -> (Vec<Island>, f64) {
    let area = |s: &Island| s.l.tris.iter().map(|&t| m.a[t as usize]).sum::<f64>();
    isl.sort_by(|x, y| area(y).total_cmp(&area(x)));
    let mut i = isl.len();
    while i > 1 {
        i -= 1;
        let Some((j, glue, len)) = (0..i).map(|j| { let (g, len) = shared(m, &isl[j], &isl[i]); (j, g, len) }).max_by(|x, y| x.2.total_cmp(&y.2)) else { continue };
        if len <= 0. { continue; }
        let Some(both) = book(m, &isl[j], &isl[i], &glue, p.tol, false) else { continue };
        let delta = both.f.mean_e * area(&both) - isl[j].f.mean_e * area(&isl[j]) - isl[i].f.mean_e * area(&isl[i]);
        if delta >= p.seam_weight * len { continue; }
        cost += delta - p.seam_weight * len;
        isl[j] = both;
        isl.remove(i);
    }
    (isl, cost)
}

/// The border edges two islands share, as (a's local vertex, b's) pairs, two per edge in a's winding order, and
/// what they cost as a seam (`seam_cost`).
fn shared(m: &Mesh, a: &Island, b: &Island) -> (Vec<(u32, u32)>, f64) {
    let edges = |s: &Island| s.l.loops.iter().flat_map(|lp| (0..lp.len()).map(move |k| (lp[k], lp[(k + 1) % lp.len()]))).collect::<Vec<_>>();
    let mut at: Map<u32, u32> = Map::default();
    let mut keys: Set<u64> = Set::default();
    for (x, y) in edges(b) {
        let (ox, oy) = (b.l.orig[x as usize], b.l.orig[y as usize]);
        at.insert(ox, x);
        at.insert(oy, y);
        keys.insert(ek(ox, oy));
    }
    let (mut glue, mut len) = (Vec::new(), 0.);
    for (x, y) in edges(a) {
        let (ox, oy) = (a.l.orig[x as usize], a.l.orig[y as usize]);
        if !keys.contains(&ek(ox, oy)) { continue; }
        glue.extend([(x, at[&ox]), (y, at[&oy])]);
        len += seam_cost(m, ox, oy);
    }
    (glue, len)
}

/// A subset of a laid-out chart as its own island, keeping the chart's layout; None if that overlaps itself.
fn sub_island(m: &Mesh, l: &Local, f: &Flat, tris: &[u32], cut: &Set<u64>) -> Option<(Local, Flat)> {
    let mut sub = local_mesh(m, tris, cut);
    let at: Map<u32, usize> = l.tris.iter().enumerate().map(|(i, &t)| (t, i)).collect();
    let (mut u, mut v) = (vec![0.; sub.nv], vec![0.; sub.nv]);
    for (i, t) in sub.t.iter().enumerate() {
        let pt = l.t[at[&sub.tris[i]]];
        for k in 0..3 { (u[t[k] as usize], v[t[k] as usize]) = (f.u[pt[k] as usize], f.v[pt[k] as usize]); }
    }
    if sub.loops.is_empty() { return None; }
    let g = crate::flatten::measure(&sub, &crate::flatten::frames(m, &sub), u, v);
    if g.flips > 0 || g.self_overlap { return None; }
    outer_first(&mut sub, &g);
    Some((sub, g))
}

/// What the edges between different pieces cost as seams (`seam_cost`).
fn seam_length(m: &Mesh, pieces: &[Vec<u32>]) -> f64 {
    let label: Map<u32, usize> = pieces.iter().enumerate().flat_map(|(i, p)| p.iter().map(move |&t| (t, i))).collect();
    let mut len = 0.;
    for (&t, &i) in &label {
        let f = m.f[t as usize];
        for k in 0..3 {
            let (a, b) = (f[k], f[(k + 1) % 3]);
            if m.edges[&ek(a, b)].iter().any(|&u| u > t && label.get(&u).is_some_and(|&j| j != i)) {
                len += seam_cost(m, a, b);
            }
        }
    }
    len
}

/// Flood triangles across edges whose dihedral is under `deg` and that aren't user seams: a cube gives its 6 faces.
pub fn feature_charts(m: &Mesh, deg: f64, seams: &Set<u64>) -> Vec<Vec<u32>> {
    let cos = deg.to_radians().cos();
    let mut lab = vec![u32::MAX; m.f.len()];
    let mut out = Vec::new();
    for s in 0..m.f.len() {
        if lab[s] != u32::MAX { continue; }
        let id = out.len() as u32;
        lab[s] = id;
        let mut list = vec![s as u32];
        let mut q = 0;
        while q < list.len() {
            let t = list[q];
            q += 1;
            let f = m.f[t as usize];
            for k in 0..3 {
                let key = ek(f[k], f[(k + 1) % 3]);
                if seams.contains(&key) { continue; }
                for &u in &m.edges[&key] {
                    if lab[u as usize] == u32::MAX && dot(m.n[t as usize], m.n[u as usize]) >= cos {
                        lab[u as usize] = id;
                        list.push(u);
                    }
                }
            }
        }
        out.push(list);
    }
    out
}

/// Puts the outline first: the border loop enclosing the most UV area (the others are holes).
fn outer_first(l: &mut Local, f: &Flat) {
    let area = |lp: &Vec<u32>| (0..lp.len()).map(|k| {
        let (a, b) = (lp[k] as usize, lp[(k + 1) % lp.len()] as usize);
        f.u[a] * f.v[b] - f.u[b] * f.v[a]
    }).sum::<f64>().abs();
    if let Some(i) = (0..l.loops.len()).max_by(|&x, &y| area(&l.loops[x]).total_cmp(&area(&l.loops[y]))) { l.loops.swap(0, i); }
}

/// The shortest edge path between two different border loops, as welded edge keys to cut: two loops become one.
fn join_loops(m: &Mesh, l: &Local) -> Vec<u64> {
    let adj = seam_adj(m, l);
    let mut owner = vec![usize::MAX; l.nv];
    for (i, lp) in l.loops.iter().enumerate() { for &v in lp { owner[v as usize] = i; } }
    let all: Vec<u32> = l.loops.iter().flatten().copied().collect();
    let (d, prev, _) = dijkstra(&adj, &all, |_| false);
    // each vertex belongs to the loop its shortest path starts from
    let root = |mut v: u32| { while prev[v as usize] != u32::MAX { v = prev[v as usize]; } owner[v as usize] };
    let mut best = (f64::INFINITY, 0u32, 0u32);
    for a in 0..l.nv as u32 {
        for &(b, w) in &adj[a as usize] {
            let len = d[a as usize] + w + d[b as usize];
            if a < b && len < best.0 && root(a) != root(b) { best = (len, a, b); }
        }
    }
    let mut keys = vec![ek(l.orig[best.1 as usize], l.orig[best.2 as usize])];
    path_keys(l, &prev, best.1, &mut keys);
    path_keys(l, &prev, best.2, &mut keys);
    keys
}

/// A chart as its own mesh. Triangle corners glue across shared edges unless the edge is cut;
/// each glued group is one local vertex, so seams split vertices by themselves.
#[derive(Clone)]
pub struct Local {
    /// Global triangle ids, in the same order as `t`.
    pub tris: Vec<u32>,
    pub t: Vec<[u32; 3]>,
    /// Local vertex → welded mesh vertex.
    pub orig: Vec<u32>,
    pub nv: usize,
    pub ne: usize,
    /// Border loops, each in winding order.
    pub loops: Vec<Vec<u32>>,
    pub on_b: Vec<bool>,
}

impl Local {
    pub fn chi(&self) -> i64 { self.nv as i64 - self.ne as i64 + self.t.len() as i64 }
    pub fn is_disk(&self) -> bool { self.chi() == 1 && self.loops.len() == 1 }
}

pub(crate) fn find(par: &mut [usize], mut x: usize) -> usize {
    while par[x] != x { par[x] = par[par[x]]; x = par[x]; }
    x
}

pub fn local_mesh(m: &Mesh, tris: &[u32], cut: &Set<u64>) -> Local {
    let n = tris.len();
    let pos: Map<u32, usize> = tris.iter().enumerate().map(|(i, &t)| (t, i)).collect();
    // Glue only across uncut edges with exactly two of the chart's triangles (a third makes it non-manifold).
    let pair = |key: u64| -> Option<[usize; 2]> {
        if cut.contains(&key) { return None; }
        let mut it = m.edges[&key].iter().filter_map(|u| pos.get(u).copied());
        match (it.next(), it.next(), it.next()) { (Some(i), Some(j), None) => Some([i, j]), _ => None }
    };
    // The mesh's winding can disagree across a chart (orientation carried over non-manifold edges elsewhere):
    // re-wind each glued piece so neighbours run shared edges opposite ways, keeping the winding most of its
    // area already has; an edge that can't agree (a Möbius band) stays open.
    let mut w: Vec<[u32; 3]> = tris.iter().map(|&t| m.f[t as usize]).collect();
    let (mut seen, mut open) = (vec![false; n], Set::default());
    for s in 0..n {
        if seen[s] { continue; }
        seen[s] = true;
        let (mut comp, mut flip, mut q) = (vec![s], vec![false], 0);
        while q < comp.len() {
            let i = comp[q];
            q += 1;
            for k in 0..3 {
                let (a, b) = (w[i][k], w[i][(k + 1) % 3]);
                let Some(ij) = pair(ek(a, b)) else { continue };
                let j = if ij[0] == i { ij[1] } else { ij[0] };
                let same = (0..3).any(|c| w[j][c] == a && w[j][(c + 1) % 3] == b);
                if !seen[j] {
                    seen[j] = true;
                    if same { w[j].swap(1, 2); }
                    comp.push(j);
                    flip.push(same);
                } else if same {
                    open.insert(ek(a, b));
                }
            }
        }
        let area = |f: bool| comp.iter().zip(&flip).filter(|x| *x.1 == f).map(|x| m.a[tris[*x.0] as usize]).sum::<f64>();
        if area(true) > area(false) { for &i in &comp { w[i].swap(1, 2); } }
    }
    let corner = |j: usize, v: u32| w[j].iter().position(|&x| x == v).unwrap();
    let mut par: Vec<usize> = (0..n * 3).collect();
    for i in 0..n {
        for k in 0..3 {
            let (a, b) = (w[i][k], w[i][(k + 1) % 3]);
            let key = ek(a, b);
            if open.contains(&key) { continue; }
            let Some(ij) = pair(key) else { continue };
            let j = if ij[0] == i { ij[1] } else { ij[0] };
            let (x, y) = (find(&mut par, i * 3 + k), find(&mut par, j * 3 + corner(j, a)));
            par[x] = y;
            let (x, y) = (find(&mut par, i * 3 + (k + 1) % 3), find(&mut par, j * 3 + corner(j, b)));
            par[x] = y;
        }
    }
    let (mut id, mut orig, mut t) = (vec![u32::MAX; n * 3], Vec::new(), vec![[0u32; 3]; n]);
    for c in 0..n * 3 {
        let r = find(&mut par, c);
        if id[r] == u32::MAX {
            id[r] = orig.len() as u32;
            orig.push(w[c / 3][c % 3]);
        }
        t[c / 3][c % 3] = id[r];
    }
    with_borders(tris.to_vec(), t, orig)
}

/// A local mesh from its triangles (global ids, local corners, local vertex → welded vertex): edge count and
/// border loops, each in winding order.
pub(crate) fn with_borders(tris: Vec<u32>, t: Vec<[u32; 3]>, orig: Vec<u32>) -> Local {
    let nv = orig.len();
    let mut ecount: Map<u64, u32> = Map::default();
    for tri in &t {
        for k in 0..3 { *ecount.entry(ek(tri[k], tri[(k + 1) % 3])).or_default() += 1; }
    }
    let mut bnext = vec![u32::MAX; nv];
    for tri in &t {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if ecount[&ek(a, b)] == 1 { bnext[a as usize] = b; }
        }
    }
    let (mut on_b, mut loops) = (vec![false; nv], Vec::new());
    for v in 0..nv {
        if bnext[v] == u32::MAX || on_b[v] { continue; }
        let (mut lp, mut w) = (Vec::new(), v as u32);
        while w != u32::MAX && !on_b[w as usize] {
            on_b[w as usize] = true;
            lp.push(w);
            w = bnext[w as usize];
        }
        loops.push(lp);
    }
    Local { tris, t, orig, nv, ne: ecount.len(), loops, on_b }
}

/// Book: a child island laid out against its parent along `run` (pairs of matching local vertices: parent's,
/// child's, in order along their shared border), the way a book opens along its spine. The parent keeps its layout;
/// the child is flattened again (LSCM + ARAP) with its copy of the spine pinned onto the parent's, so the two meet
/// along the whole spine and the child opens out on the far side (a flank and its top strip, then the other flank on
/// the strip's other edge: the grip "butterflied"). Some if the pair is one clean genus-0 piece within `tol`; a pair
/// that still folds is refused whole (carving the fold off would leave slits in the child and loose slivers).
///
/// Not a `page` but a fill: a small orphan (a groove wall carved off a face) pinned along every edge it shares with
/// the parent, so it closes the notch it came from, squashed if need be. The parent's own spine, if any, still sets
/// the net's turn.
pub fn book(m: &Mesh, a: &Island, b: &Island, run: &[(u32, u32)], tol: f64, page: bool) -> Option<Island> {
    // A child wound the same way round as its parent along their seam (winding can't agree across every edge of a
    // mesh) is turned over first, or the pair wouldn't glue into one consistently wound piece.
    let over;
    let b = if run.len() >= 2 && b.l.loops.iter().any(|lp| (0..lp.len()).any(|k| lp[k] == run[0].1 && lp[(k + 1) % lp.len()] == run[1].1)) {
        let mut l = b.l.clone();
        for t in &mut l.t { t.swap(1, 2); }
        for lp in &mut l.loops { lp.reverse(); }
        over = Island { part: b.part, f: crate::flatten::measure(&l, &crate::flatten::frames(m, &l), b.f.u.clone(), b.f.v.iter().map(|v| -v).collect()), l, spine: b.spine };
        &over
    } else { b };
    let pins: Vec<(usize, f64, f64)> = run.iter().map(|&(p, c)| (c as usize, a.f.u[p as usize], a.f.v[p as usize])).collect();
    let fb = crate::flatten::flatten_pinned(m, &b.l, &pins);
    let (cu, cv) = (&fb.u, &fb.v);
    // A fill goes in as it lies if the orphan pinned into its notch comes out clean, not stretched past FILL_STRETCH,
    // clear of the parent's outline and not lying on the parent. Otherwise the parent has closed the notch up (laid
    // out without the orphan, it pulled the notch's sides together): it's opened again round the orphan (`refill`).
    let mut fits = false;
    if !page {
        let na = a.l.nv;
        let (u2, v2): (Vec<f64>, Vec<f64>) = a.f.u.iter().chain(cu).copied().zip(a.f.v.iter().chain(cv).copied()).unzip();
        let loops: Vec<Vec<u32>> = a.l.loops.iter().cloned().chain(b.l.loops.iter().map(|lp| lp.iter().map(|&w| w + na as u32).collect())).collect();
        fits = fb.mean_e <= FILL_STRETCH && fb.flips == 0 && !fb.self_overlap && !crate::flatten::outline_crosses(&u2, &v2, &loops);
        let t = b.l.t[0].map(|w| w as usize);
        let c = ((cu[t[0]] + cu[t[1]] + cu[t[2]]) / 3., (cv[t[0]] + cv[t[1]] + cv[t[2]]) / 3.);
        let mut odd = false;
        for lp in &a.l.loops {
            for k in 0..lp.len() {
                let (p, q) = (lp[k] as usize, lp[(k + 1) % lp.len()] as usize);
                let (pu, pv, qu, qv) = (a.f.u[p], a.f.v[p], a.f.u[q], a.f.v[q]);
                if (pv > c.1) != (qv > c.1) && c.0 < pu + (c.1 - pv) / (qv - pv) * (qu - pu) { odd = !odd; }
            }
        }
        fits &= !odd;
    }
    // the two islands' own vertices side by side, the run's pairs merged: their cuts and slits stay as they are
    let na = a.l.nv;
    let mut par: Vec<usize> = (0..na + b.l.nv).collect();
    for &(p, c) in run { let (x, y) = (find(&mut par, p as usize), find(&mut par, na + c as usize)); par[x] = y; }
    let mut id = vec![u32::MAX; par.len()];
    let (mut orig, mut u, mut v, mut n) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for w in 0..par.len() {
        let r = find(&mut par, w);
        if id[r] == u32::MAX { id[r] = orig.len() as u32; orig.push(0); u.push(0.); v.push(0.); n.push(0.); }
        let k = id[r] as usize;
        let (o, x, y) = if w < na { (a.l.orig[w], a.f.u[w], a.f.v[w]) } else { (b.l.orig[w - na], cu[w - na], cv[w - na]) };
        // start from both layouts as they lie: a vertex on the seam at the mean of its two copies
        orig[k] = o; u[k] += x; v[k] += y; n[k] += 1.;
    }
    for k in 0..orig.len() { u[k] /= n[k]; v[k] /= n[k]; }
    let at: Vec<u32> = (0..par.len()).map(|w| id[find(&mut par, w)]).collect();
    let t: Vec<[u32; 3]> = a.l.t.iter().map(|t| t.map(|w| at[w as usize])).chain(b.l.t.iter().map(|t| t.map(|w| at[na + w as usize]))).collect();
    let mut l = with_borders(a.l.tris.iter().chain(&b.l.tris).copied().collect(), t, orig);
    let spine = if page { Some([at[run[0].0 as usize], at[run[run.len() - 1].0 as usize]]) } else { a.spine.map(|e| e.map(|w| at[w as usize])) };
    // genus 0, holes allowed (a strip with a port in it): ARAP doesn't need a disk
    if l.loops.is_empty() || l.chi() != 2 - l.loops.len() as i64 { return None; }
    // a page is relaxed as one from there, so the seam settles
    let fr = crate::flatten::frames(m, &l);
    let f = if page { let (u, v) = crate::flatten::arap(&l, &fr, u, v, 100); crate::flatten::measure(&l, &fr, u, v) } else {
        // a fill as it lies can still flip a sliver where the seam's two copies met halfway: open the notch then too
        match fits.then(|| crate::flatten::measure(&l, &fr, u.clone(), v.clone())) {
            Some(f) if f.flips == 0 && !f.self_overlap => f,
            _ => { let (u, v) = refill(m, &l, &u, &v, a.l.t.len())?; crate::flatten::measure(&l, &fr, u, v) }
        }
    };
    // whatever still folds back over the parent, or flips, isn't carved off: that leaves slits in the child and
    // slivers loose. The pair stays two solid islands instead.
    if f.mean_e > tol || f.flips > 0 || f.self_overlap { return None; }
    if !page {
        let (e, w) = (a.l.t.len()..l.t.len()).fold((0., 0.), |(e, w), i| (e + f.e[i] * fr.area[i], w + fr.area[i]));
        if e > FILL_STRETCH * w { return None; }
    }
    outer_first(&mut l, &f);
    Some(Island { part: a.part, l, f, spine })
}

/// A fill's notch opened again: the orphan's triangles (`from` on) and a few rings of the parent's round them laid
/// out anew, the rest held as it lies. Tutte's embedding inside the held ring first (each free vertex a positive mix
/// of its neighbours, with the cotan weights clamped positive: it doesn't flip in a ring that's star-shaped about the
/// notch), then SLIM with the rest held, which never folds. Wider rings until that comes out clean. Only the ring is
/// solved, as a mesh of its own.
fn refill(m: &Mesh, l: &Local, u: &[f64], v: &[f64], from: usize) -> Option<(Vec<f64>, Vec<f64>)> {
    let nt = l.t.len();
    let mut vt: Vec<Vec<usize>> = vec![Vec::new(); l.nv];
    for (i, t) in l.t.iter().enumerate() { for &w in t { vt[w as usize].push(i); } }
    let mut inside: Vec<bool> = (0..nt).map(|i| i >= from).collect();
    for ring in 1..=REFILL_RINGS {
        let verts: Vec<usize> = (0..nt).filter(|&i| inside[i]).flat_map(|i| l.t[i]).map(|q| q as usize).collect();
        for q in verts { for &i in &vt[q] { inside[i] = true; } }
        if ring < 2 { continue; }
        // the ring numbered on its own; the vertices that touch the rest are held
        let tris: Vec<usize> = (0..nt).filter(|&i| inside[i]).collect();
        let (mut id, mut back) = (vec![u32::MAX; l.nv], Vec::new());
        let t: Vec<[u32; 3]> = tris.iter().map(|&i| l.t[i].map(|q| {
            if id[q as usize] == u32::MAX { id[q as usize] = back.len() as u32; back.push(q as usize); }
            id[q as usize]
        })).collect();
        let sub = with_borders(tris.iter().map(|&i| l.tris[i]).collect(), t, back.iter().map(|&q| l.orig[q]).collect());
        let fr = crate::flatten::frames(m, &sub);
        let n = back.len();
        let (sum, cnt) = fr.rows.iter().flatten().fold((0., 0.), |(s, c), &(_, w)| (s + w.abs(), c + 1.));
        let floor = 1e-3 * sum / f64::max(cnt, 1.);
        let w = |x: f64| x.max(floor);
        let free: Vec<bool> = back.iter().map(|&q| vt[q].iter().all(|&i| inside[i])).collect();
        let a = fr.rows.iter().enumerate().map(|(i, r)| r.iter().map(|&(j, c)| (j, -w(c))).chain([(i, r.iter().map(|&(_, c)| w(c)).sum())]).collect()).collect();
        let Some(chol) = crate::flatten::Chol::new(a, &free) else { continue };
        let (mut tu, mut tv): (Vec<f64>, Vec<f64>) = back.iter().map(|&q| (u[q], v[q])).unzip();
        chol.solve(&vec![0.; n], &mut tu);
        chol.solve(&vec![0.; n], &mut tv);
        let s = crate::flatten::measure(&sub, &fr, tu, tv);
        if s.flips > 0 || s.self_overlap { continue; }
        let held: Vec<usize> = (0..n).filter(|&k| !free[k]).collect();
        let (su, sv) = crate::flatten::slim_held(&sub, &fr, s.u, s.v, 60, &held);
        let (mut nu, mut nv) = (u.to_vec(), v.to_vec());
        for (k, &q) in back.iter().enumerate() { (nu[q], nv[q]) = (su[k], sv[k]); }
        if !crate::flatten::outline_crosses(&nu, &nv, &l.loops) { return Some((nu, nv)); }
    }
    None
}

/// How many rings of the parent round a filled orphan `refill` may open up.
const REFILL_RINGS: usize = 4;

/// Most stretch a filled-in orphan may take on its own (a squashed groove wall), as long as the pair stays in `tol`.
const FILL_STRETCH: f64 = 0.7;

#[derive(PartialEq)]
struct Item(f64, u32);
impl Eq for Item {}
impl Ord for Item {
    fn cmp(&self, o: &Self) -> Ordering { o.0.total_cmp(&self.0) } // reversed: BinaryHeap pops the nearest
}
impl PartialOrd for Item {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) }
}

/// Shortest paths from `sources`; stops at the first node where `stop` holds and returns it.
pub fn dijkstra(adj: &[Vec<(u32, f64)>], sources: &[u32], stop: impl Fn(u32) -> bool) -> (Vec<f64>, Vec<u32>, Option<u32>) {
    let (mut dist, mut prev, mut h) = (vec![f64::INFINITY; adj.len()], vec![u32::MAX; adj.len()], BinaryHeap::new());
    for &s in sources {
        dist[s as usize] = 0.;
        h.push(Item(0., s));
    }
    while let Some(Item(d, v)) = h.pop() {
        if d > dist[v as usize] { continue; }
        if stop(v) { return (dist, prev, Some(v)); }
        for &(u, w) in &adj[v as usize] {
            let nd = d + w;
            if nd < dist[u as usize] {
                dist[u as usize] = nd;
                prev[u as usize] = v;
                h.push(Item(nd, u));
            }
        }
    }
    (dist, prev, None)
}

/// Vertex graph of a chart, weighted by edge length.
pub(crate) fn vert_adj(m: &Mesh, l: &Local) -> Vec<Vec<(u32, f64)>> { adj_by(l, |a, b| dist(m.pt(a), m.pt(b)) * if m.inside(ek(a, b)) { INSIDE } else { 1. }) }

/// A seam through a polygon (along its diagonal) costs this many times its length: it'd split the face in the export,
/// so paths go round by the polygon's own edges.
const INSIDE: f64 = 1e3;

/// Vertex graph of a chart weighted by what a seam along each edge costs (`seam_cost`): cuts run through creases
/// and hidden surface where they can.
fn seam_adj(m: &Mesh, l: &Local) -> Vec<Vec<(u32, f64)>> { adj_by(l, |a, b| seam_cost(m, a, b)) }

/// What a seam along welded edge a–b costs: its length, less where it won't be seen. In a concave crease (a groove's
/// floor, a wall's inside corner) down to half at a right angle; on surface hidden inside the model (as charting
/// found it, `Mesh::hidden`) down to a quarter.
pub(crate) fn seam_cost(m: &Mesh, a: u32, b: u32) -> f64 {
    let ts = &m.edges[&ek(a, b)];
    let mut w = 1.;
    if let [s, t] = ts[..] {
        let (ns, nt) = (m.n[s as usize], m.n[t as usize]);
        // concave: each triangle lies on the side the other faces
        if dot(sub(m.centroid(t), m.centroid(s)), ns) > 0. { w *= 1. - 0.5 * (dot(ns, nt).clamp(-1., 1.).acos() / std::f64::consts::FRAC_PI_2).min(1.); }
    }
    if let Some(h) = m.hidden.get() { w *= 1. - 0.75 * ts.iter().filter(|&&t| h[t as usize]).count() as f64 / ts.len() as f64; }
    if m.inside(ek(a, b)) { w *= INSIDE; }
    w * dist(m.pt(a), m.pt(b))
}

/// Vertex graph of a chart, each edge weighted by `w` of its welded ends.
fn adj_by(l: &Local, w: impl Fn(u32, u32) -> f64) -> Vec<Vec<(u32, f64)>> {
    let mut adj = vec![Vec::new(); l.nv];
    for tri in &l.t {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            let w = w(l.orig[a as usize], l.orig[b as usize]);
            adj[a as usize].push((b, w));
            adj[b as usize].push((a, w));
        }
    }
    adj
}

/// Welded edge keys along a shortest-path tree from `w` back to its source.
pub(crate) fn path_keys(l: &Local, prev: &[u32], mut w: u32, keys: &mut Vec<u64>) {
    while w != u32::MAX && prev[w as usize] != u32::MAX {
        let p = prev[w as usize];
        keys.push(ek(l.orig[w as usize], l.orig[p as usize]));
        w = p;
    }
}

/// Shortest edge path from any `from` vertex to any `to` vertex, as welded edge keys to cut.
pub fn cut_path(m: &Mesh, l: &Local, from: &[u32], to: &Set<u32>) -> Vec<u64> {
    let (_, prev, end) = dijkstra(&seam_adj(m, l), from, |v| to.contains(&v));
    let mut keys = Vec::new();
    path_keys(l, &prev, end.unwrap_or(u32::MAX), &mut keys);
    keys
}

/// A closed sphere-like chart opens along the path between its two farthest points.
fn far_cut(m: &Mesh, l: &Local) -> Vec<u64> {
    let adj = vert_adj(m, l);
    let far = |d: &[f64]| (0..d.len()).max_by(|&x, &y| d[x].total_cmp(&d[y])).unwrap() as u32;
    let a = far(&dijkstra(&adj, &[0], |_| false).0);
    let (d, prev, _) = dijkstra(&adj, &[a], |_| false);
    let mut keys = Vec::new();
    path_keys(l, &prev, far(&d), &mut keys);
    keys
}

/// Tree-cotree (Erickson & Whittlesey's greedy homotopy generators): the shortest loops that cut a closed
/// genus-g chart into one disk. Shortest-path tree from a root; the dual tree keeps the edges whose loops
/// would be longest; each edge left over closes one generator loop (2g of them: a torus gets 2).
fn loop_cut(m: &Mesh, l: &Local) -> Vec<u64> {
    let (d, prev, _) = dijkstra(&vert_adj(m, l), &[0], |_| false);
    let mut et: Map<u64, Vec<usize>> = Map::default();
    for (i, tri) in l.t.iter().enumerate() {
        for k in 0..3 { et.entry(ek(tri[k], tri[(k + 1) % 3])).or_default().push(i); }
    }
    let ends = |k: u64| ((k >> 32) as u32, (k & 0xffff_ffff) as u32);
    let mut dual: Vec<(f64, u64, usize, usize)> = et.iter().filter_map(|(&k, ts)| {
        let (a, b) = ends(k);
        let tree = prev[a as usize] == b || prev[b as usize] == a;
        let len = d[a as usize] + d[b as usize] + dist(m.pt(l.orig[a as usize]), m.pt(l.orig[b as usize]));
        (ts.len() == 2 && !tree).then(|| (len, k, ts[0], ts[1]))
    }).collect();
    dual.sort_by(|x, y| y.0.total_cmp(&x.0));
    let (mut par, mut keys): (Vec<usize>, _) = ((0..l.t.len()).collect(), Vec::new());
    for (_, k, t1, t2) in dual {
        let (x, y) = (find(&mut par, t1), find(&mut par, t2));
        if x != y { par[x] = y; continue; }
        let (a, b) = ends(k);
        keys.push(ek(l.orig[a as usize], l.orig[b as usize]));
        path_keys(l, &prev, a, &mut keys);
        path_keys(l, &prev, b, &mut keys);
    }
    keys
}

/// Interior vertex whose angles sum furthest from 360° (a cone tip), if any is far enough to matter.
pub fn worst_defect(m: &Mesh, l: &Local) -> Option<u32> {
    let mut sum = vec![0.; l.nv];
    for tri in &l.t {
        for k in 0..3 {
            let a = m.pt(l.orig[tri[k] as usize]);
            let b = sub(m.pt(l.orig[tri[(k + 1) % 3] as usize]), a);
            let c = sub(m.pt(l.orig[tri[(k + 2) % 3] as usize]), a);
            sum[tri[k] as usize] += norm(cross(b, c)).atan2(dot(b, c));
        }
    }
    // ponytail: fixed 0.5 rad threshold; noisy scanned meshes may want it as a parameter
    let mut best = None;
    let mut bd = 0.5;
    for v in 0..l.nv {
        let d = (std::f64::consts::TAU - sum[v]).abs();
        if !l.on_b[v] && d > bd { bd = d; best = Some(v as u32); }
    }
    best
}

/// Split a chart in two. First by which way faces point (the "cameras" idea with two views):
/// a torus gives its top and bottom rings, a sphere two caps. If that shreds the chart into
/// more than two pieces (a twisted tube like the knot), split by distance along the surface instead.
pub fn split(m: &Mesh, tris: &[u32]) -> Vec<Vec<u32>> {
    let n = |t: u32| m.n[t as usize];
    let n0 = n(tris[0]);
    let a = *tris.iter().min_by(|&&x, &&y| dot(n(x), n0).total_cmp(&dot(n(y), n0))).unwrap();
    let b = *tris.iter().min_by(|&&x, &&y| dot(n(x), n(a)).total_cmp(&dot(n(y), n(a)))).unwrap();
    let (mut ca, mut cb) = (n(a), n(b));
    let mut side: Map<u32, bool> = Map::default();
    for _ in 0..8 {
        let (mut sa, mut sb) = ([0.; 3], [0.; 3]);
        for &t in tris {
            let s = dot(n(t), ca) < dot(n(t), cb);
            side.insert(t, s);
            let acc = if s { &mut sb } else { &mut sa };
            for k in 0..3 { acc[k] += n(t)[k] * m.a[t as usize]; }
        }
        let (la, lb) = (norm(sa), norm(sb));
        if la > 0. { ca = sa.map(|x| x / la); }
        if lb > 0. { cb = sb.map(|x| x / lb); }
    }
    let parts = components(m, tris, |t| side[&t]);
    let parts = if parts.len() == 2 { parts } else { split_far(m, tris) };
    // with polygons kept whole; a chart that's all one polygon is cut through it rather than not at all
    let w = whole(m, parts.clone());
    if w.len() >= 2 { w } else { parts }
}

/// The same pieces with each of the file's polygons whole (in the piece holding most of its area), then split into
/// edge-connected pieces: no seam runs through a face (`Mesh::poly`).
pub fn whole(m: &Mesh, pieces: Vec<Vec<u32>>) -> Vec<Vec<u32>> {
    let mut area: Map<(u32, usize), f64> = Map::default();
    for (i, p) in pieces.iter().enumerate() { for &t in p { *area.entry((m.poly[t as usize], i)).or_default() += m.a[t as usize]; } }
    let mut to: Map<u32, (usize, f64)> = Map::default();
    for (&(q, i), &a) in &area {
        let e = to.entry(q).or_insert((i, a));
        if a > e.1 || (a == e.1 && i < e.0) { *e = (i, a); }
    }
    if pieces.iter().enumerate().all(|(i, p)| p.iter().all(|&t| to[&m.poly[t as usize]].0 == i)) { return pieces; }
    let mut out = vec![Vec::new(); pieces.len()];
    for p in &pieces { for &t in p { out[to[&m.poly[t as usize]].0].push(t); } }
    out.into_iter().filter(|p| !p.is_empty()).flat_map(|p| components(m, &p, |_| true)).collect()
}

/// The two halves nearest each of the two triangles farthest apart along the surface (a tube → two ring segments).
fn split_far(m: &Mesh, tris: &[u32]) -> Vec<Vec<u32>> {
    let idx: Map<u32, usize> = tris.iter().enumerate().map(|(i, &t)| (t, i)).collect();
    let cen: Vec<V3> = tris.iter().map(|&t| m.centroid(t)).collect();
    let adj: Vec<Vec<(u32, f64)>> = tris.iter().enumerate().map(|(i, &t)| {
        m.neighbors(t).filter_map(|u| idx.get(&u).map(|&j| (j as u32, dist(cen[i], cen[j])))).collect()
    }).collect();
    let far = |d: &[f64]| (0..d.len()).max_by(|&x, &y| d[x].total_cmp(&d[y])).unwrap() as u32;
    let a = far(&dijkstra(&adj, &[0], |_| false).0);
    let da = dijkstra(&adj, &[a], |_| false).0;
    let db = dijkstra(&adj, &[far(&da)], |_| false).0;
    let parts = components(m, tris, |t| { let i = idx[&t]; da[i] > db[i] });
    if parts.len() >= 2 { parts } else { components(m, tris, |t| idx[&t] < tris.len() / 2) }
}

/// Edge-connected pieces of `tris` with the same `side`.
fn components(m: &Mesh, tris: &[u32], side: impl Fn(u32) -> bool) -> Vec<Vec<u32>> {
    let inside: Set<u32> = tris.iter().copied().collect();
    let mut seen = Set::default();
    let mut out = Vec::new();
    for &s in tris {
        if !seen.insert(s) { continue; }
        let (mut comp, mut q, ss) = (vec![s], 0, side(s));
        while q < comp.len() {
            let t = comp[q];
            q += 1;
            for u in m.neighbors(t) {
                if inside.contains(&u) && side(u) == ss && seen.insert(u) { comp.push(u); }
            }
        }
        out.push(comp);
    }
    out
}



