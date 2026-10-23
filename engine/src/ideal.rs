//! The known ideal unwraps of the core shapes, as checks on a finished result. Only `check` uses these: the
//! unwrapper itself never sees them, it has to arrive at these layouts on its own.
use crate::shapes::{CONE, CYLINDER};
use crate::PartOut;

/// Per triangle: 3D normal, 3D area, UV centroid, UV area.
fn tris(p: &PartOut) -> Vec<([f64; 3], f64, (f64, f64), f64)> {
    (0..p.island.len()).map(|t| {
        let q = |c: usize, k: usize| p.positions[(t * 3 + c) * 3 + k] as f64;
        let w = |c: usize, k: usize| p.uvs[(t * 3 + c) * 2 + k] as f64;
        let (e1, e2) = ([0, 1, 2].map(|k| q(1, k) - q(0, k)), [0, 1, 2].map(|k| q(2, k) - q(0, k)));
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let a2 = ((w(1, 0) - w(0, 0)) * (w(2, 1) - w(0, 1)) - (w(2, 0) - w(0, 0)) * (w(1, 1) - w(0, 1))).abs();
        (n.map(|x| x / l), l / 2., ((w(0, 0) + w(1, 0) + w(2, 0)) / 3., (w(0, 1) + w(1, 1) + w(2, 1)) / 3.), a2 / 2.)
    }).collect()
}

/// UV centroid and UV area of the triangles picked by `f`.
fn centroid(ts: &[([f64; 3], f64, (f64, f64), f64)], f: impl Fn(&[f64; 3]) -> bool) -> ((f64, f64), f64) {
    let (mut x, mut y, mut a) = (0., 0., 0.);
    for (n, _, c, ua) in ts { if f(n) { x += c.0 * ua; y += c.1 * ua; a += ua; } }
    ((x / a, y / a), a)
}

/// UV units per model unit.
fn scale(ts: &[([f64; 3], f64, (f64, f64), f64)]) -> f64 {
    (ts.iter().map(|t| t.3).sum::<f64>() / ts.iter().map(|t| t.1).sum::<f64>()).sqrt()
}

/// The Latin cross: the only one of the cube's 11 nets where a face touches four others, so face-to-face
/// adjacency in the layout must run exactly 4, 2, 1, 1, 1, 1.
pub fn cube_cross(p: &PartOut) -> bool {
    let ts = tris(p);
    let faces: Vec<((f64, f64), f64)> = (0..6).map(|f| centroid(&ts, |n| n[f / 2] * if f % 2 == 0 { 1. } else { -1. } > 0.9)).collect();
    let side = (faces.iter().map(|f| f.1).sum::<f64>() / 6.).sqrt();
    let mut deg: Vec<usize> = (0..6).map(|i| (0..6).filter(|&j| {
        let d = (faces[i].0 .0 - faces[j].0 .0).hypot(faces[i].0 .1 - faces[j].0 .1) / side;
        i != j && (d - 1.).abs() < 0.05
    }).count()).collect();
    deg.sort();
    deg == [1, 1, 1, 1, 2, 4]
}

/// The tin can: the side as one rectangle, both caps outside it on opposite long sides, centred along it.
pub fn tin_can(p: &PartOut) -> bool {
    let ts = tris(p);
    let ((cx, cy), _) = centroid(&ts, |n| n[1].abs() < 0.5);
    // the strip's long axis: principal direction of its triangle centroids
    let (mut sxx, mut sxy, mut syy) = (0., 0., 0.);
    for (n, _, c, a) in &ts { if n[1].abs() < 0.5 { let (dx, dy) = (c.0 - cx, c.1 - cy); sxx += a * dx * dx; sxy += a * dx * dy; syy += a * dy * dy; } }
    let th = 0.5 * (2. * sxy).atan2(sxx - syy);
    let (d, e) = ((th.cos(), th.sin()), (-th.sin(), th.cos()));
    let s = scale(&ts);
    let (len, height) = (std::f64::consts::TAU * CYLINDER.0 * s, CYLINDER.1 * s);
    let caps: Vec<(f64, f64)> = [1., -1.].iter().map(|&sg| {
        let ((gx, gy), _) = centroid(&ts, |n| n[1] * sg > 0.9);
        let (dx, dy) = (gx - cx, gy - cy);
        (dx * d.0 + dy * d.1, dx * e.0 + dy * e.1)
    }).collect();
    caps.iter().all(|c| c.0.abs() < 0.05 * len && c.1.abs() > height / 2.) && caps[0].1 * caps[1].1 < 0.
}

/// A rectangle: the island fills its smallest bounding box (any rotation) to within 3%.
pub fn rectangle(p: &PartOut) -> bool {
    let ts = tris(p);
    let area: f64 = ts.iter().map(|t| t.3).sum();
    let best = (0..180).map(|d| {
        let (c, s) = ((d as f64 / 2.).to_radians().cos(), (d as f64 / 2.).to_radians().sin());
        let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for q in p.uvs.chunks(2) {
            let (x, y) = (c * q[0] as f64 - s * q[1] as f64, s * q[0] as f64 + c * q[1] as f64);
            x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y);
        }
        (x1 - x0) * (y1 - y0)
    }).fold(f64::MAX, f64::min);
    area / best > 0.97
}

/// The cone net: the base disc touching the sector at the middle of its arc, i.e. slant + radius from the
/// tip, on the sector's centre line.
pub fn cone_net(p: &PartOut) -> bool {
    let ts = tris(p);
    let s = scale(&ts);
    let (r, h) = CONE;
    let slant = r.hypot(h);
    // the tip: the corner farthest up the model
    let tip_corner = (0..p.positions.len() / 3).max_by(|&a, &b| p.positions[a * 3 + 1].total_cmp(&p.positions[b * 3 + 1])).unwrap();
    let tip = (p.uvs[tip_corner * 2] as f64, p.uvs[tip_corner * 2 + 1] as f64);
    let (side, _) = centroid(&ts, |n| n[1] > -0.9);
    let (disc, _) = centroid(&ts, |n| n[1] < -0.9);
    let (a, b) = ((side.0 - tip.0, side.1 - tip.1), (disc.0 - tip.0, disc.1 - tip.1));
    let off_line = (a.0 * b.1 - a.1 * b.0).abs() / (a.0.hypot(a.1) * b.0.hypot(b.1));
    let dist = b.0.hypot(b.1) / s;
    off_line < 0.05 && (dist / (slant + r) - 1.).abs() < 0.03
}
