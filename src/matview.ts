// Van Gogh's material view, Substance's: the default viewport light (a sunny environment, its sun casting a shadow in
// 3D) shared by the 3D view and the texture view, and the texture view's Material mode, the UV layout drawn through the
// same material and light: each texel shaded by the normal of the surface it covers, so an island shows how its side of
// the model is lit, and texture space no island covers stays the dark ground it's drawn on (two tones with the darker
// view round the square).
import * as THREE from 'three';
import type { TexSet } from './paint';

/** The bundled plate for the material view: one strong key and a dark falloff, neutral (no sky or ground tint), so planes
 *  read light or dark by where they face, as in Substance's view. */
export const PAINT_HDRI = '/hdri/studio_small_04_1k.hdr';
/** Texture space no island covers, in the material view. */
export const EMPTY = '#3a3b3d';
/** The material view's light: `sun` the strength of the key that casts the shadow, on top of the environment (alone it's
 *  too even to throw one); `mean` the environment's mean brightness once calibrated (plates come at any exposure,
 *  Substance's are made for exposure 0); `key` where the key comes from, upper front left of the model as a product
 *  shot's, the plate turned so its own brightest patch is on that side. Change it, then `relight()`. */
// The fill was 0.08: a shadowed side of a mid-grey material went near black, and a dark paint job (gunmetal,
// black Cerakote) read as silhouette, so its texture couldn't be judged. 0.3 keeps the shadow side readable; the key
// drops so the lit side doesn't clip without a tone curve.
const KEY = new THREE.Vector3(-0.5, 0.8, 0.35).normalize();
export const look = { sun: 3.2, mean: 0.3, key: KEY.clone() };

/** Turn the key (and the plate with it) round the vertical by `a` radians: Substance's Shift+right-drag. */
export function turnLight(a: number) {
  look.key.applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
  relight();
}
/** Shading › Reset: the key back on the front-left. */
export function resetLight() {
  look.key.copy(KEY);
  relight();
}

/** The environment both views light with, its sun (unit direction, toward it), the intensity that calibrates it, and a
 *  count that moves when it changes. */
export const env: { tex: THREE.Texture | null; sun: THREE.Vector3; scale: number; rot: THREE.Euler; ver: number } = { tex: null, sun: look.key.clone(), scale: 1, rot: new THREE.Euler(), ver: 0 };

export function setEnv(tex: THREE.Texture) {
  env.tex = tex;
  relight();
}
/** The light again from `look`: the sun from the key, the plate turned round the vertical so its brightest patch is on
 *  the key's side, its brightness calibrated to the mean. */
export function relight() {
  if (!env.tex) return;
  const { sun, mean } = sunOf(env.tex);
  env.rot.set(0, Math.atan2(look.key.x, look.key.z) - Math.atan2(sun.x, sun.z), 0);
  env.sun.copy(look.key).normalize();
  env.scale = mean > 0 ? look.mean / mean : 1;
  env.ver++;
}

/** The brightest patch of an equirectangular HDR (luminance × the pixel's solid angle), as a direction in three's
 *  equirect mapping (u = atan(z, x) / 2π + ½, v = asin(y) / π + ½), and the plate's mean luminance over the sphere. */
function sunOf(tex: THREE.Texture) {
  const img = tex.image as { data?: ArrayLike<number>; width: number; height: number }, d = img.data;
  if (!d) return { sun: env.sun, mean: 0 };
  let sum = 0, area = 0;
  const half = d instanceof Uint16Array, at = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(d[i]) : d[i]);
  const { width: W, height: H } = img, ch = d.length / (W * H);
  let best = -1, bu = 0.5, bv = 0.75;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * ch, lum = 0.2126 * at(i) + 0.7152 * at(i + 1) + 0.0722 * at(i + 2);
    const v = tex.flipY ? 1 - (y + 0.5) / H : (y + 0.5) / H, a = Math.cos((v - 0.5) * Math.PI), w = lum * a;
    sum += w; area += a;
    if (w > best) { best = w; bu = (x + 0.5) / W; bv = v; }
  }
  const theta = (bu - 0.5) * 2 * Math.PI, lat = (bv - 0.5) * Math.PI;
  // keep it above the horizon, so it lights the model rather than its underside
  return { sun: new THREE.Vector3(Math.cos(theta) * Math.cos(lat), Math.max(0.25, Math.sin(lat)), Math.sin(theta) * Math.cos(lat)).normalize(), mean: area ? sum / area : 0 };
}

// one renderer for every part's layout and picture (browsers allow few WebGL contexts), with the environment filtered for it
let gl: THREE.WebGLRenderer | null = null, pmrem: { from: THREE.Texture; tex: THREE.Texture } | null = null;
function rendererOf(n: number) {
  gl ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  gl.setPixelRatio(1); gl.setSize(n, n, false);
  gl.toneMapping = THREE.NoToneMapping; gl.outputColorSpace = THREE.SRGBColorSpace;
  return gl;
}
function pmremOf(r: THREE.WebGLRenderer, from: THREE.Texture) {
  if (pmrem?.from !== from) {
    pmrem?.tex.dispose();
    const g = new THREE.PMREMGenerator(r);
    pmrem = { from, tex: g.fromEquirectangular(from).texture };
    g.dispose();
  }
  return pmrem.tex;
}
/** Shading › Lift: a work light, not a look. A second sun from the side opposite the key (low, so tops don't get
 *  both and clip) and a brighter environment, so the side the key misses is lit too and its texture reads, while
 *  every face still shades by where it faces (glowing the base colour flattened the model and washed out the lit side).
 *  `lift` 0 = the true studio. */
