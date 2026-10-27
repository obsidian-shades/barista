// The PBR material library: the manifest in public/materials, the shelf's thumbnails, and the
// decoded pixels a fill layer samples. Materials are plain map sets (base color, normal,
// roughness, metallic, AO, height), not Substance graphs; the same shape accepts a folder
// exported from Substance Painter or any other baker.
import type { Channel } from './paint';

export type MapKind = 'basecolor' | 'normal' | 'roughness' | 'metallic' | 'ao' | 'height' | 'opacity';
/** A set of maps on disk (or an imported folder). `maps` are file names relative to `<id>/`. */
export interface MaterialAsset {
  id: string;
  name: string;
  category: string;
  /** The pack's own asset catalog (Blender's `catalog_simple_name`). */
  catalog?: string;
  /** The UV repeat the author tuned (the .blend's Mapping scale); a new fill's tiling. */
  scale?: number;
  /** What the set is for, so the shelf can lead with game surfaces: weapon, character, environment, prop. */
  role?: 'weapon' | 'character' | 'environment' | 'prop';
  /** Where it came from: the curated core shelf, a locally installed pack, or a folder picked this session. */
  library?: 'core' | 'pack' | 'import';
  tags: string[];
  notes?: string;
  width: number;
  height: number;
  normal: 'gl' | 'dx';
  maps: Partial<Record<MapKind, string>>;
  license: string;
  source: string;
  thumb?: string;
  asset?: string;
  /** No colour of its own: the base colour map is left out and the fill's tint is the colour (on white), so one
   *  finish takes any colour (Cerakote). Its roughness / normal / height keep the coating's texture. */
  colorless?: boolean;
}

export interface MapPixels { width: number; height: number; data: Uint8ClampedArray }
export type MaterialPixels = Partial<Record<MapKind, MapPixels>>;

/** Nine display groups replace the 30+ source-category names on the shelf. The exact category is
 *  still searchable and shown in a tile's tooltip; this is only the browse hierarchy. */
export type MaterialGroup = 'metal' | 'wood' | 'stone' | 'tile' | 'surface' | 'fabric' | 'polymer' | 'organic' | 'other';
export const MATERIAL_GROUPS: [MaterialGroup, string][] = [
  ['metal', 'Metal'],
  ['wood', 'Wood'],
  ['stone', 'Stone & Masonry'],
  ['tile', 'Tile & Ceramic'],
  ['surface', 'Concrete & Ground'],
  ['fabric', 'Fabric & Leather'],
  ['polymer', 'Polymer & Carbon'],
  ['organic', 'Organic & Food'],
  ['other', 'Other'],
];
const GROUP_OF: Record<string, MaterialGroup> = {
  Metal: 'metal', 'Pack Metals': 'metal',
  Wood: 'wood', Woods: 'wood', 'Pack Woods': 'wood',
  Stone: 'stone', Marble: 'stone', Masonry: 'stone', Bricks: 'stone', Rocks: 'stone',
  'Pack Marble': 'stone', 'Pack Bricks': 'stone', 'Pack Rocks': 'stone',
  Ceramic: 'tile', Tiles: 'tile', 'Pack Tiles': 'tile',
  Concrete: 'surface', Ground: 'surface', Asphalt: 'surface', Painted: 'surface',
  'Pack Concrete': 'surface', 'Pack Ground': 'surface',
  Fabric: 'fabric', Leather: 'fabric', Carpet: 'fabric', 'Pack Fabric': 'fabric',
  Polymer: 'polymer', Rubber: 'polymer', Carbon: 'polymer', Plastic: 'polymer', 'Pack Plastic': 'polymer',
  Organic: 'organic', Foods: 'organic', 'Pack Foods': 'organic',
  Others: 'other', Randoms: 'other', 'Pack Others': 'other', 'Pack Randoms': 'other', Imported: 'other',
};
export const materialGroup = (m: MaterialAsset): MaterialGroup => GROUP_OF[m.category] ?? 'other';
/** The Tiles tab's kinds, by name: first match wins, the rest are Other. */
export const TILE_KINDS: [string, RegExp][] = [
  ['Hex', /hex/i],
  ['Mosaic', /mosaic/i],
  ['Roof', /roof/i],
  ['Floor', /floor/i],
  ['Wall', /wall/i],
  ['Paving', /pav|sidewalk|cobble/i],
  ['Patterned', /pattern|morocc|morrocan|vintage|fan|checker|triang|pyramid|herring|diamond|star/i],
  ['Subway', /subway/i],
  ['Terracotta', /terracot|clay/i],
  ['Marble & Terrazzo', /marble|terr?azz?o|granite/i],
  ['Stone & Concrete', /stone|concer|concrete|cement|brick|slate/i],
  ['Metal', /metal/i],
  ['Wood', /wood|deck|parquet/i],
  ['Glass', /glass/i],
  ['Ceramic', /ceramic|porcelain|glaz|shiny/i],
];
export const tileKind = (m: MaterialAsset) => TILE_KINDS.find(([, re]) => re.test(m.name))?.[0] ?? 'Other';

