//! Cuts drawn by hand: a stroke of points on the model's surface (input units), from the editor's Cut tool.
//!
//! `snap` keeps the mesh as it is and returns the edge path that hugs the stroke (Dijkstra, edges far from the
//! stroke cost more), like Maya's 3D Cut and Sew or Houdini's seam selection. `knife` cuts the faces themselves
//! along the stroke, like Blender's Knife Project: the stroke and the eye span a cutting surface, the cut walks
//! across the mesh face by face along it, each crossed face is re-triangulated around the new points, and the
//! new edges come back as seams. Either way the result is seams the unwrapper must respect.
use crate::chart::dijkstra;
use crate::mesh::*;
use serde::Serialize;

/// Closest point to `p` on triangle abc (Ericson, Real-Time Collision Detection 5.1.5).
fn closest_on_tri(p: V3, a: V3, b: V3, c: V3) -> V3 {
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    if d1 <= 0. && d2 <= 0. { return a; }
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0. && d4 <= d3 { return b; }
    let vc = d1 * d4 - d3 * d2;
    let lerp = |o: V3, d: V3, t: f64| [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    if vc <= 0. && d1 >= 0. && d3 <= 0. { return lerp(a, ab, d1 / (d1 - d3)); }
    let cp = sub(p, c);
    let (d5, d6) = (dot(ab, cp), dot(ac, cp));
    if d6 >= 0. && d5 <= d6 { return c; }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0. && d2 >= 0. && d6 <= 0. { return lerp(a, ac, d2 / (d2 - d6)); }
    let va = d3 * d6 - d5 * d4;
    if va <= 0. && d4 - d3 >= 0. && d5 - d6 >= 0. { return lerp(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))); }
    let den = 1. / (va + vb + vc);
    let (v, w) = (vb * den, vc * den);
    [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

/// The triangle nearest `p`, and the nearest point on it.
// ponytail: brute force over all triangles per stroke point; a BVH if strokes on huge meshes get slow
fn nearest_face(m: &Mesh, p: V3) -> (u32, V3) {
    let mut best = (0, p, f64::INFINITY);
    for (t, f) in m.f.iter().enumerate() {
        let q = closest_on_tri(p, m.pt(f[0]), m.pt(f[1]), m.pt(f[2]));
        let d = dist(p, q);
        if d < best.2 { best = (t as u32, q, d); }
    }
    (best.0, best.1)
}

fn dist_to_polyline(p: V3, line: &[V3]) -> f64 {
    line.windows(2).map(|w| {
        let (a, d) = (w[0], sub(w[1], w[0]));
        let t = (dot(sub(p, a), d) / dot(d, d).max(1e-30)).clamp(0., 1.);
        dist(p, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t])
    }).fold(f64::INFINITY, f64::min)
}

fn mean_edge(m: &Mesh) -> f64 {
    let s: f64 = m.edges.keys().map(|&k| dist(m.pt((k >> 32) as u32), m.pt(k as u32))).sum();
    s / m.edges.len().max(1) as f64
}

