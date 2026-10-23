// Van Gogh's paint: per part a texture set (Substance's), its channels (Base Color, and with PBR Roughness and
// Metallic, glTF's metal/rough), a stack of layers as in Photoshop, each holding paint per channel with its own
// coverage, and a selection (Photoshop's): a mask per texel that paint, fills and erasing stay inside.
// A dab on the model is a sphere in world space: every texel whose point on the surface lies inside it takes the paint,
// found by rasterising the triangles near it in UV space, so a stroke carries across seams and keeps its size whatever
// the texel density. A dab in the texture view is a plain circle of texels. Either way each texel takes a dab once
// (the strongest weight), so triangle edges never show.
import * as THREE from 'three';
import type { Baked, Surface } from './bake';

export type Channel = 'color' | 'rough' | 'metal';
/** Each channel: its name, how many values a texel holds, and what shows where no layer paints. */
export const CHANNELS: Record<Channel, { name: string; file: string; k: number; base: number[] }> = {
  color: { name: 'Base Color', file: 'BaseColor', k: 3, base: [188, 188, 188] }, // Substance's default, 0.5 linear
  rough: { name: 'Roughness', file: 'Roughness', k: 1, base: [128] },
  metal: { name: 'Metallic', file: 'Metallic', k: 1, base: [0] },
};
/** A layer: per channel it paints, k values + coverage per texel (row 0 = v 0). A generator layer (`gen`) is a fill of
 *  one value per channel whose coverage the generator makes from the baked maps, again whenever its settings change. */
export interface PaintLayer { id: number; name: string; visible: boolean; opacity: number; px: Partial<Record<Channel, Uint8ClampedArray>>; gen?: Gen }
export type GenKind = 'edge' | 'dirt' | 'ao';
/** A generator (Substance's smart mask): `amount` how much it covers, `soft` how gradual its border, `width` the edge
 *  band (share of the model), `grunge` how much noise breaks it up, `scale` the noise's size (share of the model);
 *  `color` / `rough` / `metal` what it lays down; `clip` the selection it was made in. */
export interface Gen { kind: GenKind; amount: number; soft: number; width: number; grunge: number; scale: number; color: string; rough: number; metal: number; clip: Uint8Array | null }
/** `sel`: 0..255 per texel, null = no selection (paint goes anywhere). A new selection is always a new array. */
interface State { channels: Channel[]; layers: PaintLayer[]; active: number; sel: Uint8Array | null }
/** The composite: `color` (sRGB) and `orm` (G roughness, B metallic, as three and glTF read them); `shade` darkens
 *  what's outside the selection. */
export interface TexSet extends State { size: number; color: THREE.DataTexture; orm: THREE.DataTexture; shade: THREE.DataTexture; past: State[]; ver: number; bake?: Baked; aoTex?: THREE.DataTexture }
export interface Brush { radius: number; flow: number; hardness: number; erase: boolean; values: Partial<Record<Channel, number[]>> }
export type SelOp = 'set' | 'add' | 'sub';

// keyed by the part's soup: a new model or a geometry edit starts a fresh set
// ponytail: painted texels stay where they were in UV space, so a re-unwrap of the part scrambles the paint; bake through
// the old UVs (or store paint per triangle) if that bites
const sets = new WeakMap<Float32Array, TexSet>();
let ids = 0;

