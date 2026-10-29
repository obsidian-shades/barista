// `.barista` projects, the editor's half (engine/src/project.rs keeps the file): the document as JSON plus binary blobs
// (meshes, UVs, paint tiles, imported assets), swapped with the engine as a Pack: u32 JSON length, the JSON, then per
// blob u32 name length, name, u32 data length, data (little-endian). The engine shows the dialogs and writes the SQLite
// file.
//
// A save is a snapshot taken in one tick, then worked through a few blobs at a time (save.ts): the document's metadata,
// the arrays by reference (the store replaces them rather than editing them in place) and, only for the blobs that
// changed since the file's last revision, their bytes. Imported materials, decals, the environment map and the
// reference picture travel inside the file, so a project opens as it was saved on another machine.
import type { Output, Params } from './api';
import { mapUrl, type MapKind, type MaterialAsset } from './materials.ts';
import type { DecalAsset } from './decals.ts';
import { PAINT_TILE, SOLID, compMaps, compSettled, fromTiles, saveSet, tileAt, tilesOf, type Channel, type CompMap, type SavedSet, type TexSet } from './paint.ts';
import type { Part, State } from './store';
import { migrateBones } from './rig.ts';

export const PROJECT_VERSION = 2;

/** A Blob, not one buffer: Gun_Low's 105 MB as a single array failed to allocate ("Array buffer allocation failed"). */
export function encodePack(json: string, blobs: [string, Uint8Array][]): Blob {
  const enc = new TextEncoder(), parts: Uint8Array[] = [];
  const put = (b: Uint8Array) => { const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, b.length, true); parts.push(n, b); };
  put(enc.encode(json));
  for (const [name, data] of blobs) { put(enc.encode(name)); put(data); }
  return new Blob(parts as BlobPart[]);
}

export function decodePack(b: Uint8Array): { json: string; blobs: Map<string, Uint8Array> } {
  const dec = new TextDecoder(), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const take = () => { const n = v.getUint32(o, true), out = b.subarray(o + 4, o + 4 + n); o += 4 + n; return out; };
  const json = dec.decode(take()), blobs = new Map<string, Uint8Array>();
  while (o < b.length) { const name = dec.decode(take()); blobs.set(name, take()); }
  return { json, blobs };
}

/** One blob as the file stores it, which is how an open's Pack carries it (`lz4`: an eighth of the bytes to move):
 *  a u32 size, then an LZ4 block (lz4_flex's `compress_prepend_size`). `out`, when big enough, takes the bytes (a
 *  reused scratch tile). Long matches are copied with copyWithin, an overlapping one in doubling runs. */
export function unlz4(src: Uint8Array, out?: Uint8Array): Uint8Array {
  const n = (src[0] | src[1] << 8 | src[2] << 16 | src[3] << 24) >>> 0, end = src.length;
  const dst = out && out.length >= n ? out.subarray(0, n) : new Uint8Array(n);
  let i = 4, o = 0;
  while (i < end) {
    const tok = src[i++];
    let l = tok >>> 4;
    if (l === 15) { let b; do { b = src[i++]; l += b; } while (b === 255); }
    if (l < 32) for (const e = i + l; i < e;) dst[o++] = src[i++];
    else { dst.set(src.subarray(i, i + l), o); i += l; o += l; }
    if (i >= end) break; // the last sequence is literals only
    const off = src[i] | src[i + 1] << 8;
    i += 2;
    let m = tok & 15;
    if (m === 15) { let b; do { b = src[i++]; m += b; } while (b === 255); }
    m += 4;
    const from = o - off;
    if (off === 0 || from < 0) break;
    if (m < 32) for (let k = from, e = from + m; k < e;) dst[o++] = dst[k++];
    else while (m > 0) { const c = Math.min(m, o - from); dst.copyWithin(o, from, from + c); o += c; m -= c; }
  }
  if (o !== n) throw new Error('A project blob is damaged.');
  return dst;
}

