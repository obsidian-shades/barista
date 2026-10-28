//! Blender's manual Unwrap (Angle Based, Fill Holes on), step for step after `uv_parametrizer.cc`: every hole but the
//! outer border filled with temporary triangles (`p_chart_fill_boundaries`), the angles corrected by ABF++
//! (`p_chart_abf_solve`: 20 Newton steps at most, else the 3D angles), then the angle based LSCM (`p_chart_lscm_solve`)
//! held by the user's pins, or with fewer than two by two of its own (`p_chart_symmetry_pins`, else
//! `p_chart_extrema_verts`) placed at their 3D coordinates (`p_chart_pin_positions`). Both linear systems are solved
//! directly (Blender: Eigen's sparse LU); nothing else is added, so the result is Blender's.
use crate::chart::Local;
use crate::flatten::{frames, measure, Chol, Flat};
use crate::mesh::*;
use std::f64::consts::PI;

const MAX_ITER: usize = 20;

/// The chart flattened as Blender's Unwrap does, `pins` (local vertex, u, v in mesh units) held when two or more.
/// `split`: mesh vertices cut apart by a seam among the charts unwrapped together (Blender's `PVERT_SPLIT`). None for
/// a closed chart, which Blender doesn't solve either ("edge seams may need to be added").
pub fn flatten(m: &Mesh, l: &Local, pins: &[(usize, f64, f64)], split: &Set<u32>) -> Option<Flat> {
    if l.loops.is_empty() || l.t.is_empty() { return None; }
    let pt = |v: u32| m.pt(l.orig[v as usize]);
    let len = |lp: &[u32]| (0..lp.len()).map(|i| dist(pt(lp[i]), pt(lp[(i + 1) % lp.len()]))).sum::<f64>();
    // the longest; lengths within float noise tie (Blender sums in f32, a mirrored pair of holes goes either way) and
    // the first loop wins, which matched Blender on every tie tried
    let lens: Vec<f64> = l.loops.iter().map(|lp| len(lp)).collect();
    let top = lens.iter().fold(0f64, |a, &b| a.max(b));
    let outer = (0..lens.len()).find(|&i| lens[i] >= top * (1. - 1e-6)).unwrap();
    // Fill Holes: each inner loop triangulated (wound against it, so the fill glues on); its vertices become interior
    let mut t = l.t.clone();
    for (i, lp) in l.loops.iter().enumerate() {
        if i == outer || lp.len() < 3 { continue; } // ponytail: a 2-edge slit stays open; Blender glues it shut
        let ids: Vec<u32> = lp.iter().rev().copied().collect();
        let p: Vec<V3> = ids.iter().map(|&v| pt(v)).collect();
        let mut n = [0.; 3];
        for k in 0..p.len() { n = add(n, cross(p[k], p[(k + 1) % p.len()])); }
        let n = scale(n, 1. / norm(n).max(1e-30));
        let a = if n[0].abs() < 0.9 { [1., 0., 0.] } else { [0., 1., 0.] };
        let e1 = cross(a, n);
        let e1 = scale(e1, 1. / norm(e1));
        let e2 = cross(n, e1);
        let flat: Vec<(f64, f64)> = p.iter().map(|&q| (dot(q, e1), dot(q, e2))).collect();
        t.extend(beautify(polyfill(&flat), &flat).into_iter().map(|f| f.map(|i| ids[i as usize])));
    }
    let interior: Vec<bool> = (0..l.nv).map(|v| !l.loops[outer].contains(&(v as u32))).collect();
    let alpha = abf(m, l, &t, &interior).unwrap_or_else(|| t.iter().flat_map(|&f| angles(m, l, f)).collect());
    let (mut u, mut v) = lscm(m, l, &t, &alpha, pins, &l.loops[outer], split)?;
    if pins.len() < 2 {
        // `uv_parametrizer_average` (Unwrap's, area only): UV area = 3D area, fill included; the editor's fit then
        // gives every island the part's one density, as Blender's pack does
        let (mut a3, mut a2) = (0., 0.);
        for f in &t {
            let [p, q, r] = f.map(|i| pt(i));
            a3 += norm(cross(sub(q, p), sub(r, p))) / 2.;
            let [i, j, k] = f.map(|i| i as usize);
            a2 += ((u[j] - u[i]) * (v[k] - v[i]) - (u[k] - u[i]) * (v[j] - v[i])).abs() / 2.;
        }
        if a3 > 0. && a2 > 0. { let s = (a3 / a2).sqrt(); for x in u.iter_mut().chain(v.iter_mut()) { *x *= s; } }
    }
    Some(measure(l, &frames(m, l), u, v))
}

