// node src/fitpack.check.ts: changed islands drop into the free space round the fixed ones; one too big changes nothing.
import assert from 'node:assert';
import { placeChanged, type Isl } from './fitpack.ts';

/** A square island (two triangles) at (u, v) of side s, in its own array. */
const square = (u: number, v: number, s: number): Isl => ({
  a: new Float32Array([u, v, u + s, v, u + s, v + s, u, v, u + s, v + s, u, v + s]), corners: [0, 1, 2, 3, 4, 5],
});
const box = (s: Isl) => { const u = [0, 2, 4, 6, 8, 10].map((i) => s.a[i]), v = [1, 3, 5, 7, 9, 11].map((i) => s.a[i]); return [Math.min(...u), Math.min(...v), Math.max(...u), Math.max(...v)]; };
const apart = (p: number[], q: number[]) => p[2] <= q[0] || q[2] <= p[0] || p[3] <= q[1] || q[3] <= p[1];

// the bottom half taken; two new squares land above it, inside the square, apart, their size kept
const floor = square(0, 0, 0.5), floor2 = square(0.5, 0, 0.5);
const a = square(0.1, 0.1, 0.3), b = square(0.2, 0.2, 0.2);
assert.ok(placeChanged([floor, floor2], [a, b]));
for (const s of [a, b]) {
  const [u0, v0, u1, v1] = box(s);
  assert.ok(u0 >= 0 && v0 >= 0.5 && u1 <= 1 && v1 <= 1, `inside the free half: ${box(s)}`);
}
assert.ok(apart(box(a), box(b)), 'the two new islands apart');
assert.ok(Math.abs(box(a)[2] - box(a)[0] - 0.3) < 1e-6, 'size kept');
assert.deepEqual(box(floor), [0, 0, 0.5, 0.5], 'fixed islands stay');

// clear of everything where it lies: it stays there
const here = square(0.6, 0.6, 0.2), was = here.a.slice();
assert.ok(placeChanged([floor, floor2], [here]));
assert.deepEqual(here.a, was);

// no room: nothing moves
const full = square(0, 0, 1), c = square(0.2, 0.2, 0.3), before = c.a.slice();
assert.ok(!placeChanged([full], [c]));
assert.deepEqual(c.a, before);
console.log('fitpack ok');
