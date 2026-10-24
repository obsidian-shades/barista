// App state (zustand) and every user action. UI reads with useApp, acts through the functions below.
import { create } from 'zustand';
import { api, type IslandIn, type Output, type Params, type PartOut, type Stats, ServerDown } from './api';
import type { UVMap } from './colors';
import { download, readParts, toFbx, toObjs, zipFiles, type ExportPart } from './files';
import { islandsOf, pickTri, seamSegments } from './islands';
import { placeChanged } from './fitpack';
import { edgeBetween, polygonsOf, sidesOf, topoOf, trisOf, vertexAt, xyzKey, type Topo } from './topo';
import { health, healthReport, ruleCounts, RULES, setModelSize, type RuleId } from './health';
import { clearRecentFiles, forgetRecent, pickWithHandle, recentFiles, remember, reopen } from './recent';
import { carryNormals, dissolve, dissolveFaces, limitedDissolve, link, outNormals, ownPolygons, topoOfSoup, triangulate, trisToQuads, type Polys } from './polyedit';
import { bake } from './bake';
import { CHANNELS, composite, dab, dabUV, generate, setBaked, surfaceOfAsync as texelSurface, type Gen, type GenKind, type Shown, bleedAll, fillAll, fillTris, invertSelection as invertMask, keep as keepPaint, maskPolygon, maskTris, newLayer, pngOf, requestComposite, sample, select as selectMask, setOf, undo as undoSet, redo as redoSet, setUndoRect, bakeFill, bakeDecal, maskDab, maskDabUV, maskFill, maskInvert, maskSelection, pngNormalDX, pngORM, pngShown, pngUnityHDRP, pngUnityURP, type BlendMode, type Brush, type BrushTip, type Channel, type Decal, type Fill, type PaintLayer, type SelOp as MaskOp, type TexSet, type TexturePreset } from './paint';
import { gpuBegin, gpuDab, gpuFinish, gpuTake } from './gpupaint';
import { FILL_CHANNELS, loadMaterialLibrary, materialFromFiles, materialPixels, pickMaterialFolder, type MaterialAsset, type MaterialPixels } from './materials';
import { decalFromFile, decalPixels, loadDecalLibrary, type DecalAsset } from './decals';
import { SMART_MATERIALS } from './smartmaterials';
import { addLoops, connect as connectPolys, gridFill, loopCut, loopOf, members, merge as mergeVerts, meshCheck, moveOnSurface, poles, relax, rotateEdge, shapeLoop, slide, subdivide, surfaceOf, type Done, type Geo, type Sel as SoupSel } from './polygeo';

export type Mode = 'checker' | 'stretch' | 'islands';
export const TEXTURE_RESOLUTIONS = [64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;
export const setUvMap = (uvMap: UVMap) => set({ uvMap });
/** The paint resolution, and the reference map's. Existing sets are resized on next use (`paint.setOf`), so this only
 *  stores it and redraws: the redraw visits every part, which is where the resize happens. */
export const setTextureResolution = (textureResolution: number) => { set({ textureResolution }); repaint(); };
/** Blender's select modes (1 2 3), plus whole UV islands (4). */
export type SelectMode = 'vert' | 'edge' | 'face' | 'island';
/** Blender's edit-mode selection on one part: vertex, edge and face (triangle) ids of its output (`topoOf`), kept
 *  consistent with each other. `of`: the output positions it was made on. */
export interface CompSel { part: number; of: number[]; verts: Set<number>; edges: Set<number>; faces: Set<number> }
/** A menu row: an action, or (`kind`) a section heading or a line of information (`tone`: 0 green … 1 red; `title`: its tooltip).
 *  `on` marks the current choice, in a pie or a list. */
export interface MenuItem { label: string; run: () => void; kbd?: string; off?: boolean; kind?: 'head' | 'info'; tone?: number; title?: string; on?: boolean }
export type UvScope = 'part' | 'all';

/** The 3D view's lighting and overlays. An environment map brings its own grade (see HDRI_PRESETS);
 *  choosing None puts the workspace lights back. */
export interface Scene {
  background: string;
  ambient: number;
  key: number;
  exposure: number;
  hdriUrl: string | null;
  /** Preset id, `custom` for a loaded file, or '' when there is no map. */
  hdriId: string;
  hdriName: string;
  hdriBackground: boolean;
  hdriStrength: number;
  /** Yaw of the map, radians, so its bright light sits on the front-left. */
  hdriRotation: number;
  /** Backdrop blur, 0..1. Softens a 1K plate into a studio sweep. */
  hdriBlur: number;
  wireframe: boolean;
  showEdges: boolean;
  showVertices: boolean;
  showSeams: boolean;
  showGrid: boolean;
  showAxes: boolean;
  /** Blender's Viewport Shading: lights and environment (Studio), a lit sphere by normal (MatCap), or unlit (Flat). */
  lighting: 'studio' | 'matcap' | 'flat';
  matcap: string;
  /** The backdrop: the app's (Theme), or `background` (Custom); the environment map shows instead when `hdriBackground`. */
  bg: 'theme' | 'custom';
  backface: boolean;
  outline: boolean;
  specular: boolean;
  xray: boolean;
  xrayAlpha: number;
  shadow: boolean;
  shadowAmount: number;
  /** Cavity, Blender's Workbench passes: valleys darker, ridges lighter (each 0…2). World = screen-space AO over
   *  `cavityDistance` (in halves of the model, Blender's 0.2 on its default cube), Screen = curvature (crisp lines on
   *  every edge, from the normals a pixel apart), Both. */
  cavity: boolean;
  cavityType: 'world' | 'screen' | 'both';
  cavityDistance: number;
  ridge: number;
  valley: number;
}

export interface HdriPreset {
  label: string;
  url: string;
  rotation: number;
  strength: number;
  blur: number;
  exposure: number;
  ambient: number;
  key: number;
  sky: string;
  ground: string;
  keyColor: string;
}

// Grades measured from the bundled plates: mean luminance and where the hot pixels sit.
// The yaw turns that key onto the front-left of the default camera. Strength and exposure
// keep the subject in a photoshoot range instead of letting the plate's practicals clip it.
const deg = (d: number) => d * Math.PI / 180;
export const HDRI_PRESETS = {
  studio_small_09: { label: 'Soft studio', url: '/hdri/studio_small_09_1k.hdr', rotation: deg(55), strength: 0.72, blur: 0.62, exposure: 1, ambient: 0.18, key: 0.55, sky: '#f4f0e8', ground: '#3a342e', keyColor: '#fff6ec' },
  studio_small_04: { label: 'Dramatic studio', url: '/hdri/studio_small_04_1k.hdr', rotation: deg(-172), strength: 0.48, blur: 0.3, exposure: 1.05, ambient: 0.1, key: 0.9, sky: '#e6e0d6', ground: '#161311', keyColor: '#fff1e4' },
  venice_sunset: { label: 'Venice sunset', url: '/hdri/venice_sunset_1k.hdr', rotation: deg(59), strength: 0.58, blur: 0.16, exposure: 0.92, ambient: 0.16, key: 0.4, sky: '#ffd2a8', ground: '#3a2a22', keyColor: '#ffd8b0' },
  dikhololo_night: { label: 'Night sky', url: '/hdri/dikhololo_night_1k.hdr', rotation: deg(-149), strength: 1.85, blur: 0.2, exposure: 1.3, ambient: 0.32, key: 0.6, sky: '#c9d4e6', ground: '#12151c', keyColor: '#d5e2ff' },
} as const satisfies Record<string, HdriPreset>;
export type HdriId = keyof typeof HDRI_PRESETS;

const CUSTOM_GRADE: Omit<HdriPreset, 'label' | 'url'> = { rotation: 0, strength: 0.85, blur: 0.45, exposure: 1, ambient: 0.22, key: 0.6, sky: '#f3efe8', ground: '#2c2824', keyColor: '#fff4e8' };
/** Fill colours for the current map. Presets carry their own; a loaded file uses a neutral studio. */
export const sceneGrade = (id: string): Omit<HdriPreset, 'label' | 'url'> => (id in HDRI_PRESETS ? HDRI_PRESETS[id as HdriId] : CUSTOM_GRADE);

// without a plate, Studio is Blender's Solid studio light as it ships (shading.ts): Key scales its four lights, Ambient
// adds a fill it doesn't have, Exposure scales the result
const WORK_LIGHT = { ambient: 0, key: 1, exposure: 1 };
const HDRI_TYPE = 'Environment maps are .hdr or .exr files';
const dropHdri = (url: string | null) => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url.split('#')[0]); };

export interface Part {
  name: string;
  soup: Float32Array;
  /** Every seam, two xyz endpoints (6 numbers) per edge: the island borders an unwrap left, and the marked ones. */
  seams: number[];
  /** The seams marked by hand: Auto Unwrap starts over from these. */
  marked: number[];
  /** The seams the part's current UVs were made with: a seam edit re-solves only what differs from these. */
  solved: number[];
  /** The mesh itself. Off: hidden in both views. */
  visible: boolean;
  /** The checker preview. Off: the part stays, drawn as a plain shaded surface. */
  textured: boolean;
  /** Seamed by hand (Clear all seams): its islands are the seams alone, laid flat as they are; Auto Unwrap ends it. */
  manual?: boolean;
  /** Per soup triangle: the file's polygon it came from (quads and n-gons drawn as Blender shows them). */
  poly?: Int32Array;
  /** Per polygon: its corner count in the file. */
  sides?: Int32Array;
  /** The file's own normals per soup corner (Smooth view shades with them, as Blender does); carried through a Move
   *  (`carryNormals`), dropped once a Poly Doc tool rebuilds the geometry, which then shades with normals of its own. */
  normals?: Float32Array;
  /** Changed (or opened) in Poly Doc, which never unwraps: its output is the bare mesh until UV Magician unwraps it. */
  stale?: boolean;
}

/** An undo step: the UVs, and the result (Stitch makes two islands one). */
interface Snap { uvs: Float32Array[]; result: Output | null }
interface PartSnap { parts: Part[]; uvs: Float32Array[]; result: Output | null; csel: CompSel | null; activePart: number; uvScope: UvScope; past: Snap[]; future: Snap[] }

interface State {
  source: string | null;
  /** The source file's unit in cm (FBX UnitScaleFactor; 100 = metres), written back on export. */
  unit: number;
  parts: Part[];
  params: Params;
  result: Output | null;
  /** The UVs as edited by hand, per part (the result's own stay as the engine made them). */
  uvs: Float32Array[];
  /** Bumps on every UV edit, so views redraw without copying arrays every drag frame. */
  uvRev: number;
  edited: boolean;
  /** Bumps on every new result: the 3D view refits the camera. */
  rev: number;
  past: Snap[];
  future: Snap[];
  /** Parts before each seam or cut change, for undo once there's no UV edit left to undo. */
  partsPast: PartSnap[];
  partsFuture: PartSnap[];
  /** The islands the selection touches (derived from csel): what the island tools work on. */
  selected: number[];
  selectMode: SelectMode;
  csel: CompSel | null;
  /** The last view request (frame, look along an axis): the view it's for acts on each new n. */
  viewReq: { view: '3d' | 'uv'; op: ViewOp; n: number };
  /** A menu at the pointer: a list (right click, Ctrl+E) or a pie (Q). */
  menu: { x: number; y: number; title: string; items: MenuItem[]; pie?: boolean } | null;
  /** B: the next left drag box-selects, wherever it starts. */
  boxArmed: boolean;
  /** G R S in progress. */
  xform: Xform | null;
  /** Live Unwrap: moving pinned UVs lays their islands out again around them as they go. */
  liveUnwrap: boolean;
  /** After a Cut, Stitch, Unwrap Selection or Clear seams: turn the islands it made straight (Align Axis), pack the
   *  part again. Remembered between sessions. */
  afterAlign: boolean;
  afterPack: boolean;
  /** Pinned UV corners per part (P), for the output positions they were pinned on. */
  pins: Record<number, { of: number[]; corners: Set<number> }>;
  /** Shape data copied from one island for reuse on islands with matching corner topology. */
  shapeClipboard: number[] | null;
  /** The part whose UVs the UV view shows while uvScope is 'part'. */
  activePart: number;
  /** Parts highlighted in the Parts list, like a layers panel. */
  layerSel: number[];
  /** The part a Shift-click in the Parts list ranges from. */
  layerAnchor: number;
  /** UV view: just the active part, or the whole model (each part's square as a tile, or the shared atlas). */
  uvScope: UvScope;
  mode: Mode;
  /** Resolution of the checker preview texture. */
  textureResolution: number;
  /** What the model and the layout show instead of a texture: a checker, a labelled UV grid, the UV ramp, arrows. */
  uvMap: UVMap;
  /** Colours picked in the background wheel, newest first. */
  recentColors: string[];
  scene: Scene;
  unfold: number;
  /** Progressive model loading/unwrapping status; completed parts are already usable in both views. */
  loading: { phase: 'read' | 'unwrap' | 'pack' | 'error'; total: number; complete: number; active: string | null; error?: string; done: boolean[] } | null;
  busy: string | null;
  error: string | null;
  server: 'unknown' | 'up' | 'down';
  shapes: string[];
  /** Which tool fills the window: the UV unwrapper or Poly Doc (the pill tabs). */
  workspace: Workspace;
  /** Poly Doc's view: each polygon flat with the wire, smooth shaded without it (as the model will look), or Health
   *  (every face green to red by how solid it is). */
  docView: DocView;
  /** Poly Doc's face colour outside Health: one grey, or a colour per part (Blender's Random). */
  docColor: 'single' | 'random';
  /** The panel column's width (px), and the 3D view's share of the views in UV Magician: the dividers, remembered. */
  dockWidth: number;
  viewSplit: number;
  /** Poly Doc's current tool (the options bar shows it) and the tools' settings. */
  docTool: DocTool | null;
  /** File › Open Recent: the newest files first (their contents or handles live in IndexedDB, `recent.ts`). */
  recent: { name: string; time: number }[];
  /** UV Magician's last strip tool (its options bar shows it). */
  uvTool: string | null;
  docOpts: { slide: number; angle: number; relax: number };
  /** Even Out lets the selection's border vertices slide along the border (else they stay put). */
  slideBorders: boolean;
  /** Poly Doc's G: the vertices being dragged (soup ids), from the geometry the drag began with; null when not moving. */
  docMove: DocMove | null;
  /** G keeps the moved vertices on the model's surface (Blender's snap to face), so dragging evens spacing, not shape. */
  moveOnSurface: boolean;
  /** Poly Doc marks poles on the model (below the regular valence blue, above it red). */
  showPoles: boolean;
  /** What the last Poly Doc fix did, in words (shown under its buttons). */
  fixNote: string | null;
  /** Export writes triangles (a fixed triangulation for baking) instead of the polygons. */
  triangulate: boolean;
  /** Van Gogh's tool and brush: a value per channel and which channels it paints (`on`); size is % of the model (on the
   *  model) or of the texture (in the texture view); Wand and Bucket take a face, an island or the whole part (`by`). */
  paint: { tool: PaintTool; color: string; rough: number; metal: number; on: Record<Channel, boolean>; size: number; flow: number; hardness: number; tip: BrushTip; by: FillBy; decalAsset: string; decalTint: string; decalSize: number; decalRotation: number; fillBlend: BlendMode };
  /** Parts expanded in Van Gogh's Parts tree. */
  paintOpen: number[];
  /** The channel the UV view shows (picked under the part in Parts). */
  paintChannel: Shown;
  /** The baked ambient occlusion shades the model (Substance shows it as soon as it's baked). */
  paintAO: boolean;
  /** Bumped when a texture set's layers or paint change, so the panel and the UV view read them again. */
  paintRev: number;
  /** A cheap tick for the layer panel while a full recomposite is pending; the view updates when it finishes. */
  paintPanel: number;
  /** A cheap, throttled tick while a stroke is in progress: views redraw without rebuilding the panel. */
  paintLive: number;
  /** The PBR material shelf: built-ins from public/materials plus folders imported this session. */
  materials: MaterialAsset[];
  materialsLoading: boolean;
  materialsError: string | null;
  /** The decal shelf: built in from public/decals plus images imported this session. */
  decals: DecalAsset[];
  decalsLoading: boolean;
  decalsError: string | null;
  /** Which Van Gogh dock tab is open: layers, materials, decals or maps. Color is permanently above the tabs. */
  paintTab: 'layers' | 'materials' | 'tiles' | 'decals' | 'maps';
  /** The engine preset the Maps tab's export button uses. */
  texturePreset: TexturePreset;
}
export type Workspace = 'uv' | 'doc' | 'paint';
export type PaintTool = 'marquee' | 'lasso' | 'wand' | 'decal' | 'brush' | 'erase' | 'bucket' | 'picker';
export type FillBy = 'face' | 'island' | 'part';
export type DocView = 'wire' | 'smooth' | 'health';
interface DocMove { part: number; verts: number[]; base: Geo; normals?: Float32Array; marked: number[]; mouse: [number, number] | null; pivot: [number, number, number]; axis: 0 | 1 | 2 | null; snap: (p: [number, number, number]) => [number, number, number]; reselect: { faces?: number[]; verts?: number[]; edges?: [number, number][] }; moved: boolean }
/** The 3D view's camera, for tools that turn mouse movement into world movement: a screen delta (px) at a point's depth. */
export const view3d: { worldDelta: ((dx: number, dy: number, at: [number, number, number]) => [number, number, number]) | null } = { worldDelta: null };
export type DocTool = 'move' | 'dissolve' | 'limited' | 'quads' | 'connect' | 'merge' | 'collapse' | 'rotate' | 'grid' | 'relax' | 'subdivide' | 'loopcut' | 'slide' | 'space' | 'straighten' | 'circle';
/** A number kept in the browser between sessions, within bounds. */
function saved(key: string, fallback: number, min: number, max: number) {
  try { const v = Number(localStorage.getItem(key)); return localStorage.getItem(key) !== null && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback; } catch { return fallback; }
}
const keep = (key: string, v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* private mode */ } };
export const setDockWidth = (w: number) => { const dockWidth = Math.round(Math.min(420, Math.max(260, w))); set({ dockWidth }); keep('dockWidth', dockWidth); };
export const setViewSplit = (f: number) => { const viewSplit = Math.min(0.8, Math.max(0.2, f)); set({ viewSplit }); keep('viewSplit', viewSplit); };
const savedWorkspace = (): Workspace => { try { return (['doc', 'paint'] as const).find((w) => w === localStorage.getItem('workspace')) ?? 'uv'; } catch { return 'uv'; } };

export const useApp = create<State>(() => ({
  source: null, unit: 100, parts: [], params: { sharp: 45, tol: 0.08, seam_weight: 0.1, join: true, atlas: 0, one_atlas: false }, activePart: 0, layerSel: [], layerAnchor: 0, uvScope: 'part', result: null, uvs: [], uvRev: 0, edited: false,
  rev: 0, past: [], future: [], partsPast: [], partsFuture: [], selected: [], selectMode: 'face', csel: null, viewReq: { view: '3d', op: 'all', n: 0 }, menu: null, boxArmed: false, xform: null, liveUnwrap: true, afterAlign: saved('afterAlign', 1, 0, 1) === 1, afterPack: saved('afterPack', 1, 0, 1) === 1, pins: {}, shapeClipboard: null, mode: 'checker', textureResolution: 1024, uvMap: 'checker', recentColors: [],
  scene: { background: '#111111', ...WORK_LIGHT, hdriUrl: null, hdriId: '', hdriName: '', hdriBackground: false, hdriStrength: 1, hdriRotation: 0, hdriBlur: 0, wireframe: false, showEdges: true, showVertices: true, showSeams: true, showGrid: false, showAxes: false,
    lighting: 'studio', matcap: 'clay', bg: 'theme', backface: false, outline: false, specular: true, xray: false, xrayAlpha: 0.5, shadow: false, shadowAmount: 0.4, cavity: false, cavityType: 'both', cavityDistance: 0.2, ridge: 1, valley: 1 }, unfold: 0,
  busy: null, error: null, server: 'unknown', shapes: [], loading: null, workspace: savedWorkspace(), triangulate: false, fixNote: null, docView: 'wire', docColor: 'single', showPoles: false, dockWidth: saved('dockWidth', 300, 260, 420), viewSplit: saved('viewSplit', 0.55, 0.2, 0.8), docTool: null, uvTool: null, recent: [], docOpts: { slide: 0.25, angle: 5, relax: 30 }, slideBorders: true, docMove: null, moveOnSurface: true,
  paint: { tool: 'brush', color: '#c0392b', rough: 0.5, metal: 0, on: { color: true, rough: false, metal: false, normal: false, height: false }, size: 3, flow: 0.6, hardness: 0.5, tip: 'round' as BrushTip, by: 'island', decalAsset: 'garuda-mark', decalTint: '#ffffff', decalSize: 14, decalRotation: 0, fillBlend: 'normal' as BlendMode }, paintChannel: 'material', paintRev: 0, paintPanel: 0, paintLive: 0, paintOpen: [0], paintAO: true,
  materials: [], materialsLoading: false, materialsError: null, decals: [], decalsLoading: false, decalsError: null, paintTab: 'layers', texturePreset: 'generic',
}));
const set = useApp.setState, get = useApp.getState;
export const updateScene = (scene: Partial<Scene>) => set((s) => ({ scene: { ...s.scene, ...scene } }));
export const rememberColor = (background: string) => {
  const hex = background.toLowerCase();
  set((s) => ({ recentColors: [hex, ...s.recentColors.filter((c) => c !== hex)].slice(0, 8) }));
};
/** A bundled plate, or '' to take the map off and put the workspace lights back. */
export const setSceneHdriPreset = (id: string) => {
  const prev = get().scene.hdriUrl;
  if (!(id in HDRI_PRESETS)) {
    dropHdri(prev);
    updateScene({ hdriUrl: null, hdriId: '', hdriName: '', hdriBackground: false, hdriStrength: 1, hdriRotation: 0, hdriBlur: 0, ...WORK_LIGHT });
    return;
  }
  const p = HDRI_PRESETS[id as HdriId];
  if (prev !== p.url) dropHdri(prev);
  updateScene({
    hdriUrl: p.url, hdriId: id, hdriName: p.label, hdriBackground: true,
    hdriStrength: p.strength, hdriRotation: p.rotation, hdriBlur: p.blur, exposure: p.exposure, ambient: p.ambient, key: p.key,
  });
};
export const setSceneHdri = (file: File | null) => {
  if (!file) return setSceneHdriPreset('');
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext !== 'hdr' && ext !== 'exr') return set({ error: HDRI_TYPE });
  dropHdri(get().scene.hdriUrl);
  const url = URL.createObjectURL(file), g = CUSTOM_GRADE;
  // The fragment keeps the extension where drei's loader can see it; a blob request drops it.
  set((s) => ({
    error: s.error === HDRI_TYPE ? null : s.error,
    scene: {
      ...s.scene, hdriUrl: `${url}#${encodeURIComponent(file.name)}`, hdriId: 'custom', hdriName: file.name, hdriBackground: true,
      hdriStrength: g.strength, hdriRotation: g.rotation, hdriBlur: g.blur, exposure: g.exposure, ambient: g.ambient, key: g.key,
    },
  }));
};

