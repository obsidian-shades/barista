//! Reflection symmetry of a part, the way an artist sees a grip or a frame: a left and a right that mirror each other
//! across one plane. Such a part is charted, solved and joined on one half only, with a seam along the plane, and the
//! other half is laid out as that half's mirror image, island for island (`unwrap`); packing puts each net beside its
//! mirror, facing it (`pack::twin`): two mirrored halves, the butterfly. Bits with no mirror image (a lever on one
//! side) are charted on their own as usual.
//!
//! The plane: a mirror plane's normal is always an axis of the part's spread (principal axes of the surface,
//! through its centroid). An axis whose spread is shared with another (a cylinder's radial axes, a box's square
//! end) is no single axis, so directions in that plane are tried in half-degree steps; each candidate is refined
//! from the vertex pairs it matches and kept if nearly every vertex has its partner. Only a part with exactly one
//! mirror plane has a left and a right: a cylinder, a torus or a cube has many, and is left as it is.
use crate::chart::{self, Island};
use crate::mesh::*;
use crate::Params;

/// One mirrored part's islands, each one's net (dense ids), and the (kept, image) net pairs to pack side by side.
pub fn unwrap(m: &Mesh, s: &Mirror, seams: &Set<u64>, p: &Params) -> (Vec<Island>, Vec<usize>, Vec<(usize, usize)>) {
    let mut cut = seams.clone();
    cut.extend(s.seam(m));
    let (kc, mut oc): (Vec<Vec<u32>>, Vec<Vec<u32>>) = crate::region::charts(m, p.sharp, &cut).into_iter()
        .filter(|c| s.half[c[0] as usize] != Half::Image).partition(|c| s.half[c[0] as usize] == Half::Kept);
    let mut kept = chart::islands(m, kc, &cut, p);
    let join = |isl: &mut Vec<Island>| if p.join { crate::join::join(m, isl, p.tol) } else { (0..isl.len()).collect() };
    let nk = join(&mut kept);
    let (images, lost) = s.images(m, &kept);
    // image triangles that land in no kept island whole (a kept seam along what is a diagonal on this side) join
    // the one-sided chart they share most edges with, or make one of their own
    let mut of = vec![usize::MAX; m.f.len()];
    for (i, c) in oc.iter().enumerate() { for &t in c { of[t as usize] = i; } }
    for piece in pieces(m, &lost) {
        let mut shared: Map<usize, usize> = Map::default();
        for &t in &piece {
            let f = m.f[t as usize];
            for k in 0..3 {
                let e = ek(f[k], f[(k + 1) % 3]);
                if seams.contains(&e) { continue; }
                for &u in &m.edges[&e] { if of[u as usize] != usize::MAX { *shared.entry(of[u as usize]).or_default() += 1; } }
            }
        }
        match shared.into_iter().max_by_key(|&(i, n)| (n, std::cmp::Reverse(i))) {
            Some((i, _)) => oc[i].extend(piece),
            None => oc.push(piece),
        }
    }
    let mut own = chart::islands(m, oc, seams, p);
    let no = join(&mut own);
    let k = nk.iter().max().map_or(0, |x| x + 1);
    let mut net = nk.clone();
    let mut isl = kept;
    for (i, im) in images { net.push(nk[i] + k); isl.push(im); }
    net.extend(no.iter().map(|g| g + 2 * k));
    let first = isl.len();
    isl.extend(own);
    if p.join { hang_fragments(m, &mut isl, &mut net, first); }
    // the kept half, its mirror and the one-sided bits were solved (and normalised) separately: one density for
    // the lot, or the butterfly's two halves come out at different texel sizes
    chart::normalise(m, &mut isl);
    let mut ids: Map<usize, usize> = Map::default();
    let net: Vec<usize> = net.iter().map(|&g| { let n = ids.len(); *ids.entry(g).or_insert(n) }).collect();
    let twins = (0..k).filter_map(|g| Some((*ids.get(&g)?, *ids.get(&(g + k))?))).collect();
    (isl, net, twins)
}

