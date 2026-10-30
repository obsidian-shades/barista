//! Input mesh: weld a triangle soup, drop degenerate triangles, make the winding consistent and outward.
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::hash::BuildHasherDefault;

/// Hash maps with a fixed hasher: the same mesh always unwraps the same way (std's random seed made borderline
/// choices differ run to run).
pub type Map<K, V> = HashMap<K, V, BuildHasherDefault<DefaultHasher>>;
pub type Set<K> = HashSet<K, BuildHasherDefault<DefaultHasher>>;

pub type V3 = [f64; 3];
pub fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
pub fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
pub fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
pub fn norm(a: V3) -> f64 { dot(a, a).sqrt() }
pub fn dist(a: V3, b: V3) -> f64 { norm(sub(a, b)) }

/// Undirected edge key.
pub fn ek(a: u32, b: u32) -> u64 {
    let (x, y) = if a < b { (a, b) } else { (b, a) };
    (x as u64) << 32 | y as u64
}

pub struct Mesh {
    /// Welded positions, centred and scaled to radius 1 (every tolerance is relative to that).
    pub p: Vec<V3>,
    pub f: Vec<[u32; 3]>,
    /// Per triangle: its index in the input soup (degenerate input triangles are dropped, so they differ).
    pub src: Vec<u32>,
    /// Per triangle: the file's polygon it belongs to (`set_polys`; each triangle its own until then). A polygon's
    /// inside edges, its diagonals, are never cut: the export writes it back as one face only if it's in one piece.
    pub poly: Vec<u32>,
    pub n: Vec<V3>,
    pub a: Vec<f64>,
    /// Edge → the triangles on it.
    pub edges: Map<u64, Vec<u32>>,
    pub center: V3,
    pub radius: f64,
    /// Weld grid cell → vertex, to find vertices again from input positions (user seams).
    cells: Map<[i64; 3], u32>,
    /// Per triangle: hidden inside the model (no way out along a cone of rays round its patch's normal), as charting
    /// (`region::charts`) finds it; a seam there is never seen (`seam_cost`). Unset until charted.
    pub hidden: std::sync::OnceLock<Vec<bool>>,
}

// ponytail: grid-rounding weld, points straddling a cell edge stay apart; use a kd-tree if real files show cracks
const Q: f64 = 1e-5;
fn cell(v: V3) -> [i64; 3] { v.map(|x| (x / Q).round() as i64) }

impl Mesh {
    /// `s`: xyz per corner, three corners per triangle.
    pub fn from_soup(s: &[f32]) -> Result<Mesh, String> {
        if s.len() < 9 || s.len() % 9 != 0 {
            return Err(format!("expected xyz for 3 corners per triangle, got {} numbers", s.len()));
        }
        if s.iter().any(|x| !x.is_finite()) {
            return Err("positions contain NaN or infinity".into());
        }
        let pts: Vec<V3> = s.chunks(3).map(|c| [c[0] as f64, c[1] as f64, c[2] as f64]).collect();
        let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
        for q in &pts {
            for k in 0..3 { lo[k] = lo[k].min(q[k]); hi[k] = hi[k].max(q[k]); }
        }
        let center = [(lo[0] + hi[0]) / 2., (lo[1] + hi[1]) / 2., (lo[2] + hi[2]) / 2.];
        let radius = pts.iter().map(|q| dist(*q, center)).fold(0., f64::max);
        if !(radius > 0.) {
            return Err("mesh has no size".into());
        }

        let (mut cells, mut p) = (Map::default(), Vec::new());
        let corner: Vec<u32> = pts.iter().map(|q| {
            let v = [(q[0] - center[0]) / radius, (q[1] - center[1]) / radius, (q[2] - center[2]) / radius];
            *cells.entry(cell(v)).or_insert_with(|| { p.push(v); (p.len() - 1) as u32 })
        }).collect();

        let (mut f, mut src) = (Vec::new(), Vec::new());
        for (t, c) in corner.chunks(3).enumerate() {
            let (i, j, k) = (c[0], c[1], c[2]);
            if i == j || j == k || i == k { continue; }
            let (a, b, d) = (p[i as usize], p[j as usize], p[k as usize]);
            if norm(cross(sub(b, a), sub(d, a))) < 2e-12 { continue; }
            f.push([i, j, k]);
            src.push(t as u32);
        }
        if f.is_empty() {
            return Err("no usable triangles".into());
        }
        let mut edges: Map<u64, Vec<u32>> = Map::default();
        for (t, tri) in f.iter().enumerate() {
            for k in 0..3 { edges.entry(ek(tri[k], tri[(k + 1) % 3])).or_default().push(t as u32); }
        }
        orient(&p, &mut f, &edges);
        let (n, a): (Vec<V3>, Vec<f64>) = f.iter().map(|t| {
            let c = cross(sub(p[t[1] as usize], p[t[0] as usize]), sub(p[t[2] as usize], p[t[0] as usize]));
            let l = norm(c);
            ([c[0] / l, c[1] / l, c[2] / l], l / 2.)
        }).unzip();
        // a soup (OBJ, glTF) has no polygons: read the quads back out of the triangle pairs before anything charts,
        // so a seam can't run down a quad's diagonal, which the modeller never drew
        let poly = recover_quads(&p, &f, &edges, &n);
        Ok(Mesh { p, f, poly, src, n, a, edges, center, radius, cells, hidden: Default::default() })
    }

