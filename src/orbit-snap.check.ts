// node src/orbit-snap.check.ts: an Alt+middle drag lands on the expected 45° camera coordinates.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { snapOrbitOffset, type OrbitSnapStart } from './orbit-snap.ts';

const target = new THREE.Vector3(2, -1, 3);
const start: OrbitSnapStart = { x: 0, y: 0, theta: 0.01, phi: 1, radius: 5, target };
// On an 800 px viewport, this drag crosses the 45° snap thresholds in both axes.
const offset = snapOrbitOffset(start, -100, 40, 800);
const spherical = new THREE.Spherical().setFromVector3(offset);
assert.ok(Math.abs(spherical.theta - Math.PI / 4) < 1e-9, `theta should snap to 45°, got ${spherical.theta}`);
assert.ok(Math.abs(spherical.phi - Math.PI / 4) < 1e-9, `phi should snap to 45°, got ${spherical.phi}`);
assert.ok(Math.abs(offset.length() - 5) < 1e-9, 'orbit should preserve camera distance');
const cameraPosition = target.clone().add(offset);
assert.deepEqual(cameraPosition.toArray().map((n) => +n.toFixed(6)), [4.5, 2.535534, 5.5]);
console.log('Alt+middle orbit snaps to the expected 45° coordinates.');
