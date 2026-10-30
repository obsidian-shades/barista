// Automatic rigging for Geppetto: a bone for every part that articulates, parented by what it touches, its joint at
// the contact and its range of motion read from the shape and the name (a magazine slides, a trigger hinges, buttons
// press). Parts that look like fixed housing (grip, frame, shell, barrel) follow their parent's bone instead of adding
// a bone that never moves. Everything is a guess laid out for the artist to nudge: nothing here is a simulation.
import * as THREE from 'three';
import { freshName, rollFor, weldCorners, type Bone, type MoveRange, type V3 } from './rig.ts';

export type Motion = 'free' | 'hinge' | 'slide' | 'press' | 'fixed';
export interface AutoPart { name: string; positions: ArrayLike<number> }
export interface AutoRigOptions {
  /** Give fixed details their own (locked) bone instead of binding them to the parent's. */
  details?: boolean;
  /** Read slide / press / hinge from shape and name; false lays a free bone for every part. */
  motion?: boolean;
}
export interface AutoRigResult { bones: Bone[]; partBone: number[] }
/** A bone fitted to one part: where its joint goes, which way it runs, and how it may move. */
export interface Fit {
  motion: Motion;
  head: V3;
  tail: V3;
  roll: number;
  limit: Bone['limit'];
  move: MoveRange | null;
}

const V = (x: number, y: number, z: number): V3 => [x, y, z];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist = (a: V3, b: V3) => len(sub(a, b));
const ZERO_MOVE: MoveRange = { x: [0, 0], y: [0, 0], z: [0, 0] };
const ZERO_ROT: NonNullable<Bone['limit']> = { x: [0, 0], y: [0, 0], z: [0, 0] };

/** A symmetric 3×3's eigenvectors (Jacobi), biggest first. Deterministic: each vector's largest part is positive. */
function eigenSym(c: number[][]): { val: number[]; vec: V3[] } {
  const a = c.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-14) continue;
      off += a[p][q] * a[p][q];
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      const app = a[p][p], aqq = a[q][q], apq = a[p][q];
      a[p][p] = cs * cs * app - 2 * sn * cs * apq + sn * sn * aqq;
      a[q][q] = sn * sn * app + 2 * sn * cs * apq + cs * cs * aqq;
      a[p][q] = a[q][p] = 0;
      for (let k = 0; k < 3; k++) if (k !== p && k !== q) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = a[p][k] = cs * akp - sn * akq;
        a[k][q] = a[q][k] = sn * akp + cs * akq;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = cs * vkp - sn * vkq;
        v[k][q] = sn * vkp + cs * vkq;
      }
    }
    if (off < 1e-18) break;
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const vec = order.map((k): V3 => {
    let x = [v[0][k], v[1][k], v[2][k]] as V3;
    const big = Math.abs(x[0]) >= Math.abs(x[1]) && Math.abs(x[0]) >= Math.abs(x[2]) ? 0 : Math.abs(x[1]) >= Math.abs(x[2]) ? 1 : 2;
    if (x[big] < 0) x = mul(x, -1);
    return norm(x);
  });
  return { val: order.map((k) => Math.max(0, a[k][k])), vec };
}

/** A spatial hash of a part's sampled corners, for the nearest-surface questions auto-rigging asks. */
class PointGrid {
  private cell: number;
  private map = new Map<number, number[]>();
  private samples: Float32Array;
  private count: number;
  constructor(samples: Float32Array, count: number, diag: number) {
    this.samples = samples;
    this.count = count;
    this.cell = Math.max(diag * 0.04, 1e-6);
    for (let i = 0; i < count; i++) {
      const k = this.key(Math.floor(samples[i * 3] / this.cell), Math.floor(samples[i * 3 + 1] / this.cell), Math.floor(samples[i * 3 + 2] / this.cell));
      const a = this.map.get(k);
      if (a) a.push(i); else this.map.set(k, [i]);
    }
  }
  // a numeric hash: collisions only cost a distance check, never a wrong answer
  private key(x: number, y: number, z: number) { return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791); }
  /** The nearest sampled corner within `maxR` (maxR itself when there is none). */
  nearest(x: number, y: number, z: number, maxR: number): number {
    const r = Math.min(16, Math.ceil(maxR / this.cell)), ix = Math.floor(x / this.cell), iy = Math.floor(y / this.cell), iz = Math.floor(z / this.cell);
    let best = maxR * maxR;
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const ids = this.map.get(this.key(ix + dx, iy + dy, iz + dz));
      if (!ids) continue;
      for (const i of ids) {
        const d = (this.samples[i * 3] - x) ** 2 + (this.samples[i * 3 + 1] - y) ** 2 + (this.samples[i * 3 + 2] - z) ** 2;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }
}

