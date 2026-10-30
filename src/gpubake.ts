// Per-texel bakes on the GPU: the loops `paint.ts` runs over a texture set's texels (fills, generators, the bevel), as
// shader passes over bands of rows, read back into the layer buffers, so undo, save and export are unchanged. The
// CPU keeps what is cheap and order-bound: rasterising triangles in UV (`raster`: its seam / crease coverage, which
// triangle a texel takes), recorded per texel as float inputs the shader reads; the sampling and the maths run here.
// Node (the checks), a context that fails and a set larger than the GPU's textures keep the CPU loops, which stay the
// reference: every kernel is within a level of them (float32, rounding).
import * as THREE from 'three';
import { compRenderer } from './gpucomp.ts';
import type { MapPixels } from './materials.ts';

/** Rows per band: n wide, 1024² texels at most (16 MB a float input), as gpucomp's bands. */
const TILE = 1024;
/** Width of the float row textures (`rows`): per-triangle frames, segments, grid slots. */
const RW = 2048;

const VERT = `in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
/** Every kernel's head: its band inputs, which output it is drawing, where the band starts, and shared helpers. */
const HEAD = `precision highp float; precision highp int;
uniform highp sampler2D uIn0; uniform highp sampler2D uIn1; uniform int uOut; uniform int uY0; uniform int uN;
layout(location = 0) out highp vec4 outColor;
vec4 in0() { return texelFetch(uIn0, ivec2(gl_FragCoord.xy), 0); }
vec4 in1() { return texelFetch(uIn1, ivec2(gl_FragCoord.xy), 0); }
/** Item i of a float row texture (\`rows\`). */
vec4 row(highp sampler2D t, int i) { int w = textureSize(t, 0).x; return texelFetch(t, ivec2(i % w, i / w), 0); }
/** paint.ts sampleMap: bilinear with repeat, row 0 at the top, 0..255. */
vec4 tap(highp sampler2D m, vec2 uv) {
  ivec2 sz = textureSize(m, 0);
  float x = fract(uv.x) * float(sz.x) - 0.5, y = (1.0 - fract(uv.y)) * float(sz.y) - 0.5;
  float fx0 = floor(x), fy0 = floor(y), fx = x - fx0, fy = y - fy0;
  int x0 = int(fx0), y0 = int(fy0), x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 += sz.x; if (x1 >= sz.x) x1 -= sz.x; if (y0 < 0) y0 += sz.y; if (y1 >= sz.y) y1 -= sz.y;
  vec4 a = texelFetch(m, ivec2(x0, y0), 0), b = texelFetch(m, ivec2(x1, y0), 0), c = texelFetch(m, ivec2(x0, y1), 0), e = texelFetch(m, ivec2(x1, y1), 0);
  return ((a * (1.0 - fx) + b * fx) * (1.0 - fy) + (c * (1.0 - fx) + e * fx) * fy) * 255.0;
}
/** paint.ts hash3: an integer hash of a lattice point, 0..1. */
uint hashu(ivec3 c) {
  uvec3 u = uvec3(c);
  uint h = (u.x * 0x8da6b343u) ^ (u.y * 0xd8163841u) ^ (u.z * 0xcb1ab31fu);
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return h;
}
float hash3(vec3 c) { return float(hashu(ivec3(c))) / 4294967296.0; }
`;

interface Kit {
  r: THREE.WebGLRenderer; n: number; th: number; ins: THREE.DataTexture[]; out: THREE.WebGLRenderTarget; buf: Uint8Array;
  /** The float output (a kernel with `float`), made when one first runs. */
  outF: THREE.WebGLRenderTarget | null; bufF: Float32Array | null;
  scene: THREE.Scene; mesh: THREE.Mesh; cam: THREE.Camera; mats: Map<string, THREE.RawShaderMaterial>;
}
let kit: Kit | null = null, failedOn: THREE.WebGLRenderer | null = null;
const empty = new THREE.DataTexture(new Uint8Array(4), 1, 1);
empty.needsUpdate = true;
// A few materials' maps stay uploaded (the last fills, as materials.ts keeps their pixels); the rest are freed.
const maps = new Map<MapPixels, THREE.DataTexture>();

function drop() {
  if (kit) { for (const t of kit.ins) t.dispose(); kit.out.dispose(); kit.outF?.dispose(); for (const m of kit.mats.values()) m.dispose(); }
  for (const t of maps.values()) t.dispose();
  maps.clear();
  kit = null;
}
function kitFor(r: THREE.WebGLRenderer, n: number): Kit {
  if (kit && kit.r === r && kit.n === n) return kit;
  const mats = kit?.r === r ? kit.mats : new Map<string, THREE.RawShaderMaterial>();
  if (kit?.r !== r) drop(); else { for (const t of kit.ins) t.dispose(); kit.out.dispose(); kit.outF?.dispose(); }
  const th = Math.max(1, Math.min(n, Math.floor((TILE * TILE) / n)));
  const ins = [0, 1].map(() => {
    const t = new THREE.DataTexture(new Float32Array(n * th * 4), n, th, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false;
    return t;
  });
  const out = new THREE.WebGLRenderTarget(n, th, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(g); mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  kit = { r, n, th, ins, out, buf: new Uint8Array(n * th * 4), outF: null, bufF: null, scene, mesh, cam: new THREE.Camera(), mats };
  return kit;
}

/** A material's map as a texture (kept for the next fills of it). */
export function mapTexture(m: MapPixels) {
  let t = maps.get(m);
  if (t) { maps.delete(m); maps.set(m, t); return t; }
  t = new THREE.DataTexture(new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.length), m.width, m.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true;
  maps.set(m, t);
  for (const [k, old] of maps) { if (maps.size <= 12) break; old.dispose(); maps.delete(k); }
  return t;
}
/** Floats as a texture of RGBA items, RW a row (the kernel reads item i with \`row\`). Freed after the run. */
export function rows(data: Float32Array): THREE.DataTexture {
  const h = Math.max(1, Math.ceil(data.length / 4 / RW));
  const all = data.length === RW * h * 4 ? data : new Float32Array(RW * h * 4);
  if (all !== data) all.set(data);
  const t = new THREE.DataTexture(all, RW, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

/** Can an n² bake run here? */
export function gpuBakeReady(n: number) {
  const r = compRenderer();
  return !!r && failedOn !== r && !r.getContext().isContextLost() && n <= r.capabilities.maxTextureSize;
}

export interface Kernel {
  /** The shader body after HEAD: sets outColor (RGBA 0..1, read back as bytes) for output uOut. */
  frag: string;
  uniforms: Record<string, unknown>;
  /** Band inputs it reads (in0 / in1): float RGBA per texel, filled by \`band\`. */
  inputs: 0 | 1 | 2;
  /** Textures made for this run (\`rows\`): freed after it. */
  temp?: THREE.Texture[];
  /** Read back as floats (put gets a Float32Array), for values bytes would round: distances, sums. */
  float?: boolean;
}
/** Run kernel `k` over an n² set: per band of rows, `band(y0, h, ins)` fills the float inputs (n × h texels each) and
 *  `put(out, y0, h, rgba, ins)` takes each output's bytes. False: nothing usable was done (no GPU, or it failed), and
 *  the caller bakes on the CPU. */
export function gpuBake(n: number, k: Kernel, outs: number[], band: (y0: number, h: number, ins: Float32Array[]) => void,
  put: (out: number, y0: number, h: number, rgba: Uint8Array & Float32Array, ins: Float32Array[]) => void): boolean {
  const r = compRenderer();
  if (!r || !gpuBakeReady(n)) { for (const t of k.temp ?? []) t.dispose(); return false; }
  const kt = kitFor(r, n), prev = r.getRenderTarget();
  if (k.float && !kt.outF) {
    if (!r.extensions.has('EXT_color_buffer_float')) { for (const t of k.temp ?? []) t.dispose(); return false; }
    kt.outF = new THREE.WebGLRenderTarget(n, kt.th, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    kt.bufF = new Float32Array(n * kt.th * 4);
  }
  const target = k.float ? kt.outF! : kt.out, back = (k.float ? kt.bufF! : kt.buf) as Uint8Array & Float32Array;
  let mat = kt.mats.get(k.frag);
  if (!mat) {
    const uniforms: Record<string, THREE.IUniform> = { uIn0: { value: empty }, uIn1: { value: empty }, uOut: { value: 0 }, uY0: { value: 0 }, uN: { value: n } };
    for (const key of Object.keys(k.uniforms)) uniforms[key] = { value: null };
    mat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: HEAD + k.frag, depthTest: false, depthWrite: false, blending: THREE.NoBlending, uniforms });
    kt.mats.set(k.frag, mat);
  }
  const u = mat.uniforms;
  try {
    for (const [key, v] of Object.entries(k.uniforms)) u[key].value = v ?? empty;
    u.uN.value = n;
    for (let i = 0; i < k.inputs; i++) u[`uIn${i}`].value = kt.ins[i];
    kt.mesh.material = mat;
    const ins = kt.ins.slice(0, k.inputs).map((t) => t.image.data as Float32Array);
    for (let y0 = 0; y0 < n; y0 += kt.th) {
      const h = Math.min(kt.th, n - y0), views = ins.map((a) => a.subarray(0, n * h * 4));
      for (const a of views) a.fill(0);
      band(y0, h, views);
      for (let i = 0; i < k.inputs; i++) kt.ins[i].needsUpdate = true;
      u.uY0.value = y0;
      for (const o of outs) {
        u.uOut.value = o;
        r.setRenderTarget(target); r.render(kt.scene, kt.cam);
        r.readRenderTargetPixels(target, 0, 0, n, h, back);
        put(o, y0, h, back, views);
      }
    }
    return true;
  } catch (e) {
    console.warn('GPU bake failed, using the CPU from now on', e);
    failedOn = r;
    return false;
  } finally {
    for (const key of Object.keys(u)) if (u[key].value instanceof THREE.Texture) u[key].value = empty;
    for (const t of k.temp ?? []) t.dispose();
    r.setRenderTarget(prev);
  }
}

/** An integer hash of lattice point (x, y, z), 32 bits: exact on the CPU, in a shader (HEAD's `hashu`) and in the
 *  engine (`layers::hashu`); the old sin(…)·43758 hash needed f64, which a shader doesn't have. */
export function hashu(x: number, y: number, z: number) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return h >>> 0;
}
/** A grid of cells "x,y,z" → item ids as an open-addressed table a kernel searches (CELLS' `slotOf`): per slot two
 *  items (cell, used / start, count) and the ids in one list. Uniforms uSlot, uList, uSlots, uProbe. */
export function cellTable(grid: Map<string, number[]>) {
  const cells = [...grid], size = 1 << Math.ceil(Math.log2(Math.max(2, cells.length * 2)));
  const slot = new Float32Array(size * 8), list = new Float32Array(Math.max(1, cells.reduce((k, [, ids]) => k + ids.length, 0)) * 4);
  let probe = 0, at = 0;
  for (const [key, ids] of cells) {
    const [x, y, z] = key.split(',').map(Number);
    let k = 0, s = hashu(x, y, z) & (size - 1);
    while (slot[s * 8 + 3]) { s = (s + 1) & (size - 1); k++; }
    probe = Math.max(probe, k);
    slot.set([x, y, z, 1, at, ids.length, 0, 0], s * 8);
    for (const id of ids) list[at++ * 4] = id;
  }
  const uSlot = rows(slot), uList = rows(list);
  return { uniforms: { uSlot, uList, uSlots: size, uProbe: probe }, temp: [uSlot, uList] };
}

// ---- the kernels (paint.ts and bake.ts give them their inputs and stay their CPU reference) ----

/** Fill outputs in the kernels' numbering. */
export const FILL_OUT = { color: 0, rough: 1, metal: 2, height: 3, normal: 4 } as const;
/** A fill's material and settings as uniforms (both projections). */
export const FILL_UNIFORMS = `uniform highp sampler2D uColor; uniform highp sampler2D uNormal; uniform highp sampler2D uRough; uniform highp sampler2D uMetal; uniform highp sampler2D uHeight;
uniform ivec4 uHas; uniform int uHasHeight; uniform float uTiles; uniform float uCo; uniform float uSi; uniform vec2 uOffset; uniform float uStrength;
uniform vec3 uTint; uniform vec3 uPlain; uniform float uRoughV; uniform float uMetalV; uniform float uRoughBase;
`;

/** bakeFill, tri-planar. in0: world point, triangle + 1 (0: no triangle). uFrame: 16 floats a triangle (`triFrame`). */
export const TRIPLANAR = FILL_UNIFORMS + `uniform highp sampler2D uFrame;
vec2 uvs[3]; vec3 w; float ws;
vec4 blend(highp sampler2D m) {
  vec4 s = vec4(0.0);
  if (w.x > 0.0) s += tap(m, uvs[0]) * w.x;
  if (w.y > 0.0) s += tap(m, uvs[1]) * w.y;
  if (w.z > 0.0) s += tap(m, uvs[2]) * w.z;
  return s / ws;
}
float blendV(float v) { return (v * w.x + v * w.y + v * w.z) / ws; }
void main() {
  vec4 at = in0();
  if (at.w < 0.5) { outColor = vec4(0.0); return; }
  int t = int(at.w + 0.5) - 1;
  vec4 f0 = row(uFrame, t * 4), f1 = row(uFrame, t * 4 + 1), f2 = row(uFrame, t * 4 + 2), f3 = row(uFrame, t * 4 + 3);
  vec3 n = f0.xyz, tg = vec3(f0.w, f1.xy), bt = vec3(f1.zw, f2.x);
  w = f2.yzw; ws = f3.x;
  float rx = at.x * uCo + at.z * uSi, rz = -at.x * uSi + at.z * uCo;
  uvs[0] = vec2(rz, at.y) * uTiles + uOffset; uvs[1] = vec2(rx, rz) * uTiles + uOffset; uvs[2] = vec2(rx, at.y) * uTiles + uOffset;
  vec3 v;
  if (uOut == 0) v = min(vec3(255.0), (uHas.x == 1 ? blend(uColor).rgb : uPlain) * uTint / 255.0);
  else if (uOut == 1) v = vec3(uRoughV >= 0.0 ? blendV(uRoughV) : uHas.z == 1 ? blend(uRough).r : blendV(uRoughBase));
  else if (uOut == 2) v = vec3(uMetalV >= 0.0 ? blendV(uMetalV) : uHas.w == 1 ? blend(uMetal).r : 0.0);
  else if (uOut == 3) v = vec3(uHasHeight == 1 ? blend(uHeight).r : 128.0);
  else {
    if (uHas.y == 0 || w.x + w.y + w.z == 0.0) { outColor = vec4(128.0, 128.0, 255.0, 255.0) / 255.0; return; }
    // the face's normal plus each plane's detail along its tangent / bitangent (UDN, as paint.ts): a flat map keeps the face
    vec3 s = sign(n) + vec3(equal(n, vec3(0.0))), wn = n;
    for (int p = 0; p < 3; p++) {
      float k = (p == 0 ? w.x : p == 1 ? w.y : w.z) / ws;
      if (k <= 0.0) continue;
      vec4 q = tap(uNormal, uvs[p]);
      float dx = (q.r / 127.5 - 1.0) * uStrength, dy = (q.g / 127.5 - 1.0) * uStrength;
      if (p == 0) wn += vec3(0.0, -s.x * dy, dx) * k;
      else if (p == 1) wn += vec3(dx, 0.0, -s.y * dy) * k;
      else wn += vec3(dx, s.z * dy, 0.0) * k;
    }
    float l = length(wn); wn = l > 0.0 ? wn / l : wn;
    vec3 d = vec3(dot(wn, tg), dot(wn, bt), dot(wn, n));
    float dl = length(d); d = dl > 0.0 ? d / dl : d;
    v = (d * 0.5 + 0.5) * 255.0;
  }
  outColor = vec4(v / 255.0, 1.0);
}`;

/** bakeFill, UV projection: every texel, the material repeated over the texture square. No inputs. */
export const UVFILL = FILL_UNIFORMS + `void main() {
  float x = gl_FragCoord.x - 0.5, y = float(uY0) + gl_FragCoord.y - 0.5, n = float(uN);
  float u0 = ((x + 0.5) / n - 0.5) * uTiles, v0 = ((y + 0.5) / n - 0.5) * uTiles;
  vec2 uv = vec2(u0 * uCo - v0 * uSi + 0.5 + uOffset.x, u0 * uSi + v0 * uCo + 0.5 + uOffset.y);
  vec3 v;
  if (uOut == 0) v = min(vec3(255.0), (uHas.x == 1 ? tap(uColor, uv).rgb : uPlain) * uTint / 255.0);
  else if (uOut == 1) v = vec3(uRoughV >= 0.0 ? uRoughV : uHas.z == 1 ? tap(uRough, uv).r : uRoughBase);
  else if (uOut == 2) v = vec3(uMetalV >= 0.0 ? uMetalV : uHas.w == 1 ? tap(uMetal, uv).r : 0.0);
  else if (uOut == 3) v = vec3(uHasHeight == 1 ? tap(uHeight, uv).r : 128.0);
  else if (uHas.y == 1) {
    vec4 q = tap(uNormal, uv);
    float dx = (q.r / 127.5 - 1.0) * uStrength, dy = (q.g / 127.5 - 1.0) * uStrength, dz = sqrt(max(0.0, 1.0 - dx * dx - dy * dy));
    v = (vec3(dx, dy, dz) * 0.5 + 0.5) * 255.0;
  } else v = vec3(128.0, 128.0, 255.0);
  outColor = vec4(v / 255.0, 1.0);
}`;

/** generate's coverage (paint.ts genAt). in0: AO, convex and concave edge distance, on the surface; in1: point, clip. */
export const GENERATOR = `uniform int uKind; uniform float uWS; uniform float uK; uniform float uGrunge; uniform float uAmount; uniform float uSoft;
float noise(vec3 p) {
  float sum = 0.0, amp = 0.5, f = 1.0;
  for (int o = 0; o < 3; o++) {
    vec3 X = p * f, i = floor(X), fr = X - i, s = fr * fr * (3.0 - 2.0 * fr);
    float a = mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), s.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), s.x), s.y);
    float b = mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), s.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), s.x), s.y);
    sum += amp * mix(a, b, s.z);
    amp /= 2.0; f *= 2.0;
  }
  return sum / 0.875;
}
float band(float d) { return max(0.0, 1.0 - d / uWS); }
void main() {
  vec4 a = in0(), b = in1();
  if (a.w < 0.5) { outColor = vec4(0.0); return; }
  float v = uKind == 0 ? band(a.y) : uKind == 1 ? max(1.0 - a.x, 0.8 * band(a.z)) : 1.0 - a.x;
  float nz = uGrunge != 0.0 ? noise(b.xyz * uK) : 0.5;
  float broken = v * (1.0 + uGrunge * (2.0 * nz - 1.0) * 1.5);
  outColor = vec4(clamp((broken - (1.0 - uAmount)) / max(0.02, uSoft) + 0.5, 0.0, 1.0) * b.w, 0.0, 0.0, 1.0);
}`;

/** bakeBevel's normal (paint.ts bevelNormal). in0 / in1: up to two triangles over the texel (point, triangle + 1), the
 *  first that leans wins. uFrame: per triangle face normal, UV tangent, bitangent; uSeg: 3 items an edge; uSlot: the
 *  edge grid as an open-addressed table, 2 items a cell (cell, used / start, count); uList: edge ids. */
const CELLS = `uniform highp sampler2D uSlot; uniform highp sampler2D uList; uniform int uSlots; uniform int uProbe;
/** cellTable's slot of cell c, or -1. */
int slotOf(ivec3 c) {
  uint h = hashu(c);
  for (int k = 0; k <= uProbe; k++) {
    int s = int((h + uint(k)) & uint(uSlots - 1));
    vec4 a = row(uSlot, s * 2);
    if (a.w < 0.5) return -1;
    if (ivec3(a.xyz) == c) return s;
  }
  return -1;
}
`;
export const BEVEL = CELLS + `uniform highp sampler2D uFrame; uniform highp sampler2D uSeg;
uniform float uR; uniform int uChamfer;
bool lean(vec3 p, vec3 f, out vec3 w) {
  ivec3 c = ivec3(floor(p / uR));
  // per direction the strongest lean (paint.ts bevelNormal): an edge listed in several cells is the same lean again
  vec3 lu[4]; float lw[4]; int nl = 0;
  for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) for (int dz = -1; dz <= 1; dz++) {
    int s = slotOf(c + ivec3(dx, dy, dz));
    if (s < 0) continue;
    vec4 sc = row(uSlot, s * 2 + 1);
    int start = int(sc.x), cnt = int(sc.y);
    for (int j = 0; j < cnt; j++) {
      int id = int(row(uList, start + j).r);
      vec4 s0 = row(uSeg, id * 3), s1 = row(uSeg, id * 3 + 1), s2 = row(uSeg, id * 3 + 2);
      vec3 a = s0.xyz, e = vec3(s0.w, s1.xy) - a, na = vec3(s1.zw, s2.x), nb = s2.yzw, q = p - a;
      float ee = dot(e, e), u = ee > 1e-20 ? clamp(dot(q, e) / ee, 0.0, 1.0) : 0.0;
      float d = length(q - e * u);
      if (d >= uR) continue;
      float sa = dot(f, na), sb = dot(f, nb), half_ = acos(clamp(dot(na, nb), -1.0, 1.0)) / 2.0;
      if (max(sa, sb) <= cos(half_)) continue; // a face of another edge
      vec3 far = sa >= sb ? nb : na, near = sa >= sb ? na : nb; float so = sa >= sb ? sb : sa;
      if (abs(dot(q, near)) > uR * 0.25) continue; // off the near face's plane
      vec3 dir = far - f * so;
      float dl = length(dir);
      if (dl < 1e-6) continue;
      float phi = uChamfer == 1 ? half_ : half_ - asin(d / uR * sin(half_));
      vec3 ud = dir / dl; float wt = tan(phi);
      int k = 0;
      while (k < nl && dot(ud, lu[k]) <= 0.70710678) k++;
      if (k == nl) { if (nl < 4) { lu[nl] = ud; lw[nl] = wt; nl++; } }
      else if (wt > lw[k]) { lu[k] = ud; lw[k] = wt; }
    }
  }
  vec3 t = vec3(0.0);
  for (int j = 0; j < 4; j++) if (j < nl) t += lu[j] * lw[j];
  w = normalize(f + t);
  return nl > 0;
}
void main() {
  vec4 cand[2];
  cand[0] = in0(); cand[1] = in1();
  for (int k = 0; k < 2; k++) {
    if (cand[k].w < 0.5) break;
    int t = int(cand[k].w + 0.5) - 1;
    vec3 f = row(uFrame, t * 3).xyz, tg = row(uFrame, t * 3 + 1).xyz, bt = row(uFrame, t * 3 + 2).xyz, w;
    if (lean(cand[k].xyz, f, w)) { outColor = vec4(vec3(dot(w, tg), dot(w, bt), dot(w, f)) * 0.5 + 0.5, 1.0); return; }
  }
  outColor = vec4(0.0);
}`;

/** bake.ts edgeDistances: per texel the nearest edge segment over its strength, -1 past uReach. in0: point, on the
 *  surface. uSeg: 2 items an edge (a; b with the strength in w); the grid of edges as cellTable. */
export const EDGES = CELLS + `uniform highp sampler2D uSeg; uniform float uReach;
void main() {
  vec4 a = in0();
  if (a.w < 0.5) { outColor = vec4(-1.0); return; }
  vec3 p = a.xyz;
  ivec3 c = ivec3(floor(p / uReach));
  float best = 1e30;
  for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) for (int dz = -1; dz <= 1; dz++) {
    int s = slotOf(c + ivec3(dx, dy, dz));
    if (s < 0) continue;
    vec4 sc = row(uSlot, s * 2 + 1);
    int start = int(sc.x), cnt = int(sc.y);
    for (int j = 0; j < cnt; j++) {
      int id = int(row(uList, start + j).r);
      vec4 s0 = row(uSeg, id * 2), s1 = row(uSeg, id * 2 + 1);
      vec3 e = s1.xyz - s0.xyz, q = p - s0.xyz;
      float ee = dot(e, e), u = ee > 1e-20 ? clamp(dot(q, e) / ee, 0.0, 1.0) : 0.0;
      best = min(best, length(q - e * u) / s1.w);
    }
  }
  outColor = vec4(best <= uReach ? best : -1.0, 0.0, 0.0, 1.0);
}`;

/** bake.ts's AO over one chunk of directions. in0: the texel's point lifted off the surface, on the surface; in1: its
 *  normal. uDepth: the chunk's depth maps as an atlas (uTiles across, uRes each, 1 - depth in red); per direction uDirs
 *  one item and uMats four (its view-projection's columns). Out: the seen weight and the whole weight (float). */
export const AO = `uniform highp sampler2D uDepth; uniform highp sampler2D uDirs; uniform highp sampler2D uMats;
uniform int uBase; uniform int uCount; uniform int uTiles; uniform int uRes; uniform float uEps;
void main() {
  vec4 a = in0();
  if (a.w < 0.5) { outColor = vec4(0.0); return; }
  vec3 nrm = in1().xyz;
  float ao = 0.0, ws = 0.0, res = float(uRes);
  for (int k = 0; k < uCount; k++) {
    int g = uBase + k;
    float w = dot(nrm, row(uDirs, g).xyz);
    if (w <= 0.0) continue;
    ws += w;
    vec4 c = mat4(row(uMats, g * 4), row(uMats, g * 4 + 1), row(uMats, g * 4 + 2), row(uMats, g * 4 + 3)) * vec4(a.xyz, 1.0);
    int sx = int(floor((c.x + 1.0) / 2.0 * res)), sy = int(floor((c.y + 1.0) / 2.0 * res));
    bool seen = true;
    if (sx >= 0 && sy >= 0 && sx < uRes && sy < uRes) {
      float d = texelFetch(uDepth, ivec2((k % uTiles) * uRes + sx, (k / uTiles) * uRes + sy), 0).r;
      seen = (c.z + 1.0) / 2.0 <= 1.0 - d + uEps;
    }
    if (seen) ao += w;
  }
  outColor = vec4(ao, ws, 0.0, 1.0);
}`;
