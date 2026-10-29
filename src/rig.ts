// Geppetto's rig: bones placed in the model's own space, each part's triangles bound rigidly to one bone (a
// hard-surface rig: a piston rod, a forearm plate, a trigger), and a pose that respects each bone's limits.
// Frames follow Blender's: a bone's Y runs head → tail, roll about that Y (0 = the shortest turn from +Y), so an FBX
// of these bones comes into Blender pointing the way they were drawn. A bone's pose is a turn about its own X / Y / Z
// (Euler XYZ, Blender's Limit Rotation order) and a translation (Blender's Transform / Limit Location); constraints
// (Follow, Aim, Stretch, Piston) drive a bone from another one, editor-side, the way Blender's bone constraints do.
import * as THREE from 'three';

export type V3 = [number, number, number];
/** Degrees, about the bone's own X / Y / Z, relative to its rest pose. */
export type Range = [number, number];
export type ConstraintKind = 'follow' | 'aim' | 'stretch' | 'piston' | 'copyRot' | 'copyLoc';
/** A bone constraint. Targets are bones (one per part, named after it), never face or vertex selections: aim and
 *  stretch read a point on the target's surface, so a piston rod can track the socket on another part. */
export interface Constraint {
  kind: ConstraintKind;
  /** Index of the bone it reads. */
  target: number;
  /** aim / stretch / piston: the point to point at, in the model's rest space (it moves with the target). Missing: the
   *  target bone's head. */
  point?: V3;
  /** 0..1; a partial constraint blends with the bone's own pose. */
  influence: number;
  /** follow / copyRot / copyLoc: the offset from the target's frame captured when the constraint was made. */
  offset?: { pos: V3; rot: V3 };
}
/** Translation limits per bone axis, model units. Null / missing: free. */
export interface MoveRange { x: Range; y: Range; z: Range }
export interface Bone {
  name: string;
  head: V3;
  tail: V3;
  /** Index of the parent bone, -1 for a root. */
  parent: number;
  /** Blender's roll: degrees about the bone's own Y after the head → tail turn. 0 is the shortest turn from +Y. */
  roll?: number;
  /** Blender's Connected: the head is glued to the parent's tail, so the bone cannot be translated. */
  connected?: boolean;
  /** Rotation limits per axis (min = max = 0 locks it); null turns freely. */
  limit: { x: Range; y: Range; z: Range } | null;
  /** Translation limits; null / missing turns it free, all-zero locks it (a hinge). */
  move?: MoveRange | null;
  /** A piston rod's travel along the bone (older files): read as `move.y` when `move` is absent. */
  slide?: Range | null;
  /** Applied in order after the parent chain, before children are read. */
  constraints?: Constraint[];
}
/** A bone's pose: rotation in degrees about its own X / Y / Z, translation in model units along its own X / Y / Z
 *  (Blender's local location), and the legacy piston slide along Y. */
export interface PoseBone { rot: V3; slide: number; loc?: V3 }
export const REST: PoseBone = { rot: [0, 0, 0], slide: 0, loc: [0, 0, 0] };

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const D = Math.PI / 180;
const IDENTITY = new THREE.Matrix4();

