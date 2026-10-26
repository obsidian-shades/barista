//! Seam quality, measured the way an artist judges a layout rather than the way a flattener does.
//!
//! `Stats` says what the *layout* is worth: flips, stretch, overlap, how much of the square it fills. It says nothing
//! about the seams themselves, so a change that trades one for another can't be seen: a cut on the visible front, a
//! seam that zigzags across a quad, a slit that ends in the middle of a panel and opens nothing all cost the same as
//! a clean one. This measures the cuts.
//!
//! Measured on the chart partition, before `join` hangs the charts into nets: a net's border is not a cut, and its
//! corners are dead ends by construction.
//!
//! Every number is scale-free, so a part compares with a model and a change with its baseline:
//!
//!  * `length` — Σ seam length / √(Σ area), as a share of the model's size.
//!  * `hidden` — share of that length where both sides are surface `region` found inside the model (a seam there is
//!    never seen: it is what an artist hides in a groove or under an edge).
//!  * `spurs` — dead-end runs shorter than `SPUR` √area: they open nothing and still cost a seam and its texel bleed.
//!    A *long* dead end is a real relief cut (the back of a head up to the crown) and is not counted.
//!  * `steps` — share of the length in staircases: sharp turns that sit next to another sharp turn. A single corner
//!    is a real corner; many corners in a row are a seam that should have followed one edge loop.
//!  * `inside` — share lying inside one polygon (a quad's diagonal). It should be 0: the export would have to split
//!    the face there, so a texture wouldn't run across it.
use crate::chart::Island;
use crate::mesh::*;
use serde::Serialize;

/// A dead end shorter than this share of √area is junk that opens nothing.
const SPUR: f64 = 0.06;
/// cos of the turn at a seam vertex above which the seam has turned sharply (a right angle is 0, straight is −1).
const SHARP: f64 = -0.25;

#[derive(Serialize, Clone, Copy, Debug, Default)]
pub struct Seams {
    /// Σ seam length / √(Σ area): how much cutting the layout took, against the model's size.
    pub length: f64,
    /// Share of the seam length on surface hidden inside the model (1 = every cut is out of sight).
    pub hidden: f64,
    /// Dead-end runs shorter than `SPUR` √area: they open nothing.
    pub spurs: usize,
    /// Their length, over √area.
    pub spur_length: f64,
    /// Share of the seam length in staircase turns.
    pub steps: f64,
    /// Share of the seam length inside one polygon (should be 0).
    pub inside: f64,
}

/// Totals per part, before the scale is known (the model's √area is only known once every part is in).
#[derive(Clone, Copy, Debug, Default)]
pub struct Raw {
    pub len: f64,
    pub hidden: f64,
    pub spurs: usize,
    pub spur: f64,
    pub step: f64,
    pub inside: f64,
}

impl Raw {
    pub fn add(&mut self, o: Raw) {
        self.len += o.len;
        self.hidden += o.hidden;
        self.spurs += o.spurs;
        self.spur += o.spur;
        self.step += o.step;
        self.inside += o.inside;
    }

    /// The shares, against `unit` = √(the area the seams were cut on).
    pub fn seams(&self, unit: f64) -> Seams {
        let per = |x: f64| if self.len > 0. { x / self.len } else { 0. };
        Seams {
            length: if unit > 0. { self.len / unit } else { 0. },
            hidden: per(self.hidden),
            spurs: self.spurs,
            spur_length: if unit > 0. { self.spur / unit } else { 0. },
            steps: per(self.step),
            inside: per(self.inside),
        }
    }
}

