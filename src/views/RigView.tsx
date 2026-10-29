// Geppetto in the 3D view: the bones (Blender's octahedra, drawn over the model, each in the colour of the faces it
// moves), the Bone tool's pending joint, and direct handles. Drag a bone to move it, its head to join it, its tail to
// aim it; in Pose the body translates and the tail turns within the limits. The gizmo (G / R) is there for axis-precise
// work, not needed for the common ones. Constraints draw a dashed line to what they follow or aim at.
import { Line, TransformControls } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { islandColor } from '../colors';
import { boneLength, poseMatrices, restMatrix, type Bone, type Constraint, type PoseBone, type V3 } from '../rig';
import {
  aimPoseAt, cancelRigPick, chainFrom, endChain, moveJoint, modelDiagonal, pickConstraintBone, pickConstraintTarget, pickRigPart, poseTo, rigMenu, rigPoint, rotateBone, selectBone,
  setPose, translateBone, translatePose, useApp, view3d,
} from '../store';
import { SEL } from './Viewport3D';

/** Blender's octahedral bone, 1 long along +Y: the waist a tenth of the way up (slimmer than Blender's: drawn over the model). */
const OCTA = (() => {
  const w = 0.05, h = 0.1, v = [[0, 0, 0], [w, h, 0], [0, h, -w], [-w, h, 0], [0, h, w], [0, 1, 0]];
  const f = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 2, 1, 5, 3, 2, 5, 4, 3, 5, 1, 4];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(f.flatMap((i) => v[i]), 3));
  g.computeVertexNormals();
  return g;
})();
const OCTA_EDGES = new THREE.EdgesGeometry(OCTA);
const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
export const boneColor = (i: number) => new THREE.Color(...islandColor(i + 3));
/** A bone press stops R3F's pointerdown; the synthesized click/pointer-miss that follows must not reselect the part. */
export const rigClickLock = { until: 0 };
export const rigConsumesClick = () => performance.now() < rigClickLock.until;

/** Where a click on the model puts a joint: halfway through the surface under it (the ray's way in and its next way
 *  out of the same part), so a bone sits inside the arm, not on its skin. */
function inside(e: ThreeEvent<MouseEvent>): V3 {
  const out = e.intersections.find((h) => h.object === e.object && h.distance > e.distance + 1e-6);
  const p = out ? e.point.clone().add(out.point).multiplyScalar(0.5) : e.point;
  return [p.x, p.y, p.z];
}

/** A click on the model in Geppetto: Geppetto works on parts and bones, never on faces, so every click is the rig's. */
export function rigMeshClick(part: number, e: ThreeEvent<MouseEvent>): boolean {
  const s = useApp.getState(), t = e.faceIndex;
  if (rigConsumesClick()) { e.stopPropagation(); return true; }
  if (e.delta > 4 || e.button !== 0 || t == null) return false;
  e.stopPropagation();
  if (s.rigPick) pickConstraintTarget(part, t);
  else if (s.rigMode === 'edit' && s.rigTool === 'bone') rigPoint(inside(e));
  else pickRigPart(part, t); // Select (and Pose): the part, and the bone that moves it
  return true;
}

