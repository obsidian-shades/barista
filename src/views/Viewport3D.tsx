// The 3D view: every part with its UVs, island borders and hand seams drawn on it, the selection tinted,
// and the unfold slider that flattens it into its layout. Navigation as in Blender: middle drag orbits (Alt snaps to
// 45° axis and diagonal views), Shift+middle pans, wheel zooms, numpad views, Home / Space frame, numpad . frames the selection. Click picks a
// vertex, edge, face or island
// (the select mode), Shift toggles, Ctrl takes away, Alt+click an edge loop, left drag box-selects (through the
// model's hidden side). Right click: the selection menu (Cut, Stitch, Unwrap…).
import { Billboard, ContactShadows, Environment, Line, OrbitControls, TransformControls, useEnvironment } from '@react-three/drei';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useCallback, Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { snapOrbitOffset, type OrbitSnapStart } from '../orbit-snap';
import type { Output } from '../api';
import { islandColor, stretchColor, uvMapCanvas } from '../colors';
import { Morph } from '../morph';
import { decalFrame, inside, isLine, RECT_OUTLINE } from '../paint';
import { env as paintEnv, fillOf, look as paintLook, PAINT_HDRI, setEnv, turnLight } from '../matview';
import { health, healthColor } from '../health';
import { poles } from '../polygeo';
import { matcapTexture, studioShader, studioUniforms, THEME_BG } from '../shading';
import { outNormals, ownPolygons, topoOfSoup } from '../polyedit';
import { RefImage } from './RefImage';
import { activeDecal, assignMaterial, dragDecal, dropDecal, beginPaintEdit, finishDecalEdit, mirrorHover, modelDiagonal, moveSymPlane, paintHoverAt, shelfDrag, updateDecal, brushRadius, paintDrag, paintEnd, paintPress, painting, selectPaintOnModel, deselectPaint, deselectDecal, texSet, type PaintMods, clearSelection, contextMenu, kindOf, knifeClick, knifeHover, liveSel, openRecent, pickFile, pointer, sceneGrade, selectElems, selectLoop, setSceneHdri, endChain, selectBone, rigMenu, cancelRigPick, useApp, view3d, type Mode, type Part, type Scene, type SelOp, type ViewOp } from '../store';
import { setPaintRenderer } from '../gpupaint';
import { topoOf, polygonsOf, trisOf } from '../topo';
import { polyContextMenu } from '../shell/PolyTools';
import { DisplayModes } from '../shell/Chrome';
import { SceneSettings } from './SceneSettings';
import { boneColor, RigBones, rigClickLock, rigConsumesClick, rigMeshClick, rigStart } from './RigView';
import { deform, poseMatrices, skinMatrices, trianglesBones, vertexWeights, weldCorners } from '../rig';
import { Mark } from '../ui/Icon';

const checker = new THREE.CanvasTexture(uvMapCanvas('checker', 1024));
checker.colorSpace = THREE.SRGBColorSpace;
checker.anisotropy = 8;
const NORMAL_SCALE = new THREE.Vector2(1, 1);

/** Selection blue, and the seam red. */
export const SEL = '#3f8fe8', SEAM = '#e54b39';
/** What a click would pick, under the mouse: lighter than the selection, so the two never read as one. */
export const HOT = '#bcdcff';

/** Floor centre and the longest side of the model, so the grid, axes and ground shadow share one frame. */
function layoutOf(result: Output | null) {
  if (!result?.parts.length) return { x: 0, y: 0, z: 0, span: 10 };
  const bounds = new THREE.Box3();
  for (const p of result.parts) bounds.union(new THREE.Box3().setFromArray(p.positions));
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  return { x: center.x, y: bounds.min.y, z: center.z, span: Math.max(size.x, size.y, size.z, 1) };
}

/** The solid colour owns the background until an environment plate takes it. Keeping both writers
 *  made the plate flicker back to the flat colour on every slider move. */
function Backdrop({ color, off }: { color: string; off?: boolean }) {
  const { scene, gl } = useThree();
  useLayoutEffect(() => {
    if (off) return; // something else (Van Gogh's World plate) is the background
    scene.background = new THREE.Color(color);
    gl.setClearColor(color, 1);
  }, [scene, gl, color, off]);
  return null;
}

/** A plate that fails to load would otherwise take the canvas down with it. */
class EnvBoundary extends Component<{ url: string; children: ReactNode }, { bad: boolean }> {
  state = { bad: false };
  static getDerivedStateFromError() { return { bad: true }; }
  componentDidCatch(err: Error) {
    useApp.setState({ error: err.message || 'Could not read that environment map' });
    setSceneHdri(null);
  }
  render() { return this.state.bad ? null : this.props.children; }
}

/** No WebGL (the browser's graphics are off or crashed): say so in the view and keep the rest of the app running. */
class ViewBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: (e.message || String(e)).replace(/\.+$/, '') }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="hint" style={{ padding: 16, lineHeight: 1.5 }}>
        The 3D view couldn’t start: {this.state.error}.<br />
        The browser’s graphics (WebGL) are off or crashed. Restart the browser; if it stays, check its GPU page
        (about:support in Firefox, chrome://gpu in Chrome) or update the graphics driver.
      </div>
    );
  }
}

function envProps(scene: Scene) {
  const yaw = scene.hdriRotation;
  return {
    background: scene.hdriBackground,
    environmentIntensity: scene.hdriStrength,
    // The backdrop stays a little dimmer than the light on the model, so the subject separates from the sweep.
    backgroundIntensity: scene.hdriBackground ? scene.hdriStrength * 0.62 : 0,
    backgroundBlurriness: scene.hdriBackground ? scene.hdriBlur : 0,
    environmentRotation: [0, yaw, 0] as [number, number, number],
    backgroundRotation: [0, yaw, 0] as [number, number, number],
  };
}

/** The loaded plate. `map` keeps drei from disposing it when a new one takes its place. */
function Plate({ url, scene }: { url: string; scene: Scene }) {
  const texture = useEnvironment({ files: url });
  return <Environment map={texture} {...envProps(scene)} />;
}

/** Keep the plate that's already up while the next one loads, so the view doesn't drop to black. */
function StudioEnvironment({ scene }: { scene: Scene }) {
  const url = scene.hdriUrl;
  const hold = useRef<string | null>(null);
  if (!url) { hold.current = null; return null; }
  return (
    <Suspense fallback={hold.current ? <Plate url={hold.current} scene={scene} /> : null}>
      <EnvBoundary key={url} url={url}>
        <Remember url={url} hold={hold}><Plate url={url} scene={scene} /></Remember>
      </EnvBoundary>
    </Suspense>
  );
}
/** Substance's default viewport (its material view): the model lit by a sunny environment alone (no lamps, no tone
 *  curve) with its sun casting a shadow, so every plane reads light or dark by where it faces. Van Gogh, Studio, no plate. */
function PaintStudio({ layout, world }: { layout: { x: number; y: number; z: number; span: number }; world: boolean }) {
  const tex = useEnvironment({ files: PAINT_HDRI });
  const { scene, invalidate } = useThree();
  const sun = useMemo(() => new THREE.DirectionalLight('#ffffff'), []), fill = useMemo(() => new THREE.DirectionalLight('#ffffff'), []);
  const shadow = useApp((st) => st.scene.paintShadow !== false); // a project from before the setting keeps its shadow
  const lift = useApp((st) => st.scene.paintLift ?? 0.4), f = fillOf(lift);
  useApp((st) => st.paintRev); // `relight()` bumps it
  useApp((st) => st.lightRev); // Shift+right-drag
  useEffect(() => {
    setEnv(tex);
    scene.environment = tex;
    scene.environmentIntensity = paintEnv.scale;
    scene.environmentRotation.copy(paintEnv.rot);
    // the texture view's Material mode can draw now: a redraw, not a paint edit (bumping paintRev here marked a
    // project unsaved as its environment map arrived)
    useApp.setState((st) => ({ lightRev: st.lightRev + 1 }));
    invalidate();
    return () => { if (scene.environment === tex) { scene.environment = null; scene.environmentIntensity = 1; scene.environmentRotation.set(0, 0, 0); } };
  }, [tex, scene, invalidate]);
  // the sun from the key, its shadow camera round the model; the plate's turn and level as `relight` left them
  sun.intensity = paintLook.sun;
  scene.environmentIntensity = f.env; // Lift: brighter plate and a fill opposite the key (`fillOf`)
  scene.environmentRotation.copy(paintEnv.rot);
  const c = new THREE.Vector3(layout.x, layout.y + layout.span / 2, layout.z), r = layout.span;
  sun.position.copy(c).addScaledVector(paintEnv.sun, r * 3);
  sun.target.position.copy(c);
  fill.intensity = f.sun;
  fill.position.copy(c).addScaledVector(f.dir, r * 3);
  fill.target.position.copy(c);
  sun.castShadow = shadow;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: r * 0.5, far: r * 6 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = r * 0.002;
  // Background › World: the plate itself behind the model, blurred and a little dimmer so the subject separates
  if (world) {
    scene.background = tex;
    scene.backgroundBlurriness = 0.55;
    scene.backgroundIntensity = paintEnv.scale * 0.7;
    scene.backgroundRotation.copy(paintEnv.rot);
  }
  // a floor that only takes the sun's shadow, so the model sits somewhere instead of floating in the dark; with the
  // shadow off there is nothing to catch, so the floor goes too (a shadow-free view for decals on the far side)
  return <>
    <primitive object={sun} /><primitive object={sun.target} /><primitive object={fill} /><primitive object={fill.target} />
    {shadow && <mesh rotation-x={-Math.PI / 2} position={[layout.x, layout.y - r * 0.002, layout.z]} receiveShadow raycast={() => null}>
      <planeGeometry args={[r * 6, r * 6]} />
      <shadowMaterial opacity={0.35} depthWrite={false} />
    </mesh>}
  </>;
}
function Remember({ url, hold, children }: { url: string; hold: { current: string | null }; children: ReactNode }) {
  useLayoutEffect(() => { hold.current = url; }, [url, hold]);
  return children;
}


/** Shift adds (toggles on a click), Ctrl takes away, else replace. */
const opOf = (e: { shiftKey: boolean; ctrlKey: boolean }, click: boolean): SelOp => (e.shiftKey ? (click ? 'toggle' : 'add') : e.ctrlKey ? 'sub' : 'set');

type Box = { x0: number; y0: number; x1: number; y1: number };
const track = (e: React.PointerEvent) => { pointer.view = '3d'; pointer.x = e.clientX; pointer.y = e.clientY; };
/** Van Gogh, Shift+right-drag: turn the light round the model (Substance's), the plate and the key together. The view
 *  and the texture view's Material mode redraw once a frame. */
function lightDrag(e: React.PointerEvent) {
  if (e.button !== 2 || !e.shiftKey) return;
  e.preventDefault();
  let x = e.clientX, queued = 0;
  const move = (m: PointerEvent) => {
    turnLight((m.clientX - x) * 0.01);
    x = m.clientX;
    queued ||= requestAnimationFrame(() => { queued = 0; useApp.setState((st) => ({ lightRev: st.lightRev + 1 })); });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => removeEventListener('pointermove', move), { once: true });
}

/** Before a model: one action and the recent files, nothing to read. */
function EmptyState() {
  const recent = useApp((s) => s.recent);
  return (
    <div className="empty">
      <span className="mark"><Mark size={34} /></span>
      <h2>No model open</h2>
      <div className="actions">
        <button className="primary" onClick={() => void pickFile()} title="Open a model (Ctrl+O)">Open model…</button>
      </div>
      {recent.length > 0 && <div className="recent">
        {recent.slice(0, 4).map((r) => <button key={r.name} onClick={() => void openRecent(r.name)} title={`Open ${r.name}`}><span>{r.name}</span></button>)}
      </div>}
      <span className="formats">FBX · glTF · OBJ · STL</span>
    </div>
  );
}

/** Gives the GPU brush the same WebGL renderer the viewport uses, so its render target can be sampled directly. */
function PaintGL() {
  const gl = useThree((s) => s.gl);
  useEffect(() => setPaintRenderer(gl), [gl]);
  return null;
}

