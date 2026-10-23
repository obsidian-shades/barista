//! Hand edits: relax undoes a squashed island, stitch glues two cube faces along their shared edge.
use auto_unwrap::edit::{relax, reseam, stitch, IslandIn, ReseamIn, Reseamed};
use auto_unwrap::{shapes, unwrap_soup, Params};

/// Each island of the result as the editor holds it: xyz and uv per corner.
fn islands(p: Params) -> Vec<IslandIn> {
    let out = unwrap_soup(&shapes::get("cube").unwrap(), p).unwrap();
    let part = &out.parts[0];
    let n = part.island.iter().max().unwrap() + 1;
    (0..n).map(|id| {
        let ts: Vec<usize> = (0..part.island.len()).filter(|&t| part.island[t] == id).collect();
        IslandIn {
            positions: ts.iter().flat_map(|&t| part.positions[t * 9..t * 9 + 9].to_vec()).collect(),
            uvs: ts.iter().flat_map(|&t| part.uvs[t * 6..t * 6 + 6].to_vec()).collect(),
        }
    }).collect()
}

/// UV length over 3D length for every triangle edge: (min, max).
fn ratios(s: &IslandIn, uvs: &[f32]) -> (f32, f32) {
    let (mut lo, mut hi) = (f32::MAX, 0f32);
    for c in 0..uvs.len() / 2 {
        let d = c - c % 3 + (c + 1) % 3;
        let p = |i: usize, k: usize| s.positions[i * 3 + k];
        let l3 = (0..3).map(|k| (p(d, k) - p(c, k)).powi(2)).sum::<f32>().sqrt();
        let l2 = ((uvs[d * 2] - uvs[c * 2]).powi(2) + (uvs[d * 2 + 1] - uvs[c * 2 + 1]).powi(2)).sqrt();
        lo = lo.min(l2 / l3);
        hi = hi.max(l2 / l3);
    }
    (lo, hi)
}

#[test]
fn relax_unsquashes() {
    let mut isl = islands(Params::default());
    assert_eq!(isl.len(), 1);
    let s = &mut isl[0];
    for c in 0..s.uvs.len() / 2 { s.uvs[c * 2] *= 1.5; }
    let (lo, hi) = ratios(s, &s.uvs);
    assert!(hi / lo > 1.4, "squashed: {lo} {hi}");
    let out = relax(s).unwrap();
    let (lo, hi) = ratios(s, &out);
    assert!(hi / lo < 1.02, "relaxed: {lo} {hi}");
}

#[test]
fn stitch_glues_faces() {
    let isl = islands(Params { join: false, ..Params::default() });
    assert_eq!(isl.len(), 6);
    let key = |s: &IslandIn, c: usize| s.positions[c * 3..c * 3 + 3].iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    let a = &isl[0];
    let b = isl[1..].iter().find(|b| (0..b.uvs.len() / 2).filter(|&c| (0..a.uvs.len() / 2).any(|d| key(a, d) == key(b, c))).count() >= 2).unwrap();
    let [ua, ub] = stitch(a, b).unwrap();
    // corners at the same place on the model now meet in UV too
    let glued = (0..ub.len() / 2).filter(|&c| (0..ua.len() / 2).any(|d| key(a, d) == key(b, c) && (ua[d * 2] - ub[c * 2]).abs() + (ua[d * 2 + 1] - ub[c * 2 + 1]).abs() < 1e-5)).count();
    assert!(glued >= 2, "{glued} corners glued");
    // the first island stays where it was
    let moved = a.uvs.iter().zip(&ua).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
    assert!(moved < 1e-3, "first island moved {moved}");
}

