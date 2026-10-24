//! Per texel: which triangle owns it (rasterised in UV as `src/paint.ts` `raster` does, borders and all), its point
//! on the surface, and what each kind of layer puts there: a fill's material (tri-planar or UV), a decal's ink, a
//! generator's mask, or the working-resolution pixels upsampled.
use super::bake::{at, cross, dot, norm, sub, V3};
use super::{Decal, Fill, Gen};
use rayon::prelude::*;
use std::collections::HashMap;

pub const NONE: u32 = u32::MAX;

/// A part as the paint sees it: corner positions and UVs, per triangle its face normal and UV tangent frame, and per
/// corner how far a texel may sit outside the triangle (`bordersOf` in paint.ts).
pub struct Mesh<'a> {
    pub pos: &'a [f32],
    pub uv: &'a [f32],
    pub nrm: Vec<V3>,
    tan: Vec<(V3, V3)>,
    border: Vec<u8>,
}

impl<'a> Mesh<'a> {
    pub fn new(pos: &'a [f32], uv: &'a [f32]) -> Mesh<'a> {
        let tris = pos.len() / 9;
        let nrm: Vec<V3> = (0..tris).map(|t| norm(cross(sub(at(pos, t * 3 + 1), at(pos, t * 3)), sub(at(pos, t * 3 + 2), at(pos, t * 3))))).collect();
        let tan = (0..tris)
            .map(|t| {
                let (e1, e2) = (sub(at(pos, t * 3 + 1), at(pos, t * 3)), sub(at(pos, t * 3 + 2), at(pos, t * 3)));
                let (du1, dv1) = (uv[t * 6 + 2] - uv[t * 6], uv[t * 6 + 3] - uv[t * 6 + 1]);
                let (du2, dv2) = (uv[t * 6 + 4] - uv[t * 6], uv[t * 6 + 5] - uv[t * 6 + 1]);
                let det = du1 * dv2 - du2 * dv1;
                if det.abs() <= 1e-12 { return ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]); }
                let tv = norm([(e1[0] * dv2 - e2[0] * dv1) / det, (e1[1] * dv2 - e2[1] * dv1) / det, (e1[2] * dv2 - e2[2] * dv1) / det]);
                (tv, norm(cross(nrm[t], tv)))
            })
            .collect();
        // 0 inside an island, 1 a UV border the surface carries on across (within 30°), 2 a border along a crease
        let uvkey = |c: usize| (uv[c * 2].to_bits(), uv[c * 2 + 1].to_bits());
        let next = |c: usize| c - c % 3 + (c + 1) % 3;
        let ukey = |c: usize| { let (a, b) = (uvkey(c), uvkey(next(c))); if a < b { (a, b) } else { (b, a) } };
        let mut count: HashMap<_, u32> = HashMap::new();
        for c in 0..tris * 3 { *count.entry(ukey(c)).or_default() += 1; }
        let pkey = |c: usize| (pos[c * 3].to_bits(), pos[c * 3 + 1].to_bits(), pos[c * 3 + 2].to_bits());
        let ekey = |c: usize| { let (a, b) = (pkey(c), pkey(next(c))); if a < b { (a, b) } else { (b, a) } };
        let mut edges: HashMap<_, Vec<usize>> = HashMap::new();
        for c in 0..tris * 3 { edges.entry(ekey(c)).or_default().push(c / 3); }
        let border = (0..tris * 3)
            .map(|c| {
                if count[&ukey(c)] >= 2 { return 0; }
                let t = c / 3;
                if edges[&ekey(c)].iter().any(|&u| u != t && dot(nrm[t], nrm[u]) > 0.866) { 1 } else { 2 }
            })
            .collect();
        Mesh { pos, uv, nrm, tan, border }
    }

    pub fn tris(&self) -> usize { self.pos.len() / 9 }

    /// Triangle `t`'s corners in texels of an n² texture, its signed area, and per barycentric its tolerance.
    fn texel_tri(&self, t: usize, n: usize) -> ([f32; 3], [f32; 3], f32, [f32; 3]) {
        let nf = n as f32;
        let u = [self.uv[t * 6] * nf, self.uv[t * 6 + 2] * nf, self.uv[t * 6 + 4] * nf];
        let v = [self.uv[t * 6 + 1] * nf, self.uv[t * 6 + 3] * nf, self.uv[t * 6 + 5] * nf];
        let area = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
        let tol = [0, 1, 2].map(|k| {
            if self.border[t * 3 + (k + 1) % 3] != 1 || area.abs() < 1e-9 { return 0.0; }
            0.5 * (u[(k + 2) % 3] - u[(k + 1) % 3]).hypot(v[(k + 2) % 3] - v[(k + 1) % 3]) / area.abs()
        });
        (u, v, area, tol)
    }

    /// Barycentrics of texel (x, y)'s centre in triangle t (may be a little negative inside the border tolerance).
    pub fn bary(&self, t: usize, n: usize, x: usize, y: usize) -> [f32; 3] {
        let (u, v, area, _) = self.texel_tri(t, n);
        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
        let b0 = ((u[1] - px) * (v[2] - py) - (u[2] - px) * (v[1] - py)) / area;
        let b1 = ((u[2] - px) * (v[0] - py) - (u[0] - px) * (v[2] - py)) / area;
        [b0, b1, 1.0 - b0 - b1]
    }

    pub fn point(&self, t: usize, b: [f32; 3]) -> V3 {
        let (a, c, d) = (at(self.pos, t * 3), at(self.pos, t * 3 + 1), at(self.pos, t * 3 + 2));
        [0, 1, 2].map(|k| b[0] * a[k] + b[1] * c[k] + b[2] * d[k])
    }

    /// Per texel of an n² texture, the triangle that owns it (the first to reach it, as paint.ts's strongest-weight
    /// rule gives for weight 1), NONE off the surface. Bands of rows run in parallel; within a band triangles go in order.
    pub fn owners(&self, n: usize) -> Vec<u32> {
        const BAND: usize = 64;
        let bands = n.div_ceil(BAND);
        let mut lists: Vec<Vec<u32>> = vec![vec![]; bands];
        for t in 0..self.tris() {
            let (_, v, area, _) = self.texel_tri(t, n);
            if area.abs() < 1e-9 { continue; }
            let y0 = (v.iter().cloned().fold(f32::MAX, f32::min) - 2.0).floor().max(0.0) as usize;
            let y1 = ((v.iter().cloned().fold(f32::MIN, f32::max) + 2.0).ceil() as isize).clamp(0, n as isize - 1) as usize;
            for b in y0 / BAND..=(y1 / BAND).min(bands - 1) { lists[b].push(t as u32); }
        }
        let mut out = vec![NONE; n * n];
        out.par_chunks_mut(BAND * n).zip(lists.par_iter()).enumerate().for_each(|(b, (rows, list))| {
            let (ry0, ry1) = (b * BAND, (b * BAND + rows.len() / n).saturating_sub(1));
            for &t in list {
                let t = t as usize;
                let (u, v, area, tol) = self.texel_tri(t, n);
                let x0 = (u.iter().cloned().fold(f32::MAX, f32::min) - 2.0).floor().max(0.0) as usize;
                let x1 = ((u.iter().cloned().fold(f32::MIN, f32::max) + 2.0).ceil() as isize).clamp(0, n as isize - 1) as usize;
                let y0 = ((v.iter().cloned().fold(f32::MAX, f32::min) - 2.0).floor().max(0.0) as usize).max(ry0);
                let y1 = (((v.iter().cloned().fold(f32::MIN, f32::max) + 2.0).ceil() as isize).clamp(0, n as isize - 1) as usize).min(ry1);
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        let cell = &mut rows[(y - ry0) * n + x];
                        if *cell != NONE { continue; }
                        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                        let b0 = ((u[1] - px) * (v[2] - py) - (u[2] - px) * (v[1] - py)) / area;
                        let b1 = ((u[2] - px) * (v[0] - py) - (u[0] - px) * (v[2] - py)) / area;
                        if b0 < -tol[0] || b1 < -tol[1] || 1.0 - b0 - b1 < -tol[2] { continue; }
                        *cell = t as u32;
                    }
                }
            }
        });
        out
    }
}

