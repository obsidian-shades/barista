// node src/project.check.ts: a document through docOf → Pack → docFrom → restoreSet comes back the same; a snapshot is
// fixed at the tick it was taken; and a save's cache writes only what changed (save.ts).
import assert from 'node:assert';
import { blobsOf, decodePack, docFrom, docOf, encodePack, restoreAssets, unlz4 } from './project.ts';
import { cacheFits, commitCache, newCache, prepareSave, primeCache } from './save.ts';
import { CHANNELS, composite, disposeSet, fillAll, restoreSet, saveSet, setOf, tilesOf, fromTiles, type TexSet } from './paint.ts';
import type { MaterialAsset } from './materials.ts';
import type { State } from './store.ts';

// tiles: empty ones are skipped, the rest come back exactly
const n = 512, px = new Uint8ClampedArray(n * n * 4);
for (let i = 300 * n * 4; i < 301 * n * 4; i += 4) px.set([10, 20, 30, 255], i);
const tiles = tilesOf(px, n, 4);
assert.equal(tiles.length, 2, 'one painted row crosses two of the four tiles');
assert.deepEqual(fromTiles(new Uint8ClampedArray(n * n * 4), n, 4, tiles), px);

// a whole document, with a selection (saved since format 2), an imported material (kept inside the file) and a colour
const soup = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), uv = new Float32Array([0, 0, 1, 0, 1, 1]);
const ts: TexSet = setOf(soup, 256);
fillAll(ts, { radius: 0, flow: 1, hardness: 1, erase: false, values: { color: [200, 100, 50] } });
ts.sel = new Uint8Array(256 * 256);
ts.sel.fill(255, 0, 300);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const mat: MaterialAsset = {
  id: 'user-brass', name: 'Brass', category: 'Imported', tags: ['imported'], width: 1, height: 1, normal: 'gl', license: 'x', source: 'Local folder',
  library: 'import', maps: { basecolor: `data:image/png;base64,${png.toString('base64')}` },
};
const bare = {
  source: 'tri.fbx', unit: 100, params: { sharp: 45, tol: 0.08, seam_weight: 0.1, join: true, atlas: 0, one_atlas: false }, textureResolution: 256, workspace: 'paint',
  activePart: 0, scene: { hdriUrl: 'blob:x' }, paint: {}, paintChannel: 'material', paintAO: true,
  parts: [{ name: 'Tri', soup, seams: [0, 0, 0, 1, 0, 0], marked: [], solved: [], visible: true, textured: true, poly: new Int32Array([0]) }],
  uvs: [uv], result: { stats: { islands: 1 }, parts: [{ positions: [...soup], uvs: [...uv], stretch: [0], island: [0], source: [0] }] }, pins: { 0: { of: [], corners: new Set([2]) } },
  materials: [mat], decals: [], refImage: null,
} as unknown as State;
ts.layers[0] = { ...ts.layers[0], fill: { asset: 'user-brass', projection: 'uv', tiling: 1, tiles: 1, rotation: 0, offset: [0, 0], normalStrength: 1, tint: '#ffffff', channels: ['color'] } };
const state = bare;
const firstSnap = docOf(state, () => ts);
assert.equal(firstSnap.doc.version, 2);
assert.equal(firstSnap.doc.sets?.[0]?.sel, true, 'the selection is in the document');
assert.equal(firstSnap.doc.assets?.materials?.length, 1, 'a used imported material travels with the project');
assert.equal(firstSnap.doc.scene.hdriUrl, null, 'a blob: map is not kept as a URL');
const backBlobs = await blobsOf(firstSnap);
assert(backBlobs.some(([name]) => name === 'asset/material/user-brass/basecolor'), 'the material file is a blob');
assert.equal(backBlobs.find(([name]) => name === 'asset/material/user-brass/basecolor')![1].length, png.length, 'the file bytes are kept');
const back = decodePack(new Uint8Array(await encodePack(JSON.stringify({ doc: firstSnap.doc }), backBlobs).arrayBuffer()));
const { state: s2, sets, pixels, names, assets } = docFrom((JSON.parse(back.json) as { doc: unknown }).doc, back.blobs);
assert.deepEqual(s2.parts[0].soup, soup);
assert.deepEqual(s2.parts[0].poly, new Int32Array([0]));
assert.deepEqual(s2.parts[0].seams, [0, 0, 0, 1, 0, 0]);
assert.deepEqual(s2.uvs[0], uv);
assert.deepEqual(s2.result!.parts[0].positions, [...soup]);
assert.deepEqual([...s2.pins[0].corners], [2]);
assert.equal(assets.materials.length, 1, 'the imported material comes back as bytes');
assert.deepEqual([...assets.materials[0].maps.basecolor!], [...(back.blobs.get('asset/material/user-brass/basecolor'))!]);
const soup2 = s2.parts[0].soup, ts2 = restoreSet(soup2, sets[0]!, pixels(0, sets[0]!.size));
assert.equal(ts2.layers.length, ts.layers.length);
assert.deepEqual(ts2.layers[0].px.color, ts.layers[0].px.color, 'the painted pixels come back');
assert.deepEqual(ts2.sel, ts.sel, 'the selection comes back');
assert.equal(ts2.layers[0].id, ts.layers[0].id);
// the composite travels too, so an open shows it without compositing the stack again
assert.equal(sets[0]!.comp, true, 'a settled composite is saved');
assert.deepEqual(ts2.color.image.data, ts.color.image.data, 'the composite comes back exactly');
assert.deepEqual(ts2.orm.image.data, ts.orm.image.data);
assert.deepEqual(ts2.cov, ts.cov);
// a stack restored without one is not the stack's composite until it has been laid out: never saved as one
const unlaid = restoreSet(new Float32Array(soup), { ...sets[0]!, comp: false }, pixels(0, sets[0]!.size));
assert.equal(docOf(state, () => unlaid).doc.sets?.[0]?.comp, undefined, 'an unlaid composite is not saved');
fillAll(unlaid, { radius: 0, flow: 1, hardness: 1, erase: false, values: { color: [1, 2, 3] } }); // padded, but only the brush's channels
assert.equal(docOf(state, () => unlaid).doc.sets?.[0]?.comp, undefined, "a stroke over an unlaid set doesn't make it the stack's");
composite(unlaid);
assert.equal(docOf(state, () => unlaid).doc.sets?.[0]?.comp, true, 'once composited it is');
assert.equal(CHANNELS.color.k, 3);
// an open's blobs come LZ4-packed: 'abcd', a 60-byte match 4 back (overlapping), a 40-byte match 64 back, then 'z'
const block = new Uint8Array([105, 0, 0, 0, 0x4f, 97, 98, 99, 100, 4, 0, 41, 0x0f, 64, 0, 21, 0x10, 122]);
const abcd = 'abcd'.repeat(16);
assert.equal(new TextDecoder().decode(unlz4(block)), abcd + abcd.slice(0, 40) + 'z');
assert.equal(new TextDecoder().decode(unlz4(block, new Uint8Array(4096))), abcd + abcd.slice(0, 40) + 'z', 'into a scratch tile');
assert.throws(() => unlz4(block.subarray(0, 12)), /damaged/);

