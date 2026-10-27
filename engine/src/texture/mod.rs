//! Full-resolution texture export: a saved `.barista` project's paint rendered at any size (8K, 16K) by the engine.
//! The editor paints at a working resolution and never holds full-size maps. Here every layer the engine can render
//! from its description is drawn at the export size: fills (the material maps from disk), decals, generators (AO and
//! edge distances baked at that size). What it can't render (hand paint, layer masks, generator clips, an asset with
//! no file on disk) is upsampled from the working resolution over surface texels only. The stack is composited as
//! `src/paint.ts` does, padded for the mip chain, and written as PNGs (plus the editor's FBX) into one folder.
pub mod bake;
pub mod layers;

use crate::project::{load, Pack};
use bake::{Edges, Occlusion};
use layers::{fill_at, gen_at, DecalFrame, Map, Material, Mesh, Texel, Up, NONE};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ---- the document, as src/project.ts saves it (only what the render reads) ----
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    pub asset: String,
    pub projection: String,
    pub tiling: f32,
    pub tiles: f32,
    pub rotation: f32,
    pub offset: [f32; 2],
    pub normal_strength: f32,
    pub tint: String,
    pub roughness: Option<f32>,
    pub metallic: Option<f32>,
    pub channels: Vec<String>,
}
#[derive(Deserialize, Clone)]
pub struct Decal {
    pub asset: String,
    pub center: [f32; 3],
    pub normal: [f32; 3],
    pub up: [f32; 3],
    pub width: f32,
    pub rotation: f32,
    pub aspect: f32,
    pub tint: String,
    pub roughness: f32,
    pub metallic: f32,
    pub channels: Vec<String>,
    #[serde(default, rename = "flipH")]
    pub flip_h: bool,
    #[serde(default, rename = "flipV")]
    pub flip_v: bool,
    /// Engraved depth 0..1 (paint.ts `Decal.engrave`): the mark's edge tilts the normal, its ink lowers the height.
    #[serde(default)]
    pub engrave: f32,
    /// A grip texture (paint.ts `Shape`): no image, a relief drawn by `layers::shape_height` into normal and height.
    #[serde(default)]
    pub shape: Option<Shape>,
    /// Bent round the model (paint.ts `Decal.wrap`): the shape follows `layers::exp_map` instead of a flat projection.
    #[serde(default)]
    pub wrap: bool,
}
/// A relief panel in world units (paint.ts `Shape`): rounded outline, groove border, pattern inside.
#[derive(Deserialize, Clone)]
pub struct Shape {
    pub pattern: String, pub corner: f32, pub border: f32, pub depth: f32, pub cell: f32, pub amount: f32,
    /// Free outline: corners as shares of the panel's half width / height (None: the rectangle).
    #[serde(default)]
    pub outline: Option<Vec<[f32; 2]>>,
}
/// A whole-part bevel in the normal map (paint.ts `Bevel`): `radius` world units, `profile` round / chamfer, edges
/// sharper than `angle` degrees, concave ones too when `concave`.
#[derive(Deserialize, Clone)]
pub struct Bevel {
    pub radius: f32,
    pub profile: String,
    pub angle: f32,
    #[serde(default)]
    pub concave: bool,
}
#[derive(Deserialize, Clone)]
pub struct Gen {
    pub kind: String,
    pub amount: f32,
    pub soft: f32,
    pub width: f32,
    pub grunge: f32,
    pub scale: f32,
    pub color: String,
    pub rough: f32,
    pub metal: f32,
    #[serde(default)]
    pub clip: bool,
}
#[derive(Deserialize)]
struct Layer {
    id: u32,
    visible: bool,
    opacity: f32,
    #[serde(default)]
    blend: HashMap<String, String>,
    #[serde(default)]
    px: Vec<String>,
    #[serde(default)]
    mask: bool,
    fill: Option<Fill>,
    decal: Option<Decal>,
    gen: Option<Gen>,
    #[serde(default)]
    bevel: Option<Bevel>,
}
#[derive(Deserialize)]
struct Set { size: usize, channels: Vec<String>, layers: Vec<Layer> }
#[derive(Deserialize)]
struct Part { name: String, #[serde(default = "yes")] visible: bool }
fn yes() -> bool { true }
#[derive(Deserialize)]
struct Doc { parts: Vec<Part>, #[serde(default)] sets: Vec<Option<Set>> }

/// What the editor asks for: the project to render, the folder (None: the engine asks), the size, the texture
/// preset, file names' prefix, which parts, and where each asset's files are (URLs as the editor loads them).
#[derive(Deserialize)]
pub struct ExportReq {
    pub project: String,
    pub out: Option<String>,
    pub size: usize,
    #[serde(default = "generic")]
    pub preset: String,
    pub base: String,
    #[serde(default)]
    pub parts: Option<Vec<usize>>,
    /// Texels the paint is carried out past each island for the mip chain; None: max(4, size / 64).
    #[serde(default)]
    pub padding: Option<usize>,
    #[serde(default)]
    pub materials: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub decals: HashMap<String, String>,
    /// The FBX's file name, when the Pack carries one (blob `fbx`).
    pub fbx: Option<String>,
}
fn generic() -> String { "generic".into() }

#[derive(Serialize)]
pub struct ExportDone { pub dir: String, pub files: Vec<String> }

static PROGRESS: Mutex<String> = Mutex::new(String::new());
fn progress(s: impl Into<String>) { *PROGRESS.lock().unwrap() = s.into(); }
/// What the running export is doing ("" when idle), for the editor's busy line.
pub fn status() -> String { PROGRESS.lock().unwrap().clone() }

/// Where the editor's `/…` URLs live on disk: $BARISTA_PUBLIC, else `public/` beside the working directory.
fn public_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("BARISTA_PUBLIC") { return Some(PathBuf::from(p)); }
    ["public", "../public"].iter().map(PathBuf::from).find(|p| p.is_dir())
}
fn file_of(url: &str) -> Option<PathBuf> {
    if !url.starts_with('/') || url.starts_with("//") { return None; } // blob:, data:, http: — not a file the engine can read
    let p = public_dir()?.join(url.trim_start_matches('/'));
    p.is_file().then_some(p)
}
fn decode(path: &Path) -> Result<Map, String> {
    let img = image::open(path).map_err(|e| format!("{}: {e}", path.display()))?.to_rgba8();
    Ok(Map { w: img.width() as usize, h: img.height() as usize, data: img.into_raw() })
}

/// Blend on 0..1 values before the layer's alpha (paint.ts `blended`).
fn blended(d: f32, s: f32, mode: &str) -> f32 {
    match mode {
        "multiply" => d * s,
        "screen" => 1.0 - (1.0 - d) * (1.0 - s),
        "overlay" => if d < 0.5 { 2.0 * d * s } else { 1.0 - 2.0 * (1.0 - d) * (1.0 - s) },
        "add" => (d + s).min(1.0),
        _ => s,
    }
}

/// How a layer gets its texels at the export size.
enum Src<'a> { Pixels, Fill(&'a Fill, &'a Material), Decal(DecalFrame, &'a Map, &'a [String]), Shape(layers::ShapeSrc<'a>), Bevel(layers::BevelSrc), Gen(&'a Gen) }

/// One part's maps at size n: composite colour, roughness, metallic, normal, height, AO, and which texels are
/// painted (for the padding) and on the surface.
struct Out { color: Vec<[u8; 3]>, rough: Vec<u8>, metal: Vec<u8>, normal: Vec<[u8; 3]>, height: Vec<u8>, ao: Vec<u8>, covered: Vec<bool>, owner: Vec<u32> }

#[allow(clippy::too_many_arguments)]
fn render(mesh: &Mesh, set: &Set, n: usize, span: f32, gen_span: f32, occ: Option<&Occlusion>, edges: Option<&Edges>, tiles: &dyn Fn(u32, &str, usize) -> Vec<u8>, assets: &Assets) -> Out {
    let owner = mesh.owners(n);
    let wn = set.size;
    let w_owner = mesh.owners(wn);
    let up = Up { n: wn, on: &w_owner };
    let on = |c: &str| set.channels.iter().any(|x| x == c);
    let shown: Vec<&Layer> = set.layers.iter().filter(|l| l.visible && l.opacity > 0.0).collect();
    // each layer's working-res buffers, and how it renders here
    let bufs: Vec<HashMap<String, Vec<u8>>> = shown
        .iter()
        .map(|l| {
            let mut m: HashMap<String, Vec<u8>> = l.px.iter().map(|ch| (ch.clone(), tiles(l.id, ch, stride(ch)))).collect();
            if l.mask { m.insert("mask".into(), tiles(l.id, "mask", 1)); }
            if l.gen.as_ref().is_some_and(|g| g.clip) { m.insert("clip".into(), tiles(l.id, "clip", 1)); }
            m
        })
        .collect();
    let srcs: Vec<Src> = shown
        .iter()
        .map(|l| {
            if let Some(f) = &l.fill { if let Some(m) = assets.materials.get(&f.asset) { return Src::Fill(f, m); } }
            if let Some(d) = &l.decal { if let Some(sh) = &d.shape { return Src::Shape(layers::ShapeSrc::new(d, sh, span, mesh)); } }
            if let Some(d) = &l.decal { if let Some(img) = assets.decals.get(&d.asset) { return Src::Decal(DecalFrame::new(d, span), img, &d.channels); } }
            if let Some(b) = &l.bevel { return Src::Bevel(layers::BevelSrc::new(b, mesh.pos)); }
            if let Some(g) = &l.gen { if occ.is_some() && edges.is_some() { return Src::Gen(g); } }
            Src::Pixels
        })
        .collect();
    let gen_values: Vec<Option<([f32; 3], f32, f32)>> = shown.iter().map(|l| l.gen.as_ref().map(|g| (layers::hex(&g.color), g.rough * 255.0, g.metal * 255.0))).collect();
    let writes = |l: &Layer, ch: &str| l.fill.as_ref().map(|f| &f.channels).or(l.decal.as_ref().map(|d| &d.channels)).is_none_or(|c| c.iter().any(|x| x == ch));
    let blend_of = |l: &Layer, ch: &str| l.blend.get(ch).cloned().unwrap_or_else(|| if ch == "height" { "add".into() } else { "normal".into() });
    let need_ao = occ.is_some();
    let rows: Vec<_> = (0..n)
        .into_par_iter()
        .map(|y| {
            let mut row = (vec![[188u8; 3]; n], vec![128u8; n], vec![0u8; n], vec![[128u8, 128, 255]; n], vec![128u8; n], vec![255u8; n], vec![false; n]);
            let mut tmp = [0f32; 4];
            for x in 0..n {
                let t = owner[y * n + x];
                if t == NONE { continue; }
                let t = t as usize;
                let b = mesh.bary(t, n, x, y);
                let p = mesh.point(t, b);
                let nn = mesh.nrm[t];
                let (u, v) = ((x as f32 + 0.5) / n as f32, (y as f32 + 0.5) / n as f32);
                let ao = if need_ao { occ.unwrap().ao(p, nn) } else { 1.0 };
                row.5[x] = (ao * 255.0).round() as u8;
                let (mut convex, mut concave) = (f32::NAN, f32::NAN);
                // every layer's texel, bottom first
                let texels: Vec<(Texel, f32)> = shown
                    .iter()
                    .enumerate()
                    .map(|(j, l)| {
                        let buf = &bufs[j];
                        let mask = buf.get("mask").map(|m| up.sample(m, 1, true, u, v, &mut tmp) * tmp[0] / 255.0).unwrap_or(1.0);
                        let mut te = match &srcs[j] {
                            Src::Fill(f, m) => fill_at(f, m, mesh, t, p, x, y, n, span),
                            Src::Decal(fr, img, ch) => fr.at(img, mesh, t, p, ch),
                            Src::Shape(sh) => sh.at(mesh, t, p),
                            Src::Bevel(b) => b.at(mesh, t, p),
                            Src::Gen(g) => {
                                if convex.is_nan() { convex = edges.unwrap().dist(0, p); concave = edges.unwrap().dist(1, p); }
                                let clip = buf.get("clip").map(|m| up.sample(m, 1, true, u, v, &mut tmp) * tmp[0] / 255.0).unwrap_or(1.0);
                                let c = gen_at(g, ao, convex, concave, p, gen_span) * clip;
                                let (col, r, m) = gen_values[j].unwrap();
                                Texel { color: Some((col, c)), rough: Some((r, c)), metal: Some((m, c)), normal: None, height: None }
                            }
                            Src::Pixels => {
                                let mut te = Texel::default();
                                for (ch, px) in buf.iter().filter(|(k, _)| *k != "mask" && *k != "clip") {
                                    let a = up.sample(px, stride(ch), false, u, v, &mut tmp);
                                    match ch.as_str() {
                                        "color" => te.color = Some(([tmp[0], tmp[1], tmp[2]], a)),
                                        "rough" => te.rough = Some((tmp[0], a)),
                                        "metal" => te.metal = Some((tmp[0], a)),
                                        "normal" => te.normal = Some(([tmp[0], tmp[1], tmp[2]], a)),
                                        "height" => te.height = Some((tmp[0], a)),
                                        _ => {}
                                    }
                                }
                                te
                            }
                        };
                        if !writes(l, "color") { te.color = None; }
                        if !writes(l, "rough") { te.rough = None; }
                        if !writes(l, "metal") { te.metal = None; }
                        if !writes(l, "normal") { te.normal = None; }
                        if !writes(l, "height") { te.height = None; }
                        (te, l.opacity * mask)
                    })
                    .collect();
                // colour, roughness, metallic: each layer over what's below by its blend, at its alpha
                let mut col = [188f32; 3];
                let mut any = false;
                if on("color") {
                    for (j, (te, op)) in texels.iter().enumerate() {
                        if let Some((v, c)) = te.color {
                            let a = c * op;
                            if a <= 0.0 { continue; }
                            any = true;
                            let mode = blend_of(shown[j], "color");
                            for k in 0..3 { let d = col[k] / 255.0; col[k] = (d + (blended(d, v[k] / 255.0, &mode) - d) * a) * 255.0; }
                        }
                    }
                }
                row.0[x] = col.map(|c| c.clamp(0.0, 255.0).round() as u8);
                row.6[x] = any;
                for (ch, base, slot) in [("rough", 128.0, 1), ("metal", 0.0, 2)] {
                    let mut val: f32 = base;
                    if on(ch) {
                        for (j, (te, op)) in texels.iter().enumerate() {
                            if let Some((v, c)) = if ch == "rough" { te.rough } else { te.metal } {
                                let a = c * op;
                                if a > 0.0 { let d = val / 255.0; val = (d + (blended(d, v / 255.0, &blend_of(shown[j], ch)) - d) * a) * 255.0; }
                            }
                        }
                    }
                    if slot == 1 { row.1[x] = val.clamp(0.0, 255.0).round() as u8 } else { row.2[x] = val.clamp(0.0, 255.0).round() as u8 }
                }
                // normals: whiteout, never an average
                if on("normal") {
                    let (mut nx, mut ny, mut nz) = (0f32, 0f32, 1f32);
                    for (te, op) in &texels {
                        if let Some((v, c)) = te.normal {
                            let a = c * op;
                            if a <= 0.0 { continue; }
                            let (dx, dy, dz) = (v[0] / 127.5 - 1.0, v[1] / 127.5 - 1.0, v[2] / 127.5 - 1.0);
                            let r = bake::norm([nx + dx, ny + dy, nz * dz]);
                            nx += (r[0] - nx) * a; ny += (r[1] - ny) * a; nz += (r[2] - nz) * a;
                            let l = bake::norm([nx, ny, nz]);
                            (nx, ny, nz) = (l[0], l[1], l[2]);
                        }
                    }
                    row.3[x] = [nx, ny, nz].map(|c| ((c * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0).round() as u8);
                }
                if on("height") {
                    let mut h: f32 = 128.0;
                    for (j, (te, op)) in texels.iter().enumerate() {
                        if let Some((v, c)) = te.height {
                            let a = c * op;
                            if a <= 0.0 { continue; }
                            let (d, s, mode) = (h / 255.0, v / 255.0, blend_of(shown[j], "height"));
                            let bl = if mode == "add" { (d + (s - 0.5)).clamp(0.0, 1.0) } else { blended(d, s, &mode) };
                            h = (d + (bl - d) * a) * 255.0;
                        }
                    }
                    row.4[x] = h.clamp(0.0, 255.0).round() as u8;
                }
            }
            row
        })
        .collect();
    let mut out = Out { color: vec![], rough: vec![], metal: vec![], normal: vec![], height: vec![], ao: vec![], covered: vec![], owner };
    for r in rows {
        out.color.extend(r.0); out.rough.extend(r.1); out.metal.extend(r.2); out.normal.extend(r.3); out.height.extend(r.4); out.ao.extend(r.5); out.covered.extend(r.6);
    }
    out
}

fn stride(ch: &str) -> usize { if ch == "color" || ch == "normal" { 4 } else { 2 } }

/// Carry the paint `p` texels out past its islands into the empty texture (paint.ts `bleed`): only texels off the
/// surface are written, so a face left bare stays bare; two islands meeting in a gap stop halfway.
fn pad(o: &mut Out, n: usize, p: usize) {
    let p = p.min(512);
    if p == 0 { return; }
    let mut seen: Vec<bool> = o.covered.clone();
    // only painted texels with an unpainted neighbour can spread (all of them would be 64M entries at 8K)
    let edge = |i: usize| { let (x, y) = (i % n, i / n); (x > 0 && !o.covered[i - 1]) || (x + 1 < n && !o.covered[i + 1]) || (y > 0 && !o.covered[i - n]) || (y + 1 < n && !o.covered[i + n]) };
    let mut front: Vec<usize> = (0..n * n).into_par_iter().filter(|&i| o.covered[i] && edge(i)).collect();
    for _ in 0..p {
        let mut next = Vec::new();
        for &i in &front {
            let (x, y) = (i % n, i / n);
            for (dx, dy) in [(1isize, 0isize), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (x as isize + dx, y as isize + dy);
                if nx < 0 || ny < 0 || nx >= n as isize || ny >= n as isize { continue; }
                let j = ny as usize * n + nx as usize;
                if seen[j] { continue; }
                seen[j] = true;
                if o.owner[j] == NONE {
                    o.color[j] = o.color[i]; o.rough[j] = o.rough[i]; o.metal[j] = o.metal[i]; o.normal[j] = o.normal[i]; o.height[j] = o.height[i];
                }
                next.push(j);
            }
        }
        front = next;
    }
}

/// An n² image as PNG, rows flipped (texture row 0 is v = 0, an image's is the top).
fn png(path: &Path, n: usize, channels: usize, px: impl Fn(usize, &mut [u8]) + Sync) -> Result<(), String> {
    let f = std::io::BufWriter::new(std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?);
    let mut enc = png::Encoder::new(f, n as u32, n as u32);
    enc.set_color(if channels == 1 { png::ColorType::Grayscale } else if channels == 3 { png::ColorType::Rgb } else { png::ColorType::Rgba });
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    let mut w = enc.write_header().map_err(|e| e.to_string())?;
    let mut data = vec![0u8; n * n * channels];
    data.par_chunks_mut(n * channels).enumerate().for_each(|(row, out)| {
        let y = n - 1 - row;
        for x in 0..n { px(y * n + x, &mut out[x * channels..(x + 1) * channels]); }
    });
    w.write_image_data(&data).map_err(|e| e.to_string())
}

struct Assets { materials: HashMap<String, Material>, decals: HashMap<String, Map> }

/// Decode every asset the request names that has a file on disk (the rest fall back to working-res pixels).
fn assets(req: &ExportReq) -> Assets {
    let materials = req
        .materials
        .iter()
        .filter_map(|(id, maps)| {
            let get = |k: &str| maps.get(k).and_then(|u| file_of(u)).and_then(|p| decode(&p).ok());
            let m = Material { basecolor: get("basecolor"), normal: get("normal"), roughness: get("roughness"), metallic: get("metallic"), height: get("height") };
            // a material whose colour map can't be read renders from its working-res pixels instead
            (m.basecolor.is_some() || !maps.contains_key("basecolor")).then(|| (id.clone(), m))
        })
        .collect();
    let decals = req.decals.iter().filter_map(|(id, u)| Some((id.clone(), decode(&file_of(u)?).ok()?))).collect();
    Assets { materials, decals }
}

/// Render and write every requested part's maps. Body: a Pack whose JSON is an `ExportReq` (blob `fbx`: the model).
pub fn export(body: &[u8]) -> Result<Option<ExportDone>, String> {
    let pack = Pack::decode(body)?;
    let req: ExportReq = serde_json::from_str(&pack.json).map_err(|e| e.to_string())?;
    let dir = match &req.out {
        Some(d) => PathBuf::from(d),
        None => match rfd::FileDialog::new().set_title("Export textures into…").pick_folder() { Some(d) => d, None => return Ok(None) },
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = run(&req, &dir, pack.blobs.iter().find(|(k, _)| k == "fbx").map(|(_, v)| v.as_slice()));
    progress("");
    result.map(|files| Some(ExportDone { dir: dir.display().to_string(), files }))
}

fn run(req: &ExportReq, dir: &Path, fbx: Option<&[u8]>) -> Result<Vec<String>, String> {
    progress("Reading the project…");
    let project = load(Path::new(&req.project))?;
    let doc: Doc = serde_json::from_str(&project.json).map_err(|e| format!("project document: {e}"))?;
    let blobs: HashMap<&str, &[u8]> = project.blobs.iter().map(|(k, v)| (k.as_str(), v.as_slice())).collect();
    let floats = |name: &str| -> Result<Vec<f32>, String> {
        let b = blobs.get(name).ok_or_else(|| format!("the project has no {name}"))?;
        Ok(b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect())
    };
    let n = req.size.clamp(16, 16384);
    let positions: Vec<Vec<f32>> = (0..doc.parts.len()).map(|i| floats(&format!("out/{i}/positions"))).collect::<Result<_, _>>()?;
    let casters: Vec<&[f32]> = doc.parts.iter().zip(&positions).filter(|(p, _)| p.visible).map(|(_, q)| q.as_slice()).collect();
    // fills and decals size against the whole model's box diagonal, generators against its bounding sphere (as the editor)
    let (lo, hi) = positions.iter().flat_map(|p| p.chunks_exact(3)).fold(([f32::MAX; 3], [f32::MIN; 3]), |(mut lo, mut hi), v| {
        for k in 0..3 { lo[k] = lo[k].min(v[k]); hi[k] = hi[k].max(v[k]); }
        (lo, hi)
    });
    let diag = { let d = bake::sub(hi, lo); bake::dot(d, d).sqrt().max(1e-6) };
    let gen_span = 2.0 * bake::sphere(&casters).1;
    progress("Loading materials and decals…");
    let assets = assets(req);
    let wanted: Vec<usize> = req.parts.clone().unwrap_or_else(|| (0..doc.parts.len()).collect());
    let todo: Vec<usize> = wanted.into_iter().filter(|&i| doc.sets.get(i).is_some_and(|s| s.is_some())).collect();
    let needs_ao = req.preset != "unity-urp" || todo.iter().any(|&i| doc.sets[i].as_ref().unwrap().layers.iter().any(|l| l.gen.is_some()));
    let occ = needs_ao.then(|| { progress("Baking ambient occlusion views…"); Occlusion::new(&casters) });
    let mut files = vec![];
    for (k, &i) in todo.iter().enumerate() {
        let set = doc.sets[i].as_ref().unwrap();
        let name = &doc.parts[i].name;
        let label = format!("{name} ({} of {})", k + 1, todo.len());
        progress(format!("Rendering {label} at {n}×{n}…"));
        let uv = floats(&format!("part/{i}/uv"))?;
        let mesh = Mesh::new(&positions[i], &uv);
        let edges = set.layers.iter().any(|l| l.gen.is_some()).then(|| Edges::new(&positions[i], 0.05 * gen_span));
        // tiles back into one working-res buffer per layer channel
        let tiles = |id: u32, what: &str, st: usize| -> Vec<u8> {
            let wn = set.size;
            let t = wn.min(256);
            let mut buf = vec![0u8; wn * wn * st];
            for ty in 0..wn / t {
                for tx in 0..wn / t {
                    if let Some(data) = blobs.get(format!("set/{i}/{id}/{what}/{tx}_{ty}").as_str()) {
                        for y in 0..t { buf[((ty * t + y) * wn + tx * t) * st..((ty * t + y) * wn + tx * t + t) * st].copy_from_slice(&data[y * t * st..(y + 1) * t * st]); }
                    }
                }
            }
            buf
        };
        let mut out = render(&mesh, set, n, diag, gen_span, occ.as_ref(), edges.as_ref(), &tiles, &assets);
        progress(format!("Padding {label}…"));
        pad(&mut out, n, req.padding.unwrap_or((n / 64).max(4)));
        progress(format!("Writing {label}…"));
        let prefix = format!("{}-{name}", req.base);
        let mut write = |suffix: &str, ch: usize, f: &(dyn Fn(usize, &mut [u8]) + Sync)| -> Result<(), String> {
            let file = format!("{prefix}-{suffix}.png");
            png(&dir.join(&file), n, ch, f)?;
            files.push(file);
            Ok(())
        };
        let on = |c: &str| set.channels.iter().any(|x| x == c);
        write("BaseColor", 3, &|i, o| o.copy_from_slice(&out.color[i]))?;
        match req.preset.as_str() {
            "unreal" => {
                write("Normal", 3, &|i, o| { let v = out.normal[i]; o.copy_from_slice(&[v[0], 255 - v[1], v[2]]) })?;
                write("ORM", 3, &|i, o| o.copy_from_slice(&[out.ao[i], out.rough[i], out.metal[i]]))?;
                if on("height") { write("Height", 1, &|i, o| o[0] = out.height[i])?; }
            }
            "unity-hdrp" => {
                write("Normal", 3, &|i, o| o.copy_from_slice(&out.normal[i]))?;
                write("MaskMap", 4, &|i, o| o.copy_from_slice(&[out.metal[i], out.ao[i], 0, 255 - out.rough[i]]))?;
                if on("height") { write("Height", 1, &|i, o| o[0] = out.height[i])?; }
            }
            "unity-urp" => {
                write("Normal", 3, &|i, o| o.copy_from_slice(&out.normal[i]))?;
                write("MetallicSmoothness", 4, &|i, o| o.copy_from_slice(&[out.metal[i], 0, 0, 255 - out.rough[i]]))?;
                if on("height") { write("Height", 1, &|i, o| o[0] = out.height[i])?; }
            }
            _ => {
                if on("rough") { write("Roughness", 1, &|i, o| o[0] = out.rough[i])?; }
                if on("metal") { write("Metallic", 1, &|i, o| o[0] = out.metal[i])?; }
                if on("normal") { write("Normal", 3, &|i, o| o.copy_from_slice(&out.normal[i]))?; }
                if on("height") { write("Height", 1, &|i, o| o[0] = out.height[i])?; }
                if occ.is_some() { write("AmbientOcclusion", 1, &|i, o| o[0] = out.ao[i])?; }
                write("ORM", 3, &|i, o| o.copy_from_slice(&[out.ao[i], out.rough[i], out.metal[i]]))?;
            }
        }
    }
    if let (Some(name), Some(bytes)) = (&req.fbx, fbx) {
        std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
        files.push(name.clone());
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::save;

    /// A box's top (normal +z) meeting its side (+x) at a 90° edge: the same numbers as paint.check.ts's bevel block —
    /// a round bevel leans 30° at half the radius and nothing past it, a chamfer 45°, and a 100° threshold skips it.
    #[test]
    fn bevel_matches_the_editor() {
        let bx: [f32; 36] = [0., 0., 1., 1., 0., 1., 1., 1., 1., 0., 0., 1., 1., 1., 1., 0., 1., 1., 1., 0., 1., 1., 0., 0., 1., 1., 0., 1., 0., 1., 1., 1., 0., 1., 1., 1.];
        let b = |profile: &str, angle: f32| Bevel { radius: 0.1, profile: profile.into(), angle, concave: false };
        let lean = |src: &layers::BevelSrc, x: f32| src.normal([x, 0.5, 1.0], [0.0, 0.0, 1.0]).map(|n| n[0].atan2(n[2]).to_degrees());
        let round = layers::BevelSrc::new(&b("round", 30.0), &bx);
        assert!((lean(&round, 0.95).unwrap() - 30.0).abs() < 1e-3, "round at r/2: {:?}", lean(&round, 0.95));
        assert!(lean(&round, 0.85).is_none(), "past the radius");
        let chamfer = layers::BevelSrc::new(&b("chamfer", 30.0), &bx);
        assert!((lean(&chamfer, 0.95).unwrap() - 45.0).abs() < 1e-3, "chamfer");
        assert!(lean(&layers::BevelSrc::new(&b("round", 100.0), &bx), 0.95).is_none(), "under the threshold");
    }

    /// The engine draws a grip texture as the editor does: paint.ts `shapeHeight` at the same points (from Node).
    #[test]
    fn shape_relief_matches_the_editor() {
        let sh = |p: &str| Shape { pattern: p.into(), corner: 0.2, border: 0.06, depth: 0.03, cell: 0.05, amount: 0.012, outline: None };
        let pts = [(0.3079, 0.2233), (-0.1728, 0.5644), (0.0044, 0.3288), (0.2237, 0.6699), (0.1085, -0.0205), (0.47, 0.2)];
        let want = [
            ("stipple", [0.003171373, 0.005149145, 0.006135595, 0.004268161, 0.01070719, -0.03]),
            ("grooves", [-0.011727217, -0.002837988, -0.010657637, -0.009618804, -0.010131935, -0.03]),
            ("checker", [0.004714192, 0.010213977, 0.00690817, 0.007445302, 0.004215948, -0.03]),
        ];
        for (p, w) in want {
            for (&(x, y), w) in pts.iter().zip(w) {
                let h = layers::shape_height(&sh(p), x, y, 0.5, 1.0).unwrap();
                assert!((h - w).abs() < 2e-5, "{p} at ({x}, {y}): engine {h}, editor {w}");
            }
            assert!(layers::shape_height(&sh(p), 0.6, 0.0, 0.5, 1.0).is_none(), "{p}: nothing outside the outline");
        }
        // a free outline with rounded corners
        let sh = Shape { pattern: "stipple".into(), corner: 0.08, border: 0.05, depth: 0.02, cell: 0.04, amount: 0.01, outline: Some(vec![[-1.0, -1.0], [0.8, -0.9], [1.0, 0.4], [0.0, 1.0], [-0.6, 0.3]]) };
        let pts = [(0.0, 0.0), (0.1, -0.2), (-0.3, 0.1), (0.35, 0.2), (0.42, -0.4), (-0.45, -0.45), (0.2, 0.6), (0.6, 0.6)];
        let want = [Some(0.0), Some(0.0), Some(-0.019924021), Some(0.001377607), Some(-0.006470219), None, None, None];
        for (&(x, y), w) in pts.iter().zip(want) {
            let h = layers::shape_height(&sh, x, y, 0.5, 0.7);
            assert!(match (h, w) { (Some(h), Some(w)) => (h - w).abs() < 2e-5, (None, None) => true, _ => false }, "outline at ({x}, {y}): engine {h:?}, editor {w:?}");
        }
    }

    /// Wrapping unfolds the surface (paint.ts `expMap`): a strip bent 90° over an edge, its far face's corners one unit
    /// past the fold, exactly as the editor places them.
    #[test]
    fn wrap_map_unfolds_a_fold() {
        let fold = [0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 0., 0., 1., 1., 0., 0., 1., 0., 1., 0., 0., 1., 0., -1., 1., 1., -1., 1., 0., 0., 1., 1., -1., 1., 1., 0.];
        let m = layers::exp_map(&fold, [0.5, 0.5, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], 5.0);
        let want = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 1.5, -0.5, 1.5, 0.5, 0.5, -0.5, 1.5, 0.5, 0.5, 0.5];
        for (k, (a, b)) in m.iter().zip(want).enumerate() { assert!((a - b).abs() < 1e-9, "corner {}: engine {a}, editor {b}", k / 2); }
    }

    /// A unit cube (12 triangles, each face its own UV cell in a 3×2 grid), painted red at 64² by hand, plus edge
    /// wear, rendered at 256².
    #[test]
    fn renders_a_project_at_four_times_its_working_size() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("texture-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (mut pos, mut uv) = (vec![], vec![]);
        let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
            ([0., 0., 1.], [1., 0., 0.], [0., 1., 0.]), ([0., 0., -1.], [-1., 0., 0.], [0., 1., 0.]), ([1., 0., 0.], [0., 0., -1.], [0., 1., 0.]),
            ([-1., 0., 0.], [0., 0., 1.], [0., 1., 0.]), ([0., 1., 0.], [1., 0., 0.], [0., 0., -1.]), ([0., -1., 0.], [1., 0., 0.], [0., 0., 1.]),
        ];
        for (f, (n, u, v)) in faces.iter().enumerate() {
            let c = |a: f32, b: f32| [0, 1, 2].map(|k| n[k] * 0.5 + u[k] * (a - 0.5) + v[k] * (b - 0.5));
            let (cu, cv) = ((f % 3) as f32 / 3.0, (f / 3) as f32 / 2.0);
            let m = 0.02;
            for (a, b) in [(0., 0.), (1., 0.), (1., 1.), (0., 0.), (1., 1.), (0., 1.)] {
                pos.extend(c(a, b));
                uv.extend([cu + m + a * (1.0 / 3.0 - 2.0 * m), cv + m + b * (0.5 - 2.0 * m)]);
            }
        }
        let wn = 64;
        let mut red = vec![0u8; wn * wn * 4];
        for px in red.chunks_exact_mut(4) { px.copy_from_slice(&[220, 20, 20, 255]); }
        let f32s = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
        let mut blobs = vec![("out/0/positions".to_string(), f32s(&pos)), ("part/0/uv".to_string(), f32s(&uv))];
        // one tile (64 < 256): the whole layer
        blobs.push(("set/0/1/color/0_0".into(), red));
        let doc = serde_json::json!({
            "parts": [{ "name": "Cube", "visible": true }],
            "sets": [{ "size": wn, "channels": ["color", "rough", "metal"], "active": 1, "layers": [
                { "id": 1, "name": "Paint", "visible": true, "opacity": 1, "px": ["color"], "mask": false },
                { "id": 2, "name": "Edge Wear", "visible": true, "opacity": 1, "px": [], "mask": false,
                  "gen": { "kind": "edge", "amount": 0.6, "soft": 0.15, "width": 0.05, "grunge": 0, "scale": 0.03, "color": "#ffffff", "rough": 0.35, "metal": 1, "clip": false } }
            ] }]
        });
        let project = dir.join("cube.barista");
        save(&project, &Pack { json: doc.to_string(), blobs }).unwrap();
        let req = serde_json::json!({ "project": project.display().to_string(), "out": dir.display().to_string(), "size": 256, "base": "t" });
        let done = export(&Pack { json: req.to_string(), blobs: vec![] }.encode()).unwrap().unwrap();
        for f in ["t-Cube-BaseColor.png", "t-Cube-Roughness.png", "t-Cube-Metallic.png", "t-Cube-AmbientOcclusion.png", "t-Cube-ORM.png"] {
            assert!(done.files.iter().any(|x| x == f), "{f} missing from {:?}", done.files);
        }
        let img = image::open(dir.join("t-Cube-BaseColor.png")).unwrap().to_rgb8();
        // the middle of the first face (u 1/6, v 1/4; images flip v): red, upsampled from 64² unchanged
        let mid = img.get_pixel(256 / 6, 256 - 1 - 256 / 4);
        assert_eq!(mid.0, [220, 20, 20], "face centre");
        // next to a cube edge the wear is white-ish and metallic
        let near_edge = img.get_pixel((256.0 * (0.02 + 0.005)) as u32, 256 - 1 - 256 / 4);
        assert!(near_edge.0[1] > 120, "edge wear at the border: {:?}", near_edge.0);
        let metal = image::open(dir.join("t-Cube-Metallic.png")).unwrap().to_luma8();
        assert_eq!(metal.get_pixel(256 / 6, 256 - 1 - 256 / 4).0[0], 0, "no wear mid-face");
        // padding: two texels past the island's right edge (u = 1/3 − 0.02) take its edge texel (worn white); the middle,
        // more than max(4, n/64) texels from either island, stays bare
        let gap = img.get_pixel((256.0 * (1.0 / 3.0 - 0.02)) as u32 + 2, 256 - 1 - 256 / 4);
        assert_ne!(gap.0, [188, 188, 188], "the gutter is padded");
        assert_eq!(img.get_pixel(256 / 3, 256 - 1 - 256 / 4).0, [188, 188, 188], "beyond the padding");
        std::fs::remove_dir_all(dir).ok();
    }
}
