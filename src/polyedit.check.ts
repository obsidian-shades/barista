// node src/polyedit.check.ts: a strip of four triangles → two quads → one 6-corner polygon; a ring never closes on itself.
import assert from 'node:assert';
import { carryNormals, dissolve, ownPolygons, trisToQuads } from './polyedit.ts';

// unit squares [0,1] and [1,2] along x, each split along its diagonal
const at = (x: number, y: number) => [x, y, 0, x + 1, y, 0, x + 1, y + 1, 0, x, y, 0, x + 1, y + 1, 0, x, y + 1, 0];
const sq = (x: number) => [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 0, 0, x + 1, 1, 0, x, 1, 0];
const strip = new Float32Array([...sq(0), ...sq(1)]);
const q = trisToQuads(strip, ownPolygons(4), [0, 1, 2, 3])!;
assert.deepEqual([...q.poly], [0, 0, 1, 1], 'pairs each square, not across squares');
assert.deepEqual([...q.sides], [4, 4]);
const n = dissolve(strip, q, [[1, 2]])!;
assert.deepEqual([[...n.poly], [...n.sides]], [[0, 0, 0, 0], [6]], 'two quads side by side make a 6-corner polygon');

// a ring: a 3×3 grid of squares without the centre. Dissolving every edge between its quads would leave a polygon
// with a hole, so the merge that would close the ring is refused and every polygon keeps one simple outline.
const cells: number[] = [];
for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (x !== 1 || y !== 1) cells.push(...at(x, y));
const ring = new Float32Array(cells), rq = trisToQuads(ring, ownPolygons(16), Array.from({ length: 16 }, (_, i) => i))!;
assert.equal(rq.sides.length, 8);
const shared: [number, number][] = [];
const key = (f: number, k: number) => [...ring.subarray(f * 9 + k * 3, f * 9 + k * 3 + 2)].join();
for (let a = 0; a < 16; a++) for (let b = a + 1; b < 16; b++) {
  const ka = [0, 1, 2].map((k) => key(a, k)), kb = new Set([0, 1, 2].map((k) => key(b, k)));
  if (ka.filter((x) => kb.has(x)).length === 2 && rq.poly[a] !== rq.poly[b]) shared.push([a, b]);
}
const merged = dissolve(ring, rq, shared)!;
assert.ok(merged.sides.length === 2 && [...merged.sides].every((n) => n >= 4), `ring kept open: ${[...merged.sides]}`);
// a move keeps the file's normals where nothing moved, and a sharp edge stays sharp: two faces at 90° along x=1,
// each with its own flat normal; lifting the far corner of the floor turns only the floor's fan there
const bent = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 0]), fileN = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, -1, 0, 0, -1, 0, 0, -1, 0, 0]);
const same = carryNormals(bent, fileN, bent);
assert.ok(same.every((x, i) => Math.abs(x - fileN[i]) < 1e-6), 'nothing moved, file normals kept');
const lifted = bent.slice(); lifted[2] = 0.3;
const c = carryNormals(bent, fileN, lifted);
assert.ok(c.slice(9).every((x, i) => Math.abs(x - fileN[9 + i]) < 1e-6), 'the wall across the sharp edge is untouched');
assert.ok(c[3] > 0.1 && c[6] > 0.1, 'the floor leans with its lifted corner');
console.log('polyedit ok');
