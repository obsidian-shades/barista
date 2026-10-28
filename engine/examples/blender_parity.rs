//! Our manual unwrap against Blender's on the same triangles and seams (`tools/blender-unwrap-ref.py` writes them):
//! `cargo run --release --example blender_parity -- ref.json`. Per island: its shape's error after the best turn,
//! scale, shift (and mirror), as a share of the island's size in Blender: 0 = the same layout. A second argument, a
//! folder: an SVG per case, Blender's layout in red under ours (fitted onto it) in blue.
use barista::edit::{reseam, ReseamIn};
use barista::Params;
use std::collections::BTreeMap;

fn main() {
    let path = std::env::args().nth(1).expect("ref.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let floats = |v: &serde_json::Value| v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect::<Vec<f32>>();
    let mut worst = 0f64;
    for c in &cases {
        let (pos, uvs, seams, before) = (floats(&c["positions"]), floats(&c["uvs"]), floats(&c["seams"]), floats(&c["before"]));
        let pins: Vec<u32> = c["pins"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u32).collect();
        let nt = pos.len() / 9;
        let t0 = std::time::Instant::now();
        let r = reseam(&ReseamIn {
            positions: pos, uvs: before, stretch: vec![0.; nt], island: vec![0; nt], seams, changed: vec![],
            pins: pins.clone(), faces: (0..nt as u32).collect(), live: false, manual: true,
        }, &Params::default()).unwrap();
        let ms = t0.elapsed().as_millis();
        let drift = pins.iter().map(|&k| (r.uvs[2 * k as usize] - uvs[2 * k as usize]).abs().max((r.uvs[2 * k as usize + 1] - uvs[2 * k as usize + 1]).abs())).fold(0f32, f32::max);
        if !pins.is_empty() { println!("{:9} pins moved at most {drift:e} (Blender holds them)", c["name"].as_str().unwrap()); }
        let mut isl: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
        for t in 0..nt { isl.entry(r.island[t]).or_default().extend(3 * t..3 * t + 3); }
        let mut svg = String::new();
        let mut line = format!("{:9} {:4} tris {:4} ms:", c["name"].as_str().unwrap(), nt, ms);
        let area = |w: &[f32], cs: &[usize]| cs.chunks_exact(3).map(|c| {
            let [a, b, d] = [c[0], c[1], c[2]].map(|k| (w[2 * k] as f64, w[2 * k + 1] as f64));
            ((b.0 - a.0) * (d.1 - a.1) - (d.0 - a.0) * (b.1 - a.1)).abs() / 2.
        }).sum::<f64>();
        // islands' sizes against each other (Blender's average islands scale): ours / Blender's, the same for all
        let ratios: Vec<f64> = isl.values().map(|cs| area(&r.uvs, cs) / area(&uvs, cs)).filter(|x| x.is_finite()).collect();
        let spread = ratios.iter().fold(f64::MIN, |a, &b| a.max(b)) / ratios.iter().fold(f64::MAX, |a, &b| a.min(b));
        for cs in isl.values() {
            let p: Vec<(f64, f64)> = cs.iter().map(|&k| (r.uvs[2 * k] as f64, r.uvs[2 * k + 1] as f64)).collect();
            let q: Vec<(f64, f64)> = cs.iter().map(|&k| (uvs[2 * k] as f64, uvs[2 * k + 1] as f64)).collect();
            let size = { let (x, y): (Vec<f64>, Vec<f64>) = q.iter().copied().unzip(); let r = |v: &[f64]| v.iter().fold(f64::MIN, |a, &b| a.max(b)) - v.iter().fold(f64::MAX, |a, &b| a.min(b)); r(&x).hypot(r(&y)) };
            if size < 1e-9 { line += &format!(" [{} tris: Blender failed]", cs.len() / 3); continue; }
            let e = [false, true].map(|mirror| fit(&p.iter().map(|&(x, y)| if mirror { (x, -y) } else { (x, y) }).collect::<Vec<_>>(), &q));
            let (e, fitted) = if e[0].0 <= e[1].0 { e[0].clone() } else { e[1].clone() };
            let e = e / size;
            for (tri, col) in [(&q, "red"), (&fitted, "blue")] {
                for c in tri.chunks_exact(3) {
                    svg += &format!("<path d='M{} {}L{} {}L{} {}Z' fill='none' stroke='{col}' stroke-width='0.001'/>", c[0].0, -c[0].1, c[1].0, -c[1].1, c[2].0, -c[2].1);
                }
            }
            worst = worst.max(e);
            line += &format!(" [{} tris {:.4}]", cs.len() / 3, e);
        }
        println!("{line} sizes ±{:.4}", spread.sqrt() - 1.);
        if let Some(dir) = std::env::args().nth(2) {
            std::fs::write(format!("{dir}/{}.svg", c["name"].as_str().unwrap()), format!("<svg xmlns='http://www.w3.org/2000/svg' viewBox='-0.05 -1.05 1.1 1.1' width='600' height='600' style='background:white'>{svg}</svg>")).unwrap();
        }
    }
    println!("worst island error: {worst:.4} of its size");
}

/// RMS distance after the best similarity p → q (complex least squares: q ≈ a·p + b), and p so moved.
fn fit(p: &[(f64, f64)], q: &[(f64, f64)]) -> (f64, Vec<(f64, f64)>) {
    let n = p.len() as f64;
    let mean = |v: &[(f64, f64)]| v.iter().fold((0., 0.), |s, x| (s.0 + x.0 / n, s.1 + x.1 / n));
    let (pm, qm) = (mean(p), mean(q));
    let (mut num, mut den) = ((0., 0.), 0.);
    for (a, b) in p.iter().zip(q) {
        let (px, py, qx, qy) = (a.0 - pm.0, a.1 - pm.1, b.0 - qm.0, b.1 - qm.1);
        num = (num.0 + px * qx + py * qy, num.1 + px * qy - py * qx);
        den += px * px + py * py;
    }
    let (ar, ai) = (num.0 / den.max(1e-30), num.1 / den.max(1e-30));
    let moved: Vec<(f64, f64)> = p.iter().map(|a| {
        let (px, py) = (a.0 - pm.0, a.1 - pm.1);
        (ar * px - ai * py + qm.0, ar * py + ai * px + qm.1)
    }).collect();
    let e = (moved.iter().zip(q).map(|(a, b)| (a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sum::<f64>() / n).sqrt();
    (e, moved)
}
