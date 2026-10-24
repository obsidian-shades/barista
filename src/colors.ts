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

// The UV reference maps: what the model and the layout show instead of a texture. A checker reads texel density and
// shear; the labelled grid gives every cell a name, so a seam or a stretched face can be pointed at ("the paint
// breaks along C4"); the ramp shows each island's turn and where a seam jumps; the arrows show direction alone.
//
// They are generated, not a bitmap on disk: the *cell count* follows the texture resolution (64 cells across at
// 1K, 256 at 4K), so the pattern gets finer as the texture does and keeps reading the same texel density, while the
// canvas it is drawn on stays a fixed crisp size — a 4K or 8K texture needs no 4K canvas to be looked at.
export type UVMap = 'checker' | 'grid' | 'uv' | 'arrows';

const CANVAS = 2048;
const INK = ['#0f6f8f', '#2aa8a0', '#f7e6b0', '#f4a582', '#c2185b', '#232323'];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Cells across the atlas at this paint resolution. */
export const cellsOf = (kind: UVMap, resolution: number) =>
  kind === 'grid' || kind === 'arrows' ? clamp(Math.round(resolution / 256), 2, 16) : clamp(Math.round(resolution / 16), 4, 256);

export function uvMapCanvas(kind: UVMap, resolution = 1024) {
  const size = CANVAS, cells = cellsOf(kind, resolution), s = size / cells;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const x = cv.getContext('2d')!;
  if (kind === 'uv') {
    // u across, v up: an island's rotation and every seam read straight off the model
    const g = x.createImageData(size, size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const o = (j * size + i) * 4;
      g.data[o] = (i / size) * 255; g.data[o + 1] = ((size - 1 - j) / size) * 255; g.data[o + 2] = 40; g.data[o + 3] = 255;
    }
    x.putImageData(g, 0, 0);
    return cv;
  }
  for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) {
    const px = i * s, py = (cells - 1 - j) * s;
    if (kind === 'checker') {
      x.fillStyle = (i + j) % 2 ? '#55585b' : '#252729';
      x.fillRect(px, py, s, s);
      // a registration mark per cell: seams, orientation and texel scale read at a glance (only when it fits)
      if (s >= 10) {
        const dot = Math.max(1, Math.round(s * 0.13));
        x.fillStyle = `hsl(${(i * 67 + j * 131) % 360},90%,62%)`;
        x.fillRect(px + (s - dot) / 2, py + (s - dot) / 2, dot, dot);
      }
      continue;
    }
    if (kind === 'grid') {
      const ink = INK[(i * 7 + j * 5) % INK.length];
      x.fillStyle = ink;
      x.fillRect(px, py, s, s);
      x.strokeStyle = 'rgba(0,0,0,.45)';
      x.lineWidth = Math.max(1, s * 0.04);
      x.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
      if (s >= 48) {
        x.fillStyle = ink === '#f7e6b0' || ink === '#232323' ? '#1b1b1b' : '#ffffff';
        x.font = `600 ${Math.round(s * 0.22)}px ui-sans-serif, system-ui, sans-serif`;
        x.textBaseline = 'top';
        x.fillText(String.fromCharCode(65 + (i % 26)) + j, px + s * 0.08, py + s * 0.06);
      }
    } else {
      x.fillStyle = (i + j) % 2 ? '#2b2e31' : '#3a3e42';
      x.fillRect(px, py, s, s);
      x.strokeStyle = 'rgba(255,255,255,.10)';
      x.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    }
    // the arrow points along +V: a stroke's direction on the model tells you which way the island is turned
    const c = [px + s / 2, py + s / 2], h = s * 0.3;
    x.strokeStyle = kind === 'grid' ? '#ffffff' : '#e8c33a';
    x.fillStyle = x.strokeStyle;
    x.lineWidth = Math.max(1.5, s * 0.05);
    x.beginPath(); x.moveTo(c[0], c[1] + h); x.lineTo(c[0], c[1] - h); x.stroke();
    x.beginPath(); x.moveTo(c[0], c[1] - h - s * 0.06); x.lineTo(c[0] - s * 0.09, c[1] - h + s * 0.04); x.lineTo(c[0] + s * 0.09, c[1] - h + s * 0.04); x.closePath(); x.fill();
  }
  return cv;
}

/** The checker alone, `cells` across (the UV view's island mode and the editor's own preview use it). */
export function checkerCanvas(cells = 64) {
  return uvMapCanvas('checker', cells * 16);
}