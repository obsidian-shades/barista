// Van Gogh's paint: per part a texture set (Substance's), its channels (Base Color, and with PBR Roughness and
// Metallic, glTF's metal/rough), a stack of layers as in Photoshop, each holding paint per channel with its own
// coverage, and a selection (Photoshop's): a mask per texel that paint, fills and erasing stay inside.
// A dab on the model is a sphere in world space: every texel whose point on the surface lies inside it takes the paint,
// found by rasterising the triangles near it in UV space, so a stroke carries across seams and keeps its size whatever
// the texel density. A dab in the texture view is a plain circle of texels. Either way each texel takes a dab once
// (the strongest weight), so triangle edges never show.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Baked, Surface } from './bake';
import type { MapKind, MapPixels, MaterialPixels } from './materials';
import { uvShell } from './uvshell.ts';
import { gpuComposite, gpuCompositeReady, MODES, type Group } from './gpucomp.ts';
import { BEVEL, FILL_OUT, GENERATOR, TRIPLANAR, UVFILL, cellTable, gpuBake, gpuBakeReady, hashu, mapTexture, rows } from './gpubake.ts';

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
/** A decal's relief maps, decoded (DECALmachine's: normal, ao_curv_height and masks). */
export interface ReliefPixels { normal: MapPixels; height: MapPixels; mask: MapPixels }
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
  /** A procedural relief instead of an image (grip textures): written to Normal and Height, and with 'color' in
   *  `channels` also painted: `tint` / `roughness` / `metallic` inside, `rim` on the border band (`onRim`). */
  shape?: Shape;
  /** A shape's border finish (absent: the same as inside). */
  rim?: { tint: string; roughness: number; metallic: number };
  /** Bend round the model: the relief follows the surface's own coordinates out from `center` (`expMap`) instead of a
   *  flat projection, so it carries over bevels and curves without stretching. */
  wrap?: boolean;
  /** A relief read from the decal's own maps (DECALmachine's): how strongly the normal map tilts (1 = as authored)
   *  and the height map's contrast. `bakeRelief` writes Normal and Height; the mark puts down no colour. */
  reliefNormal?: number;
  reliefHeight?: number;
}
/** A grip texture's fill: raised stipple dots, grooves across the panel, diamond checkering, or none (the border alone).
 *  The other reliefs: `pad` lifts the panel by `amount` (negative: pressed in) over a `border` wide edge; `fastener`
 *  is one screw / bolt / rivet head; and the line kinds run along the outline as a polyline (`closed` or open), `border`
 *  wide: `groove` cut `depth` deep, `bead` a weld `depth` high rippling by `amount` every `cell`, `stitch` thread
 *  dashes every `cell` in a channel `amount` deep, `rivets` a head every `cell`, `scratch` a V with burred lips whose
 *  depth wanders by `amount` every `cell`. */
export type Pattern = 'stipple' | 'grooves' | 'checker' | 'pyramid' | 'none' | 'pad' | 'fastener' | 'groove' | 'bead' | 'stitch' | 'rivets' | 'scratch';
/** A cross-section: a groove's, or a pad's edge. */
export type Profile = 'round' | 'v' | 'square' | 'chamfer';
/** A fastener's head: button dome, pan, countersunk flush, socket cap, hex bolt. */
export type Head = 'dome' | 'pan' | 'flat' | 'cap' | 'hexhead';
/** What's cut into the head. */
export type Drive = 'none' | 'slot' | 'phillips' | 'pozi' | 'torx' | 'hex' | 'square';
/** A relief drawn as a line on the model rather than placed as a panel. */
export const isLine = (p: Pattern) => p === 'groove' || p === 'bead' || p === 'stitch' || p === 'rivets' || p === 'scratch';
/** A relief panel: a rounded rectangle (`corner` radius), a groove `border` wide and `depth` deep round its edge, and
 *  `pattern` inside, one `cell` per repeat, `amount` high. All world units, so stretching the panel never stretches the
 *  dots. `shapeHeight` here and the engine's `shape_height` must agree. */
export interface Shape {
  pattern: Pattern; corner: number; border: number; depth: number; cell: number; amount: number;
  /** A free outline instead of the rectangle: corners in the panel's frame as shares of its half width / height (the
   *  rectangle is [-1,-1] [1,-1] [1,1] [-1,1]), each rounded by `corner`. */
  outline?: [number, number][];
  /** A line kind's polyline closes back to its first point. */
  closed?: boolean;
  /** A groove's cross-section or a pad's edge (round when absent). */
  profile?: Profile;
  /** A fastener's or a rivet row's head and drive, and a washer under it. */
  head?: Head; drive?: Drive; washer?: boolean;
}
/** The rectangle a shape is until its outline is edited. */
export const RECT_OUTLINE: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
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
export interface PaintLayer { id: number; name: string; visible: boolean; opacity: number; blend?: Partial<Record<Channel, BlendMode>>; px: Partial<Record<Channel, Uint8ClampedArray>>; gen?: Gen; fill?: Fill; decal?: Decal; bevel?: Bevel; mask?: Uint8Array; /** Per buffer, bumped when its pixels are written in place (a generator slider, a re-bake, a mask): a buffer's identity alone can't tell a save that its bytes moved. */ ver?: Partial<Record<Channel | 'mask' | 'clip', number>> }
export type GenKind = 'edge' | 'dirt' | 'ao';
/** A whole-part bevel faked in the normal map (Substance's / Blender's Bevel): within `radius` (world units) of an edge
 *  sharper than `angle` degrees the normal turns toward the face across it, so a hard-edged low poly shades rounded
 *  (`round`: a circular fillet's normals) or chamfered (`chamfer`: the halfway normal); concave edges too when `concave`. */
export interface Bevel { radius: number; profile: 'round' | 'chamfer'; angle: number; concave: boolean }
/** A generator (Substance's smart mask): `amount` how much it covers, `soft` how gradual its border, `width` the edge
 *  band (share of the model), `grunge` how much noise breaks it up, `scale` the noise's size (share of the model);
 *  `color` / `rough` / `metal` what it lays down; `clip` the selection it was made in. */
export interface Gen { kind: GenKind; amount: number; soft: number; width: number; grunge: number; scale: number; color: string; rough: number; metal: number; clip: Uint8Array | null }
/** `sel`: 0..255 per texel, null = no selection (paint goes anywhere). A new selection is always a new array. */
interface State { channels: Channel[]; layers: PaintLayer[]; active: number; sel: Uint8Array | null; undoRect?: [number, number, number, number]; bytes?: number }
/** The composite: `color` (sRGB) and `orm` (G roughness, B metallic, as three and glTF read them); `shade` darkens
 *  what's outside the selection; `normal` (tangent space, RGB) and `height` (R) are the extra PBR maps. */
export interface TexSet extends State { size: number; color: THREE.DataTexture; orm: THREE.DataTexture; shade: THREE.DataTexture; normal: THREE.DataTexture; height: THREE.DataTexture; past: State[]; future: State[]; ver: number; bake?: Baked; aoTex?: THREE.DataTexture; shell?: Uint8Array; shellFor?: unknown; cov?: Uint8Array; dirty?: [number, number, number, number]; preview?: THREE.Texture; /** Per composite tile, moved by every write to it (`stampTiles`): a save sends only the tiles that moved. */ stamp?: Uint32Array; /** A restored stack whose composite has not been made yet (cleared by a whole composite). */ unlaid?: boolean }
export type BrushTip = 'round' | 'square' | 'chalk' | 'spray' | 'ring';
export interface Brush { radius: number; flow: number; hardness: number; erase: boolean; tip?: BrushTip; values: Partial<Record<Channel, number[]>> }
export type SelOp = 'set' | 'add' | 'sub';

// keyed by the part's soup: a new model or a geometry edit starts a fresh set
// ponytail: painted texels stay where they were in UV space, so a re-unwrap of the part scrambles the paint; bake through
// the old UVs (or store paint per triangle) if that bites
const sets = new WeakMap<Float32Array, TexSet>();
/** Each set's soup, so `disposeSet` can unkey it (a set is otherwise only reachable through `setOf`). */
const soups = new WeakMap<TexSet, Float32Array>();
let ids = 0;