const BASE = '/materials';
/** Weapon finishes the pack has under other names: the same maps, shelved again under the finish's name
 *  (textures only, no tint). [name, the pack material it is]. */
const FINISHES: [string, string, boolean][] = [
  ['Cerakote', 'painted metal PBR', true],
  ['Anodized Metal', 'silver metal PBR', false],
];
let library: MaterialAsset[] | null = null;
let loading: Promise<MaterialAsset[]> | null = null;

/** The installed material shelf. The purchased pack is the library now; the small core set is only
 *  a fallback for a checkout without `public/materials-pack/index.json`. */
export function loadMaterialLibrary(): Promise<MaterialAsset[]> {
  if (library) return Promise.resolve(library);
  loading ??= (async () => {
    try {
      const pr = await fetch(`${BASE}-pack/index.json`);
      if (pr.ok) {
        const pj = await pr.json() as { materials?: MaterialAsset[] };
        if (Array.isArray(pj.materials) && pj.materials.length) {
          library = pj.materials.map((m) => ({ ...m, library: 'pack' as const }));
          for (const [name, of, colorless] of FINISHES) {
            const m = library.find((x) => x.name === of);
            if (!m) continue;
            library.unshift({
              ...m, id: `finish-${name.toLowerCase().replace(/\W+/g, '-')}`, name, tags: [...m.tags, 'finish', name.toLowerCase(), ...(colorless ? ['colorless', 'any colour'] : [])],
              notes: colorless ? `${name} finish (the pack's “${of}” texture, no colour: the fill's tint is its colour)` : `${name} finish (the pack's “${of}”)`,
              ...(colorless ? { maps: { ...m.maps, basecolor: undefined }, colorless } : {}),
            });
          }
          return library;
        }
      }
    } catch { /* fall through to the fallback shelf */ }
    const r = await fetch(`${BASE}/index.json`);
    if (!r.ok) throw new Error(`No purchased pack and no fallback library (${r.status})`);
    const j = await r.json() as { materials?: MaterialAsset[] };
    if (!Array.isArray(j.materials)) throw new Error('The material library has no materials');
    library = j.materials.map((m) => ({ ...m, library: m.library ?? 'core' as const }));
    return library;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** A material's map as a URL: built-ins resolve under /materials, imported folders give blob URLs. */
export function mapUrl(m: MaterialAsset, kind: MapKind): string | null {
  const p = m.maps[kind];
  if (!p) return null;
  return /^(blob:|data:|https?:|\/)/.test(p) ? p : `${BASE}/${m.id}/${p}`;
}

/** The shelf's small albedo crop (never the 1K map). */
export function thumbUrl(m: MaterialAsset): string {
  if (m.thumb && /^(blob:|data:|https?:|\/)/.test(m.thumb)) return m.thumb;
  return m.thumb ? `${BASE}/${m.id}/${m.thumb}` : mapUrl(m, 'basecolor') ?? '';
}

/** A decoded image, RGBA bytes, row 0 at the top (as images store them). Used for maps and decals. */
export async function decodeImage(url: string): Promise<MapPixels> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not read ${url} (${r.status})`);
  const blob = await r.blob();
  const bmp = await createImageBitmap(blob);
  const { width, height } = bmp;
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not decode an image (no 2D canvas)');
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  bmp.close();
  return { width, height, data };
}

// Decoded maps are big: a 2K six-map metal is ~84 MB of RGBA. Keep a working set for the last few fills
// instead of a whole shelf (and far less than the 1K-only three the first shelf assumed).
const PIXEL_BUDGET = 192 * 1024 * 1024;
const pixels = new Map<string, Promise<MaterialPixels>>();
const costs = new Map<string, number>();
const order: string[] = [];
const bytesOf = (px: MaterialPixels) => Object.values(px).reduce((n, m) => n + m.width * m.height * 4, 0);
function trimPixels(keep: string) {
  let total = [...costs.values()].reduce((n, x) => n + x, 0);
  while (total > PIXEL_BUDGET && order.length > 1) {
    const old = order.find((id) => id !== keep) ?? order[0];
    total -= costs.get(old) ?? 0;
    costs.delete(old);
    pixels.delete(old);
    order.splice(order.indexOf(old), 1);
  }
}

/** Decode a material's maps for CPU sampling. Cached; the least recently used is dropped. */
export function materialPixels(m: MaterialAsset): Promise<MaterialPixels> {
  const hit = pixels.get(m.id);
  if (hit) {
    const i = order.indexOf(m.id);
    if (i >= 0) order.splice(i, 1);
    order.push(m.id);
    return hit;
  }
  const job = (async () => {
    const out: MaterialPixels = {};
    // all maps at once: one after another was a fetch + decode round trip each
    await Promise.all((['basecolor', 'normal', 'roughness', 'metallic', 'ao', 'height'] as MapKind[]).map(async (kind) => {
      const url = mapUrl(m, kind);
      if (!url) return;
      const px = await decodeImage(url);
      // One convention everywhere inside the painter: tangent-space OpenGL. DirectX bakes
      // (Unreal, some Substance exports) only differ in the green channel.
      if (kind === 'normal' && m.normal === 'dx') for (let i = 1; i < px.data.length; i += 4) px.data[i] = 255 - px.data[i];
      out[kind] = px;
    }));
    if (!out.basecolor && !m.colorless) throw new Error(`${m.name} has no base color map`);
    return out;
  })();
  pixels.set(m.id, job);
  order.push(m.id);
  job.then((px) => { if (!pixels.has(m.id)) return; costs.set(m.id, bytesOf(px)); trimPixels(m.id); }).catch(() => {
    pixels.delete(m.id);
    costs.delete(m.id);
    const i = order.indexOf(m.id);
    if (i >= 0) order.splice(i, 1);
  });
  return job;
}

/** The painter's channels that a fill layer can write. */
export const FILL_CHANNELS: Channel[] = ['color', 'rough', 'metal', 'normal', 'height'];

/** A file name to a slot: Substance/Unreal/Unity/MaterialX exporters all name maps differently. */
const SLOTS: [MapKind, RegExp][] = [
  ['basecolor', /(base.?color|albedo|diffuse|_color(?!.*normal))/i],
  ['normal', /(normal|nrm|normalgl|normaldx)/i],
  ['roughness', /(roughness|rough)/i],
  ['metallic', /(metallic|metalness|_metal\b)/i],
  ['ao', /(ambient.?occlusion|_ao\b|occlusion)/i],
  ['height', /(height|displacement|disp)/i],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'material';

/** Build an asset from a folder of maps. The maps become object URLs, so the folder is read once. */
export async function materialFromFiles(name: string, files: File[]): Promise<MaterialAsset | null> {
  const images = files.filter((f) => /\.(png|jpe?g|webp|tga)$/i.test(f.name));
  if (!images.length) return null;
  const maps: Partial<Record<MapKind, string>> = {};
  let normal: 'gl' | 'dx' = 'gl';
  let baseFile: File | null = null;
  for (const [slot, re] of SLOTS) {
    if (maps[slot]) continue;
    const f = images.find((x) => re.test(x.name));
    if (!f) continue;
    maps[slot] = URL.createObjectURL(f);
    if (slot === 'basecolor') baseFile = f;
    if (slot === 'normal' && /(directx|normaldx|_dx\b)/i.test(f.name)) normal = 'dx';
  }
  if (!maps.basecolor) return null;
  let width = 1024, height = 1024;
  try {
    const bmp = await createImageBitmap(baseFile ?? images[0]);
    width = bmp.width; height = bmp.height; bmp.close();
  } catch { /* the decode path will report a real error if the file is bad */ }
  return {
    id: `user-${slug(name)}-${Date.now().toString(36)}`,
    name, category: 'Imported', library: 'import', tags: ['imported', 'local'],
    width, height, normal, maps,
    license: 'user-provided', source: 'Local folder', thumb: maps.basecolor,
  };
}

