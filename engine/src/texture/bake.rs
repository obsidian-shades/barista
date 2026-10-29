//! Bake Mesh Maps at any size (src/bake.ts on the CPU): ambient occlusion from the whole model's depth seen from 96
//! directions round it (orthographic, like a shadow map each), and per texel the distance to the nearest sharp convex
//! and concave edge, which the generators (edge wear, dirt) turn into masks.
use std::collections::HashMap;

const DIRS: usize = 96;
const RES: usize = 512;

pub type V3 = [f32; 3];
pub fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
pub fn dot(a: V3, b: V3) -> f32 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
pub fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
pub fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt();
    if l > 0.0 { [a[0] / l, a[1] / l, a[2] / l] } else { a }
}
pub fn at(p: &[f32], i: usize) -> V3 { [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]] }

/// The bounding sphere three.js gives (box centre, farthest point).
pub fn sphere(all: &[&[f32]]) -> (V3, f32) {
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for p in all {
        for v in p.chunks_exact(3) {
            for k in 0..3 { lo[k] = lo[k].min(v[k]); hi[k] = hi[k].max(v[k]); }
        }
    }
    let c = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0];
    let r = all.iter().flat_map(|p| p.chunks_exact(3)).map(|v| dot(sub([v[0], v[1], v[2]], c), sub([v[0], v[1], v[2]], c))).fold(0.0f32, f32::max).sqrt();
    (c, r.max(1e-6))
}

/// One direction's depth map: the model seen along `d` from outside, nearest depth per pixel (0 = near plane).
struct View { d: V3, eye: V3, x: V3, y: V3, z: V3, depth: Vec<f32> }

pub struct Occlusion { views: Vec<View>, r: f32, near: f32, far: f32, eps: f32, off: f32 }

impl Occlusion {
    /// Depth from 96 Fibonacci-sphere directions of every triangle in `casters`.
    pub fn new(casters: &[&[f32]]) -> Occlusion {
        use rayon::prelude::*;
        let (c, r) = sphere(casters);
        let (near, far) = (0.01 * r, 3.0 * r);
        let views = (0..DIRS)
            .into_par_iter()
            .map(|k| {
                let y = 1.0 - 2.0 * (k as f32 + 0.5) / DIRS as f32;
                let rr = (1.0 - y * y).sqrt();
                let a = k as f32 * std::f32::consts::PI * (3.0 - 5f32.sqrt());
                let d = [a.cos() * rr, y, a.sin() * rr];
                let eye = [c[0] + d[0] * 1.5 * r, c[1] + d[1] * 1.5 * r, c[2] + d[2] * 1.5 * r];
                // three's lookAt: z from the target to the eye, x = up × z, y = z × x
                let up = if d[1].abs() > 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
                let z = norm(sub(eye, c));
                let x = norm(cross(up, z));
                let yv = cross(z, x);
                let mut view = View { d, eye, x, y: yv, z, depth: vec![f32::INFINITY; RES * RES] };
                for p in casters {
                    for t in p.chunks_exact(9) {
                        let v: Vec<[f32; 3]> = (0..3).map(|i| view.project([t[i * 3], t[i * 3 + 1], t[i * 3 + 2]], r, near, far)).collect();
                        raster_depth(&mut view.depth, &v);
                    }
                }
                view
            })
            .collect();
        // a sample is in front if within two depth texels of the nearest surface seen there (bake.ts: 4R/RES over 3R)
        Occlusion { views, r, near, far, eps: (4.0 * r) / RES as f32 / (3.0 * r), off: (3.0 * r) / RES as f32 }
    }

    /// 0 (shut in) .. 1 (open sky): the cosine-weighted share of the texel's hemisphere from which nothing hides it.
    pub fn ao(&self, p: V3, n: V3) -> f32 {
        let q = [p[0] + n[0] * self.off, p[1] + n[1] * self.off, p[2] + n[2] * self.off];
        let (mut seen, mut sum) = (0.0, 0.0);
        for v in &self.views {
            let w = dot(n, v.d);
            if w <= 0.0 { continue; }
            sum += w;
            let [sx, sy, z] = v.project(q, self.r, self.near, self.far);
            let (ix, iy) = ((sx).floor() as isize, (sy).floor() as isize);
            if ix < 0 || iy < 0 || ix >= RES as isize || iy >= RES as isize || z <= v.depth[iy as usize * RES + ix as usize] + self.eps {
                seen += w;
            }
        }
        if sum > 0.0 { seen / sum } else { 1.0 }
    }
}

impl View {
    /// Pixel x, y and depth 0..1 between the near and far planes.
    fn project(&self, p: V3, r: f32, near: f32, far: f32) -> [f32; 3] {
        let q = sub(p, self.eye);
        [(dot(q, self.x) / r + 1.0) / 2.0 * RES as f32, (dot(q, self.y) / r + 1.0) / 2.0 * RES as f32, (-dot(q, self.z) - near) / (far - near)]
    }
}

