// Poly Doc's Health: every polygon checked against named rules, scored 0 (solid, green) … 1 (fix, red), and coloured as
// one face by its worst rule. It reads the mesh alone, never the UVs.
// The shape rules are the engineering ones: Sandia's Verdict / CUBIT quality metrics and their acceptable ranges (the
// green limit of each rule); the game-art practice (Polycount) sets where they bend: a flat n-gon is fine, a long thin
// quad (a bevel strip) is normal, long thin triangles and bent faces are what make bakes shade badly, and a pole only
// matters where the surface curves.
import type { PartOut } from './api.ts';
import { curveEdges, loopOf, members, meshCheck, poles, type Geo } from './polygeo.ts';
import { topoOfSoup } from './polyedit.ts';
import { edgeBetween, trisOf } from './topo.ts';
import { angle, cross, dot, len, shapeIssues, sub, type V } from './quality.ts';

const deg = Math.PI / 180;

export type RuleId = 'nonManifold' | 'flipped' | 'zero' | 'duplicate' | 'outline'
  | 'triMin' | 'triMax' | 'quadJacobian' | 'quadSkew' | 'quadTaper' | 'quadWarp' | 'quadAspect' | 'ngonBent' | 'poleCurve' | 'poleBig' | 'faceted' | 'dense';
export interface Rule { name: string; good: string; why: string; source: string }
const CUBIT = 'Sandia CUBIT / Verdict', PC = 'Polycount practice', VALID = 'Mesh validity';
export const RULES: Record<RuleId, Rule> = {
  nonManifold: { name: 'Non-manifold edge', good: 'two faces per edge', why: 'More than two faces share an edge: bakers, unwrappers and engines can’t say which side is out', source: VALID },
  flipped: { name: 'Flipped face', good: 'wound like its neighbours', why: 'Its normal points the other way: it shades black or vanishes with backface culling', source: VALID },
  zero: { name: 'Zero-area face', good: 'some area', why: 'Corners on top of each other or in a line: no normal, breaks smoothing and bakes', source: VALID },
  duplicate: { name: 'Duplicate face', good: 'one face per set of corners', why: 'Two faces on the same corners: z-fighting and doubled bakes', source: VALID },
  outline: { name: 'Tangled outline', good: 'one simple loop', why: 'Its edges don’t form one simple loop (a pinch or a hole)', source: VALID },
  triMin: { name: 'Sliver triangle', good: 'smallest angle ≥ 30°', why: 'Long thin triangles bend normals and leave gradients in normal-map bakes', source: `${CUBIT} (min angle 30–60°)` },
  triMax: { name: 'Flat-capped triangle', good: 'largest angle ≤ 120°', why: 'A corner near 180° makes a cap triangle: almost no area, a long edge, shading streaks', source: `${CUBIT} (90° for simulation; 120° for shading)` },
  quadJacobian: { name: 'Collapsed / concave quad', good: 'scaled Jacobian ≥ 0.5', why: 'A corner near 0° or bent inwards: the quad folds, and its two triangles shade apart', source: `${CUBIT} (0.5–1)` },
  quadSkew: { name: 'Skewed quad', good: 'skew ≤ 0.5', why: 'Leaning far from square: its triangulation shows in the shading', source: `${CUBIT} (0–0.5)` },
  quadTaper: { name: 'Tapered quad', good: 'taper ≤ 0.7', why: 'One end much narrower than the other: close to a triangle with a cut corner', source: `${CUBIT} (0–0.7)` },
  quadWarp: { name: 'Bent quad', good: 'warpage ≥ 0.9 (≤ 26° off flat)', why: 'Not flat: it shades by whichever diagonal splits it, so bakes and engines can disagree. Triangulate it, or flatten it', source: `${CUBIT} (0.9–1)` },
  quadAspect: { name: 'Long quad', good: 'aspect ratio ≤ 4', why: 'Long and thin. Normal for bevel and support strips; worth a look on big surfaces', source: `${CUBIT} (1–4), softened: bevels are long by design` },
  ngonBent: { name: 'Bent n-gon', good: 'flat (off its plane ≤ 2% of its size)', why: 'Flat n-gons are fine; a bent one shades by a triangulation you don’t control', source: PC },
  poleCurve: { name: 'Pole on a curve', good: 'poles on flat areas', why: '3 or 5 edges meeting where the surface bends pinch the shading', source: PC },
  poleBig: { name: 'Big pole', good: 'at most 5 edges at a vertex', why: '6 or more edges meeting: a star of thin faces, shading pinches round it', source: PC },
  faceted: { name: 'Faceted curve', good: 'off the curve ≤ 0.1% of the model', why: 'Too few polygons on a smooth curve: the flat faces cut its corners (width across × bend / 8), so the silhouette shows facets. Add a loop', source: `${PC}: spend polygons on the silhouette; chord error as in CAD tessellation` },
  dense: { name: 'Over-dense curve', good: 'off the curve ≥ 0.002% of the model', why: 'A curve split far finer than the model needs (a many-segment bevel on a small edge): polygons that change nothing on screen; a normal map carries it', source: `${PC}: polycount where it shows, not where it doesn’t` },
};
export interface Issue { rule: RuleId; value: string; score: number }