/// A one-sided island alone in its net and under this share of the part: a fragment, hung off a neighbour.
const FRAGMENT: f64 = 0.03;
/// How much of each of its triangles a hung fragment must keep clear of its new net (towards the centre).
const SNUG: f64 = 0.9;

/// One-sided fragments (islands from `first` on, each alone in its net and small: a sliver where the halves'
/// triangulations disagree) hung rigidly off the neighbour they share the most border with, along a shared edge,
/// as they lie or flipped over, wherever they don't overlap that neighbour's net. Only fragments move: a mirrored
/// pair stays each other's image, plus what hangs off it.
fn hang_fragments(m: &Mesh, isl: &mut [Island], net: &mut [usize], first: usize) {
    let area = |s: &Island| s.l.tris.iter().map(|&t| m.a[t as usize]).sum::<f64>();
    let total: f64 = isl.iter().map(area).sum();
    let mut border: Map<u64, Vec<(usize, u32, u32)>> = Map::default();
    for (i, s) in isl.iter().enumerate() {
        for lp in &s.l.loops {
            for k in 0..lp.len() {
                let (a, b) = (lp[k], lp[(k + 1) % lp.len()]);
                border.entry(ek(s.l.orig[a as usize], s.l.orig[b as usize])).or_default().push((i, a, b));
            }
        }
    }
    let alone = |net: &[usize], j: usize| net.iter().filter(|&&g| g == net[j]).count() == 1;
    let mut order: Vec<usize> = (first..isl.len()).filter(|&j| alone(net, j) && area(&isl[j]) < FRAGMENT * total).collect();
    order.sort_by(|&x, &y| area(&isl[y]).total_cmp(&area(&isl[x])).then(x.cmp(&y)));
    for j in order {
        // shared edges per neighbour: (parent's ends, the child's ends at the same welded vertices, length)
        let mut by: Map<usize, Vec<(u32, u32, u32, u32, f64)>> = Map::default();
        for lp in &isl[j].l.loops {
            for k in 0..lp.len() {
                let (a, b) = (lp[k], lp[(k + 1) % lp.len()]);
                let (oa, ob) = (isl[j].l.orig[a as usize], isl[j].l.orig[b as usize]);
                for &(i, pa, pb) in &border[&ek(oa, ob)] {
                    if i == j { continue; }
                    let (pa, pb) = if isl[i].l.orig[pa as usize] == oa { (pa, pb) } else { (pb, pa) };
                    by.entry(i).or_default().push((pa, pb, a, b, dist(m.pt(oa), m.pt(ob))));
                }
            }
        }
        let mut parents: Vec<(f64, usize)> = by.iter().map(|(&i, hs)| (hs.iter().map(|h| h.4).sum(), i)).collect();
        parents.sort_by(|x, y| y.0.total_cmp(&x.0).then(x.1.cmp(&y.1)));
        'tries: for &(_, i) in parents.iter().take(3) {
            let mut hs = by[&i].clone();
            hs.sort_by(|x, y| y.4.total_cmp(&x.4));
            for &(pa, pb, ca, cb, _) in hs.iter().take(3) {
                for flip in [false, true] {
                    let Some((u, v)) = hang(&isl[i], &isl[j], [pa, pb, ca, cb], flip) else { continue };
                    // each a little shrunk: it was flattened on its own, so it fills the gap it came from only nearly
                    let shrink = |t: [(f64, f64); 3]| { let c = ((t[0].0 + t[1].0 + t[2].0) / 3., (t[0].1 + t[1].1 + t[2].1) / 3.); t.map(|p| (c.0 + SNUG * (p.0 - c.0), c.1 + SNUG * (p.1 - c.1))) };
                    let mine: Vec<[(f64, f64); 3]> = isl[j].l.t.iter().map(|t| shrink(t.map(|q| (u[q as usize], v[q as usize])))).collect();
                    let clash = (0..isl.len()).filter(|&k| net[k] == net[i]).any(|k| {
                        let s = &isl[k];
                        s.l.t.iter().any(|t| { let y = t.map(|q| (s.f.u[q as usize], s.f.v[q as usize])); mine.iter().any(|&x| overlap(x, y)) })
                    });
                    if clash { continue; }
                    let s = &mut isl[j];
                    (s.f.u, s.f.v) = (u, v);
                    // flipped over: wound the other way so its triangles still read as unflipped
                    if flip { for t in &mut s.l.t { t.swap(1, 2); } for lp in &mut s.l.loops { lp.reverse(); } }
                    net[j] = net[i];
                    break 'tries;
                }
            }
        }
    }
}