/// A working-resolution buffer (n², `stride` bytes a texel, the last the coverage unless `plain`) read at another size:
/// bilinear over the neighbours that lie on the surface at that resolution, so an island's edge never averages in
/// the empty texture beside it.
pub struct Up<'a> { pub n: usize, pub on: &'a [u32] }

impl Up<'_> {
    /// Values (premultiplied by coverage, then divided back) and coverage 0..1 at UV (u, v); `plain` buffers (masks)
    /// have no coverage byte and return it as 1.
    pub fn sample(&self, buf: &[u8], stride: usize, plain: bool, u: f32, v: f32, out: &mut [f32; 4]) -> f32 {
        let n = self.n;
        let (x, y) = (u * n as f32 - 0.5, v * n as f32 - 0.5);
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let k = if plain { stride } else { stride - 1 };
        let (mut wsum, mut cov) = (0.0, 0.0);
        let mut acc = [0f32; 4];
        for (dx, dy, w) in [(0, 0, (1.0 - fx) * (1.0 - fy)), (1, 0, fx * (1.0 - fy)), (0, 1, (1.0 - fx) * fy), (1, 1, fx * fy)] {
            let (xi, yi) = (x0 as isize + dx, y0 as isize + dy);
            if xi < 0 || yi < 0 || xi >= n as isize || yi >= n as isize { continue; }
            let i = yi as usize * n + xi as usize;
            if self.on[i] == NONE || w <= 0.0 { continue; }
            let a = if plain { 1.0 } else { buf[i * stride + k] as f32 / 255.0 };
            wsum += w;
            cov += w * a;
            for c in 0..k { acc[c] += w * a * buf[i * stride + c] as f32; }
        }
        if wsum <= 0.0 {
            // a sliver thinner than a working texel: take the nearest texel as it is
            let i = (v * n as f32).clamp(0.0, n as f32 - 1.0) as usize * n + (u * n as f32).clamp(0.0, n as f32 - 1.0) as usize;
            let a = if plain { 1.0 } else { buf[i * stride + k] as f32 / 255.0 };
            for c in 0..k { out[c] = buf[i * stride + c] as f32; }
            return a;
        }
        for c in 0..k { out[c] = if cov > 0.0 { acc[c] / cov } else { 0.0 }; }
        cov / wsum
    }
}