/// Edge path (as xyz pairs, 6 numbers per edge, input units) along the mesh's own edges that follows the stroke.
pub fn snap(soup: &[f32], stroke: &[f32]) -> Result<Vec<f32>, String> {
    let m = Mesh::from_soup(soup)?;
    let line: Vec<V3> = stroke.chunks_exact(3).map(|c| m.to_local([c[0], c[1], c[2]])).collect();
    if line.len() < 2 { return Ok(vec![]); }
    let h = mean_edge(&m);
    // edges cost their length, times a penalty growing with distance from the stroke, so paths hug it
    let mut adj = vec![Vec::new(); m.p.len()];
    for &k in m.edges.keys() {
        let (a, b) = ((k >> 32) as u32, k as u32);
        let (pa, pb) = (m.pt(a), m.pt(b));
        let d = dist_to_polyline([(pa[0] + pb[0]) / 2., (pa[1] + pb[1]) / 2., (pa[2] + pb[2]) / 2.], &line) / h;
        let w = dist(pa, pb) * (1. + 4. * d * d);
        adj[a as usize].push((b, w));
        adj[b as usize].push((a, w));
    }
    // waypoints every few edge lengths along the stroke, each snapped to its nearest vertex
    let nearest = |p: V3| (0..m.p.len()).min_by(|&x, &y| dist(m.p[x], p).total_cmp(&dist(m.p[y], p))).unwrap() as u32;
    let (mut way, mut acc) = (vec![nearest(line[0])], 0.);
    for w in line.windows(2) {
        acc += dist(w[0], w[1]);
        if acc >= 6. * h { acc = 0.; way.push(nearest(w[1])); }
    }
    way.push(nearest(*line.last().unwrap()));
    way.dedup();
    let mut keys = Set::default();
    for w in way.windows(2) {
        let (_, prev, end) = dijkstra(&adj, &[w[0]], |v| v == w[1]);
        let mut v = end.unwrap_or(u32::MAX);
        while v != u32::MAX && prev[v as usize] != u32::MAX { keys.insert(ek(v, prev[v as usize])); v = prev[v as usize]; }
    }
    let mut keys: Vec<u64> = keys.into_iter().collect();
    keys.sort();
    Ok(keys.iter().flat_map(|&k| [m.to_world(m.pt((k >> 32) as u32)), m.to_world(m.pt(k as u32))].concat()).collect())
}

#[derive(Serialize)]
pub struct Knifed {
    /// The cut mesh, xyz per corner (input units).
    pub positions: Vec<f32>,
    /// The new edges along the cut, 6 numbers each.
    pub seams: Vec<f32>,
}

/// A point of the cut: inside a face, or on an edge a→b at a + t(b − a).
#[derive(Clone, Copy)]
enum Pt { Face(V3), Edge(u32, u32, f64) }

