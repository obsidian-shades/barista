//! Barista's unwrap engine: cut meshes into islands that each flatten with no flips, no overlap and little stretch.
//!
//! 1. weld + orient each part (`mesh`)
//! 2. charts (`region`): smooth simple regions stay whole; boxy and tangled ones go to the side of the shell's box
//!    frame they face, small walls and bevels joining the face they're cut into (a slide's flank and its grooves)
//! 3. per chart (`chart::solve`): closed → open along its shortest loops · with holes → projected and relaxed
//!    without overlap (`flatten::flatten_slim`), else holes seamed to the border · LSCM + ARAP (`flatten`) ·
//!    unfolds flat but folds over itself → carve it into pieces that don't overlap · stretched cone tip → seam to the border.
//!    Past `tol`, try splitting it and keep whichever costs less: the stretch, or the halves plus `seam_weight` ×
//!    the new seam.
//! 4. join each part's islands into nets: hang islands off each other along shared edges, never overlapping (`join`)
//! 5. pack each part's nets into its own unit square (or all parts into one, `one_atlas`) at one texel density (`pack`)
pub mod chart;
pub mod edit;
pub mod flatten;
pub mod ideal;
pub mod join;
pub mod mesh;
pub mod symmetry;
pub mod pack;
pub mod quads;
pub mod region;
pub mod shapes;
pub mod stroke;
pub mod topology;
pub mod torus;

