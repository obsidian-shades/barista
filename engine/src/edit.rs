//! Hand edits the editor asks for (after Mio3 UV): relax an island where it lies (ARAP from its current layout),
//! stitch two islands along their shared border (`chart::book`). Islands come as the editor holds them: xyz and uv
//! per corner, three corners per triangle. Corners with the same position and the same UV are one vertex, so the
//! island's own seams stay seams. A seam toggled by hand re-solves just the islands it touches (`reseam`).
use crate::chart::{book, find, local_mesh, with_borders, Island, Local};
use crate::flatten::{arap_pinned, flatten, flatten_lscm_pinned, flatten_pinned, flatten_slim, frames, measure, slim, Flat};
use crate::mesh::*;
use crate::Params;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct IslandIn {
    pub positions: Vec<f32>,
    pub uvs: Vec<f32>,
}

/// An island over the shared mesh: its local mesh, its UVs per local vertex, and where each input corner went
/// (local triangle, corner); None for a corner of a degenerate triangle with no vertex of its own.
struct Piece { l: Local, u: Vec<f64>, v: Vec<f64>, corner: Vec<Option<(usize, usize)>> }

/// The islands over one mesh made of all their triangles, so islands of one part share its welded vertices.
fn build(islands: &[&IslandIn]) -> Result<(Mesh, Vec<Piece>), String> {
    for s in islands {
        if s.positions.len() % 9 != 0 || s.uvs.len() * 3 != s.positions.len() * 2 {
            return Err("expected xyz and uv per corner, three corners per triangle".into());
        }
    }
    let soup: Vec<f32> = islands.iter().flat_map(|s| s.positions.iter().copied()).collect();
    let m = Mesh::from_soup(&soup)?;
    let pieces = islands.iter().map(|s| {
        let nc = s.uvs.len() / 2;
        let w: Vec<Option<u32>> = s.positions.chunks_exact(3).map(|q| m.vertex_at([q[0] as f64, q[1] as f64, q[2] as f64])).collect();
        let key = |c: usize| w[c].map(|x| (x, s.uvs[2 * c].to_bits(), s.uvs[2 * c + 1].to_bits()));
        let mut id: Map<(u32, u32, u32), u32> = Map::default();
        let (mut orig, mut u, mut v, mut tris, mut t) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut corner = vec![None; nc];
        for c0 in (0..nc).step_by(3) {
            let Some(ws) = (0..3).map(|k| w[c0 + k]).collect::<Option<Vec<u32>>>() else { continue };
            // the mesh's own triangle on these corners (degenerate ones were dropped)
            let Some(&tri) = m.edges.get(&ek(ws[0], ws[1])).and_then(|ts| ts.iter().find(|&&x| m.f[x as usize].contains(&ws[2]))) else { continue };
            let lt = [0, 1, 2].map(|k| *id.entry(key(c0 + k).unwrap()).or_insert_with(|| {
                orig.push(ws[k]);
                u.push(s.uvs[2 * (c0 + k)] as f64);
                v.push(s.uvs[2 * (c0 + k) + 1] as f64);
                (orig.len() - 1) as u32
            }));
            for k in 0..3 { corner[c0 + k] = Some((t.len(), k)); }
            tris.push(tri);
            t.push(lt);
        }
        if t.is_empty() { return Err("island has no usable triangles".to_string()); }
        let mut at: Map<u32, (usize, usize)> = Map::default();
        for (i, tr) in t.iter().enumerate() { for k in 0..3 { at.entry(tr[k]).or_insert((i, k)); } }
        for c in 0..nc {
            if corner[c].is_none() { corner[c] = key(c).and_then(|x| id.get(&x)).map(|x| at[x]); }
        }
        Ok(Piece { l: with_borders(tris, t, orig), u, v, corner })
    }).collect::<Result<Vec<_>, _>>()?;
    Ok((m, pieces))
}

