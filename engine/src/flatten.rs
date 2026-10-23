//! Flatten a disk chart: LSCM (keeps angles exactly) then ARAP (fixes lengths), and measure the result.
use crate::chart::Local;
use crate::mesh::*;

#[derive(Clone)]
pub struct Flat {
    pub u: Vec<f64>,
    pub v: Vec<f64>,
    /// Per triangle: max(|ln σ1|, |ln σ2|) of its 3D→2D map; infinite when flipped.
    pub e: Vec<f64>,
    pub flips: usize,
    /// Area-weighted mean of `e` over unflipped triangles.
    pub mean_e: f64,
    pub self_overlap: bool,
}

/// Conjugate gradients on the `free` entries; fixed entries of `x` stay as given.
pub(crate) fn cg(mul: impl Fn(&[f64], &mut [f64]), b: &[f64], x: &mut [f64], free: &[bool], iters: usize, tol: f64) {
    pcg(mul, None, b, x, free, iters, tol)
}

/// `cg` with an optional Jacobi preconditioner (the matrix diagonal).
pub(crate) fn pcg(mul: impl Fn(&[f64], &mut [f64]), diag: Option<&[f64]>, b: &[f64], x: &mut [f64], free: &[bool], iters: usize, tol: f64) {
    let n = x.len();
    let pre = |i: usize, r: f64| diag.map_or(r, |d| if d[i] > 0. { r / d[i] } else { r });
    let (mut r, mut z, mut p, mut ap) = (vec![0.; n], vec![0.; n], vec![0.; n], vec![0.; n]);
    mul(x, &mut ap);
    let (mut rz, mut rr, mut bb) = (0., 0., 0.);
    for i in 0..n {
        if free[i] {
            r[i] = b[i] - ap[i];
            z[i] = pre(i, r[i]);
            rz += r[i] * z[i];
            rr += r[i] * r[i];
            bb += b[i] * b[i];
        }
    }
    p.copy_from_slice(&z);
    let stop = tol * tol * bb.max(rr).max(1e-30);
    for _ in 0..iters {
        if rr <= stop { break; }
        mul(&p, &mut ap);
        let pap: f64 = (0..n).filter(|&i| free[i]).map(|i| p[i] * ap[i]).sum();
        if !(pap > 0.) { break; }
        let al = rz / pap;
        let (mut rz2, mut rr2) = (0., 0.);
        for i in 0..n {
            if free[i] {
                x[i] += al * p[i];
                r[i] -= al * ap[i];
                z[i] = pre(i, r[i]);
                rz2 += r[i] * z[i];
                rr2 += r[i] * r[i];
            }
        }
        let be = rz2 / rz;
        for i in 0..n { p[i] = if free[i] { z[i] + be * p[i] } else { 0. }; }
        (rz, rr) = (rz2, rr2);
    }
}

/// A sparse symmetric positive definite matrix (rows of (column, value), repeats summed) over its `free` entries,
/// the others held at their values in x. Cholesky over the envelope in reverse Cuthill–McKee order: factored once,
/// then each solve is two triangular sweeps. None if a pivot isn't positive (degenerate triangles).
pub(crate) struct Chol { a: Vec<Vec<(usize, f64)>>, ord: Vec<usize>, pos: Vec<usize>, first: Vec<usize>, start: Vec<usize>, l: Vec<f64> }