/// How many chart borders carry each welded edge. A mesh edge is a **cut** when exactly two of them do: the two
/// charts on its sides, or the two sides of one slit (a cone tip opened to the border, both sides on one chart).
/// One occurrence is the mesh's own border; none is the inside of a chart; three is a pinch, not a seam.
fn borders(isl: &[Island]) -> Map<u64, u8> {
    let mut n: Map<u64, u8> = Map::default();
    for s in isl {
        for lp in &s.l.loops {
            for k in 0..lp.len() {
                let a = s.l.orig[lp[k] as usize];
                let b = s.l.orig[lp[(k + 1) % lp.len()] as usize];
                let e = n.entry(ek(a, b)).or_insert(0);
                *e = e.saturating_add(1);
            }
        }
    }
    n
}

/// The seams of one part's chart partition.
pub fn measure(m: &Mesh, isl: &[Island]) -> Raw {
    let mut raw = Raw::default();
    let mut adj: Map<u32, Vec<(u32, f64)>> = Map::default();
    let hidden = m.hidden.get();
    for (&key, &count) in &borders(isl) {
        if count != 2 { continue; }
        let (a, b) = ((key >> 32) as u32, (key & 0xffff_ffff) as u32);
        let len = dist(m.pt(a), m.pt(b));
        raw.len += len;
        // both sides inside the model: the seam is on surface that's never seen
        if hidden.is_some_and(|h| m.edges[&key].iter().all(|&t| h[t as usize])) { raw.hidden += len; }
        if m.inside(key) { raw.inside += len; }
        adj.entry(a).or_default().push((b, len));
        adj.entry(b).or_default().push((a, len));
    }
    if !(raw.len > 0.) { return raw; }
    let area: f64 = isl.iter().flat_map(|s| s.l.tris.iter()).map(|&t| m.a[t as usize]).sum();
    let unit = area.sqrt();
    // vertices on the mesh's own border: a dead end there isn't a dead end, the seam can run off the sheet
    let mut border: Set<u32> = Set::default();
    for (k, ts) in &m.edges {
        if ts.len() == 1 {
            border.insert((k >> 32) as u32);
            border.insert((k & 0xffff_ffff) as u32);
        }
    }

    // dead ends: walk the run from each one to where it joins something, and keep the short ones
    let mut seen: Set<u64> = Set::default();
    for (&v, ns) in &adj {
        if ns.len() != 1 || border.contains(&v) { continue; }
        let (mut cur, mut prev, mut run, mut guard) = (v, u32::MAX, 0., 0);
        while guard < 4096 {
            guard += 1;
            let Some(&(w, len)) = adj.get(&cur).and_then(|ns| ns.iter().find(|(w, _)| *w != prev)) else { break };
            if !seen.insert(ek(cur.min(w), cur.max(w))) { break; }
            run += len;
            if border.contains(&w) || adj[&w].len() != 2 || run > 0.2 * unit { break; }
            prev = cur;
            cur = w;
        }
        // a run already walked from its other end adds nothing (its first edge is `seen` and it stopped at once)
        if run > 0. && run < SPUR * unit {
            raw.spurs += 1;
            raw.spur += run;
        }
    }

    // staircases: a sharp turn next to another sharp turn; a lone corner is a corner
    let mut sharp: Vec<u32> = Vec::new();
    for (&v, ns) in &adj {
        if ns.len() != 2 { continue; }
        let (a, b) = (sub(m.pt(v), m.pt(ns[0].0)), sub(m.pt(v), m.pt(ns[1].0)));
        let (la, lb) = (norm(a), norm(b));
        if la > 0. && lb > 0. && dot(a, b) / (la * lb) > SHARP { sharp.push(v); }
    }
    let near: Set<u32> = sharp.iter().copied().collect();
    let mut turned: Set<u64> = Set::default();
    for &v in &sharp {
        if !adj[&v].iter().any(|&(w, _)| near.contains(&w)) { continue; }
        for &(w, _) in &adj[&v] { turned.insert(ek(v, w)); }
    }
    raw.step = turned.iter().map(|k| dist(m.pt((k >> 32) as u32), m.pt((k & 0xffff_ffff) as u32))).sum();
    raw
}
