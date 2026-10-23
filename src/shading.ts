// Viewport shading after Blender's popover: MatCaps (lit spheres the model takes its shading from by normal, drawn here so
// there are no image files) and Blender's Solid Studio lighting (cavity is the Workbench pass in Viewport3D).
import * as THREE from 'three';

/** The 3D view's background in Theme mode. */
export const THEME_BG = '#1f2124';

type RGB = [number, number, number];
interface Matcap { label: string; base: RGB; amb: number; dif: number; spec: number; shine: number; rim: number; rimColor?: RGB; kind?: 'chrome' | 'toon' | 'normals' }
export const MATCAPS: Record<string, Matcap> = {
  clay: { label: 'Clay', base: [0.78, 0.74, 0.69], amb: 0.28, dif: 0.78, spec: 0.12, shine: 18, rim: 0.12 },
  studio: { label: 'Studio grey', base: [0.74, 0.75, 0.77], amb: 0.22, dif: 0.82, spec: 0.38, shine: 42, rim: 0.18 },
  wax: { label: 'Red wax', base: [0.72, 0.18, 0.15], amb: 0.2, dif: 0.85, spec: 0.55, shine: 70, rim: 0.2, rimColor: [1, 0.6, 0.5] },
  jade: { label: 'Jade', base: [0.28, 0.62, 0.48], amb: 0.25, dif: 0.75, spec: 0.6, shine: 90, rim: 0.35, rimColor: [0.6, 1, 0.8] },
  chrome: { label: 'Chrome', base: [0.8, 0.82, 0.86], amb: 0, dif: 0, spec: 0.9, shine: 120, rim: 0.2, kind: 'chrome' },
  toon: { label: 'Toon', base: [0.85, 0.82, 0.78], amb: 0.3, dif: 0.7, spec: 0.3, shine: 60, rim: 0, kind: 'toon' },
  normals: { label: 'Normals', base: [1, 1, 1], amb: 0, dif: 0, spec: 0, shine: 1, rim: 0, kind: 'normals' },
};

const canvases = new Map<string, HTMLCanvasElement>(), textures = new Map<string, THREE.Texture>();
/** A matcap drawn as a lit sphere, 256 px: diffuse + specular + rim from a light up and to the left. */
export function matcapCanvas(id: string): HTMLCanvasElement {
  let cv = canvases.get(id);
  if (cv) return cv;
  const m = MATCAPS[id] ?? MATCAPS.clay, N = 256, c = N / 2, r = N / 2 - 1;
  cv = document.createElement('canvas'); cv.width = cv.height = N;
  const x2 = cv.getContext('2d')!, img = x2.createImageData(N, N);
  const L = [-0.45, 0.6, 0.66], Ll = Math.hypot(...L), l = L.map((v) => v / Ll), H = [l[0], l[1], l[2] + 1], Hl = Math.hypot(...H), h = H.map((v) => v / Hl);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let nx = (x - c) / r, ny = -(y - c) / r;
    const d = nx * nx + ny * ny;
    if (d > 1) { const s = 1 / Math.sqrt(d); nx *= s; ny *= s; } // outside the sphere: its rim, so edges sample cleanly
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const diff = Math.max(0, nx * l[0] + ny * l[1] + nz * l[2]), spec = Math.pow(Math.max(0, nx * h[0] + ny * h[1] + nz * h[2]), m.shine), rim = Math.pow(1 - nz, 2.5);
    let col: number[];
    if (m.kind === 'normals') col = [nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5];
    else if (m.kind === 'chrome') {
      // a studio reflected in chrome: bright sky, dark floor, a sharp horizon
      const sky = ny > -0.05 ? 0.55 + 0.45 * Math.pow(Math.max(0, ny), 0.6) : 0.08 + 0.18 * (1 + ny);
      col = m.base.map((b) => b * sky + m.spec * spec + m.rim * rim);
    } else {
      const lit = m.kind === 'toon' ? (diff > 0.66 ? 1 : diff > 0.3 ? 0.62 : 0.28) : diff;
      const rc = m.rimColor ?? [1, 1, 1];
      col = m.base.map((b, k) => b * (m.amb + m.dif * lit) + m.spec * (m.kind === 'toon' ? (spec > 0.5 ? 1 : 0) : spec) + m.rim * rim * rc[k]);
    }
    const o = (y * N + x) * 4;
    for (let k = 0; k < 3; k++) img.data[o + k] = Math.round(255 * Math.min(1, Math.max(0, col[k])));
    img.data[o + 3] = 255;
  }
  x2.putImageData(img, 0, 0);
  canvases.set(id, cv);
  return cv;
}
export function matcapTexture(id: string): THREE.Texture {
  let t = textures.get(id);
  if (!t) { t = new THREE.CanvasTexture(matcapCanvas(id)); t.colorSpace = THREE.SRGBColorSpace; textures.set(id, t); }
  return t;
}

