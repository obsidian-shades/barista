// Van Gogh's paint: per part a texture set (Substance's), its channels (Base Color, and with PBR Roughness and
// Metallic, glTF's metal/rough), a stack of layers as in Photoshop, each holding paint per channel with its own
// coverage, and a selection (Photoshop's): a mask per texel that paint, fills and erasing stay inside.
// A dab on the model is a sphere in world space: every texel whose point on the surface lies inside it takes the paint,
// found by rasterising the triangles near it in UV space, so a stroke carries across seams and keeps its size whatever
// the texel density. A dab in the texture view is a plain circle of texels. Either way each texel takes a dab once
// (the strongest weight), so triangle edges never show.
import * as THREE from 'three';
import type { Baked, Surface } from './bake';
import type { MapKind, MapPixels, MaterialPixels } from './materials';
import { uvShell } from './uvshell.ts';
import { gpuComposite, gpuCompositeReady, MODES, type Group } from './gpucomp.ts';

export type Channel = 'color' | 'rough' | 'metal' | 'normal' | 'height';
/** Each channel: its name, how many values a texel holds, and what shows where no layer paints. */
export const CHANNELS: Record<Channel, { name: string; file: string; k: number; base: number[] }> = {
  color: { name: 'Base Color', file: 'BaseColor', k: 3, base: [188, 188, 188] }, // Substance's default, 0.5 linear
  rough: { name: 'Roughness', file: 'Roughness', k: 1, base: [128] },
  metal: { name: 'Metallic', file: 'Metallic', k: 1, base: [0] },
  normal: { name: 'Normal', file: 'Normal', k: 3, base: [128, 128, 255] },
  height: { name: 'Height', file: 'Height', k: 1, base: [128] },
};
/** A fill layer's projection and material settings. `tiling` repeats per UV unit; `tiles` is how many
 *  times the material crosses the model for tri-planar, so it is independent of the document's units. */
export type Projection = 'uv' | 'triplanar';
/** The asset id of a solid fill: no maps, one colour (the tint), roughness and metallic (Substance's fill layer with
 *  plain values). It stays a layer of settings, so its colour can change without repainting. */
export const SOLID = 'solid';
export interface Fill {
  asset: string;
  projection: Projection;
  tiling: number;
  tiles: number;
  rotation: number;
  offset: [number, number];
  normalStrength: number;
  tint: string;
  /** When set, replaces the map's roughness / metallic (a finish, not a scan). */
  roughness?: number;
  metallic?: number;
  channels: Channel[];
}
/** A placed decal: a planar projector tangent to the surface at `center`, oriented by `normal`/`up`.
 *  `width` is world units, `aspect` image width / height. It is baked into a layer, so it paints and
 *  exports like the rest of the stack. */
export interface Decal {
  asset: string;
  center: [number, number, number];
  normal: [number, number, number];
  up: [number, number, number];
  width: number;
  rotation: number;
  aspect: number;
  tint: string;
  roughness: number;
  metallic: number;
  channels: Channel[];
  /** Mirrored across its own width (flipH) or height (flipV). */
  flipH?: boolean;
  flipV?: boolean;
  /** Engraved: how deep the mark is cut, 0..1 (the 'normal' and 'height' channels carry it; 0 or absent: ink only). */
  engrave?: number;
}
/** How a layer combines with what is below it, per channel as Substance Painter holds it: the base colour, the
 *  roughness and the metallic each carry their own mode, so a grunge layer can multiply the colour and still lay its
 *  roughness on straight. Normals always compose with the whiteout blend (averaging one flattens the detail). */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add';
/** A channel's blend when the layer leaves it alone: Substance's defaults. Height adds (Linear Dodge, where mid grey
 *  is zero, so stacked detail grows instead of replacing the layer below); a new layer's normal map combines. */
export const DEFAULT_BLEND: Record<Channel, BlendMode> = { color: 'normal', rough: 'normal', metal: 'normal', normal: 'normal', height: 'add' };
export const blendOf = (l: PaintLayer, ch: Channel): BlendMode => l.blend?.[ch] ?? DEFAULT_BLEND[ch];
/** A layer: per channel it paints, k values + coverage per texel (row 0 = v 0). A generator layer (`gen`) is a fill of
 *  one value per channel whose coverage the generator makes from the baked maps, again whenever its settings change.
 *  A fill layer (`fill`) holds a material; its pixels are the baked cache, and `mask` applies the layer. */
export interface PaintLayer { id: number; name: string; visible: boolean; opacity: number; blend?: Partial<Record<Channel, BlendMode>>; px: Partial<Record<Channel, Uint8ClampedArray>>; gen?: Gen; fill?: Fill; decal?: Decal; mask?: Uint8Array }
export type GenKind = 'edge' | 'dirt' | 'ao';
/** A generator (Substance's smart mask): `amount` how much it covers, `soft` how gradual its border, `width` the edge
 *  band (share of the model), `grunge` how much noise breaks it up, `scale` the noise's size (share of the model);
 *  `color` / `rough` / `metal` what it lays down; `clip` the selection it was made in. */
export interface Gen { kind: GenKind; amount: number; soft: number; width: number; grunge: number; scale: number; color: string; rough: number; metal: number; clip: Uint8Array | null }
/** `sel`: 0..255 per texel, null = no selection (paint goes anywhere). A new selection is always a new array. */
interface State { channels: Channel[]; layers: PaintLayer[]; active: number; sel: Uint8Array | null; undoRect?: [number, number, number, number] }
/** The composite: `color` (sRGB) and `orm` (G roughness, B metallic, as three and glTF read them); `shade` darkens
 *  what's outside the selection; `normal` (tangent space, RGB) and `height` (R) are the extra PBR maps. */
export interface TexSet extends State { size: number; color: THREE.DataTexture; orm: THREE.DataTexture; shade: THREE.DataTexture; normal: THREE.DataTexture; height: THREE.DataTexture; past: State[]; future: State[]; ver: number; bake?: Baked; aoTex?: THREE.DataTexture; shell?: Uint8Array; shellFor?: unknown; cov?: Uint8Array; dirty?: [number, number, number, number]; preview?: THREE.Texture }
export type BrushTip = 'round' | 'square' | 'chalk' | 'spray' | 'ring';
export interface Brush { radius: number; flow: number; hardness: number; erase: boolean; tip?: BrushTip; values: Partial<Record<Channel, number[]>> }
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

/** The part's set, made (Base Color, one empty layer) the first time; changing the texture resolution resizes it. */
export function setOf(soup: Float32Array, size: number): TexSet {
  let s = sets.get(soup);
  if (!s) {
    s = { size, channels: ['color'], layers: [newLayer(1)], active: 0, sel: null, color: tex(size, true), orm: tex(size, false), shade: tex(size, false), normal: tex(size, false), height: tex(size, false), past: [], future: [], ver: 0 };
    sets.set(soup, s);
    composite(s);
  } else if (s.size !== size) resize(s, size);
  return s;
}

/** The part's set if it has one yet (saving a project must not make empty ones). */
export const setIfAny = (soup: Float32Array) => sets.get(soup) ?? null;
/** A layer's stack entry as a project file keeps it (project.ts): everything but the pixels, which go as tiles. */
export type SavedLayer = Omit<PaintLayer, 'px' | 'mask' | 'gen'> & { gen?: Omit<Gen, 'clip'> & { clip: boolean }; mask: boolean; px: Channel[] };
export interface SavedSet { size: number; channels: Channel[]; active: number; layers: SavedLayer[] }
export const PAINT_TILE = 256;
/** `px` (n × n texels of `stride` bytes) as tiles of PAINT_TILE² texels, row by row; tiles whose last byte per texel (the
 *  coverage, or the whole value for a 1-byte mask) is 0 everywhere are left out. */
export function tilesOf(px: ArrayLike<number> & { subarray(a: number, b: number): Uint8Array | Uint8ClampedArray }, n: number, stride: number): { tx: number; ty: number; data: Uint8Array }[] {
  const t = Math.min(PAINT_TILE, n), out: { tx: number; ty: number; data: Uint8Array }[] = [];
  for (let ty = 0; ty < n / t; ty++) for (let tx = 0; tx < n / t; tx++) {
    const data = new Uint8Array(t * t * stride);
    let any = false;
    for (let y = 0; y < t; y++) {
      const o = ((ty * t + y) * n + tx * t) * stride, row = px.subarray(o, o + t * stride);
      data.set(row, y * t * stride);
      if (!any) for (let i = stride - 1; i < row.length; i += stride) if (row[i]) { any = true; break; }
    }
    if (any) out.push({ tx, ty, data });
  }
  return out;
}
/** The other way: tiles back into one n × n buffer (missing tiles stay 0). */
export function fromTiles<T extends Uint8Array | Uint8ClampedArray>(into: T, n: number, stride: number, tiles: { tx: number; ty: number; data: Uint8Array }[]): T {
  const t = Math.min(PAINT_TILE, n);
  for (const { tx, ty, data } of tiles) for (let y = 0; y < t; y++) into.set(data.subarray(y * t * stride, (y + 1) * t * stride), ((ty * t + y) * n + tx * t) * stride);
  return into;
}
/** A part's set as a saved project had it: its stack, with `pixels(layer id, channel | 'mask' | 'clip', stride)` giving
 *  each buffer back. Layer ids carry on past the highest one loaded. */