/// A decoded image, RGBA, row 0 at the top.
pub struct Map { pub w: usize, pub h: usize, pub data: Vec<u8> }

/// Bilinear with repeat (a material map).
fn sample_map(m: &Map, u: f32, v: f32) -> [f32; 4] {
    let (w, h) = (m.w as isize, m.h as isize);
    let (fu, fv) = (u - u.floor(), v - v.floor());
    let (x, y) = (fu * w as f32 - 0.5, (1.0 - fv) * h as f32 - 0.5);
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let wrap = |a: isize, n: isize| ((a % n) + n) % n;
    let (xa, xb, ya, yb) = (wrap(x0 as isize, w), wrap(x0 as isize + 1, w), wrap(y0 as isize, h), wrap(y0 as isize + 1, h));
    let px = |xx: isize, yy: isize, k: usize| m.data[((yy * w + xx) * 4) as usize + k] as f32;
    [0, 1, 2, 3].map(|k| (px(xa, ya, k) * (1.0 - fx) + px(xb, ya, k) * fx) * (1.0 - fy) + (px(xa, yb, k) * (1.0 - fx) + px(xb, yb, k) * fx) * fy)
}

/// Bilinear, clamped, alpha-weighted (a decal): RGB and alpha 0..255.
fn sample_decal(m: &Map, u: f32, v: f32) -> [f32; 4] {
    let (w, h) = (m.w as isize, m.h as isize);
    let (x, y) = (u * w as f32 - 0.5, (1.0 - v) * h as f32 - 0.5);
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let cl = |a: isize, n: isize| a.clamp(0, n - 1);
    let (xa, xb, ya, yb) = (cl(x0 as isize, w), cl(x0 as isize + 1, w), cl(y0 as isize, h), cl(y0 as isize + 1, h));
    let (mut r, mut g, mut b, mut a) = (0.0, 0.0, 0.0, 0.0);
    for (xx, yy, wt) in [(xa, ya, (1.0 - fx) * (1.0 - fy)), (xb, ya, fx * (1.0 - fy)), (xa, yb, (1.0 - fx) * fy), (xb, yb, fx * fy)] {
        let o = ((yy * w + xx) * 4) as usize;
        let al = m.data[o + 3] as f32 / 255.0 * wt;
        r += m.data[o] as f32 * al; g += m.data[o + 1] as f32 * al; b += m.data[o + 2] as f32 * al; a += al;
    }
    if a > 1e-6 { r /= a; g /= a; b /= a; }
    [r, g, b, a * 255.0]
}