/// The UV area, signed: negative when the island lies mirrored (flipped by hand).
fn uv_area(l: &Local, u: &[f64], v: &[f64]) -> f64 {
    l.t.iter().map(|t| {
        let [a, b, c] = t.map(|q| q as usize);
        ((u[b] - u[a]) * (v[c] - v[a]) - (u[c] - u[a]) * (v[b] - v[a])) / 2.
    }).sum()
}

/// Mirror sign and scale that bring an island's UVs to the mesh's units, unmirrored (ARAP only turns, never mirrors).
fn frame(m: &Mesh, p: &Piece) -> Result<(f64, f64), String> {
    let a = uv_area(&p.l, &p.u, &p.v);
    let k = (p.l.tris.iter().map(|&t| m.a[t as usize]).sum::<f64>() / a.abs()).sqrt();
    if !k.is_finite() || a == 0. { return Err("island has no area in UV".into()); }
    Ok((a.signum(), k))
}

/// The turn, uniform scale and shift that best lay `from` onto `to` (least squares over the `pairs`, from → to),
/// applied to all of `from`.
/// `size`: UV units per layout unit to use instead of the fitted one (keep the fit's turn and place only).
fn fit(fu: &[f64], fv: &[f64], tu: &[f64], tv: &[f64], pairs: &[(usize, usize)], size: Option<f64>) -> (Vec<f64>, Vec<f64>) {
    let n = pairs.len() as f64;
    let (mut f0, mut t0) = ((0., 0.), (0., 0.));
    for &(i, j) in pairs { f0 = (f0.0 + fu[i] / n, f0.1 + fv[i] / n); t0 = (t0.0 + tu[j] / n, t0.1 + tv[j] / n); }
    // as complex numbers: λ = Σ conj(f) t / Σ |f|²
    let (mut re, mut im, mut den) = (0., 0., 0.);
    for &(i, j) in pairs {
        let (a, b, c, d) = (fu[i] - f0.0, fv[i] - f0.1, tu[j] - t0.0, tv[j] - t0.1);
        re += a * c + b * d;
        im += a * d - b * c;
        den += a * a + b * b;
    }
    let (re, im) = if den > 0. { (re / den, im / den) } else { (1., 0.) };
    let (re, im) = match size { Some(k) => { let h = re.hypot(im); if h > 0. { (re / h * k, im / h * k) } else { (k, 0.) } } None => (re, im) };
    (0..fu.len()).map(|i| {
        let (a, b) = (fu[i] - f0.0, fv[i] - f0.1);
        (t0.0 + re * a - im * b, t0.1 + im * a + re * b)
    }).unzip()
}

/// UVs per input corner: from the local layout where the corner has a vertex, else as it came.
fn corners(s: &IslandIn, p: &Piece, uv: impl Fn(usize, usize) -> (f64, f64)) -> Vec<f32> {
    p.corner.iter().enumerate().flat_map(|(c, at)| match at {
        &Some((i, k)) => { let (u, v) = uv(i, k); [u as f32, v as f32] }
        None => [s.uvs[2 * c], s.uvs[2 * c + 1]],
    }).collect()
}

/// Relax: ARAP from the island's current layout, then turned, scaled and moved back onto where it was. If ARAP
/// folds a layout that was clean, SLIM from the same start instead (it never flips or crosses the outline).
pub fn relax(s: &IslandIn) -> Result<Vec<f32>, String> {
    let (m, ps) = build(&[s])?;
    let p = &ps[0];
    let l = &p.l;
    if l.loops.is_empty() { return Err("island has no border to relax".into()); }
    let (sg, k) = frame(&m, p)?;
    let (u0, v0): (Vec<f64>, Vec<f64>) = p.u.iter().zip(&p.v).map(|(u, v)| (u * sg * k, v * k)).unzip();
    let fr = frames(&m, l);
    // one vertex held per connected piece (a net's members may only touch at corners)
    let mut par: Vec<usize> = (0..l.nv).collect();
    for t in &l.t { for k in 1..3 { let (x, y) = (find(&mut par, t[0] as usize), find(&mut par, t[k] as usize)); par[x] = y; } }
    let held: Vec<usize> = (0..l.nv).filter(|&w| find(&mut par, w) == w).collect();
    let (u, v) = arap_pinned(l, &fr, u0.clone(), v0.clone(), 100, &held);
    let mut f = measure(l, &fr, u, v);
    if f.flips > 0 || f.self_overlap {
        let start = measure(l, &fr, u0.clone(), v0.clone());
        if start.flips == 0 && !start.self_overlap {
            let (u, v) = slim(l, &fr, u0.clone(), v0.clone(), 60);
            f = measure(l, &fr, u, v);
        }
    }
    let all: Vec<(usize, usize)> = (0..l.nv).map(|w| (w, w)).collect();
    let (u, v) = fit(&f.u, &f.v, &u0, &v0, &all, None);
    Ok(corners(s, p, |i, c| { let w = l.t[i][c] as usize; (sg * u[w] / k, v[w] / k) }))
}

