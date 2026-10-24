// The decal shelf: transparent marks shipped with the app (public/decals) plus PNGs imported this
// session. A decal is an image and its aspect; Van Gogh projects it onto the model in the layer stack,
// so it paints and exports like any other layer.
import { decodeImage, type MapPixels } from './materials';

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
    library = j.decals;
    return library;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export function decalUrl(a: DecalAsset): string {
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
