// The layer stack flattened on the GPU: the composite `paint.ts` runs on the CPU, as shader passes. The layers stay
// CPU arrays (undo, save and the engine's export read them); per pass one layer's buffer is uploaded into a scratch
// texture (only the region being composited), blended over the running result in a float render target, and the
// result is read back into the set's composite arrays, so every reader of those (the views, padding, the eyedropper)
// is unchanged. A full 2K recomposite of four PBR layers was 1.2 s on the CPU; undo, opacity, visibility and blend
// changes all pay it. Node (the checks) and a GPU without float targets keep the CPU path.
import * as THREE from 'three';

/** One channel's stack: how its passes blend (`kind`), its unpainted value (0..1), and its visible layers bottom first. */
export interface Group {
  ch: string;
  kind: 0 | 1 | 2 | 3; // 0 colour (RGB, alpha = coverage), 1 a scalar (value, alpha), 2 normals (whiteout), 3 height (adds)
  base: number[];
  layers: { px: Uint8Array | Uint8ClampedArray; stride: 1 | 2 | 4; op: number; mask?: Uint8Array | Uint8ClampedArray | null; mode: number }[];
}
/** Blend modes as the shader numbers them. */
export const MODES: Record<string, number> = { normal: 0, multiply: 1, screen: 2, overlay: 3, add: 4 };

let gl: THREE.WebGLRenderer | null = null, failed = false;
/** The viewport's renderer. A new one (the 3D view remounted) can't use targets and textures made on the old
 *  context: those are dropped and made again, or every composite read back another context's leftovers. */
export function setCompRenderer(r: THREE.WebGLRenderer) {
  if (r !== gl) dispose();
  gl = r; failed = false;
}

/** Texels a pass covers: full-width bands (n wide, TILE² / n rows), so a whole-width box reads straight back into the
 *  set's own arrays, and the float targets stay at 1024² worth (16 MB) whatever the size. */
const TILE = 1024;