/// Most mean stretch a stitched pair may have.
const STITCH_TOL: f64 = 0.25;

/// Directed border edges by welded key: local a → b as the island winds them.
fn border(l: &Local) -> Map<u64, (u32, u32)> {
    let mut out = Map::default();
    for lp in &l.loops {
        for k in 0..lp.len() {
            let (a, b) = (lp[k], lp[(k + 1) % lp.len()]);
            out.insert(ek(l.orig[a as usize], l.orig[b as usize]), (a, b));
        }
    }
    out
}

/// Stitch: `b` laid against `a` along their longest unbroken shared stretch of border (a book page on that spine,
/// `chart::book`), the pair relaxed as one and put back where `a` was. Err if they share no edge, or the pair won't
/// lie flat in one piece.
pub fn stitch(a: &IslandIn, b: &IslandIn) -> Result<[Vec<f32>; 2], String> {
    let (m, mut ps) = build(&[a, b])?;
    let mut pb = ps.pop().unwrap();
    let pa = ps.pop().unwrap();
    // B must run each shared edge against A's way round; wound the other way (as the mesh came), it's turned over
    let shared = |pb: &Piece| {
        let bb = border(&pb.l);
        let (mut same, mut other) = (0, 0);
        for (key, &(x, _)) in &border(&pa.l) {
            if let Some(&(y, _)) = bb.get(key) { if pa.l.orig[x as usize] == pb.l.orig[y as usize] { same += 1 } else { other += 1 } }
        }
        (same, other, bb)
    };
    let (same, other, mut bb) = shared(&pb);
    if same + other == 0 { return Err("the two islands share no edge on the model".into()); }
    if same > other {
        let t: Vec<[u32; 3]> = pb.l.t.iter().map(|t| [t[0], t[2], t[1]]).collect();
        pb.l = with_borders(pb.l.tris.clone(), t, pb.l.orig.clone());
        for c in pb.corner.iter_mut().flatten() { c.1 = [0, 2, 1][c.1]; }
        bb = shared(&pb).2;
    }
    // the longest unbroken stretch of shared edges along A's border, as (A vertex, B vertex) pairs
    let (mut run, mut best) = (Vec::new(), 0.);
    for lp in &pa.l.loops {
        let n = lp.len();
        let hit = |k: usize| {
            let (la, lb) = (lp[k], lp[(k + 1) % n]);
            bb.get(&ek(pa.l.orig[la as usize], pa.l.orig[lb as usize])).map(|&(x, y)| {
                let (ja, jb) = if pb.l.orig[x as usize] == pa.l.orig[la as usize] { (x, y) } else { (y, x) };
                ([(la, ja), (lb, jb)], dist(m.pt(pa.l.orig[la as usize]), m.pt(pa.l.orig[lb as usize])))
            })
        };
        let start = (0..n).find(|&k| hit(k).is_none()).map_or(0, |k| k + 1);
        let (mut cur, mut len) = (Vec::new(), 0.);
        for s in 0..n {
            match hit((start + s) % n) {
                Some((h, d)) => { cur.extend(h); len += d; }
                None => { cur.clear(); len = 0.; }
            }
            if len > best { best = len; run = cur.clone(); }
        }
    }
    let (sg, k) = frame(&m, &pa)?;
    let island = |p: &Piece| {
        let (u, v) = p.u.iter().zip(&p.v).map(|(u, v)| (u * sg * k, v * k)).unzip();
        Island { part: 0, l: p.l.clone(), f: measure(&p.l, &frames(&m, &p.l), u, v), spine: None }
    };
    let (ia, ib) = (island(&pa), island(&pb));
    let j = book(&m, &ia, &ib, &run, STITCH_TOL, true).ok_or("stitched, the pair would stretch too much or fold over itself")?;
    // book keeps A's triangles first, then B's, corners in the same order
    let (j, na, ta) = (&j, pa.l.t.len(), &pa.l.t);
    let pairs: Vec<(usize, usize)> = (0..na).flat_map(|i| (0..3).map(move |c| (j.l.t[i][c] as usize, ta[i][c] as usize))).collect();
    let (u, v) = fit(&j.f.u, &j.f.v, &ia.f.u, &ia.f.v, &pairs, None);
    let (u, v) = (&u, &v);
    let uv = |off: usize| move |i: usize, c: usize| { let w = j.l.t[off + i][c] as usize; (sg * u[w] / k, v[w] / k) };
    Ok([corners(a, &pa, uv(0)), corners(b, &pb, uv(na))])
}