/** The turn from +Y to a direction, as Blender's roll-0 frame: straight down has no shortest turn, so it flips about Z. */
function alignQuat(d: THREE.Vector3): THREE.Quaternion {
  return d.y < -0.99999
    ? new THREE.Quaternion().setFromAxisAngle(Z, Math.PI)
    : new THREE.Quaternion().setFromUnitVectors(Y, d.clone().normalize());
}
/** The bone's rest frame in the model: at the head, Y toward the tail, rolled about it. */
export function restMatrix(b: Bone): THREE.Matrix4 {
  const d = new THREE.Vector3(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]).normalize();
  const q = alignQuat(d);
  if (b.roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(Y, b.roll * D));
  return new THREE.Matrix4().compose(new THREE.Vector3(...b.head), q, new THREE.Vector3(1, 1, 1));
}
/** The roll about a direction that turns the roll-0 frame's X onto `x`: what `boneFromFrame` recovers from a turn. */
function rollAbout(d: THREE.Vector3, x: THREE.Vector3): number {
  const y = d.clone().normalize(), x0 = new THREE.Vector3(1, 0, 0).applyQuaternion(alignQuat(y));
  const px = x.clone().addScaledVector(y, -x.dot(y)); // the part of x across the bone
  if (px.lengthSq() < 1e-12) return 0;
  px.normalize();
  const angle = Math.atan2(new THREE.Vector3().crossVectors(x0, px).dot(y), x0.dot(px));
  const deg = angle / D;
  return ((deg + 180) % 360 + 360) % 360 - 180;
}
/** The roll that makes the bone's own X run along `x` (its hinge axis), for a bone pointing along `direction`. */
export const rollFor = (direction: V3, x: V3) => rollAbout(new THREE.Vector3(...direction), new THREE.Vector3(...x));
/** A bone's end and roll from a frame: the inverse of restMatrix, for turning a bone in Edit. */
export function boneFromFrame(head: V3, q: THREE.Quaternion, length: number): { tail: V3; roll: number } {
  const y = Y.clone().applyQuaternion(q).normalize();
  const tail: V3 = [head[0] + y.x * length, head[1] + y.y * length, head[2] + y.z * length];
  return { tail, roll: rollAbout(y, new THREE.Vector3(1, 0, 0).applyQuaternion(q)) };
}
export const boneLength = (b: Bone) => Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);

const clampTo = (v: number, [a, b]: Range) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
/** The translation range the bone is held in (null: free). An explicit null `move` is free, even if an old `slide`
 *  range is still on the bone. */
export const moveRange = (b: Bone): MoveRange | null => (b.move !== undefined ? b.move : b.slide ? { x: [0, 0], y: b.slide, z: [0, 0] } : null);
/** The pose held inside the bone's limits: a connected bone cannot translate (its head is its parent's tail). */
export function clampPose(b: Bone, p: PoseBone): PoseBone {
  const rot: V3 = b.limit ? [clampTo(p.rot[0], b.limit.x), clampTo(p.rot[1], b.limit.y), clampTo(p.rot[2], b.limit.z)] : p.rot;
  const m = b.connected ? null : moveRange(b);
  let loc: V3 = p.loc ? [p.loc[0], p.loc[1], p.loc[2]] : [0, 0, 0];
  if (b.connected) loc = [0, 0, 0];
  else if (m) loc = [clampTo(loc[0], m.x), clampTo(loc[1], m.y), clampTo(loc[2], m.z)];
  // an old piston pose still slides; a migrated bone (move from slide) carries it in loc
  const slide = b.slide && b.move === undefined && !b.connected ? clampTo(p.slide, b.slide) : 0;
  return { rot, loc, slide };
}
/** The pose as a matrix in the bone's rest frame. */
export function localMatrix(p: PoseBone): THREE.Matrix4 {
  const l = p.loc ?? [0, 0, 0];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(l[0], l[1] + p.slide, l[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0] * D, p.rot[1] * D, p.rot[2] * D, 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
}
/** The pose a world matrix asks for: `m` is where the bone's frame should be, read back through its parent's pose. */
export function poseFrom(bones: Bone[], posed: THREE.Matrix4[], i: number, m: THREE.Matrix4): PoseBone {
  const b = bones[i], rest = restMatrix(b);
  const base = b.parent >= 0 ? posed[b.parent].clone().multiply(restMatrix(bones[b.parent]).invert()).multiply(rest) : rest;
  const l = base.invert().multiply(m), t = new THREE.Vector3(), q = new THREE.Quaternion();
  l.decompose(t, q, new THREE.Vector3());
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { rot: [e.x / D, e.y / D, e.z / D], slide: 0, loc: [t.x, t.y, t.z] };
}

const decompose = (m: THREE.Matrix4) => {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
};
const compose = (p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3) => new THREE.Matrix4().compose(p, q, s);
/** A matrix part of the way from `a` to `b`, for constraints with influence below 1. */
function blendMatrix(a: THREE.Matrix4, b: THREE.Matrix4, w: number): THREE.Matrix4 {
  if (w >= 1) return b;
  if (w <= 0) return a;
  const A = decompose(a), B = decompose(b);
  return compose(A.p.lerp(B.p, w), A.q.slerp(B.q, w), A.s.lerp(B.s, w));
}
const offsetMatrix = (o: { pos: V3; rot: V3 }) => compose(
  new THREE.Vector3(...o.pos),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rot[0] * D, o.rot[1] * D, o.rot[2] * D, 'XYZ')),
  new THREE.Vector3(1, 1, 1),
);
/** The frame another bone's point sits in, posed: what the target part does to the model's rest space. */
function targetPoint(posed: THREE.Matrix4[], rest: THREE.Matrix4[], c: Constraint): THREE.Vector3 {
  const m = posed[c.target];
  if (c.point) return new THREE.Vector3(...c.point).applyMatrix4(m.clone().multiply(rest[c.target].clone().invert()));
  return new THREE.Vector3().setFromMatrixPosition(m);
}