export function Viewport3D() {
  const result = useApp((s) => s.result), rev = useApp((s) => s.rev), unfold = useApp((s) => s.unfold);
  const scene = useApp((s) => s.scene), doc = useApp((s) => s.workspace === 'doc'), paintWs = useApp((s) => s.workspace === 'paint'), rigWs = useApp((s) => s.workspace === 'rig');
  const vis = useApp((s) => s.parts.map((p) => (p.visible ? '1' : '0')).join(''));
  const empty = useApp((s) => !s.loading && !s.parts.length);
  const layout = useMemo(() => layoutOf(result), [result]);
  const studio = scene.lighting === 'studio' && !!scene.hdriUrl;
  // Van Gogh in Studio lighting with no plate picked: Substance's material view (sunny environment, sun shadow, no lamps)
  const paintStudio = paintWs && scene.lighting === 'studio' && !scene.hdriUrl;
  const uvWs = !doc && !paintWs && !rigWs;
  const grade = sceneGrade(scene.hdriId);
  const [box, setBox] = useState<Box | null>(null), [lasso, setLasso] = useState<[number, number][] | null>(null);
  // the studio materials share these uniforms; every scene change re-renders this and redraws (Redraw)
  studioUniforms.wbKey.value = scene.key; studioUniforms.wbAmbient.value = scene.ambient;
  studioUniforms.wbExposure.value = scene.exposure; studioUniforms.wbUseSpec.value = scene.specular;
  return (
    <section className="view">
      <header className="vbar">
        <span className="caps" title="Middle drag orbits; Alt+middle snaps to axis and diagonal views; Home / Space recenters">3D</span>
        <div className="vtools">
          {!uvWs && (
            <>
              <span className="vlabel" title={paintWs ? 'How the model is lit' : 'How the view draws the model'}>{paintWs ? 'Lighting' : 'Display'}</span>
              <DisplayModes />
            </>
          )}
          <SceneSettings />
          {uvWs && (
            <label className="slider" title="Roll the model out into its UV layout (double-click to put it back)">
              Unfold
              <input type="range" min={0} max={1} step={0.01} value={unfold} aria-label="Unfold" onChange={(e) => useApp.setState({ unfold: +e.target.value })} onDoubleClick={() => useApp.setState({ unfold: 0 })} />
              <output className="num">{Math.round(unfold * 100)}%</output>
            </label>
          )}
        </div>
      </header>
      <div className="vbody" onPointerMove={track} onPointerDown={(e) => { track(e); if (paintWs) lightDrag(e); }}
        onContextMenu={(e) => { e.preventDefault(); if (paintWs) return; if (rigWs) { const s = useApp.getState(); if (s.rigPick) { cancelRigPick(); return; } if (s.rigChain) { endChain(); return; } rigMenu(e.clientX, e.clientY); return; } if (doc) polyContextMenu(); else contextMenu(); }}>
        {/* drawn only when something changed (orbit, a store update), not 60 times a second: an idle view costs no GPU */}
        <ViewBoundary>
        <div className="r3f">
        <Canvas shadows frameloop="demand" camera={{ position: [2.2, 1.6, 3], fov: 45 }} dpr={[1, 2]}
          onCreated={({ gl }) => setPaintRenderer(gl)}
          onPointerMissed={(e) => {
            if (e.button !== 0 || e.shiftKey || e.ctrlKey || rigConsumesClick() || useApp.getState().docKnife) return;
            // a click on the empty view is outside every mark too: with the Decal tool it clears the pick
            const s = useApp.getState();
            if (s.workspace === 'paint' && s.paint.tool === 'decal') deselectDecal();
            // Select Faces: a click off the model drops the paint selection, as Marquee and Lasso's click does
            if (s.workspace === 'paint' && s.paint.tool === 'wand' && !e.altKey) deselectPaint();
            // Geppetto: a click on nothing drops the bone (the Bone tool's clicks belong to the chain)
            if (s.workspace === 'rig') { if (s.rigTool === 'bone' && s.rigMode === 'edit') return; selectBone(-1); }
            clearSelection();
          }}>
          <PaintGL />
          <Backdrop off={paintStudio && scene.hdriBackground} color={scene.bg === 'custom' ? scene.background : THEME_BG} />
          {/* Workspace lights stay as they were. A plate takes over: a warm or cool fill at the slider's
              level, plus one front-left lamp, and the map does the rest of the room. */}
          <hemisphereLight color={studio ? grade.sky : '#ffffff'} groundColor={studio ? grade.ground : '#333344'} intensity={paintStudio ? 0 : scene.ambient} />
          <directionalLight position={studio ? [-0.4, 7.9, 6.1] : [3, 4, 5]} intensity={paintStudio ? 0 : scene.key} color={studio ? grade.keyColor : '#ffffff'} />
          <RendererExposure exposure={scene.exposure} />
          {scene.lighting === 'studio' && <StudioEnvironment scene={scene} />}
          {paintStudio && <Suspense fallback={null}><PaintStudio layout={layout} world={scene.hdriBackground} /></Suspense>}
          <gridHelper key={`grid${layout.span}`} visible={scene.showGrid} position={[layout.x, layout.y, layout.z]} args={[layout.span * 3, 20, '#59616b', '#343a42']} />
          <axesHelper key={`axes${layout.span}`} visible={scene.showAxes} position={[layout.x, layout.y, layout.z]} args={[layout.span * 0.55]} />
          {scene.shadow && unfold === 0 && result && !paintStudio && (
            <ContactShadows key={`${rev}:${vis}`} position={[layout.x, layout.y, layout.z]} scale={layout.span * 2.6} far={layout.span * 1.25} blur={2.6} opacity={scene.shadowAmount} resolution={1024} frames={1} color={studio ? '#1c140f' : '#000000'} />
          )}
          {result && (
            <FitOnOpen fitKey={rev}>
              <Model result={result} unfold={unfold} studio={studio} wireframe={scene.wireframe} showEdges={scene.showEdges} showVertices={scene.showVertices} showSeams={scene.showSeams} />
            </FitOnOpen>
          )}
          {result && <SymPlaneGizmo />}
          {rigWs && result && <RigBones />}
          {paintWs && <BrushCursor />}
          {paintWs && <DecalGizmo />}
          {paintWs && <DecalPreview />}
          {paintWs && <MirrorPreview />}
          {paintWs && <DrawnLine />}
          {doc && <KnifeLine />}
          <Picker />
          {/* the wheel zooms toward what's under the mouse (Blender's Zoom to Mouse Position), about 14% a notch (three's default 5% felt stuck on a big FBX), with no limit either way */}
          <OrbitControls makeDefault zoomToCursor zoomSpeed={3} minDistance={0} maxDistance={Infinity} mouseButtons={{ LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: -1 as THREE.MOUSE }} />
          <OrbitSnap />
          <ClipPlanes span={layout.span} />
          <Redraw />
          <Workbench curvature={scene.cavity && scene.cavityType !== 'world'} cavity={scene.cavity && scene.cavityType !== 'screen'} outline={scene.outline && unfold === 0} outlineColor="#e6e6e6" ridge={scene.ridge} valley={scene.valley}
            distance={scene.cavityDistance} span={layout.span} toneMap={paintStudio ? false : !(scene.lighting === 'studio' && !studio)} />
          <Navigation setBox={setBox} setLasso={setLasso} />
        </Canvas>
        </div>
        </ViewBoundary>
        {empty && !result && <EmptyState />}
        {lasso && <svg className="lassosel"><polygon points={lasso.map((p) => p.join(',')).join(' ')} /></svg>}
        <RefImage />
        {box && <div className="boxsel" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
      </div>
    </section>
  );
}

type Controls = { target: THREE.Vector3; update: () => void; enabled: boolean; addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void };

/** Frame the model when it arrives: an opened project, a fresh unwrap, a shape. drei's `<Bounds fit>` animates the
 *  camera from wherever it was and only fits on its first layout, so a fit that read the canvas before it had a size
 *  (or the default camera while a model sits thousands of units from the origin) left the view pointed at nothing.
 *  This snaps to the model once the canvas and its controls exist. */
function FitOnOpen({ fitKey, children }: { fitKey: number; children: ReactNode }) {
  const { camera, controls, size, invalidate } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: Controls | null; size: { width: number; height: number }; invalidate: () => void };
  const fitted = useRef(-1);
  useLayoutEffect(() => {
    if (!controls || size.width < 2 || size.height < 2 || fitted.current === fitKey) return;
    fitted.current = fitKey;
    look(camera, controls, 'all');
    invalidate();
  }, [fitKey, size.width, size.height, camera, controls, invalidate]);
  return <>{children}</>;
}

/** Near and far follow the camera every frame, from how far it is from what it looks at and how big the model is: close
 *  up nothing gets sliced off by the near plane, far out nothing drops past the far one (a fixed pair, set once when
 *  framing, cut the model away as you zoomed in on a big FBX). */
function ClipPlanes({ span }: { span: number }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: Controls | null };
  useFrame(() => {
    const d = controls ? camera.position.distanceTo(controls.target) : camera.position.length();
    const near = Math.max(d / 500, span * 1e-6, 1e-6), far = Math.max(d * 4 + span * 4, near * 10);
    if (Math.abs(camera.near - near) > near * 0.05 || Math.abs(camera.far - far) > far * 0.05) {
      camera.near = near; camera.far = far; camera.updateProjectionMatrix();
    }
  });
  return null;
}

/** Effects write geometry and textures straight into three (positions, UVs, colours): any store change asks for a frame. */
function Redraw() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => useApp.subscribe(() => invalidate()), [invalidate]);
  return null;
}

/** Blender's Workbench resolve, every frame: the view drawn to a buffer (linear colour), the part meshes' view-space
 *  normals, ids and depth to another, then per pixel World cavity (workbench_cavity: Alchemy SSAO, 16 disk samples a
 *  frame) and Screen curvature (workbench_curvature: normals a pixel apart, soft-clamped), applied as Blender does on
 *  the linear colour: × clamp((1 − cavity)(1 + edges)(1 + curvature), 0, 4). While nothing changes it draws TAA − 1
 *  more frames, each jittered under a pixel and with the next 16 cavity samples, and averages them (Blender's TAA):
 *  edges come out smooth and the cavity without noise. Lengths are in halves of the model (Blender's default cube). */
const TAA = 8, SSAO = 16;
const halton = (i: number, b: number) => { let f = 1, r = 0; for (; i > 0; i = Math.floor(i / b)) { f /= b; r += f * (i % b); } return r; };
// Blender's disk samples (load_samples_buf): Hammersley angle, radius stepped so each frame's 16 cover the disk
const DISK = Array.from({ length: TAA * SSAO }, (_, i) => {
  const add = Math.floor(i / SSAO) * 0.499, r = ((i + 0.5 + add) / SSAO) % 1, phi = halton(i, 2) * 2 * Math.PI + add;
  return new THREE.Vector3(Math.cos(phi), Math.sin(phi), r);
});
const QUAD_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const RESOLVE_FRAG = /* glsl */ `
uniform sampler2D color, normals, depth, prev;
uniform vec3 disk[${TAA * SSAO}];
uniform int start;
uniform float blend, curvRidge, curvValley, cavRidge, cavValley, dist, unit, curvWidth, dpr;
uniform bool useCurv, useCav, useOutline, tone;
uniform vec3 outlineColor;
#include <tonemapping_pars_fragment>
uniform vec2 px;
uniform mat4 proj, projInv;
varying vec2 vUv;
float softClamp(float c, float k) { return c < 0.5 / k ? c * (1.0 - c * k) : 0.25 / k; }
vec3 toView(vec2 uv, float d) { vec4 v = projInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0); return v.xyz / v.w; }
void main() {
  vec3 c = texture2D(color, vUv).rgb;
  vec4 nd = texture2D(normals, vUv);
  if (nd.a > 0.0) {
    float cav = 0.0, edges = 0.0, curv = 0.0;
    if (useCav) {
      float d = texture2D(depth, vUv).r;
      vec3 P = toView(vUv, d), N = nd.xyz;
      // per-pixel rotation and radius offset (Blender: a blue-noise texture; here interleaved gradient noise)
      float a = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float b = clamp(fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5, -0.499, 0.499) / ${TAA * SSAO}.0;
      vec2 rotX = vec2(cos(a), sin(a)), rotY = vec2(-rotX.y, rotX.x);
      vec2 off = vec2(proj[0][0], proj[1][1]) * dist * unit / (proj[2][3] * P.z + proj[3][3]) * 0.5;
      for (int i = 0; i < ${SSAO}; i++) {
        vec3 s = disk[start + i];
        vec2 uv = vUv + vec2(dot(s.xy, rotX), dot(s.xy, rotY)) * (s.z + b) * off;
        if (any(greaterThan(abs(uv - 0.5), vec2(0.5)))) continue;
        float sd = texture2D(depth, uv).r;
        bool bg = sd == 1.0;
        vec3 sp = toView(uv, bg ? d : sd);
        if (bg) sp.z -= dist * unit;
        vec3 dir = (sp - P) / unit;
        float len = length(dir);
        if (len < 1e-6) continue;
        float fc = dot(dir, N), bias = 0.05 * len + 0.0001, att = 1.0 / (len * (1.0 + len * len));
        if (fc > -bias) cav += fc * att;
        if (-fc > bias) edges -= fc * att;
      }
      cav = clamp(cav / ${SSAO}.0 * cavValley, 0.0, 1.0);
      edges = edges / ${SSAO}.0 * cavRidge;
    }
    if (useCurv) {
      // Blender samples 1 px apart, which fades as you zoom in (a bevel spreads over many pixels); here the spacing is
      // a fixed share of the model on screen, never under 1 px (Blender's look when it's small) nor over 4 px
      float z = -toView(vUv, texture2D(depth, vUv).r).z;
      vec2 o = px * clamp(curvWidth * unit * proj[1][1] * 0.5 / (z * px.y), dpr, 4.0 * dpr);
      vec4 u = texture2D(normals, vUv + vec2(0.0, o.y)), dn = texture2D(normals, vUv - vec2(0.0, o.y));
      vec4 r = texture2D(normals, vUv + vec2(o.x, 0.0)), l = texture2D(normals, vUv - vec2(o.x, 0.0));
      if (u.a == dn.a && r.a == l.a && !(u.a == 0.0 && r.a == 0.0)) {
        float diff = (u.y - dn.y) + (r.x - l.x);
        curv = diff < 0.0 ? -2.0 * softClamp(-diff, curvValley) : 2.0 * softClamp(diff, curvRidge);
      }
    }
    c *= clamp((1.0 - cav) * (1.0 + edges) * (1.0 + curv), 0.0, 4.0);
    if (useOutline) {
      // silhouette from the part ids in the normals buffer: a neighbouring pixel that is background or another part
      // is an edge. A 1 px mix keeps the whole surface clean (a wireframe is its own overlay, not this).
      vec4 l = texture2D(normals, vUv - vec2(px.x, 0.0)), r = texture2D(normals, vUv + vec2(px.x, 0.0));
      vec4 u = texture2D(normals, vUv - vec2(0.0, px.y)), d = texture2D(normals, vUv + vec2(0.0, px.y));
      float edge = max(max(abs(l.a - nd.a), abs(r.a - nd.a)), max(abs(u.a - nd.a), abs(d.a - nd.a)));
      c = mix(c, outlineColor, step(0.5, edge));
    }
  }
  // The display transform before the frames are averaged, never after: a lit surface is brighter than 1, so an edge
  // pixel averaged in HDR (half a 2.0 surface, half a dark background: 1.0) tone-maps or clips to the surface's own
  // white and the edge stays as hard as with no antialiasing at all.
  c = clamp(tone ? ACESFilmicToneMapping(c) : c, 0.0, 1.0);
  gl_FragColor = vec4(mix(texture2D(prev, vUv).rgb, c, blend), 1.0);
}`;
// the frames are already display-referred (tone mapped in the resolve): the blit only encodes them for the screen
const BLIT_FRAG = 'uniform sampler2D tex; varying vec2 vUv; void main() { gl_FragColor = texture2D(tex, vUv);\n#include <colorspace_fragment>\n}';

/** Two camera matrices alike to well under a pixel: each element within 1e-6 of its own size (a view matrix of a model
 *  thousands of units from the origin holds thousands in its translation). */
const same = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) <= 1e-6 * Math.max(1, Math.abs(v)));

/** Overlays that move outside the store (the brush cursor, the Draw rubber band, the Decal gizmo's screen-sized
 *  handles) set this, so the Workbench's frame accumulation starts again instead of leaving their old place ghosted in. */
