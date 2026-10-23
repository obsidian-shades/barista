// node src/files.check.ts: a quad's two triangles go out as one 4-corner face in winding order; a seam inside it splits it back.
import assert from 'node:assert';
import { faceLoops, toObjs } from './files.ts';

// quad 0-1-2-3 as triangles (0,1,2) and (0,2,3); corners 0..5
const vi = [0, 1, 2, 0, 2, 3];
const quad = faceLoops(vi, [0, 1, 2, 0, 2, 3], Int32Array.from([0, 0]));
assert.deepEqual(quad.map((f) => f.map((c) => vi[c])), [[0, 1, 2, 3]]);
// the diagonal 0–2 carries different UVs on its two sides (a seam): both triangles go out on their own
assert.deepEqual(faceLoops(vi, [0, 1, 2, 4, 5, 3], Int32Array.from([0, 0])), [[0, 1, 2], [3, 4, 5]]);
// no polygons: triangles
assert.deepEqual(faceLoops(vi, [0, 1, 2, 0, 2, 3], undefined), [[0, 1, 2], [3, 4, 5]]);
// export writes the file's own normals; a corner the file had none for (NaN) falls back to angle smoothing (here the face's)
const out = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uvs: [0, 0, 1, 0, 0, 1], stretch: [0], island: [0], source: [0] };
const obj = (normals?: Float32Array) => new TextDecoder().decode(toObjs([{ name: 'p', material: 'm', out, uv: new Float32Array(out.uvs), normals }], 30, 100)[0].data)
  .split('\n').filter((l) => l.startsWith('vn '));
assert.deepEqual(obj(new Float32Array([0.6, 0, 0.8, 0.6, 0, 0.8, NaN, NaN, NaN])), ['vn 0.6000000238418579 0 0.800000011920929', 'vn 0 0 1']);
assert.deepEqual(obj(), ['vn 0 0 1']);
console.log('files ok');