/// A piece flattened as its seams leave it: a disk by LSCM + ARAP, holes and all by SLIM, else (still closed, or
/// SLIM found no start) projected flat along its thinnest side.
fn as_cut(m: &Mesh, l: &Local) -> Flat {
    if l.is_disk() { return flatten(m, l); }
    if let Some(f) = (!l.loops.is_empty()).then(|| flatten_slim(m, l)).flatten() { return f; }
    let p: Vec<V3> = l.orig.iter().map(|&w| m.pt(w)).collect();
    let ext = |k: usize| p.iter().map(|q| q[k]).fold(f64::MIN, f64::max) - p.iter().map(|q| q[k]).fold(f64::MAX, f64::min);
    let thin = (0..3).min_by(|&a, &b| ext(a).total_cmp(&ext(b))).unwrap();
    let (a, b) = ((thin + 1) % 3, (thin + 2) % 3);
    measure(l, &frames(m, l), p.iter().map(|q| q[a]).collect(), p.iter().map(|q| q[b]).collect())
}

/// Whether any of `keys` (edges with two triangles) is a border in `isl`: its sides in two islands, or apart in one.
fn reopens(m: &Mesh, isl: &[Island], keys: &Set<u64>) -> bool {
    let mut owner: Map<u32, (usize, usize)> = Map::default();
    for (i, s) in isl.iter().enumerate() { for (j, &t) in s.l.tris.iter().enumerate() { owner.insert(t, (i, j)); } }
    keys.iter().any(|k| {
        let &[x, y] = &m.edges[k][..] else { return false };
        let (Some(&(i, a)), Some(&(j, b))) = (owner.get(&x), owner.get(&y)) else { return false };
        if i != j { return true; }
        // the same island: glued if both triangles have the same local vertices on the edge
        let l = &isl[i].l;
        let ends = [(k >> 32) as u32, *k as u32];
        let on = |t: usize| { let mut v: Vec<u32> = l.t[t].iter().copied().filter(|&q| ends.contains(&l.orig[q as usize])).collect(); v.sort(); v };
        on(a) != on(b)
    })
}

/// A part as the editor holds it: xyz and uv per corner, stretch and island per triangle, every seam now, the edges
/// toggled since its UVs were made (6 numbers per edge), the pinned corners; `faces`: triangles to unwrap again
/// (Blender's U on a selection); `live`: just lay those faces' islands out around their pins, fast (a pin drag).
#[derive(Deserialize)]
pub struct ReseamIn {
    pub positions: Vec<f32>,
    pub uvs: Vec<f32>,
    pub stretch: Vec<f32>,
    pub island: Vec<u32>,
    pub seams: Vec<f32>,
    pub changed: Vec<f32>,
    #[serde(default)]
    pub pins: Vec<u32>,
    #[serde(default)]
    pub faces: Vec<u32>,
    #[serde(default)]
    pub live: bool,
    /// By hand: islands made by the seams alone, each flattened as it is, never cut further (stretched or folded
    /// shows as such: the artist's seams to fix).
    #[serde(default)]
    pub manual: bool,
}

