//! Straight strips, like Blender's Follow Active Quads: the soup's triangles paired back into quads across their
//! near-coplanar diagonals, each connected run of quads laid out as a grid of rectangles (every edge loop a straight
//! line along U or V, each ring of edges as long as its 3D edges on average), then the island solved again around
//! those runs held straight.
use crate::chart::{find, Island};
use crate::flatten::{flatten_pinned, frames, measure};
use crate::mesh::*;

/// Straighten the quad runs of `s` (bevels, straps) that lay out within `tol`; keep the result only if the island
/// stays clean and within `tol` (or no worse than it was).
pub fn straighten(m: &Mesh, s: &mut Island, tol: f64) {
    let l = &s.l;
    let quads = pair(m, s);
    if quads.len() < 3 { return; }
    let pt = |v: u32| m.pt(l.orig[v as usize]);
    // edge rings: a quad's opposite sides are one ring, one length
    let mut id: Map<u64, usize> = Map::default();
    for (q, _) in &quads { for k in 0..4 { let n = id.len(); id.entry(ek(q[k], q[(k + 1) % 4])).or_insert(n); } }
    let mut par: Vec<usize> = (0..id.len()).collect();
    for (q, _) in &quads {
        for k in 0..2 {
            let (a, b) = (find(&mut par, id[&ek(q[k], q[k + 1])]), find(&mut par, id[&ek(q[k + 2], q[(k + 3) % 4])]));
            par[a] = b;
        }
    }
    let (mut sum, mut cnt) = (vec![0.; id.len()], vec![0.; id.len()]);
    for (&e, &i) in &id {
        let r = find(&mut par, i);
        sum[r] += dist(pt((e >> 32) as u32), pt(e as u32));
        cnt[r] += 1.;
    }
    let mut ring = |a: u32, b: u32| { let r = find(&mut par, id[&ek(a, b)]); sum[r] / cnt[r] };
    let eps = 1e-6 * sum.iter().sum::<f64>() / cnt.iter().sum::<f64>().max(1.);

    let mut by_edge: Map<u64, Vec<usize>> = Map::default();
    for (i, (q, _)) in quads.iter().enumerate() { for k in 0..4 { by_edge.entry(ek(q[k], q[(k + 1) % 4])).or_default().push(i); } }
    let fr = frames(m, l);
    let (mut done, mut pinned) = (vec![false; quads.len()], vec![false; l.nv]);
    let mut pins: Vec<(usize, f64, f64)> = vec![];
    // a run from each quad not yet taken: the grid grows across shared sides, each next quad standing on the side
    // it shares; a quad that won't fit the grid (a pole, a vertex another run holds) stays out, solved freely
    for seed in 0..quads.len() {
        if done[seed] { continue; }
        done[seed] = true;
        let q0 = quads[seed].0;
        if q0.iter().any(|&v| pinned[v as usize]) { continue; }
        let mut uv: Map<u32, [f64; 2]> = Map::default();
        let (w, h) = (ring(q0[0], q0[1]), ring(q0[1], q0[2]));
        for (k, p) in [[0., 0.], [w, 0.], [w, h], [0., h]].into_iter().enumerate() { uv.insert(q0[k], p); }
        let (mut run, mut queue) = (vec![seed], std::collections::VecDeque::from([seed]));
        while let Some(i) = queue.pop_front() {
            let q = quads[i].0;
            for k in 0..4 {
                for &j in &by_edge[&ek(q[k], q[(k + 1) % 4])] {
                    if done[j] { continue; }
                    let r = quads[j].0;
                    let s0 = (0..4).find(|&s| ek(r[s], r[(s + 1) % 4]) == ek(q[k], q[(k + 1) % 4])).unwrap();
                    let w = [0, 1, 2, 3].map(|x| r[(s0 + x) % 4]);
                    let (a, b) = (uv[&w[0]], uv[&w[1]]);
                    let len = (b[0] - a[0]).hypot(b[1] - a[1]);
                    let h = ring(w[1], w[2]);
                    let n = [-(b[1] - a[1]) / len * h, (b[0] - a[0]) / len * h];
                    let new = [(w[2], [b[0] + n[0], b[1] + n[1]]), (w[3], [a[0] + n[0], a[1] + n[1]])];
                    if new.iter().any(|(v, p)| pinned[*v as usize] || uv.get(v).is_some_and(|o| (o[0] - p[0]).abs() + (o[1] - p[1]).abs() > eps)) { continue; }
                    done[j] = true;
                    uv.extend(new);
                    run.push(j);
                    queue.push_back(j);
                }
            }
        }
        if run.len() < 3 { continue; }
        // the run's own stretch, laid straight: over `tol`, it's a curved patch, not a strip
        let (mut u, mut v) = (s.f.u.clone(), s.f.v.clone());
        for (&k, p) in &uv { u[k as usize] = p[0]; v[k as usize] = p[1]; }
        let f = measure(l, &fr, u, v);
        let tris: Vec<usize> = run.iter().flat_map(|&i| quads[i].1).collect();
        let area: f64 = tris.iter().map(|&t| fr.area[t]).sum();
        let e = tris.iter().map(|&t| f.e[t] * fr.area[t]).sum::<f64>() / area;
        if !(e <= tol) { continue; }
        // held where the run lies now: the rigid fit of the straight grid onto it
        let pts: Vec<(u32, [f64; 2])> = uv.into_iter().collect();
        let mean = |f: &dyn Fn(&(u32, [f64; 2])) -> [f64; 2]| {
            let s = pts.iter().map(f).fold([0., 0.], |a, b| [a[0] + b[0], a[1] + b[1]]);
            [s[0] / pts.len() as f64, s[1] / pts.len() as f64]
        };
        let (cg, cn) = (mean(&|p| p.1), mean(&|p| [s.f.u[p.0 as usize], s.f.v[p.0 as usize]]));
        let (mut dt, mut cr) = (0., 0.);
        for (k, p) in &pts {
            let (x, y) = ([p[0] - cg[0], p[1] - cg[1]], [s.f.u[*k as usize] - cn[0], s.f.v[*k as usize] - cn[1]]);
            dt += x[0] * y[0] + x[1] * y[1];
            cr += x[0] * y[1] - x[1] * y[0];
        }
        let (cs, sn) = (cr.atan2(dt).cos(), cr.atan2(dt).sin());
        for (k, p) in pts {
            let (x, y) = (p[0] - cg[0], p[1] - cg[1]);
            pins.push((k as usize, cn[0] + cs * x - sn * y, cn[1] + sn * x + cs * y));
            pinned[k as usize] = true;
        }
    }
    if pins.is_empty() { return; }
    let f = if pins.len() == l.nv {
        let (mut u, mut v) = (vec![0.; l.nv], vec![0.; l.nv]);
        for &(k, a, b) in &pins { u[k] = a; v[k] = b; }
        measure(l, &fr, u, v)
    } else { flatten_pinned(m, l, &pins) };
    // and no triangle much worse than the island's worst was (a needle squashed by a pinned run)
    let worst = |f: &crate::flatten::Flat| f.e.iter().copied().fold(0., f64::max);
    if f.flips == 0 && !f.self_overlap && f.mean_e <= tol.max(s.f.mean_e) && worst(&f) <= worst(&s.f).max(3. * tol) { s.f = f; }
}

