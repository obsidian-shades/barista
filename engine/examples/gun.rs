//! Benchmark on a real model: `cargo run --release --example gun [soup] [out_dir] [part]`. Prints per-part stats;
//! with `out_dir`, writes per part a PNG: three checker-textured 3D views (islands tinted) beside its UV layout.
use barista::{unwrap, Params, PartIn, PartOut};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let path = a.get(1).cloned().unwrap_or(concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/gun.soup").into());
    let only: Option<usize> = a.get(3).and_then(|x| x.parse().ok());
    let b = std::fs::read(&path).expect("soup");
    let word = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap()) as usize;
    let (mut parts, mut at) = (vec![], 4);
    for k in 0..word(0) {
        let n = word(at);
        let positions = b[at + 4..at + 4 + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        if only.is_none_or(|o| o == k) { parts.push(PartIn { name: format!("part{k}"), positions, seams: vec![], ..Default::default() }); }
        at += 4 + n * 4;
    }
    if std::env::var("CHARTS").is_ok() {
        // the charting alone: each part's charts in flat colours, chart sizes listed
        for q in &parts {
            let m = barista::mesh::Mesh::from_soup(&q.positions).unwrap();
            let cs = barista::region::charts(&m, Params::default().sharp, &Default::default());
            let mut island = vec![0u32; m.f.len()];
            for (i, c) in cs.iter().enumerate() { for &t in c { island[t as usize] = i as u32; } }
            let mut sizes: Vec<(usize, usize)> = cs.iter().enumerate().map(|(i, c)| (c.len(), i)).collect();
            sizes.sort_by(|a, b| b.cmp(a));
            println!("{}: {} charts, biggest {:?}", q.name, cs.len(), &sizes[..sizes.len().min(12)]);
            let positions: Vec<f32> = m.f.iter().flat_map(|f| f.iter().flat_map(|&v| m.to_world(m.pt(v)))).collect();
            // HL=<tri count>: that chart in red
            let hl: Option<usize> = std::env::var("HL").ok().and_then(|x| x.parse().ok());
            let stretch = (0..m.f.len()).map(|t| if hl.is_some_and(|h| cs[island[t] as usize].len() == h) { -1. } else { 0. }).collect();
            let p = PartOut { positions, uvs: vec![0.; m.f.len() * 6], stretch, island, source: m.src.clone() };
            let mut img = Img::new(2400, 1200);
            render(&mut img, &p, (0, 0, 1200, 600), [1., 0., 0.]);
            render(&mut img, &p, (1200, 0, 1200, 600), [-1., 0., 0.]);
            let views: Vec<f64> = std::env::var("VIEW").unwrap_or("0,-1,0,0.6,-0.5,-0.6".into()).split(',').map(|x| x.parse().unwrap()).collect();
            render(&mut img, &p, (0, 600, 1200, 600), [views[0], views[1], views[2]]);
            render(&mut img, &p, (1200, 600, 1200, 600), [views[3], views[4], views[5]]);
            img.save(&format!("{}/{}-charts.png", a.get(2).map_or(".", |s| s.as_str()), q.name));
        }
        return;
    }
    // ONE_ATLAS=1: every part in one square; OBJ=<path>: the result as an OBJ with UVs, one object per part
    let out = unwrap(&parts, Params { one_atlas: std::env::var("ONE_ATLAS").is_ok(), ..Default::default() }).unwrap();
    if let Ok(path) = std::env::var("OBJ") {
        let mut s = String::new();
        let mut n = 0;
        for (k, p) in out.parts.iter().enumerate() {
            s += &format!("o {}\n", parts[k].name);
            for c in 0..p.positions.len() / 3 {
                s += &format!("v {} {} {}\nvt {} {}\n", p.positions[c * 3], p.positions[c * 3 + 1], p.positions[c * 3 + 2], p.uvs[c * 2], p.uvs[c * 2 + 1]);
            }
            for t in 0..p.positions.len() / 9 { let i = n + t * 3; s += &format!("f {}/{} {}/{} {}/{}\n", i + 1, i + 1, i + 2, i + 2, i + 3, i + 3); }
            n += p.positions.len() / 3;
        }
        std::fs::write(&path, s).expect("obj");
    }
    for (k, p) in out.parts.iter().enumerate() {
        let mut ids = p.island.clone();
        ids.sort();
        ids.dedup();
        let (mut se, mut sa, mut hot) = (0., 0., 0.);
        for (t, &e) in p.stretch.iter().enumerate() {
            let ar = area3(p, t);
            if e >= 0. { se += e as f64 * ar; sa += ar; }
            // fully red in the editor's Stretch view (≥ 50%)
            if e >= 1.5f32.ln() { hot += ar; }
        }
        println!("{}: {:5} tris  {:3} islands  stretch {:5.2}%  hot {:5.2}%  eff {:4.1}%  max {:5.2}", parts[k].name, p.island.len(), ids.len(), se / sa.max(1e-30) * 100.,
            hot / sa.max(1e-30) * 100., barista::pack::efficiency(&p.uvs) * 100., p.stretch.iter().fold(0f32, |a, &b| a.max(b)));
    }
    let s = &out.stats;
    println!("TOTAL {} islands, {} tris, flips {}, stretch {:.2}% (max {:.2}), good {:.1}%, overlap {:.3}%, eff {:.1}%, {:.0} ms",
        s.islands, s.tris, s.flips, s.mean_stretch * 100., s.max_stretch, s.good_area * 100., s.overlap * 100., s.efficiency * 100., s.ms);
    let Some(dir) = a.get(2) else { return };
    for (k, p) in out.parts.iter().enumerate() {
        let mut img = Img::new(2400, 1200);
        render(&mut img, p, (0, 0, 600, 600), [1., 0., 0.]);
        render(&mut img, p, (600, 0, 600, 600), [-1., 0., 0.]);
        render(&mut img, p, (0, 600, 600, 600), [0., 1., 0.]);
        render(&mut img, p, (600, 600, 600, 600), [0.6, 0.5, -0.6]);
        uv_view(&mut img, p, (1200, 0, 1200, 1200));
        img.save(&format!("{dir}/{}.png", parts[k].name));
    }
}