export function restoreSet(soup: Float32Array, saved: SavedSet, pixels: (id: number, what: Channel | 'mask' | 'clip', stride: number) => Uint8Array) {
  const s = setOf(soup, saved.size);
  s.channels = saved.channels;
  s.layers = saved.layers.map(({ px, mask, gen, ...l }) => ({
    ...l,
    px: Object.fromEntries(px.map((ch) => [ch, new Uint8ClampedArray(pixels(l.id, ch, CHANNELS[ch].k + 1).buffer)])),
    ...(mask ? { mask: pixels(l.id, 'mask', 1) } : {}),
    ...(gen ? { gen: { ...gen, clip: gen.clip ? pixels(l.id, 'clip', 1) : null } } : {}),
  }));
  s.active = Math.min(saved.active, s.layers.length - 1);
  s.sel = null; s.past = []; s.future = []; s.bake = undefined; s.aoTex = undefined;
  ids = Math.max(ids, ...s.layers.map((l) => l.id));
  composite(s);
  return s;
}
/** The set as a project saves it: the stack, and every pixel buffer to tile. */
export function saveSet(s: TexSet): { saved: SavedSet; buffers: { id: number; what: Channel | 'mask' | 'clip'; px: Uint8Array | Uint8ClampedArray; stride: number }[] } {
  const buffers: { id: number; what: Channel | 'mask' | 'clip'; px: Uint8Array | Uint8ClampedArray; stride: number }[] = [];
  const layers = s.layers.map(({ px, mask, gen, ...l }): SavedLayer => {
    for (const ch of Object.keys(px) as Channel[]) buffers.push({ id: l.id, what: ch, px: px[ch]!, stride: CHANNELS[ch].k + 1 });
    if (mask) buffers.push({ id: l.id, what: 'mask', px: mask, stride: 1 });
    if (gen?.clip) buffers.push({ id: l.id, what: 'clip', px: gen.clip, stride: 1 });
    return { ...l, px: Object.keys(px) as Channel[], mask: !!mask, ...(gen ? { gen: { ...gen, clip: !!gen.clip } } : {}) };
  });
  return { saved: { size: s.size, channels: [...s.channels], active: s.active, layers }, buffers };
}

/** Move a set to another resolution: every layer, the selection and the composite are resampled nearest (a hard
 *  edge stays hard — a bilinear pass would blur it by the ratio), and the bake is dropped because it is built per
 *  texel at the old size. Painting done before the move is as sharp as it was; nothing can add detail that was
 *  never sampled. Undo history is dropped with it: its buffers are the old size. */
export function resize(s: TexSet, size: number) {
  const n = s.size, m = size;
  if (n === m) return;
  const map = (src: Uint8ClampedArray, stride: number) => {
    const out = new Uint8ClampedArray(m * m * stride);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const sy = Math.min(n - 1, Math.floor((y * n) / m)), sx = Math.min(n - 1, Math.floor((x * n) / m));
      for (let c = 0; c < stride; c++) out[(y * m + x) * stride + c] = src[(sy * n + sx) * stride + c];
    }
    return out;
  };
  const mapMask = (src: Uint8Array) => {
    const out = new Uint8Array(m * m);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const sy = Math.min(n - 1, Math.floor((y * n) / m)), sx = Math.min(n - 1, Math.floor((x * n) / m));
      out[y * m + x] = src[sy * n + sx];
    }
    return out;
  };
  for (const l of s.layers) {
    for (const ch of Object.keys(l.px) as Channel[]) l.px[ch] = map(l.px[ch]!, CHANNELS[ch].k + 1);
    if (l.mask) l.mask = mapMask(l.mask);
    if (l.gen?.clip) l.gen = { ...l.gen, clip: mapMask(l.gen.clip) };
  }
  if (s.sel) s.sel = mapMask(s.sel);
  s.size = m;
  s.color = tex(m, true);
  s.orm = tex(m, false);
  s.shade = tex(m, false);
  s.normal = tex(m, false);
  s.height = tex(m, false);
  s.past = [];
  s.future = [];
  s.dirty = undefined;
  s.bake = undefined;
  s.aoTex = undefined;
  s.shell = undefined;
  s.cov = undefined;
  s.shellFor = undefined;
  composite(s);
  shade(s);
}

type Rect = [number, number, number, number];
const snapshot = (s: TexSet): State => ({ channels: [...s.channels], layers: s.layers.map((l) => ({ ...l, px: { ...l.px }, mask: l.mask?.slice() })), active: s.active, sel: s.sel, undoRect: undefined });
/** Keep the set as it is, for one undo step. Copy on write: the layers' buffers are shared with the step, and the
 *  active layer gets fresh copies before paint goes into them. */
export function keep(s: TexSet) {
  s.past.push(snapshot(s));
  // ponytail: 20 steps, each a copy of the painted layer's channels (4 MB each at 1K); keep dirty tiles if memory bites
  if (s.past.length > 20) s.past.shift();
  s.future.length = 0;
  const l = s.layers[s.active];
  if (l) s.layers[s.active] = { ...l, px: Object.fromEntries(Object.entries(l.px).map(([c, a]) => [c, a!.slice()])), mask: l.mask?.slice() };
}
/** A selection change only moves the mask: its step can share the layers instead of copying every buffer of every
 *  visible part (island picks are document-wide), which at 4K was hundreds of megabytes per click. */
export function keepSelection(s: TexSet) {
  s.past.push({ channels: s.channels, layers: s.layers.slice(), active: s.active, sel: s.sel, undoRect: undefined });
  if (s.past.length > 20) s.past.shift();
  s.future.length = 0;
}
/** Restore the last step, and keep what it replaced so `redo` can put it back (`defer`: the caller composites
 *  the returned box itself, through the queue). */
export function undo(s: TexSet, defer = false): { rect?: Rect; full: boolean } | null {
  const prev = s.past.pop();
  if (!prev) return null;
  // the state being taken back is where a redo lands, over the same box the stroke touched
  s.future.push({ ...snapshot(s), undoRect: prev.undoRect });
  if (s.future.length > 20) s.future.shift();
  const oldSel = s.sel, rect = prev.undoRect;
  Object.assign(s, prev);
  if (oldSel !== prev.sel) shade(s);
  if (!defer) {
    if (rect) {
      composite(s, rect[0], rect[1], rect[2], rect[3], undefined, false);
      s.dirty = rect;
      bleedAll(s);
    } else composite(s);
  }
  return { rect, full: !rect };
}
/** Put back what the last undo took away. */
export function redo(s: TexSet, defer = false): { rect?: Rect; full: boolean } | null {
  const next = s.future.pop();
  if (!next) return null;
  s.past.push({ ...snapshot(s), undoRect: next.undoRect });
  if (s.past.length > 20) s.past.shift();
  const oldSel = s.sel, rect = next.undoRect;
  Object.assign(s, next);
  if (oldSel !== next.sel) shade(s);
  if (!defer) {
    if (rect) {
      composite(s, rect[0], rect[1], rect[2], rect[3], undefined, false);
      s.dirty = rect;
      bleedAll(s);
    } else composite(s);
  }
  return { rect, full: !rect };
}

// ---- non-blocking composites ----
// A full layer change, an undo or a fill is recomposited in yielding bands so 4K stays interactive. Requests are
// queued per set instead of cancelling each other: a pass abandoned halfway would leave the part of its box it had
// not reached showing an older layer state, which is exactly what a Ctrl+Z followed by a stroke used to do.
interface CompQueue { full: boolean; rects: Rect[]; running: boolean; notify?: () => void; waiters: Array<() => void> }
const queues = new WeakMap<TexSet, CompQueue>();
const union = (rects: Rect[]): Rect => rects.reduce<Rect>((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], [Infinity, Infinity, -Infinity, -Infinity]);

/** Composite `rect` (all texels when omitted) after the pass already running, merging requests made meanwhile.
 *  `notify` is called once a batch lands, so the views can redraw; the promise resolves when the queue is empty. */
export function requestComposite(s: TexSet, rect?: Rect, notify?: () => void): Promise<void> {
  const q = queues.get(s) ?? { full: false, rects: [], running: false, waiters: [] };
  queues.set(s, q);
  if (notify) q.notify = notify;
  if (rect) q.rects.push(rect); else q.full = true;
  const done = new Promise<void>((ok) => q.waiters.push(ok));
  if (!q.running) void drainComposite(s, q);
  return done;
}
async function drainComposite(s: TexSet, q: CompQueue) {
  q.running = true;
  try {
    while (q.full || q.rects.length) {
      const full = q.full, rects = q.rects;
      q.full = false; q.rects = [];
      // on the GPU a whole box is a few passes: no need to band it to stay interactive
      const n = s.size, band = gpuCompositeReady(n) ? n : Math.max(32, Math.ceil(n / 64));
      if (full) {
        for (let y = 0; y < n; y += band) {
          composite(s, 0, y, n - 1, Math.min(n - 1, y + band - 1), undefined, false);
          await new Promise((ok) => setTimeout(ok, 0));
        }
        s.dirty = undefined;
      } else {
        const [x0, y0, x1, y1] = union(rects);
        for (let y = y0; y <= y1; y += band) {
          composite(s, x0, y, x1, Math.min(y1, y + band - 1), undefined, false);
          await new Promise((ok) => setTimeout(ok, 0));
        }
      }
      q.notify?.();
    }
  } finally {
    q.running = false;
    for (const ok of q.waiters.splice(0)) ok();
  }
}
/** The paint operation that just finished touched only `rect`: its undo can recomposite that box instead of
 *  all 4K texels. Called after a stroke/fill, before the padding pass clears `s.dirty`. */
export function setUndoRect(s: TexSet, rect: Rect) {
  const h = s.past[s.past.length - 1];
  if (h) h.undoRect = rect;
}

/** A layer's blend, on 0..1 values, before the layer's alpha is applied. */
function blended(dst: number, src: number, mode: BlendMode) {
  if (mode === 'multiply') return dst * src;
  if (mode === 'screen') return 1 - (1 - dst) * (1 - src);
  if (mode === 'overlay') return dst < 0.5 ? 2 * dst * src : 1 - 2 * (1 - dst) * (1 - src);
  if (mode === 'add') return Math.min(1, dst + src);
  return src;
}
/** Height is signed data around mid grey: `add` (Substance's Linear Dodge) grows the detail instead of clipping a
 *  plain sum, so a bright ridge and a dark groove both survive the stack. */
function blendedHeight(dst: number, src: number, mode: BlendMode) {
  return mode === 'add' ? Math.max(0, Math.min(1, dst + (src - 0.5))) : blended(dst, src, mode);
}