impl Chol {
    pub fn new(a: Vec<Vec<(usize, f64)>>, free: &[bool]) -> Option<Chol> {
        let n = a.len();
        let deg = |i: usize| a[i].len();
        let (mut pos, mut ord) = (vec![usize::MAX; n], Vec::new());
        let mut seeds: Vec<usize> = (0..n).filter(|&i| free[i]).collect();
        seeds.sort_by_key(|&i| deg(i));
        for s in seeds {
            if pos[s] != usize::MAX { continue; }
            pos[s] = ord.len();
            ord.push(s);
            let mut q = ord.len() - 1;
            while q < ord.len() {
                let mut nb: Vec<usize> = a[ord[q]].iter().map(|x| x.0).filter(|&j| free[j] && pos[j] == usize::MAX).collect();
                q += 1;
                nb.sort_by_key(|&j| deg(j));
                for j in nb { if pos[j] == usize::MAX { pos[j] = ord.len(); ord.push(j); } }
            }
        }
        ord.reverse();
        for (r, &i) in ord.iter().enumerate() { pos[i] = r; }
        let m = ord.len();
        let first: Vec<usize> = (0..m).map(|r| a[ord[r]].iter().filter(|x| free[x.0]).map(|x| pos[x.0]).fold(r, usize::min)).collect();
        let mut start = vec![0; m + 1];
        for r in 0..m { start[r + 1] = start[r] + r - first[r] + 1; }
        let at = |r: usize, c: usize| start[r] + c - first[r];
        let mut l = vec![0.; start[m]];
        for r in 0..m {
            for &(j, w) in &a[ord[r]] { if free[j] && pos[j] <= r { l[at(r, pos[j])] += w; } }
            for c in first[r]..=r {
                let mut s = l[at(r, c)];
                for k in first[c].max(first[r])..c { s -= l[at(r, k)] * l[at(c, k)]; }
                if c < r { l[at(r, c)] = s / l[at(c, c)]; } else if s > 0. && s.is_finite() { l[at(r, r)] = s.sqrt(); } else { return None; }
            }
        }
        Some(Chol { a, ord, pos, first, start, l })
    }

    /// x = A⁻¹ b on the free entries; the fixed ones are read from x.
    pub fn solve(&self, b: &[f64], x: &mut [f64]) {
        let at = |r: usize, c: usize| self.start[r] + c - self.first[r];
        let mut y: Vec<f64> = self.ord.iter().map(|&i| {
            b[i] - self.a[i].iter().filter(|q| self.pos[q.0] == usize::MAX).map(|&(j, w)| w * x[j]).sum::<f64>()
        }).collect();
        for r in 0..y.len() {
            let s: f64 = (self.first[r]..r).map(|k| self.l[at(r, k)] * y[k]).sum();
            y[r] = (y[r] - s) / self.l[at(r, r)];
        }
        for r in (0..y.len()).rev() {
            y[r] /= self.l[at(r, r)];
            for k in self.first[r]..r { y[k] -= self.l[at(r, k)] * y[r]; }
        }
        for (r, &i) in self.ord.iter().enumerate() { x[i] = y[r]; }
    }
}

/// Each triangle laid flat in its own frame (`x`: corners at (0,0), (x1,0), (x2,y2)), its corner cotangents,
/// its area, and the cotan Laplacian as rows of (neighbour, weight).
pub(crate) struct Frames {
    pub x: Vec<[f64; 6]>,
    pub cot: Vec<[f64; 3]>,
    pub area: Vec<f64>,
    pub rows: Vec<Vec<(usize, f64)>>,
}

impl Frames {
    /// L as matrix rows (diagonal included), for `Chol`.
    pub fn matrix(&self) -> Vec<Vec<(usize, f64)>> {
        self.rows.iter().enumerate().map(|(i, r)| {
            let mut row: Vec<(usize, f64)> = r.iter().map(|&(j, w)| (j, -w)).collect();
            row.push((i, r.iter().map(|x| x.1).sum()));
            row
        }).collect()
    }

    /// y = L x
    pub fn lmul(&self, x: &[f64], y: &mut [f64]) {
        for (i, r) in self.rows.iter().enumerate() { y[i] = r.iter().map(|&(j, w)| w * (x[i] - x[j])).sum(); }
    }
}