const tex = (size: number, srgb: boolean) => {
  const t = new THREE.DataTexture(new Uint8ClampedArray(size * size * 4), size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8;
  return t;
};
export const newLayer = (n: number): PaintLayer => ({ id: ++ids, name: `Layer ${n}`, visible: true, opacity: 1, px: {} });

/** The part's set, made (Base Color, one empty layer) the first time; changing the texture resolution resizes it. */
/** The part's set if it has one, without making it (Da Vinci shows an unpainted part plain). */
export const hasSet = (soup: Float32Array): TexSet | undefined => sets.get(soup);

export function setOf(soup: Float32Array, size: number): TexSet {
  let s = sets.get(soup);
  if (!s) {
    s = { size, channels: ['color'], layers: [newLayer(1)], active: 0, sel: null, color: tex(size, true), orm: tex(size, false), shade: tex(size, false), normal: tex(size, false), height: tex(size, false), past: [], future: [], ver: 0 };
    sets.set(soup, s);
    soups.set(s, soup);
    blank(s);
  } else if (s.size !== size) resize(s, size);
  return s;
}
/** What `composite` makes of a new set's one empty layer — the base values, nothing covered — written straight in: a
 *  GPU pass and its readback per new set cost an opening project ~100 ms a part, only to be composited over again. */
function blank(s: TexSet) {
  const fill = (t: THREE.DataTexture, [r, g, b]: number[]) => {
    new Uint32Array((t.image.data as Uint8ClampedArray).buffer).fill(((255 << 24) | (b << 16) | (g << 8) | r) >>> 0); // little-endian RGBA
    t.needsUpdate = true;
  };
  fill(s.color, CHANNELS.color.base);
  fill(s.orm, [255, CHANNELS.rough.base[0], CHANNELS.metal.base[0]]);
  s.cov = new Uint8Array(s.size * s.size);
  stampTiles(s, 0, 0, s.size - 1, s.size - 1);
  s.ver++;
}
let stamps = 0;
/** The composite's texels in a rectangle were written: their tiles' stamps move, so the next save sends those tiles.
 *  ponytail: one stamp per tile for all five maps, and a rewrite that leaves the bytes as they were still moves it; per-map
 *  stamps or a hash per tile if composite saves get heavy. */
function stampTiles(s: TexSet, x0: number, y0: number, x1: number, y1: number) {
  const t = Math.min(PAINT_TILE, s.size), m = s.size / t;
  if (s.stamp?.length !== m * m) s.stamp = new Uint32Array(m * m);
  for (let ty = Math.floor(y0 / t); ty <= Math.floor(y1 / t); ty++) for (let tx = Math.floor(x0 / t); tx <= Math.floor(x1 / t); tx++) s.stamp[ty * m + tx] = ++stamps;
}
/** The composite is exactly what the layers make, padding and all: made at least once over the whole stack (`unlaid`),
 *  nothing queued or running, no band left unpadded (`dirty`), no live GPU stroke. Only then may a save keep it. */
export function compSettled(s: TexSet) {
  const q = queues.get(s);
  return !s.unlaid && !s.dirty && !s.preview && !!s.cov && !(q && (q.running || q.full || q.rects.length));
}
/** The composite's maps as a project keeps them, under layer id 0: `comp_color` … `comp_cov`. */
export const compMaps = (s: TexSet) => [
  ['comp_color', s.color.image.data, 4], ['comp_orm', s.orm.image.data, 4], ['comp_normal', s.normal.image.data, 4],
  ['comp_height', s.height.image.data, 4], ['comp_cov', s.cov!, 1],
] as [CompMap, Uint8Array | Uint8ClampedArray, number][];
export type CompMap = 'comp_color' | 'comp_orm' | 'comp_normal' | 'comp_height' | 'comp_cov';

/** Free a set's textures and forget it: nothing will draw it again (the document it belongs to was replaced). A
 *  WebGL texture is only released by `dispose()`, never by its object being garbage collected. */
export function disposeSet(s: TexSet) {
  const soup = soups.get(s);
  soups.delete(s);
  if (soup && sets.get(soup) === s) sets.delete(soup);
  // the preview texture belongs to gpupaint's render target, which `gpuFinish()` disposes
  s.preview = undefined;
  for (const t of [s.color, s.orm, s.shade, s.normal, s.height, s.aoTex]) t?.dispose();
  s.bake = undefined;
}

/** A Poly Doc edit replaced the part's soup but kept its UVs (Recalculate Outside, a cut, Move): the paint is still in the
 *  right place in UV space, so the new soup takes the same set. The old soup keeps it too, so undo brings the part back
 *  painted. Without this the edit left every layer behind on the old soup and the part came back blank (and saved so). */
export function shareSet(from: Float32Array, to: Float32Array) {
  const s = sets.get(from);
  if (!s || sets.has(to)) return;
  sets.set(to, s);
  soups.set(s, to);
}

/** The part's set if it has one yet (saving a project must not make empty ones). */
export const setIfAny = (soup: Float32Array) => sets.get(soup) ?? null;
/** A layer's buffer was written in place: a project save reads this to know the buffer no longer holds what it wrote. */
function touch(l: PaintLayer | null | undefined, what: Channel | 'mask' | 'clip') {
  if (!l) return;
  const v = (l.ver ??= {});
  v[what] = (v[what] ?? 0) + 1;
}
/** A layer's stack entry as a project file keeps it (project.ts): everything but the pixels, which go as tiles. */
export type SavedLayer = Omit<PaintLayer, 'px' | 'mask' | 'gen' | 'ver'> & { gen?: Omit<Gen, 'clip'> & { clip: boolean }; mask: boolean; px: Channel[] };
export interface SavedSet { size: number; channels: Channel[]; active: number; layers: SavedLayer[]; /** The set has a selection mask saved under `set/<part>/0/sel`. */ sel?: boolean; /** Its composite is saved too (`compMaps`), so opening shows it without compositing the stack. */ comp?: boolean }
export const PAINT_TILE = 256;
/** `px` (n × n texels of `stride` bytes) as tiles of PAINT_TILE² texels, row by row; tiles whose last byte per texel (the
 *  coverage, or the whole value for a 1-byte mask) is 0 everywhere are left out. A sparse layer (a decal's footprint, a
 *  mask's edge) must not allocate a tile's bytes per tile just to drop them: one scratch tile is reused, and only the
 *  non-empty ones are copied out. */
type Px = ArrayLike<number> & { subarray(a: number, b: number): Uint8Array | Uint8ClampedArray };
export function tilesOf(px: Px, n: number, stride: number): { tx: number; ty: number; data: Uint8Array }[] {
  const t = Math.min(PAINT_TILE, n), out: { tx: number; ty: number; data: Uint8Array }[] = [], scratch = new Uint8Array(t * t * stride);
  for (let ty = 0; ty < n / t; ty++) for (let tx = 0; tx < n / t; tx++) {
    const data = tileAt(px, n, stride, tx, ty, scratch);
    if (data) out.push({ tx, ty, data });
  }
  return out;
}
/** One tile of `px` copied out, or null when it is empty (as `tilesOf` judges); `scratch` takes the copy-in. */
export function tileAt(px: Px, n: number, stride: number, tx: number, ty: number, scratch?: Uint8Array): Uint8Array | null {
  const t = Math.min(PAINT_TILE, n), into = scratch ?? new Uint8Array(t * t * stride);
  let any = false;
  for (let y = 0; y < t; y++) {
    const o = ((ty * t + y) * n + tx * t) * stride, row = px.subarray(o, o + t * stride);
    into.set(row, y * t * stride);
    if (!any) for (let i = stride - 1; i < row.length; i += stride) if (row[i]) { any = true; break; }
  }
  return any ? (scratch ? into.slice() : into) : null;
}
/** The other way: tiles back into one n × n buffer (missing tiles stay 0). */
export function fromTiles<T extends Uint8Array | Uint8ClampedArray>(into: T, n: number, stride: number, tiles: { tx: number; ty: number; data: Uint8Array }[]): T {
  const t = Math.min(PAINT_TILE, n);
  for (const { tx, ty, data } of tiles) for (let y = 0; y < t; y++) into.set(data.subarray(y * t * stride, (y + 1) * t * stride), ((ty * t + y) * n + tx * t) * stride);
  return into;
}
/** A part's set as a saved project had it: its stack, with `pixels(layer id, channel | 'mask' | 'clip' | 'sel', stride)`
 *  giving each buffer back (the selection is under layer id 0). Layer ids carry on past the highest one loaded. */
export function restoreSet(soup: Float32Array, saved: SavedSet, pixels: (id: number, what: Channel | 'mask' | 'clip' | 'sel' | CompMap, stride: number) => Uint8Array) {
  const s = setOf(soup, saved.size);
  s.channels = saved.channels;
  s.layers = saved.layers.map(({ px, mask, gen, ...l }) => ({
    ...l,
    px: Object.fromEntries(px.map((ch) => [ch, new Uint8ClampedArray(pixels(l.id, ch, CHANNELS[ch].k + 1).buffer)])),
    ...(mask ? { mask: pixels(l.id, 'mask', 1) } : {}),
    ...(gen ? { gen: { ...gen, clip: gen.clip ? pixels(l.id, 'clip', 1) : null } } : {}),
  }));
  s.active = Math.min(saved.active, s.layers.length - 1);
  s.sel = saved.sel ? pixels(0, 'sel', 1) : null;
  s.past = []; s.future = []; s.bake = undefined; s.aoTex = undefined;
  footprints.delete(s);
  ids = Math.max(ids, ...s.layers.map((l) => l.id));
  const n = s.size;
  // an older file may hold a decal under a material layer: its saved composite is of that order, so lay it again
  if (decalsLast(s)) saved = { ...saved, comp: undefined };
  if (saved.comp) {
    const [col, orm, nrm, hgt] = [s.color, s.orm, s.normal, s.height];
    for (const [t, what] of [[col, 'comp_color'], [orm, 'comp_orm'], [nrm, 'comp_normal'], [hgt, 'comp_height']] as const) {
      t.image.data = new Uint8ClampedArray(pixels(0, what, 4).buffer);
      t.needsUpdate = true;
    }
    s.cov = pixels(0, 'comp_cov', 1);
    s.dirty = undefined;
    s.unlaid = false;
  } else {
    // the caller lays the stack out (store `openProject` uses the banded `requestComposite`): a 4K set's full composite
    // here would hold the viewport for seconds while a project opens. Until then the composite is not the stack's.
    s.unlaid = true;
  }
  return s;
}
/** The set as a project saves it: the stack, and every pixel buffer to tile. `ver` moves when a buffer was written in
 *  place (project.ts keys its blobs by it, so a re-baked generator is not mistaken for the one already saved). */
export function saveSet(s: TexSet): { saved: SavedSet; buffers: { id: number; what: Channel | 'mask' | 'clip' | 'sel'; px: Uint8Array | Uint8ClampedArray; stride: number; ver: number }[] } {
  const buffers: { id: number; what: Channel | 'mask' | 'clip' | 'sel'; px: Uint8Array | Uint8ClampedArray; stride: number; ver: number }[] = [];
  const layers = s.layers.map(({ px, mask, gen, ver, ...l }): SavedLayer => {
    const stamp = ver ?? {};
    for (const ch of Object.keys(px) as Channel[]) buffers.push({ id: l.id, what: ch, px: px[ch]!, stride: CHANNELS[ch].k + 1, ver: stamp[ch] ?? 0 });
    if (mask) buffers.push({ id: l.id, what: 'mask', px: mask, stride: 1, ver: stamp.mask ?? 0 });
    if (gen?.clip) buffers.push({ id: l.id, what: 'clip', px: gen.clip, stride: 1, ver: stamp.clip ?? 0 });
    return { ...l, px: Object.keys(px) as Channel[], mask: !!mask, ...(gen ? { gen: { ...gen, clip: !!gen.clip } } : {}) };
  });
  // the selection is document state (Photoshop's): saving it with the paint keeps it across a reopen
  if (s.sel) buffers.push({ id: 0, what: 'sel', px: s.sel, stride: 1, ver: 0 });
  return { saved: { size: s.size, channels: [...s.channels], active: s.active, layers, ...(s.sel ? { sel: true } : {}) }, buffers };
}

/** Move a set to another resolution: every layer, the selection and the composite are resampled nearest (a hard
 *  edge stays hard — a bilinear pass would blur it by the ratio), and the bake is dropped because it is built per
 *  texel at the old size. Painting done before the move is as sharp as it was; nothing can add detail that was
 *  never sampled. Undo history is dropped with it: its buffers are the old size. */
export function resize(s: TexSet, size: number) {
  footprints.delete(s);
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
  // the old size's textures are replaced outright: three keeps their GPU memory until they are disposed
  const old = [s.color, s.orm, s.shade, s.normal, s.height, s.aoTex];
  s.color = tex(m, true);
  s.orm = tex(m, false);
  s.shade = tex(m, false);
  s.normal = tex(m, false);
  s.height = tex(m, false);
  for (const t of old) t?.dispose();
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

/** A texel rectangle: x0, y0, x1, y1, inclusive. */
export type TexRect = [number, number, number, number];
type Rect = TexRect;
const snapshot = (s: TexSet): State => ({ channels: [...s.channels], layers: s.layers.map((l) => ({ ...l, px: { ...l.px }, mask: l.mask?.slice() })), active: s.active, sel: s.sel, undoRect: undefined });
/** Most memory one set's undo steps may hold. */
const UNDO_BYTES = 256 << 20;
/** Keep the set as it is, for one undo step. Copy on write: the layers' buffers are shared with the step, and the
 *  active layer gets fresh copies before paint goes into them. */
export function keep(s: TexSet) {
  const l = s.layers[s.active];
  // what this step holds on to: the painted layer's channels and every layer's mask (snapshot copies those)
  const bytes = Object.values(l?.px ?? {}).reduce((a, x) => a + x!.byteLength, 0) + s.layers.reduce((a, m) => a + (m.mask?.byteLength ?? 0), 0);
  s.past.push({ ...snapshot(s), bytes });
  // ponytail: whole-layer copies, so at 2K a fill is ~60 MB a step and 20 steps on a few sets ran the page out of memory
  // (saves then failed: "Array buffer allocation failed"); keep dirty tiles instead if the depth matters
  let total = s.past.reduce((a, p) => a + (p.bytes ?? 0), 0);
  while (s.past.length > 1 && (s.past.length > 20 || total > UNDO_BYTES)) total -= s.past.shift()!.bytes ?? 0;
  s.future.length = 0;
  if (l) s.layers[s.active] = { ...l, px: Object.fromEntries(Object.entries(l.px).map(([c, a]) => [c, a!.slice()])), mask: l.mask?.slice(), ver: l.ver ? { ...l.ver } : undefined };
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
  forgetDecalFootprints(s);
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
  forgetDecalFootprints(s);
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
        s.unlaid = false;
        // the bands skipped the padding pass each blocking composite does: without it the mip chain repeats the
        // island edge into bare texture space (a seam at distance) until the next stroke bleeds
        bleedAll(s);
      } else {
        const [x0, y0, x1, y1] = union(rects);
        for (let y = y0; y <= y1; y += band) {
          composite(s, x0, y, x1, Math.min(y1, y + band - 1), undefined, false);
          await new Promise((ok) => setTimeout(ok, 0));
        }
        bleedAll(s);
        s.dirty = undefined;
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

/** Decals always paint on top of the material stack: move any decal layer below a non-decal one up to the top (in
 *  its own order), keeping the active layer the same layer. True when it moved anything. The engine's export sorts
 *  the same way. */
export function decalsLast(s: { layers: PaintLayer[]; active: number }) {
  const first = s.layers.findIndex((l) => l.decal);
  if (first < 0 || s.layers.slice(first).every((l) => l.decal)) return false;
  const act = s.layers[s.active];
  s.layers = [...s.layers.filter((l) => !l.decal), ...s.layers.filter((l) => l.decal)];
  s.active = Math.max(0, s.layers.indexOf(act));
  return true;
}

/** Texels in a composite box from which the GPU takes over (256²). */
const GPU_MIN = 256 * 256;
/** The layers flattened into the textures the model shows, within a texel rectangle (all of it by default).
 *  `only` limits the work to the channels a brush just touched: painting Base Color does not recomposite
 *  Roughness, Metallic, Normal and Height on every dab. */
export function composite(s: TexSet, x0 = 0, y0 = 0, x1 = s.size - 1, y1 = s.size - 1, only?: Channel[], pad = true) {
  // a stack whose decals are not all on top (an add above a mark, an older project): put them back, then lay all of it
  if (decalsLast(s)) { x0 = y0 = 0; x1 = y1 = s.size - 1; only = undefined; }
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
  stampTiles(s, x0, y0, x1, y1);
  if (!only && x0 === 0 && y0 === 0 && x1 === n - 1 && y1 === n - 1) s.unlaid = false;
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
  if (!s.shell) { s.dirty = undefined; return; } // no shell known: nothing to pad, so nothing left undone
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
export function ensureShell(s: TexSet, uvs: ArrayLike<number>) {
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
  stampTiles(s, ex0, ey0, ex1, ey1);
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
/** The selection's shade, as the 3D view draws a selection: a light blue tint inside with a solid blue border
 *  (`SEL`), black over what's outside. Darkening alone vanished on a dark material, so a click looked like nothing. */
export function shade(s: TexSet) {
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
    if (inside) { d[o] = 63; d[o + 1] = 143; d[o + 2] = 232; d[o + 3] = edge ? 255 : 40; }
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
    for (const ch of channels) touch(l, ch);
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
/** A mesh and the UVs its texels were laid out on (per corner, as the engine's output). */
export interface Layout { pos: ArrayLike<number>; uvs: ArrayLike<number> }
/** Carry a set's pixels from the layout they were painted on (`from`) to a new one (`to`): a re-unwrap, a mesh edited in
 *  Poly Doc, a model replaced by a new version of its file. Each texel of the new layout takes the old texel at the same
 *  point of the model — the very same texel where the layout didn't change there (most of a re-unwrap that kept its
 *  islands, so that paint comes across byte for byte), else the old surface's nearest point, read through its triangle's
 *  UVs. Pixels stay empty where the new surface is far from any old one (geometry that wasn't there), but masks, clips
 *  and the selection take the nearest old surface's value however far: they say where a material goes, and a reworked
 *  grip must stay inside its Black polymer (a cut-off there left a quarter of it bare). Every buffer moves: hand
 *  paint, fills', decals' and generators' pixels, layer masks, generator clips, the selection. The bake and the undo
 *  history described the old layout, so they go. The caller composites (and re-bakes decals from their 3D frames). */
export async function transferPaint(s: TexSet, from: Layout, to: Layout) {
  const n = s.size, a = await surfaceOfAsync(n, from.pos, from.uvs), b = await surfaceOfAsync(n, to.pos, to.uvs);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < to.pos.length; k++) { lo[k % 3] = Math.min(lo[k % 3], to.pos[k]); hi[k % 3] = Math.max(hi[k % 3], to.pos[k]); }
  const span = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1, same = span * 1e-4, far = span * 0.02;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(from.pos), 3));
  const bvh = new MeshBVH(geo), idx = geo.index!.array, q = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const T = new THREE.Triangle(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), w = new THREE.Vector3(), P = from.pos, U = from.uvs;
  const src = new Int32Array(n * n).fill(-1), near = new Uint8Array(n * n);
  let looked = 0, lost = 0;
  for (let i = 0; i < n * n; i++) {
    if (!b.has[i]) continue;
    const x = b.pos[i * 3], y = b.pos[i * 3 + 1], z = b.pos[i * 3 + 2];
    if (a.has[i] && Math.hypot(a.pos[i * 3] - x, a.pos[i * 3 + 1] - y, a.pos[i * 3 + 2] - z) < same) { src[i] = i; near[i] = 1; continue; }
    if (!bvh.closestPointToPoint(q.set(x, y, z), hit)) continue;
    if (hit.distance > far) lost++; else near[i] = 1;
    // the BVH sorts its own index: the hit's corners are vertices of the soup (corner c = position c, uv c), not triangle faceIndex
    const ca = idx[hit.faceIndex * 3], cb = idx[hit.faceIndex * 3 + 1], cc = idx[hit.faceIndex * 3 + 2];
    T.set(A.set(P[ca * 3], P[ca * 3 + 1], P[ca * 3 + 2]), B.set(P[cb * 3], P[cb * 3 + 1], P[cb * 3 + 2]), C.set(P[cc * 3], P[cc * 3 + 1], P[cc * 3 + 2])).getBarycoord(hit.point, w);
    const u = w.x * U[ca * 2] + w.y * U[cb * 2] + w.z * U[cc * 2], v = w.x * U[ca * 2 + 1] + w.y * U[cb * 2 + 1] + w.z * U[cc * 2 + 1];
    const sx = Math.min(n - 1, Math.max(0, Math.floor(u * n))), sy = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
    src[i] = sy * n + sx;
    if ((++looked & 4095) === 0) await new Promise((ok) => setTimeout(ok, 0));
  }
  geo.dispose();
  // `cover`: a mask, clip or selection, which reaches new surface; pixels only come from surface that was there
  const moved = <T extends Uint8Array | Uint8ClampedArray>(buf: T, cover = false): T => {
    const k = buf.length / (n * n), out = new (buf.constructor as new (len: number) => T)(buf.length);
    for (let i = 0; i < n * n; i++) { const j = src[i]; if (j >= 0 && (cover || near[i])) for (let c = 0; c < k; c++) out[i * k + c] = buf[j * k + c]; }
    return out;
  };
  s.layers = s.layers.map((l) => {
    const px = Object.fromEntries(Object.entries(l.px).map(([ch, buf]) => [ch, moved(buf!)])) as PaintLayer['px'];
    const next: PaintLayer = { ...l, px, ...(l.mask ? { mask: moved(l.mask, true) } : {}), ...(l.gen?.clip ? { gen: { ...l.gen, clip: moved(l.gen.clip, true) } } : {}) };
    for (const ch of Object.keys(px) as Channel[]) touch(next, ch);
    if (next.mask) touch(next, 'mask');
    if (next.gen?.clip) touch(next, 'clip');
    return next;
  });
  if (s.sel) s.sel = moved(s.sel, true);
  s.bake = undefined; s.aoTex?.dispose(); s.aoTex = undefined;
  s.past = []; s.future = [];
  s.shellFor = undefined;
  s.ver++;
  return { kept: looked === 0 ? 1 : 1 - looked / Math.max(1, b.has.reduce((c, h) => c + h, 0)), lost };
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
export { hashu };
/** The generators' lattice hash (their noise runs on the GPU too, so it is the integer one). */
const latticeHash = (x: number, y: number, z: number) => hashu(x, y, z) / 4294967296;
/** The grip stipple's jitter: CPU only, kept as it was so placed grips keep their dots. */
const hash = (x: number, y: number, z: number) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); };
function noise(x: number, y: number, z: number) {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 3; o++, amp /= 2, f *= 2) {
    const X = x * f, Y = y * f, Z = z * f, ix = Math.floor(X), iy = Math.floor(Y), iz = Math.floor(Z);
    const fx = X - ix, fy = Y - iy, fz = Z - iz, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const plane = (k: number) => lerp(lerp(latticeHash(ix, iy, k), latticeHash(ix + 1, iy, k), sx), lerp(latticeHash(ix, iy + 1, k), latticeHash(ix + 1, iy + 1, k), sx), sy);
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
  for (const ch of ['color', 'rough', 'metal'] as Channel[]) if (s.channels.includes(ch)) touch(l, ch);
  const n = s.size, values: Partial<Record<Channel, number[]>> = { color: [1, 3, 5].map((k) => parseInt(g.color.slice(k, k + 2), 16)), rough: [g.rough * 255], metal: [g.metal * 255] };
  const cover = new Float32Array(n * n);
  // the coverage on the GPU (gpubake.ts GENERATOR) when there is one: the noise is most of a generator's time
  const gpu = gpuBakeReady(n) && gpuBake(n, {
    frag: GENERATOR, inputs: 2,
    uniforms: { uKind: g.kind === 'edge' ? 0 : g.kind === 'dirt' ? 1 : 2, uWS: g.width * b.span, uK: 1 / (g.scale * b.span), uGrunge: g.grunge, uAmount: g.amount, uSoft: g.soft },
  }, [0], (y0, h, [a, p]) => {
    for (let j = 0, i = y0 * n; j < n * h; j++, i++) {
      a[j * 4] = b.ao[i]; a[j * 4 + 1] = b.convex[i]; a[j * 4 + 2] = b.concave[i]; a[j * 4 + 3] = b.has[i];
      p[j * 4] = b.pos[i * 3]; p[j * 4 + 1] = b.pos[i * 3 + 1]; p[j * 4 + 2] = b.pos[i * 3 + 2]; p[j * 4 + 3] = g.clip ? g.clip[i] / 255 : 1;
    }
  }, (_o, y0, h, rgba) => { for (let j = 0, i = y0 * n; j < n * h; j++, i++) cover[i] = rgba[j * 4] / 255; });
  if (!gpu) for (let i = 0; i < n * n; i++) cover[i] = b.has[i] ? genAt(g, b, i) * (g.clip ? g.clip[i] / 255 : 1) : 0;
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
// Bilinear taps per slot: the corner offsets and fractions of (u, v) on a w×h map, so a tri-planar texel works out
// each plane's taps once and every map of that size reads them (slot 3 is sampleMap's own).
const tapO = new Int32Array(16), tapF = new Float64Array(8);
function tap(p: number, w: number, h: number, u: number, v: number) {
  const x = (u - Math.floor(u)) * w - 0.5, y = (1 - (v - Math.floor(v))) * h - 0.5;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  tapF[p * 2] = x - x0; tapF[p * 2 + 1] = y - y0;
  // x0, y0 are at least -1 and x1, y1 at most w, h: wrapping is one step either way
  let x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 += w; if (x1 >= w) x1 -= w; if (y0 < 0) y0 += h; if (y1 >= h) y1 -= h;
  tapO[p * 4] = (y0 * w + x0) * 4; tapO[p * 4 + 1] = (y0 * w + x1) * 4; tapO[p * 4 + 2] = (y1 * w + x0) * 4; tapO[p * 4 + 3] = (y1 * w + x1) * 4;
}
function tapped(d: Uint8ClampedArray, p: number, k: number) {
  const fx = tapF[p * 2], fy = tapF[p * 2 + 1];
  return (d[tapO[p * 4] + k] * (1 - fx) + d[tapO[p * 4 + 1] + k] * fx) * (1 - fy) + (d[tapO[p * 4 + 2] + k] * (1 - fx) + d[tapO[p * 4 + 3] + k] * fx) * fy;
}
function sampleMap(m: MapPixels, u: number, v: number) {
  tap(3, m.width, m.height, u, v);
  for (let k = 0; k < 4; k++) sampleOut[k] = tapped(m.data, 3, k);
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
  for (const ch of f.channels) touch(l, ch);
  ensureShell(s, uvs);
  const n = s.size;
  for (const ch of Object.keys(l.px) as Channel[]) if (!f.channels.includes(ch)) delete l.px[ch];
  const buf: Partial<Record<Channel, Uint8ClampedArray>> = {};
  for (const ch of f.channels) buf[ch] = fillBuf(s, l, ch);
  const tint = hexTint(f.tint), strength = f.normalStrength;
  // no colour map (a solid fill, a colorless finish such as Cerakote): its colour is the tint, on white
  const plain = [255, 255, 255];
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
    if (gpuBakeReady(n) && gpuBake(n, { frag: UVFILL, inputs: 0, uniforms: fillUniforms(f, src, f.tiling, co, si) }, fillOuts(f, buf), () => {}, putFill(n, buf, true))) return;
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
  // every map of the first one's size reads the planes' shared taps; any other size samples on its own
  const first = color ?? normalMap ?? rough ?? metal ?? height, tw = first?.width ?? 0, th = first?.height ?? 0;
  const puv = new Float64Array(6);
  const mix = (m: MapPixels, p: number, k: number) => m.width === tw && m.height === th ? tapped(m.data, p, k) : sampleMap(m, puv[p * 2], puv[p * 2 + 1])[k];
  const roughP = (p: number) => f.roughness != null ? f.roughness * 255 : rough ? mix(rough, p, 0) : CHANNELS.rough.base[0];
  const metalP = (p: number) => f.metallic != null ? f.metallic * 255 : metal ? mix(metal, p, 0) : 0;
  if (bakeFillGpu(s, f, src, pos, uvs, buf, tiles, co, si)) return;
  const fr = new Float64Array(16);
  for (let t = 0; t < pos.length / 9; t++) {
    triFrame(pos, uvs, t, fr);
    const [nx, ny, nz, tx, ty, tz, bx, by, bz, wx, wy, wz, ws] = fr;
    const blend = (m: MapPixels, k: number) => ((wx ? mix(m, 0, k) * wx : 0) + (wy ? mix(m, 1, k) * wy : 0) + (wz ? mix(m, 2, k) * wz : 0)) / ws;
    const blendAt = (at: (p: number) => number) => ((wx ? at(0) * wx : 0) + (wy ? at(1) * wy : 0) + (wz ? at(2) * wz : 0)) / ws;
    // per plane x / y / z: its share, and which way the face looks along that axis
    const sx = nx >= 0 ? 1 : -1, sy = ny >= 0 ? 1 : -1, sz = nz >= 0 ? 1 : -1;
    raster(n, pos, uvs, t, (x, y, z, i) => {
      // rotate the projection around Y, then project on each plane
      const rx = x * co + z * si, rz = -x * si + z * co, ou = f.offset[0], ov = f.offset[1];
      puv[0] = rz * tiles + ou; puv[1] = y * tiles + ov;
      puv[2] = rx * tiles + ou; puv[3] = rz * tiles + ov;
      puv[4] = rx * tiles + ou; puv[5] = y * tiles + ov;
      if (first) { if (wx) tap(0, tw, th, puv[0], puv[1]); if (wy) tap(1, tw, th, puv[2], puv[3]); if (wz) tap(2, tw, th, puv[4], puv[5]); }
      if (buf.color) {
        const k = CHANNELS.color.k, px = buf.color;
        let r = 0, g = 0, b = 0;
        if (color) {
          r = blend(color, 0); g = blend(color, 1); b = blend(color, 2);
        } else { [r, g, b] = plain; }
        px[i * (k + 1)] = Math.min(255, r * tint[0] / 255); px[i * (k + 1) + 1] = Math.min(255, g * tint[1] / 255); px[i * (k + 1) + 2] = Math.min(255, b * tint[2] / 255); px[i * (k + 1) + k] = 255;
      }
      if (buf.rough) { const px = buf.rough; px[i * 2] = blendAt(roughP); px[i * 2 + 1] = 255; }
      if (buf.metal) { const px = buf.metal; px[i * 2] = blendAt(metalP); px[i * 2 + 1] = 255; }
      if (buf.height) { const px = buf.height; px[i * 2] = height ? blend(height, 0) : 128; px[i * 2 + 1] = 255; }
      if (buf.normal) {
        const px = buf.normal;
        // The face's own normal plus each plane's detail along that plane's tangent and bitangent (UDN): a flat map
        // leaves the face as it is, so the fill's Normal is (0, 0, 1) and the mesh keeps its smooth / weighted
        // shading. Summing each plane's whole normal (±its axis) instead bent every face that isn't square to an
        // axis toward the axes, by up to ~20°, a different amount per triangle: shading broke into facets.
        let wnx = nx, wny = ny, wnz = nz;
        if (normalMap) for (let p = 0; p < 3; p++) {
          const weight = (p === 0 ? wx : p === 1 ? wy : wz) / ws;
          if (weight <= 0) continue;
          const dx = (mix(normalMap, p, 0) / 127.5 - 1) * strength, dy = (mix(normalMap, p, 1) / 127.5 - 1) * strength;
          if (p === 0) { wny += -sx * dy * weight; wnz += dx * weight; }
          else if (p === 1) { wnx += dx * weight; wnz += -sy * dy * weight; }
          else { wnx += dx * weight; wny += sz * dy * weight; }
        }
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

/** Triangle t's tri-planar frame into `out` at `at`: face normal, UV tangent and bitangent, the three planes' weights
 *  (a plane under 1/512 of the blend moves no texel by a level: dropped, so a face square to an axis samples once)
 *  and their sum. The GPU bake (gpubake.ts) reads the same floats, 16 a triangle. */
function triFrame(pos: ArrayLike<number>, uvs: ArrayLike<number>, t: number, out: Float64Array | Float32Array, at = 0) {
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
  let wx = Math.pow(Math.abs(nx), 4), wy = Math.pow(Math.abs(ny), 4), wz = Math.pow(Math.abs(nz), 4);
  const cut = (wx + wy + wz) / 512;
  if (wx < cut) wx = 0; if (wy < cut) wy = 0; if (wz < cut) wz = 0;
  out[at] = nx; out[at + 1] = ny; out[at + 2] = nz; out[at + 3] = tx; out[at + 4] = ty; out[at + 5] = tz; out[at + 6] = bx; out[at + 7] = by;
  out[at + 8] = bz; out[at + 9] = wx; out[at + 10] = wy; out[at + 11] = wz; out[at + 12] = wx + wy + wz || 1;
}

/** A fill's material and settings as gpubake.ts FILL_UNIFORMS. */
function fillUniforms(f: Fill, src: MaterialPixels, tiles: number, co: number, si: number) {
  const t = (m?: MapPixels) => (m ? mapTexture(m) : null);
  return {
    uColor: t(src.basecolor), uNormal: t(src.normal), uRough: t(src.roughness), uMetal: t(src.metallic), uHeight: t(src.height),
    uHas: [+!!src.basecolor, +!!src.normal, +!!src.roughness, +!!src.metallic], uHasHeight: +!!src.height,
    uTiles: tiles, uCo: co, uSi: si, uOffset: f.offset, uStrength: f.normalStrength, uTint: hexTint(f.tint),
    uPlain: [255, 255, 255], uRoughV: f.roughness != null ? f.roughness * 255 : -1,
    uMetalV: f.metallic != null ? f.metallic * 255 : -1, uRoughBase: CHANNELS.rough.base[0],
  };
}
const FILL_CH: Channel[] = ['color', 'rough', 'metal', 'height', 'normal']; // FILL_OUT's order
const fillOuts = (f: Fill, buf: Partial<Record<Channel, Uint8ClampedArray>>) => f.channels.filter((ch) => buf[ch]).map((ch) => FILL_OUT[ch]);
/** A fill kernel's bytes into the layer: every texel (`all`), or those with a triangle in input 0. */
const putFill = (n: number, buf: Partial<Record<Channel, Uint8ClampedArray>>, all: boolean) => (o: number, y0: number, h: number, rgba: Uint8Array, ins: Float32Array[]) => {
  const px = buf[FILL_CH[o]]!, wide = o === FILL_OUT.color || o === FILL_OUT.normal;
  for (let j = 0, i = y0 * n; j < n * h; j++, i++) {
    if (!all && !ins[0][j * 4 + 3]) continue;
    if (wide) { px[i * 4] = rgba[j * 4]; px[i * 4 + 1] = rgba[j * 4 + 1]; px[i * 4 + 2] = rgba[j * 4 + 2]; px[i * 4 + 3] = 255; }
    else { px[i * 2] = rgba[j * 4]; px[i * 2 + 1] = 255; }
  }
};
/** Each triangle's texel rows (with raster's 2-texel margin), so a band only rasterises the triangles reaching it. */
function rowSpans(n: number, uvs: ArrayLike<number>, T: number) {
  const lo = new Float32Array(T), hi = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const a = uvs[t * 6 + 1] * n, b = uvs[t * 6 + 3] * n, c = uvs[t * 6 + 5] * n;
    lo[t] = Math.min(a, b, c) - 2; hi[t] = Math.max(a, b, c) + 2;
  }
  return (y0: number, h: number, t: number) => hi[t] >= y0 && lo[t] <= y0 + h;
}

/** bakeFill's tri-planar texels on the GPU (gpubake.ts TRIPLANAR): the CPU rasterises as ever, recording each texel's
 *  point and triangle per band, and the shader samples. False: no GPU here (Node, a failed context), bake on the CPU. */
function bakeFillGpu(s: TexSet, f: Fill, src: MaterialPixels, pos: ArrayLike<number>, uvs: ArrayLike<number>, buf: Partial<Record<Channel, Uint8ClampedArray>>, tiles: number, co: number, si: number) {
  const n = s.size, T = pos.length / 9;
  if (!gpuBakeReady(n) || T >= 1 << 24) return false;
  const frames = new Float32Array(T * 16), reaches = rowSpans(n, uvs, T);
  for (let t = 0; t < T; t++) triFrame(pos, uvs, t, frames, t * 16);
  const uFrame = rows(frames);
  const ok = gpuBake(n, { frag: TRIPLANAR, inputs: 1, uniforms: { ...fillUniforms(f, src, tiles, co, si), uFrame }, temp: [uFrame] }, fillOuts(f, buf), (y0, h, [at]) => {
    const clip: Rect = [0, y0, n - 1, y0 + h - 1], base = y0 * n;
    for (let t = 0; t < T; t++) {
      if (!reaches(y0, h, t)) continue;
      raster(n, pos, uvs, t, (x, y, z, i) => { const o = (i - base) * 4; at[o] = x; at[o + 1] = y; at[o + 2] = z; at[o + 3] = t + 1; return 1; }, clip);
    }
  }, putFill(n, buf, false));
  for (const i of touched) weight[i] = 0;
  touched.length = 0;
  return ok;
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

/** A decal image's mip chain: halved by alpha-weighted 2×2 boxes down to one pixel, so a texel reads the level its
 *  footprint spans (a 1024 px mark baked into a few hundred texels aliased into beads). Engine: `mips`. */
const mipCache = new WeakMap<MapPixels, MapPixels[]>();
function decalMips(m: MapPixels): MapPixels[] {
  const hit = mipCache.get(m);
  if (hit) return hit;
  const chain = [m];
  for (let a = m; a.width > 1 || a.height > 1;) {
    const w = Math.max(1, a.width >> 1), h = Math.max(1, a.height >> 1), data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, al = 0;
      for (let k = 0; k < 4; k++) {
        const o = (Math.min(a.height - 1, y * 2 + (k >> 1)) * a.width + Math.min(a.width - 1, x * 2 + (k & 1))) * 4, q = a.data[o + 3];
        r += a.data[o] * q; g += a.data[o + 1] * q; b += a.data[o + 2] * q; al += q;
      }
      const o = (y * w + x) * 4;
      if (al > 0) { data[o] = r / al; data[o + 1] = g / al; data[o + 2] = b / al; }
      data[o + 3] = al / 4;
    }
    chain.push(a = { width: w, height: h, data });
  }
  mipCache.set(m, chain);
  return chain;
}
/** `sampleDecal` at a footprint of `fp` source pixels per texel: the two mip levels round it, blended. Engine: `sample_mip`. */
function sampleMip(chain: MapPixels[], u: number, v: number, fp: number) {
  const l = Math.min(chain.length - 1, Math.log2(Math.max(fp, 1))), l0 = Math.floor(l), f = l - l0;
  const a = sampleDecal(chain[l0], u, v);
  if (f < 1e-3 || l0 + 1 >= chain.length) return a;
  const r = a[0], g = a[1], b = a[2], wa = a[3] * (1 - f);
  const q = sampleDecal(chain[l0 + 1], u, v), wb = q[3] * f, al = wa + wb;
  if (al > 1e-6) { q[0] = (r * wa + q[0] * wb) / al; q[1] = (g * wa + q[1] * wb) / al; q[2] = (b * wa + q[2] * wb) / al; }
  q[3] = al;
  return q;
}

/** A decal's projector: centre, facing, right / up turned by the rotation, size and how deep it reaches. */
export interface DecalFrame {
  cx: number; cy: number; cz: number; nx: number; ny: number; nz: number;
  uxr: number; uyr: number; uzr: number; vxr: number; vyr: number; vzr: number;
  width: number; height: number; depth: number;
}
/** The frame a decal is projected in: the gizmo, the placement preview and the bake all read it here, so the frame
 *  drawn on the model is exactly the one the ink lands in. */
export function decalFrame(d: Decal, span: number): DecalFrame {
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
  return { cx, cy, cz, nx, ny, nz, uxr, uyr, uzr, vxr, vyr, vzr, width, height, depth };
}

/** Where each decal layer last put ink, per set and layer id: a move clears and recomposites only that box instead
 *  of the whole texture. */
const footprints = new WeakMap<TexSet, Map<number, Rect>>();
/** The paint was put back (undo, a reload, another resolution): the recorded footprints belong to a state that is
 *  gone, so the next decal bake clears its layer whole and starts again. */
export function forgetDecalFootprints(s: TexSet) { footprints.delete(s); }
/** Zero a layer's channels over a box (a decal's ink is wholly derived from its projector, so clearing is enough). */
function clearRect(s: TexSet, l: PaintLayer, r: Rect) {
  const n = s.size;
  for (const ch of Object.keys(l.px) as Channel[]) {
    const px = l.px[ch]!, st = CHANNELS[ch].k + 1;
    for (let y = r[1]; y <= r[3]; y++) px.fill(0, (y * n + r[0]) * st, (y * n + r[2] + 1) * st);
  }
}

/** The UV box (texels) a projector can ink triangle `t` in: the part of the triangle inside the projector's rectangle,
 *  carried back through its barycentrics. Null for a triangle facing away (the projector's box reaches round a thin
 *  part, and those would drag the clip across the atlas) or one it misses entirely. */
function projectedUVBox(pos: ArrayLike<number>, uvs: ArrayLike<number>, t: number, f: DecalFrame, n: number): Rect | null {
  const o = t * 9;
  const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
  const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
  const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
  const fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-14 || (fx * f.nx + fy * f.ny + fz * f.nz) / fl < 0.12) return null;
  const hw = f.width / 2, hh = f.height / 2;
  // the triangle in the projector's own plane, with each corner's barycentric weights along for the ride
  type Vtx = [number, number, number, number];
  let poly: Vtx[] = [];
  for (let k = 0; k < 3; k++) {
    const dx = pos[o + k * 3] - f.cx, dy = pos[o + k * 3 + 1] - f.cy, dz = pos[o + k * 3 + 2] - f.cz;
    poly.push([dx * f.uxr + dy * f.uyr + dz * f.uzr, dx * f.vxr + dy * f.vyr + dz * f.vzr, k === 1 ? 1 : 0, k === 2 ? 1 : 0]);
  }
  // Sutherland–Hodgman against the four sides of the rectangle; (b1, b2) interpolate with it
  const cut = (a: Vtx, b: Vtx, u: number): Vtx => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
  const keep = (side: (p: Vtx) => number) => {
    const out: Vtx[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], da = side(a), db = side(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) out.push(cut(a, b, da / (da - db)));
    }
    poly = out;
  };
  keep((p) => p[0] + hw);
  keep((p) => hw - p[0]);
  keep((p) => p[1] + hh);
  keep((p) => hh - p[1]);
  if (!poly.length) return null;
  const u0 = uvs[t * 6], v0 = uvs[t * 6 + 1], u1 = uvs[t * 6 + 2], v1 = uvs[t * 6 + 3], u2 = uvs[t * 6 + 4], v2 = uvs[t * 6 + 5];
  let x0 = n, y0 = n, x1 = -1, y1 = -1;
  for (const p of poly) {
    const b0 = 1 - p[2] - p[3], u = (b0 * u0 + p[2] * u1 + p[3] * u2) * n, v = (b0 * v0 + p[2] * v1 + p[3] * v2) * n;
    if (u < x0) x0 = u; if (u > x1) x1 = u; if (v < y0) y0 = v; if (v > y1) y1 = v;
  }
  if (x1 < 0) return null;
  const pad = 2; // the raster's seam tolerance reaches a texel past a corner
  return [Math.max(0, Math.floor(x0) - pad), Math.max(0, Math.floor(y0) - pad), Math.min(n - 1, Math.ceil(x1) + pad), Math.min(n - 1, Math.ceil(y1) + pad)];
}

/** Bake a placed decal into a layer. A decal is a flat projector at `center`, tangent to the surface and
 *  facing along `normal`; only front-facing triangles within the projector's depth take ink. That keeps a
 *  mark from bleeding round the back of a slide or down the sides of a grip. Returns the texel box the bake changed
 *  (the caller recomposites it), or null. */
export function bakeDecal(s: TexSet, l: PaintLayer, src: MapPixels, pos: ArrayLike<number>, uvs: ArrayLike<number>, span: number): Rect | null {
  const d = l.decal;
  if (!d) return null;
  for (const ch of Object.keys(l.px) as Channel[]) touch(l, ch);
  if (d.shape) { bakeShape(s, l, pos, uvs, span); return null; }
  ensureShell(s, uvs);
  const n = s.size, f = decalFrame(d, span);
  const { cx, cy, cz, nx, ny, nz, uxr, uyr, uzr, vxr, vyr, vzr, width, height, depth } = f;
  for (const ch of Object.keys(l.px) as Channel[]) if (!d.channels.includes(ch)) delete l.px[ch];
  const buf: Partial<Record<Channel, Uint8ClampedArray>> = {};
  const eng = Math.max(0, d.engrave ?? 0);
  for (const ch of d.channels) if (ch === 'color' || ch === 'rough' || ch === 'metal' || (eng > 0 && (ch === 'normal' || ch === 'height'))) buf[ch] = fillBuf(s, l, ch);
  if (!buf.color) return null;
  // The triangles the projector's box reaches, and the box they occupy in the texture: the bake works inside it (a
  // decal is a few hundred texels of a 4K atlas; the whole part per frame is what made a drag crawl).
  const hits: [number, Rect][] = [];
  let bx0 = n, by0 = n, bx1 = -1, by1 = -1;
  for (let t = 0; t < pos.length / 9; t++) {
    const box = projectedUVBox(pos, uvs, t, f, n);
    if (!box) continue;
    hits.push([t, box]);
    if (box[0] < bx0) bx0 = box[0]; if (box[1] < by0) by0 = box[1]; if (box[2] > bx1) bx1 = box[2]; if (box[3] > by1) by1 = box[3];
  }
  const map = footprints.get(s) ?? (footprints.set(s, new Map()), footprints.get(s)!);
  const old = map.get(l.id);
  // Clear where the ink may be — last bake's box and this one's — or the whole layer when that box is not known
  // (a project loaded its baked pixels, an undo put another state back).
  let clear: Rect | null = old ? [...old] : null;
  if (bx1 >= 0) clear = clear ? [Math.min(clear[0], bx0), Math.min(clear[1], by0), Math.max(clear[2], bx1), Math.max(clear[3], by1)] : [bx0, by0, bx1, by1];
  if (clear) clearRect(s, l, clear); else for (const b of Object.values(buf)) b.fill(0);
  if (!hits.length) { map.delete(l.id); return clear; }
  const tint = hexTint(d.tint), rough = d.roughness * 255, metal = d.metallic * 255;
  const color = buf.color, rc = buf.rough, mt = buf.metal, nm = buf.normal, ht = buf.height;
  // engraving: the ink's edge tilts the normal as a cut would (height = -ink), slope from the ink's gradient, taken
  // over at least half a texel either side (over 1.5 source pixels alone, a 2K texel hit or missed the edge: a beaded outline)
  const mips = decalMips(src), slope = eng * 3;
  let fp = 1, hu = 0, hv = 0;
  const ink = (u: number, v: number) => sampleMip(mips, d.flipH ? 1 - u : u, d.flipV ? 1 - v : v, fp)[3] / 255;
  let sr = 0, sg = 0, sb = 0, sa = 0, gx = 0, gy = 0, cut = false;
  let tx = 1, ty = 0, tz = 0, bx = 0, by = 1, bz = 0;
  let ix0 = n, iy0 = n, ix1 = -1, iy1 = -1;
  ready(n);
  for (const [t] of hits) {
    const o = t * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const e1x = pos[o + 3] - ax, e1y = pos[o + 4] - ay, e1z = pos[o + 5] - az;
    const e2x = pos[o + 6] - ax, e2y = pos[o + 7] - ay, e2z = pos[o + 8] - az;
    let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    if (fx * nx + fy * ny + fz * nz < 0.12) continue; // a mark only lands on surface facing the projector
    if (eng > 0) [tx, ty, tz, bx, by, bz] = tangentOf(pos, uvs, t, fx, fy, fz);
    const tex = texelSize(pos, uvs, t, n);
    fp = (tex / width) * src.width; hu = Math.max(1.5 / src.width, 0.5 * tex / width); hv = Math.max(1.5 / src.height, 0.5 * tex / height);
    raster(n, pos, uvs, t, (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const along = dx * nx + dy * ny + dz * nz;
      if (Math.abs(along) > depth) return 0;
      const u = (dx * uxr + dy * uyr + dz * uzr) / width + 0.5;
      const v = (dx * vxr + dy * vyr + dz * vzr) / height + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      const q = sampleMip(mips, d.flipH ? 1 - u : u, d.flipV ? 1 - v : v, fp);
      sa = q[3] / 255;
      const qr = q[0], qg = q[1], qb = q[2];
      cut = false;
      if (eng > 0) {
        const gu = ink(u + hu, v) - ink(u - hu, v), gv = ink(u, v + hv) - ink(u, v - hv);
        cut = Math.abs(gu) + Math.abs(gv) > 1e-3;
        // world tilt along the decal's axes, then into the triangle's tangent space
        const wx = (gu * uxr + gv * vxr) * slope, wy = (gu * uyr + gv * vyr) * slope, wz = (gu * uzr + gv * vzr) * slope;
        gx = wx * tx + wy * ty + wz * tz; gy = wx * bx + wy * by + wz * bz;
      }
      if (sa <= 0 && !cut) return 0;
      sr = Math.min(255, qr * tint[0] / 255); sg = Math.min(255, qg * tint[1] / 255); sb = Math.min(255, qb * tint[2] / 255);
      return cut ? 1 : sa;
    }, clear ?? undefined, (_x, _y, _z, i) => {
      const ix = i % n, iy = (i / n) | 0;
      if (ix < ix0) ix0 = ix; if (ix > ix1) ix1 = ix; if (iy < iy0) iy0 = iy; if (iy > iy1) iy1 = iy;
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
  if (ix1 >= 0) map.set(l.id, [ix0, iy0, ix1, iy1]); else map.delete(l.id);
  return clear;
}

/** Triangle t's tangent frame as the engine's Mesh has it: T from the UVs, B = N × T (N the unit face normal). */
function tangentOf(pos: ArrayLike<number>, uvs: ArrayLike<number>, t: number, fx: number, fy: number, fz: number): [number, number, number, number, number, number] {
  const o = t * 9;
  const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
  const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
  const du1 = uvs[t * 6 + 2] - uvs[t * 6], dv1 = uvs[t * 6 + 3] - uvs[t * 6 + 1], du2 = uvs[t * 6 + 4] - uvs[t * 6], dv2 = uvs[t * 6 + 5] - uvs[t * 6 + 1];
  const det = du1 * dv2 - du2 * dv1;
  let tx = 1, ty = 0, tz = 0;
  if (Math.abs(det) > 1e-12) {
    tx = (e1x * dv2 - e2x * dv1) / det; ty = (e1y * dv2 - e2y * dv1) / det; tz = (e1z * dv2 - e2z * dv1) / det;
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  }
  return [tx, ty, tz, fy * tz - fz * ty, fz * tx - fx * tz, fx * ty - fy * tx];
}

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** A pattern's relief at (x, y) in cells: stipple 0..1 bumps, grooves 0..-1 cuts across, checker 0..1 pyramids,
 *  pyramid 0..1 a square grid of flat-topped nubs with flat gaps between (a polymer pistol frame's texture). */
function patternAt(p: Pattern, x: number, y: number) {
  if (p === 'pyramid') { const d = 2 * Math.max(Math.abs(x - Math.floor(x) - 0.5), Math.abs(y - Math.floor(y) - 0.5)); return smooth01((0.85 - d) / 0.4); }
  if (p === 'grooves') { const f = y - Math.floor(y); return f > 0.25 && f < 0.75 ? -Math.sin(Math.PI * (f - 0.25) * 2) : 0; }
  if (p === 'checker') {
    const tri = (s: number) => 1 - 2 * Math.abs(s - Math.floor(s) - 0.5);
    return Math.min(tri((x + y) * Math.SQRT1_2), tri((x - y) * Math.SQRT1_2));
  }
  if (p !== 'stipple') return 0;
  // one jittered dome per cell, the tallest of the 3×3 around wins
  const i = Math.floor(x), j = Math.floor(y);
  let v = 0;
  for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) {
    const dx = x - (a + 0.2 + 0.6 * hash(a, b, 1)), dy = y - (b + 0.2 + 0.6 * hash(a, b, 2)), r = 0.38 + 0.2 * hash(a, b, 3);
    const q = 1 - (dx * dx + dy * dy) / (r * r);
    if (q > 0) v = Math.max(v, q * q);
  }
  return v;
}
/** The outline scaled to the panel (half extents hw × hh) with every corner rounded by r: a short arc in place of
 *  each corner, its tangent points kept within half of either edge (engine: `filleted`). Flat x, y pairs. */
function filleted(pts: [number, number][], hw: number, hh: number, r: number): number[] {
  const p = pts.map(([x, y]) => [x * hw, y * hh]), n = p.length, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = p[i], [ax, ay] = p[(i + n - 1) % n], [bx, by] = p[(i + 1) % n];
    const la = Math.hypot(ax - px, ay - py), lb = Math.hypot(bx - px, by - py);
    if (r <= 0 || la < 1e-12 || lb < 1e-12) { out.push(px, py); continue; }
    const dax = (ax - px) / la, day = (ay - py) / la, dbx = (bx - px) / lb, dby = (by - py) / lb;
    const th = Math.acos(Math.max(-1, Math.min(1, dax * dbx + day * dby)));
    if (th > Math.PI - 1e-3 || th < 1e-3) { out.push(px, py); continue; }
    const tn = Math.tan(th / 2), t = Math.min(r / tn, Math.min(la, lb) * 0.5), rr = t * tn;
    const mx = dax + dbx, my = day + dby, k = rr / Math.sin(th / 2) / Math.hypot(mx, my);
    const cx = px + mx * k, cy = py + my * k;
    const a0 = Math.atan2(py + day * t - cy, px + dax * t - cx), a1 = Math.atan2(py + dby * t - cy, px + dbx * t - cx);
    let da = a1 - a0;
    if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
    for (let j = 0; j <= 6; j++) out.push(cx + rr * Math.cos(a0 + (da * j) / 6), cy + rr * Math.sin(a0 + (da * j) / 6));
  }
  return out;
}
/** Signed distance to a closed polygon (flat x, y pairs): negative inside (even-odd). Engine: `poly_sd`. */
function polySd(poly: number[], x: number, y: number) {
  let d = Infinity, inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const ax = poly[j], ay = poly[j + 1], ex = poly[i] - ax, ey = poly[i + 1] - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
    d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t));
    if ((ay > y) !== (poly[i + 1] > y) && x < ax + ((y - ay) * ex) / ey) inside = !inside;
  }
  return inside ? -d : d;
}
// a bake asks for the same panel's polygon on every texel: keep the last one per shape
const polyCache = new WeakMap<Shape, { hw: number; hh: number; poly: number[] }>();
function outlinePoly(sh: Shape, hw: number, hh: number) {
  const c = polyCache.get(sh);
  if (c && c.hw === hw && c.hh === hh) return c.poly;
  const poly = filleted(sh.outline!, hw, hh, isLine(sh.pattern) && !sh.closed ? 0 : sh.corner);
  polyCache.set(sh, { hw, hh, poly });
  return poly;
}
/** The relief at (x, y) world units from a shape's centre (half extents hw × hh), null outside its outline: a groove
 *  `border` wide round the rounded edge, then the pattern faded in a little inside it. Engine: `shape_height`. */
export function shapeHeight(sh: Shape, x: number, y: number, hw: number, hh: number): number | null {
  if (isLine(sh.pattern)) return sh.outline ? lineHeight(sh, outlinePoly(sh, hw, hh), x, y) : null;
  if (sh.pattern === 'fastener') {
    const r = Math.min(hw, hh);
    return fastener(sh, x / r, y / r);
  }
  const sd = panelSd(sh, x, y, hw, hh);
  if (sd > 0) return null;
  const g = sh.border;
  if (sh.pattern === 'pad') return sh.amount * profileAt(sh.profile, 1 - Math.min(1, -sd / Math.max(g, 1e-9)));
  let h = g > 0 && sd > -g ? -sh.depth * Math.sin((Math.PI * (sd + g)) / g) : 0;
  const fade = smooth01((-(g > 0 ? g * 1.6 : 0) - sd) / (sh.cell * 0.5));
  if (fade > 0 && sh.pattern !== 'none') h += sh.amount * fade * patternAt(sh.pattern, x / sh.cell, y / sh.cell);
  return h;
}
/** A panel's (or pad's) signed distance to its rounded outline, negative inside. Engine: `panel_sd`. */
function panelSd(sh: Shape, x: number, y: number, hw: number, hh: number) {
  if (sh.outline) return polySd(outlinePoly(sh, hw, hh), x, y);
  const r = Math.min(sh.corner, hw, hh);
  const qx = Math.abs(x) - hw + r, qy = Math.abs(y) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
/** Whether (x, y) lies on a panel's or pad's border band, which takes the decal's `rim` finish. Engine: `on_rim`. */
export function onRim(sh: Shape, x: number, y: number, hw: number, hh: number) {
  if (isLine(sh.pattern) || sh.pattern === 'fastener' || sh.border <= 0) return false;
  const sd = panelSd(sh, x, y, hw, hh);
  return sd <= 0 && sd > -sh.border;
}
/** The step a shape's slope is taken over (world units): a fraction of its finest feature. Engine: `slope_step`. */
export function slopeStep(sh: Shape, hw: number, hh: number) {
  if (sh.pattern === 'fastener') return Math.min(hw, hh) * 0.012;
  if (sh.pattern === 'rivets') return sh.border * 0.006;
  return Math.min(sh.cell, sh.border > 0 ? sh.border : sh.cell) * 0.1;
}
/** How deep a cross-section is at q (0 on its centre line, 1 at its lip), 0..1. Engine: `profile_at`. */
function profileAt(p: Profile | undefined, q: number) {
  if (q >= 1) return 0;
  if (p === 'v') return 1 - q;
  if (p === 'square') return smooth01((1 - q) / 0.18);
  if (p === 'chamfer') return Math.min(1, (1 - q) / 0.45);
  return Math.sqrt(1 - q * q);
}
/** 1D value noise, 0..1 (engine: `vnoise`): a scratch's depth wanders along its length. */
function vnoise(t: number) {
  const i = Math.floor(t), f = t - i, k = f * f * (3 - 2 * f);
  return hash(i, 0, 7) * (1 - k) + hash(i + 1, 0, 7) * k;
}
/** A line kind along the polyline p (flat x, y pairs; `sh.closed` joins its ends), null off it. Engine: `line_relief`. */
function lineHeight(sh: Shape, p: number[], x: number, y: number): number | null {
  const n = p.length / 2, segs = sh.closed ? n : n - 1, w = sh.border / 2;
  if (n < 2 || w <= 0) return null;
  // the nearest point: its distance, the side of the line it's on, how far along the line it is
  let d = Infinity, side = 1, at = 0, run = 0;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, ax = p[i * 2], ay = p[i * 2 + 1], ex = p[j * 2] - ax, ey = p[j * 2 + 1] - ay, len = Math.hypot(ex, ey);
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (len * len))) : 0;
    const dd = Math.hypot(x - ax - ex * t, y - ay - ey * t);
    if (dd < d) { d = dd; at = run + t * len; side = ex * (y - ay) - ey * (x - ax) < 0 ? -1 : 1; }
    run += len;
  }
  const cell = Math.max(sh.cell, 1e-9), q = d / w;
  switch (sh.pattern) {
    case 'groove': return q > 1 ? null : -sh.depth * profileAt(sh.profile, q);
    case 'bead': {
      // a weld: a round bead whose ripples are crescents pointing the way it was laid
      if (q > 1) return null;
      const f = Math.sqrt(1 - q * q), phase = at / cell + 0.6 * (1 - f);
      return f * (sh.depth + sh.amount * (0.5 + 0.5 * Math.cos(2 * Math.PI * phase)));
    }
    case 'stitch': {
      // a channel a little wider than the row, the thread laid in it as slanted dashes
      if (q > 1.5) return null;
      const ch = -sh.amount * (1 - (q / 1.5) ** 2);
      const u = at - (Math.floor(at / cell) + 0.5) * cell, v = side * d, co = 0.94, si = 0.342;
      const a = u * co + v * si, b = -u * si + v * co, L = 0.36 * cell, tw = w * 0.45;
      if (Math.abs(a) >= L || Math.abs(b) >= tw) return ch;
      return ch * 0.5 + sh.depth * Math.sqrt(1 - (b / tw) ** 2) * Math.sqrt(1 - (a / L) ** 4);
    }
    case 'rivets': {
      // a head every `cell`, centred on an open line (a closed row spaced evenly round), each turned to the line
      const k = sh.closed ? Math.max(1, Math.round(run / cell)) : Math.max(0, Math.floor(run / cell));
      const sp = sh.closed ? run / k : cell, o = sh.closed ? 0 : (run - k * sp) / 2, heads = sh.closed ? k : k + 1;
      let best = Infinity, X = 0, Y = 0, walked = 0, h0 = 0;
      for (let i = 0; i < segs && h0 < heads; i++) {
        const j = (i + 1) % n, ax = p[i * 2], ay = p[i * 2 + 1], ex = p[j * 2] - ax, ey = p[j * 2 + 1] - ay, len = Math.hypot(ex, ey);
        if (len <= 0) continue;
        const tx = ex / len, ty = ey / len;
        while (h0 < heads && o + h0 * sp <= walked + len + 1e-9) {
          const s = o + h0 * sp - walked, cx = ax + tx * s, cy = ay + ty * s, dd = Math.hypot(x - cx, y - cy);
          if (dd < best) { best = dd; X = ((x - cx) * tx + (y - cy) * ty) / w; Y = (-(x - cx) * ty + (y - cy) * tx) / w; }
          h0++;
        }
        walked += len;
      }
      return best > w ? null : fastener(sh, X, Y);
    }
    default: {
      // scratch: a V gouge whose displaced metal stands up as a burr on both lips, tapering out at an open line's ends
      if (q > 1) return null;
      const f = q < 0.55 ? -(1 - q / 0.55) : 0.3 * Math.sin((Math.PI * (q - 0.55)) / 0.45);
      const taper = sh.closed ? 1 : Math.sqrt(Math.sin(Math.PI * Math.min(1, Math.max(0, at / (run || 1)))));
      return Math.max(0, sh.depth - sh.amount * vnoise(at / cell)) * f * taper;
    }
  }
}
/** A screw, bolt or rivet head at (X, Y) in units of its outer radius (1 = the washer's edge with one, else the
 *  head's), null outside: the head `depth` high, its drive cut `amount` deep. Engine: `fastener`. */
function fastener(sh: Shape, X: number, Y: number) {
  const rho = Math.hypot(X, Y);
  if (rho > 1) return null;
  let base = 0, hx = X, hy = Y;
  if (sh.washer) { base = 0.22 * smooth01((1 - rho) / 0.05); hx = X * 1.35; hy = Y * 1.35; }
  const r = Math.hypot(hx, hy);
  if (r > 1) return sh.depth * base;
  const ax = Math.abs(hx), ay = Math.abs(hy);
  let H: number;
  switch (sh.head) {
    case 'pan': { const t = Math.min(1, (1 - r) / 0.4); H = Math.sqrt(1 - (1 - t) ** 2) * (0.92 + 0.08 * Math.sqrt(1 - r * r)); break; }
    case 'flat': H = r > 0.93 ? -0.35 * Math.sin((Math.PI * (r - 0.93)) / 0.07) : 0; break;
    case 'cap': H = Math.min(1, (1 - r) / 0.12); break;
    case 'hexhead': {
      // six flats, the top's corners turned off by the bolt's chamfer circle
      const flat = Math.max(ay, ax * 0.866 + ay * 0.5);
      H = flat > 0.85 ? 0 : Math.min(Math.min(1, (0.85 - flat) / 0.04), 0.55 + 0.45 * Math.max(0, Math.min(1, (0.87 - r) / 0.12)));
      break;
    }
    default: H = 0.2 * smooth01((1 - r) / 0.05) + 0.8 * Math.sqrt(1 - r * r);
  }
  // the drive: its outline as a distance (negative inside), and how deep its floor sinks toward the middle
  let sd = 1, floor = 1, scribe = 0;
  switch (sh.drive) {
    case 'slot': sd = Math.max(ax - 1.2, ay - 0.085); break;
    case 'phillips': case 'pozi': {
      const pozi = sh.drive === 'pozi';
      const arm = (a: number, b: number) => Math.max(a - 0.55, b - (pozi ? 0.075 : 0.06 + 0.1 * Math.max(0, 1 - a / 0.55)));
      sd = Math.min(arm(ax, ay), arm(ay, ax), r - 0.16);
      floor = 0.55 + 0.45 * Math.max(0, 1 - r / 0.55);
      if (pozi) {
        // Pozidriv's four scribed ticks between the arms
        const u = Math.abs(hx + hy) * 0.7071, v = Math.abs(hx - hy) * 0.7071;
        scribe = Math.max(smooth01(-Math.max(u - 0.42, v - 0.012) / 0.01), smooth01(-Math.max(v - 0.42, u - 0.012) / 0.01));
      }
      break;
    }
    case 'torx': sd = r - (0.25 + 0.17 * (0.5 + 0.5 * Math.cos(6 * Math.atan2(hy, hx))) ** 1.6); floor = 0.8 + 0.2 * Math.max(0, 1 - r / 0.4); break;
    case 'hex': sd = Math.max(ay, ax * 0.866 + ay * 0.5) - 0.3; floor = 0.75 + 0.25 * Math.max(0, 1 - r / 0.3); break;
    case 'square': sd = Math.max(ax, ay) - 0.22; floor = 0.75 + 0.25 * Math.max(0, 1 - r / 0.3); break;
  }
  const cut = smooth01(-sd / 0.03) * floor + 0.15 * scribe;
  return sh.depth * (base + H) - sh.amount * cut;
}
/** Triangle t's texel size in world units at an n² texture. Engine: `texel_sizes`. */
function texelSize(pos: ArrayLike<number>, uvs: ArrayLike<number>, t: number, n: number) {
  const o = t * 9, q = t * 6;
  const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
  const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
  const area = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
  const uva = Math.abs((uvs[q + 2] - uvs[q]) * (uvs[q + 5] - uvs[q + 1]) - (uvs[q + 4] - uvs[q]) * (uvs[q + 3] - uvs[q + 1])) * n * n;
  return uva > 0 ? Math.sqrt(area / uva) : 0;
}
/** Distance from p to the triangle abc: to its plane where p projects inside it, else to its nearest edge. Engine: `tri_dist`. */
function triDist(a: V, b: V, c: V, p: V) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], q = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d11 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], d12 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], d22 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
  const q1 = q[0] * e1[0] + q[1] * e1[1] + q[2] * e1[2], q2 = q[0] * e2[0] + q[1] * e2[1] + q[2] * e2[2], det = d11 * d22 - d12 * d12;
  const seg = (s: V, t: V) => {
    const ex = t[0] - s[0], ey = t[1] - s[1], ez = t[2] - s[2], l2 = ex * ex + ey * ey + ez * ez;
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - s[0]) * ex + (p[1] - s[1]) * ey + (p[2] - s[2]) * ez) / l2)) : 0;
    return Math.hypot(p[0] - s[0] - ex * k, p[1] - s[1] - ey * k, p[2] - s[2] - ez * k);
  };
  if (det > 0) {
    const u = (d22 * q1 - d12 * q2) / det, v = (d11 * q2 - d12 * q1) / det;
    if (u >= 0 && v >= 0 && u + v <= 1) return Math.hypot(q[0] - u * e1[0] - v * e2[0], q[1] - u * e1[1] - v * e2[1], q[2] - u * e1[2] - v * e2[2]);
  }
  return Math.min(seg(a, b), seg(b, c), seg(c, a));
}
/** Where on a decal's exponential map (`expMap`) the point p on triangle t lands, or null where the walk stopped. */
export function mapAt(pos: ArrayLike<number>, map: Float64Array, t: number, p: ArrayLike<number>): [number, number] | null {
  const o = t * 9;
  const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
  const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
  const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x, f2 = fx * fx + fy * fy + fz * fz;
  if (f2 <= 0) return null;
  const px = p[0] - pos[o], py = p[1] - pos[o + 1], pz = p[2] - pos[o + 2];
  const w1 = ((py * e2z - pz * e2y) * fx + (pz * e2x - px * e2z) * fy + (px * e2y - py * e2x) * fz) / f2;
  const w2 = ((e1y * pz - e1z * py) * fx + (e1z * px - e1x * pz) * fy + (e1x * py - e1y * px) * fz) / f2, w0 = 1 - w1 - w2;
  const u = w0 * map[t * 6] + w1 * map[t * 6 + 2] + w2 * map[t * 6 + 4], v = w0 * map[t * 6 + 1] + w1 * map[t * 6 + 3] + w2 * map[t * 6 + 5];
  return Number.isNaN(u) || Number.isNaN(v) ? null : [u, v];
}
/** How far a shape reaches from its centre (world units): its outline's farthest corner. */
export function reachOf(sh: Shape, hw: number, hh: number) {
  return Math.max(...(sh.outline ?? RECT_OUTLINE).map(([x, y]) => Math.hypot(x * hw, y * hh)));
}