/// The child's UVs moved (and flipped over, if asked) so its copy of a shared edge lands on the parent's:
/// h = [parent's a, parent's b, child's a, child's b].
fn hang(parent: &Island, child: &Island, h: [u32; 4], flip: bool) -> Option<(Vec<f64>, Vec<f64>)> {
    let s = if flip { -1. } else { 1. };
    let pt = |x: &Island, q: u32, s: f64| (s * x.f.u[q as usize], x.f.v[q as usize]);
    let (p0, p1, q0, q1) = (pt(parent, h[0], 1.), pt(parent, h[1], 1.), pt(child, h[2], s), pt(child, h[3], s));
    let (lp, lq) = ((p1.0 - p0.0).hypot(p1.1 - p0.1), (q1.0 - q0.0).hypot(q1.1 - q0.1));
    if lp < 1e-12 || lq < 1e-12 { return None; }
    let th = (p1.1 - p0.1).atan2(p1.0 - p0.0) - (q1.1 - q0.1).atan2(q1.0 - q0.0);
    let (cs, sn) = (th.cos(), th.sin());
    Some(child.f.u.iter().zip(&child.f.v).map(|(&x, &y)| {
        let (dx, dy) = (s * x - q0.0, y - q0.1);
        (p0.0 + cs * dx - sn * dy, p0.1 + sn * dx + cs * dy)
    }).unzip())
}

/// Whether two UV triangles overlap: edges crossing properly, or one's centre inside the other. Touching (a shared
/// edge, a corner on an edge) doesn't count.
fn overlap(x: [(f64, f64); 3], y: [(f64, f64); 3]) -> bool {
    let lo_hi = |t: [(f64, f64); 3], k: usize| t.iter().map(|p| if k == 0 { p.0 } else { p.1 }).fold((f64::MAX, f64::MIN), |r, a| (r.0.min(a), r.1.max(a)));
    if (0..2).any(|k| { let (a, b) = (lo_hi(x, k), lo_hi(y, k)); a.1 <= b.0 || b.1 <= a.0 }) { return false; }
    let size = (0..2).map(|k| { let r = lo_hi(x, k); r.1 - r.0 }).fold(0., f64::max).max(1e-300);
    let tol = size * size * 1e-6;
    let side = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| { let s = (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0); if s.abs() < tol { 0. } else { s.signum() } };
    let inside = |t: [(f64, f64); 3], c: (f64, f64)| { let s = side(t[0], t[1], t[2]); s != 0. && (0..3).all(|k| side(t[k], t[(k + 1) % 3], c) == s) };
    let centre = |t: [(f64, f64); 3]| ((t[0].0 + t[1].0 + t[2].0) / 3., (t[0].1 + t[1].1 + t[2].1) / 3.);
    (0..3).any(|i| (0..3).any(|j| {
        let (a, b, c, d) = (x[i], x[(i + 1) % 3], y[j], y[(j + 1) % 3]);
        side(a, b, c) * side(a, b, d) < 0. && side(c, d, a) * side(c, d, b) < 0.
    })) || inside(x, centre(y)) || inside(y, centre(x))
}