pub(crate) fn frames(m: &Mesh, l: &Local) -> Frames {
    let (nt, nv) = (l.t.len(), l.nv);
    let pt = |v: u32| m.pt(l.orig[v as usize]);
    let (mut x, mut cot, mut area) = (vec![[0.; 6]; nt], vec![[0.; 3]; nt], vec![0.; nt]);
    for (i, tri) in l.t.iter().enumerate() {
        let a = pt(tri[0]);
        let (e1, e2) = (sub(pt(tri[1]), a), sub(pt(tri[2]), a));
        let len = norm(e1);
        let (cx, cy) = (dot(e1, e2) / len, norm(cross(e1, e2)) / len);
        x[i] = [0., 0., len, 0., cx, cy];
        area[i] = len * cy / 2.;
        for k in 0..3 {
            let (o, j, q) = (2 * k, 2 * ((k + 1) % 3), 2 * ((k + 2) % 3));
            let (ux, uy, vx, vy) = (x[i][j] - x[i][o], x[i][j + 1] - x[i][o + 1], x[i][q] - x[i][o], x[i][q + 1] - x[i][o + 1]);
            cot[i][k] = (ux * vx + uy * vy) / (ux * vy - uy * vx).abs();
        }
    }

    // cotan Laplacian: the edge opposite corner k gets cot/2 from each side
    let mut w: Map<u64, f64> = Map::default();
    for (i, tri) in l.t.iter().enumerate() {
        for k in 0..3 { *w.entry(ek(tri[(k + 1) % 3], tri[(k + 2) % 3])).or_default() += cot[i][k] / 2.; }
    }
    let mut rows = vec![Vec::new(); nv];
    for (key, w) in w {
        let (i, j) = ((key >> 32) as usize, (key & 0xffff_ffff) as usize);
        rows[i].push((j, w));
        rows[j].push((i, w));
    }
    Frames { x, cot, area, rows }
}

/// LSCM: conformal energy = Dirichlet − area, two far-apart border vertices pinned.
fn lscm(m: &Mesh, l: &Local, fr: &Frames) -> (Vec<f64>, Vec<f64>) {
    let pt = |v: u32| m.pt(l.orig[v as usize]);
    let lp = &l.loops[0];
    let p0 = lp[0];
    let (p1, d01) = lp.iter().map(|&v| (v, dist(pt(v), pt(p0)))).max_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
    lscm_pinned(l, fr, &[(p0 as usize, 0., 0.), (p1 as usize, d01, 0.)])
}

/// LSCM with the given vertices pinned at (u, v); at least two of them.
fn lscm_pinned(l: &Local, fr: &Frames, pins: &[(usize, f64, f64)]) -> (Vec<f64>, Vec<f64>) {
    let nv = l.nv;
    let lmul = |a: &[f64], y: &mut [f64]| fr.lmul(a, y);
    // the conformal term's boundary part runs round every border loop
    let bnd: Vec<(usize, usize)> = l.loops.iter().flat_map(|lp| (0..lp.len()).map(move |i| (lp[i] as usize, lp[(i + 1) % lp.len()] as usize))).collect();
    let mut uv = vec![0.; 2 * nv];
    let mut free = vec![true; 2 * nv];
    for &(p, x, y) in pins { (free[p], free[nv + p], uv[p], uv[nv + p]) = (false, false, x, y); }
    let lscm = |x: &[f64], y: &mut [f64]| {
        lmul(&x[..nv], &mut y[..nv]);
        lmul(&x[nv..], &mut y[nv..]);
        for &(i, j) in &bnd {
            y[i] -= 0.5 * x[nv + j]; // −B/2 · v
            y[j] += 0.5 * x[nv + i];
            y[nv + i] += 0.5 * x[j]; // +B/2 · u
            y[nv + j] -= 0.5 * x[i];
        }
    };
    // the same matrix as rows, for a direct solve; CG if that fails
    let mut a = fr.matrix();
    a.extend(fr.matrix().into_iter().map(|r| r.into_iter().map(|(j, w)| (nv + j, w)).collect()));
    for &(i, j) in &bnd {
        a[i].push((nv + j, -0.5));
        a[j].push((nv + i, 0.5));
        a[nv + i].push((j, 0.5));
        a[nv + j].push((i, -0.5));
    }
    match Chol::new(a, &free) {
        Some(c) => c.solve(&vec![0.; 2 * nv], &mut uv),
        None => cg(lscm, &vec![0.; 2 * nv], &mut uv, &free, 4000, 1e-10),
    }
    (uv[..nv].to_vec(), uv[nv..].to_vec())
}