/** Texels in a composite box from which the GPU takes over (256²). */
const GPU_MIN = 256 * 256;
/** The layers flattened into the textures the model shows, within a texel rectangle (all of it by default).
 *  `only` limits the work to the channels a brush just touched: painting Base Color does not recomposite
 *  Roughness, Metallic, Normal and Height on every dab. */
export function composite(s: TexSet, x0 = 0, y0 = 0, x1 = s.size - 1, y1 = s.size - 1, only?: Channel[], pad = true) {
  const n = s.size, col = s.color.image.data as Uint8ClampedArray, orm = s.orm.image.data as Uint8ClampedArray;
  const nrm = s.normal.image.data as Uint8ClampedArray, hgt = s.height.image.data as Uint8ClampedArray;
  const shown = s.layers.filter((l) => l.visible && l.opacity > 0);
  const v = [0, 0, 0], cov = (s.cov ??= new Uint8Array(n * n));
  const want = (ch: Channel) => !only || only.includes(ch);
  // A fill or decal layer writes only the channels it was baked for; a paint or generator layer writes whatever it has.
  const writes = (l: PaintLayer, ch: Channel) => {
    const set = l.fill?.channels ?? l.decal?.channels;
    return !set || set.includes(ch);
  };
  const nOn = s.channels.includes('normal') && want('normal');
  const hOn = s.channels.includes('height') && want('height');
  // A box this size or more goes to the GPU (gpucomp.ts): the same blends as shader passes, read back into the arrays
  // below. A dab's box stays here, where a readback would cost more than it saves.
  let done = false;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) >= GPU_MIN && gpuCompositeReady(n)) {
    const stackOf = (ch: Channel, stride: 2 | 4) => shown.flatMap((l) => (writes(l, ch) && l.px[ch] ? [{ px: l.px[ch]!, stride, op: l.opacity, mask: l.mask, mode: MODES[blendOf(l, ch)] ?? 0 }] : []));
    const groups: Group[] = [];
    for (const ch of ['color', 'rough', 'metal'] as Channel[]) if (want(ch)) {
      groups.push({ ch, kind: ch === 'color' ? 0 : 1, base: CHANNELS[ch].base.map((b) => b / 255), layers: s.channels.includes(ch) ? stackOf(ch, ch === 'color' ? 4 : 2) : [] });
    }
    if (nOn) groups.push({ ch: 'normal', kind: 2, base: [0, 0, 1], layers: stackOf('normal', 4) });
    if (hOn) groups.push({ ch: 'height', kind: 3, base: [128 / 255], layers: stackOf('height', 2) });
    done = gpuComposite(n, x0, y0, x1, y1, groups, (g, buf, tx, ty, w, h) => {
      if (!buf) { // read straight into the array: colour's alpha came back as coverage
        if (g.ch === 'color') for (let i = ty * n, e = (ty + h) * n; i < e; i++) { cov[i] = col[i * 4 + 3] > 127 ? 1 : 0; col[i * 4 + 3] = 255; }
        return;
      }
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const i = (ty + r) * n + tx + c, o = (r * w + c) * 4, d = i * 4;
        if (g.ch === 'color') { col[d] = buf[o]; col[d + 1] = buf[o + 1]; col[d + 2] = buf[o + 2]; col[d + 3] = 255; cov[i] = buf[o + 3] > 127 ? 1 : 0; }
        else if (g.ch === 'rough' || g.ch === 'metal') { orm[d] = 255; orm[d + (g.ch === 'rough' ? 1 : 2)] = buf[o]; orm[d + 3] = 255; }
        else if (g.ch === 'normal') { nrm[d] = buf[o]; nrm[d + 1] = buf[o + 1]; nrm[d + 2] = buf[o + 2]; nrm[d + 3] = 255; }
        else { hgt[d] = hgt[d + 1] = hgt[d + 2] = buf[o]; hgt[d + 3] = 255; }
      }
    }, (g) => (g.ch === 'color' ? col : g.ch === 'normal' ? nrm : g.ch === 'height' ? hgt : null));
  }
  if (!done) for (const ch of ['color', 'rough', 'metal'] as Channel[]) {
    if (!want(ch)) continue;
    const { k, base } = CHANNELS[ch], on = s.channels.includes(ch);
    const stack = shown.flatMap((l) => (writes(l, ch) && l.px[ch] ? [[l.px[ch]!, l.opacity, l.mask, blendOf(l, ch)] as const] : []));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * n + x;
      for (let c = 0; c < k; c++) v[c] = base[c];
      let any = false;
      if (on) for (const [px, op, mask, mode] of stack) {
        const a = (px[i * (k + 1) + k] / 255) * op * (mask ? mask[i] / 255 : 1);
        if (a > 0) {
          any = true;
          for (let c = 0; c < k; c++) {
            const d = v[c] / 255, sv = px[i * (k + 1) + c] / 255;
            v[c] = (d + (blended(d, sv, mode) - d) * a) * 255;
          }
        }
      }
      if (ch === 'color') { cov[i] = any ? 1 : 0; col[i * 4] = v[0]; col[i * 4 + 1] = v[1]; col[i * 4 + 2] = v[2]; col[i * 4 + 3] = 255; }
      else { orm[i * 4] = 255; orm[i * 4 + (ch === 'rough' ? 1 : 2)] = v[0]; orm[i * 4 + 3] = 255; }
    }
  }
  // Normals compose with a whiteout blend, never a plain average: averaging flattens the detail.
  const nstack = nOn && !done ? shown.flatMap((l) => (writes(l, 'normal') && l.px.normal ? [[l.px.normal, l.opacity, l.mask] as const] : [])) : [];
  const hstack = hOn && !done ? shown.flatMap((l) => (writes(l, 'height') && l.px.height ? [[l.px.height, l.opacity, l.mask, blendOf(l, 'height')] as const] : [])) : [];
  if (!done && (nOn || hOn)) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * n + x;
    if (nOn) {
      let nx = 0, ny = 0, nz = 1;
      for (const [px, op, mask] of nstack) {
        const a = (px[i * 4 + 3] / 255) * op * (mask ? mask[i] / 255 : 1);
        if (a <= 0) continue;
        const dx = px[i * 4] / 127.5 - 1, dy = px[i * 4 + 1] / 127.5 - 1, dz = px[i * 4 + 2] / 127.5 - 1;
        let rx = nx + dx, ry = ny + dy, rz = nz * dz;
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        nx += (rx - nx) * a; ny += (ry - ny) * a; nz += (rz - nz) * a;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
      }
      nrm[i * 4] = (nx * 0.5 + 0.5) * 255; nrm[i * 4 + 1] = (ny * 0.5 + 0.5) * 255; nrm[i * 4 + 2] = (nz * 0.5 + 0.5) * 255; nrm[i * 4 + 3] = 255;
    }
    if (hOn) {
      let h = 128;
      for (const [px, op, mask, mode] of hstack) {
        const a = (px[i * 2 + 1] / 255) * op * (mask ? mask[i] / 255 : 1);
        if (a > 0) { const d = h / 255, sv = px[i * 2] / 255; h = (d + (blendedHeight(d, sv, mode) - d) * a) * 255; }
      }
      hgt[i * 4] = hgt[i * 4 + 1] = hgt[i * 4 + 2] = h; hgt[i * 4 + 3] = 255;
    }
  }
  const mark = (t: THREE.DataTexture) => {
    t.needsUpdate = true;
    // A whole-texture composite uploads in one go (no ranges). A banded pass or a dab must *add* to the ranges: three
    // uploads every pending range on the next render and only clears them then. Clearing here (as this did) dropped
    // every band's rows but the last one, so the GPU kept an old patchwork of the texture while the CPU copy was
    // right — a stroke that landed only in stripes, and undo leaving pieces of itself on screen.
    if (pad || (x0 === 0 && y0 === 0 && x1 === n - 1 && y1 === n - 1)) { t.clearUpdateRanges(); return; }
    for (let y = y0; y <= y1; y++) t.addUpdateRange((y * n + x0) * 4, (x1 - x0 + 1) * 4);
  };
  if (want('color')) mark(s.color);
  if (want('rough') || want('metal')) mark(s.orm);
  if (want('normal')) mark(s.normal);
  if (want('height')) mark(s.height);
  if (pad) { s.dirty = undefined; bleed(s, x0, y0, x1, y1); }
  else {
    const d = s.dirty;
    s.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
  }
  s.ver++;
}

/** Carry the paint into the empty texture around the islands once, after a stroke: the mip-padding pass is
 *  too expensive to run on every dab, and a live stroke does not need it until it is committed. */
export function bleedAll(s: TexSet) {
  if (!s.shell) return;
  const n = s.size, [x0, y0, x1, y1] = s.dirty ?? [0, 0, n - 1, n - 1];
  bleed(s, x0, y0, x1, y1);
  const p = mipPad(n), ax0 = Math.max(0, x0 - p), ay0 = Math.max(0, y0 - p), ax1 = Math.min(n - 1, x1 + p), ay1 = Math.min(n - 1, y1 + p);
  const full = ax0 === 0 && ay0 === 0 && ax1 === n - 1 && ay1 === n - 1;
  for (const t of [s.color, s.orm, s.normal, s.height]) {
    t.needsUpdate = true;
    // A whole texture uploads as one image; otherwise add the padded box to whatever ranges are still pending (a
    // banded pass that has not been drawn yet), never clearing them.
    if (full) { t.clearUpdateRanges(); continue; }
    for (let y = ay0; y <= ay1; y++) t.addUpdateRange((y * n + ax0) * 4, (ax1 - ax0 + 1) * 4);
  }
  s.dirty = undefined;
  s.ver++;
}

/** Does any visible layer put paint on texel `i`? `cov` (built by `composite`) answers the same in O(1). */
function covered(s: TexSet, i: number) {
  if (s.cov) return s.cov[i] > 0;
  for (const l of s.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    for (const ch of s.channels) {
      const px = l.px[ch];
      if (px && px[i * (CHANNELS[ch].k + 1) + CHANNELS[ch].k] > 0 && (!l.mask || l.mask[i] > 0)) return true;
    }
  }
  return false;
}

