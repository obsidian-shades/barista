//! Lay islands out in the unit square, and measure overlap of the finished atlas.

use rayon::prelude::*;

/// One island (or net) of UVs, in any units (all sets share them), and its outline loops.
pub struct UvSet {
    pub u: Vec<f64>,
    pub v: Vec<f64>,
    pub outline: Vec<Vec<usize>>,
    /// Its triangles, as indices into u, v: what the packer rasterises.
    pub tris: Vec<[usize; 3]>,
    /// A direction (angle) to line up with an axis instead of squaring the outline up: a book's spine.
    pub along: Option<f64>,
    /// 3D position per u, v (y up, z front), or empty: what turns the set upright.
    pub xyz: Vec<[f64; 3]>,
}

/// The turn that stands the set upright, and whether up is told from down. Per triangle, the gradient of world
/// height (y) over the UVs points up; summed as axes (double angle) so a net's mirrored halves — flanks opened
/// round the top — agree on the axis, signed only when they agree on the sense too. A set with no clear up
/// (lying flat) uses the horizontal axis (x or z) it is shorter along, so its length lies along U like the flanks
/// beside it (a slide's top strip as long as its sides).
fn upright(s: &UvSet) -> Option<(f64, bool)> {
    if s.xyz.is_empty() { return None; }
    let field = |k: usize| {
        let (mut ax, mut sg, mut area) = ([0f64; 2], [0f64; 2], 0.);
        for &[a, b, c] in &s.tris {
            let (u1, v1, u2, v2) = (s.u[b] - s.u[a], s.v[b] - s.v[a], s.u[c] - s.u[a], s.v[c] - s.v[a]);
            let det = u1 * v2 - u2 * v1;
            if det.abs() < 1e-14 { continue; }
            let (y1, y2) = (s.xyz[b][k] - s.xyz[a][k], s.xyz[c][k] - s.xyz[a][k]);
            let (gu, gv, w) = ((y1 * v2 - y2 * v1) / det, (u1 * y2 - u2 * y1) / det, det.abs() / 2.);
            let g = gu.hypot(gv);
            if g > 0. { ax[0] += w * (gu * gu - gv * gv) / g; ax[1] += w * 2. * gu * gv / g; }
            sg[0] += w * gu;
            sg[1] += w * gv;
            area += w;
        }
        let c = ax[0].hypot(ax[1]) / area.max(1e-300);
        let phi = ax[1].atan2(ax[0]) / 2.;
        let along = (sg[0] * phi.cos() + sg[1] * phi.sin()) / area.max(1e-300);
        (c, if along < 0. { phi + std::f64::consts::PI } else { phi }, along.abs() >= 0.5 * c)
    };
    let span = |k: usize| s.xyz.iter().map(|p| p[k]).fold(f64::MIN, f64::max) - s.xyz.iter().map(|p| p[k]).fold(f64::MAX, f64::min);
    let (y, side) = (field(1), field(if span(0) < span(2) { 0 } else { 2 }));
    let (c, phi, signed) = if y.0 < 0.3 * side.0 { side } else { y };
    (c >= 0.25).then_some((std::f64::consts::FRAC_PI_2 - phi, signed))
}

/// The turn that lines the outline's dominant straight-edge direction up with the axes, the way an artist
/// squares up a net; None if no direction holds a fifth of the outline (curved shapes).
fn square_up(u: &[f64], v: &[f64], loops: &[Vec<usize>]) -> Option<f64> {
    let mut bins = [0f64; 180]; // half-degree bins over 0..90°
    let mut total = 0.;
    for lp in loops {
        for k in 0..lp.len() {
            let (a, b) = (lp[k], lp[(k + 1) % lp.len()]);
            let (dx, dy) = (u[b] - u[a], v[b] - v[a]);
            let len = dx.hypot(dy);
            let ang = dy.atan2(dx).to_degrees().rem_euclid(90.);
            bins[((ang * 2.) as usize).min(179)] += len;
            total += len;
        }
    }
    // within ±1.5°: an edge relaxed into a slight bend still counts as one straight direction
    let near: Vec<f64> = (0..180).map(|i| (i + 177..=i + 183).map(|j| bins[j % 180]).sum()).collect();
    let (i, w) = near.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1))?;
    (*w >= 0.2 * total).then(|| -((i as f64 + 0.5) / 2.).to_radians())
}

