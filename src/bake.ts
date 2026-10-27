// Van Gogh's Bake Mesh Maps (Substance's): per texel of a part's texture, ambient occlusion and the distance to the
// nearest sharp convex and concave edge, which the generators (edge wear, dirt) turn into masks.
// AO the GPU way: the whole model's depth seen from ~100 directions round it (orthographic, like a shadow map each), then
// per texel the share of its sky (cosine-weighted, over its own hemisphere) from which nothing stands in front of it.
// With the viewport's renderer the per-texel tests run there too (gpubake.ts AO, EDGES); the CPU loops are the
// fallback and the reference.
import * as THREE from 'three';
import { topoOf } from './topo';
import { compRenderer } from './gpucomp';
import { AO, EDGES, cellTable, gpuBake, gpuBakeReady, rows } from './gpubake';

export interface Surface { pos: Float32Array; nrm: Float32Array; has: Uint8Array }
/** Per texel: `ao` 0 (shut in) .. 1 (open sky); `convex` / `concave`: distance to the nearest such edge (world units,
 *  over the edge's strength, Infinity past `reach`); plus the texel's point on the surface, for the generators' noise. */
export interface Baked extends Surface { ao: Float32Array; convex: Float32Array; concave: Float32Array; span: number }

const DIRS = 96, RES = 512;
/** One offscreen renderer for every bake: a new one per bake leaked a WebGL context each time (dispose() doesn't free
 *  it), and past the browser's 16 the oldest, the 3D view's, was lost for good: the model stopped drawing. */
let gl: THREE.WebGLRenderer | null = null;

/** The whole model as one geometry, and its bounding sphere. */
function modelOf(all: ArrayLike<number>[]) {
  const geo = new THREE.BufferGeometry(), n = all.reduce((a, p) => a + p.length, 0), xyz = new Float32Array(n);
  let o = 0;
  for (const p of all) { xyz.set(p, o); o += p.length; }
  geo.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
  geo.computeBoundingSphere();
  return { geo, c: geo.boundingSphere!.center, R: Math.max(geo.boundingSphere!.radius, 1e-6) };
}

/** View `k` of DIRS (a Fibonacci sphere: evenly spread directions) as the orthographic camera that sees the model from it. */
function viewOf(k: number, c: THREE.Vector3, R: number, cam: THREE.OrthographicCamera) {
  const y = 1 - (2 * (k + 0.5)) / DIRS, r = Math.sqrt(1 - y * y), a = k * Math.PI * (3 - Math.sqrt(5));
  const d = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  cam.position.copy(c).addScaledVector(d, 1.5 * R);
  cam.up.set(Math.abs(d.y) > 0.9 ? 1 : 0, Math.abs(d.y) > 0.9 ? 0 : 1, 0);
  cam.lookAt(c);
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  return d;
}
/** The model's depth from `DIRS` directions; `each(dir, seen)` sees every one (seen: is this point in view from there?). */
async function eachView({ geo, c, R }: ReturnType<typeof modelOf>, each: (d: THREE.Vector3, seen: (x: number, y: number, z: number) => boolean) => void, progress?: (f: number) => void) {  const scene = new THREE.Scene(), mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(geo, mat));
  if (!gl || gl.getContext().isContextLost()) gl = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: false });
  const ren = gl;
  const rt = new THREE.WebGLRenderTarget(RES, RES, { type: THREE.FloatType }), buf = new Float32Array(RES * RES * 4);
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.01 * R, 3 * R), m = new THREE.Matrix4();
  // a sample is in front if within two depth texels (plus its own slope) of the nearest surface seen there
  const eps = (4 * R) / RES / (3 * R);
  try {
    for (let k = 0; k < DIRS; k++) {
      const d = viewOf(k, c, R, cam);
      ren.setRenderTarget(rt); ren.setClearColor(0x000000, 1); ren.clear(); ren.render(scene, cam); ren.setRenderTarget(null);
      ren.readRenderTargetPixels(rt, 0, 0, RES, RES, buf);
      const e = m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
      each(d, (x, y, z) => {
        const sx = Math.floor(((e[0] * x + e[4] * y + e[8] * z + e[12] + 1) / 2) * RES), sy = Math.floor(((e[1] * x + e[5] * y + e[9] * z + e[13] + 1) / 2) * RES);
        if (sx < 0 || sy < 0 || sx >= RES || sy >= RES) return true;
        // the depth material writes 1 − depth, so the cleared black reads as far
        return ((e[2] * x + e[6] * y + e[10] * z + e[14]) + 1) / 2 <= 1 - buf[(sy * RES + sx) * 4] + eps;
      });
      if ((k & 1) === 1) { progress?.((k + 1) / DIRS); await new Promise((ok) => setTimeout(ok)); }
    }
  } finally { rt.dispose(); mat.dispose(); geo.dispose(); }
}