const bench = { dirty: false };
function Workbench({ curvature, cavity, outline, outlineColor, ridge, valley, distance, span, toneMap }: { curvature: boolean; cavity: boolean; outline: boolean; outlineColor: string; ridge: number; valley: number; distance: number; span: number; toneMap: boolean }) {
  const { gl, scene, camera, size, invalidate } = useThree();
  const res = useMemo(() => {
    const half = { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    const color = new THREE.WebGLRenderTarget(1, 1, { ...half, samples: 4 });
    // 24-bit depth: a float depth texture beside a half-float colour isn't a framebuffer every driver takes
    const normalRT = new THREE.WebGLRenderTarget(1, 1, { ...half, depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType) });
    const accum = [new THREE.WebGLRenderTarget(1, 1, half), new THREE.WebGLRenderTarget(1, 1, half)];
    const normals = new THREE.ShaderMaterial({
      uniforms: { id: { value: 0 } }, side: THREE.DoubleSide,
      vertexShader: 'varying vec3 vN; void main() { vN = normalMatrix * normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float id; varying vec3 vN; void main() { vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0); gl_FragColor = vec4(n, id); }',
    });
    const resolve = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: color.texture }, normals: { value: normalRT.texture }, depth: { value: normalRT.depthTexture }, prev: { value: null },
        disk: { value: DISK }, start: { value: 0 }, blend: { value: 1 }, curvRidge: { value: 0.5 }, curvValley: { value: 0.7 }, cavRidge: { value: 1 }, cavValley: { value: 1 },
        // curvature spacing in halves of the model: 1 px when the model spans ~330 px, the size that looked right
        dist: { value: 0.2 }, unit: { value: 1 }, curvWidth: { value: 0.006 }, dpr: { value: 1 }, useCurv: { value: false }, useCav: { value: false }, useOutline: { value: false }, outlineColor: { value: new THREE.Color('#e6e6e6') }, px: { value: new THREE.Vector2() },
        proj: { value: new THREE.Matrix4() }, projInv: { value: new THREE.Matrix4() }, tone: { value: true }, toneMappingExposure: { value: 1 },
      },
      depthTest: false, depthWrite: false, vertexShader: QUAD_VERT, fragmentShader: RESOLVE_FRAG,
    });
    const blit = new THREE.ShaderMaterial({ uniforms: { tex: { value: null } }, depthTest: false, depthWrite: false, toneMapped: false, vertexShader: QUAD_VERT, fragmentShader: BLIT_FRAG });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), resolve);
    quad.frustumCulled = false;
    return { color, normalRT, accum, normals, resolve, blit, quad, ortho: new THREE.Camera() };
  }, []);
  useEffect(() => () => {
    for (const t of [res.color, res.normalRT, ...res.accum]) t.dispose();
    res.normalRT.depthTexture?.dispose();
    for (const m of [res.normals, res.resolve, res.blit]) m.dispose();
    res.quad.geometry.dispose();
  }, [res]);
  // a change to any of these starts the accumulation again (the store subscription and `bench` catch the rest)
  const st = useRef({ k: 0, ours: false, dirty: true, checked: false, view: new THREE.Matrix4(), proj: new THREE.Matrix4() });
  useEffect(() => useApp.subscribe(() => { st.current.dirty = true; }), []);
  useEffect(() => {
    const u = res.resolve.uniforms;
    // Blender: curvature control = 0.5 / ridge², 0.7 / valley²; the cavity factors as they are
    u.curvRidge.value = 0.5 / Math.max(ridge * ridge, 1e-4); u.curvValley.value = 0.7 / Math.max(valley * valley, 1e-4);
    u.cavRidge.value = ridge; u.cavValley.value = valley; u.dist.value = distance; u.unit.value = span / 2;
    u.useCurv.value = curvature; u.useCav.value = cavity;
    u.useOutline.value = outline; (u.outlineColor.value as THREE.Color).set(outlineColor);
    u.tone.value = toneMap;
    st.current.dirty = true;
    invalidate();
  }, [res, ridge, valley, distance, span, curvature, cavity, outline, outlineColor, toneMap, invalidate]);

  // priority 1: the frame's drawing is ours
  useFrame(() => {
    const s = st.current, dpr = gl.getPixelRatio(), W = Math.round(size.width * dpr), H = Math.round(size.height * dpr);
    if (res.color.width !== W || res.color.height !== H) { for (const t of [res.color, res.normalRT, ...res.accum]) t.setSize(W, H); s.dirty = true; }
    camera.updateMatrixWorld();
    if (bench.dirty) { s.dirty = true; bench.dirty = false; }
    // OrbitControls' damping keeps nudging the camera by ever smaller amounts long after an orbit: compared exactly,
    // every nudge restarted the frames, so after any orbit the view stayed on its first, unaveraged frame (aliased) and
    // never stopped drawing. A camera within a ten-thousandth of a pixel's worth is the same camera.
    const moved = !same(s.view, camera.matrixWorldInverse) || !same(s.proj, camera.projectionMatrix);
    if (!s.ours || s.dirty || moved) { s.k = 0; s.view.copy(camera.matrixWorldInverse); s.proj.copy(camera.projectionMatrix); }
    s.ours = false; s.dirty = false;
    const k = s.k, P = camera.projectionMatrix as THREE.Matrix4, Pi = (camera as THREE.PerspectiveCamera).projectionMatrixInverse;
    const keep = P.clone(), keepInv = Pi.clone();
    // under a pixel: Halton (2, 3), the first frame unjittered
    if (k > 0) { P.elements[8] += ((halton(k + 1, 2) - 0.5) * 2) / W; P.elements[9] += ((halton(k + 1, 3) - 0.5) * 2) / H; Pi.copy(P).invert(); }

    gl.setRenderTarget(res.color); gl.render(scene, camera);
    if (curvature || cavity || outline) {
      // each part mesh its own id, so the outline knows where one part ends and the next begins (and cavity doesn't
      // draw an edge between parts that merely touch)
      let id = 0;
      const tagged: [THREE.Object3D, THREE.Object3D['onBeforeRender']][] = [];
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !o.layers.isEnabled(SOLID)) return;
        const mine = ++id;
        tagged.push([o, o.onBeforeRender]);
        o.onBeforeRender = () => { res.normals.uniforms.id.value = mine; res.normals.uniformsNeedUpdate = true; };
      });
      const [over, bg, layers, clear, alpha] = [scene.overrideMaterial, scene.background, camera.layers.mask, gl.getClearColor(new THREE.Color()), gl.getClearAlpha()];
      scene.overrideMaterial = res.normals; scene.background = null; camera.layers.set(SOLID);
      gl.setRenderTarget(res.normalRT); gl.setClearColor(0x000000, 0); gl.clear(); gl.render(scene, camera);
      if (!s.checked) {
        s.checked = true;
        const c = gl.getContext(), status = c.checkFramebufferStatus(c.FRAMEBUFFER);
        if (status !== c.FRAMEBUFFER_COMPLETE) console.warn(`Cavity: this GPU won't draw the normals buffer (framebuffer status 0x${status.toString(16)}), so there is no cavity`);
      }
      scene.overrideMaterial = over; scene.background = bg; camera.layers.mask = layers; gl.setClearColor(clear, alpha);
      for (const [o, f] of tagged) o.onBeforeRender = f;
    } else { gl.setRenderTarget(res.normalRT); gl.clear(); }

    const u = res.resolve.uniforms, [read, write] = [res.accum[k % 2], res.accum[(k + 1) % 2]];
    u.proj.value.copy(P); u.projInv.value.copy(Pi); u.start.value = (k % TAA) * SSAO; u.blend.value = 1 / (k + 1);
    u.prev.value = read.texture; u.px.value.set(1 / W, 1 / H); u.dpr.value = dpr; u.toneMappingExposure.value = gl.toneMappingExposure;
    res.quad.material = res.resolve; gl.setRenderTarget(write); gl.render(res.quad, res.ortho);
    res.blit.uniforms.tex.value = write.texture;
    res.quad.material = res.blit; gl.setRenderTarget(null); gl.render(res.quad, res.ortho);

    P.copy(keep); Pi.copy(keepInv);
    if (k + 1 < TAA) { s.k = k + 1; s.ours = true; invalidate(); }
  }, 1);
  return null;
}

function RendererExposure({ exposure }: { exposure: number }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = exposure; }, [gl, exposure]);
  return null;
}

/** Camera keys (frame, numpad views and steps) and the left-drag box select. */
function Navigation({ setBox, setLasso }: { setBox: (b: Box | null) => void; setLasso: (p: [number, number][] | null) => void }) {
  const { camera, gl, scene, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; gl: THREE.WebGLRenderer; scene: THREE.Scene; controls: Controls | null };
  const viewReq = useApp((s) => s.viewReq);
  const first = useRef(viewReq.n);
  // tools that drag in 3D (Poly Doc's G) turn mouse pixels into world units at a point's depth, in the camera's plane
  useEffect(() => {
    const fn = (dx: number, dy: number, at: [number, number, number]) => {
      const per = (2 * camera.position.distanceTo(new THREE.Vector3(...at)) * Math.tan((camera.fov * Math.PI) / 360)) / (gl.domElement.clientHeight || 1);
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      return right.multiplyScalar(dx * per).add(up.multiplyScalar(-dy * per)).toArray() as [number, number, number];
    };
    view3d.worldDelta = fn;
    // switching tools mounts the new view before the old 3D scene finishes unmounting: only take back our own hook
    return () => { if (view3d.worldDelta === fn) view3d.worldDelta = null; };
  }, [camera, gl]);

  useEffect(() => {
    if (!controls || viewReq.view !== '3d' || viewReq.n === first.current) return;
    look(camera, controls, viewReq.op);
  }, [viewReq, camera, controls]);

  useEffect(() => {
    const el = gl.domElement;
    const down = (e: PointerEvent) => {
      const s = useApp.getState();
      if (s.workspace === 'paint') return paintShape(e);
      if (s.workspace === 'rig') return; // no face selection in Geppetto: a drag only orbits or moves the gizmo
      if (e.button !== 0 || e.altKey || s.unfold > 0 || !s.result || s.docKnife) return;
      if (s.boxArmed) useApp.setState({ boxArmed: false });
      const r = el.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
      let b: Box | null = null;
      const move = (m: PointerEvent) => {
        const x1 = m.clientX - r.left, y1 = m.clientY - r.top;
        if (!b && Math.hypot(x1 - x0, y1 - y0) < 5) return;
        b = { x0, y0, x1, y1 };
        setBox(b);
      };
      const up = (u: PointerEvent) => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        setBox(null);
        if (b) boxSelect(camera, r.width, r.height, b, opOf(u, false), depthOf(gl, scene, camera, r.width, r.height, b));
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    };
    // Van Gogh's Marquee and Lasso on the model: drag a rectangle or a free shape; what's inside it on screen and seen
    // (not hidden behind other surface) is selected, texel by texel. A click without a drag deselects, as in Photoshop.
    const paintShape = (e: PointerEvent) => {
      const tool = useApp.getState().paint.tool;
      if (e.button !== 0 || e.ctrlKey || (tool !== 'marquee' && tool !== 'lasso') || !useApp.getState().result) return;
      const r = el.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top, mods: PaintMods = { shift: e.shiftKey, alt: e.altKey, ctrl: false };
      let pts: [number, number][] = [[x0, y0]];
      const move = (m: PointerEvent) => {
        const x = m.clientX - r.left, y = m.clientY - r.top;
        pts = tool === 'marquee' ? [[x0, y0], [x, y0], [x, y], [x0, y]] : [...pts, [x, y]];
        setLasso(pts);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        setLasso(null);
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        if (pts.length < 3 || Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) < 4) { if (!mods.shift && !mods.alt) deselectPaint(); return; }
        const seen = depthOf(gl, scene, camera, r.width, r.height, { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
        const v = new THREE.Vector3();
        selectPaintOnModel((x, y, z) => {
          v.set(x, y, z).project(camera);
          const sx = ((v.x + 1) / 2) * r.width, sy = ((1 - v.y) / 2) * r.height;
          return v.z < 1 && inside(pts, sx, sy) && seen(sx, sy, v.z);
        }, mods);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    };
    el.addEventListener('pointerdown', down);
    return () => el.removeEventListener('pointerdown', down);
  }, [gl, scene, camera, setBox, setLasso]);
  return null;
}

const AXES: Partial<Record<ViewOp, [number, number, number]>> = {
  front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 1e-4], bottom: [0, -1, 1e-4],
};

/** Alt+middle-drag owns its orbit gesture so snapped angles never fight OrbitControls' own drag deltas. */
function OrbitSnap() {
  const { camera, gl, controls, invalidate } = useThree() as unknown as { camera: THREE.PerspectiveCamera; gl: THREE.WebGLRenderer; controls: Controls | null; invalidate: () => void };
  useEffect(() => {
    if (!controls) return;
    const el = gl.domElement;
    let alt = false, shift = false, ctrl = false;
    let drag: (OrbitSnapStart & { pointerId: number }) | null = null;
    const sync = (e: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => { alt = e.altKey; shift = e.shiftKey; ctrl = e.ctrlKey || e.metaKey; };
    const down = (e: PointerEvent) => {
      sync(e);
      if (e.button !== 1 || !alt || shift || ctrl) return;
      const target = controls.target.clone(), offset = camera.position.clone().sub(target);
      if (!Number.isFinite(offset.lengthSq()) || offset.lengthSq() < 1e-12) return;
      const spherical = new THREE.Spherical().setFromVector3(offset);
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, theta: spherical.theta, phi: spherical.phi, radius: spherical.radius, target };
      e.preventDefault();
      e.stopImmediatePropagation();
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      sync(e);
      camera.position.copy(drag.target).add(snapOrbitOffset(drag, e.clientX - drag.x, e.clientY - drag.y, el.clientHeight));
      camera.lookAt(drag.target);
      controls.update();
      invalidate();
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      sync(e);
      drag = null;
    };
    const cancel = (e: PointerEvent) => { if (drag?.pointerId === e.pointerId) drag = null; };
    const blur = () => { drag = null; alt = shift = ctrl = false; };
    const key = (e: KeyboardEvent) => {
      const on = e.type === 'keydown';
      if (e.key === 'Alt') alt = on; else if (e.key === 'Shift') shift = on; else if (e.key === 'Control' || e.key === 'Meta') ctrl = on;
    };
    el.addEventListener('pointerdown', down, true);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', cancel);
    addEventListener('blur', blur);
    addEventListener('keydown', key);
    addEventListener('keyup', key);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', cancel);
      removeEventListener('blur', blur);
      removeEventListener('keydown', key);
      removeEventListener('keyup', key);
    };
  }, [camera, gl, controls, invalidate]);
  return null;
}

/** Frame everything or the selection, look along an axis, or orbit 15° (numpad 4 6 8 2). */
function look(camera: THREE.PerspectiveCamera, controls: Controls, op: ViewOp) {
  const target = controls.target, offset = camera.position.clone().sub(target), step = Math.PI / 12;
  // a camera that was never framed (or a lost fit) can sit on the target, or hold NaN: then frame from the default view
  if (!Number.isFinite(offset.lengthSq()) || offset.lengthSq() < 1e-12) offset.set(2.2, 1.6, 3);
  if (op === 'all' || op === 'selected') {
    const pts = framePoints(op === 'selected');
    if (!pts.length) return;
    const sphere = new THREE.Box3().setFromArray(pts).getBoundingSphere(new THREE.Sphere());
    const fov = Number.isFinite(camera.fov) && camera.fov > 0 ? camera.fov : 45;
    const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
    // fit the tighter of the vertical and horizontal fields, as Bounds did: a split or a tall window narrows the view
    const hFov = 2 * Math.atan(Math.tan((fov * Math.PI) / 360) * aspect);
    const r = Math.max(sphere.radius, 1e-3), dist = Math.max(r / Math.sin((fov * Math.PI) / 360), r / Math.sin(hFov / 2)) * 1.1;
    if (!Number.isFinite(dist)) return;
    target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(offset.normalize(), dist);
    // near and far follow from here every frame (ClipPlanes)
  } else if (AXES[op]) {
    camera.position.copy(target).addScaledVector(new THREE.Vector3(...AXES[op]!).normalize(), offset.length());
  } else if (op === 'orbit-left' || op === 'orbit-right') {
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), op === 'orbit-left' ? -step : step);
    camera.position.copy(target).add(offset);
  } else {
    const right = new THREE.Vector3().crossVectors(camera.up, offset).normalize();
    const turned = offset.clone().applyAxisAngle(right, op === 'orbit-up' ? -step : step);
    if (Math.abs(turned.clone().normalize().y) < 0.999) camera.position.copy(target).add(turned);
  }
  camera.lookAt(target);
  controls.update();
}

