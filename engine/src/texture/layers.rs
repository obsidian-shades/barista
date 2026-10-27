//! Per texel: which triangle owns it (rasterised in UV as `src/paint.ts` `raster` does, borders and all), its point
//! on the surface, and what each kind of layer puts there: a fill's material (tri-planar or UV), a decal's ink, a
//! generator's mask, or the working-resolution pixels upsampled.
use super::bake::{at, cross, dot, norm, sub, V3};
use super::{Bevel, Decal, Fill, Gen, Shape};
use rayon::prelude::*;
use std::collections::HashMap;

pub const NONE: u32 = u32::MAX;

/// A part as the paint sees it: corner positions and UVs, per triangle its face normal and UV tangent frame, and per
/// corner how far a texel may sit outside the triangle (`bordersOf` in paint.ts).
pub struct Mesh<'a> {
    pub pos: &'a [f32],
    pub uv: &'a [f32],
    pub nrm: Vec<V3>,
    pub tan: Vec<(V3, V3)>,
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
            // No surface texel round (u, v): a sliver thinner than a working texel, or a texel this size owns past a
            // seam (half an export texel is several working texels below the working size). The raw texel there is
            // off the surface, unpainted, and came out as a bare line along the island; take the nearest surface texel.
            let (cx, cy) = ((u * n as f32).clamp(0.0, n as f32 - 1.0) as isize, (v * n as f32).clamp(0.0, n as f32 - 1.0) as isize);
            let mut i = cy as usize * n + cx as usize;
            'ring: for r in 1..=8isize {
                for dy in -r..=r {
                    for dx in -r..=r {
                        if dx.abs() != r && dy.abs() != r { continue; }
                        let (xi, yi) = (cx + dx, cy + dy);
                        if xi < 0 || yi < 0 || xi >= n as isize || yi >= n as isize || self.on[yi as usize * n + xi as usize] == NONE { continue; }
                        i = yi as usize * n + xi as usize;
                        break 'ring;
                    }
                }
            }
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
    // a solid fill (`SOLID` in paint.ts) has no maps: its colour is the tint itself; a material missing its colour map is unpainted grey
    // no colour map (a solid fill, a colorless finish such as Cerakote): the tint is the colour, on white (paint.ts)
    let plain = 255.0;
    let mut out = Texel::default();
    if f.projection == "uv" {
        let rad = f.rotation.to_radians();
        let (co, si) = (rad.cos(), rad.sin());
        let u = ((x as f32 + 0.5) / n as f32 - 0.5) * f.tiling;
        let v = ((y as f32 + 0.5) / n as f32 - 0.5) * f.tiling;
        let (su, sv) = (u * co - v * si + 0.5 + f.offset[0], u * si + v * co + 0.5 + f.offset[1]);
        if has("color") { out.color = Some((m.basecolor.as_ref().map(|c| tinted(sample_map(c, su, sv))).unwrap_or_else(|| tinted([plain; 4])), 1.0)); }
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
            None => tinted([plain; 4]),
        };
        out.color = Some((c, 1.0));
    }
    if has("rough") { out.rough = Some((blend(&rough_v), 1.0)); }
    if has("metal") { out.metal = Some((blend(&metal_v), 1.0)); }
    if has("height") { out.height = Some((blend(&height_v), 1.0)); }
    if has("normal") {
        let n3 = match &m.normal {
            Some(nm) if w[0] + w[1] + w[2] > 0.0 => {
                // the face's normal plus each plane's detail along its tangent / bitangent (UDN, as paint.ts): a flat
                // map keeps the face, so the mesh's own smooth / weighted shading survives the fill
                let mut wn = nn;
                for k in 0..3 {
                    let wt = w[k] / ws;
                    if wt <= 0.0 { continue; }
                    let q = sample_map(nm, uvs[k].0, uvs[k].1);
                    let (dx, dy) = ((q[0] / 127.5 - 1.0) * f.normal_strength, (q[1] / 127.5 - 1.0) * f.normal_strength);
                    let sign = if nn[k] >= 0.0 { 1.0 } else { -1.0 };
                    let (pn, pt): (V3, V3) = match k { 0 => ([sign, 0.0, 0.0], [0.0, 0.0, 1.0]), 1 => ([0.0, sign, 0.0], [1.0, 0.0, 0.0]), _ => ([0.0, 0.0, sign], [1.0, 0.0, 0.0]) };
                    let pb = cross(pn, pt);
                    for c in 0..3 { wn[c] += (pt[c] * dx + pb[c] * dy) * wt; }
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
pub struct DecalFrame { c: V3, n: V3, u: V3, v: V3, w: f32, h: f32, depth: f32, tint: [f32; 3], rough: f32, metal: f32, flip: (bool, bool), engrave: f32 }

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
        DecalFrame { c: d.center, n, u: ur, v: vr, w, h: w / d.aspect.max(1e-4), depth: (w * 0.55).max(span * 0.012), tint: hex(&d.tint), rough: d.roughness * 255.0, metal: d.metallic * 255.0, flip: (d.flip_h, d.flip_v), engrave: d.engrave.max(0.0) }
    }

    /// The ink at point p on triangle t, front-facing and inside the projector only.
    pub fn at(&self, img: &Map, mesh: &Mesh, t: usize, p: V3, channels: &[String]) -> Texel {
        let mut out = Texel::default();
        if dot(mesh.nrm[t], self.n) < 0.12 { return out; }
        let d = sub(p, self.c);
        if dot(d, self.n).abs() > self.depth { return out; }
        let (u, v) = (dot(d, self.u) / self.w + 0.5, dot(d, self.v) / self.h + 0.5);
        if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) { return out; }
        let fu = |u: f32| if self.flip.0 { 1.0 - u } else { u };
        let fv = |v: f32| if self.flip.1 { 1.0 - v } else { v };
        let q = sample_decal(img, fu(u), fv(v));
        let a = q[3] / 255.0;
        let has = |c: &str| channels.iter().any(|x| x == c);
        if !has("color") { return out; }
        // engraving (paint.ts bakeDecal): the ink's gradient tilts the normal in the triangle's tangent frame
        if self.engrave > 0.0 && has("normal") {
            let ink = |u: f32, v: f32| sample_decal(img, fu(u), fv(v))[3] / 255.0;
            let (hu, hv) = (1.5 / img.w as f32, 1.5 / img.h as f32);
            let (gu, gv) = (ink(u + hu, v) - ink(u - hu, v), ink(u, v + hv) - ink(u, v - hv));
            if gu.abs() + gv.abs() > 1e-3 {
                let s = self.engrave * 3.0;
                let wv = [0, 1, 2].map(|k| (gu * self.u[k] + gv * self.v[k]) * s);
                let (tv, bv) = mesh.tan[t];
                let (gx, gy) = (dot(wv, tv), dot(wv, bv));
                let l2 = (gx * gx + gy * gy).min(0.95);
                let k = if gx * gx + gy * gy > 0.0 { (l2 / (gx * gx + gy * gy)).sqrt() } else { 0.0 };
                let (ex, ey) = (gx * k, gy * k);
                let ez = (1.0 - ex * ex - ey * ey).max(0.0).sqrt();
                out.normal = Some(([(ex * 0.5 + 0.5) * 255.0, (ey * 0.5 + 0.5) * 255.0, (ez * 0.5 + 0.5) * 255.0], 1.0));
            }
        }
        if a <= 0.0 { return out; }
        out.color = Some(([0, 1, 2].map(|c| (q[c] * self.tint[c] / 255.0).min(255.0)), a));
        if has("rough") { out.rough = Some((self.rough, a)); }
        if has("metal") { out.metal = Some((self.metal, a)); }
        if self.engrave > 0.0 && has("height") { out.height = Some((128.0 - 64.0 * self.engrave, a)); }
        out
    }
}

/// A grip texture as one layer draws it (paint.ts `bakeShape`): the projector, the outline's rounded polygon and, when
/// wrapped, the surface's own coordinates per corner (`exp_map`), all worked out once per part.
pub struct ShapeSrc<'a> { fr: DecalFrame, sh: &'a Shape, poly: Option<Vec<f64>>, map: Option<Vec<f64>>, ch: &'a [String] }

impl<'a> ShapeSrc<'a> {
    pub fn new(d: &'a Decal, sh: &'a Shape, span: f32, mesh: &Mesh) -> ShapeSrc<'a> {
        let fr = DecalFrame::new(d, span);
        let (hw, hh) = (fr.w as f64 / 2.0, fr.h as f64 / 2.0);
        let poly = sh.outline.as_ref().map(|o| filleted(o, hw, hh, sh.corner as f64));
        let map = d.wrap.then(|| {
            let f = |v: V3| [v[0] as f64, v[1] as f64, v[2] as f64];
            exp_map(mesh.pos, f(fr.c), f(fr.n), f(fr.u), f(fr.v), reach_of(sh, hw, hh) + sh.cell as f64)
        });
        ShapeSrc { fr, sh, poly, map, ch: &d.channels }
    }

    /// The relief at p on triangle t: height, and its slope as a tangent-space normal.
    pub fn at(&self, mesh: &Mesh, t: usize, p: V3) -> Texel {
        let mut out = Texel::default();
        let fr = &self.fr;
        let (fu, fv) = (if fr.flip.0 { -1.0 } else { 1.0 }, if fr.flip.1 { -1.0 } else { 1.0 });
        let (hw, hh) = (fr.w as f64 / 2.0, fr.h as f64 / 2.0);
        let d = sub(p, fr.c);
        // where on the panel, and the panel's axes there
        let (a, b, ua, va) = if let Some(m) = &self.map {
            let c = |k: usize| (m[t * 6 + k * 2], m[t * 6 + k * 2 + 1]);
            let ((u0, v0), (u1, v1), (u2, v2)) = (c(0), c(1), c(2));
            if u0.is_nan() || u1.is_nan() || u2.is_nan() { return out; }
            let pos = mesh.pos;
            let q = |k: usize| [0, 1, 2].map(|j| pos[t * 9 + k * 3 + j] as f64);
            let (q0, q1, q2) = (q(0), q(1), q(2));
            let e1 = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
            let e2 = [q2[0] - q0[0], q2[1] - q0[1], q2[2] - q0[2]];
            let (du1, dv1, du2, dv2) = (u1 - u0, v1 - v0, u2 - u0, v2 - v0);
            let det = du1 * dv2 - du2 * dv1;
            if det.abs() < 1e-14 { return out; }
            let unit = |x: [f64; 3]| { let l = (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]).sqrt().max(1e-300); [x[0] / l, x[1] / l, x[2] / l] };
            let ua = unit([0, 1, 2].map(|j| (e1[j] * dv2 - e2[j] * dv1) / det));
            let va = unit([0, 1, 2].map(|j| (e2[j] * du1 - e1[j] * du2) / det));
            // barycentric weights of p (as paint.ts: against the unit face normal and the doubled area)
            let f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            let fl = (f[0] * f[0] + f[1] * f[1] + f[2] * f[2]).sqrt().max(1e-300);
            let fnn = [f[0] / fl, f[1] / fl, f[2] / fl];
            let pp = [p[0] as f64 - q0[0], p[1] as f64 - q0[1], p[2] as f64 - q0[2]];
            let w1 = ((pp[1] * e2[2] - pp[2] * e2[1]) * fnn[0] + (pp[2] * e2[0] - pp[0] * e2[2]) * fnn[1] + (pp[0] * e2[1] - pp[1] * e2[0]) * fnn[2]) / fl;
            let w2 = ((e1[1] * pp[2] - e1[2] * pp[1]) * fnn[0] + (e1[2] * pp[0] - e1[0] * pp[2]) * fnn[1] + (e1[0] * pp[1] - e1[1] * pp[0]) * fnn[2]) / fl;
            let w0 = 1.0 - w1 - w2;
            ((w0 * u0 + w1 * u1 + w2 * u2) * fu, (w0 * v0 + w1 * v1 + w2 * v2) * fv, ua.map(|x| x as f32), va.map(|x| x as f32))
        } else {
            if dot(mesh.nrm[t], fr.n) < 0.12 || dot(d, fr.n).abs() > fr.depth { return out; }
            (dot(d, fr.u) as f64 * fu, dot(d, fr.v) as f64 * fv, fr.u, fr.v)
        };
        let sh = self.sh;
        let at = |a: f64, b: f64| relief(sh, self.poly.as_deref(), a, b, hw, hh);
        let Some(h) = at(a, b) else { return out };
        let has = |c: &str| self.ch.iter().any(|x| x == c);
        if has("normal") {
            let e = (sh.cell.min(if sh.border > 0.0 { sh.border } else { sh.cell }) * 0.1) as f64;
            let z = |a: f64, b: f64| at(a, b).unwrap_or(0.0);
            let (su, sv) = ((z(a + e, b) - z(a - e, b)) / (2.0 * e) * fu, (z(a, b + e) - z(a, b - e)) / (2.0 * e) * fv);
            let w = [0, 1, 2].map(|k| (su * ua[k] as f64 + sv * va[k] as f64) as f32);
            let (tv, bv) = mesh.tan[t];
            let (gx, gy) = (dot(w, tv), dot(w, bv));
            let k = 1.0 / (gx * gx + gy * gy + 1.0).sqrt();
            out.normal = Some(([(-gx * k * 0.5 + 0.5) * 255.0, (-gy * k * 0.5 + 0.5) * 255.0, (k * 0.5 + 0.5) * 255.0], 1.0));
        }
        if has("height") { out.height = Some((128.0 + 127.0 * (h / sh.depth.max(sh.amount).max(1e-9) as f64).clamp(-1.0, 1.0) as f32, 1.0)); }
        out
    }
}