/** How far the paint is carried out past itself, in texels: a mip is an average of a 2^k square, so an island with
 *  empty texture behind it smears its edge into the background and the background into its edge — the soft halo
 *  round every painted area seen at a distance or at a grazing angle, the "smudge" at a seam. Padding by the size
 *  of the coarsest mips anyone sees keeps the average inside the colour. */
const mipPad = (n: number) => Math.max(4, Math.round(n / 64));

/** The texels inside the part's UV shell: a triangle covers them even where nothing is painted. Padding may only go
 *  outside it — inside, a bare texel is a face the artist left unpainted. Also what stops the flood tunnelling
 *  through an island to its far side. */
function ensureShell(s: TexSet, uvs: ArrayLike<number>) {
  if (s.shellFor === uvs) return;
  const n = s.size;
  const gpu = uvShell(n, uvs);
  if (gpu) { s.shell = gpu; s.shellFor = uvs; return; }
  const mask = new Uint8Array(n * n), tris = uvs.length / 6;
  for (let t = 0; t < tris; t++) {
    const u = [0, 1, 2].map((k) => uvs[t * 6 + k * 2] * n), v = [0, 1, 2].map((k) => uvs[t * 6 + k * 2 + 1] * n);
    const area = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(...u))), x1 = Math.min(n - 1, Math.ceil(Math.max(...u)));
    const y0 = Math.max(0, Math.floor(Math.min(...v))), y1 = Math.min(n - 1, Math.ceil(Math.max(...v)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const b0 = ((u[1] - px) * (v[2] - py) - (u[2] - px) * (v[1] - py)) / area;
      const b1 = ((u[2] - px) * (v[0] - py) - (u[0] - px) * (v[2] - py)) / area;
      if (b0 >= 0 && b1 >= 0 && b0 + b1 <= 1) mask[y * n + x] = 1;
    }
  }
  s.shell = mask;
  s.shellFor = uvs;
}

/** Carry the paint out past its island into the empty texture, `mipPad` texels deep — the margin painter tools
 *  add for the mip chain, which is an average: with nothing behind an island edge a mip blends its colour into the
 *  background and the background into its edge, and every seam shows a soft halo. The flood runs through the
 *  island's bare texels (it must, to reach the edge) but only *writes* outside the shell, so a face the artist left
 *  bare stays bare; two islands meeting in a gap stop at the middle, each on its own colour. */
function bleed(s: TexSet, x0: number, y0: number, x1: number, y1: number) {
  if (!s.shell) return; // no UV shell known yet: the shell is what tells paint from bare face
  const n = s.size, p = mipPad(n);
  const [ex0, ey0, ex1, ey1] = [Math.max(0, x0 - p), Math.max(0, y0 - p), Math.min(n - 1, x1 + p), Math.min(n - 1, y1 + p)];
  const w = ex1 - ex0 + 1, h = ey1 - ey0 + 1;
  const col = s.color.image.data as Uint8ClampedArray, orm = s.orm.image.data as Uint8ClampedArray;
  const nrm = s.normal.image.data as Uint8ClampedArray, hgt = s.height.image.data as Uint8ClampedArray;
  const at = new Uint8Array(w * h); // 0 = untouched, 1 = queued
  // The frontier only ever holds a band `p` wide; bound it so a 4K full composite can't ask for a 64 MB queue.
  const q = new Uint32Array(Math.min(w * h, 1 << 22));
  let head = 0, tail = 0, levelEnd = 0;
  for (let y = ey0; y <= ey1; y++) for (let x = ex0; x <= ex1; x++) {
    if (!covered(s, y * n + x) || tail === q.length) continue;
    const k = (y - ey0) * w + (x - ex0);
    at[k] = 1;
    q[tail++] = k;
  }
  levelEnd = tail;
  // level by level, so the step is the loop's own counter and no per-texel distance array is needed
  for (let step = 1; step <= p && head < tail; step++) {
    const end = levelEnd;
    while (head < end) {
      const k = q[head++], x = ex0 + (k % w), y = ey0 + ((k / w) | 0), src = y * n + x;
      for (let a = 0; a < 4; a++) {
        const nx = x + (a === 0 ? 1 : a === 1 ? -1 : 0), ny = y + (a === 2 ? 1 : a === 3 ? -1 : 0);
        if (nx < ex0 || nx > ex1 || ny < ey0 || ny > ey1) continue;
        const j = (ny - ey0) * w + (nx - ex0);
        if (at[j]) continue;
        at[j] = 1;
        const dst = ny * n + nx;
        if (!s.shell[dst]) {
          for (let c = 0; c < 3; c++) { col[dst * 4 + c] = col[src * 4 + c]; orm[dst * 4 + c] = orm[src * 4 + c]; nrm[dst * 4 + c] = nrm[src * 4 + c]; }
          hgt[dst * 4] = hgt[dst * 4 + 1] = hgt[dst * 4 + 2] = hgt[src * 4];
          col[dst * 4 + 3] = orm[dst * 4 + 3] = nrm[dst * 4 + 3] = hgt[dst * 4 + 3] = 255;
        }
        if (step < p && tail < q.length) q[tail++] = j;
      }
    }
    levelEnd = tail;
  }
}
/** The selection's shade, as the 3D view draws a selection: a light orange tint inside with a solid orange border
 *  (`SEL`), black over what's outside. Darkening alone vanished on a dark material, so a click looked like nothing. */
function shade(s: TexSet) {
  const d = s.shade.image.data as Uint8ClampedArray, m = s.sel, n = s.size;
  // the border is a couple of texels wide, enough to survive the texture view's downsampled preview
  const w = Math.max(1, Math.round(n / 512));
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && m![y * n + x] > 127;
  for (let i = 0; i < n * n; i++) {
    const o = i * 4;
    if (!m) { d[o + 3] = 0; continue; }
    const x = i % n, y = (i / n) | 0, inside = m[i] > 127;
    let edge = false;
    if (inside) for (let k = 1; k <= w && !edge; k++) edge = !on(x + k, y) || !on(x - k, y) || !on(x, y + k) || !on(x, y - k);
    if (inside) { d[o] = 255; d[o + 1] = 143; d[o + 2] = 31; d[o + 3] = edge ? 255 : 40; }
    else { d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = 140; }
  }
  s.shade.needsUpdate = true;
  s.ver++;
}

/** How much of the paint each texel takes (the strongest), and the texels touched, before any is laid down. */
let weight = new Float32Array(0);
const touched: number[] = [];
const ready = (n: number) => { if (weight.length !== n * n) weight = new Float32Array(n * n); };
const mark = (i: number, a: number) => {
  if (a <= weight[i]) return false;
  if (weight[i] === 0) touched.push(i);
  weight[i] = a;
  return true;
};

/** Per triangle corner k, what its edge to corner k+1 is: 0 inside the island (a face fills exactly its own texels),
 *  1 a UV border the *surface* continues across (a seam in the middle of a smooth surface — paint bleeds a pixel so
 *  no hairline shows there), 2 a border along a crease or the mesh's edge (the edge of a face — paint stops dead).
 *  The second case is the one that smears a line: bleeding a fill or a stroke across a 90° crease lays paint on the
 *  panel beside it, and on a bevel that panel is a few texels wide, so the spill shows as a ragged fringe. */
const borderCache = new WeakMap<object, { pos: unknown; border: Uint8Array }>();
export function bordersOf(uvs: ArrayLike<number>, pos?: ArrayLike<number>) {
  const hit = borderCache.get(uvs as object);
  if (hit && hit.pos === pos) return hit.border;
  const key = (c: number, d: number) => { const p = `${uvs[c * 2]},${uvs[c * 2 + 1]}`, q = `${uvs[d * 2]},${uvs[d * 2 + 1]}`; return p < q ? `${p}|${q}` : `${q}|${p}`; };
  const count = new Map<string, number>(), tris = uvs.length / 6;
  for (let c = 0; c < tris * 3; c++) { const k = key(c, c - (c % 3) + ((c + 1) % 3)); count.set(k, (count.get(k) ?? 0) + 1); }
  const b = new Uint8Array(tris * 3);
  for (let c = 0; c < tris * 3; c++) b[c] = +(count.get(key(c, c - (c % 3) + ((c + 1) % 3)))! < 2);
  // Which of those borders the surface carries on across: the same two corners in 3D, in another triangle, facing
  // within 30° of this one. Nobody tells the paint about smoothing groups, so the surface answers for itself.
  if (pos && pos.length === tris * 9) {
    const at = (t: number, k: number) => `${pos[t * 9 + k * 3]},${pos[t * 9 + k * 3 + 1]},${pos[t * 9 + k * 3 + 2]}`;
    const edges = new Map<string, [number, number, number][]>(); // 3D edge → (triangle, corner a, corner b)
    const ekey = (p: string, q: string) => (p < q ? `${p}|${q}` : `${q}|${p}`);
    for (let t = 0; t < tris; t++) for (let k = 0; k < 3; k++) {
      const kk = ekey(at(t, k), at(t, (k + 1) % 3));
      const list = edges.get(kk);
      if (list) list.push([t, k, (k + 1) % 3]); else edges.set(kk, [[t, k, (k + 1) % 3]]);
    }
    const nrm = (t: number) => {
      const o = t * 9, e1 = [0, 1, 2].map((i) => pos[o + 3 + i] - pos[o + i]), e2 = [0, 1, 2].map((i) => pos[o + 6 + i] - pos[o + i]);
      const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(c[0], c[1], c[2]) || 1;
      return [c[0] / l, c[1] / l, c[2] / l];
    };
    for (let t = 0; t < tris; t++) for (let k = 0; k < 3; k++) {
      if (!b[t * 3 + k]) continue;
      const list = edges.get(ekey(at(t, k), at(t, (k + 1) % 3))) ?? [];
      const n = nrm(t);
      let smooth = false;
      for (const [u] of list) {
        if (u === t) continue;
        const m = nrm(u);
        if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 0.866) { smooth = true; break; } // within 30°
      }
      b[t * 3 + k] = smooth ? 1 : 2;
    }
  }
  borderCache.set(uvs as object, { pos, border: b });
  return b;
}