const bytes = (a: Float32Array | Int32Array | Uint8Array | Uint8ClampedArray) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
// copies, so each array is aligned and owns its buffer
const f32 = (b: Uint8Array) => new Float32Array(b.slice().buffer);
const i32 = (b: Uint8Array) => new Int32Array(b.slice().buffer);

// The engine's output arrives as JSON numbers; writing them as bytes is the one big main-thread job a save has left.
// A million elements a turn (and a yield every few milliseconds) keeps the viewport live while a 100 MB result is packed.
const TURN = 1 << 20;
let lastTurn = 0;
async function tick() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastTurn < 8) return;
  lastTurn = now;
  await new Promise((ok) => setTimeout(ok, 0));
}
async function f32Bytes(a: ArrayLike<number>): Promise<Uint8Array> {
  const out = new Float32Array(a.length);
  for (let o = 0; o < a.length; o += TURN) {
    const end = Math.min(a.length, o + TURN);
    for (let i = o; i < end; i++) out[i] = a[i];
    await tick();
  }
  return new Uint8Array(out.buffer);
}

async function i32Bytes(a: ArrayLike<number>): Promise<Uint8Array> {
  const out = new Int32Array(a.length);
  for (let o = 0; o < a.length; o += TURN) {
    const end = Math.min(a.length, o + TURN);
    for (let i = o; i < end; i++) out[i] = a[i];
    await tick();
  }
  return new Uint8Array(out.buffer);
}

/** What a project keeps of the store: the model, its unwrap and hand edits, the paint, and how it was being looked at. */
type Doc = {
  version: number; source: string | null; unit: number; params: Params; textureResolution: number; workspace: State['workspace'];
  activePart: number; scene: State['scene']; paint: State['paint']; paintChannel: State['paintChannel']; paintAO: boolean;
  parts: (Omit<Part, 'soup' | 'poly' | 'sides' | 'normals'> & { poly: boolean; sides: boolean; normals: boolean })[];
  result: { stats: Output['stats'] } | null; pins: Record<number, number[]>; sets: (SavedSet | null)[];
  /** The mirror plane drawn by hand (world units), or missing/null for automatic. */
  symPlane?: State['symPlane'];
  /** Geppetto's bones; each part's binding is the blob `rig/<part>` (per soup triangle). */
  bones?: State['rig']['bones'];
  /** Files that came from outside the app (materials, decals, the map, the reference picture), by blob name. */
  assets?: SavedAssets;
};

/** An imported material, its maps given by blob name instead of the session's blob: URL. */
export interface SavedMaterial { asset: Omit<MaterialAsset, 'maps' | 'thumb'>; maps: Partial<Record<MapKind, string>> }
/** An imported decal: its picture given by blob name. */
export interface SavedDecal { asset: Omit<DecalAsset, 'file'>; file: string }
export interface SavedAssets {
  materials?: SavedMaterial[];
  decals?: SavedDecal[];
  /** A .hdr/.exr loaded from disk: the map itself, not just its name. */
  hdri?: { blob: string; name: string };
  /** View › Reference image… */
  ref?: { blob: string; opacity: number };
}

/** One blob (or one paint buffer's tiles) the document holds. `key` names its content: the same key as the last save
 *  means the file already has these bytes, so they are neither made nor sent. */
export interface BlobItem {
  /** Where it sits in the document, e.g. `part/0/soup` or `set/0/1/color`: the save's cache is kept by this. */
  id: string;
  key: string;
  /** A single named blob. `data` is only called when it changed. */
  one?: { name: string; data: () => Uint8Array | Promise<Uint8Array> };
  /** A paint buffer as PAINT_TILE² tiles named `<prefix>/<tx>_<ty>` (empty tiles left out). */
  tiles?: { prefix: string; px: Uint8Array | Uint8ClampedArray; size: number; stride: number };
}

/** The document as one save sees it, and what `saved` compares to know whether the file is still current. */
export interface SaveSnapshot {
  doc: Doc;
  items: BlobItem[];
  stamp: { rig: unknown; parts: unknown; uvs: unknown; result: unknown; uvRev: number; paintRev: number; params: unknown; textureResolution: number; sceneHdri: string | null; refImage: unknown };
  /** Things that could not be embedded (an imported file that vanished), for the status bar. */
  warnings: string[];
}