// an opened project's imported files come back as shelf entries with blob: URLs\nconst restored = restoreAssets(assets);\nassert.equal(restored.materials.length, 1, 'the material is back on the shelf');\nassert(restored.materials[0].maps.basecolor!.startsWith('blob:'), 'its map is a blob: URL again');\nassert.equal(restored.materials[0].thumb, restored.materials[0].maps.basecolor);\nconst art = restoreAssets({ materials: [], decals: [], hdri: { bytes: new Uint8Array([1]), name: 'a b.hdr' }, ref: { bytes: new Uint8Array([2]), opacity: 0.5 } });\nassert(art.scene.hdriUrl?.includes(encodeURIComponent('a b.hdr')), 'the environment map name is kept in its URL');\nassert.equal(art.refImage?.opacity, 0.5);\nassert(art.refImage!.url.startsWith('blob:'));\n\n// a save snapshot is fixed when it is taken: a UV drag afterwards cannot change the bytes it writes
const held = docOf(state, () => ts);
state.uvs[0][0] = 0.75;
const heldBlobs = new Map((await blobsOf(held)).map(([k, v]) => [k, v]));
const heldUv = new Float32Array(heldBlobs.get('part/0/uv')!.slice().buffer);
assert.equal(heldUv[0], 0, 'the snapshot kept the UVs as they were');
state.uvs[0][0] = 0;

// the save cache: a first save writes everything; the next one (same file) only names what the file has
const cache = newCache();
const snap = docOf(state, () => ts);
const one = await prepareSave(snap, cache, { reuse: false, path: '/tmp/p.barista', auto: false });
assert(one.blobs.length > 5, 'a first save writes the document');
assert.equal(one.keep.length, 0, 'a new file has nothing to keep');
for (const [, data] of one.blobs) assert(data instanceof Uint8Array);
commitCache(cache, one.next, 1);
assert(cacheFits(cache, '/tmp/p.barista'), 'the cache matches the file it was made for');
assert(!cacheFits(cache, '/tmp/other.barista'), 'and not another one');
const same = await prepareSave(docOf(state, () => ts), cache, { reuse: true, path: '/tmp/p.barista', auto: false });
assert.equal(same.blobs.length, 0, 'nothing changed: nothing is made or sent');
assert(same.keep.length > 5, 'the file keeps every blob');

