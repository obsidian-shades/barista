// The shape rules for one polygon from its corners (Sandia Verdict / CUBIT metrics for quads, corner angles for
// triangles, flatness for n-gons), shared by Health (which names and colours them) and Even Out (which won't make them
// worse). Scores: 0 fine … 1 bad; only rules a polygon breaks are returned.
export type ShapeRule = 'triMin' | 'triMax' | 'quadJacobian' | 'quadSkew' | 'quadTaper' | 'quadWarp' | 'quadAspect' | 'ngonBent';
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
    const a = P.map((p, i) => angle(sub(P[(i + n - 1) % n], p), sub(P[(i + 1) % n], p)));
    push('triMin', ramp(-Math.min(...a), -30 * deg, -8 * deg), `smallest angle ${(Math.min(...a) / deg).toFixed(1)}°`);
    push('triMax', ramp(Math.max(...a), 120 * deg, 165 * deg), `largest angle ${(Math.max(...a) / deg).toFixed(1)}°`);
  } else if (n === 4) {
    const [p0, p1, p2, p3] = P, X1 = add(sub(p1, p0), sub(p2, p3)), X2 = add(sub(p2, p1), sub(p3, p0)), X12 = add(sub(p0, p1), sub(p2, p3));
    const N = unit(add(cross(sub(p1, p0), sub(p3, p0)), cross(sub(p3, p2), sub(p1, p2))));
    const jac = Math.min(...P.map((p, i) => dot(cross(sub(P[(i + 1) % 4], p), sub(P[(i + 3) % 4], p)), N) / ((len(sub(P[(i + 1) % 4], p)) * len(sub(P[(i + 3) % 4], p))) || 1)));
    const skew = Math.abs(dot(unit(X1), unit(X2))), taper = Math.max(len(X12) / (len(X1) || 1), len(X12) / (len(X2) || 1));
    const aspect = Math.max(len(X1) / (len(X2) || 1), len(X2) / (len(X1) || 1));
    // warpage: how far the two halves of each diagonal split disagree (1 flat)
    const nrm = (a: V, b: V, c: V) => unit(cross(sub(b, a), sub(c, a)));
    const warp = Math.min(dot(nrm(p0, p1, p2), nrm(p0, p2, p3)), dot(nrm(p1, p2, p3), nrm(p1, p3, p0)));
    push('quadJacobian', ramp(-jac, -0.5, -0.1), `scaled Jacobian ${jac.toFixed(2)}`);
    push('quadSkew', ramp(skew, 0.5, 0.85), `skew ${skew.toFixed(2)}`);
    push('quadTaper', ramp(taper, 0.7, 1), `taper ${taper.toFixed(2)}`);
    push('quadWarp', ramp(-warp, -0.9, -0.6), `warpage ${warp.toFixed(2)} (${(Math.acos(Math.max(-1, Math.min(1, warp))) / deg).toFixed(0)}° off flat)`);
    push('quadAspect', 0.45 * ramp(aspect, 4, 12), `aspect ratio ${aspect.toFixed(1)}`);
  } else {
    const c = P.reduce((a, p) => add(a, p.map((x) => x / n) as V), [0, 0, 0] as V), N: V = [0, 0, 0];
    P.forEach((a, i) => { const b = P[(i + 1) % n]; N[0] += (a[1] - b[1]) * (a[2] + b[2]); N[1] += (a[2] - b[2]) * (a[0] + b[0]); N[2] += (a[0] - b[0]) * (a[1] + b[1]); });
    const u = unit(N), size = Math.max(...P.map((p) => len(sub(p, c)))) || 1, off = Math.max(...P.map((p) => Math.abs(dot(sub(p, c), u)))) / size;
    push('ngonBent', ramp(off, 0.02, 0.15), `${(off * 100).toFixed(1)}% off its plane`);
  }
  return out;
}

/** A polygon's worst shape score (0 fine … 1 bad). */
export const shapeBadness = (P: V[]) => shapeIssues(P).reduce((m, i) => Math.max(m, i.score), 0);