/// The part's UVs, stretch and islands after `reseam`, corners and triangles in the order they came.
#[derive(Serialize)]
pub struct Reseamed {
    pub uvs: Vec<f32>,
    pub stretch: Vec<f32>,
    pub island: Vec<u32>,
}

/// A seam change worked into the UVs that are there, not a new unwrap: only the islands a toggled edge touches are
/// solved again (`chart::solve`), cut where they were cut plus the added seams, joined across the removed ones (two
/// islands become one there). Each new island is laid onto where most of it lay (turn, scale, shift; mirrored if
/// that was); with two or more pinned UVs it is laid out again around them instead (Blender's pins: LSCM + ARAP
/// with the pins held), a lone pin stays where it was. Every other island keeps its UVs, hand edits and all; new
/// islands get ids past the old ones.
///
/// With `faces`, those triangles are unwrapped again instead, their islands made by the seams alone (and the edge
/// of the selection), as Blender's U does. With `live` too, each of their islands is only laid out again by LSCM
/// around its pins (two or more, else it stays as it lies), keeping its id: fast enough to follow a pin drag.
pub fn reseam(r: &ReseamIn, p: &Params) -> Result<Reseamed, String> {
    let nt = r.island.len();
    if r.positions.len() != nt * 9 || r.uvs.len() != nt * 6 || r.stretch.len() != nt {
        return Err("expected xyz and uv per corner, stretch and island per triangle".into());
    }
    let mut out = Reseamed { uvs: r.uvs.clone(), stretch: r.stretch.clone(), island: r.island.clone() };
    let m = Mesh::from_soup(&r.positions)?;
    let w: Vec<Option<u32>> = r.positions.chunks_exact(3).map(|q| m.vertex_at([q[0] as f64, q[1] as f64, q[2] as f64])).collect();
    // mesh triangle → input triangle (none for a degenerate one: it keeps its UVs)
    const NONE: usize = usize::MAX;
    let mut from = vec![NONE; m.f.len()];
    for t in 0..nt {
        let Some(ws) = (0..3).map(|k| w[3 * t + k]).collect::<Option<Vec<u32>>>() else { continue };
        let x = m.edges.get(&ek(ws[0], ws[1])).and_then(|ts| ts.iter().copied().find(|&x| from[x as usize] == NONE && m.f[x as usize].contains(&ws[2])));
        if let Some(x) = x { from[x as usize] = t; }
    }
    let (changed, seams) = (m.edges_at(&r.changed), m.edges_at(&r.seams));
    let stitched: Set<u64> = changed.iter().filter(|k| !seams.contains(k)).copied().collect();
    let island = |x: u32| Some(from[x as usize]).filter(|&t| t != NONE).map(|t| r.island[t]);
    let hit: Set<u32> = changed.iter().flat_map(|e| &m.edges[e]).filter_map(|&x| island(x)).collect();
    let picked: Set<u32> = r.faces.iter().copied().collect();
    if hit.is_empty() && picked.is_empty() { return Ok(out); }
    let tris: Vec<u32> = (0..m.f.len() as u32)
        .filter(|&x| from[x as usize] != NONE && (picked.contains(&(from[x as usize] as u32)) || island(x).is_some_and(|i| hit.contains(&i))))
        .collect();
    let seams_only = (!picked.is_empty() || r.manual) && !r.live;
    let uv_at = |t: usize, v: u32| (0..3).find(|&k| w[3 * t + k] == Some(v)).map(|k| (r.uvs[6 * t + 2 * k], r.uvs[6 * t + 2 * k + 1]));
    // glued where it was (one island, one UV at each end) unless it's a seam now, or where a seam was removed
    let joined = |a: u32, b: u32| match &m.edges[&ek(a, b)][..] {
        &[x, y] => island(x).is_some() && island(x) == island(y) && [a, b].iter().all(|&v| {
            match (uv_at(from[x as usize], v), uv_at(from[y as usize], v)) {
                (Some(s), Some(t)) => (s.0 - t.0).abs() + (s.1 - t.1).abs() < 1e-6,
                _ => false,
            }
        }),
        _ => false,
    };
    let mut cut = Set::default();
    for &x in &tris {
        let f = m.f[x as usize];
        for k in 0..3 {
            let (a, b) = (f[k], f[(k + 1) % 3]);
            let key = ek(a, b);
            if seams.contains(&key) || (!seams_only && !(changed.contains(&key) || joined(a, b))) { cut.insert(key); }
        }
    }
    // each glued piece solved on its own, as the unwrap solves a chart
    let l = local_mesh(&m, &tris, &cut);
    let mut par: Vec<usize> = (0..l.nv).collect();
    for t in &l.t { for k in 1..3 { let (x, y) = (find(&mut par, t[0] as usize), find(&mut par, t[k] as usize)); par[x] = y; } }
    let mut pieces: Map<usize, Vec<u32>> = Map::default();
    for (i, t) in l.t.iter().enumerate() { pieces.entry(find(&mut par, t[0] as usize)).or_default().push(l.tris[i]); }
    let solved: Vec<Island> = pieces.into_values().collect::<Vec<_>>().into_par_iter().flat_map(|t| {
        if r.manual && !r.live { let l = local_mesh(&m, &t, &cut); let f = as_cut(&m, &l); return vec![Island { part: 0, l, f, spine: None }]; }
        if !r.live {
            // a stitched edge stays stitched: if the solve would cut one open again, the piece as the seams leave it
            let auto = crate::chart::islands(&m, vec![t.clone()], &cut, p);
            if !reopens(&m, &auto, &stitched) { return auto; }
            let l = local_mesh(&m, &t, &cut);
            let f = as_cut(&m, &l);
            return vec![Island { part: 0, l, f, spine: None }];
        }
        // live: the island as it is, laid out again below around its pins
        let l = local_mesh(&m, &t, &cut);
        let f = measure(&l, &frames(&m, &l), vec![0.; l.nv], vec![0.; l.nv]);
        vec![Island { part: 0, l, f, spine: None }]
    }).collect();

    // UV units per mesh unit: the islands left as they are, else what was solved again (each triangle's own area: a
    // projected closed shell lies over itself). A fit sized by least squares onto such a projection shrinks to a speck.
    let uv_tri = |t: usize| ((r.uvs[6 * t + 2] - r.uvs[6 * t]) * (r.uvs[6 * t + 5] - r.uvs[6 * t + 1]) - (r.uvs[6 * t + 4] - r.uvs[6 * t]) * (r.uvs[6 * t + 3] - r.uvs[6 * t + 1])).abs() as f64 / 2.;
    let in_tris: Set<u32> = tris.iter().copied().collect();
    let density = |keep: bool| {
        let (mut uv, mut xyz) = (0., 0.);
        for x in 0..m.f.len() as u32 {
            if from[x as usize] == NONE || in_tris.contains(&x) == keep { continue; }
            (uv, xyz) = (uv + uv_tri(from[x as usize]), xyz + m.a[x as usize]);
        }
        (uv > 0. && xyz > 0.).then(|| (uv / xyz).sqrt())
    };
    let size = density(true).or_else(|| density(false));
    let pinned: Set<u32> = r.pins.iter().copied().collect();
    let mut next = r.island.iter().max().map_or(0, |x| x + 1);
    for s in &solved {
        // (input corner, local vertex), three per triangle
        let mut cs = Vec::new();
        for (i, lt) in s.l.t.iter().enumerate() {
            let t = from[s.l.tris[i] as usize];
            for k in 0..3 {
                if let Some(&q) = lt.iter().find(|&&q| Some(s.l.orig[q as usize]) == w[3 * t + k]) { cs.push((3 * t + k, q as usize)); }
            }
        }
        // held by the old island most of its area was
        let mut area: Map<u32, f64> = Map::default();
        for &x in &s.l.tris { *area.entry(r.island[from[x as usize]]).or_default() += m.a[x as usize]; }
        let home = area.into_iter().max_by(|a, b| a.1.total_cmp(&b.1)).unwrap().0;
        let pairs: Vec<(usize, usize)> = (0..cs.len()).filter(|&i| r.island[cs[i].0 / 3] == home).map(|i| (i, i)).collect();
        let (fu, fv): (Vec<f64>, Vec<f64>) = cs.iter().map(|&(_, q)| (s.f.u[q], s.f.v[q])).unzip();
        let (tu, tv): (Vec<f64>, Vec<f64>) = cs.iter().map(|&(c, _)| (r.uvs[2 * c] as f64, r.uvs[2 * c + 1] as f64)).unzip();
        // `fit` only turns: mirror first if the home island lay mirrored
        let signed = |u: &[f64], v: &[f64]| pairs.chunks_exact(3).map(|c| {
            let (a, b, d) = (c[0].0, c[1].0, c[2].0);
            (u[b] - u[a]) * (v[d] - v[a]) - (u[d] - u[a]) * (v[b] - v[a])
        }).sum::<f64>();
        // pinned UVs, one per local vertex
        let mut held: Map<usize, (f64, f64)> = Map::default();
        for (i, &(c, q)) in cs.iter().enumerate() { if pinned.contains(&(c as u32)) { held.entry(q).or_insert((tu[i], tv[i])); } }
        // the home island's UV area in the local winding (its sign: mirrored or not) and its area on the model
        let old = |i: usize, q: u32| { let c = cs[3 * i..3 * i + 3].iter().position(|x| x.1 == q as usize).unwrap() + 3 * i; (tu[c], tv[c]) };
        let home_tris: Vec<usize> = (0..s.l.t.len()).filter(|&i| r.island[from[s.l.tris[i] as usize]] == home).collect();
        let uv_area = home_tris.iter().map(|&i| {
            let [a, b, d] = s.l.t[i].map(|q| old(i, q));
            (b.0 - a.0) * (d.1 - a.1) - (d.0 - a.0) * (b.1 - a.1)
        }).sum::<f64>() / 2.;
        let k = (home_tris.iter().map(|&i| m.a[s.l.tris[i] as usize]).sum::<f64>() / uv_area.abs()).sqrt();
        if r.live && held.len() < 2 { continue; } // nothing to lay it out around: as it lies
        let (u, v, e) = if held.len() >= 2 && k.is_finite() && uv_area != 0. {
            // laid out again around the pins, in the mesh's units, then back to UV
            let sg = uv_area.signum();
            let pins: Vec<(usize, f64, f64)> = held.iter().map(|(&q, &(x, y))| (q, sg * x * k, y * k)).collect();
            let f = if r.live { flatten_lscm_pinned(&m, &s.l, &pins) } else { flatten_pinned(&m, &s.l, &pins) };
            let (u, v): (Vec<f64>, Vec<f64>) = cs.iter().map(|&(_, q)| (sg * f.u[q] / k, f.v[q] / k)).unzip();
            (u, v, f.e)
        } else {
            let fu = if signed(&fu, &fv) * signed(&tu, &tv) < 0. { fu.iter().map(|x| -x).collect() } else { fu };
            let (mut u, mut v) = fit(&fu, &fv, &tu, &tv, &pairs, size);
            if let Some((&q, &(x, y))) = held.iter().next() {
                let i = cs.iter().position(|&(_, p)| p == q).unwrap();
                let (du, dv) = (x - u[i], y - v[i]);
                for j in 0..u.len() { u[j] += du; v[j] += dv; }
            }
            (u, v, s.f.e.clone())
        };
        for (i, &(c, _)) in cs.iter().enumerate() { out.uvs[2 * c] = u[i] as f32; out.uvs[2 * c + 1] = v[i] as f32; }
        for (i, &x) in s.l.tris.iter().enumerate() {
            let t = from[x as usize];
            out.stretch[t] = if e[i].is_finite() { e[i] as f32 } else { -1. };
            if !r.live { out.island[t] = next; }
        }
        next += 1;
    }
    Ok(out)
}