/// A whole-part bevel in the normal map (paint.ts `bevelEdges` / `bevelNormal` / `bakeBevel`, the same steps): the
/// edges sharper than `angle` with both faces' normals, in a grid of `radius` cells; per texel the normal leaned toward
/// the far face of every edge within reach, by a fillet's angle (round) or the halfway turn (chamfer).
pub struct BevelSrc { segs: Vec<[f32; 12]>, grid: HashMap<(i32, i32, i32), Vec<u32>>, r: f32, round: bool }

impl BevelSrc {
    pub fn new(b: &Bevel, pos: &[f32]) -> BevelSrc {
        let tris = pos.len() / 9;
        let fnrm: Vec<V3> = (0..tris).map(|t| norm(cross(sub(at(pos, t * 3 + 1), at(pos, t * 3)), sub(at(pos, t * 3 + 2), at(pos, t * 3))))).collect();
        let fc: Vec<V3> = (0..tris).map(|t| { let (a, b, c) = (at(pos, t * 3), at(pos, t * 3 + 1), at(pos, t * 3 + 2)); [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0] }).collect();
        let next = |c: usize| c - c % 3 + (c + 1) % 3;
        let key = |c: usize| (pos[c * 3].to_bits(), pos[c * 3 + 1].to_bits(), pos[c * 3 + 2].to_bits());
        // corners per welded edge, in corner order (the editor's Map keeps insertion order: the same first corner)
        let mut order: Vec<_> = Vec::new();
        let mut on: HashMap<_, Vec<usize>> = HashMap::new();
        for c in 0..tris * 3 {
            let (ka, kb) = (key(c), key(next(c)));
            let k = if ka < kb { (ka, kb) } else { (kb, ka) };
            on.entry(k).or_insert_with(|| { order.push(k); vec![] }).push(c);
        }
        let (r, cos) = (b.radius.max(1e-9), b.angle.to_radians().cos());
        let cell = |p: V3| ((p[0] / r).floor() as i32, (p[1] / r).floor() as i32, (p[2] / r).floor() as i32);
        let (mut segs, mut grid) = (Vec::new(), HashMap::<(i32, i32, i32), Vec<u32>>::new());
        for k in &order {
            let cs = &on[k];
            if cs.len() != 2 { continue; }
            let (c, ta, tb) = (cs[0], cs[0] / 3, cs[1] / 3);
            if dot(fnrm[ta], fnrm[tb]) > cos { continue; }
            // concave when b's centre lies in front of a's plane
            let (a, e) = (at(pos, c), at(pos, next(c)));
            if dot(sub(fc[tb], a), fnrm[ta]) > 0.0 && !b.concave { continue; }
            let id = segs.len() as u32;
            let (na, nb) = (fnrm[ta], fnrm[tb]);
            segs.push([a[0], a[1], a[2], e[0], e[1], e[2], na[0], na[1], na[2], nb[0], nb[1], nb[2]]);
            let steps = ((dot(sub(e, a), sub(e, a)).sqrt() / (r / 8.0)).ceil() as usize).max(1);
            let mut seen = Vec::new();
            for s in 0..=steps {
                let f = s as f32 / steps as f32;
                let q = cell([a[0] + (e[0] - a[0]) * f, a[1] + (e[1] - a[1]) * f, a[2] + (e[2] - a[2]) * f]);
                if seen.contains(&q) { continue; }
                seen.push(q);
                grid.entry(q).or_default().push(id);
            }
        }
        BevelSrc { segs, grid, r, round: b.profile != "chamfer" }
    }

