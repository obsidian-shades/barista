import * as THREE from 'three';

export type OrbitSnapStart = { x: number; y: number; theta: number; phi: number; radius: number; target: THREE.Vector3 };

/** Camera offset for a drag measured from its unsnapped start, quantized to 45° axis and diagonal views. */
export function snapOrbitOffset(start: OrbitSnapStart, dx: number, dy: number, height: number): THREE.Vector3 {
  const step = Math.PI / 4, turn = (Math.PI * 2) / Math.max(height, 1);
  const theta = start.theta - dx * turn, phi = start.phi - dy * turn;
  const spherical = new THREE.Spherical(
    start.radius,
    THREE.MathUtils.clamp(Math.round(phi / step) * step, 0.02, Math.PI - 0.02),
    Math.round(theta / step) * step,
  );
  return new THREE.Vector3().setFromSpherical(spherical);
}
