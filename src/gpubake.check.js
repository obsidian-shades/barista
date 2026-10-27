import * as P from './paint.ts';
import * as G from './gpucomp.ts';
import * as B from './gpubake.ts';
import * as T3 from 'three';
import { bake } from './bake.ts';
// Open /src/gpubake.check.html on the dev server (a real GPU: headless Edge on the RTX, not the software-GL pane): every
// gpubake.ts kernel and the GPU bake against their CPU loops on a subdivided box, within a level (bytes) or 0.03 (AO).
// The title ends "ok" or "FAIL"; the body holds the numbers. window.__gpucheck(size) / __bakecheck(size) run one.
window.__gpucheck = async (S = 512, R) => {
  const r = R ?? (window.__r ??= new T3.WebGLRenderer());
  const D = 40, pos = [], uvs = [];
  const faces = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]];
  faces.forEach(([a, b, c, sgn], f) => {
    const su = (f % 3) / 3, sv = Math.floor(f / 3) / 2;
    for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) for (const [i, j] of [[x, y], [x + 1, y], [x + 1, y + 1], [x, y], [x + 1, y + 1], [x, y + 1]]) {
      const p = [0, 0, 0]; p[a] = i / D; p[b] = (sgn > 0 ? j : D - j) / D; p[c] = sgn > 0 ? 1 : 0;
      // a dent so normals vary
      p[c] += (sgn > 0 ? 1 : -1) * 0.05 * Math.sin((i / D) * 3) * Math.sin((j / D) * 3);
      pos.push(...p); uvs.push(su + (i / D) * 0.31 + 0.01, sv + (j / D) * 0.47 + 0.01);
    }
  });
  const map = (w, s) => ({ width: w, height: w, data: new Uint8ClampedArray(w * w * 4).map((_, i) => ((i * 2654435761 + s) >>> 0) % 256) });
  const maps = { basecolor: map(256, 1), normal: map(256, 2), roughness: map(128, 3), metallic: map(256, 4), height: map(256, 5) };
  const surf = P.surfaceOf(S, pos, uvs), n2 = S * S;
  const baked = { ao: new Float32Array(n2).map((_, i) => 0.5 + 0.5 * Math.sin(i * 0.001)), convex: new Float32Array(n2).map((_, i) => (i % 53) / 2000), concave: new Float32Array(n2).map((_, i) => (i % 41) / 2000), pos: surf.pos, has: surf.has, span: 1 };
  const fill = (projection, x = {}) => ({ asset: 'x', projection, tiling: 2, tiles: 4, rotation: 20, offset: [0.1, 0.3], normalStrength: 0.8, tint: '#ffcc88', channels: ['color', 'rough', 'metal', 'normal', 'height'], ...x });
  const gen = (kind) => ({ kind, amount: 0.5, soft: 0.2, width: 0.01, grunge: 0.6, scale: 0.05, color: '#ff8800', rough: 0.4, metal: 1, clip: null });
  const cases = {
    'fill uv': (s, l) => { l.fill = fill('uv'); P.bakeFill(s, l, maps, pos, uvs, 1); },
    'fill uv solid': (s, l) => { l.fill = fill('uv', { asset: 'solid', roughness: 0.2, metallic: 1 }); P.bakeFill(s, l, {}, pos, uvs, 1); },
    'fill tri': (s, l) => { l.fill = fill('triplanar'); P.bakeFill(s, l, maps, pos, uvs, 1); },
    'gen edge': (s, l) => { l.gen = gen('edge'); P.generate(s, l); },
    'gen dirt': (s, l) => { l.gen = gen('dirt'); P.generate(s, l); },
    'gen ao': (s, l) => { l.gen = { ...gen('ao'), grunge: 0 }; P.generate(s, l); },
    'bevel round': (s, l) => { l.bevel = { radius: 0.06, profile: 'round', angle: 30, concave: true }; P.bakeBevel(s, l, pos, uvs); },
    'bevel chamfer': (s, l) => { l.bevel = { radius: 0.04, profile: 'chamfer', angle: 30, concave: false }; P.bakeBevel(s, l, pos, uvs); },
  };
  const go = (fn) => {
    const s = P.setOf(new Float32Array(pos), S); s.channels = ['color', 'rough', 'metal', 'normal', 'height']; P.setBaked(s, baked);
    const l = { ...P.newLayer(2) }; s.layers.push(l); s.active = 1;
    const t = performance.now(); fn(s, l); return [l.px, Math.round(performance.now() - t)];
  };
  const out = {}; let reads = 0; const orig = r.readRenderTargetPixels.bind(r); r.readRenderTargetPixels = (...a) => { reads++; return orig(...a); };
  for (const [name, fn] of Object.entries(cases)) {
    reads = 0; G.setCompRenderer(null); const [c, tc] = go(fn); const rc = reads;
    G.setCompRenderer(r); if (!B.gpuBakeReady(S)) throw new Error('GPU bake not ready'); go(fn); reads = 0; const [g, tg] = go(fn); const rg = reads;
    let mx = 0, bad = 0, px = 0;
    for (const ch of Object.keys(c)) for (let i = 0; i < c[ch].length; i++) { const d = Math.abs(c[ch][i] - g[ch][i]); if (d > mx) mx = d; if (d > 1) bad++; px++; }
    out[name] = { cpu: tc, gpu: tg, maxDiff: mx, over1: bad, of: px, rc, rg };
  }
  r.readRenderTargetPixels = orig;
  return out;
};