const tex = (size: number, srgb: boolean) => {
  const t = new THREE.DataTexture(new Uint8ClampedArray(size * size * 4), size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8;
  return t;
};
export const newLayer = (n: number): PaintLayer => ({ id: ++ids, name: `Layer ${n}`, visible: true, opacity: 1, px: {} });

/** The part's set, made (Base Color, one empty layer) the first time; its size stays what it was made at. */
export function setOf(soup: Float32Array, size: number): TexSet {
  let s = sets.get(soup);
  if (!s) {
    s = { size, channels: ['color'], layers: [newLayer(1)], active: 0, sel: null, color: tex(size, true), orm: tex(size, false), shade: tex(size, false), past: [], ver: 0 };
    sets.set(soup, s);
    composite(s);
  }
  return s;
}

/** Keep the set as it is, for one undo step. Copy on write: the layers' buffers are shared with the step, and the
 *  active layer gets fresh copies before paint goes into them. */
export function keep(s: TexSet) {
  s.past.push({ channels: [...s.channels], layers: s.layers.map((l) => ({ ...l, px: { ...l.px } })), active: s.active, sel: s.sel });
  // ponytail: 20 steps, each a copy of the painted layer's channels (4 MB each at 1K); keep dirty tiles if memory bites
  if (s.past.length > 20) s.past.shift();
  const l = s.layers[s.active];
  if (l) s.layers[s.active] = { ...l, px: Object.fromEntries(Object.entries(l.px).map(([c, a]) => [c, a!.slice()])) };
}
export function undo(s: TexSet) {
  const prev = s.past.pop();
  if (!prev) return false;
  Object.assign(s, prev);
  composite(s);
  shade(s);
  return true;
}

/** The layers flattened into the textures the model shows, within a texel rectangle (all of it by default). */
export function composite(s: TexSet, x0 = 0, y0 = 0, x1 = s.size - 1, y1 = s.size - 1) {
  const n = s.size, col = s.color.image.data as Uint8ClampedArray, orm = s.orm.image.data as Uint8ClampedArray;
  const shown = s.layers.filter((l) => l.visible && l.opacity > 0);
  const v = [0, 0, 0];
  for (const ch of ['color', 'rough', 'metal'] as Channel[]) {
    const { k, base } = CHANNELS[ch], on = s.channels.includes(ch), stack = shown.flatMap((l) => (l.px[ch] ? [[l.px[ch]!, l.opacity] as const] : []));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * n + x;
      for (let c = 0; c < k; c++) v[c] = base[c];
      if (on) for (const [px, op] of stack) {
        const a = (px[i * (k + 1) + k] / 255) * op;
        if (a > 0) for (let c = 0; c < k; c++) v[c] += (px[i * (k + 1) + c] - v[c]) * a;
      }
      if (ch === 'color') { col[i * 4] = v[0]; col[i * 4 + 1] = v[1]; col[i * 4 + 2] = v[2]; col[i * 4 + 3] = 255; }
      else { orm[i * 4] = 255; orm[i * 4 + (ch === 'rough' ? 1 : 2)] = v[0]; orm[i * 4 + 3] = 255; }
    }
  }
  s.color.needsUpdate = s.orm.needsUpdate = true;
  s.ver++;
}
/** The selection's shade: black, see-through inside, half over what's outside it. */
function shade(s: TexSet) {
  const d = s.shade.image.data as Uint8ClampedArray, m = s.sel;
  for (let i = 0; i < s.size * s.size; i++) d[i * 4 + 3] = m ? (255 - m[i]) * 0.5 : 0;
  s.shade.needsUpdate = true;
  s.ver++;
}

/** How much of the paint each texel takes (the strongest), and the texels touched, before any is laid down. */
let weight = new Float32Array(0);
const touched: number[] = [];
const ready = (n: number) => { if (weight.length !== n * n) weight = new Float32Array(n * n); };
const mark = (i: number, a: number) => {
  if (a <= weight[i]) return;
  if (weight[i] === 0) touched.push(i);
  weight[i] = a;
};

/** Per triangle corner k: is its edge to corner k+1 a UV border (a seam or the mesh's edge)? Only there does paint
 *  bleed past the edge (1.5 px, so a seam shows no hairline); inside an island a face fills exactly its own texels. */