// One job at a time; the status bar shows what's running and why the last one failed.
async function task(label: string, job: () => Promise<void>) {
  set({ busy: label, error: null });
  try {
    await job();
    set({ server: 'up' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    set((s) => ({ error: message, server: e instanceof ServerDown ? 'down' : s.server,
      loading: s.loading ? { ...s.loading, phase: 'error', error: message } : null }));
  } finally {
    set({ busy: null });
  }
}

// Only the latest request may land: a slow earlier operation must not overwrite a newer part edit.
let latest = 0;
async function solve(refit = true) {
  const { parts, params } = get(), me = ++latest;
  if (!parts.length) return;
  const previous = get().result;
  if (!previous) {
    const preview = { parts: parts.map(placeholder), stats: { islands: 0, tris: 0, flips: 0, mean_stretch: 0, max_stretch: 0, good_area: 0, overlap: 0, efficiency: 0, ms: 0 } };
    set((s) => ({ result: preview, uvs: preview.parts.map((p) => new Float32Array(p.uvs)), uvRev: s.uvRev + 1, rev: s.rev + 1 }));
  }
  set((s) => ({ loading: { phase: 'unwrap', total: parts.length, complete: 0, active: 'All meshes (Rust parallel)', done: parts.map(() => !!previous) } }));
  const result = await api.unwrap(parts.map((p) => ({ ...p, seams: p.marked })), params);
  if (me !== latest) return;
  set((s) => ({
    result, uvs: result.parts.map((p) => new Float32Array(p.uvs)), uvRev: s.uvRev + 1, edited: false, parts: s.parts.map((p, i) => (result.parts[i] ? { ...withBorders(p, result.parts[i]), stale: false } : p)),
    rev: refit ? s.rev + 1 : s.rev, past: [], future: [], csel: null, activePart: Math.min(s.activePart, result.parts.length - 1), loading: null,
  }));
}

/** Poly Doc's view of parts: the bare mesh as the output, no unwrap (all parts, or just one after an edit). Each is
 *  marked stale so UV Magician unwraps it when you go back there. */
function meshOnly(only?: number) {
  const s = get(), stats = { islands: 0, tris: 0, flips: 0, mean_stretch: 0, max_stretch: 0, good_area: 0, overlap: 0, efficiency: 0, ms: 0 };
  const outs = s.parts.map((p, i) => (only === undefined || i === only || !s.result?.parts[i] ? placeholder(p) : s.result.parts[i]));
  set((st) => ({
    result: { parts: outs, stats: st.result?.stats ?? stats }, uvs: outs.map((o, i) => (only === undefined || i === only ? new Float32Array(o.uvs) : st.uvs[i])), uvRev: st.uvRev + 1,
    parts: st.parts.map((p, i) => (only === undefined || i === only ? { ...p, stale: true } : p)), loading: null,
    ...(only === undefined ? { rev: st.rev + 1, activePart: 0 } : {}),
  }));
}

const placeholder = (part: Part): PartOut => {
  const tris = Math.floor(part.soup.length / 9);
  return { positions: Array.from(part.soup), uvs: Array(tris * 6).fill(0), stretch: Array(tris).fill(0), island: Array(tris).fill(-1), source: Array.from({ length: tris }, (_, t) => t) };
};

function uvArea(uv: ArrayLike<number>) {
  let area = 0;
  for (let i = 0; i + 5 < uv.length; i += 6) area += Math.abs((uv[i + 2] - uv[i]) * (uv[i + 5] - uv[i + 1]) - (uv[i + 4] - uv[i]) * (uv[i + 3] - uv[i + 1])) * 0.5;
  return area;
}

function refreshStats(parts: PartOut[], previous: Output['stats'], oneAtlas: boolean, ms: number): Stats {
  let islands = 0, tris = 0, flips = 0, max_stretch = 0, weightedStretch = 0, worldArea = 0, goodArea = 0, totalUvArea = 0, perPartEfficiency = 0;
  for (const p of parts) {
    islands += new Set(p.island).size;
    tris += p.stretch.length;
    perPartEfficiency += uvArea(p.uvs);
    totalUvArea += uvArea(p.uvs);
    for (let t = 0; t < p.stretch.length; t++) {
      const e = p.stretch[t];
      if (e < 0) { flips++; continue; }
      const o = t * 9, ax = p.positions[o], ay = p.positions[o + 1], az = p.positions[o + 2];
      const bx = p.positions[o + 3], by = p.positions[o + 4], bz = p.positions[o + 5];
      const cx = p.positions[o + 6], cy = p.positions[o + 7], cz = p.positions[o + 8];
      const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
      const a = Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) * 0.5;
      worldArea += a; weightedStretch += e * a; if (e < 0.05) goodArea += a; max_stretch = Math.max(max_stretch, e);
    }
  }
  return { ...previous, islands, tris, flips, max_stretch, mean_stretch: worldArea ? weightedStretch / worldArea : 0,
    good_area: worldArea ? goodArea / worldArea : 0, efficiency: oneAtlas ? totalUvArea : (parts.length ? perPartEfficiency / parts.length : 0), ms };
}

/** Replace one part's chart output while retaining every other part's UV edits and atlas allocation. */
async function unwrapPart(partIndex: number) {
  const before = get(), part = before.parts[partIndex], result = before.result;
  if (!part || !result) return;
  const me = ++latest, params = before.params;
  set((s) => ({ loading: { phase: 'unwrap', total: 1, complete: 0, active: part.name, done: s.parts.map((_, i) => i !== partIndex) } }));
  const output = await api.unwrap([{ ...part, seams: part.marked }], { ...params, one_atlas: false });
  const currentPart = get().parts[partIndex];
  if (me !== latest || currentPart?.soup !== part.soup || currentPart?.seams !== part.seams) return;
  const raw = output.parts[0];
  let partUvs = new Float32Array(raw.uvs);
  if (params.one_atlas) {
    const oldUvs = before.uvs[partIndex];
    if (oldUvs?.length) {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (let i = 0; i < oldUvs.length; i += 2) { u0 = Math.min(u0, oldUvs[i]); u1 = Math.max(u1, oldUvs[i]); v0 = Math.min(v0, oldUvs[i + 1]); v1 = Math.max(v1, oldUvs[i + 1]); }
      for (let i = 0; i < partUvs.length; i += 2) { partUvs[i] = u0 + partUvs[i] * (u1 - u0); partUvs[i + 1] = v0 + partUvs[i + 1] * (v1 - v0); }
    }
  }
  land(partIndex, raw, partUvs, part.seams, output.stats.ms, false);
}

/** An edge's key in a seam list (6 numbers per edge, at `o`): its two endpoints, in a fixed order. */
function edgeKey(list: number[], o: number) {
  const a = `${list[o]},${list[o + 1]},${list[o + 2]}`, b = `${list[o + 3]},${list[o + 4]},${list[o + 5]}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
const keysOf = (list: number[]) => { const m = new Map<string, number>(); for (let o = 0; o < list.length; o += 6) m.set(edgeKey(list, o), o); return m; };
/** A seam list with these edges (6 numbers each) added, taken out, or toggled; the same list if nothing changed. */
function editSeams(list: number[], edges: number[], how: 'add' | 'remove' | 'toggle'): number[] {
  const keys = keysOf(list), drop = new Set<number>(), add: number[] = [];
  for (let o = 0; o < edges.length; o += 6) {
    const at = keys.get(edgeKey(edges, o));
    if (at !== undefined) { if (how !== 'add') drop.add(at); }
    else if (how !== 'remove') { add.push(...edges.slice(o, o + 6)); keys.set(edgeKey(edges, o), -1); }
  }
  if (!drop.size && !add.length) return list;
  const out: number[] = [];
  for (let o = 0; o < list.length; o += 6) if (!drop.has(o)) for (let k = 0; k < 6; k++) out.push(list[o + k]);
  for (const x of add) out.push(x);
  return out;
}
/** Symmetric difference of two seam lists: the edges toggled from one to the other. */
function seamDiff(a: number[], b: number[]) {
  const ka = keysOf(a), kb = keysOf(b), out: number[] = [];
  for (const [o, k] of [...ka].map(([k, o]) => [o, k] as const)) if (!kb.has(k)) out.push(...a.slice(o, o + 6));
  for (const [k, o] of kb) if (!ka.has(k)) out.push(...b.slice(o, o + 6));
  return out;
}
/** A part after a fresh unwrap: its seams are every island border on the model (where the two sides differ in UV),
 *  plus the marked ones, as if each had been marked in Blender; clearing one joins the islands there. */
function withBorders(p: Part, out: PartOut): Part {
  const seams = editSeams(seamSegments(out.positions, out.uvs, false), p.marked, 'add');
  return { ...p, seams, solved: seams, manual: false };
}

/** Work a seam edit into the part's UVs as they are: only the islands an added or removed seam touches are solved
 *  again and laid back where they were; every other island, hand edits and all, stays. Unwrap starts over instead. */
async function reseamPart(partIndex: number, join: number[] = []) {
  const before = get(), part = before.parts[partIndex], out = before.result?.parts[partIndex], uvs = before.uvs[partIndex];
  if (!part || !out || !uvs) return;
  const changed = [...seamDiff(part.solved, part.seams), ...join];
  if (!changed.length) return;
  const me = ++latest, t0 = performance.now();
  set((s) => ({ loading: { phase: 'unwrap', total: 1, complete: 0, active: part.name, done: s.parts.map((_, i) => i !== partIndex) } }));
  const pins = [...(pinsOf(before, partIndex) ?? [])];
  const r = await api.reseam({ positions: out.positions, uvs: Array.from(uvs), stretch: out.stretch, island: out.island, seams: part.seams, changed, pins, manual: part.manual }, before.params);
  const now = get();
  if (me !== latest || now.result !== before.result || now.parts[partIndex]?.seams !== part.seams) return;
  land(partIndex, { ...out, ...r }, new Float32Array(r.uvs), part.seams, performance.now() - t0, true);
  await tidy(partIndex, uvs);
}

/** After a seam edit landed: the islands it changed (any corner moved from `before`) turned straight, the part packed
 *  again, as the Align / Pack switches say; part of the edit's undo step. */
async function tidy(part: number, before: Float32Array) {
  const s = get(), a = s.uvs[part];
  if (!s.result || !a || a.length !== before.length || (!s.afterAlign && !s.afterPack)) return;
  const isl = islandsOf(s.result), changed = new Set(isl.flatMap((x, id) =>
    x.part === part && x.corners.some((c) => a[c * 2] !== before[c * 2] || a[c * 2 + 1] !== before[c * 2 + 1]) ? [id] : []));
  if (s.afterAlign) for (const id of changed) straighten(a, isl[id].corners);
  if (s.afterPack) {
    // the changed islands into the free space round the rest (fast, nothing else moves); no room: pack it all
    const atlas = isl.flatMap((x, id) => (s.params.one_atlas || x.part === part ? [{ id, a: s.uvs[x.part], corners: x.corners }] : []));
    if (!placeChanged(atlas.filter((x) => !changed.has(x.id)), atlas.filter((x) => changed.has(x.id)))) (await packed(part))();
  }
  set((st) => ({ uvRev: st.uvRev + 1 }));
}

/** One part's new output into the result, island ids renumbered across parts; every other part keeps its UVs.
 *  `keep`: a reseam, the part's hand edits carry over (and its selection: same positions, same topology). */
function land(partIndex: number, raw: PartOut, partUvs: Float32Array, seams: number[], ms: number, keep: boolean) {
  const before = get(), result = before.result!, params = before.params;
  const nextParts = result.parts.slice();
  nextParts[partIndex] = { ...raw, uvs: Array.from(partUvs) };
  let nextId = 0;
  for (let i = 0; i < nextParts.length; i++) {
    const p = nextParts[i], local = [...new Set(p.island)].sort((a, b) => a - b), map = new Map(local.map((id) => [id, nextId++]));
    nextParts[i] = { ...p, island: p.island.map((id) => map.get(id)!) };
  }
  const nextUvs: Float32Array[] = before.uvs.map((a) => a.slice());
  nextUvs[partIndex] = partUvs;
  const nextResult: Output = { parts: nextParts, stats: refreshStats(nextParts, result.stats, params.one_atlas, ms) };
  set((s) => ({ result: nextResult, uvs: nextUvs, uvRev: s.uvRev + 1, edited: keep && s.edited, loading: null, past: [], future: [],
    parts: s.parts.map((p, i) => (i !== partIndex ? p : keep ? { ...p, solved: seams, stale: false } : { ...withBorders(p, raw), stale: false })) }));
}

// ---- loading, unwrapping, exporting ----
export const connect = () => task('Connecting to engine…', async () => {
  void recentFiles().then((r) => set({ recent: r.map(({ name, time }) => ({ name, time })) }));
  set({ shapes: await api.shapes() });
});
export const unwrap = () => task('Unwrapping…', async () => {
  if (get().loading) return;
  const { activePart, parts } = get();
  if (parts.length) await unwrapPart(activePart);
});
export const loadShape = (name: string) => task(`Unwrapping ${name}…`, async () => {
  const me = ++latest;
  set({ loading: { phase: 'read', total: 0, complete: 0, active: null, done: [] }, source: name });
  const soup = new Float32Array(await api.shape(name));
  if (me !== latest) return;
  const parts = [{ name, soup, seams: [], marked: [], solved: [], visible: true, textured: true }];
  setModelSize([soup]);
  resetPaintHistory();
  set({ source: name, unit: 100, parts, partsPast: [], partsFuture: [], result: null, uvs: [], activePart: 0, layerSel: [0], layerAnchor: 0, uvScope: 'part', csel: null, fixNote: null });
  if (get().workspace === 'doc') meshOnly(); else await solve();
});
export const openFile = (file: File) => task(`Unwrapping ${file.name}…`, async () => {
  const me = ++latest;
  set({ loading: { phase: 'read', total: 0, complete: 0, active: file.name, done: [] }, source: file.name });
  const { parts: imported, unit } = await readParts(file);
  if (me !== latest) return;
  const parts = imported.map((p) => ({ ...p, seams: [], marked: [], solved: [], visible: true, textured: true }));
  setModelSize(parts.map((p) => p.soup));
  resetPaintHistory();
  set({ source: file.name, unit, parts, partsPast: [], partsFuture: [], result: null, uvs: [], activePart: 0, layerSel: parts.length ? [0] : [], layerAnchor: 0, uvScope: 'part', csel: null, fixNote: null });
  if (get().workspace === 'doc') meshOnly(); else await solve();
});
export const setParams = (p: Partial<Params>) => {
  const old = get().params, changed = Object.keys(p);
  set({ params: { ...old, ...p } });
  // The current full-model solve will read these values after a pending file read.
  // During a solve, defer recomputing until the user explicitly asks for it afterward.
  if (get().loading) return;
  if (changed.length === 1 && changed[0] === 'one_atlas') void repack();
  else void unwrap();
};

/** Ctrl+O: the system's open dialog (with a handle to reopen the file by, where the browser has one), else a file input. */
export async function pickFile() {
  let picked: Awaited<ReturnType<typeof pickWithHandle>>;
  try { picked = await pickWithHandle(); } catch (e) { set({ error: `Couldn't open that file: ${(e as Error).message}` }); return; }
  if (picked === 'cancelled') return;
  if (picked) return openRemembered(picked.file, picked.handle);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.fbx,.obj,.glb,.gltf,.stl';
  input.onchange = () => input.files?.[0] && openRemembered(input.files[0]);
  input.click();
}
/** Open a file and put it at the top of File › Open Recent. */
async function openRemembered(file: File, handle?: FileSystemFileHandle) {
  await remember(file, handle);
  set({ recent: (await recentFiles()).map(({ name, time }) => ({ name, time })) });
  return openFile(file);
}
/** File › Open Recent › a file: read it again (from disk, or the kept copy) and open it. */
export const openRecent = (name: string) => task(`Opening ${name}…`, async () => {
  const r = (await recentFiles()).find((x) => x.name === name);
  if (!r) return;
  let file: File;
  try { file = await reopen(r); } catch (e) {
    await forgetRecent(name);
    set({ recent: (await recentFiles()).map(({ name, time }) => ({ name, time })) });
    throw new Error(`${name} couldn't be opened again (moved or deleted?): it's off the recent list. ${(e as Error).message}`);
  }
  await openRemembered(file, r.handle);
});
export const clearRecent = async () => { await clearRecentFiles(); set({ recent: [] }); };

const baseName = () => (get().source ?? 'mesh').replace(/\.[^.]+$/, '');
// Every part with its current UVs; with one atlas they share a material, so Painter gives them one texture set.
function exportParts(): ExportPart[] | null {
  const { result, uvs, parts, params } = get();
  if (!result) return null;
  if (result.parts.length !== parts.length || uvs.length !== parts.length) throw new Error('Export stopped: the unwrapped mesh count does not match the imported part count.');
  const tri = get().triangulate;
  return parts.map((p, i) => ({ name: p.name, material: params.one_atlas ? baseName() : p.name, out: result.parts[i], uv: uvs[i],
    faces: tri || !p.poly ? undefined : polygonsOf(result.parts[i].source, p.poly),
    normals: p.normals?.length === p.soup.length ? outNormals(result.parts[i].positions, result.parts[i].source, p.soup, p.normals) : undefined }));
}
export const setTriangulate = (triangulate: boolean) => set({ triangulate });
export const exportFbx = () => task('Exporting FBX…', async () => {
  await unwrapChanged();
  const ps = exportParts();
  if (ps) download(toFbx(ps, get().params.sharp, get().unit), `${baseName()}-unwrapped.fbx`);
});
export const exportObjParts = () => task('Exporting OBJ parts…', async () => {
  await unwrapChanged();
  const ps = exportParts();
  if (ps) download(zipFiles(toObjs(ps, get().params.sharp, get().unit)).buffer as ArrayBuffer, `${baseName()}-unwrapped-obj.zip`);
});

// ---- parts and seams ----
export function setPartVisible(i: number, visible: boolean) {
  set({ parts: get().parts.map((p, j) => (j === i ? { ...p, visible } : p)) });
}
export function setPartTextured(i: number, textured: boolean) {
  set({ parts: get().parts.map((p, j) => (j === i ? { ...p, textured } : p)) });
}
/** Click a part row. Shift selects the range from the anchor. Ctrl toggles that part. */
export function selectPart(i: number, shift = false, ctrl = false) {
  set((s) => {
    let layerSel: number[], active = i, layerAnchor = i;
    if (ctrl) {
      const has = s.layerSel.includes(i);
      layerSel = (has ? s.layerSel.filter((j) => j !== i) : [...s.layerSel, i]).sort((a, b) => a - b);
      if (has) active = layerSel.includes(s.activePart) ? s.activePart : (layerSel.at(-1) ?? s.activePart);
    } else if (shift) {
      const a = Math.min(s.layerAnchor, i), b = Math.max(s.layerAnchor, i);
      layerSel = Array.from({ length: b - a + 1 }, (_, k) => a + k);
      layerAnchor = s.layerAnchor;
    } else layerSel = [i];
    return { activePart: active, uvScope: 'part', csel: shift || ctrl ? s.csel : null, layerSel, layerAnchor };
  });
}
export const selectAllParts = () => set((s) => ({ layerSel: s.parts.map((_, i) => i) }));
export const selectNoParts = () => set({ layerSel: [] });
/** Hide the parts selected in the list. If every one of them is already hidden, show them. */
export function hideSelectedParts() {
  const { parts, layerSel } = get();
  if (!layerSel.length) return;
  const on = new Set(layerSel), hide = layerSel.some((i) => parts[i]?.visible);
  set({ parts: parts.map((p, i) => (on.has(i) ? { ...p, visible: !hide } : p)) });
}
/** Hide every part; if every one is already hidden, show them all. */
export function hideAllParts() {
  const parts = get().parts, hide = parts.some((p) => p.visible);
  set({ parts: parts.map((p) => ({ ...p, visible: !hide })) });
}
/** Hide every part but the selected ones (Blender's Shift+H), showing those. */
export function hideOtherParts() {
  const { parts, layerSel } = get(), on = new Set(layerSel);
  if (on.size) set({ parts: parts.map((p, i) => ({ ...p, visible: on.has(i) })) });
}
/** Right click on the parts list: on a part not selected, that part is picked first, as a file list does. */
export function partsMenu(x: number, y: number, row: number | null) {
  if (row !== null && !get().layerSel.includes(row)) selectPart(row);
  const { parts, layerSel } = get(), none = !layerSel.length;
  const hidden = !none && layerSel.every((i) => !parts[i]?.visible), allHidden = parts.every((p) => !p.visible);
  pointer.x = x; pointer.y = y;
  openMenu('Parts', [
    { label: 'Select all', run: selectAllParts, off: !parts.length },
    { label: 'Select none', run: selectNoParts, off: none },
    { label: hidden ? 'Show selected' : 'Hide selected', run: hideSelectedParts, off: none },
    { label: 'Hide others', run: hideOtherParts, off: none },
    { label: allHidden ? 'Show all' : 'Hide all', run: hideAllParts, off: !parts.length },
    { label: 'Clear all seams', run: () => void clearAllSeams(), off: !get().result?.parts[get().activePart] },
  ]);
}
/** Bring one part's UVs up on their own (picking a part, or an island of it, in 3D or the parts list). */
export const showPart = (i: number) => set({ activePart: i, uvScope: 'part' });
export const setUvScope = (uvScope: UvScope) => set({ uvScope });

/** Gap between part tiles in the whole-model UV view, in UV units (a tile is 1). */
export const TILE = 1.2;
/**
 * Where each part's UVs sit in the UV view: an offset in UV units, or null when not shown. One part at a time,
 * or the whole model: the shared atlas as is, or each part's own square as a tile in a grid (top row first).
 */
export function uvTiles(): { at: ([number, number] | null)[]; cols: number; rows: number } {
  const { parts, params, activePart, uvScope, loading } = get();
  const shown = parts.map((p, i) => p.visible && (uvScope === 'all' || i === activePart));
  if (uvScope === 'part' || (params.one_atlas && !loading)) return { at: shown.map((s) => (s ? [0, 0] : null)), cols: 1, rows: 1 };
  const order = shown.flatMap((s, i) => (s ? [i] : [])), cols = Math.max(1, Math.ceil(Math.sqrt(order.length))), rows = Math.max(1, Math.ceil(order.length / cols));
  const at: ([number, number] | null)[] = parts.map(() => null);
  order.forEach((i, k) => { at[i] = [(k % cols) * TILE, (rows - 1 - Math.floor(k / cols)) * TILE]; });
  return { at, cols, rows };
}

const partSnapshot = (st: State): PartSnap => ({ parts: st.parts, result: st.result, uvs: st.uvs.map((a) => a.slice()), csel: st.csel,
  activePart: st.activePart, uvScope: st.uvScope, past: st.past, future: st.future });
const keepParts = () => set((st) => ({
  partsPast: [...st.partsPast.slice(-19), partSnapshot(st)],
  partsFuture: [], past: [], future: [],
}));

/** The edges a Cut or a Stitch works on, as edge ids: the selected edges (vertex and edge modes); with faces
 *  selected, for a Cut their outline (edges with one side selected), for a Stitch the edges between them. A Stitch
 *  keeps only edges that are apart now: a seam, or UVs torn apart by hand. */
function sewEdges(c: CompSel, stitch: boolean): number[] {
  const s = get(), t = topoOf(c.of), a = s.uvs[c.part], seams = keysOf(s.parts[c.part]?.seams ?? []);
  const faceMode = s.selectMode === 'face' || s.selectMode === 'island';
  const inSel = (e: number) => t.edgeTris[e].filter((f) => c.faces.has(f)).length;
  const ids = [...c.edges].filter((e) => !faceMode || (stitch ? inSel(e) >= 2 : inSel(e) === 1 && t.edgeTris[e].length > 1));
  if (!stitch) return ids;
  // apart: a seam, or the two sides' corners at either end don't share a UV
  const apart = (e: number) => {
    const ends = [t.ends[e * 2], t.ends[e * 2 + 1]], key = edgeKey(edgeXyz(t, [e]), 0);
    if (seams.has(key)) return true;
    const [f, g] = t.edgeTris[e];
    if (g === undefined) return false;
    return ends.some((v) => {
      const cf = [0, 1, 2].map((k) => f * 3 + k).find((k) => t.vid[k] === v)!, cg = [0, 1, 2].map((k) => g * 3 + k).find((k) => t.vid[k] === v)!;
      return a[cf * 2] !== a[cg * 2] || a[cf * 2 + 1] !== a[cg * 2 + 1];
    });
  };
  return ids.filter(apart);
}
/** Edge ids as a seam list: two xyz endpoints (6 numbers) each. */
const edgeXyz = (t: Topo, ids: number[]) => ids.flatMap((e) => [...t.pos.slice(t.ends[e * 2] * 3, t.ends[e * 2] * 3 + 3), ...t.pos.slice(t.ends[e * 2 + 1] * 3, t.ends[e * 2 + 1] * 3 + 3)]);

/** Cut (snip): the edges become seams; Stitch: they stop being seams and the two sides meet again (a tear made by
 *  hand too). Only the islands they touch are solved again; one undo step. */
function sew(stitch: boolean) {
  const cur = liveSel();
  if (!cur || get().loading) return;
  const edges = edgeXyz(topoOf(cur.of), sewEdges(cur, stitch));
  if (!edges.length) return;
  const i = cur.part, how = stitch ? 'remove' : 'add';
  keepParts();
  set({ parts: get().parts.map((p, j) => (j !== i ? p : { ...p, seams: editSeams(p.seams, edges, how), marked: editSeams(p.marked, edges, how) })) });
  void task(stitch ? 'Stitching…' : 'Cutting…', () => reseamPart(i, stitch ? edges : []));
}
export const cutSelection = () => sew(false);
export const stitchSelection = () => sew(true);

/** Start over by hand: every seam on the active part cleared, auto and marked, its UVs laid flat from none (closed
 *  shells projected). From here islands are only what C cuts and V stitches; Auto Unwrap goes back to automatic. */
export const clearAllSeams = () => task('Clearing seams…', async () => {
  const s = get(), i = s.activePart, part = s.parts[i], out = s.result?.parts[i], uvs = s.uvs[i];
  if (!part || !out || !uvs || s.loading) return;
  keepParts();
  set({ parts: get().parts.map((p, j) => (j === i ? { ...p, seams: [], marked: [], manual: true } : p)) });
  const me = ++latest, t0 = performance.now();
  const r = await api.reseam({ positions: out.positions, uvs: Array.from(uvs), stretch: out.stretch, island: out.island, seams: [], changed: [], pins: [],
    faces: out.island.map((_, t) => t), manual: true }, s.params);
  if (me !== latest || get().result !== s.result) return;
  land(i, { ...out, ...r }, new Float32Array(r.uvs), [], performance.now() - t0, true);
  await tidy(i, uvs);
});

/** Clear the seams marked by hand on the active part (the islands they cut join again). */
export function clearSeams() {
  const active = get().activePart, current = get().parts[active];
  if (!current?.marked.length || get().loading) return;
  keepParts();
  set({ parts: get().parts.map((p, j) => (j === active ? { ...p, seams: editSeams(p.seams, p.marked, 'remove'), marked: [] } : p)) });
  void task(`Re-solving seams on ${current.name}…`, () => reseamPart(active));
}

// ---- selection: Blender's edit-mode selection, one set shared by the 3D and UV views ----
/** The selection, if it still belongs to the part's current output (unwrapping the part again ends it). */
export function liveSel(s: State = get()): CompSel | null {
  const c = s.csel;
  return c && s.result?.parts[c.part]?.positions === c.of ? c : null;
}
type Kind = 'verts' | 'edges' | 'faces';
/** What a mode picks: vertices, edges or faces (island mode: faces, whole islands at a time). */
export const kindOf = (m: SelectMode): Kind => (m === 'vert' ? 'verts' : m === 'edge' ? 'edges' : 'faces');
/** The selection counted the way the status and options bars say it, in every workspace: a face is its whole polygon
 *  (not its triangles), an edge you can pick (not a polygon's hidden diagonal), an island the islands it touches. */
export function selectionCount(s: State = get()): { n: number; label: string } | null {
  const c = liveSel(s);
  if (!c) return null;
  const m = s.selectMode;
  if (m === 'island') {
    const n = s.selected.length;
    return { n, label: n === 1 ? 'island' : 'islands' };
  }
  if (m === 'face') {
    const out = s.result?.parts[c.part], pid = out ? polygonsOf(out.source, s.parts[c.part]?.poly) : null;
    const n = pid ? new Set([...c.faces].map((f) => (pid[f] < 0 ? -1 - f : pid[f]))).size : c.faces.size;
    return { n, label: n === 1 ? 'face' : 'faces' };
  }
  if (m === 'edge') {
    const out = s.result?.parts[c.part];
    if (!out) return { n: c.edges.size, label: c.edges.size === 1 ? 'edge' : 'edges' };
    const pid = polygonsOf(out.source, s.parts[c.part]?.poly), t = topoOf(c.of);
    const n = [...c.edges].filter((e) => { const [a, b] = t.edgeTris[e]; return b === undefined || pid[a] < 0 || pid[a] !== pid[b]; }).length;
    return { n, label: n === 1 ? 'edge' : 'edges' };
  }
  const n = c.verts.size;
  return { n, label: n === 1 ? 'vertex' : 'vertices' };
}

/** A selection of one kind with the other two flushed from it, as Blender does: in vertex mode an edge is selected
 *  when both its ends are and a face when its three corners are; in edge mode a face when its three edges are;
 *  in face mode the edges and corners of the selected faces. */
function flushed(part: number, of: number[], kind: Kind, own: Iterable<number>): CompSel {
  const t = topoOf(of), nt = t.vid.length / 3, ne = t.ends.length / 2;
  const verts = new Set<number>(), edges = new Set<number>(), faces = new Set<number>();
  if (kind === 'verts') {
    for (const v of own) verts.add(v);
    for (let e = 0; e < ne; e++) if (verts.has(t.ends[e * 2]) && verts.has(t.ends[e * 2 + 1])) edges.add(e);
    for (let f = 0; f < nt; f++) if (verts.has(t.vid[f * 3]) && verts.has(t.vid[f * 3 + 1]) && verts.has(t.vid[f * 3 + 2])) faces.add(f);
  } else if (kind === 'edges') {
    for (const e of own) { edges.add(e); verts.add(t.ends[e * 2]); verts.add(t.ends[e * 2 + 1]); }
    for (let f = 0; f < nt; f++) if (edges.has(t.edge[f * 3]) && edges.has(t.edge[f * 3 + 1]) && edges.has(t.edge[f * 3 + 2])) faces.add(f);
  } else {
    for (const f of own) { faces.add(f); for (let k = 0; k < 3; k++) { verts.add(t.vid[f * 3 + k]); edges.add(t.edge[f * 3 + k]); } }
  }
  return { part, of, verts, edges, faces };
}
const polyMembers = new WeakMap<Int32Array, Map<number, number[]>>();
/** Every triangle of the polygons these triangles belong to (output ids; a triangle with no polygon is its own). */
function wholePolygons(out: PartOut, poly: Int32Array | undefined, faces: Iterable<number>): number[] {
  if (!poly) return [...faces];
  const pid = polygonsOf(out.source, poly);
  let m = polyMembers.get(pid);
  if (!m) { m = new Map(); pid.forEach((p, f) => { if (p >= 0) (m!.get(p) ?? m!.set(p, []).get(p)!).push(f); }); polyMembers.set(pid, m); }
  const out2 = new Set<number>();
  for (const f of faces) for (const g of pid[f] >= 0 ? m.get(pid[f])! : [f]) out2.add(g);
  return [...out2];
}
/** Only the polygons whose every triangle is among these faces. */
function completePolygons(out: PartOut, poly: Int32Array | undefined, faces: Set<number>): number[] {
  if (!poly) return [...faces];
  const pid = polygonsOf(out.source, poly), whole = wholePolygons(out, poly, faces), missing = new Set<number>();
  for (const f of whole) if (!faces.has(f)) missing.add(pid[f]);
  return whole.filter((f) => !missing.has(pid[f]));
}
/** Every face connected to these across shared edges: Poly Doc's Select Linked (it has no islands, it doesn't unwrap). */
function wholeMesh(positions: number[], faces: Iterable<number>): number[] {
  const t = topoOf(positions), seen = new Uint8Array(t.vid.length / 3), out: number[] = [];
  for (const f of faces) if (!seen[f]) { seen[f] = 1; out.push(f); }
  for (let i = 0; i < out.length; i++) for (let k = 0; k < 3; k++) for (const g of t.edgeTris[t.edge[out[i] * 3 + k]]) if (!seen[g]) { seen[g] = 1; out.push(g); }
  return out;
}
/** Linked faces: the whole island in UV Magician, the whole connected piece of mesh in Poly Doc. */
const linked = (out: PartOut, faces: Iterable<number>) => (get().workspace === 'doc' ? wholeMesh(out.positions, faces) : wholeIslands(out.island, faces));
/** Every face of the islands these faces are on. */
function wholeIslands(island: number[], faces: Iterable<number>) {
  const ids = new Set<number>(), out: number[] = [];
  for (const f of faces) ids.add(island[f]);
  island.forEach((id, f) => { if (ids.has(id)) out.push(f); });
  return out;
}
/** Faces with a corner on one of these vertices. */
function facesAround(t: Topo, verts: Set<number>) {
  const out = new Set<number>();
  for (let c = 0; c < t.vid.length; c++) if (verts.has(t.vid[c])) out.add((c / 3) | 0);
  return out;
}

/** set: replace · add · sub: take away · toggle: Shift+click (off if all already on). */
export type SelOp = 'set' | 'add' | 'sub' | 'toggle';
/** Change one part's selection by elements of the mode's kind: vertex, edge or face ids of its output (island
 *  mode: any face of each island). */
export function selectElems(part: number, ids: Iterable<number>, op: SelOp = 'set', polygons = true) {
  const s = get(), out = s.result?.parts[part];
  if (!out) return;
  const kind = kindOf(s.selectMode), cur = liveSel(s), own = new Set(op !== 'set' && cur?.part === part ? cur[kind] : []);
  // a face is its whole polygon, however it was picked (click, box, all, linked, the UV view), as in Blender
  // (not for whole islands in UV Magician: a seam can run through a quad, and an island must stay exactly itself)
  const pick = s.selectMode === 'island' ? wholeIslands(out.island, ids) : kind === 'faces' && polygons ? wholePolygons(out, s.parts[part]?.poly, ids) : [...ids];
  const allOn = pick.length > 0 && pick.every((x) => own.has(x));
  for (const x of pick) { if (op === 'sub' || (op === 'toggle' && allOn)) own.delete(x); else own.add(x); }
  set({ csel: own.size ? flushed(part, out.positions, kind, own) : null, activePart: part, uvScope: 'part' });
}
/** Select by faces, whatever the mode (in vertex mode their corners, in edge mode their edges). */
function selectFaces(part: number, faces: number[], op: SelOp, polygons = true) {
  const out = get().result?.parts[part];
  if (!out) return;
  const kind = kindOf(get().selectMode);
  selectElems(part, kind === 'faces' ? faces : flushed(part, out.positions, 'faces', faces)[kind], op, polygons);
}
export function showWorkspace(workspace: Workspace) {
  // Poly Doc has no islands (it doesn't unwrap) and no UV view: island select mode becomes face, framing keys target 3D
  if (workspace === 'doc') { if (get().selectMode === 'island') setSelectMode('face'); pointer.view = '3d'; }
  set(workspace === 'uv' ? { workspace } : { workspace, unfold: 0 });
  try { localStorage.setItem('workspace', workspace); } catch { /* private mode */ }
  if (workspace !== 'doc') void unwrapStale(); // Van Gogh paints through the UVs
}
/** UV Magician picks up what Poly Doc changed: every part if none has UVs yet, else each changed part on its own. */
const unwrapStale = () => task('Unwrapping what Poly Doc changed…', unwrapChanged);
/** The parts Poly Doc left mesh-only, unwrapped (export needs their UVs too). */
async function unwrapChanged() {
  const { parts } = get(), stale = parts.flatMap((p, i) => (p.stale ? [i] : []));
  if (!stale.length) return;
  if (stale.length === parts.length) return solve();
  for (const i of stale) await unwrapPart(i);
}
/** Poly Doc: select every face of the active part whose polygon has `min`..`max` sides (tris 3..3, quads 4..4, n-gons 5..∞). */
export function selectPolygons(min: number, max: number) {
  const { result, activePart, parts } = get(), out = result?.parts[activePart];
  if (!out) return;
  const sides = sidesOf(polygonsOf(out.source, parts[activePart]?.poly), parts[activePart]?.sides), faces: number[] = [];
  sides.forEach((n, t) => { if (n >= min && n <= max) faces.push(t); });
  if (!faces.length) return set({ csel: null });
  selectFaces(activePart, faces, 'set');
  viewOp('3d', 'selected');
}
/** A Poly Doc fix on the selection's part: the triangles stay, their grouping into polygons changes (one undo step). */
const polys = (n: number) => `${n} polygon${n === 1 ? '' : 's'}`;
function regroup(what: string, edit: (soup: Float32Array, cur: Polys, c: CompSel, t: Topo, src: number[]) => Polys | null, why: (kinds: string) => string) {
  const s = get(), c = liveSel(s), out = c && s.result?.parts[c.part], part = c && s.parts[c.part];
  if (!c || !out || !part) return set({ fixNote: `${what}: select something first.` });
  const cur = part.poly && part.sides ? { poly: part.poly, sides: part.sides } : ownPolygons(part.soup.length / 9);
  const tris = [...c.faces].map((f) => out.source[f]), count = (p: Polys) => new Set(tris.map((f) => p.poly[f])).size;
  const next = edit(part.soup, cur, c, topoOf(out.positions), out.source);
  if (!next) {
    const k = [0, 0, 0];
    for (const p of new Set(tris.map((f) => cur.poly[f]))) k[Math.min(cur.sides[p], 5) - 3]++;
    return set({ fixNote: `${what}: nothing changed. ${why([k[0] && `${k[0]} triangles`, k[1] && `${k[1]} quads`, k[2] && `${k[2]} n-gons`].filter(Boolean).join(', ') || 'no faces')}` });
  }
  keepParts();
  set({ parts: s.parts.map((p, i) => (i === c.part ? { ...p, poly: next.poly, sides: next.sides } : p)), fixNote: `${what}: ${polys(count(cur))} → ${count(next)}.` });
}
/** X › Dissolve: faces selected → the polygons merge into one per connected patch (Dissolve Faces); edges selected → the
 *  polygons on either side of each edge merge (Dissolve Edges). */
export const dissolveSel = () => regroup('Dissolve', (soup, cur, c, t, src) => {
  if (get().selectMode === 'face' || get().selectMode === 'island') return dissolveFaces(soup, cur, [...c.faces].map((f) => src[f]));
  const pairs: [number, number][] = [];
  for (const e of c.edges) {
    const [a, b] = t.edgeTris[e];
    if (b !== undefined && t.edgeTris[e].length === 2) pairs.push([src[a], src[b]]);
  }
  return dissolve(soup, cur, pairs);
}, (k) => `The selection (${k}) can't merge into polygons with one clean outline (it would close round a hole), or there's nothing between its faces to dissolve.`);
/** The active selection in soup terms, as a Poly Doc tool takes it: faces (and their corners) in face mode, edges you
 *  can see (not a polygon's diagonal) in edge and vertex modes, vertices in vertex mode. */
function soupSel(): { part: number; g: Geo; sel: SoupSel } | null {
  const s = get(), c = liveSel(s), out = c && s.result?.parts[c.part], part = c && s.parts[c.part];
  if (!c || !out || !part) return null;
  const L = link(out, part.soup), t = topoOf(c.of), cur = part.poly && part.sides ? { poly: part.poly, sides: part.sides } : ownPolygons(part.soup.length / 9);
  const pid = polygonsOf(out.source, part.poly), faceMode = s.selectMode === 'face' || s.selectMode === 'island';
  const verts = [...c.verts].map((v) => L.toSoup[v]).filter((v) => v >= 0);
  const edges = faceMode ? [] : [...c.edges].filter((e) => { const [a, b] = t.edgeTris[e]; return b === undefined || pid[a] < 0 || pid[a] !== pid[b]; })
    .map((e) => [L.toSoup[t.ends[e * 2]], L.toSoup[t.ends[e * 2 + 1]]] as [number, number]).filter(([a, b]) => a >= 0 && b >= 0);
  return { part: c.part, g: { soup: part.soup, ...cur },
    sel: { faces: faceMode ? [...c.faces].map((f) => out.source[f]) : [], verts: s.selectMode === 'vert' || faceMode ? verts : [], edges } };
}
/** Select in a part by soup ids (vertices, edge vertex pairs, triangles), switching to the mode that shows them. */
function selectSoup(part: number, what: { verts?: number[]; edges?: [number, number][]; faces?: number[] }) {
  const s = get(), out = s.result?.parts[part], p = s.parts[part];
  if (!out || !p) return;
  const L = link(out, p.soup), t = topoOf(out.positions);
  if (what.faces) {
    if (s.selectMode !== 'face') set({ selectMode: 'face' });
    return selectFaces(part, what.faces.map((f) => L.triOut[f]).filter((f) => f >= 0), 'set');
  }
  set({ selectMode: what.edges ? 'edge' : 'vert' });
  const ids = what.edges ? what.edges.map(([a, b]) => edgeBetween(t, L.toOut[a], L.toOut[b])) : (what.verts ?? []).map((v) => L.toOut[v]);
  selectElems(part, ids.filter((x) => x >= 0));
}
/** A Poly Doc tool that moves or adds geometry: the part's triangles are replaced (one undo step), shown as the bare
 *  mesh (no unwrap: UV Magician does that when you go back), and what the tool made selected so the next press keeps
 *  working on it. Hand-marked seams on edges that no
 *  longer exist are dropped. */
const reshape = (what: string, need: string, done: string, why: string, edit: (g: Geo, s: SoupSel) => Done | null, guard = false) => task(`${what}…`, async () => {
  const at = soupSel();
  if (!at || !(at.sel.faces.length || at.sel.verts.length || at.sel.edges.length)) return set({ fixNote: `${what}: select ${need} first.` });
  const r = edit(at.g, at.sel), part = get().parts[at.part];
  if (!r) return set({ fixNote: `${what}: nothing changed. ${why}` });
  if (guard) {
    // a tool meant to make things better never makes them worse: refused if more faces would turn red than before
    const red = (g: Geo) => { const n = new Map<RuleId, number>(); let total = 0; for (const [, is] of healthReport(g).issues) { const bad = is.filter((i) => i.score >= 0.6); if (bad.length) total++; for (const i of bad) n.set(i.rule, (n.get(i.rule) ?? 0) + 1); } return { total, n }; };
    const was = red(at.g), now = red(r.geo);
    if (now.total > was.total) {
      const worse = [...now.n].filter(([rule, c]) => c > (was.n.get(rule) ?? 0)).map(([rule]) => RULES[rule].name.toLowerCase()).join(', ');
      return set({ fixNote: `${what}: not applied, it would turn ${now.total - was.total} more face${now.total - was.total === 1 ? '' : 's'} red (${worse}). Try fewer Rounds, Slide borders off, or a smaller patch.` });
    }
  }
  const edges = new Set<string>(), k = (a: ArrayLike<number>, o: number) => `${a[o]},${a[o + 1]},${a[o + 2]}`;
  for (let f = 0; f < r.geo.soup.length / 9; f++) for (let i = 0; i < 3; i++) {
    const a = k(r.geo.soup, f * 9 + i * 3), b = k(r.geo.soup, f * 9 + ((i + 1) % 3) * 3);
    edges.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  const marked: number[] = [];
  for (let o = 0; o < part.marked.length; o += 6) {
    const a = k(part.marked, o), b = k(part.marked, o + 3);
    if (edges.has(a < b ? `${a}|${b}` : `${b}|${a}`)) marked.push(...part.marked.slice(o, o + 6));
  }
  keepParts();
  set({ parts: get().parts.map((p, i) => (i === at.part ? { ...p, soup: r.geo.soup, poly: r.geo.poly, sides: r.geo.sides, normals: undefined, marked, seams: marked, solved: [] } : p)), csel: null, fixNote: `${what}: ${done}` });
  meshOnly(at.part);
  // what it made, found again in the new soup by position
  const t = topoOfSoup(r.geo.soup), vid = (p: number[]) => t.at.get(xyzKey(p[0], p[1], p[2])) ?? -1;
  selectSoup(at.part, r.faces ? { faces: r.faces } : r.edges ? { edges: r.edges.map(([a, b]) => [vid(a), vid(b)] as [number, number]).filter(([a, b]) => a >= 0 && b >= 0) } : { verts: (r.verts ?? []).map(vid).filter((v) => v >= 0) });
});
export const relaxPolySel = () => reshape('Even Out', 'faces', 'spacing evened out; the shape, outline and creases stay.',
  'Every vertex there is a corner (or on the border with Slide borders off). Select a bigger patch.', (g, s) => relax(g, s, get().docOpts.relax, get().slideBorders), true);
export const subdivideSel = () => reshape('Subdivide', 'faces', 'each polygon cut into quads.', 'The selected polygons have no simple outline to cut.', subdivide);
export const connectSel = () => reshape('Connect', 'two vertices of a polygon, or two of its edges', 'new edges cut across.',
  "Pick two vertices of one polygon that aren't already joined by an edge (vertex mode), or two edges of one polygon (edge mode).", connectPolys);
export const mergePolySel = (collapse: boolean) => reshape(collapse ? 'Collapse' : 'Merge', collapse ? 'edges' : 'vertices',
  collapse ? 'each group of edges collapsed to its centre.' : 'merged at their centre.',
  collapse ? 'Collapse works on selected edges.' : 'Pick at least two vertices.', (g, s) => mergeVerts(g, s, collapse));
export const rotateEdgeSel = () => reshape('Rotate Edge', 'an edge between two polygons', 'edge turned one step.', 'The edge needs a polygon on each side.', rotateEdge);
export const addLoopsSel = () => reshape('Add Loops on Curve', 'faceted faces', 'new loops rounding the curve out.', 'It needs a quad on a faceted curve.', (g, s) => addLoops(g, s), true);
export const loopCutSel = () => reshape('Loop Cut', 'an edge', 'new loop cut across the quads.', 'The selected edge needs a quad beside it.', (g, s) => loopCut(g, s));
export const slideSel = (f: number) => reshape('Edge Slide', 'edges', 'loop slid along its rails.', 'Select a chain of edges with polygons beside it.', (g, s) => slide(g, s, f));
export const shapeLoopSel = (how: 'space' | 'straight' | 'circle') => reshape(how === 'space' ? 'Space' : how === 'straight' ? 'Straighten' : 'Circle', 'edges',
  how === 'space' ? 'vertices spaced evenly along the loop.' : how === 'straight' ? 'loop straightened on the surface.' : 'loop made round.',
  how === 'circle' ? 'Circle needs a closed loop of edges.' : how === 'straight' ? 'Straighten needs an open chain of edges.' : 'Select a chain of edges.', (g, s) => shapeLoop(g, s, how));
export const gridFillSel = () => reshape('Grid Fill', "an n-gon (face mode) or a hole's border (edge mode)", 'filled with a quad grid.',
  'It needs an even number of corners, 6 or more: a polygon in face mode, or a closed loop of open edges in edge mode.', gridFill);
export const limitedDissolveSel = () => regroup('Limited Dissolve', (soup, cur, c, _t, src) => limitedDissolve(soup, cur, [...c.faces].map((f) => src[f]), get().docOpts.angle),
  (k) => `The selection (${k}) has no flat neighbours to merge (they meet at more than ${get().docOpts.angle}°).`);
/** Mesh Check / pole buttons: select what the check found on the active part. */
export function selectFound(kind: 'nonManifold' | 'nonManifoldVert' | 'open' | 'flipped' | 'insideOut' | 'zero' | 'duplicate' | 'low' | 'high') {
  const { activePart: i, parts, result } = get(), p = parts[i], out = result?.parts[i];
  if (!p || !out) return;
  const g = { soup: p.soup, ...(p.poly && p.sides ? { poly: p.poly, sides: p.sides } : ownPolygons(p.soup.length / 9)) };
  if (kind === 'low' || kind === 'high') selectSoup(i, { verts: poles(g)[kind] });
  else {
    const m = meshCheck(g);
    if (kind === 'nonManifoldVert') selectSoup(i, { verts: m.nonManifoldVert });
    else if (kind === 'insideOut') selectSoup(i, { faces: m.insideOut.flat() });
    else if (kind === 'nonManifold' || kind === 'open') selectSoup(i, { edges: m[kind] });
    else selectSoup(i, { faces: m[kind] });
  }
  viewOp('3d', 'selected');
}
export const setShowPoles = (showPoles: boolean) => set({ showPoles });
export const setSlideBorders = (slideBorders: boolean) => set({ slideBorders });
export const setMoveOnSurface = (moveOnSurface: boolean) => { set({ moveOnSurface }); const m = get().docMove; if (m) updateDocMove(lastMouse[0], lastMouse[1], true); };

// ---- Poly Doc's G: move vertices by hand, on the surface, with Health updating live ----
const lastMouse: [number, number] = [0, 0];
let moveFrame = 0;
/** G: start dragging the selection's vertices (faces: their corners, edges: their ends). */
export function startDocMove(x?: number, y?: number) {
  const at = soupSel();
  if (!at) return set({ fixNote: 'Move: select something first.' });
  const verts = [...new Set([...at.sel.verts, ...at.sel.edges.flat()])];
  if (!verts.length) return set({ fixNote: 'Move: select vertices, edges or faces first.' });
  const t = topoOfSoup(at.g.soup), pivot = [0, 1, 2].map((k) => verts.reduce((s, v) => s + t.pos[v * 3 + k], 0) / verts.length) as [number, number, number];
  keepParts();
  const s = get(), mode = s.selectMode, reselect = mode === 'face' || mode === 'island' ? { faces: at.sel.faces } : at.sel.edges.length ? { edges: at.sel.edges } : { verts };
  // from the strip (no mouse position): the drag counts from where the mouse first moves, so nothing jumps
  if (x !== undefined && y !== undefined) { lastMouse[0] = x; lastMouse[1] = y; }
  set({ docTool: 'move', docMove: { part: at.part, verts, base: at.g, normals: s.parts[at.part].normals, marked: s.parts[at.part].marked, mouse: x !== undefined && y !== undefined ? [x, y] : null, pivot, axis: null, snap: surfaceOf(at.g.soup), reselect, moved: false },
    fixNote: `Move: ${verts.length} vertices follow the mouse${s.moveOnSurface ? ' on the surface' : ''}. X / Y / Z lock an axis; click or Enter keeps it, Esc or right-click cancels.` });
}
/** The drag: the vertices at the mouse (per animation frame), from where they began. */
export function updateDocMove(x: number, y: number, now = false) {
  lastMouse[0] = x; lastMouse[1] = y;
  const m0 = get().docMove;
  if (!m0) return;
  if (!m0.mouse) return set({ docMove: { ...m0, mouse: [x, y] } });
  if (moveFrame && !now) return;
  const apply = () => {
    moveFrame = 0;
    const m = get().docMove;
    if (!m || !m.mouse || !view3d.worldDelta) return;
    let d = view3d.worldDelta(lastMouse[0] - m.mouse[0], lastMouse[1] - m.mouse[1], m.pivot);
    if (m.axis !== null) d = d.map((v, k) => (k === m.axis ? v : 0)) as [number, number, number];
    const geo = moveOnSurface(m.base, m.verts, d, get().moveOnSurface && m.axis === null, m.snap);
    set({ parts: get().parts.map((p, i) => (i === m.part ? { ...p, soup: geo.soup, normals: m.normals && carryNormals(m.base.soup, m.normals, geo.soup) } : p)), docMove: { ...m, moved: true } });
    meshOnly(m.part);
  };
  if (now) apply(); else moveFrame = requestAnimationFrame(apply);
}
/** X / Y / Z while moving: lock to that world axis (again: free). */
export function docMoveAxis(axis: 0 | 1 | 2) {
  const m = get().docMove;
  if (!m) return;
  set({ docMove: { ...m, axis: m.axis === axis ? null : axis } });
  updateDocMove(lastMouse[0], lastMouse[1], true);
}
/** Click / Enter: keep the move (one undo step), and select what was selected again. */
export function confirmDocMove() {
  const m = get().docMove;
  if (!m) return;
  cancelAnimationFrame(moveFrame); moveFrame = 0;
  set({ docMove: null, fixNote: m.moved ? `Move: ${m.verts.length} vertices moved.` : null });
  if (!m.moved) { set((s) => ({ partsPast: s.partsPast.slice(0, -1) })); return; }
  selectSoup(m.part, m.reselect);
}
/** Esc / right-click: put everything back as it was before G. */
export function cancelDocMove() {
  const m = get().docMove;
  if (!m) return;
  cancelAnimationFrame(moveFrame); moveFrame = 0;
  const past = get().partsPast, snap = past[past.length - 1];
  set((s) => ({ ...(snap ? restorePart(s, snap) : {}), partsPast: past.slice(0, -1), docMove: null, fixNote: 'Move cancelled.' }));
  selectSoup(m.part, m.reselect);
}
/** Health: select the active part's red faces (score 0.6 and up) and show them. */
export function selectRed() {
  const { activePart: i, parts, result } = get(), p = parts[i], out = result?.parts[i];
  if (!p || !out) return;
  const score = health(out, { soup: p.soup, ...(p.poly && p.sides ? { poly: p.poly, sides: p.sides } : ownPolygons(p.soup.length / 9)) });
  set({ selectMode: 'face', docView: 'health' });
  selectFaces(i, [...score.keys()].filter((t) => score[t] >= 0.6), 'set');
  viewOp('3d', 'selected');
}
export const setDocOpt = (key: keyof State['docOpts'], value: number) => set((s) => ({ docOpts: { ...s.docOpts, [key]: value } }));
/** Smooth is how the model will look: it turns Cavity on (World + Screen), which can still be switched off there. */
export const setDocView = (docView: DocView) => set((s) => ({ docView, ...(docView === 'smooth' && { scene: { ...s.scene, cavity: true, cavityType: 'both' as const } }) }));
export const setDocColor = (docColor: 'single' | 'random') => set((s) => ({ docColor, docView: s.docView === 'health' ? 'wire' : s.docView }));

/** The one Display model: the options bar, the View menu and Z all offer the same choices in every workspace.
 *  Poly Doc shows how solid the mesh is, UV Magician how the UVs are laid out, Van Gogh how the material is lit. */
export interface DisplayChoice { id: string; label: string; title: string }
export const DISPLAY: Record<Workspace, DisplayChoice[]> = {
  doc: [
    { id: 'wire', label: 'Wire', title: 'Each polygon flat, with the wireframe: for working on the topology' },
    { id: 'smooth', label: 'Smooth', title: 'Smooth shaded, no wireframe: how the model will look' },
    { id: 'health', label: 'Health', title: 'Every face green (solid) through yellow to red (fix)' },
  ],
  uv: [
    { id: 'checker', label: 'Checker', title: 'The checker texture: texel density and distortion' },
    { id: 'stretch', label: 'Stretch', title: 'Stretch colored per face' },
    { id: 'islands', label: 'Islands', title: 'A color per UV island' },
  ],
  paint: [
    { id: 'studio', label: 'Studio', title: 'The lit PBR material' },
    { id: 'matcap', label: 'MatCap', title: 'A lit sphere the model takes its shading from by normal' },
    { id: 'flat', label: 'Flat', title: 'Unlit colors' },
  ],
};
export interface DisplayOption extends DisplayChoice { on: boolean; run: () => void }
/** The workspace's Display choices with their current state and what picking them does. */
export function displayChoices(s: State = get()): DisplayOption[] {
  const workspace = s.workspace;
  return DISPLAY[workspace].map((c) => ({
    ...c,
    on: workspace === 'doc' ? s.docView === c.id : workspace === 'paint' ? s.scene.lighting === c.id : s.mode === c.id,
    run: () => {
      if (workspace === 'doc') setDocView(c.id as DocView);
      else if (workspace === 'paint') updateScene({ lighting: c.id as Scene['lighting'] });
      else set({ mode: c.id as Mode });
    },
  }));
}
/** Pick a Display choice by id (the View menu's radio group). */
export const setDisplay = (id: string) => displayChoices().find((c) => c.id === id)?.run();
/** Alt+J: the selected lone triangles paired into quads. */
/** The fixes the right-click menu suggests for a rule (Health's): each the usual cure for what that rule flags. */
export const triangulateSel = () => regroup('Triangulate', (_soup, cur, c, _t, src) => triangulate(cur, [...c.faces].map((f) => src[f])),
  (k) => `The selection is ${k}: there's nothing to split.`);
/** Each selected polygon's outline edges in the soup, longest or shortest first. */
function outlineEdges(g: Geo, faces: number[]) {
  const t = topoOfSoup(g.soup), m = members(g.poly), out: { p: number; edges: [number, number, number][] }[] = [];
  for (const p of new Set(faces.map((f) => g.poly[f]))) {
    const l = loopOf(t, m.get(p) ?? []);
    if (!l) continue;
    out.push({ p, edges: l.map((v, i) => { const w = l[(i + 1) % l.length]; return [v, w, Math.hypot(t.pos[v * 3] - t.pos[w * 3], t.pos[v * 3 + 1] - t.pos[w * 3 + 1], t.pos[v * 3 + 2] - t.pos[w * 3 + 2])] as [number, number, number]; }) });
  }
  return { t, out };
}
/** A sliver merged into the polygon across its longest edge. */
export const mergeIntoNeighbourSel = () => regroup('Merge into Neighbour', (soup, cur, c, _t, src) => {
  const { t, out } = outlineEdges({ soup, ...cur }, [...c.faces].map((f) => src[f])), pairs: [number, number][] = [];
  for (const { p, edges } of out) {
    const [a, b] = [...edges].sort((x, y) => y[2] - x[2])[0], e = edgeBetween(t, a, b);
    const mine = t.edgeTris[e].find((f) => cur.poly[f] === p), other = t.edgeTris[e].find((f) => cur.poly[f] !== p);
    if (mine !== undefined && other !== undefined) pairs.push([mine, other]);
  }
  return pairs.length ? dissolve(soup, cur, pairs) : null;
}, (k) => `The selection (${k}) has no neighbour across its longest edge, or merging would tangle the outline.`);
/** A needle's shortest edge collapsed to a point: the triangle goes, its neighbours close up. */
export const collapseShortestSel = () => reshape('Collapse Shortest Edge', 'faces', 'shortest edge collapsed.', 'The selected faces have no simple outline.',
  (g, s) => { const edges = outlineEdges(g, s.faces).out.map(({ edges: es }) => { const [a, b] = [...es].sort((x, y) => x[2] - y[2])[0]; return [a, b] as [number, number]; }); return edges.length ? mergeVerts(g, { ...s, edges }, true) : null; });
/** Relax the selected polygons together with the ring of polygons round them (a lone quad has no inside vertex to move). */
export const relaxAroundSel = () => reshape('Relax Around', 'faces', 'spacing evened out round the selection.', 'Every vertex there sits on a crease or an open edge.',
  (g, s) => {
    const t = topoOfSoup(g.soup), picked = new Set(s.faces.map((f) => g.poly[f])), grown = new Set(picked);
    g.poly.forEach((p, f) => { if (picked.has(p)) for (let k = 0; k < 3; k++) for (const h of trisOf(t, t.vid[f * 3 + k])) grown.add(g.poly[h]); });
    const faces: number[] = [];
    g.poly.forEach((p, f) => { if (grown.has(p)) faces.push(f); });
    return relax(g, { ...s, faces }, get().docOpts.relax, get().slideBorders);
  }, true);
/** Health: select the polygons a rule flags on the active part. */
export function selectRule(rule: RuleId) {
  const { activePart: i, parts } = get(), p = parts[i];
  if (!p) return;
  const g = { soup: p.soup, ...(p.poly && p.sides ? { poly: p.poly, sides: p.sides } : ownPolygons(p.soup.length / 9)) }, r = ruleCounts(g).get(rule);
  if (!r) return;
  const polys = new Set([...r.look, ...r.fix]), faces: number[] = [];
  g.poly.forEach((q, f) => { if (polys.has(q)) faces.push(f); });
  selectSoup(i, { faces });
  viewOp('3d', 'selected');
}
export const trisToQuadsSel = () => regroup('Tris to Quads', (soup, cur, c, _t, src) => trisToQuads(soup, cur, [...c.faces].map((f) => src[f])),
  (k) => `The selection is ${k}: only two triangles side by side, nearly flat, can become a quad.`);
/** Select whole islands by id (the island tools' Select buttons). `add` toggles them. */
export function select(ids: number[], add = false) {
  const { result, activePart } = get();
  if (!result) return;
  const isl = islandsOf(result), valid = ids.filter((id) => isl[id]);
  const part = add || !valid.length ? activePart : isl[valid[0]].part;
  const faces = valid.filter((id) => isl[id].part === part).flatMap((id) => isl[id].corners.filter((c) => c % 3 === 0).map((c) => c / 3));
  if (!faces.length && !add) return set({ csel: null });
  selectFaces(part, faces, add ? 'toggle' : 'set', false); // whole islands, exactly
}

/** 1 2 3 4: vertex, edge, face or island mode. The selection carries over, as Blender converts it. Poly Doc has no
 *  islands, so 4 does nothing there (the control is disabled, not hidden, so the row never moves). */
export function setSelectMode(m: SelectMode) {
  const s = get(), cur = liveSel(s);
  if (m === 'island' && s.workspace === 'doc') return;
  if (!cur || m === s.selectMode) return set({ selectMode: m });
  const out = s.result!.parts[cur.part];
  let own: Iterable<number> = cur[kindOf(m)];
  if (m === 'island') own = wholeIslands(out.island, cur.faces.size ? cur.faces : facesAround(topoOf(cur.of), cur.verts));
  // to faces: a polygon counts once every one of its triangles does (all its corners selected), as Blender converts
  else if (kindOf(m) === 'faces') own = completePolygons(out, s.parts[cur.part]?.poly, new Set(own));
  const next = flushed(cur.part, cur.of, kindOf(m), own);
  set({ selectMode: m, csel: next[kindOf(m)].size ? next : null });
}
const count = (t: Topo, kind: Kind) => (kind === 'verts' ? t.nv : kind === 'edges' ? t.ends.length / 2 : t.vid.length / 3);
/** A: everything on the active part. */
export function selectAll() {
  const { result, activePart, selectMode } = get(), out = result?.parts[activePart];
  if (!out) return;
  selectElems(activePart, Array.from({ length: count(topoOf(out.positions), kindOf(selectMode)) }, (_, i) => i));
}
/** Alt+A. */
export const clearSelection = () => set({ csel: null });
/** Ctrl+I. */
export function invertSelection() {
  const { result, activePart, selectMode } = get(), cur = liveSel(), part = cur?.part ?? activePart, out = result?.parts[part];
  if (!out) return;
  const kind = kindOf(selectMode), on = cur?.[kind] ?? new Set<number>();
  selectElems(part, Array.from({ length: count(topoOf(out.positions), kind) }, (_, i) => i).filter((i) => !on.has(i)));
}
/** Ctrl+L: grow the selection to the whole islands it touches (Blender's select linked, delimited by seams). */
export function selectLinked() {
  const cur = liveSel(), out = cur && get().result!.parts[cur.part];
  if (!cur || !out) return;
  selectFaces(cur.part, linked(out, cur.faces.size ? cur.faces : facesAround(topoOf(cur.of), cur.verts)), 'add', get().workspace === 'doc');
}
/** Where the pointer is, for the keys that act on what's under it (L, menus, framing). The views write it. */
export const pointer = { view: '3d' as '3d' | 'uv', part: -1, tri: -1, u: 0, v: 0, x: 0, y: 0 };
/** L: the island under the pointer added (Shift+L: taken away). */
export function selectLinkedUnder(sub = false) {
  const { result, uvs } = get();
  if (!result) return;
  const hit = pointer.view === '3d' ? (pointer.part >= 0 ? { part: pointer.part, tri: pointer.tri } : null) : pickTri(result, uvs, uvTiles().at, pointer.u, pointer.v);
  if (!hit || hit.tri < 0) return;
  selectFaces(hit.part, linked(result.parts[hit.part], [hit.tri]), sub ? 'sub' : 'add', get().workspace === 'doc');
}
/** Alt+click: the edge loop through an edge (the engine walks the straightest way on at each vertex). */
export const selectLoop = (part: number, edge: number, add: boolean) => task('Selecting loop…', async () => {
  const p = get().parts[part], out = get().result?.parts[part];
  if (!p || !out) return;
  const edges = await loopEdges(p.soup, out.positions, [edge]);
  if (get().result?.parts[part]?.positions !== out.positions) return;
  const sel = flushed(part, out.positions, 'edges', edges), kind = kindOf(get().selectMode);
  if (sel[kind].size) selectElems(part, sel[kind], add ? 'add' : 'set');
});
/** Select › Edge Loops: the loop through every selected edge. */
export const selectEdgeLoop = () => task('Selecting loops…', async () => {
  const cur = liveSel(), p = cur && get().parts[cur.part];
  if (!cur || !p || !cur.edges.size) return;
  const edges = await loopEdges(p.soup, cur.of, [...cur.edges]);
  if (liveSel() !== cur) return;
  selectElems(cur.part, flushed(cur.part, cur.of, 'edges', edges)[kindOf(get().selectMode)], 'add');
});
async function loopEdges(soup: Float32Array, of: number[], seeds: number[]) {
  const t = topoOf(of), xyz = (v: number) => Array.from(t.pos.slice(v * 3, v * 3 + 3)), out = new Set(seeds);
  for (const e of seeds) {
    const loop = await api.edgeLoop(soup, [...xyz(t.ends[e * 2]), ...xyz(t.ends[e * 2 + 1])]);
    for (let o = 0; o + 5 < loop.length; o += 6) {
      const a = vertexAt(t, loop[o], loop[o + 1], loop[o + 2]), b = vertexAt(t, loop[o + 3], loop[o + 4], loop[o + 5]);
      const k = a >= 0 && b >= 0 ? edgeBetween(t, a, b) : -1;
      if (k >= 0) out.add(k);
    }
  }
  return out;
}

/** Ask a view to frame everything or the selection (Home, numpad .), or (3D) look along an axis or orbit a step. */
export type ViewOp = 'all' | 'selected' | 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom' | 'orbit-left' | 'orbit-right' | 'orbit-up' | 'orbit-down';
export const viewOp = (view: '3d' | 'uv', op: ViewOp) => set((s) => ({ viewReq: { view, op, n: s.viewReq.n + 1 } }));
/** A small menu at the pointer (Ctrl+E). A pie keeps its whole ring inside the window, so pressing Z at an edge still
 *  shows every item; `releaseZ` measures from the stored (clamped) centre. */
export const openMenu = (title: string, items: MenuItem[], pie = false) => {
  const x = pie ? Math.max(176, Math.min(innerWidth - 176, pointer.x)) : pointer.x;
  const y = pie ? Math.max(120, Math.min(innerHeight - 120, pointer.y)) : pointer.y;
  set({ menu: { x, y, title, items, pie } });
};
export const closeMenu = () => set({ menu: null });
export const armBox = () => set({ boxArmed: true });
/** What the menus offer, for the selection there is. */
function sewItems(): MenuItem[] {
  const none = !liveSel();
  return [
    { label: 'Cut', kbd: 'C', run: cutSelection, off: none },
    { label: 'Stitch', kbd: 'V', run: stitchSelection, off: none },
    { label: 'Unwrap', kbd: 'U', run: () => void unwrapSelected(), off: none },
    { label: 'Pin', kbd: 'P', run: () => pinSelected(true), off: none },
    { label: 'Unpin', kbd: 'Alt+P', run: () => pinSelected(false), off: none },
    { label: 'Select linked', kbd: 'Ctrl+L', run: selectLinked, off: none },
    { label: 'Select loops', kbd: 'Alt+click', run: () => void selectEdgeLoop(), off: none },
    { label: 'Pack', kbd: 'Ctrl+P', run: () => void repack() },
  ];
}
/** Right click: the list. */
export const contextMenu = () => openMenu('Selection', sewItems());
/** Q: the same as a pie round the pointer. */
export const pieMenu = () => openMenu('Selection', sewItems(), true);
/** Z, in every workspace: the same Display choices the options bar and View menu offer, as a pie at the pointer. */
export const viewPie = () => openMenu('Display', displayChoices().map((c) => ({ label: c.label, run: c.run, title: c.title, on: c.on })), true);
/** Ctrl+E: the edge menu. */
export const edgeMenu = () => openMenu('Edge', sewItems().slice(0, 2).concat(sewItems()[6]));

// The islands the selection touches: what the island tools (align, stack, relax…) and the island count work on.
useApp.subscribe((s, prev) => {
  if (s.csel === prev.csel && s.result === prev.result && s.selectMode === prev.selectMode) return;
  const c = liveSel(s), out = c && s.result!.parts[c.part], ids = new Set<number>();
  if (c && out) {
    if (s.selectMode === 'face' || s.selectMode === 'island') for (const f of c.faces) ids.add(out.island[f]);
    else { const t = topoOf(c.of); for (let k = 0; k < t.vid.length; k++) if (c.verts.has(t.vid[k])) ids.add(out.island[(k / 3) | 0]); }
  }
  const selected = [...ids].filter((id) => id >= 0).sort((a, b) => a - b);
  if (selected.length !== s.selected.length || selected.some((x, i) => x !== s.selected[i])) set({ selected });
});

// ---- UV edits: one undo step each; drags snapshot once, then move in place ----
const snapshot = (): Snap => ({ uvs: get().uvs.map((a) => a.slice()), result: get().result });
export function beginEdit() { set((s) => ({ past: [...s.past.slice(-49), snapshot()], future: [] })); }
const touched = () => set((s) => ({ uvRev: s.uvRev + 1, edited: true }));

/** The UV corners the selection moves: the selected faces' own corners (face and island modes), else every corner
 *  of a selected vertex (Blender's synced selection: a vertex's UVs move together). */
function eachSelected(fn: (a: Float32Array, c: number) => void) {
  const s = get(), c = liveSel(s), a = c && s.uvs[c.part];
  if (!c || !a) return;
  if (s.selectMode === 'face' || s.selectMode === 'island') { for (const f of c.faces) for (let k = 0; k < 3; k++) fn(a, f * 3 + k); return; }
  const t = topoOf(c.of);
  for (let k = 0; k < t.vid.length; k++) if (c.verts.has(t.vid[k])) fn(a, k);
}
function selectionCenter(): [number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  eachSelected((a, c) => { x0 = Math.min(x0, a[c * 2]); x1 = Math.max(x1, a[c * 2]); y0 = Math.min(y0, a[c * 2 + 1]); y1 = Math.max(y1, a[c * 2 + 1]); });
  return x0 === Infinity ? null : [(x0 + x1) / 2, (y0 + y1) / 2];
}

// ---- G R S: Blender's modal transforms of the selected UVs, and pins ----
export type XformKind = 'move' | 'rotate' | 'scale';
/** A transform in progress: the corners it moves and where they started, the pivot (the selection's box centre),
 *  where the mouse started and is now (the part's UV units), an axis lock, typed digits, Ctrl snapping, and the
 *  readout the UV view shows. */
export interface Xform {
  kind: XformKind; part: number; corners: number[]; orig: Float32Array; pivot: [number, number];
  start: [number, number]; mouse: [number, number]; axis: 'x' | 'y' | null; typed: string; snap: boolean; info: string;
  /** The part's UVs when it started (cancel puts all of them back: a live unwrap moves more than the selection). */
  whole: Float32Array;
  /** Moving pins with Live Unwrap on: just the pins move, their islands follow. */
  live: boolean;
}
/** Ctrl snaps: a 1/32 UV step, 5°, a 0.1 scale step. */
const SNAP = { move: 1 / 32, rotate: 5, scale: 0.1 };

/** The pointer in the part's own UV units (the view shows parts side by side as tiles). */
function partUV(part: number, u: number, v: number): [number, number] {
  const at = uvTiles().at[part] ?? [0, 0];
  return [u - at[0], v - at[1]];
}
/** G, R or S with the pointer over the UV view: the selection follows the mouse until a click or Enter (Esc or a
 *  right click puts it back). Pressing another of G R S mid-way switches to it. */
export function startXform(kind: XformKind) {
  const s = get(), x = s.xform;
  if (x) return update({ ...x, kind, typed: '', start: x.mouse });
  const c = liveSel(s), pivot = selectionCenter();
  if (s.loading || pointer.view !== 'uv' || !c || !pivot) return;
  let corners: number[] = [];
  eachSelected((_, k) => corners.push(k));
  // with Live Unwrap, the selected pins move and the rest of their islands follows (Blender's pin drag)
  const pins = pinsOf(s, c.part), pinned = pins ? corners.filter((k) => pins.has(k)) : [];
  const live = s.liveUnwrap && pinned.length > 0;
  if (live) corners = pinned;
  const a = s.uvs[c.part], start = partUV(c.part, pointer.u, pointer.v);
  beginEdit();
  update({ kind, part: c.part, corners, orig: Float32Array.from(corners.flatMap((k) => [a[k * 2], a[k * 2 + 1]])), pivot, start, mouse: start, axis: null,
    typed: '', snap: false, info: '', whole: a.slice(), live });
}
/** Apply a transform state, and with Live Unwrap ask for its islands around the moved pins. */
function update(x: Xform) {
  const y = applyXform(x);
  set({ xform: y });
  if (y.live) liveSolve(y);
}

// Live Unwrap: one engine request at a time (LSCM around the pins), each with the pins where they are by then; a
// cancel makes any answer still on its way stale.
let liveNext: Xform | null = null, liveBusy = false, liveGen = 0;
function liveSolve(x: Xform) {
  liveNext = x;
  if (!liveBusy) void liveRun();
}
async function liveRun() {
  liveBusy = true;
  while (liveNext) {
    const x = liveNext, gen = liveGen;
    liveNext = null;
    const s = get(), out = s.result?.parts[x.part], part = s.parts[x.part], pins = pinsOf(s, x.part), a = s.uvs[x.part];
    if (!out || !part || !pins || !a) continue;
    // just the dragged islands' triangles go: the engine's work follows the island, not the part
    const ids = new Set(x.corners.map((c) => out.island[(c / 3) | 0])), faces = out.island.flatMap((id, f) => (ids.has(id) ? [f] : []));
    const sub = {
      positions: faces.flatMap((f) => out.positions.slice(f * 9, f * 9 + 9)), uvs: faces.flatMap((f) => Array.from(a.subarray(f * 6, f * 6 + 6))),
      stretch: faces.map((f) => out.stretch[f]), island: faces.map((f) => out.island[f]),
      pins: faces.flatMap((f, i) => [0, 1, 2].flatMap((k) => (pins.has(f * 3 + k) ? [i * 3 + k] : []))),
    };
    try {
      const r = await api.reseam({ ...sub, seams: part.seams, changed: [], faces: faces.map((_, i) => i), live: true }, s.params);
      const now = get(), b = now.uvs[x.part];
      if (gen !== liveGen || now.result !== s.result || !b) continue;
      faces.forEach((f, i) => { for (let k = 0; k < 3; k++) { const c = f * 3 + k; if (!pins.has(c)) { b[c * 2] = r.uvs[(i * 3 + k) * 2]; b[c * 2 + 1] = r.uvs[(i * 3 + k) * 2 + 1]; } } });
      set((st) => ({ uvRev: st.uvRev + 1 }));
    } catch { /* the drag goes on: a failed live solve just isn't shown */ }
  }
  liveBusy = false;
}
export const setLiveUnwrap = (liveUnwrap: boolean) => set({ liveUnwrap });
export const setAfterAlign = (afterAlign: boolean) => { set({ afterAlign }); keep('afterAlign', +afterAlign); };
export const setAfterPack = (afterPack: boolean) => { set({ afterPack }); keep('afterPack', +afterPack); };
/** The corners where the transform puts them now; returns it with its readout. */
function applyXform(x: Xform): Xform {
  const a = get().uvs[x.part], [pu, pv] = x.pivot, [su, sv] = x.start, [mu, mv] = x.mouse;
  const typed = x.typed !== '' && x.typed !== '-' && Number.isFinite(+x.typed) ? +x.typed : null;
  const axis = x.axis ? ` along ${x.axis.toUpperCase()}` : '';
  let map: (u: number, v: number) => [number, number], info: string;
  if (x.kind === 'move') {
    let du = mu - su, dv = mv - sv;
    if (typed !== null) [du, dv] = x.axis === 'y' ? [0, typed] : [typed, 0];
    else {
      if (x.snap) { du = Math.round(du / SNAP.move) * SNAP.move; dv = Math.round(dv / SNAP.move) * SNAP.move; }
      if (x.axis === 'x') dv = 0;
      if (x.axis === 'y') du = 0;
    }
    map = (u, v) => [u + du, v + dv];
    info = `Move  D: ${du.toFixed(4)}  ${dv.toFixed(4)}${axis}`;
  } else if (x.kind === 'rotate') {
    let deg = typed ?? ((Math.atan2(mv - pv, mu - pu) - Math.atan2(sv - pv, su - pu)) * 180) / Math.PI;
    if (typed === null) { deg = ((deg + 540) % 360) - 180; if (x.snap) deg = Math.round(deg / SNAP.rotate) * SNAP.rotate; }
    const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    map = (u, v) => [pu + c * (u - pu) - sn * (v - pv), pv + sn * (u - pu) + c * (v - pv)];
    info = `Rotate  ${deg.toFixed(2)}°`;
  } else {
    const d0 = Math.hypot(su - pu, sv - pv);
    let f = typed ?? (d0 > 1e-9 ? Math.hypot(mu - pu, mv - pv) / d0 : 1);
    if (typed === null && x.snap) f = Math.round(f / SNAP.scale) * SNAP.scale;
    const [fu, fv] = x.axis === 'x' ? [f, 1] : x.axis === 'y' ? [1, f] : [f, f];
    map = (u, v) => [pu + fu * (u - pu), pv + fv * (v - pv)];
    info = `Scale  ${fu.toFixed(3)}  ${fv.toFixed(3)}${axis}`;
  }
  x.corners.forEach((k, i) => { const [u, v] = map(x.orig[i * 2], x.orig[i * 2 + 1]); a[k * 2] = u; a[k * 2 + 1] = v; });
  touched();
  return { ...x, info: `${info}${x.typed ? `  [${x.typed}]` : ''}${x.snap ? '  snap' : ''}${x.live ? '  · live unwrap' : ''}` };
}
/** The mouse (the UV view's coordinates) or Ctrl moved mid-transform. */
export function xformMouse(u: number, v: number, snap: boolean) {
  const x = get().xform;
  if (x) update({ ...x, mouse: partUV(x.part, u, v), snap });
}
export function xformSnap(snap: boolean) {
  const x = get().xform;
  if (x && x.snap !== snap) update({ ...x, snap });
}
/** X / Y lock an axis (again: unlock); digits, '.', '-' and Backspace type an exact value. */
export function xformKey(key: string) {
  const x = get().xform;
  if (!x) return;
  let { axis, typed } = x;
  if (key === 'x' || key === 'y') axis = axis === key ? null : key;
  else if (key === 'backspace') typed = typed.slice(0, -1);
  else if (key === '-') typed = typed.startsWith('-') ? typed.slice(1) : `-${typed}`;
  else if (/^[0-9.]$/.test(key)) typed += key;
  else return;
  update({ ...x, axis, typed });
}
/** Click or Enter: keep it (one undo step, taken when it started). */
export const confirmXform = () => set({ xform: null });
/** Esc or right click: everything back where it was, and no undo step. */
export function cancelXform() {
  const x = get().xform;
  if (!x) return;
  liveGen++;
  liveNext = null;
  get().uvs[x.part]?.set(x.whole);
  set((s) => ({ xform: null, past: s.past.slice(0, -1), uvRev: s.uvRev + 1 }));
}

/** U: the selected faces unwrapped again (their islands made by the seams alone, as Blender's U), pins held, laid
 *  back where they were; one undo step. */
export const unwrapSelected = () => task('Unwrapping selection…', async () => {
  const s = get(), c = liveSel(s), part = c && s.parts[c.part], out = c && s.result?.parts[c.part], uvs = c && s.uvs[c.part];
  if (!c || !part || !out || !uvs || !c.faces.size || s.loading || s.xform) return;
  keepParts();
  const me = ++latest, t0 = performance.now();
  const r = await api.reseam({ positions: out.positions, uvs: Array.from(uvs), stretch: out.stretch, island: out.island, seams: part.seams, changed: [],
    pins: [...(pinsOf(s, c.part) ?? [])], faces: [...c.faces], manual: part.manual }, s.params);
  if (me !== latest || get().result !== s.result) return;
  land(c.part, { ...out, ...r }, new Float32Array(r.uvs), part.seams, performance.now() - t0, true);
  await tidy(c.part, uvs);
});

/** The pinned corners of a part, if they still belong to its current output. */
export function pinsOf(s: State, part: number): Set<number> | null {
  const p = s.pins[part];
  return p && s.result?.parts[part]?.positions === p.of ? p.corners : null;
}
/** P pins the selected UVs, Alt+P unpins them: a seam edit then lays their island out again around them. */
export function pinSelected(on: boolean) {
  const s = get(), c = liveSel(s);
  if (!c) return;
  const corners = new Set(pinsOf(s, c.part) ?? []);
  eachSelected((_, k) => { if (on) corners.add(k); else corners.delete(k); });
  set({ pins: { ...s.pins, [c.part]: { of: c.of, corners } } });
}
/** Move the selection by (du, dv) in place, mid-drag (call beginEdit first). */
export function nudge(du: number, dv: number) {
  eachSelected((a, c) => { a[c * 2] += du; a[c * 2 + 1] += dv; });
  touched();
}
/** Linear map [[a, b], [c, d]] about the selection's centre: rotate, flip, scale. */
function transform(m: [number, number, number, number]) {
  const ctr = selectionCenter();
  if (!ctr) return;
  beginEdit();
  eachSelected((a, c) => {
    const x = a[c * 2] - ctr[0], y = a[c * 2 + 1] - ctr[1];
    a[c * 2] = ctr[0] + m[0] * x + m[1] * y;
    a[c * 2 + 1] = ctr[1] + m[2] * x + m[3] * y;
  });
  touched();
}
export const rotateSel = (deg: number) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); transform([c, -s, s, c]); };
export const flipSel = (horizontal = true) => transform(horizontal ? [-1, 0, 0, 1] : [1, 0, 0, -1]);
export const scaleSel = (f: number) => transform([f, 0, 0, f]);