/** Each bone's frame in the model, posed: the parent's pose carried down the chain, then its constraints. */
export function poseMatrices(bones: Bone[], pose: (PoseBone | undefined)[]): THREE.Matrix4[] {
  const out: (THREE.Matrix4 | undefined)[] = [], rest = bones.map(restMatrix), visiting: boolean[] = [];
  const at = (i: number): THREE.Matrix4 => {
    if (out[i]) return out[i]!;
    const b = bones[i];
    if (!b) return IDENTITY.clone();
    visiting[i] = true;
    let m = (b.parent >= 0 ? at(b.parent).clone().multiply(rest[b.parent].clone().invert()).multiply(rest[i]) : rest[i].clone());
    m.multiply(localMatrix(pose[i] ?? REST));
    for (const c of b.constraints ?? []) {
      if (c.target < 0 || c.target >= bones.length || c.target === i || visiting[c.target] || !(c.influence > 0)) continue;
      const { p: head, q: turn, s: scale } = decompose(m);
      switch (c.kind) {
        case 'follow': {
          if (!c.offset) break;
          m = blendMatrix(m, at(c.target).clone().multiply(offsetMatrix(c.offset)), c.influence);
          break;
        }
        case 'copyRot': {
          const t = decompose(at(c.target));
          const q = c.offset ? t.q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(c.offset.rot[0] * D, c.offset.rot[1] * D, c.offset.rot[2] * D, 'XYZ'))) : t.q;
          m = blendMatrix(m, compose(head, q, scale), c.influence);
          break;
        }
        case 'copyLoc': {
          const t = new THREE.Vector3().setFromMatrixPosition(at(c.target));
          const pos = t.add(new THREE.Vector3(...(c.offset?.pos ?? [0, 0, 0])));
          m = blendMatrix(m, compose(pos, turn, scale), c.influence);
          break;
        }
        case 'aim':
        case 'stretch':
        case 'piston': {
          at(c.target); // the target's frame must be there before its point is read
          const point = targetPoint(out as THREE.Matrix4[], rest, c);
          const dir = point.sub(head);
          const dist = dir.length();
          if (dist < 1e-9) break;
          const aim = new THREE.Quaternion().setFromUnitVectors(Y.clone().applyQuaternion(turn).normalize(), dir.multiplyScalar(1 / dist));
          const q = aim.multiply(turn);
          const s = scale.clone();
          if (c.kind !== 'aim') s.y = scale.y * (dist / Math.max(boneLength(b), 1e-9));
          m = blendMatrix(m, compose(head, q, s), c.influence);
          break;
        }
      }
    }
    visiting[i] = false;
    out[i] = m;
    return m;
  };
  return bones.map((_, i) => at(i));
}
/** What each bone does to the points bound to it: posed frame × rest frame⁻¹. */
export const skinMatrices = (bones: Bone[], posed: THREE.Matrix4[]) => posed.map((m, i) => m.clone().multiply(restMatrix(bones[i]).invert()));