const VERT = `in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = `precision highp float; precision highp int;
uniform highp sampler2D uPrev; uniform highp sampler2D uPx; uniform highp sampler2D uMask;
uniform int uPass; uniform int uKind; uniform int uMode; uniform int uUseMask; uniform float uOp; uniform vec3 uBase; uniform ivec2 uOff;
layout(location = 0) out highp vec4 outColor;
float blended(float d, float s, int m) {
  if (m == 1) return d * s;
  if (m == 2) return 1.0 - (1.0 - d) * (1.0 - s);
  if (m == 3) return d < 0.5 ? 2.0 * d * s : 1.0 - 2.0 * (1.0 - d) * (1.0 - s);
  if (m == 4) return min(1.0, d + s);
  return s;
}
void main() {
  ivec2 here = ivec2(gl_FragCoord.xy);
  if (uPass == 0) { outColor = uKind == 2 ? vec4(0.0, 0.0, 1.0, 0.0) : vec4(uBase, 0.0); return; } // the unpainted value
  vec4 prev = texelFetch(uPrev, here, 0);
  if (uPass == 2) { // encode for an 8-bit readback, as paint.ts stores it
    // colour keeps its coverage in alpha (the caller splits it off); the rest come out as paint.ts lays them in their RGBA
    if (uKind == 2) outColor = vec4(prev.xyz * 0.5 + 0.5, 1.0);
    else if (uKind == 3) outColor = vec4(prev.rrr, 1.0);
    else if (uKind == 1) outColor = vec4(prev.r, 0.0, 0.0, 1.0);
    else outColor = vec4(prev.rgb, prev.a > 0.5 ? 1.0 : 0.0);
    return;
  }
  ivec2 at = here + uOff;
  vec4 p = texelFetch(uPx, at, 0);
  float m = uUseMask == 1 ? texelFetch(uMask, at, 0).r : 1.0;
  if (uKind == 0) {
    float a = p.a * uOp * m;
    outColor = vec4(prev.r + (blended(prev.r, p.r, uMode) - prev.r) * a, prev.g + (blended(prev.g, p.g, uMode) - prev.g) * a,
      prev.b + (blended(prev.b, p.b, uMode) - prev.b) * a, a > 0.0 ? 1.0 : prev.a);
  } else if (uKind == 1 || uKind == 3) {
    float a = p.g * uOp * m, d = prev.r;
    float b = uKind == 3 && uMode == 4 ? clamp(d + (p.r - 0.5), 0.0, 1.0) : blended(d, p.r, uMode);
    outColor = vec4(d + (b - d) * a, 0.0, 0.0, prev.a);
  } else {
    // whiteout, never an average (paint.ts): the detail adds, z multiplies
    float a = p.a * uOp * m;
    vec3 d = prev.xyz, s = p.rgb * 2.0 - 1.0, r = vec3(d.x + s.x, d.y + s.y, d.z * s.z);
    float rl = length(r); r = rl > 0.0 ? r / rl : r;
    vec3 n = d + (r - d) * a; float nl = length(n);
    outColor = vec4(a > 0.0 ? (nl > 0.0 ? n / nl : n) : d, prev.a);
  }
}`;

interface Kit {
  n: number; tw: number; th: number; ping: THREE.WebGLRenderTarget; pong: THREE.WebGLRenderTarget; out: THREE.WebGLRenderTarget;
  scene: THREE.Scene; cam: THREE.Camera; mat: THREE.RawShaderMaterial; scratch: Map<number, THREE.DataTexture>; buf: Uint8Array;
}
let kit: Kit | null = null;

function kitFor(r: THREE.WebGLRenderer, n: number): Kit | null {
  if (kit?.n === n) return kit;
  dispose();
  const type = r.extensions.has('EXT_color_buffer_float') ? THREE.FloatType : r.extensions.has('EXT_color_buffer_half_float') ? THREE.HalfFloatType : null;
  if (!type) return null; // 8-bit ping-pong would round every layer: keep the CPU's exact result instead
  const tw = n, th = Math.max(1, Math.min(n, Math.floor((TILE * TILE) / n)));
  const rt = (ty: THREE.TextureDataType) => new THREE.WebGLRenderTarget(tw, th, { type: ty, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    uniforms: { uPrev: { value: null }, uPx: { value: null }, uMask: { value: null }, uPass: { value: 0 }, uKind: { value: 0 }, uMode: { value: 0 }, uUseMask: { value: 0 }, uOp: { value: 1 }, uBase: { value: new THREE.Vector3() }, uOff: { value: new THREE.Vector2() } },
  });
  // one triangle over the whole target
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  kit = { n, tw, th, ping: rt(type), pong: rt(type), out: rt(THREE.UnsignedByteType), scene, cam: new THREE.Camera(), mat, scratch: new Map(), buf: new Uint8Array(tw * th * 4) };
  return kit;
}
function dispose() {
  if (!kit) return;
  kit.ping.dispose(); kit.pong.dispose(); kit.out.dispose(); kit.mat.dispose();
  for (const t of kit.scratch.values()) t.dispose();
  kit = null;
}

/** The n² scratch texture a layer buffer of `stride` bytes a texel is uploaded into (1: a mask; the key 0 is the mask's
 *  own, so a layer and its mask can be bound at once). Allocated once, then only ever written region by region. */
function scratchOf(r: THREE.WebGLRenderer, k: Kit, stride: 1 | 2 | 4, key: number) {
  let t = k.scratch.get(key);
  if (t) return t;
  const fmt = stride === 4 ? THREE.RGBAFormat : stride === 2 ? THREE.RGFormat : THREE.RedFormat;
  t = new THREE.DataTexture(new Uint8Array(k.n * k.n * stride), k.n, k.n, fmt, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true;
  r.initTexture(t);
  (t.image as { data: unknown }).data = null; // the GPU holds it now; three never re-uploads it (needsUpdate stays off)
  k.scratch.set(key, t);
  return t;
}
/** Region (x0, y0, w, h) of buffer `px` (n texels a row) into scratch texture `t`, through three's state so its
 *  binding cache stays right. three's own update ranges only handle RGBA. */
function upload(r: THREE.WebGLRenderer, t: THREE.DataTexture, px: Uint8Array | Uint8ClampedArray, n: number, stride: 1 | 2 | 4, x0: number, y0: number, w: number, h: number) {
  const c = r.getContext() as WebGL2RenderingContext, st = r.state, tex = (r.properties.get(t) as { __webglTexture: WebGLTexture }).__webglTexture;
  st.bindTexture(c.TEXTURE_2D, tex);
  st.pixelStorei(c.UNPACK_FLIP_Y_WEBGL, false); st.pixelStorei(c.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  st.pixelStorei(c.UNPACK_ALIGNMENT, 1); st.pixelStorei(c.UNPACK_ROW_LENGTH, n); st.pixelStorei(c.UNPACK_SKIP_PIXELS, x0); st.pixelStorei(c.UNPACK_SKIP_ROWS, y0);
  const fmt = stride === 4 ? c.RGBA : stride === 2 ? c.RG : c.RED;
  c.texSubImage2D(c.TEXTURE_2D, 0, x0, y0, w, h, fmt, c.UNSIGNED_BYTE, new Uint8Array(px.buffer, px.byteOffset, px.length));
  st.pixelStorei(c.UNPACK_ROW_LENGTH, 0); st.pixelStorei(c.UNPACK_SKIP_PIXELS, 0); st.pixelStorei(c.UNPACK_SKIP_ROWS, 0);
}

/** Can a composite of an n² set run here? */
export const gpuCompositeReady = (n: number) => !!gl && !failed && !gl.getContext().isContextLost() && n <= gl.capabilities.maxTextureSize;
const bytes = (a: Uint8Array | Uint8ClampedArray) => (a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.length));

/** Composite texel box (x0, y0)–(x1, y1) of an n² set. `emit` receives each group's result per tile: RGBA bytes, row 0
 *  at texture row ty, `w` × `h`. When `into` names the group's own n² RGBA array and the box spans whole rows, the
 *  result is read straight into it and `emit` gets null (only post-processing left). False: nothing was done (no
 *  GPU, or it failed), and the caller composites on the CPU. */
export function gpuComposite(n: number, x0: number, y0: number, x1: number, y1: number, groups: Group[], emit: (g: Group, buf: Uint8Array | null, tx: number, ty: number, w: number, h: number) => void, into?: (g: Group) => Uint8Array | Uint8ClampedArray | null): boolean {
  const r = gl;
  if (!r || !gpuCompositeReady(n)) return false;
  const k = kitFor(r, n);
  if (!k) { failed = true; return false; }
  const prevTarget = r.getRenderTarget(), u = k.mat.uniforms;
  const pass = (to: THREE.WebGLRenderTarget) => { r.setRenderTarget(to); r.render(k.scene, k.cam); };
  try {
    for (let ty = y0; ty <= y1; ty += k.th) for (let tx = x0; tx <= x1; tx += k.tw) {
      const w = Math.min(k.tw, x1 - tx + 1), h = Math.min(k.th, y1 - ty + 1);
      (u.uOff.value as THREE.Vector2).set(tx, ty);
      for (const g of groups) {
        u.uKind.value = g.kind;
        (u.uBase.value as THREE.Vector3).set(g.base[0], g.base[1] ?? 0, g.base[2] ?? 0);
        let a = k.ping, b = k.pong;
        // never sample the target being drawn: WebGL drops a draw whose bound textures include its own target (a
        // feedback loop), and the tile kept the last one's pixels
        u.uPrev.value = u.uPx.value = u.uMask.value = null;
        u.uPass.value = 0; pass(a);
        u.uPass.value = 1;
        for (const l of g.layers) {
          const t = scratchOf(r, k, l.stride, l.stride);
          upload(r, t, l.px, n, l.stride, tx, ty, w, h);
          if (l.mask) { const m = scratchOf(r, k, 1, 0); upload(r, m, l.mask, n, 1, tx, ty, w, h); u.uMask.value = m; }
          u.uUseMask.value = l.mask ? 1 : 0; u.uPx.value = t; u.uPrev.value = a.texture; u.uOp.value = l.op; u.uMode.value = l.mode;
          pass(b);
          [a, b] = [b, a];
        }
        u.uPass.value = 2; u.uPrev.value = a.texture; pass(k.out);
        const dest = w === n ? into?.(g) : null;
        if (dest) { r.readRenderTargetPixels(k.out, 0, 0, w, h, bytes(dest).subarray(ty * n * 4, (ty + h) * n * 4)); emit(g, null, tx, ty, w, h); }
        else { r.readRenderTargetPixels(k.out, 0, 0, w, h, k.buf); emit(g, k.buf, tx, ty, w, h); }
      }
    }
    return true;
  } catch (e) {
    console.warn('GPU composite failed, using the CPU from now on', e);
    failed = true;
    return false;
  } finally {
    u.uPx.value = u.uPrev.value = u.uMask.value = null;
    r.setRenderTarget(prevTarget);
  }
}
