// node src/rig.check.ts [out.fbx]: Geppetto's rig math — bone frames point Y along the bone and roll about it, the
// limits and connection hold, a bone translates in Pose, constraints aim / stretch / follow, auto-rig parents parts by
// contact and reads their motion, a shared vertex follows both bones, deleting a bone re-parents its child.
// With a path it also writes a two-bone arm as FBX (for `tools/rig-blender-check.py`).
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { autoRig, looseUnits } from './autorig.ts';
import { boneFromFrame, boneLength, clampPose, constraintOffset, deform, moveRange, partAxis, poseFrom, poseMatrices, removeBone, restMatrix, rollFor, skinMatrices, vertexWeights, type Bone, type V3 } from './rig.ts';
import { toFbx } from './files.ts';

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => assert.ok(Array.from(a).every((x, i) => Math.abs(x - b[i]) < eps), `${Array.from(a)} ≠ ${Array.from(b)}`);
// an arm along +X: upper 0→1, forearm 1→2 (hinge ±90 on X, which for a bone along +X is the world's… its own X)
const bones: Bone[] = [
  { name: 'Upper', head: [0, 0, 0], tail: [1, 0, 0], parent: -1, limit: null, slide: null },
  { name: 'Fore', head: [1, 0, 0], tail: [2, 0, 0], parent: 0, limit: { x: [0, 0], y: [0, 0], z: [-90, 90] }, slide: null },
];
// Y runs along the bone
near(new THREE.Vector3(0, 1, 0).transformDirection(restMatrix(bones[1])).toArray(), [1, 0, 0]);
// roll: the frame's own X can be aimed at a hinge pin, and turning the frame back recovers tail and roll
const rolled: Bone = { ...bones[0], tail: [2, 0, 0], roll: rollFor([1, 0, 0], [0, 0, 1]) };
const rolledFrame = restMatrix(rolled);
near(new THREE.Vector3(1, 0, 0).transformDirection(rolledFrame).toArray(), [0, 0, 1]);
const back = boneFromFrame(rolled.head, new THREE.Quaternion().setFromRotationMatrix(rolledFrame), boneLength(rolled));
near(back.tail, [2, 0, 0]);
assert.ok(Math.abs(back.roll - (rolled.roll ?? 0)) < 1e-4, `${back.roll} ≠ ${rolled.roll}`);
// the limit holds: 120° asked, 90° kept; locked axes stay 0; translation is carried
assert.deepEqual(clampPose(bones[1], { rot: [30, 10, 120], slide: 5, loc: [1, 2, 3] }), { rot: [0, 0, 90], loc: [1, 2, 3], slide: 0 });
// a connected bone cannot translate; a limited one stops at its translation range
assert.deepEqual(clampPose({ ...bones[1], connected: true }, { rot: [0, 0, 0], slide: 0, loc: [1, 2, 3] }).loc, [0, 0, 0]);
assert.deepEqual(clampPose({ ...bones[0], move: { x: [0, 0], y: [-0.5, 0.25], z: [0, 0] } }, { rot: [0, 0, 0], slide: 0, loc: [1, 3, 0] }).loc, [0, 0.25, 0]);
assert.equal(moveRange({ ...bones[0], move: null, slide: [-1, 1] }), null, 'an explicit free move ignores an old slide range');
near(moveRange({ ...bones[0], slide: [-1, 1] })!.y, [-1, 1]);
// forearm turned 90° about its Z: its tail swings from (2,0,0) to 90° round the elbow, still 1 from it
const pose = [undefined, clampPose(bones[1], { rot: [0, 0, 90], slide: 0 })];
const posed = poseMatrices(bones, pose), tip = new THREE.Vector3(0, 1, 0).applyMatrix4(posed[1]);
near([tip.distanceTo(new THREE.Vector3(1, 0, 0))], [1]);
assert.ok(tip.distanceTo(new THREE.Vector3(2, 0, 0)) > 1.4, 'the forearm turned');
// the gizmo's matrix reads back to the pose that made it
near(poseFrom(bones, posed, 1, posed[1]).rot, [0, 0, 90], 1e-4);
// a parent's turn carries the child: upper turned, forearm's frame follows
const p2 = poseMatrices(bones, [{ rot: [0, 0, 90], slide: 0 }, undefined]);
near(new THREE.Vector3().setFromMatrixPosition(p2[1]).toArray(), new THREE.Vector3(1, 0, 0).applyMatrix4(p2[0].clone().multiply(restMatrix(bones[0]).invert())).toArray());
// Pose translation moves the bone's frame along its own axes (and its child with it): local +Y is world +X here
const movedArm = poseMatrices(bones, [{ rot: [0, 0, 0], slide: 0, loc: [0, 0.5, 0] }, undefined]);
near(new THREE.Vector3().setFromMatrixPosition(movedArm[1]).toArray(), [1.5, 0, 0]);
// two triangles sharing the elbow vertex, one per bone: the elbow follows both, half each; the hand follows the forearm
const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0.1, 0, /**/ 1, 0, 0, 2, 0, 0, 2, 0.1, 0]);
const vi = [0, 1, 2, 1, 3, 4], w = vertexWeights(vi, 5, Int32Array.from([0, 1]));
near(w.w.subarray(w.start[1], w.start[2]), [0.5, 0.5]);
const moved = deform(pos, w, skinMatrices(bones, posed));
near(moved.subarray(12, 15), tip.toArray(), 1e-5); // corner 4 is the forearm's tail
near(moved.subarray(0, 3), [0, 0, 0]);
// a piston: slide only, inside its travel
assert.deepEqual(clampPose({ ...bones[0], slide: [-0.5, 0.25] }, { rot: [0, 0, 0], slide: 3 }).slide, 0.25);
// deleting the upper arm makes the forearm a root
assert.deepEqual(removeBone(bones, 0).map((b) => b.parent), [-1]);
// deleting a bone a constraint reads retargets it to that bone's parent, or drops it if it would read itself
const constrained: Bone[] = [
  { ...bones[0], name: 'Root' },
  { ...bones[1], name: 'Mid', parent: 0, constraints: [{ kind: 'copyRot', target: 2, influence: 1 }] },
  { name: 'Tip', head: [2, 0, 0], tail: [3, 0, 0], parent: 1, limit: null, slide: null },
];
assert.equal(removeBone(constrained, 2)[1].constraints?.length, 0, 'a constraint on the removed bone drops rather than reading its own bone');
const withLeaf: Bone[] = [...constrained, { name: 'Leaf', head: [3, 0, 0], tail: [4, 0, 0], parent: 2, limit: null, slide: null, constraints: [{ kind: 'copyRot', target: 2, influence: 1 }] }];
const cut = removeBone(withLeaf, 2);
assert.equal(cut[2].name, 'Leaf');
assert.equal(cut[2].constraints?.[0].target, 1);
// constraints: a target 2 away translated by (0, 2, 0) drags a follower with it
const target: Bone = { name: 'Target', head: [0, 0, 0], tail: [0, 1, 0], parent: -1, limit: null, slide: null };
const followerRest: Bone = { name: 'Follower', head: [2, 0, 0], tail: [2, 1, 0], parent: -1, limit: null, slide: null };
const follower: Bone = { ...followerRest, constraints: [{ kind: 'follow', target: 0, influence: 1, offset: constraintOffset(followerRest, target) }] };
const followFrames = poseMatrices([target, follower], [{ rot: [0, 0, 0], slide: 0, loc: [0, 2, 0] }]);
near(new THREE.Vector3().setFromMatrixPosition(followFrames[1]).toArray(), [2, 2, 0]);
// aim: the bone's Y points at a point held on the target; stretch: its tail reaches it
const aim: Bone = { ...followerRest, constraints: [{ kind: 'aim', target: 0, influence: 1, point: [5, 0, 0] }] };
near(new THREE.Vector3(0, 1, 0).transformDirection(poseMatrices([target, aim], [])[1]).toArray(), [1, 0, 0]);
const stretch: Bone = { ...followerRest, constraints: [{ kind: 'stretch', target: 0, influence: 1, point: [5, 0, 0] }] };
const stretched = poseMatrices([target, stretch], [])[1];
near(new THREE.Vector3(0, 1, 0).applyMatrix4(stretched).toArray(), [5, 0, 0], 1e-4);
// copy location: the bone's head lands on the target head + offset
const copy: Bone = { ...followerRest, constraints: [{ kind: 'copyLoc', target: 0, influence: 1, offset: { pos: [2, 1, 0], rot: [0, 0, 0] } }] };
near(new THREE.Vector3().setFromMatrixPosition(poseMatrices([target, copy], [{ rot: [0, 0, 0], slide: 0, loc: [0, 3, 0] }])[1]).toArray(), [2, 4, 0]);
// Add bone: along a part's longest direction, end to end, the head at the end toward the model's middle
const bar = new Float32Array([2, 0, 0, 6, 0.5, 0, 6, -0.5, 0, 2, 0.5, 0.2, 2, -0.5, -0.2, 4, 0, 0.1]);
const ax = partAxis(bar, [0, 0, 0]);
assert.ok(ax.head[0] < 2.2 && ax.tail[0] > 5.8 && Math.abs(ax.head[1]) < 0.3, `${ax.head} → ${ax.tail}`);
const backAxis = partAxis(bar, [9, 0, 0]);
assert.ok(backAxis.head[0] > 5.8, 'facing the other way when the model lies the other side');

