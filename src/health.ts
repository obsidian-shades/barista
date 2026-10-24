// Poly Doc's Health: the pre-bake check, not a simulation-mesh quality report. Every polygon is scored 0 (solid,
// green) … 1 (fix, red) and coloured as one face by its worst rule. It reads the mesh alone, never the UVs.
//
// Three layers, because they mean different things to an artist:
//   broken  — the mesh isn't a valid surface: non-manifold edges/vertices, inside-out shells, flipped, zero-area or
//             duplicate faces, a tangled outline. Unwrap, bake and engine import can't be trusted until these are fixed.
//   bake    — valid geometry that a bake can still get wrong: a folded or strongly non-planar quad (bake and engine may
//             triangulate it differently, so MikkTSpace tangents disagree), a bent n-gon. Triangulate before baking.
//   craft   — shape and sampling that a game artist would look at, never a hard error: needles, skew, taper, a visibly
//             faceted silhouette, a curve split past what any screen shows.
//
// The shape limits are Sandia's Verdict / CUBIT metrics moved to their game-art ends (a simulation can demand a 30°
// minimum angle; a pole fan or a cylinder cap cannot meet that and shades fine). Sampling is scale-free: the turn from
// one face to the next, not a share of the model's bounding box. Poles are topology, not defects: their indices must sum
// to the Euler characteristic (Poincaré–Hopf), so a torus may have none and a sphere must have curvature. Health does not
// colour them; the Topology census reports them (see `meshTopology`). The design notes and sources are in
// docs/health.md.
import type { PartOut } from './api.ts';
import { curveEdges, loopOf, members, meshCheck, type Geo } from './polygeo.ts';
import { topoOfSoup } from './polyedit.ts';
import { edgeBetween, trisOf } from './topo.ts';
import { shapeIssues, type V } from './quality.ts';

const deg = Math.PI / 180;
const ramp = (x: number, good: number, bad: number) => Math.max(0, Math.min(1, (x - good) / (bad - good)));

export type RuleKind = 'broken' | 'bake' | 'craft';
export type RuleId = 'nonManifold' | 'nonManifoldVert' | 'flipped' | 'insideOut' | 'zero' | 'duplicate' | 'outline'
  | 'triMin' | 'triMax' | 'quadJacobian' | 'quadSkew' | 'quadTaper' | 'quadWarp' | 'ngonBent' | 'faceted' | 'dense';
