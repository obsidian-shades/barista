use barista::{mesh::Mesh, symmetry, unwrap_soup, Params};

/// A house-shaped prism, sheared so its only mirror plane is x = 0: the right half built, the left half its mirror.
fn house() -> Vec<f32> {
    let prof = [(-1., 0.), (0., 0.), (1., 0.), (1., 1.), (0., 1.8), (-1., 1.)];
    let at = |x: f64, y: f64, z: f64| [x, y + 0.3 * z, z];
    let mut tris: Vec<[[f64; 3]; 3]> = Vec::new();
    for j in 0..4 {
        let (z0, z1) = (-1. + 0.5 * j as f64, -0.5 + 0.5 * j as f64);
        for i in 0..prof.len() {
            let (a, b) = (prof[i], prof[(i + 1) % prof.len()]);
            let q = [at(a.0, a.1, z0), at(b.0, b.1, z0), at(b.0, b.1, z1), at(a.0, a.1, z1)];
            tris.extend([[q[0], q[1], q[2]], [q[0], q[2], q[3]]]);
        }
    }
    for (z, c) in [(-1., 0.75), (1., 0.75)] {
        for i in 0..prof.len() {
            let (a, b) = (prof[i], prof[(i + 1) % prof.len()]);
            tris.push([at(0., c, z), at(a.0, a.1, z), at(b.0, b.1, z)]);
        }
    }
    let right: Vec<_> = tris.into_iter().filter(|t| t.iter().map(|p| p[0]).sum::<f64>() > 0.).collect();
    let left = right.iter().map(|t| [t[0], t[2], t[1]].map(|p| [-p[0], p[1], p[2]]));
    right.iter().copied().chain(left).flatten().flatten().map(|x| x as f32).collect()
}

#[test]
fn mirrored_shape_unwraps_into_mirrored_islands() {
    let soup = house();
    let s = symmetry::find(&Mesh::from_soup(&soup).unwrap()).expect("one mirror plane");
    assert!(s.n[0].abs() > 0.999, "plane {:?}", s.n);

    let out = unwrap_soup(&soup, Params::default()).unwrap();
    assert_eq!((out.stats.flips, out.stats.overlap < 0.001), (0, true));
    let p = &out.parts[0];
    let n = p.island.len();
    let corner = |t: usize, k: usize| ([0, 1, 2].map(|i| p.positions[(t * 3 + k) * 3 + i]), [p.uvs[(t * 3 + k) * 2], p.uvs[(t * 3 + k) * 2 + 1]]);
    let centre = |t: usize| [0, 1, 2].map(|i| (0..3).map(|k| corner(t, k).0[i]).sum::<f32>() / 3.);
    let near = |a: [f32; 3], b: [f32; 3]| (0..3).all(|i| (a[i] - b[i]).abs() < 1e-4);
    for t in (0..n).filter(|&t| centre(t)[0] > 0.) {
        let c = centre(t);
        let m = (0..n).find(|&u| near(centre(u), [-c[0], c[1], c[2]])).expect("mirror triangle");
        // its own island, on the other half; laid out as the same shape, flipped
        assert_ne!(p.island[t], p.island[m]);
        let uv_of = |u: usize, q: [f32; 3]| (0..3).map(|k| corner(u, k)).find(|x| near(x.0, q)).unwrap().1;
        let pair: Vec<([f32; 2], [f32; 2])> = (0..3).map(|k| { let (q, a) = corner(t, k); (a, uv_of(m, [-q[0], q[1], q[2]])) }).collect();
        let len = |x: [f32; 2], y: [f32; 2]| (x[0] - y[0]).hypot(x[1] - y[1]);
        let area = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        for k in 0..3 {
            let (a, b) = (pair[k], pair[(k + 1) % 3]);
            assert!((len(a.0, b.0) - len(a.1, b.1)).abs() < 1e-4, "edge {k} of triangle {t}");
        }
        let (x, y) = (area(pair[0].0, pair[1].0, pair[2].0), area(pair[0].1, pair[1].1, pair[2].1));
        assert!(x * y < 0., "triangle {t} isn't flipped in its mirror");
    }
}