export interface DocOpts {
  /** True when blob `id`'s content is already in the file under this key: the bytes are kept, so a mutable array (the
   *  hand-edited UVs) doesn't have to be copied at the snapshot's tick. */
  reuse?: (id: string, key: string) => boolean;
}

// A stable name for an array's identity, without keeping the array alive (a cache of old UV or paint arrays would).
const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object) => {
  let n = ids.get(o);
  if (!n) { n = nextId++; ids.set(o, n); }
  return n;
};
/** The content key of an array: its identity, and (UVs are edited in place) a revision. */
export const keyOf = (a: object, tag = 0) => `${idOf(a)}:${tag}`;

/** The store's document and the blobs it comes from (`setOf(i)`: part i's texture set, if it has one).
 *  Everything here is captured in the calling tick: the big arrays by reference (the store replaces them on an edit),
 *  the hand-edited UVs copied unless the cache says their bytes are already in the file. */
export function docOf(s: State, setOf: (i: number) => TexSet | null, opts: DocOpts = {}): SaveSnapshot {
  const items: BlobItem[] = [], warnings: string[] = [], reuse = opts.reuse ?? (() => false);
  const one = (id: string, key: string, name: string, data: () => Uint8Array | Promise<Uint8Array>) => ({ id, key, one: { name, data } });
  const parts = s.parts.map(({ soup, poly, sides, normals, ...p }, i) => {
    items.push(one(`part/${i}/soup`, keyOf(soup), `part/${i}/soup`, () => bytes(soup)));
    if (poly) items.push(one(`part/${i}/poly`, keyOf(poly), `part/${i}/poly`, () => bytes(poly)));
    if (sides) items.push(one(`part/${i}/sides`, keyOf(sides), `part/${i}/sides`, () => bytes(sides)));
    if (normals) items.push(one(`part/${i}/normals`, keyOf(normals), `part/${i}/normals`, () => bytes(normals)));
    return { ...p, poly: !!poly, sides: !!sides, normals: !!normals };
  });
  if (s.rig.bones.length) s.rig.bind.forEach((b, i) => { if (b && i < s.parts.length) items.push(one(`rig/${i}`, keyOf(b), `rig/${i}`, () => bytes(b))); });
  // the hand-edited UVs are the one array edited in place: keep the document's tick, unless the file can reuse it
  s.uvs.forEach((uv, i) => {
    if (!uv?.length) return;
    const key = keyOf(uv, s.uvRev), reusable = reuse(`part/${i}/uv`, key);
    const held = reusable ? null : uv.slice();
    items.push(one(`part/${i}/uv`, key, `part/${i}/uv`, () => bytes(held ?? uv)));
  });
  s.result?.parts.forEach((o, i) => {
    type A = 'positions' | 'uvs' | 'stretch' | 'island' | 'source';
    for (const k of ['positions', 'uvs', 'stretch'] as const) items.push(one(`out/${i}/${k}`, keyOf(o[k as A]), `out/${i}/${k}`, () => f32Bytes(o[k])));
    for (const k of ['island', 'source'] as const) items.push(one(`out/${i}/${k}`, keyOf(o[k as A]), `out/${i}/${k}`, () => i32Bytes(o[k])));
  });
  const sets = s.parts.map((part, i) => {
    const ts = setOf(i);
    if (!ts) return null;
    const { saved, buffers } = saveSet(ts);
    for (const b of buffers) {
      const id = `set/${i}/${b.id}/${b.what}`;
      items.push({ id, key: keyOf(b.px, b.ver), tiles: { prefix: `set/${i}/${b.id}/${b.what}`, px: b.px, size: saved.size, stride: b.stride } });
    }
    // The composite, so opening shows it instead of compositing the whole stack again: only when it is the stack's
    // (nothing queued, padded), and per tile, since it is written in place — a tile the file holds under its stamp is
    // only named, any other is copied now, so a dab saves its few tiles and the snapshot stays this tick's.
    if (!compSettled(ts)) return saved;
    const n = saved.size, t = Math.min(PAINT_TILE, n), m = n / t;
    for (const [what, px, stride] of compMaps(ts)) for (let k = 0; k < m * m; k++) {
      const tx = k % m, ty = (k / m) | 0, id = `set/${i}/0/${what}/${tx}_${ty}`, key = keyOf(px, ts.stamp![k]);
      const take = () => tileAt(px, n, stride, tx, ty) ?? new Uint8Array();
      const held = reuse(id, key) ? null : take();
      items.push(one(id, key, id, () => held ?? take()));
    }
    return { ...saved, comp: true };
  });
  // a map loaded from disk lives at a blob: URL, gone with the page: the file keeps the map itself
  const scene = s.scene.hdriUrl?.startsWith('blob:') ? { ...s.scene, hdriUrl: null, hdriId: '', hdriName: '' } : s.scene;
  const assets = savedAssets(s, sets, items, one, warnings);
  const doc: Doc = {
    version: PROJECT_VERSION, source: s.source, unit: s.unit, params: s.params, textureResolution: s.textureResolution, workspace: s.workspace,
    // the material held on the Eyedropper is cursor state, not a document setting
    activePart: s.activePart, scene, paint: { ...s.paint, grab: null }, paintChannel: s.paintChannel, paintAO: s.paintAO, parts,
    result: s.result ? { stats: s.result.stats } : null,
    pins: Object.fromEntries(Object.entries(s.pins).map(([i, p]) => [i, [...p.corners]])), sets,
    symPlane: s.symPlane,
    ...(s.rig.bones.length ? { bones: s.rig.bones } : {}),
    ...(assets ? { assets } : {}),
  };
  return {
    doc, items, warnings,
    stamp: { rig: s.rig, parts: s.parts, uvs: s.uvs, result: s.result, uvRev: s.uvRev, paintRev: s.paintRev, params: s.params, textureResolution: s.textureResolution,
      sceneHdri: s.scene.hdriUrl, refImage: s.refImage },
  };
}

