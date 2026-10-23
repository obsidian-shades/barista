//! Charts the way an artist blocks out a hard-surface model: each shell gets the box frame its flat faces line
//! up with, and every triangle goes to the frame side it faces (left, right, top, ...); touching triangles facing
//! the same side make one chart. A pistol slide's left flank comes out as one chart with its grooves and bevels
//! on it, not one chart per facet, and the left and right flanks mirror each other (the "butterfly").
//!
//! Hidden surfaces (a magazine well's inside, a slide's cavity) never share a chart with the outside: a patch
//! that can't see out of the model along any of a cone of rays round its normal is inside, and the inside gets
//! sides of its own. Groove walls still see out (a tilted ray leaves the groove), so they stay on their flank.
//!
//! Smooth regions (feature charts) that are already simple stay whole: a disk, a ring (cylinder side), a closed
//! sphere or torus; tangled ones (bevels chaining a whole slide into one region full of holes) and boxy ones
//! (mostly big flat faces joined by bevels) are split by side. Bits too small to stand alone join the neighbour they share the most border with.
use crate::chart::{feature_charts, find, local_mesh};
use crate::mesh::*;
use rayon::prelude::*;

/// A region whose normals average to less than this is curved (half a cylinder: 0.64), not a face of a box.
const CURVED: f64 = 0.8;
/// Dihedral (degrees) under which triangles count as one flat patch.
const PLANAR: f64 = 10.;
/// A flat patch this share of its region or bigger is a face of a box, not a facet of a curve.
const BIG_PATCH: f64 = 0.1;
/// How much facing its side is worth against border length (see the labelling in `charts`).
const FACING: f64 = 8.;
/// A chart under this share of its shell's area joins a neighbour.
const SMALL: f64 = 0.03;