const locked = (r: [number, number]) => r[0] === r[1];
const allLocked = (r: { x: [number, number]; y: [number, number]; z: [number, number] } | null | undefined) => !!r && locked(r.x) && locked(r.y) && locked(r.z);
const full = (b: Bone, kind: Constraint['kind']) => (b.constraints ?? []).some((c) => c.kind === kind && c.influence >= 0.999);
/** The one rotation axis a hinge turns about; null for a free/ball bone or one with every axis locked. */
function hingeOf(b: Bone): 0 | 1 | 2 | null {
  if (!b.limit) return null;
  const axes = (['x', 'y', 'z'] as const).filter((k) => !locked(b.limit![k])).map((k) => (k === 'x' ? 0 : k === 'y' ? 1 : 2) as 0 | 1 | 2);
  return axes.length === 1 ? axes[0] : null;
}
/** The target's point in the model, posed: the socket a piston follows. */
function targetAt(c: Constraint, frames: THREE.Matrix4[], rests: THREE.Matrix4[]): THREE.Vector3 {
  const t = frames[c.target];
  if (!t) return new THREE.Vector3();
  if (!c.point) return new THREE.Vector3().setFromMatrixPosition(t);
  return new THREE.Vector3(...c.point).applyMatrix4(t.clone().multiply(rests[c.target].clone().invert()));
}
/** The pointer ray's hit on a plane through `through`, or null when it runs parallel to it. */
function pointerOnPlane(clientX: number, clientY: number, camera: THREE.Camera, canvas: HTMLCanvasElement, through: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 | null {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.clone().normalize(), through);
  return ray.ray.intersectPlane(plane, new THREE.Vector3());
}
/** The angle of a point around a hinge axis, on the plane through `head`. */
function angleAround(p: THREE.Vector3, head: THREE.Vector3, axis: THREE.Vector3): number {
  const v = p.clone().sub(head);
  const ref = Math.abs(axis.dot(UP)) > 0.9 ? X : UP;
  const u = new THREE.Vector3().crossVectors(axis, ref).normalize(), w = new THREE.Vector3().crossVectors(axis, u).normalize();
  return Math.atan2(v.dot(w), v.dot(u));
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The dashed line a constraint draws: what a bone follows, where it aims, what stretches it. */
function ConstraintLinks({ bones, frames, rests }: { bones: Bone[]; frames: THREE.Matrix4[]; rests: THREE.Matrix4[] }) {
  const lines = useMemo(() => {
    const out: { from: THREE.Vector3; to: THREE.Vector3 }[] = [];
    bones.forEach((b, i) => {
      const from = new THREE.Vector3().setFromMatrixPosition(frames[i]);
      for (const c of b.constraints ?? []) {
        if (!frames[c.target]) continue;
        out.push({ from, to: targetAt(c, frames, rests) });
      }
    });
    return out;
  }, [bones, frames, rests]);
  if (!lines.length) return null;
  return (
    <>
      {lines.map((l, i) => <Line key={i} points={[l.from, l.to]} color={SEL} lineWidth={1} dashed dashSize={modelDiagonal() * 0.012} gapSize={modelDiagonal() * 0.01} depthTest={false} transparent opacity={0.7} raycast={() => null} />)}
      {lines.map((l, i) => (
        <mesh key={`p${i}`} position={l.to} renderOrder={12} raycast={() => null}>
          <sphereGeometry args={[modelDiagonal() * 0.004, 10, 8]} />
          <meshBasicMaterial color={SEL} depthTest={false} transparent opacity={0.9} />
        </mesh>
      ))}
    </>
  );
}

type DragPart = 'head' | 'tail' | 'body';
/** A part drag starts the same direct manipulation as its bone: set by the rig view, used by the model's pointerdown. */
export const rigStart: { fn: ((i: number, part: DragPart, x: number, y: number) => void) | null } = { fn: null };
interface Drag {
  i: number;
  part: DragPart;
  pose: boolean;
  hinge: 0 | 1 | 2 | null;
  axis: THREE.Vector3;
  head: THREE.Vector3;
  startTail: THREE.Vector3;
  pivot: THREE.Vector3;
  startAngle: number;
  startPose: PoseBone;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

export function RigBones() {
  const rig = useApp((s) => s.rig), sel = useApp((s) => s.rigSel), mode = useApp((s) => s.rigMode), pose = useApp((s) => s.pose);
  const chain = useApp((s) => s.rigChain), end = useApp((s) => s.rigEnd), tool = useApp((s) => s.rigTool), result = useApp((s) => s.result);
  const gizmo = useApp((s) => s.rigGizmo), gizmoOn = useApp((s) => s.rigGizmoOn), rigPick = useApp((s) => s.rigPick);
  const posing = mode === 'pose';
  const frames = useMemo(() => (posing ? poseMatrices(rig.bones, pose) : rig.bones.map(restMatrix)), [posing, rig.bones, pose]);
  const rests = useMemo(() => rig.bones.map(restMatrix), [rig.bones]);
  const span = useMemo(() => modelDiagonal(), [result]);
  const { camera, gl, controls } = useThree() as unknown as { camera: THREE.Camera; gl: THREE.WebGLRenderer; controls: { enabled: boolean } | null };
  // the gizmo's handle: one object for the life of the view (the gizmo attaches to it)
  const handle = useMemo(() => new THREE.Object3D(), []);
  const b = rig.bones[sel];
  const moveEnd = !posing && b?.connected && end === 'body' ? 'tail' : end;
  const last = useRef(new THREE.Vector3());
  const dragged = useRef(false);
  const drag = useRef<Drag | null>(null);
  const startRef = useRef<(i: number, part: DragPart, x: number, y: number) => void>(() => {});
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(-1);
  const hoverRef = useRef(-1);

  const setCursor = (c: string) => { if (gl.domElement.style.cursor !== c) gl.domElement.style.cursor = c; };

  /** Start a direct drag from a screen point: a joint moves, a bone body moves, a tail aims. */
  const startDrag = (i: number, part: DragPart, clientX: number, clientY: number) => {
    const s = useApp.getState(), bone = s.rig.bones[i];
    if (!bone) return;
    if (s.rigPick) { pickConstraintBone(i); return; }
    if (!posing && s.rigTool === 'bone' && part === 'body') { chainFrom(i); return; }
    selectBone(i, part);
    const poseMode = s.rigMode === 'pose';
    if (poseMode) {
      if ((part === 'body' || part === 'head') && (bone.connected || allLocked(bone.move) || full(bone, 'follow') || full(bone, 'copyLoc'))) return;
      const rotLocked = allLocked(bone.limit);
      if (part === 'tail' && (rotLocked || full(bone, 'follow') || full(bone, 'copyRot') || full(bone, 'aim') || full(bone, 'stretch') || full(bone, 'piston'))) return;
    } else if (part === 'body' && bone.connected) return; // its head is its parent's tail: drag the ends
    const framesNow = poseMode ? poseMatrices(s.rig.bones, s.pose) : s.rig.bones.map(restMatrix);
    const frame = framesNow[i], head = new THREE.Vector3().setFromMatrixPosition(frame), tail = UP.clone().applyMatrix4(frame);
    const hinge = part === 'tail' ? hingeOf(bone) : null;
    const axis = hinge === null ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3().setFromMatrixColumn(frame, hinge).normalize();
    let startAngle = 0;
    if (hinge !== null) {
      const p = pointerOnPlane(clientX, clientY, camera, gl.domElement, head, axis);
      if (!p) return;
      startAngle = angleAround(p, head, axis);
    }
    drag.current = {
      i, part, pose: poseMode, hinge, axis, head,
      startTail: tail,
      pivot: part === 'body' ? head.clone().add(tail).multiplyScalar(0.5) : head,
      startAngle,
      startPose: s.pose[i] ?? { rot: [0, 0, 0], slide: 0, loc: [0, 0, 0] },
      startX: clientX, startY: clientY, lastX: clientX, lastY: clientY, moved: false,
    };
    if (controls) controls.enabled = false;
    setCursor('grabbing');
    setDragging(true);
  };
  startRef.current = startDrag;
  rigStart.fn = startDrag;
  useEffect(() => () => { rigStart.fn = null; }, []);

  // A capture-phase hit test on the canvas: bones are drawn inside the mesh, and a plain R3F click would hit the model
  // first. Projecting the joints and bone segments into screen space makes them clickable wherever they are.
  useEffect(() => {
    const canvas = gl.domElement;
    const hit = (x: number, y: number): { i: number; part: DragPart } | null => {
      const s = useApp.getState();
      if (s.workspace !== 'rig' || s.rigGizmoOn) return null;
      const framesNow = s.rigMode === 'pose' ? poseMatrices(s.rig.bones, s.pose) : s.rig.bones.map(restMatrix);
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const project = (v: THREE.Vector3): [number, number] | null => {
        const p = v.clone().project(camera);
        if (p.z > 1) return null;
        return [(p.x * 0.5 + 0.5) * r.width + r.left, (-p.y * 0.5 + 0.5) * r.height + r.top];
      };
      const d2 = (a: number, b: number, c: number, d: number) => (a - c) ** 2 + (b - d) ** 2;
      let best: { i: number; part: DragPart } | null = null, bestD = Infinity, bestRank = 3;
      s.rig.bones.forEach((_, i) => {
        const frame = framesNow[i];
        if (!frame) return;
        const h = new THREE.Vector3().setFromMatrixPosition(frame), t = UP.clone().applyMatrix4(frame);
        const ph = project(h), pt = project(t);
        for (const [part, p] of [['head', ph], ['tail', pt]] as const) {
          if (!p) continue;
          const d = d2(x, y, p[0], p[1]);
          if (d < 13 ** 2 && (1 < bestRank || (1 === bestRank && d < bestD))) { bestRank = 1; bestD = d; best = { i, part }; }
        }
        if (!ph || !pt) return;
        const vx = pt[0] - ph[0], vy = pt[1] - ph[1], ll = vx * vx + vy * vy;
        if (ll < 16) return;
        const k = Math.max(0, Math.min(1, ((x - ph[0]) * vx + (y - ph[1]) * vy) / ll));
        const d = d2(x, y, ph[0] + vx * k, ph[1] + vy * k);
        if (d < 8 ** 2 && bestRank > 2) { bestRank = 2; bestD = d; best = { i, part: 'body' }; }
      });
      return best;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      const s = useApp.getState();
      if (s.workspace !== 'rig' || s.rigGizmoOn || drag.current) return;
      const h = hit(e.clientX, e.clientY);
      if (!h) return;
      rigClickLock.until = performance.now() + 250;
      e.stopImmediatePropagation();
      e.preventDefault();
      startRef.current(h.i, h.part, e.clientX, e.clientY);
    };
    const over = (e: PointerEvent) => {
      const s = useApp.getState();
      if (s.workspace !== 'rig' || s.rigGizmoOn || drag.current || e.buttons) return;
      const h = hit(e.clientX, e.clientY);
      const next = h?.i ?? -1;
      if (next !== hoverRef.current) { hoverRef.current = next; setHover(next); }
      setCursor(h ? (s.rigPick ? 'crosshair' : 'grab') : '');
    };
    const ctx = (e: MouseEvent) => {
      const s = useApp.getState();
      if (s.workspace !== 'rig' || s.rigGizmoOn) return;
      if (s.rigPick) { e.preventDefault(); e.stopImmediatePropagation(); cancelRigPick(); return; }
      if (s.rigChain) { e.preventDefault(); e.stopImmediatePropagation(); endChain(); return; }
      const h = hit(e.clientX, e.clientY);
      if (!h) return;
      e.preventDefault(); e.stopImmediatePropagation();
      selectBone(h.i, h.part);
      rigMenu(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointerdown', down, true);
    canvas.addEventListener('pointermove', over, true);
    canvas.addEventListener('contextmenu', ctx, true);
    const leave = () => { if (!drag.current) { hoverRef.current = -1; setHover(-1); setCursor(''); } };
    canvas.addEventListener('pointerleave', leave);
    return () => {
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('pointermove', over, true);
      canvas.removeEventListener('contextmenu', ctx, true);
      canvas.removeEventListener('pointerleave', leave);
    };
  }, [camera, gl, controls]); // eslint-disable-line react-hooks/exhaustive-deps

  // the drag: pixels become a camera-plane delta for a body or a joint, an angle round the hinge, or a tip aim
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 2) return;
      const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;
      d.lastX = e.clientX; d.lastY = e.clientY;
      if (d.part !== 'tail') {
        const delta = view3d.worldDelta?.(dx, dy, d.pivot.toArray() as [number, number, number]) ?? [0, 0, 0];
        if (d.pose) translatePose(d.i, delta);
        else if (d.part === 'body') translateBone(d.i, delta, !d.moved);
        else {
          const bone = useApp.getState().rig.bones[d.i];
          if (bone) moveJoint(d.i, 'head', [bone.head[0] + delta[0], bone.head[1] + delta[1], bone.head[2] + delta[2]], !d.moved);
        }
        d.moved = true;
        return;
      }
      const s = useApp.getState(), bone = s.rig.bones[d.i];
      if (!bone) return;
      if (d.hinge !== null) {
        const p = pointerOnPlane(e.clientX, e.clientY, camera, gl.domElement, d.head, d.axis);
        if (!p) return;
        const da = wrap(angleAround(p, d.head, d.axis) - d.startAngle);
        if (d.pose) {
          const rot = [...d.startPose.rot] as V3;
          rot[d.hinge] = d.startPose.rot[d.hinge] + (da * 180) / Math.PI;
          setPose(d.i, { rot, slide: d.startPose.slide, loc: d.startPose.loc });
        } else {
          const tail = d.head.clone().add(d.startTail.clone().sub(d.head).applyAxisAngle(d.axis, da));
          moveJoint(d.i, 'tail', [tail.x, tail.y, tail.z], !d.moved);
        }
      } else if (d.pose) {
        const n = camera.getWorldDirection(new THREE.Vector3());
        const p = pointerOnPlane(e.clientX, e.clientY, camera, gl.domElement, d.head, n);
        if (p) aimPoseAt(d.i, [p.x, p.y, p.z]);
      } else {
        const n = camera.getWorldDirection(new THREE.Vector3());
        const p = pointerOnPlane(e.clientX, e.clientY, camera, gl.domElement, d.startTail, n);
        if (p) moveJoint(d.i, 'tail', [p.x, p.y, p.z], !d.moved);
      }
      d.moved = true;
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      if (controls) controls.enabled = true;
      setCursor('');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (controls) controls.enabled = true;
    };
  }, [camera, gl, controls]);

  useEffect(() => {
    if (!b) return;
    if (posing) {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      frames[sel].decompose(p, q, s);
      handle.position.copy(p);
      handle.quaternion.copy(q);
      handle.scale.set(1, 1, 1);
    } else if (gizmo === 'move' && moveEnd === 'body') {
      handle.position.set((b.head[0] + b.tail[0]) / 2, (b.head[1] + b.tail[1]) / 2, (b.head[2] + b.tail[2]) / 2);
      handle.quaternion.identity();
    } else if (gizmo === 'move' && moveEnd === 'tail') {
      handle.position.set(...b.tail);
      handle.quaternion.identity();
    } else {
      handle.position.set(...b.head);
      if (gizmo === 'rotate') handle.quaternion.setFromRotationMatrix(restMatrix(b));
      else handle.quaternion.identity();
    }
    handle.scale.set(1, 1, 1);
    handle.updateMatrix();
  }, [b, sel, end, posing, frames, handle, gizmo, moveEnd]);

  const turnAxes = posing ? {
    x: !(b?.limit && locked(b.limit.x)) && !(b && (full(b, 'follow') || full(b, 'copyRot') || full(b, 'aim') || full(b, 'stretch') || full(b, 'piston'))),
    // aim and stretch drive X / Z but leave the twist about the bone's own Y to the artist
    y: !!b && !(b.limit && locked(b.limit.y)) && !(full(b, 'follow') || full(b, 'copyRot')),
    z: !(b?.limit && locked(b.limit.z)) && !(b && (full(b, 'follow') || full(b, 'copyRot') || full(b, 'aim') || full(b, 'stretch') || full(b, 'piston'))),
  } : { x: true, y: true, z: true };
  const moveAxes = posing ? {
    x: !!b && !b.connected && !(b.move && locked(b.move.x)) && !(full(b, 'follow') || full(b, 'copyLoc')),
    y: !!b && !b.connected && !(b.move && locked(b.move.y)) && !(full(b, 'follow') || full(b, 'copyLoc')),
    z: !!b && !b.connected && !(b.move && locked(b.move.z)) && !(full(b, 'follow') || full(b, 'copyLoc')),
  } : { x: true, y: true, z: true };
  const any = gizmo === 'rotate' ? turnAxes.x || turnAxes.y || turnAxes.z : moveAxes.x || moveAxes.y || moveAxes.z;
  const showGizmo = !!b && gizmoOn && !dragging && any && (posing || tool !== 'bone');
  const hinge = b ? hingeOf(b) : null;

  return (
    <>
      <primitive object={handle} />
      {rig.bones.map((bone, i) => {
        const len = Math.max(boneLength(bone), span * 0.025), m = frames[i].clone().scale(new THREE.Vector3(len * 1.5, len, len * 1.5)), on = i === sel, hot = i === hover;
        const at = new THREE.Vector3().setFromMatrixPosition(frames[i]);
        const tip = UP.clone().applyMatrix4(frames[i]);
        return (
          <group key={i}>
            <group matrixAutoUpdate={false} matrix={m}>
              <mesh geometry={OCTA} renderOrder={10}
                onPointerDown={(e) => { if (!gizmoOn) { e.stopPropagation(); startRef.current(i, 'body', e.nativeEvent.clientX, e.nativeEvent.clientY); } }}
                onClick={(e) => { if (gizmoOn) { e.stopPropagation(); selectBone(i, 'body'); } }}
                onContextMenu={(e) => { e.stopPropagation(); selectBone(i, 'body'); rigMenu(); }}>
                <meshBasicMaterial color={on ? SEL : boneColor(i)} transparent opacity={on ? 0.82 : hot ? 0.72 : 0.5} depthTest={false} depthWrite={false} />
              </mesh>
              <lineSegments geometry={OCTA_EDGES} renderOrder={11} raycast={() => null}>
                <lineBasicMaterial color={on ? '#ffffff' : '#000000'} opacity={on ? 1 : 0.5} depthTest={false} transparent />
              </lineSegments>
            </group>
            {(['head', 'tail'] as const).map((part) => (
              <mesh key={part} position={part === 'head' ? at : tip} renderOrder={12}
                onPointerDown={(e) => { if (!gizmoOn) { e.stopPropagation(); startRef.current(i, part, e.nativeEvent.clientX, e.nativeEvent.clientY); } }}
                onClick={(e) => { if (gizmoOn) { e.stopPropagation(); selectBone(i, part); } }}
                onContextMenu={(e) => { e.stopPropagation(); selectBone(i, part); rigMenu(); }}>
                <sphereGeometry args={[span * (on ? 0.0062 : hot ? 0.005 : 0.004), 10, 8]} />
                <meshBasicMaterial color={on ? '#ffffff' : boneColor(i)} transparent opacity={on ? 1 : hot ? 0.9 : 0.65} depthTest={false} />
              </mesh>
            ))}
          </group>
        );
      })}
      {chain && (
        <mesh position={chain.at} renderOrder={12} raycast={() => null}>
          <sphereGeometry args={[span * 0.006, 12, 8]} />
          <meshBasicMaterial color="#ffd23f" depthTest={false} transparent />
        </mesh>
      )}
      {b && (() => {
        const head = new THREE.Vector3().setFromMatrixPosition(frames[sel]);
        const tail = UP.clone().applyMatrix4(frames[sel]);
        return <Line points={[head, tail]} color="#ffffff" lineWidth={2} depthTest={false} transparent opacity={0.9} raycast={() => null} />;
      })()}
      {/* the circle a hinge's tail travels on: drag the tip along it */}
      {b && hinge !== null && (() => {
        const frame = frames[sel], head = new THREE.Vector3().setFromMatrixPosition(frame);
        const axis = new THREE.Vector3().setFromMatrixColumn(frame, hinge).normalize();
        const ref = Math.abs(axis.dot(UP)) > 0.9 ? X : UP;
        const u = new THREE.Vector3().crossVectors(axis, ref).normalize(), w = new THREE.Vector3().crossVectors(axis, u).normalize();
        const r = Math.max(boneLength(b), span * 0.01);
        const pts = Array.from({ length: 49 }, (_, k) => {
          const a = (k / 48) * Math.PI * 2;
          return head.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(w, Math.sin(a) * r);
        });
        return <Line points={pts} color={SEL} lineWidth={1} dashed dashSize={span * 0.01} gapSize={span * 0.008} depthTest={false} transparent opacity={0.28} raycast={() => null} />;
      })()}
      <ConstraintLinks bones={rig.bones} frames={frames} rests={rests} />
      {showGizmo && (
        <TransformControls object={handle} size={0.8} mode={gizmo === 'move' ? 'translate' : 'rotate'} space={posing ? 'local' : 'world'}
          showX={gizmo === 'rotate' ? turnAxes.x : moveAxes.x} showY={gizmo === 'rotate' ? turnAxes.y : moveAxes.y} showZ={gizmo === 'rotate' ? turnAxes.z : moveAxes.z}
          onMouseDown={() => { dragged.current = false; last.current.copy(handle.position); }}
          onObjectChange={() => {
            handle.updateMatrix();
            if (posing) poseTo(sel, handle.matrix);
            else if (gizmo === 'rotate') rotateBone(sel, handle.matrix, !dragged.current);
            else if (moveEnd === 'body') {
              const d = handle.position.clone().sub(last.current);
              translateBone(sel, [d.x, d.y, d.z], !dragged.current);
              last.current.copy(handle.position);
            } else moveJoint(sel, moveEnd, [handle.position.x, handle.position.y, handle.position.z], !dragged.current);
            dragged.current = true;
          }} />
      )}
    </>
  );
}
