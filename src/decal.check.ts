// node src/decal.check.ts: the Decal tool's pick through the real store — a click on a mark selects it, a click on bare
// surface (and the empty view) puts the gizmo away without touching the layer, and deleting the mark takes its layer
// with it (Delete used to clear the decal's mask and leave an empty decal row in the stack).
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

  // deleting the mark removes it from the stack, and the gizmo goes with it
  store.deletePaintLayer();
  assert.equal(store.texSet(0).layers.length, 1, 'the decal layer is gone from the stack');
  assert.equal(store.activeDecal(), null, 'nothing left to edit on the model');
  store.undoPaint();
  assert.equal(store.texSet(0).layers.length, 2, 'undo brings the layer back');
  console.log('decal ok');
} finally {
  await vite.close();
}