/// The outline first: the border loop enclosing the most UV area (as `chart` keeps it).
fn outer_first(l: &mut chart::Local, f: &crate::flatten::Flat) {
    let area = |lp: &Vec<u32>| (0..lp.len()).map(|k| {
        let (a, b) = (lp[k] as usize, lp[(k + 1) % lp.len()] as usize);
        f.u[a] * f.v[b] - f.u[b] * f.v[a]
    }).sum::<f64>().abs();
    if let Some(i) = (0..l.loops.len()).max_by(|&x, &y| area(&l.loops[x]).total_cmp(&area(&l.loops[y]))) { l.loops.swap(0, i); }
}

/// Edge-connected pieces of `tris`.
fn pieces(m: &Mesh, tris: &[u32]) -> Vec<Vec<u32>> {
    let mut left: Set<u32> = tris.iter().copied().collect();
    let mut out = Vec::new();
    for &s in tris {
        if !left.remove(&s) { continue; }
        let (mut comp, mut q) = (vec![s], 0);
        while q < comp.len() {
            let t = comp[q];
            q += 1;
            for u in m.neighbors(t) { if left.remove(&u) { comp.push(u); } }
        }
        out.push(comp);
    }
    out
}

pub struct Mirror {
    /// The plane: points x with n·x = d (the mesh's normalised frame).
    pub n: V3,
    pub d: f64,
    /// Vertex → its mirror image (itself on the plane), NONE without one.
    pub v: Vec<u32>,
    /// Per triangle: which half it's in.
    pub half: Vec<Half>,
}

/// How far (share of the part's radius) a vertex's mirror image may land from its partner.
const TOL: f64 = 1e-3;
/// The same for a plane the artist drew: slightly asymmetric models still mirror their bulk, and an odd detail with
/// no partner within this stays one-sided.
pub const HAND_TOL: f64 = 3e-3;
/// How close to a drawn plane a vertex must be for the plane's distance to move onto its layer.
const HAND_BAND: f64 = 8e-3;
/// Share of vertices that must have a partner for a plane to count.
const NEARLY_ALL: f64 = 0.9;
/// Spreads closer than this (share of the largest) make one axis plane, not two axes.
const SAME_SPREAD: f64 = 0.02;

pub fn find(m: &Mesh) -> Option<Mirror> {
    // area-weighted centroid and spread of the surface (triangle centroids)
    let total: f64 = m.a.iter().sum();
    let cs: Vec<V3> = (0..m.f.len() as u32).map(|t| m.centroid(t)).collect();
    let mut c = [0.; 3];
    for (q, a) in cs.iter().zip(&m.a) { for k in 0..3 { c[k] += q[k] * a / total; } }
    let mut cov = [[0.; 3]; 3];
    for (q, a) in cs.iter().zip(&m.a) {
        let d = sub(*q, c);
        for i in 0..3 { for j in 0..3 { cov[i][j] += d[i] * d[j] * a / total; } }
    }
    let (val, vec) = eigen(cov);
    let big = val.iter().copied().fold(0., f64::max).max(1e-300);
    let same = |i: usize, j: usize| (val[i] - val[j]).abs() < SAME_SPREAD * big;
    if same(0, 1) && same(1, 2) { return None; } // no axes at all: a sphere, a cube
    let mut cands = Vec::new();
    for i in 0..3 {
        let (j, k) = ((i + 1) % 3, (i + 2) % 3);
        if !same(i, j) && !same(i, k) { cands.push(vec[i]); }
        if same(i, j) {
            for s in 0..360 {
                let a = (s as f64 * 0.5).to_radians();
                cands.push([0, 1, 2].map(|x| a.cos() * vec[i][x] + a.sin() * vec[j][x]));
            }
        }
    }
    let grid = Grid::new(&m.p, 0.02);
    let mut planes: Vec<(V3, f64)> = Vec::new();
    for n in cands {
        let Some((n, d)) = refine(m, &grid, n, dot(n, c)) else { continue };
        if !planes.iter().any(|p| dot(p.0, n).abs() > 0.9998) { planes.push((n, d)); }
        if planes.len() > 1 { return None; }
    }
    let (n, d) = planes.pop()?;
    at(m, n.map(|x| x * d), n, TOL)
}