const borderCache = new WeakMap<object, Uint8Array>();
function bordersOf(uvs: ArrayLike<number>) {
  let b = borderCache.get(uvs as object);
  if (b) return b;
  const key = (c: number, d: number) => { const p = `${uvs[c * 2]},${uvs[c * 2 + 1]}`, q = `${uvs[d * 2]},${uvs[d * 2 + 1]}`; return p < q ? `${p}|${q}` : `${q}|${p}`; };
  const count = new Map<string, number>(), tris = uvs.length / 6;
  for (let c = 0; c < tris * 3; c++) { const k = key(c, c - (c % 3) + ((c + 1) % 3)); count.set(k, (count.get(k) ?? 0) + 1); }
  b = new Uint8Array(tris * 3);
  for (let c = 0; c < tris * 3; c++) b[c] = +(count.get(key(c, c - (c % 3) + ((c + 1) % 3)))! < 2);
  borderCache.set(uvs as object, b);
  return b;
}

/** Rasterise triangle `t` into `weight`: `w(x, y, z, i)` (0..1, of texel i's point on the surface). */
function raster(n: number, pos: ArrayLike<number>, uvs: ArrayLike<number>, t: number, w: (x: number, y: number, z: number, i: number) => number) {
  const u = [0, 1, 2].map((k) => uvs[t * 6 + k * 2] * n), v = [0, 1, 2].map((k) => uvs[t * 6 + k * 2 + 1] * n);
  const area = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
  if (Math.abs(area) < 1e-9) return;
  // how far below 0 each barycentric may go: 1.5 px over that corner's height where the opposite edge is a UV border
  const border = bordersOf(uvs);
  const tol = [0, 1, 2].map((k) => (border[t * 3 + ((k + 1) % 3)] ? (1.5 * Math.hypot(u[(k + 2) % 3] - u[(k + 1) % 3], v[(k + 2) % 3] - v[(k + 1) % 3])) / Math.abs(area) : 0));
  const x0 = Math.max(0, Math.floor(Math.min(...u) - 2)), x1 = Math.min(n - 1, Math.ceil(Math.max(...u) + 2));
  const y0 = Math.max(0, Math.floor(Math.min(...v) - 2)), y1 = Math.min(n - 1, Math.ceil(Math.max(...v) + 2));
  const o = t * 9;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const b0 = ((u[1] - px) * (v[2] - py) - (u[2] - px) * (v[1] - py)) / area;
    const b1 = ((u[2] - px) * (v[0] - py) - (u[0] - px) * (v[2] - py)) / area;
    const b2 = 1 - b0 - b1;
    if (b0 < -tol[0] || b1 < -tol[1] || b2 < -tol[2]) continue;
    mark(y * n + x, w(b0 * pos[o] + b1 * pos[o + 3] + b2 * pos[o + 6], b0 * pos[o + 1] + b1 * pos[o + 4] + b2 * pos[o + 7], b0 * pos[o + 2] + b1 * pos[o + 5] + b2 * pos[o + 8], y * n + x));
  }
}

/** Lay the weighted texels into the active layer (paint over, or erase), inside the selection, then refresh the composite there. */
function lay(s: TexSet, b: Brush) {
  const l = s.layers[s.active], n = s.size, m = s.sel;
  let x0 = n, y0 = n, x1 = -1, y1 = -1;
  if (l) for (const ch of s.channels) {
    const val = b.values[ch];
    if (!val) continue;
    const k = CHANNELS[ch].k, px = (l.px[ch] ??= new Uint8ClampedArray(n * n * (k + 1)));
    for (const i of touched) {
      const w = m ? (weight[i] * m[i]) / 255 : weight[i], o = i * (k + 1), a = px[o + k] / 255;
      if (w <= 0) continue;
      if (b.erase) { px[o + k] = a * (1 - w) * 255; continue; }
      const na = w + a * (1 - w);
      for (let c = 0; c < k; c++) px[o + c] = (val[c] * w + px[o + c] * a * (1 - w)) / na;
      px[o + k] = na * 255;
    }
  }
  for (const i of touched) {
    const x = i % n, y = (i / n) | 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    weight[i] = 0;
  }
  touched.length = 0;
  if (x1 >= 0) composite(s, x0, y0, x1, y1);
}