interface Shape {
  name: string;
  samples: Float32Array;
  count: number;
  centre: V3;
  box: THREE.Box3;
  diag: number;
  /** Longest principal direction, then the middle and thinnest ones (deterministic signs). */
  eig: [V3, V3, V3];
  /** Half the sampled span along each eigenvector. */
  ext: [number, number, number];
  /** The bone direction through the part, from its 2% to its 98% projection. */
  axis: V3;
  lo: number;
  hi: number;
  grid: PointGrid;
}
interface Contact { dist: number; count: number; centre: V3 | null; cLo: number; cHi: number; contains: boolean }

const quantile = (a: number[], q: number) => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))];

/** Sample a part (soup corners duplicate a lot, so every nth) and read its principal frame. */
function shapeOf(part: AutoPart): Shape | null {
  const n = part.positions.length / 3;
  if (!n) return null;
  const box = new THREE.Box3().setFromArray(part.positions as ArrayLike<number>);
  const step = Math.max(1, Math.ceil(n / 2400)), count = Math.max(1, Math.floor(n / step));
  const samples = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const c = Math.min(n - 1, i * step);
    samples[i * 3] = part.positions[c * 3];
    samples[i * 3 + 1] = part.positions[c * 3 + 1];
    samples[i * 3 + 2] = part.positions[c * 3 + 2];
  }
  const mean = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) mean[k] += samples[i * 3 + k] / count;
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < count; i++) {
    const d = [samples[i * 3] - mean[0], samples[i * 3 + 1] - mean[1], samples[i * 3 + 2] - mean[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += d[a] * d[b] / count;
  }
  const { vec } = eigenSym(cov);
  const proj = (v: V3) => {
    const t: number[] = [];
    for (let i = 0; i < count; i++) t.push((samples[i * 3] - mean[0]) * v[0] + (samples[i * 3 + 1] - mean[1]) * v[1] + (samples[i * 3 + 2] - mean[2]) * v[2]);
    t.sort((a, b) => a - b);
    return { lo: quantile(t, 0.02), hi: quantile(t, 0.98), ext: (quantile(t, 0.98) - quantile(t, 0.02)) / 2, sorted: t };
  };
  const p0 = proj(vec[0]), p1 = proj(vec[1]), p2 = proj(vec[2]);
  const order = [0, 1, 2].sort((a, b) => [p0, p1, p2][b].ext - [p0, p1, p2][a].ext);
  let eig = order.map((k) => vec[k]) as [V3, V3, V3];
  let ext = order.map((k) => [p0, p1, p2][k].ext) as [number, number, number];
  // A cube, a sphere or a square rod has no unique principal direction; take the world axes instead of whatever
  // diagonal Jacobi happened to land on. When only the top two are even, keep the unique thin axis and use a box
  // axis across it, so a hinge still points along the part's thin side.
  const top = Math.max(ext[0], 1e-9);
  if ((top - Math.min(...ext)) / top < 0.03) {
    const size = box.getSize(new THREE.Vector3()), world: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const ws = [0, 1, 2].sort((a, b) => [size.x, size.y, size.z][b] - [size.x, size.y, size.z][a]);
    eig = ws.map((k) => world[k]) as [V3, V3, V3];
    ext = eig.map((e) => proj(e).ext) as [number, number, number];
  } else if (ext[0] < ext[1] * 1.03) {
    const thin = eig[2], world: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const across = world.map((a) => sub(a, mul(thin, dot(a, thin)))).sort((a, b) => len(b) - len(a))[0];
    if (len(across) > 0.2) {
      const x = norm(across);
      eig = [x, norm(cross(thin, x)), thin];
      ext = eig.map((e) => proj(e).ext) as [number, number, number];
    }
  }
  const axis = eig[0];
  const pa = proj(axis);
  const centre: V3 = [mean[0], mean[1], mean[2]];
  const diag = box.getSize(new THREE.Vector3()).length() || Math.max(ext[0] * 2, 1e-6);
  return { name: part.name, samples, count, centre, box, diag, eig, ext, axis, lo: pa.lo, hi: pa.hi, grid: new PointGrid(samples, count, diag) };
}

const boxGap = (a: THREE.Box3, b: THREE.Box3) => {
  const dx = Math.max(a.min.x - b.max.x, b.min.x - a.max.x, 0);
  const dy = Math.max(a.min.y - b.max.y, b.min.y - a.max.y, 0);
  const dz = Math.max(a.min.z - b.max.z, b.min.z - a.max.z, 0);
  return Math.hypot(dx, dy, dz);
};
const boxDist = (p: V3, b: THREE.Box3) => {
  const dx = Math.max(b.min.x - p[0], p[0] - b.max.x, 0);
  const dy = Math.max(b.min.y - p[1], p[1] - b.max.y, 0);
  const dz = Math.max(b.min.z - p[2], p[2] - b.max.z, 0);
  return Math.hypot(dx, dy, dz);
};

const boxDistPoint = (x: number, y: number, z: number, b: THREE.Box3) => {
  const dx = Math.max(b.min.x - x, x - b.max.x, 0);
  const dy = Math.max(b.min.y - y, y - b.max.y, 0);
  const dz = Math.max(b.min.z - z, z - b.max.z, 0);
  return Math.hypot(dx, dy, dz);
};

/** How close `child` comes to `parent`, and where it touches: samples within `tol`, and the nearest sample. */
function contactOf(child: Shape, parent: Shape, tol: number, maxDist: number): Contact {
  let nearest = maxDist, count = 0, cx = 0, cy = 0, cz = 0, cLo = Infinity, cHi = -Infinity;
  const step = Math.max(1, Math.ceil(child.count / (maxDist <= tol * 3 ? 400 : 80))), c = child.centre;
  for (let i = 0; i < child.count; i += step) {
    const x = child.samples[i * 3], y = child.samples[i * 3 + 1], z = child.samples[i * 3 + 2];
    if (boxDistPoint(x, y, z, parent.box) > maxDist) continue; // far outside: no nearer vertex can be in reach
    const d = parent.grid.nearest(x, y, z, maxDist);
    if (d < nearest) nearest = d;
    if (d <= tol) {
      count++; cx += x; cy += y; cz += z;
      const t = (x - c[0]) * child.axis[0] + (y - c[1]) * child.axis[1] + (z - c[2]) * child.axis[2];
      cLo = Math.min(cLo, t); cHi = Math.max(cHi, t);
    }
  }
  return {
    dist: nearest, count,
    centre: count ? [cx / count, cy / count, cz / count] : null,
    cLo: count ? cLo : 0, cHi: count ? cHi : 0,
    contains: parent.box.containsPoint(new THREE.Vector3(...c)),
  };
}

const words = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const has = (name: string, list: string[]) => { const ws = name.split(' '); return list.some((w) => ws.some((x) => x.startsWith(w))); };
// "shell" is a gun's cartridge case (it slides out of the chamber), not housing: housing says frame / body / housing
const FIXED = ['frame', 'body', 'receiver', 'chassis', 'grip', 'stock', 'handguard', 'barrel', 'rail', 'mount', 'cover', 'panel', 'plate', 'guard', 'sight', 'scope', 'sides', 'side', 'housing', 'case', 'bracket', 'tray'];
const HINGE = ['trigger', 'hammer', 'lever', 'latch', 'catch', 'folding', 'hinge', 'flap', 'door', 'lid', 'clamp', 'pedal', 'crank', 'knuckle', 'safety', 'breech'];
const SLIDE = ['mag', 'magazine', 'slide', 'slider', 'piston', 'rod', 'plunger', 'carriage', 'bolt', 'drawer', 'telescop', 'recoil', 'pump', 'shell', 'casing', 'cartridge', 'ejector'];
/** A root held in the hand: its bone goes in the handle (`handleFit`), not along the part's longest line. */
const HELD = ['grip', 'handle'];

/** A held root's bone: head at the palm, up the handle, its X across the model (turning X aims the model up and down),
 *  so the whole model turns about where it is held. The handle is the stretch of the part farthest out from the model's
 *  long axis (a pistol's grip hangs below its barrel); null when the part has no such stretch. */
function handleFit(s: Shape, mid: V3, long: V3, thin: V3): { head: V3; tail: V3; roll: number } | null {
  const at = (i: number): V3 => [s.samples[i * 3], s.samples[i * 3 + 1], s.samples[i * 3 + 2]];
  const off: V3[] = [];
  for (let i = 0; i < s.count; i++) { const p = sub(at(i), mid); off.push(sub(p, mul(long, dot(p, long)))); }
  // which way the handle hangs: the mean offset of the farthest tenth of the part
  const far = off.map(len).sort((a, b) => b - a)[Math.floor(s.count * 0.1)] ?? 0;
  let d: V3 = [0, 0, 0];
  for (const o of off) if (len(o) >= far) d = add(d, o);
  if (len(d) < 1e-9) return null;
  d = norm(d);
  const t = off.map((o) => dot(o, d)), top = Math.max(...t);
  const centre = (lo: number, hi: number): V3 | null => {
    let c: V3 = [0, 0, 0], k = 0;
    t.forEach((v, i) => { if (v >= lo * top && v <= hi * top) { c = add(c, at(i)); k++; } });
    return k ? mul(c, 1 / k) : null;
  };
  // the butt, the handle's upper half (above the butt, below a trigger guard), and the palm between them
  const butt = centre(0.8, 1), upper = centre(0.35, 0.55), palm = centre(0.35, 1);
  if (!butt || !upper || !palm || top <= 0) return null;
  const dir = norm(sub(upper, butt));
  const across = sub(thin, mul(dir, dot(thin, dir)));
  return { head: palm, tail: add(palm, mul(dir, dist(butt, upper) * 1.5)), roll: len(across) > 0.2 ? rollFor(dir, norm(across)) : 0 };
}
const PRESS = ['button', 'press', 'key', 'knob', 'toggle', 'pad', 'switch'];

/** Whether a part's name says how it moves (Slider, Mag, Trigger, Grip…): its loose pieces then move as one. */
export const namedMotion = (name: string) => { const n = words(name); return [PRESS, SLIDE, HINGE, FIXED].some((l) => has(n, l)); };

/** The part of the thinnest axis that runs across the bone: the hinge pin. */
function thinAcross(s: Shape, dir: V3): V3 {
  for (const e of [s.eig[2], s.eig[1], s.eig[0]]) {
    const px = sub(e, mul(dir, dot(e, dir)));
    if (len(px) > 0.25) return norm(px);
  }
  const fallback = Math.abs(dir[0]) < 0.9 ? V(1, 0, 0) : V(0, 1, 0);
  return norm(sub(fallback, mul(dir, dot(fallback, dir))));
}
/** The share of the child's bone that lies inside the parent's box: an inserted rod, a magazine in its well. */
function overlapAlong(s: Shape, parent: Shape, dir: V3): number {
  const pts: V3[] = [];
  for (let i = 0; i < 8; i++) pts.push([(i & 1 ? parent.box.max.x : parent.box.min.x), (i & 2 ? parent.box.max.y : parent.box.min.y), (i & 4 ? parent.box.max.z : parent.box.min.z)]);
  const t = pts.map((p) => dot(sub(p, s.centre), dir));
  const lo = Math.max(s.lo, Math.min(...t)), hi = Math.min(s.hi, Math.max(...t));
  return Math.max(0, hi - lo) / Math.max(1e-9, s.hi - s.lo);
}

/** Whether the parent's box reaches well past the part on both sides of its thin axis (twice its thickness each way). */
function embedded(s: Shape, parent: Shape): boolean {
  const thin = s.eig[2], t: number[] = [];
  for (let i = 0; i < 8; i++) t.push(dot([(i & 1 ? parent.box.max.x : parent.box.min.x), (i & 2 ? parent.box.max.y : parent.box.min.y), (i & 4 ? parent.box.max.z : parent.box.min.z)], thin));
  const c = dot(s.centre, thin), room = s.ext[2] * 4;
  return Math.max(...t) - c > room && c - Math.min(...t) > room;
}

/** What the part looks like it does: a name hint first (mag, trigger, button, grip), then the shape. */
function classify(s: Shape, parent: Shape, c: Contact, dir: V3, span: number): Motion {
  const n = words(s.name);
  const press = has(n, PRESS), slide = has(n, SLIDE), hinge = has(n, HINGE), fixed = has(n, FIXED);
  if (press) return 'press';
  if (slide) return 'slide';
  if (hinge) return 'hinge';
  if (fixed) return 'fixed';
  const ext = s.ext, flat = ext[2] < ext[1] * 0.5, long = ext[0] > ext[1] * 1.7;
  const aligned = Math.max(...parent.eig.map((e) => Math.abs(dot(s.axis, e))));
  const insert = overlapAlong(s, parent, dir);
  const spread = c.count ? (c.cHi - c.cLo) / Math.max(1e-9, span) : 1;
  const small = s.diag < parent.diag * 0.25;
  // a button sits on the parent's skin; a flat part held in the parent's middle plane (a trigger in its guard) swings
  if (small && flat && c.count > 0 && spread > 0.35) return embedded(s, parent) ? 'hinge' : 'press';
  if (long && aligned > 0.72 && insert > 0.35 && ext[1] < ext[0] * 0.8) return 'slide';
  if (flat && c.count > 0 && spread < 0.7) return 'hinge';
  return 'free';
}

/** Fit one part: joint at its attachment, bone through its long axis, limits from `classify`. */
function fitShape(s: Shape, parent: Shape | null, centre: V3, modelDiag: number, motionOn: boolean, force?: Motion): Fit {
  const parentCentre = parent ? parent.centre : centre;
  const lo = add(s.centre, mul(s.axis, s.lo)), hi = add(s.centre, mul(s.axis, s.hi));
  const [near, far] = dist(lo, parentCentre) <= dist(hi, parentCentre) ? [lo, hi] : [hi, lo];
  const dir = norm(sub(far, near)), span = Math.max(dist(near, far), modelDiag * 1e-4);
  const c = parent ? contactOf(s, parent, modelDiag * 0.02, Math.min(modelDiag * 0.05, Math.max(Math.min(s.diag, parent.diag) * 0.35, 1e-6))) : null;
  const motion: Motion = force ?? (!parent || !motionOn ? 'free' : classify(s, parent, c!, dir, span));
  let head = near, tail = far, roll = 0, limit: Bone['limit'] = null, move: MoveRange | null = null;
  if (motion === 'hinge') {
    if (c && c.count >= 3 && c.centre) {
      const t = Math.min(span * 0.35, Math.max(0, dot(sub(c.centre, near), dir)));
      head = add(near, mul(dir, t));
    }
    roll = rollFor(dir, thinAcross(s, dir));
    limit = { x: [-90, 90], y: [0, 0], z: [0, 0] };
    move = ZERO_MOVE;
  } else if (motion === 'slide') {
    const travel = span * 0.25;
    limit = { ...ZERO_ROT };
    move = { x: [0, 0], y: [-travel, travel], z: [0, 0] };
  } else if (motion === 'press') {
    let out = thinAcross(s, dir);
    if (dot(out, sub(s.centre, parentCentre)) < 0) out = mul(out, -1);
    const thick = Math.max(s.ext[2], modelDiag * 0.004), l = Math.max(thick * 1.5, modelDiag * 0.012);
    head = sub(s.centre, mul(out, l / 2));
    tail = add(s.centre, mul(out, l / 2));
    limit = { ...ZERO_ROT };
    move = { x: [0, 0], y: [-Math.max(thick * 0.8, modelDiag * 0.004), 0], z: [0, 0] };
  } else if (motion === 'fixed') {
    limit = { ...ZERO_ROT };
    move = ZERO_MOVE;
  }
  return { motion, head, tail, roll, limit, move };
}

/** Fit a bone to a part by itself (Auto fit, and the motion presets with `force`: a Hinge turns the bone so it swings
 *  the way the part would, not about whatever axis a Press fit left it on): the same reading auto-rig uses. */
export function fitPart(part: AutoPart, parent?: AutoPart, centre?: V3, force?: Motion): Fit {
  const s = shapeOf(part);
  const fallback: Fit = { motion: 'free', head: [0, 0, 0], tail: [0, 1, 1], roll: 0, limit: null, move: null };
  if (!s) return fallback;
  const p = parent ? shapeOf(parent) : null;
  const c: V3 = centre ?? (p ? p.centre : s.centre);
  return fitShape(s, p, c, Math.max(s.diag, p?.diag ?? 0, 1e-6), true, force);
}

/** Auto-rig: hierarchy from contact, joints and motion from each part's shape. `partBone[i]` is the bone that moves
 *  part i (-1 when it has no geometry). Fixed details share their parent's bone unless `details` asks for one each. */
export function autoRig(parts: AutoPart[], opts: AutoRigOptions = {}): AutoRigResult {
  const shapes: (Shape | null)[] = parts.map(shapeOf);
  const partBone = new Array<number>(parts.length).fill(-1);
  const valid = shapes.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (!valid.length) return { bones: [], partBone };

  const world = new THREE.Box3();
  for (const i of valid) world.union(shapes[i]!.box);
  const centre = world.getCenter(new THREE.Vector3()), modelDiag = world.getSize(new THREE.Vector3()).length() || 1;
  const mid: V3 = [centre.x, centre.y, centre.z];

  // ---- who touches whom: a minimum spanning forest weighted by surface distance, with containment preferred ----
  const edges: { a: number; b: number; w: number }[] = [];
  for (let x = 0; x < valid.length; x++) for (let y = x + 1; y < valid.length; y++) {
    const i = valid[x], j = valid[y], A = shapes[i]!, B = shapes[j]!;
    const gap = boxGap(A.box, B.box);
    if (gap > modelDiag * 0.18) continue;
    const [small, big] = A.diag <= B.diag ? [A, B] : [B, A];
    const reach = Math.min(modelDiag * 0.1, Math.max(Math.min(A.diag, B.diag) * 0.5, modelDiag * 0.005));
    const c = contactOf(small, big, modelDiag * 0.02, reach);
    if (c.dist >= reach && gap > reach) continue;
    const cd = A.box.getCenter(new THREE.Vector3()).distanceTo(B.box.getCenter(new THREE.Vector3()));
    let w = c.dist + gap * 1.5 + cd * 0.01;
    if (c.contains) w *= 0.5;
    edges.push({ a: i, b: j, w });
  }
  edges.sort((p, q) => p.w - q.w);
  const uf = new Map<number, number>(valid.map((i) => [i, i]));
  const find = (a: number): number => { const p = uf.get(a) ?? a; if (p === a) return a; const r = find(p); uf.set(a, r); return r; };
  const adj = new Map<number, number[]>();
  for (const i of valid) adj.set(i, []);
  for (const e of edges) {
    const [ra, rb] = [find(e.a), find(e.b)];
    if (ra === rb) continue;
    uf.set(ra, rb);
    adj.get(e.a)!.push(e.b); adj.get(e.b)!.push(e.a);
  }
  // each tree is rooted on the part whose box holds the model's middle (then the biggest): the frame, not a rail
  const seen = new Set<number>(), roots: number[] = [], order: number[] = [];
  for (const i of valid.slice().sort((a, b) => shapes[b]!.diag - shapes[a]!.diag)) {
    if (seen.has(i)) continue;
    const comp: number[] = [], stack = [i];
    seen.add(i);
    while (stack.length) { const k = stack.pop()!; comp.push(k); for (const j of adj.get(k)!) if (!seen.has(j)) { seen.add(j); stack.push(j); } }
    const root = comp.reduce((best, k) => {
      const d = boxDist(mid, shapes[k]!.box);
      const bd = boxDist(mid, shapes[best]!.box);
      return d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && shapes[k]!.diag > shapes[best]!.diag) ? k : best;
    }, comp[0]);
    roots.push(root);
  }
  const parentPart = new Map<number, number>();
  const queue = roots.slice();
  for (const r of roots) { seen.add(r); order.push(r); parentPart.set(r, -1); }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    for (const j of adj.get(k)!) {
      if (parentPart.has(j)) continue;
      parentPart.set(j, k);
      order.push(j);
      queue.push(j);
    }
  }
  for (const i of valid) if (!parentPart.has(i)) { parentPart.set(i, -1); order.push(i); }

  // the model's barrel line and thin side, for a held root's handle: the box's longest and shortest axes. Not principal
  // axes: the handle itself tilts those (a pistol's grip pulls its long axis down toward the butt).
  // ponytail: a model authored at an angle to the world axes gets a skewed handle; PCA with the handle left out if that turns up
  const size = world.getSize(new THREE.Vector3()), axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const byLen = [0, 1, 2].sort((a, b) => [size.x, size.y, size.z][b] - [size.x, size.y, size.z][a]);
  const model = { vec: byLen.map((k) => axes[k]) };

  // ---- lay the bones ----
  const bones: Bone[] = [];
  for (const i of order) {
    const s = shapes[i]!, parent = parentPart.get(i) ?? -1, parentBone = parent >= 0 ? partBone[parent] : -1;
    const fit = fitShape(s, parent >= 0 ? shapes[parent] : null, mid, modelDiag, opts.motion !== false);
    const hand = parent < 0 && has(words(s.name), HELD) ? handleFit(s, mid, model.vec[0], model.vec[2]) : null;
    if (hand) Object.assign(fit, hand);
    if (fit.motion === 'fixed' && !opts.details && parentBone >= 0) { partBone[i] = parentBone; continue; }
    let connected = false;
    if (parentBone >= 0 && fit.motion !== 'slide' && fit.motion !== 'press') {
      const tail = bones[parentBone].tail;
      if (dist(fit.head, tail) < Math.max(modelDiag * 0.02, 1e-6)) { fit.head = [...tail]; connected = true; }
    }
    const bone: Bone = {
      name: freshName(bones, s.name),
      head: fit.head,
      tail: fit.tail,
      parent: parentBone,
      ...(fit.roll ? { roll: +fit.roll.toFixed(2) } : {}),
      ...(connected ? { connected: true } : {}),
      limit: fit.limit,
      move: connected ? ZERO_MOVE : fit.move,
      slide: null,
    };
    if (dist(bone.head, bone.tail) < modelDiag * 1e-5) bone.tail = add(bone.head, mul(norm(sub(bone.tail, bone.head)), modelDiag * 0.01));
    bones.push(bone);
    partBone[i] = bones.length - 1;
  }
  return { bones, partBone };
}