export const repack = () => task('Packing…', async () => {
  if (get().loading || !get().result) return;
  const apply = await packed(get().activePart);
  beginEdit();
  apply();
  touched();
});

/** The part's islands packed (everything into one square with One atlas, else the part's own); returns the write. */
async function packed(part: number) {
  const { result, uvs } = get(), isl = islandsOf(result!), { one_atlas } = get().params;
  const g = isl.flatMap((x, id) => (one_atlas || x.part === part ? [id] : []));
  const out = g.length ? await api.pack(g.map((id) => isl[id].corners.flatMap((c) => [uvs[isl[id].part][c * 2], uvs[isl[id].part][c * 2 + 1]]))) : [];
  return () => g.forEach((id, k) => isl[id].corners.forEach((c, j) => { uvs[isl[id].part][c * 2] = out[k][j * 2]; uvs[isl[id].part][c * 2 + 1] = out[k][j * 2 + 1]; }));
}

// ---- Island-level UV tools: each operation applies to the selection as one undo step ----
type Box = { u0: number; v0: number; u1: number; v1: number };
/** The selected islands, each with its part's UV array and its corners. */
function selIslands() {
  const { result, uvs, selected, activePart } = get();
  if (!result) return [];
  const isl = islandsOf(result);
  return selected.flatMap((id) => isl[id]?.part === activePart ? [{ id, a: uvs[activePart], part: activePart, corners: isl[id].corners }] : []);
}
function boxOf(a: Float32Array, cs: number[]): Box {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const c of cs) { u0 = Math.min(u0, a[c * 2]); u1 = Math.max(u1, a[c * 2]); v0 = Math.min(v0, a[c * 2 + 1]); v1 = Math.max(v1, a[c * 2 + 1]); }
  return { u0, v0, u1, v1 };
}
const moveBy = (a: Float32Array, cs: number[], du: number, dv: number) => { for (const c of cs) { a[c * 2] += du; a[c * 2 + 1] += dv; } };
/** Turn and scale corners about (cu, cv): angle in radians, factor k. */
function spin(a: Float32Array, cs: number[], th: number, k = 1) {
  const b = boxOf(a, cs), cu = (b.u0 + b.u1) / 2, cv = (b.v0 + b.v1) / 2, c = Math.cos(th) * k, s = Math.sin(th) * k;
  for (const i of cs) {
    const x = a[i * 2] - cu, y = a[i * 2 + 1] - cv;
    a[i * 2] = cu + c * x - s * y;
    a[i * 2 + 1] = cv + s * x + c * y;
  }
}
/** One undo step over the selected islands. */
function editIslands(fn: (sel: ReturnType<typeof selIslands>) => void) {
  const sel = selIslands();
  if (!sel.length) return;
  beginEdit();
  fn(sel);
  touched();
}

