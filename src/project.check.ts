// node src/project.check.ts: a document through docOf → Pack → docFrom → restoreSet comes back the same.
import assert from 'node:assert';
import { decodePack, docFrom, docOf, encodePack } from './project.ts';
import { CHANNELS, fillAll, restoreSet, setOf, tilesOf, fromTiles, type TexSet } from './paint.ts';
import type { State } from './store.ts';

// tiles: empty ones are skipped, the rest come back exactly
const n = 512, px = new Uint8ClampedArray(n * n * 4);
for (let i = 300 * n * 4; i < 301 * n * 4; i += 4) px.set([10, 20, 30, 255], i);
const tiles = tilesOf(px, n, 4);
assert.equal(tiles.length, 2, 'one painted row crosses two of the four tiles');
assert.deepEqual(fromTiles(new Uint8ClampedArray(n * n * 4), n, 4, tiles), px);

// a whole document
const soup = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), uv = new Float32Array([0, 0, 1, 0, 1, 1]);
const ts: TexSet = setOf(soup, 256);
fillAll(ts, { radius: 0, flow: 1, hardness: 1, erase: false, values: { color: [200, 100, 50] } });
const state = {
  source: 'tri.fbx', unit: 100, params: { sharp: 45, tol: 0.08, seam_weight: 0.1, join: true, atlas: 0, one_atlas: false }, textureResolution: 256, workspace: 'paint',
  activePart: 0, scene: { hdriUrl: 'blob:x' }, paint: {}, paintChannel: 'material', paintAO: true,
  parts: [{ name: 'Tri', soup, seams: [0, 0, 0, 1, 0, 0], marked: [], solved: [], visible: true, textured: true, poly: new Int32Array([0]) }],
  uvs: [uv], result: { stats: { islands: 1 }, parts: [{ positions: [...soup], uvs: [...uv], stretch: [0], island: [0], source: [0] }] }, pins: { 0: { of: [], corners: new Set([2]) } },
} as unknown as State;
const { doc, blobs } = docOf(state, () => ts);
const back = decodePack(encodePack(JSON.stringify({ doc }), blobs));
const { state: s2, sets, pixels } = docFrom((JSON.parse(back.json) as { doc: unknown }).doc, back.blobs);
assert.deepEqual(s2.parts[0].soup, soup);
assert.deepEqual(s2.parts[0].poly, new Int32Array([0]));
assert.deepEqual(s2.parts[0].seams, [0, 0, 0, 1, 0, 0]);
assert.deepEqual(s2.uvs[0], uv);
assert.deepEqual(s2.result!.parts[0].positions, [...soup]);
assert.equal(s2.scene.hdriUrl, null, 'a blob: map is not kept');
assert.deepEqual([...s2.pins[0].corners], [2]);
const soup2 = s2.parts[0].soup, ts2 = restoreSet(soup2, sets[0]!, pixels(0, sets[0]!.size));
assert.equal(ts2.layers.length, ts.layers.length);
assert.deepEqual(ts2.layers[0].px.color, ts.layers[0].px.color, 'the painted pixels come back');
assert.equal(ts2.layers[0].id, ts.layers[0].id);
assert.equal(CHANNELS.color.k, 3);
console.log('project ok');