/** Rasterise triangle `t` into `weight`: `w(x, y, z, i)` (0..1, of texel i's point on the surface). */
function raster(n: number, pos: ArrayLike<number>, uvs: ArrayLike<number>, t: number, w: (x: number, y: number, z: number, i: number) => number, clip?: [number, number, number, number], write?: (x: number, y: number, z: number, i: number) => void) {
  const u = [0, 1, 2].map((k) => uvs[t * 6 + k * 2] * n), v = [0, 1, 2].map((k) => uvs[t * 6 + k * 2 + 1] * n);
  const area = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
  if (Math.abs(area) < 1e-9) return;
  // How far below 0 each barycentric may go: one texel over that corner's height where the opposite edge is a
  // seam the surface carries on across (`bordersOf` = 1), nothing at all along a crease (= 2) — a fill that spills
  // over the edge of a face is the smudge, and on a bevel a couple of texels of spill is the whole bevel.
  const border = bordersOf(uvs, pos);
  const tol = [0, 1, 2].map((k) => {
    const b = border[t * 3 + ((k + 1) % 3)];
    return b === 1 ? (0.5 * Math.hypot(u[(k + 2) % 3] - u[(k + 1) % 3], v[(k + 2) % 3] - v[(k + 1) % 3])) / Math.abs(area) : 0;
  });
  const x0 = Math.max(0, Math.floor(Math.min(...u) - 2), clip ? clip[0] : 0), x1 = Math.min(n - 1, Math.ceil(Math.max(...u) + 2), clip ? clip[2] : n - 1);
  const y0 = Math.max(0, Math.floor(Math.min(...v) - 2), clip ? clip[1] : 0), y1 = Math.min(n - 1, Math.ceil(Math.max(...v) + 2), clip ? clip[3] : n - 1);
  const o = t * 9;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const b0 = ((u[1] - px) * (v[2] - py) - (u[2] - px) * (v[1] - py)) / area;
    const b1 = ((u[2] - px) * (v[0] - py) - (u[0] - px) * (v[2] - py)) / area;
    const b2 = 1 - b0 - b1;
    if (b0 < -tol[0] || b1 < -tol[1] || b2 < -tol[2]) continue;
    const x3 = b0 * pos[o] + b1 * pos[o + 3] + b2 * pos[o + 6];
    const y3 = b0 * pos[o + 1] + b1 * pos[o + 4] + b2 * pos[o + 7];
    const z3 = b0 * pos[o + 2] + b1 * pos[o + 5] + b2 * pos[o + 8];
    const i = y * n + x, a = w(x3, y3, z3, i);
    if (a > 0 && mark(i, a)) write?.(x3, y3, z3, i);
  }
}

/** Lay the weighted texels into the active layer (paint over, or erase), inside the selection, then refresh the composite there. */
function lay(s: TexSet, b: Brush, compositeNow = true) {
  const l = s.layers[s.active], n = s.size, m = s.sel, channels = Object.keys(b.values) as Channel[];
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
  if (x1 >= 0) {
    if (compositeNow) composite(s, x0, y0, x1, y1, channels, false);
    else {
      const d = s.dirty;
      s.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
    }
  }
}

interface TriGrid { cell: number; ox: number; oy: number; oz: number; map: Map<number, number[]>; big: number[]; seen: Uint32Array; stamp: number }
const grids = new WeakMap<object, TriGrid | null>();
const cellKey = (x: number, y: number, z: number) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
/** A triangle hash over the part's world-space bounds: a dab asks only the cells its sphere touches instead of
 *  walking every triangle of a dense mesh. Built once per positions array, small parts keep the simple loop. */
function triGrid(pos: ArrayLike<number>): TriGrid | null {
  const tris = pos.length / 9;
  if (tris < 8000) return null;
  const cache = grids.get(pos as unknown as object);
  if (cache !== undefined) return cache;
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const cell = Math.max(Math.hypot(maxx - minx, maxy - miny, maxz - minz) / 96, 1e-6);
  const g: TriGrid = { cell, ox: minx - cell, oy: miny - cell, oz: minz - cell, map: new Map(), big: [], seen: new Uint32Array(tris), stamp: 0 };
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const x0 = Math.floor((Math.min(pos[o], pos[o + 3], pos[o + 6]) - g.ox) / cell), x1 = Math.floor((Math.max(pos[o], pos[o + 3], pos[o + 6]) - g.ox) / cell);
    const y0 = Math.floor((Math.min(pos[o + 1], pos[o + 4], pos[o + 7]) - g.oy) / cell), y1 = Math.floor((Math.max(pos[o + 1], pos[o + 4], pos[o + 7]) - g.oy) / cell);
    const z0 = Math.floor((Math.min(pos[o + 2], pos[o + 5], pos[o + 8]) - g.oz) / cell), z1 = Math.floor((Math.max(pos[o + 2], pos[o + 5], pos[o + 8]) - g.oz) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 64) { g.big.push(t); continue; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = cellKey(x, y, z), list = g.map.get(k);
      if (list) list.push(t); else g.map.set(k, [t]);
    }
  }
  grids.set(pos as unknown as object, g);
  return g;
}
/** Triangles whose bounds can touch the sphere; null means "walk them all" (a small part). */
function nearTris(g: TriGrid, cx: number, cy: number, cz: number, r: number): number[] {
  const out: number[] = [], stamp = ++g.stamp;
  const push = (t: number) => { if (g.seen[t] !== stamp) { g.seen[t] = stamp; out.push(t); } };
  for (const t of g.big) push(t);
  const x0 = Math.floor((cx - r - g.ox) / g.cell), x1 = Math.floor((cx + r - g.ox) / g.cell);
  const y0 = Math.floor((cy - r - g.oy) / g.cell), y1 = Math.floor((cy + r - g.oy) / g.cell);
  const z0 = Math.floor((cz - r - g.oz) / g.cell), z1 = Math.floor((cz + r - g.oz) / g.cell);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    const list = g.map.get(cellKey(x, y, z));
    if (list) for (const t of list) push(t);
  }
  return out;
}
function forNear(pos: ArrayLike<number>, x: number, y: number, z: number, r: number, fn: (t: number) => void) {
  const g = triGrid(pos);
  if (g) { for (const t of nearTris(g, x, y, z, r)) fn(t); return; }
  const tris = pos.length / 9, r2 = r;
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    if (Math.min(pos[o], pos[o + 3], pos[o + 6]) <= x + r2 && Math.max(pos[o], pos[o + 3], pos[o + 6]) >= x - r2 &&
      Math.min(pos[o + 1], pos[o + 4], pos[o + 7]) <= y + r2 && Math.max(pos[o + 1], pos[o + 4], pos[o + 7]) >= y - r2 &&
      Math.min(pos[o + 2], pos[o + 5], pos[o + 8]) <= z + r2 && Math.max(pos[o + 2], pos[o + 5], pos[o + 8]) >= z - r2) fn(t);
  }
}
/** The UV bounds a world-space dab can touch on one triangle, so `raster` does not visit a large triangle's
 *  whole UV box for a small brush. */
function brushClip(n: number, pos: ArrayLike<number>, uvs: ArrayLike<number>, t: number, u: number, v: number, rWorld: number): [number, number, number, number] | undefined {
  const o = t * 9, uo = t * 6;
  // Only clip in the UV neighbourhood the pointer is actually in; a triangle across a seam lives somewhere
  // else in the atlas and must keep its whole box (the world dab still reaches it).
  const u0 = Math.min(uvs[uo], uvs[uo + 2], uvs[uo + 4]), u1 = Math.max(uvs[uo], uvs[uo + 2], uvs[uo + 4]);
  const v0 = Math.min(uvs[uo + 1], uvs[uo + 3], uvs[uo + 5]), v1 = Math.max(uvs[uo + 1], uvs[uo + 3], uvs[uo + 5]);
  if (u < u0 - 0.02 || u > u1 + 0.02 || v < v0 - 0.02 || v > v1 + 0.02) return undefined;
  let scale = 0;
  for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
    const wl = Math.hypot(pos[o + b * 3] - pos[o + a * 3], pos[o + b * 3 + 1] - pos[o + a * 3 + 1], pos[o + b * 3 + 2] - pos[o + a * 3 + 2]);
    const ul = Math.hypot(uvs[uo + b * 2] - uvs[uo + a * 2], uvs[uo + b * 2 + 1] - uvs[uo + a * 2 + 1]);
    if (wl > 1e-9) scale = Math.max(scale, (ul * n) / wl);
  }
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  const rad = rWorld * scale * 1.35 + 3, cx = u * n, cy = v * n;
  if (rad > n * 2) return undefined;
  return [Math.floor(cx - rad), Math.floor(cy - rad), Math.ceil(cx + rad), Math.ceil(cy + rad)];
}
/** One dab of the brush at world point `at`. */
export function dab(s: TexSet, pos: ArrayLike<number>, uvs: ArrayLike<number>, at: number[], b: Brush, uv?: [number, number], batch = false) {
  ensureShell(s, uvs);
  ready(s.size);
  const [px, py, pz] = at, r = b.radius, hard = Math.min(0.99, b.hardness);
  forNear(pos, px, py, pz, r, (t) => raster(s.size, pos, uvs, t, (x, y, z) => tipAlpha(b.tip, (x - px) / r, (y - py) / r, (z - pz) / r, x, y, z, r, b.flow, hard)));
  lay(s, b, !batch);
}
const grain = (x: number, y: number, z: number) => { const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return n - Math.floor(n); };
/** A brush dab's coverage at local offset (dx, dy, dz) / radius: round or square silhouette, then chalk, spray or ring. */
function tipAlpha(tip: BrushTip | undefined, dx: number, dy: number, dz: number, wx: number, wy: number, wz: number, r: number, flow: number, hard: number) {
  const d = tip === 'square' ? Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) : Math.hypot(dx, dy, dz);
  if (d >= 1) return 0;
  let a = d <= hard ? 1 : 1 - (d - hard) / (1 - hard);
  if (tip === 'chalk') a *= 0.35 + 0.65 * grain(wx / (r * 0.18), wy / (r * 0.18), wz / (r * 0.18));
  else if (tip === 'spray') a *= grain(wx / (r * 0.09), wy / (r * 0.09), wz / (r * 0.09)) > 0.55 ? 1 : 0;
  else if (tip === 'ring') a *= Math.max(0, 1 - Math.abs(d - 0.72) / 0.28);
  return a * flow;
}