export type Edge = 'left' | 'right' | 'top' | 'bottom' | 'center' | 'middle' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
/** Line islands up on one edge (or centre line) of their joint box; a lone island goes to the square's. */
export const alignSel = (edge: Edge) => editIslands((sel) => {
  const boxes = sel.map((s) => boxOf(s.a, s.corners));
  const all = sel.length > 1 ? boxes.reduce((p, b) => ({ u0: Math.min(p.u0, b.u0), v0: Math.min(p.v0, b.v0), u1: Math.max(p.u1, b.u1), v1: Math.max(p.v1, b.v1) }))
    : { u0: 0, v0: 0, u1: 1, v1: 1 };
  sel.forEach((s, i) => {
    const b = boxes[i];
    const left = edge === 'left' || edge.endsWith('left'), right = edge === 'right' || edge.endsWith('right');
    const top = edge === 'top' || edge.startsWith('top-'), bottom = edge === 'bottom' || edge.startsWith('bottom-');
    const du = left ? all.u0 - b.u0 : right ? all.u1 - b.u1 : edge === 'center' ? (all.u0 + all.u1 - b.u0 - b.u1) / 2 : 0;
    const dv = bottom ? all.v0 - b.v0 : top ? all.v1 - b.v1 : edge === 'middle' || edge === 'center' ? (all.v0 + all.v1 - b.v0 - b.v1) / 2 : 0;
    moveBy(s.a, s.corners, du, dv);
  });
});

