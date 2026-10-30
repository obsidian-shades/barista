// The decal shelf: the Stickers tab's transparent marks shipped with the app (public/assets/decals, drawn by
// tools/stickers.mjs) plus PNGs imported this session, and the Geometry tab's reliefs. A decal is an image and its aspect; Van Gogh projects it onto the model in the layer stack,
// so it paints and exports like any other layer.
import { decodeImage, type MapPixels } from './materials';
import { isLine, shapeHeight, slopeStep, type ReliefPixels, type Shape } from './paint';

export interface DecalAsset {
  id: string;
  name: string;
  category: string;
  tags: string[];
  notes?: string;
  file: string;
  width: number;
  height: number;
  /** The ink placing it starts with (white: a coloured sign keeps its own palette); absent, the brush colour. */
  tint?: string;
  /** Placed engraved this deep (`Decal.engrave`): roll marks, proof and part stamps. */
  engrave?: number;
  license: string;
  source: string;
  /** A grip texture: no image, a relief drawn from these settings (sizes as shares of the model, made world units when placed). */
  shape?: Shape;
  /** A relief read from a decal's own maps (DECALmachine assets): normal, height (AO/curvature/height, blue) and
   *  coverage (masks, red). Sampled through the projector and written to Normal and Height; it puts down no ink, so
   *  the surface's own colour and finish stay. URLs, like `file`. */
  relief?: { normal: string; height: string; mask: string };
  /** Where placing it starts: its width as a % of the model (the Decal tool's Size). */
  size?: number;
}

/** Grip textures: relief panels the Decal tool places like any mark, written to Normal and Height. Sizes are shares
 *  of the model (a pistol grip panel is about a fifth of the gun's length). */
const grip = (id: string, name: string, w: number, h: number, shape: Shape, notes: string): DecalAsset =>
  ({ id: `shape-${id}`, name, category: 'Grip', tags: ['grip', 'relief', 'normal', shape.pattern], notes, file: '', width: w, height: h, license: 'CC0', source: 'Barista', shape, size: (GRIP_TALL * w) / h });
/** The grip textures' patterns (the rest are reliefs: lines, fasteners, pads). */
const GRIP_PATTERNS: Shape['pattern'][] = ['stipple', 'pyramid', 'grooves', 'checker', 'none'];
/** Every grip texture starts this tall (% of the model): a pistol's grip panel, whatever its width. */
const GRIP_TALL = 30;
export const GRIP_SHAPES: DecalAsset[] = [
  grip('stipple-panel', 'Stipple', 60, 100, { pattern: 'stipple', corner: 0.025, border: 0.006, depth: 0.003, cell: 0.0045, amount: 0.0012 }, 'Raised stipple for a textured grip panel.'),
  grip('grooved-panel', 'Ribs', 30, 100, { pattern: 'grooves', corner: 0.01, border: 0.004, depth: 0.003, cell: 0.012, amount: 0.0025 }, 'Parallel grooves; adjust their spacing after choosing this look.'),
  grip('nub-panel', 'Polymer frame', 60, 100, { pattern: 'pyramid', corner: 0.025, border: 0.006, depth: 0.003, cell: 0.0055, amount: 0.0011 }, 'A fine grid of small square nubs, the moulded texture of a polymer pistol frame.'),
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
  // A grip is a texture: shown as the material balls are, its pattern over the whole ball at the panel's scale (a panel
  // four times the ball, so its edge never shows), never the panel's outline; Border only, which has no pattern, as a square.
  const grip = GRIP_PATTERNS.includes(sh.pattern), fill = grip && sh.pattern !== 'none';
  if (grip) hh = hw;
  const look: Shape = grip ? { ...sh, outline: undefined, ...(fill ? { border: 0, corner: 0 } : {}) } : sh, grow = fill ? 4 : 1;
  const k = span / Math.max(hw, hh), e = slopeStep(look, hw, hh), top = Math.max(look.depth, Math.abs(look.amount), 1e-9);
  const at = (x: number, y: number) => shapeHeight(look, x, y, hw * grow, hh * grow) ?? 0;
  return litBall(W, k, (x, y) => [at(x, y) / top, (at(x + e, y) - at(x - e, y)) / (2 * e), (at(x, y + e) - at(x, y - e)) / (2 * e)]);
}

