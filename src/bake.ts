// Van Gogh's Bake Mesh Maps (Substance's): per texel of a part's texture, ambient occlusion and the distance to the
// nearest sharp convex and concave edge, which the generators (edge wear, dirt) turn into masks.
// AO the GPU way: the whole model's depth seen from ~100 directions round it (orthographic, like a shadow map each), then
// per texel the share of its sky (cosine-weighted, over its own hemisphere) from which nothing stands in front of it.
import * as THREE from 'three';
import { topoOf } from './topo';

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
      // Fibonacci sphere: evenly spread directions
      const y = 1 - (2 * (k + 0.5)) / DIRS, r = Math.sqrt(1 - y * y), a = k * Math.PI * (3 - Math.sqrt(5));
      const d = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
      cam.position.copy(c).addScaledVector(d, 1.5 * R);
      cam.up.set(Math.abs(d.y) > 0.9 ? 1 : 0, Math.abs(d.y) > 0.9 ? 0 : 1, 0);
      cam.lookAt(c);
      cam.updateMatrixWorld(); cam.updateProjectionMatrix();
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

/** Bake part `positions` (its texels `surf`) with every part in `all` casting occlusion. */
export async function bake(n: number, positions: number[], all: ArrayLike<number>[], surf: Surface, progress?: (f: number) => void): Promise<Baked> {
  const ao = new Float32Array(n * n), wsum = new Float32Array(n * n), { pos, nrm, has } = surf, model = modelOf(all), R = model.R;
  // lifted off its own surface by a depth texel and a half, so it doesn't shadow itself
  const off = (3 * R) / RES;
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
  const span = 2 * R;
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
  const grids = [new Map<string, number[]>(), new Map<string, number[]>()], cell = (x: number, y: number, z: number) => `${Math.floor(x / reach)},${Math.floor(y / reach)},${Math.floor(z / reach)}`;
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
    const seg = [ax, ay, az, bx, by, bz, s], seen = new Set<string>();
    for (let k = 0; k <= steps; k++) {
      const f = k / steps, key = cell(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f);
      if (seen.has(key)) continue;
      seen.add(key);
      const list = g.get(key);
      if (list) list.push(...seg); else g.set(key, seg.slice());
    }
    if ((e & 2047) === 2047) await new Promise((ok) => setTimeout(ok, 0));
  }
  const out: Float32Array[] = [];
  for (const g of grids) {
    const arr = new Float32Array(n * n).fill(Infinity);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (!surf.has[i]) continue;
        const px = surf.pos[i * 3], py = surf.pos[i * 3 + 1], pz = surf.pos[i * 3 + 2], cx = Math.floor(px / reach), cy = Math.floor(py / reach), cz = Math.floor(pz / reach);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const list = g.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (let k = 0; k < list.length; k += 7) {
            const ex = list[k + 3] - list[k], ey = list[k + 4] - list[k + 1], ez = list[k + 5] - list[k + 2];
            const qx = px - list[k], qy = py - list[k + 1], qz = pz - list[k + 2], ee = ex * ex + ey * ey + ez * ez;
            const t = ee > 1e-20 ? Math.max(0, Math.min(1, (qx * ex + qy * ey + qz * ez) / ee)) : 0;
            const dx = qx - ex * t, dy = qy - ey * t, dz = qz - ez * t;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / list[k + 6];
            if (d < best) best = d;
          }
        }
        arr[i] = best <= reach ? best : Infinity;
      }
      if ((y & 15) === 15) await new Promise((ok) => setTimeout(ok, 0));
    }
    out.push(arr);
  }
  return out;
}