/// A mirror across a plane the artist drew: `point` on it and its `normal`, both in the mesh's normalised frame.
///
/// No searching and no snapping of the normal: the plane is honoured as drawn, because the whole point is that the
/// guess was wrong. The distance is nudged onto the nearest layer of vertices (`HAND_BAND` round the drawn plane), so
/// the centre seam runs along edges instead of cutting a ragged strip out of the faces a few tenths of a percent off;
/// the normal is kept, which is the part the artist is actually judging. Vertices with no partner within `HAND_TOL`
/// are one-sided (`Half::Own`), so a slightly asymmetric model still mirrors its bulk and charts the odd detail once.
pub fn hand(m: &Mesh, point: V3, normal: V3) -> Option<Mirror> {
    let l = norm(normal);
    if !(l > 1e-12) || !point.iter().all(|x| x.is_finite()) { return None; }
    let n = normal.map(|x| x / l);
    let mut d = dot(n, point);
    // the plane the vertices themselves lie on: the median of those within reach of the drawn one, so a drawn plane a
    // hair off the mirror line still cuts between two rows of faces instead of through one
    let mut near: Vec<f64> = m.p.iter().map(|q| dot(*q, n)).filter(|x| (x - d).abs() <= HAND_BAND).collect();
    if near.len() >= 8 {
        near.sort_by(f64::total_cmp);
        d = near[near.len() / 2];
    }
    at(m, n.map(|x| x * d), n, HAND_TOL)
}

/// The mirror map for a plane: vertices within `tol` (share of the radius) of their image get one, the rest are
/// one-sided; triangles that straddle the plane (or touch a one-sided vertex) are charted on their own.
fn at(m: &Mesh, point: V3, n: V3, tol: f64) -> Option<Mirror> {
    let d = dot(n, point);
    let fine = Grid::new(&m.p, tol);
    let v: Vec<u32> = (0..m.p.len()).map(|i| fine.near(&m.p, reflect(m.p[i], n, d), tol).unwrap_or(NONE)).collect();
    let side = |x: u32| { let s = dot(m.pt(x), n) - d; if s > tol { 1 } else if s < -tol { -1 } else { 0 } };
    let half = m.f.iter().map(|f| {
        let s = f.map(side);
        if f.iter().any(|&x| v[x as usize] == NONE) || s.contains(&1) == s.contains(&-1) { Half::Own }
        else if s.contains(&1) { Half::Kept } else { Half::Image }
    }).collect();
    Some(Mirror { n, d, v, half })
}

pub const NONE: u32 = u32::MAX;
/// Stretch past which an image triangle is charted on its own rather than kept in its mirrored island.
const BAD_STRETCH: f64 = 2.;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Half {
    /// On the charted side, with an image on the other.
    Kept,
    /// On the other side: laid out as the mirror of the kept half.
    Image,
    /// No image (a one-sided detail), or straddling the plane: charted on its own.
    Own,
}

impl Mirror {
    /// The edges between kept, image and own triangles: the centre line, and round one-sided details.
    pub fn seam(&self, m: &Mesh) -> Set<u64> {
        m.edges.iter().filter(|(_, ts)| ts.iter().any(|&t| self.half[t as usize] != self.half[ts[0] as usize])).map(|(&k, _)| k).collect()
    }

    /// Whether every mirrored edge in `seams` has its image there too (hand seams on one side only break the mirror).
    pub fn keeps(&self, seams: &Set<u64>) -> bool {
        seams.iter().all(|&k| {
            let (a, b) = (self.v[(k >> 32) as usize], self.v[(k & 0xffff_ffff) as usize]);
            a == NONE || b == NONE || seams.contains(&ek(a, b))
        })
    }

    /// Share of the surface that mirrors (kept and image triangles): near 1 for a truly mirrored part, low for a
    /// drawn plane that doesn't fit the model.
    pub fn coverage(&self, m: &Mesh) -> f64 {
        let total: f64 = m.a.iter().sum();
        let split: f64 = (0..m.f.len()).filter(|&t| self.half[t] != Half::Own).map(|t| m.a[t]).sum();
        if total > 0. { split / total } else { 0. }
    }