/// The island's triangles paired into quads (corners in winding order, and the two triangles), each pair across
/// their shared longest edge, near-coplanar, and the quad near-rectangular.
fn pair(m: &Mesh, s: &Island) -> Vec<([u32; 4], [usize; 2])> {
    let l = &s.l;
    let pt = |v: u32| m.pt(l.orig[v as usize]);
    let mut on: Map<u64, Vec<usize>> = Map::default();
    for (i, t) in l.t.iter().enumerate() { for k in 0..3 { on.entry(ek(t[k], t[(k + 1) % 3])).or_default().push(i); } }
    let longest = |t: [u32; 3]| (0..3).map(|k| dist(pt(t[k]), pt(t[(k + 1) % 3]))).fold(0., f64::max);
    let corner = |a: u32, b: u32, c: u32| { let (x, y) = (sub(pt(a), pt(b)), sub(pt(c), pt(b))); (dot(x, y) / (norm(x) * norm(y))).abs() };
    let mut cand: Vec<(f64, usize, usize, [u32; 4])> = vec![];
    for (i, t) in l.t.iter().enumerate() {
        for k in 0..3 {
            let (x, y, z1) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
            let Some(&[a, b]) = on.get(&ek(x, y)).map(|v| v.as_slice()) else { continue };
            let j = if a == i { b } else { a };
            if j < i { continue; }
            let u = l.t[j];
            let Some(z2) = u.into_iter().find(|&q| q != x && q != y) else { continue };
            let d = dist(pt(x), pt(y));
            if d < 0.999 * longest(*t) || d < 0.999 * longest(u) { continue; }
            let bend = 1. - dot(m.n[l.tris[i] as usize], m.n[l.tris[j] as usize]);
            let q = [x, z2, y, z1];
            // every corner within 40° of square (cos 50° ≈ 0.64), the pair within ~15° of flat
            let skew = (0..4).map(|c| corner(q[(c + 3) % 4], q[c], q[(c + 1) % 4])).fold(0., f64::max);
            if skew < 0.64 && bend < 0.035 { cand.push((bend + skew, i, j, q)); }
        }
    }
    cand.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut used = vec![false; l.t.len()];
    let mut quads = vec![];
    for (_, i, j, q) in cand {
        if used[i] || used[j] { continue; }
        used[i] = true;
        used[j] = true;
        quads.push((q, [i, j]));
    }
    quads
}