pub fn flatten(m: &Mesh, l: &Local) -> Flat {
    let fr = frames(m, l);
    let (u, v) = lscm(m, l, &fr);
    let (u, v) = arap(l, &fr, u, v, 200);
    measure(l, &fr, u, v)
}

/// LSCM then ARAP with the given vertices held at (u, v): a book's halves, laid against their straight spine.
pub fn flatten_pinned(m: &Mesh, l: &Local, pins: &[(usize, f64, f64)]) -> Flat {
    let fr = frames(m, l);
    let (u, v) = lscm_pinned(l, &fr, pins);
    let held: Vec<usize> = pins.iter().map(|p| p.0).collect();
    let (u, v) = arap_pinned(l, &fr, u, v, 200, &held);
    measure(l, &fr, u, v)
}

/// LSCM alone with the given vertices held: fast and conformal, Blender's live unwrap while pins are dragged.
pub fn flatten_lscm_pinned(m: &Mesh, l: &Local, pins: &[(usize, f64, f64)]) -> Flat {
    let fr = frames(m, l);
    let (u, v) = lscm_pinned(l, &fr, pins);
    measure(l, &fr, u, v)
}

/// ARAP from a given layout: best rotation per triangle (local), then a Poisson solve (global); one vertex pinned.
pub(crate) fn arap(l: &Local, fr: &Frames, u: Vec<f64>, v: Vec<f64>, iters: usize) -> (Vec<f64>, Vec<f64>) {
    arap_pinned(l, fr, u, v, iters, &[l.loops[0][0] as usize])
}

/// ARAP with the `held` vertices staying where they are.
pub(crate) fn arap_pinned(l: &Local, fr: &Frames, mut u: Vec<f64>, mut v: Vec<f64>, iters: usize, held: &[usize]) -> (Vec<f64>, Vec<f64>) {
    let (nt, nv) = (l.t.len(), l.nv);
    let (x, cot) = (&fr.x, &fr.cot);
    let lmul = |a: &[f64], y: &mut [f64]| fr.lmul(a, y);

    let mut free1 = vec![true; nv];
    for &p in held { free1[p] = false; }
    // the same matrix every step: factor it once
    let chol = Chol::new(fr.matrix(), &free1);
    let (mut rot, mut bu, mut bv, mut eprev) = (vec![(1., 0.); nt], vec![0.; nv], vec![0.; nv], f64::INFINITY);
    let edge = |i: usize, k: usize| {
        let (a, b) = ((k + 1) % 3, (k + 2) % 3);
        (a, b, x[i][2 * b] - x[i][2 * a], x[i][2 * b + 1] - x[i][2 * a + 1])
    };
    for _ in 0..iters {
        for (i, tri) in l.t.iter().enumerate() {
            let (mut s00, mut s01, mut s10, mut s11) = (0., 0., 0., 0.);
            for k in 0..3 {
                let (a, b, xx, xy) = edge(i, k);
                let (ia, ib, c) = (tri[a] as usize, tri[b] as usize, cot[i][k] / 2.);
                let (ux, uy) = (u[ib] - u[ia], v[ib] - v[ia]);
                s00 += c * ux * xx; s01 += c * ux * xy; s10 += c * uy * xx; s11 += c * uy * xy;
            }
            let th = (s10 - s01).atan2(s00 + s11);
            rot[i] = (th.cos(), th.sin());
        }
        bu.fill(0.);
        bv.fill(0.);
        let mut e = 0.;
        for (i, tri) in l.t.iter().enumerate() {
            let (cs, sn) = rot[i];
            for k in 0..3 {
                let (a, b, xx, xy) = edge(i, k);
                let (ia, ib, c) = (tri[a] as usize, tri[b] as usize, cot[i][k] / 2.);
                let (rx, ry) = (cs * xx - sn * xy, sn * xx + cs * xy); // rotated b − a
                bu[ib] += c * rx; bv[ib] += c * ry; bu[ia] -= c * rx; bv[ia] -= c * ry;
                let (dx, dy) = (u[ib] - u[ia] - rx, v[ib] - v[ia] - ry);
                e += c.abs() * (dx * dx + dy * dy);
            }
        }
        if e < 1e-14 || (eprev - e).abs() < 1e-7 * eprev { break; }
        eprev = e;
        if let Some(c) = &chol {
            c.solve(&bu, &mut u);
            c.solve(&bv, &mut v);
        } else {
            cg(&lmul, &bu, &mut u, &free1, 500, 1e-10);
            cg(&lmul, &bv, &mut v, &free1, 500, 1e-10);
        }
    }
    (u, v)
}