/** One dab in the texture view: a circle `r` texels round UV (u, v). */
export function dabUV(s: TexSet, u: number, v: number, r: number, b: Brush, batch = false) {
  ready(s.size);
  const n = s.size, cx = u * n, cy = v * n, hard = Math.min(0.99, b.hardness);
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.ceil(cx + r)); x++)
      mark(y * n + x, tipAlpha(b.tip, (x + 0.5 - cx) / r, (y + 0.5 - cy) / r, 0, x, y, 0, r, b.flow, hard));
  lay(s, b, !batch);
}

/** Every triangle in `tris` painted solid (the Bucket), inside the selection. */
export function fillTris(s: TexSet, pos: ArrayLike<number>, uvs: ArrayLike<number>, tris: Iterable<number>, b: Brush) {
  ensureShell(s, uvs);
  ready(s.size);
  for (const t of tris) raster(s.size, pos, uvs, t, () => 1);
  lay(s, b);
  if (s.dirty) setUndoRect(s, s.dirty);
  bleedAll(s);
}
/** The whole active layer painted solid inside the selection (Fill; with `erase`, Delete), empty texture space too,
 *  so mipmaps don't pull white in. */
export function fillAll(s: TexSet, b: Brush) {
  ready(s.size);
  for (let i = 0; i < s.size * s.size; i++) mark(i, 1);
  lay(s, b);
  if (s.dirty) setUndoRect(s, s.dirty);
  bleedAll(s);
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
  keepSelection(s);
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
  keepSelection(s);
  s.sel = s.sel ? s.sel.map((x) => 255 - x) : new Uint8Array(s.size * s.size);
  shade(s);
}
/** Photoshop's Select › Modify › Expand / Contract: the selection grown (`by` > 0) or shrunk by |by| texels, a square
 *  max / min filter. Growing stays on the surface (`shell`); shrinking treats empty texture as selected, so only the
 *  selection's own border moves in, not every UV border. */
// ponytail: texel space, so a grow stops at a UV seam; walk the mesh across seams if that bites
export function growSelection(s: TexSet, by: number, uvs: ArrayLike<number>) {
  if (!s.sel || !by) return;
  ensureShell(s, uvs);
  const shell = s.shell;
  const n = s.size, r = Math.abs(by), grow = by > 0, pick = grow ? Math.max : Math.min;
  const src = s.sel.slice();
  if (!grow && shell) for (let i = 0; i < src.length; i++) if (!shell[i]) src[i] = 255;
  const pass = (a: Uint8Array, dx: number, dy: number) => {
    const out = new Uint8Array(a.length);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let v = a[y * n + x];
      for (let k = 1; k <= r; k++) {
        const x0 = x - k * dx, y0 = y - k * dy, x1 = x + k * dx, y1 = y + k * dy;
        if (x0 >= 0 && y0 >= 0) v = pick(v, a[y0 * n + x0]); else if (!grow) v = 0;
        if (x1 < n && y1 < n) v = pick(v, a[y1 * n + x1]); else if (!grow) v = 0;
      }
      out[y * n + x] = v;
    }
    return out;
  };
  const next = pass(pass(src, 1, 0), 0, 1);
  if (shell) for (let i = 0; i < next.length; i++) if (!shell[i]) next[i] = 0;
  keepSelection(s);
  s.sel = next;
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

/** `surfaceOf` for the bake: yields to the UI every 512 triangles, so a 100k-triangle part does not freeze
 *  the editor while its per-texel surface is built. */
export async function surfaceOfAsync(n: number, pos: ArrayLike<number>, uvs: ArrayLike<number>): Promise<Surface> {
  ready(n);
  const P = new Float32Array(n * n * 3), N = new Float32Array(n * n * 3), has = new Uint8Array(n * n);
  const tris = pos.length / 9;
  for (let t = 0; t < tris; t++) {
    const o = t * 9, ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2], vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    raster(n, pos, uvs, t, (x, y, z, i) => { P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z; N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz; has[i] = 1; return 1; });
    if ((t & 255) === 255) await new Promise((ok) => setTimeout(ok, 0));
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
  const n = s.size, values: Partial<Record<Channel, number[]>> = { color: [1, 3, 5].map((k) => parseInt(g.color.slice(k, k + 2), 16)), rough: [g.rough * 255], metal: [g.metal * 255] };
  const cover = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) cover[i] = b.has[i] ? genAt(g, b, i) * (g.clip ? g.clip[i] / 255 : 1) : 0;
  for (const ch of s.channels) {
    const vals = values[ch];
    if (!vals) continue; // a generator has no normal/height values
    const k = CHANNELS[ch].k, px = (l.px[ch] ??= new Uint8ClampedArray(n * n * (k + 1)));
    for (let i = 0; i < n * n; i++) { for (let c = 0; c < k; c++) px[i * (k + 1) + c] = vals[c]; px[i * (k + 1) + k] = cover[i] * 255; }
  }
}