/** World points to frame: the selected vertices, or every visible part. */
function framePoints(selected: boolean): number[] {
  const s = useApp.getState(), c = liveSel(s);
  if (selected && c?.verts.size) {
    const t = topoOf(c.of), out: number[] = [];
    for (const v of c.verts) out.push(t.pos[v * 3], t.pos[v * 3 + 1], t.pos[v * 3 + 2]);
    return out;
  }
  return s.result ? s.result.parts.flatMap((p, i) => (s.parts[i]?.visible ? p.positions : [])) : [];
}

/** Layer the part meshes are also on, so the depth pass draws just them. */
const SOLID = 1;
/** The model's depth as the camera sees it (one pass of the part meshes), as a test: is this point in front, not
 *  hidden behind another surface? Box select leaves hidden elements alone, as Blender does outside X-ray. */
function depthOf(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, w: number, h: number, b: Box) {
  const dpr = gl.getPixelRatio(), W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  // plain depth in a float target (1 − z, so the cleared black reads as far)
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType }), mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
  const [over, bg, layers, clear, alpha] = [scene.overrideMaterial, scene.background, camera.layers.mask, gl.getClearColor(new THREE.Color()), gl.getClearAlpha()];
  scene.overrideMaterial = mat; scene.background = null; camera.layers.set(SOLID);
  gl.setRenderTarget(rt); gl.setClearColor(0x000000, 1); gl.clear(); gl.render(scene, camera); gl.setRenderTarget(null);
  scene.overrideMaterial = over; scene.background = bg; camera.layers.mask = layers; gl.setClearColor(clear, alpha);
  // read back just the box (and a little round it): the readback is what costs
  const clampX = (x: number) => Math.min(W, Math.max(0, x)), clampY = (y: number) => Math.min(H, Math.max(0, y));
  const x0 = clampX(Math.floor(Math.min(b.x0, b.x1) * dpr) - 2), x1 = clampX(Math.ceil(Math.max(b.x0, b.x1) * dpr) + 2);
  const y0 = clampY(Math.floor(Math.min(b.y0, b.y1) * dpr) - 2), y1 = clampY(Math.ceil(Math.max(b.y0, b.y1) * dpr) + 2);
  const rw = Math.max(1, x1 - x0), rh = Math.max(1, y1 - y0), buf = new Float32Array(rw * rh * 4);
  gl.readRenderTargetPixels(rt, x0, H - y1, rw, rh, buf);
  rt.dispose(); mat.dispose();
  const at = (x: number, y: number) => (x < x0 || x >= x1 || y < y0 || y >= y1 ? 1 : 1 - buf[((y1 - 1 - y) * rw + (x - x0)) * 4]);
  // in front if no surface within a pixel of it lies nearer (a vertex sits on its own faces' depth)
  return (sx: number, sy: number, z: number) => {
    const px = Math.round(sx * dpr), py = Math.round(sy * dpr);
    let far = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = px + dx, y = py + dy;
      if (x >= 0 && y >= 0 && x < W && y < H) far = Math.max(far, at(x, y));
    }
    return (z + 1) / 2 <= far + 1e-4;
  };
}

/** Box select: the mode's elements whose vertices (faces: centres) project inside the box and aren't hidden, on the
 *  part with most. */
function boxSelect(camera: THREE.Camera, w: number, h: number, b: Box, op: SelOp, seen: (sx: number, sy: number, z: number) => boolean) {
  const s = useApp.getState(), kind = kindOf(s.selectMode), [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)], [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
  const v = new THREE.Vector3(), inside = (x: number, y: number, z: number) => {
    v.set(x, y, z).project(camera);
    const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
    return v.z < 1 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 && seen(sx, sy, v.z);
  };
  let best: { part: number; ids: number[] } | null = null;
  s.result?.parts.forEach((p, part) => {
    if (!s.parts[part]?.visible) return;
    const t = topoOf(p.positions), vin = new Uint8Array(t.nv), ids: number[] = [];
    for (let i = 0; i < t.nv; i++) vin[i] = +inside(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]);
    if (kind === 'verts') for (let i = 0; i < t.nv; i++) { if (vin[i]) ids.push(i); }
    else if (kind === 'edges') for (let e = 0; e < t.ends.length / 2; e++) { if (vin[t.ends[e * 2]] && vin[t.ends[e * 2 + 1]]) ids.push(e); }
    else for (let f = 0; f < t.vid.length / 3; f++) {
      const q = p.positions, o = f * 9;
      if (inside((q[o] + q[o + 3] + q[o + 6]) / 3, (q[o + 1] + q[o + 4] + q[o + 7]) / 3, (q[o + 2] + q[o + 5] + q[o + 8]) / 3)) ids.push(f);
    }
    if (ids.length && (!best || ids.length > best.ids.length)) best = { part, ids };
  });
  const hit = best as { part: number; ids: number[] } | null;
  if (hit) selectElems(hit.part, hit.ids, op);
  else if (op === 'set') clearSelection();
}

function Model({ result, unfold, studio, wireframe, showEdges, showVertices, showSeams }: { result: Output; unfold: number; studio: boolean; wireframe: boolean; showEdges: boolean; showVertices: boolean; showSeams: boolean }) {
  const parts = useApp((s) => s.parts), mode = useApp((s) => s.mode), textureResolution = useApp((s) => s.textureResolution), uvMap = useApp((s) => s.uvMap);
  useEffect(() => { checker.image = uvMapCanvas(uvMap, textureResolution); checker.needsUpdate = true; }, [uvMap, textureResolution]);
  // one shared frame for the flat layout: the UV square, sized to the whole model
  const frame = useMemo(() => {
    const box = new THREE.Box3();
    for (const p of result.parts) box.union(new THREE.Box3().setFromArray(p.positions));
    return box.getBoundingSphere(new THREE.Sphere());
  }, [result]);
  return <>{result.parts.map((p, i) => parts[i]?.visible && <PartMesh key={i} index={i} result={result} part={parts[i]} frame={frame} mode={mode} unfold={unfold} studio={studio} wireframe={wireframe} showEdges={showEdges} showVertices={showVertices} showSeams={showSeams} />)}</>;
}