/// Request bodies, the same for the server's routes (src/main.rs) and the desktop app's commands (src-tauri).
pub mod req {
    use crate::edit::{IslandIn, ReseamIn};
    use crate::{Params, PartIn};
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct UnwrapReq { pub parts: Vec<PartIn>, #[serde(default)] pub params: Params }

    /// One part after a seam change: just the islands it touches solved again (`edit::reseam`).
    #[derive(Deserialize)]
    pub struct ReseamReq { pub part: ReseamIn, #[serde(default)] pub params: Params }

    /// u,v per corner, one list per island.
    #[derive(Deserialize)]
    pub struct PackReq { pub islands: Vec<Vec<f32>>, #[serde(default)] pub rotate: bool }

    /// Islands as the editor holds them (xyz and uv per corner), each relaxed on its own.
    #[derive(Deserialize)]
    pub struct IslandsReq { pub islands: Vec<IslandIn> }

    #[derive(Deserialize)]
    pub struct EdgeLoopReq { pub positions: Vec<f32>, pub edge: Vec<f32> }
}

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
#[serde(default)]
pub struct Params {
    /// Edges bending more than this (degrees) are always seams.
    pub sharp: f64,
    /// Mean stretch an island may have without even trying a split (0.08 = 8%).
    pub tol: f64,
    /// What a unit of seam costs against a unit of stretch × area: higher means fewer, more stretched islands.
    pub seam_weight: f64,
    /// Join islands into nets (a cube's faces into its cross) where they fit without overlapping.
    pub join: bool,
    /// How far the atlas may break a net up again, 0..1. A net saves seams but spends its own box: one that fills
    /// under half of the smallest box round it (a band folding back across itself) leaves more texture unused than
    /// the seam it saves is worth. 0 keeps every net (a paper model, the cube's cross); 1 breaks every net that
    /// packs better apart, island for island; in between breaks the worst of them (fill, worst first).
    pub atlas: f64,
    /// Pack every part into one shared atlas; otherwise each part gets its own 0..1 square.
    pub one_atlas: bool,
}

impl Default for Params {
    fn default() -> Self { Params { sharp: 45., tol: 0.08, seam_weight: 0.1, join: true, atlas: 0., one_atlas: false } }
}

#[derive(Deserialize, Default)]
pub struct PartIn {
    #[serde(default)]
    pub name: String,
    /// xyz per corner, three corners per triangle.
    pub positions: Vec<f32>,
    /// Edges that must be seams: two xyz endpoints (6 numbers) each.
    #[serde(default)]
    pub seams: Vec<f32>,
    /// Per input triangle, the file's polygon it belongs to (empty: triangles): no seam runs inside a polygon.
    #[serde(default)]
    pub polys: Vec<u32>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Stats {
    pub islands: usize,
    pub tris: usize,
    pub flips: usize,
    /// Area-weighted mean of max(|ln σ1|, |ln σ2|): 0.05 ≈ 5% stretch.
    pub mean_stretch: f64,
    pub max_stretch: f64,
    /// Share of the area stretched under 5%.
    pub good_area: f64,
    /// Share of used texels claimed twice (512² raster of the final atlas; the worst part's, one atlas per part).
    pub overlap: f64,
    /// UV area of all triangles over the atlas area: how much of the square the packing fills (mean over parts,
    /// one atlas per part).
    pub efficiency: f64,
    pub ms: f64,
    /// How many of the `islands` are a mirrored half's image (`symmetry`): islands − twins counts each pair once.
    /// Engine-side only (not sent to the editor).
    #[serde(skip)]
    pub twins: usize,
}

/// Per corner (3 per triangle): `positions` xyz in the input's units, `uvs`. Per triangle: `stretch` (−1 = flipped),
/// `island` (numbered across all parts), `source` (its index in the input soup: the editor maps it to the file's polygons).
#[derive(Serialize)]
pub struct PartOut {
    pub positions: Vec<f32>,
    pub uvs: Vec<f32>,
    pub stretch: Vec<f32>,
    pub island: Vec<u32>,
    pub source: Vec<u32>,
}

#[derive(Serialize)]
pub struct Output {
    pub parts: Vec<PartOut>,
    pub stats: Stats,
}

/// Pack whole nets, in real units, so every part gets the same texel density: all into one square, or each part's
/// into its own; a mirrored net packs with its image beside it.
fn uv_set(m: &mesh::Mesh, isl: &[chart::Island], ms: &[usize]) -> pack::UvSet {
    let mut set = pack::UvSet { u: vec![], v: vec![], outline: vec![], tris: vec![], along: None, xyz: vec![] };
    for &i in ms {
        let (s, r) = (&isl[i], m.radius);
        let off = set.u.len();
        // the net's biggest book sets its turn: spine along an axis, pages either side, as in a mockup
        if let (None, Some([a, b])) = (set.along, s.spine) {
            let (a, b) = (a as usize, b as usize);
            set.along = Some((s.f.v[b] - s.f.v[a]).atan2(s.f.u[b] - s.f.u[a]));
        }
        set.outline.push(s.l.loops[0].iter().map(|&k| k as usize + off).collect());
        set.tris.extend(s.l.t.iter().map(|t| t.map(|k| k as usize + off)));
        set.u.extend(s.f.u.iter().map(|x| x * r));
        set.v.extend(s.f.v.iter().map(|x| x * r));
        set.xyz.extend(s.l.orig.iter().map(|&o| m.pt(o).map(|x| x * r)));
    }
    set
}

/// How much of its square a part's islands fill when packed on their own: what that part's atlas will be worth.
fn fill(m: &mesh::Mesh, isl: &[chart::Island], nets: &[usize]) -> f64 {
    let n = nets.iter().max().map_or(0, |x| x + 1);
    let mut members = vec![Vec::new(); n];
    for (i, &g) in nets.iter().enumerate() { members[g].push(i); }
    let mut sets: Vec<pack::UvSet> = members.iter().map(|ms| uv_set(m, isl, ms)).collect();
    pack::pack(&mut sets, true);
    sets.iter().map(pack::area).sum()
}

/// How much better the loose islands must pack than the nets before a net is broken up.
const NETS_PAY: f64 = 1.02;

/// A net that fills less of its own box than this is broken back into its islands before packing: on a mirrored
/// part the whole part goes loose instead.
const NET_KEEP: f64 = 0.48;

/// Break up the nets that don't pack, up to `atlas` of the candidates: each net is measured by the box it will be
/// placed in, and one that leaves too much of that box dead carries more atlas cost than the seam it saves. The
/// islands themselves stay as they are (same layout, same count) — only their net number changes, so this costs a
/// pack, not a solve.
fn loosen(isl: &[chart::Island], nets: &[usize], atlas: f64) -> Vec<usize> {
    if !(atlas > 0.) { return nets.to_vec(); }
    let n = nets.iter().max().map_or(0, |x| x + 1);
    let mut members = vec![Vec::new(); n];
    for (i, &g) in nets.iter().enumerate() { members[g].push(i); }
    let mut worst: Vec<(f64, usize)> = members.iter().enumerate()
        .filter(|(_, ms)| ms.len() > 1)
        .map(|(g, ms)| (join::net_fill(isl, ms), g))
        .filter(|&(f, _)| f < NET_KEEP)
        .collect();
    worst.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let cut = ((worst.len() as f64) * atlas.min(1.)).round() as usize;
    let broken: std::collections::HashSet<usize> = worst.iter().take(cut).map(|&(_, g)| g).collect();
    let (mut out, mut next) = (vec![0usize; nets.len()], 0usize);
    for (g, ms) in members.iter().enumerate() {
        let keep = !broken.contains(&g);
        for (k, &i) in ms.iter().enumerate() { out[i] = if keep { next } else { next + k }; }
        next += if keep { 1 } else { ms.len().max(1) };
    }
    out
}

/// Nets or loose islands: pack each way and keep whichever fills its square better (the nets have to be worth
/// `NETS_PAY`). Both assignments run over the same islands.
fn pick_nets(m: &mesh::Mesh, isl: &[chart::Island], a: Vec<usize>, b: Vec<usize>) -> Vec<usize> {
    if a == b { return a; } // nothing broke up: no need to pack it twice
    if fill(m, isl, &a) * NETS_PAY >= fill(m, isl, &b) { a } else { b }
}

/// The same choice where the two ways solve the part differently (a mirrored part: nets and loose halves are two
/// runs). `loose` is only called when the nets leave something on the table.
fn arbitrate(m: &mesh::Mesh, nets: (Vec<chart::Island>, Vec<usize>, Vec<(usize, usize)>),
             loose: impl FnOnce() -> (Vec<chart::Island>, Vec<usize>, Vec<(usize, usize)>)) -> (Vec<chart::Island>, Vec<usize>, Vec<(usize, usize)>) {
    if fill(m, &nets.0, &nets.1) >= 0.5 { return nets; }
    let a = fill(m, &nets.0, &nets.1);
    let alt = loose();
    let b = fill(m, &alt.0, &alt.1);
    if b > a * NETS_PAY { alt } else { nets }
}

pub fn unwrap(parts: &[PartIn], p: Params) -> Result<Output, String> {
    let t0 = Instant::now();
    if parts.is_empty() {
        return Err("no parts".into());
    }
    let named = |i: usize, e: String| if parts.len() > 1 { format!("{}: {e}", if parts[i].name.is_empty() { format!("part {}", i + 1) } else { parts[i].name.clone() }) } else { e };
    let meshes = parts.par_iter().enumerate()
        .map(|(i, q)| mesh::Mesh::from_soup(&q.positions).map(|mut m| { m.set_polys(&q.polys); m }).map_err(|e| named(i, e)))
        .collect::<Result<Vec<_>, _>>()?;
    #[allow(clippy::type_complexity)]
    let per_part: Vec<(Vec<chart::Island>, Vec<usize>, Vec<(usize, usize)>)> = meshes.par_iter().enumerate().map(|(i, m)| {
        let seams = m.edges_at(&parts[i].seams);
        // a part with a left and a right comes out as two mirrored halves (`symmetry`)
        let sym = symmetry::find(m).filter(|s| s.keeps(&seams) && !s.seam(m).iter().any(|&k| m.inside(k)));
        let (mut v, nets, twins) = match sym {
            Some(s) => {
                let joined = symmetry::unwrap(m, &s, &seams, &p);
                // a net is a paper-model convenience; the atlas pays for its empty corners. Solve the part both
                // ways and keep whichever fills its square better (`arbitrate`).
                if p.join && p.atlas > 0. {
                    let mut loose = p;
                    loose.join = false;
                    arbitrate(m, joined, || symmetry::unwrap(m, &s, &seams, &loose))
                } else { joined }
            }
            None => {
                let mut v = chart::unwrap(m, &seams, &p);
                if !p.join { let n = v.len(); (v, (0..n).collect(), vec![]) } else {
                    let nets = join::join(m, &mut v, p.tol);
                    let loose = loosen(&v, &nets, p.atlas);
                    let nets = pick_nets(m, &v, nets, loose);
                    (v, nets, vec![])
                }
            }
        };
        for s in &mut v { s.part = i; }
        (v, nets, twins)
    }).collect();
    // number nets across parts; an island's id in the output is its net's
    let (mut isl, mut net, mut twins, mut count) = (Vec::new(), Vec::new(), Vec::new(), 0);
    for (v, g, t) in per_part {
        net.extend(g.iter().map(|x| x + count));
        twins.extend(t.iter().map(|&(a, b)| (a + count, b + count)));
        count += g.iter().max().map_or(0, |x| x + 1);
        isl.extend(v);
    }

    // pack whole nets, in real units, so every part gets the same texel density: all into one square, or each
    // part's into its own; a mirrored net packs with its image beside it
    let mut members = vec![Vec::new(); count];
    for (i, &g) in net.iter().enumerate() { members[g].push(i); }
    let image: mesh::Map<usize, usize> = twins.iter().map(|&(a, b)| (b, a)).collect();
    let twin: mesh::Map<usize, usize> = twins.iter().copied().collect();
    let atlases: Vec<Vec<usize>> = if p.one_atlas { vec![(0..count).filter(|g| !image.contains_key(g)).collect()] } else {
        (0..meshes.len()).map(|k| (0..count).filter(|&g| isl[members[g][0]].part == k && !image.contains_key(&g)).collect()).collect()
    };
    let sets: Vec<pack::UvSet> = members.iter().map(|ms| uv_set(&meshes[isl[ms[0]].part], &isl, ms)).collect();
    let mut slots: Vec<Option<pack::UvSet>> = sets.into_iter().map(Some).collect();
    let mut uv: Vec<(Vec<f64>, Vec<f64>)> = vec![Default::default(); count];
    for a in &atlases {
        let gap = pack::gap(a.iter().chain(a.iter().filter_map(|g| twin.get(g))).map(|&g| slots[g].as_ref().unwrap()));
        let mut group: Vec<pack::UvSet> = a.iter().map(|&g| {
            let s = slots[g].take().unwrap();
            match twin.get(&g) { Some(&h) => pack::twin(s, slots[h].take().unwrap(), gap), None => s }
        }).collect();
        if !group.is_empty() { pack::pack(&mut group, true); }
        for (&g, mut set) in a.iter().zip(group) {
            if let Some(&h) = twin.get(&g) {
                let n = members[g].iter().map(|&i| isl[i].f.u.len()).sum();
                uv[h] = (set.u.split_off(n), set.v.split_off(n));
            }
            uv[g] = (set.u, set.v);
        }
    }
    for (ms, set) in members.iter().zip(uv) {
        let mut off = 0;
        for &i in ms {
            let k = isl[i].f.u.len();
            isl[i].f.u = set.0[off..off + k].to_vec();
            isl[i].f.v = set.1[off..off + k].to_vec();
            off += k;
        }
    }

    let mut out: Vec<PartOut> = meshes.iter().map(|_| PartOut { positions: vec![], uvs: vec![], stretch: vec![], island: vec![], source: vec![] }).collect();
    let (mut n, mut flips, mut sum_e, mut sum_a, mut good, mut max_e) = (0, 0, 0., 0., 0., 0f64);
    for (si, s) in isl.iter().enumerate() {
        let (m, o) = (&meshes[s.part], &mut out[s.part]);
        for (i, tri) in s.l.t.iter().enumerate() {
            for &lv in tri {
                let q = m.pt(s.l.orig[lv as usize]);
                o.positions.extend((0..3).map(|k| (q[k] * m.radius + m.center[k]) as f32));
                o.uvs.extend([s.f.u[lv as usize] as f32, s.f.v[lv as usize] as f32]);
            }
            let (e, a) = (s.f.e[i], m.a[s.l.tris[i] as usize] * m.radius * m.radius);
            if e.is_finite() {
                sum_e += e * a;
                sum_a += a;
                max_e = max_e.max(e);
                if e < 0.05 { good += a; }
                o.stretch.push(e as f32);
            } else {
                flips += 1;
                o.stretch.push(-1.);
            }
            o.island.push(net[si] as u32);
            o.source.push(m.src[s.l.tris[i] as usize]);
            n += 1;
        }
    }
    let (overlap, efficiency) = if p.one_atlas {
        let all: Vec<f32> = out.iter().flat_map(|o| o.uvs.iter().copied()).collect();
        (pack::overlap(&all, 512), pack::efficiency(&all))
    } else {
        let per: Vec<(f64, f64)> = out.par_iter().map(|o| (pack::overlap(&o.uvs, 512), pack::efficiency(&o.uvs))).collect();
        (per.iter().map(|x| x.0).fold(0., f64::max), per.iter().map(|x| x.1).sum::<f64>() / per.len() as f64)
    };
    let stats = Stats {
        islands: count, tris: n, flips, overlap, efficiency, twins: twins.len(),
        mean_stretch: if sum_a > 0. { sum_e / sum_a } else { 0. },
        max_stretch: max_e,
        good_area: if sum_a > 0. { good / sum_a } else { 0. },
        ms: t0.elapsed().as_secs_f64() * 1e3,
    };
    Ok(Output { parts: out, stats })
}

/// One part, no seams: the shapes and tests use this.
pub fn unwrap_soup(soup: &[f32], p: Params) -> Result<Output, String> {
    unwrap(&[PartIn { positions: soup.to_vec(), ..Default::default() }], p)
}

/// Pack islands given as u,v pairs per corner, as they are now (after hand edits): sizes kept, no rotation unless asked.
pub fn repack(islands: Vec<Vec<f32>>, rotate: bool) -> Vec<Vec<f32>> {
    let mut sets: Vec<pack::UvSet> = islands.iter().map(|c| {
        let (u, v): (Vec<f64>, Vec<f64>) = c.chunks_exact(2).map(|p| (p[0] as f64, p[1] as f64)).unzip();
        let outline = vec![(0..u.len()).collect()];
        let tris = (0..u.len() / 3).map(|t| [3 * t, 3 * t + 1, 3 * t + 2]).collect();
        pack::UvSet { u, v, outline, tris, along: None, xyz: vec![] }
    }).collect();
    if sets.iter().any(|s| s.u.is_empty()) { return islands; }
    pack::pack(&mut sets, rotate);
    sets.into_iter().map(|s| s.u.iter().zip(&s.v).flat_map(|(&u, &v)| [u as f32, v as f32]).collect()).collect()
}

#[derive(Serialize, Debug)]
pub struct CheckRow {
    pub shape: &'static str,
    pub pass: bool,
    /// The ideal this shape is held to, in words.
    pub ideal: &'static str,
    pub stats: Stats,
}

/// Each core shape against its known ideal unwrap (`ideal`), at the given params. Everything: no flips, no
/// overlap. Cube: the Latin cross. Cylinder: the tin can. Cone: sector with the disc on its arc. All three at 0%
/// stretch, one piece. Torus and knot: one seamless strip. Sphere and capsule (no flat ideal): one piece or a
/// few, at most 12% stretch.
pub fn check(p: Params) -> Vec<CheckRow> {
    shapes::NAMES.par_iter().map(|&shape| {
        let out = unwrap_soup(&shapes::get(shape).unwrap(), p).expect("core shape");
        let (s, part) = (out.stats, &out.parts[0]);
        let flat = |ok: bool| s.islands == 1 && s.mean_stretch < 0.005 && ok;
        let (ideal, ok) = match shape {
            "cube" => ("Latin cross", flat(ideal::cube_cross(part))),
            "cylinder" => ("tin can: strip + caps on its long sides", flat(ideal::tin_can(part))),
            "cone" => ("sector + disc on its arc", flat(ideal::cone_net(part))),
            "torus" => ("one seamless rectangle", s.islands == 1 && ideal::rectangle(part)),
            "knot" => ("one seamless strip", s.islands == 1),
            _ => ("≤ 4 pieces, ≤ 12% stretch", s.islands <= 4 && s.mean_stretch <= 0.12),
        };
        let pass = s.flips == 0 && s.overlap < 0.001 && ok;
        CheckRow { shape, pass, ideal, stats: s }
    }).collect()
}