pub fn charts(m: &Mesh, sharp: f64, seams: &Set<u64>) -> Vec<Vec<u32>> {
    let nt = m.f.len();
    let shell = shells(m);
    let frames = frames(m, &shell, seams);
    let dirs = |t: u32| { let f = frames[&shell[t as usize]]; [f[0], neg(f[0]), f[1], neg(f[1]), f[2], neg(f[2])] };
    let face = |t: u32, n: V3| { let d = dirs(t); (0..6).max_by(|&x, &y| dot(n, d[x]).total_cmp(&dot(n, d[y]))).unwrap() };

    // regions with a side each: 0..6 for the frame's sides, 6..12 for them inside the model, 12 + i for a curved
    // simple region (always alone)
    let fcs = feature_charts(m, sharp, seams);
    let mut planar = vec![0usize; nt];
    for (i, p) in feature_charts(m, PLANAR, seams).iter().enumerate() { for &t in p { planar[t as usize] = i; } }
    let split: Vec<Vec<(Vec<u32>, usize)>> = fcs.par_iter().enumerate().map(|(i, fc)| {
        let l = local_mesh(m, fc, seams);
        let simple = l.is_disk() || (l.chi() == 0 && l.loops.len() == 2) || (l.loops.is_empty() && (l.chi() == 0 || l.chi() == 2));
        let (n, k) = mean_normal(m, fc);
        let patches = pieces(m, fc, seams, |t| planar[t as usize]);
        // a box with bevels is one smooth region too, but most of it lies in big flat patches
        let area = |p: &[u32]| p.iter().map(|&t| m.a[t as usize]).sum::<f64>();
        let total = area(fc);
        let boxy = patches.iter().map(|p| area(p)).filter(|&a| a >= BIG_PATCH * total).sum::<f64>() >= 0.5 * total;
        if simple && !(boxy && patches.len() > 1) { return vec![(fc.clone(), if k < CURVED { 12 + i } else { face(fc[0], n) })]; }
        // tangled or boxy: its flat patches (a groove wall, a bevel, a flank), each facing its own side for now
        patches.into_iter().map(|p| { let s = face(p[0], mean_normal(m, &p).0); (p, s) }).collect()
    }).collect();
    let (regions, mut side): (Vec<Vec<u32>>, Vec<usize>) = split.into_iter().flatten().unzip();
    let inside: Vec<bool> = regions.par_iter().map(|r| hidden(m, r)).collect();
    for (s, &h) in side.iter_mut().zip(&inside) { if *s < 6 && h { *s += 6; } }
    let mut region_of = vec![0usize; nt];
    for (i, r) in regions.iter().enumerate() { for &t in r { region_of[t as usize] = i; } }
    // kept on the mesh: hidden surface is where seams cost least (`chart::seam_cost`)
    let _ = m.hidden.set((0..nt).map(|t| inside[region_of[t]]).collect());
    let area: Vec<f64> = regions.iter().map(|r| r.iter().map(|&t| m.a[t as usize]).sum()).collect();
    let sum: Vec<V3> = regions.iter().map(|r| r.iter().fold([0.; 3], |s, &t| [0, 1, 2].map(|k| s[k] + m.n[t as usize][k] * m.a[t as usize]))).collect();
    let mut shell_area = vec![0.; nt];
    for t in 0..nt { shell_area[shell[t]] += m.a[t]; }

    // region adjacency with shared border length (user seams don't connect)
    let mut nb: Vec<Map<usize, f64>> = vec![Map::default(); regions.len()];
    let mut keys: Vec<&u64> = m.edges.keys().collect();
    keys.sort();
    for &key in keys {
        let ts = &m.edges[&key];
        if seams.contains(&key) || ts.len() != 2 { continue; }
        let (x, y) = (region_of[ts[0] as usize], region_of[ts[1] as usize]);
        if x == y { continue; }
        let len = dist(m.pt((key >> 32) as u32), m.pt((key & 0xffff_ffff) as u32));
        *nb[x].entry(y).or_default() += len;
        *nb[y].entry(x).or_default() += len;
    }

    // Sides settle by trading facing against border (Potts labelling, solved by iterated conditional modes):
    // a region pays α × area × (1 − cos) for the side it's on, plus the length of border it shares with
    // regions on other sides. A thin groove wall bordered on both long edges by the flank it's cut into pays
    // less on the flank than facing its own way; a big face keeps its own side. α scales with the shell
    // (1/√area), so the trade doesn't depend on units.
    let unit = |v: V3| { let l = norm(v).max(1e-300); v.map(|x| x / l) };
    let mut order: Vec<usize> = (0..regions.len()).filter(|&i| side[i] < 12).collect();
    order.sort_by(|&x, &y| area[x].total_cmp(&area[y]).then(x.cmp(&y)));
    for _ in 0..50 {
        let mut changed = false;
        for &i in &order {
            let (d, n) = (dirs(regions[i][0]), unit(sum[i]));
            let alpha = FACING / shell_area[shell[regions[i][0] as usize]].sqrt();
            // inside stays inside: the labels it may take are the inner six
            let base = if inside[i] { 6 } else { 0 };
            let cost = |l: usize| alpha * area[i] * (1. - dot(n, d[l - base])) + nb[i].iter().filter(|(&j, _)| side[j] != l).map(|x| x.1).sum::<f64>();
            let best = (base..base + 6).filter(|&l| l == side[i] || dot(n, d[l - base]) > -0.05)
                .min_by(|&x, &y| cost(x).total_cmp(&cost(y)).then((x != side[i]).cmp(&(y != side[i])))).unwrap();
            if best != side[i] && cost(best) < cost(side[i]) - 1e-12 {
                side[i] = best;
                changed = true;
            }
        }
        if !changed { break; }
    }

    // charts: touching regions on the same side
    let mut par: Vec<usize> = (0..regions.len()).collect();
    for (i, n) in nb.iter().enumerate() {
        for &j in n.keys() {
            if side[i] == side[j] { let (a, b) = (find(&mut par, i), find(&mut par, j)); par[a] = b; }
        }
    }
    // small charts join the neighbouring chart they share the most border with, smallest first, unless that
    // neighbour faces away from them
    loop {
        let mut g_area: Map<usize, f64> = Map::default();
        let mut g_sum: Map<usize, V3> = Map::default();
        let mut g_in: Map<usize, bool> = Map::default();
        let mut border: Map<usize, Map<usize, f64>> = Map::default();
        for i in 0..regions.len() {
            let g = find(&mut par, i);
            *g_area.entry(g).or_default() += area[i];
            g_in.insert(g, inside[i]);
            let s = g_sum.entry(g).or_default();
            for k in 0..3 { s[k] += sum[i][k]; }
            for (&j, &len) in &nb[i] {
                let h = find(&mut par, j);
                if h != g { *border.entry(g).or_default().entry(h).or_default() += len; }
            }
        }
        let shell_of = |g: usize| shell_area[shell[regions[g][0] as usize]];
        let mut small: Vec<(f64, usize)> = g_area.iter().filter(|&(&g, &a)| a < SMALL * shell_of(g)).map(|(&g, &a)| (a, g)).collect();
        small.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
        let unit = |v: V3| { let l = norm(v).max(1e-300); v.map(|x| x / l) };
        // merge every small chart whose target isn't itself merging this round (keeps rounds few, order stable)
        let mut taken = Set::default();
        for (_, g) in small {
            if taken.contains(&g) { continue; }
            let ng = unit(g_sum[&g]);
            let Some(b) = border.get(&g) else { continue };
            // the same kind (inside or out) if there is one next to it
            let near = |same: bool| b.iter().filter(|(h, _)| (!same || g_in[*h] == g_in[&g]) && dot(ng, unit(g_sum[*h])) > -0.2).max_by(|a, b| a.1.total_cmp(b.1).then(b.0.cmp(a.0)));
            let best = near(true).or_else(|| near(false));
            if let Some((&h, _)) = best {
                if taken.contains(&h) { continue; }
                par[g] = h;
                taken.insert(g);
                taken.insert(h);
            }
        }
        if taken.is_empty() { break; }
    }
    let mut out: Map<usize, Vec<u32>> = Map::default();
    for (i, r) in regions.iter().enumerate() { out.entry(find(&mut par, i)).or_default().extend(r); }
    let mut out: Vec<Vec<u32>> = crate::chart::whole(m, out.into_values().collect());
    for c in &mut out { c.sort(); }
    out.sort_by_key(|c| c[0]);
    out
}