/// Cut the faces along the stroke, as seen from `eye` (the camera, input units).
pub fn knife(soup: &[f32], stroke: &[f32], eye: [f32; 3]) -> Result<Knifed, String> {
    let m = Mesh::from_soup(soup)?;
    let s: Vec<V3> = stroke.chunks_exact(3).map(|c| m.to_local([c[0], c[1], c[2]])).collect();
    let e = m.to_local(eye);
    let unchanged = || Knifed { positions: soup.to_vec(), seams: vec![] };
    if s.len() < 2 { return Ok(unchanged()); }

    // 1. trace the stroke over the surface: chains of points, each step staying inside one face
    let mut chains: Vec<(Vec<Pt>, Vec<u32>)> = Vec::new(); // points, and the face each step runs through
    let (mut face, mut at) = nearest_face(&m, s[0]);
    let mut cur = (vec![Pt::Face(at)], Vec::new());
    for i in 0..s.len() - 1 {
        let (target, b) = nearest_face(&m, s[i + 1]);
        if target == face {
            cur.0.push(Pt::Face(b));
            cur.1.push(face);
        } else {
            // the cutting plane: through the eye and both stroke points
            let n = cross(sub(at, e), sub(b, e));
            match walk(&m, face, b, target, n, e) {
                Some(cross_pts) => {
                    for (f, p) in cross_pts { cur.0.push(p); cur.1.push(f); }
                    cur.0.push(Pt::Face(b));
                    cur.1.push(target);
                }
                None => {
                    chains.push(std::mem::replace(&mut cur, (vec![Pt::Face(b)], Vec::new())));
                }
            }
        }
        (face, at) = (target, b);
    }
    chains.push(cur);

    // 2. a cut starts and ends on edges: drop the bits of stroke dangling inside the first and last face
    let mut cuts: Vec<(Vec<Pt>, Vec<u32>)> = Vec::new();
    for (pts, faces) in chains {
        let edge = |p: &Pt| matches!(p, Pt::Edge(..));
        let (Some(first), Some(last)) = (pts.iter().position(edge), pts.iter().rposition(edge)) else { continue };
        if first < last { cuts.push((pts[first..=last].to_vec(), faces[first..last].to_vec())); }
    }
    if cuts.is_empty() { return Ok(unchanged()); }

    // 3. number the new points: edge points shared by both faces of the edge, face points their own
    let mut pos: Vec<V3> = m.p.clone();
    let mut on_edge: Map<u64, Vec<(f64, u32)>> = Map::default(); // edge → (t from its lower vertex, point)
    let mut face_chains: Map<u32, Vec<Vec<u32>>> = Map::default();
    let mut seams = Vec::new();
    for (pts, faces) in &cuts {
        let ids: Vec<u32> = pts.iter().map(|p| match *p {
            Pt::Face(q) => { pos.push(q); (pos.len() - 1) as u32 }
            Pt::Edge(a, b, t) => {
                let (lo, hi, tc) = if a < b { (a, b, t) } else { (b, a, 1. - t) };
                let list = on_edge.entry(ek(lo, hi)).or_default();
                if let Some(&(_, id)) = list.iter().find(|x| (x.0 - tc).abs() < 1e-9) { return id; }
                let (pl, ph) = (m.pt(lo), m.pt(hi));
                pos.push([0, 1, 2].map(|k| pl[k] + (ph[k] - pl[k]) * tc));
                let id = (pos.len() - 1) as u32;
                list.push((tc, id));
                id
            }
        }).collect();
        // consecutive steps in the same face make one chain through it, edge point to edge point
        let mut k = 0;
        while k < faces.len() {
            let mut j = k;
            while j + 1 < faces.len() && faces[j + 1] == faces[k] { j += 1; }
            face_chains.entry(faces[k]).or_default().push(ids[k..=j + 1].to_vec());
            for w in ids[k..=j + 1].windows(2) { seams.push((w[0], w[1])); }
            k = j + 1;
        }
    }

    // 4. re-triangulate every face the cut crosses: its outline (corners + edge points) split along its chains
    let mut tris: Vec<[u32; 3]> = Vec::with_capacity(m.f.len() + 8 * face_chains.len());
    for (t, f) in m.f.iter().enumerate() {
        let touched = (0..3).any(|k| on_edge.contains_key(&ek(f[k], f[(k + 1) % 3])));
        if !touched && !face_chains.contains_key(&(t as u32)) { tris.push(*f); continue; }
        let mut ring = Vec::new();
        for k in 0..3 {
            let (a, b) = (f[k], f[(k + 1) % 3]);
            ring.push(a);
            if let Some(list) = on_edge.get(&ek(a, b)) {
                let mut l: Vec<(f64, u32)> = list.iter().map(|&(tc, id)| (if a < b { tc } else { 1. - tc }, id)).collect();
                l.sort_by(|x, y| x.0.total_cmp(&y.0));
                ring.extend(l.iter().map(|x| x.1));
            }
        }
        let mut regions = vec![ring];
        for c in face_chains.get(&(t as u32)).into_iter().flatten() {
            let (s0, s1) = (c[0], *c.last().unwrap());
            let Some(r) = regions.iter().position(|r| r.contains(&s0) && r.contains(&s1)) else { continue };
            let ring = regions.swap_remove(r);
            let (i0, i1) = (ring.iter().position(|&x| x == s0).unwrap(), ring.iter().position(|&x| x == s1).unwrap());
            let walk_ring = |from: usize, to: usize| {
                let mut out = vec![ring[from]];
                let mut i = from;
                while i != to { i = (i + 1) % ring.len(); out.push(ring[i]); }
                out
            };
            let inner = &c[1..c.len() - 1];
            let mut a = walk_ring(i0, i1);
            a.extend(inner.iter().rev());
            let mut b = walk_ring(i1, i0);
            b.extend(inner.iter());
            regions.push(a);
            regions.push(b);
        }
        let (o, nrm) = (m.pt(f[0]), m.n[t]);
        let ax = { let d = sub(m.pt(f[1]), o); let l = norm(d); d.map(|x| x / l) };
        let ay = cross(nrm, ax);
        for r in regions {
            let flat: Vec<(f64, f64)> = r.iter().map(|&i| { let d = sub(pos[i as usize], o); (dot(d, ax), dot(d, ay)) }).collect();
            tris.extend(ear_clip(&r, &flat));
        }
    }

    let positions = tris.iter().flat_map(|t| t.iter().flat_map(|&i| m.to_world(pos[i as usize]))).collect();
    let seams = seams.iter().flat_map(|&(a, b)| [m.to_world(pos[a as usize]), m.to_world(pos[b as usize])].concat()).collect();
    Ok(Knifed { positions, seams })
}