// ---- fill layers: a PBR material projected onto the mesh, baked into the layer's channel buffers ----
/** Bilinear sample with repeat, row 0 at the top as images store it; returns a shared 4-byte array. */
const sampleOut = [0, 0, 0, 0];
function sampleMap(m: MapPixels, u: number, v: number) {
  const w = m.width, h = m.height;
  const fu = u - Math.floor(u), fv = v - Math.floor(v);
  let x = fu * w - 0.5, y = (1 - fv) * h - 0.5;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  x0 = ((x0 % w) + w) % w; x1 = ((x1 % w) + w) % w; y0 = ((y0 % h) + h) % h; y1 = ((y1 % h) + h) % h;
  const d = m.data, a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, e = (y1 * w + x1) * 4;
  for (let k = 0; k < 4; k++) sampleOut[k] = (d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy;
  return sampleOut;
}
const hexTint = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
function fillBuf(s: TexSet, l: PaintLayer, ch: Channel) {
  const k = CHANNELS[ch].k;
  return (l.px[ch] ??= new Uint8ClampedArray(s.size * s.size * (k + 1)));
}

/** Bake a fill layer from `src`: every texel takes the material's maps through `f.projection`. UV is per island
 *  (repeats inside the packed atlas); tri-planar projects in world space, seamless across islands. */
export function bakeFill(s: TexSet, l: PaintLayer, src: MaterialPixels, pos: ArrayLike<number>, uvs: ArrayLike<number>, span: number) {
  const f = l.fill;
  if (!f) return;
  ensureShell(s, uvs);
  const n = s.size;
  for (const ch of Object.keys(l.px) as Channel[]) if (!f.channels.includes(ch)) delete l.px[ch];
  const buf: Partial<Record<Channel, Uint8ClampedArray>> = {};
  for (const ch of f.channels) buf[ch] = fillBuf(s, l, ch);
  const tint = hexTint(f.tint), strength = f.normalStrength;
  // a solid fill has no maps: its colour is the tint; a material missing its colour map is unpainted grey
  const plain = f.asset === SOLID ? [255, 255, 255] : CHANNELS.color.base;
  const color = src.basecolor, normalMap = src.normal, rough = src.roughness, metal = src.metallic, height = src.height;
  const roughV = (u: number, v: number) => f.roughness != null ? f.roughness * 255 : rough ? sampleMap(rough, u, v)[0] : CHANNELS.rough.base[0];
  const metalV = (u: number, v: number) => f.metallic != null ? f.metallic * 255 : metal ? sampleMap(metal, u, v)[0] : 0;

  const writeUV = (i: number, u: number, v: number) => {
    if (buf.color) { const k = CHANNELS.color.k, px = buf.color; if (color) { const q = sampleMap(color, u, v); for (let c = 0; c < 3; c++) px[i * (k + 1) + c] = Math.min(255, q[c] * tint[c] / 255); } else for (let c = 0; c < 3; c++) px[i * (k + 1) + c] = Math.min(255, plain[c] * tint[c] / 255); px[i * (k + 1) + k] = 255; }
    if (buf.rough) { const px = buf.rough; px[i * 2] = roughV(u, v); px[i * 2 + 1] = 255; }
    if (buf.metal) { const px = buf.metal; px[i * 2] = metalV(u, v); px[i * 2 + 1] = 255; }
    if (buf.height) { const px = buf.height; px[i * 2] = height ? sampleMap(height, u, v)[0] : CHANNELS.height.base[0]; px[i * 2 + 1] = 255; }
    if (buf.normal) {
      const px = buf.normal;
      if (normalMap) {
        const q = sampleMap(normalMap, u, v);
        const dx = (q[0] / 127.5 - 1) * strength, dy = (q[1] / 127.5 - 1) * strength;
        const dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
        px[i * 4] = (dx * 0.5 + 0.5) * 255; px[i * 4 + 1] = (dy * 0.5 + 0.5) * 255; px[i * 4 + 2] = (dz * 0.5 + 0.5) * 255;
      } else { px[i * 4] = 128; px[i * 4 + 1] = 128; px[i * 4 + 2] = 255; }
      px[i * 4 + 3] = 255;
    }
  };

  if (f.projection === 'uv') {
    const rad = (f.rotation * Math.PI) / 180, co = Math.cos(rad), si = Math.sin(rad);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = ((x + 0.5) / n - 0.5) * f.tiling, v = ((y + 0.5) / n - 0.5) * f.tiling;
      writeUV(y * n + x, u * co - v * si + 0.5 + f.offset[0], u * si + v * co + 0.5 + f.offset[1]);
    }
    return;
  }

  // Tri-planar: rasterise each triangle in UV, project its world position on the three planes. The mesh UV frame
  // converts the blended world normal back to tangent space, which is what the normal map texture stores.
  ready(n);
  const tiles = f.tiles / (span || 1), rad = (f.rotation * Math.PI) / 180, co = Math.cos(rad), si = Math.sin(rad);
  const planeOut = [0, 0, 0];
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const e1x = pos[o + 3] - ax, e1y = pos[o + 4] - ay, e1z = pos[o + 5] - az;
    const e2x = pos[o + 6] - ax, e2y = pos[o + 7] - ay, e2z = pos[o + 8] - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    // UV tangent frame of this triangle
    const du1 = uvs[t * 6 + 2] - uvs[t * 6], dv1 = uvs[t * 6 + 3] - uvs[t * 6 + 1];
    const du2 = uvs[t * 6 + 4] - uvs[t * 6], dv2 = uvs[t * 6 + 5] - uvs[t * 6 + 1];
    const det = du1 * dv2 - du2 * dv1;
    let tx = 0, ty = 0, tz = 0, bx = 0, by = 0, bz = 0;
    if (Math.abs(det) > 1e-12) {
      tx = (e1x * dv2 - e2x * dv1) / det; ty = (e1y * dv2 - e2y * dv1) / det; tz = (e1z * dv2 - e2z * dv1) / det;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      bx = ny * tz - nz * ty; by = nz * tx - nx * tz; bz = nx * ty - ny * tx;
      const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1; bx /= bl; by /= bl; bz /= bl;
    } else { tx = 1; bx = 0; by = 1; }
    const wx = Math.pow(Math.abs(nx), 4), wy = Math.pow(Math.abs(ny), 4), wz = Math.pow(Math.abs(nz), 4);
    const ws = wx + wy + wz || 1;
    raster(n, pos, uvs, t, (x, y, z, i) => {
      // rotate the projection around Y, then project on each plane
      const rx = x * co + z * si, rz = -x * si + z * co;
      const ux = rz * tiles + f.offset[0], vx = y * tiles + f.offset[1];
      const uy = rx * tiles + f.offset[0], vy = rz * tiles + f.offset[1];
      const uz = rx * tiles + f.offset[0], vz = y * tiles + f.offset[1];
      if (buf.color) {
        const k = CHANNELS.color.k, px = buf.color;
        let r = 0, g = 0, b = 0;
        if (color) {
          let q = sampleMap(color, ux, vx); r += q[0] * wx; g += q[1] * wx; b += q[2] * wx;
          q = sampleMap(color, uy, vy); r += q[0] * wy; g += q[1] * wy; b += q[2] * wy;
          q = sampleMap(color, uz, vz); r += q[0] * wz; g += q[1] * wz; b += q[2] * wz;
          r /= ws; g /= ws; b /= ws;
        } else { [r, g, b] = plain; }
        px[i * (k + 1)] = Math.min(255, r * tint[0] / 255); px[i * (k + 1) + 1] = Math.min(255, g * tint[1] / 255); px[i * (k + 1) + 2] = Math.min(255, b * tint[2] / 255); px[i * (k + 1) + k] = 255;
      }
      if (buf.rough) { const px = buf.rough, q1 = roughV(ux, vx), q2 = roughV(uy, vy), q3 = roughV(uz, vz); px[i * 2] = (q1 * wx + q2 * wy + q3 * wz) / ws; px[i * 2 + 1] = 255; }
      if (buf.metal) { const px = buf.metal, q1 = metalV(ux, vx), q2 = metalV(uy, vy), q3 = metalV(uz, vz); px[i * 2] = (q1 * wx + q2 * wy + q3 * wz) / ws; px[i * 2 + 1] = 255; }
      if (buf.height) { const px = buf.height, q1 = height ? sampleMap(height, ux, vx)[0] : 128, q2 = height ? sampleMap(height, uy, vy)[0] : 128, q3 = height ? sampleMap(height, uz, vz)[0] : 128; px[i * 2] = (q1 * wx + q2 * wy + q3 * wz) / ws; px[i * 2 + 1] = 255; }
      if (buf.normal) {
        const px = buf.normal;
        let wnx = 0, wny = 0, wnz = 0;
        const add = (plane: 0 | 1 | 2, weight: number, u: number, v: number) => {
          if (!normalMap || weight <= 0) return;
          const q = sampleMap(normalMap, u, v);
          let dx = (q[0] / 127.5 - 1) * strength, dy = (q[1] / 127.5 - 1) * strength;
          const dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
          const sign = (plane === 0 ? nx : plane === 1 ? ny : nz) >= 0 ? 1 : -1;
          let pnx = 0, pny = 0, pnz = 0, ptx = 0, pty = 0, ptz = 0;
          if (plane === 0) { pnx = sign; ptz = 1; } else if (plane === 1) { pny = sign; ptx = 1; } else { pnz = sign; ptx = 1; }
          const pbx = pny * ptz - pnz * pty, pby = pnz * ptx - pnx * ptz, pbz = pnx * pty - pny * ptx;
          planeOut[0] = ptx * dx + pbx * dy + pnx * dz;
          planeOut[1] = pty * dx + pby * dy + pny * dz;
          planeOut[2] = ptz * dx + pbz * dy + pnz * dz;
          wnx += planeOut[0] * weight; wny += planeOut[1] * weight; wnz += planeOut[2] * weight;
        };
        add(0, wx / ws, ux, vx); add(1, wy / ws, uy, vy); add(2, wz / ws, uz, vz);
        if (!normalMap || (wx + wy + wz) === 0) { px[i * 4] = 128; px[i * 4 + 1] = 128; px[i * 4 + 2] = 255; }
        else {
          const l = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz) || 1;
          wnx /= l; wny /= l; wnz /= l;
          const dx = wnx * tx + wny * ty + wnz * tz, dy = wnx * bx + wny * by + wnz * bz, dz = wnx * nx + wny * ny + wnz * nz;
          const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          px[i * 4] = ((dx / dl) * 0.5 + 0.5) * 255; px[i * 4 + 1] = ((dy / dl) * 0.5 + 0.5) * 255; px[i * 4 + 2] = ((dz / dl) * 0.5 + 0.5) * 255;
        }
        px[i * 4 + 3] = 255;
      }
      return 1;
    });
  }
  for (const i of touched) weight[i] = 0;
  touched.length = 0;
}

/** Bilinear decal sample, clamped (a decal does not tile), returning premultiplied-safe RGB and alpha. */
const decalSample = [0, 0, 0, 0];
function sampleDecal(m: MapPixels, u: number, v: number) {
  const w = m.width, h = m.height;
  const x = u * w - 0.5, y = (1 - v) * h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cl = (n: number, max: number) => Math.max(0, Math.min(max, n));
  const xa = cl(x0, w - 1), xb = cl(x0 + 1, w - 1), ya = cl(y0, h - 1), yb = cl(y0 + 1, h - 1);
  let r = 0, g = 0, b = 0, a = 0;
  for (const [xx, yy, wt] of [[xa, ya, (1 - fx) * (1 - fy)], [xb, ya, fx * (1 - fy)], [xa, yb, (1 - fx) * fy], [xb, yb, fx * fy]] as const) {
    const o = (yy * w + xx) * 4, al = m.data[o + 3] / 255 * wt;
    r += m.data[o] * al; g += m.data[o + 1] * al; b += m.data[o + 2] * al; a += al;
  }
  if (a > 1e-6) { r /= a; g /= a; b /= a; }
  decalSample[0] = r; decalSample[1] = g; decalSample[2] = b; decalSample[3] = a * 255;
  return decalSample;
}

/** Bake a placed decal into a layer. A decal is a flat projector at `center`, tangent to the surface and
 *  facing along `normal`; only front-facing triangles within the projector's depth take ink. That keeps a
 *  mark from bleeding round the back of a slide or down the sides of a grip. */