/// Nearest depth per pixel centre, both faces.
fn raster_depth(buf: &mut [f32], v: &[[f32; 3]]) {
    let area = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1]);
    if area.abs() < 1e-12 { return; }
    let x0 = v.iter().map(|p| p[0]).fold(f32::MAX, f32::min).floor().max(0.0) as usize;
    let x1 = (v.iter().map(|p| p[0]).fold(f32::MIN, f32::max).ceil() as isize).min(RES as isize - 1);
    let y0 = v.iter().map(|p| p[1]).fold(f32::MAX, f32::min).floor().max(0.0) as usize;
    let y1 = (v.iter().map(|p| p[1]).fold(f32::MIN, f32::max).ceil() as isize).min(RES as isize - 1);
    if x1 < 0 || y1 < 0 { return; }
    for y in y0..=y1 as usize {
        for x in x0..=x1 as usize {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let b0 = ((v[1][0] - px) * (v[2][1] - py) - (v[2][0] - px) * (v[1][1] - py)) / area;
            let b1 = ((v[2][0] - px) * (v[0][1] - py) - (v[0][0] - px) * (v[2][1] - py)) / area;
            let b2 = 1.0 - b0 - b1;
            if b0 < 0.0 || b1 < 0.0 || b2 < 0.0 { continue; }
            let z = b0 * v[0][2] + b1 * v[1][2] + b2 * v[2][2];
            let d = &mut buf[y * RES + x];
            if z < *d { *d = z; }
        }
    }
}

/// The file's normals per output corner (polyedit.ts `outNormals`): each output triangle's corner takes the normal of
/// the nearest corner of the file triangle it came from (`source`); NaN where it came from none.
pub fn out_normals(pos: &[f32], source: &[i32], soup: &[f32], normals: &[f32]) -> Vec<f32> {
    let mut n = vec![f32::NAN; pos.len()];
    for (t, &s) in source.iter().enumerate() {
        if s < 0 || (s as usize) * 9 + 9 > soup.len().min(normals.len()) || t * 9 + 9 > pos.len() { continue; }
        let s = s as usize;
        for k in 0..3 {
            let o = t * 9 + k * 3;
            let best = (0..3).map(|j| s * 9 + j * 3).min_by(|&a, &b| {
                let d = |q: usize| (0..3).map(|c| (soup[q + c] - pos[o + c]).powi(2)).sum::<f32>();
                d(a).total_cmp(&d(b))
            }).unwrap();
            n[o..o + 3].copy_from_slice(&normals[best..best + 3]);
        }
    }
    n
}

/// The part's hard edges (bake.ts `isHard`: the file's normals differ across it, else the faces meet at more than
/// `sharp` degrees; UV seams play no part), convex and concave apart, as whole segments in a grid of `reach` cells; a
/// query is the distance to the nearest segment over its strength (Infinity past `reach`).
pub struct Edges { grids: [HashMap<(i32, i32, i32), Vec<[f32; 7]>>; 2], reach: f32 }

