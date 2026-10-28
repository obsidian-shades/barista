// node src/decal.check.ts: the Decal tool's pick through the real store — a click on a mark selects it, a click on bare
// surface (and the empty view) puts the gizmo away without touching the layer, and deleting the mark takes its layer
// with it (Delete used to clear the decal's mask and leave an empty decal row in the stack) — and the Mirror tool.
import assert from 'node:assert';
import { createServer } from 'vite';

(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', resolve: { preserveSymlinks: true } });
try {
  const store = await vite.ssrLoadModule('/src/store.ts') as typeof import('./store.ts');
  const quad = () => new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
  const part = { name: 'quad', soup: quad(), seams: [], marked: [], solved: [], visible: true, textured: true };
  const out = { positions: Array.from(quad()), uvs: uv, stretch: [0.01, 0.01], island: [0, 0], source: [0, 1] };
  store.useApp.setState({ parts: [part], result: { parts: [out], stats: {} } as never, uvs: [new Float32Array(uv)], textureResolution: 128, workspace: 'paint', activePart: 0 });
  store.setPaint({ tool: 'decal', decalMode: 'edit' });
  const s = store.texSet(0);
  // a mark as placeDecal makes one, centred on the quad and facing its front
  s.layers.push({
    id: 900, name: 'Mark', visible: true, opacity: 1, px: {},
    decal: { asset: 'mark', center: [0.5, 0.5, 0], normal: [0, 0, 1], up: [0, 1, 0], width: 0.5, rotation: 0, aspect: 1, tint: '#ffffff', roughness: 0.5, metallic: 0, channels: ['color', 'rough', 'metal'] },
  });
  s.active = 1;
  const m = { shift: false, alt: false, ctrl: false };
  const at = (x: number, y: number) => [x, y, 0] as [number, number, number];

  // a click on the mark picks it (and drags it from there)
  assert.equal(store.paintPress(0, 0, at(0.25, 0.25), [0.25, 0.25], m), true, 'the press starts a drag on the mark');
  assert.ok(store.activeDecal(), 'a click on the mark selects it');
  store.paintEnd();

  // a click on bare surface puts it away, and the layer is untouched
  assert.equal(store.paintPress(0, 0, at(0.95, 0.05), [0.95, 0.05], m), false, 'bare surface starts nothing');
  assert.equal(store.activeDecal(), null, 'a click on bare surface deselects the mark');
  assert.equal(store.useApp.getState().paint.decalSel, false, 'and the pick is off');
  assert.equal(store.texSet(0).layers.length, 2, 'the layer itself stays in the stack');

  // the Layers panel can pick the mark again
  store.pickPaintLayer(1);
  assert.ok(store.activeDecal(), 'choosing the decal layer picks the mark again');

  // A grip mark on a curved panel: the surface lies behind the projector's tangent plane (0.1 of this 1-unit model,
  // where the panel curves away) and its free outline reaches past the projector's rectangle — both exactly as the
  // grip decals do. The pick used to clip to the rectangle and to 0.4% of the model behind the plane, so most of such
  // a mark (sometimes all of it) could not be clicked, and every miss deselected it: "clicking the decals stopped
  // working". A mark is its footprint: anywhere inside its outline and the projector's depth picks it.
  store.texSet(0).layers.push({
    id: 901, name: 'Grip', visible: true, opacity: 1, px: {},
    decal: {
      asset: 'shape-stipple-panel', center: [0.5, 0.5, 0.1], normal: [0, 0, 1], up: [0, 1, 0], width: 0.6, rotation: 0,
      aspect: 0.6, tint: '#ffffff', roughness: 0.5, metallic: 0, channels: ['normal', 'height'],
      shape: { pattern: 'stipple', corner: 0.02, border: 0.006, depth: 0.003, cell: 0.01, amount: 0.002, outline: [[-1.4, -1], [0.2, -1], [1, 0.2], [-0.6, 1]] },
    },
  });
  store.texSet(0).active = 2;
  store.deselectDecal();
  assert.equal(store.activeDecal(), null, 'the grip mark starts unpicked');
  // behind the tangent plane by 0.1 and outside the projector's box (u < 0), yet inside the mark's outline
  assert.equal(store.paintPress(0, 0, at(0.14, 0.1), [0, 0], m), true, 'a click on a curved grip mark picks it');
  store.paintEnd();
  assert.ok(store.activeDecal(), 'the grip mark is selected from its own surface, not just its middle');
  store.deselectDecal();
  assert.equal(store.paintPress(0, 0, at(0.5, 0.5), [0, 0], m), true, 'and from the middle too');
  store.paintEnd();
  store.deselectDecal();
  // a click on bare surface beside it still puts the pick away
  assert.equal(store.paintPress(0, 0, at(0.95, 0.95), [0, 0], m), false, 'bare surface beside the mark starts nothing');
  assert.equal(store.activeDecal(), null, 'and the pick is off');
  store.texSet(0).layers.pop();
  store.texSet(0).active = 1;

  // Draw: a line armed puts the tool in Draw; clicks lay a polyline's corners and Enter finishes it open
  const { RELIEF_SHAPES } = await vite.ssrLoadModule('/src/decals.ts') as typeof import('./decals.ts');
  store.useApp.setState({ decals: RELIEF_SHAPES });
  store.pickDecal('shape-groove');
  assert.equal(store.useApp.getState().paint.decalMode, 'draw', 'arming a line puts the Decal tool in Draw');
  const before = store.texSet(0).layers.length;
  const click = (x: number, y: number) => { assert.equal(store.paintPress(0, 0, at(x, y), [x, y], m), true, 'a press in Draw'); store.paintEnd(); };
  click(0.3, 0.1); click(0.6, 0.2); click(0.9, 0.4);
  assert.equal(store.useApp.getState().drawLine?.length, 3, 'each click is a corner, shown while drawing');
  assert.equal(store.texSet(0).layers.length, before, 'nothing is made until it is finished');
  store.finishDraw();
  const line = store.texSet(0).layers.find((l) => l.decal?.shape?.pattern === 'groove');
  assert.equal(store.texSet(0).layers.length, before + 1, 'finishing adds one layer');
  assert.ok(line?.decal?.wrap && line.decal.shape!.outline!.length === 3 && !line.decal.shape!.closed, 'an open wrapped groove through the three corners');
  assert.equal(store.useApp.getState().drawLine, null, 'the preview goes');
  assert.equal(store.useApp.getState().paint.decalMode, 'draw', 'still drawing, for the next line');
  const ht = line!.px.height!;
  let cut = 0;
  for (let k = 0; k < ht.length; k += 2) if (ht[k + 1] > 0 && ht[k] < 120) cut++;
  assert.ok(cut > 0, 'the groove lowers the height under the line');
  // a click on the first corner closes it; Backspace takes a corner back, Esc drops the lot
  click(0.3, 0.05); click(0.7, 0.1); click(0.9, 0.5); click(0.3, 0.05);
  const loop = store.texSet(0).layers.filter((l) => l.decal?.shape?.pattern === 'groove').at(-1)!;
  assert.ok(loop !== line && loop.decal!.shape!.closed && loop.decal!.shape!.outline!.length === 3, 'clicking the first point closes the line');
  click(0.4, 0.1); click(0.8, 0.2);
  store.undoDrawPoint();
  assert.equal(store.useApp.getState().drawLine?.length, 1, 'Backspace takes back the last corner');
  store.cancelDraw();
  assert.equal(store.useApp.getState().drawLine, null, 'Esc drops it');
  // a pad drawn as an outline is always closed
  store.pickDecal('shape-pad');
  store.setDecalMode('draw');
  click(0.4, 0.1); click(0.9, 0.15); click(0.85, 0.5);
  store.finishDraw();
  const pad = store.texSet(0).layers.find((l) => l.decal?.shape?.pattern === 'pad');
  assert.ok(pad?.decal?.shape?.outline?.length === 3, 'a pad takes the drawn outline');
  for (const l of [line, loop, pad]) store.texSet(0).layers.splice(store.texSet(0).layers.indexOf(l!), 1);
  store.texSet(0).active = 1;
  store.setPaint({ tool: 'decal', decalMode: 'edit' });

  // deleting the mark removes it from the stack, and the gizmo goes with it
  store.deletePaintLayer();
  assert.equal(store.texSet(0).layers.length, 1, 'the decal layer is gone from the stack');
  assert.equal(store.activeDecal(), null, 'nothing left to edit on the model');
  store.undoPaint();
  assert.equal(store.texSet(0).layers.length, 2, 'undo brings the layer back');

  // The Mirror tool: pick a mark, hover — near the spot symmetric to it across the model's middle (here Z, the slab's
  // far face) the copy snaps there as its mirror image (right reversed, up kept) — and a click places a plain copy.
  const { decalFrame } = await vite.ssrLoadModule('/src/paint.ts') as typeof import('./paint.ts');
  const back = [0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 1]; // the slab's far face, at z = 1, facing -z
  store.useApp.setState({ result: { parts: [{ ...out, positions: [...out.positions, ...back], uvs: [...uv, ...uv], stretch: [0.01, 0.01, 0.01, 0.01], island: [0, 0, 1, 1], source: [0, 1, 2, 3] }], stats: {} } as never, uvs: [new Float32Array([...uv, ...uv])] });
  const mark = store.texSet(0).layers[1];
  mark.decal = { ...mark.decal!, center: [0.3, 0.6, 0], rotation: 30 };
  store.setPaint({ tool: 'mirror' });
  store.paintPress(0, 0, [0.3, 0.6, 0], [0, 0], m);
  assert.ok(store.activeDecal()?.decal === mark.decal, 'a Mirror click on a mark picks it');
  store.mirrorHover(0, 3, [0.9, 0.1, 1]);
  assert.equal(store.useApp.getState().mirrorAim?.snapped, false, 'away from the mirrored spot the copy follows the pointer');
  store.mirrorHover(0, 3, [0.35, 0.62, 1]);
  const aim = store.useApp.getState().mirrorAim!;
  const close = (x: number[], y: number[], msg: string) => assert.ok(x.every((v, k) => Math.abs(v - y[k]) < 1e-6), `${msg}: ${x} vs ${y}`);
  assert.ok(aim.snapped, 'near it, it snaps');
  close(aim.decal.center, [0.3, 0.6, 1], 'onto the spot across the middle on Z');
  const n0 = store.texSet(0).layers.length;
  store.paintPress(0, 3, [0.35, 0.62, 1], [0, 0], m);
  const copy = store.texSet(0).layers.find((l) => l.name === 'Mark mirror')!;
  assert.equal(store.texSet(0).layers.length, n0 + 1, 'a click places one copy');
  close(copy.decal!.normal, [0, 0, -1], 'facing the far way');
  const f0 = decalFrame(mark.decal!, 1), f1 = decalFrame(copy.decal!, 1);
  close([f1.uxr, f1.uyr, f1.uzr], [-f0.uxr, -f0.uyr, f0.uzr], 'its right is the reflected right, reversed');
  close([f1.vxr, f1.vyr, f1.vzr], [f0.vxr, f0.vyr, -f0.vzr], 'its up is the reflected up');
  assert.ok(copy.decal!.flipH && copy.decal!.rotation === -30, 'flipped, turned the other way: a mirror image');
  assert.equal(store.useApp.getState().paint.tool, 'decal', 'and the Decal tool takes over with the copy selected');
  assert.ok(store.activeDecal()?.decal === copy.decal, 'the copy is the one picked');
  // nothing is linked: editing the copy leaves the original where it was
  store.updateDecal({ rotation: 10 });
  assert.equal(store.texSet(0).layers.find((l) => l.id === 900)!.decal!.rotation, 30, 'the original does not follow');
  store.undoPaint(); store.undoPaint();
  assert.equal(store.texSet(0).layers.length, n0, 'undo takes the copy back out');
  console.log('decal ok');
} finally {
  await vite.close();
}