    /// The bevelled normal at p on a face of normal f; None outside every edge's band.
    pub fn normal(&self, p: V3, f: V3) -> Option<V3> {
        let r = self.r;
        let (cx, cy, cz) = ((p[0] / r).floor() as i32, (p[1] / r).floor() as i32, (p[2] / r).floor() as i32);
        let (mut lean, mut any, mut seen) = ([0f32; 3], false, Vec::<u32>::new());
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(list) = self.grid.get(&(cx + dx, cy + dy, cz + dz)) else { continue };
                    for &id in list {
                        if seen.contains(&id) { continue; }
                        seen.push(id);
                        let s = &self.segs[id as usize];
                        let (ab, ap) = ([s[3] - s[0], s[4] - s[1], s[5] - s[2]], [p[0] - s[0], p[1] - s[1], p[2] - s[2]]);
                        let ee = dot(ab, ab);
                        let t = if ee > 1e-20 { (dot(ap, ab) / ee).clamp(0.0, 1.0) } else { 0.0 };
                        let q = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
                        let d = dot(q, q).sqrt();
                        if d >= r { continue; }
                        let (na, nb) = ([s[6], s[7], s[8]], [s[9], s[10], s[11]]);
                        let (sa, sb) = (dot(f, na), dot(f, nb));
                        let half = dot(na, nb).clamp(-1.0, 1.0).acos() / 2.0;
                        // a face of another edge (a box's top beside a side's corner)
                        if sa.max(sb) <= half.cos() { continue; }
                        let (o, so) = if sa >= sb { (nb, sb) } else { (na, sa) };
                        let u = [o[0] - f[0] * so, o[1] - f[1] * so, o[2] - f[2] * so];
                        let ul = dot(u, u).sqrt();
                        if ul < 1e-6 { continue; }
                        let phi = if self.round { half.min(((1.0 - d / r) * half.tan()).min(1.0).asin()) } else { half };
                        let w = phi.tan() / ul;
                        for k in 0..3 { lean[k] += u[k] * w; }
                        any = true;
                    }
                }
            }
        }
        any.then(|| norm([f[0] + lean[0], f[1] + lean[1], f[2] + lean[2]]))
    }

    /// The layer's texel: the bevelled normal in the triangle's tangent space, nothing where no edge leans it.
    pub fn at(&self, mesh: &Mesh, t: usize, p: V3) -> Texel {
        let mut out = Texel::default();
        let f = mesh.nrm[t];
        if let Some(w) = self.normal(p, f) {
            let (tv, bv) = mesh.tan[t];
            out.normal = Some(([(dot(w, tv) * 0.5 + 0.5) * 255.0, (dot(w, bv) * 0.5 + 0.5) * 255.0, (dot(w, f) * 0.5 + 0.5) * 255.0], 1.0));
        }
        out
    }
}