type V = [number, number, number];
/** The least rotation taking unit a onto unit b, applied to x. */
function turn(a: V, b: V, x: V): V {
  const k: V = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], co = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (co < -0.9999) return [x[0], x[1], x[2]];
  const kd = (k[0] * x[0] + k[1] * x[1] + k[2] * x[2]) / (1 + co);
  return [x[0] * co + (k[1] * x[2] - k[2] * x[1]) + k[0] * kd, x[1] * co + (k[2] * x[0] - k[0] * x[2]) + k[1] * kd, x[2] * co + (k[0] * x[1] - k[1] * x[0]) + k[2] * kd];
}
/** The surface's own coordinates round a decal's centre, for wrapping (a discrete exponential map, Schmidt, Grimm &
 *  Wyvill 2006): the soup welded into vertices, the triangle nearest the centre seeded by flat projection, then
 *  Dijkstra outward, each vertex placed from the one that reached it: the step turned into that vertex's tangent
 *  plane (its frame carried from the centre by the least rotation between normals), its length kept. Per soup corner
 *  (u, v) along the frame's right / up; NaN where the walk stopped (past `reach`). Engine: `exp_map`, same steps. */
export function expMap(pos: ArrayLike<number>, c: V, nrm: V, uax: V, vax: V, reach: number): Float64Array {
  const corners = pos.length / 3, id = new Int32Array(corners), key = new Map<string, number>(), vp: number[] = [];
  for (let k = 0; k < corners; k++) {
    const s = `${Math.round(pos[k * 3] * 1e5)},${Math.round(pos[k * 3 + 1] * 1e5)},${Math.round(pos[k * 3 + 2] * 1e5)}`;
    let v = key.get(s);
    if (v === undefined) { v = vp.length / 3; key.set(s, v); vp.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]); }
    id[k] = v;
  }
  const nv = vp.length / 3, vn = new Float64Array(nv * 3), nb: number[][] = Array.from({ length: nv }, () => []);
  const P = (v: number): V => [vp[v * 3], vp[v * 3 + 1], vp[v * 3 + 2]], N = (v: number): V => [vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]];
  for (let t = 0; t < corners / 3; t++) {
    const a = id[t * 3], b = id[t * 3 + 1], d = id[t * 3 + 2], pa = P(a), pb = P(b), pd = P(d);
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], e2 = [pd[0] - pa[0], pd[1] - pa[1], pd[2] - pa[2]];
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; // area-weighted
    for (const v of [a, b, d]) for (let k = 0; k < 3; k++) vn[v * 3 + k] += f[k];
    for (const [p, q] of [[a, b], [b, d], [d, a]]) { if (!nb[p].includes(q)) nb[p].push(q); if (!nb[q].includes(p)) nb[q].push(p); }
  }
  for (let v = 0; v < nv; v++) { const l = Math.hypot(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]) || 1; for (let k = 0; k < 3; k++) vn[v * 3 + k] /= l; }
  for (const l of nb) l.sort((x, y) => x - y);
  // seed: the triangle the centre lies on (nearest by point-to-triangle distance; by the corners' summed distance a
  // small triangle near a big face won, and the walk from there never reached the face the mark is on)
  let best = -1, bestD = Infinity;
  for (let t = 0; t < corners / 3; t++) {
    const dd = triDist(P(id[t * 3]), P(id[t * 3 + 1]), P(id[t * 3 + 2]), c);
    if (dd < bestD) { bestD = dd; best = t; }
  }
  const out = new Float64Array(corners * 2).fill(NaN);
  if (best < 0) return out;
  const uv = new Float64Array(nv * 2), dist = new Float64Array(nv).fill(Infinity), done = new Uint8Array(nv);
  const fu: V[] = new Array(nv), fv: V[] = new Array(nv);
  // a binary heap of [dist when pushed, vertex], least first (the engine's BinaryHeap order)
  const heap: [number, number][] = [], less = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const push = (v: number) => {
    const x: [number, number] = [dist[v], v];
    let i = heap.push(x) - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!less(x, heap[p])) break; heap[i] = heap[p]; i = p; }
    heap[i] = x;
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = last, at = i;
        if (l < heap.length && less(heap[l], m)) { m = heap[l]; at = l; }
        if (r < heap.length && less(heap[r], m)) { m = heap[r]; at = r; }
        if (at === i) break;
        heap[i] = m; i = at;
      }
      heap[i] = last;
    }
    return top[1];
  };
  for (let k = 0; k < 3; k++) {
    const v = id[best * 3 + k];
    if (dist[v] !== Infinity) continue;
    const p = P(v), d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    uv[v * 2] = d[0] * uax[0] + d[1] * uax[1] + d[2] * uax[2]; uv[v * 2 + 1] = d[0] * vax[0] + d[1] * vax[1] + d[2] * vax[2];
    dist[v] = Math.hypot(uv[v * 2], uv[v * 2 + 1]);
    fu[v] = turn(nrm, N(v), uax); fv[v] = turn(nrm, N(v), vax);
    push(v);
  }
  while (heap.length) {
    const p = pop();
    if (done[p]) continue;
    done[p] = 1;
    if (dist[p] > reach) continue;
    const pp = P(p), np = N(p);
    for (const q of nb[p]) {
      if (done[q]) continue;
      const pq = P(q), e = [pq[0] - pp[0], pq[1] - pp[1], pq[2] - pp[2]], len = Math.hypot(e[0], e[1], e[2]);
      if (dist[p] + len >= dist[q]) continue;
      // the step in p's tangent plane, its length kept
      const en = e[0] * np[0] + e[1] * np[1] + e[2] * np[2], s = [e[0] - np[0] * en, e[1] - np[1] * en, e[2] - np[2] * en], sl = Math.hypot(s[0], s[1], s[2]);
      const k = sl > 1e-12 ? len / sl : 0;
      dist[q] = dist[p] + len;
      uv[q * 2] = uv[p * 2] + (s[0] * fu[p][0] + s[1] * fu[p][1] + s[2] * fu[p][2]) * k;
      uv[q * 2 + 1] = uv[p * 2 + 1] + (s[0] * fv[p][0] + s[1] * fv[p][1] + s[2] * fv[p][2]) * k;
      fu[q] = turn(np, N(q), fu[p]); fv[q] = turn(np, N(q), fv[p]);
      push(q);
    }
  }
  for (let k = 0; k < corners; k++) if (done[id[k]]) { out[k * 2] = uv[id[k] * 2]; out[k * 2 + 1] = uv[id[k] * 2 + 1]; }
  return out;
}