// ---- auto-rig: four moving parts on a frame, a shell that is fixed to it ----
const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
  const X = x + sx / 2, x0 = x - sx / 2, Y = y + sy / 2, y0 = y - sy / 2, Z = z + sz / 2, z0 = z - sz / 2;
  const p = [x0, y0, z0, X, y0, z0, X, Y, z0, x0, Y, z0, x0, y0, Z, X, y0, Z, X, Y, Z, x0, Y, Z];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return Float32Array.from(f.flatMap((c) => [p[c * 3], p[c * 3 + 1], p[c * 3 + 2]]));
};
const assembled = [
  { name: 'Frame', positions: box(0, 0, 0, 10, 10, 10) },
  { name: 'Trigger', positions: box(0, -5.5, 3, 0.8, 3, 2) }, // flat, hanging under the frame's face
  { name: 'Mag', positions: box(0, 7, 0, 1.2, 6, 1.2) }, // long and inserted into the frame
  { name: 'Button', positions: box(5.3, 0, 0, 0.6, 1, 1) }, // small and flush on the side
  { name: 'Shell', positions: box(0, 0, 5.4, 4, 4, 0.8) }, // fixed housing
];
const rig = autoRig(assembled);
const byName = (n: string) => rig.bones.findIndex((b) => b.name === n);
const frame = byName('Frame'), trigger = byName('Trigger'), mag = byName('Mag'), button = byName('Button');
for (const [n, i] of [['Frame', frame], ['Trigger', trigger], ['Mag', mag], ['Button', button]] as const) assert.ok(i >= 0, `${n} has a bone`);
assert.ok(trigger >= 0 && rig.bones[trigger].limit?.x[0] === -90, 'a trigger hinges');
assert.ok(rig.bones[trigger].move && rig.bones[trigger].move!.y[0] === rig.bones[trigger].move!.y[1], 'a hinge does not translate');
assert.ok(mag >= 0 && rig.bones[mag].limit && rig.bones[mag].limit!.x[0] === 0 && rig.bones[mag].move!.y[0] < 0, 'a magazine slides');
assert.ok(button >= 0 && rig.bones[button].move!.y[1] === 0 && rig.bones[button].move!.y[0] < 0, 'a button presses inward');
assert.equal(rig.partBone[4], rig.partBone[0], 'the shell rides the frame');
for (const i of [trigger, mag, button]) {
  let j = i;
  while (j >= 0 && j !== frame) j = rig.bones[j].parent;
  assert.equal(j, frame, 'it is parented under the frame');
}
// every bone's joint is inside its part (the guess is at the contact, not at a stray vertex)
for (const [i, part] of [[trigger, 1], [mag, 2], [button, 3]] as const) {
  const b = rig.bones[i], p = assembled[part].positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[k + a]); hi[a] = Math.max(hi[a], p[k + a]); }
  assert.ok(b.head.every((x, a) => x >= lo[a] - 0.05 && x <= hi[a] + 0.05), `${b.name} head ${b.head} outside its part`);
}
const withDetails = autoRig(assembled, { details: true });
assert.ok(withDetails.bones.some((b) => b.name === 'Shell'), 'details get their own bone when asked');
// a mesh holding two rigid shells splits into two auto-rig units; one shell does not
const twin = new Float32Array(box(0, 0, 0, 2, 1, 1).length * 2);
twin.set(box(0, 0, 0, 2, 1, 1)); twin.set(box(4, 0, 0, 2, 1, 1), twin.length / 2);
assert.equal(looseUnits(twin)?.length, 2);
assert.equal(looseUnits(box(0, 0, 0, 2, 1, 1)), null);

// FBX: writes, with the armature, both bones and a skin
const out = { positions: Array.from(pos), uvs: new Array(12).fill(0), stretch: [0, 0], island: [0, 0], source: [0, 1] };
const fbx = toFbx([{ name: 'Arm', material: 'Arm', out, uv: new Float32Array(12), bone: Int32Array.from([0, 1]) }], 30, 100, bones);
const text = new TextDecoder('latin1').decode(fbx);
for (const s of ['LimbNode', 'Upper', 'Fore', 'Cluster', 'BindPose', 'Armature']) assert.ok(text.includes(s), s);
if (process.argv[2]) writeFileSync(process.argv[2], fbx);
console.log('rig ok');