fn area3(p: &PartOut, t: usize) -> f64 {
    let q = |c: usize, i: usize| p.positions[(t * 3 + c) * 3 + i] as f64;
    let (e1, e2) = ([0, 1, 2].map(|i| q(1, i) - q(0, i)), [0, 1, 2].map(|i| q(2, i) - q(0, i)));
    let c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt() / 2.
}

fn hue(id: u32) -> [f64; 3] {
    let h = ((id as u64).wrapping_mul(2654435761) % 360) as f64 / 60.;
    let x = 1. - (h % 2. - 1.).abs();
    let c = match h as u32 { 0 => [1., x, 0.], 1 => [x, 1., 0.], 2 => [0., 1., x], 3 => [0., x, 1.], 4 => [x, 0., 1.], _ => [1., 0., x] };
    c.map(|v| 0.35 + 0.65 * v)
}

type Rect = (usize, usize, usize, usize);

struct Img { w: usize, h: usize, px: Vec<[u8; 3]>, z: Vec<f64> }

impl Img {
    fn new(w: usize, h: usize) -> Img { Img { w, h, px: vec![[30, 30, 34]; w * h], z: vec![f64::INFINITY; w * h] } }

    fn save(&self, path: &str) {
        let mut raw = Vec::with_capacity((self.w * 3 + 1) * self.h);
        for y in 0..self.h {
            raw.push(0);
            for x in 0..self.w { raw.extend(self.px[y * self.w + x]); }
        }
        // zlib with stored blocks: no compression, no dependency
        let mut z = vec![0x78, 1];
        let n = raw.len().div_ceil(65535);
        for (i, ch) in raw.chunks(65535).enumerate() {
            z.push((i + 1 == n) as u8);
            z.extend((ch.len() as u16).to_le_bytes());
            z.extend((!(ch.len() as u16)).to_le_bytes());
            z.extend(ch);
        }
        let (mut s1, mut s2) = (1u32, 0u32);
        for &x in &raw { s1 = (s1 + x as u32) % 65521; s2 = (s2 + s1) % 65521; }
        z.extend(((s2 << 16) | s1).to_be_bytes());
        let mut png = vec![0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10];
        let mut chunk = |t: &[u8], d: &[u8]| {
            png.extend((d.len() as u32).to_be_bytes());
            let mut c = t.to_vec();
            c.extend(d);
            let mut crc = !0u32;
            for &x in &c {
                crc ^= x as u32;
                for _ in 0..8 { crc = if crc & 1 != 0 { 0xEDB88320 ^ (crc >> 1) } else { crc >> 1 }; }
            }
            png.extend(&c);
            png.extend((!crc).to_be_bytes());
        };
        let mut ihdr = (self.w as u32).to_be_bytes().to_vec();
        ihdr.extend((self.h as u32).to_be_bytes());
        ihdr.extend([8, 2, 0, 0, 0]);
        chunk(b"IHDR", &ihdr);
        chunk(b"IDAT", &z);
        chunk(b"IEND", &[]);
        std::fs::write(path, png).unwrap();
    }