function PartMesh({ index, result, part, frame, mode, unfold, studio, wireframe, showEdges, showVertices, showSeams }: { index: number; result: Output; part: Part; frame: THREE.Sphere; mode: Mode; unfold: number; studio: boolean; wireframe: boolean; showEdges: boolean; showVertices: boolean; showSeams: boolean }) {
  const out = result.parts[index];
  const uvs = useApp((s) => s.uvs[index]), uvRev = useApp((s) => s.uvRev), loading = useApp((s) => s.loading);
  const selectMode = useApp((s) => s.selectMode), csel = useApp((s) => liveSel(s)), sel = csel?.part === index ? csel : null;
  // Poly Doc: plain grey and the wire always on, as Blender's edit mode shows a mesh
  const doc = useApp((s) => s.workspace === 'doc'), paint = useApp((s) => s.workspace === 'paint'), rig = useApp((s) => s.workspace === 'rig');
  // Geppetto: the bone each triangle follows, and in Pose the model moved by the bones
  const bind = useApp((s) => (rig ? s.rig.bind[index] : undefined)), bones = useApp((s) => s.rig.bones);
  const pickedPart = useApp((s) => rig && s.activePart === index && !s.rigChain && s.rigTool === 'select');
  const pose = useApp((s) => (rig && s.rigMode === 'pose' ? s.pose : null)), boneTint = useApp((s) => rig && s.rigView === 'bones');
  const triBone = useMemo(() => (rig ? trianglesBones(out.source, bind) : null), [rig, out, bind]);
  const weights = useMemo(() => (pose && triBone ? vertexWeights(weldCorners(out.positions).vi, weldCorners(out.positions).n, triBone) : null), [!!pose, triBone, out]); // eslint-disable-line react-hooks/exhaustive-deps
  useApp((s) => (paint ? s.paintRev : 0)); // a layer or channel change redraws
  useApp((s) => (paint ? s.paintLive : 0)); // a live stroke redraws without rebuilding the panel
  const paintAO = useApp((s) => s.paintAO);
  const ts = paint ? texSet(index) : null, pbr = !!ts?.channels.includes('rough'), normal = !!ts?.channels.includes('normal');
  const docView = useApp((s) => (s.workspace === 'doc' ? s.docView : null)), smooth = docView === 'smooth' || paint, // Van Gogh shades smooth, as the game (and Substance) will
    sharp = useApp((s) => s.params.sharp);
  const uvReady = !loading || !!loading.done[index];
  const invalidate = useThree((s) => s.invalidate), camera = useThree((s) => s.camera);

  const { geo, p3, stretch, islands } = useMemo(() => {
    const p3 = new Float32Array(out.positions), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p3.slice(), 3));
    const perCorner = (f: (t: number) => [number, number, number]) => {
      const a = new Float32Array(p3.length);
      for (let t = 0; t < out.stretch.length; t++) { const rgb = f(t); for (let k = 0; k < 3; k++) a.set(rgb, t * 9 + k * 3); }
      return new THREE.BufferAttribute(a, 3);
    };
    return { geo, p3, stretch: perCorner((t) => stretchColor(out.stretch[t])), islands: perCorner((t) => islandColor(out.island[t])) };
  }, [out]);
  useEffect(() => () => geo.dispose(), [geo]);

  // the unfold morph: built when first needed, rebuilt when the layout changes
  const morph = useRef<{ key: unknown[]; m: Morph } | null>(null);
  // the unfold the normals were last computed at
  const shaded = useRef(0);
  // positions: on the model, or (unfold) rolled out toward the UV layout laid flat
  useEffect(() => {
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const pos = geo.attributes.position.array as Float32Array;
    if (unfold === 0 && pose && weights) deform(p3, weights, skinMatrices(bones, poseMatrices(bones, pose)), pos);
    else if (unfold === 0) pos.set(p3);
    else {
      const key = [p3, uvs, uvRev, frame];
      if (!morph.current || morph.current.key.some((k, i) => k !== key[i])) {
        const { center: c, radius: r } = frame, flat = new Float32Array(p3.length);
        for (let i = 0; i < p3.length / 3; i++) {
          flat[i * 3] = c.x + (uvs[i * 2] - 0.5) * 2.4 * r;
          flat[i * 3 + 1] = c.y + (uvs[i * 2 + 1] - 0.5) * 2.4 * r;
          flat[i * 3 + 2] = c.z;
        }
        morph.current = { key, m: new Morph(p3, flat, uvs) };
      }
      morph.current.m.at(unfold, pos);
    }
    geo.attributes.position.needsUpdate = true;
    // the raycast (and culling) tests these first: left from an unfolded frame, clicks on the model missed it
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    // normals follow the positions: a UV edit alone (most of them) leaves them as they are
    if (pose) { geo.computeVertexNormals(); shaded.current = -1; } // posed: flat normals, made again on the way back
    else if (unfold !== 0 || !geo.attributes.normal || shaded.current !== 0) { geo.computeVertexNormals(); shaded.current = unfold; }
    invalidate();
  }, [geo, p3, uvs, uvRev, frame, unfold, invalidate, pose, weights, bones]);

  // Poly Doc's Health view: each face green (solid) to red (fix)
  const healthy = docView === 'health' && uvReady;
  const healthAttr = useMemo(() => {
    if (!healthy) return null;
    const g = { soup: part.soup, ...(part.poly && part.sides ? { poly: part.poly, sides: part.sides } : ownPolygons(part.soup.length / 9)) };
    const score = health(out, g), a = new Float32Array(out.positions.length);
    for (let t = 0; t < score.length; t++) { const rgb = healthColor(score[t]); for (let k = 0; k < 3; k++) a.set(rgb, t * 9 + k * 3); }
    return new THREE.BufferAttribute(a, 3);
  }, [healthy, out, part.soup, part.poly, part.sides]);
  // the faces' colour: the view's colour mode (Blender's Color); cavity is a screen pass (Workbench)
  const sc = useApp((s) => s.scene), docColor = useApp((s) => s.docColor);
  const colour = paint ? 'paint' : doc ? (healthy ? 'health' : docColor) : rig ? (boneTint ? 'bones' : 'single') : mode;
  const colorAttr = useMemo(() => {
    if (!uvReady) return null;
    const n = out.positions.length / 3, a = new Float32Array(n * 3);
    const base = colour === 'health' ? healthAttr?.array : colour === 'islands' ? islands.array : colour === 'stretch' ? stretch.array : null;
    if (colour === 'bones' && triBone) {
      const grey = [0.55, 0.55, 0.55];
      for (let c = 0; c < n; c++) { const b = triBone[(c / 3) | 0]; a.set(b >= 0 ? boneColor(b).toArray() : grey, c * 3); }
      return new THREE.BufferAttribute(a, 3);
    }
    const plain = colour === 'random' ? islandColor(index * 5 + 2) : colour === 'single' ? [0.8, 0.8, 0.8] : [1, 1, 1]; // Blender's Single default
    for (let c = 0; c < n; c++) a.set(base ? base.subarray(c * 3, c * 3 + 3) : plain, c * 3);
    return new THREE.BufferAttribute(a, 3);
  }, [uvReady, out, colour, healthAttr, islands, stretch, index, triBone]);
  useEffect(() => { if (colorAttr) geo.setAttribute('color', colorAttr); }, [geo, colorAttr]);

  const topo = useMemo(() => topoOf(out.positions), [out.positions]);
  // the file's polygons: an edge inside one (a quad's diagonal, an n-gon's fan) isn't drawn, as in Blender
  const pid = useMemo(() => polygonsOf(out.source, part.poly), [out.source, part.poly]);
  const seams = useMemo(() => lineGeo(new Float32Array(part.seams)), [part.seams]);
  // edit-mode overlays: the wire, every vertex (vertex mode), and the selection
  const edgesOf = (ids: Iterable<number>) => {
    const a: number[] = [];
    for (const e of ids) for (const v of [topo.ends[e * 2], topo.ends[e * 2 + 1]]) a.push(topo.pos[v * 3], topo.pos[v * 3 + 1], topo.pos[v * 3 + 2]);
    return lineGeo(new Float32Array(a));
  };
  // on the model, each polygon shades as one face (its triangles' area-weighted normal), as Blender draws a quad or an
  // n-gon that isn't quite flat; runs after the positions effect above, which only resets normals when unfolding
  useEffect(() => {
    if (unfold !== 0 || pose) return;
    const sum = new Map<number, number[]>(), n = new Float32Array(p3.length), tris = p3.length / 9;
    const cross = (t: number) => {
      const o = t * 9, ux = p3[o + 3] - p3[o], uy = p3[o + 4] - p3[o + 1], uz = p3[o + 5] - p3[o + 2], vx = p3[o + 6] - p3[o], vy = p3[o + 7] - p3[o + 1], vz = p3[o + 8] - p3[o + 2];
      return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    };
    for (let t = 0; t < tris; t++) {
      const c = cross(t), key = pid[t] < 0 ? -1 - t : pid[t], s = sum.get(key);
      if (s) for (let k = 0; k < 3; k++) s[k] += c[k]; else sum.set(key, c);
    }
    const unit = new Map<number, number[]>();
    for (const [key, s] of sum) { const l = Math.hypot(s[0], s[1], s[2]) || 1; unit.set(key, [s[0] / l, s[1] / l, s[2] / l]); }
    const keyOf = (t: number) => (pid[t] < 0 ? -1 - t : pid[t]), cos = Math.cos((sharp * Math.PI) / 180);
    // Smooth with the file's own normals (Blender's shading: its smoothing, sharp edges, custom normals): each output
    // triangle's corner takes the normal of the nearest corner of the file triangle it came from
    const fileN = smooth && part.normals?.length === part.soup.length ? outNormals(p3, out.source, part.soup, part.normals) : null;
    for (let t = 0; t < tris; t++) {
      const own = unit.get(keyOf(t))!;
      for (let k = 0; k < 3; k++) {
        let v = own;
        const o = t * 9 + k * 3;
        if (fileN && !Number.isNaN(fileN[o])) v = [fileN[o], fileN[o + 1], fileN[o + 2]];
        else if (smooth) {
          // the polygons round this corner that meet its own at less than Sharp edges, each once, by area
          const s = [0, 0, 0], seen = new Set<number>();
          for (const f of trisOf(topo, topo.vid[t * 3 + k])) {
            const key = keyOf(f), u = unit.get(key)!;
            if (seen.has(key) || u[0] * own[0] + u[1] * own[1] + u[2] * own[2] < cos) continue;
            seen.add(key);
            const w = sum.get(key)!;
            for (let i = 0; i < 3; i++) s[i] += w[i];
          }
          const l = Math.hypot(s[0], s[1], s[2]);
          if (l) v = [s[0] / l, s[1] / l, s[2] / l];
        }
        n.set(v, t * 9 + k * 3);
      }
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  }, [geo, p3, pid, unfold, uvs, uvRev, smooth, sharp, topo, out.source, part.normals, part.soup, pose]);
  const flatNow = unfold === 0;
  // Poly Doc's poles as dots: blue below the regular valence, red above it (4 for quads, 6 for triangles)
  const showPoles = useApp((s) => s.showPoles && s.workspace === 'doc');
  const poleDots = useMemo(() => {
    if (!showPoles || !flatNow) return null;
    const g = { soup: part.soup, ...(part.poly && part.sides ? { poly: part.poly, sides: part.sides } : ownPolygons(part.soup.length / 9)) };
    const p = poles(g), t = topoOfSoup(part.soup), xyz: number[] = [], rgb: number[] = [];
    for (const [vs, c] of [[p.low, [0.25, 0.6, 1]], [p.high, [1, 0.3, 0.25]]] as const) for (const v of vs) { xyz.push(t.pos[v * 3], t.pos[v * 3 + 1], t.pos[v * 3 + 2]); rgb.push(...c); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(rgb, 3));
    return geo;
  }, [showPoles, flatNow, part.soup, part.poly, part.sides]);
  useEffect(() => () => poleDots?.dispose(), [poleDots]);
  const shown = useCallback((e: number) => {
    const [a, b] = topo.edgeTris[e];
    return b === undefined || pid[a] < 0 || pid[a] !== pid[b];
  }, [topo, pid]);
  const wire = useMemo(() => edgesOf(Array.from({ length: topo.ends.length / 2 }, (_, i) => i).filter(shown)), [topo, shown]);
  const allVerts = useMemo(() => lineGeo(new Float32Array(topo.pos)), [topo]);
  // selected edges as thick lines (WebGL draws plain lines 1 px wide)
  const selEdges = useMemo(() => (sel?.edges.size ? [...sel.edges].filter(shown).flatMap((e) => [topo.ends[e * 2], topo.ends[e * 2 + 1]].map((v) => [topo.pos[v * 3], topo.pos[v * 3 + 1], topo.pos[v * 3 + 2]] as [number, number, number])) : null), [sel, topo, shown]);
  const selVerts = useMemo(() => (sel ? lineGeo(new Float32Array([...sel.verts].flatMap((v) => [topo.pos[v * 3], topo.pos[v * 3 + 1], topo.pos[v * 3 + 2]]))) : null), [sel, topo]);
  const selFaces = useMemo(() => {
    if (!sel?.faces.size) return null;
    const tris: number[] = [];
    for (const f of sel.faces) tris.push(...out.positions.slice(f * 9, f * 9 + 9));
    return lineGeo(new Float32Array(tris));
  }, [sel, out]);
  useEffect(() => () => { for (const g of [seams, wire, allVerts, selVerts, selFaces]) g?.dispose(); }, [seams, wire, allVerts, selVerts, selFaces]);
  // Van Gogh: what a Bucket / Wand click or a dropped material would take, tinted and outlined
  const hoverTris = useApp((s) => (paint && s.paintHover?.part === index ? s.paintHover.tris : null));
  // triangles as a fill and their outline
  const outlined = (tris: number[]) => {
    const fill = new Float32Array(tris.length * 9), count = new Map<number, number>();
    tris.forEach((t, k) => {
      for (let j = 0; j < 9; j++) fill[k * 9 + j] = out.positions[t * 9 + j];
      for (let c = 0; c < 3; c++) { const e = topo.edge[t * 3 + c]; count.set(e, (count.get(e) ?? 0) + 1); }
    });
    const border = [...count].filter(([, n]) => n === 1).flatMap(([e]) => [topo.ends[e * 2], topo.ends[e * 2 + 1]].map((v) => [topo.pos[v * 3], topo.pos[v * 3 + 1], topo.pos[v * 3 + 2]] as [number, number, number]));
    return { fill: lineGeo(fill), border };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hoverGeo = useMemo(() => (hoverTris ? outlined(hoverTris) : null), [hoverTris, out, topo]);
  useEffect(() => () => hoverGeo?.fill.dispose(), [hoverGeo]);
  const flat = unfold === 0 && !pose, editing = !paint && !rig && (doc || selectMode !== 'island');
  const hover = (e: ThreeEvent<PointerEvent>) => {
    // the nearest part under the mouse is the one hovered: parts behind it along the ray (R3F hands the move to
    // every hit) would otherwise overwrite the pointer, the brush cursor and the pick outline with the farthest
    e.stopPropagation();
    pointer.part = index; pointer.tri = e.faceIndex ?? -1;
    if (doc && useApp.getState().docKnife && e.faceIndex != null) { knifeHover(index, e.faceIndex, e.point.toArray(), e.ray.direction.toArray()); setHot(null); return; }
    hotAt(e);
    if (paint && e.face) { cursor.on = true; cursor.p.copy(e.point); cursor.n.copy(e.face.normal); bench.dirty = true; invalidate(); }
    if (shelfDrag.id) return; // a material held from the shelf: the drag outlines, it doesn't paint
    if (paint && !painting()) {
      const st = useApp.getState(), t = st.paint.tool;
      // the held material outlines what a click would put it on, as the Bucket / Wand outline what they'd take
      if (t === 'bucket' || t === 'wand' || (t === 'picker' && st.paint.grab)) paintHoverAt(index, e.faceIndex ?? -1);
      if (t === 'mirror') mirrorHover(index, e.faceIndex ?? -1, e.point.toArray());
    }
    if (!paint || e.buttons !== 1 || !e.uv || e.faceIndex == null) return;
    // a drag that began off the model starts painting where it comes onto it, as Photoshop paints from anywhere
    const tool = useApp.getState().paint.tool;
    if (painting()) paintDrag(index, e.point.toArray(), [e.uv.x, e.uv.y], e.pointerType === 'pen' ? e.pressure : 1, e.faceIndex, e.shiftKey);
    else if ((tool === 'brush' || tool === 'erase') && !e.ctrlKey && !e.altKey && paintPress(index, e.faceIndex, e.point.toArray(), [e.uv.x, e.uv.y], { shift: false, alt: false, ctrl: false, pressure: e.pressure, pen: e.pointerType === 'pen' })) addEventListener('pointerup', paintEnd, { once: true });
    invalidate();
  };
  // Van Gogh: the nearest hit takes the stroke; it ends wherever the button comes up
  const press = (e: ThreeEvent<PointerEvent>) => {
    // Geppetto: drag a part to move (or, for a hinge, turn) its own bone. A click without movement selects it.
    if (rig && e.button === 0 && e.faceIndex != null) {
      const s = useApp.getState();
      if (s.rigTool === 'select' && !s.rigPick && !s.rigGizmoOn) {
        const b = s.rig.bind[index]?.[out.source[e.faceIndex]] ?? -1, bone = s.rig.bones[b], part = s.parts[index];
        // a detail riding a shared parent bone is not dragged by dragging the detail: that would move its parent
        if (bone && part && bone.name === part.name) {
          const one = (r: [number, number]) => r[0] === r[1];
          const moveLocked = !!bone.move && one(bone.move.x) && one(bone.move.y) && one(bone.move.z);
          const rotLocked = !!bone.limit && one(bone.limit.x) && one(bone.limit.y) && one(bone.limit.z);
          if (!(s.rigMode === 'pose' && moveLocked && rotLocked)) {
            e.stopPropagation();
            rigClickLock.until = performance.now() + 250;
            rigStart.fn?.(b, s.rigMode === 'pose' && moveLocked ? 'tail' : 'body', e.nativeEvent.clientX, e.nativeEvent.clientY);
            return;
          }
        }
      }
    }
    if (!paint || e.button !== 0 || e.faceIndex == null || !e.uv || !uvReady || unfold !== 0) return;
    const tool = useApp.getState().paint.tool;
    if ((tool === 'marquee' || tool === 'lasso') && !e.ctrlKey) return; // the view draws the shape (Navigation)
    // A mark lands on the panel the artist sees. The material is double-sided, so a ray can otherwise hit the
    // inside of a slide through an opening and place a mark on a face that is never visible from here. Only when
    // placing: in edit mode a click picks the mark under it, which is what the same face shows.
    if (tool === 'decal' && e.face && useApp.getState().paint.decalMode === 'place' && !e.altKey && e.face.normal.dot(camera.position.clone().sub(e.point)) <= 0) return;
    e.stopPropagation();
    if (paintPress(index, e.faceIndex, e.point.toArray(), [e.uv.x, e.uv.y], { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, pressure: e.pressure, pen: e.pointerType === 'pen' })) addEventListener('pointerup', paintEnd, { once: true });
    invalidate();
  };


  // the corner and the drawn edge of triangle t nearest to point p: what a click there picks in vertex / edge mode
  const nearest = (t: number, p: THREE.Vector3) => {
    const c = [0, 1, 2].map((k) => new THREE.Vector3().fromArray(out.positions, t * 9 + k * 3));
    let be = 0, bd = Infinity, bv = 0, bvd = Infinity;
    for (let k = 0; k < 3; k++) {
      const d = new THREE.Line3(c[k], c[(k + 1) % 3]).closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p);
      if (d < bd && shown(topo.edge[t * 3 + k])) { bd = d; be = k; } // a polygon's hidden diagonal isn't an edge to pick
      const dv = c[k].distanceTo(p);
      if (dv < bvd) { bvd = dv; bv = k; }
    }
    return { vert: topo.vid[t * 3 + bv], edge: topo.edge[t * 3 + be] };
  };
  // a face is its whole polygon, as Blender picks it
  const polygonOf = (t: number) => (pid[t] < 0 ? [t] : pid.reduce<number[]>((a, p, f) => (p === pid[t] ? (a.push(f), a) : a), []));
  // what a click would pick, outlined under the mouse (vertex, edge, polygon or island), so a click never lands on the wrong one
  const [hot, setHot] = useState<{ kind: typeof selectMode; id: number; t: number } | null>(null);
  const hotAt = (e: ThreeEvent<PointerEvent>) => {
    const m = useApp.getState().selectMode, t = e.faceIndex;
    if (paint || rig || !uvReady || t == null || e.buttons || (!flat && (m === 'vert' || m === 'edge'))) { setHot(null); return; }
    const id = m === 'vert' ? nearest(t, e.point).vert : m === 'edge' ? nearest(t, e.point).edge : m === 'island' ? out.island[t] : pid[t] < 0 ? -1 - t : pid[t];
    setHot((h) => (h?.kind === m && h.id === id ? h : { kind: m, id, t }));
  };
  type V3 = [number, number, number];
  const hotGeo = useMemo((): { dot?: THREE.BufferGeometry; line?: V3[]; fill?: THREE.BufferGeometry; border?: V3[] } | null => {
    if (!hot || hot.kind !== selectMode) return null;
    const at = (v: number) => [topo.pos[v * 3], topo.pos[v * 3 + 1], topo.pos[v * 3 + 2]] as [number, number, number];
    if (hot.kind === 'vert') return { dot: lineGeo(new Float32Array(at(hot.id))) };
    if (hot.kind === 'edge') return { line: [at(topo.ends[hot.id * 2]), at(topo.ends[hot.id * 2 + 1])] };
    const tris = hot.kind === 'island' ? Array.from(out.island.keys()).filter((f) => out.island[f] === hot.id) : polygonOf(hot.t);
    return outlined(tris);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hot, selectMode, topo, out]);
  useEffect(() => () => { hotGeo?.dot?.dispose(); hotGeo?.fill?.dispose(); }, [hotGeo]);

  const click = (e: ThreeEvent<MouseEvent>) => {
    if (paint || (rig && rigMeshClick(index, e)) || pose) return;
    if (e.delta > 4 || e.faceIndex == null || e.button !== 0) return; // a drag, not a click
    if (doc && useApp.getState().docKnife) { e.stopPropagation(); knifeClick(index, e.faceIndex, e.point.toArray(), e.ray.direction.toArray()); return; }
    const progress = useApp.getState().loading;
    if (progress && !progress.done[index]) return;
    e.stopPropagation();
    const t = e.faceIndex, m = useApp.getState().selectMode;
    if (!flat && (m === 'vert' || m === 'edge')) return; // unfolded, the corners aren't where the model has them
    const { vert, edge } = nearest(t, e.point);
    if (e.altKey) { if (m === 'vert' || m === 'edge') void selectLoop(index, edge, e.shiftKey); return; }
    selectElems(index, m === 'vert' ? [vert] : m === 'edge' ? [edge] : polygonOf(t), opOf(e, true));
  };

  return (
    <group>
      <mesh geometry={geo} castShadow={paint} receiveShadow={paint} onUpdate={(m) => m.layers.enable(SOLID)} onClick={click} onPointerDown={press} onPointerMove={hover} userData={{ part: index }} onPointerOut={() => { setHot(null); if (pointer.part === index) { pointer.part = -1; cursor.on = false; if (useApp.getState().docKnife) knifeHover(-1, -1, [0, 0, 0], [0, 0, 0]); }if (useApp.getState().paintHover?.part === index) paintHoverAt(-1); if (useApp.getState().mirrorAim?.part === index) mirrorHover(-1); invalidate(); }}>
        {(() => {
          // Blender's Lighting: Studio (lights and the environment), MatCap (a lit sphere by normal), Flat (unlit)
          const key = `${colour}-${rig}-${uvReady}-${paint}-${pbr}-${normal}-${part.textured !== false}-${sc.lighting}-${sc.xray}`;
          const props = {
            color: uvReady ? '#ffffff' : '#888d92',
            map: ts && uvReady ? ts.preview ?? ts.color : !doc && !rig && uvReady && mode === 'checker' && part.textured !== false ? checker : null, vertexColors: !!colorAttr,
            side: sc.backface ? THREE.FrontSide : THREE.DoubleSide, wireframe, transparent: sc.xray, opacity: sc.xray ? sc.xrayAlpha : 1, depthWrite: !sc.xray,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
          };
          // Van Gogh in Studio: the real PBR material, as the game will light it: the set's roughness and metallic (glTF's G
          // and B) or, without PBR, a plain dielectric; the baked AO as its occlusion map (it darkens the ambient light only)
          const ao = paintAO && ts?.aoTex ? ts.aoTex : null;
          if (ts && sc.lighting === 'studio') return pbr
            ? <meshStandardMaterial key={`${key}-${!!ao}`} {...props} roughnessMap={ts.orm} metalnessMap={ts.orm} roughness={1} metalness={1} aoMap={ao} normalMap={normal ? ts.normal : null} normalScale={normal ? NORMAL_SCALE : undefined} />
            : <meshStandardMaterial key={`${key}-${!!ao}`} {...props} roughness={0.3} metalness={0} aoMap={ao} />; // Substance's default
          if (sc.lighting === 'matcap') return <meshMatcapMaterial key={key} {...props} matcap={matcapTexture(sc.matcap)} />;
          if (sc.lighting === 'flat') return <meshBasicMaterial key={key} {...props} />;
          // no plate: Blender's Solid Studio lighting itself (shading.ts), not three's lamps
          if (!studio) return <meshBasicMaterial key={`${key}-wb`} {...props} toneMapped={false} onBeforeCompile={studioShader} customProgramCacheKey={() => 'wb'} />;
          return <meshStandardMaterial key={key} {...props} roughness={sc.specular ? (studio && mode === 'checker' ? 0.46 : 0.55) : 1} metalness={sc.specular && studio && mode === 'checker' ? 0.03 : 0} dithering={studio} />;
        })()}
      </mesh>
      {flat && editing && showEdges && !smooth && <lineSegments geometry={wire}><lineBasicMaterial color="#000000" transparent opacity={0.35} /></lineSegments>}
      {poleDots && <points geometry={poleDots} renderOrder={4}><pointsMaterial size={7} sizeAttenuation={false} vertexColors /></points>}
      {/* Van Gogh in MatCap or Flat: the baked AO multiplied over the model (Studio takes it as the material's AO map) */}
      {flat && paintAO && ts?.aoTex && sc.lighting !== 'studio' && <mesh geometry={geo} renderOrder={1} raycast={() => null}><meshBasicMaterial map={ts.aoTex} blending={THREE.MultiplyBlending} premultipliedAlpha transparent toneMapped={false} depthWrite={false} polygonOffset polygonOffsetFactor={-1} side={THREE.DoubleSide} /></mesh>}
      {/* Van Gogh: what's outside the selection, shaded. These sit over the part's whole surface: they must not take a
          ray, or the mark under them (and every other tool) would stop being clickable. */}
      {flat && ts?.sel && <mesh geometry={geo} renderOrder={2} raycast={() => null}><meshBasicMaterial map={ts.shade} transparent depthWrite={false} polygonOffset polygonOffsetFactor={-1} side={THREE.DoubleSide} /></mesh>}
      {flat && hoverGeo && <mesh geometry={hoverGeo.fill} renderOrder={3} raycast={() => null}><meshBasicMaterial color={SEL} transparent opacity={0.3} depthWrite={false} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} /></mesh>}
      {flat && !!hoverGeo?.border.length && <Line points={hoverGeo.border} segments color={SEL} lineWidth={2.5} renderOrder={4} />}
      {flat && showSeams && !doc && !paint && !rig && <lineSegments geometry={seams}><lineBasicMaterial color={SEAM} /></lineSegments>}
      {flat && !paint && selFaces && (
        <mesh geometry={selFaces} renderOrder={2}>
          <meshBasicMaterial color={SEL} transparent opacity={0.45} depthWrite={false} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      )}
      {/* Geppetto: the part picked (what Add bone works on) */}
      {pickedPart && <mesh geometry={geo} renderOrder={2} raycast={() => null}><meshBasicMaterial color={SEL} transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1} /></mesh>}
      {flat && editing && !!selEdges?.length && <Line points={selEdges} segments color={SEL} lineWidth={2.5} renderOrder={3} />}
      {hotGeo?.fill && <mesh geometry={hotGeo.fill} renderOrder={3} raycast={() => null}><meshBasicMaterial color={HOT} transparent opacity={0.18} depthWrite={false} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} /></mesh>}
      {!!hotGeo?.border?.length && <Line points={hotGeo.border} segments color={HOT} lineWidth={1.5} renderOrder={4} raycast={() => null} />}
      {hotGeo?.line && <Line points={hotGeo.line} color={HOT} lineWidth={3} renderOrder={4} raycast={() => null} />}
      {hotGeo?.dot && <points geometry={hotGeo.dot} renderOrder={5} raycast={() => null}><pointsMaterial color={HOT} size={9} sizeAttenuation={false} /></points>}
      {flat && editing && showVertices && selectMode === 'vert' && <points geometry={allVerts}><pointsMaterial color="#111111" size={4} sizeAttenuation={false} /></points>}
      {flat && editing && showVertices && selectMode === 'vert' && selVerts && <points geometry={selVerts} renderOrder={4}><pointsMaterial color={SEL} size={6} sizeAttenuation={false} /></points>}
    </group>
  );
}