/** AO on the viewport's renderer: CHUNK views' depth maps at a time into one float atlas, then one kernel pass over the
 *  texels tests all of them (gpubake.ts AO). Null: no GPU for it, bake on the CPU. */
const CHUNK = 32, ACROSS = 8;
async function aoOnGpu(n: number, { geo, c, R }: ReturnType<typeof modelOf>, surf: Surface, off: number, progress?: (f: number) => void) {
  const r = compRenderer();
  if (!r || !gpuBakeReady(n) || !r.extensions.has('EXT_color_buffer_float')) return null;
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.01 * R, 3 * R), m = new THREE.Matrix4();
  const dirs = new Float32Array(DIRS * 4), mats = new Float32Array(DIRS * 16);
  for (let k = 0; k < DIRS; k++) {
    const d = viewOf(k, c, R, cam);
    dirs.set([d.x, d.y, d.z, 0], k * 4);
    mats.set(m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements, k * 16);
  }
  const scene = new THREE.Scene(), mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(geo, mat));
  const atlas = new THREE.WebGLRenderTarget(ACROSS * RES, (CHUNK / ACROSS) * RES, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  const uDirs = rows(dirs), uMats = rows(mats);
  const ao = new Float32Array(n * n), wsum = new Float32Array(n * n), { pos, nrm, has } = surf;
  const prev = r.getRenderTarget(), clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha(), auto = r.autoClear;
  let ok = true;
  try {
    for (let base = 0; base < DIRS && ok; base += CHUNK) {
      const count = Math.min(CHUNK, DIRS - base);
      // the viewport's renderer keeps drawing between chunks: its state is put back before each yield
      r.autoClear = false; r.setClearColor(0x000000, 1);
      atlas.viewport.set(0, 0, atlas.width, atlas.height);
      r.setRenderTarget(atlas); r.clear();
      for (let k = 0; k < count; k++) {
        viewOf(base + k, c, R, cam);
        atlas.viewport.set((k % ACROSS) * RES, Math.floor(k / ACROSS) * RES, RES, RES);
        r.setRenderTarget(atlas); r.render(scene, cam);
      }
      r.setRenderTarget(prev); r.setClearColor(clear, alpha); r.autoClear = auto;
      ok = gpuBake(n, {
        frag: AO, inputs: 2, float: true,
        uniforms: { uDepth: atlas.texture, uDirs, uMats, uBase: base, uCount: count, uTiles: ACROSS, uRes: RES, uEps: (4 * R) / RES / (3 * R) },
      }, [0], (y0, h, [p, q]) => {
        for (let j = 0, i = y0 * n; j < n * h; j++, i++) {
          if (!has[i]) continue;
          p[j * 4] = pos[i * 3] + nrm[i * 3] * off; p[j * 4 + 1] = pos[i * 3 + 1] + nrm[i * 3 + 1] * off; p[j * 4 + 2] = pos[i * 3 + 2] + nrm[i * 3 + 2] * off; p[j * 4 + 3] = 1;
          q[j * 4] = nrm[i * 3]; q[j * 4 + 1] = nrm[i * 3 + 1]; q[j * 4 + 2] = nrm[i * 3 + 2];
        }
      }, (_o, y0, h, v) => { for (let j = 0, i = y0 * n; j < n * h; j++, i++) { ao[i] += v[j * 4]; wsum[i] += v[j * 4 + 1]; } });
      progress?.((base + count) / DIRS);
      await new Promise((go) => setTimeout(go));
    }
  } finally {
    r.setRenderTarget(prev); r.setClearColor(clear, alpha); r.autoClear = auto;
    atlas.dispose(); mat.dispose(); uDirs.dispose(); uMats.dispose();
  }
  if (!ok) return null;
  for (let i = 0; i < n * n; i++) ao[i] = wsum[i] ? ao[i] / wsum[i] : 1;
  return ao;
}

