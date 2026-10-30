// Da Vinci's view: the model as a product shot in a dark room. Big softboxes in the environment give metal and coated
// plastic long clean highlights, two neutral rim strips cut the silhouette out of the black, and a soft key casts the
// model's own shadows; the model turns on a turntable, opening to Geppetto's pose and closing again once a turn. Its own
// canvas: none of the editors' overlays, picking or demand frameloop. The model is centred and scaled to ~2 units, so
// lights and camera are fixed. Post: MSAA, a little bloom and optional depth of field, a vignette and grain, Khronos PBR
// Neutral at `exposure` EV (the painted colours stay the painted colours). Every setting is in `show`, so the same
// numbers build the Blender scene (`tools/blender-showcase.py`).
import { Environment, Lightformer, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { PartOut } from '../api';
import { download } from '../files';
import { PAINT_HDRI } from '../matview';
import { hasSet } from '../paint';
import { outNormals } from '../polyedit';
import { openPose, poseMatrices, skinMatrices, trianglesBones, type PoseBone } from '../rig';
import { polygonsOf, topoOf } from '../topo';
import { useApp, type Part, type Show } from '../store';
import { shadingNormals } from './Viewport3D';

/** Seconds per cycle: one turn, or 6 s when the turntable holds still. */
export const cycleOf = (s: Show) => (s.spin > 0 ? 360 / s.spin : 6);
/** How open the model is at `t`: shut for the first quarter, eased open, held, eased shut by 85% of the cycle. */
function openness(t: number, s: Show) {
  if (!s.open) return 0;
  const c = cycleOf(s), a = 0.25 * c, d = 0.85 * c, tw = Math.max(1e-3, Math.min(s.tween, (d - a) / 2));
  const ease = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
  return ease((t - a) / tw) - ease((t - (d - tw)) / tw);
}
const clock = { t: 0 };
const scaled = (p: PoseBone | undefined, w: number): PoseBone | undefined => p && {
  rot: [p.rot[0] * w, p.rot[1] * w, p.rot[2] * w], slide: p.slide * w, ...(p.loc && { loc: [p.loc[0] * w, p.loc[1] * w, p.loc[2] * w] }),
};

/** The rig's bones plus one that never moves (unbound triangles), shared by every part's SkinnedMesh. Each bone's
 *  matrixWorld is written directly (they sit in no scene graph): the skin matrix, posed × rest⁻¹. */
function useSkeleton(count: number) {
  return useMemo(() => {
    const bones = Array.from({ length: count + 1 }, () => Object.assign(new THREE.Bone(), { matrixAutoUpdate: false, matrixWorldAutoUpdate: false }));
    return new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  }, [count]);
}

function ShowPart({ index, out, part, skeleton }: { index: number; out: PartOut; part: Part; skeleton: THREE.Skeleton }) {
  const uvs = useApp((s) => s.uvs[index]), sharp = useApp((s) => s.params.sharp), bind = useApp((s) => s.rig.bind[index]);
  useApp((s) => s.paintRev);
  const bones = skeleton.bones.length - 1;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry(), p3 = new Float32Array(out.positions), n = p3.length / 3;
    g.setAttribute('position', new THREE.BufferAttribute(p3, 3));
    if (uvs) g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const fileN = part.normals?.length === part.soup.length ? outNormals(p3, out.source, part.soup, part.normals) : null;
    g.setAttribute('normal', new THREE.BufferAttribute(shadingNormals(p3, polygonsOf(out.source, part.poly), topoOf(out.positions), true, sharp, fileN), 3));
    // ponytail: rigid per triangle (Geppetto's binding); a corner shared by two bones' triangles can open a crack at a skinned joint
    const tri = trianglesBones(out.source, bind), idx = new Uint16Array(n * 4), w = new Float32Array(n * 4);
    for (let c = 0; c < n; c++) { const b = tri[(c / 3) | 0]; idx[c * 4] = b >= 0 && b < bones ? b : bones; w[c * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    return g;
  }, [out, uvs, part.normals, part.soup, part.poly, sharp, bind, bones]);
  useEffect(() => () => geo.dispose(), [geo]);
  // the Van Gogh material as the game will light it (the set's composite; an unpainted part Substance's default grey)
  const ts = hasSet(part.soup), pbr = !!ts?.channels.includes('rough'), normal = !!ts?.channels.includes('normal');
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#bcbcbc', roughness: 0.5, metalness: 0 }), []);
  useEffect(() => () => mat.dispose(), [mat]);
  Object.assign(mat, { map: ts?.color ?? null, roughnessMap: pbr ? ts!.orm : null, metalnessMap: pbr ? ts!.orm : null, roughness: pbr ? 1 : 0.5, metalness: pbr ? 1 : 0, normalMap: normal ? ts!.normal : null, aoMap: ts?.aoTex ?? null });
  mat.color.set(ts ? '#ffffff' : '#bcbcbc');
  mat.envMapIntensity = 1;
  mat.needsUpdate = true;
  const mesh = useMemo(() => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.bindMode = THREE.DetachedBindMode; // the bones are in the model's frame, not the world's (the turntable turns it)
    m.bind(skeleton, new THREE.Matrix4());
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }, [geo, mat, skeleton]);
  return <primitive object={mesh} />;
}