    /// Whether the plane actually cuts the part in two: triangles on both sides, with images.
    pub fn splits(&self) -> bool {
        self.half.iter().any(|h| *h == Half::Kept) && self.half.iter().any(|h| *h == Half::Image)
    }

    /// Each kept island's image: the image half's triangles that land on it, laid out on its UVs with u flipped.
    /// A triangle lands where its mirrored centre falls inside a kept triangle facing the same way, its mirrored
    /// corners taken from that triangle and the ones round it (a quad split the other way spans two). Returns the
    /// images with their kept island's index, and the triangles that landed nowhere whole.
    fn images(&self, m: &Mesh, kept: &[Island]) -> (Vec<(usize, Island)>, Vec<u32>) {
        let mut at = vec![(usize::MAX, 0usize); m.f.len()];
        let mut around: Vec<Vec<u32>> = vec![Vec::new(); m.p.len()];
        for (i, s) in kept.iter().enumerate() {
            for (j, &t) in s.l.tris.iter().enumerate() {
                at[t as usize] = (i, j);
                for &x in &m.f[t as usize] { around[x as usize].push(t); }
            }
        }
        let et: Vec<Map<u64, Vec<usize>>> = kept.iter().map(|s| {
            let mut e: Map<u64, Vec<usize>> = Map::default();
            for (j, t) in s.l.t.iter().enumerate() { for k in 0..3 { e.entry(ek(t[k], t[(k + 1) % 3])).or_default().push(j); } }
            e
        }).collect();
        // how far inside triangle k a point lies: its least barycentric coordinate in k's plane
        let inside = |k: u32, c: V3| {
            let [a, b, d] = m.f[k as usize].map(|x| m.pt(x));
            let (e1, e2, w) = (sub(b, a), sub(d, a), sub(c, a));
            let (aa, ab, bb, wa, wb) = (dot(e1, e1), dot(e1, e2), dot(e2, e2), dot(w, e1), dot(w, e2));
            let det = (aa * bb - ab * ab).max(1e-300);
            let (y, z) = ((bb * wa - ab * wb) / det, (aa * wb - ab * wa) / det);
            (1. - y - z).min(y).min(z)
        };
        let (mut got, mut lost): (Vec<Vec<(u32, [u32; 3])>>, Vec<u32>) = (vec![Vec::new(); kept.len()], Vec::new());
        for t in (0..m.f.len() as u32).filter(|&t| self.half[t as usize] == Half::Image) {
            let g = m.f[t as usize].map(|x| self.v[x as usize]);
            let (c, nt) = (reflect(m.centroid(t), self.n, self.d), m.n[t as usize]);
            let nr = [0, 1, 2].map(|k| nt[k] - 2. * dot(nt, self.n) * self.n[k]);
            // two rings round the mirrored corners: an n-gon split differently may hold it in a triangle touching none
            let ring: Set<u32> = g.iter().flat_map(|&x| &around[x as usize]).flat_map(|&k| &m.f[k as usize]).flat_map(|&x| &around[x as usize]).copied().collect();
            let mut ring: Vec<u32> = ring.into_iter().collect();
            ring.sort();
            // facing either way (the winding can flip between halves), on the surface (not a thin wall's far side)
            let on = |k: u32| dot(sub(c, m.pt(m.f[k as usize][0])), m.n[k as usize]).abs() < (3. * TOL).max(0.2 * (2. * m.a[k as usize]).sqrt());
            let best = ring.into_iter().filter(|&k| dot(m.n[k as usize], nr).abs() > 0.5 && on(k))
                .max_by(|&x, &y| inside(x, c).total_cmp(&inside(y, c)).then(y.cmp(&x)));
            let Some(k) = best.filter(|&k| inside(k, c) > -1e-6) else { lost.push(t); continue };
            let (i, j) = at[k as usize];
            if i == usize::MAX { lost.push(t); continue; }
            let s = &kept[i];
            let mut near = vec![j];
            for _ in 0..2 {
                for q in near.clone() {
                    let lt = s.l.t[q];
                    for e in 0..3 { for &r in &et[i][&ek(lt[e], lt[(e + 1) % 3])] { if !near.contains(&r) { near.push(r); } } }
                }
            }
            // the copy nearest the triangle it landed in, should a slit leave two within reach
            let kc = s.l.t[j].iter().fold((0., 0.), |c, &q| (c.0 + s.f.u[q as usize] / 3., c.1 + s.f.v[q as usize] / 3.));
            let gap = |lv: u32| (s.f.u[lv as usize] - kc.0).hypot(s.f.v[lv as usize] - kc.1);
            let corner = |w: u32| near.iter().flat_map(|&q| s.l.t[q]).filter(|&lv| s.l.orig[lv as usize] == w).min_by(|&x, &y| gap(x).total_cmp(&gap(y)));
            match g.map(corner) { [Some(a), Some(b), Some(c)] => got[i].push((t, [a, b, c])), _ => lost.push(t) }
        }
        let mut out = Vec::new();
        for (i, list) in got.into_iter().enumerate() {
            if list.is_empty() { continue; }
            let s = &kept[i];
            // each triangle wound the way its flipped UVs run (a kept island may be wound against the mesh); one
            // that lays out flat or badly stretched (a corner taken from the wrong side of a slit) is lost
            let uv = |lv: u32| (-s.f.u[lv as usize], s.f.v[lv as usize]);
            let mut list: Vec<(u32, [(u32, u32); 3])> = list.into_iter().filter_map(|(tri, c)| {
                let mut q = [0, 1, 2].map(|k| (c[k], m.f[tri as usize][k]));
                let [a, b, d] = q.map(|x| uv(x.0));
                let det = (b.0 - a.0) * (d.1 - a.1) - (d.0 - a.0) * (b.1 - a.1);
                if det == 0. { lost.push(tri); return None; }
                if det < 0. { q.swap(1, 2); }
                Some((tri, q))
            }).collect();
            let build = |list: &[(u32, [(u32, u32); 3])]| {
                let (mut id, mut orig, mut u, mut v): (Map<u32, u32>, Vec<u32>, Vec<f64>, Vec<f64>) = Default::default();
                let t: Vec<[u32; 3]> = list.iter().map(|(_, q)| q.map(|(lv, o)| *id.entry(lv).or_insert_with(|| {
                    orig.push(o);
                    let (x, y) = uv(lv);
                    u.push(x);
                    v.push(y);
                    (orig.len() - 1) as u32
                }))).collect();
                let l = chart::with_borders(list.iter().map(|x| x.0).collect(), t, orig);
                let f = crate::flatten::measure(&l, &crate::flatten::frames(m, &l), u, v);
                (l, f, id)
            };
            let (mut l, mut f, mut id) = build(&list);
            if f.e.iter().any(|&e| e > BAD_STRETCH) {
                let mut k = 0;
                list.retain(|x| { k += 1; f.e[k - 1] <= BAD_STRETCH || { lost.push(x.0); false } });
                if list.is_empty() { continue; }
                (l, f, id) = build(&list);
            }
            if l.loops.is_empty() { lost.extend(l.tris); continue; }
            outer_first(&mut l, &f);
            let spine = s.spine.and_then(|e| Some([*id.get(&e[0])?, *id.get(&e[1])?]));
            out.push((i, Island { part: s.part, l, f, spine }));
        }
        (out, lost)
    }
}

