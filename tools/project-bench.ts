// Real-world project benchmark: opens a `.barista` through the engine, restores its paint, checks that a save right
// after opening writes nothing, makes a small stroke and saves it incrementally, then reopens the copy and compares the
// pixels. Run it after a change to the project format or the save pipeline:
//
//   pnpm server                                     (or any format-2 engine; API=http://host:port/api)
//   node --max-old-space-size=8192 tools/project-bench.ts C:\path\to\Gun_Low.barista
//
// The project itself is never written: the benchmark works on a copy (2nd argument, default `target/<name>.bench.barista`).
// A 100 MB project with 2K paint holds ~1.6 GB, hence the heap flag.
import assert from 'node:assert';
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { decodePack, docFrom, docOf, encodePack } from '../src/project.ts';
import { commitCache, newCache, prepareSave, primeCache } from '../src/save.ts';
import { bleedAll, dabUV, restoreSet, type Brush, type TexSet } from '../src/paint.ts';
import type { MaterialAsset } from '../src/materials.ts';
import type { State } from '../src/store.ts';

const API = process.env.API ?? 'http://127.0.0.1:3000/api';
const source = process.argv[2];
if (!source) {
  console.error('usage: node --max-old-space-size=8192 tools/project-bench.ts <project.barista> [copy.barista]');
  process.exit(2);
}
const original = resolve(source), name = basename(original, '.barista');
const copy = resolve(process.argv[3] ?? join('target', `${name}.bench.barista`));
const mb = (n: number) => (n / 1048576).toFixed(1);
const now = () => performance.now();
const fmt = (t: number) => `${Math.round(t)} ms`;
const open = async (path: string) => {
  const t = now();
  const r = await fetch(`${API}/project-open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  if (!r.ok) throw new Error(`project-open: ${r.status} ${await r.text()}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { bytes, ms: now() - t };
};
const save = async (path: string, rev: number | null, keep: string[], doc: unknown, blobs: [string, Uint8Array][]) => {
  const head = { path, save_as: false, autosave: false, name, doc, ...(rev == null ? {} : { rev, keep }) };
  const pack = encodePack(JSON.stringify(head), blobs);
  const t = now();
  const r = (await (await fetch(`${API}/project-save`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pack })).json()) as
    { path: string; rev: number; stale: boolean; written: number };
  return { r, ms: now() - t, pack: pack.size };
};

const format = await (await fetch(`${API}/project-format`, { method: 'POST' })).json().catch(() => 0);
if (format !== 2) throw new Error(`${API} is not a format-2 engine (got ${format}): restart the engine tab after engine changes`);

mkdirSync(dirname(copy), { recursive: true });
copyFileSync(original, copy); // every run starts from the untouched project

const opened = await open(original);
console.log(`open: ${fmt(opened.ms)}, pack ${mb(opened.bytes.length)} MB`);
let t = now();
const { json, blobs } = decodePack(opened.bytes);
const head = JSON.parse(json) as { path: string; rev: number; lz4?: boolean; doc: unknown };
console.log(`decode: ${fmt(now() - t)}, rev ${head.rev}`);

t = now();
let loaded: ReturnType<typeof docFrom> | null = docFrom(head.doc, blobs, head.lz4);
const names = loaded.names;
const state = { ...(loaded.state as unknown as State), materials: [], decals: [], refImage: null } as State;
const sets = new Map<number, TexSet>();
loaded.sets.forEach((saved, i) => {
  if (!saved) return;
  sets.set(i, restoreSet(state.parts[i].soup, saved, loaded!.pixels(i, saved.size)));
});
console.log(`document + paint: ${fmt(now() - t)}, ${sets.size} sets, ${state.parts.length} parts, ${loaded.warnings.length} warnings`);
assert.deepEqual(loaded.warnings, []);

// the pack's views are only needed while the sets are unpacked, as in the app: leave the memory to the collector
loaded = null;
blobs.clear();
const setOf = (i: number) => sets.get(i) ?? null;

t = now();
const snap = docOf(state, setOf);
console.log(`snapshot: ${fmt(now() - t)}, ${snap.items.length} blob items, ${snap.warnings.length} warnings`);
assert.deepEqual(snap.warnings, [], 'a built-in shelf material is not a missing file');