/// The turns a set may pack at, the first the one it stands at. Upright (`up`, and `upright` finds one): up picks
/// the quarter turn; the angle comes from the set's own lines when it has them — a strip's (3:1 or longer) tightest
/// box, else its straight edges — and from up itself only when it has none. Unsigned up (mirrored halves) may also
/// turn round; a narrow strip (its width under a tenth of the √area of everything packed, `total`) may lie on its
/// side, never upside down. Otherwise (a UV-only repack: `total` None; a set under 2% of `total`, too small to read
/// which way is up): squared up — a book's spine, straight edges or tightest box — at any quarter turn.
fn turns(s: &UvSet, total: Option<f64>) -> Vec<f64> {
    let (u, v, b) = (&s.u, &s.v, &s.outline);
    let bbox = |th: f64| {
        let (cs, sn) = (th.cos(), th.sin());
        let r = b_iter(u, v, b).fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |r, (x, y)| {
            let (x, y) = (cs * x - sn * y, sn * x + cs * y);
            [r[0].min(x), r[1].min(y), r[2].max(x), r[3].max(y)]
        });
        (r[2] - r[0], r[3] - r[1])
    };
    let boxed = |a: &f64, b: &f64| { let (p, q) = (bbox(*a), bbox(*b)); (p.0 * p.1).total_cmp(&(q.0 * q.1)) };
    let tight = (0..90).map(|d| (d as f64).to_radians()).min_by(boxed).unwrap();
    let tight = (-20..=20).map(|d| tight + (d as f64 * 0.05).to_radians()).min_by(boxed).unwrap();
    let (w, h) = bbox(tight);
    let q = std::f64::consts::FRAC_PI_2;
    if let Some((up, signed)) = upright(s).filter(|_| total.is_some_and(|a| area_of(s) >= 0.02 * a)) {
        let strip = w.max(h) >= 3. * w.min(h);
        let narrow = strip && w.min(h) <= 0.1 * total.unwrap().sqrt();
        let lie = if strip { Some(tight) } else { square_up(u, v, b) };
        let th = lie.map_or(up, |a| a + ((up - a) / q).round() * q);
        let ks: &[f64] = match (narrow, signed) { (true, _) => &[0., 1., -1.], (_, true) => &[0.], _ => &[0., 2.] };
        return ks.iter().map(|k| th + k * q).collect();
    }
    let th = s.along.map(|a| -a).or_else(|| square_up(u, v, b)).unwrap_or(tight);
    (0..4).map(|k| th + k as f64 * q).collect()
}

fn area_of(s: &UvSet) -> f64 {
    s.tris.iter().map(|&[a, b, c]| ((s.u[b] - s.u[a]) * (s.v[c] - s.v[a]) - (s.u[c] - s.u[a]) * (s.v[b] - s.v[a])).abs() / 2.).sum()
}

/// Texels across the square root of the total UV area: the packing grid's resolution.
const RES: f64 = 512.;
/// Gap kept around every set, in texels of that grid (about 1% of the atlas side).
const PAD: usize = 3;

/// A set's footprint at turn `th` on the packing grid: bit x of row y is texel (x, y). `raw` is every texel its
/// triangles touch, `grown` that dilated by PAD; both sit PAD texels in from the corner (`x0`, `y0`, in units).
struct Mask { th: f64, x0: f64, y0: f64, w: usize, h: usize, raw: Vec<Vec<u64>>, grown: Vec<Vec<u64>>, pop: Vec<u32>, area: u32 }

