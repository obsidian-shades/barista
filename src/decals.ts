// The decal shelf: transparent marks shipped with the app (public/decals) plus PNGs imported this
// session. A decal is an image and its aspect; Van Gogh projects it onto the model in the layer stack,
// so it paints and exports like any other layer.
import { decodeImage, type MapPixels } from './materials';
import { isLine, shapeHeight, slopeStep, type Shape } from './paint';

export interface DecalAsset {
  id: string;
  name: string;
  category: string;
  tags: string[];
  notes?: string;
  file: string;
  width: number;
  height: number;
  /** The ink the mark was drawn in; placing it starts with this colour. */
  tint?: string;
  license: string;
  source: string;
  /** A grip texture: no image, a relief drawn from these settings (sizes as shares of the model, made world units when placed). */
  shape?: Shape;
  /** Where placing it starts: its width as a % of the model (the Decal tool's Size). */
  size?: number;
}

/** Grip textures: relief panels the Decal tool places like any mark, written to Normal and Height. Sizes are shares
 *  of the model (a pistol grip panel is about a fifth of the gun's length). */
const grip = (id: string, name: string, w: number, h: number, shape: Shape, notes: string): DecalAsset =>
  ({ id: `shape-${id}`, name, category: 'Grip', tags: ['grip', 'relief', 'normal', shape.pattern], notes, file: '', width: w, height: h, license: 'CC0', source: 'Barista', shape, size: (GRIP_TALL * w) / h });
/** Every grip texture starts this tall (% of the model): a pistol's grip panel, whatever its width. */
const GRIP_TALL = 30;
export const GRIP_SHAPES: DecalAsset[] = [
  grip('stipple-panel', 'Stipple', 60, 100, { pattern: 'stipple', corner: 0.025, border: 0.006, depth: 0.003, cell: 0.0045, amount: 0.0012 }, 'Raised stipple for a textured grip panel.'),
  grip('grooved-panel', 'Ribs', 30, 100, { pattern: 'grooves', corner: 0.01, border: 0.004, depth: 0.003, cell: 0.012, amount: 0.0025 }, 'Parallel grooves; adjust their spacing after choosing this look.'),
  grip('checker-panel', 'Checkered', 60, 100, { pattern: 'checker', corner: 0.02, border: 0.006, depth: 0.003, cell: 0.008, amount: 0.0015 }, 'Diamond checkering for a textured grip panel.'),
  grip('groove-frame', 'Border only', 60, 100, { pattern: 'none', corner: 0.025, border: 0.006, depth: 0.003, cell: 0.005, amount: 0 }, 'A simple raised outline with no inner pattern.'),
];
/** The hard-surface detail a sculpt-and-bake would add, in Normal and Height: one tile per tool, the variants (profile,
 *  head, drive, washer, raised or pressed in) are its settings. Sizes are shares of the model; `size` a head's or
 *  pad's width as a % of it (lines are drawn, so theirs is the stretch the tile shows); a line's outline here is only
 *  the tile's sample stroke. */
const relief = (category: string, id: string, name: string, size: number, shape: Shape, notes: string, w = 100, h = 60): DecalAsset =>
  ({ id: `shape-${id}`, name, category, tags: ['relief', 'normal', shape.pattern, ...(isLine(shape.pattern) ? ['line', 'polyline'] : [])], notes, file: '', width: w, height: h, license: 'CC0', source: 'Barista', shape, size });