    pub fn pt(&self, v: u32) -> V3 { self.p[v as usize] }

    /// Group the triangles into the file's polygons: `per_soup`, a polygon id per input triangle (ignored unless it
    /// has one for each).
    pub fn set_polys(&mut self, per_soup: &[u32]) {
        if per_soup.len() > *self.src.iter().max().unwrap() as usize { self.poly = self.src.iter().map(|&s| per_soup[s as usize]).collect(); }
    }

    /// Whether edge `k` lies inside one polygon (a quad's or n-gon's diagonal).
    pub fn inside(&self, k: u64) -> bool { matches!(self.edges[&k][..], [s, t] if self.poly[s as usize] == self.poly[t as usize]) }

    /// Input units → the mesh's normalised frame, and back.
    pub fn to_local(&self, q: [f32; 3]) -> V3 { [0, 1, 2].map(|k| (q[k] as f64 - self.center[k]) / self.radius) }
    pub fn to_world(&self, v: V3) -> [f32; 3] { [0, 1, 2].map(|k| (v[k] * self.radius + self.center[k]) as f32) }

    /// The welded vertex at an input-space position (its cell, or a neighbouring one: f32 round trips land on edges).
    pub fn vertex_at(&self, q: V3) -> Option<u32> {
        let c = cell([(q[0] - self.center[0]) / self.radius, (q[1] - self.center[1]) / self.radius, (q[2] - self.center[2]) / self.radius]);
        let mut near = (-1..=1).flat_map(|x| (-1..=1).flat_map(move |y| (-1..=1).map(move |z| [c[0] + x, c[1] + y, c[2] + z])));
        self.cells.get(&c).or_else(|| near.find_map(|k| self.cells.get(&k))).copied()
    }

    /// Edges named by input-space endpoint pairs (6 numbers each) that exist in this mesh.
    pub fn edges_at(&self, pairs: &[f32]) -> Set<u64> {
        pairs.chunks_exact(6).filter_map(|e| {
            let a = self.vertex_at([e[0] as f64, e[1] as f64, e[2] as f64])?;
            let b = self.vertex_at([e[3] as f64, e[4] as f64, e[5] as f64])?;
            Some(ek(a, b)).filter(|k| self.edges.contains_key(k))
        }).collect()
    }

    /// Triangles sharing an edge with `t`.
    pub fn neighbors(&self, t: u32) -> impl Iterator<Item = u32> + '_ {
        let f = self.f[t as usize];
        (0..3).flat_map(move |k| self.edges[&ek(f[k], f[(k + 1) % 3])].iter().copied().filter(move |&u| u != t))
    }

    pub fn centroid(&self, t: u32) -> V3 {
        let [a, b, c] = self.f[t as usize].map(|v| self.pt(v));
        [(a[0] + b[0] + c[0]) / 3., (a[1] + b[1] + c[1]) / 3., (a[2] + b[2] + c[2]) / 3.]
    }
}