/** Bake a shape decal: per texel the relief's height and its slope as a tangent-space normal (Normal / Height). Flat:
 *  front-facing surface inside the projector, like an image decal. Wrapped: wherever `expMap` reached. */
export function bakeShape(s: TexSet, l: PaintLayer, pos: ArrayLike<number>, uvs: ArrayLike<number>, span: number) {
  const d = l.decal, sh = d?.shape;
  if (!d || !sh) return;
  for (const ch of Object.keys(l.px) as Channel[]) touch(l, ch);
  ensureShell(s, uvs);
  const n = s.size;
  const { cx, cy, cz, nx, ny, nz, uxr, uyr, uzr, vxr, vyr, vzr, width, height, depth } = decalFrame(d, span);
  for (const ch of Object.keys(l.px) as Channel[]) if (!d.channels.includes(ch)) delete l.px[ch];
  const nm = d.channels.includes('normal') ? fillBuf(s, l, 'normal') : null, ht = d.channels.includes('height') ? fillBuf(s, l, 'height') : null;
  nm?.fill(0); ht?.fill(0);
  // painted: the panel's finish inside, the rim's on the border band
  const col = d.channels.includes('color') ? fillBuf(s, l, 'color') : null, rc = col && d.channels.includes('rough') ? fillBuf(s, l, 'rough') : null, mt = col && d.channels.includes('metal') ? fillBuf(s, l, 'metal') : null;
  col?.fill(0); rc?.fill(0); mt?.fill(0);
  const fin = (f: { tint: string; roughness: number; metallic: number }) => [...hexTint(f.tint), f.roughness * 255, f.metallic * 255];
  const inner = fin(d), outer = fin(d.rim ?? d);
  let rim = false;
  const hw = width / 2, hh = height / 2, fu = d.flipH ? -1 : 1, fv = d.flipV ? -1 : 1;
  const e0 = slopeStep(sh, hw, hh), top = Math.max(sh.depth, Math.abs(sh.amount), 1e-9);
  let e = e0;
  const at = (a: number, b: number) => shapeHeight(sh, a, b, hw, hh) ?? 0;
  const map = d.wrap ? expMap(pos, [cx, cy, cz], [nx, ny, nz], [uxr, uyr, uzr], [vxr, vyr, vzr], reachOf(sh, hw, hh) * 1.25 + sh.cell) : null;
  // the decal's axes at the texel: the frame's when flat, the map's own directions on a wrapped triangle
  let Ux = uxr, Uy = uyr, Uz = uzr, Vx = vxr, Vy = vyr, Vz = vzr;
  let h = 0, gx = 0, gy = 0, tx = 1, ty = 0, tz = 0, bx = 0, by = 1, bz = 0;
  ready(n);
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let m0u = 0, m0v = 0, m1u = 0, m1v = 0, m2u = 0, m2v = 0;
    if (map) {
      m0u = map[t * 6]; m0v = map[t * 6 + 1]; m1u = map[t * 6 + 2]; m1v = map[t * 6 + 3]; m2u = map[t * 6 + 4]; m2v = map[t * 6 + 5];
      if (Number.isNaN(m0u) || Number.isNaN(m1u) || Number.isNaN(m2u)) continue;
      // the map's directions on this triangle: dP/du, dP/dv
      const du1 = m1u - m0u, dv1 = m1v - m0v, du2 = m2u - m0u, dv2 = m2v - m0v, det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) < 1e-14) continue;
      Ux = (e1x * dv2 - e2x * dv1) / det; Uy = (e1y * dv2 - e2y * dv1) / det; Uz = (e1z * dv2 - e2z * dv1) / det;
      Vx = (e2x * du1 - e1x * du2) / det; Vy = (e2y * du1 - e1y * du2) / det; Vz = (e2z * du1 - e1z * du2) / det;
      const ul = Math.hypot(Ux, Uy, Uz) || 1, vl = Math.hypot(Vx, Vy, Vz) || 1;
      Ux /= ul; Uy /= ul; Uz /= ul; Vx /= vl; Vy /= vl; Vz /= vl;
    } else if (fx * nx + fy * ny + fz * nz < 0.12) continue;
    [tx, ty, tz, bx, by, bz] = tangentOf(pos, uvs, t, fx, fy, fz);
    // never finer than half a texel here: a hard rim sampled finer than the texture aliases into steps (engine: the same)
    e = Math.max(e0, texelSize(pos, uvs, t, n) * 0.5);
    raster(n, pos, uvs, t, (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      let a: number, b: number;
      if (map) {
        // the point's barycentric weights on the triangle, then the map there
        const px = x - pos[o], py = y - pos[o + 1], pz = z - pos[o + 2];
        const w1 = ((py * e2z - pz * e2y) * fx + (pz * e2x - px * e2z) * fy + (px * e2y - py * e2x) * fz) / fl;
        const w2 = ((e1y * pz - e1z * py) * fx + (e1z * px - e1x * pz) * fy + (e1x * py - e1y * px) * fz) / fl, w0 = 1 - w1 - w2;
        a = (w0 * m0u + w1 * m1u + w2 * m2u) * fu; b = (w0 * m0v + w1 * m1v + w2 * m2v) * fv;
      } else {
        if (Math.abs(dx * nx + dy * ny + dz * nz) > depth) return 0;
        a = (dx * uxr + dy * uyr + dz * uzr) * fu; b = (dx * vxr + dy * vyr + dz * vzr) * fv;
      }
      const hv = shapeHeight(sh, a, b, hw, hh);
      if (hv === null) return 0;
      h = hv;
      if (col) rim = onRim(sh, a, b, hw, hh);
      // the slope along the decal's axes, into world, then the triangle's tangent space; the normal leans downhill
      const su = ((at(a + e, b) - at(a - e, b)) / (2 * e)) * fu, sv = ((at(a, b + e) - at(a, b - e)) / (2 * e)) * fv;
      const wx = su * Ux + sv * Vx, wy = su * Uy + sv * Vy, wz = su * Uz + sv * Vz;
      gx = wx * tx + wy * ty + wz * tz; gy = wx * bx + wy * by + wz * bz;
      return 1;
    }, undefined, (_x, _y, _z, i) => {
      if (nm) {
        const k = 1 / Math.hypot(gx, gy, 1);
        nm[i * 4] = (-gx * k * 0.5 + 0.5) * 255; nm[i * 4 + 1] = (-gy * k * 0.5 + 0.5) * 255; nm[i * 4 + 2] = (k * 0.5 + 0.5) * 255; nm[i * 4 + 3] = 255;
      }
      if (ht) { ht[i * 2] = 128 + 127 * Math.max(-1, Math.min(1, h / top)); ht[i * 2 + 1] = 255; }
      if (col) {
        const f = rim ? outer : inner;
        col[i * 4] = f[0]; col[i * 4 + 1] = f[1]; col[i * 4 + 2] = f[2]; col[i * 4 + 3] = 255;
        if (rc) { rc[i * 2] = f[3]; rc[i * 2 + 1] = 255; }
        if (mt) { mt[i * 2] = f[4]; mt[i * 2 + 1] = 255; }
      }
    });
  }
  for (const i of touched) weight[i] = 0;
  touched.length = 0;
}

