//! The core shapes, as triangle soups. Same proportions as the three.js primitives the first prototype used.
//! Winding doesn't matter: `Mesh::from_soup` makes it consistent and outward.
use crate::mesh::{cross, norm, sub, V3};
use std::f64::consts::{PI, TAU};

pub const NAMES: [&str; 7] = ["cube", "cylinder", "cone", "sphere", "torus", "capsule", "knot"];
/// (radius, height) of the cylinder and the cone.
pub const CYLINDER: (f64, f64) = (0.5, 1.5);
pub const CONE: (f64, f64) = (0.7, 1.5);

pub fn get(name: &str) -> Option<Vec<f32>> {
    Some(match name {
        "cube" => cube(4),
        "cylinder" => { let (r, h) = CYLINDER; lathe(&line(&[((0., -h / 2.), 0), ((r, -h / 2.), 1), ((r, h / 2.), 6), ((0., h / 2.), 1)]), 48) }
        "cone" => { let (r, h) = CONE; lathe(&line(&[((0., -h / 2.), 0), ((r, -h / 2.), 1), ((0., h / 2.), 6)]), 48) }
        "sphere" => lathe(&arc(0., 1., -PI / 2., PI / 2., 32), 48),
        "torus" => quads(64, 32, |i, j| {
            let (a, b) = (TAU * i as f64 / 64., TAU * j as f64 / 32.);
            [(1. + 0.4 * b.cos()) * a.cos(), (1. + 0.4 * b.cos()) * a.sin(), 0.4 * b.sin()]
        }),
        "capsule" => lathe(&[arc(-0.5, 0.5, -PI / 2., 0., 8), arc(0.5, 0.5, 0., PI / 2., 8)].concat(), 32),
        "knot" => knot(1., 0.3, 160, 24, 2., 3.),
        _ => return None,
    })
}

/// Grid of quads over `f(i, j)`, i ≤ nu, j ≤ nv; seams that meet (f(nu, j) = f(0, j)) are welded later.
fn quads(nu: usize, nv: usize, f: impl Fn(usize, usize) -> V3) -> Vec<f32> {
    let mut s = Vec::with_capacity(nu * nv * 18);
    for i in 0..nu {
        for j in 0..nv {
            let (a, b, c, d) = (f(i, j), f(i + 1, j), f(i + 1, j + 1), f(i, j + 1));
            for q in [a, b, c, a, c, d] { s.extend(q.map(|x| x as f32)); }
        }
    }
    s
}

/// Spin a (radius, height) profile round the y axis.
fn lathe(profile: &[(f64, f64)], seg: usize) -> Vec<f32> {
    quads(profile.len() - 1, seg, |i, j| {
        let ((r, y), a) = (profile[i], TAU * j as f64 / seg as f64);
        [r * a.cos(), y, r * a.sin()]
    })
}

/// Polyline through points, each segment cut into the given number of pieces.
fn line(pts: &[((f64, f64), usize)]) -> Vec<(f64, f64)> {
    let mut out = vec![pts[0].0];
    for w in pts.windows(2) {
        let ((a, _), (b, n)) = (w[0], w[1]);
        for k in 1..=n {
            let t = k as f64 / n as f64;
            out.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
        }
    }
    out
}

/// Profile arc of radius `r` centred on the axis at height `cy`, angles from the equator.
fn arc(cy: f64, r: f64, a0: f64, a1: f64, n: usize) -> Vec<(f64, f64)> {
    (0..=n).map(|k| { let a = a0 + (a1 - a0) * k as f64 / n as f64; (r * a.cos(), cy + r * a.sin()) }).collect()
}

fn cube(n: usize) -> Vec<f32> {
    let mut s = Vec::new();
    for axis in 0..3 {
        for side in [-0.5, 0.5] {
            s.extend(quads(n, n, |i, j| {
                let mut p = [0.; 3];
                p[axis] = side;
                p[(axis + 1) % 3] = -0.5 + i as f64 / n as f64;
                p[(axis + 2) % 3] = -0.5 + j as f64 / n as f64;
                p
            }));
        }
    }
    s
}

/// three.js' TorusKnotGeometry: a tube round a (p, q) knot, with its frame from two nearby curve points.
fn knot(radius: f64, tube: f64, nu: usize, nv: usize, p: f64, q: f64) -> Vec<f32> {
    let curve = |u: f64| {
        let w = q / p * u;
        [radius * (2. + w.cos()) * 0.5 * u.cos(), radius * (2. + w.cos()) * u.sin() * 0.5, radius * w.sin() * 0.5]
    };
    let unit = |a: V3| { let l = norm(a); a.map(|x| x / l) };
    quads(nu, nv, |i, j| {
        let (u, v) = (i as f64 / nu as f64 * p * TAU, j as f64 / nv as f64 * TAU);
        let (p1, p2) = (curve(u), curve(u + 0.01));
        let t = sub(p2, p1);
        let b = unit(cross(t, [p1[0] + p2[0], p1[1] + p2[1], p1[2] + p2[2]]));
        let n = unit(cross(b, t));
        let (cx, cy) = (-tube * v.cos(), tube * v.sin());
        [p1[0] + cx * n[0] + cy * b[0], p1[1] + cx * n[1] + cy * b[1], p1[2] + cx * n[2] + cy * b[2]]
    })
}