export function fillOf(lift: number) {
  const dir = new THREE.Vector3(-env.sun.x, 0.2, -env.sun.z).normalize();
  return { dir, sun: look.sun * lift * 2, env: env.scale * (1 + lift * 1.5) };
}
/** The set's PBR material, as the 3D view draws it. */
function materialOf(s: TexSet, ao: boolean) {
  const pbr = s.channels.includes('rough'), normal = s.channels.includes('normal');
  return new THREE.MeshStandardMaterial({
    map: s.color, side: THREE.DoubleSide, aoMap: ao && s.aoTex ? s.aoTex : null,
    ...(pbr ? { roughnessMap: s.orm, metalnessMap: s.orm, roughness: 1, metalness: 1 } : { roughness: 0.3, metalness: 0 }),
    ...(normal ? { normalMap: s.normal } : {}),
  });
}
/** `mesh` in the shared light and environment (and Lift's fill), on the empty-texture ground. */
function sceneOf(pm: THREE.Texture, mesh: THREE.Mesh, lift: number) {
  const f = fillOf(lift), scene = new THREE.Scene(), sun = new THREE.DirectionalLight('#ffffff', look.sun), fill = new THREE.DirectionalLight('#ffffff', f.sun);
  scene.background = new THREE.Color(EMPTY);
  scene.environment = pm;
  scene.environmentIntensity = f.env;
  scene.environmentRotation.copy(env.rot);
  sun.position.copy(env.sun);
  fill.position.copy(f.dir);
  scene.add(mesh, sun, fill);
  return scene;
}

const pics = new WeakMap<TexSet, { key: string; url: string }>();
/** A texture set's picture for the Parts list: the part itself in its material and the shared light, seen from the
 *  front-right above, `n` px square. Null until the environment has loaded; kept until the paint or the light change. */
export function partShot(s: TexSet, positions: ArrayLike<number>, uvs: ArrayLike<number>, lift = 0, n = 96) {
  if (!env.tex) return null;
  const key = `${s.ver}|${env.ver}|${s.channels.length}|${lift}`, hit = pics.get(s);
  if (hit?.key === key) return hit.url;
  const r = rendererOf(n), pm = pmremOf(r, env.tex), geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(positions), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uvs), 2));
  geo.computeVertexNormals(); // unindexed: flat faces
  geo.computeBoundingSphere();
  const { center: c, radius } = geo.boundingSphere!, mat = materialOf(s, false), scene = sceneOf(pm, new THREE.Mesh(geo, mat), lift);
  const cam = new THREE.PerspectiveCamera(30, 1, radius * 0.05, radius * 10), dist = (radius / Math.sin(Math.PI / 12)) * 1.02;
  cam.position.copy(new THREE.Vector3(1, 0.7, 1.3).normalize().multiplyScalar(dist).add(c));
  cam.lookAt(c);
  r.render(scene, cam);
  geo.dispose(); mat.dispose();
  const url = r.domElement.toDataURL();
  pics.set(s, { key, url });
  return url;
}
const shots = new WeakMap<TexSet, { key: string; uvs: ArrayLike<number>; cv: HTMLCanvasElement }>();

/** Part set `s`'s UV layout drawn in its material and the shared light, `s.size` square (top row v = 1); null until the
 *  environment has loaded. Kept until the paint, the UVs, the AO or the light change. */
export function materialCanvas(s: TexSet, positions: ArrayLike<number>, uvs: ArrayLike<number>, ao: boolean, lift = 0) {
  if (!env.tex) return null;
  const key = `${s.ver}|${env.ver}|${ao}|${s.channels.length}|${lift}`, hit = shots.get(s);
  if (hit && hit.key === key && hit.uvs === uvs) return hit.cv;
  // The texture view shows this at roughly screen size; rendering a 4K offscreen image only to scale it
  // down to a 500 px square was most of the pause after a stroke. Cap the preview at 1K.
  const n = Math.min(s.size, 1024), gl = rendererOf(n), pm = pmremOf(gl, env.tex);
  // the layout as geometry: each corner at its UV, carrying its face's normal on the model and its UV for the textures
  const tris = positions.length / 9, xyz = new Float32Array(tris * 9), nrm = new Float32Array(tris * 9), uv = new Float32Array(tris * 6);
  // ponytail: flat face normals (the 3D view smooths within Sharp edges); share its normals if a curve looks stepped here
  for (let t = 0; t < tris; t++) {
    const o = t * 9, p = positions;
    const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2], vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) {
      xyz.set([uvs[t * 6 + k * 2], uvs[t * 6 + k * 2 + 1], 0], o + k * 3);
      nrm.set([nx, ny, nz], o + k * 3);
      uv.set([uvs[t * 6 + k * 2], uvs[t * 6 + k * 2 + 1]], t * 6 + k * 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const mat = materialOf(s, ao), scene = sceneOf(pm, new THREE.Mesh(geo, mat), lift);
  // looking straight down at the UV square; the camera's frame is the world's, so the normals light as on the model
  const cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  cam.position.set(0, 0, 0.5);
  gl.render(scene, cam);
  geo.dispose(); mat.dispose();
  const cv = hit?.cv ?? document.createElement('canvas');
  cv.width = cv.height = n;
  cv.getContext('2d')!.drawImage(gl.domElement, 0, 0);
  shots.set(s, { key, uvs, cv });
  return cv;
}