/// Walk from face f0 along the plane n·(x − e) = 0 to face `target`, crossing edge by edge.
/// Returns the edge crossings with the face each step runs through, or None if the walk can't get there.
fn walk(m: &Mesh, f0: u32, to: V3, target: u32, n: V3, e: V3) -> Option<Vec<(u32, Pt)>> {
    let side = |v: u32| dot(n, sub(m.pt(v), e)) >= 0.;
    let crossings = |f: u32| -> Vec<(u32, u32, f64)> {
        let t = m.f[f as usize];
        (0..3).filter_map(|k| {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            if side(a) == side(b) { return None; }
            let (sa, sb) = (dot(n, sub(m.pt(a), e)), dot(n, sub(m.pt(b), e)));
            // kept off the corners, so no sliver triangles
            Some((a, b, (sa / (sa - sb)).clamp(1e-3, 1. - 1e-3)))
        }).collect()
    };
    let point = |(a, b, t): (u32, u32, f64)| { let (pa, pb) = (m.pt(a), m.pt(b)); [0, 1, 2].map(|k| pa[k] + (pb[k] - pa[k]) * t) };
    let mut starts = crossings(f0);
    // try the way out that heads toward the target first, then the other way round
    starts.sort_by(|x, y| dist(point(*x), to).total_cmp(&dist(point(*y), to)));
    let limit = 4 * (m.f.len() as f64).sqrt() as usize + 64;
    'start: for first in starts {
        let (mut f, mut c, mut out) = (f0, first, Vec::new());
        for _ in 0..limit {
            out.push((f, Pt::Edge(c.0, c.1, c.2)));
            let on = &m.edges[&ek(c.0, c.1)];
            // an open border or a non-manifold edge: this way round can't get there
            let (2, Some(&g)) = (on.len(), on.iter().find(|&&g| g != f)) else { continue 'start };
            if g == target { return Some(out); }
            let Some(next) = crossings(g).into_iter().find(|x| ek(x.0, x.1) != ek(c.0, c.1)) else { continue 'start };
            (f, c) = (g, next);
        }
    }
    None
}

/// Triangulate a simple polygon (counter-clockwise in `flat`) by ear clipping.
fn ear_clip(ids: &[u32], flat: &[(f64, f64)]) -> Vec<[u32; 3]> {
    let mut idx: Vec<usize> = (0..ids.len()).collect();
    let mut out = Vec::new();
    let cross = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0);
    let scale = flat.iter().fold(0f64, |s, p| s.max(p.0.abs()).max(p.1.abs())).max(1e-30);
    let eps = scale * scale * 1e-12;
    while idx.len() > 3 {
        let n = idx.len();
        let ear = (0..n).find(|&i| {
            let (a, b, c) = (flat[idx[(i + n - 1) % n]], flat[idx[i]], flat[idx[(i + 1) % n]]);
            cross(a, b, c) > eps && (0..n).all(|j| {
                if j == i || j == (i + n - 1) % n || j == (i + 1) % n { return true; }
                let p = flat[idx[j]];
                !(cross(a, b, p) > -eps && cross(b, c, p) > -eps && cross(c, a, p) > -eps)
            })
        }).or_else(|| (0..n).max_by(|&x, &y| {
            let k = |i: usize| cross(flat[idx[(i + n - 1) % n]], flat[idx[i]], flat[idx[(i + 1) % n]]);
            k(x).total_cmp(&k(y))
        }))
        .unwrap();
        out.push([ids[idx[(ear + n - 1) % n]], ids[idx[ear]], ids[idx[(ear + 1) % n]]]);
        idx.remove(ear);
    }
    if idx.len() == 3 { out.push([ids[idx[0]], ids[idx[1]], ids[idx[2]]]); }
    out
}