const cache = newCache();
t = now();
primeCache(cache, docOf(state, setOf, { reuse: () => true }), names, head.rev, copy);
console.log(`prime the save cache: ${fmt(now() - t)}`);

t = now();
const quiet = await prepareSave(snap, cache, { reuse: true, path: copy, auto: false });
console.log(`save with no edits: ${fmt(now() - t)}, ${quiet.blobs.length} blobs, ${mb(quiet.bytes)} MB, ${quiet.keep.length} kept`);
assert.equal(quiet.blobs.length, 0, 'opening then saving must write nothing');
assert(quiet.keep.length > 0);

// what the app's shelf would hold: a fill's built-in material resolves, and it is still not copied into the project
const anyFill = (head.doc as { sets?: ({ layers?: { fill?: { asset?: string } }[] } | null)[] }).sets
  ?.flatMap((s) => s?.layers ?? []).map((l) => l.fill?.asset).find((id) => id && id !== 'solid');
if (anyFill) {
  const builtin: MaterialAsset = { id: anyFill, name: anyFill, category: 'Metal', tags: [], width: 1024, height: 1024, normal: 'gl',
    maps: { roughness: 'r.png', normal: 'n.png' }, license: '', source: 'pack', library: 'pack' };
  state.materials = [builtin];
  const withShelf = docOf(state, setOf);
  console.log(`  ${anyFill}: ${withShelf.warnings.length} warnings, ${withShelf.doc.assets ? 'copied into the file' : 'left on the shelf (built in)'}`);
  assert.deepEqual(withShelf.warnings, []);
  assert.equal(withShelf.doc.assets ?? null, null);
  state.materials = [];
}

// a small dab on the first part, saved incrementally into the copy of the real file
const ts = sets.get(0);
if (ts) {
  const brush: Brush = { radius: 0, flow: 1, hardness: 1, erase: false, values: { color: [255, 0, 0] } };
  const saveDab = async (label: string) => {
    t = now();
    dabUV(ts, 0.5, 0.5, Math.max(4, ts.size / 50), brush);
    bleedAll(ts); // the stroke's end, as store `paintEnd` does: the composite is settled again
    // as the store's save: a composite tile the file holds under its stamp is only named
    const edited = docOf(state, setOf, { reuse: (id, key) => cache.keys.get(id) === key });
    const snapped = now() - t;
    t = now();
    const one = await prepareSave(edited, cache, { reuse: true, path: copy, auto: false });
    const prep = now() - t;
    console.log(`${label}: snapshot ${fmt(snapped)}, prepare ${fmt(prep)}, ${one.blobs.length} blobs, ${mb(one.bytes)} MB`);
    const { r, ms, pack } = await save(copy, cache.rev, one.keep, edited.doc, one.blobs);
    console.log(`  write: ${fmt(ms)}, pack ${mb(pack)} MB, rev ${r.rev}, ${r.written} blobs`);
    assert.equal(r.stale, false, 'a save against the revision it just opened must land');
    commitCache(cache, { ...one.next, path: copy }, r.rev);
    return one;
  };
  const first = await saveDab('dab');
  console.log('  blobs:', first.blobs.map(([n]) => n).join(', ') || '(none)');
  await saveDab('second dab');

  // the file keeps what was painted: reopen the copy and compare the whole colour buffer with the one in memory
  const re = await open(copy);
  const p = decodePack(re.bytes);
  const reHead = JSON.parse(p.json) as { lz4?: boolean; doc: unknown };
  const back = docFrom(reHead.doc, p.blobs, reHead.lz4);
  const ts2 = restoreSet(back.state.parts[0].soup, back.sets[0]!, back.pixels(0, back.sets[0]!.size));
  const a = ts.layers[ts.active].px.color!, c = ts2.layers[ts2.active].px.color!;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) diff++;
  console.log(`reopen: ${fmt(re.ms)}, ${diff} colour bytes differ, ${back.sets[0]!.layers.length} layers, ${back.warnings.length} warnings`);
  assert.equal(diff, 0, 'the saved paint must come back exactly');
}
console.log(`${name}: ok — ${copy}`);