/// The outline scaled to the panel with every corner rounded by r (paint.ts `filleted`): flat x, y pairs.
fn filleted(pts: &[[f32; 2]], hw: f64, hh: f64, r: f64) -> Vec<f64> {
    let p: Vec<[f64; 2]> = pts.iter().map(|q| [q[0] as f64 * hw, q[1] as f64 * hh]).collect();
    let n = p.len();
    let mut out = vec![];
    for i in 0..n {
        let ([px, py], [ax, ay], [bx, by]) = (p[i], p[(i + n - 1) % n], p[(i + 1) % n]);
        let (la, lb) = ((ax - px).hypot(ay - py), (bx - px).hypot(by - py));
        if r <= 0.0 || la < 1e-12 || lb < 1e-12 { out.extend([px, py]); continue; }
        let (dax, day, dbx, dby) = ((ax - px) / la, (ay - py) / la, (bx - px) / lb, (by - py) / lb);
        let th = (dax * dbx + day * dby).clamp(-1.0, 1.0).acos();
        if th > std::f64::consts::PI - 1e-3 || th < 1e-3 { out.extend([px, py]); continue; }
        let tn = (th / 2.0).tan();
        let t = (r / tn).min(la.min(lb) * 0.5);
        let rr = t * tn;
        let (mx, my) = (dax + dbx, day + dby);
        let k = rr / (th / 2.0).sin() / mx.hypot(my);
        let (cx, cy) = (px + mx * k, py + my * k);
        let a0 = (py + day * t - cy).atan2(px + dax * t - cx);
        let a1 = (py + dby * t - cy).atan2(px + dbx * t - cx);
        let mut da = a1 - a0;
        if da > std::f64::consts::PI { da -= 2.0 * std::f64::consts::PI } else if da < -std::f64::consts::PI { da += 2.0 * std::f64::consts::PI }
        for j in 0..=6 { let a = a0 + da * j as f64 / 6.0; out.extend([cx + rr * a.cos(), cy + rr * a.sin()]); }
    }
    out
}
/// Signed distance to a closed polygon, negative inside (paint.ts `polySd`).
fn poly_sd(poly: &[f64], x: f64, y: f64) -> f64 {
    let (mut d, mut inside) = (f64::INFINITY, false);
    let n = poly.len();
    let mut j = n - 2;
    for i in (0..n).step_by(2) {
        let (ax, ay) = (poly[j], poly[j + 1]);
        let (ex, ey) = (poly[i] - ax, poly[i + 1] - ay);
        let l2 = ex * ex + ey * ey;
        let t = (((x - ax) * ex + (y - ay) * ey) / if l2 != 0.0 { l2 } else { 1.0 }).clamp(0.0, 1.0);
        d = d.min((x - ax - ex * t).hypot(y - ay - ey * t));
        if (ay > y) != (poly[i + 1] > y) && x < ax + (y - ay) * ex / ey { inside = !inside; }
        j = i;
    }
    if inside { -d } else { d }
}
/// How far a shape reaches from its centre: its outline's farthest corner (paint.ts `reachOf`).
fn reach_of(sh: &Shape, hw: f64, hh: f64) -> f64 {
    let rect = [[-1.0f32, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]];
    sh.outline.as_deref().unwrap_or(&rect).iter().map(|q| (q[0] as f64 * hw).hypot(q[1] as f64 * hh)).fold(0.0, f64::max)
}