    /// Fill a screen-space triangle (x, y, depth) inside `rect`; `shade` maps barycentrics to a colour.
    fn tri(&mut self, p: [[f64; 3]; 3], rect: Rect, shade: &dyn Fn([f64; 3]) -> [u8; 3]) {
        let minf = |k: usize| p.iter().map(|q| q[k]).fold(f64::MAX, f64::min);
        let maxf = |k: usize| p.iter().map(|q| q[k]).fold(f64::MIN, f64::max);
        let (x0, x1) = (minf(0).max(rect.0 as f64), maxf(0).min((rect.0 + rect.2 - 1) as f64));
        let (y0, y1) = (minf(1).max(rect.1 as f64), maxf(1).min((rect.1 + rect.3 - 1) as f64));
        let d = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
        if d.abs() < 1e-12 { return; }
        for y in y0.ceil() as i64..=y1.floor() as i64 {
            for x in x0.ceil() as i64..=x1.floor() as i64 {
                let (fx, fy) = (x as f64, y as f64);
                let b1 = ((fx - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (fy - p[0][1])) / d;
                let b2 = ((p[1][0] - p[0][0]) * (fy - p[0][1]) - (fx - p[0][0]) * (p[1][1] - p[0][1])) / d;
                let b0 = 1. - b1 - b2;
                if b0 < -1e-9 || b1 < -1e-9 || b2 < -1e-9 { continue; }
                let z = b0 * p[0][2] + b1 * p[1][2] + b2 * p[2][2];
                let i = y as usize * self.w + x as usize;
                if z < self.z[i] {
                    self.z[i] = z;
                    self.px[i] = shade([b0, b1, b2]);
                }
            }
        }
    }
}

fn cr(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn dt(a: [f64; 3], b: [f64; 3]) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn unit(a: [f64; 3]) -> [f64; 3] { let l = dt(a, a).sqrt().max(1e-30); a.map(|x| x / l) }

/// Orthographic view looking along −`dir`, checker from the UVs (64 squares across the atlas), islands tinted.
fn render(img: &mut Img, p: &PartOut, rect: Rect, dir: [f64; 3]) {
    let f = unit(dir);
    let up = if f[1].abs() > 0.9 { [1., 0., 0.] } else { [0., 1., 0.] };
    let r = unit(cr(up, f));
    let u = cr(f, r);
    let pos = |c: usize| [0, 1, 2].map(|i| p.positions[c * 3 + i] as f64);
    let n = p.island.len() * 3;
    let proj: Vec<[f64; 3]> = (0..n).map(|c| { let q = pos(c); [dt(q, r), -dt(q, u), -dt(q, f)] }).collect();
    let (lo, hi) = proj.iter().fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), q| ([lo[0].min(q[0]), lo[1].min(q[1])], [hi[0].max(q[0]), hi[1].max(q[1])]));
    let s = ((rect.2 - 20) as f64 / (hi[0] - lo[0])).min((rect.3 - 20) as f64 / (hi[1] - lo[1]));
    let (ox, oy) = (rect.0 as f64 + (rect.2 as f64 - s * (hi[0] - lo[0])) / 2., rect.1 as f64 + (rect.3 as f64 - s * (hi[1] - lo[1])) / 2.);
    for t in 0..p.island.len() {
        let c = [3 * t, 3 * t + 1, 3 * t + 2];
        let sc = c.map(|k| [ox + (proj[k][0] - lo[0]) * s, oy + (proj[k][1] - lo[1]) * s, proj[k][2]]);
        let (a, b, d) = (pos(c[0]), pos(c[1]), pos(c[2]));
        let nn = unit(cr([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]));
        let lam = dt(nn, f).abs() * 0.7 + 0.3;
        let col = if p.stretch[t] < 0. { [1., 0., 0.] } else { hue(p.island[t]) };
        let uv: Vec<[f64; 2]> = c.iter().map(|&k| [p.uvs[k * 2] as f64, p.uvs[k * 2 + 1] as f64]).collect();
        img.tri(sc, rect, &|b: [f64; 3]| {
            let x = b[0] * uv[0][0] + b[1] * uv[1][0] + b[2] * uv[2][0];
            let y = b[0] * uv[0][1] + b[1] * uv[1][1] + b[2] * uv[2][1];
            let ch = if ((x * 64.).floor() as i64 + (y * 64.).floor() as i64).rem_euclid(2) == 0 { 1. } else { 0.55 };
            col.map(|v| (v * ch * lam * 255.) as u8)
        });
    }
}

/// The part's islands in UV, fitted to `rect`, darker where stretched, triangle edges faint.
fn uv_view(img: &mut Img, p: &PartOut, rect: Rect) {
    let n = p.island.len() * 3;
    let (lo, hi) = (0..n).fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), c| {
        let (x, y) = (p.uvs[c * 2] as f64, p.uvs[c * 2 + 1] as f64);
        ([lo[0].min(x), lo[1].min(y)], [hi[0].max(x), hi[1].max(y)])
    });
    let s = ((rect.2 - 20) as f64 / (hi[0] - lo[0])).min((rect.3 - 20) as f64 / (hi[1] - lo[1]));
    for t in 0..p.island.len() {
        let sc = [0, 1, 2].map(|k| {
            let c = 3 * t + k;
            [rect.0 as f64 + 10. + (p.uvs[c * 2] as f64 - lo[0]) * s, (rect.1 + rect.3) as f64 - 10. - (p.uvs[c * 2 + 1] as f64 - lo[1]) * s, 0.]
        });
        let col = if p.stretch[t] < 0. { [1., 0., 0.] } else { hue(p.island[t]) };
        let e = p.stretch[t].clamp(0., 0.5) as f64;
        img.tri(sc, rect, &|_| col.map(|v| (v * (1. - e) * 255.) as u8));
    }
}