/** One dab of the brush at world point `at`. */
export function dab(s: TexSet, pos: ArrayLike<number>, uvs: ArrayLike<number>, at: number[], b: Brush) {
  ready(s.size);
  const [px, py, pz] = at, r = b.radius, hard = Math.min(0.99, b.hardness);
  // ponytail: every triangle checked per dab, O(triangles); a BVH if a 200k-triangle part feels slow
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9;
    let near = true;
    for (let k = 0; k < 3 && near; k++) near = Math.min(pos[o + k], pos[o + 3 + k], pos[o + 6 + k]) <= at[k] + r && Math.max(pos[o + k], pos[o + 3 + k], pos[o + 6 + k]) >= at[k] - r;
    if (!near) continue;
    raster(s.size, pos, uvs, t, (x, y, z) => falloff(Math.hypot(x - px, y - py, z - pz) / r, b.flow, hard));
  }
  lay(s, b);
}
const falloff = (d: number, flow: number, hard: number) => (d >= 1 ? 0 : flow * (d <= hard ? 1 : 1 - (d - hard) / (1 - hard)));

/** One dab in the texture view: a circle `r` texels round UV (u, v). */
export function dabUV(s: TexSet, u: number, v: number, r: number, b: Brush) {
  ready(s.size);
  const n = s.size, cx = u * n, cy = v * n, hard = Math.min(0.99, b.hardness);
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.ceil(cx + r)); x++)
      mark(y * n + x, falloff(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r, b.flow, hard));
  lay(s, b);
}

/** Every triangle in `tris` painted solid (the Bucket), inside the selection. */
export function fillTris(s: TexSet, pos: ArrayLike<number>, uvs: ArrayLike<number>, tris: Iterable<number>, b: Brush) {
  ready(s.size);
  for (const t of tris) raster(s.size, pos, uvs, t, () => 1);
  lay(s, b);
}
/** The whole active layer painted solid inside the selection (Fill; with `erase`, Delete), empty texture space too,
 *  so mipmaps don't pull white in. */
export function fillAll(s: TexSet, b: Brush) {
  ready(s.size);
  for (let i = 0; i < s.size * s.size; i++) mark(i, 1);
  lay(s, b);
}

// ---- selection ----
/** The texels of `tris` (those whose point on the surface passes `keep`, if given) as a mask. */
export function maskTris(s: TexSet, pos: ArrayLike<number>, uvs: ArrayLike<number>, tris: Iterable<number>, keep?: (x: number, y: number, z: number) => boolean) {
  ready(s.size);
  for (const t of tris) raster(s.size, pos, uvs, t, keep ? (x, y, z) => +keep(x, y, z) : () => 1);
  const m = new Uint8Array(s.size * s.size);
  for (const i of touched) { m[i] = weight[i] > 0 ? 255 : 0; weight[i] = 0; }
  touched.length = 0;
  return m;
}
/** The texels inside a polygon drawn in the texture view (UV points), as a mask. */
export function maskPolygon(s: TexSet, poly: [number, number][]) {
  const n = s.size, m = new Uint8Array(n * n);
  const ys = poly.map((p) => p[1] * n);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(n - 1, Math.ceil(Math.max(...ys))); y++)
    for (let x = 0; x < n; x++) if (inside(poly, (x + 0.5) / n, (y + 0.5) / n)) m[y * n + x] = 255;
  return m;
}
/** Even-odd point in polygon. */
export function inside(poly: [number, number][], x: number, y: number) {
  let on = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) on = !on;
  }
  return on;
}
/** The selection replaced by, grown by or cut by mask `m` (null m: deselect). Takes an undo step. */
export function select(s: TexSet, m: Uint8Array | null, op: SelOp) {
  keep(s);
  const old = s.sel;
  let next = m;
  if (m && op === 'add' && old) { next = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) next[i] = Math.max(old[i], m[i]); }
  if (m && op === 'sub') {
    if (!old) next = new Uint8Array(m.length).fill(255);
    else next = old.slice();
    for (let i = 0; i < m.length; i++) next[i] = Math.min(next[i], 255 - m[i]);
  }
  s.sel = next;
  shade(s);
}
export function invertSelection(s: TexSet) {
  keep(s);
  s.sel = s.sel ? s.sel.map((x) => 255 - x) : new Uint8Array(s.size * s.size);
  shade(s);
}

