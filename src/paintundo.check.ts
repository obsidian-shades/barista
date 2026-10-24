// node src/paintundo.check.ts: Van Gogh's undo through the real store (the queue that composites in bands is what
// this pins down). An undo used to be cancelled by the next stroke's composite, leaving part of the box it had not
// reached showing the stroke that was just taken back: a texture with half an undone stroke on it. Each case here
// starts the next action immediately, before the banded pass can finish.
import assert from 'node:assert';
import { createServer } from 'vite';

(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', resolve: { preserveSymlinks: true } });
try {
  const store = await vite.ssrLoadModule('/src/store.ts') as typeof import('./store.ts');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const N = 512, BASE = '188,188,188';
  const quad = () => new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
  const part = { name: 'quad', soup: quad(), seams: [], marked: [], solved: [], visible: true, textured: true };
  const out = { positions: Array.from(quad()), uvs: uv, stretch: [0.01, 0.01], island: [0, 0], source: [0, 1] };
  store.useApp.setState({ parts: [part], result: { parts: [out], stats: {} } as never, uvs: [new Float32Array(uv)], textureResolution: N, workspace: 'paint', activePart: 0 });
  store.setPaint({ tool: 'brush', color: '#ff0000', size: 10, flow: 1, hardness: 1, on: { color: true, rough: false, metal: false, normal: false, height: false } });
  const s = store.texSet(0);
  const texel = (u: number, v: number) => Array.from((s.color.image.data as Uint8ClampedArray).subarray((Math.floor(v * N) * N + Math.floor(u * N)) * 4, (Math.floor(v * N) * N + Math.floor(u * N)) * 4 + 3)).join();
  const m = { shift: false, alt: false, ctrl: false };
  const stroke = (u: number, v: number) => { store.paintPress(0, 0, [u, v, 0], [u, v], m); store.paintDrag(0, [u + 0.02, v, 0], [u + 0.02, v]); store.paintEnd(); };

  // undo, then a new stroke before the undo's bands finish
  stroke(0.3, 0.3); await sleep(60);
  store.undoPaint();
  stroke(0.8, 0.2);
  await sleep(600);
  assert.equal(texel(0.3, 0.3), BASE, 'the undone stroke is gone even though a stroke started right after Ctrl+Z');
  assert.equal(texel(0.81, 0.2), '255,0,0', 'and the new stroke is there');

  // the second of two strokes undone, the first kept, a new stroke right away
  stroke(0.2, 0.75); await sleep(60);
  stroke(0.72, 0.68); await sleep(60);
  store.undoPaint();
  stroke(0.8, 0.85);
  await sleep(600);
  assert.equal(texel(0.21, 0.75), '255,0,0', 'the stroke below the undone one stays');
  assert.equal(texel(0.72, 0.68), BASE, 'the undone one is gone');
  assert.equal(texel(0.81, 0.85), '255,0,0', 'the newest stroke is intact');

  // redo puts the step back and a second redo has nothing left
  store.undoPaint();
  await sleep(400);
  assert.equal(texel(0.81, 0.85), BASE, 'undone');
  store.redoPaint();
  await sleep(400);
  assert.equal(texel(0.81, 0.85), '255,0,0', 'redone with Ctrl+Shift+Z');
  store.redoPaint();
  assert.equal(texel(0.81, 0.85), '255,0,0', 'nothing left to redo');

  // two undos back to back: the redo'd stroke and the one under it both go, none half-composited
  store.undoPaint();
  store.undoPaint();
  await sleep(600);
  assert.equal(texel(0.81, 0.85), BASE, 'back-to-back undos take the newest stroke');
  assert.equal(texel(0.21, 0.75), BASE, 'and the one below it');
  console.log('paint undo ok');
} finally {
  await vite.close();
}