type D3 = [f64; 3];
/// The least rotation taking unit a onto unit b, applied to x (paint.ts `turn`).
fn turn(a: D3, b: D3, x: D3) -> D3 {
    let k = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let co = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if co < -0.9999 { return x; }
    let kd = (k[0] * x[0] + k[1] * x[1] + k[2] * x[2]) / (1.0 + co);
    [x[0] * co + (k[1] * x[2] - k[2] * x[1]) + k[0] * kd, x[1] * co + (k[2] * x[0] - k[0] * x[2]) + k[1] * kd, x[2] * co + (k[0] * x[1] - k[1] * x[0]) + k[2] * kd]
}
/// The surface's own coordinates round a decal's centre (paint.ts `expMap`, a discrete exponential map): per soup
/// corner (u, v) along the frame's right / up, NaN where the walk stopped. Same weld, seed, order and steps.
pub fn exp_map(pos: &[f32], c: D3, nrm: D3, uax: D3, vax: D3, reach: f64) -> Vec<f64> {
    use std::cmp::Reverse;
    use std::collections::{BinaryHeap, HashMap};
    let corners = pos.len() / 3;
    let mut id = vec![0usize; corners];
    let mut key: HashMap<(i64, i64, i64), usize> = HashMap::new();
    let mut vp: Vec<D3> = vec![];
    let r5 = |x: f32| (x as f64 * 1e5 + 0.5).floor() as i64; // Math.round
    for k in 0..corners {
        let kk = (r5(pos[k * 3]), r5(pos[k * 3 + 1]), r5(pos[k * 3 + 2]));
        id[k] = *key.entry(kk).or_insert_with(|| { vp.push([pos[k * 3] as f64, pos[k * 3 + 1] as f64, pos[k * 3 + 2] as f64]); vp.len() - 1 });
    }
    let nv = vp.len();
    let mut vn = vec![[0.0f64; 3]; nv];
    let mut nb: Vec<Vec<usize>> = vec![vec![]; nv];
    for t in 0..corners / 3 {
        let (a, b, d) = (id[t * 3], id[t * 3 + 1], id[t * 3 + 2]);
        let (pa, pb, pd) = (vp[a], vp[b], vp[d]);
        let e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        let e2 = [pd[0] - pa[0], pd[1] - pa[1], pd[2] - pa[2]];
        let f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        for v in [a, b, d] { for k in 0..3 { vn[v][k] += f[k]; } }
        for (p, q) in [(a, b), (b, d), (d, a)] {
            if !nb[p].contains(&q) { nb[p].push(q); }
            if !nb[q].contains(&p) { nb[q].push(p); }
        }
    }
    for n in vn.iter_mut() { let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt(); let l = if l > 0.0 { l } else { 1.0 }; for x in n.iter_mut() { *x /= l; } }
    for l in nb.iter_mut() { l.sort_unstable(); }
    let dist3 = |a: D3, b: D3| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    let mut out = vec![f64::NAN; corners * 2];
    let (mut best, mut best_d) = (usize::MAX, f64::INFINITY);
    for t in 0..corners / 3 {
        let dd: f64 = (0..3).map(|k| dist3(vp[id[t * 3 + k]], c)).sum();
        if dd < best_d { best_d = dd; best = t; }
    }
    if best == usize::MAX { return out; }
    let mut uv = vec![[0.0f64; 2]; nv];
    let mut dist = vec![f64::INFINITY; nv];
    let mut done = vec![false; nv];
    let (mut fu, mut fv) = (vec![[0.0f64; 3]; nv], vec![[0.0f64; 3]; nv]);
    // (dist, vertex) min-heap; f64 bits order as the values do for non-negative distances
    let mut heap: BinaryHeap<Reverse<(u64, usize)>> = BinaryHeap::new();
    for k in 0..3 {
        let v = id[best * 3 + k];
        if dist[v] != f64::INFINITY { continue; }
        let d = [vp[v][0] - c[0], vp[v][1] - c[1], vp[v][2] - c[2]];
        uv[v] = [d[0] * uax[0] + d[1] * uax[1] + d[2] * uax[2], d[0] * vax[0] + d[1] * vax[1] + d[2] * vax[2]];
        dist[v] = uv[v][0].hypot(uv[v][1]);
        fu[v] = turn(nrm, vn[v], uax);
        fv[v] = turn(nrm, vn[v], vax);
        heap.push(Reverse((dist[v].to_bits(), v)));
    }
    while let Some(Reverse((_, p))) = heap.pop() {
        if done[p] { continue; }
        done[p] = true;
        if dist[p] > reach { continue; }
        let (pp, np) = (vp[p], vn[p]);
        for &q in &nb[p] {
            if done[q] { continue; }
            let e = [vp[q][0] - pp[0], vp[q][1] - pp[1], vp[q][2] - pp[2]];
            let len = (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]).sqrt();
            if dist[p] + len >= dist[q] { continue; }
            let en = e[0] * np[0] + e[1] * np[1] + e[2] * np[2];
            let s = [e[0] - np[0] * en, e[1] - np[1] * en, e[2] - np[2] * en];
            let sl = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
            let k = if sl > 1e-12 { len / sl } else { 0.0 };
            dist[q] = dist[p] + len;
            uv[q] = [uv[p][0] + (s[0] * fu[p][0] + s[1] * fu[p][1] + s[2] * fu[p][2]) * k, uv[p][1] + (s[0] * fv[p][0] + s[1] * fv[p][1] + s[2] * fv[p][2]) * k];
            fu[q] = turn(np, vn[q], fu[p]);
            fv[q] = turn(np, vn[q], fv[p]);
            heap.push(Reverse((dist[q].to_bits(), q)));
        }
    }
    for k in 0..corners { if done[id[k]] { out[k * 2] = uv[id[k]][0]; out[k * 2 + 1] = uv[id[k]][1]; } }
    out
}