// paint: writing a layer's buffer in place (a generator, a fill, a mask) moves its stamp, so its tiles are written
const before = same.keep.length;
fillAll(ts, { radius: 0, flow: 1, hardness: 1, erase: false, values: { color: [10, 20, 30] } });
const painted = await prepareSave(docOf(state, () => ts), cache, { reuse: true, path: '/tmp/p.barista', auto: false });
assert(painted.blobs.length > 0, 'the painted layer is written');
assert(painted.blobs.every(([name]) => name.startsWith('set/0/')), 'only that set changed');
assert(painted.keep.length > 0, 'the rest of the document is kept');
assert(painted.keep.includes('part/0/soup'), 'the mesh is kept');
assert(painted.keep.length + painted.blobs.length >= before, 'every blob is either kept or written');
assert.equal(painted.blobs.filter(([name]) => name === 'part/0/soup').length, 0, 'the mesh is kept');
commitCache(cache, painted.next, 2);
const again = await prepareSave(docOf(state, () => ts), cache, { reuse: true, path: '/tmp/p.barista', auto: false });
assert(again.blobs.length === 0, 'and the next save is quiet again');

// the composite is written per tile: a small composite sends the tiles it touched, not four whole textures
const big = setOf(new Float32Array(soup), 512), bigCache = newCache();
commitCache(bigCache, (await prepareSave(docOf(state, () => big), bigCache, { reuse: false, path: '/tmp/b.barista', auto: false })).next, 1);
composite(big, 0, 0, 10, 10);
const dabbed = await prepareSave(docOf(state, () => big, { reuse: (id, key) => bigCache.keys.get(id) === key }), bigCache, { reuse: true, path: '/tmp/b.barista', auto: false });
const comps = dabbed.blobs.filter(([name]) => name.includes('/comp_'));
assert(comps.length > 0 && comps.every(([name]) => name.endsWith('/0_0')), 'only the touched composite tile is written');

// a geometry edit writes the mesh and the results made from it, not the paint
const moved = new Float32Array(soup);
moved[3] = 2;
const edited = { ...state, parts: [{ ...state.parts[0], soup: moved }] } as State;
const geo = await prepareSave(docOf(edited, () => ts), cache, { reuse: true, path: '/tmp/p.barista', auto: false });
assert(geo.blobs.some(([name]) => name === 'part/0/soup'), 'the new mesh is written');
assert.equal(geo.blobs.filter(([name]) => name.startsWith('set/')).length, 0, 'the paint did not change');

// opening a project primes the cache: every blob the file had is kept by the first save after it
const opened = { ...(s2 as unknown as State), materials: [], decals: [], refImage: null };
const primed = newCache();
primeCache(primed, docOf(opened, () => ts2, { reuse: () => true }), names, 5, '/tmp/x.barista');
const afterOpen = await prepareSave(docOf(opened, () => ts2), primed, { reuse: true, path: '/tmp/x.barista', auto: false });
assert.equal(afterOpen.blobs.length, 0, 'a save right after opening writes nothing');
assert(afterOpen.keep.includes('part/0/soup') && afterOpen.keep.includes('part/0/uv'), 'the mesh and UVs are kept');
assert(afterOpen.keep.some((x) => x.startsWith('set/0/')), 'the paint tiles are kept');
// a version 1 file has no revision to prime against: its first save writes everything (never a half-known file)
const oldCache = newCache();
primeCache(oldCache, docOf(opened, () => ts2, { reuse: () => true }), names, 0, '/tmp/old.barista');
assert.equal(oldCache.rev, null, 'an older file is not primed');

// a document replaced: its set is freed and the same soup gets a new one, not the disposed textures
let freed = 0;
const was = ts2.color.dispose.bind(ts2.color);
ts2.color.dispose = () => { freed++; was(); };
disposeSet(ts2);
assert.equal(freed, 1, 'the set\'s textures are disposed');
assert.notEqual(setOf(soup2, sets[0]!.size), ts2, 'a disposed set is never handed out again');
const saved = saveSet(ts);
assert.equal(saved.saved.sel, true);
assert(saved.buffers.some((b) => b.what === 'sel'));
console.log('project ok');