/** Equal gaps between islands along u or v, the outermost two staying put; if they don't fit side by side in
 *  that span, equal steps between their centres instead. */
export const distributeSel = (axis: 'u' | 'v') => editIslands((sel) => {
  if (sel.length < 3) return;
  const lo = axis === 'u' ? 'u0' : 'v0', hi = axis === 'u' ? 'u1' : 'v1', mid = (b: Box) => (b[lo] + b[hi]) / 2;
  const items = sel.map((s) => ({ s, b: boxOf(s.a, s.corners) })).sort((x, y) => mid(x.b) - mid(y.b));
  const first = items[0].b, last = items[items.length - 1].b, n = items.length - 1;
  const gap = (last[hi] - first[lo] - items.reduce((k, x) => k + x.b[hi] - x.b[lo], 0)) / n;
  let at = first[hi] + gap;
  items.slice(1, -1).forEach(({ s, b }, i) => {
    const d = gap >= 0 ? at - b[lo] : mid(first) + ((mid(last) - mid(first)) * (i + 1)) / n - mid(b);
    moveBy(s.a, s.corners, axis === 'u' ? d : 0, axis === 'v' ? d : 0);
    at += b[hi] - b[lo] + gap;
  });
});

/** Border edges of an island (corner pairs on one triangle only, matched by their UVs). */
function borderEdges(a: Float32Array, cs: number[]): [number, number][] {
  const key = (c: number) => `${a[c * 2]},${a[c * 2 + 1]}`, seen = new Map<string, [number, number] | null>();
  for (let k = 0; k < cs.length; k += 3) {
    for (let j = 0; j < 3; j++) {
      const p = cs[k + j], q = cs[k + (j + 1) % 3], kp = key(p), kq = key(q), e = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      seen.set(e, seen.has(e) ? null : [p, q]);
    }
  }
  return [...seen.values()].filter((x): x is [number, number] => x !== null);
}