/** What the composite holds at UV (u, v): colour as #rrggbb, roughness and metallic 0..1 (the eyedropper). */
export function sample(s: TexSet, u: number, v: number) {
  const n = s.size, i = (Math.min(n - 1, Math.max(0, Math.floor(v * n))) * n + Math.min(n - 1, Math.max(0, Math.floor(u * n)))) * 4;
  const c = s.color.image.data as Uint8ClampedArray, o = s.orm.image.data as Uint8ClampedArray;
  return { color: `#${[0, 1, 2].map((k) => c[i + k].toString(16).padStart(2, '0')).join('')}`, rough: o[i + 1] / 255, metal: o[i + 2] / 255 };
}

// ---- baking and generators ----
/** Per texel of an n × n texture: its point on the surface and its triangle's normal (`has`: on some triangle, or within
 *  the seam bleed), for the bake. */
export function surfaceOf(n: number, pos: ArrayLike<number>, uvs: ArrayLike<number>): Surface {
  ready(n);
  const P = new Float32Array(n * n * 3), N = new Float32Array(n * n * 3), has = new Uint8Array(n * n);
  // ponytail: flat face normals (a low-poly curve's AO steps a little at each facet); smooth within an angle if it shows
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9, ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2], vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    raster(n, pos, uvs, t, (x, y, z, i) => { P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z; N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz; has[i] = 1; return 1; });
  }
  for (const i of touched) weight[i] = 0;
  touched.length = 0;
  return { pos: P, nrm: N, has };
}
/** The set's baked maps, kept, with AO as a texture the model can be shaded by. */
export function setBaked(s: TexSet, b: Baked) {
  s.bake = b;
  // linear data, as a material's aoMap reads it
  const t = (s.aoTex ??= tex(s.size, false)), d = t.image.data as Uint8ClampedArray;
  for (let i = 0; i < b.ao.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = b.ao[i] * 255; d[i * 4 + 3] = 255; }
  t.needsUpdate = true;
  s.ver++;
}

/** Value noise in 3D, 0..1, three octaves (the grunge that breaks a generator's mask up). */
const hash = (x: number, y: number, z: number) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); };
function noise(x: number, y: number, z: number) {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 3; o++, amp /= 2, f *= 2) {
    const X = x * f, Y = y * f, Z = z * f, ix = Math.floor(X), iy = Math.floor(Y), iz = Math.floor(Z);
    const fx = X - ix, fy = Y - iy, fz = Z - iz, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const plane = (k: number) => lerp(lerp(hash(ix, iy, k), hash(ix + 1, iy, k), sx), lerp(hash(ix, iy + 1, k), hash(ix + 1, iy + 1, k), sx), sy);
    sum += amp * lerp(plane(iz), plane(iz + 1), sz);
  }
  return sum / 0.875;
}
/** What a generator covers at texel i, 0..1, before the selection it was made in. */
function genAt(g: Gen, b: Baked, i: number) {
  const band = (d: number) => Math.max(0, 1 - d / (g.width * b.span));
  const v = g.kind === 'edge' ? band(b.convex[i]) : g.kind === 'dirt' ? Math.max(1 - b.ao[i], 0.8 * band(b.concave[i])) : 1 - b.ao[i];
  const k = (1 / (g.scale * b.span)), nz = g.grunge ? noise(b.pos[i * 3] * k, b.pos[i * 3 + 1] * k, b.pos[i * 3 + 2] * k) : 0.5;
  const broken = v * (1 + g.grunge * (2 * nz - 1) * 1.5);
  // amount moves the threshold, softness widens it
  return Math.max(0, Math.min(1, (broken - (1 - g.amount)) / Math.max(0.02, g.soft) + 0.5));
}
/** Layer `l` made (again) by its generator: its value everywhere, coverage from the baked maps. */
export function generate(s: TexSet, l: PaintLayer) {
  const g = l.gen, b = s.bake;
  if (!g || !b) return;
  const n = s.size, values: Record<Channel, number[]> = { color: [1, 3, 5].map((k) => parseInt(g.color.slice(k, k + 2), 16)), rough: [g.rough * 255], metal: [g.metal * 255] };
  const cover = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) cover[i] = b.has[i] ? genAt(g, b, i) * (g.clip ? g.clip[i] / 255 : 1) : 0;
  for (const ch of s.channels) {
    const k = CHANNELS[ch].k, px = (l.px[ch] ??= new Uint8ClampedArray(n * n * (k + 1)));
    for (let i = 0; i < n * n; i++) { for (let c = 0; c < k; c++) px[i * (k + 1) + c] = values[ch][c]; px[i * (k + 1) + k] = cover[i] * 255; }
  }
}