fn mask(s: &UvSet, th: f64, t: f64) -> Mask {
    let (cs, sn) = (th.cos(), th.sin());
    let (x, y): (Vec<f64>, Vec<f64>) = s.u.iter().zip(&s.v).map(|(&u, &v)| (cs * u - sn * v, sn * u + cs * v)).unzip();
    let (x0, y0) = (x.iter().copied().fold(f64::MAX, f64::min), y.iter().copied().fold(f64::MAX, f64::min));
    let (x, y): (Vec<f64>, Vec<f64>) = x.iter().zip(&y).map(|(a, b)| ((a - x0) / t + PAD as f64, (b - y0) / t + PAD as f64)).unzip();
    let w = x.iter().copied().fold(0., f64::max) as usize + 1 + PAD;
    let h = y.iter().copied().fold(0., f64::max) as usize + 1 + PAD;
    let mut raw = vec![vec![0u64; w.div_ceil(64)]; h];
    let mut set = |px: f64, py: f64| {
        let (i, j) = ((px as usize).min(w - 1), (py as usize).min(h - 1));
        raw[j][i / 64] |= 1 << (i % 64);
    };
    for tri in &s.tris {
        let [a, b, c] = tri.map(|i| (x[i], y[i]));
        // the edges, sampled every half texel, then the texel centres inside: every texel the triangle touches,
        // to within slivers the padding covers
        for (p, q) in [(a, b), (b, c), (c, a)] {
            let n = ((q.0 - p.0).abs().max((q.1 - p.1).abs()) * 2.).ceil() as usize + 1;
            for k in 0..=n {
                let f = k as f64 / n as f64;
                set(p.0 + (q.0 - p.0) * f, p.1 + (q.1 - p.1) * f);
            }
        }
        let det = (b.0 - a.0) * (c.1 - a.1) - (c.0 - a.0) * (b.1 - a.1);
        if det == 0. { continue; }
        for j in a.1.min(b.1).min(c.1) as usize..=a.1.max(b.1).max(c.1) as usize {
            for i in a.0.min(b.0).min(c.0) as usize..=a.0.max(b.0).max(c.0) as usize {
                let (px, py) = (i as f64 + 0.5, j as f64 + 0.5);
                let l1 = ((px - a.0) * (c.1 - a.1) - (c.0 - a.0) * (py - a.1)) / det;
                let l2 = ((b.0 - a.0) * (py - a.1) - (px - a.0) * (b.1 - a.1)) / det;
                if l1 >= 0. && l2 >= 0. && l1 + l2 <= 1. { set(px, py); }
            }
        }
    }
    let mut grown = raw.clone();
    for _ in 0..PAD {
        let row = |g: &[Vec<u64>], j: usize, k: usize| {
            let r = &g[j];
            r[k] | r[k] << 1 | r[k] >> 1 | if k > 0 { r[k - 1] >> 63 } else { 0 } | r.get(k + 1).map_or(0, |b| b << 63)
        };
        grown = (0..h).map(|j| (0..grown[j].len()).map(|k| {
            row(&grown, j, k) | if j > 0 { row(&grown, j - 1, k) } else { 0 } | if j + 1 < h { row(&grown, j + 1, k) } else { 0 }
        }).collect()).collect();
    }
    let pop: Vec<u32> = raw.iter().map(|r| r.iter().map(|b| b.count_ones()).sum()).collect();
    Mask { th, x0, y0, w, h, area: pop.iter().sum(), raw, grown, pop }
}

/// The atlas so far: rows of grown masks, `width` texels wide, and each row's free texels.
struct Atlas { width: usize, rows: Vec<Vec<u64>>, free: Vec<u32> }