/** The imported files the document actually uses: the materials its fills name, the decals its marks name, the map and
 *  the reference picture. Built-in shelf files (the pack, the shipped marks, the bundled environment maps) are paths the
 *  app ships with and are never copied into the project. */
function savedAssets(s: State, sets: (SavedSet | null)[], items: BlobItem[], one: BlobItemFactory, warnings: string[]): SavedAssets | null {
  const matIds = new Set<string>(), decalIds = new Set<string>();
  for (const set of sets) for (const l of set?.layers ?? []) {
    if (l.fill && l.fill.asset !== SOLID) matIds.add(l.fill.asset);
    if (l.decal) decalIds.add(l.decal.asset);
  }
  const out: SavedAssets = {};
  const materials: SavedMaterial[] = [];
  for (const id of matIds) {
    const m = s.materials.find((x) => x.id === id);
    // A built-in (the pack, a finish made from it) is resolved by the shelf when the project opens, and the shelf may
    // not have been read yet when a save runs: only a missing user import is a file that is really gone.
    if (!m) { if (isUserImport(id)) warnings.push(`The material “${id}” isn't loaded: its maps can't travel with the project.`); continue; }
    // the shipped pack's maps are paths the app installs; only a folder picked this session lives at blob: URLs
    const local = (Object.keys(m.maps) as MapKind[]).filter((kind) => isLocal(mapUrl(m, kind) ?? ''));
    if (!local.length) continue;
    const files: Partial<Record<MapKind, string>> = {};
    for (const kind of local) {
      const url = mapUrl(m, kind)!;
      const name = `asset/material/${m.id}/${kind}`;
      files[kind] = name;
      items.push(one(`asset/material/${m.id}/${kind}`, `url:${url}`, name, () => readUrl(url, warnings)));
    }
    const { maps: _maps, thumb: _thumb, ...asset } = m;
    materials.push({ asset, maps: files });
  }
  if (materials.length) out.materials = materials;
  const decals: SavedDecal[] = [];
  for (const id of decalIds) {
    const d = s.decals.find((x) => x.id === id);
    if (!d) { if (isUserImport(id)) warnings.push(`The decal “${id}” isn't loaded: its picture can't travel with the project.`); continue; }
    if (d.shape) continue; // a grip or relief is drawn from its settings, nothing to copy
    if (!isLocal(d.file)) continue;
    const name = `asset/decal/${d.id}`;
    items.push(one(`asset/decal/${d.id}`, `url:${d.file}`, name, () => readUrl(d.file, warnings)));
    const { file: _file, ...asset } = d;
    decals.push({ asset, file: name });
  }
  if (decals.length) out.decals = decals;
  const hdri = s.scene.hdriUrl?.split('#')[0];
  if (hdri?.startsWith('blob:')) {
    items.push(one('asset/hdri', `url:${hdri}`, 'asset/hdri', () => readUrl(hdri, warnings)));
    out.hdri = { blob: 'asset/hdri', name: s.scene.hdriName || 'environment.hdr' };
  }
  const ref = s.refImage?.url;
  if (ref?.startsWith('blob:')) {
    items.push(one('asset/ref', `url:${ref}`, 'asset/ref', () => readUrl(ref, warnings)));
    out.ref = { blob: 'asset/ref', opacity: s.refImage!.opacity };
  }
  return Object.keys(out).length ? out : null;
}
type BlobItemFactory = (id: string, key: string, name: string, data: () => Uint8Array | Promise<Uint8Array>) => BlobItem;
/** A shelf entry made by importing a folder or a file this session (materials.ts / decals.ts `user-…`): the only kind
 *  of asset the app cannot rebuild from what it ships. */