/** Blender's Solid mode Studio lighting (Workbench `get_world_lighting`, its built-in "Default" studio light): four
 *  lights fixed to the camera, each with wrap-around diffuse ("smooth") and normalised Blinn specular, roughness 0.4,
 *  no ambient, no tone mapping. Patched into a MeshBasicMaterial so the map, vertex colours, X-ray etc. still work. */
const SOLID_LIGHTS = [
  // view-space direction, diffuse, specular, smooth (wrap)
  { vec: [-0.352546, 0.170931, -0.920051], col: [0.033103, 0.033103, 0.033103], spec: [0.266761, 0.266761, 0.266761], smooth: 0.52662 },
  { vec: [-0.408163, 0.346939, 0.844415], col: [0.521083, 0.538226, 0.538226], spec: [0.59903, 0.59903, 0.59903], smooth: 0 },
  { vec: [0.521739, 0.826087, 0.212999], col: [0.038403, 0.034357, 0.04953], spec: [0.106102, 0.125981, 0.158523], smooth: 0.478261 },
  { vec: [0.624519, -0.562067, -0.542269], col: [0.090838, 0.08208, 0.072255], spec: [0.106535, 0.084771, 0.06608], smooth: 0.2 },
];
const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
/** Shared by every studio material: `key` scales the lights, `ambient` adds an even fill, `exposure` the result. */
export const studioUniforms = {
  wbDir: { value: SOLID_LIGHTS.map((l) => v3(l.vec).normalize()) },
  wbCol: { value: SOLID_LIGHTS.map((l) => v3(l.col)) },
  wbSpec: { value: SOLID_LIGHTS.map((l) => v3(l.spec)) },
  wbWrap: { value: new THREE.Vector4(...SOLID_LIGHTS.map((l) => l.smooth)) },
  wbKey: { value: 1 }, wbAmbient: { value: 0 }, wbExposure: { value: 1 }, wbUseSpec: { value: true }, wbRough: { value: 0.4 },
};
const STUDIO_FRAG = /* glsl */ `
uniform vec3 wbDir[4], wbCol[4], wbSpec[4];
uniform vec4 wbWrap;
uniform float wbKey, wbAmbient, wbExposure, wbRough;
uniform bool wbUseSpec;
varying vec3 vWbN, vWbV;
vec4 wbWrapped(vec4 NL, vec4 w) { vec4 w1 = w + 1.0; return clamp((NL + w) / (w1 * w1), 0.0, 1.0); }
vec3 wbLight(vec3 base, vec3 N, vec3 I) {
  vec3 specColor = wbUseSpec ? vec3(0.05) : vec3(0.0), specLight = vec3(wbAmbient), diffLight = vec3(wbAmbient);
  if (wbUseSpec) {
    vec3 R = -reflect(I, N);
    vec4 angle, NL, wrappedNL;
    for (int i = 0; i < 4; i++) {
      vec3 L = wbDir[i];
      wrappedNL[i] = dot(L, R); angle[i] = clamp(dot(normalize(L + I), N), 0.0, 1.0); NL[i] = clamp(dot(L, N), 0.0, 1.0);
    }
    vec4 shininess = exp2(10.0 * vec4(1.0 - wbRough) * (1.0 - wbWrap) + 1.0);
    vec4 spec = pow(angle, shininess) * NL * (shininess * 0.125 + 1.0);
    spec = mix(spec, wbWrapped(wrappedNL, mix(wbWrap, vec4(1.0), wbRough)), wbWrap * wbWrap);
    for (int i = 0; i < 4; i++) specLight += spec[i] * wbSpec[i] * wbKey;
    float NV = clamp(dot(N, I), 0.0, 1.0);
    specColor = mix(specColor, vec3(1.0), exp2(-8.35 * NV) * (1.0 - wbRough));
  }
  specLight *= specColor;
  vec4 dNL;
  for (int i = 0; i < 4; i++) dNL[i] = dot(wbDir[i], N);
  vec4 diff = wbWrapped(dNL, wbWrap);
  for (int i = 0; i < 4; i++) diffLight += diff[i] * wbCol[i] * wbKey;
  diffLight *= base * (1.0 - dot(specColor, vec3(0.33333)));
  return diffLight + specLight;
}
`;
export function studioShader(shader: THREE.WebGLProgramParametersWithUniforms) {
  Object.assign(shader.uniforms, studioUniforms);
  shader.vertexShader = 'varying vec3 vWbN, vWbV;\n' + shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvWbN = normalMatrix * normal; vWbV = -mvPosition.xyz;');
  shader.fragmentShader = STUDIO_FRAG + shader.fragmentShader.replace('#include <opaque_fragment>',
    'outgoingLight = wbLight(diffuseColor.rgb, normalize(vWbN) * (gl_FrontFacing ? 1.0 : -1.0), normalize(vWbV)) * wbExposure;\n#include <opaque_fragment>');
}