impl Atlas {
    /// 64 texels of row `y`, from `x` on.
    fn bits(&self, y: usize, x: usize) -> u64 {
        let Some(r) = self.rows.get(y) else { return 0 };
        let (i, s) = (x / 64, x % 64);
        r.get(i).map_or(0, |a| a >> s) | if s > 0 { r.get(i + 1).map_or(0, |a| a << (64 - s)) } else { 0 }
    }
    fn fits(&self, m: &Mask, x: usize, y: usize) -> bool {
        (0..m.h).all(|j| m.pop[j] == 0 || m.raw[j].iter().enumerate().all(|(k, &b)| self.bits(y + j, x + 64 * k) & b == 0))
    }
    /// Bottom-left: the lowest, then leftmost, spot for `m` whose top stays under `below`.
    fn find(&self, m: &Mask, below: usize) -> Option<(usize, usize)> {
        if m.w > self.width { return None; }
        for y in 0.. {
            if y + m.h >= below { return None; }
            if (0..m.h).any(|j| self.free.get(y + j).is_some_and(|&f| f < m.pop[j])) { continue; }
            if let Some(x) = (0..=self.width - m.w).find(|&x| self.fits(m, x, y)) { return Some((x, y)); }
        }
        None
    }
    fn place(&mut self, m: &Mask, x: usize, y: usize) {
        let words = self.width.div_ceil(64) + 2;
        while self.rows.len() < y + m.h { self.rows.push(vec![0; words]); self.free.push(self.width as u32); }
        let (i, s) = (x / 64, x % 64);
        for j in 0..m.h {
            let r = &mut self.rows[y + j];
            for (k, &b) in m.grown[j].iter().enumerate() {
                r[i + k] |= b << s;
                if s > 0 { r[i + k + 1] |= b >> (64 - s); }
            }
            self.free[y + j] = self.width as u32 - r.iter().map(|b| b.count_ones()).sum::<u32>();
        }
    }
}

/// Optionally turn each island to its squared-up (or smallest-box) angle and try all four quarter turns of that,
/// then pack them all at one scale (so texel density stays as it is between islands): rasterise each one's
/// triangles and drop them, biggest first, into the lowest then leftmost spot where they keep the padding, the
/// way xatlas does. A few atlas widths are tried; the smallest square wins. Rewrites u, v into 0..1.
pub fn pack(isl: &mut [UvSet], rotate: bool) {
    if isl.is_empty() { return; }
    let area: f64 = isl.iter().map(area_of).sum();
    let t = if area > 0. { area.sqrt() / RES } else { 1. };
    let masks: Vec<Vec<Mask>> = isl.par_iter().map(|s| {
        if !rotate { return vec![mask(s, 0., t)]; }
        turns(s, Some(area)).into_iter().map(|th| mask(s, th, t)).collect()
    }).collect();
    // biggest first, by box area or by longest side (long strips down early, while whole rows are free)
    let mut by_area: Vec<usize> = (0..isl.len()).collect();
    by_area.sort_by_key(|&i| std::cmp::Reverse(masks[i][0].w * masks[i][0].h));
    let mut by_side = by_area.clone();
    by_side.sort_by_key(|&i| std::cmp::Reverse(masks[i][0].w.max(masks[i][0].h)));

    // ponytail: brute-force bottom-left scan per set and turn; a skyline or free-span index if big atlases get slow
    let min_w = masks.iter().map(|ms| ms.iter().map(|m| m.w).min().unwrap()).max().unwrap();
    let raw: f64 = masks.iter().map(|ms| ms[0].area as f64).sum();
    let trials: Vec<(usize, Vec<(usize, usize, usize)>)> = (0..32).into_par_iter().map(|k| {
        let order = if k % 2 == 0 { &by_area } else { &by_side };
        let mut a = Atlas { width: ((raw.sqrt() * (1. + 0.05 * (k / 2) as f64)) as usize).max(min_w), rows: vec![], free: vec![] };
        let (mut at, mut used) = (vec![(0, 0, 0); isl.len()], 0);
        for &i in order {
            let mut best: Option<(usize, usize, usize)> = None; // (turn, x, y): the lowest top wins
            for (r, m) in masks[i].iter().enumerate() {
                let below = best.map_or(usize::MAX, |(b, _, y)| y + masks[i][b].h);
                if let Some((x, y)) = a.find(m, below) { best = Some((r, x, y)); }
            }
            let (r, x, y) = best.unwrap();
            a.place(&masks[i][r], x, y);
            at[i] = (r, x, y);
            used = used.max(x + masks[i][r].w);
        }
        (used.max(a.rows.len()), at)
    }).collect();
    let at = &trials.iter().min_by_key(|t| t.0).unwrap().1;

    for (s, (ms, &(r, x, y))) in isl.iter_mut().zip(masks.iter().zip(at)) {
        let m = &ms[r];
        let (cs, sn) = (m.th.cos(), m.th.sin());
        for i in 0..s.u.len() {
            let (a, b) = (s.u[i], s.v[i]);
            s.u[i] = cs * a - sn * b - m.x0 + (x + PAD) as f64 * t;
            s.v[i] = sn * a + cs * b - m.y0 + (y + PAD) as f64 * t;
        }
    }
    // the used box, into the unit square with half the gap between sets around it: off the square's edge, and
    // the same gap again across tiled copies
    let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
    for s in isl.iter() {
        for (&u, &v) in s.u.iter().zip(&s.v) { lo = [lo[0].min(u), lo[1].min(v)]; hi = [hi[0].max(u), hi[1].max(v)]; }
    }
    let gap = PAD as f64 * t;
    let size = (hi[0] - lo[0]).max(hi[1] - lo[1]).max(f64::MIN_POSITIVE) + gap;
    for s in isl.iter_mut() {
        for i in 0..s.u.len() { s.u[i] = (s.u[i] - lo[0] + gap / 2.) / size; s.v[i] = (s.v[i] - lo[1] + gap / 2.) / size; }
    }
}