export interface Report { score: Float32Array; issues: Map<number, Issue[]> }
const reports = new WeakMap<Int32Array, { soup: Float32Array; size: number; report: Report }>();
/** The whole model's size (its bounding box diagonal), so density is judged at one scale for every part (a small
 *  part's curves count as small); 0: each part by its own. */
let modelSize = 0;
export function setModelSize(soups: Float32Array[]) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const s of soups) for (let i = 0; i < s.length; i++) { lo[i % 3] = Math.min(lo[i % 3], s[i]); hi[i % 3] = Math.max(hi[i % 3], s[i]); }
  modelSize = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 0;
}
/** Every polygon's issues, and per soup triangle its polygon's score (the worst rule), cached per geometry. */
export function healthReport(g: Geo): Report {
  const hit = reports.get(g.poly);
  if (hit && hit.soup === g.soup && hit.size === modelSize) return hit.report;
  const t = topoOfSoup(g.soup), P = t.pos, issues = new Map<number, Issue[]>();
  const at = (v: number): V => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const note = (p: number, i: Issue) => (issues.get(p) ?? issues.set(p, []).get(p)!).push(i);
  // broken mesh: red
  const m = meshCheck(g);
  for (const [rule, fs] of [['flipped', m.flipped], ['zero', m.zero], ['duplicate', m.duplicate]] as const) for (const f of fs) note(g.poly[f], { rule, score: 1, value: '' });
  for (const [a, b] of m.nonManifold) for (const f of t.edgeTris[edgeBetween(t, a, b)] ?? []) note(g.poly[f], { rule: 'nonManifold', score: 1, value: `${t.edgeTris[edgeBetween(t, a, b)].length} faces on one edge` });
  // each polygon's shape
  const mem = members(g.poly);
  for (const [p, tris] of mem) {
    const l = loopOf(t, tris);
    if (!l) note(p, { rule: 'outline', score: 0.5, value: '' });
    else for (const i of shapeIssues(l.map(at))) note(p, i);
  }
  // poles where the surface bends, and big poles anywhere: every polygon round them
  const normal = (f: number) => cross(sub(at(t.vid[f * 3 + 1]), at(t.vid[f * 3])), sub(at(t.vid[f * 3 + 2]), at(t.vid[f * 3])));
  const pl = poles(g), valence = new Map<number, number>();
  for (const v of pl.many) { const ps = new Set(trisOf(t, v).map((f) => g.poly[f])); valence.set(v, ps.size); }
  for (const v of [...pl.three, ...pl.many]) {
    const fs = trisOf(t, v), ns = fs.map(normal), bend = Math.max(...ns.flatMap((a) => ns.map((b) => angle(a, b)))), k = valence.get(v) ?? 3;
    const big = k >= 6, curved = bend > 20 * deg;
    if (!big && !curved) continue;
    const issue: Issue = big ? { rule: 'poleBig', score: curved ? 1 : 0.5, value: `${k} edges at one vertex${curved ? ', on a curve' : ''}` }
      : { rule: 'poleCurve', score: 0.5, value: `${k} edges, surface bends ${(bend / deg).toFixed(0)}°` };
    for (const p of new Set(fs.map((f) => g.poly[f]))) note(p, issue);
  }
  // density: a curve's chord error at the model's scale, on both polygons of the edge
  let D = modelSize;
  if (!D) { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); } D = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1; }
  // faceted: both sides wide, alike (segments of one curve) and bent: a bevel strip or a chamfer beside a face passes; dense: a polygon whose own
  // width × bend is tiny on every curve edge it has (two or more: a segment of a run)
  const worstErr = new Map<number, number>(), own = new Map<number, number[]>();
  for (const e of curveEdges(g)) {
    if (e.even) for (const p of [e.p, e.q]) worstErr.set(p, Math.max(worstErr.get(p) ?? 0, e.err / D));
    for (const [p, w] of [[e.p, e.wp], [e.q, e.wq]]) (own.get(p) ?? own.set(p, []).get(p)!).push((w * e.bend) / 8 / D);
  }
  for (const [p, r] of worstErr) {
    const score = Math.max(0, Math.min(1, (r - 0.001) / 0.003));
    if (score > 0) note(p, { rule: 'faceted', score, value: `${(r * 100).toFixed(2)}% of the model off the curve` });
  }
  for (const [p, rs] of own) {
    const r = Math.max(...rs);
    if (rs.length >= 2 && r < 0.00002) note(p, { rule: 'dense', score: 0.3, value: `${(r * 100).toFixed(4)}% of the model off the curve` });
  }
  // a polygon's score is its worst rule, on every one of its triangles: it's one face
  const worst = new Map<number, number>();
  for (const [p, is] of issues) worst.set(p, Math.max(...is.map((i) => i.score)));
  const report = { score: Float32Array.from(g.poly, (p) => worst.get(p) ?? 0), issues };
  reports.set(g.poly, { soup: g.soup, size: modelSize, report });
  return report;
}

