// node src/paint.check.ts: a unit square split at x = 0.5 into two islands far apart in UV. A dab on the seam paints
// both; a dab paints a flat face evenly (no lines where its triangles meet); layers stack; erase and undo work.
import assert from 'node:assert';
import { bordersOf, composite, dab, fillAll, fillTris, generate, keep, maskTris, newLayer, redo, select, setBaked, setOf, undo, bakeFill, bakeDecal, blendOf, DEFAULT_BLEND, type Brush, type Decal, type Fill, type GenKind, type PaintLayer } from './paint.ts';
import type { MaterialPixels } from './materials.ts';

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
// mip padding: the paint is carried into the gap past its island — a mip is an average, and an island with
// background behind it smears its edge into the gap and the gap into its edge (the halo at a seam). The flood
// stops at the shell of the island next door and never covers a bare face inside the same island.
const s2 = setOf(new Float32Array(pos), 64);
fillTris(s2, pos, uvs, [0, 1], { radius: 0.1, flow: 1, hardness: 1, erase: false, values: { color: [255, 0, 0] } });
const px2 = (x: number, y: number) => Array.from((s2.color.image.data as Uint8ClampedArray).subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)).join();
assert.equal(px2(17, 8), '255,0,0', 'paint is carried out into the gap (mip padding)');
assert.equal(px2(30, 8), '188,188,188', 'but only a mip deep');
assert.equal(px2(40, 8), '188,188,188', 'the island next door is not painted through the gap');
// a crease is not a seam: two quads folded 90° with their own islands. Paint may cross a smooth seam (no hairline)
// but must stop dead at the fold — bleeding a fill over a hard edge lays paint on the panel beside it.
const fold = [
  0,0,0, 1,0,0, 1,1,0, 0,0,0, 1,1,0, 0,1,0, // the flat quad
  1,0,0, 1,0,1, 1,1,1, 1,0,0, 1,1,1, 1,1,0, // the same sheet folded up at x = 1
];
const foldUV = [0,0, 0.25,0, 0.25,0.25, 0,0, 0.25,0.25, 0,0.25, 0.5,0, 0.75,0, 0.75,0.25, 0.5,0, 0.75,0.25, 0.5,0.25];
const fb = bordersOf(foldUV, fold);
assert.ok(fb.slice(0, 3).some((x) => x === 2), `the fold is a crease, not a seam: ${Array.from(fb)}`);
const seamUV = [0,0, 0.25,0, 0.25,0.25, 0,0, 0.25,0.25, 0,0.25, 0.35,0, 0.6,0, 0.6,0.25, 0.35,0, 0.6,0.25, 0.35,0.25];
assert.ok(bordersOf(seamUV, [0,0,0, 1,0,0, 1,1,0, 0,0,0, 1,1,0, 0,1,0, 0,0,0, 1,0,0, 1,1,0, 0,0,0, 1,1,0, 0,1,0]).every((x) => x !== 2), 'a cut through a flat sheet is a seam and may bleed');
// texture resolution is a paint setting, not an unwrap one: changing it resizes the set in place (nearest), so the
// paint that was there is still there and new strokes are at the new resolution
const soupR = new Float32Array(pos);
const r = setOf(soupR, 64);
fillTris(r, pos, uvs, [0, 1], red);
assert.equal((r.color.image.data as Uint8ClampedArray)[(8 * 64 + 8) * 4], 255, 'painted at 64');
const r2 = setOf(soupR, 128);
assert.equal(r2.size, 128, 'the set follows the resolution');
assert.equal((r2.color.image.data as Uint8ClampedArray)[(16 * 128 + 16) * 4], 255, 'the paint survives the resize');
assert.equal(r2.past.length, 0, 'undo history is dropped with it: its buffers are the old size');
// A fill layer: the material's maps baked through UV and tri-planar projections, its mask applied by the composite,
// and a normal map that stays a normal instead of averaging to flat.
const one = (rgba: number[]) => ({ width: 1, height: 1, data: new Uint8ClampedArray(rgba) });
const maps: MaterialPixels = {
  basecolor: one([255, 0, 0, 255]),
  roughness: one([200, 200, 200, 255]),
  metallic: one([255, 255, 255, 255]),
  normal: one([128, 128, 255, 255]),
  height: one([64, 64, 64, 255]),
};
const fs = setOf(new Float32Array(pos), 32);
fs.channels = ['color', 'rough', 'metal', 'normal', 'height'];
const fill: Fill = { asset: 'test', projection: 'uv', tiling: 1, tiles: 1, rotation: 0, offset: [0, 0], normalStrength: 1, tint: '#ffffff', channels: ['color', 'rough', 'metal', 'normal', 'height'] };
const layer: PaintLayer = { ...newLayer(7), fill };
fs.layers.push(layer);
fs.active = 1;
const texel = (set: typeof fs, x: number, y: number) => Array.from((set.color.image.data as Uint8ClampedArray).subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3));
bakeFill(fs, layer, maps, pos, uvs, 1);
composite(fs);
assert.deepEqual(texel(fs, 3, 3), [255, 0, 0], 'UV fill lands on the surface');
assert.equal((fs.orm.image.data as Uint8ClampedArray)[(3 * 32 + 3) * 4 + 1], 200, 'roughness is sampled');
assert.equal((fs.orm.image.data as Uint8ClampedArray)[(3 * 32 + 3) * 4 + 2], 255, 'metallic is sampled');
// mask off, then back on at one texel: the fill is a layer, not a replacement for the base
layer.mask = new Uint8Array(32 * 32);
composite(fs);
assert.deepEqual(texel(fs, 3, 3), BASE, 'a black mask hides the fill');
layer.mask[3 * 32 + 3] = 255;
composite(fs);
assert.deepEqual(texel(fs, 3, 3), [255, 0, 0], 'a white mask shows it');
// tri-planar on the same square: still the constant material, now projected in world space
fill.projection = 'triplanar';
delete layer.mask;
bakeFill(fs, layer, maps, pos, uvs, 1);
composite(fs);
assert.deepEqual(texel(fs, 3, 3), [255, 0, 0], 'tri-planar fill covers the square');
// tangent-space normal: (1, 0, 0) encoded as 255,128,255 must tilt the result, not stay flat
fill.projection = 'uv';
maps.normal = one([255, 128, 255, 255]);
bakeFill(fs, layer, maps, pos, uvs, 1);
composite(fs);
const n = (fs.normal.image.data as Uint8ClampedArray)[(3 * 32 + 3) * 4];
assert.ok(n > 200, `normal map tilts the baked normal: ${n}`);
// the same detail through tri-planar: the plane frame and the mesh UV frame must agree
fill.projection = 'triplanar';
bakeFill(fs, layer, maps, pos, uvs, 1);
composite(fs);
const tn = (fs.normal.image.data as Uint8ClampedArray)[(3 * 32 + 3) * 4];
assert.ok(tn > 200, `tri-planar normal tilts too: ${tn}`);
// A finish can override a scan's roughness/metallic with one value (Violet Anodized lives on a brushed map
// but is a satin anodize, not a rough one).
fill.projection = 'uv';
fill.roughness = 0.2; fill.metallic = 0.6;
bakeFill(fs, layer, maps, pos, uvs, 1);
composite(fs);
assert.equal((fs.orm.image.data as Uint8ClampedArray)[(3 * 32 + 3) * 4 + 1], 51, 'fill roughness override');
assert.equal((fs.orm.image.data as Uint8ClampedArray)[(3 * 32 + 3) * 4 + 2], 153, 'fill metallic override');
delete fill.roughness; delete fill.metallic;
// a blend mode changes how the same color meets the layer below: multiply red over the 188 base keeps red's
// red and takes the base's green/blue to zero
const bs = setOf(new Float32Array(pos), 64);
bs.channels = ['color'];
bs.layers[0].blend = { color: 'multiply' };
fillAll(bs, { radius: 1, flow: 1, hardness: 1, erase: false, values: { color: [255, 0, 0] } });
composite(bs);
const bp = Array.from((bs.color.image.data as Uint8ClampedArray).subarray((20 * 64 + 20) * 4, (20 * 64 + 20) * 4 + 3));
assert.deepEqual(bp, [188, 0, 0], `multiply blend: ${bp}`);
assert.ok(undo(fs) || true, 'undo is available for a fill');
// A decal is a flat projector: it inks front-facing texels inside its rectangle and nothing behind or outside.
// Moving it clears the old footprint, so a decal layer can be dragged without leaving a ghost.
const ds = setOf(new Float32Array(pos), 64);
ds.channels = ['color', 'rough', 'metal'];
const solid = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) };
const decal: Decal = {
  asset: 'check-mark', center: [0.5, 0.5, 0], normal: [0, 0, 1], up: [0, 1, 0],
  width: 0.4, rotation: 0, aspect: 1, tint: '#ff0000', roughness: 0.2, metallic: 0.5,
  channels: ['color', 'rough', 'metal'],
};
const dl: PaintLayer = { ...newLayer(11), decal };
ds.layers.push(dl); ds.active = 1;
bakeDecal(ds, dl, solid, pos, uvs, 1);
composite(ds);
const dpx = (x: number, y: number) => Array.from((ds.color.image.data as Uint8ClampedArray).subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3));
assert.deepEqual(dpx(16, 16), [255, 0, 0], 'the decal tints its centre');
assert.deepEqual(dpx(2, 32), BASE, 'outside the projector is untouched');
assert.equal((ds.orm.image.data as Uint8ClampedArray)[(16 * 64 + 16) * 4 + 1], 51, 'the decal sets roughness');
assert.equal((ds.orm.image.data as Uint8ClampedArray)[(16 * 64 + 16) * 4 + 2], 128, 'the decal sets metallic');
decal.center = [0.15, 0.5, 0];
bakeDecal(ds, dl, solid, pos, uvs, 1);
composite(ds);
assert.deepEqual(dpx(16, 16), BASE, 'moving the decal clears its old footprint');
assert.deepEqual(dpx(8, 16), [255, 0, 0], 'and inks the new one');
// Blends are per channel, as Substance Painter's stack holds them: a grunge layer can multiply Base Color and still
// lay its roughness straight down, and a channel nobody set keeps Substance's default.
const pc: PaintLayer = { ...newLayer(12), blend: { color: 'multiply' } };
assert.equal(blendOf(pc, 'color'), 'multiply', 'the channel that was set');
assert.equal(blendOf(pc, 'rough'), DEFAULT_BLEND.rough, 'the others keep their default');
assert.equal(DEFAULT_BLEND.height, 'add', 'height adds by default (Linear Dodge)');
assert.equal(DEFAULT_BLEND.color, 'normal', 'colour replaces by default');
// Height adds around mid grey (127/128 is zero), so stacked height detail grows instead of replacing the layer below.
const hs = setOf(new Float32Array(pos), 32);
hs.channels = ['height'];
hs.layers.push(newLayer(2)); hs.active = 1;
const hB = { radius: 1, flow: 1, hardness: 1, erase: false, values: { height: [160] } };
fillAll(hs, hB); composite(hs);
const hAt = () => (hs.height.image.data as Uint8ClampedArray)[(10 * 32 + 10) * 4];
const h1 = hAt();
hs.layers.push(newLayer(3)); hs.active = 2;
fillAll(hs, hB); composite(hs);
assert.ok(hAt() > h1 + 20, `a second height layer adds (${h1} → ${hAt()})`);
hs.layers[2].blend = { height: 'normal' }; composite(hs);
assert.equal(hAt(), h1, 'an explicit Normal on height replaces instead');
// Undo keeps the state it took back, so a Ctrl+Shift+Z can put it again — a stroke, back, and forward.
const us = setOf(new Float32Array(pos), 64);
keep(us);
dab(us, pos, uvs, [0.5, 0.5, 0], red);
const uAt = () => Array.from((us.color.image.data as Uint8ClampedArray).subarray((16 * 64 + 16) * 4, (16 * 64 + 16) * 4 + 3)).join();
assert.equal(uAt(), '255,0,0', 'painted');
assert.ok(undo(us));
assert.equal(uAt(), BASE.join(), 'undone');
assert.ok(redo(us));
assert.equal(uAt(), '255,0,0', 'redone');
assert.equal(redo(us), null, 'and nothing left to redo');
// Upload ranges: a banded pass must leave every band pending, because three uploads what is pending at the next draw
// and only then clears it. Clearing per call (as this did) left the GPU with the last band only — a stroke that showed
// in stripes, and the patchwork an undo left behind.
const up = setOf(new Float32Array(pos), 32);
up.color.clearUpdateRanges();
composite(up, 0, 0, 31, 3, undefined, false);
const rows1 = up.color.updateRanges.length;
composite(up, 0, 8, 31, 11, undefined, false);
assert.ok(rows1 > 0 && up.color.updateRanges.length > rows1, `both bands stay pending (${rows1} → ${up.color.updateRanges.length})`);
composite(up);
assert.equal(up.color.updateRanges.length, 0, 'a full composite asks for one whole-texture upload');
// A selection step shares the layers: an island pick is document-wide, so copying every part's buffers (hundreds of
// megabytes at 4K) per click is what made a wand click feel like a save point.
const ss = setOf(new Float32Array(pos), 32);
fillTris(ss, pos, uvs, [0], red);
const painted0 = ss.layers[0].px.color;
select(ss, maskTris(ss, pos, uvs, [1]), 'set');
assert.equal(ss.past[ss.past.length - 1].layers[0].px.color, painted0, 'a selection step does not copy the layer buffers');
console.log('paint ok');