/** Bake part `positions` (its texels `surf`) with every part in `all` casting occlusion. */
export async function bake(n: number, positions: number[], all: ArrayLike<number>[], surf: Surface, progress?: (f: number) => void): Promise<Baked> {
  const { pos, nrm, has } = surf, model = modelOf(all), R = model.R;
  // lifted off its own surface by a depth texel and a half, so it doesn't shadow itself
  const off = (3 * R) / RES;
  const span = 2 * R;
  const gpu = await aoOnGpu(n, model, surf, off, progress && ((f) => progress(f * 0.9)));
  if (gpu) {
    const [convex, concave] = await edgeDistances(n, positions, surf, 0.05 * span);
    progress?.(1);
    model.geo.dispose();
    return { ...surf, ao: gpu, convex, concave, span };
  }
  const ao = new Float32Array(n * n), wsum = new Float32Array(n * n);
  await eachView(model, (d, seen) => {
    for (let i = 0; i < n * n; i++) {
      if (!has[i]) continue;
      const w = nrm[i * 3] * d.x + nrm[i * 3 + 1] * d.y + nrm[i * 3 + 2] * d.z;
      if (w <= 0) continue;
      wsum[i] += w;
      if (seen(pos[i * 3] + nrm[i * 3] * off, pos[i * 3 + 1] + nrm[i * 3 + 1] * off, pos[i * 3 + 2] + nrm[i * 3 + 2] * off)) ao[i] += w;
    }
  }, progress && ((f) => progress(f * 0.9)));
  for (let i = 0; i < n * n; i++) {
    ao[i] = wsum[i] ? ao[i] / wsum[i] : 1;
    if ((i & 262143) === 262143) await new Promise((ok) => setTimeout(ok, 0));
  }
  const [convex, concave] = await edgeDistances(n, positions, surf, 0.05 * span);
  progress?.(1);
  return { ...surf, ao, convex, concave, span };
}

/** Per texel, the distance to the nearest sharp (> 20°) convex and concave edge of the part, over the edge's strength
 *  (90° counts full), up to `reach`. Each edge is one segment in the reach-sized cells it crosses. */
