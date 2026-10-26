//! The seam judge (`engine/src/judge.rs`): its numbers have to say the right thing about cuts whose quality is known
//! by construction, or they can't be trusted on the gun.
use barista::judge;
use barista::mesh::Mesh;
use barista::{chart, shapes, unwrap, unwrap_soup, Params, PartIn};

/// A flat `n × n` grid of quads over [0,1]², as a triangle soup (two triangles per cell, split on the longer diagonal).
fn grid(n: usize) -> Vec<f32> {
    let mut s = Vec::new();
    let p = |i: usize, j: usize| [i as f32 / n as f32, j as f32 / n as f32, 0.];
    for i in 0..n {
        for j in 0..n {
            let (a, b, c, d) = (p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1));
            for q in [a, b, c, a, c, d] { s.extend(q); }
        }
    }
    s
}

#[test]
fn a_clean_net_has_clean_seams() {
    // the cube's cross: every cut is a closed loop round a face, so no dead ends, no staircases, and all of it on the
    // outside where `region` can see it
    let s = unwrap_soup(&shapes::get("cube").unwrap(), Params::default()).unwrap().stats;
    let q = &s.seams;
    assert_eq!(s.islands, 1);
    assert!(q.length > 4. && q.length < 6., "seam length {:.2} / √A", q.length);
    assert_eq!(q.hidden, 0.);
    assert_eq!(q.spurs, 0);
    assert_eq!(q.steps, 0.);
    assert_eq!(q.inside, 0.);
    for name in ["cylinder", "cone"] {
        let q = &unwrap_soup(&shapes::get(name).unwrap(), Params::default()).unwrap().stats.seams;
        assert_eq!((q.spurs, q.inside), (0, 0.), "{name}: spurs {} inside {}", q.spurs, q.inside);
        assert_eq!(q.steps, 0., "{name}: staircase seams");
    }
}

#[test]
fn a_short_dead_end_is_counted_as_a_spur() {
    // a 40×40 unit sheet: two grid edges are 5% of √area, under the 6% that makes a dead end junk. The cut runs from
    // the sheet's own border two edges in, so it opens (a lone interior edge can't: its vertex fan stays glued round
    // it) and ends in the middle of the panel.
    let n = 40;
    let e = 1. / n as f32;
    let x = 15. * e;
    let ends = [x, 0., 0., x, e, 0., x, e, 0., x, 2. * e, 0.];
    let m = Mesh::from_soup(&grid(n)).unwrap();
    let seams = m.edges_at(&ends);
    assert_eq!(seams.len(), 2, "the cut is two edges");
    let isl = chart::unwrap(&m, &seams, &Params { join: false, ..Default::default() });
    let q = judge::measure(&m, &isl).seams(m.a.iter().sum::<f64>().sqrt());
    assert_eq!(q.spurs, 1, "the cut should end in one dead end, got {q:?}");
    // both are in units of √area, so the normalisation cancels the mesh scale: two edges of 1/n are 2/n\n    assert!((q.length - 2. * e as f64).abs() < 1e-6, "the only cut is that path, length {:.4}", q.length);
    assert!((q.spur_length - 2. * e as f64).abs() < 1e-6, "spur length {:.4}", q.spur_length);
    assert_eq!(q.steps, 0.);
    assert_eq!(q.inside, 0.);
}

#[test]
fn a_seam_never_lands_inside_a_polygon() {
    // quads given as polygons (as an FBX loader supplies them): no cut may run down a diagonal
    for name in shapes::NAMES {
        let positions = shapes::get(name).unwrap();
        let polys = (0..positions.len() as u32 / 9).map(|t| t / 2).collect();
        let out = unwrap(&[PartIn { name: name.into(), positions, polys, ..Default::default() }], Params::default()).unwrap();
        assert_eq!(out.stats.seams.inside, 0., "{name}: a seam runs inside a polygon");
    }
}