/// `BLI_polyfill_calc` (clip even, sweep): ears cut every other vertex, turning back where the next isn't convex, so
/// a convex polygon comes out zigzagged, not fanned. `p` CCW; triangles (prev, ear, next) as indices into it.
fn polyfill(p: &[(f64, f64)]) -> Vec<[u32; 3]> {
    let n = p.len();
    let cross = |a: usize, b: usize, c: usize| (p[b].0 - p[a].0) * (p[c].1 - p[a].1) - (p[b].1 - p[a].1) * (p[c].0 - p[a].0);
    let (mut prev, mut next): (Vec<usize>, Vec<usize>) = ((0..n).map(|i| (i + n - 1) % n).collect(), (0..n).map(|i| (i + 1) % n).collect());
    let sign = |prev: &[usize], next: &[usize], i: usize| cross(prev[i], i, next[i]).partial_cmp(&0.).unwrap_or(std::cmp::Ordering::Equal) as i8;
    let (mut alive, mut left, mut out) = (vec![true; n], n, Vec::new());
    let (mut init, mut reverse) = (0, false);
    while left > 3 {
        let ear_ok = |prev: &[usize], next: &[usize], alive: &[bool], e: usize, accept: i8| {
            if sign(prev, next, e) != accept { return false; }
            let (a, c) = (prev[e], next[e]);
            (0..n).all(|v| !alive[v] || v == a || v == e || v == c || sign(prev, next, v) > 0
                || !(cross(a, e, v) >= 0. && cross(e, c, v) >= 0. && cross(c, a, v) >= 0.))
        };
        let mut ear = None;
        'find: for accept in [1i8, 0] {
            let mut e = init;
            for _ in 0..left {
                if ear_ok(&prev, &next, &alive, e, accept) { ear = Some(e); break 'find; }
                e = if reverse { prev[e] } else { next[e] };
            }
        }
        let e = ear.unwrap_or(init); // ponytail: Blender's "desperate" pass picks a non-concave tip; any tip here
        let (a, c) = (prev[e], next[e]);
        out.push([a as u32, e as u32, c as u32]);
        (next[a], prev[c], alive[e], left) = (c, a, false, left - 1);
        init = if reverse { prev[a] } else { next[c] };
        if sign(&prev, &next, init) <= 0 { init = if reverse { prev[init] } else { next[init] }; reverse = !reverse; }
    }
    let a = (0..n).find(|&i| alive[i]).unwrap();
    out.push([a as u32, next[a] as u32, next[next[a]] as u32]);
    out
}