export interface Rule { name: string; good: string; why: string; source: string; kind: RuleKind }
const CUBIT = 'Sandia CUBIT / Verdict', PC = 'Polycount practice', VALID = 'Mesh validity', BAKE = 'Normal-map baking';
export const RULES: Record<RuleId, Rule> = {
  nonManifold: { name: 'Non-manifold edge', good: 'two faces per edge', why: 'More than two faces share an edge: bakers, unwrappers and engines can’t say which side is out', source: VALID, kind: 'broken' },
  nonManifoldVert: { name: 'Non-manifold vertex', good: 'one fan of faces round the point', why: 'Two surfaces touch at a single vertex (a bow-tie): unwrappers split them apart and the join becomes a pinhole', source: VALID, kind: 'broken' },
  flipped: { name: 'Flipped face', good: 'wound like its neighbours', why: 'Its normal points the other way: it shades black or vanishes with backface culling, and bakes through the surface', source: VALID, kind: 'broken' },
  insideOut: { name: 'Inside-out shell', good: 'normals point out', why: 'A whole closed shell is wound inward (not the inner wall of a cavity): with backface culling it disappears, and a normal/AO bake comes out inverted', source: `${VALID}: signed volume of each closed piece`, kind: 'broken' },
  zero: { name: 'Zero-area face', good: 'some area', why: 'Corners on top of each other or in a line: no normal, breaks smoothing and bakes', source: VALID, kind: 'broken' },
  duplicate: { name: 'Duplicate face', good: 'one face per set of corners', why: 'Two faces on the same corners: z-fighting and doubled bakes', source: VALID, kind: 'broken' },
  outline: { name: 'Tangled outline', good: 'one simple loop', why: 'Its edges don’t form one simple loop (a pinch or a hole), so the polygon can’t be exported as one face', source: VALID, kind: 'broken' },
  quadWarp: { name: 'Bent quad', good: 'at most 18° off flat', why: 'Bake and engine may split it along different diagonals; MikkTSpace tangents then disagree and a normal map shows black seams. A planar quad has no choice. Export triangles, or flatten it', source: `${BAKE}: triangulation must match (Substance 3D)`, kind: 'bake' },
  ngonBent: { name: 'Bent n-gon', good: 'flat (off its plane ≤ 2% of its size)', why: 'A baked n-gon is triangulated by an algorithm you don’t control; a bent one shades by that triangulation. Triangulate it', source: BAKE, kind: 'bake' },
  quadJacobian: { name: 'Collapsed / concave quad', good: 'scaled Jacobian ≥ 0.4', why: 'A corner near 0° or bent inwards: the quad folds, and its two triangles shade apart', source: `${CUBIT} (0.5–1 for simulation)`, kind: 'bake' },
  triMin: { name: 'Needle triangle', good: 'smallest angle ≥ 6°', why: 'A true needle (< 1.5° at a corner): interpolation and texturing across it are unreliable. Pole fans (a UV sphere or a cylinder cap) sit at 5–15° and are normal; only the extreme end is flagged', source: `${CUBIT} (30–60° for simulation)`, kind: 'craft' },
  triMax: { name: 'Flat-capped triangle', good: 'largest angle ≤ 150°', why: 'A corner past 150° leaves almost no height: the triangle is a long cap with a thin normal gradient', source: `${CUBIT} (90° for simulation; 150° for shading)`, kind: 'craft' },
  quadSkew: { name: 'Skewed quad', good: 'skew ≤ 0.7', why: 'Leaning far from square: its triangulation starts to show in the shading', source: `${CUBIT} (0–0.5 for simulation)`, kind: 'craft' },
  quadTaper: { name: 'Tapered quad', good: 'taper ≤ 0.8', why: 'One end much narrower than the other: close to a triangle with a cut corner', source: `${CUBIT} (0–0.7 for simulation)`, kind: 'craft' },
  faceted: { name: 'Faceted curve', good: 'at most 32° between segments', why: 'The silhouette turns more than a 12-sided circle between faces: the flat segments show as corners. Add a loop only where the curve is big enough to see', source: `${PC}: chord sagitta, scale-free`, kind: 'craft' },
  dense: { name: 'Over-dense curve', good: 'at least 1° per segment', why: 'A curve split past ~360 segments: polygons that change nothing on screen; a normal map carries the smoothness', source: `${PC}: polycount where it shows`, kind: 'craft' },
};
export interface Issue { rule: RuleId; value: string; score: number }
export interface Report { score: Float32Array; issues: Map<number, Issue[]> }
const reports = new WeakMap<Int32Array, { soup: Float32Array; size: number; report: Report }>();
/** The whole model's size (its bounding-box diagonal), so a curve is only judged for faceting if it is large enough on
 *  screen to see (a 1 mm bevel on a 1 m gun is not); 0: each part by its own. */
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
  for (const [a, b] of m.nonManifold) {
    const e = edgeBetween(t, a, b), faces = t.edgeTris[e] ?? [];
    for (const f of faces) note(g.poly[f], { rule: 'nonManifold', score: 1, value: `${faces.length} faces on one edge` });
  }
  for (const v of m.nonManifoldVert) {
    const ps = new Set(trisOf(t, v).map((f) => g.poly[f]));
    for (const p of ps) note(p, { rule: 'nonManifoldVert', score: 1, value: `${ps.size} faces meet only at a point` });
  }
  for (const shell of m.insideOut) for (const f of shell) note(g.poly[f], { rule: 'insideOut', score: 1, value: `${shell.length} faces wound inward` });
  // each polygon's corner shape
  const mem = members(g.poly);
  for (const [p, tris] of mem) {
    const l = loopOf(t, tris);
    if (!l) note(p, { rule: 'outline', score: 0.75, value: '' });
    else for (const i of shapeIssues(l.map(at))) note(p, i);
  }
  // sampling: a smooth curve's turn per segment, not its chord error as a share of the model. The segment size gate
  // keeps a tiny bevel's facets out of it; `even` keeps a deliberate chamfer or bevel strip (a wide face beside a
  // narrow one) out of it too.
  let D = modelSize;
  if (!D) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); }
    D = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  }
  const worstTurn = new Map<number, number>(), own = new Map<number, number[]>();
  for (const e of curveEdges(g)) {
    if (!e.even || e.radius <= 0.002 * D) continue;
    for (const p of [e.p, e.q]) worstTurn.set(p, Math.max(worstTurn.get(p) ?? 0, e.bend));
    for (const [p, b] of [[e.p, e.bend], [e.q, e.bend]]) (own.get(p) ?? own.set(p, []).get(p)!).push(b);
  }
  for (const [p, b] of worstTurn) {
    // faceting is a look issue, never a bake blocker: it stays in the "worth a look" band (≤ 0.55), so a deliberately
    // low-poly button or a 2-segment bevel is a hint rather than a red face. Add Loops is offered in its menu.
    const score = Math.min(0.55, ramp(b, 32 * deg, 45 * deg));
    if (score > 0) note(p, { rule: 'faceted', score, value: `${(b / deg).toFixed(0)}° between segments` });
  }
  for (const [p, bs] of own) {
    if (bs.length >= 2 && Math.max(...bs) < 1 * deg) note(p, { rule: 'dense', score: 0.15, value: `${(Math.max(...bs) / deg).toFixed(2)}° per segment` });
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
  for (const [p, is] of healthReport(g).issues) {
    const seen = new Set<RuleId>(); // one polygon counted once per rule, however many of its edges/faces are hit
    for (const i of is) {
      if (seen.has(i.rule)) continue;
      seen.add(i.rule);
      const r = out.get(i.rule) ?? out.set(i.rule, { look: [], fix: [] }).get(i.rule)!;
      (i.score >= 0.6 ? r.fix : r.look).push(p);
    }
  }
  return out;
}