/** Rectangle parameterization for one disk-like triangle chart, solved on its own corner graph. */
function rectangleLayout(s: ReturnType<typeof selIslands>[number], even: boolean): number[] | null {
  const key = (c: number) => `${s.a[c * 2]},${s.a[c * 2 + 1]}`;
  const edges = borderEdges(s.a, s.corners), adjacent = new Map<string, Set<string>>(), uv = new Map<string, [number, number]>();
  for (const [p, q] of edges) {
    const a = key(p), b = key(q);
    uv.set(a, [s.a[p * 2], s.a[p * 2 + 1]]); uv.set(b, [s.a[q * 2], s.a[q * 2 + 1]]);
    if (!adjacent.has(a)) adjacent.set(a, new Set()); if (!adjacent.has(b)) adjacent.set(b, new Set());
    adjacent.get(a)!.add(b); adjacent.get(b)!.add(a);
  }
  if (adjacent.size < 4 || [...adjacent.values()].some((n) => n.size !== 2)) return null;
  const start = adjacent.keys().next().value as string, loop = [start];
  let prev = '', current = start;
  for (let i = 0; i < adjacent.size; i++) {
    const next = [...adjacent.get(current)!].find((k) => k !== prev);
    if (!next || next === start) break;
    loop.push(next); prev = current; current = next;
  }
  if (loop.length !== adjacent.size || [...adjacent.get(loop[loop.length - 1])!].every((k) => k !== start)) return null;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity, area = 0;
  for (let i = 0; i < loop.length; i++) {
    const [u, v] = uv.get(loop[i])!, [x, y] = uv.get(loop[(i + 1) % loop.length])!;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); area += u * y - x * v;
  }
  if (u1 - u0 < 1e-12 || v1 - v0 < 1e-12) return null;
  // The four anchors are the existing boundary vertices nearest the original box corners.
  const corners: [number, number][] = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], chosen = new Set<number>();
  const anchors = corners.map((p, target) => {
    let best = -1, distance = Infinity;
    loop.forEach((k, i) => { if (chosen.has(i)) return; const q = uv.get(k)!, d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (d < distance) { best = i; distance = d; } });
    chosen.add(best); return { at: best, target };
  }).sort((a, b) => a.at - b.at);
  const positive = area > 0;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i].target, b = anchors[(i + 1) % anchors.length].target;
    if (((b - a + 4) % 4 === 1) !== positive) return null;
  }
  const boundary = new Map<string, [number, number]>();
  for (let a = 0; a < anchors.length; a++) {
    const from = anchors[a], to = anchors[(a + 1) % anchors.length], count = (to.at - from.at + loop.length) % loop.length || loop.length;
    let total = 0;
    for (let j = 0; j < count; j++) total += even ? 1 : Math.hypot(uv.get(loop[(from.at + j) % loop.length])![0] - uv.get(loop[(from.at + j + 1) % loop.length])![0], uv.get(loop[(from.at + j) % loop.length])![1] - uv.get(loop[(from.at + j + 1) % loop.length])![1]);
    let run = 0;
    const p = corners[from.target], q = corners[to.target];
    for (let j = 0; j <= count; j++) {
      const k = loop[(from.at + j) % loop.length], t = total ? run / total : j / count;
      boundary.set(k, [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      if (j < count) run += even ? 1 : Math.hypot(uv.get(k)![0] - uv.get(loop[(from.at + j + 1) % loop.length])![0], uv.get(k)![1] - uv.get(loop[(from.at + j + 1) % loop.length])![1]);
    }
  }
  const ids = new Map<string, number>(), points: [number, number][] = [], links: Set<number>[] = [];
  const id = (c: number) => { const k = key(c); let i = ids.get(k); if (i === undefined) { i = points.length; ids.set(k, i); points.push([s.a[c * 2], s.a[c * 2 + 1]]); links.push(new Set()); } return i; };
  for (let i = 0; i < s.corners.length; i += 3) {
    const tri = [id(s.corners[i]), id(s.corners[i + 1]), id(s.corners[i + 2])];
    for (let j = 0; j < 3; j++) { links[tri[j]].add(tri[(j + 1) % 3]); links[tri[(j + 1) % 3]].add(tri[j]); }
  }
  const fixed = new Set<number>();
  for (const [k, p] of boundary) { const i = ids.get(k); if (i === undefined) return null; points[i] = p; fixed.add(i); }
  let curU = Float64Array.from(points, (p) => p[0]), curV = Float64Array.from(points, (p) => p[1]);
  let nextU = new Float64Array(curU.length), nextV = new Float64Array(curV.length);
  for (let iteration = 0; iteration < 600; iteration++) {
    nextU.set(curU); nextV.set(curV); let delta = 0;
    for (let i = 0; i < curU.length; i++) if (!fixed.has(i) && links[i].size) {
      let u = 0, v = 0; for (const j of links[i]) { u += curU[j] / links[i].size; v += curV[j] / links[i].size; }
      delta = Math.max(delta, Math.abs(u - curU[i]), Math.abs(v - curV[i])); nextU[i] = u; nextV[i] = v;
    }
    [curU, nextU] = [nextU, curU]; [curV, nextV] = [nextV, curV]; if (delta < 1e-8) break;
  }
  const out: number[] = [];
  for (const c of s.corners) { const i = ids.get(key(c))!; out.push(curU[i], curV[i]); }
  return out;
}

/** Rectify a selected single-boundary chart; Gridify additionally spaces each boundary edge evenly. */
export function rectifySel(gridify = false) {
  const sel = selIslands(), layouts = sel.map((s) => rectangleLayout(s, gridify));
  if (!layouts.some(Boolean)) return;
  beginEdit();
  sel.forEach((s, i) => { const layout = layouts[i]; if (layout) s.corners.forEach((c, j) => { s.a[c * 2] = layout[j * 2]; s.a[c * 2 + 1] = layout[j * 2 + 1]; }); });
  touched();
}
/** Straighten (Align Axis): turn each island so its outline's main straight-edge direction runs along u or v. */
export const straightenSel = () => editIslands((sel) => { for (const s of sel) straighten(s.a, s.corners); });
function straighten(a: Float32Array, corners: number[]) {
  const bins = new Float64Array(180); // half-degree bins over 0..90°
  for (const [p, q] of borderEdges(a, corners)) {
    const du = a[q * 2] - a[p * 2], dv = a[q * 2 + 1] - a[p * 2 + 1];
    const deg = ((Math.atan2(dv, du) * 180) / Math.PI % 90 + 90) % 90;
    bins[Math.min(179, Math.floor(deg * 2))] += Math.hypot(du, dv);
  }
  let best = 0;
  for (let i = 1; i < 180; i++) if (bins[i] > bins[best]) best = i;
  const deg = (best + 0.5) / 2;
  spin(a, corners, (-(deg > 45 ? deg - 90 : deg) * Math.PI) / 180);
}

/** Orient each island's longest UV axis horizontally using its covariance. */
export const orientSel = () => editIslands((sel) => {
  for (const s of sel) {
    let xx = 0, yy = 0, xy = 0, cu = 0, cv = 0;
    for (const c of s.corners) { cu += s.a[c * 2] / s.corners.length; cv += s.a[c * 2 + 1] / s.corners.length; }
    for (const c of s.corners) { const x = s.a[c * 2] - cu, y = s.a[c * 2 + 1] - cv; xx += x * x; yy += y * y; xy += x * y; }
    if (xx + yy > 1e-18) spin(s.a, s.corners, -Math.atan2(2 * xy, xx - yy) / 2);
  }
});

/** World 3D direction per island as seen in UV: area-weighted gradient of one world axis over the island. */
function worldGradient(positions: number[], a: Float32Array, cs: number[], axis: number): [number, number] {
  let gu = 0, gv = 0;
  for (let k = 0; k < cs.length; k += 3) {
    const [p0, p1, p2] = [cs[k], cs[k + 1], cs[k + 2]];
    const u1 = a[p1 * 2] - a[p0 * 2], v1 = a[p1 * 2 + 1] - a[p0 * 2 + 1], u2 = a[p2 * 2] - a[p0 * 2], v2 = a[p2 * 2 + 1] - a[p0 * 2 + 1];
    const det = u1 * v2 - u2 * v1;
    if (Math.abs(det) < 1e-14) continue;
    const y1 = positions[p1 * 3 + axis] - positions[p0 * 3 + axis], y2 = positions[p2 * 3 + axis] - positions[p0 * 3 + axis];
    // the plane y = gu·u + gv·v through the triangle, weighted by its UV area
    gu += ((y1 * v2 - y2 * v1) / det) * Math.abs(det);
    gv += ((u1 * y2 - u2 * y1) / det) * Math.abs(det);
  }
  return [gu, gv];
}
/** Orient World: turn each island so the model's up (or, for a face lying flat, its front) points up in UV. */
export const orientWorldSel = () => editIslands((sel) => {
  const r = get().result!;
  for (const s of sel) {
    const pos = r.parts[s.part].positions;
    let g = worldGradient(pos, s.a, s.corners, 1);
    const z = worldGradient(pos, s.a, s.corners, 2);
    if (Math.hypot(...g) < 0.3 * Math.hypot(...z)) g = z;
    if (Math.hypot(...g) === 0) continue;
    spin(s.a, s.corners, Math.PI / 2 - Math.atan2(g[1], g[0]));
  }
});

/** Island area in 3D and in UV. */
function areas(positions: number[], a: Float32Array, cs: number[]) {
  let a3 = 0, a2 = 0;
  for (let k = 0; k < cs.length; k += 3) {
    const [p, q, w] = [cs[k], cs[k + 1], cs[k + 2]], P = (i: number, j: number) => positions[i * 3 + j];
    const e1 = [0, 1, 2].map((j) => P(q, j) - P(p, j)), e2 = [0, 1, 2].map((j) => P(w, j) - P(p, j));
    a3 += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
    a2 += Math.abs((a[q * 2] - a[p * 2]) * (a[w * 2 + 1] - a[p * 2 + 1]) - (a[w * 2] - a[p * 2]) * (a[q * 2 + 1] - a[p * 2 + 1])) / 2;
  }
  return { a3, a2 };
}
/** Average Island Scales: one texel density for all selected islands (the one they have together). */
export const averageScalesSel = () => editIslands((sel) => {
  const r = get().result!, ar = sel.map((s) => areas(r.parts[s.part].positions, s.a, s.corners));
  const target = Math.sqrt(ar.reduce((n, x) => n + x.a2, 0) / ar.reduce((n, x) => n + x.a3, 0));
  sel.forEach((s, i) => { if (ar[i].a2 > 0) spin(s.a, s.corners, 0, target / Math.sqrt(ar[i].a2 / ar[i].a3)); });
});

/** Normalize: scale and move the selection, keeping its proportions, to fill the 0..1 square. */
export const normalizeSel = () => editIslands((sel) => {
  const b = sel.map((s) => boxOf(s.a, s.corners)).reduce((p, x) => ({ u0: Math.min(p.u0, x.u0), v0: Math.min(p.v0, x.v0), u1: Math.max(p.u1, x.u1), v1: Math.max(p.v1, x.v1) }));
  const k = 1 / Math.max(b.u1 - b.u0, b.v1 - b.v0, 1e-12);
  for (const s of sel) for (const c of s.corners) { s.a[c * 2] = (s.a[c * 2] - b.u0) * k; s.a[c * 2 + 1] = (s.a[c * 2 + 1] - b.v0) * k; }
});

// ---- Relax, Stitch (engine solvers) and Stack ----
type Sel = ReturnType<typeof selIslands>[number];
const islandIn = (r: Output, s: Sel): IslandIn => ({
  positions: s.corners.flatMap((c) => r.parts[s.part].positions.slice(c * 3, c * 3 + 3)),
  uvs: s.corners.flatMap((c) => [s.a[c * 2], s.a[c * 2 + 1]]),
});
/** Engine work on the selection; its answer lands as one undo step unless the UVs changed meanwhile. */
async function solveSel(label: string, run: (r: Output, sel: Sel[]) => Promise<() => void>) {
  const r = get().result, uvs = get().uvs, sel = selIslands();
  if (!r || !sel.length) return;
  await task(label, async () => {
    const apply = await run(r, sel);
    if (get().result !== r || get().uvs !== uvs) return;
    beginEdit();
    apply();
    touched();
  });
}
const put = (s: Sel, uv: number[]) => s.corners.forEach((c, j) => { s.a[c * 2] = uv[j * 2]; s.a[c * 2 + 1] = uv[j * 2 + 1]; });

/** Relax: each selected island re-flattened (ARAP) from its current layout, staying where it is. */
export const relaxSel = () => solveSel('Relaxing…', async (r, sel) => {
  const out = await api.relax(sel.map((s) => islandIn(r, s)));
  return () => sel.forEach((s, i) => put(s, out[i]));
});

/** An island's shape for fitting: its centre, main axis (radians) and up to 256 of its points about the centre. */
function shapeOf(a: Float32Array, cs: number[]) {
  let cu = 0, cv = 0, xx = 0, yy = 0, xy = 0;
  for (const c of cs) { cu += a[c * 2] / cs.length; cv += a[c * 2 + 1] / cs.length; }
  const pts: [number, number][] = [], step = Math.max(1, Math.floor(cs.length / 256));
  cs.forEach((c, i) => {
    const x = a[c * 2] - cu, y = a[c * 2 + 1] - cv;
    xx += x * x; yy += y * y; xy += x * y;
    if (i % step === 0) pts.push([x, y]);
  });
  return { cu, cv, th: Math.atan2(2 * xy, xx - yy) / 2, pts };
}
/** Stack: islands like the first selected one (the other selected, or with one selected every one like it on its
 *  part) laid on top of it: main axes lined up, then whichever quarter turn, mirrored or not, fits its shape best. */
export function stackSel() {
  const { result, uvs, selected } = get();
  if (!result || !selected.length) return;
  const isl = islandsOf(result), facts = islandFacts(), base = selected[0];
  const ids = (selected.length > 1 ? selected.slice(1) : facts.map((_, j) => j)).filter((j) => j !== base && alike(facts[base], facts[j]));
  if (!ids.length) return;
  const at = (id: number) => uvs[isl[id].part], t = shapeOf(at(base), isl[base].corners);
  beginEdit();
  for (const id of ids) {
    const a = at(id), cs = isl[id].corners, s = shapeOf(a, cs);
    let best: number[] = [], bd = Infinity;
    for (let q = 0; q < 4; q++) for (const m of [1, -1]) {
      // R(t.th + q·90°) · diag(1, m) · R(−s.th)
      const p = t.th + (q * Math.PI) / 2, c1 = Math.cos(p), s1 = Math.sin(p), c2 = Math.cos(s.th), s2 = Math.sin(s.th);
      const M = [c1 * c2 + s1 * m * s2, c1 * s2 - s1 * m * c2, s1 * c2 - c1 * m * s2, s1 * s2 + c1 * m * c2];
      let d = 0;
      for (const [x, y] of s.pts) {
        const u = M[0] * x + M[1] * y, v = M[2] * x + M[3] * y;
        let n = Infinity;
        for (const [tx, ty] of t.pts) n = Math.min(n, (u - tx) ** 2 + (v - ty) ** 2);
        d += n;
      }
      if (d < bd) { bd = d; best = M; }
    }
    for (const c of cs) {
      const x = a[c * 2] - s.cu, y = a[c * 2 + 1] - s.cv;
      a[c * 2] = t.cu + best[0] * x + best[1] * y;
      a[c * 2 + 1] = t.cv + best[2] * x + best[3] * y;
    }
  }
  touched();
}

/** Shuffle island positions while keeping every island's shape intact. */
export const shuffleSel = () => editIslands((sel) => {
  if (sel.length < 2) return;
  const centers = sel.map((s) => { const b = boxOf(s.a, s.corners); return [(b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2] as const; });
  const order = centers.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  sel.forEach((s, i) => moveBy(s.a, s.corners, centers[order[i]][0] - centers[i][0], centers[order[i]][1] - centers[i][1]));
});

/** Set selected islands to a common width while preserving each island's aspect ratio. */
export const stretchSel = () => editIslands((sel) => {
  const boxes = sel.map((s) => boxOf(s.a, s.corners));
  const width = boxes.reduce((n, b) => n + b.u1 - b.u0, 0) / boxes.length;
  sel.forEach((s, i) => {
    const b = boxes[i], w = b.u1 - b.u0;
    if (w <= 1e-12) return;
    const mid = (b.u0 + b.u1) / 2, scale = width / w;
    for (const c of s.corners) s.a[c * 2] = mid + (s.a[c * 2] - mid) * scale;
  });
});

/** Circularize each selected island's outline loop, keeping its interior vertices in place. */
export const circleBoundarySel = () => editIslands((sel) => {
  for (const s of sel) {
    const edges = borderEdges(s.a, s.corners), adjacent = new Map<string, Set<string>>(), coords = new Map<string, [number, number]>();
    const key = (c: number) => `${s.a[c * 2]},${s.a[c * 2 + 1]}`;
    for (const [p, q] of edges) {
      const a = key(p), b = key(q);
      coords.set(a, [s.a[p * 2], s.a[p * 2 + 1]]); coords.set(b, [s.a[q * 2], s.a[q * 2 + 1]]);
      (adjacent.get(a) ?? adjacent.set(a, new Set()).get(a)!).add(b);
      (adjacent.get(b) ?? adjacent.set(b, new Set()).get(b)!).add(a);
    }
    const unseen = new Set(adjacent.keys()), moved = new Map<string, [number, number]>();
    while (unseen.size) {
      const start = unseen.values().next().value as string, stack = [start], loop: string[] = [];
      unseen.delete(start);
      while (stack.length) { const k = stack.pop()!; loop.push(k); for (const n of adjacent.get(k) ?? []) if (unseen.delete(n)) stack.push(n); }
      if (loop.length < 3) continue;
      const c = loop.reduce((p, k) => [p[0] + coords.get(k)![0] / loop.length, p[1] + coords.get(k)![1] / loop.length], [0, 0]);
      const radius = loop.reduce((n, k) => n + Math.hypot(coords.get(k)![0] - c[0], coords.get(k)![1] - c[1]) / loop.length, 0);
      for (const k of loop) { const [u, v] = coords.get(k)!, angle = Math.atan2(v - c[1], u - c[0]); moved.set(k, [c[0] + radius * Math.cos(angle), c[1] + radius * Math.sin(angle)]); }
    }
    for (const c of s.corners) { const uv = moved.get(key(c)); if (uv) { s.a[c * 2] = uv[0]; s.a[c * 2 + 1] = uv[1]; } }
  }
});

/** Copy an island's normalized UV shape for later pasting onto matching corner topology. */
export function copyShapeSel() {
  const s = selIslands()[0];
  if (!s) return;
  const b = boxOf(s.a, s.corners), w = Math.max(b.u1 - b.u0, 1e-12), h = Math.max(b.v1 - b.v0, 1e-12);
  set({ shapeClipboard: s.corners.flatMap((c) => [(s.a[c * 2] - b.u0) / w, (s.a[c * 2 + 1] - b.v0) / h]) });
}
/** Paste the copied shape onto selected islands without changing their current bounds. */
export const pasteShapeSel = () => {
  const clip = get().shapeClipboard, selected = selIslands();
  if (!clip || !selected.length || selected.some((s) => s.corners.length * 2 !== clip.length)) return;
  editIslands((sel) => sel.forEach((s) => {
    const b = boxOf(s.a, s.corners), w = b.u1 - b.u0, h = b.v1 - b.v0;
    s.corners.forEach((c, i) => { s.a[c * 2] = b.u0 + clip[i * 2] * w; s.a[c * 2 + 1] = b.v0 + clip[i * 2 + 1] * h; });
  }));
};

/** Expand or shrink selected island outlines by a UV distance using averaged boundary normals. */
export const offsetBoundarySel = (distance = 0.005) => editIslands((sel) => {
  for (const s of sel) {
    const key = (c: number) => `${s.a[c * 2]},${s.a[c * 2 + 1]}`;
    let cu = 0, cv = 0;
    for (const c of s.corners) { cu += s.a[c * 2] / s.corners.length; cv += s.a[c * 2 + 1] / s.corners.length; }
    const normals = new Map<string, [number, number]>();
    for (const [p, q] of borderEdges(s.a, s.corners)) {
      const du = s.a[q * 2] - s.a[p * 2], dv = s.a[q * 2 + 1] - s.a[p * 2 + 1], len = Math.hypot(du, dv);
      if (len < 1e-12) continue;
      let nu = dv / len, nv = -du / len;
      const mu = (s.a[p * 2] + s.a[q * 2]) / 2, mv = (s.a[p * 2 + 1] + s.a[q * 2 + 1]) / 2;
      if (nu * (mu - cu) + nv * (mv - cv) < 0) { nu = -nu; nv = -nv; }
      for (const c of [p, q]) { const k = key(c), n = normals.get(k) ?? [0, 0]; n[0] += nu; n[1] += nv; normals.set(k, n); }
    }
    const moved = new Map<string, [number, number]>();
    for (const [k, [nu, nv]] of normals) { const len = Math.hypot(nu, nv); if (len > 1e-12) moved.set(k, [distance * nu / len, distance * nv / len]); }
    for (const c of s.corners) { const d = moved.get(key(c)); if (d) { s.a[c * 2] += d[0]; s.a[c * 2 + 1] += d[1]; } }
  }
});

/** Bring UV copies of shared 3D vertices together across selected islands. */
export const alignSeamsSel = () => editIslands((sel) => {
  const groups = new Map<string, { a: Float32Array; corners: number[]; islands: Set<number> }>();
  for (const s of sel) {
    const pos = get().result!.parts[s.part].positions;
    for (const c of s.corners) {
      const k = `${s.part}|${pos[c * 3].toFixed(6)},${pos[c * 3 + 1].toFixed(6)},${pos[c * 3 + 2].toFixed(6)}`;
      const g = groups.get(k) ?? { a: s.a, corners: [], islands: new Set<number>() };
      g.corners.push(c); g.islands.add(s.id); groups.set(k, g);
    }
  }
  for (const g of groups.values()) if (g.islands.size > 1) {
    const uv = g.corners.reduce((p, c) => [p[0] + g.a[c * 2] / g.corners.length, p[1] + g.a[c * 2 + 1] / g.corners.length], [0, 0]);
    for (const c of g.corners) { g.a[c * 2] = uv[0]; g.a[c * 2 + 1] = uv[1]; }
  }
});

/** Weld selected UV corners within a small threshold, matching Mio3's merge-by-distance action. */
export const mergeSel = (threshold = 0.0001) => editIslands((sel) => {
  for (const s of sel) {
    const byCell = new Map<string, number[]>(), parent = new Map<number, number>();
    const root = (x: number): number => { const p = parent.get(x); if (p === undefined) { parent.set(x, x); return x; } if (p === x) return x; const r = root(p); parent.set(x, r); return r; };
    const join = (a: number, b: number) => { const x = root(a), y = root(b); if (x !== y) parent.set(y, x); };
    for (const c of s.corners) {
      const u = s.a[c * 2], v = s.a[c * 2 + 1], x = Math.floor(u / threshold), y = Math.floor(v / threshold);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const other of byCell.get(`${x + dx},${y + dy}`) ?? []) {
        if (Math.hypot(u - s.a[other * 2], v - s.a[other * 2 + 1]) <= threshold) join(c, other);
      }
      const k = `${x},${y}`; byCell.set(k, [...(byCell.get(k) ?? []), c]);
    }
    const sums = new Map<number, [number, number, number]>();
    for (const c of s.corners) { const r = root(c), n = sums.get(r) ?? [0, 0, 0]; n[0] += s.a[c * 2]; n[1] += s.a[c * 2 + 1]; n[2]++; sums.set(r, n); }
    for (const c of s.corners) { const [u, v, n] = sums.get(root(c))!; s.a[c * 2] = u / n; s.a[c * 2 + 1] = v / n; }
  }
});

/** Order selected islands by their 3D X position in one compact row. */
export const sortSel = () => editIslands((sel) => {
  if (sel.length < 2) return;
  const r = get().result!, boxes = sel.map((s) => boxOf(s.a, s.corners));
  const items = sel.map((s, i) => {
    const p = r.parts[s.part].positions, c = [0, 0, 0];
    for (const k of s.corners) for (let j = 0; j < 3; j++) c[j] += p[k * 3 + j] / s.corners.length;
    return { s, b: boxes[i], x: c[0] };
  }).sort((a, b) => a.x - b.x || a.s.id - b.s.id);
  const gap = Math.max(...boxes.map((b) => b.u1 - b.u0)) * 0.08;
  const centerV = boxes.reduce((n, b) => n + (b.v0 + b.v1) / 2, 0) / boxes.length;
  let u = Math.min(...boxes.map((b) => b.u0));
  for (const { s, b } of items) {
    moveBy(s.a, s.corners, u - b.u0, centerV - (b.v0 + b.v1) / 2);
    u += b.u1 - b.u0 + gap;
  }
});

/** Symmetrize a selected side onto its matching side across a 3D axis, mirroring one UV axis. */
export const symmetrizeSel = (worldAxis: 0 | 1 | 2, uvAxis: 0 | 1, snap = false) => editIslands((sel) => {
  const r = get().result;
  if (!r || !sel.length) return;
  const all = islandsOf(r), selectedSide = new Map<number, number>();
  for (const s of sel) {
    const p = r.parts[s.part].positions;
    let lo = Infinity, hi = -Infinity;
    for (let i = worldAxis; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    const mid = (lo + hi) / 2, mean = s.corners.reduce((n, c) => n + (p[c * 3 + worldAxis] - mid) / s.corners.length, 0);
    selectedSide.set(s.id, mean);
  }
  const dominant = [...selectedSide.values()].reduce((n, x) => n + x, 0) >= 0 ? 1 : -1;
  const sourceIds = new Set(sel.filter((s) => selectedSide.get(s.id)! * dominant > 1e-7).map((s) => s.id));
  for (const source of sel) {
    if (!sourceIds.has(source.id)) continue;
    const part = r.parts[source.part], pos = part.positions;
    let lo = Infinity, hi = -Infinity, extent = 1;
    for (let i = worldAxis; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
    const mid = (lo + hi) / 2;
    for (let j = 0; j < 3; j++) { let a = Infinity, b = -Infinity; for (let i = j; i < pos.length; i += 3) { a = Math.min(a, pos[i]); b = Math.max(b, pos[i]); } extent = Math.max(extent, b - a); }
    const eps = extent * 1e-5, key = (x: number, y: number, z: number) => `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    const pointCorners = new Map<string, number[]>();
    for (let c = 0; c < pos.length / 3; c++) { const k = key(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]); const list = pointCorners.get(k) ?? []; list.push(c); pointCorners.set(k, list); }
    const side = selectedSide.get(source.id)! >= 0 ? 1 : -1, candidates = new Map<number, number>();
    for (const c of source.corners) {
      const xyz = [pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]];
      if ((xyz[worldAxis] - mid) * side <= 1e-7) continue;
      xyz[worldAxis] = 2 * mid - xyz[worldAxis];
      for (const d of pointCorners.get(key(xyz[0], xyz[1], xyz[2])) ?? []) { const id = part.island[Math.floor(d / 3)]; if (!sourceIds.has(id)) candidates.set(id, (candidates.get(id) ?? 0) + 1); }
    }
    const targetId = [...candidates].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    if (targetId === undefined) continue;
    const target = all[targetId], targetUV = get().uvs[target.part], sources = new Map<string, [number, number]>(), center = 0.5;
    for (const c of source.corners) {
      const xyz = [pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]];
      if ((xyz[worldAxis] - mid) * side <= 1e-7) continue;
      xyz[worldAxis] = 2 * mid - xyz[worldAxis];
      const u = source.a[c * 2], v = source.a[c * 2 + 1];
      sources.set(key(xyz[0], xyz[1], xyz[2]), uvAxis === 0 ? [2 * center - u, v] : [u, 2 * center - v]);
    }
    for (const c of target.corners) {
      const k = c * 3, uv = sources.get(key(pos[k], pos[k + 1], pos[k + 2]));
      if (!uv) continue;
      const d = Math.hypot(targetUV[c * 2] - uv[0], targetUV[c * 2 + 1] - uv[1]);
      if (!snap || d < 0.02) { targetUV[c * 2] = uv[0]; targetUV[c * 2 + 1] = uv[1]; }
    }
  }
});

/** Select islands with effectively no UV area. */
export function selectZeroArea() {
  const { result: r, activePart } = get();
  if (!r) return;
  const isl = islandsOf(r), uvs = get().uvs;
  select(isl.flatMap((s, id) => s.part === activePart && areas(r.parts[s.part].positions, uvs[s.part], s.corners).a2 < 1e-12 ? [id] : []));
}

// ---- selecting islands by where they are and what they are ----
/** Each island's 3D centre (in its part's frame: x relative to the part's middle), triangle count and area. */
function islandFacts() {
  const r = get().result;
  if (!r) return [];
  const mid = r.parts.map((p) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < p.positions.length; i += 3) { lo = Math.min(lo, p.positions[i]); hi = Math.max(hi, p.positions[i]); } return (lo + hi) / 2; });
  return islandsOf(r).map(({ part, corners }) => {
    const p = r.parts[part].positions, c = [0, 0, 0];
    for (const k of corners) for (let j = 0; j < 3; j++) c[j] += p[k * 3 + j] / corners.length;
    c[0] -= mid[part];
    return { part, c, tris: corners.length / 3, area: areas(p, get().uvs[part], corners).a3 };
  });
}
/** Islands of the shown parts on one side of each part's middle (−X or +X). */
export function selectSide(sign: -1 | 1) {
  const { parts, activePart } = get();
  select(islandFacts().flatMap((f, id) => (f.part === activePart && parts[f.part]?.visible && f.c[0] * sign > 0 ? [id] : [])));
}
/** Add each selected island's mirror twin across its part's middle (X). */
export function selectMirror() {
  const facts = islandFacts(), { selected } = get(), out = new Set(selected);
  for (const id of selected) {
    const f = facts[id], m = [-f.c[0], f.c[1], f.c[2]];
    let best = -1, bd = Infinity;
    facts.forEach((g, j) => { if (g.part === f.part && j !== id) { const d = Math.hypot(g.c[0] - m[0], g.c[1] - m[1], g.c[2] - m[2]); if (d < bd) { bd = d; best = j; } } });
    if (best >= 0) out.add(best);
  }
  select([...out]);
}
type Fact = ReturnType<typeof islandFacts>[number];
const closeEnough = (x: number, y: number) => Math.abs(x - y) <= 0.1 * Math.max(x, y);
/** Same part, triangle count and area within 10%. */
const alike = (f: Fact, g: Fact) => f.part === g.part && closeEnough(f.tris, g.tris) && closeEnough(f.area, g.area);
/** Add islands like the selected ones. */
export function selectSimilar() {
  const facts = islandFacts(), { selected } = get();
  select(facts.flatMap((g, j) => (selected.some((id) => alike(facts[id], g)) ? [j] : [])));
}
/** Islands with triangles turned over in UV (a mirrored texture there): flagged by the engine, or wound the other
 *  way from the engine's own layout since (an island flipped by hand). The engine may wind an island's halves
 *  either way, so its layout, not a fixed winding, is the reference. */
export function selectFlipped() {
  const r = get().result, { uvs, activePart } = get();
  if (!r) return;
  const wind = (a: ArrayLike<number>, p: number, q: number, w: number) => Math.sign((a[q * 2] - a[p * 2]) * (a[w * 2 + 1] - a[p * 2 + 1]) - (a[w * 2] - a[p * 2]) * (a[q * 2 + 1] - a[p * 2 + 1]));
  select(islandsOf(r).flatMap(({ part, corners }, id) => {
    if (part !== activePart) return [];
    const [now, was, st] = [uvs[part], r.parts[part].uvs, r.parts[part].stretch];
    for (let k = 0; k < corners.length; k += 3) {
      const [p, q, w] = [corners[k], corners[k + 1], corners[k + 2]];
      if (st[p / 3] < 0 || wind(now, p, q, w) * wind(was, p, q, w) < 0) return [id];
    }
    return [];
  }));
}

export function undo() {
  const { past, partsPast } = get();
  if (!past.length) {
    // no hand edit of UVs left: take back the last seam or cut instead
    if (!partsPast.length) return;
    const target = partsPast[partsPast.length - 1];
    set((s) => ({ ...restorePart(s, target), partsPast: partsPast.slice(0, -1), partsFuture: [partSnapshot(s), ...s.partsFuture], loading: null, edited: false }));
    return;
  }
  set((s) => ({ future: [snapshot(), ...s.future], past: s.past.slice(0, -1), ...restore(s, past[past.length - 1]) }));
}
export function redo() {
  const { future, partsFuture } = get();
  if (future.length) {
    set((s) => ({ past: [...s.past, snapshot()], future: s.future.slice(1), ...restore(s, future[0]) }));
    return;
  }
  if (!partsFuture.length) return;
  const target = partsFuture[0];
  set((s) => ({ ...restorePart(s, target), partsFuture: partsFuture.slice(1), partsPast: [...s.partsPast, partSnapshot(s)], loading: null, edited: false }));
}
// island ids change with the result: the selection only carries over when it's the same one
const restore = (s: State, p: Snap) => ({ uvs: p.uvs, result: p.result, uvRev: s.uvRev + 1 });
const restorePart = (s: State, p: PartSnap) => ({ parts: p.parts, result: p.result, uvs: p.uvs.map((a) => a.slice()), csel: p.csel,
  activePart: p.activePart, uvScope: p.uvScope, past: p.past, future: p.future, uvRev: s.uvRev + 1 });

// ---- Van Gogh: painting textures ----
export const setPaint = (p: Partial<State['paint']>) => set((s) => ({ paint: { ...s.paint, ...p } }));
export const setPaintTab = (paintTab: State['paintTab']) => set({ paintTab });
export const setTexturePreset = (texturePreset: TexturePreset) => set({ texturePreset });
/** Part `i`'s texture set (Base Color and one empty layer, at the texture resolution, the first time). */
export const texSet = (i: number) => setOf(get().parts[i].soup, get().textureResolution);
const repaint = () => set((s) => ({ paintRev: s.paintRev + 1 }));
const repaintPanel = () => set((s) => ({ paintPanel: s.paintPanel + 1 }));
/** One redraw per animation frame while a stroke is under way; `paintRev` waits for the stroke end. */
let liveQueued = 0;
const repaintLive = () => {
  if (liveQueued) return;
  const run = () => { liveQueued = 0; set((s) => ({ paintLive: s.paintLive + 1 })); };
  liveQueued = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : setTimeout(run, 16);
};
/** A full 4K layer recomposite runs in yielding bands; requests merge instead of cancelling, so a pass never
 *  leaves half its box showing an older layer state (that was Ctrl+Z followed by a stroke). */
function scheduleComposite(s: TexSet) {
  void requestComposite(s, undefined, repaint);
}
/** The model's bounding box diagonal, which the brush size is a share of. */
const span = new WeakMap<Output, number>();
function modelSize(r: Output) {
  if (!span.has(r)) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of r.parts) for (let i = 0; i < p.positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p.positions[i]); hi[i % 3] = Math.max(hi[i % 3], p.positions[i]); }
    span.set(r, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1);
  }
  return span.get(r)!;
}
/** The current model's bounding diagonal (world units), for decal width readouts. */
export const modelDiagonal = () => { const r = get().result; return r ? modelSize(r) : 1; };
/** What the brush lays down: each channel it's on for, with its value (0..255). The eraser takes the paint off every
 *  channel the set has, whatever the brush's ticks say: it clears the layer, it doesn't paint a value. */
function brushOf(r: Output, pressure = 1): Brush {
  const p = get().paint, hex = (k: number) => parseInt(p.color.slice(k, k + 2), 16), values: Brush['values'] = {};
  const all = p.tool === 'erase';
  if (all || p.on.color) values.color = [hex(1), hex(3), hex(5)];
  if (all || p.on.rough) values.rough = [p.rough * 255];
  if (all || p.on.metal) values.metal = [p.metal * 255];
  const pen = Math.max(0.08, Math.min(1, pressure)), size = 0.3 + 0.7 * pen;
  return { radius: (p.size / 100) * modelSize(r) * size, flow: p.flow * (0.35 + 0.65 * pen), hardness: p.hardness, erase: all, tip: p.tip, values };
}
/** The texture sets each paint undo step changed (a selection can change several), newest last. */
const painted: TexSet[][] = [];
/** The steps Ctrl+Z took back, so Ctrl+Shift+Z can put them again; a new step starts a new history. */
const paintRedo: TexSet[][] = [];
const step = (...ts: TexSet[]) => { for (const t of ts) keepPaint(t); painted.push(ts); paintRedo.length = 0; };
export type PaintMods = { shift: boolean; alt: boolean; ctrl: boolean; pressure?: number; pen?: boolean };
const pressureOf = (m: PaintMods) => (m.pen ? Math.max(0.08, Math.min(1, m.pressure ?? 0.5)) : 1);
/** Photoshop's: Shift adds to the selection, Alt takes away, plain replaces it. */
const opOfMods = (m: PaintMods): MaskOp => (m.shift ? 'add' : m.alt ? 'sub' : 'set');
const visibleParts = () => get().parts.flatMap((p, i) => (p.visible && get().result?.parts[i] && get().uvs[i] ? [i] : []));
/** The triangles the Wand or Bucket takes from a click on triangle `tri` of part `i`: its polygon, its island, or the part. */
function trisBy(i: number, tri: number) {
  const out = get().result!.parts[i], by = get().paint.by;
  if (by === 'part') return out.island.map((_, t) => t);
  if (by === 'island') return out.island.flatMap((x, t) => (x === out.island[tri] ? [t] : []));
  const pid = polygonsOf(out.source, get().parts[i].poly);
  return pid[tri] < 0 ? [tri] : Array.from(pid).flatMap((p, t) => (p === pid[tri] ? [t] : []));
}
/** The selection, document-wide as Photoshop's: replacing it (op set) leaves nothing selected on the parts `masks`
 *  doesn't name; adding or taking away changes only those it names. One undo step. */
function selectDoc(masks: Map<number, Uint8Array>, op: MaskOp) {
  const ids = op === 'set' ? visibleParts() : [...masks.keys()], ts = ids.map(texSet);
  painted.push(ts);
  paintRedo.length = 0;
  ids.forEach((i, k) => selectMask(ts[k], masks.get(i) ?? new Uint8Array(ts[k].size * ts[k].size), op));
  repaint();
}
/** Ctrl+A: the whole visible texture selected, as Photoshop's Select All. Painting is unrestricted without a
 *  selection either, so this mostly makes the state honest (and gives Invert something to work from). */
export function selectAllPaint() {
  const masks = new Map<number, Uint8Array>();
  for (const i of visibleParts()) {
    const n = texSet(i).size;
    masks.set(i, new Uint8Array(n * n).fill(255));
  }
  if (masks.size) selectDoc(masks, 'set');
}
/** Ctrl+D: no selection. */
export function deselectPaint() {
  const ts = visibleParts().map(texSet).filter((t) => t.sel);
  if (!ts.length) return;
  painted.push(ts);
  paintRedo.length = 0;
  for (const t of ts) selectMask(t, null, 'set');
  repaint();
}
/** Ctrl+Shift+I: what was selected isn't, and the other way round (nothing happens without a selection). */
export function invertPaintSelection() {
  const ts = visibleParts().map(texSet);
  if (!ts.some((t) => t.sel)) return;
  painted.push(ts);
  paintRedo.length = 0;
  for (const t of ts) invertMask(t);
  repaint();
}
/** Marquee or Lasso on the model: the texels of each visible part whose point passes `keep` (inside the shape on screen,
 *  and seen, not hidden behind other surface). */
export function selectPaintOnModel(keep: (x: number, y: number, z: number) => boolean, mods: PaintMods) {
  const { result, uvs } = get(), masks = new Map<number, Uint8Array>();
  if (!result) return;
  for (const i of visibleParts()) {
    const out = result.parts[i], m = maskTris(texSet(i), out.positions, uvs[i], out.island.map((_, t) => t), keep);
    if (m.some((x) => x)) masks.set(i, m);
  }
  selectDoc(masks, opOfMods(mods));
}
/** Marquee or Lasso in the texture view: a polygon in part `i`'s UVs. */
export function selectPaintInUV(i: number, poly: [number, number][], mods: PaintMods) {
  if (poly.length < 3 || !get().uvs[i]) return;
  selectDoc(new Map([[i, maskPolygon(texSet(i), poly)]]), opOfMods(mods));
}
/** Ctrl+click: part `i` becomes the one the panels show, opened in the Parts tree. */
export function pickPaintPart(i: number) {
  set((s) => ({ activePart: i, paintOpen: s.paintOpen.includes(i) ? s.paintOpen : [...s.paintOpen, i] }));
}
export const togglePaintOpen = (i: number) => set((s) => ({ paintOpen: s.paintOpen.includes(i) ? s.paintOpen.filter((x) => x !== i) : [...s.paintOpen, i] }));
let last: { part: number; at: number[]; uv: boolean; fill: boolean; decal: boolean; pressure: number; gpu: boolean } | null = null;
/** A GPU stroke is replaying into the CPU; a new stroke waits for it instead of fighting the same layers. */
let committing = false, undoQueued = false, redoQueued = false;
/** A press on part `i`, triangle `tri`, at world point `at` (on the model) or null (in the texture view), UV (u, v):
 *  every tool's click, on either view. True when a drag should follow (Brush, Eraser). */
export function paintPress(i: number, tri: number, at: [number, number, number] | null, uv: [number, number], mods: PaintMods) {
  const { result, uvs, paint } = get(), out = result?.parts[i];
  if (!out || !uvs[i] || get().busy) return false;
  if (committing) return false;
  if (mods.ctrl) { pickPaintPart(i); return false; }
  const s = texSet(i);
  if (paint.tool === 'decal') {
    if (!at) return false;
    const current = s.layers[s.active]?.decal;
    // A click inside the active decal moves it; a click elsewhere adds another. The Decal tab arms the asset.
    if (current && insideDecal(current, at, modelSize(result!))) {
      step(s);
      last = { part: i, at: at.slice(), uv: false, fill: false, decal: true, pressure: 1, gpu: false };
      return true;
    }
    if (!placeDecal(i, tri, at)) return false;
    last = { part: i, at: at.slice(), uv: false, fill: false, decal: true, pressure: 1, gpu: false };
    return true;
  }
  // the Eyedropper, or Alt+click with a painting tool (Photoshop's): take the colour (and roughness, metallic) under it
  if (paint.tool === 'picker' || (mods.alt && (paint.tool === 'brush' || paint.tool === 'bucket'))) {
    const v = sample(s, uv[0], uv[1]);
    setPaint(s.channels.length > 1 ? v : { color: v.color });
    return false;
  }
  if (paint.tool === 'wand') { selectDoc(new Map([[i, maskTris(s, out.positions, uvs[i], trisBy(i, tri))]]), opOfMods(mods)); return false; }
  if (paint.tool === 'bucket') {
    step(s);
    fillTris(s, out.positions, uvs[i], trisBy(i, tri), brushOf(result!, pressureOf(mods)));
    repaint();
    return false;
  }
  if (paint.tool !== 'brush' && paint.tool !== 'erase') return false;
  step(s);
  const layer = s.layers[s.active], pen = pressureOf(mods), b = brushOf(result!, pen);
  const above = s.layers.slice(s.active + 1).some((l) => l.visible && l.opacity > 0);
  const simple = paint.tool === 'brush' && !s.sel && !above && layer && !layer.fill && !layer.decal && !layer.gen && !layer.mask && !layer.blend?.color && !!b.values.color && Object.keys(b.values).every((k) => k === 'color' || k === 'rough' || k === 'metal');
  if (simple && gpuBegin(s, i, at ? 'world' : 'uv', uv, b, layer.opacity, out.positions, uvs[i])) {
    last = { part: i, at: at ?? uv, uv: !at, fill: false, decal: false, pressure: pen, gpu: true };
    gpuDab(at, uv, b, at ? 0 : uvRadius(s, pen) / s.size);
    repaintLive();
    return true;
  }
  const masked = !!(layer?.fill || layer?.decal);
  last = { part: i, at: at ?? uv, uv: !at, fill: masked, decal: false, pressure: pen, gpu: false };
  if (masked) {
    // A fill or decal layer cannot be painted; its brush paints the mask (Substance's white/black mask).
    if (at) maskDab(s, layer!, out.positions, uvs[i], at, b, uv);
    else maskDabUV(s, layer!, uv[0], uv[1], uvRadius(s, pen), b);
    repaintLive();
    return true;
  }
  if (at) dab(s, out.positions, uvs[i], at, b, uv);
  else dabUV(s, uv[0], uv[1], uvRadius(s, pen), b);
  repaintLive();
  return true;
}
/** The brush's radius on the model (world units), for the cursor. */
export const brushRadius = () => { const r = get().result; return r ? brushOf(r).radius : 0; };
/** In the texture view the brush is a share of the texture's width. */
const uvRadius = (s: TexSet, pressure = 1) => Math.max(0.5, (get().paint.size / 100) * s.size * (0.3 + 0.7 * pressure));
/** The drag went on to world point `at` (or UV `uv` in the texture view): dabs every quarter radius along the way, so a
 *  fast stroke has no gaps. */
export function paintDrag(i: number, at: [number, number, number] | null, uv: [number, number], pressure?: number) {
  const { result, uvs } = get(), out = result?.parts[i];
  if (!out || !uvs[i] || !last || last.part !== i || last.uv === !!at) return;
  if (pressure != null) last.pressure = Math.max(0.08, Math.min(1, pressure));
  const b = brushOf(result!, last.pressure), s = texSet(i), from = last.at, to = at ?? uv;
  if (last.decal) {
    if (at) moveDecal(at);
    last.at = to;
    repaintLive();
    return;
  }
  const r = at ? b.radius : uvRadius(s, last.pressure) / s.size;
  const steps = Math.max(1, Math.ceil(Math.hypot(...to.map((x, k) => x - from[k])) / (r / 4)));
  if (last.gpu) {
    for (let k = 1; k <= steps; k++) {
      const p = to.map((x, c) => from[c] + ((x - from[c]) * k) / steps);
      gpuDab(at ? p : null, uv, b, at ? 0 : uvRadius(s, last.pressure) / s.size);
    }
    last.at = to;
    repaintLive();
    return;
  }
  const l = s.layers[s.active];
  for (let k = 1; k <= steps; k++) {
    const p = to.map((x, c) => from[c] + ((x - from[c]) * k) / steps);
    if (last.fill) {
      if (!l?.fill && !l?.decal) break;
      if (at) maskDab(s, l, out.positions, uvs[i], p, b, uv); else maskDabUV(s, l, p[0], p[1], uvRadius(s, last.pressure), b);
    } else if (at) dab(s, out.positions, uvs[i], p, b, uv); else dabUV(s, p[0], p[1], uvRadius(s, last.pressure), b);
  }
  last.at = to;
  repaintLive();
}
// ponytail: the texture view and panel catch up when the stroke ends, not per dab (a 1K redraw per mouse move)
export const paintEnd = () => {
  if (!last) return;
  if (last.decal) { last = null; repaint(); return; }
  if (last.gpu) {
    const part = last.part, s = texSet(part), points = gpuTake(), { result, uvs } = get(), pos = result?.parts[part]?.positions, uv = uvs[part];
    last = null;
    committing = true;
    repaintLive();
    void (async () => {
      try {
        if (pos && uv) for (let k = 0; k < points.length; k++) {
          const p = points[k];
          if (p.at) dab(s, pos, uv, p.at, p.b, p.uv, true);
          else dabUV(s, p.uv[0], p.uv[1], p.uvR, p.b, true);
          if ((k & 1) === 1) await new Promise((ok) => setTimeout(ok, 0));
        }
        const d = s.dirty;
        if (d) {
          setUndoRect(s, d);
          await requestComposite(s, d, repaint);
          // the same mip-padding pass the CPU stroke ends with, so the commit is not a different stroke than a CPU one
          bleedAll(s);
        }
      } finally {
        committing = false;
        gpuFinish();
        repaint();
        if (undoQueued) { undoQueued = false; undoPaint(); }
        else if (redoQueued) { redoQueued = false; redoPaint(); }
      }
    })();
    return;
  }
  const s = texSet(last.part), d = s.dirty;
  if (d) setUndoRect(s, d);
  bleedAll(s);
  repaint();
  last = null;
};
/** A Brush or Eraser stroke is under way. */
export const painting = () => !!last;
/** Ctrl+Z: take back the last paint step (a stroke, a fill, a selection, a layer edit), whichever texture set it
 *  touched. A step whose sets have no history left (a resize dropped it) is skipped rather than swallowed. */
export function undoPaint() {
  if (committing) { undoQueued = true; return; }
  // Ctrl+Z in the middle of a stroke (mouse still down) ends it first: taking its step back underneath a live drag
  // would leave the drag writing into the restored layer and stamp the next step's box with the wrong rectangle.
  if (last) paintEnd();
  // a GPU stroke commits in the background: take the step back once its replay has landed
  if (committing) { undoQueued = true; return; }
  repaintPanel();
  while (painted.length) {
    const undoStep = painted.pop()!;
    const undone = undoStep.flatMap((s) => {
      const u = undoSet(s, true);
      if (!u) return [];
      void requestComposite(s, u.rect, repaint);
      return [s];
    });
    if (!undone.length) continue;
    paintRedo.push(undone);
    return;
  }
}
/** Ctrl+Shift+Z / Ctrl+Y: put back the step the last undo took away. */
export function redoPaint() {
  if (committing) { redoQueued = true; return; }
  if (last) paintEnd();
  if (committing) { redoQueued = true; return; }
  const step = paintRedo.pop();
  if (!step) return;
  repaintPanel();
  painted.push(step);
  for (const s of step) {
    const r = redoSet(s, true);
    if (r) void requestComposite(s, r.rect, repaint);
  }
}
/** A new document (or a resolution change) makes the old steps meaningless: their sets are another model's. */
export function resetPaintHistory() {
  painted.length = 0;
  paintRedo.length = 0;
  sliderStep = null;
}
/** Alt+Backspace (Fill) or Delete (Clear): the active layer of each part with a selection, inside it; with no
 *  selection, the active part's whole layer. */
export function fillPaintSelection(erase = false) {
  const r = get().result;
  if (!r) return;
  const sel = visibleParts().map(texSet).filter((t) => t.sel);
  const ts = sel.length ? sel : get().parts[get().activePart] ? [texSet(get().activePart)] : [];
  step(...ts);
  for (const t of ts) {
    const l = t.layers[t.active];
    if (l?.fill || l?.decal) { maskSelection(t, l, erase); composite(t); }
    else fillAll(t, { ...brushOf(r), flow: 1, erase });
  }
  repaint();
}
/** Layer edits on the active part's set, each one undo step (`undoable` false: part of a step already taken). */
function layers(f: (s: TexSet) => void, undoable = true) {
  if (!get().parts[get().activePart]) return;
  const s = texSet(get().activePart);
  if (undoable) step(s); else ensureStep(s);
  f(s);
  scheduleComposite(s);
  repaintPanel();
}
/** A layer that makes the selection shiny metal (Metallic 1, Roughness 0.25) and leaves colour alone, so islands
 *  picked with Select Faces (Island) take a sheen over whatever fill is under them; the layer's opacity sets how much.
 *  No selection: the whole part. Turns the set's PBR channels on if it was Base Color only. */
export const addMetalLayer = () => layers((s) => {
  if (!s.channels.includes('metal')) s.channels = [...FILL_CHANNELS];
  s.layers.splice(s.active + 1, 0, { ...newLayer(0), name: 'Metal sheen' });
  s.active++;
  fillAll(s, { radius: 0, flow: 1, hardness: 1, erase: false, values: { rough: [0.25 * 255], metal: [255] } });
});
export const addPaintLayer = () => layers((s) => { s.layers.splice(s.active + 1, 0, newLayer(s.layers.length + 1)); s.active++; });
export const deletePaintLayer = () => layers((s) => { if (s.layers.length > 1) { s.layers.splice(s.active, 1); s.active = Math.min(s.active, s.layers.length - 1); } });
/** Ctrl+J: a copy of the active layer above it. */
export const duplicatePaintLayer = () => layers((s) => {
  const l = s.layers[s.active];
  s.layers.splice(s.active + 1, 0, {
    ...newLayer(0), name: `${l.name} copy`, opacity: l.opacity, blend: l.blend ? { ...l.blend } : undefined, px: Object.fromEntries(Object.entries(l.px).map(([c, a]) => [c, a!.slice()])),
    ...(l.fill ? { fill: { ...l.fill, channels: [...l.fill.channels], offset: [...l.fill.offset] as [number, number] } } : {}),
    ...(l.decal ? { decal: { ...l.decal, center: [...l.decal.center] as [number, number, number], normal: [...l.decal.normal] as [number, number, number], up: [...l.decal.up] as [number, number, number], channels: [...l.decal.channels] } } : {}),
    ...(l.mask ? { mask: l.mask.slice() } : {}),
  });
  s.active++;
});
/** Layer `from` dragged to stack position `to` (0 = bottom), Photoshop's drag in the Layers panel; it stays the active one. */
export const movePaintLayerTo = (from: number, to: number) => layers((s) => {
  if (from === to || to < 0 || to >= s.layers.length) return;
  const [l] = s.layers.splice(from, 1);
  s.layers.splice(to, 0, l);
  s.active = to;
});
/** Ctrl+] / Ctrl+[: the active layer up or down one. */
export const movePaintLayer = (d: 1 | -1) => { const a = texSet(get().activePart).active; movePaintLayerTo(a, a + d); };
export const editPaintLayer = (j: number, l: Partial<Pick<PaintLayer, 'name' | 'visible' | 'opacity' | 'blend'>>, undoable = true) => layers((s) => { s.layers[j] = { ...s.layers[j], ...l }; }, undoable);
/** The active layer's blend for one channel (Substance's stack is per channel). Picking one for Base Color also
 *  becomes the blend the next material comes in with: layering textures should not mean "add, then walk back to the
 *  layer panel and switch it" every time. */
export function setLayerBlend(ch: Channel, mode: BlendMode) {
  if (!get().parts[get().activePart]) return;
  const s = texSet(get().activePart), l = s.layers[s.active];
  if (!l) return;
  editPaintLayer(s.active, { blend: { ...l.blend, [ch]: mode } });
  if (ch === 'color') setPaint({ fillBlend: mode });
}
/** The shelf's "blend over paint": what the next material comes in with, and — when the layer just added is a fill,
 *  the one you are looking at — its Base Color blend now, so the fix does not need a trip to the Layers panel. */
export function setFillBlend(mode: BlendMode) {
  const i = get().activePart;
  const l = get().parts[i] ? texSet(i).layers[texSet(i).active] : null;
  if (l?.fill) setLayerBlend('color', mode); else setPaint({ fillBlend: mode });
}
/** A slider drag starts: its undo step is taken by the first change, so a click that changes nothing leaves no
 *  empty step for Ctrl+Z to chew through. */
let sliderStep: TexSet | null = null;
export const beginPaintEdit = () => { sliderStep = get().parts[get().activePart] ? texSet(get().activePart) : null; };
/** The first edit of a drag: take the step the pointerdown deferred. */
function ensureStep(s: TexSet) { if (sliderStep === s) { sliderStep = null; step(s); } }
export const pickPaintLayer = (j: number) => { texSet(get().activePart).active = j; repaint(); };
/** Part `i` gets Roughness, Metallic, Normal and Height channels (PBR, glTF's metal/rough plus a normal map),
 *  or loses them. */
export function setPbr(i: number, on: boolean) {
  set({ activePart: i });
  layers((s) => { s.channels = on ? [...FILL_CHANNELS] : ['color']; });
  if (!on && (get().paintChannel === 'rough' || get().paintChannel === 'metal' || get().paintChannel === 'normal' || get().paintChannel === 'height')) set({ paintChannel: 'material' });
}
/** Show part `i`'s channel `ch` in the UV view. */
export const pickPaintChannel = (i: number, ch: Shown) => set({ activePart: i, paintChannel: ch, uvScope: 'part' });

// ---- the material shelf ----
/** Read public/materials/index.json once. Imported folders are already in `materials`. */
export function loadMaterials() {
  if (get().materials.length || get().materialsLoading) return;
  set({ materialsLoading: true, materialsError: null });
  loadMaterialLibrary()
    .then((materials) => set({ materials, materialsLoading: false }))
    .catch((e) => set({ materialsLoading: false, materialsError: e instanceof Error ? e.message : String(e) }));
}
const materialOf = (id: string) => get().materials.find((m) => m.id === id) ?? null;
function addImported(m: MaterialAsset) { set((s) => ({ materials: [m, ...s.materials.filter((x) => x.id !== m.id)] })); }
/** A folder of PBR maps from disk (Substance's exported textures, ambientCG, anything). */
export const importMaterial = () => task('Importing a material…', async () => {
  const m = await pickMaterialFolder();
  if (!m) throw new Error('This browser has no folder picker; use the file picker instead.');
  addImported(m);
});
export const importMaterialFiles = (name: string, files: File[]) => task('Importing a material…', async () => {
  const m = await materialFromFiles(name, files);
  if (!m) throw new Error('No base color map was found in that folder.');
  addImported(m);
});

// ---- the decal shelf ----
/** Read public/decals/index.json once; imported marks already live in `decals`. */
export function loadDecals() {
  if (get().decals.length || get().decalsLoading) return;
  set({ decalsLoading: true, decalsError: null });
  loadDecalLibrary()
    .then((decals) => set((s) => ({
      decals, decalsLoading: false,
      paint: !s.paint.decalAsset && decals.length ? { ...s.paint, decalAsset: decals[0].id } : s.paint,
    })))
    .catch((e) => set({ decalsLoading: false, decalsError: e instanceof Error ? e.message : String(e) }));
}
const decalOf = (id: string) => get().decals.find((d) => d.id === id) ?? null;
/** Arm a mark for placement: its ink becomes the starting tint and the Decal tool is selected. */
export function pickDecal(id: string) {
  const a = decalOf(id);
  if (!a) return;
  set((s) => ({
    paint: { ...s.paint, tool: 'decal', decalAsset: id, decalTint: a.tint ?? '#ffffff' },
    paintTab: 'decals', error: null,
  }));
}
export const importDecal = (file: File) => task('Importing a decal…', async () => {
  const a = await decalFromFile(file);
  set((s) => ({
    decals: [a, ...s.decals.filter((x) => x.id !== a.id)],
    paint: { ...s.paint, tool: 'decal', decalAsset: a.id, decalTint: a.tint ?? '#ffffff' },
    paintTab: 'decals', error: null,
  }));
});

export const setDecalSize = (decalSize: number) => set((s) => ({ paint: { ...s.paint, decalSize: Math.max(1, Math.min(60, decalSize)) } }));
export const setDecalRotation = (decalRotation: number) => set((s) => ({ paint: { ...s.paint, decalRotation: Math.round(Math.max(-180, Math.min(180, decalRotation))) } }));

/** The face normal of output triangle `tri`. */
function faceNormal(out: { positions: ArrayLike<number> }, tri: number): [number, number, number] {
  const o = tri * 9;
  const ax = out.positions[o], ay = out.positions[o + 1], az = out.positions[o + 2];
  const e1x = out.positions[o + 3] - ax, e1y = out.positions[o + 4] - ay, e1z = out.positions[o + 5] - az;
  const e2x = out.positions[o + 6] - ax, e2y = out.positions[o + 7] - ay, e2z = out.positions[o + 8] - az;
  let x = e1y * e2z - e1z * e2y, y = e1z * e2x - e1x * e2z, z = e1x * e2y - e1y * e2x;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
/** The upright tangent for a decal: world up projected on the face, or +Z when the face is nearly horizontal. */
function decalUp(n: [number, number, number]): [number, number, number] {
  const base: [number, number, number] = Math.abs(n[1]) > 0.94 ? [0, 0, 1] : [0, 1, 0];
  const d = base[0] * n[0] + base[1] * n[1] + base[2] * n[2];
  let x = base[0] - n[0] * d, y = base[1] - n[1] * d, z = base[2] - n[2] * d;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
function insideDecal(d: Decal, at: [number, number, number], span: number) {
  const dx = at[0] - d.center[0], dy = at[1] - d.center[1], dz = at[2] - d.center[2];
  const along = dx * d.normal[0] + dy * d.normal[1] + dz * d.normal[2];
  if (Math.abs(along) > Math.max(d.width * 0.3, span * 0.012)) return false;
  const h = d.width / Math.max(d.aspect, 0.01);
  return Math.hypot(dx, dy, dz) <= Math.max(d.width, h) * 0.62;
}
/** Bake one decal layer from its current projector. */
function rebakeDecal(i: number, layer: PaintLayer) {
  const a = layer.decal && decalOf(layer.decal.asset);
  if (!a) return;
  const st = get(), out = st.result?.parts[i], uv = st.uvs[i];
  if (!out || !uv) return;
  const span = modelSize(st.result!);
  void decalPixels(a).then((px) => {
    const now = get();
    if (!now.result?.parts[i] || now.uvs[i] !== uv || !texSet(i).layers.includes(layer)) return;
    bakeDecal(texSet(i), layer, px, out.positions, uv, span);
    composite(texSet(i));
    repaint();
  }).catch((e) => set({ error: e instanceof Error ? e.message : String(e) }));
}
/** Add a decal layer at a hit on part `i`, of the armed mark (`paint.decalAsset`). */
function placeDecal(i: number, tri: number, at: [number, number, number]) {
  const st = get(), out = st.result?.parts[i], uv = st.uvs[i], a = decalOf(st.paint.decalAsset) ?? st.decals[0];
  if (!out || !uv || !a) {
    if (!st.decals.length) set({ error: 'The decal shelf is still loading; try again in a moment.' });
    return false;
  }
  const s = texSet(i), normal = faceNormal(out, tri), span = modelSize(st.result!);
  const decal: Decal = {
    asset: a.id, center: [...at] as [number, number, number], normal, up: decalUp(normal),
    width: Math.max(span * st.paint.decalSize / 100, span * 0.01), rotation: st.paint.decalRotation,
    aspect: a.width / a.height, tint: st.paint.decalTint, roughness: 0.55, metallic: 0,
    channels: ['color', 'rough', 'metal'],
  };
  step(s);
  const layer: PaintLayer = { ...newLayer(s.layers.length + 1), name: a.name, decal };
  s.layers.splice(s.active + 1, 0, layer);
  s.active++;
  set({ activePart: i, paintChannel: 'material', error: null });
  rebakeDecal(i, layer);
  repaintPanel();
  return true;
}
/** Drag an existing decal to a new point; the projector keeps its facing, so it stays upright on the same panel. */
let decalFrame = 0;
function moveDecal(at: [number, number, number]) {
  const i = get().activePart, s = texSet(i), l = s.layers[s.active];
  if (!l?.decal) return;
  l.decal = { ...l.decal, center: [...at] as [number, number, number] };
  if (decalFrame) return;
  const run = () => { decalFrame = 0; const now = get(); if (now.parts[i] && texSet(i).layers.includes(l)) rebakeDecal(i, l); };
  decalFrame = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : setTimeout(run, 16) as unknown as number;
}
/** Change the active decal's size, rotation, tint, finish or placed asset. */
export function updateDecal(patch: Partial<Decal>, undoable = true) {
  if (get().busy) return;
  const i = get().activePart, s = texSet(i), l = s.layers[s.active];
  if (!l?.decal) return;
  if (undoable) step(s); else ensureStep(s);
  const next = { ...l.decal, ...patch };
  l.decal = next;
  if (patch.asset) {
    const a = decalOf(patch.asset);
    if (a) { l.name = a.name; next.aspect = a.width / a.height; }
  }
  rebakeDecal(i, l);
  repaintPanel();
}

/** A new fill layer above the active one, with `asset` projected tri-planar over the part (the default that does not
 *  break at a packed atlas's seams). An existing selection becomes its mask. */
export function assignMaterial(id: string, all = false) {
  if (get().busy) return;
  const { activePart, parts, result } = get();
  if (!parts[activePart] || !result) return;
  const asset = materialOf(id);
  if (!asset) return;
  const targets = (all ? visibleParts() : [activePart]).filter((i) => parts[i] && result.parts[i] && get().uvs[i]);
  if (!targets.length) return;
  void task(all ? `Filling ${targets.length} parts…` : 'Loading material…', async () => {
    const maps = await materialPixels(asset);
    const st = get();
    if (!st.result) return;
    const sets = targets.map(texSet);
    step(...sets);
    for (const [k, i] of targets.entries()) {
      const out = st.result.parts[i], uv = st.uvs[i];
      if (!out || !uv) continue;
      const ts = sets[k];
      // A material dropped over paint already there keeps the Base Color blend the last one was given (Normal covers it,
      // Multiply tints it): choosing once should not mean switching every texture that follows. The first fill still
      // comes in Normal, so a material is a material, not a darkening.
      const over = ts.layers.some((x) => x.visible && (x.fill || x.decal || x.gen || Object.keys(x.px).length > 0));
      const fill: Fill = { asset: id, projection: 'triplanar', tiling: asset.scale ?? 1, tiles: 4, rotation: 0, offset: [0, 0], normalStrength: 1, tint: '#ffffff', channels: [...FILL_CHANNELS] };
      const layer: PaintLayer = { ...newLayer(ts.layers.length + 1), name: asset.name, fill, ...(over && st.paint.fillBlend !== 'normal' ? { blend: { color: st.paint.fillBlend } } : {}), ...(ts.sel ? { mask: ts.sel.slice() } : {}) };
      ts.layers.splice(ts.active + 1, 0, layer);
      ts.active++;
      ts.channels = [...FILL_CHANNELS];
      bakeFill(ts, layer, maps, out.positions, uv, modelSize(st.result));
      composite(ts);
    }
    set({ paintChannel: 'material' });
    repaint();
  });
}

/** Apply a smart-material recipe to the active part: a fill plus the generator layers that weather it.
 *  Smart materials need baked mesh maps; without them the edge/AO masks have nothing to read. */
export function applySmartMaterial(id: string) {
  if (get().busy) return;
  const recipe = SMART_MATERIALS.find((r) => r.id === id);
  const i = get().activePart;
  if (!recipe || !get().parts[i] || !get().result) return;
  void task(`Building ${recipe.name}…`, async () => {
    // Load every fill's maps first, so a missing material fails before the layer stack is touched.
    const maps = new Map<string, MaterialPixels>();
    for (const spec of recipe.layers) {
      if (!spec.fill) continue;
      const asset = materialOf(spec.fill.asset);
      if (!asset) throw new Error(`The library is missing ${spec.fill.asset}`);
      maps.set(asset.id, await materialPixels(asset));
    }
    const st = get();
    if (!st.result || !st.parts[i]) return;
    const ts = texSet(i);
    if (!ts.bake && recipe.layers.some((l) => l.gen)) throw new Error('Bake mesh maps first: this finish uses edge and AO masks.');
    step(ts);
    const sel = ts.sel, at = ts.active + 1, added: PaintLayer[] = [];
    for (const spec of recipe.layers) {
      if (spec.fill) {
        const fill: Fill = {
          asset: spec.fill.asset, projection: spec.fill.projection ?? 'triplanar',
          tiling: spec.fill.tiling ?? 1, tiles: spec.fill.tiles ?? 4, rotation: spec.fill.rotation ?? 0,
          offset: [0, 0], normalStrength: spec.fill.normalStrength ?? 1, tint: spec.fill.tint ?? '#ffffff',
          ...(spec.fill.roughness != null ? { roughness: spec.fill.roughness } : {}),
          ...(spec.fill.metallic != null ? { metallic: spec.fill.metallic } : {}),
          channels: [...FILL_CHANNELS],
        };
        added.push({ ...newLayer(0), name: spec.name, fill, ...(sel ? { mask: sel.slice() } : {}) });
      } else if (spec.gen) {
        added.push({ ...newLayer(0), name: spec.name, gen: { ...spec.gen, clip: sel ? sel.slice() : null } });
      }
    }
    ts.layers.splice(at, 0, ...added);
    const fillAt = added.findIndex((l) => l.fill);
    ts.active = at + (fillAt >= 0 ? fillAt : added.length - 1);
    ts.channels = [...FILL_CHANNELS];
    const out = st.result.parts[i];
    for (const l of added) {
      if (l.fill) {
        const m = maps.get(l.fill.asset);
        if (m) bakeFill(ts, l, m, out.positions, st.uvs[i], modelSize(st.result));
      } else if (l.gen) generate(ts, l);
    }
    composite(ts);
    set({ paintChannel: 'material' });
    repaint();
  });
}

// A drag on a slider can ask for several bakes; only the newest may land on the layer.
let fillSeq = 0;
/** Change the active fill layer (projection, tiling, rotation, normal strength, tint, channels) and re-bake it.
 *  `undoable` false is for a drag that already took its undo step in `beginPaintEdit`. */
export function updateFill(patch: Partial<Fill>, undoable = true) {
  if (get().busy) return;
  const i = get().activePart, ts = texSet(i), current = ts.layers[ts.active];
  if (!current?.fill) return;
  if (undoable) step(ts); else ensureStep(ts);
  const l = ts.layers[ts.active];
  const f = { ...l.fill!, ...patch };
  const asset = materialOf(f.asset);
  if (!asset) return;
  l.fill = f;
  const seq = ++fillSeq;
  void materialPixels(asset)
    .then((maps) => {
      if (seq !== fillSeq) return;
      const st = get(), out = st.result?.parts[i];
      if (!out || texSet(i).layers[ts.active] !== l) return;
      bakeFill(ts, l, maps, out.positions, st.uvs[i], modelSize(st.result!));
      composite(ts);
      repaint();
    })
    .catch((e) => set({ error: e instanceof Error ? e.message : String(e) }));
}
/** White/black the active fill's mask, invert it, or remove it (white). */
export const setFillMask = (value: number) => layers((s) => { const l = s.layers[s.active]; if (l?.fill) maskFill(s, l, value); });
export const invertFillMask = () => layers((s) => { const l = s.layers[s.active]; if (l?.fill) maskInvert(s, l); });
export const clearFillMask = () => layers((s) => { const l = s.layers[s.active]; if (l?.fill) delete l.mask; });

/** Every channel of the active part, one PNG each (Base Color sRGB, Roughness and Metallic greyscale),
 *  the packed ORM (R AO, G roughness, B metallic) and a small JSON that names the colour spaces. */
export const exportPaint = (preset: TexturePreset = 'generic') => task('Writing the textures…', async () => {
  const { parts, activePart } = get();
  if (!parts[activePart]) return;
  const s = texSet(activePart), prefix = `${baseName()}-${parts[activePart].name}`;
  const save = async (blob: Blob, name: string) => download(blob, `${prefix}-${name}.png`);
  if (preset === 'unreal') {
    await save(await pngOf(s, 'color'), 'BaseColor');
    await save(await pngNormalDX(s), 'Normal');
    await save(await pngORM(s), 'ORM');
    if (s.channels.includes('height')) await save(await pngOf(s, 'height'), 'Height');
  } else if (preset === 'unity-hdrp') {
    await save(await pngOf(s, 'color'), 'BaseColor');
    await save(await pngOf(s, 'normal'), 'Normal');
    await save(await pngUnityHDRP(s), 'MaskMap');
    if (s.channels.includes('height')) await save(await pngOf(s, 'height'), 'Height');
  } else if (preset === 'unity-urp') {
    await save(await pngOf(s, 'color'), 'BaseColor');
    await save(await pngOf(s, 'normal'), 'Normal');
    await save(await pngUnityURP(s), 'MetallicSmoothness');
    if (s.channels.includes('height')) await save(await pngOf(s, 'height'), 'Height');
  } else {
    for (const ch of s.channels) await save(await pngOf(s, ch), CHANNELS[ch].file);
    if (s.bake) await save(await pngShown(s, 'ao'), 'AmbientOcclusion');
    await save(await pngORM(s), 'ORM');
  }
  const meta = {
    part: parts[activePart].name, preset, channels: s.channels,
    normalConvention: preset === 'unreal' ? 'dx' : 'gl',
    colorSpace: { BaseColor: 'srgb', Normal: 'linear', Roughness: 'linear', Metallic: 'linear', AmbientOcclusion: 'linear', Height: 'linear', ORM: 'linear', MaskMap: 'linear', MetallicSmoothness: 'linear' },
  };
  download(new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }), `${prefix}-material.json`);
});

// ---- baking and generators (Substance's Bake Mesh Maps and smart masks) ----
/** Bake AO and edge maps for every visible part, every part casting occlusion on the others. */
/** Quick bake: the active part only, with every visible part casting occlusion. `allParts` is the slow
 *  version that bakes every texture set; the future Bakery tab owns the full low/high-poly workflow. */
export const bakePaint = (allParts = false) => task('Baking mesh maps…', async () => {
  const { result, uvs, activePart, parts } = get();
  if (!result) return;
  const casters = parts.flatMap((p, i) => (p.visible && result.parts[i] ? [result.parts[i].positions] : []));
  const targets = (allParts ? visibleParts() : [activePart]).filter((i) => parts[i] && result.parts[i] && uvs[i]);
  for (const [k, i] of targets.entries()) {
    const s = texSet(i), out = result.parts[i], name = get().parts[i].name;
    const label = targets.length > 1 ? `${name} (${k + 1} of ${targets.length})` : name;
    set({ busy: `Baking ${label}…` });
    const surf = await texelSurface(s.size, out.positions, uvs[i]);
    setBaked(s, await bake(s.size, out.positions, casters, surf, (f) => set({ busy: `Baking ${label} ${Math.round(f * 100)}%` })));
    // generator layers follow the new maps
    for (const l of s.layers) if (l.gen) { generate(s, l); await new Promise((ok) => setTimeout(ok, 0)); }
    composite(s);
    await new Promise((ok) => setTimeout(ok, 0));
  }
  set({ paintAO: true });
  repaint();
});
export const bakeAllPaint = () => bakePaint(true);
export const setPaintAO = (paintAO: boolean) => set((s) => ({ paintAO, paintRev: s.paintRev + 1 })); // the texture view's Material mode too
/** Each generator's starting look: worn bare metal on edges, brown grime in crevices, plain dark occlusion. */
const GEN_START: Record<GenKind, { name: string } & Omit<Gen, 'kind' | 'clip'>> = {
  edge: { name: 'Edge Wear', amount: 0.45, soft: 0.15, width: 0.008, grunge: 0.5, scale: 0.03, color: '#c9c5bd', rough: 0.35, metal: 1 },
  dirt: { name: 'Dirt', amount: 0.4, soft: 0.3, width: 0.012, grunge: 0.4, scale: 0.05, color: '#3d3226', rough: 0.9, metal: 0 },
  ao: { name: 'Ambient Occlusion', amount: 0.6, soft: 0.6, width: 0.01, grunge: 0, scale: 0.05, color: '#000000', rough: 0.8, metal: 0 },
};
/** A generator layer above the active one, inside the selection if there is one (the active part must be baked). */
export function addGenerator(kind: GenKind) {
  if (!get().parts[get().activePart] || !texSet(get().activePart).bake) return;
  layers((s) => {
    const { name, ...g } = GEN_START[kind], l = { ...newLayer(0), name, gen: { kind, ...g, clip: s.sel } };
    generate(s, l);
    s.layers.splice(s.active + 1, 0, l);
    s.active++;
  });
}
/** The active generator layer's settings changed: made again (`undoable` false: inside a slider drag's step). */
export const editGen = (g: Partial<Gen>, undoable = true) => layers((s) => {
  const l = s.layers[s.active];
  if (!l.gen) return;
  s.layers[s.active] = { ...l, gen: { ...l.gen, ...g } };
  generate(s, s.layers[s.active]);
}, undoable);