pub fn hex(s: &str) -> [f32; 3] {
    [1, 3, 5].map(|k| s.get(k..k + 2).and_then(|h| u8::from_str_radix(h, 16).ok()).unwrap_or(255) as f32)
}

/// A fill's material maps (paint.ts MaterialPixels).
#[derive(Default)]
pub struct Material { pub basecolor: Option<Map>, pub normal: Option<Map>, pub roughness: Option<Map>, pub metallic: Option<Map>, pub height: Option<Map> }

/// What one layer lays on a texel: per channel its value(s) 0..255 and coverage 0..1 (None: the layer leaves it alone).
#[derive(Default, Clone, Copy)]
pub struct Texel { pub color: Option<([f32; 3], f32)>, pub rough: Option<(f32, f32)>, pub metal: Option<(f32, f32)>, pub normal: Option<([f32; 3], f32)>, pub height: Option<(f32, f32)> }

/// A fill layer's material at texel (x, y) of an n² texture, owned by triangle t at point p (`bakeFill` in paint.ts).
pub fn fill_at(f: &Fill, m: &Material, mesh: &Mesh, t: usize, p: V3, x: usize, y: usize, n: usize, span: f32) -> Texel {
    let tint = hex(&f.tint);
    let has = |c: &str| f.channels.iter().any(|x| x == c);
    let rough_v = |u: f32, v: f32| f.roughness.map(|r| r * 255.0).unwrap_or_else(|| m.roughness.as_ref().map(|r| sample_map(r, u, v)[0]).unwrap_or(128.0));
    let metal_v = |u: f32, v: f32| f.metallic.map(|r| r * 255.0).unwrap_or_else(|| m.metallic.as_ref().map(|r| sample_map(r, u, v)[0]).unwrap_or(0.0));
    let height_v = |u: f32, v: f32| m.height.as_ref().map(|r| sample_map(r, u, v)[0]).unwrap_or(128.0);
    let tinted = |q: [f32; 4]| [0, 1, 2].map(|c| (q[c] * tint[c] / 255.0).min(255.0));
    let mut out = Texel::default();
    if f.projection == "uv" {
        let rad = f.rotation.to_radians();
        let (co, si) = (rad.cos(), rad.sin());
        let u = ((x as f32 + 0.5) / n as f32 - 0.5) * f.tiling;
        let v = ((y as f32 + 0.5) / n as f32 - 0.5) * f.tiling;
        let (su, sv) = (u * co - v * si + 0.5 + f.offset[0], u * si + v * co + 0.5 + f.offset[1]);
        if has("color") { out.color = Some((m.basecolor.as_ref().map(|c| tinted(sample_map(c, su, sv))).unwrap_or([188.0; 3]), 1.0)); }
        if has("rough") { out.rough = Some((rough_v(su, sv), 1.0)); }
        if has("metal") { out.metal = Some((metal_v(su, sv), 1.0)); }
        if has("height") { out.height = Some((height_v(su, sv), 1.0)); }
        if has("normal") {
            out.normal = Some((match &m.normal {
                Some(nm) => {
                    let q = sample_map(nm, su, sv);
                    let (dx, dy) = ((q[0] / 127.5 - 1.0) * f.normal_strength, (q[1] / 127.5 - 1.0) * f.normal_strength);
                    let dz = (1.0 - dx * dx - dy * dy).max(0.0).sqrt();
                    [(dx * 0.5 + 0.5) * 255.0, (dy * 0.5 + 0.5) * 255.0, (dz * 0.5 + 0.5) * 255.0]
                }
                None => [128.0, 128.0, 255.0],
            }, 1.0));
        }
        return out;
    }
    // tri-planar: the projection turned about Y, then each plane, blended by the face normal to the 4th power
    let nn = mesh.nrm[t];
    let (tv, bv) = mesh.tan[t];
    let tiles = f.tiles / if span > 0.0 { span } else { 1.0 };
    let rad = f.rotation.to_radians();
    let (co, si) = (rad.cos(), rad.sin());
    let (rx, rz) = (p[0] * co + p[2] * si, -p[0] * si + p[2] * co);
    let uvs = [(rz * tiles + f.offset[0], p[1] * tiles + f.offset[1]), (rx * tiles + f.offset[0], rz * tiles + f.offset[1]), (rx * tiles + f.offset[0], p[1] * tiles + f.offset[1])];
    let w = [nn[0].abs().powi(4), nn[1].abs().powi(4), nn[2].abs().powi(4)];
    let ws = { let s = w[0] + w[1] + w[2]; if s > 0.0 { s } else { 1.0 } };
    let blend = |g: &dyn Fn(f32, f32) -> f32| (0..3).map(|k| g(uvs[k].0, uvs[k].1) * w[k]).sum::<f32>() / ws;
    if has("color") {
        let c = match &m.basecolor {
            Some(cm) => { let mut acc = [0.0; 3]; for k in 0..3 { let q = sample_map(cm, uvs[k].0, uvs[k].1); for c in 0..3 { acc[c] += q[c] * w[k]; } } tinted([acc[0] / ws, acc[1] / ws, acc[2] / ws, 0.0]) }
            None => tinted([188.0, 188.0, 188.0, 0.0]),
        };
        out.color = Some((c, 1.0));
    }
    if has("rough") { out.rough = Some((blend(&rough_v), 1.0)); }
    if has("metal") { out.metal = Some((blend(&metal_v), 1.0)); }
    if has("height") { out.height = Some((blend(&height_v), 1.0)); }
    if has("normal") {
        let n3 = match &m.normal {
            Some(nm) if w[0] + w[1] + w[2] > 0.0 => {
                let mut wn = [0f32; 3];
                for k in 0..3 {
                    let wt = w[k] / ws;
                    if wt <= 0.0 { continue; }
                    let q = sample_map(nm, uvs[k].0, uvs[k].1);
                    let (dx, dy) = ((q[0] / 127.5 - 1.0) * f.normal_strength, (q[1] / 127.5 - 1.0) * f.normal_strength);
                    let dz = (1.0 - dx * dx - dy * dy).max(0.0).sqrt();
                    let sign = if nn[k] >= 0.0 { 1.0 } else { -1.0 };
                    let (pn, pt): (V3, V3) = match k { 0 => ([sign, 0.0, 0.0], [0.0, 0.0, 1.0]), 1 => ([0.0, sign, 0.0], [1.0, 0.0, 0.0]), _ => ([0.0, 0.0, sign], [1.0, 0.0, 0.0]) };
                    let pb = cross(pn, pt);
                    for c in 0..3 { wn[c] += (pt[c] * dx + pb[c] * dy + pn[c] * dz) * wt; }
                }
                let wn = norm(wn);
                let d = norm([dot(wn, tv), dot(wn, bv), dot(wn, nn)]);
                [(d[0] * 0.5 + 0.5) * 255.0, (d[1] * 0.5 + 0.5) * 255.0, (d[2] * 0.5 + 0.5) * 255.0]
            }
            _ => [128.0, 128.0, 255.0],
        };
        out.normal = Some((n3, 1.0));
    }
    out
}