const BEND: [number, number][] = [[-0.95, -0.55], [-0.2, -0.55], [0.35, 0.5], [0.95, 0.5]];
const ROW: [number, number][] = [[-0.92, -0.25], [0.92, 0.25]];
const LINE_HINT = 'Click points on the model to lay it as a polyline (drag draws freehand); click the first point to close it, Enter or double-click to finish.';
export const RELIEF_SHAPES: DecalAsset[] = [
  relief('Lines', 'groove', 'Groove', 8, { pattern: 'groove', profile: 'round', corner: 0, border: 0.004, depth: 0.0016, cell: 0.01, amount: 0, outline: BEND }, `A cut along a polyline: panel lines, seams, channels. Width, depth and profile (round, V, square, chamfer) are its settings. ${LINE_HINT}`),
  relief('Lines', 'bead', 'Weld bead', 8, { pattern: 'bead', corner: 0, border: 0.007, depth: 0.0022, cell: 0.0028, amount: 0.0006, outline: BEND }, `A rippled weld seam standing on the surface. ${LINE_HINT}`),
  relief('Lines', 'stitch', 'Stitching', 8, { pattern: 'stitch', corner: 0, border: 0.004, depth: 0.0008, cell: 0.007, amount: 0.0007, outline: BEND }, `Thread stitched along a channel: leather straps, holsters, soft grips. ${LINE_HINT}`),
  relief('Lines', 'rivets', 'Rivet row', 8, { pattern: 'rivets', head: 'dome', drive: 'none', corner: 0, border: 0.012, depth: 0.0035, cell: 0.026, amount: 0.002, outline: ROW }, `A head every few units along a polyline, each turned to the line; any head and drive. ${LINE_HINT}`),
  relief('Lines', 'scratch', 'Scratch', 8, { pattern: 'scratch', corner: 0, border: 0.0018, depth: 0.0007, cell: 0.008, amount: 0.0005, outline: [[-0.95, -0.4], [-0.3, 0.05], [0.4, 0.2], [0.95, 0.55]] }, `A V gouge with burred lips that tapers out at its ends and breaks up along the way. ${LINE_HINT}`),
  relief('Fasteners', 'fastener', 'Screw / bolt', 2.5, { pattern: 'fastener', head: 'pan', drive: 'phillips', washer: false, corner: 1, border: 0, depth: 0.0035, cell: 0.01, amount: 0.0025 }, 'One head: dome, pan, countersunk, socket cap or hex bolt, with a slot, Phillips, Pozidriv, Torx, hex or square drive and an optional washer.', 1, 1),
  relief('Pads', 'pad', 'Pad', 12, { pattern: 'pad', profile: 'round', corner: 0.01, border: 0.004, depth: 0, cell: 0.01, amount: -0.002 }, 'A panel pressed into the surface or standing out of it (its Height, either side of 0) over a soft, chamfered or stepped edge. Drag its corners, or Draw its outline as a polyline.'),
];

/** A relief on a lit sphere: the shelf's tiles and the layer's preview. The shape lies over the sphere's front in the
 *  sphere's own coordinates (arc length along latitude and longitude), so it bends round it as Wrap does on the
 *  model; its slope tilts the sphere's normal, lit by a key, a cool rim and a soft sky on dark gunmetal, with its
 *  pits darkened. `sh`, hw and hh share one unit; the shape spans `span` radians of the sphere either way. */
export function reliefSphere(sh: Shape, hw: number, hh: number, W: number, span = 1): string {
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas'); c.width = W; c.height = W;
  const g = c.getContext('2d')!, img = g.createImageData(W, W), S = W * 0.47, k = span / Math.max(hw, hh);
  const e = slopeStep(sh, hw, hh), top = Math.max(sh.depth, Math.abs(sh.amount), 1e-9);
  const at = (x: number, y: number) => shapeHeight(sh, x, y, hw, hh) ?? 0;
  const L = [-0.48, 0.62, 0.62], Lr = [0.75, 0.15, -0.35], Hv = [L[0], L[1], L[2] + 1];
  const hl = Math.hypot(...Hv); Hv[0] /= hl; Hv[1] /= hl; Hv[2] /= hl;
  const lin = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const nx = (i + 0.5 - W / 2) / S, ny = (W / 2 - j - 0.5) / S, r2 = nx * nx + ny * ny, cover = Math.min(1, Math.max(0, (1 - Math.sqrt(r2)) * S + 0.5));
    if (cover <= 0) continue;
    const nz = Math.sqrt(Math.max(0, 1 - r2)), lon = Math.atan2(nx, nz), lat = Math.asin(Math.max(-1, Math.min(1, ny)));
    const x = (lon * Math.cos(lat)) / k, y = lat / k, h = at(x, y);
    const sx = (at(x + e, y) - at(x - e, y)) / (2 * e), sy = (at(x, y + e) - at(x, y - e)) / (2 * e);
    // T along longitude, B along latitude
    const cl = Math.cos(lon), sl = Math.sin(lon), ca = Math.cos(lat), sa = Math.sin(lat);
    let px = nx - sx * cl + sy * sa * sl, py = ny - sy * ca, pz = nz + sx * sl + sy * sa * cl;
    const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
    const dif = Math.max(0, px * L[0] + py * L[1] + pz * L[2]), spec = Math.max(0, px * Hv[0] + py * Hv[1] + pz * Hv[2]) ** 60;
    const rim = (1 - Math.max(0, pz)) ** 2.5 * Math.max(0, px * Lr[0] + py * Lr[1] + pz * Lr[2]);
    const occ = Math.min(1, 1 + 0.75 * Math.min(0, h) / top), sky = 0.07 + 0.06 * py;
    const v = (0.2 * (dif * 1.15 + sky) + 0.55 * spec) * occ, o = (j * W + i) * 4;
    img.data[o] = lin(v + 0.08 * rim); img.data[o + 1] = lin(v * 1.01 + 0.11 * rim); img.data[o + 2] = lin(v * 1.07 + 0.16 * rim); img.data[o + 3] = 255 * cover;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL();
}
/** A shape's shelf tile: its relief on the sphere at the size it starts at on the model. */
const thumbs = new Map<string, string>();
function shapeThumb(a: DecalAsset): string {
  const hit = thumbs.get(a.id);
  if (hit || typeof document === 'undefined' || !a.shape) return hit ?? '';
  // in units of the panel's half width: a share of the model over the half of `size` the panel spans
  const f = 200 / Math.max(a.size ?? 20, 0.5), s = a.shape;
  const sh: Shape = { ...s, corner: s.corner * (s.pattern === 'fastener' ? 1 : f), border: s.border * f, depth: s.depth * f, cell: s.cell * f, amount: s.amount * f };
  const url = reliefSphere(sh, 1, a.height / a.width, 120, s.pattern === 'fastener' ? 0.75 : 0.95);
  thumbs.set(a.id, url);
  return url;
}

