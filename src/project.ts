// `.barista` projects, the editor's half (engine/src/project.rs keeps the file): the document as JSON plus binary blobs
// (meshes, UVs, paint tiles), swapped with the engine as a Pack: u32 JSON length, the JSON, then per blob u32 name
// length, name, u32 data length, data (little-endian). The engine shows the dialogs and writes the SQLite file.
import type { Output, Params } from './api';
import { fromTiles, saveSet, tilesOf, type Channel, type SavedSet, type TexSet } from './paint.ts';
import type { Part, State } from './store';

export const PROJECT_VERSION = 1;

export function encodePack(json: string, blobs: [string, Uint8Array][]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder(), parts: Uint8Array[] = [];
  const put = (b: Uint8Array) => { const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, b.length, true); parts.push(n, b); };
  put(enc.encode(json));
  for (const [name, data] of blobs) { put(enc.encode(name)); put(data); }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

export function decodePack(b: Uint8Array): { json: string; blobs: Map<string, Uint8Array> } {
  const dec = new TextDecoder(), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const take = () => { const n = v.getUint32(o, true), out = b.subarray(o + 4, o + 4 + n); o += 4 + n; return out; };
  const json = dec.decode(take()), blobs = new Map<string, Uint8Array>();
  while (o < b.length) { const name = dec.decode(take()); blobs.set(name, take()); }
  return { json, blobs };
}

const bytes = (a: Float32Array | Int32Array | Uint8Array | Uint8ClampedArray) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
// copies, so each array is aligned and owns its buffer
const f32 = (b: Uint8Array) => new Float32Array(b.slice().buffer);
const i32 = (b: Uint8Array) => new Int32Array(b.slice().buffer);

/** What a project keeps of the store: the model, its unwrap and hand edits, the paint, and how it was being looked at. */
type Doc = {
  version: number; source: string | null; unit: number; params: Params; textureResolution: number; workspace: State['workspace'];
  activePart: number; scene: State['scene']; paint: State['paint']; paintChannel: State['paintChannel']; paintAO: boolean;
  parts: (Omit<Part, 'soup' | 'poly' | 'sides' | 'normals'> & { poly: boolean; sides: boolean; normals: boolean })[];
  result: { stats: Output['stats'] } | null; pins: Record<number, number[]>; sets: (SavedSet | null)[];
  /** The mirror plane drawn by hand (world units), or missing/null for automatic. */
  symPlane?: State['symPlane'];
};

/** The store's document and its blobs (`setOf(i)`: part i's texture set, if it has one). */
export function docOf(s: State, setOf: (i: number) => TexSet | null) {
  const blobs: [string, Uint8Array][] = [];
  const parts = s.parts.map(({ soup, poly, sides, normals, ...p }, i) => {
    blobs.push([`part/${i}/soup`, bytes(soup)]);
    if (poly) blobs.push([`part/${i}/poly`, bytes(poly)]);
    if (sides) blobs.push([`part/${i}/sides`, bytes(sides)]);
    if (normals) blobs.push([`part/${i}/normals`, bytes(normals)]);
    if (s.uvs[i]) blobs.push([`part/${i}/uv`, bytes(s.uvs[i])]);
    return { ...p, poly: !!poly, sides: !!sides, normals: !!normals };
  });
  s.result?.parts.forEach((o, i) => {
    for (const k of ['positions', 'uvs', 'stretch'] as const) blobs.push([`out/${i}/${k}`, bytes(Float32Array.from(o[k]))]);
    for (const k of ['island', 'source'] as const) blobs.push([`out/${i}/${k}`, bytes(Int32Array.from(o[k]))]);
  });
  const sets = s.parts.map((_, i) => {
    const ts = setOf(i);
    if (!ts) return null;
    const { saved, buffers } = saveSet(ts);
    for (const b of buffers) for (const t of tilesOf(b.px, saved.size, b.stride)) blobs.push([`set/${i}/${b.id}/${b.what}/${t.tx}_${t.ty}`, t.data]);
    return saved;
  });
  // a map loaded from disk lives at a blob: URL, gone with the page; a preset's URL reloads
  const scene = s.scene.hdriUrl?.startsWith('blob:') ? { ...s.scene, hdriUrl: null, hdriId: '', hdriName: '' } : s.scene;
  const doc: Doc = {
    version: PROJECT_VERSION, source: s.source, unit: s.unit, params: s.params, textureResolution: s.textureResolution, workspace: s.workspace,
    activePart: s.activePart, scene, paint: s.paint, paintChannel: s.paintChannel, paintAO: s.paintAO, parts,
    result: s.result ? { stats: s.result.stats } : null,
    pins: Object.fromEntries(Object.entries(s.pins).map(([i, p]) => [i, [...p.corners]])), sets,
    symPlane: s.symPlane,
  };
  return { doc, blobs };
}

/** A project back as store state, plus each part's saved texture set and how to read its pixels. */
export function docFrom(saved: unknown, blobs: Map<string, Uint8Array>) {
  const doc = saved as Doc;
  if (doc.version > PROJECT_VERSION) throw new Error('This project was saved by a newer Barista; update to open it.');
  const need = (name: string) => { const b = blobs.get(name); if (!b) throw new Error(`The project is missing ${name}`); return b; };
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
  const pins: State['pins'] = result ? Object.fromEntries(Object.entries(doc.pins).map(([i, c]) => [i, { of: result.parts[+i].positions, corners: new Set(c) }])) : {};
  // per set, its tiles by buffer: `set/<part>/<layer id>/<channel|mask|clip>/<tx>_<ty>`
  const tiles = new Map<string, { tx: number; ty: number; data: Uint8Array }[]>();
  for (const [name, data] of blobs) {
    const m = /^set\/(\d+)\/(\d+)\/(\w+)\/(\d+)_(\d+)$/.exec(name);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key)!.push({ tx: +m[4], ty: +m[5], data });
  }
  const pixels = (part: number, size: number) => (id: number, what: Channel | 'mask' | 'clip', stride: number) =>
    fromTiles(new Uint8Array(size * size * stride), size, stride, tiles.get(`${part}/${id}/${what}`) ?? []);
  const state = {
    source: doc.source, unit: doc.unit, params: doc.params, textureResolution: doc.textureResolution, workspace: doc.workspace,
    activePart: Math.min(doc.activePart, Math.max(0, parts.length - 1)), scene: doc.scene, paint: doc.paint, paintChannel: doc.paintChannel,
    paintAO: doc.paintAO, parts, result, uvs, pins, symPlane: doc.symPlane ?? null, symEdit: null,
  } satisfies Partial<State>;
  return { state, sets: doc.sets, pixels };
}