/// Edges shared by two triangles (s, t), as their endpoints (6 numbers), where `pick(s, t, same UVs at both ends)`.
fn edges_where(o: &auto_unwrap::PartOut, pick: impl Fn(usize, usize, bool) -> bool) -> Vec<(usize, usize, Vec<f32>)> {
    let n = o.island.len();
    let mut out = Vec::new();
    for s in 0..n {
        for t in s + 1..n {
            let shared: Vec<(usize, usize)> = (0..3).flat_map(|i| (0..3).map(move |j| (i, j)))
                .filter(|&(i, j)| (0..3).all(|k| o.positions[s * 9 + i * 3 + k] == o.positions[t * 9 + j * 3 + k])).collect();
            if shared.len() != 2 { continue; }
            let same_uv = shared.iter().all(|&(i, j)| o.uvs[s * 6 + i * 2..s * 6 + i * 2 + 2] == o.uvs[t * 6 + j * 2..t * 6 + j * 2 + 2]);
            if pick(s, t, same_uv) {
                out.push((s, t, shared.iter().flat_map(|&(i, _)| o.positions[s * 9 + i * 3..s * 9 + i * 3 + 3].to_vec()).collect()));
            }
        }
    }
    out
}

#[test]
fn reseam_touches_only_its_islands() {
    let out = unwrap_soup(&shapes::get("cube").unwrap(), Params { join: false, ..Params::default() }).unwrap();
    let o = &out.parts[0];
    let run = |seams: Vec<f32>, changed: Vec<f32>| reseam(&ReseamIn {
        positions: o.positions.clone(), uvs: o.uvs.clone(), stretch: o.stretch.clone(), island: o.island.clone(), seams, changed, pins: vec![], faces: vec![], live: false, manual: false,
    }, &Params::default()).unwrap();
    let count = |ids: &[u32]| ids.iter().collect::<std::collections::HashSet<_>>().len();
    let untouched = |r: &Reseamed, hit: &[u32]| (0..o.island.len()).filter(|&t| !hit.contains(&o.island[t]))
        .all(|t| r.island[t] == o.island[t] && r.uvs[t * 6..t * 6 + 6] == o.uvs[t * 6..t * 6 + 6]);

    // a seam across a face's corner cuts that triangle off, nothing else moves
    let inside = edges_where(o, |s, t, same| same && o.island[s] == o.island[t]);
    let (s, r) = inside.into_iter().map(|(s, _, e)| (s, run(e.clone(), e))).find(|(_, r)| count(&r.island) == count(&o.island) + 1)
        .expect("some seam splits a face");
    assert!(untouched(&r, &[o.island[s]]));
    assert!(r.stretch.iter().all(|&x| x >= 0.), "flipped");

    // a removed seam on a cube edge joins its two faces there, nothing else moves
    let (s, t, e) = edges_where(o, |s, t, _| o.island[s] != o.island[t]).swap_remove(0);
    let r = run(vec![], e);
    assert_eq!(r.island[s], r.island[t]);
    assert_eq!(count(&r.island), count(&o.island) - 1);
    assert!(untouched(&r, &[o.island[s], o.island[t]]));
    assert!(r.stretch.iter().all(|&x| x >= 0.), "flipped");
}

#[test]
fn reseam_keeps_pins() {
    let out = unwrap_soup(&shapes::get("cube").unwrap(), Params { join: false, ..Params::default() }).unwrap();
    let o = &out.parts[0];
    // a removed seam joins two faces; two corners of the bigger-id face pinned, moved off where the solve would put them
    let (s, _, e) = edges_where(o, |s, t, _| o.island[s] != o.island[t]).swap_remove(0);
    let mut uvs = o.uvs.clone();
    let pins: Vec<u32> = (0..3).map(|k| (s * 3 + k) as u32).take(2).collect();
    for &c in &pins { uvs[c as usize * 2] += 0.05; }
    let r = reseam(&ReseamIn {
        positions: o.positions.clone(), uvs: uvs.clone(), stretch: o.stretch.clone(), island: o.island.clone(), seams: vec![], changed: e, pins: pins.clone(), faces: vec![], live: false, manual: false,
    }, &Params::default()).unwrap();
    for &c in &pins {
        let c = c as usize;
        assert!((r.uvs[c * 2] - uvs[c * 2]).abs() + (r.uvs[c * 2 + 1] - uvs[c * 2 + 1]).abs() < 1e-5, "pin moved");
    }
    assert!(r.stretch.iter().all(|&x| x >= 0.), "flipped");
}