/** Turntable, the open / close tween and the skeleton, once a frame. */
function Turntable() {
  const result = useApp((s) => s.result), parts = useApp((s) => s.parts), count = useApp((s) => s.rig.bones.length);
  const skeleton = useSkeleton(count);
  const frame = useMemo(() => {
    const box = new THREE.Box3();
    for (const p of result?.parts ?? []) box.union(new THREE.Box3().setFromArray(p.positions));
    const size = box.getSize(new THREE.Vector3()), k = 2 / Math.max(size.x, size.y, size.z, 1e-6);
    return { centre: box.getCenter(new THREE.Vector3()).multiplyScalar(-k), k };
  }, [result]);
  const turn = useMemo(() => new THREE.Group(), []);
  useFrame((_, dt) => {
    const s = useApp.getState(), show = s.show;
    if (s.showPlay || s.showRec === 'video') clock.t = (clock.t + Math.min(dt, 0.1)) % cycleOf(show);
    turn.rotation.y = THREE.MathUtils.degToRad(clock.t * show.spin);
    const w = openness(clock.t, show), bones = s.rig.bones;
    if (bones.length !== count) return;
    const open = openPose(bones, s.pose);
    const skin = skinMatrices(bones, poseMatrices(bones, bones.map((_, i) => scaled(open[i], w))));
    skin.forEach((m, i) => skeleton.bones[i].matrixWorld.copy(m));
  });
  if (!result) return null;
  return (
    <primitive object={turn}>
      <group scale={frame.k} position={frame.centre}>
        {result.parts.map((p, i) => parts[i]?.visible && <ShowPart key={i} index={i} out={p} part={parts[i]} skeleton={skeleton} />)}
      </group>
    </primitive>
  );
}

/** A product studio in a dark room: big softboxes in the environment (what metal and coated plastic reflect: an overhead
 *  box, a key card front-left, two neutral rim strips behind, a low kicker) and lamps for the diffuse light (a soft key
 *  that casts the model's own shadows, two rims, a faint fill so the shadow side never goes to black). */
function Studio() {
  const { rim, rimPower, key, bg } = useApp((s) => s.show);
  return <>
    <color attach="background" args={[bg]} />
    {/* the room is Van Gogh's studio plate (what the paint was judged under), with softboxes and rim strips hung in it;
        the camera sees only the dark backdrop, the model reflects the lit room */}
    <Suspense fallback={null}>
    <Environment key={`${rim}${rimPower}${key}`} files={PAINT_HDRI} resolution={512} environmentIntensity={0.75}>
      {/* overhead box */}
      <Lightformer form="rect" intensity={2 * key} position={[0, 5, 0]} scale={[8, 8, 1]} />
      {/* big key panel front-left and a weaker one front-right, at the model's height: what its sides reflect */}
      <Lightformer form="rect" intensity={1.6 * key} position={[-4, 1, 3.5]} scale={[4, 5, 1]} />
      <Lightformer form="rect" intensity={0.8 * key} position={[4, 0.5, 3.5]} scale={[4, 4, 1]} />
      {/* rim strips behind and a strip over the back, for the silhouette */}
      <Lightformer form="rect" intensity={2 * rimPower} color={rim} position={[-4, 1, -3.5]} scale={[1, 6, 1]} />
      <Lightformer form="rect" intensity={2 * rimPower} color={rim} position={[4, 1, -3.5]} scale={[1, 6, 1]} />
      <Lightformer form="rect" intensity={1.4 * rimPower} color={rim} position={[0, 3.5, -4.5]} scale={[8, 0.6, 1]} />
    </Environment>
    </Suspense>
    <hemisphereLight args={['#ffffff', '#202020', 1.1 * key]} />
    <directionalLight
      castShadow position={[1, 5, 4]} intensity={5 * key}
      shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-radius={6}
      shadow-camera-near={0.5} shadow-camera-far={20} shadow-camera-left={-2.5} shadow-camera-right={2.5}
      shadow-camera-top={2.5} shadow-camera-bottom={-2.5} shadow-bias={-0.0002} shadow-normalBias={0.01}
    />
    <directionalLight position={[-3, 2, -4]} intensity={3 * rimPower} color={rim} />
    <directionalLight position={[3.5, 2.5, -4]} intensity={3 * rimPower} color={rim} />
  </>;
}

