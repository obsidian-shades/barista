use barista::{check, repack, shapes, unwrap, unwrap_soup, Params, PartIn};

// charting tests count islands before they're joined into nets
const CHARTS: Params = Params { sharp: 45., tol: 0.08, seam_weight: 0.1, join: false, atlas: 0., one_atlas: false };

#[test]
fn core_shapes_unwrap_perfectly() {
    let rows = check(Params::default());
    for r in &rows {
        let s = &r.stats;
        let q = &s.seams;
        eprintln!("{} {:9} islands {:3}  flips {}  overlap {:.2}%  stretch {:6.2}%  {:4.0} ms  ideal: {}\n           seams {:.3} len/√A  {:.0}% hidden  {} spurs ({:.3})  {:.1}% steps  {:.2}% inside a face",
            if r.pass { "PASS" } else { "FAIL" }, r.shape, s.islands, s.flips, s.overlap * 100., s.mean_stretch * 100., s.ms, r.ideal,
            q.length, q.hidden * 100., q.spurs, q.spur_length, q.steps * 100., q.inside * 100.);
    }
    // a seam may never run inside a polygon: the export would split the face there (quads_stay_whole covers the
    // other side of the same rule)
    assert!(rows.iter().all(|r| r.stats.seams.inside == 0.), "a seam runs inside a polygon");
    assert!(rows.iter().all(|r| r.pass), "some core shapes failed (see above)");
}

#[test]
fn rejects_bad_input() {
    assert!(unwrap_soup(&[0.; 8], Params::default()).is_err());
    assert!(unwrap_soup(&[0.; 9], Params::default()).is_err()); // one degenerate triangle
    assert!(unwrap_soup(&[f32::NAN; 9], Params::default()).is_err());
    assert!(unwrap(&[], Params::default()).is_err());
}

#[test]
fn mixed_winding_still_unwraps() {
    // every other triangle of the cube flipped, as some exporters do
    let mut s = shapes::get("cube").unwrap();
    for t in s.chunks_mut(9).step_by(2) {
        for k in 0..3 { t.swap(3 + k, 6 + k); }
    }
    let st = unwrap_soup(&s, CHARTS).unwrap().stats;
    assert_eq!((st.islands, st.flips), (6, 0));
}

#[test]
fn user_seam_splits_a_face() {
    // a seam right across the cube's +z face, along x = 0 (the 4×4 grid has vertices there)
    let seams: Vec<f32> = (0..4).flat_map(|i| {
        let (y0, y1) = (-0.5 + i as f32 * 0.25, -0.25 + i as f32 * 0.25);
        [0., y0, 0.5, 0., y1, 0.5]
    }).collect();
    let part = PartIn { name: "cube".into(), positions: shapes::get("cube").unwrap(), seams, ..Default::default() };
    let st = unwrap(&[part], CHARTS).unwrap().stats;
    assert_eq!((st.islands, st.flips), (7, 0));
}

#[test]
fn one_seam_edge_is_a_slit_not_a_split() {
    // the exact edge a click in the editor produced: from the cube's rim into the face, a slit that flattens as is
    // repeated: this case once passed or failed depending on hash-map order (float noise on the slit)
    for _ in 0..20 {
        let part = PartIn { name: "cube".into(), positions: shapes::get("cube").unwrap(), seams: vec![0.5, 0., -0.5, 0.5, 0.25, -0.25], ..Default::default() };
        let st = unwrap(&[part], CHARTS).unwrap().stats;
        assert_eq!((st.islands, st.flips), (6, 0));
    }
}

#[test]
fn torus_is_one_seamless_rectangle() {
    let out = unwrap_soup(&shapes::get("torus").unwrap(), Params::default()).unwrap();
    assert_eq!(out.stats.islands, 1);
    let p = &out.parts[0];
    // every copy of a seam vertex sits a whole number of periods away from the others: the layout tiles the
    // plane, so a tiling texture runs straight across the seams
    let mut at: std::collections::HashMap<[i32; 3], Vec<(f64, f64)>> = Default::default();
    for c in 0..p.positions.len() / 3 {
        let key = [0, 1, 2].map(|k| (p.positions[c * 3 + k] * 1e4).round() as i32);
        at.entry(key).or_default().push((p.uvs[c * 2] as f64, p.uvs[c * 2 + 1] as f64));
    }
    let mut shifts: Vec<(f64, f64)> = at.values().flat_map(|uvs| uvs.iter().flat_map(move |a| uvs.iter().map(move |b| (a.0 - b.0, a.1 - b.1))))
        .filter(|d| d.0.hypot(d.1) > 1e-4).collect();
    shifts.sort_by(|a, b| a.0.hypot(a.1).total_cmp(&b.0.hypot(b.1)));
    let p1 = shifts[0];
    let p2 = *shifts.iter().find(|q| (p1.0 * q.1 - p1.1 * q.0).abs() > 1e-3).expect("two periods");
    let det = p1.0 * p2.1 - p1.1 * p2.0;
    for d in &shifts {
        let (a, b) = ((d.0 * p2.1 - d.1 * p2.0) / det, (d.1 * p1.0 - d.0 * p1.1) / det);
        assert!((a - a.round()).abs() < 0.01 && (b - b.round()).abs() < 0.01, "shift {d:?} isn't a whole number of periods {p1:?} {p2:?}");
    }
}