fn neg(v: V3) -> V3 { v.map(|x| -x) }

/// Area-weighted mean normal (unit) and how much the normals agree (1 = flat, 0 = they cancel out).
fn mean_normal(m: &Mesh, tris: &[u32]) -> (V3, f64) {
    let (mut s, mut a) = ([0.; 3], 0.);
    for &t in tris {
        for k in 0..3 { s[k] += m.n[t as usize][k] * m.a[t as usize]; }
        a += m.a[t as usize];
    }
    let l = norm(s);
    (s.map(|x| x / l.max(1e-300)), l / a.max(1e-300))
}

/// Edge-connected pieces of `tris` with the same label, not crossing user seams.
fn pieces(m: &Mesh, tris: &[u32], seams: &Set<u64>, label: impl Fn(u32) -> usize) -> Vec<Vec<u32>> {
    let inside: Set<u32> = tris.iter().copied().collect();
    let (mut seen, mut out) = (Set::default(), Vec::new());
    for &s in tris {
        if !seen.insert(s) { continue; }
        let (mut comp, mut q, ls) = (vec![s], 0, label(s));
        while q < comp.len() {
            let t = comp[q];
            q += 1;
            let f = m.f[t as usize];
            for k in 0..3 {
                let key = ek(f[k], f[(k + 1) % 3]);
                if seams.contains(&key) { continue; }
                for &u in &m.edges[&key] {
                    if inside.contains(&u) && label(u) == ls && seen.insert(u) { comp.push(u); }
                }
            }
        }
        out.push(comp);
    }
    out
}

/// Connected shell of every triangle.
fn shells(m: &Mesh) -> Vec<usize> {
    let mut par: Vec<usize> = (0..m.f.len()).collect();
    for ts in m.edges.values() {
        for w in ts.windows(2) { let (a, b) = (find(&mut par, w[0] as usize), find(&mut par, w[1] as usize)); par[a] = b; }
    }
    (0..m.f.len()).map(|t| find(&mut par, t)).collect()
}