/// A decal's projector frame (`bakeDecal`): right / up turned by the rotation, size and depth.
pub struct DecalFrame { c: V3, n: V3, u: V3, v: V3, w: f32, h: f32, depth: f32, tint: [f32; 3], rough: f32, metal: f32 }

impl DecalFrame {
    pub fn new(d: &Decal, span: f32) -> DecalFrame {
        let n = norm(d.normal);
        let vd = dot(d.up, n);
        let mut v = [d.up[0] - n[0] * vd, d.up[1] - n[1] * vd, d.up[2] - n[2] * vd];
        if dot(v, v).sqrt() < 1e-6 { v = [1.0, 0.0, 0.0]; }
        let v = norm(v);
        let u = norm(cross(v, n));
        let rad = d.rotation.to_radians();
        let (co, si) = (rad.cos(), rad.sin());
        let ur = [0, 1, 2].map(|k| u[k] * co + v[k] * si);
        let vr = [0, 1, 2].map(|k| -u[k] * si + v[k] * co);
        let w = d.width.max(1e-5);
        DecalFrame { c: d.center, n, u: ur, v: vr, w, h: w / d.aspect.max(1e-4), depth: (w * 0.55).max(span * 0.012), tint: hex(&d.tint), rough: d.roughness * 255.0, metal: d.metallic * 255.0 }
    }