/** Bake a relief decal (DECALmachine's): the mark's own normal and height maps, under its mask's red coverage,
 *  written to Normal and Height. Front-facing surface inside the projector, like an image decal; no ink is laid
 *  down, so the surface's colour and finish stay. The maps' +X is the mark's right, +Y its up, +Z its facing. */
export function bakeRelief(s: TexSet, l: PaintLayer, maps: ReliefPixels, pos: ArrayLike<number>, uvs: ArrayLike<number>, span: number) {
  const d = l.decal;
  if (!d) return;
  for (const ch of Object.keys(l.px) as Channel[]) touch(l, ch);
  ensureShell(s, uvs);
  const n = s.size;
  const { cx, cy, cz, nx, ny, nz, uxr, uyr, uzr, vxr, vyr, vzr, width, height, depth } = decalFrame(d, span);
  for (const ch of Object.keys(l.px) as Channel[]) if (!d.channels.includes(ch)) delete l.px[ch];
  const nm = d.channels.includes('normal') ? fillBuf(s, l, 'normal') : null;
  const ht = d.channels.includes('height') ? fillBuf(s, l, 'height') : null;
  nm?.fill(0); ht?.fill(0);
  if (!nm && !ht) return;
  const strength = d.reliefNormal ?? 1, contrast = d.reliefHeight ?? 1;
  // a flip mirrors the mark, so the slope's own X / Y turns over with the sampled map
  const fh = d.flipH ? -1 : 1, fv = d.flipV ? -1 : 1;
  let a = 0, hb = 0, gx = 0, gy = 0, gz = 1, tx = 1, ty = 0, tz = 0, bx = 0, by = 1, bz = 0;
  ready(n);
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    if (fx * nx + fy * ny + fz * nz < 0.12) continue;
    [tx, ty, tz, bx, by, bz] = tangentOf(pos, uvs, t, fx, fy, fz);
    raster(n, pos, uvs, t, (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      if (Math.abs(dx * nx + dy * ny + dz * nz) > depth) return 0;
      const u = (dx * uxr + dy * uyr + dz * uzr) / width + 0.5;
      const v = (dx * vxr + dy * vyr + dz * vzr) / height + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      const su = d.flipH ? 1 - u : u, sv = d.flipV ? 1 - v : v;
      a = sampleDecal(maps.mask, su, sv)[0] / 255;
      if (a < 0.004) return 0;
      hb = sampleDecal(maps.height, su, sv)[2] / 255;
      const q = sampleDecal(maps.normal, su, sv);
      const ax = (q[0] / 127.5 - 1) * strength * fh, ay = (q[1] / 127.5 - 1) * strength * fv, az = q[2] / 127.5 - 1;
      // the mark's tangent space to world, then the triangle's own tangent frame (the texture's space)
      const wx = ax * uxr + ay * vxr + az * nx, wy = ax * uyr + ay * vyr + az * ny, wz = ax * uzr + ay * vzr + az * nz;
      gx = wx * tx + wy * ty + wz * tz; gy = wx * bx + wy * by + wz * bz; gz = wx * fx + wy * fy + wz * fz;
      const gl = Math.hypot(gx, gy, gz) || 1; gx /= gl; gy /= gl; gz /= gl;
      return a;
    }, undefined, (_x, _y, _z, i) => {
      if (nm) { nm[i * 4] = (gx * 0.5 + 0.5) * 255; nm[i * 4 + 1] = (gy * 0.5 + 0.5) * 255; nm[i * 4 + 2] = (gz * 0.5 + 0.5) * 255; nm[i * 4 + 3] = a * 255; }
      if (ht) { ht[i * 2] = 128 + 127 * Math.max(-1, Math.min(1, (hb - 0.5) * 2 * contrast)); ht[i * 2 + 1] = a * 255; }
    });
  }
  for (const i of touched) weight[i] = 0;
  touched.length = 0;
}