/** The offset a Follow / Copy constraint keeps: the target's rest frame to this bone's (so it can be undone). */
export function constraintOffset(bone: Bone, target: Bone): { pos: V3; rot: V3 } {
  const off = restMatrix(target).invert().multiply(restMatrix(bone));
  const { p, q } = decompose(off);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { pos: [p.x, p.y, p.z], rot: [e.x / D, e.y / D, e.z / D] };
}
/** The point on a bone's segment nearest a world-space point: the default socket an aim or stretch reads. */
export function closestOnBone(b: Bone, p: V3): V3 {
  const a = new THREE.Vector3(...b.head), t = new THREE.Vector3(...b.tail).sub(a), q = new THREE.Vector3(...p).sub(a);
  const len = t.lengthSq();
  const k = len > 1e-12 ? Math.min(1, Math.max(0, q.dot(t) / len)) : 0;
  const at = a.addScaledVector(t, k);
  return [at.x, at.y, at.z];
}

/** Per output triangle, its bone: the binding is kept per soup triangle (it survives a re-unwrap), the output says
 *  which soup triangle each of its own came from. */
export function trianglesBones(source: ArrayLike<number>, bind: Int32Array | undefined): Int32Array {
  const out = new Int32Array(source.length).fill(-1);
  if (bind) for (let t = 0; t < source.length; t++) out[t] = bind[source[t]] ?? -1;
  return out;
}

/** Corners welded by exact position, as the FBX export welds them (`files.weld`): a vertex shared by triangles of two
 *  bones follows both, by how many of its triangles each has, so a joint inside one mesh bends instead of tearing. */
export interface Weights { vi: Int32Array; start: Int32Array; bone: Int32Array; w: Float32Array }
export function vertexWeights(vi: ArrayLike<number>, verts: number, triBone: ArrayLike<number>): Weights {
  const count = Array.from({ length: verts }, () => new Map<number, number>());
  for (let c = 0; c < vi.length; c++) {
    const b = triBone[(c / 3) | 0];
    if (b >= 0) count[vi[c]].set(b, (count[vi[c]].get(b) ?? 0) + 1);
  }
  const start = new Int32Array(verts + 1), bone: number[] = [], w: number[] = [];
  count.forEach((m, v) => {
    let n = 0;
    for (const k of m.values()) n += k;
    for (const [b, k] of m) { bone.push(b); w.push(k / n); }
    start[v + 1] = bone.length;
  });
  return { vi: Int32Array.from(vi), start, bone: Int32Array.from(bone), w: Float32Array.from(w) };
}
const welds = new WeakMap<object, { vi: Int32Array; n: number }>();
/** Corner → vertex, welded by exact position (cached per positions array). */
export function weldCorners(positions: ArrayLike<number> & object): { vi: Int32Array; n: number } {
  let w = welds.get(positions);
  if (!w) {
    const ids = new Map<string, number>(), vi = new Int32Array(positions.length / 3);
    for (let c = 0; c < vi.length; c++) {
      const k = `${positions[c * 3]},${positions[c * 3 + 1]},${positions[c * 3 + 2]}`;
      let id = ids.get(k);
      if (id === undefined) ids.set(k, (id = ids.size));
      vi[c] = id;
    }
    welds.set(positions, (w = { vi, n: ids.size }));
  }
  return w;
}

/** The corners moved by the pose (linear blend of their bones; unbound corners stay). */
export function deform(positions: ArrayLike<number> & object, weights: Weights, skin: THREE.Matrix4[], into: Float32Array = new Float32Array(positions.length)): Float32Array {
  const p = new THREE.Vector3(), q = new THREE.Vector3(), s = new THREE.Vector3();
  for (let c = 0; c < weights.vi.length; c++) {
    const v = weights.vi[c], a = weights.start[v], z = weights.start[v + 1];
    p.set(positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]);
    if (a === z) { into[c * 3] = p.x; into[c * 3 + 1] = p.y; into[c * 3 + 2] = p.z; continue; }
    s.set(0, 0, 0);
    for (let k = a; k < z; k++) s.addScaledVector(q.copy(p).applyMatrix4(skin[weights.bone[k]]), weights.w[k]);
    into[c * 3] = s.x; into[c * 3 + 1] = s.y; into[c * 3 + 2] = s.z;
  }
  return into;
}