/** The shelf's lit ball, one look for every relief preview: the mark lies over the ball's front in the ball's own
 *  coordinates (arc length along latitude and longitude, `k` radians a unit), and `sample(x, y)` gives its height (as a
 *  share of its deepest: pits darken) and slope there, which tilt the ball's normal, lit by a key, a cool rim and a soft
 *  sky on dark gunmetal. */
function litBall(W: number, k: number, sample: (x: number, y: number) => [number, number, number]): string {
  const c = document.createElement('canvas'); c.width = W; c.height = W;
  const g = c.getContext('2d')!, img = g.createImageData(W, W), S = W * 0.47;
  const L = [-0.48, 0.62, 0.62], Lr = [0.75, 0.15, -0.35], Hv = [L[0], L[1], L[2] + 1];
  const hl = Math.hypot(...Hv); Hv[0] /= hl; Hv[1] /= hl; Hv[2] /= hl;
  const lin = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const nx = (i + 0.5 - W / 2) / S, ny = (W / 2 - j - 0.5) / S, r2 = nx * nx + ny * ny, cover = Math.min(1, Math.max(0, (1 - Math.sqrt(r2)) * S + 0.5));
    if (cover <= 0) continue;
    const nz = Math.sqrt(Math.max(0, 1 - r2)), lon = Math.atan2(nx, nz), lat = Math.asin(Math.max(-1, Math.min(1, ny)));
    const [h, sx, sy] = sample((lon * Math.cos(lat)) / k, lat / k);
    // T along longitude, B along latitude
    const cl = Math.cos(lon), sl = Math.sin(lon), ca = Math.cos(lat), sa = Math.sin(lat);
    let px = nx - sx * cl + sy * sa * sl, py = ny - sy * ca, pz = nz + sx * sl + sy * sa * cl;
    const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
    const dif = Math.max(0, px * L[0] + py * L[1] + pz * L[2]), spec = Math.max(0, px * Hv[0] + py * Hv[1] + pz * Hv[2]) ** 60;
    const rim = (1 - Math.max(0, pz)) ** 2.5 * Math.max(0, px * Lr[0] + py * Lr[1] + pz * Lr[2]);
    const occ = Math.min(1, 1 + 0.75 * Math.min(0, h)), sky = 0.07 + 0.06 * py;
    const v = (0.2 * (dif * 1.15 + sky) + 0.55 * spec) * occ, o = (j * W + i) * 4;
    img.data[o] = lin(v + 0.08 * rim); img.data[o + 1] = lin(v * 1.01 + 0.11 * rim); img.data[o + 2] = lin(v * 1.07 + 0.16 * rim); img.data[o + 3] = 255 * cover;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL();
}

/** An imported relief decal (DECALmachine's) on the same lit ball, from its own maps: the normal map's tilt and the
 *  height map's pits under the mask, so its tile reads like every other relief instead of the asset pack's own render
 *  (dark on some, grey-mauve on others). Drawn in the background, one decal at a time; '' until then. */