async function edgeDistances(n: number, positions: number[], surf: Surface, reach: number) {
  const t = topoOf(positions), tris = positions.length / 9, fn = new Float64Array(tris * 3), fc = new Float64Array(tris * 3);
  for (let f = 0; f < tris; f++) {
    const o = f * 9, p = positions;
    const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2], vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    fn.set([nx / l, ny / l, nz / l], f * 3);
    fc.set([(p[o] + p[o + 3] + p[o + 6]) / 3, (p[o + 1] + p[o + 4] + p[o + 7]) / 3, (p[o + 2] + p[o + 5] + p[o + 8]) / 3], f * 3);
  }
  // Each cell holds whole segments `[x0,y0,z0, x1,y1,z1, strength]`, in every cell a segment passes through: a
  // query is the distance to the nearest segment, not to points sampled along it. Points every reach/8 made a
  // band narrower than that spacing — Edge Wear's `width` is often under it — break into beads: dots, at any
  // texture resolution, because the gaps are in world space.
  const grids = [new Map<string, number[]>(), new Map<string, number[]>()], segs: number[][] = [[], []], cell = (x: number, y: number, z: number) => `${Math.floor(x / reach)},${Math.floor(y / reach)},${Math.floor(z / reach)}`;
  for (let e = 0; e < t.edgeTris.length; e++) {
    const [a, b] = t.edgeTris[e];
    if (b === undefined) continue;
    const dot = fn[a * 3] * fn[b * 3] + fn[a * 3 + 1] * fn[b * 3 + 1] + fn[a * 3 + 2] * fn[b * 3 + 2], angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (angle < (20 * Math.PI) / 180) continue;
    // convex when b's centre lies behind a's plane
    const v0 = t.ends[e * 2], v1 = t.ends[e * 2 + 1], P = t.pos;
    const side = (fc[b * 3] - P[v0 * 3]) * fn[a * 3] + (fc[b * 3 + 1] - P[v0 * 3 + 1]) * fn[a * 3 + 1] + (fc[b * 3 + 2] - P[v0 * 3 + 2]) * fn[a * 3 + 2];
    const g = grids[side < 0 ? 0 : 1], s = Math.min(1, angle / (Math.PI / 2));
    const ax = P[v0 * 3], ay = P[v0 * 3 + 1], az = P[v0 * 3 + 2], bx = P[v1 * 3], by = P[v1 * 3 + 1], bz = P[v1 * 3 + 2];
    const len = Math.hypot(bx - ax, by - ay, bz - az), steps = Math.max(1, Math.ceil(len / (reach / 8)));
    const kind = side < 0 ? 0 : 1, id = segs[kind].length / 8, seen = new Set<string>();
    segs[kind].push(ax, ay, az, 0, bx, by, bz, s);
    for (let k = 0; k <= steps; k++) {
      const f = k / steps, key = cell(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f);
      if (seen.has(key)) continue;
      seen.add(key);
      const list = g.get(key);
      if (list) list.push(id); else g.set(key, [id]);
    }
    if ((e & 2047) === 2047) await new Promise((ok) => setTimeout(ok, 0));
  }
  const out: Float32Array[] = [];
  for (const [kind, g] of grids.entries()) {
    const arr = new Float32Array(n * n).fill(Infinity), S = segs[kind];
    out.push(arr);
    if (!S.length) continue;
    if (gpuBakeReady(n)) {
      const cells = cellTable(g), uSeg = rows(new Float32Array(S));
      const ok = gpuBake(n, { frag: EDGES, inputs: 1, float: true, uniforms: { uSeg, ...cells.uniforms, uReach: reach }, temp: [uSeg, ...cells.temp] }, [0], (y0, h, [p]) => {
        for (let j = 0, i = y0 * n; j < n * h; j++, i++) if (surf.has[i]) { p[j * 4] = surf.pos[i * 3]; p[j * 4 + 1] = surf.pos[i * 3 + 1]; p[j * 4 + 2] = surf.pos[i * 3 + 2]; p[j * 4 + 3] = 1; }
      }, (_o, y0, h, v) => { for (let j = 0, i = y0 * n; j < n * h; j++, i++) if (v[j * 4] >= 0) arr[i] = v[j * 4]; });
      if (ok) continue;
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (!surf.has[i]) continue;
        const px = surf.pos[i * 3], py = surf.pos[i * 3 + 1], pz = surf.pos[i * 3 + 2], cx = Math.floor(px / reach), cy = Math.floor(py / reach), cz = Math.floor(pz / reach);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const list = g.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const id of list) {
            const k = id * 8, ex = S[k + 4] - S[k], ey = S[k + 5] - S[k + 1], ez = S[k + 6] - S[k + 2];
            const qx = px - S[k], qy = py - S[k + 1], qz = pz - S[k + 2], ee = ex * ex + ey * ey + ez * ez;
            const t = ee > 1e-20 ? Math.max(0, Math.min(1, (qx * ex + qy * ey + qz * ez) / ee)) : 0;
            const dx = qx - ex * t, dy = qy - ey * t, dz = qz - ez * t;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / S[k + 7];
            if (d < best) best = d;
          }
        }
        arr[i] = best <= reach ? best : Infinity;
      }
      if ((y & 15) === 15) await new Promise((ok) => setTimeout(ok, 0));
    }
  }
  return out;
}