function lineGeo(xyz: Float32Array) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
  return g;
}


/** Where Van Gogh's brush is over the model: the point and the face's normal (set by the parts' hover). */
const cursor = { on: false, p: new THREE.Vector3(), n: new THREE.Vector3(0, 0, 1) };
const ring = (() => {
  const g = new THREE.BufferGeometry(), a: number[] = [];
  for (let k = 0; k < 64; k++) a.push(Math.cos((k / 64) * 2 * Math.PI), Math.sin((k / 64) * 2 * Math.PI), 0);
  g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
  return g;
})();
/** The brush on the surface, Substance's: a dashed ring where the dab ends, a solid one where it paints at full strength
 *  (hardness), lying on the face under the mouse. Brush and Eraser only. */
function BrushCursor() {
  const tool = useApp((s) => s.paint.tool), hardness = useApp((s) => s.paint.hardness);
  const g = useRef<THREE.Group>(null), z = new THREE.Vector3(0, 0, 1);
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    o.visible = cursor.on && (tool === 'brush' || tool === 'erase');
    o.position.copy(cursor.p).addScaledVector(cursor.n, brushRadius() * 0.02);
    o.quaternion.setFromUnitVectors(z, cursor.n);
    o.scale.setScalar(brushRadius() || 1);
  });
  return (
    <group ref={g} renderOrder={10}>
      <lineLoop geometry={ring} onUpdate={(l) => l.computeLineDistances()} renderOrder={10} raycast={() => null}>
        <lineDashedMaterial color="#ffffff" dashSize={0.09} gapSize={0.07} depthTest={false} transparent opacity={0.9} />
      </lineLoop>
      <lineLoop geometry={ring} scale={Math.max(0.02, hardness)} renderOrder={10} raycast={() => null}>
        <lineBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0.9} />
      </lineLoop>
    </group>
  );
}

/** A material held from the shelf (a pointer drag, not an HTML one: the app window takes those on Windows): over the
 *  model it outlines what it would cover (Face / Island / Part), let go there it fills it. True while over the model. */
export function shelfDragOver(x: number, y: number) {
  const h = pickAt.fn?.(x, y);
  paintHoverAt(h?.part ?? -1, h?.tri ?? -1);
  return !!h;
}
export function shelfDrop(id: string, x: number, y: number) {
  const h = pickAt.fn?.(x, y);
  if (h) paintHoverAt(h.part, h.tri);
  const onto = h && useApp.getState().paintHover;
  paintHoverAt(-1);
  if (onto) assignMaterial(id, false, onto);
}
/** A mark held from the decal shelf: over the model (a face turned toward the camera) its frame shows where and how big it
 *  lands (`DecalPreview`), let go there it is placed. True while it would land. */
export function decalDragOver(x: number, y: number) {
  const h = pickAt.fn?.(x, y);
  decalAim.at = h?.front ? h : null;
  pickAt.invalidate?.();
  return !!decalAim.at;
}
export function decalDrop(id: string, x: number, y: number) {
  const h = pickAt.fn?.(x, y);
  decalAim.at = null;
  pickAt.invalidate?.();
  if (h?.front) dropDecal(id, h.part, h.tri, h.point);
}
/** The mirror plane the artist is placing: a translucent square with drei's move/rotate gizmo on it. The gizmo writes
 *  the plane to the store as it moves (no unwrap yet); Apply in the options bar unwraps across it. The square takes no
 *  ray, so a click beside it still picks the model. */
function SymPlaneGizmo() {
  const plane = useApp((s) => s.symPlane), edit = useApp((s) => s.symEdit), result = useApp((s) => s.result);
  const uv = useApp((s) => s.workspace === 'uv'); // the mirror plane is UV Magician's: not drawn over Poly Doc or paint
  // one group for the life of the view: the gizmo attaches to it, so it must not be replaced by a re-render
  const group = useMemo(() => new THREE.Group(), []);
  const span = useMemo(() => modelDiagonal(), [result]);
  useEffect(() => {
    if (!plane) return;
    group.position.set(...plane.c);
    // only re-aim when the normal moved: turning the plane about its own axis leaves the mirror as it is, and
    // re-deriving the quaternion would make that rotation jump back
    const n = new THREE.Vector3(...plane.n).normalize();
    if (new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion).dot(n) < 0.999999) {
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    }
  }, [plane, group]);
  const sync = () => {
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion).normalize();
    moveSymPlane([group.position.x, group.position.y, group.position.z], [n.x, n.y, n.z]);
  };
  if (!plane || !uv) return null;
  const h = span * 0.5;
  const loop = [[1, 1], [1, -1], [-1, -1], [-1, 1], [1, 1]].map(([x, y]) => new THREE.Vector3(x * h, y * h, 0));
  return (
    <>
      <primitive object={group}>
        <mesh renderOrder={5} raycast={() => null}>
          <planeGeometry args={[span, span]} />
          <meshBasicMaterial color={SEL} transparent opacity={edit ? 0.16 : 0.1} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <Line points={loop} color={SEL} lineWidth={1.5} raycast={() => null} />
      </primitive>
      {edit && <TransformControls object={group} mode={edit.mode} space="world" size={0.85} onObjectChange={sync} />}
    </>
  );
}

/** Mirror tool: the selected mark's mirrored copy where a click would put it — its outline (the rectangle for an image
 *  mark) laid on the surface as the gizmo lays it, solid on the spot symmetric to the mark, dashed anywhere else. */
function MirrorPreview() {
  const aim = useApp((s) => (s.paint.tool === 'mirror' ? s.mirrorAim : null));
  if (!aim) return null;
  const d = aim.decal, f = decalFrame(d, modelDiagonal());
  const n = new THREE.Vector3(f.nx, f.ny, f.nz), ur = new THREE.Vector3(f.uxr, f.uyr, f.uzr), vr = new THREE.Vector3(f.vxr, f.vyr, f.vzr);
  const c = new THREE.Vector3(f.cx, f.cy, f.cz), fu = d.flipH ? -1 : 1, fv = d.flipV ? -1 : 1;
  const sh = d.shape, pts = sh?.outline ?? RECT_OUTLINE, open = !!sh && isLine(sh.pattern) && !sh.closed;
  const proj = surfaceProjector(useApp.getState().result?.parts[aim.part]?.positions), inward = n.clone().negate();
  const line = [...pts, ...(open ? [] : [pts[0]])].map(([x, y]) => {
    const pw = c.clone().addScaledVector(ur, x * fu * f.width / 2).addScaledVector(vr, y * fv * f.height / 2);
    return (proj?.ray(pw, inward, f.depth) ?? pw).addScaledVector(n, f.width * 0.004);
  });
  return <Line points={line} color={SEL} lineWidth={2} dashed={!aim.snapped} dashSize={f.width * 0.06} gapSize={f.width * 0.04} depthTest={false} renderOrder={12} raycast={() => null} />;
}

type Pick = { part: number; tri: number; point: [number, number, number]; normal: [number, number, number]; front: boolean };
const decalAim: { at: Pick | null } = { at: null };
/** The 3D view raycasts a screen point itself for the shelf drags (R3F's events only see the canvas's own pointer). */
const pickAt: { fn: ((x: number, y: number) => Pick | null) | null; invalidate?: () => void } = { fn: null };
function Picker() {
  const { camera, scene, gl, raycaster, invalidate } = useThree();
  useEffect(() => {
    pickAt.invalidate = invalidate;
    pickAt.fn = (x, y) => {
      const r = gl.domElement.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
      const hit = raycaster.intersectObjects(scene.children, true).find((h) => h.object.userData.part !== undefined && h.faceIndex != null);
      if (!hit?.face) return null;
      const n = hit.face.normal;
      return { part: hit.object.userData.part as number, tri: hit.faceIndex!, point: hit.point.toArray(), normal: n.toArray(), front: n.dot(camera.position.clone().sub(hit.point)) > 0 };
    };
    return () => { pickAt.fn = null; };
  }, [camera, scene, gl, raycaster, invalidate]);
  return null;
}
/** The polyline being drawn (Decal tool, Draw): its segments, a dot per corner, the first one ringed (a click there
 *  closes it), and a rubber band from the last corner to the pointer, all over the model until it is finished. */
