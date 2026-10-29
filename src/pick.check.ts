// node src/pick.check.ts: Van Gogh's Eyedropper through the real store. Material mode lifts the clicked part's material
// layers (fills, solids, generators, bevels) onto the cursor, and the next click applies them to the part, island or face
// under it — decals and hand paint stay behind, one Ctrl+Z puts an apply back. Color mode still samples the surface.
import assert from 'node:assert';
import { createServer } from 'vite';
import type { Channel, Decal, Fill, PaintLayer } from './paint.ts';

(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', resolve: { preserveSymlinks: true } });
try {
  const store = await vite.ssrLoadModule('/src/store.ts') as typeof import('./store.ts');
  const paint = await vite.ssrLoadModule('/src/paint.ts') as typeof import('./paint.ts');
  const N = 64;
  const quad = (x: number) => new Float32Array([x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 0, 0, x + 1, 1, 0, x, 1, 0]);
  const uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
  const part = (name: string, x: number) => ({ name, soup: quad(x), seams: [], marked: [], solved: [], visible: true, textured: true });
  const out = (x: number) => ({ positions: Array.from(quad(x)), uvs: uv, stretch: [0.01, 0.01], island: [0, 0], source: [0, 1] });
  store.useApp.setState({
    parts: [part('source', 0), part('dest', 2)], result: { parts: [out(0), out(2)], stats: {} } as never,
    uvs: [new Float32Array(uv), new Float32Array(uv)], textureResolution: N, workspace: 'paint', activePart: 1,
    paint: { ...store.useApp.getState().paint, tool: 'picker', pickMode: 'material', by: 'part' },
  });
  const src = store.texSet(0), dst = store.texSet(1);
  const solid = (tint: string): Fill => ({ asset: paint.SOLID, projection: 'triplanar', tiling: 1, tiles: 4, rotation: 0, offset: [0, 0], normalStrength: 1, tint, roughness: 0.2, metallic: 0.9, channels: ['color', 'rough', 'metal'] });
  const mark = (name: string): PaintLayer => ({
    id: 0, name, visible: true, opacity: 1, px: {},
    decal: { asset: 'mark', center: [0.5, 0.5, 0], normal: [0, 0, 1], up: [0, 1, 0], width: 0.4, rotation: 0, aspect: 1, tint: '#ffffff', roughness: 0.5, metallic: 0, channels: ['color', 'rough', 'metal'] } as Decal,
  });
  const painted = (id: number, name: string, rgb: [number, number, number]): PaintLayer => {
    const px = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) { px[i * 4] = rgb[0]; px[i * 4 + 1] = rgb[1]; px[i * 4 + 2] = rgb[2]; px[i * 4 + 3] = 255; }
    return { id, name, visible: true, opacity: 1, px: { color: px } };
  };
  // the source: a red solid, a bevel, a generator and a decal, plus hand paint — only the first three are materials
  src.channels = ['color', 'rough', 'metal', 'normal', 'height'] as Channel[];
  src.layers.push(
    painted(901, 'Source paint', [0, 0, 255]),
    { id: 902, name: 'Red', visible: true, opacity: 1, px: {}, fill: solid('#ff0000') },
    { id: 903, name: 'Bevel', visible: true, opacity: 1, px: {}, bevel: { radius: 0.02, profile: 'round', angle: 30, concave: false } },
    { id: 908, name: 'Edge Wear', visible: true, opacity: 1, px: {}, gen: { kind: 'edge', amount: 0.3, soft: 0.2, width: 0.02, grunge: 0, scale: 0.05, color: '#ffffff', rough: 0.4, metal: 1, clip: null } },
    mark('Source mark'),
  );
  // the destination: a green solid of its own, its own decal and hand paint; already baked, so an applied generator
  // needs no bake (a bake is AO from 96 views, not something a unit check should wait on)
  dst.layers.push(
    painted(905, 'Dest paint', [0, 255, 0]),
    { id: 906, name: 'Green', visible: true, opacity: 1, px: {}, fill: solid('#00ff00') },
    mark('Dest mark'),
  );
  dst.bake = { pos: new Float32Array(N * N * 3), nrm: new Float32Array(N * N * 3), has: new Uint8Array(N * N).fill(1), ao: new Float32Array(N * N).fill(1), convex: new Float32Array(N * N), concave: new Float32Array(N * N), span: 1 };
  dst.active = 2;
  const m = { shift: false, alt: false, ctrl: false };
  const tick = () => new Promise((r) => setTimeout(r, 20));

  // Material mode: the first click lifts the materials onto the cursor, and nothing lands yet
  assert.equal(store.paintPress(0, 0, [0.5, 0.5, 0], [0.5, 0.5], m), false, 'the Eyedropper starts no drag');
  const grab = store.useApp.getState().paint.grab;
  assert.ok(grab, 'the click picks up the source materials');
  assert.equal(grab.count, 3, 'the fill, the bevel and the generator (not the decal or the hand paint)');
  assert.equal(grab.tint, '#ff0000', 'the cursor chip takes the solid fill’s colour');
  assert.equal(store.useApp.getState().activePart, 1, 'picking up does not change the active part');
  assert.equal(dst.layers.filter((l) => l.fill).length, 1, 'nothing lands until the next click');

  // the next click applies them to the whole part under it
  store.paintPress(1, 0, [2.5, 0.5, 0], [0.5, 0.5], m);
  await tick();
  assert.equal(store.useApp.getState().activePart, 1, 'the part clicked is the one worked on');
  assert.ok(store.useApp.getState().paint.grab, 'the stack stays on the cursor for the next target');
  assert.equal(dst.layers.filter((l) => l.fill).length, 1, 'the destination has the source material, not its own');
  assert.equal(dst.layers.find((l) => l.fill)?.fill?.tint, '#ff0000', 'with the source colour');
  assert.equal(dst.layers.filter((l) => l.decal).length, 1, 'the destination keeps its own decal and gets none of the source’s');
  assert.equal(dst.layers.find((l) => l.decal)?.name, 'Dest mark', 'its own mark is the one that stays');
  assert.ok(dst.layers.some((l) => l.name === 'Dest paint'), 'hand paint stays');
  assert.ok(!dst.layers.some((l) => l.name === 'Source paint'), 'the source’s hand paint is not copied');
  assert.ok(dst.layers.some((l) => l.bevel), 'the bevel layer comes too');
  const gen = dst.layers.find((l) => l.gen);
  assert.ok(gen, 'the generator layer comes too');
  assert.ok(gen.px.color?.some((v, i) => i % 4 === 3 && v > 0), 'and is generated on the destination');
  assert.equal(src.layers.filter((l) => l.fill).length, 1, 'the source is untouched');

  // one Ctrl+Z puts the destination's own materials back
  store.undoPaint();
  assert.equal(dst.layers.filter((l) => l.fill).length, 1, 'undo takes the applied materials back out');
  assert.equal(dst.layers.find((l) => l.fill)?.fill?.tint, '#00ff00', 'its own green is back');
  assert.equal(dst.layers.find((l) => l.fill)?.id, 906, 'the original layer itself, not a rebuilt one');
  assert.deepEqual(dst.channels, ['color'], 'undo restores the channel set too (the material had turned PBR on)');

  // an island adds the held material masked there, over the part's own materials
  store.setPaint({ by: 'island' });
  store.paintPress(1, 0, [2.5, 0.5, 0], [0.5, 0.5], m);
  await tick();
  const greens = dst.layers.filter((l) => l.fill);
  assert.equal(greens.length, 2, 'the island material sits over the part’s own');
  const island = greens.find((l) => l.fill?.tint === '#ff0000');
  assert.ok(island?.mask?.some((v) => v > 0), 'masked to the island clicked');
  assert.ok(dst.layers.some((l) => l.fill?.tint === '#00ff00'), 'the rest of the part keeps its material');
  assert.ok(dst.layers.find((l) => l.gen)?.gen?.clip?.some((v) => v > 0), 'a generator is clipped to the island too');
  store.undoPaint();
  assert.equal(dst.layers.filter((l) => l.fill).length, 1, 'undo takes the island back off');

  // the same held stack on a second face of that part widens the first apply's layers, it does not stack a copy
  store.setPaint({ by: 'face' });
  await store.applyGrab(1, 0);
  const n1 = dst.layers.length, first = dst.layers.find((l) => l.fill?.tint === '#ff0000')!.mask!.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);
  await store.applyGrab(1, 1);
  assert.equal(dst.layers.length, n1, 'a second face adds no layers');
  const reds = dst.layers.filter((l) => l.fill?.tint === '#ff0000');
  assert.equal(reds.length, 1, 'one layer for the material');
  assert.ok(reds[0].mask!.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) >= first, 'its mask takes the second face in');
  assert.equal(dst.layers.filter((l) => l.gen).length, 1, 'one generator too, its clip widened');
  store.undoPaint();
  assert.equal(dst.layers.length, n1, 'undo takes the second face back off the same layers');
  store.undoPaint();
  assert.equal(dst.layers.filter((l) => l.fill).length, 1, 'and the first apply off');

  // the part the materials came from has nowhere to put them whole: it says so
  store.setPaint({ by: 'part' });
  await store.applyGrab(0, 0);
  assert.match(store.useApp.getState().notice ?? '', /came from/, 'a whole-part self apply is refused');
  assert.ok(store.useApp.getState().paint.grab, 'and the stack is still held');

  // Esc (dropMaterials) lets go
  store.dropMaterials();
  assert.equal(store.useApp.getState().paint.grab, null, 'Esc drops the held stack');

  // Color mode (the color wheel's eyedropper) samples the surface instead, and a mode switch drops the grab
  store.paintPress(0, 0, [0.5, 0.5, 0], [0.5, 0.5], m);
  assert.ok(store.useApp.getState().paint.grab, 'picked up again for the color-mode switch');
  store.setPaint({ pickMode: 'color' });
  assert.equal(store.useApp.getState().paint.grab, null, 'Color mode lets the held stack go');
  const before = dst.layers.length;
  store.paintPress(0, 0, [0.5, 0.5, 0], [0.5, 0.5], m);
  await tick();
  assert.equal(store.useApp.getState().activePart, 0, 'a color pick makes the clicked part active');
  assert.equal(store.useApp.getState().paint.color, paint.sample(src, 0.5, 0.5).color, 'and takes its color');
  assert.equal(dst.layers.length, before, 'Color mode copies no layers');
  // Select by Material: the faces showing the clicked face's material, and only those
  store.setPaint({ tool: 'picker', pickMode: 'material', by: 'face' });
  store.paintPress(0, 0, [0.5, 0.5, 0], [0.5, 0.5], m); // pick the red stack up again (Color mode let it go)
  await store.applyGrab(1, 0);
  const redTris = dst.layers.find((l) => l.fill?.tint === '#ff0000')!;
  store.setPaint({ by: 'material' });
  store.paintHoverAt(1, 0);
  const sameRed = store.useApp.getState().paintHover!.tris;
  store.paintHoverAt(-1);
  assert.ok(sameRed.includes(0), 'the clicked face is in its own material');
  const uvOf = (t: number) => Math.floor(((uv[t * 6 + 1] + uv[t * 6 + 3] + uv[t * 6 + 5]) / 3) * N) * N + Math.floor(((uv[t * 6] + uv[t * 6 + 2] + uv[t * 6 + 4]) / 3) * N);
  for (const t of [0, 1]) assert.equal(sameRed.includes(t), redTris.mask![uvOf(t)] > 127, `face ${t} goes with the red only if it shows red`);
  store.undoPaint();
  store.setPaint({ by: 'part' });

  // the Eraser on a generator takes wear off where it goes: its mask, not its pixels (the next regenerate would undo those)
  const wear: PaintLayer = { id: 920, name: 'Wear', visible: true, opacity: 1, px: {}, gen: { kind: 'edge', amount: 0.3, soft: 0.2, width: 0.02, grunge: 0, scale: 0.05, color: '#ffffff', rough: 0.4, metal: 1, clip: null } };
  dst.layers.push(wear);
  dst.active = dst.layers.length - 1;
  store.useApp.setState({ activePart: 1 });
  store.setPaint({ tool: 'erase', size: 20 });
  store.paintPress(1, 0, [2.5, 0.5, 0], [0.5, 0.5], m);
  store.paintEnd();
  const erased = dst.layers[dst.active];
  assert.ok(erased.mask?.some((v) => v < 255), 'the Eraser writes the generator’s mask');
  assert.ok(!erased.px.color || erased.px.color.every((v, i) => i % 4 !== 3 || v === 0), 'and leaves its generated pixels alone');
  console.log('pick ok');
} finally {
  await vite.close();
}