/// Neighbours must run a shared edge in opposite directions (files often mix windings); then a closed piece is
/// flipped, if needed, to face away from its middle (signed volume), and an open piece keeps the side most of its
/// faces were wound to in the file: an open piece's "volume" depends on where the model sits, so it turned panels
/// (a barrel's bore walls) either way, against the file's normals and against Poly Doc's Recalculate Outside.
/// Only plain two-triangle edges carry orientation: where shells touch along an edge (4 triangles on it, two each
/// way) "opposite" is ambiguous, and following it turned a whole correctly wound shell inside out.
fn orient(p: &[V3], f: &mut [[u32; 3]], edges: &Map<u64, Vec<u32>>) {
    let mut seen = vec![false; f.len()];
    for s in 0..f.len() {
        if seen[s] { continue; }
        seen[s] = true;
        let mut comp = vec![s];
        let mut turned = 0;
        let mut q = 0;
        while q < comp.len() {
            let t = comp[q];
            q += 1;
            for k in 0..3 {
                let (a, b) = (f[t][k], f[t][(k + 1) % 3]);
                let on = &edges[&ek(a, b)];
                if on.len() != 2 { continue; }
                for &u in on {
                    let u = u as usize;
                    if seen[u] { continue; }
                    seen[u] = true;
                    if (0..3).any(|j| f[u][j] == a && f[u][(j + 1) % 3] == b) { f[u].swap(1, 2); turned += 1; }
                    comp.push(u);
                }
            }
        }
        // open: some edge of the piece is a border (one triangle); an edge two shells share (4 triangles) is no hole
        let closed = comp.iter().all(|&t| (0..3).all(|k| edges[&ek(f[t][k], f[t][(k + 1) % 3])].len() >= 2));
        let flip = if closed {
            let vol: f64 = comp.iter().map(|&t| {
                let [a, b, c] = f[t].map(|v| p[v as usize]);
                dot(a, cross(b, c))
            }).sum();
            vol < 0.
        } else {
            turned * 2 > comp.len()
        };
        if flip {
            for &t in &comp { f[t].swap(1, 2); }
        }
    }
}

/// Dihedral (degrees) under which two triangles across an edge count as the two halves of one quad.
const QUAD_FLAT: f64 = 20.;
/// A quad's shared edge must be this much of its other diagonal at least: a pair across a short edge is a triangle
/// fan, not a quad.
const QUAD_DIAGONAL: f64 = 0.625;