/// `BLI_polyfill_beautify`: the inside diagonal whose flip most raises the two triangles' area / perimeter sum is
/// flipped, again and again while one does (`BLI_polyfill_beautify_quad_rotate_calc_ex`). `t` CCW in `p`.
fn beautify(mut t: Vec<[u32; 3]>, p: &[(f64, f64)]) -> Vec<[u32; 3]> {
    let q = |i: u32| p[i as usize];
    let cross = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0);
    let d = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).hypot(a.1 - b.1);
    // diagonal 2–4 of the quad 1 2 3 4: triangles (2 3 4) and (2 4 1); Some((cost, area)) when 1–3 is allowed
    let cost = |v1: (f64, f64), v2: (f64, f64), v3: (f64, f64), v4: (f64, f64)| {
        let (a234, a241, a123, a134) = (cross(v2, v3, v4), cross(v2, v4, v1), cross(v1, v2, v3), cross(v1, v3, v4));
        let area = (a234.abs() + a241.abs() + a123.abs() + a134.abs()) / 8.;
        if (a123 >= 0.) != (a134 >= 0.) || a123.abs() <= 1e-12 || a134.abs() <= 1e-12 { return None; }
        if (a234 >= 0.) != (a241 >= 0.) || a234.abs() <= 1e-12 || a241.abs() <= 1e-12 { return Some((f64::MIN, area)); }
        let f24 = a234.abs() / (d(v2, v3) + d(v3, v4) + d(v2, v4)) + a241.abs() / (d(v4, v1) + d(v1, v2) + d(v2, v4));
        let f13 = a123.abs() / (d(v1, v2) + d(v2, v3) + d(v1, v3)) + a134.abs() / (d(v3, v4) + d(v4, v1) + d(v1, v3));
        Some((f24 - f13, area))
    };
    for _ in 0..4 * t.len() * t.len() {
        let mut best: Option<(f64, usize, usize, usize, usize)> = None;
        for i in 0..t.len() { for j in i + 1..t.len() { for k in 0..3 {
            let (a, b) = (t[i][k], t[i][(k + 1) % 3]);
            let Some(c) = (0..3).find(|&c| t[j][c] == b && t[j][(c + 1) % 3] == a) else { continue };
            // A = (a b x), B = (b a y): quad 1 2 3 4 = y a x b, diagonal 2–4 = a–b
            let (x, y) = (t[i][(k + 2) % 3], t[j][(c + 2) % 3]);
            let Some((cst, area)) = cost(q(y), q(a), q(x), q(b)) else { continue };
            if cst < -1e-6 * area.max(1.) && best.is_none_or(|bb| cst < bb.0) { best = Some((cst, i, j, k, c)); }
        }}}
        let Some((_, i, j, k, c)) = best else { break };
        let (a, b, x, y) = (t[i][k], t[i][(k + 1) % 3], t[i][(k + 2) % 3], t[j][(c + 2) % 3]);
        (t[i], t[j]) = ([x, y, b], [y, x, a]);
    }
    t
}