#[test]
fn unwrap_selected_faces_heals_and_stays() {
    let out = unwrap_soup(&shapes::get("cube").unwrap(), Params { join: false, ..Params::default() }).unwrap();
    let o = &out.parts[0];
    // tear one triangle of island 0 off its neighbours by hand, then unwrap that island's faces (U)
    let faces: Vec<u32> = (0..o.island.len() as u32).filter(|&t| o.island[t as usize] == o.island[0]).collect();
    let mut uvs = o.uvs.clone();
    for k in 0..6 { uvs[k] += 0.3; }
    let r = reseam(&ReseamIn {
        positions: o.positions.clone(), uvs, stretch: o.stretch.clone(), island: o.island.clone(), seams: vec![], changed: vec![], pins: vec![], faces: faces.clone(), live: false, manual: false,
    }, &Params::default()).unwrap();
    // one island again, back where the face was, nothing else touched
    let ids: std::collections::HashSet<u32> = faces.iter().map(|&t| r.island[t as usize]).collect();
    assert_eq!(ids.len(), 1);
    let moved = (0..o.island.len()).filter(|&t| !faces.contains(&(t as u32))).any(|t| r.uvs[t * 6..t * 6 + 6] != o.uvs[t * 6..t * 6 + 6]);
    assert!(!moved);
    let drift = faces.iter().flat_map(|&t| (0..6).map(move |k| t as usize * 6 + k)).map(|i| (r.uvs[i] - o.uvs[i]).abs()).fold(0f32, f32::max);
    assert!(drift < 0.05, "drifted {drift}");
}

#[test]
fn live_unwrap_follows_pins() {
    let out = unwrap_soup(&shapes::get("cube").unwrap(), Params { join: false, ..Params::default() }).unwrap();
    let o = &out.parts[0];
    let faces: Vec<u32> = (0..o.island.len() as u32).filter(|&t| o.island[t as usize] == o.island[0]).collect();
    // pin two far corners of the face's island and pull one of them away
    let corners: Vec<usize> = faces.iter().flat_map(|&t| (0..3).map(move |k| t as usize * 3 + k)).collect();
    let a = corners[0];
    let d = |c: usize| (o.uvs[c * 2] - o.uvs[a * 2]).hypot(o.uvs[c * 2 + 1] - o.uvs[a * 2 + 1]);
    let b = *corners.iter().max_by(|&&x, &&y| d(x).total_cmp(&d(y))).unwrap();
    let mut uvs = o.uvs.clone();
    uvs[b * 2] += 0.1;
    let pins = vec![a as u32, b as u32];
    let r = reseam(&ReseamIn {
        positions: o.positions.clone(), uvs: uvs.clone(), stretch: o.stretch.clone(), island: o.island.clone(), seams: vec![], changed: vec![], pins: pins.clone(), faces, live: true, manual: false,
    }, &Params::default()).unwrap();
    for &c in &pins { assert!((r.uvs[c as usize * 2] - uvs[c as usize * 2]).abs() < 1e-5, "pin moved"); }
    assert_eq!(r.island, o.island, "live keeps island ids");
    assert!(corners.iter().any(|&c| c != a && c != b && (r.uvs[c * 2] - o.uvs[c * 2]).abs() > 1e-3), "the rest should follow");
}

#[test]
fn manual_cuts_only_the_seams() {
    let out = unwrap_soup(&shapes::get("cube").unwrap(), Params { join: false, ..Params::default() }).unwrap();
    let o = &out.parts[0];
    let all: Vec<u32> = (0..o.island.len() as u32).collect();
    let run = |seams: Vec<f32>| reseam(&ReseamIn {
        positions: o.positions.clone(), uvs: o.uvs.clone(), stretch: o.stretch.clone(), island: o.island.clone(), seams, changed: vec![], pins: vec![], faces: all.clone(), live: false, manual: true,
    }, &Params::default()).unwrap();
    let count = |ids: &[u32]| ids.iter().collect::<std::collections::HashSet<_>>().len();
    // no seams at all: the closed cube stays one island (projected flat), nothing cut for it
    assert_eq!(count(&run(vec![]).island), 1);
    // the auto unwrap's borders as seams: the same islands, each a clean flat face
    let seams: Vec<f32> = edges_where(o, |s, t, _| o.island[s] != o.island[t]).into_iter().flat_map(|e| e.2).collect();
    let r = run(seams);
    assert_eq!(count(&r.island), count(&o.island));
    assert!(r.stretch.iter().all(|&x| (0. ..0.01).contains(&x)), "faces cut along their edges flatten exactly");
}