/** A channel's composite (or the selection's shade) as a canvas, top row v = 1 as images have it, for the texture view
 *  and export; kept until the set changes. */
/** What the texture view shows: the material view (`matview.ts`), a channel, or a baked map. */
export type Shown = 'material' | Channel | 'ao' | 'curv';
const shots = new WeakMap<TexSet, Partial<Record<Shown | 'shade', { ver: number; cv: HTMLCanvasElement }>>>();
export function canvasOf(s: TexSet, ch: Exclude<Shown, 'material'> | 'shade') {
  const all = shots.get(s) ?? {}, hit = all[ch];
  if (hit?.ver === s.ver) return hit.cv;
  const n = s.size, cv = hit?.cv ?? document.createElement('canvas');
  cv.width = cv.height = n;
  const img = new ImageData(n, n), src = (ch === 'color' ? s.color : ch === 'shade' ? s.shade : ch === 'ao' && s.aoTex ? s.aoTex : s.orm).image.data as Uint8ClampedArray, g = ch === 'rough' ? 1 : 2;
  const b = s.bake, band = (d: number) => Math.max(0, 1 - d / (0.01 * b!.span));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = ((n - 1 - y) * n + x) * 4, o = (y * n + x) * 4;
    // curvature as Substance draws it: grey, convex edges light, concave ones dark (a band 1% of the model wide)
    if (ch === 'curv') { const j = i / 4, v = b ? 128 + 127 * (band(b.convex[j]) - band(b.concave[j])) : 128; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255; }
    else if (ch === 'color' || ch === 'shade' || ch === 'ao') img.data.set(src.subarray(i, i + 4), o);
    else { img.data[o] = img.data[o + 1] = img.data[o + 2] = src[i + g]; img.data[o + 3] = 255; }
  }
  cv.getContext('2d')!.putImageData(img, 0, 0);
  all[ch] = { ver: s.ver, cv };
  shots.set(s, all);
  return cv;
}
export const pngOf = (s: TexSet, ch: Channel) => new Promise<Blob>((ok, no) => canvasOf(s, ch).toBlob((b) => (b ? ok(b) : no(new Error('Could not write the PNG'))), 'image/png'));

/** A layer's thumbnail (its Base Color, or its first painted channel, over a checkerboard where it's empty), as a data URL. */
export function thumbOf(s: TexSet, l: PaintLayer, size = 32) {
  const ch = (l.px.color ? 'color' : (Object.keys(l.px)[0] as Channel | undefined));
  const n = s.size, cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const img = new ImageData(size, size), px = ch && l.px[ch], k = ch ? CHANNELS[ch].k : 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4, i = Math.floor(((size - 1 - y) / size) * n) * n + Math.floor((x / size) * n);
    const bg = ((x >> 2) + (y >> 2)) % 2 ? 200 : 255, a = px ? px[i * (k + 1) + k] / 255 : 0;
    for (let c = 0; c < 3; c++) img.data[o + c] = bg + ((px ? px[i * (k + 1) + Math.min(c, k - 1)] : bg) - bg) * a;
    img.data[o + 3] = 255;
  }
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv.toDataURL();
}
