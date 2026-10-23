// node src/paint.check.ts: a unit square split at x = 0.5 into two islands far apart in UV. A dab on the seam paints
// both; a dab paints a flat face evenly (no lines where its triangles meet); layers stack; erase and undo work.
import assert from 'node:assert';
import { composite, dab, fillTris, generate, keep, maskTris, newLayer, select, setBaked, setOf, undo, type Brush, type GenKind } from './paint.ts';

// left half [0,.5] → uv (0..0.25, 0..0.5); right half [.5,1] → uv (0.5..0.75, 0..0.5): the seam is 0.25 apart in UV
const pos = [0, 0, 0, 0.5, 0, 0, 0.5, 1, 0, 0, 0, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 0, 0, 1, 0, 0, 1, 1, 0, 0.5, 0, 0, 1, 1, 0, 0.5, 1, 0];
const uvs = pos.flatMap((_, i) => (i % 3 ? [] : [pos[i] / 2 + (i >= 18 ? 0.25 : 0), pos[i + 1] / 2])); // the right half's 2 triangles shifted
const s = setOf(new Float32Array(pos), 64);
const at = (u: number, v: number) => { const i = (Math.floor(v * 64) * 64 + Math.floor(u * 64)) * 4; return Array.from((s.color.image.data as Uint8ClampedArray).subarray(i, i + 3)); };
const BASE = [188, 188, 188]; // the unpainted Base Color
const red: Brush = { radius: 0.1, flow: 1, hardness: 0.9, erase: false, values: { color: [255, 0, 0] } };

keep(s);
dab(s, pos, uvs, [0.5, 0.5, 0], red);
assert.deepEqual(at(0.24, 0.25), [255, 0, 0], 'left of the seam painted');
assert.deepEqual(at(0.51, 0.25), [255, 0, 0], 'right of the seam painted, though far away in UV');
assert.deepEqual(at(0.1, 0.25), BASE, 'outside the radius untouched');
assert.deepEqual(at(0.9, 0.9), BASE, 'empty texture space untouched');

// half-strength dab right over the left half's diagonal: every texel takes it once, so the diagonal isn't darker
keep(s);
dab(s, pos, uvs, [0.25, 0.5, 0], { ...red, radius: 0.2, flow: 0.5, hardness: 1 });
const g = [at(0.125, 0.25)[1], at(0.1, 0.22)[1], at(0.15, 0.28)[1]];
assert.ok(g.every((x) => Math.abs(x - g[0]) <= 1), `even across the diagonal: ${g}`);

// a second layer over the first, then hidden
s.layers.push(newLayer(2)); s.active = 1;
fillTris(s, pos, uvs, [0, 1], { ...red, values: { color: [0, 255, 0] } });
assert.deepEqual(at(0.1, 0.1), [0, 255, 0], 'the top layer covers');
s.layers[1].visible = false; composite(s);
assert.deepEqual(at(0.1, 0.1), BASE, 'hidden, the layer below shows');
s.layers[1].visible = true; composite(s);
keep(s);
dab(s, pos, uvs, [0.2, 0.2, 0], { ...red, erase: true });
assert.deepEqual(at(0.1, 0.1), BASE, 'the eraser takes the top layer off there');

// a selection on the left half's lower triangle: a big dab paints only there, and the bucket on that one face fills it
// exactly, not a pixel over into the face beside it (same island, so no seam bleed)
const before = at(0.05, 0.4);
select(s, maskTris(s, pos, uvs, [0]), 'set');
dab(s, pos, uvs, [0.5, 0.5, 0], { ...red, radius: 2, values: { color: [0, 0, 255] } });
assert.deepEqual(at(0.2, 0.05), [0, 0, 255], 'inside the selection painted');
assert.deepEqual(at(0.05, 0.4), before, 'outside the selection untouched');
select(s, null, 'set');
keep(s);
fillTris(s, pos, uvs, [1], { ...red, values: { color: [0, 0, 0] } });
const row = 16; // v = 0.25: the diagonal of the left square runs through texel x = 8 (u = 0.125)
const xs = Array.from({ length: 16 }, (_, x) => (s.color.image.data as Uint8ClampedArray)[(row * 64 + x) * 4 + 2]);
assert.ok(xs.slice(0, 7).every((b) => b === 0) && xs.slice(9, 16).every((b) => b === 255), `face fill stops at the diagonal: ${xs}`);
for (let i = 0; i < 5; i++) assert.ok(undo(s)); // the fill, the deselect, the selection (with the dab in it), the eraser, the half dab // the eraser, then the half dab (and the layer, added inside that step)
assert.deepEqual(at(0.24, 0.25), [255, 0, 0], 'undo keeps the first stroke');
assert.ok(undo(s));
assert.deepEqual(at(0.24, 0.25), BASE, 'and takes it back');
// generators: Edge Wear covers texels near a convex edge and leaves the rest; Occlusion covers what's shut in
const N = 64 * 64, far = new Float32Array(N).fill(Infinity), b = { pos: new Float32Array(N * 3), nrm: new Float32Array(N * 3), has: new Uint8Array(N).fill(1), ao: new Float32Array(N).fill(1), convex: far.slice(), concave: far, span: 1 };
b.convex[5] = 0; b.ao[7] = 0;
setBaked(s, b);
const gen = (kind: GenKind) => {
  const l = { ...newLayer(9), gen: { kind, amount: 0.5, soft: 0.1, width: 0.01, grunge: 0, scale: 0.05, color: '#000000', rough: 0, metal: 0, clip: null } };
  generate(s, l);
  return (i: number) => l.px.color![i * 4 + 3];
};
const edge = gen('edge'), occ = gen('ao');
assert.ok(edge(5) === 255 && edge(6) === 0, 'edge wear on the edge only');
assert.ok(occ(7) === 255 && occ(6) === 0, 'occlusion where shut in only');
console.log('paint ok');