    /// The ink at point p on triangle t, front-facing and inside the projector only.
    pub fn at(&self, img: &Map, mesh: &Mesh, t: usize, p: V3, channels: &[String]) -> Texel {
        let mut out = Texel::default();
        if dot(mesh.nrm[t], self.n) < 0.12 { return out; }
        let d = sub(p, self.c);
        if dot(d, self.n).abs() > self.depth { return out; }
        let (u, v) = (dot(d, self.u) / self.w + 0.5, dot(d, self.v) / self.h + 0.5);
        if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) { return out; }
        let q = sample_decal(img, u, v);
        let a = q[3] / 255.0;
        if a <= 0.0 { return out; }
        let has = |c: &str| channels.iter().any(|x| x == c);
        if !has("color") { return out; }
        out.color = Some(([0, 1, 2].map(|c| (q[c] * self.tint[c] / 255.0).min(255.0)), a));
        if has("rough") { out.rough = Some((self.rough, a)); }
        if has("metal") { out.metal = Some((self.metal, a)); }
        out
    }
}

/// Value noise in 3D, 0..1, three octaves (paint.ts `noise`, f64 like JavaScript so the grunge matches).
fn hash(x: f64, y: f64, z: f64) -> f64 { let h = (x * 127.1 + y * 311.7 + z * 74.7).sin() * 43758.5453; h - h.floor() }
fn noise(x: f64, y: f64, z: f64) -> f64 {
    let (mut sum, mut amp, mut f) = (0.0, 0.5, 1.0);
    for _ in 0..3 {
        let (xx, yy, zz) = (x * f, y * f, z * f);
        let (ix, iy, iz) = (xx.floor(), yy.floor(), zz.floor());
        let (fx, fy, fz) = (xx - ix, yy - iy, zz - iz);
        let (sx, sy, sz) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy), fz * fz * (3.0 - 2.0 * fz));
        let lerp = |a: f64, b: f64, t: f64| a + (b - a) * t;
        let plane = |k: f64| lerp(lerp(hash(ix, iy, k), hash(ix + 1.0, iy, k), sx), lerp(hash(ix, iy + 1.0, k), hash(ix + 1.0, iy + 1.0, k), sx), sy);
        sum += amp * lerp(plane(iz), plane(iz + 1.0), sz);
        amp /= 2.0;
        f *= 2.0;
    }
    sum / 0.875
}

/// What a generator covers, 0..1 (`genAt`), from the texel's AO, convex and concave edge distances and point.
pub fn gen_at(g: &Gen, ao: f32, convex: f32, concave: f32, p: V3, span: f32) -> f32 {
    let band = |d: f32| (1.0 - d / (g.width * span)).max(0.0);
    let v = match g.kind.as_str() { "edge" => band(convex), "dirt" => (1.0 - ao).max(0.8 * band(concave)), _ => 1.0 - ao };
    let k = 1.0 / (g.scale as f64 * span as f64);
    let nz = if g.grunge != 0.0 { noise(p[0] as f64 * k, p[1] as f64 * k, p[2] as f64 * k) as f32 } else { 0.5 };
    let broken = v * (1.0 + g.grunge * (2.0 * nz - 1.0) * 1.5);
    ((broken - (1.0 - g.amount)) / g.soft.max(0.02) + 0.5).clamp(0.0, 1.0)
}