/** Green (solid) through yellow (worth a look) to red (fix), continuous at every step. */
const HEALTH_STOPS: [number, [number, number, number]][] = [
  [0, [0.24, 0.65, 0.32]],
  [0.35, [0.70, 0.78, 0.28]],
  [0.65, [0.96, 0.74, 0.20]],
  [1, [0.88, 0.22, 0.18]],
];
export function healthColor(s: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, s));
  for (let i = 1; i < HEALTH_STOPS.length; i++) {
    const [x1, c1] = HEALTH_STOPS[i - 1], [x2, c2] = HEALTH_STOPS[i];
    if (x <= x2) { const t = (x - x1) / (x2 - x1 || 1); return [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t]; }
  }
  return HEALTH_STOPS[HEALTH_STOPS.length - 1][1];
}

/** Share of a part's area that's solid (< 0.2), worth a look, and to fix (≥ 0.6). */
export function healthSummary(out: PartOut, score: Float32Array) {
  const P = out.positions, sum = [0, 0, 0];
  for (let t = 0; t < score.length; t++) {
    const o = t * 9, u = [P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]], v = [P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]];
    const a = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    sum[score[t] < 0.2 ? 0 : score[t] < 0.6 ? 1 : 2] += a;
  }
  const all = sum[0] + sum[1] + sum[2] || 1;
  return { solid: sum[0] / all, look: sum[1] / all, fix: sum[2] / all };
}

/** One line for the panel: what a bake would say about this part. */
export function healthVerdict(out: PartOut, g: Geo): { kind: 'ok' | 'look' | 'fix'; text: string } {
  const sum = healthSummary(out, health(out, g)), count = ruleCounts(g);
  let broken = 0;
  for (const [id, r] of count) if (RULES[id].kind === 'broken') broken += r.fix.length + r.look.length;
  if (broken) return { kind: 'fix', text: `${broken} broken` };
  if (sum.fix > 0.005) return { kind: 'fix', text: 'fix before baking' };
  if (sum.look > 0.02) return { kind: 'look', text: 'worth a look' };
  return { kind: 'ok', text: 'ready to bake' };
}