/// A pattern's relief at (x, y) in cells (paint.ts `patternAt`, f64 like JavaScript so the stipple matches).
fn pattern_at(p: &str, x: f64, y: f64) -> f64 {
    match p {
        "grooves" => { let f = y - y.floor(); if f > 0.25 && f < 0.75 { -(std::f64::consts::PI * (f - 0.25) * 2.0).sin() } else { 0.0 } }
        "checker" => {
            let tri = |s: f64| 1.0 - 2.0 * (s - s.floor() - 0.5).abs();
            let r = std::f64::consts::FRAC_1_SQRT_2;
            tri((x + y) * r).min(tri((x - y) * r))
        }
        "stipple" => {
            let (i, j) = (x.floor(), y.floor());
            let mut v: f64 = 0.0;
            for a in [i - 1.0, i, i + 1.0] {
                for b in [j - 1.0, j, j + 1.0] {
                    let (dx, dy, r) = (x - (a + 0.2 + 0.6 * hash(a, b, 1.0)), y - (b + 0.2 + 0.6 * hash(a, b, 2.0)), 0.38 + 0.2 * hash(a, b, 3.0));
                    let q = 1.0 - (dx * dx + dy * dy) / (r * r);
                    if q > 0.0 { v = v.max(q * q); }
                }
            }
            v
        }
        _ => 0.0,
    }
}
/// The relief at (x, y) world units from a shape's centre, None outside its outline (paint.ts `shapeHeight`).
pub fn shape_height(sh: &Shape, x: f32, y: f32, hw: f32, hh: f32) -> Option<f32> {
    let (hw, hh) = (hw as f64, hh as f64);
    let poly = sh.outline.as_ref().map(|o| filleted(o, hw, hh, sh.corner as f64));
    relief(sh, poly.as_deref(), x as f64, y as f64, hw, hh).map(|h| h as f32)
}
/// `shape_height` with the outline's rounded polygon already made (once per layer, not per texel).
fn relief(sh: &Shape, poly: Option<&[f64]>, x: f64, y: f64, hw: f64, hh: f64) -> Option<f64> {
    let (corner, g, cell) = (sh.corner as f64, sh.border as f64, sh.cell as f64);
    let sd = match poly {
        Some(p) => poly_sd(p, x, y),
        None => {
            let r = corner.min(hw).min(hh);
            let (qx, qy) = (x.abs() - hw + r, y.abs() - hh + r);
            qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r
        }
    };
    if sd > 0.0 { return None; }
    let mut h = if g > 0.0 && sd > -g { -(sh.depth as f64) * (std::f64::consts::PI * (sd + g) / g).sin() } else { 0.0 };
    let t = (-(if g > 0.0 { g * 1.6 } else { 0.0 }) - sd) / (cell * 0.5);
    let fade = if t <= 0.0 { 0.0 } else if t >= 1.0 { 1.0 } else { t * t * (3.0 - 2.0 * t) };
    if fade > 0.0 && sh.pattern != "none" { h += sh.amount as f64 * fade * pattern_at(&sh.pattern, x / cell, y / cell); }
    Some(h)
}

