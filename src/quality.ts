// The shape rules for one polygon from its corners (Sandia Verdict / CUBIT metrics, retuned for game art: the ranges
// that matter for shading and baking, not for finite-element simulation), shared by Health (which names and colours
// them) and Even Out (which won't make them worse). Scores: 0 fine … 1 bad; only rules a polygon breaks are returned.
// Size is never judged here: a long quad on a flat strip is fine, and a tiny bevel is judged at its own scale by Health's
// sampling rule. Only corner shape and non-planarity are.
export type ShapeRule = 'triMin' | 'triMax' | 'quadJacobian' | 'quadSkew' | 'quadTaper' | 'quadWarp' | 'ngonBent';
export interface ShapeIssue { rule: ShapeRule; value: string; score: number }

const ramp = (x: number, good: number, bad: number) => Math.max(0, Math.min(1, (x - good) / (bad - good)));
const deg = Math.PI / 180;
export type V = [number, number, number];
export const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const angle = (a: V, b: V) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / ((len(a) * len(b)) || 1))));

/** One polygon's shape issues, from its corners in order (Verdict's quad metrics; corner angles for triangles; flatness for n-gons). */
export function shapeIssues(P: V[]): ShapeIssue[] {
  const n = P.length, out: ShapeIssue[] = [];
  const push = (rule: ShapeRule, score: number, value: string) => { if (score > 0) out.push({ rule, score, value }); };
  if (n === 3) {
    // Only true needles are flagged: a pole fan's wedges (a UV sphere, a cylinder cap) are 5–15° and shade correctly.
    // 6° green / 1.5° red is the game-art end of Verdict's 30–60° simulation range.
    const a = P.map((p, i) => angle(sub(P[(i + n - 1) % n], p), sub(P[(i + 1) % n], p)));
    push('triMin', ramp(-Math.min(...a), -6 * deg, -1.5 * deg), `smallest angle ${(Math.min(...a) / deg).toFixed(1)}°`);
    // A corner past 150° is a cap with almost no height; 120° (Verdict's shading limit) is a normal right-ish triangle.
    push('triMax', ramp(Math.max(...a), 150 * deg, 179 * deg), `largest angle ${(Math.max(...a) / deg).toFixed(1)}°`);
  } else if (n === 4) {
    const [p0, p1, p2, p3] = P, X1 = add(sub(p1, p0), sub(p2, p3)), X2 = add(sub(p2, p1), sub(p3, p0)), X12 = add(sub(p0, p1), sub(p2, p3));
    const N = unit(add(cross(sub(p1, p0), sub(p3, p0)), cross(sub(p3, p2), sub(p1, p2))));
    const jac = Math.min(...P.map((p, i) => dot(cross(sub(P[(i + 1) % 4], p), sub(P[(i + 3) % 4], p)), N) / ((len(sub(P[(i + 1) % 4], p)) * len(sub(P[(i + 3) % 4], p))) || 1)));
    const skew = Math.abs(dot(unit(X1), unit(X2))), taper = Math.max(len(X12) / (len(X1) || 1), len(X12) / (len(X2) || 1));
    // warpage: how far the two halves of each diagonal split disagree (1 flat). 18° is where the two possible
    // triangulations start to shade apart under MikkTSpace; 50° is a quad that isn't one quad any more.
    const nrm = (a: V, b: V, c: V) => unit(cross(sub(b, a), sub(c, a)));
    const warp = Math.min(dot(nrm(p0, p1, p2), nrm(p0, p2, p3)), dot(nrm(p1, p2, p3), nrm(p1, p3, p0)));
    // Verdict's 0.5 / 0.5 / 0.7 are simulation limits; a sheared or tapered quad is normal in organic and hard-surface
    // work, so only the extreme ends are flagged. A folded (negative Jacobian) corner is always red.
    push('quadJacobian', ramp(-jac, -0.4, -0.05), `scaled Jacobian ${jac.toFixed(2)}`);
    push('quadSkew', ramp(skew, 0.7, 0.95), `skew ${skew.toFixed(2)}`);
    push('quadTaper', ramp(taper, 0.8, 0.98), `taper ${taper.toFixed(2)}`);
    push('quadWarp', ramp(-warp, -Math.cos(18 * deg), -Math.cos(50 * deg)), `warpage ${warp.toFixed(2)} (${(Math.acos(Math.max(-1, Math.min(1, warp))) / deg).toFixed(0)}° off flat)`);
  } else {
    const c = P.reduce((a, p) => add(a, p.map((x) => x / n) as V), [0, 0, 0] as V), N: V = [0, 0, 0];
    P.forEach((a, i) => { const b = P[(i + 1) % n]; N[0] += (a[1] - b[1]) * (a[2] + b[2]); N[1] += (a[2] - b[2]) * (a[0] + b[0]); N[2] += (a[0] - b[0]) * (a[1] + b[1]); });
    const u = unit(N), size = Math.max(...P.map((p) => len(sub(p, c)))) || 1, off = Math.max(...P.map((p) => Math.abs(dot(sub(p, c), u)))) / size;
    push('ngonBent', ramp(off, 0.02, 0.2), `${(off * 100).toFixed(1)}% off its plane`);
  }
  return out;
}

/** A polygon's worst shape score (0 fine … 1 bad). */
export const shapeBadness = (P: V[]) => shapeIssues(P).reduce((m, i) => Math.max(m, i.score), 0);