const reliefThumbs = new Map<string, string>(), reliefWaiting: [DecalAsset, () => void][] = [];
let reliefDrawing = false;
export function reliefThumb(a: DecalAsset, ready: () => void): string {
  const hit = reliefThumbs.get(a.id);
  if (hit !== undefined || typeof document === 'undefined' || !a.relief) return hit ?? '';
  if (!reliefWaiting.some(([b]) => b.id === a.id)) reliefWaiting.push([a, ready]);
  if (!reliefDrawing) void drawReliefs();
  return '';
}
async function drawReliefs() {
  reliefDrawing = true;
  for (let job = reliefWaiting.shift(); job; job = reliefWaiting.shift()) {
    const [a, ready] = job, r = a.relief!;
    try {
      const [nm, ht, mk] = await Promise.all([decodeImage(r.normal), decodeImage(r.height), decodeImage(r.mask)]);
      // a long strip (a trim) is fitted by its short side and repeats along its length, as a trim is laid; else whole
      const hw = 1, hh = a.height / a.width, strip = Math.max(hw, hh) / Math.min(hw, hh) > 2.5;
      const k = strip ? 0.45 / Math.min(hw, hh) : 0.8 / Math.max(hw, hh), wrap = (t: number) => t - Math.floor(t);
      // bilinear like the bake's sampleDecal (row 0 at the top), one channel
      const tap = (m: MapPixels, u: number, v: number, ch: number) => {
        const x = Math.min(m.width - 1, Math.max(0, u * m.width - 0.5)), y = Math.min(m.height - 1, Math.max(0, (1 - v) * m.height - 0.5));
        const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(m.width - 1, x0 + 1), y1 = Math.min(m.height - 1, y0 + 1), fx = x - x0, fy = y - y0;
        const p = (xx: number, yy: number) => m.data[(yy * m.width + xx) * 4 + ch];
        return (p(x0, y0) * (1 - fx) + p(x1, y0) * fx) * (1 - fy) + (p(x0, y1) * (1 - fx) + p(x1, y1) * fx) * fy;
      };
      reliefThumbs.set(a.id, litBall(120, k, (x, y) => {
        let u = x / (2 * hw) + 0.5, v = y / (2 * hh) + 0.5;
        if (strip) { if (hw > hh) u = wrap(u); else v = wrap(v); }
        if (u < 0 || u > 1 || v < 0 || v > 1) return [0, 0, 0];
        const m = tap(mk, u, v, 0) / 255;
        if (m < 0.004) return [0, 0, 0];
        const ax = tap(nm, u, v, 0) / 127.5 - 1, ay = tap(nm, u, v, 1) / 127.5 - 1, az = Math.max(0.2, tap(nm, u, v, 2) / 127.5 - 1);
        return [(tap(ht, u, v, 2) / 255 - 0.5) * 2 * m, (-ax / az) * m, (-ay / az) * m];
      }));
    } catch { reliefThumbs.set(a.id, a.file); } // the maps would not load: the pack's own picture, rather than nothing
    ready();
    await new Promise((ok) => setTimeout(ok, 0));
  }
  reliefDrawing = false;
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

const BASE = '/assets/decals';
/** The locally imported DECALmachine relief decals (tools/dm-decals.mjs). Optional: a checkout without the purchase
 *  simply has no file there. */
const RELIEF_BASE = '/assets/geometry/decalmachine';
let library: DecalAsset[] | null = null;
let loading: Promise<DecalAsset[]> | null = null;

/** The built-in decal shelf: `public/assets/decals/index.json` plus the imported relief decals. Cached after the first read. */
export function loadDecalLibrary(): Promise<DecalAsset[]> {
  if (library) return Promise.resolve(library);
  loading ??= (async () => {
    const r = await fetch(`${BASE}/index.json`);
    if (!r.ok) throw new Error(`Could not read the decal library (${r.status})`);
    const j = await r.json() as { decals?: DecalAsset[] };
    if (!Array.isArray(j.decals)) throw new Error('The decal library has no decals');
    const relief = await fetch(`${RELIEF_BASE}/index.json`)
      .then((x) => (x.ok ? x.json() as Promise<{ decals?: DecalAsset[] }> : { decals: [] }))
      .then((x) => (Array.isArray(x.decals) ? x.decals : []))
      .catch(() => []);
    library = [...GRIP_SHAPES, ...RELIEF_SHAPES, ...relief, ...j.decals];
    return library;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export function decalUrl(a: DecalAsset): string {
  if (a.shape) return shapeThumb(a);
  if (a.relief) return reliefThumbs.get(a.id) || ''; // its lit ball once drawn (`reliefThumb`)
  return /^(blob:|data:|https?:|\/)/.test(a.file) ? a.file : `${BASE}/${a.file}`;
}

/** A relief decal's three maps, decoded. Kept apart from `pixels`: an image mark samples one texture, a relief samples
 *  three, and only the last few placed marks are ever read. */
const reliefs = new Map<string, Promise<ReliefPixels>>();
const reliefOrder: string[] = [];
export function reliefPixels(a: DecalAsset): Promise<ReliefPixels> {
  const hit = reliefs.get(a.id);
  if (hit) {
    const i = reliefOrder.indexOf(a.id);
    if (i >= 0) reliefOrder.splice(i, 1);
    reliefOrder.push(a.id);
    return hit;
  }
  const r = a.relief!;
  const job = Promise.all([decodeImage(r.normal), decodeImage(r.height), decodeImage(r.mask)])
    .then(([normal, height, mask]) => ({ normal, height, mask }));
  reliefs.set(a.id, job);
  reliefOrder.push(a.id);
  job.catch(() => { reliefs.delete(a.id); const i = reliefOrder.indexOf(a.id); if (i >= 0) reliefOrder.splice(i, 1); });
  while (reliefOrder.length > 3) reliefs.delete(reliefOrder.shift()!);
  return job;
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