/** Bloom, bokeh, one grade pass and the tone curve. The renderer's own draw is turned off by the priority; this is the only draw. */
const post: {
  composer: EffectComposer | null;
  bloom: UnrealBloomPass | null;
  bokeh: BokehPass | null;
  grade: ShaderPass | null;
} = { composer: null, bloom: null, bokeh: null, grade: null };

const GRADE = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null }, uTime: { value: 0 }, uVignette: { value: 0.42 },
    uGrain: { value: 0.035 }, uLetterbox: { value: 0 }, uAspect: { value: 16 / 9 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uVignette, uGrain, uLetterbox, uAspect;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      vec3 col = texture2D(tDiffuse, uv).rgb;
      // an elliptical vignette: the corners fall away, the subject stays clean
      vec2 vp = d * vec2(uAspect, 1.0);
      float v = smoothstep(1.25, 0.35, length(vp));
      col *= mix(1.0, v, uVignette * 0.72);
      // film grain, scaled with the signal so the black room stays black
      float n = hash(uv * vec2(1920.0, 1080.0) + uTime * 23.0) - 0.5;
      col *= 1.0 + n * uGrain * 4.0;
      // a true 2.39:1 frame, letterboxed in the canvas (the Blender scene renders the same aspect)
      if (uLetterbox > 0.5) {
        float bar = max(0.0, (1.0 - uAspect / 2.39) * 0.5);
        if (uv.y < bar || uv.y > 1.0 - bar) col = vec3(0.0);
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

function Cinematic() {
  const gl = useThree((s) => s.gl), scene = useThree((s) => s.scene), camera = useThree((s) => s.camera), size = useThree((s) => s.size);
  const parts = useMemo(() => {
    // MSAA in the composer's own targets (the canvas has none: everything draws through here)
    const composer = new EffectComposer(gl, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    composer.addPass(new RenderPass(scene, camera));
    const bokeh = new BokehPass(scene, camera, { focus: 6, aperture: 0.0, maxblur: 0.007 });
    composer.addPass(bokeh);
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.72, 0.82);
    composer.addPass(bloom);
    const grade = new ShaderPass(GRADE);
    composer.addPass(grade);
    composer.addPass(new OutputPass());
    post.composer = composer; post.bloom = bloom; post.bokeh = bokeh; post.grade = grade;
    return { composer, bokeh, bloom, grade };
  }, [gl, scene, camera]);
  useEffect(() => {
    gl.toneMapping = THREE.NeutralToneMapping;
  }, [gl]);
  useEffect(() => {
    parts.composer.setPixelRatio(Math.max(1, gl.getPixelRatio()));
    parts.composer.setSize(size.width, size.height);
  }, [gl, parts, size]);
  useEffect(() => () => {
    parts.composer.dispose();
    parts.bloom.dispose(); parts.bokeh.dispose(); parts.grade.dispose();
    if (post.composer === parts.composer) { post.composer = null; post.bloom = null; post.bokeh = null; post.grade = null; }
  }, [parts]);
  useFrame((state) => {
    const s = useApp.getState().show;
    const bokehU = parts.bokeh.uniforms as Record<string, { value: number }>;
    parts.bokeh.enabled = s.cine && s.dof > 0.002;
    parts.bloom.enabled = s.cine && s.bloom > 0;
    parts.grade.enabled = s.cine;
    gl.toneMappingExposure = 2 ** s.exposure; // EV, as Blender's exposure
    bokehU.focus.value = camera.position.length();
    bokehU.aperture.value = s.dof * 0.006;
    bokehU.maxblur.value = 0.007;
    parts.bloom.strength = s.bloom * 0.4;
    parts.bloom.radius = 0.2;
    parts.bloom.threshold = 1.6;
    const u = parts.grade.uniforms;
    u.uTime.value = state.clock.elapsedTime;
    u.uVignette.value = 0.35;
    u.uGrain.value = s.grain * 0.06;
    u.uLetterbox.value = s.letterbox ? 1 : 0;
    u.uAspect.value = size.width / Math.max(1, size.height);
    parts.composer.render();
  }, 50);
  return null;
}

/** The still target: `show.still` is the long edge in pixels, 0 keeps the view's own size. */
function stillSize(gl: THREE.WebGLRenderer, width: number, height: number, target: number) {
  if (!target) return { width: Math.round(width), height: Math.round(height), scale: 1 };
  const cap = Math.min(8192, gl.capabilities.maxTextureSize || 4096);
  const scale = Math.min(target / Math.max(width, height), cap / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** One high-resolution still through the same composer, then the canvas goes back to its viewport size. */
async function captureStill(gl: THREE.WebGLRenderer, camera: THREE.Camera, width: number, height: number, target: number, name: string) {
  const t = stillSize(gl, width, height, target);
  const oldRatio = gl.getPixelRatio(), oldSize = new THREE.Vector2();
  gl.getSize(oldSize);
  const oldAspect = camera instanceof THREE.PerspectiveCamera ? camera.aspect : null;
  const restore = () => {
    gl.setPixelRatio(oldRatio);
    gl.setSize(oldSize.x, oldSize.y, false);
    if (camera instanceof THREE.PerspectiveCamera && oldAspect != null) { camera.aspect = oldAspect; camera.updateProjectionMatrix(); }
    if (post.composer) { post.composer.setPixelRatio(oldRatio); post.composer.setSize(oldSize.x, oldSize.y); }
  };
  try {
    if (t.scale > 1.001) {
      gl.setPixelRatio(1);
      gl.setSize(t.width, t.height, false);
      if (camera instanceof THREE.PerspectiveCamera) { camera.aspect = t.width / t.height; camera.updateProjectionMatrix(); }
      if (post.composer) { post.composer.setPixelRatio(1); post.composer.setSize(t.width, t.height); }
    }
    post.composer?.render();
    const blob = await new Promise<Blob | null>((done) => gl.domElement.toBlob(done, 'image/png'));
    if (blob) download(blob, `${name}.png`);
  } finally { restore(); }
}

/** Captures: one whole cycle from its start as WebM (the canvas stream, 60 fps), or a still through the composer. */
function Capture() {
  const gl = useThree((s) => s.gl), camera = useThree((s) => s.camera), size = useThree((s) => s.size), rec = useApp((s) => s.showRec);
  useEffect(() => {
    if (!rec) return;
    const st = useApp.getState(), name = (st.source ?? 'model').replace(/\.[^.]+$/, '');
    const done = () => useApp.setState({ showRec: null });
    if (rec === 'still') {
      void captureStill(gl, camera, size.width, size.height, st.show.still, name).finally(done);
      return;
    }
    clock.t = 0;
    const type = ['video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(gl.domElement.captureStream(60), { mimeType: type, videoBitsPerSecond: 25e6 }), chunks: Blob[] = [];
    mr.ondataavailable = (e) => chunks.push(e.data);
    mr.onstop = () => { download(new Blob(chunks, { type: 'video/webm' }), `${name}-showcase.webm`); done(); };
    mr.start();
    const stop = setTimeout(() => mr.stop(), cycleOf(useApp.getState().show) * 1000);
    return () => { clearTimeout(stop); if (mr.state !== 'inactive') mr.stop(); };
  }, [rec, gl, camera, size]);
  return null;
}

export function RenderView() {
  const has = useApp((s) => !!s.result), rec = useApp((s) => s.showRec);
  return (
    <section className="view">
      <header className="vbar">
        <span className="caps" title="Drag orbits, wheel zooms; the turntable keeps turning">Render</span>
        <div className="vtools">{rec === 'video' && <span className="vlabel">● Recording one turn…</span>}</div>
      </header>
      <div className="vbody">
        <div className="r3f">
          <Canvas
            camera={{ position: [2.3, 0.7, 3.1], fov: 32, near: 0.05, far: 100 }}
            dpr={[1, 2]}
            shadows="percentage"
            gl={{ preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' }}
          >
            <Studio />
            {has && <Turntable />}
            <Cinematic />
            <Capture />
            <OrbitControls
              makeDefault enablePan={false} enableDamping dampingFactor={0.075}
              minDistance={1.8} maxDistance={20} minPolarAngle={0.18} maxPolarAngle={Math.PI / 2 + 0.02}
              target={[0, 0.04, 0]}
              mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: -1 as THREE.MOUSE }}
            />
          </Canvas>
        </div>
      </div>
    </section>
  );
}