/** A part's loose shells (corners welded by exact position, as the FBX export welds them): one mesh holding several
 *  rigid pieces gets one auto-rig unit per piece. Null when there is nothing worth splitting, or too many pieces. */
export function looseUnits(soup: Float32Array, limit = 48): { triangles: number[]; positions: Float32Array }[] | null {
  const n = soup.length / 9;
  if (n < 2) return null;
  const weld = weldCorners(soup), up = new Int32Array(weld.n);
  for (let i = 0; i < up.length; i++) up[i] = i;
  const find = (a: number): number => { while (up[a] !== a) { up[a] = up[up[a]]; a = up[a]; } return a; };
  for (let t = 0; t < n; t++) {
    const a = find(weld.vi[t * 3]), b = find(weld.vi[t * 3 + 1]), c = find(weld.vi[t * 3 + 2]);
    up[b] = a; up[find(c)] = a;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    const r = find(weld.vi[t * 3]);
    const g = groups.get(r);
    if (g) g.push(t); else groups.set(r, [t]);
  }
  if (groups.size < 2 || groups.size > limit || groups.size > n * 0.6) return null;
  return [...groups.values()].map((triangles) => {
    const positions = new Float32Array(triangles.length * 9);
    triangles.forEach((t, k) => positions.set(soup.subarray(t * 9, t * 9 + 9), k * 9));
    return { triangles, positions };
  });
}

/** The shortest distance from a point to a bone's segment (rest space), for Skin to nearest bone. */
export function boneDistance(b: Bone, x: number, y: number, z: number): number {
  const ax = b.head[0], ay = b.head[1], az = b.head[2];
  const tx = b.tail[0] - ax, ty = b.tail[1] - ay, tz = b.tail[2] - az;
  const l = tx * tx + ty * ty + tz * tz;
  const k = l > 1e-12 ? Math.min(1, Math.max(0, ((x - ax) * tx + (y - ay) * ty + (z - az) * tz) / l)) : 0;
  return Math.hypot(x - (ax + tx * k), y - (ay + ty * k), z - (az + tz * k));
}