function DrawnLine() {
  const pts = useApp((s) => s.drawLine);
  const band = useMemo(() => {
    const l = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SEL, depthTest: false, transparent: true, opacity: 0.6 }));
    l.renderOrder = 12; l.raycast = () => {};
    return l;
  }, []);
  const dots = useMemo(() => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts?.flat() ?? [], 3)), [pts]);
  useFrame(() => {
    const last = pts?.[pts.length - 1];
    if (!last) return;
    band.visible = cursor.on;
    bench.dirty = true;
    band.geometry.setAttribute('position', new THREE.Float32BufferAttribute([...last, cursor.p.x, cursor.p.y, cursor.p.z], 3));
  });
  if (!pts?.length) return null;
  return (
    <group>
      {pts.length > 1 && <Line points={pts} color={SEL} lineWidth={2} depthTest={false} renderOrder={12} raycast={() => null} />}
      <primitive object={band} />
      <points geometry={dots} renderOrder={13} raycast={() => null}><pointsMaterial color="#ffffff" size={6} sizeAttenuation={false} depthTest={false} /></points>
      <points renderOrder={13} raycast={() => null}><bufferGeometry attach="geometry" onUpdate={(g) => g.setAttribute('position', new THREE.Float32BufferAttribute(pts[0], 3))} /><pointsMaterial color={SEL} size={12} sizeAttenuation={false} depthTest={false} /></points>
    </group>
  );
}
/** Poly Doc's knife: the points clicked so far joined up, and a rubber band to the snapped point under the mouse. */
function KnifeLine() {
  const k = useApp((s) => s.docKnife);
  const dots = useMemo(() => lineGeo(new Float32Array([...(k?.pts ?? []), ...(k?.aim ? [k.aim] : [])].flatMap((q) => q.p))), [k]);
  useEffect(() => () => dots.dispose(), [dots]);
  if (!k) return null;
  const pts = k.pts.map((q) => q.p), aim = k.aim?.p;
  return (
    <group>
      {pts.length > 1 && <Line points={pts} color={SEL} lineWidth={2} depthTest={false} renderOrder={12} raycast={() => null} />}
      {aim && pts.length > 0 && <Line points={[pts[pts.length - 1], aim]} color={SEL} lineWidth={1.5} dashed dashSize={modelDiagonal() * 0.01} gapSize={modelDiagonal() * 0.006} depthTest={false} renderOrder={12} raycast={() => null} />}
      <points geometry={dots} renderOrder={13} raycast={() => null}><pointsMaterial color="#ffffff" size={7} sizeAttenuation={false} depthTest={false} /></points>
    </group>
  );
}
const unitRect = lineGeo(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]));
/** Where a mark dragged from the shelf would land: its frame on the face under the pointer, at the next mark's size and
 *  rotation (Decals tab), upright as `placeDecal` makes it. */
function DecalPreview() {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const o = g.current, at = decalAim.at;
    if (!o) return;
    o.visible = !!at;
    if (!at) return;
    const s = useApp.getState(), a = s.decals.find((d) => d.id === shelfDrag.id), w = (modelDiagonal() * s.paint.decalSize) / 100;
    const n = new THREE.Vector3(...at.normal).normalize(), up = new THREE.Vector3(...(Math.abs(n.y) > 0.94 ? [0, 0, 1] : [0, 1, 0]) as [number, number, number]);
    up.addScaledVector(n, -up.dot(n)).normalize();
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    o.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
    o.rotateZ((s.paint.decalRotation * Math.PI) / 180);
    o.position.set(...at.point).addScaledVector(n, w * 0.02);
    o.scale.set(w, w / (a ? a.width / a.height : 1), 1);
  });
  return (
    <group ref={g} visible={false}>
      <lineLoop geometry={unitRect} renderOrder={12} raycast={() => null}><lineBasicMaterial color={SEL} depthTest={false} transparent /></lineLoop>
    </group>
  );
}

/** What a Decal handle does when dragged: slide the mark, scale it uniformly, stretch one axis, turn it, or move one
 *  corner of a grip texture's outline (insert: a new corner on that edge). */
type DecalGrab = 'move' | 'uniform' | 'u' | 'v' | 'rotate' | 'corner' | 'insert';
interface DecalHandle { key: string; mode: DecalGrab; index: number; x: number; y: number; r: number }
/** The gizmo's handles in screen space, read before the canvas sees a pointerdown. A pad behind the surface (a mark
 *  spanning a curved face) or off the silhouette used to lose the pick to the model, which then slid the whole mark —
 *  both are the same grab now, and the nearest handle in screen space wins. */