/** A part's bevelled edges: per edge `[a xyz, b xyz, na xyz, nb xyz]` (the two faces' normals), and a grid of `radius`
 *  cells listing the edges crossing each. Welded by exact position. Engine: `BevelSrc::new`. */
export function bevelEdges(pos: ArrayLike<number>, b: Bevel) {
  const tris = pos.length / 9, fn = new Float64Array(tris * 3), fc = new Float64Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x, l = Math.hypot(fx, fy, fz) || 1;
    fn[t * 3] = fx / l; fn[t * 3 + 1] = fy / l; fn[t * 3 + 2] = fz / l;
    for (let k = 0; k < 3; k++) fc[t * 3 + k] = (pos[o + k] + pos[o + 3 + k] + pos[o + 6 + k]) / 3;
  }
  const key = (c: number) => `${pos[c * 3]},${pos[c * 3 + 1]},${pos[c * 3 + 2]}`, on = new Map<string, number[]>();
  for (let c = 0; c < tris * 3; c++) {
    const d = c - (c % 3) + ((c + 1) % 3), ka = key(c), kb = key(d), k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const e = on.get(k);
    if (e) e.push(c); else on.set(k, [c]);
  }
  const r = b.radius, cos = Math.cos((b.angle * Math.PI) / 180), segs: number[] = [], grid = new Map<string, number[]>();
  const cell = (x: number, y: number, z: number) => `${Math.floor(x / r)},${Math.floor(y / r)},${Math.floor(z / r)}`;
  for (const cs of on.values()) {
    if (cs.length !== 2) continue;
    const c = cs[0], ta = (c / 3) | 0, tb = (cs[1] / 3) | 0, d = c - (c % 3) + ((c + 1) % 3);
    const dot = fn[ta * 3] * fn[tb * 3] + fn[ta * 3 + 1] * fn[tb * 3 + 1] + fn[ta * 3 + 2] * fn[tb * 3 + 2];
    if (dot > cos) continue;
    // concave when b's centre lies in front of a's plane
    const side = (fc[tb * 3] - pos[c * 3]) * fn[ta * 3] + (fc[tb * 3 + 1] - pos[c * 3 + 1]) * fn[ta * 3 + 1] + (fc[tb * 3 + 2] - pos[c * 3 + 2]) * fn[ta * 3 + 2];
    if (side > 0 && !b.concave) continue;
    const id = segs.length / 12, ax = pos[c * 3], ay = pos[c * 3 + 1], az = pos[c * 3 + 2], bx = pos[d * 3], by = pos[d * 3 + 1], bz = pos[d * 3 + 2];
    segs.push(ax, ay, az, bx, by, bz, fn[ta * 3], fn[ta * 3 + 1], fn[ta * 3 + 2], fn[tb * 3], fn[tb * 3 + 1], fn[tb * 3 + 2]);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / (r / 8))), seen = new Set<string>();
    for (let k = 0; k <= steps; k++) {
      const f = k / steps, q = cell(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f);
      if (seen.has(q)) continue;
      seen.add(q);
      const list = grid.get(q);
      if (list) list.push(id); else grid.set(q, [id]);
    }
  }
  return { segs, grid };
}
/** The bevelled normal at p on a face of normal f, or null outside every edge's band. Each edge within `radius` whose
 *  near face f belongs to (closer to f than half the edge's turn) and whose plane p lies on leans the normal toward the
 *  far face by phi: the halfway turn at the edge down to none at `radius`, along a circular fillet spanned between the
 *  two band borders (round; phi = half − asin(d/r · sin half), no flat strip at the edge), or the halfway turn all
 *  across (chamfer). Leans the same way (within 45°) keep the strongest
 *  — the segments of one edge, or a curve's facets: summed, every vertex along an edge beaded — and leans different
 *  ways add, so corners round both ways. */