/// Per shell root: the frame (three orthonormal axes) its faces line up with best. Candidates come from pairs
/// of its biggest flat patches' normals; the score is area × cos² to the nearest axis over all its triangles.
fn frames(m: &Mesh, shell: &[usize], seams: &Set<u64>) -> Map<usize, [V3; 3]> {
    let mut patches: Map<usize, Vec<(f64, V3)>> = Map::default();
    for p in feature_charts(m, 10., seams) {
        let (n, k) = mean_normal(m, &p);
        if k < 0.98 { continue; }
        let a: f64 = p.iter().map(|&t| m.a[t as usize]).sum();
        patches.entry(shell[p[0] as usize]).or_default().push((a, n));
    }
    let mut tris: Map<usize, Vec<u32>> = Map::default();
    for t in 0..m.f.len() { tris.entry(shell[t]).or_default().push(t as u32); }
    tris.into_par_iter().map(|(s, ts)| {
        let mut flat = patches.get(&s).cloned().unwrap_or_default();
        flat.sort_by(|x, y| y.0.total_cmp(&x.0));
        flat.truncate(8);
        let mut cands = vec![[[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]];
        for &(_, a) in &flat {
            for &(_, n) in &flat {
                let b = sub(n, a.map(|x| x * dot(n, a)));
                let l = norm(b);
                if l < 0.7 { continue; }
                let b = b.map(|x| x / l);
                cands.push([a, b, cross(a, b)]);
            }
            let t = if a[0].abs() < 0.9 { [1., 0., 0.] } else { [0., 1., 0.] };
            let b = cross(a, t);
            let b = b.map(|x| x / norm(b));
            cands.push([a, b, cross(a, b)]);
        }
        let score = |f: &[V3; 3]| ts.iter().map(|&t| {
            let c = f.iter().map(|d| dot(m.n[t as usize], *d).abs()).fold(0., f64::max);
            m.a[t as usize] * c * c
        }).sum::<f64>();
        (s, cands.into_iter().max_by(|x, y| score(x).total_cmp(&score(y))).unwrap())
    }).collect()
}

/// Whether a region is hidden inside the model: from its biggest triangle, five rays (along its normal and 60°
/// off it each way) all hit the mesh again.
fn hidden(m: &Mesh, r: &[u32]) -> bool {
    let t = *r.iter().max_by(|&&x, &&y| m.a[x as usize].total_cmp(&m.a[y as usize])).unwrap();
    let n = m.n[t as usize];
    let c = m.centroid(t);
    let o = [0, 1, 2].map(|k| c[k] + n[k] * 1e-5);
    let e1 = cross(n, if n[0].abs() < 0.9 { [1., 0., 0.] } else { [0., 1., 0.] });
    let e1 = e1.map(|x| x / norm(e1));
    let e2 = cross(n, e1);
    let tilt = |e: V3, s: f64| [0, 1, 2].map(|k| 0.5 * n[k] + s * 0.75f64.sqrt() * e[k]);
    let dirs = [n, tilt(e1, 1.), tilt(e1, -1.), tilt(e2, 1.), tilt(e2, -1.)];
    dirs.iter().all(|&d| hits(m, o, d, t))
}

/// Whether a ray from `o` along `d` hits any triangle but `skip` (Möller–Trumbore).
fn hits(m: &Mesh, o: V3, d: V3, skip: u32) -> bool {
    // ponytail: brute force over the part's triangles; a BVH if parts get to hundreds of thousands of triangles
    m.f.iter().enumerate().any(|(i, f)| {
        if i as u32 == skip { return false; }
        let [a, b, c] = f.map(|v| m.pt(v));
        let (e1, e2) = (sub(b, a), sub(c, a));
        let p = cross(d, e2);
        let det = dot(e1, p);
        if det.abs() < 1e-14 { return false; }
        let s = sub(o, a);
        let u = dot(s, p) / det;
        if !(0. ..=1.).contains(&u) { return false; }
        let q = cross(s, e1);
        let v = dot(d, q) / det;
        v >= 0. && u + v <= 1. && dot(e2, q) / det > 1e-6
    })
}