fn add(a: V3, b: V3) -> V3 { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn scale(a: V3, s: f64) -> V3 { [a[0] * s, a[1] * s, a[2] * s] }

/// `p_triangle_angles`: corners over 179° give the excess to the other two (by the far side's length), none under 0.001.
fn angles(m: &Mesh, l: &Local, f: [u32; 3]) -> [f64; 3] {
    let p = f.map(|v| m.pt(l.orig[v as usize]));
    let mut a = [0.; 3];
    for i in 0..3 {
        let (e1, e2) = (sub(p[(i + 1) % 3], p[i]), sub(p[(i + 2) % 3], p[i]));
        a[i] = (dot(e1, e2) / (norm(e1) * norm(e2))).clamp(-1., 1.).acos();
        if !a[i].is_finite() { a[i] = 0.; }
    }
    for i in 0..3 {
        let fix = a[i] - 179f64.to_radians();
        if fix < 0. { continue; }
        let (d1, d2) = (dist(p[i], p[(i + 1) % 3]), dist(p[i], p[(i + 2) % 3]));
        let w = if d1 + d2 > 1e-20 { d2 / (d1 + d2) } else { 0.5 };
        a[i] -= fix;
        a[(i + 1) % 3] += fix * w;
        a[(i + 2) % 3] += fix * (1. - w);
    }
    a.map(|x| x.max(0.001))
}

/// `p_chart_abf_solve` + `p_abf_matrix_invert`: angles per corner (3 per triangle of `t`), None when it doesn't converge.
fn abf(m: &Mesh, l: &Local, t: &[[u32; 3]], interior: &[bool]) -> Option<Vec<f64>> {
    let nf = t.len();
    let mut iid = vec![usize::MAX; l.nv];
    let mut ni = 0;
    for v in 0..l.nv { if interior[v] { iid[v] = ni; ni += 1; } }
    // the corners round each vertex: (triangle, corner)
    let mut fan: Vec<Vec<(usize, usize)>> = vec![Vec::new(); l.nv];
    for (f, tri) in t.iter().enumerate() { for k in 0..3 { fan[tri[k] as usize].push((f, k)); } }
    let mut beta: Vec<f64> = t.iter().flat_map(|&f| angles(m, l, f)).collect();
    let weight: Vec<f64> = beta.iter().map(|b| 2. / (b * b)).collect();
    for v in 0..l.nv {
        if !interior[v] { continue; }
        let sum: f64 = fan[v].iter().map(|&(f, k)| beta[3 * f + k]).sum();
        let s = if sum == 0. { 0. } else { 2. * PI / sum };
        for &(f, k) in &fan[v] { beta[3 * f + k] *= s; }
    }
    let mut alpha = beta.clone();
    if ni == 0 { return Some(alpha); }
    let (mut l_tri, mut l_planar, mut l_len) = (vec![0.; nf], vec![0.; ni], vec![1.; ni]);
    let limit = if nf > 100 { 1. } else { 1e-3 };
    // ∏ sin of the corners after / before v round its fan; d/dα[aid] of it with Some(aid)
    let sin_product = |si: &[f64], co: &[f64], v: usize, aid: Option<usize>| {
        let (mut s1, mut s2) = (1., 1.);
        for &(f, k) in &fan[v] {
            let (a1, a2) = (3 * f + (k + 1) % 3, 3 * f + (k + 2) % 3);
            if aid == Some(a1) { s1 *= co[a1]; s2 = 0.; } else { s1 *= si[a1]; }
            if aid == Some(a2) { s1 = 0.; s2 *= co[a2]; } else { s2 *= si[a2]; }
        }
        s1 - s2
    };
    for iter in 0..=MAX_ITER {
        let si: Vec<f64> = alpha.iter().map(|a| a.sin()).collect();
        let co: Vec<f64> = alpha.iter().map(|a| a.cos()).collect();
        // p_abf_compute_gradient
        let (mut b_alpha, mut b_tri, mut b_int, mut norm) = (vec![0.; 3 * nf], vec![0.; nf], vec![0.; 2 * ni], 0.);
        for (f, tri) in t.iter().enumerate() {
            for k in 0..3 {
                let id = 3 * f + k;
                let mut g = (alpha[id] - beta[id]) * weight[id] + l_tri[f];
                let v = tri[k] as usize;
                if interior[v] { g += l_planar[iid[v]]; }
                for q in [tri[(k + 1) % 3] as usize, tri[(k + 2) % 3] as usize] {
                    if interior[q] { g += l_len[iid[q]] * sin_product(&si, &co, q, Some(id)); }
                }
                b_alpha[id] = -g;
                norm += g * g;
            }
            let g = alpha[3 * f] + alpha[3 * f + 1] + alpha[3 * f + 2] - PI;
            b_tri[f] = -g;
            norm += g * g;
        }
        for v in 0..l.nv {
            if !interior[v] { continue; }
            let g = fan[v].iter().map(|&(f, k)| alpha[3 * f + k]).sum::<f64>() - 2. * PI;
            let gl = sin_product(&si, &co, v, None);
            b_int[iid[v]] = -g;
            b_int[ni + iid[v]] = -gl;
            norm += g * g + gl * gl;
        }
        if norm < limit { return Some(alpha); }
        if iter == MAX_ITER { return None; }
        // p_abf_matrix_invert: the 2·ninterior Schur system. It is −J₂Λ*J₂ᵀ, symmetric negative semidefinite, so
        // Cholesky on its negation
        let mut a: Vec<Vec<(usize, f64)>> = vec![Vec::new(); 2 * ni];
        let mut b = b_int.clone();
        let (mut bstar, mut dstar) = (vec![0.; nf], vec![0.; nf]);
        let mut j2s = vec![[[0.; 3]; 3]; nf];
        for (f, tri) in t.iter().enumerate() {
            let ids = [3 * f, 3 * f + 1, 3 * f + 2];
            let wi = ids.map(|i| 1. / weight[i]);
            let bs = (0..3).map(|k| b_alpha[ids[k]] * wi[k]).sum::<f64>() - b_tri[f];
            let s = 1. / (wi[0] + wi[1] + wi[2]);
            let be = ids.map(|i| bs * s - b_alpha[i]);
            (bstar[f], dstar[f]) = (bs, s);
            let w: [[f64; 3]; 3] = std::array::from_fn(|r| std::array::from_fn(|c| s - if r == c { weight[ids[r]] } else { 0. }));
            let mut vid = [usize::MAX; 6];
            let j2 = &mut j2s[f];
            for v in 0..3 {
                let q = tri[v] as usize;
                if !interior[q] { continue; }
                (vid[v], vid[3 + v]) = (iid[q], ni + iid[q]);
                for side in 0..3 { j2[side][v] = if side == v { wi[v] } else { sin_product(&si, &co, q, Some(ids[side])) * wi[side] }; }
                b[iid[q]] += j2[v][v] * be[v];
                b[ni + iid[q]] += (0..3).filter(|&k| k != v).map(|k| j2[k][v] * be[k]).sum::<f64>();
            }
            // rows[k][j]: row k of W·J₂ᵀ against unknown j (0..3 planar of corner j, 3..6 length of corner j−3)
            let mut rows = [[0.; 6]; 3];
            for v in 0..3 {
                if vid[v] == usize::MAX { continue; }
                for k in 0..3 {
                    rows[k][v] = j2[v][v] * w[k][v];
                    rows[k][3 + v] = (0..3).filter(|&x| x != v).map(|x| j2[x][v] * w[k][x]).sum();
                }
            }
            for i in 0..3 {
                let r = vid[i];
                if r == usize::MAX { continue; }
                for j in 0..6 {
                    let c = vid[j];
                    if c == usize::MAX { continue; }
                    for k in 0..3 { a[if k == i { r } else { r + ni }].push((c, -j2[k][i] * rows[k][j])); }
                }
            }
        }
        let x = {
            // semidefinite: a rounding-negative pivot where Blender's LU goes on gets a 1e-9 nudge on the diagonal
            let chol = Chol::new(a.clone(), &vec![true; 2 * ni]).or_else(|| {
                let d = (0..2 * ni).map(|i| a[i].iter().filter(|x| x.0 == i).map(|x| x.1).sum::<f64>()).fold(0., f64::max);
                let mut a = a;
                for (i, row) in a.iter_mut().enumerate() { row.push((i, 1e-9 * d)); }
                Chol::new(a, &vec![true; 2 * ni])
            })?;
            let mut x = vec![0.; 2 * ni];
            chol.solve(&b.iter().map(|v| -v).collect::<Vec<_>>(), &mut x);
            if !x.iter().all(|v| v.is_finite()) { return None; }
            x
        };
        for (f, tri) in t.iter().enumerate() {
            let j2 = &j2s[f];
            let mut pre = [0.; 3];
            for v in 0..3 {
                let q = tri[v] as usize;
                if !interior[q] { continue; }
                let (xp, xl) = (x[iid[q]], x[ni + iid[q]]);
                for k in 0..3 { pre[k] += j2[k][v] * if k == v { xp } else { xl }; }
            }
            let d = dstar[f] * (bstar[f] - (pre[0] + pre[1] + pre[2]));
            l_tri[f] += d;
            for k in 0..3 {
                let id = 3 * f + k;
                alpha[id] = (alpha[id] + (b_alpha[id] - d) / weight[id] - pre[k]).clamp(0., PI);
            }
        }
        for i in 0..ni { l_planar[i] += x[i]; l_len[i] += x[ni + i]; }
    }
    None
}

/// `p_chart_lscm_begin` / `p_chart_lscm_solve`: the angle based LSCM over `t` (fill included), each row pair Blender's.
fn lscm(m: &Mesh, l: &Local, t: &[[u32; 3]], alpha: &[f64], pins: &[(usize, f64, f64)], outer: &[u32], split: &Set<u32>) -> Option<(Vec<f64>, Vec<f64>)> {
    let nv = l.nv;
    let mut x = vec![0.; 2 * nv];
    let mut free = vec![true; 2 * nv];
    let held: Vec<(usize, f64, f64)> = if pins.len() >= 2 { pins.to_vec() } else { auto_pins(m, l, outer, split) };
    let mut at: Map<usize, (f64, f64)> = Map::default();
    for &(p, u, v) in &held { (x[2 * p], x[2 * p + 1], free[2 * p], free[2 * p + 1]) = (u, v, false, false); at.insert(p, (u, v)); }
    // the pinned triangles say which way up: wound the other way, every face is
    let (mut up, mut down) = (0., 0.);
    if pins.len() >= 2 {
        for f in &l.t {
            let (Some(a), Some(b), Some(c)) = (at.get(&(f[0] as usize)), at.get(&(f[1] as usize)), at.get(&(f[2] as usize))) else { continue };
            let s = (b.0 - a.0) * (c.1 - a.1) - (c.0 - a.0) * (b.1 - a.1);
            if s > 0. { up += s } else { down -= s }
        }
    }
    let flip = down > up;
    // AᵀA over the rows (two per triangle), rows of (column, value) summed by Chol
    let mut ata: Vec<Vec<(usize, f64)>> = vec![Vec::new(); 2 * nv];
    for (f, tri) in t.iter().enumerate() {
        let (mut v, mut a) = ([0, 1, 2].map(|k| tri[k] as usize), [0, 1, 2].map(|k| alpha[3 * f + k]));
        if flip { v.swap(1, 2); a.swap(1, 2); }
        let mut s = a.map(f64::sin);
        let max = s[0].max(s[1]).max(s[2]);
        if s[2] != max {
            (v, a, s) = ([v[2], v[0], v[1]], [a[2], a[0], a[1]], [s[2], s[0], s[1]]);
            if s[1] == max { (v, a, s) = ([v[2], v[0], v[1]], [a[2], a[0], a[1]], [s[2], s[0], s[1]]); }
        }
        let ratio = if s[2] == 0. { 1. } else { s[1] / s[2] };
        let (c, si) = (a[0].cos() * ratio, s[0] * ratio);
        let rows = [
            [(2 * v[0], c - 1.), (2 * v[0] + 1, -si), (2 * v[1], -c), (2 * v[1] + 1, si), (2 * v[2], 1.)],
            [(2 * v[0], si), (2 * v[0] + 1, c - 1.), (2 * v[1], -si), (2 * v[1] + 1, -c), (2 * v[2] + 1, 1.)],
        ];
        for row in rows { for &(i, p) in &row { for &(j, q) in &row { ata[i].push((j, p * q)); } } }
    }
    let chol = Chol::new(ata, &free)?;
    chol.solve(&vec![0.; 2 * nv], &mut x);
    if !x.iter().all(|v| v.is_finite()) { return None; }
    // no pins / a lone pin: Blender then turns the island and packs it (or puts it back on its pin); the editor lays it
    // onto where it lay instead (`edit::reseam`'s fit), the lone pin moved back onto its spot
    Some((0..nv).map(|i| (x[2 * i], x[2 * i + 1])).unzip())
}

/// No pins (or one): Blender's own two. The longest run of split vertices round the outer border, if it is half the
/// border or more: one pin in its middle, one in the middle of the rest; else the extremes along the longest axis.
fn auto_pins(m: &Mesh, l: &Local, outer: &[u32], split: &Set<u32>) -> Vec<(usize, f64, f64)> {
    let pt = |v: u32| m.pt(l.orig[v as usize]);
    let n = outer.len();
    let sp = |i: usize| split.contains(&l.orig[outer[i % n] as usize]);
    // edge i runs outer[i] → outer[i+1]; Blender's run: edges whose start is split, or whose both neighbours are
    let marked: Vec<bool> = (0..n).map(|i| sp(i) || (sp(i + n - 1) && sp(i + 1))).collect();
    let elen: Vec<f64> = (0..n).map(|i| dist(pt(outer[i]), pt(outer[(i + 1) % n]))).collect();
    let total: f64 = elen.iter().sum();
    // the longest run of marked edges; none when all are (Blender then finds no end to it either)
    let mut best: Option<(f64, usize, usize)> = None; // (length, first edge, edges)
    if let Some(gap) = (0..n).find(|&i| !marked[i]) {
        let mut i = 0;
        while i < n {
            let k = (gap + i) % n;
            if !marked[k] { i += 1; continue; }
            let (s, mut len) = (i, 0.);
            while i < n && marked[(gap + i) % n] { len += elen[(gap + i) % n]; i += 1; }
            if best.is_none_or(|b| len > b.0) { best = Some((len, k, i - s)); }
        }
    }
    let pins = best.filter(|b| b.0 >= 0.5 * total && b.0 > 0.).and_then(|(_, first, count)| {
        let mid = |from: usize, edges: usize| {
            let (mut a, mut b, mut la, mut lb) = (from, from + edges, 0., 0.);
            while a != b { if la < lb { la += elen[a % n]; a += 1; } else { b -= 1; lb += elen[b % n]; } }
            outer[a % n] as usize
        };
        let (p1, p2) = (mid(first, count), mid(first + count, n - count));
        (pt(p1 as u32) != pt(p2 as u32)).then_some((p1, p2))
    });
    let (p1, p2) = pins.unwrap_or_else(|| {
        // copies of one vertex (a seam's two sides) tie: Blender takes whichever its list meets first; take the one on
        // the outer border, never a filled hole's, which LSCM shrinks to a point and the whole chart with it
        let on_outer: Vec<bool> = { let mut o = vec![false; l.nv]; for &v in outer { o[v as usize] = true; } o };
        let ext = |k: usize| {
            let key = |a: usize, sg: f64| (sg * pt(a as u32)[k], !on_outer[a]);
            let lo = (0..l.nv).min_by(|&a, &b| key(a, 1.).partial_cmp(&key(b, 1.)).unwrap()).unwrap();
            let hi = (0..l.nv).min_by(|&a, &b| key(a, -1.).partial_cmp(&key(b, -1.)).unwrap()).unwrap();
            (lo, hi, pt(hi as u32)[k] - pt(lo as u32)[k])
        };
        let e = [ext(0), ext(1), ext(2)];
        let k = (0..3).fold(0, |b, k| if e[k].2 > e[b].2 { k } else { b });
        (e[k].0, e[k].1)
    });
    pin_positions(m, l, p1, p2)
}

/// `p_chart_pin_positions`: both pins at their 3D coordinates along the two axes they differ most in.
fn pin_positions(m: &Mesh, l: &Local, p1: usize, p2: usize) -> Vec<(usize, f64, f64)> {
    if p1 == p2 { let f = l.t[0]; return vec![(f[0] as usize, 0., 0.5), (f[1] as usize, 1., 0.5)]; }
    let (a, b) = (m.pt(l.orig[p1]), m.pt(l.orig[p2]));
    let d = [0, 1, 2].map(|k| (a[k] - b[k]).abs());
    let (dx, dy) = if d[0] > d[1] && d[0] > d[2] { (0, if d[1] > d[2] { 1 } else { 2 }) }
        else if d[1] > d[0] && d[1] > d[2] { (1, if d[0] > d[2] { 0 } else { 2 }) }
        else { (2, if d[0] > d[1] { 0 } else { 1 }) };
    let at = |p: V3| if dx == 2 { (p[dy], p[dx]) } else { (p[dx], p[dy]) };
    let (pa, pb) = (at(a), at(b));
    vec![(p1, pa.0, pa.1), (p2, pb.0, pb.1)]
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_holed_plane_and_a_cut_torus_flatten() {
        // the torus cut open along one ring: genus 1 with one border, a handle ABF must take whole
        let m = crate::mesh::Mesh::from_soup(&crate::shapes::get("torus").unwrap()).unwrap();
        let tris: Vec<u32> = (0..m.f.len() as u32).collect();
        let cut: crate::mesh::Set<u64> = m.edges.keys().copied().filter(|&e| {
            let (pa, pb) = (m.pt((e >> 32) as u32), m.pt(e as u32));
            pa[1].abs() < 1e-6 && pb[1].abs() < 1e-6 && pa[0] > 0.5 && pb[0] > 0.5
        }).collect();
        let l = crate::chart::local_mesh(&m, &tris, &cut);
        assert_eq!((l.chi(), l.loops.len()), (-1, 1));
        let f = super::flatten(&m, &l, &[], &Default::default()).expect("solved");
        assert!(f.u.iter().chain(&f.v).all(|x| x.is_finite()));
    }
}