export function bevelNormal(e: ReturnType<typeof bevelEdges>, b: Bevel, px: number, py: number, pz: number, fx: number, fy: number, fz: number): [number, number, number] | null {
  const r = b.radius, cx = Math.floor(px / r), cy = Math.floor(py / r), cz = Math.floor(pz / r), seen: number[] = [], S = e.segs;
  const lean: number[] = []; // per direction: ux, uy, uz, tan(phi)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const list = e.grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
    if (!list) continue;
    for (const id of list) {
      if (seen.includes(id)) continue;
      seen.push(id);
      const o = id * 12, ex = S[o + 3] - S[o], ey = S[o + 4] - S[o + 1], ez = S[o + 5] - S[o + 2];
      const qx = px - S[o], qy = py - S[o + 1], qz = pz - S[o + 2], ee = ex * ex + ey * ey + ez * ez;
      const t = ee > 1e-20 ? Math.max(0, Math.min(1, (qx * ex + qy * ey + qz * ez) / ee)) : 0;
      const d = Math.hypot(qx - ex * t, qy - ey * t, qz - ez * t);
      if (d >= r) continue;
      const sa = fx * S[o + 6] + fy * S[o + 7] + fz * S[o + 8], sb = fx * S[o + 9] + fy * S[o + 10] + fz * S[o + 11];
      const half = Math.acos(Math.max(-1, Math.min(1, S[o + 6] * S[o + 9] + S[o + 7] * S[o + 10] + S[o + 8] * S[o + 11]))) / 2;
      if (Math.max(sa, sb) <= Math.cos(half)) continue; // a face of another edge (a box's top beside a side's corner)
      const k = sa >= sb ? o + 9 : o + 6, so = sa >= sb ? sb : sa, m = sa >= sb ? o + 6 : o + 9;
      // off the near face's plane: a parallel face nearby (a step, the far side of a thin plate), not this edge's face
      if (Math.abs(qx * S[m] + qy * S[m + 1] + qz * S[m + 2]) > r / 4) continue;
      let ux = S[k] - fx * so, uy = S[k + 1] - fy * so, uz = S[k + 2] - fz * so;
      const ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-6) continue;
      ux /= ul; uy /= ul; uz /= ul;
      const phi = b.profile === 'chamfer' ? half : half - Math.asin((d / r) * Math.sin(half));
      const w = Math.tan(phi);
      let j = 0;
      while (j < lean.length && ux * lean[j] + uy * lean[j + 1] + uz * lean[j + 2] <= Math.SQRT1_2) j += 4;
      if (j === lean.length) lean.push(ux, uy, uz, w);
      else if (w > lean[j + 3]) lean.splice(j, 4, ux, uy, uz, w);
    }
  }
  if (!lean.length) return null;
  let nx = fx, ny = fy, nz = fz;
  for (let j = 0; j < lean.length; j += 4) { nx += lean[j] * lean[j + 3]; ny += lean[j + 1] * lean[j + 3]; nz += lean[j + 2] * lean[j + 3]; }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
