// Rasterise a texture set's UV triangles into a shell mask on the GPU. The CPU version walks every
// triangle's texel box; at 4K that is tens of millions of tests and froze the first brush stroke.
// This renders the same triangles once into an n×n target and reads it back. Null when WebGL is
// unavailable (tests, old browsers); `paint.ts` falls back to its CPU rasteriser.
import * as THREE from 'three';

let gl: THREE.WebGLRenderer | null = null;
let failed = false;

export function uvShell(n: number, uvs: ArrayLike<number>): Uint8Array | null {
  if (failed || n <= 0 || uvs.length < 6 || typeof document === 'undefined') return null;
  const tris = uvs.length / 6;
  try {
    if (!gl) {
      gl = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' });
      gl.setPixelRatio(1);
      gl.outputColorSpace = THREE.SRGBColorSpace;
      gl.toneMapping = THREE.NoToneMapping;
    }
    gl.setSize(n, n, false);
    const rt = new THREE.WebGLRenderTarget(n, n, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });
    const pos = new Float32Array(tris * 9);
    for (let t = 0; t < tris; t++) {
      for (let k = 0; k < 3; k++) {
        pos[t * 9 + k * 3] = uvs[t * 6 + k * 2] * 2 - 1;
        pos[t * 9 + k * 3 + 1] = uvs[t * 6 + k * 2 + 1] * 2 - 1;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    gl.setRenderTarget(rt);
    gl.setClearColor(0x000000, 1);
    gl.clear();
    gl.render(scene, cam);
    const buf = new Uint8Array(n * n * 4);
    gl.readRenderTargetPixels(rt, 0, 0, n, n, buf);
    gl.setRenderTarget(null);
    geo.dispose(); mat.dispose(); rt.dispose();
    const mask = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) mask[i] = buf[i * 4] > 127 ? 1 : 0;
    return mask;
  } catch {
    failed = true;
    return null;
  }
}