/// Quality of a layout: singular values of each triangle's 3D→2D map, flips, and the outline crossing itself.
pub(crate) fn measure(l: &Local, fr: &Frames, u: Vec<f64>, v: Vec<f64>) -> Flat {
    let (x, area, nt) = (&fr.x, &fr.area, l.t.len());
    let (mut e, mut flips, mut sum_e, mut sum_a) = (vec![0.; nt], 0, 0., 0.);
    for (i, tri) in l.t.iter().enumerate() {
        let [t0, t1, t2] = tri.map(|q| q as usize);
        let (a1, b1, c1, d1) = (u[t1] - u[t0], u[t2] - u[t0], v[t1] - v[t0], v[t2] - v[t0]);
        let (x1, x2, y2) = (x[i][2], x[i][4], x[i][5]);
        // J = U · X⁻¹ with X = [[x1, x2], [0, y2]]
        let (ja, jc) = (a1 / x1, c1 / x1);
        let (jb, jd) = ((b1 - ja * x2) / y2, (d1 - jc * x2) / y2);
        if ja * jd - jb * jc <= 0. {
            flips += 1;
            e[i] = f64::INFINITY;
            continue;
        }
        let (q, r) = (((ja + jd) / 2.).hypot((jc - jb) / 2.), ((ja - jd) / 2.).hypot((jc + jb) / 2.));
        e[i] = (q + r).ln().abs().max((q - r).abs().max(1e-12).ln().abs());
        sum_e += e[i] * area[i];
        sum_a += area[i];
    }
    let self_overlap = outline_crosses(&u, &v, &l.loops);
    Flat { u, v, e, flips, mean_e: if sum_a > 0. { sum_e / sum_a } else { 0. }, self_overlap }
}

/// An island whose outline (every border loop) crosses itself overlaps itself.
pub(crate) fn outline_crosses(u: &[f64], v: &[f64], loops: &[Vec<u32>]) -> bool { !crossings(u, v, loops, false).is_empty() }

/// Endpoints of outline segments that cross another (just the first pair unless `all`).
fn crossings(u: &[f64], v: &[f64], loops: &[Vec<u32>], all: bool) -> Vec<usize> {
    let segs: Vec<(usize, usize)> = loops.iter().flat_map(|lp| (0..lp.len()).map(move |k| (lp[k] as usize, lp[(k + 1) % lp.len()] as usize))).collect();
    if segs.is_empty() { return vec![]; }
    // A slit's two sides lie on each other: solver noise there is not a crossing. Points within a tolerance
    // (scaled to the island) of a line count as on it, and on-the-line never crosses.
    let (mut lo, mut hi, mut len) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN), 0.);
    for &(a, b) in &segs {
        lo = (lo.0.min(u[a]), lo.1.min(v[a]));
        hi = (hi.0.max(u[a]), hi.1.max(v[a]));
        len += (u[b] - u[a]).hypot(v[b] - v[a]);
    }
    let size = (hi.0 - lo.0).max(hi.1 - lo.1).max(1e-300);
    let tol = size * size * 1e-7;
    let side = |a: usize, b: usize, c: usize| {
        let s = (u[b] - u[a]) * (v[c] - v[a]) - (v[b] - v[a]) * (u[c] - u[a]);
        if s.abs() < tol { 0. } else { s.signum() }
    };
    // segments bucketed on a grid about two mean segment lengths across
    let cell = (2. * len / segs.len() as f64).max(size * 1e-4);
    let key = |x: f64, y: f64| (((x - lo.0) / cell) as i64, ((y - lo.1) / cell) as i64);
    let mut grid: Map<(i64, i64), Vec<usize>> = Map::default();
    for (i, &(a, b)) in segs.iter().enumerate() {
        let (k0, k1) = (key(u[a].min(u[b]), v[a].min(v[b])), key(u[a].max(u[b]), v[a].max(v[b])));
        for x in k0.0..=k1.0 { for y in k0.1..=k1.1 { grid.entry((x, y)).or_default().push(i); } }
    }
    let mut out = Vec::new();
    for list in grid.values() {
        for (n, &i) in list.iter().enumerate() {
            for &j in &list[n + 1..] {
                let ((a, b), (c, d)) = (segs[i], segs[j]);
                if a == c || a == d || b == c || b == d { continue; }
                if side(a, b, c) * side(a, b, d) < 0. && side(c, d, a) * side(c, d, b) < 0. {
                    out.extend([a, b, c, d]);
                    if !all { return out; }
                }
            }
        }
    }
    out
}