/** Bake a bevel layer: its Normal, only where an edge leans it. Engine: `layers::BevelSrc::at`. */
export function bakeBevel(s: TexSet, l: PaintLayer, pos: ArrayLike<number>, uvs: ArrayLike<number>) {
  const b = l.bevel;
  if (!b) return;
  for (const ch of Object.keys(l.px) as Channel[]) touch(l, ch);
  ensureShell(s, uvs);
  const n = s.size, e = bevelEdges(pos, b);
  for (const ch of Object.keys(l.px) as Channel[]) if (ch !== 'normal') delete l.px[ch];
  const nm = fillBuf(s, l, 'normal');
  nm.fill(0);
  if (!e.segs.length || bakeBevelGpu(n, b, e, pos, uvs, nm)) return;
  let a = 0, c = 0, z = 1;
  ready(n);
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-14) continue;
    fx /= fl; fy /= fl; fz /= fl;
    const [tx, ty, tz, bx, by, bz] = tangentOf(pos, uvs, t, fx, fy, fz);
    raster(n, pos, uvs, t, (x, y, zz) => {
      const w = bevelNormal(e, b, x, y, zz, fx, fy, fz);
      if (!w) return 0;
      a = w[0] * tx + w[1] * ty + w[2] * tz; c = w[0] * bx + w[1] * by + w[2] * bz; z = w[0] * fx + w[1] * fy + w[2] * fz;
      return 1;
    }, undefined, (_x, _y, _z, i) => {
      nm[i * 4] = (a * 0.5 + 0.5) * 255; nm[i * 4 + 1] = (c * 0.5 + 0.5) * 255; nm[i * 4 + 2] = (z * 0.5 + 0.5) * 255; nm[i * 4 + 3] = 255;
    });
  }
  for (const i of touched) weight[i] = 0;
  touched.length = 0;
}

/** bakeBevel on the GPU (gpubake.ts BEVEL): the edges, their grid as an open-addressed table of cells and each
 *  triangle's frame go up as float rows; the CPU rasterises, keeping per texel the first two triangles over it (the
 *  CPU loop takes the first that leans; a third over one texel is a corner of a seam's bleed, left out). */
function bakeBevelGpu(n: number, b: Bevel, e: ReturnType<typeof bevelEdges>, pos: ArrayLike<number>, uvs: ArrayLike<number>, nm: Uint8ClampedArray) {
  const T = pos.length / 9;
  if (!gpuBakeReady(n) || T >= 1 << 24) return false;
  const frames = new Float32Array(T * 12), live = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-14) continue;
    fx /= fl; fy /= fl; fz /= fl;
    live[t] = 1;
    const [tx, ty, tz, bx, by, bz] = tangentOf(pos, uvs, t, fx, fy, fz);
    frames.set([fx, fy, fz, 0, tx, ty, tz, 0, bx, by, bz, 0], t * 12);
  }
  const cells = cellTable(e.grid), uFrame = rows(frames), uSeg = rows(new Float32Array(e.segs));
  const reaches = rowSpans(n, uvs, T);
  const ok = gpuBake(n, {
    frag: BEVEL, inputs: 2, temp: [uFrame, uSeg, ...cells.temp],
    uniforms: { uFrame, uSeg, ...cells.uniforms, uR: b.radius, uChamfer: +(b.profile === 'chamfer') },
  }, [0], (y0, h, [c0, c1]) => {
    const clip: Rect = [0, y0, n - 1, y0 + h - 1], base = y0 * n;
    for (let t = 0; t < T; t++) {
      if (!live[t] || !reaches(y0, h, t)) continue;
      raster(n, pos, uvs, t, (x, y, z, i) => {
        const o = (i - base) * 4, into = !c0[o + 3] ? c0 : !c1[o + 3] ? c1 : null;
        if (into) { into[o] = x; into[o + 1] = y; into[o + 2] = z; into[o + 3] = t + 1; }
        return 1;
      }, clip);
    }
  }, (_o, y0, h, rgba) => {
    for (let j = 0, i = y0 * n; j < n * h; j++, i++) if (rgba[j * 4 + 3]) { nm[i * 4] = rgba[j * 4]; nm[i * 4 + 1] = rgba[j * 4 + 1]; nm[i * 4 + 2] = rgba[j * 4 + 2]; nm[i * 4 + 3] = 255; }
  });
  for (const i of touched) weight[i] = 0;
  touched.length = 0;
  return ok;
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
  if (x1 >= 0) { touch(l, 'mask'); composite(s, x0, y0, x1, y1, undefined, false); }
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
  if (x1 >= 0) { touch(l, 'mask'); composite(s, x0, y0, x1, y1, undefined, false); }
}
/** White or black the whole mask (a fill layer with no mask is white). */
export function maskFill(s: TexSet, l: PaintLayer, value: number) { maskOf(s, l).fill(value); touch(l, 'mask'); }
/** Fill (or clear) the mask inside the selection; outside it stays as it was. */
export function maskSelection(s: TexSet, l: PaintLayer, erase: boolean) {
  const m = maskOf(s, l), v = erase ? 0 : 255;
  if (!s.sel) m.fill(v);
  else for (let i = 0; i < m.length; i++) if (s.sel[i]) m[i] = v;
  touch(l, 'mask');
}
export function maskInvert(s: TexSet, l: PaintLayer) { const m = maskOf(s, l); for (let i = 0; i < m.length; i++) m[i] = 255 - m[i]; touch(l, 'mask'); }

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

/** A layer's thumbnail (its Base Color, or its first painted channel, over a checkerboard where it's empty), as a data URL.
 *  Each pixel averages a 4×4 spread of the texels under it (one texel out of a 2048² set, per pixel, sparkled), at
 *  64 px so a 30 px row stays sharp on a high-DPI screen. */
export function thumbOf(s: TexSet, l: PaintLayer, size = 64) {
  const ch = (l.px.color ? 'color' : (Object.keys(l.px)[0] as Channel | undefined));
  const n = s.size, cv = document.createElement('canvas'), Q = 4;
  cv.width = cv.height = size;
  const img = new ImageData(size, size), px = ch && l.px[ch], k = ch ? CHANNELS[ch].k : 0;
  const v = [0, 0, 0];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4, bg = ((x >> 3) + (y >> 3)) % 2 ? 200 : 255;
    v[0] = v[1] = v[2] = 0;
    for (let sy = 0; sy < Q; sy++) for (let sx = 0; sx < Q; sx++) {
      const i = Math.min(n - 1, Math.floor(((size - 1 - y + (sy + 0.5) / Q) / size) * n)) * n + Math.min(n - 1, Math.floor(((x + (sx + 0.5) / Q) / size) * n));
      const a = px ? px[i * (k + 1) + k] / 255 : 0;
      for (let c = 0; c < 3; c++) v[c] += bg + ((px ? px[i * (k + 1) + Math.min(c, k - 1)] : bg) - bg) * a;
    }
    for (let c = 0; c < 3; c++) img.data[o + c] = v[c] / (Q * Q);
    img.data[o + 3] = 255;
  }
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv.toDataURL();
}
