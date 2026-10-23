//! Study: on the gun, stitch each pair of neighbouring islands along their whole shared border, as the editor's
//! Stitch does, and report what comes back. `NUKE=1`: every seam cleared and each part unwrapped from none instead.
//! `cargo run --release --example stitch_study [soup]`
use auto_unwrap::edit::{reseam, ReseamIn};
use auto_unwrap::{unwrap, Params, PartIn};
use std::collections::{HashMap, HashSet};

fn main() {
    let path = std::env::args().nth(1).unwrap_or(concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/gun.soup").into());
    let b = std::fs::read(&path).unwrap();
    let word = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap()) as usize;
    let (mut parts, mut at) = (vec![], 4);
    for k in 0..word(0) {
        let n = word(at);
        let positions = b[at + 4..at + 4 + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        parts.push(PartIn { name: format!("part{k}"), positions, seams: vec![], ..Default::default() });
        at += 4 + n * 4;
    }
    let p = Params::default();
    let out = unwrap(&parts, p.clone()).unwrap();
    let ids = |x: &[u32]| x.iter().copied().collect::<HashSet<u32>>();
    if std::env::var("NUKE").is_ok() {
        for (k, o) in out.parts.iter().enumerate() {
            let t0 = std::time::Instant::now();
            let faces: Vec<u32> = (0..o.island.len() as u32).collect();
            let r = reseam(&ReseamIn { positions: o.positions.clone(), uvs: o.uvs.clone(), stretch: o.stretch.clone(), island: o.island.clone(), seams: vec![], changed: vec![], pins: vec![], faces, live: false, manual: false }, &p).unwrap();
            let st = r.stretch.iter().filter(|x| **x >= 0.).sum::<f32>() / r.stretch.len() as f32;
            println!("part{k} {} tris: auto {} islands, no seams {} islands, mean stretch {:.1}%, flips {}, {} ms",
                o.island.len(), ids(&o.island).len(), ids(&r.island).len(), st * 100., r.stretch.iter().filter(|x| **x < 0.).count(), t0.elapsed().as_millis());
        }
        return;
    }
    let (mut tried, mut merged, mut resplit, mut other) = (0, 0, 0, 0);
    for (k, o) in out.parts.iter().enumerate() {
        let n = o.island.len();
        let key = |t: usize, i: usize| { let q = &o.positions[t * 9 + i * 3..t * 9 + i * 3 + 3]; [q[0].to_bits(), q[1].to_bits(), q[2].to_bits()] };
        let mut by: HashMap<([u32; 3], [u32; 3]), Vec<(usize, usize, usize)>> = HashMap::new();
        for t in 0..n { for i in 0..3 { let (a, c) = (key(t, i), key(t, (i + 1) % 3)); by.entry(if a < c { (a, c) } else { (c, a) }).or_default().push((t, i, (i + 1) % 3)); } }
        // every island border is a seam, as after an auto unwrap; the borders between each pair of islands
        let (mut border, mut seams): (HashMap<(u32, u32), Vec<f32>>, Vec<f32>) = (HashMap::new(), vec![]);
        for v in by.values() {
            if v.len() != 2 { continue; }
            let (s, t) = (v[0].0, v[1].0);
            let xyz: Vec<f32> = [v[0].1, v[0].2].iter().flat_map(|&i| o.positions[s * 9 + i * 3..s * 9 + i * 3 + 3].to_vec()).collect();
            if o.island[s] != o.island[t] {
                seams.extend(&xyz);
                border.entry((o.island[s].min(o.island[t]), o.island[s].max(o.island[t]))).or_default().extend(xyz);
            }
        }
        let size: HashMap<u32, usize> = o.island.iter().fold(HashMap::new(), |mut m, &i| { *m.entry(i).or_default() += 1; m });
        let mut pairs: Vec<_> = border.iter().collect();
        pairs.sort_by_key(|(k, _)| **k);
        for (&(a, c), edges) in pairs.into_iter().take(40) {
            tried += 1;
            let drop: HashSet<Vec<u32>> = edges.chunks(6).map(|e| e.iter().map(|x| x.to_bits()).collect()).collect();
            let kept: Vec<f32> = seams.chunks(6).filter(|e| !drop.contains(&e.iter().map(|x| x.to_bits()).collect::<Vec<_>>())).flatten().copied().collect();
            let r = reseam(&ReseamIn { positions: o.positions.clone(), uvs: o.uvs.clone(), stretch: o.stretch.clone(), island: o.island.clone(), seams: kept, changed: edges.clone(), pins: vec![], faces: vec![], live: false, manual: false }, &p).unwrap();
            let (ta, tc) = (o.island.iter().position(|&i| i == a).unwrap(), o.island.iter().position(|&i| i == c).unwrap());
            let hit: HashSet<u32> = (0..n).filter(|&t| o.island[t] == a || o.island[t] == c).map(|t| r.island[t]).collect();
            let one = r.island[ta] == r.island[tc];
            if one && hit.len() == 1 { merged += 1 } else if !one { resplit += 1 } else { other += 1 }
            println!("part{k} isl {a}({}) + {c}({}) shared {} edges: {} -> {} islands; touched now {} pieces; joined {}",
                size[&a], size[&c], edges.len() / 6, ids(&o.island).len(), ids(&r.island).len(), hit.len(), one);
        }
    }
    println!("tried {tried}: merged cleanly {merged}, joined but split elsewhere {other}, not joined {resplit}");
}