/// The per-triangle map J (2×2, row-major) from the layout, read off the rest frame `x`.
fn jac(x: &[f64; 6], t: [usize; 3], u: &[f64], v: &[f64]) -> [f64; 4] {
    let (a1, b1, c1, d1) = (u[t[1]] - u[t[0]], u[t[2]] - u[t[0]], v[t[1]] - v[t[0]], v[t[2]] - v[t[0]]);
    let (x1, x2, y2) = (x[2], x[4], x[5]);
    let (ja, jc) = (a1 / x1, c1 / x1);
    [ja, (b1 - ja * x2) / y2, jc, (d1 - jc * x2) / y2]
}

/// The adjoint of `jac`: a gradient with respect to J, spread onto the triangle's corners.
fn jac_t(x: &[f64; 6], t: [usize; 3], g: [f64; 4], gu: &mut [f64], gv: &mut [f64]) {
    let (x1, x2, y2) = (x[2], x[4], x[5]);
    let k = -x2 / (x1 * y2);
    let (u1, u2) = (g[0] / x1 + g[1] * k, g[1] / y2);
    let (v1, v2) = (g[2] / x1 + g[3] * k, g[3] / y2);
    gu[t[1]] += u1; gu[t[2]] += u2; gu[t[0]] -= u1 + u2;
    gv[t[1]] += v1; gv[t[2]] += v2; gv[t[0]] -= v1 + v2;
}

/// Symmetric Dirichlet energy (area-weighted σ1² + σ2² + σ1⁻² + σ2⁻²: 4 per unit area at an isometry);
/// infinite once anything flips.
fn sym_dirichlet(l: &Local, fr: &Frames, u: &[f64], v: &[f64]) -> f64 {
    let mut e = 0.;
    for (i, tri) in l.t.iter().enumerate() {
        let j = jac(&fr.x[i], tri.map(|q| q as usize), u, v);
        let det = j[0] * j[3] - j[1] * j[2];
        if det <= 0. { return f64::INFINITY; }
        let f2 = j.iter().map(|x| x * x).sum::<f64>();
        e += fr.area[i] * (f2 + f2 / (det * det));
    }
    e
}

/// Locally injective flattening from a valid start (SLIM, Rabinovich et al. 2017): reweighted local-global
/// steps on the symmetric Dirichlet energy. Every step is cut short before a triangle flips or the outline
/// crosses itself, so a layout that starts overlap-free stays overlap-free.
pub(crate) fn slim(l: &Local, fr: &Frames, u: Vec<f64>, v: Vec<f64>, iters: usize) -> (Vec<f64>, Vec<f64>) {
    slim_held(l, fr, u, v, iters, &[0])
}