const isUserImport = (id: string) => id.startsWith('user-');
const isLocal = (url: string) => url.startsWith('blob:') || url.startsWith('data:');
async function readUrl(url: string, warnings: string[]): Promise<Uint8Array> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    warnings.push(`A file the project uses could not be read (${e instanceof Error ? e.message : String(e)}).`);
    return new Uint8Array();
  }
}

/** Imported assets a project brought with it, as bytes: the store turns them back into blob: URLs and shelf entries. */
export interface LoadedAssets {
  materials: { asset: Omit<MaterialAsset, 'maps'>; maps: Partial<Record<MapKind, Uint8Array>> }[];
  decals: { asset: DecalAsset; file: Uint8Array | null }[];
  hdri: { bytes: Uint8Array; name: string } | null;
  ref: { bytes: Uint8Array; opacity: number } | null;
}

/** A project back as store state, plus each part's saved texture set and how to read its pixels. `tiles` names the blobs
 *  each part's buffers came from, so a save right after opening writes only what changed; `rev` is the file revision
 *  those names belong to. */
/** `lz4`: the blobs are as the file stores them (an open's Pack); false for raw bytes. */
export function docFrom(saved: unknown, packed: Map<string, Uint8Array>, lz4 = false) {
  const doc = saved as Doc;
  // the tiles stay packed until `pixels` lays them into their layer; everything else is small and unpacked here
  const blobs = new Map([...packed].map(([k, b]) => [k, lz4 && !k.startsWith('set/') ? unlz4(b) : b]));
  if (!doc || typeof doc !== 'object') throw new Error('The project has no document.');
  const version = doc.version ?? 1;
  if (version > PROJECT_VERSION) throw new Error('This project was saved by a newer Barista; update to open it.');
  const need = (name: string) => { const b = blobs.get(name); if (!b) throw new Error(`The project is missing ${name}`); return b; };
  const warnings: string[] = [];
  const parts: Part[] = doc.parts.map(({ poly, sides, normals, ...p }, i) => ({
    ...p, soup: f32(need(`part/${i}/soup`)),
    ...(poly ? { poly: i32(need(`part/${i}/poly`)) } : {}), ...(sides ? { sides: i32(need(`part/${i}/sides`)) } : {}),
    ...(normals ? { normals: f32(need(`part/${i}/normals`)) } : {}),
  }));
  const result: Output | null = doc.result && {
    stats: doc.result.stats,
    parts: parts.map((_, i) => ({
      positions: Array.from(f32(need(`out/${i}/positions`))), uvs: Array.from(f32(need(`out/${i}/uvs`))), stretch: Array.from(f32(need(`out/${i}/stretch`))),
      island: Array.from(i32(need(`out/${i}/island`))), source: Array.from(i32(need(`out/${i}/source`))),
    })),
  };
  const uvs = parts.map((_, i) => (blobs.has(`part/${i}/uv`) ? f32(blobs.get(`part/${i}/uv`)!) : new Float32Array()));
  const pins: State['pins'] = result ? Object.fromEntries(Object.entries(doc.pins ?? {}).map(([i, c]) => [i, { of: result.parts[+i].positions, corners: new Set(c) }])) : {};
  // per set, its tiles by buffer: `set/<part>/<layer id>/<channel|mask|clip|sel>/<tx>_<ty>`
  const tiles = new Map<string, { tx: number; ty: number; data: Uint8Array }[]>();
  const names = new Map<string, string[]>();
  for (const [name, data] of blobs) {
    const m = /^set\/(\d+)\/(\d+)\/(\w+)\/(\d+)_(\d+)$/.exec(name);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    if (!tiles.has(key)) { tiles.set(key, []); names.set(key, []); }
    tiles.get(key)!.push({ tx: +m[4], ty: +m[5], data });
    names.get(key)!.push(name);
  }
  const scratch = new Uint8Array(256 * 256 * 4);
  const pixels = (part: number, size: number) => (id: number, what: Channel | 'mask' | 'clip' | 'sel' | CompMap, stride: number) => {
    const into = new Uint8Array(size * size * stride);
    for (const t of tiles.get(`${part}/${id}/${what}`) ?? []) fromTiles(into, size, stride, [lz4 ? { ...t, data: unlz4(t.data, scratch) } : t]);
    return into;
  };
  // a project saved before the decal pick (`paint.decalSel`), the Eyedropper's material mode (`paint.pickMode`) or the
  // Decal tool's Edit / Place switch (`paint.decalMode`) existed has no such field: default them as the store does
  // A project saved before the material view's Lift, or with the old Headlight view, gets the current scene fields.
  // Headlight had replaced the key and its shadow: lifting the material does that job now, so a project that used it
  // opens with the shadow back on.
  // a project saved before the asset tree (public/assets/…) names its built-in environment map by the old path
  const oldHdri = (u: string | null | undefined) => u?.replace(/^\/hdri\//, '/assets/hdri/') ?? null;
  const hadHeadlight = (doc.scene as { paintHeadlight?: boolean } | undefined)?.paintHeadlight === true;
  const { paintHeadlight: _headlight, ...savedScene } = (doc.scene ?? {}) as typeof doc.scene & { paintHeadlight?: boolean };
  const state = {
    source: doc.source, unit: doc.unit, params: doc.params, textureResolution: doc.textureResolution, workspace: doc.workspace,
    activePart: Math.min(doc.activePart, Math.max(0, parts.length - 1)), scene: { ...savedScene, hdriUrl: oldHdri(savedScene.hdriUrl), paintShadow: hadHeadlight ? true : savedScene.paintShadow ?? true, paintLift: savedScene.paintLift ?? 0.4 }, paint: { ...doc.paint, decalSel: doc.paint.decalSel ?? true, decalMode: doc.paint.decalMode ?? 'edit', pickMode: doc.paint.pickMode ?? 'material', grab: null }, paintChannel: doc.paintChannel,
    paintAO: doc.paintAO, parts, result, uvs, pins, symPlane: doc.symPlane ?? null, symEdit: null,
    // a binding whose part was since edited (another triangle count) is dropped, not misapplied
    rig: { bones: migrateBones(doc.bones ?? []), bind: parts.map((p, i) => { const b = blobs.get(`rig/${i}`); return b && b.length / 4 === p.soup.length / 9 ? i32(b) : undefined; }) },
  } satisfies Partial<State>;
  return { state, sets: doc.sets ?? parts.map(() => null), pixels, names, assets: loadedAssets(doc.assets, blobs, warnings), warnings };
}

/** An opened project's own files (imported materials, decals, the environment map, the reference picture), back as
 *  blob: URLs and shelf entries, so its fills and marks draw as they were saved. */
export function restoreAssets(a: LoadedAssets): { materials: MaterialAsset[]; decals: DecalAsset[]; scene: Partial<State['scene']>; refImage: State['refImage'] } {
  const url = (bytes: Uint8Array) => URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  const materials: MaterialAsset[] = [], decals: DecalAsset[] = [];
  for (const m of a.materials) {
    const maps: Partial<Record<MapKind, string>> = {};
    for (const [kind, bytes] of Object.entries(m.maps) as [MapKind, Uint8Array][]) maps[kind] = url(bytes);
    materials.push({ ...m.asset, maps, thumb: maps.basecolor ?? Object.values(maps)[0] });
  }
  for (const d of a.decals) decals.push({ ...d.asset, file: d.file ? url(d.file) : '' });
  const scene: Partial<State['scene']> = {};
  if (a.hdri) {
    scene.hdriUrl = `${url(a.hdri.bytes)}#${encodeURIComponent(a.hdri.name)}`;
    scene.hdriId = 'custom';
    scene.hdriName = a.hdri.name;
  }
  const refImage = a.ref ? { url: url(a.ref.bytes), opacity: a.ref.opacity } : null;
  // ponytail: the previous project's blob: URLs are left alone (a save in flight may still be reading them); the
  // browser frees them with the page
  return { materials, decals, scene, refImage };
}

/** The imported files a v2 document carries, back as bytes (restoreAssets makes them URLs). A missing one is not fatal:
 *  its layer's pixels are still in the project, so the paint survives even if the file has to be re-imported. */
function loadedAssets(a: SavedAssets | undefined, blobs: Map<string, Uint8Array>, warnings: string[]): LoadedAssets {
  const out: LoadedAssets = { materials: [], decals: [], hdri: null, ref: null };
  if (!a) return out;
  const take = (name: string) => {
    const b = blobs.get(name);
    if (!b) { warnings.push(`The project has no ${name}.`); return null; }
    return b;
  };
  for (const m of a.materials ?? []) {
    const maps: Partial<Record<MapKind, Uint8Array>> = {};
    for (const [kind, name] of Object.entries(m.maps) as [MapKind, string][]) {
      const b = take(name);
      if (b) maps[kind] = b;
    }
    out.materials.push({ asset: { ...m.asset, library: 'import' }, maps });
  }
  for (const d of a.decals ?? []) {
    const b = take(d.file);
    if (b) out.decals.push({ asset: { ...d.asset, file: '', license: d.asset.license ?? 'user-provided', source: d.asset.source ?? 'Imported' }, file: b });
  }
  if (a.hdri) {
    const b = take(a.hdri.blob);
    if (b) out.hdri = { bytes: b, name: a.hdri.name };
  }
  if (a.ref) {
    const b = take(a.ref.blob);
    if (b) out.ref = { bytes: b, opacity: a.ref.opacity };
  }
  return out;
}

/** The blobs a document holds, in name → bytes form: what `docFrom` and the engine's texture export read. Only for
 *  small documents and checks; a real save streams through save.ts. */
export async function blobsOf(snapshot: SaveSnapshot): Promise<[string, Uint8Array][]> {
  const out: [string, Uint8Array][] = [];
  for (const item of snapshot.items) {
    if (item.one) out.push([item.one.name, await item.one.data()]);
    else if (item.tiles) for (const t of tilesOf(item.tiles.px, item.tiles.size, item.tiles.stride)) out.push([`${item.tiles.prefix}/${t.tx}_${t.ty}`, t.data]);
  }
  return out;
}