impl Edges {
    pub fn new(pos: &[f32], reach: f32, normals: Option<&[f32]>, sharp: f32) -> Edges {
        let tris = pos.len() / 9;
        let fnrm: Vec<V3> = (0..tris).map(|t| norm(cross(sub(at(pos, t * 3 + 1), at(pos, t * 3)), sub(at(pos, t * 3 + 2), at(pos, t * 3))))).collect();
        let fc: Vec<V3> = (0..tris).map(|t| { let (a, b, c) = (at(pos, t * 3), at(pos, t * 3 + 1), at(pos, t * 3 + 2)); [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0] }).collect();
        // welded edges by exact position (topo.ts topoOf): the triangles on each
        let key = |v: V3| (v[0].to_bits(), v[1].to_bits(), v[2].to_bits());
        let mut edges: HashMap<((u32, u32, u32), (u32, u32, u32)), (V3, V3, Vec<usize>)> = HashMap::new();
        // the corner of triangle `t` at position `v`
        let corner = |t: usize, v: V3| (0..3).map(|k| t * 3 + k).find(|&c| key(at(pos, c)) == key(v)).unwrap_or(t * 3);
        let hard = |v0: V3, v1: V3, a: usize, b: usize, angle: f32| -> bool {
            if let Some(n) = normals {
                let mut known = true;
                for v in [v0, v1] {
                    let (ca, cb) = (corner(a, v) * 3, corner(b, v) * 3);
                    if n[ca].is_nan() || n[cb].is_nan() { known = false; break; }
                    if n[ca] * n[cb] + n[ca + 1] * n[cb + 1] + n[ca + 2] * n[cb + 2] < 0.999 { return true; }
                }
                if known { return false; }
            }
            angle > sharp.to_radians()
        };
        for t in 0..tris {
            for k in 0..3 {
                let (a, b) = (at(pos, t * 3 + k), at(pos, t * 3 + (k + 1) % 3));
                let (ka, kb) = (key(a), key(b));
                let e = edges.entry(if ka < kb { (ka, kb) } else { (kb, ka) }).or_insert((a, b, vec![]));
                e.2.push(t);
            }
        }
        let cell = |p: V3| ((p[0] / reach).floor() as i32, (p[1] / reach).floor() as i32, (p[2] / reach).floor() as i32);
        let mut grids = [HashMap::new(), HashMap::new()];
        for (v0, v1, ts) in edges.values() {
            let [a, b] = [ts[0], *ts.get(1).unwrap_or(&usize::MAX)];
            if b == usize::MAX { continue; }
            let angle = dot(fnrm[a], fnrm[b]).clamp(-1.0, 1.0).acos();
            if !hard(*v0, *v1, a, b, angle) { continue; }
            // convex when b's centre lies behind a's plane
            let side = dot(sub(fc[b], *v0), fnrm[a]);
            let g = &mut grids[if side < 0.0 { 0 } else { 1 }];
            let s = (angle / std::f32::consts::FRAC_PI_2).min(1.0);
            let len = dot(sub(*v1, *v0), sub(*v1, *v0)).sqrt();
            let steps = ((len / (reach / 8.0)).ceil() as usize).max(1);
            // the segment, in every cell it crosses: its distance is exact between those samples, so a band
            // narrower than reach/8 stays a continuous line instead of beads (Edge Wear's 0.4% width was dots)
            let seg = [v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], s];
            let mut seen: Vec<(i32, i32, i32)> = Vec::new();
            for k in 0..=steps {
                let f = k as f32 / steps as f32;
                let c = cell([v0[0] + (v1[0] - v0[0]) * f, v0[1] + (v1[1] - v0[1]) * f, v0[2] + (v1[2] - v0[2]) * f]);
                if seen.contains(&c) { continue; }
                seen.push(c);
                g.entry(c).or_insert_with(Vec::new).push(seg);
            }
        }
        Edges { grids, reach }
    }

    /// Distance to the nearest convex (0) or concave (1) edge, over its strength.
    pub fn dist(&self, which: usize, p: V3) -> f32 {
        let r = self.reach;
        let (cx, cy, cz) = ((p[0] / r).floor() as i32, (p[1] / r).floor() as i32, (p[2] / r).floor() as i32);
        let mut best = f32::INFINITY;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = self.grids[which].get(&(cx + dx, cy + dy, cz + dz)) {
                        for q in list {
                            let ab = [q[3] - q[0], q[4] - q[1], q[5] - q[2]];
                            let ap = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
                            let ee = dot(ab, ab);
                            let t = if ee > 1e-20 { (dot(ap, ab) / ee).clamp(0.0, 1.0) } else { 0.0 };
                            let d = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
                            best = best.min(dot(d, d).sqrt() / q[6]);
                        }
                    }
                }
            }
        }
        if best <= r { best } else { f32::INFINITY }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two quads folded 90° along the x axis. A texel 0.5 out from both flanks is 0.707 from the crease; the old
    /// sampled-points distance (samples only at the ends, reach/8 = 1.25 apart) made it 0.866 — the beads behind
    /// dotted Edge Wear.
    #[test]
    fn an_edge_distance_is_measured_to_the_segment() {
        let pos = [0., 0., 0., 1., 0., 0., 1., -1., 0., 0., 0., 0., 1., 0., 0., 1., 0., 1.];
        let e = Edges::new(&pos, 10.0, None, 45.0);
        let d = e.dist(0, [0.5, 0.5, 0.5]).min(e.dist(1, [0.5, 0.5, 0.5]));
        assert!((d - 0.5f32.hypot(0.5)).abs() < 1e-4, "distance {d}");
    }

    /// Wear follows the shading, not the bend: two quads meeting at 30° are an edge only when the file's normals
    /// split there (or, with no normals, when 30° is past Sharp edges). bake.ts `isHard` is the same rule.
    #[test]
    fn hard_edges_follow_the_shading() {
        let (c, s) = (30f32.to_radians().cos(), 30f32.to_radians().sin());
        // flank a in the xy plane, flank b turned 30° about the x axis, sharing the edge (0,0,0)-(1,0,0)
        let pos = [0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 0., 0., 1., -c, s, 1., 0., 0.];
        let p = [0.5, 0.05, 0.05];
        let near = |e: &Edges| e.dist(0, p).min(e.dist(1, p)).is_finite();
        assert!(!near(&Edges::new(&pos, 10.0, None, 45.0)), "30° under a 45° Sharp edges is smooth");
        assert!(near(&Edges::new(&pos, 10.0, None, 20.0)), "30° over a 20° Sharp edges is an edge");
        let up = [0f32, 0., 1.];
        let smooth: Vec<f32> = (0..6).flat_map(|_| up).collect();
        assert!(!near(&Edges::new(&pos, 10.0, Some(&smooth), 20.0)), "one normal across it: smooth, whatever the angle");
        let mut split = smooth.clone();
        for k in 3..6 { split[k * 3..k * 3 + 3].copy_from_slice(&[0., s, c]); }
        assert!(near(&Edges::new(&pos, 10.0, Some(&split), 45.0)), "normals split across it: an edge");
    }
}