/// `slim` with the `held` vertices staying where they are.
pub(crate) fn slim_held(l: &Local, fr: &Frames, mut u: Vec<f64>, mut v: Vec<f64>, iters: usize, held: &[usize]) -> (Vec<f64>, Vec<f64>) {
    let (nt, nv) = (l.t.len(), l.nv);
    let tri = |i: usize| l.t[i].map(|q| q as usize);
    let mut e = sym_dirichlet(l, fr, &u, &v);
    if !e.is_finite() { return (u, v); }
    let mut free = vec![true; 2 * nv];
    for &h in held { (free[h], free[nv + h]) = (false, false); }
    let mul2 = |a: &[f64; 4], b: &[f64; 4]| [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
    for _ in 0..iters {
        // local: per triangle the closest rotation R and the weight W² = U diag(w1², w2²) Uᵀ (J = U Σ Vᵀ)
        let (mut w2, mut rot) = (vec![[0.; 4]; nt], vec![[0.; 4]; nt]);
        for i in 0..nt {
            let j = jac(&fr.x[i], tri(i), &u, &v);
            let (ee, ff, gg, hh) = ((j[0] + j[3]) / 2., (j[0] - j[3]) / 2., (j[2] + j[1]) / 2., (j[2] - j[1]) / 2.);
            let (q, r) = (ee.hypot(hh), ff.hypot(gg));
            let (s1, s2) = (q + r, (q - r).max(1e-8));
            let (a1, a2) = (gg.atan2(ff), hh.atan2(ee));
            let phi = (a2 + a1) / 2.;
            let w = |s: f64| (s + 1.) * (s * s + 1.) / (s * s * s);
            let (c, s, p1, p2) = (phi.cos(), phi.sin(), w(s1), w(s2));
            w2[i] = [c * c * p1 + s * s * p2, c * s * (p1 - p2), c * s * (p1 - p2), s * s * p1 + c * c * p2];
            rot[i] = [a2.cos(), -a2.sin(), a2.sin(), a2.cos()];
        }
        // global: minimise Σ A ‖W (J − R)‖² over the layout
        let hmul = |x: &[f64], y: &mut [f64]| {
            y.fill(0.);
            let (yu, yv) = y.split_at_mut(nv);
            for i in 0..nt {
                let j = jac(&fr.x[i], tri(i), &x[..nv], &x[nv..]);
                jac_t(&fr.x[i], tri(i), mul2(&w2[i], &j).map(|q| q * fr.area[i]), yu, yv);
            }
        };
        let mut b = vec![0.; 2 * nv];
        {
            let (bu, bv) = b.split_at_mut(nv);
            for i in 0..nt { jac_t(&fr.x[i], tri(i), mul2(&w2[i], &rot[i]).map(|q| q * fr.area[i]), bu, bv); }
        }
        // Jacobi preconditioner: corner k of a triangle moves J's u row by g_k, so H[u_k,u_k] += A |g_k|² W²₀₀
        let mut diag = vec![0.; 2 * nv];
        for i in 0..nt {
            let x = &fr.x[i];
            let k = -x[4] / (x[2] * x[5]);
            let g = [(-1. / x[2], -k - 1. / x[5]), (1. / x[2], k), (0., 1. / x[5])];
            for (c, &q) in tri(i).iter().enumerate() {
                let gg = (g[c].0 * g[c].0 + g[c].1 * g[c].1) * fr.area[i];
                diag[q] += gg * w2[i][0];
                diag[nv + q] += gg * w2[i][3];
            }
        }
        // Solve, then step. A step that would push the outline through itself freezes the vertices at the
        // contact (and their neighbours) and solves again, so one touching spot doesn't stall the whole chart.
        let mut frozen = vec![false; nv];
        let mut moved = false;
        'attempt: for _ in 0..8 {
            let fr_free: Vec<bool> = (0..2 * nv).map(|k| free[k] && !frozen[k % nv]).collect();
            let mut x: Vec<f64> = u.iter().chain(&v).copied().collect();
            pcg(&hmul, Some(&diag), &b, &mut x, &fr_free, 300, 1e-6);
            let (du, dv): (Vec<f64>, Vec<f64>) = (0..nv).map(|k| (x[k] - u[k], x[nv + k] - v[k])).unzip();
            // the longest step before any triangle flips: smallest positive root of det(J + αD) = 0
            let mut a: f64 = 1.;
            for i in 0..nt {
                let (j, d) = (jac(&fr.x[i], tri(i), &u, &v), jac(&fr.x[i], tri(i), &du, &dv));
                let c0 = j[0] * j[3] - j[1] * j[2];
                let c1 = j[0] * d[3] + d[0] * j[3] - j[1] * d[2] - d[1] * j[2];
                let c2 = d[0] * d[3] - d[1] * d[2];
                let roots = if c2.abs() < 1e-14 * c0.abs().max(1e-300) { [-c0 / c1, f64::NAN] } else {
                    let disc = c1 * c1 - 4. * c2 * c0;
                    if disc < 0. { [f64::NAN; 2] } else { let sq = disc.sqrt(); [(-c1 - sq) / (2. * c2), (-c1 + sq) / (2. * c2)] }
                };
                for r in roots { if r > 0. { a = a.min(0.8 * r); } }
            }
            // then back off until the energy drops
            for _ in 0..30 {
                let un: Vec<f64> = (0..nv).map(|k| u[k] + a * du[k]).collect();
                let vn: Vec<f64> = (0..nv).map(|k| v[k] + a * dv[k]).collect();
                let en = sym_dirichlet(l, fr, &un, &vn);
                if en < e {
                    let hit = crossings(&un, &vn, &l.loops, true);
                    if hit.is_empty() {
                        moved = e - en > 1e-5 * e;
                        (u, v, e) = (un, vn, en);
                        break 'attempt;
                    }
                    for &w in &hit { frozen[w] = true; }
                    for t in &l.t { if t.iter().any(|&q| hit.contains(&(q as usize))) { for &q in t { frozen[q as usize] = true; } } }
                    continue 'attempt;
                }
                a /= 2.;
            }
            break;
        }
        if !moved { break; }
    }
    (u, v)
}