#[test]
fn same_input_same_output() {
    let soup = shapes::get("torus").unwrap();
    let a = unwrap_soup(&soup, Params::default()).unwrap();
    let b = unwrap_soup(&soup, Params::default()).unwrap();
    assert_eq!(a.parts[0].uvs, b.parts[0].uvs);
}

#[test]
fn parts_share_one_atlas() {
    let part = |n: &str| PartIn { name: n.into(), positions: shapes::get(n).unwrap(), seams: vec![], ..Default::default() };
    let out = unwrap(&[part("cube"), part("cylinder")], Params::default()).unwrap();
    assert_eq!(out.parts.len(), 2);
    assert_eq!(out.stats.islands, 2); // one net per part
    assert!(out.stats.overlap < 0.001);
}

#[test]
fn repack_keeps_islands_apart() {
    let tri = |o: f32| vec![o, 0., o + 1., 0., o, 1.];
    let out = repack(vec![tri(0.), tri(0.2)], false); // overlapping on purpose
    assert!(out.iter().flatten().all(|&x| (0. ..=1.).contains(&x)));
    // they may nest corner into corner (the packer works on their shapes, not boxes), but never overlap
    let all: Vec<f32> = out.concat();
    assert_eq!(barista::pack::overlap(&all, 512), 0., "islands overlap: {out:?}");
}

#[test]
fn gun_packs_tightly() {
    // testdata/gun.soup: the 10-part gun FBX baked to world-space soups (u32 parts, then per part u32 floats + f32 xyz)
    let Ok(b) = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/gun.soup")) else {
        eprintln!("testdata/gun.soup missing: skipped");
        return;
    };
    let word = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap()) as usize;
    let (mut parts, mut at) = (vec![], 4);
    for k in 0..word(0) {
        let n = word(at);
        let positions = b[at + 4..at + 4 + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        parts.push(PartIn { name: format!("part {k}"), positions, seams: vec![], ..Default::default() });
        at += 4 + n * 4;
    }
    let s = unwrap(&parts, Params { one_atlas: true, ..Params::default() }).unwrap().stats;
    let unique = s.islands - s.twins;
    let q = &s.seams;
    eprintln!("gun: {} nets ({} counting mirrored pairs once), efficiency {:.1}%, overlap {:.3}%, {:.0} ms\n     seams {:.2} length/√A, {:.0}% hidden, {} spurs ({:.3}), {:.1}% steps, {:.2}% inside a face",
        s.islands, unique, s.efficiency * 100., s.overlap * 100., s.ms, q.length, q.hidden * 100., q.spurs, q.spur_length, q.steps * 100., q.inside * 100.);
    assert!(s.overlap < 0.001);
    // 508 islands when every 45° crease was a chart; charting by facing side, books and orphan fills: ~114. A
    // mirrored half's image is the same island again, so a pair counts once: the cap still guards fragmentation.
    assert!(unique < 140, "gun unwraps into {unique} islands, mirrored pairs counted once ({} in all)", s.islands);
    // bounding-box shelves filled 19% of the atlas; packing the nets' rasterised shapes fills ~43%
    assert!(s.efficiency > 0.38, "gun packs at {:.1}%", s.efficiency * 100.);
    // the seams themselves (judge): a gun has plenty of hidden surface to run a cut through, and a cut that ends
    // nowhere costs a seam for nothing; before quads were read back and paths charged for their bends this was 77
    assert!(q.hidden > 0.05, "only {:.0}% of the gun's seams are hidden", q.hidden * 100.);
    assert!(q.spurs < 60, "{} dead ends in the gun's seams", q.spurs);
    assert!(q.inside < 0.01, "{:.2}% of a seam runs inside a face", q.inside * 100.);
}

#[test]
fn quads_stay_whole() {
    // the shapes are grids of quads, two triangles each in a row: given as polygons, no seam may run along a
    // diagonal, or the export would have to write the quad as two triangles
    for name in shapes::NAMES {
        let positions = shapes::get(name).unwrap();
        let polys = (0..positions.len() as u32 / 9).map(|t| t / 2).collect();
        let out = unwrap(&[PartIn { name: name.into(), positions, polys, ..Default::default() }], Params::default()).unwrap();
        let o = &out.parts[0];
        let mut by: std::collections::HashMap<u32, Vec<usize>> = Default::default();
        for (t, &s) in o.source.iter().enumerate() { by.entry(s / 2).or_default().push(t); }
        let key = |c: usize| [0, 1, 2].map(|k| o.positions[c * 3 + k].to_bits());
        let split = by.values().filter(|ts| ts.len() == 2 && {
            let (a, b) = (ts[0], ts[1]);
            (0..3).any(|i| (0..3).any(|j| key(a * 3 + i) == key(b * 3 + j) && (o.uvs[(a * 3 + i) * 2] != o.uvs[(b * 3 + j) * 2] || o.uvs[(a * 3 + i) * 2 + 1] != o.uvs[(b * 3 + j) * 2 + 1])))
        }).count();
        assert_eq!(split, 0, "{name}: {split} quads cut along their diagonal");
    }
}
