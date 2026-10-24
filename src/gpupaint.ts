// A GPU brush preview for the live stroke. The authoritative pixels stay on the CPU (layers, masks, export,
// undo); while the mouse is down the dabs are stamped into a WebGL render target and the model samples that
// target directly, so a 4K stroke is a few GPU draws instead of a JS compositing pass per move. On release the
// points replay through the CPU with one composite, which is what the layers, export and undo see.
//
// This is WebGL2 rather than raw WebGPU because the viewport is three.js/WebGL: the render target's texture can
// be handed straight to the model's material without a cross-API copy. A WebGPU backend can replace this module
// without changing the store contract.
import * as THREE from 'three';
import type { Brush, TexSet } from './paint';

type Mode = 'world' | 'uv';
interface Point { at: number[] | null; uv: [number, number]; b: Brush; uvR: number }

interface Session {
  ts: TexSet; part: number; mode: Mode; size: number; opacity: number;
  rt: THREE.WebGLRenderTarget; scene: THREE.Scene; cam: THREE.Camera; mesh: THREE.Mesh; mat: THREE.ShaderMaterial;
  geom: THREE.BufferGeometry; cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  data: Uint8Array; points: Point[]; serial: number; shotSerial: number;
}

let renderer: THREE.WebGLRenderer | null = null;
let session: Session | null = null;

export function setPaintRenderer(gl: THREE.WebGLRenderer) { renderer = gl; }

const VERT = `
attribute vec3 aWorld;
attribute vec2 aUv;
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vWorld = aWorld;
  vUv = aUv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform int uMode;
uniform vec3 uCenter;
uniform float uRadius;
uniform vec3 uColor;
uniform float uFlow;
uniform float uHardness;
uniform float uOpacity;
uniform int uTip;
varying vec3 vWorld;
varying vec2 vUv;
float grain(vec3 p) {
  float n = sin(p.x * 12.9898 + p.y * 78.233 + p.z * 37.719) * 43758.5453;
  return n - floor(n);
}
void main() {
  vec3 off = uMode == 0 ? vWorld - uCenter : vec3(vUv - uCenter.xy, 0.0);
  float d = uTip == 1
    ? max(max(abs(off.x), abs(off.y)), abs(off.z)) / uRadius
    : length(off) / uRadius;
  if (d >= 1.0) discard;
  float hard = clamp(uHardness, 0.0, 0.99);
  float a = d <= hard ? 1.0 : 1.0 - (d - hard) / (1.0 - hard);
  vec3 p = uMode == 0 ? vWorld * 260.0 : vec3(vUv * 800.0, 0.0);
  if (uTip == 2) a *= 0.35 + 0.65 * grain(p);
  else if (uTip == 3) a *= step(0.55, grain(p * 2.0));
  else if (uTip == 4) a *= max(0.0, 1.0 - abs(d - 0.72) / 0.28);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColor, a * uFlow * uOpacity);
}`;

const clip = (uv: ArrayLike<number>) => {
  const a = new Float32Array(uv.length / 2 * 3);
  for (let i = 0, j = 0; i < uv.length; i += 2, j += 3) { a[j] = uv[i] * 2 - 1; a[j + 1] = uv[i + 1] * 2 - 1; a[j + 2] = 0; }
  return a;
};
const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const tipIndex = (tip: Brush['tip']) => (tip === 'square' ? 1 : tip === 'chalk' ? 2 : tip === 'spray' ? 3 : tip === 'ring' ? 4 : 0);

function dispose(s: Session) {
  s.rt.dispose(); s.geom.dispose(); s.mat.dispose();
  s.ts.preview = undefined;
}