fn b_iter<'a>(u: &'a [f64], v: &'a [f64], b: &'a [Vec<usize>]) -> impl Iterator<Item = (f64, f64)> + 'a {
    b.iter().flatten().map(move |&i| (u[i], v[i]))
}

/// Total UV area of the triangles (u,v per corner) over the unit square's: the share of the atlas in use.
pub fn efficiency(uv: &[f32]) -> f64 {
    uv.chunks_exact(6).map(|p| {
        let p = p.iter().map(|&c| c as f64).collect::<Vec<_>>();
        ((p[2] - p[0]) * (p[5] - p[1]) - (p[4] - p[0]) * (p[3] - p[1])).abs() / 2.
    }).sum()
}

/// Fraction of used texels (at `res`²) covered by more than one triangle: 0 means a clean atlas.
pub fn overlap(uv: &[f32], res: usize) -> f64 {
    let r = res as f64;
    let mut cnt = vec![0u8; res * res];
    for t in uv.chunks(6) {
        let p: Vec<f64> = t.iter().map(|&c| c as f64 * r).collect();
        let det = (p[2] - p[0]) * (p[5] - p[1]) - (p[4] - p[0]) * (p[3] - p[1]);
        if det == 0. { continue; }
        let (y0, y1) = (p[1].min(p[3]).min(p[5]).floor().max(0.) as usize, (p[1].max(p[3]).max(p[5]) as usize).min(res - 1));
        let (x0, x1) = (p[0].min(p[2]).min(p[4]).floor().max(0.) as usize, (p[0].max(p[2]).max(p[4]) as usize).min(res - 1));
        for y in y0..=y1 {
            for x in x0..=x1 {
                let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                let l1 = ((px - p[0]) * (p[5] - p[1]) - (p[4] - p[0]) * (py - p[1])) / det;
                let l2 = ((p[2] - p[0]) * (py - p[1]) - (px - p[0]) * (p[3] - p[1])) / det;
                // strictly inside: texel centres exactly on a shared edge count for neither side
                if l1 > 1e-9 && l2 > 1e-9 && l1 + l2 < 1. - 1e-9 {
                    let c = &mut cnt[y * res + x];
                    *c = c.saturating_add(1);
                }
            }
        }
    }
    let used = cnt.iter().filter(|&&c| c > 0).count();
    let multi = cnt.iter().filter(|&&c| c > 1).count();
    if used == 0 { 0. } else { multi as f64 / used as f64 }
}