/** Per output triangle (the part as drawn): its polygon's health score, 0 solid … 1 fix. */
export function health(out: PartOut, g: Geo): Float32Array {
  const s = healthReport(g).score;
  return Float32Array.from(out.source, (src) => s[src] ?? 0);
}

/** The polygons each rule flags on a part: worth a look (score under 0.6) and to fix (0.6 up). */
export function ruleCounts(g: Geo): Map<RuleId, { look: number[]; fix: number[] }> {
  const out = new Map<RuleId, { look: number[]; fix: number[] }>();
  for (const [p, is] of healthReport(g).issues) for (const i of is) {
    const r = out.get(i.rule) ?? out.set(i.rule, { look: [], fix: [] }).get(i.rule)!;
    (i.score >= 0.6 ? r.fix : r.look).push(p);
  }
  return out;
}

/** Green (solid) through yellow to red (fix). */
export function healthColor(s: number): [number, number, number] {
  return s < 0.5 ? [0.2 + 1.5 * s, 0.66 + 0.22 * s, 0.26 - 0.08 * s] : [0.95 - 0.1 * (s - 0.5), 0.77 - 1.1 * (s - 0.5), 0.22];
}

/** Share of a part's area that's solid (< 0.25), worth a look, and to fix (≥ 0.6). */
export function healthSummary(out: PartOut, score: Float32Array) {
  const P = out.positions, sum = [0, 0, 0];
  for (let t = 0; t < score.length; t++) {
    const o = t * 9, u = [P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]], v = [P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]];
    const a = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    sum[score[t] < 0.25 ? 0 : score[t] < 0.6 ? 1 : 2] += a;
  }
  const all = sum[0] + sum[1] + sum[2] || 1;
  return { solid: sum[0] / all, look: sum[1] / all, fix: sum[2] / all };
}