window.__bakecheck = async (S = 2048) => {
  const D = 40, pos = [], uvs = [];
  const faces = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]];
  faces.forEach(([a, b, c, sgn], f) => {
    const su = (f % 3) / 3, sv = Math.floor(f / 3) / 2;
    for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) for (const [i, j] of [[x, y], [x + 1, y], [x + 1, y + 1], [x, y], [x + 1, y + 1], [x, y + 1]]) {
      const p = [0, 0, 0]; p[a] = i / D; p[b] = (sgn > 0 ? j : D - j) / D; p[c] = sgn > 0 ? 1 : 0;
      p[c] += (sgn > 0 ? 1 : -1) * 0.05 * Math.sin((i / D) * 3) * Math.sin((j / D) * 3);
      pos.push(...p); uvs.push(su + (i / D) * 0.31 + 0.01, sv + (j / D) * 0.47 + 0.01);
    }
  });
  const slab = []; for (const [x, y] of [[-0.3, -0.3], [1.3, -0.3], [1.3, 1.3], [-0.3, -0.3], [1.3, 1.3], [-0.3, 1.3]]) slab.push(x, y, 1.15);
  const wall = []; for (const [x, z] of [[1.1, -0.2], [1.1, 1.2], [1.1, 1.2], [1.1, -0.2], [1.1, 1.2], [1.1, -0.2]]) wall.push(x, 0.5, z);
  const casters = [pos, slab, [1.1, -0.3, -0.3, 1.1, 1.3, -0.3, 1.1, 1.3, 1.3, 1.1, -0.3, -0.3, 1.1, 1.3, 1.3, 1.1, -0.3, 1.3]];
  const surf = P.surfaceOf(S, pos, uvs);
  const r = window.__r ??= new T3.WebGLRenderer();
  G.setCompRenderer(null); let t = performance.now(); const c = await bake(S, pos, casters, surf); const tc = performance.now() - t;
  G.setCompRenderer(r); t = performance.now(); const g = await bake(S, pos, casters, surf); const tg = performance.now() - t;
  const cmp = (A, B) => { let mx = 0, bad = 0, inf = 0, n = 0; for (let i = 0; i < A.length; i++) { if (!surf.has[i]) continue; n++; if ((A[i] === Infinity) !== (B[i] === Infinity)) { inf++; continue; } if (A[i] === Infinity) continue; const d = Math.abs(A[i] - B[i]); mx = Math.max(mx, d); if (d > 0.01) bad++; } return { mx, bad, inf, n }; };
  let mean = 0, cnt = 0; for (let i = 0; i < c.ao.length; i++) if (surf.has[i]) { mean += c.ao[i]; cnt++; }
  return { cpu: Math.round(tc), gpu: Math.round(tg), aoMean: mean / cnt, ao: cmp(c.ao, g.ao), convex: cmp(c.convex, g.convex), concave: cmp(c.concave, g.concave) };
};

(async () => {
  const k = await window.__gpucheck(512), b = await window.__bakecheck(512);
  const bad = Object.entries(k).filter(([, v]) => v.over1 > 0 || v.rg === 0).map(([n]) => n);
  if (b.ao.mx > 0.03 || b.convex.mx > 1e-4 || b.concave.mx > 1e-4 || b.ao.inf || b.convex.inf) bad.push('bake');
  document.body.textContent = JSON.stringify({ kernels: k, bake: b }, null, 1);
  document.title = `gpubake ${bad.length ? 'FAIL ' + bad.join(', ') : 'ok'}`;
})();