/// The quads a triangle soup was cut from, as a polygon id per triangle (`Mesh::poly`).
///
/// A boxed model exported as OBJ or glTF arrives with every quad split by a diagonal the modeller never drew. Charting
/// by facing gets away with it most of the time, but a seam path or a split can run down that diagonal, and the export
/// then has to write the quad as two triangles — a texel seam on a face that should carry one. The diagonal is easy to
/// tell from a real edge: its two triangles lie flat against each other and their four corners make a proper convex
/// quad, and it is the longer way across. Those are dissolved best first, each triangle used once.
fn recover_quads(p: &[V3], f: &[[u32; 3]], edges: &Map<u64, Vec<u32>>, n: &[V3]) -> Vec<u32> {
    let mut poly: Vec<u32> = (0..f.len() as u32).collect();
    if f.len() < 2 { return poly; }
    let mut cand: Vec<(f64, u32, u32)> = Vec::new();
    for (&key, ts) in edges {
        if ts.len() != 2 { continue; }
        let (s, t) = (ts[0], ts[1]);
        let (a, b) = ((key >> 32) as u32, (key & 0xffff_ffff) as u32);
        let other = |tri: u32| f[tri as usize].iter().copied().find(|&v| v != a && v != b);
        let (Some(c), Some(d)) = (other(s), other(t)) else { continue };
        let ang = dot(n[s as usize], n[t as usize]).clamp(-1., 1.).acos().to_degrees();
        if ang > QUAD_FLAT { continue; }
        // the four corners in winding order, the shared edge as the diagonal, must make a convex quad
        let q = [c, a, d, b];
        let nn = [0, 1, 2].map(|k| n[s as usize][k] + n[t as usize][k]);
        let l = norm(nn);
        if !(l > 0.) { continue; }
        let nn = nn.map(|x| x / l);
        let (mut side, mut ok) = (0., true);
        for k in 0..4 {
            let (x, y, z) = (p[q[k] as usize], p[q[(k + 1) % 4] as usize], p[q[(k + 2) % 4] as usize]);
            let s = dot(cross(sub(y, x), sub(z, y)), nn);
            if s.abs() < 1e-12 { ok = false; break; }
            if side == 0. { side = s.signum(); } else if s.signum() != side { ok = false; break; }
        }
        if !ok { continue; }
        let diag = dist(p[a as usize], p[b as usize]);
        let across = dist(p[c as usize], p[d as usize]);
        if diag < 1e-12 || across > diag / QUAD_DIAGONAL { continue; }
        // flattest first, then the pair whose shared edge is the longer way across
        cand.push((ang + 20. * (across / diag - 1.).max(0.), s, t));
    }
    cand.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2)));
    let mut used = vec![false; f.len()];
    let mut next = f.len() as u32;
    for (_, s, t) in cand {
        if used[s as usize] || used[t as usize] { continue; }
        used[s as usize] = true;
        used[t as usize] = true;
        poly[s as usize] = next;
        poly[t as usize] = next;
        next += 1;
    }
    poly
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two halves of a flat quad are one polygon, so its diagonal is `inside` (never a seam); a bent pair is two.
    #[test]
    fn a_flat_quad_is_read_back_from_its_triangles() {
        let quad = [0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 0., 0., 1., 1., 0., 0., 1., 0.];
        let m = Mesh::from_soup(&quad).unwrap();
        assert_eq!(m.f.len(), 2);
        assert_eq!(m.poly[0], m.poly[1]);
        let shared = *m.edges.iter().find(|(_, ts)| ts.len() == 2).map(|(k, _)| k).unwrap();
        assert!(m.inside(shared), "the quad's diagonal is not inside its polygon");

        // the same diagonal with one far corner lifted out of the plane: a fold, not a quad
        let bent = [0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 0., 0., 1., 1., 0., 0., 1., 0.5];
        let m = Mesh::from_soup(&bent).unwrap();
        assert_eq!(m.f.len(), 2);
        assert_ne!(m.poly[0], m.poly[1]);
    }

    /// Two outward cubes touching along one edge (4 triangles on each of its pieces) stay outward, both of them.
    #[test]
    fn shells_touching_along_an_edge_keep_their_winding() {
        let a = crate::shapes::get("cube").unwrap();
        let b: Vec<f32> = a.chunks(3).flat_map(|v| [v[0] + 1., v[1] + 1., v[2]]).collect();
        let m = Mesh::from_soup(&[a, b].concat()).unwrap();
        let (ca, cb) = (m.to_local([0., 0., 0.]), m.to_local([1., 1., 0.]));
        for t in 0..m.f.len() as u32 {
            let c = m.centroid(t);
            let mid = if dist(c, ca) < dist(c, cb) { ca } else { cb };
            assert!(dot(m.n[t as usize], sub(c, mid)) > 0., "triangle {t} faces into its cube");
        }
    }

    /// An open piece keeps the side most of its faces face in the file (one stray turned to match), wherever it sits:
    /// a box with no lid wound inward, far from the origin, stays wound inward.
    #[test]
    fn open_pieces_keep_the_files_side() {
        // the shapes' cube is half wound inward on purpose: take the engine's outward one
        let cube = Mesh::from_soup(&crate::shapes::get("cube").unwrap()).unwrap();
        let mut soup: Vec<f32> = Vec::new();
        for (i, t) in cube.f.iter().enumerate().skip(2) {
            let mut c: Vec<[f32; 3]> = t.iter().map(|&v| { let w = cube.to_world(cube.pt(v)); [w[0] + 100., w[1] + 50., w[2] + 20.] }).collect();
            if i != 5 { c.swap(1, 2); } // inward, but one stray left outward
            soup.extend(c.iter().flatten());
        }
        let m = Mesh::from_soup(&soup).unwrap();
        let mid = m.to_local([100., 50., 20.]);
        for t in 0..m.f.len() as u32 {
            assert!(dot(m.n[t as usize], sub(m.centroid(t), mid)) < 0., "triangle {t} turned out of the open box");
        }
    }
}