/// The gap `twin` keeps between a net and its mirror, for these sets packed together: the padding between sets.
pub fn gap<'a>(sets: impl IntoIterator<Item = &'a UvSet>) -> f64 {
    let area: f64 = sets.into_iter().flat_map(|s| s.tris.iter().map(move |&[a, b, c]| ((s.u[b] - s.u[a]) * (s.v[c] - s.v[a]) - (s.u[c] - s.u[a]) * (s.v[b] - s.v[a])).abs() / 2.)).sum();
    (PAD + 1) as f64 * area.sqrt() / RES
}

/// A mirrored half's net and its image (`symmetry`: b's UVs are a's with u flipped) as one set, the butterfly: a stood
/// upright, b beside it facing it across the centre line (the vertices they share), `gap` apart.
pub fn twin(a: UvSet, b: UvSet, gap: f64) -> UvSet {
    let th = turns(&a, Some(0.))[0];
    let turn = |s: &UvSet, th: f64| -> (Vec<f64>, Vec<f64>) {
        let (cs, sn) = (th.cos(), th.sin());
        s.u.iter().zip(&s.v).map(|(&u, &v)| (cs * u - sn * v, sn * u + cs * v)).unzip()
    };
    // turned the other way, b is still a's mirror: u = −(a's u)
    let ((au, av), (bu, bv)) = (turn(&a, th), turn(&b, -th));
    let shared: std::collections::HashSet<[u64; 3]> = b.xyz.iter().map(|p| p.map(f64::to_bits)).collect();
    let seam: Vec<usize> = (0..au.len()).filter(|&i| a.xyz.get(i).is_some_and(|p| shared.contains(&p.map(f64::to_bits)))).collect();
    // b faces a across the side the centre line runs along: beside it (mirrored across a vertical line), or for a
    // long net above or below it (across a horizontal one, opened round its top like a book), whichever is squarer
    let range = |x: &[f64]| (x.iter().copied().fold(f64::MAX, f64::min), x.iter().copied().fold(f64::MIN, f64::max));
    let across = |x: &[f64]| {
        let (lo, hi) = range(x);
        let far = seam.is_empty() || seam.iter().map(|&i| x[i]).sum::<f64>() / seam.len() as f64 >= (lo + hi) / 2.;
        (if far { hi + gap / 2. } else { lo - gap / 2. }, hi - lo)
    };
    let ((x, w), (y, h)) = (across(&au), across(&av));
    // beside: b's u is −(a's), mirrored across x; above or below: b turned half round, mirrored across y
    let (bu, bv): (Vec<f64>, Vec<f64>) = if (2. * w + gap).max(h) <= (2. * h + gap).max(w) {
        (bu.into_iter().map(|u| u + 2. * x).collect(), bv)
    } else {
        (bu.into_iter().map(|u| -u).collect(), bv.into_iter().map(|v| 2. * y - v).collect())
    };
    let n = au.len();
    UvSet {
        u: au.into_iter().chain(bu).collect(),
        v: av.into_iter().chain(bv).collect(),
        outline: a.outline.into_iter().chain(b.outline.into_iter().map(|l| l.into_iter().map(|k| k + n).collect())).collect(),
        tris: a.tris.into_iter().chain(b.tris.into_iter().map(|t| t.map(|k| k + n))).collect(),
        along: None,
        xyz: a.xyz.into_iter().chain(b.xyz).collect(),
    }
}