const BASE = '/decals';
let library: DecalAsset[] | null = null;
let loading: Promise<DecalAsset[]> | null = null;

/** The built-in decal shelf: `public/decals/index.json`. Cached after the first read. */
export function loadDecalLibrary(): Promise<DecalAsset[]> {
  if (library) return Promise.resolve(library);
  loading ??= (async () => {
    const r = await fetch(`${BASE}/index.json`);
    if (!r.ok) throw new Error(`Could not read the decal library (${r.status})`);
    const j = await r.json() as { decals?: DecalAsset[] };
    if (!Array.isArray(j.decals)) throw new Error('The decal library has no decals');
    library = [...GRIP_SHAPES, ...RELIEF_SHAPES, ...j.decals];
    return library;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export function decalUrl(a: DecalAsset): string {
  if (a.shape) return shapeThumb(a);
  return /^(blob:|data:|https?:|\/)/.test(a.file) ? a.file : `${BASE}/${a.file}`;
}

/** Decoded RGBA of a decal; only the last few are kept, as a decal is sampled only while it is placed. */
const pixels = new Map<string, Promise<MapPixels>>();
const order: string[] = [];
const MAX = 6;
export function decalPixels(a: DecalAsset): Promise<MapPixels> {
  const hit = pixels.get(a.id);
  if (hit) {
    const i = order.indexOf(a.id);
    if (i >= 0) order.splice(i, 1);
    order.push(a.id);
    return hit;
  }
  const job = decodeImage(decalUrl(a));
  pixels.set(a.id, job);
  order.push(a.id);
  job.catch(() => { pixels.delete(a.id); const i = order.indexOf(a.id); if (i >= 0) order.splice(i, 1); });
  while (order.length > MAX) pixels.delete(order.shift()!);
  return job;
}

const slug = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'decal';

/** A PNG (or JPEG/WebP) from disk. Keeps its transparent pixels; JPEG marks are boxed by their own colour. */
export async function decalFromFile(file: File): Promise<DecalAsset> {
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|svg)$/i.test(file.name)) throw new Error('That file is not an image.');
  let width = 1024, height = 1024;
  try {
    const bmp = await createImageBitmap(file);
    width = bmp.width; height = bmp.height; bmp.close();
  } catch { /* the decode path reports a bad image when it is placed */ }
  return {
    id: `user-${slug(file.name)}-${Date.now().toString(36)}`,
    name: file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '),
    category: 'Imported', tags: ['imported', 'custom'], file: URL.createObjectURL(file), width, height,
    tint: '#ffffff', license: 'user-provided', source: 'Local file',
    notes: 'Imported this session; re-import after a reload.',
  };
}
