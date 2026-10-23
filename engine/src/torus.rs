//! Genus-1 charts (a torus, the knot's tube): a seamless layout from two harmonic one-forms
//! (Gu & Yau's global conformal parametrization, the genus-1 case).
//!
//! Tree-cotree gives the two generator loops a, b. For each, a closed one-form that is 1 across a dual loop
//! crossing it once, made harmonic with one Poisson solve. Integrated over the chart cut open along a and b,
//! the two forms are the u and v coordinates: a torus becomes a rectangle running round the ring and round
//! the tube, and the two sides of each seam differ by a pure shift, so a tiling texture carries straight on.
use crate::chart::{dijkstra, find, local_mesh, path_keys, vert_adj, Local};
use crate::flatten::{cg, frames, measure, Flat};
use crate::mesh::*;
use std::collections::VecDeque;

/// `l0`: the chart, closed with Euler characteristic 0 and no cuts yet. None if it isn't a clean torus.
pub fn torus_map(m: &Mesh, tris: &[u32], l0: &Local) -> Option<(Local, Flat)> {
    let nv = l0.nv;
    // an uncut closed chart: local vertices are welded vertices one to one
    let mut local_of: Map<u32, u32> = Map::default();
    for (i, &w) in l0.orig.iter().enumerate() { local_of.insert(w, i as u32); }

    // directed edge → the triangle whose winding runs along it
    let mut left: Map<(u32, u32), usize> = Map::default();
    for (i, t) in l0.t.iter().enumerate() {
        for k in 0..3 { left.insert((t[k], t[(k + 1) % 3]), i); }
    }

    // tree-cotree: shortest-path tree, dual tree keeping the edges whose loops would be longest
    let (d, prev, _) = dijkstra(&vert_adj(m, l0), &[0], |_| false);
    let mut dual: Vec<(f64, u32, u32)> = left.keys().filter(|&&(a, b)| a < b && prev[a as usize] != b && prev[b as usize] != a)
        .map(|&(a, b)| (d[a as usize] + d[b as usize] + dist(m.pt(l0.orig[a as usize]), m.pt(l0.orig[b as usize])), a, b))
        .collect();
    dual.sort_by(|x, y| y.0.total_cmp(&x.0).then((x.1, x.2).cmp(&(y.1, y.2))));
    let mut par: Vec<usize> = (0..l0.t.len()).collect();
    let mut cotree = vec![Vec::new(); l0.t.len()];
    let mut gens = Vec::new();
    for (_, a, b) in dual {
        let (t1, t2) = (*left.get(&(a, b))?, *left.get(&(b, a))?);
        let (x, y) = (find(&mut par, t1), find(&mut par, t2));
        if x != y { par[x] = y; cotree[t1].push(t2); cotree[t2].push(t1); } else { gens.push((a, b)); }
    }
    if gens.len() != 2 { return None; }

    let fr0 = frames(m, l0);
    // ω per generator, as a value on each undirected edge (a<b), read along a→b
    let omega: Vec<Map<(u32, u32), f64>> = gens.iter().map(|&(a, b)| {
        // the dual loop: cotree path from the triangle left of a→b to the one left of b→a, then back across a→b
        let (from, to) = (left[&(a, b)], left[&(b, a)]);
        let mut came = vec![usize::MAX; l0.t.len()];
        let mut q = VecDeque::from([from]);
        came[from] = from;
        while let Some(t) = q.pop_front() {
            if t == to { break; }
            for &u in &cotree[t] { if came[u] == usize::MAX { came[u] = t; q.push_back(u); } }
        }
        let mut c: Map<(u32, u32), f64> = Map::default();
        let mut cross = |s: usize, t: usize| {
            // the edge of s shared with t, as s winds it: stepping from s to t crosses it right to left
            let tri = l0.t[s];
            for k in 0..3 {
                let (p, q) = (tri[k], tri[(k + 1) % 3]);
                if left.get(&(q, p)) == Some(&t) {
                    *c.entry((p.min(q), p.max(q))).or_default() += if p < q { 1. } else { -1. };
                    return;
                }
            }
        };
        let mut t = to;
        while t != from { cross(came[t], t); t = came[t]; }
        cross(to, from);

        // harmonic: minimise Σ w (u_j − u_i + c_ij)² ⇒ L u = Σ_j w_ij c_ij
        let cij = |i: u32, j: u32| c.get(&(i.min(j), i.max(j))).map_or(0., |v| if i < j { *v } else { -v });
        let rhs: Vec<f64> = (0..nv).map(|i| fr0.rows[i].iter().map(|&(j, w)| w * cij(i as u32, j as u32)).sum()).collect();
        let (mut u, mut free) = (vec![0.; nv], vec![true; nv]);
        free[0] = false;
        cg(|x: &[f64], y: &mut [f64]| fr0.lmul(x, y), &rhs, &mut u, &free, 4000, 1e-11);
        left.keys().filter(|&&(i, j)| i < j).map(|&(i, j)| ((i, j), u[j as usize] - u[i as usize] + cij(i, j))).collect()
    }).collect();

    // cut open along both loops, then integrate each form from one corner
    let mut cut = Set::default();
    for &(a, b) in &gens {
        let mut keys = vec![ek(l0.orig[a as usize], l0.orig[b as usize])];
        path_keys(l0, &prev, a, &mut keys);
        path_keys(l0, &prev, b, &mut keys);
        cut.extend(keys);
    }
    let l = local_mesh(m, tris, &cut);
    if !l.is_disk() { return None; }
    let mut adj = vec![Vec::new(); l.nv];
    for t in &l.t {
        for k in 0..3 { let (a, b) = (t[k], t[(k + 1) % 3]); adj[a as usize].push(b); adj[b as usize].push(a); }
    }
    let mut uv = [vec![f64::NAN; l.nv], vec![f64::NAN; l.nv]];
    for (k, w) in omega.iter().enumerate() {
        let read = |a: u32, b: u32| { // ω along disk edge a→b, through the welded vertices
            let (i, j) = (local_of[&l.orig[a as usize]], local_of[&l.orig[b as usize]]);
            w.get(&(i.min(j), i.max(j))).map_or(0., |v| if i < j { *v } else { -v })
        };
        let phi = &mut uv[k];
        phi[0] = 0.;
        let mut q = VecDeque::from([0u32]);
        while let Some(a) = q.pop_front() {
            for &b in &adj[a as usize] {
                if phi[b as usize].is_nan() { phi[b as usize] = phi[a as usize] + read(a, b); q.push_back(b); }
            }
        }
    }
    let [u, mut v] = uv;
    let signed: f64 = l.t.iter().map(|t| {
        let [a, b, c] = t.map(|q| q as usize);
        (u[b] - u[a]) * (v[c] - v[a]) - (u[c] - u[a]) * (v[b] - v[a])
    }).sum();
    if signed < 0. { v.iter_mut().for_each(|x| *x = -*x); }

    // Each coordinate grows by 1 per turn: give the layout the model's lengths with the one 2×2 map A that's
    // closest to rigid on every triangle (local: best rotation R_t of A·J_t; global: A = ΣaRJᵀ (ΣaJJᵀ)⁻¹).
    // A linear map keeps every seam a pure shift, so the layout stays seamless.
    let fr = frames(m, &l);
    let jac: Vec<[f64; 4]> = l.t.iter().enumerate().map(|(i, t)| {
        let [x1, x2, y2] = [fr.x[i][2], fr.x[i][4], fr.x[i][5]];
        let grad = |f: &[f64]| {
            let (f0, f1, f2) = (f[t[0] as usize], f[t[1] as usize], f[t[2] as usize]);
            let gx = (f1 - f0) / x1;
            (gx, (f2 - f0 - gx * x2) / y2)
        };
        let ((a, b), (c, d)) = (grad(&u), grad(&v));
        [a, b, c, d]
    }).collect();
    let mul = |p: [f64; 4], q: [f64; 4]| [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
    let tr = |p: [f64; 4]| [p[0], p[2], p[1], p[3]];
    let mut nn = [0.; 4];
    for (i, j) in jac.iter().enumerate() { let jj = mul(*j, tr(*j)); for k in 0..4 { nn[k] += fr.area[i] * jj[k]; } }
    let det = nn[0] * nn[3] - nn[1] * nn[2];
    if !(det.abs() > 1e-30) { return None; }
    let ninv = [nn[3] / det, -nn[1] / det, -nn[2] / det, nn[0] / det];
    let mut a = ninv; // start: undo the gradients' size
    for _ in 0..30 {
        let mut mm = [0.; 4];
        for (i, j) in jac.iter().enumerate() {
            let p = mul(a, *j);
            let th = (p[2] - p[1]).atan2(p[0] + p[3]);
            let r = [th.cos(), -th.sin(), th.sin(), th.cos()];
            let rj = mul(r, tr(*j));
            for k in 0..4 { mm[k] += fr.area[i] * rj[k]; }
        }
        a = mul(mm, ninv);
    }
    if a[0] * a[3] - a[1] * a[2] <= 0. { return None; }
    let (u, v): (Vec<f64>, Vec<f64>) = u.iter().zip(&v).map(|(&x, &y)| (a[0] * x + a[1] * y, a[2] * x + a[3] * y)).unzip();
    if let Some((l2, u2, v2)) = recut(m, tris, &l, &u, &v) {
        let f = measure(&l2, &frames(m, &l2), u2, v2);
        return Some((l2, f));
    }
    let f = measure(&l, &fr, u, v);
    Some((l, f))
}

/// The seamless layout tiles the plane with two shifts (the seams' periods). Re-cut it along the most square
/// cell of that lattice (Lagrange–Gauss reduction), each triangle moved into the cell by its centroid: a torus
/// of revolution comes out a rectangle cut exactly along its grid lines, still seamless.
fn recut(m: &Mesh, tris: &[u32], l: &Local, u: &[f64], v: &[f64]) -> Option<(Local, Vec<f64>, Vec<f64>)> {
    let mut copies: Map<u32, Vec<usize>> = Map::default();
    for (i, &w) in l.orig.iter().enumerate() { copies.entry(w).or_default().push(i); }
    let mut shifts: Vec<(f64, f64)> = Vec::new();
    for c in copies.values() {
        for &x in c { for &y in c { if x < y { shifts.push((u[y] - u[x], v[y] - v[x])); } } }
    }
    let len = |p: (f64, f64)| p.0.hypot(p.1);
    shifts.retain(|&p| len(p) > 1e-9);
    shifts.sort_by(|a, b| len(*a).total_cmp(&len(*b)));
    let mut p1 = *shifts.first()?;
    let mut p2 = *shifts.iter().find(|q| (p1.0 * q.1 - p1.1 * q.0).abs() > 1e-6 * len(p1) * len(**q))?;
    for _ in 0..32 {
        if len(p2) < len(p1) { std::mem::swap(&mut p1, &mut p2); }
        let k = ((p1.0 * p2.0 + p1.1 * p2.1) / (p1.0 * p1.0 + p1.1 * p1.1)).round();
        if k == 0. { break; }
        p2 = (p2.0 - k * p1.0, p2.1 - k * p1.1);
    }
    let det = p1.0 * p2.1 - p1.1 * p2.0;
    // cell coordinates from vertex 0, so the cell's sides run through vertices (along mesh edges)
    let (ox, oy) = (u[0], v[0]);
    let cell = |x: f64, y: f64| (((x - ox) * p2.1 - (y - oy) * p2.0) / det, ((y - oy) * p1.0 - (x - ox) * p1.1) / det);
    let eps = 1e-9 * len(p1);
    // each triangle moves by its polygon's centre (`Mesh::poly`), so a quad never ends up in two cells
    let mut mid: Map<u32, (f64, f64, f64)> = Map::default();
    for (i, t) in l.t.iter().enumerate() {
        let e = mid.entry(m.poly[l.tris[i] as usize]).or_default();
        for q in t { (e.0, e.1, e.2) = (e.0 + u[*q as usize], e.1 + v[*q as usize], e.2 + 1.); }
    }
    let corner: Vec<[(f64, f64); 3]> = l.t.iter().enumerate().map(|(i, t)| {
        let c = t.map(|q| (u[q as usize], v[q as usize]));
        let s = mid[&m.poly[l.tris[i] as usize]];
        let (a, b) = cell(s.0 / s.2, s.1 / s.2);
        let (fa, fb) = (a.floor(), b.floor());
        c.map(|(x, y)| (x - fa * p1.0 - fb * p2.0, y - fa * p1.1 - fb * p2.1))
    }).collect();
    // new seams: edges whose two sides now disagree
    let at: Map<u32, usize> = tris.iter().enumerate().map(|(i, &t)| (t, i)).collect();
    let mut cut = Set::default();
    for (i, &t) in tris.iter().enumerate() {
        let f = m.f[t as usize];
        for k in 0..3 {
            let (a, b) = (f[k], f[(k + 1) % 3]);
            for &o in &m.edges[&ek(a, b)] {
                let Some(&j) = at.get(&o) else { continue };
                if j == i { continue; }
                let uv = |i: usize, w: u32| corner[i][m.f[tris[i] as usize].iter().position(|&x| x == w).unwrap()];
                let d = |p: (f64, f64), q: (f64, f64)| len((p.0 - q.0, p.1 - q.1));
                if d(uv(i, a), uv(j, a)) > eps * 1e3 || d(uv(i, b), uv(j, b)) > eps * 1e3 { cut.insert(ek(a, b)); }
            }
        }
    }
    let l2 = local_mesh(m, tris, &cut);
    if !l2.is_disk() { return None; }
    let (mut u2, mut v2) = (vec![0.; l2.nv], vec![0.; l2.nv]);
    for (i, t) in l2.t.iter().enumerate() {
        // local_mesh keeps corner order; corners came from `l`'s triangle i in the same order
        let welded = m.f[tris[i] as usize];
        for k in 0..3 {
            let w = l2.orig[t[k] as usize];
            let c = corner[i][welded.iter().position(|&x| x == w).unwrap()];
            u2[t[k] as usize] = c.0;
            v2[t[k] as usize] = c.1;
        }
    }
    Some((l2, u2, v2))
}
