use barista::mesh::Mesh;
use barista::stroke::{knife, snap};
use barista::{shapes, unwrap, Params, PartIn};

const CHARTS: Params = Params { sharp: 45., tol: 0.08, seam_weight: 0.1, join: false, one_atlas: false };

/// Points along a line, a + t(b − a).
fn line(a: [f32; 3], b: [f32; 3], n: usize) -> Vec<f32> {
    (0..=n).flat_map(|i| { let t = i as f32 / n as f32; [0, 1, 2].map(|k| a[k] + (b[k] - a[k]) * t) }).collect()
}

fn area(soup: &[f32]) -> f64 {
    soup.chunks(9).map(|t| {
        let p = |c: usize| [t[c * 3] as f64, t[c * 3 + 1] as f64, t[c * 3 + 2] as f64];
        let (a, b, c) = (p(0), p(1), p(2));
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() / 2.
    }).sum()
}

#[test]
fn snap_follows_a_wobbly_stroke_onto_the_grid_line() {
    let cube = shapes::get("cube").unwrap();
    // drawn a little off the x = 0 grid line of the +z face, wobbling
    let stroke: Vec<f32> = (0..=40).flat_map(|i| {
        let y = -0.48 + 0.96 * i as f32 / 40.;
        [0.03 * (i as f32 * 0.7).sin(), y, 0.5]
    }).collect();
    let seams = snap(&cube, &stroke).unwrap();
    assert!(seams.len() >= 6 * 3, "too few edges: {}", seams.len() / 6);
    for p in seams.chunks(3) { assert!(p[0].abs() < 1e-6 && (p[2] - 0.5).abs() < 1e-6, "edge off the line at {p:?}"); }
    let st = unwrap(&[PartIn { name: "cube".into(), positions: cube, seams, ..Default::default() }], CHARTS).unwrap().stats;
    assert_eq!((st.islands, st.flips), (7, 0), "the face should be split in two");
}

#[test]
fn snap_along_the_equator_stays_on_it() {
    let sphere = shapes::get("sphere").unwrap();
    let stroke: Vec<f32> = (0..=60).flat_map(|i| { let a = std::f32::consts::PI * i as f32 / 60.; [a.cos(), 0.01, a.sin()] }).collect();
    let seams = snap(&sphere, &stroke).unwrap();
    assert!(seams.len() / 6 >= 20);
    for p in seams.chunks(3) { assert!(p[1].abs() < 1e-5, "left the equator at {p:?}"); }
}

#[test]
fn knife_cuts_exactly_where_drawn_and_keeps_the_mesh_whole() {
    let cube = shapes::get("cube").unwrap();
    // x = 0.13 is between grid lines: only a real cut through faces can follow it. Over the top edge, seen from above-front.
    let mut stroke = line([0.13, -0.45, 0.5], [0.13, 0.5, 0.5], 30);
    stroke.extend(line([0.13, 0.5, 0.5], [0.13, 0.5, -0.45], 30));
    let out = knife(&cube, &stroke, [0.13, 3., 3.]).unwrap();
    assert!(out.seams.len() / 6 >= 8, "too few cut edges: {}", out.seams.len() / 6);
    for p in out.seams.chunks(3) { assert!((p[0] - 0.13).abs() < 1e-4, "cut off the stroke at {p:?}"); }
    assert!(out.positions.len() > cube.len(), "no faces were cut");
    assert!((area(&out.positions) - area(&cube)).abs() < 1e-4, "area changed");
    // still one closed, manifold surface: every edge between exactly two triangles
    let m = Mesh::from_soup(&out.positions).unwrap();
    assert!(m.edges.values().all(|t| t.len() == 2), "the cut left holes or non-manifold edges");
    // and it unwraps cleanly with the cut as seams
    let st = unwrap(&[PartIn { name: "cube".into(), positions: out.positions, seams: out.seams, ..Default::default() }], Params::default()).unwrap().stats;
    assert_eq!((st.flips, st.overlap < 0.001), (0, true));
}

#[test]
fn knife_on_empty_or_tiny_strokes_changes_nothing() {
    let cube = shapes::get("cube").unwrap();
    assert_eq!(knife(&cube, &[0.1, 0.1, 0.5], [0., 0., 5.]).unwrap().positions, cube);
    // a stroke inside one face never reaches an edge: nothing to cut
    assert!(knife(&cube, &line([0.01, 0.01, 0.5], [0.02, 0.02, 0.5], 3), [0., 0., 5.]).unwrap().seams.is_empty());
}