/** A name not taken yet: "Bone", "Bone.001", … as Blender numbers them. */
export function freshName(bones: Bone[], base = 'Bone'): string {
  const used = new Set(bones.map((b) => b.name));
  if (!used.has(base)) return base;
  for (let i = 1; ; i++) { const n = `${base}.${String(i).padStart(3, '0')}`; if (!used.has(n)) return n; }
}
/** Is `a` this bone or one of its ancestors (so it can't become this bone's child)? */
export function isAncestor(bones: Bone[], a: number, i: number): boolean {
  for (let j = i; j >= 0; j = bones[j].parent) if (j === a) return true;
  return false;
}
/** Is `i` this bone or one of its descendants (so a constraint on it would feed back)? */
export function isDescendant(bones: Bone[], a: number, i: number): boolean {
  for (let j = a; j >= 0; j = bones[j].parent) if (j === i) return true;
  return false;
}
/** The bones without bone `i`: its children go to its parent, every index past it moves down one, constraints that
 *  read it move to its parent (and are dropped if that would make a bone read itself). */
export function removeBone(bones: Bone[], i: number): Bone[] {
  const up = bones[i].parent, fix = (p: number) => { const q = p === i ? up : p; return q > i ? q - 1 : q; };
  const out: Bone[] = [];
  bones.forEach((b, j) => {
    if (j === i) return;
    out.push({
      ...b,
      parent: fix(b.parent),
      ...(b.constraints ? { constraints: b.constraints.map((c) => ({ ...c, target: fix(c.target) })).filter((c) => c.target >= 0) } : {}),
    });
  });
  return out.map((b, j) => (b.constraints ? { ...b, constraints: b.constraints.filter((c) => c.target !== j) } : b));
}

/** Old files carry a piston `slide` range; it is the bone's Y translation limit now. */
export function migrateBones(bones: Bone[]): Bone[] {
  return bones.map((b) => (b.move === undefined && b.slide ? { ...b, move: { x: [0, 0], y: b.slide, z: [0, 0] } } : b));
}

/** A bone for a part, as an artist would lay one: along the part's longest direction (the principal axis of its
 *  corners), through its middle, end to end; the head at the end nearer `centre` (the model's middle), where a part
 *  usually hinges on the rest of the model. */
export function partAxis(positions: ArrayLike<number>, centre: V3): { head: V3; tail: V3 } {
  const n = positions.length / 3, m = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m[k] += positions[i * 3 + k] / n;
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d = [positions[i * 3] - m[0], positions[i * 3 + 1] - m[1], positions[i * 3 + 2] - m[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) c[a * 3 + b] += d[a] * d[b];
  }
  // power iteration from the widest axis: the covariance's biggest eigenvector
  const w = [c[0], c[4], c[8]];
  let v = [0, 0, 0];
  v[w.indexOf(Math.max(...w))] = 1;
  for (let it = 0; it < 50; it++) {
    const u = [0, 1, 2].map((a) => c[a * 3] * v[0] + c[a * 3 + 1] * v[1] + c[a * 3 + 2] * v[2]), l = Math.hypot(...u);
    if (!l) break;
    v = u.map((x) => x / l);
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = (positions[i * 3] - m[0]) * v[0] + (positions[i * 3 + 1] - m[1]) * v[1] + (positions[i * 3 + 2] - m[2]) * v[2];
    lo = Math.min(lo, t); hi = Math.max(hi, t);
  }
  const at = (t: number): V3 => [m[0] + v[0] * t, m[1] + v[1] * t, m[2] + v[2] * t];
  const a = at(lo), b = at(hi), d = (p: V3) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]);
  return d(a) <= d(b) ? { head: a, tail: b } : { head: b, tail: a };
}