fn reflect(p: V3, n: V3, d: f64) -> V3 { let s = 2. * (dot(p, n) - d); [0, 1, 2].map(|k| p[k] - s * n[k]) }

/// Tighten a candidate plane: match each vertex's image to its nearest vertex, fit the plane to the pairs, at
/// ever smaller tolerances; Some once nearly every vertex is matched within TOL.
fn refine(m: &Mesh, grid: &Grid, mut n: V3, mut d: f64) -> Option<(V3, f64)> {
    // the first rounds on a sample: a wrong direction fails there, cheaply
    let step = (m.p.len() / 400).max(1);
    for (round, tol) in [0.02, 0.006, 0.002, TOL].into_iter().enumerate() {
        let ids: Vec<usize> = if round < 2 { (0..m.p.len()).step_by(step).collect() } else { (0..m.p.len()).collect() };
        let (mut sn, mut sd, mut hit) = ([0.; 3], 0., 0usize);
        let own;
        let g = if tol < grid.cell { own = Grid::new(&m.p, tol); &own } else { grid };
        let mut pairs = Vec::new();
        for &i in &ids {
            let Some(j) = g.near(&m.p, reflect(m.p[i], n, d), tol) else { continue };
            hit += 1;
            pairs.push((i, j as usize));
            let e = sub(m.p[i], m.p[j as usize]);
            let s = if dot(e, n) < 0. { -1. } else { 1. };
            for k in 0..3 { sn[k] += s * e[k]; }
        }
        if (hit as f64) < NEARLY_ALL * ids.len() as f64 { return None; }
        let l = norm(sn);
        if l > 1e-12 { n = sn.map(|x| x / l); }
        for &(i, j) in &pairs { sd += dot(n, m.p[i]) + dot(n, m.p[j]); }
        d = sd / (2 * pairs.len()).max(1) as f64;
    }
    Some((n, d))
}