/** Start a GPU preview for a normal-blend, color-capable brush stroke. False means use the CPU path. */
export function gpuBegin(ts: TexSet, part: number, mode: Mode, uv: [number, number], b: Brush, opacity: number, pos: ArrayLike<number> | null, uvs: ArrayLike<number> | null): boolean {
  if (!renderer || renderer.getContext().isContextLost()) return false;
  if (!b.values.color || !ts.channels.includes('color')) return false;
  if (ts.size > renderer.capabilities.maxTextureSize) return false;
  if (session) gpuEnd();
  const size = ts.size;
  const rt = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prevTarget = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(rt);
    renderer.copyTextureToTexture(ts.color, rt.texture);
  } catch { rt.dispose(); renderer.setRenderTarget(prevTarget); return false; }
  renderer.setRenderTarget(prevTarget);

  const g = new THREE.BufferGeometry();
  if (mode === 'world' && uvs) {
    g.setAttribute('position', new THREE.Float32BufferAttribute(clip(uvs), 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(Array.from(uvs), 2));
    g.setAttribute('aWorld', new THREE.Float32BufferAttribute(pos ? Array.from(pos) : new Float32Array(uvs.length / 2 * 3), 3));
  } else {
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    g.setAttribute('aWorld', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMode: { value: mode === 'world' ? 0 : 1 }, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 },
      uColor: { value: new THREE.Vector3() }, uFlow: { value: 1 }, uHardness: { value: 0.5 }, uOpacity: { value: opacity }, uTip: { value: 0 },
    },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  const ctx = cv.getContext('2d')!;
  session = { ts, part, mode, size, opacity, rt, scene, cam: new THREE.Camera(), mesh, mat, geom: g, cv, ctx, data: new Uint8Array(size * size * 4), points: [], serial: 0, shotSerial: -1 };
  ts.preview = rt.texture;
  return true;
}

/** One GPU dab: world position on the model, or UV in the texture view (radius normalized by the set size). */
export function gpuDab(at: number[] | null, uv: [number, number], b: Brush, uvRadius: number) {
  const s = session;
  if (!s || !renderer || !b.values.color) return;
  const u = s.mat.uniforms;
  u.uMode.value = s.mode === 'world' ? 0 : 1;
  if (s.mode === 'world') {
    if (!at) return;
    (u.uCenter.value as THREE.Vector3).set(at[0], at[1], at[2]);
    u.uRadius.value = Math.max(1e-6, b.radius);
  } else {
    (u.uCenter.value as THREE.Vector3).set(uv[0], uv[1], 0);
    u.uRadius.value = Math.max(1e-6, uvRadius);
  }
  const c = b.values.color;
  (u.uColor.value as THREE.Vector3).set(lin(c[0]), lin(c[1]), lin(c[2]));
  u.uFlow.value = b.flow; u.uHardness.value = b.hardness; u.uTip.value = tipIndex(b.tip); u.uOpacity.value = s.opacity;
  const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
  renderer.setRenderTarget(s.rt); renderer.autoClear = false; renderer.render(s.scene, s.cam);
  renderer.autoClear = prevAuto; renderer.setRenderTarget(prevTarget);
  s.points.push({ at: at ? [...at] : null, uv: [uv[0], uv[1]], b, uvR: uvRadius * s.size });
  s.serial++;
}

/** 512 px readback for the 2D texture view; cached until the next dab. Above 2K the CPU preview stays,
 *  because reading a 4K render target every frame would cost more than the 2D view is worth. */
export function gpuPreviewCanvas(part: number): HTMLCanvasElement | null {
  const s = session;
  if (!s || s.part !== part || !renderer || s.size > 2048) return null;
  if (s.shotSerial === s.serial) return s.cv;
  const prevTarget = renderer.getRenderTarget();
  try { renderer.readRenderTargetPixels(s.rt, 0, 0, s.size, s.size, s.data); }
  catch { renderer.setRenderTarget(prevTarget); return null; }
  renderer.setRenderTarget(prevTarget);
  const N = 512, S = s.size, img = s.ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    const sy = Math.min(S - 1, Math.floor(((N - 1 - y) / N) * S));
    for (let x = 0; x < N; x++) {
      const sx = Math.min(S - 1, Math.floor((x / N) * S)), i = (sy * S + sx) * 4, o = (y * N + x) * 4;
      img.data[o] = s.data[i]; img.data[o + 1] = s.data[i + 1]; img.data[o + 2] = s.data[i + 2]; img.data[o + 3] = 255;
    }
  }
  s.ctx.putImageData(img, 0, 0);
  s.shotSerial = s.serial;
  return s.cv;
}

/** End the preview and hand the recorded points back for the authoritative CPU replay. */
export function gpuEnd(): Point[] {
  if (!session) return [];
  const points = session.points;
  dispose(session);
  session = null;
  return points;
}

/** Hand the points over but keep the preview alive until the CPU replay has caught up: releasing a 4K
 *  stroke should not flash the old composite while the commit runs. */
export function gpuTake(): Point[] { return session ? [...session.points] : []; }
export function gpuFinish() {
  if (!session) return;
  const s = session;
  dispose(s);
  session = null;
}
