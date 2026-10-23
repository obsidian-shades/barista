// Shared colour rules, so the 3D view and the UV view agree.
import * as THREE from 'three';

/** White at 0 stretch → red at 50%+; magenta when flipped (stretch < 0). */
export function stretchColor(s: number): [number, number, number] {
  if (s < 0) return [1, 0, 1];
  const t = Math.min(1, s / Math.log(1.5));
  return [1, 1 - t, 1 - t];
}

const c = new THREE.Color();
export function islandColor(i: number): [number, number, number] {
  c.setHSL((i * 0.618034) % 1, 0.55, 0.6);
  return [c.r, c.g, c.b];
}

// Hue across U, light/dark squares: seams, stretch and rotation all show.
export function checkerCanvas(size = 512, n = Math.max(4, Math.floor(size / 16))) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const x = cv.getContext('2d')!, s = size / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    x.fillStyle = (i + j) % 2 ? '#55585b' : '#252729';
    x.fillRect(i * s, (n - 1 - j) * s, s, s);
    // Small colored registration marks make seams, orientation and texel scale easy to read.
    const hue = (i * 67 + j * 131) % 360;
    x.fillStyle = `hsl(${hue},90%,62%)`;
    const dot = Math.max(1, Math.round(s * 0.13));
    x.fillRect(i * s + (s - dot) / 2, (n - 1 - j) * s + (s - dot) / 2, dot, dot);
  }
  return cv;
}