const decalHandles: {
  hit: ((x: number, y: number) => DecalHandle | null) | null;
  start: ((h: DecalHandle, x: number, y: number, shift: boolean, alt: boolean) => void) | null;
} = { hit: null, start: null };
/** A Decal handle's icon: what dragging it does, drawn white on a transparent canvas (cached). */
type HandleIcon = 'move' | 'rotate' | 'scale' | 'stretchU' | 'stretchV';
const icons = new Map<HandleIcon, THREE.CanvasTexture>();
function iconTexture(kind: HandleIcon) {
  const hit = icons.get(kind);
  if (hit) return hit;
  const S = 96, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!, m = S / 2;
  g.strokeStyle = g.fillStyle = '#ffffff'; g.lineWidth = 8; g.lineCap = 'round'; g.lineJoin = 'round';
  // an arrowhead with its tip at (x, y) pointing along angle a
  const head = (x: number, y: number, a: number, k = 24) => {
    g.beginPath(); g.moveTo(x, y);
    g.lineTo(x - k * Math.cos(a - 0.62), y - k * Math.sin(a - 0.62)); g.lineTo(x - k * Math.cos(a + 0.62), y - k * Math.sin(a + 0.62));
    g.closePath(); g.fill();
  };
  const line = (x0: number, y0: number, x1: number, y1: number) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  // a double arrow through the middle along angle a
  const both = (a: number, l: number) => {
    const dx = Math.cos(a) * l, dy = Math.sin(a) * l, ix = Math.cos(a) * (l - 14), iy = Math.sin(a) * (l - 14);
    line(m - ix, m - iy, m + ix, m + iy); head(m + dx, m + dy, a); head(m - dx, m - dy, a + Math.PI);
  };
  if (kind === 'move') { both(0, 40); both(Math.PI / 2, 40); }
  else if (kind === 'scale') both(-Math.PI / 4, 42);
  else if (kind === 'stretchU') both(0, 40);
  else if (kind === 'stretchV') both(Math.PI / 2, 40);
  else {
    // three quarters of a turn, the arrowhead at its end along the turning direction
    const r = 26, a0 = -Math.PI * 0.6, a1 = Math.PI * 0.75;
    g.beginPath(); g.arc(m, m, r, a0, a1); g.stroke();
    const ta = a1 + 0.35;
    head(m + r * Math.cos(ta), m + r * Math.sin(ta), ta + Math.PI / 2, 26);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  icons.set(kind, t);
  return t;
}
/** The grabbed handle's colour: nothing else in the gizmo is blue, so it reads as "this drag is the handle's". */
const GRAB = '#4fb3ff';

/** The active decal on the model: the frame its ink is projected in (always, so a mark found in the Layers panel is
 *  visible where it lies) and, with the Decal tool on, its handles — a disc in the middle to slide it over the
 *  surface, corner squares to scale, edge bars to stretch one side, a knob to rotate it (Shift: 15°). The handles keep
 *  one screen size at any zoom, so a mark a centimetre across is as easy to grab as one across the slide, and the one
 *  being dragged turns blue. A grip texture's outline is pulled onto the surface itself (the projector's plane floats
 *  off a curved grip, so on the plane its line sat outside the relief it was describing). */
function DecalGizmo() {
  const tool = useApp((s) => s.paint.tool);
  useApp((s) => s.paintRev); useApp((s) => s.paintLive); useApp((s) => s.paintPanel); useApp((s) => s.activePart);
  const { camera, gl, size, invalidate } = useThree();
  const a = activeDecal(), d = a?.decal;
  // world units per screen pixel where the mark is: handle glyphs and their pick pads are sized from it
  const [px, setPx] = useState(0.01);
  // the handle being dragged, so it can light up while it works
  const [grab, setGrab] = useState<string | null>(null);
  const dragging = useRef(false);
  const cx = d?.center[0] ?? 0, cy = d?.center[1] ?? 0, cz = d?.center[2] ?? 0;
  const here = useMemo(() => new THREE.Vector3(cx, cy, cz), [cx, cy, cz]);
  useFrame(() => {
    if (!d) return;
    const dist = camera.position.distanceTo(here);
    const per = (2 * Math.tan((((camera as THREE.PerspectiveCamera).fov || 45) * Math.PI) / 360) * dist) / Math.max(1, size.height);
    if (per > 0 && Math.abs(per - px) > px * 0.05) setPx(per);
  });
  // the screen-sized handles move once React has drawn them at the new size: the Workbench must start its frame
  // accumulation again then, not in the frame that measured it (that one still drew them at the old size and place)
  useEffect(() => { bench.dirty = true; invalidate(); }, [px, invalidate]);
  // A pointerdown on a handle must not reach the model: the mark's own press would start a slide there instead. The
  // listener is captured on the canvas's parent, so it runs before R3F's whatever the handle's depth or occlusion.
  useEffect(() => {
    const el = gl.domElement.parentElement ?? gl.domElement;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const h = decalHandles.hit?.(e.clientX, e.clientY);
      if (!h) return;
      e.preventDefault();
      e.stopPropagation();
      decalHandles.start?.(h, e.clientX, e.clientY, e.shiftKey, e.altKey);
    };
    el.addEventListener('pointerdown', down, true);
    return () => el.removeEventListener('pointerdown', down, true);
  }, [gl]);
  // A drag ends on any release or when the window loses focus, even if the drag's own handler missed it: otherwise one
  // lost pointerup would leave `dragging` set and every later press on a mark would be silently ignored — marks look
  // unclickable and the handles dead until the view is reloaded.
  useEffect(() => {
    const release = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setGrab(null);
      gl.domElement.style.cursor = '';
      invalidate();
    };
    addEventListener('pointerup', release);
    addEventListener('pointercancel', release);
    addEventListener('blur', release);
    return () => {
      removeEventListener('pointerup', release);
      removeEventListener('pointercancel', release);
      removeEventListener('blur', release);
    };
  }, [gl, invalidate]);
  if (!a || !d) { decalHandles.hit = null; decalHandles.start = null; return null; }
  const f = decalFrame(d, modelDiagonal());
  const n = new THREE.Vector3(f.nx, f.ny, f.nz), ur = new THREE.Vector3(f.uxr, f.uyr, f.uzr), vr = new THREE.Vector3(f.vxr, f.vyr, f.vzr);
  const w = f.width, h = f.height;
  const c = new THREE.Vector3(f.cx, f.cy, f.cz).addScaledVector(n, Math.max(px * 1.5, Math.max(w, h) * 0.004));
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(ur, vr, n));
  const glyph = px * 7, reach = px * 64;
  const rect = [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0], [-w / 2, -h / 2, 0]] as [number, number, number][];
  // a small mark would be all handles: keep the middle, the knob and one scale square, set outside the corner so it
  // cannot be mistaken for the middle
  const roomy = w / px > 72 && h / px > 72;
  const sh = d.shape, fu = d.flipH ? -1 : 1, fv = d.flipV ? -1 : 1, pts = sh ? sh.outline ?? RECT_OUTLINE : null;
  // an open polyline (a line kind not Closed) has no edge from its last corner back to its first
  const open = !!sh && isLine(sh.pattern) && !sh.closed;
  const edges = pts ? pts.slice(0, open ? -1 : undefined).map((p, k) => [p, pts[(k + 1) % pts.length]] as const) : [];
  const local = (p: [number, number]): [number, number, number] => [p[0] * fu * w / 2, p[1] * fv * h / 2, 0];
  // A shape's outline is its boundary, so the projector's rectangle is not drawn for one: on a curved surface it read
  // as a second rectangle that did not fit the relief. The knob and the scale square stand on the outline's own box.
  const ptsLocal = pts ? pts.map(local) : null;
  const ob = ptsLocal && ptsLocal.length
    ? ptsLocal.reduce<[number, number, number, number]>((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity])
    : null;
  const top: [number, number, number] = ob ? [(ob[0] + ob[2]) / 2, ob[3] + reach, 0] : [0, h / 2 + reach, 0];
  const topAnchor: [number, number, number] = ob ? [(ob[0] + ob[2]) / 2, ob[3], 0] : [0, h / 2, 0];
  // the slide disc in the outline's middle: a drawn line is framed on one of its corners, which the disc would hide
  const mid: [number, number, number] = ob ? [(ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2, 0] : [0, 0, 0];
  const solo: [number, number, number] = ob ? [ob[2] + px * 18, ob[3] + px * 18, 0] : [w / 2 + px * 18, h / 2 + px * 18, 0];
  const planeWorld = (at: [number, number, number]) => new THREE.Vector3(...at).applyQuaternion(q).add(c);
  // the outline's points are pulled onto the part's surface: a ray along the projector's normal, so on a curved grip
  // they land where the relief's own border is instead of a flat rectangle floating over it. A point past the part
  // stays in the plane (there is nothing to stand on there).
  const projector = sh ? surfaceProjector(useApp.getState().result?.parts[a.part]?.positions ?? null) : null;
  const inward = n.clone().negate();
  const onSurface = (at: [number, number, number]) => {
    const pw = planeWorld(at);
    if (!projector) return pw;
    const hit = projector.ray(pw, inward, f.depth);
    if (hit) return hit;
    // a corner just past a rounded edge has nothing under its own ray: the nearest surface is the silhouette the
    // relief is clipped by, which is where the outline should stop
    const near = projector.near(pw);
    return near.distanceTo(pw) <= Math.max(w, h) * 0.4 ? near : pw;
  };
  const cursorOf = (mode: DecalGrab) => mode === 'move' ? 'move' : mode === 'uniform' ? 'nwse-resize' : mode === 'u' ? 'ew-resize' : mode === 'v' ? 'ns-resize' : mode === 'rotate' ? 'grab' : mode === 'insert' ? 'copy' : 'move';
  /** Alt+click a grip outline's corner: it is gone (no drag); three is the fewest an outline may have, two a line's. */
  const removeCorner = (index: number) => {
    if (!sh || !pts || pts.length <= (open ? 2 : 3)) return;
    const o = pts.map((p) => [p[0], p[1]] as [number, number]);
    o.splice(index, 1);
    updateDecal({ shape: { ...sh, outline: o } });
  };

  /** The drag for `mode`, begun at a screen point (a handle's own event, or the capture above). One pointermove at a
   *  time, one undo step for the whole drag, the handle blue and the frame blue while it lasts. An outline corner moves
   *  by the pointer's delta from where it was grabbed: its dot sits on the surface, not in the projector's plane, so
   *  reading the cursor's plane point straight would make it jump on the first move. */
  const begin = (mode: DecalGrab, key: string, x: number, y: number, shift: boolean, index = 0, alt = false) => {
    if (dragging.current) return;
    const outline = mode === 'corner' || mode === 'insert';
    if (outline && !sh) return;
    if (mode === 'corner' && alt) { removeCorner(index); return; }
    const box = gl.domElement.getBoundingClientRect(), p = c.clone().project(camera);
    const sx = box.left + ((p.x + 1) / 2) * box.width, sy = box.top + ((1 - p.y) / 2) * box.height;
    const angle = (mx: number, my: number) => Math.atan2(-(my - sy), mx - sx);
    const r0 = Math.max(4, Math.hypot(x - sx, y - sy)), a0 = angle(x, y);
    const w0 = d.width, h0 = w0 / Math.max(d.aspect, 1e-4), rot0 = d.rotation, span = modelDiagonal();
    const sign = n.dot(camera.position.clone().sub(c)) >= 0 ? 1 : -1;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, c), ray = new THREE.Raycaster(), hit = new THREE.Vector3();
    const sizeOf = (v: number) => Math.min(span * 1.5, Math.max(span * 0.003, v));
    let o = pts ? pts.map((p) => [p[0], p[1]] as [number, number]) : [], k = index;
    beginPaintEdit();
    // a + on an edge goes in at once, so the new corner is there to drag
    if (mode === 'insert' && sh) { const p0 = o[k] ?? o[0] ?? [0, 0], p1 = o[(k + 1) % o.length] ?? p0; k++; o.splice(k, 0, [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2]); updateDecal({ shape: { ...sh, outline: o } }, false, false); }
    // where the pointer's ray met the plane at the grab, and the corner's own plane point: the drag moves the corner
    // by the difference of the two
    const inv = q.clone().invert(), start = new THREE.Vector3(), corner0 = new THREE.Vector3();
    let grabbed = false, edited = false;
    if (outline && pts) {
      ray.setFromCamera(new THREE.Vector2(((x - box.left) / box.width) * 2 - 1, -((y - box.top) / box.height) * 2 + 1), camera);
      grabbed = ray.ray.intersectPlane(plane, start) !== null;
      corner0.set(...local(o[k] ?? o[0] ?? [0, 0]));
    }
    const move = (m: PointerEvent) => {
      if (outline) {
        if (!sh) return;
        ray.setFromCamera(new THREE.Vector2(((m.clientX - box.left) / box.width) * 2 - 1, -((m.clientY - box.top) / box.height) * 2 + 1), camera);
        if (!ray.ray.intersectPlane(plane, hit)) return;
        o = o.map((p) => [p[0], p[1]] as [number, number]);
        if (grabbed) {
          const dl = hit.clone().sub(start).applyQuaternion(inv);
          o[k] = [(corner0.x + dl.x) / (w / 2) * fu, (corner0.y + dl.y) / (h / 2) * fv];
        } else {
          hit.sub(c);
          o[k] = [(hit.dot(ur) / (w / 2)) * fu, (hit.dot(vr) / (h / 2)) * fv];
        }
        updateDecal({ shape: { ...sh, outline: o } }, false, false);
        edited = true;
      } else if (mode === 'move') {
        // on the model the mark rides the surface (Shift catches the middle line); off it, along its own plane, so a
        // drag can reach over an edge instead of stopping at the silhouette
        const pick = pickAt.fn?.(m.clientX, m.clientY);
        if (pick && pick.part === a.part && pick.front) { dragDecal(pick.point, pick.tri, m.shiftKey, false); edited = true; }
        else {
          ray.setFromCamera(new THREE.Vector2(((m.clientX - box.left) / box.width) * 2 - 1, -((m.clientY - box.top) / box.height) * 2 + 1), camera);
          if (ray.ray.intersectPlane(plane, hit)) { dragDecal(hit.toArray() as [number, number, number], -1, m.shiftKey, false); edited = true; }
        }
      } else if (mode === 'rotate') {
        let r = rot0 + (sign * (angle(m.clientX, m.clientY) - a0) * 180) / Math.PI;
        r = ((((r + 180) % 360) + 360) % 360) - 180;
        updateDecal({ rotation: m.shiftKey ? Math.round(r / 15) * 15 : r }, false);
      } else {
        let kf = Math.max(0.05, Math.hypot(m.clientX - sx, m.clientY - sy) / r0);
        if (m.shiftKey) kf = Math.max(0.05, Math.round(kf * 20) / 20); // 5% steps
        if (mode === 'v') updateDecal({ aspect: w0 / sizeOf(h0 * kf) }, false);
        else {
          const nw = sizeOf(w0 * kf);
          updateDecal(mode === 'u' ? { width: nw, aspect: nw / h0 } : { width: nw }, false);
        }
      }
      invalidate();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      removeEventListener('blur', up);
      if (edited && (outline || mode === 'move')) finishDecalEdit();
      dragging.current = false;
      setGrab(null);
      gl.domElement.style.cursor = '';
      invalidate();
    };
    // the pointer belongs to this drag now: taken only once everything above has been computed, and the end listeners
    // are in place before it is, so a stale drag can never leave every later press ignored
    dragging.current = true;
    setGrab(key);
    gl.domElement.style.cursor = 'grabbing';
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    addEventListener('blur', up);
  };

  /** One handle: a generous invisible pad (the capture above does the real picking) and a glyph shaped by what it does
   *  — an icon badge for slide (four arrows), turn (a curved arrow), scale (a diagonal double arrow) and stretch one axis
 *  (a double arrow along it); a dot for an outline corner, a plus to add one.
   *  `at` is world space: shape handles stand on the surface, the rest on the frame's plane. The glyph is billboarded,
   *  so a square reads as a square (and stays grabbable) from any angle instead of lying in the mark's tilted plane. */
  const handle = (key: string, mode: DecalGrab, at: THREE.Vector3 | [number, number, number], r: number, glyphShape: 'disc' | 'square' | 'barU' | 'barV' | 'knob' | 'dot' | 'plus', index = 0) => {
    const hot = grab === key;
    const fill = hot ? GRAB : glyphShape === 'dot' ? SEL : '#ffffff';
    const icon: HandleIcon | null = glyphShape === 'disc' ? 'move' : glyphShape === 'knob' ? 'rotate' : glyphShape === 'square' ? 'scale'
      : glyphShape === 'barU' ? 'stretchV' : glyphShape === 'barV' ? 'stretchU' : null;
    return (
      // r is screen pixels (the pick above reads it so): px turns it into world units here
      <Billboard key={key} position={at} scale={px}>
        <mesh renderOrder={14}
          onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); begin(mode, key, e.clientX, e.clientY, e.shiftKey, index, e.nativeEvent.altKey); }}
          onPointerOver={() => { if (!dragging.current) gl.domElement.style.cursor = cursorOf(mode); }}
          onPointerOut={() => { if (!dragging.current) gl.domElement.style.cursor = ''; }}>
          <planeGeometry args={[r * 2.2, r * 2.2]} />
          <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
        {icon ? <>
          {/* a dark badge, ringed, with the drag's icon on it: blue while it is the one being dragged */}
          <mesh raycast={() => null} renderOrder={15} scale={hot ? 1.2 : 1}>
            <circleGeometry args={[r * 0.95, 32]} />
            <meshBasicMaterial color={hot ? GRAB : '#1d1f23'} depthTest={false} side={THREE.DoubleSide} />
          </mesh>
          <mesh raycast={() => null} renderOrder={16} scale={hot ? 1.2 : 1}>
            <ringGeometry args={[r * 0.88, r * 1.02, 32]} />
            <meshBasicMaterial color={hot ? '#ffffff' : SEL} depthTest={false} transparent opacity={0.9} side={THREE.DoubleSide} />
          </mesh>
          <mesh raycast={() => null} renderOrder={17} scale={hot ? 1.2 : 1}>
            <planeGeometry args={[r * 1.6, r * 1.6]} />
            <meshBasicMaterial map={iconTexture(icon)} depthTest={false} transparent side={THREE.DoubleSide} />
          </mesh>
        </> : <mesh raycast={() => null} renderOrder={15} scale={hot ? 1.3 : 1}>
          {glyphShape === 'dot' ? <circleGeometry args={[r * 0.55, 16]} /> : <planeGeometry args={[r * 0.8, r * 0.2]} />}
          <meshBasicMaterial color={fill} depthTest={false} transparent={glyphShape === 'plus'} opacity={glyphShape === 'plus' ? 0.7 : 1} side={THREE.DoubleSide} />
        </mesh>}
        {icon ? null : glyphShape === 'plus'
          ? <mesh raycast={() => null} renderOrder={15} scale={hot ? 1.3 : 1}><planeGeometry args={[r * 0.2, r * 0.8]} /><meshBasicMaterial color={fill} depthTest={false} transparent opacity={hot ? 1 : 0.7} side={THREE.DoubleSide} /></mesh>
          : <mesh raycast={() => null} renderOrder={16} scale={hot ? 1.3 : 1}><ringGeometry args={[r * 0.62, r * 0.78, 24]} /><meshBasicMaterial color={hot ? GRAB : SEL} depthTest={false} transparent opacity={hot ? 1 : 0.8} side={THREE.DoubleSide} /></mesh>}
      </Billboard>
    );
  };
  // what the capture above picks, in the same order it draws: nearest screen distance inside its own radius wins
  const handles: { key: string; mode: DecalGrab; world: THREE.Vector3; r: number; index?: number }[] = [];
  if (tool === 'decal') {
    handles.push({ key: 'move', mode: 'move', world: planeWorld(mid), r: 14 });
    handles.push({ key: 'rotate', mode: 'rotate', world: planeWorld(top), r: 16 });
    if (pts) {
      pts.forEach((p, k) => handles.push({ key: `c${k}`, mode: 'corner', world: onSurface(local(p)), r: 12, index: k }));
      edges.forEach(([p, e], k) => handles.push({ key: `m${k}`, mode: 'insert', world: onSurface(local([(p[0] + e[0]) / 2, (p[1] + e[1]) / 2])), r: 10, index: k }));
      // a grip panel still needs one scale square on the model: its outline corners belong to its shape
      handles.push({ key: 's1', mode: 'uniform', world: onSurface(solo), r: 14 });
    } else if (roomy) {
      rect.slice(0, 4).forEach((p, k) => handles.push({ key: `s${k}`, mode: 'uniform', world: planeWorld(p), r: 13 }));
      handles.push({ key: 'v0', mode: 'v', world: planeWorld([0, h / 2, 0]), r: 12 }, { key: 'v1', mode: 'v', world: planeWorld([0, -h / 2, 0]), r: 12 });
      handles.push({ key: 'u0', mode: 'u', world: planeWorld([w / 2, 0, 0]), r: 12 }, { key: 'u1', mode: 'u', world: planeWorld([-w / 2, 0, 0]), r: 12 });
    } else {
      handles.push({ key: 's1', mode: 'uniform', world: planeWorld(solo), r: 14 });
    }
  }
  decalHandles.hit = tool === 'decal' ? (x, y) => {
    const b = gl.domElement.getBoundingClientRect();
    let best: DecalHandle | null = null, bestD = Infinity;
    for (const hd of handles) {
      const p = hd.world.clone().project(camera);
      const sx = b.left + ((p.x + 1) / 2) * b.width, sy = b.top + ((1 - p.y) / 2) * b.height;
      const dd = Math.hypot(x - sx, y - sy);
      if (dd <= hd.r && dd < bestD) { bestD = dd; best = { key: hd.key, mode: hd.mode, index: hd.index ?? 0, x: sx, y: sy, r: hd.r }; }
    }
    return best;
  } : null;
  decalHandles.start = (hh, x, y, shift, alt) => begin(hh.mode, hh.key, x, y, shift, hh.index, alt);
  const outlineWorld = pts ? (open ? pts : [...pts, pts[0]]).map((p) => onSurface(local(p))) : null;

  return (
    <>
      <group position={c} quaternion={q}>
        {/* a shape's boundary is its outline: a projector rectangle beside it read as a second, misfitting outline */}
        {!pts && <Line points={rect} color={grab ? GRAB : tool === 'decal' ? '#ffffff' : SEL} lineWidth={grab ? 2.2 : tool === 'decal' ? 1.6 : 1.2} depthTest={false} renderOrder={11} raycast={() => null} />}
        <Line points={[topAnchor, top]} color={SEL} lineWidth={1.4} depthTest={false} renderOrder={11} raycast={() => null} />
      </group>
      {outlineWorld && <Line points={outlineWorld} color={grab && grab.startsWith('c') ? GRAB : tool === 'decal' ? SEL : '#ffffff'} lineWidth={tool === 'decal' ? 2 : 1.4} depthTest={false} renderOrder={12} raycast={() => null} />}
      {tool === 'decal' && <>
        {handle('move', 'move', planeWorld(mid), 14, 'disc')}
        {handle('rotate', 'rotate', planeWorld(top), 16, 'knob')}
        {/* a shape's corners are its outline's: the rectangle's own handles would sit under them */}
        {!pts && roomy && rect.slice(0, 4).map((p, k) => handle(`s${k}`, 'uniform', planeWorld(p), 13, 'square'))}
        {!pts && roomy && handle('v0', 'v', planeWorld([0, h / 2, 0]), 11, 'barU')}
        {!pts && roomy && handle('v1', 'v', planeWorld([0, -h / 2, 0]), 11, 'barU')}
        {!pts && roomy && handle('u0', 'u', planeWorld([w / 2, 0, 0]), 11, 'barV')}
        {!pts && roomy && handle('u1', 'u', planeWorld([-w / 2, 0, 0]), 11, 'barV')}
        {!pts && !roomy && handle('s1', 'uniform', planeWorld(solo), 14, 'square')}
        {pts && handle('s1', 'uniform', onSurface(solo), 14, 'square')}
        {pts?.map((p, k) => handle(`c${k}`, 'corner', onSurface(local(p)), 12, 'dot', k))}
        {edges.map(([p, e], k) => handle(`m${k}`, 'insert', onSurface(local([(p[0] + e[0]) / 2, (p[1] + e[1]) / 2])), 10, 'plus', k))}
      </>}
    </>
  );
}

/** Where a projector's outline stands on a part: a point reached along the projector's normal, or the nearest surface
 *  point when the ray misses (an outline corner just past a rounded edge) — `null` when it is nowhere near. Built once
 *  per part (a BVH) and only for parts a browser can build in a blink; a bigger one keeps the outline in the plane
 *  rather than stalling. */
interface Projector {
  ray: (p: THREE.Vector3, dir: THREE.Vector3, reach: number) => THREE.Vector3 | null;
  near: (p: THREE.Vector3) => THREE.Vector3;
}
const projectors = new WeakMap<object, Projector | null>();
function surfaceProjector(positions: ArrayLike<number> | null | undefined): Projector | null {
  if (!positions) return null;
  const key = positions as unknown as object;
  if (projectors.has(key)) return projectors.get(key)!;
  let out: Projector | null = null;
  if (positions.length / 9 <= 120_000) {
    try {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(positions), 3));
      const bvh = new MeshBVH(geo), ray = new THREE.Ray(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
      out = {
        ray: (p, dir, reach) => {
          ray.origin.copy(p).addScaledVector(dir, -reach);
          ray.direction.copy(dir);
          const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, reach * 2);
          return h ? h.point.clone() : null;
        },
        near: (p) => { bvh.closestPointToPoint(p, hit); return hit.point.clone(); },
      };
    } catch { out = null; }
  }
  projectors.set(key, out);
  return out;
}