/// Value noise in 3D, 0..1, three octaves (paint.ts `noise`, f64 like JavaScript so the grunge matches).
/// An integer hash of lattice point (x, y, z): the editor's `hashu` (paint.ts) and its shader's (gpubake.ts), bit for bit.
pub fn hashu(x: i32, y: i32, z: i32) -> u32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd816_3841) ^ (z as u32).wrapping_mul(0xcb1a_b31f);
    h ^= h >> 16; h = h.wrapping_mul(0x7feb_352d); h ^= h >> 15; h = h.wrapping_mul(0x846c_a68b); h ^= h >> 16;
    h
}
/// The generators' lattice hash (the editor bakes their noise on the GPU too, so it is the integer one).
fn lattice_hash(x: f64, y: f64, z: f64) -> f64 { hashu(x as i32, y as i32, z as i32) as f64 / 4294967296.0 }
/// The grip stipple's jitter, as the editor's `hash` (CPU only, kept so placed grips keep their dots).
fn hash(x: f64, y: f64, z: f64) -> f64 { let h = (x * 127.1 + y * 311.7 + z * 74.7).sin() * 43758.5453; h - h.floor() }
fn noise(x: f64, y: f64, z: f64) -> f64 {
    let (mut sum, mut amp, mut f) = (0.0, 0.5, 1.0);
    for _ in 0..3 {
        let (xx, yy, zz) = (x * f, y * f, z * f);
        let (ix, iy, iz) = (xx.floor(), yy.floor(), zz.floor());
        let (fx, fy, fz) = (xx - ix, yy - iy, zz - iz);
        let (sx, sy, sz) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy), fz * fz * (3.0 - 2.0 * fz));
        let lerp = |a: f64, b: f64, t: f64| a + (b - a) * t;
        let plane = |k: f64| lerp(lerp(lattice_hash(ix, iy, k), lattice_hash(ix + 1.0, iy, k), sx), lerp(lattice_hash(ix, iy + 1.0, k), lattice_hash(ix + 1.0, iy + 1.0, k), sx), sy);
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

#[cfg(test)]
mod hash_tests {
    #[test]
    fn hashu_matches_the_editor() {
        // paint.check.ts pins the same values (and gpubake.ts's shader computes them): one grunge pattern everywhere
        assert_eq!([super::hashu(1, 2, 3), super::hashu(-5, 7, -9), super::hashu(0, 0, 0)], [72785788, 2634903715, 0]);
    }
}