export function bakeDecal(s: TexSet, l: PaintLayer, src: MapPixels, pos: ArrayLike<number>, uvs: ArrayLike<number>, span: number) {
  const d = l.decal;
  if (!d) return;
  ensureShell(s, uvs);
  const n = s.size;
  const [cx, cy, cz] = d.center;
  let [nx, ny, nz] = d.normal;
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  // Re-orthogonalise the stored up vector against the normal, then make the right vector. Text is upright
  // when the decal is placed on a vertical face, which is how the reference markings read.
  let [vx, vy, vz] = d.up;
  const vd = vx * nx + vy * ny + vz * nz;
  vx -= nx * vd; vy -= ny * vd; vz -= nz * vd;
  let vl = Math.hypot(vx, vy, vz);
  if (vl < 1e-6) { vx = 1; vy = 0; vz = 0; vl = 1; }
  vx /= vl; vy /= vl; vz /= vl;
  let ux = vy * nz - vz * ny, uy = vz * nx - vx * nz, uz = vx * ny - vy * nx;
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const rad = (d.rotation * Math.PI) / 180, co = Math.cos(rad), si = Math.sin(rad);
  const uxr = ux * co + vx * si, uyr = uy * co + vy * si, uzr = uz * co + vz * si;
  const vxr = -ux * si + vx * co, vyr = -uy * si + vy * co, vzr = -uz * si + vz * co;
  const width = Math.max(d.width, 1e-5), height = width / Math.max(d.aspect, 1e-4);
  const depth = Math.max(width * 0.55, span * 0.012);
  for (const ch of Object.keys(l.px) as Channel[]) if (!d.channels.includes(ch)) delete l.px[ch];
  const buf: Partial<Record<Channel, Uint8ClampedArray>> = {};
  const eng = Math.max(0, d.engrave ?? 0);
  for (const ch of d.channels) if (ch === 'color' || ch === 'rough' || ch === 'metal' || (eng > 0 && (ch === 'normal' || ch === 'height'))) buf[ch] = fillBuf(s, l, ch);
  for (const b of Object.values(buf)) b.fill(0);
  if (!buf.color) return;
  const tint = hexTint(d.tint), rough = d.roughness * 255, metal = d.metallic * 255;
  const color = buf.color, rc = buf.rough, mt = buf.metal, nm = buf.normal, ht = buf.height;
  // engraving: the ink's edge tilts the normal as a cut would (height = -ink), slope from the ink's gradient
  const hu = 1.5 / src.width, hv = 1.5 / src.height, slope = eng * 3;
  const ink = (u: number, v: number) => sampleDecal(src, d.flipH ? 1 - u : u, d.flipV ? 1 - v : v)[3] / 255;
  let sr = 0, sg = 0, sb = 0, sa = 0, gx = 0, gy = 0, cut = false;
  let tx = 1, ty = 0, tz = 0, bx = 0, by = 1, bz = 0;
  ready(n);
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const e1x = pos[o + 3] - ax, e1y = pos[o + 4] - ay, e1z = pos[o + 5] - az;
    const e2x = pos[o + 6] - ax, e2y = pos[o + 7] - ay, e2z = pos[o + 8] - az;
    let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    if (fx * nx + fy * ny + fz * nz < 0.12) continue; // a mark only lands on surface facing the projector
    if (eng > 0) {
      // the triangle's tangent frame as the engine's Mesh has it: T from the UVs, B = N × T
      const du1 = uvs[t * 6 + 2] - uvs[t * 6], dv1 = uvs[t * 6 + 3] - uvs[t * 6 + 1], du2 = uvs[t * 6 + 4] - uvs[t * 6], dv2 = uvs[t * 6 + 5] - uvs[t * 6 + 1];
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) > 1e-12) {
        tx = (e1x * dv2 - e2x * dv1) / det; ty = (e1y * dv2 - e2y * dv1) / det; tz = (e1z * dv2 - e2z * dv1) / det;
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      } else { tx = 1; ty = 0; tz = 0; }
      bx = fy * tz - fz * ty; by = fz * tx - fx * tz; bz = fx * ty - fy * tx;
    }
    raster(n, pos, uvs, t, (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const along = dx * nx + dy * ny + dz * nz;
      if (Math.abs(along) > depth) return 0;
      const u = (dx * uxr + dy * uyr + dz * uzr) / width + 0.5;
      const v = (dx * vxr + dy * vyr + dz * vzr) / height + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      const q = sampleDecal(src, d.flipH ? 1 - u : u, d.flipV ? 1 - v : v);
      sa = q[3] / 255;
      cut = false;
      if (eng > 0) {
        const gu = ink(u + hu, v) - ink(u - hu, v), gv = ink(u, v + hv) - ink(u, v - hv);
        cut = Math.abs(gu) + Math.abs(gv) > 1e-3;
        // world tilt along the decal's axes, then into the triangle's tangent space
        const wx = (gu * uxr + gv * vxr) * slope, wy = (gu * uyr + gv * vyr) * slope, wz = (gu * uzr + gv * vzr) * slope;
        gx = wx * tx + wy * ty + wz * tz; gy = wx * bx + wy * by + wz * bz;
      }
      if (sa <= 0 && !cut) return 0;
      sr = Math.min(255, q[0] * tint[0] / 255); sg = Math.min(255, q[1] * tint[1] / 255); sb = Math.min(255, q[2] * tint[2] / 255);
      return cut ? 1 : sa;
    }, undefined, (_x, _y, _z, i) => {
      color[i * 4] = sr; color[i * 4 + 1] = sg; color[i * 4 + 2] = sb; color[i * 4 + 3] = sa * 255;
      if (rc) { rc[i * 2] = rough; rc[i * 2 + 1] = sa * 255; }
      if (mt) { mt[i * 2] = metal; mt[i * 2 + 1] = sa * 255; }
      if (nm && cut) {
        const l2 = Math.min(0.95, gx * gx + gy * gy), k = l2 > 0 ? Math.sqrt(l2 / (gx * gx + gy * gy)) : 0;
        const ex = gx * k, ey = gy * k, ez = Math.sqrt(1 - ex * ex - ey * ey);
        nm[i * 4] = (ex * 0.5 + 0.5) * 255; nm[i * 4 + 1] = (ey * 0.5 + 0.5) * 255; nm[i * 4 + 2] = (ez * 0.5 + 0.5) * 255; nm[i * 4 + 3] = 255;
      }
      if (ht && sa > 0) { ht[i * 2] = 128 - 64 * eng; ht[i * 2 + 1] = sa * 255; }
    });
  }
  for (const i of touched) weight[i] = 0;
  touched.length = 0;
}

/** A fill layer's mask, white where nothing has been painted yet. */
function maskOf(s: TexSet, l: PaintLayer) {
  return (l.mask ??= new Uint8Array(s.size * s.size).fill(255));
}
/** Paint a fill layer's mask on the model: Brush adds, Eraser takes away. */
export function maskDab(s: TexSet, l: PaintLayer, pos: ArrayLike<number>, uvs: ArrayLike<number>, at: number[], b: Brush, uv?: [number, number]) {
  ready(s.size);
  const [px, py, pz] = at, r = b.radius, hard = Math.min(0.99, b.hardness);
  forNear(pos, px, py, pz, r, (t) => raster(s.size, pos, uvs, t, (x, y, z) => tipAlpha(b.tip, (x - px) / r, (y - py) / r, (z - pz) / r, x, y, z, r, b.flow, hard)));
  const m = maskOf(s, l);
  let x0 = s.size, y0 = s.size, x1 = -1, y1 = -1;
  for (const i of touched) {
    const w = weight[i]; m[i] = b.erase ? m[i] * (1 - w) : m[i] + (255 - m[i]) * w; weight[i] = 0;
    const x = i % s.size, y = (i / s.size) | 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  touched.length = 0;
  if (x1 >= 0) composite(s, x0, y0, x1, y1, undefined, false);
}
/** Paint a fill layer's mask in the texture view. */
export function maskDabUV(s: TexSet, l: PaintLayer, u: number, v: number, r: number, b: Brush) {
  ready(s.size);
  const n = s.size, cx = u * n, cy = v * n, hard = Math.min(0.99, b.hardness);
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.ceil(cx + r)); x++)
      mark(y * n + x, tipAlpha(b.tip, (x + 0.5 - cx) / r, (y + 0.5 - cy) / r, 0, x, y, 0, r, b.flow, hard));
  const m = maskOf(s, l);
  let x0 = n, y0 = n, x1 = -1, y1 = -1;
  for (const i of touched) {
    const w = weight[i]; m[i] = b.erase ? m[i] * (1 - w) : m[i] + (255 - m[i]) * w; weight[i] = 0;
    const x = i % n, y = (i / n) | 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  touched.length = 0;
  if (x1 >= 0) composite(s, x0, y0, x1, y1, undefined, false);
}
/** White or black the whole mask (a fill layer with no mask is white). */
export function maskFill(s: TexSet, l: PaintLayer, value: number) { maskOf(s, l).fill(value); }
/** Fill (or clear) the mask inside the selection; outside it stays as it was. */
export function maskSelection(s: TexSet, l: PaintLayer, erase: boolean) {
  const m = maskOf(s, l), v = erase ? 0 : 255;
  if (!s.sel) m.fill(v);
  else for (let i = 0; i < m.length; i++) if (s.sel[i]) m[i] = v;
}
export function maskInvert(s: TexSet, l: PaintLayer) { const m = maskOf(s, l); for (let i = 0; i < m.length; i++) m[i] = 255 - m[i]; }

/** A channel's composite (or the selection's shade) as a canvas, top row v = 1 as images have it, for the texture view
 *  and export; kept until the set changes. */
/** What the texture view shows: the material view (`matview.ts`), a channel, or a baked map. */
export type Shown = 'material' | Channel | 'ao' | 'curv';
const shots = new WeakMap<TexSet, Record<string, { ver: number; cv: HTMLCanvasElement }>>();
export function canvasOf(s: TexSet, ch: Exclude<Shown, 'material'> | 'shade', size = s.size) {
  const key = size === s.size ? ch : `${ch}@${size}`;
  const all = shots.get(s) ?? {}, hit = all[key];
  if (hit?.ver === s.ver) return hit.cv;
  const n = size, S = s.size, cv = hit?.cv ?? document.createElement('canvas');
  cv.width = cv.height = n;
  const img = new ImageData(n, n);
  const src = (ch === 'color' ? s.color : ch === 'shade' ? s.shade : ch === 'ao' && s.aoTex ? s.aoTex : ch === 'normal' ? s.normal : ch === 'height' ? s.height : s.orm).image.data as Uint8ClampedArray
    , g = ch === 'rough' ? 1 : 2;
  const b = s.bake, band = (d: number) => Math.max(0, 1 - d / (0.01 * b!.span));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = Math.min(S - 1, Math.floor((x / n) * S)), sy = Math.min(S - 1, Math.floor(((n - 1 - y) / n) * S));
    const i = (sy * S + sx) * 4, o = (y * n + x) * 4;
    // curvature as Substance draws it: grey, convex edges light, concave ones dark (a band 1% of the model wide)
    if (ch === 'curv') { const j = i / 4, v = b ? 128 + 127 * (band(b.convex[j]) - band(b.concave[j])) : 128; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255; }
    else if (ch === 'normal') img.data.set(src.subarray(i, i + 4), o);
    else if (ch === 'height') { const v = src[i]; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255; }
    else if (ch === 'color' || ch === 'shade' || ch === 'ao') img.data.set(src.subarray(i, i + 4), o);
    else { img.data[o] = img.data[o + 1] = img.data[o + 2] = src[i + g]; img.data[o + 3] = 255; }
  }
  cv.getContext('2d')!.putImageData(img, 0, 0);
  all[key] = { ver: s.ver, cv };
  shots.set(s, all);
  return cv;
}
export type TexturePreset = 'generic' | 'unreal' | 'unity-hdrp' | 'unity-urp';

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