#[test]
fn manual_cut_keeps_its_size() {
    // seaming by hand from nothing: the closed cube projected flat, then the top face's outline cut
    let out = unwrap_soup(&shapes::get("cube").unwrap(), Params { join: false, ..Params::default() }).unwrap();
    let o = &out.parts[0];
    let all: Vec<u32> = (0..o.island.len() as u32).collect();
    let flat = reseam(&ReseamIn {
        positions: o.positions.clone(), uvs: o.uvs.clone(), stretch: o.stretch.clone(), island: o.island.clone(), seams: vec![], changed: vec![], pins: vec![], faces: all, live: false, manual: true,
    }, &Params::default()).unwrap();
    let top = o.positions.iter().skip(1).step_by(3).fold(f32::MIN, |a, &b| a.max(b));
    let up = |t: usize| (0..3).all(|k| o.positions[t * 9 + k * 3 + 1] == top);
    let ring: Vec<f32> = edges_where(o, |s, t, _| up(s) != up(t)).into_iter().flat_map(|e| e.2).collect();
    let r = reseam(&ReseamIn {
        positions: o.positions.clone(), uvs: flat.uvs.clone(), stretch: flat.stretch, island: flat.island, seams: ring.clone(), changed: ring, pins: vec![], faces: vec![], live: false, manual: true,
    }, &Params::default()).unwrap();
    let area = |uv: &[f32]| uv.chunks_exact(6).map(|c| ((c[2] - c[0]) * (c[5] - c[1]) - (c[4] - c[0]) * (c[3] - c[1])).abs() / 2.).sum::<f32>();
    assert_eq!(r.island.iter().collect::<std::collections::HashSet<_>>().len(), 2);
    // the two islands come back at the size the shell had, not shrunk onto the projection
    assert!(area(&r.uvs) > 0.5 * area(&flat.uvs), "shrank: {} → {}", area(&flat.uvs), area(&r.uvs));
}

#[test]
fn stitch_stays_stitched() {
    // the cross: one island whose own seams close the cube; stitch one of them
    let out = unwrap_soup(&shapes::get("cube").unwrap(), Params::default()).unwrap();
    let o = &out.parts[0];
    let (s, t, e) = edges_where(o, |s, t, same| !same && o.island[s] == o.island[t]).swap_remove(0);
    // every other seam stays
    let seams: Vec<f32> = edges_where(o, |s, t, same| !same || o.island[s] != o.island[t]).into_iter().filter(|x| x.2 != e).flat_map(|x| x.2).collect();
    let r = reseam(&ReseamIn {
        positions: o.positions.clone(), uvs: o.uvs.clone(), stretch: o.stretch.clone(), island: o.island.clone(), seams, changed: e.clone(), pins: vec![], faces: vec![], live: false, manual: false,
    }, &Params::default()).unwrap();
    // the two sides meet in UV along the stitched edge
    let uv_at = |t: usize, p: &[f32]| (0..3).find(|&k| o.positions[t * 9 + k * 3..t * 9 + k * 3 + 3] == *p).map(|k| (r.uvs[t * 6 + k * 2], r.uvs[t * 6 + k * 2 + 1])).unwrap();
    assert_eq!(r.island[s], r.island[t]);
    for p in e.chunks_exact(3) { let (a, b) = (uv_at(s, p), uv_at(t, p)); assert!((a.0 - b.0).abs() + (a.1 - b.1).abs() < 1e-5, "apart: {a:?} {b:?}"); }
}