/// Vertices hashed on a grid, to find the one nearest a point.
struct Grid { cell: f64, at: Map<[i64; 3], Vec<u32>> }

impl Grid {
    fn new(p: &[V3], cell: f64) -> Grid {
        let mut at: Map<[i64; 3], Vec<u32>> = Map::default();
        for (i, q) in p.iter().enumerate() { at.entry(q.map(|x| (x / cell).floor() as i64)).or_default().push(i as u32); }
        Grid { cell, at }
    }
    fn near(&self, p: &[V3], q: V3, tol: f64) -> Option<u32> {
        let c = q.map(|x| (x / self.cell).floor() as i64);
        let mut best = (tol, None);
        for x in -1..=1 { for y in -1..=1 { for z in -1..=1 {
            for &i in self.at.get(&[c[0] + x, c[1] + y, c[2] + z]).into_iter().flatten() {
                let e = dist(p[i as usize], q);
                if e <= best.0 { best = (e, Some(i)); }
            }
        } } }
        best.1
    }
}

/// Eigenvalues and unit eigenvectors of a symmetric 3×3 matrix (Jacobi rotations).
fn eigen(mut a: [[f64; 3]; 3]) -> ([f64; 3], [V3; 3]) {
    let mut v = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    for _ in 0..50 {
        let (p, q) = [(0, 1), (0, 2), (1, 2)].into_iter().max_by(|x, y| a[x.0][x.1].abs().total_cmp(&a[y.0][y.1].abs())).unwrap();
        if a[p][q].abs() < 1e-15 { break; }
        let th = 0.5 * (2. * a[p][q]).atan2(a[q][q] - a[p][p]);
        let (c, s) = (th.cos(), th.sin());
        let mut r = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
        r[p][p] = c; r[q][q] = c; r[p][q] = s; r[q][p] = -s;
        // a ← rᵀ a r, v ← v r
        let mul = |x: &[[f64; 3]; 3], y: &[[f64; 3]; 3]| { let mut o = [[0.; 3]; 3]; for i in 0..3 { for j in 0..3 { for k in 0..3 { o[i][j] += x[i][k] * y[k][j]; } } } o };
        let rt = [0, 1, 2].map(|i| [0, 1, 2].map(|j| r[j][i]));
        a = mul(&mul(&rt, &a), &r);
        v = mul(&v, &r);
    }
    ([a[0][0], a[1][1], a[2][2]], [0, 1, 2].map(|j| [v[0][j], v[1][j], v[2][j]]))
}
