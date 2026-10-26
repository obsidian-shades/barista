// The decal shelf: transparent marks shipped with the app (public/decals) plus PNGs imported this
// session. A decal is an image and its aspect; Van Gogh projects it onto the model in the layer stack,
// so it paints and exports like any other layer.
import { decodeImage, type MapPixels } from './materials';
import { shapeHeight, type Shape } from './paint';

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
  grip('stipple-panel', 'Stipple panel', 60, 100, { pattern: 'stipple', corner: 0.025, border: 0.006, depth: 0.003, cell: 0.0045, amount: 0.0012 }, 'Raised stipple inside a groove border: a polymer pistol\'s side panel.'),
  grip('stipple-strip', 'Stipple strip', 22, 100, { pattern: 'stipple', corner: 0.012, border: 0.005, depth: 0.003, cell: 0.0045, amount: 0.0012 }, 'A narrow stippled band with its own border, for back straps and bevels.'),
  grip('grooved-panel', 'Grooved panel', 30, 100, { pattern: 'grooves', corner: 0.01, border: 0, depth: 0.003, cell: 0.012, amount: 0.0025 }, 'Evenly spaced grooves across the panel: back and front straps, slide serrations.'),
  grip('checker-panel', 'Checkered panel', 60, 100, { pattern: 'checker', corner: 0.02, border: 0.006, depth: 0.003, cell: 0.008, amount: 0.0015 }, 'Diamond checkering inside a groove border: wood and metal grip panels.'),
  grip('groove-frame', 'Groove frame', 60, 100, { pattern: 'none', corner: 0.025, border: 0.006, depth: 0.003, cell: 0.005, amount: 0 }, 'Only the groove outline, to frame a panel or split two textures.'),
];

/** A shape's shelf picture: its relief lit from the top left, transparent outside the outline. */
const thumbs = new Map<string, string>();
function shapeThumb(a: DecalAsset): string {
  const hit = thumbs.get(a.id);
  if (hit || typeof document === 'undefined' || !a.shape) return hit ?? '';
  const W = 120, H = Math.round((W * a.height) / a.width), k = 1 / 0.2; // drawn as if a fifth of the model wide
  const sh: Shape = { ...a.shape, corner: a.shape.corner * k, border: a.shape.border * k, depth: a.shape.depth * k, cell: a.shape.cell * k, amount: a.shape.amount * k };
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!, img = g.createImageData(W, H), hw = 0.5, hh = (0.5 * a.height) / a.width, px = 1 / W;
  const at = (x: number, y: number) => shapeHeight(sh, x, y, hw, hh);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = (i + 0.5) * px - hw, y = hh - (j + 0.5) * px, h = at(x, y);
    if (h === null) continue;
    const sx = ((at(x + px, y) ?? 0) - (at(x - px, y) ?? 0)) / (2 * px), sy = ((at(x, y + px) ?? 0) - (at(x, y - px) ?? 0)) / (2 * px);
    const l = Math.max(0, (sx * 0.6 - sy * 0.6 + 1) / Math.hypot(sx, sy, 1) / Math.hypot(0.6, 0.6, 1));
    const v = 40 + 190 * l, o = (j * W + i) * 4;
    img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v * 1.04; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const url = c.toDataURL();
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
    library = [...GRIP_SHAPES, ...j.decals];
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