/// A valid start for `slim`: the chart projected onto the plane it faces, if that neither flips nor overlaps (a
/// hard-surface flank with its grooves usually qualifies, holes and all).
fn start(m: &Mesh, l: &Local, fr: &Frames) -> Option<(Vec<f64>, Vec<f64>)> {
    let pt = |w: usize| m.pt(l.orig[w]);
    let mut n = [0.; 3];
    for tri in &l.t {
        let c = cross(sub(pt(tri[1] as usize), pt(tri[0] as usize)), sub(pt(tri[2] as usize), pt(tri[0] as usize)));
        for k in 0..3 { n[k] += c[k]; }
    }
    let nl = norm(n);
    if nl > 0. {
        let n = n.map(|x| x / nl);
        let e1 = cross(n, if n[0].abs() < 0.9 { [1., 0., 0.] } else { [0., 1., 0.] });
        let e1 = e1.map(|x| x / norm(e1));
        let e2 = cross(n, e1);
        let (u, v): (Vec<f64>, Vec<f64>) = (0..l.nv).map(|w| (dot(pt(w), e1), dot(pt(w), e2))).unzip();
        if sym_dirichlet(l, fr, &u, &v).is_finite() && !outline_crosses(&u, &v, &l.loops) { return Some((u, v)); }
    }
    None
}

/// Overlap-free flattening of a genus-0 chart, holes allowed: `slim` from `start`. None without a valid start.
pub fn flatten_slim(m: &Mesh, l: &Local) -> Option<Flat> {
    let fr = frames(m, l);
    let (u, v) = start(m, l, &fr)?;
    let (u, v) = slim(l, &fr, u, v, 60);
    Some(measure(l, &fr, u, v))
}

/// `slim` from a layout that's already clean (a piece carved out of a bigger unfolding): less stretch, still no
/// flips or overlap.
pub fn relax(m: &Mesh, l: &Local, f: &Flat) -> Flat {
    let fr = frames(m, l);
    let (u, v) = slim(l, &fr, f.u.clone(), f.v.clone(), 60);
    measure(l, &fr, u, v)
}
