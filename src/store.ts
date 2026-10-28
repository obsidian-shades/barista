// App state (zustand) and every user action. UI reads with useApp, acts through the functions below.
import { create } from 'zustand';
import { api, projectApi, textureApi, type IslandIn, type Output, type Params, type PartOut, type SavedProject, type Stats, ServerDown } from './api';
import { decodePack, docFrom, docOf, encodePack, restoreAssets, type SaveSnapshot } from './project';
import { cacheFits, commitCache, newCache, prepareSave, primeCache, resetCache, type SaveCache } from './save';
import type { UVMap } from './colors';
import { download, readParts, toFbx, toObjs, zipFiles, type ExportPart, type FbxSlot } from './files';
import { islandsOf, pickTri, seamSegments } from './islands';
import { placeChanged } from './fitpack';
import { edgeBetween, polygonsOf, sidesOf, topoOf, trisOf, vertexAt, xyzKey, type Topo } from './topo';
import { health, healthReport, ruleCounts, RULES, setModelSize, type RuleId } from './health';
import { clearRecentFiles, forgetRecent, pickWithHandle, recentFiles, remember, rememberProject, reopen } from './recent';
import { carryNormals, dissolve, dissolveFaces, limitedDissolve, link, outNormals, ownPolygons, topoOfSoup, triangulate, trisToQuads, type Polys } from './polyedit';
import { bake } from './bake';
import { resetLight } from './matview';
import { CHANNELS, expMap, isLine, mapAt, composite, dab, dabUV, disposeSet, generate, setBaked, surfaceOfAsync as texelSurface, type Gen, type GenKind, type Shown, bleedAll, fillAll, fillTris, invertSelection as invertMask, growSelection, keep as keepPaint, SOLID, maskPolygon, maskTris, newLayer, requestComposite, restoreSet, setIfAny, sample, select as selectMask, setOf, undo as undoSet, redo as redoSet, setUndoRect, bakeFill, bakeDecal, bakeShape, bakeBevel, type Bevel, decalFrame, shapeHeight, maskDab, maskDabUV, maskFill, maskInvert, maskSelection, shade, type BlendMode, type Brush, type BrushTip, type Channel, type Decal, type Fill, type PaintLayer, type Shape, type SelOp as MaskOp, type TexSet, type TexturePreset } from './paint';
import { gpuBegin, gpuDab, gpuFinish, gpuTake } from './gpupaint';
import { FILL_CHANNELS, loadMaterialLibrary, mapUrl, materialFromFiles, materialPixels, thumbUrl, type MaterialAsset, type MaterialPixels } from './materials';
import { decalFromFile, decalPixels, decalUrl, loadDecalLibrary, type DecalAsset } from './decals';
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
  /** Van Gogh's material view: the key light casts a shadow onto the floor and between the parts. Off, the model is lit
   *  evenly with no cast shadow, so decals on the side turned away from the key stay readable. */
  paintShadow: boolean;
  /** Van Gogh's material view: how much of the base colour shines on its own, added under the key and the environment.
   *  A black paint job's texture is still there in shadow — 0.4 reads it; 0 is the true PBR material. */
  paintLift: number;
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
/** A mirror plane the artist drew in the 3D view: a point on it and its normal, in world units. */
export interface SymPlane { c: [number, number, number]; n: [number, number, number] }
/** Placing the mirror plane with the 3D gizmo: its mode, and the plane to go back to if it's cancelled. */
export interface SymEdit { mode: 'translate' | 'rotate'; before: SymPlane | null }
interface PartSnap { parts: Part[]; uvs: Float32Array[]; result: Output | null; csel: CompSel | null; activePart: number; uvScope: UvScope; past: Snap[]; future: Snap[] }

/** File › Export: a texture set, or a model. */
export type ExportKind = 'textures' | 'model';
/** Which parts an export writes. */
export type ExportScope = 'visible' | 'selected' | 'all';
/** The model-only formats: one binary FBX, or a ZIP of one OBJ per part. */
export type ExportModel = 'fbx' | 'obj';
/** The texture destinations; Blender is the generic set plus an FBX whose materials link the maps. */
export type ExportTarget = 'blender' | TexturePreset;

export interface State {
  source: string | null;
  /** The source file's unit in cm (FBX UnitScaleFactor; 100 = metres), written back on export. */
  unit: number;
  parts: Part[];
  params: Params;
  /** A mirror plane the artist drew (three clicks on the model): Unwrap mirrors across it instead of guessing one.
   *  Null: automatic. */
  symPlane: SymPlane | null;
  /** The plane gizmo is out (null: not editing). Nothing unwraps until Apply. */
  symEdit: SymEdit | null;
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
  /** A project save is writing (it never blocks the tools, unlike `busy`). */
  saving: string | null;
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
  /** The open `.barista` project's path (null: never saved), and whether everything in it is saved. */
  project: string | null;
  saved: boolean;
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
  paint: { tool: PaintTool; pickMode: PickMode; grab: MaterialGrab | null; color: string; rough: number; metal: number; on: Record<Channel, boolean>; size: number; flow: number; hardness: number; tip: BrushTip; by: FillBy; angle: number; decalMode: DecalMode; decalSel: boolean;  decalAsset: string; decalTint: string; decalSize: number; decalRotation: number; fillBlend: BlendMode };
  /** Parts expanded in Van Gogh's Parts tree. */
  paintOpen: number[];
  /** The channel the UV view shows (picked under the part in Parts). */
  paintChannel: Shown;
  /** The baked ambient occlusion shades the model (Substance shows it as soon as it's baked). */
  paintAO: boolean;
  /** Van Gogh's All sets: fills, solids, generators and layer edits go to every visible part's set, not just the active one. */
  linkSets: boolean;
  /** A reference picture over the 3D view (View › Reference image…), to paint against. */
  refImage: { url: string; opacity: number } | null;
  /** Bumped when a texture set's layers or paint change, so the panel and the UV view read them again. */
  paintRev: number;
  /** A cheap tick for the layer panel while a full recomposite is pending; the view updates when it finishes. */
  paintPanel: number;
  /** A cheap, throttled tick while a stroke is in progress: views redraw without rebuilding the panel. */
  paintLive: number;
  /** Moves when Van Gogh's light turns (Shift+right-drag): redraws the views, never touches the document. */
  lightRev: number;
  /** The PBR material shelf: built-ins from public/materials plus folders imported this session. */
  materials: MaterialAsset[];
  materialsLoading: boolean;
  materialsError: string | null;
  /** The decal shelf: built in from public/decals plus images imported this session. */
  decals: DecalAsset[];
  decalsLoading: boolean;
  decalsError: string | null;
  /** Which Van Gogh dock tab is open: layers, materials, decals or maps. Color is permanently above the tabs. */
  paintTab: 'layers' | 'assets' | 'maps';
  assetTab: 'materials' | 'tiles' | 'decals' | 'geometry';
  /** The engine preset the Maps tab's export button uses. */
  texturePreset: TexturePreset;
  /** The size the engine renders exported textures at (to 16K; the editor paints at `textureResolution`). */
  exportSize: number;
  /** File › Export open: the dedicated dialog (its tab, scope, format and gutter are remembered). */
  exportOpen: boolean;
  exportKind: ExportKind;
  exportModel: ExportModel;
  exportScope: ExportScope;
  /** Texture export: also write the FBX whose materials link the maps (Blender's own import comes in textured). */
  exportFbx: boolean;
  /** Texels of colour bled past each island for the mip chain; 0 = the engine's default, max(4, size / 64). */
  exportPadding: number;
  /** A one-line result for the status bar (an export's folder); cleared when the next task starts. */
  notice: string | null;
  /** Van Gogh: what a Bucket / Wand click or a material dropped from the shelf would take, under the mouse (outlined). */
  paintHover: { part: number; tris: number[] } | null;
  /** Mirror tool: where a click would put the selected mark's mirrored copy (`snapped`: on the spot symmetric to it). */
  mirrorAim: { part: number; decal: Decal; snapped: boolean } | null;
  /** Van Gogh: the line being drawn with a groove / scratch armed (world points), shown until it is let go. */
  drawLine: [number, number, number][] | null;
  /** A question the app waits on (`AskDialog`, modal): how to open a model, or what to do with unsaved changes. */
  ask: Ask | null;
  /** File › Ask how to open models: off, a model opens with the last answer (`openOpts`) without asking. */
  askOnOpen: boolean;
  openOpts: OpenOpts;
}
export interface OpenOpts { resolution: number; unwrap: boolean; one_atlas: boolean; join: boolean; sharp: number; workspace: Workspace }
const OPEN_DEFAULTS: OpenOpts = { resolution: 1024, unwrap: true, one_atlas: false, join: true, sharp: 45, workspace: 'uv' };
/** The last open answers (localStorage `openOpts`), over the defaults. */
function savedOpen(): OpenOpts {
  try { return { ...OPEN_DEFAULTS, ...JSON.parse(localStorage.getItem('openOpts') ?? '{}') }; } catch { return OPEN_DEFAULTS; }
}
export type Ask =
  | { kind: 'open'; name: string; done: (o: OpenOpts | null) => void }
  | { kind: 'unsaved'; name: string; done: (a: 'save' | 'discard' | null) => void };
export type Workspace = 'uv' | 'doc' | 'paint';
export type PaintTool = 'marquee' | 'lasso' | 'wand' | 'decal' | 'mirror' | 'brush' | 'erase' | 'bucket' | 'picker';
/** What the Eyedropper takes: the material layers of the part it clicks (fills, solids, generators, bevels — not
 *  decals or hand paint), or the base colour / roughness / metallic under the pointer. */
export type PickMode = 'material' | 'color';
/** A material stack held on the cursor: the source part's material layers as settings (the pixels are baked again on
 *  every target), with the name and picture the cursor shows. */
export interface MaterialGrab {
  from: number;
  fromName: string;
  /** The top fill's material name, or its layer's name for a solid. */
  name: string;
  layers: GrabbedLayer[];
  /** The top fill's material preview (a shelf thumbnail); null for a solid, whose `tint` is drawn instead. */
  thumb: string | null;
  tint: string | null;
  count: number;
}
export type GrabbedLayer = Pick<PaintLayer, 'name' | 'visible' | 'opacity' | 'blend'> & { fill?: Fill; gen?: Gen; bevel?: Bevel };
/** What a click on the model does with the Decal tool: `edit` selects the mark under it (and drags it), `place`
 *  puts a copy of the armed mark there. The tool stays in `edit`; a tile clicked in the Decals tab arms one
 *  placement, so a click meant to move a mark can never leave another one behind. */
/** Decal tool: Select (pick and move marks), Place (the next click puts the armed mark), Draw (a drag lays a groove
 *  or scratch along the stroke). */
export type DecalMode = 'edit' | 'place' | 'draw';
export type FillBy = 'face' | 'surface' | 'island' | 'part';
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
/** A string kept in the browser between sessions, only if it is one of `allowed`. */
function savedStr<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try { const v = localStorage.getItem(key); return allowed.includes(v as T) ? v as T : fallback; } catch { return fallback; }
}
const keepStr = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private mode */ } };
export const setDockWidth = (w: number) => { const dockWidth = Math.round(Math.min(420, Math.max(260, w))); set({ dockWidth }); keep('dockWidth', dockWidth); };
export const setViewSplit = (f: number) => { const viewSplit = Math.min(0.8, Math.max(0.2, f)); set({ viewSplit }); keep('viewSplit', viewSplit); };
const savedWorkspace = (): Workspace => { try { return (['doc', 'paint'] as const).find((w) => w === localStorage.getItem('workspace')) ?? 'uv'; } catch { return 'uv'; } };

export const useApp = create<State>(() => ({
  source: null, unit: 100, parts: [], params: { sharp: 45, tol: 0.08, seam_weight: 0.1, join: true, atlas: 0, one_atlas: false }, symPlane: null, symEdit: null, activePart: 0, layerSel: [], layerAnchor: 0, uvScope: 'part', result: null, uvs: [], uvRev: 0, edited: false,
  rev: 0, past: [], future: [], partsPast: [], partsFuture: [], selected: [], selectMode: 'face', csel: null, viewReq: { view: '3d', op: 'all', n: 0 }, menu: null, boxArmed: false, xform: null, liveUnwrap: true, afterAlign: saved('afterAlign', 1, 0, 1) === 1, afterPack: saved('afterPack', 1, 0, 1) === 1, pins: {}, shapeClipboard: null, mode: 'checker', textureResolution: 1024, uvMap: 'checker', recentColors: [],
  scene: { background: '#111111', ...WORK_LIGHT, hdriUrl: null, hdriId: '', hdriName: '', hdriBackground: false, hdriStrength: 1, hdriRotation: 0, hdriBlur: 0, wireframe: false, showEdges: true, showVertices: true, showSeams: true, showGrid: false, showAxes: false,
    lighting: 'studio', matcap: 'clay', bg: 'theme', backface: false, outline: false, specular: true, xray: false, xrayAlpha: 0.5, shadow: false, shadowAmount: 0.4, paintShadow: true, paintLift: 0.4, cavity: false, cavityType: 'both', cavityDistance: 0.2, ridge: 1, valley: 1 }, unfold: 0,
  busy: null, saving: null, error: null, server: 'unknown', shapes: [], loading: null, workspace: savedWorkspace(), triangulate: false, fixNote: null, docView: 'wire', docColor: 'single', showPoles: false, dockWidth: saved('dockWidth', 300, 260, 420), viewSplit: saved('viewSplit', 0.55, 0.2, 0.8), docTool: null, uvTool: null, project: null, saved: true, recent: [], docOpts: { slide: 0.25, angle: 5, relax: 30 }, slideBorders: true, docMove: null, moveOnSurface: true,
  paint: { tool: 'brush', pickMode: 'material' as PickMode, grab: null, color: '#c0392b', rough: 0.5, metal: 0, on: { color: true, rough: false, metal: false, normal: false, height: false }, size: 3, flow: 0.6, hardness: 0.5, tip: 'round' as BrushTip, by: 'island' as FillBy, angle: 30, decalMode: 'edit' as DecalMode, decalSel: true,  decalAsset: 'garuda-mark', decalTint: '#ffffff', decalSize: 14, decalRotation: 0, fillBlend: 'normal' as BlendMode }, paintChannel: 'material', paintRev: 0, paintPanel: 0, paintLive: 0, lightRev: 0, paintOpen: [0], paintAO: true, linkSets: false, refImage: null,
  materials: [], materialsLoading: false, materialsError: null, decals: [], decalsLoading: false, decalsError: null, paintTab: 'layers', assetTab: 'materials', texturePreset: 'generic', exportSize: saved('exportSize', 4096, 256, 16384),
  exportOpen: false, exportKind: savedStr('exportKind', 'textures', ['textures', 'model'] as const), exportModel: savedStr('exportModel', 'fbx', ['fbx', 'obj'] as const),
  exportScope: savedStr('exportScope', 'visible', ['visible', 'selected', 'all'] as const), exportFbx: saved('exportFbx', 0, 0, 1) === 1, exportPadding: saved('exportPadding', 0, 0, 512),
  paintHover: null, mirrorAim: null, drawLine: null, ask: null, askOnOpen: saved('askOnOpen', 1, 0, 1) === 1, openOpts: savedOpen(),
  notice: null,
}));
const set = useApp.setState, get = useApp.getState;
export const updateScene = (scene: Partial<Scene>) => set((s) => ({ scene: { ...s.scene, ...scene } }));
/** Van Gogh's Lift (a fill light opposite the key, `matview.fillOf`): a view setting, so it redraws both the model and the texture view's material. */
export const setPaintLift = (paintLift: number) => set((s) => ({ scene: { ...s.scene, paintLift }, lightRev: s.lightRev + 1 }));
const SCENE0 = get().scene;
/** Shading › Reset: every viewport setting (lighting, lamps, map, background, options, overlays) back to the default,
 *  and Van Gogh's light turned back to the front-left. */
export const resetScene = () => { resetLight(); set((s) => ({ scene: SCENE0, lightRev: s.lightRev + 1 })); };
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
  set({ busy: label, error: null, notice: null });
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
/** The drawn mirror plane as the engine's `PartIn.symmetry` (a point and a normal): empty means auto-detect. */
const planeArg = (s: State) => (s.symPlane ? [...s.symPlane.c, ...s.symPlane.n] : []);
/** No seams measured yet (a preview or Poly Doc's bare mesh): a new unwrap fills them in (`Stats.seams`). */
const NO_SEAMS = () => ({ length: 0, hidden: 0, spurs: 0, spur_length: 0, steps: 0, inside: 0 });
let latest = 0;
async function solve(refit = true) {
  const { parts, params } = get(), me = ++latest;
  if (!parts.length) return;
  const previous = get().result;
  if (!previous) {
    const preview = { parts: parts.map(placeholder), stats: { islands: 0, tris: 0, flips: 0, mean_stretch: 0, max_stretch: 0, good_area: 0, overlap: 0, efficiency: 0, seams: NO_SEAMS(), ms: 0 } };
    set((s) => ({ result: preview, uvs: preview.parts.map((p) => new Float32Array(p.uvs)), uvRev: s.uvRev + 1, rev: s.rev + 1 }));
  }
  set((s) => ({ loading: { phase: 'unwrap', total: parts.length, complete: 0, active: 'All meshes (Rust parallel)', done: parts.map(() => !!previous) } }));
  const result = await api.unwrap(parts.map((p) => ({ ...p, seams: p.marked, symmetry: planeArg(get()) })), params);
  if (me !== latest) return;
  set((s) => ({
    result, uvs: result.parts.map((p) => new Float32Array(p.uvs)), uvRev: s.uvRev + 1, edited: false, parts: s.parts.map((p, i) => (result.parts[i] ? { ...withBorders(p, result.parts[i]), stale: false } : p)),
    rev: refit ? s.rev + 1 : s.rev, past: [], future: [], csel: null, activePart: Math.min(s.activePart, result.parts.length - 1), loading: null,
  }));
}

/** Poly Doc's view of parts: the bare mesh as the output, no unwrap (all parts, or just one after an edit). Each is
 *  marked stale so UV Magician unwraps it when you go back there. */
function meshOnly(only?: number) {
  const s = get(), stats = { islands: 0, tris: 0, flips: 0, mean_stretch: 0, max_stretch: 0, good_area: 0, overlap: 0, efficiency: 0, seams: NO_SEAMS(), ms: 0 };
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
  const output = await api.unwrap([{ ...part, seams: part.marked, symmetry: planeArg(get()) }], { ...params, one_atlas: false });
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
  startAutosave();
  void recentFiles().then((r) => set({ recent: r.map(({ name, time }) => ({ name, time })) }));
  set({ shapes: await api.shapes() });
});
export const unwrap = () => task('Unwrapping…', async () => {
  if (get().loading) return;
  const { activePart, parts } = get();
  // opened without unwrapping (or changed in Poly Doc): every part still waiting, not just the active one
  if (parts.some((p) => p.stale)) await unwrapChanged();
  else if (parts.length) await unwrapPart(activePart);
});
/** The open question's answer (null: cancelled / Esc). */
export function answerAsk(v: OpenOpts | 'save' | 'discard' | null) {
  const a = get().ask;
  set({ ask: null });
  a?.done(v as never);
}
export const setAskOnOpen = (askOnOpen: boolean) => { set({ askOnOpen }); keep('askOnOpen', +askOnOpen); };
/** Before the document is replaced or the window closes: true when nothing is unsaved, or the user saved or let it go. */
export async function confirmDiscard() {
  const s = get();
  if (s.saved || !s.parts.length) return true;
  const name = s.project?.split(/[\\/]/).pop() ?? s.source ?? 'Untitled';
  const a = await new Promise<'save' | 'discard' | null>((done) => set({ ask: { kind: 'unsaved', name, done } }));
  if (a !== 'save') return a === 'discard';
  try { return !!(await writeProject('save')); } catch (e) { set({ error: (e as Error).message }); return false; }
}
/** How to open a model: asked (resolution, unwrap settings, workspace), or the last answer when File › Ask how to open models is off. */
async function openOptions(name: string) {
  if (!get().askOnOpen) return get().openOpts;
  const o = await new Promise<OpenOpts | null>((done) => set({ ask: { kind: 'open', name, done } }));
  if (o) { set({ openOpts: o }); keepStr('openOpts', JSON.stringify(o)); }
  return o;
}
export const loadShape = async (name: string) => (await confirmDiscard()) && task(`Unwrapping ${name}…`, async () => {
  const me = ++latest;
  set({ loading: { phase: 'read', total: 0, complete: 0, active: null, done: [] }, source: name });
  const soup = new Float32Array(await api.shape(name));
  if (me !== latest) return;
  const parts = [{ name, soup, seams: [], marked: [], solved: [], visible: true, textured: true }];
  ++docGen;
  resetCache(cache);
  setModelSize([soup]);
  resetPaintHistory();
  set({ project: null, source: name, unit: 100, parts, partsPast: [], partsFuture: [], result: null, uvs: [], activePart: 0, layerSel: [0], layerAnchor: 0, uvScope: 'part', csel: null, fixNote: null, symPlane: null, symEdit: null });
  if (get().workspace === 'doc') meshOnly(); else await solve();
});
export async function openFile(file: File) {
  if (!(await confirmDiscard())) return;
  const o = await openOptions(file.name);
  if (o) await loadFile(file, o);
}
const loadFile = (file: File, o: OpenOpts) => task(`${o.unwrap ? 'Unwrapping' : 'Opening'} ${file.name}…`, async () => {
  const me = ++latest;
  // the new model's own settings; nothing unwraps on the switch, the old parts are about to go
  set((s) => ({ params: { ...s.params, one_atlas: o.one_atlas, join: o.join, sharp: o.sharp } }));
  showWorkspace(o.workspace, false);
  set({ loading: { phase: 'read', total: 0, complete: 0, active: file.name, done: [] }, source: file.name });
  const { parts: imported, unit } = await readParts(file);
  if (me !== latest) return;
  const parts = imported.map((p) => ({ ...p, seams: [], marked: [], solved: [], visible: true, textured: true }));
  ++docGen;
  resetCache(cache);
  setModelSize(parts.map((p) => p.soup));
  resetPaintHistory();
  set({ project: null, source: file.name, unit, parts, partsPast: [], partsFuture: [], result: null, uvs: [], activePart: 0, layerSel: parts.length ? [0] : [], layerAnchor: 0, uvScope: o.one_atlas ? 'all' : 'part', csel: null, fixNote: null, textureResolution: o.resolution, symPlane: null, symEdit: null });
  // no auto unwrap: the bare mesh, stale, so Unwrap (or entering UV Magician / Van Gogh from Poly Doc) unwraps it
  if (get().workspace === 'doc' || !o.unwrap) meshOnly(); else await solve();
  // a model just opened is its source file: nothing to lose yet, so opening another doesn't ask to save it
  // (solve takes its own `latest`, so this asks whether the result landed instead)
  if (get().source === file.name && !get().loading) set({ saved: true });
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

/** The model's middle, where a new plane goes (arrays, no THREE in the store). */
let centreOf: { r: unknown; c: [number, number, number] } | null = null;
export const modelCentre = (): [number, number, number] => {
  const r = get().result;
  if (centreOf?.r === r) return centreOf.c;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of get().result?.parts ?? []) {
    for (let i = 0; i + 2 < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const x = p.positions[i + k];
        if (x < lo[k]) lo[k] = x;
        if (x > hi[k]) hi[k] = x;
      }
    }
  }
  const c: [number, number, number] = Number.isFinite(lo[0]) ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : [0, 0, 0];
  centreOf = { r, c };
  return c;
};

/** Show the mirror-plane gizmo: one across the model's middle (+X: the side-to-side of most characters and vehicles),
 *  or grab the plane already set. Move/rotate it, then Apply — nothing unwraps before that. */
export const editSymPlane = () => {
  if (get().symEdit) return;
  const before = get().symPlane;
  set({ symEdit: { mode: 'translate', before }, symPlane: before ?? { c: modelCentre(), n: [1, 0, 0] }, error: null });
};
/** The gizmo moved or turned: keep the plane where it now sits; the UVs wait for Apply. */
export const moveSymPlane = (c: [number, number, number], n: [number, number, number]) => {
  if (get().symEdit) set({ symPlane: { c, n } });
};
export const setSymMode = (mode: SymEdit['mode']) => {
  const e = get().symEdit;
  if (e && e.mode !== mode) set({ symEdit: { ...e, mode } });
};
/** Apply: unwrap the whole model across the plane as it now sits. */
export const applySymPlane = () => {
  if (!get().symEdit || get().loading) return;
  set({ symEdit: null, saved: false });
  void task('Unwrapping across the symmetry plane…', () => solve());
};
/** Esc / Cancel: undo the move, back to the plane as it was (or none). The UVs never moved. */
export const cancelSymPlane = () => {
  const e = get().symEdit;
  if (!e) return;
  set({ symPlane: e.before, symEdit: null });
};
/** Back to the automatic plane (and the unwrap it gives). */
export const clearSymPlane = () => {
  if ((!get().symPlane && !get().symEdit) || get().loading) return;
  set({ symPlane: null, symEdit: null, saved: false });
  void task('Unwrapping without a drawn plane…', () => solve());
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
  if (r.path) { await openProject(r.path); return; }
  let file: File;
  try { file = await reopen(r); } catch (e) {
    await forgetRecent(name);
    set({ recent: (await recentFiles()).map(({ name, time }) => ({ name, time })) });
    throw new Error(`${name} couldn't be opened again (moved or deleted?): it's off the recent list. ${(e as Error).message}`);
  }
  await openRemembered(file, r.handle);
});
export const clearRecent = async () => { await clearRecentFiles(); set({ recent: [] }); };

// ---- .barista projects (project.ts, save.ts, engine/src/project.rs) ----
const listRecent = async () => set({ recent: (await recentFiles()).map(({ name, time }) => ({ name, time })) });
/** What the open project's file already holds (blob names by content key), so a save writes only what changed. */
let cache: SaveCache = newCache();
/** Which document the cache describes: opening another one drops it (a save still in flight must not touch it). */
let docGen = 0;
/** Saves run one at a time: the engine takes a Pack as one staged buffer (src-tauri `stage`), so two at once would mix. */
let saveChain: Promise<unknown> = Promise.resolve();
const serialize = <T,>(f: () => Promise<T>): Promise<T> => {
  const p = saveChain.then(f, f);
  saveChain = p.catch(() => {});
  return p;
};
const saveError = (e: unknown) => set({ error: e instanceof Error ? e.message : String(e) });

/** A stroke or a slider drag is writing a set's buffers in place: a save waits for it to end, so it photographs the
 *  project rather than a half-made stroke. (A GPU stroke also replays into the CPU once the mouse is up.) */
const paintIdle = () => !painting() && !committing && !paintEditingNow();
async function untilIdle() {
  for (let i = 0; i < 120 && !paintIdle(); i++) await new Promise((ok) => setTimeout(ok, 50));
}

/** The document as Ctrl+S found it: taken in this tick, so the write below is a snapshot, not a race with the artist. */
interface SaveJob { how: 'save' | 'as' | 'auto'; snap: SaveSnapshot; name: string; gen: number; path: string | null }
function saveJob(how: SaveJob['how']): SaveJob | null {
  const s = get();
  if (!s.parts.length) return null;
  // a composite tile the file holds under the same stamp is only named, not copied in this tick
  const snap = docOf(s, (i) => setIfAny(s.parts[i].soup), { reuse: (id, key) => cache.keys.get(id) === key });
  const name = (s.project?.split(/[\\/]/).pop() ?? baseName()).replace(/\.barista$/i, '');
  return { how, snap, name, gen: docGen, path: how === 'as' ? null : s.project };
}
const mb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** File › Save (Ctrl+S) / Save As (Ctrl+Shift+S): the engine asks where the first time, then writes there. The editor
 *  is never blocked: the snapshot is taken here, and the bytes are made while the artist keeps working. */
export const saveProject = (as = false) => {
  const job = saveJob(as ? 'as' : 'save');
  if (job) void serialize(() => runSave(job)).catch(saveError);
};
/** Autosave: into the project's own file once it has one, else into the engine's autosave folder (File › Recover). */
async function writeProject(how: 'save' | 'as' | 'auto'): Promise<string | null> {
  const job = saveJob(how);
  return job ? serialize(() => runSave(job)) : null;
}
/** The engine's project format: an older engine can't take a keep list, so it is sent every blob. */
let engineFormat: number | null = null;
async function saveFormat(): Promise<number> {
  if (engineFormat !== null && engineFormat >= 2) return engineFormat;
  engineFormat = await projectApi.format().catch(() => 0);
  return engineFormat;
}
/** Write a job's snapshot: only changed blobs, unless the file can't take them (a new path, or it moved on). */
async function runSave(job: SaveJob, full = false): Promise<string | null> {
  // the document was replaced while this save waited its turn: that project owns the app now
  if (job.gen !== docGen) return null;
  if (!paintIdle()) await untilIdle();
  if (job.gen !== docGen) return null;
  const path = job.how === 'as' ? null : job.path ?? get().project;
  const auto = job.how === 'auto' && !path;
  // the file's own revision and blob names are only known for the project (or autosave file) this editor just had,
  // and only an engine that understands them may be sent a keep list
  const reuse = !full && job.how !== 'as' && (await saveFormat()) >= 2 && (path ? cacheFits(cache, path) : auto && cacheFits(cache, null));
  set({ saving: 'Saving…' });
  try {
    const prepared = await prepareSave(job.snap, cache, {
      reuse, path: path ?? (auto ? cache.path : null), auto,
      onProgress: ({ bytes }) => set({ saving: bytes ? `Saving… ${mb(bytes)}` : 'Saving…' }),
    });
    const head = {
      path, save_as: job.how === 'as', autosave: auto, name: job.name, doc: job.snap.doc,
      ...(reuse ? { rev: cache.rev, keep: prepared.keep } : {}),
    };
    // an engine older than format 2 answers with the path alone (or null): it was sent every blob, so its revision is
    // unknown (0) and the next save writes everything again
    // the pack owns the blob data now: drop our references before the upload so a big first save peaks lower
    const pack = encodePack(JSON.stringify(head), prepared.blobs);
    prepared.blobs.length = 0;
    const raw = (await projectApi.save(pack)) as unknown as SavedProject | string | null;
    const done: SavedProject = typeof raw === 'string' || raw === null ? { path: raw, rev: 0, stale: false, written: 0 } : raw;
    if (done.stale) {
      // another window (or a check script) wrote this project after we last saw it: write ours whole, as it is now
      if (job.gen !== docGen) return null;
      const fresh = saveJob(job.how);
      if (!fresh) return null;
      return runSave(fresh, true);
    }
    if (!done.path) return null; // the dialog was cancelled
    // the cache belongs to the file the engine actually wrote (a dialog may have picked a different one)
    if (job.gen === docGen) { commitCache(cache, { ...prepared.next, path: done.path }, done.rev); cache.path = done.path; }
    // a file that couldn't be read is worth saying, but the project saved: its layer's pixels are in the file
    if (job.snap.warnings.length) set({ notice: job.snap.warnings[0] });
    if (job.how === 'auto') return done.path;
    const now = get(), was = job.snap.stamp;
    // edits made while the file was being written stay unsaved
    const same = now.parts === was.parts && now.uvs === was.uvs && now.result === was.result && now.uvRev === was.uvRev
      && now.paintRev === was.paintRev && now.params === was.params && now.textureResolution === was.textureResolution
      && now.scene.hdriUrl === was.sceneHdri && now.refImage === was.refImage;
    // the document may have been replaced while the bytes were written: that project owns the app now
    if (job.gen === docGen) set({ project: done.path, saved: same });
    await rememberProject(done.path);
    await listRecent();
    return done.path;
  } finally {
    set({ saving: null });
  }
}
const mergeById = <T extends { id: string }>(add: T[], have: T[]) => [...add, ...have.filter((x) => !add.some((a) => a.id === x.id))];
let restoring = false;
/** File › Open Project…: a `.barista` back as it was saved (`recover`: the dialog opens in the autosave folder). */
export const openProject = async (path?: string, recover = false) => (await confirmDiscard()) && task('Opening project…', async () => {
  const { json, blobs } = decodePack(await projectApi.open({ path, recover }));
  const head = JSON.parse(json) as { cancelled?: boolean; path: string; rev?: number; lz4?: boolean; doc: unknown };
  if (head.cancelled) return;
  const { state, sets, pixels, assets, names, warnings } = docFrom(head.doc, blobs, head.lz4);
  ++latest; // whatever was loading is stale now
  ++docGen;
  resetCache(cache);
  restoring = true;
  try {
    const restored = restoreAssets(assets);
    setModelSize(state.parts.map((p) => p.soup));
    resetPaintHistory();
    set((s) => ({ ...state, scene: { ...state.scene, ...restored.scene },
      materials: mergeById(restored.materials, s.materials), decals: mergeById(restored.decals, s.decals), refImage: restored.refImage,
      project: recover ? null : head.path, saved: !recover, rev: s.rev + 1, uvRev: s.uvRev + 1, edited: false, loading: null,
      // the Unfold slider is a view of the old model's UVs: a project opens on the model itself
      unfold: 0,
      past: [], future: [], partsPast: [], partsFuture: [], csel: null, selected: [], layerSel: state.parts.length ? [state.activePart] : [], layerAnchor: state.activePart,
      uvScope: state.params.one_atlas ? 'all' : 'part', fixNote: null, paintOpen: [state.activePart], error: warnings[0] ?? null }));
    const restoredSets: { i: number; ts: TexSet }[] = [];
    sets.forEach((saved, i) => {
      if (!saved || !state.parts[i]) return;
      const ts = restoreSet(state.parts[i].soup, saved, pixels(i, saved.size));
      if (ts.sel) shade(ts);
      // a set saved with its composite shows as it is: only the others lay their stack out
      if (!saved.comp) restoredSets.push({ i, ts });
    });
    repaint();
    // Each set's stack is laid out in bands, one set after another (the active part first): opening a 100 MB project
    // must not hold the view while its paint composites, and seven compositing loops at once only fight for one CPU.
    // A view tick, not `repaint`: filling textures is not an edit, and a paintRev bump would mark the fresh project unsaved.
    if (restoredSets.length) {
      const order = [...restoredSets].sort((a, b) => (a.i === state.activePart ? -1 : b.i === state.activePart ? 1 : a.i - b.i));
      void (async () => {
        for (const [k, { ts }] of order.entries()) {
          set({ notice: order.length > 1 ? `Preparing paint… ${k + 1}/${order.length}` : 'Preparing paint…' });
          await requestComposite(ts);
          set((s) => ({ paintLive: s.paintLive + 1 }));
        }
        set({ notice: null });
      })();
    }
    // the blobs the file holds are the state's now: a save right after opening writes only the edits
    if (!recover) primeCache(cache, docOf(get(), (i) => setIfAny(get().parts[i].soup), { reuse: () => true }), names, head.rev ?? 0, head.path);
  } finally { restoring = false; }
  if (!recover) { await rememberProject(head.path); await listRecent(); }
  // a project can hold parts Poly Doc left mesh-only (opened without an unwrap, or edited there and saved before
  // switching): the bare mesh would come back with every UV at 0, which reads as an untextured/blank model in UV
  // Magician and Van Gogh. UV / paint open those parts now, as entering the workspace does; Poly Doc keeps its mesh.
  if (state.parts.length && (!state.result || state.parts.some((p) => p.stale))) {
    if (get().workspace === 'doc') { if (!state.result) meshOnly(); }
    else if (state.result) await unwrapChanged();
    else await solve();
  }
});
// Anything that changes the document marks it unsaved (the title's dot).
useApp.subscribe((s, p) => {
  if (!restoring && s.saved && (s.parts !== p.parts || s.uvs !== p.uvs || s.result !== p.result || s.uvRev !== p.uvRev
    || s.paintRev !== p.paintRev || s.params !== p.params || s.textureResolution !== p.textureResolution
    // the environment map and the reference picture are files the project now carries
    || s.scene.hdriUrl !== p.scene.hdriUrl || s.refImage !== p.refImage)) set({ saved: false });
});
const AUTOSAVE_MS = 2 * 60 * 1000;
let autosaving = false;
/** Every two minutes, unsaved work is written (started once the app connects, so check scripts don't keep running). */
function startAutosave() {
  if (autosaving || typeof window === 'undefined') return;
  autosaving = true;
  window.setInterval(() => {
    const s = get();
    if (!s.saved && s.parts.length && !s.busy && !s.loading && !s.saving && paintIdle()) void writeProject('auto').catch(saveError);
  }, AUTOSAVE_MS);
}

const baseName = () => (get().source ?? 'mesh').replace(/\.[^.]+$/, '');
/** The parts an export writes: visible (the default), the parts chosen in the texture-set tree (or the active one),
 *  or every part. Indices are into `parts` / `result.parts`, which are kept in step. */
export function scopeIndices(scope: ExportScope): number[] {
  const s = get();
  if (scope === 'all') return s.parts.map((_, i) => i);
  if (scope === 'selected') return (s.layerSel.length ? s.layerSel : s.parts[s.activePart] ? [s.activePart] : []).filter((i) => i >= 0 && i < s.parts.length);
  return s.parts.flatMap((p, i) => (p.visible ? [i] : []));
}
/** Every part in scope with its current UVs; with one atlas they share a material, so Painter gives them one set. */
function exportParts(): { i: number; part: ExportPart }[] | null {
  const { result, uvs, parts, params } = get();
  if (!result) return null;
  if (result.parts.length !== parts.length || uvs.length !== parts.length) throw new Error('Export stopped: the unwrapped mesh count does not match the imported part count.');
  const tri = get().triangulate, picked = scopeIndices(get().exportScope);
  if (!picked.length) throw new Error('Nothing in scope to export.');
  return picked.filter((i) => result.parts[i] && uvs[i]).map((i) => {
    const p = parts[i];
    return { i, part: { name: p.name, material: params.one_atlas ? baseName() : p.name, out: result.parts[i], uv: uvs[i],
      faces: tri || !p.poly ? undefined : polygonsOf(result.parts[i].source, p.poly),
      normals: p.normals?.length === p.soup.length ? outNormals(result.parts[i].positions, result.parts[i].source, p.soup, p.normals) : undefined } };
  });
}
export const setTriangulate = (triangulate: boolean) => set({ triangulate });
/** File › Export ▸ Model: the parts in scope as one binary FBX in the browser's downloads. */
export const exportFbx = () => task('Exporting FBX…', async () => {
  await unwrapChanged();
  const ps = exportParts();
  if (ps) download(toFbx(ps.map((x) => x.part), get().params.sharp, get().unit), `${baseName()}-unwrapped.fbx`);
});
export const exportObjParts = () => task('Exporting OBJ parts…', async () => {
  await unwrapChanged();
  const ps = exportParts();
  if (ps) download(zipFiles(toObjs(ps.map((x) => x.part), get().params.sharp, get().unit)).buffer as ArrayBuffer, `${baseName()}-unwrapped-obj.zip`);
});
export const setExportSize = (exportSize: number) => { set({ exportSize }); keep('exportSize', exportSize); };
export const setExportScope = (scope: ExportScope) => { set({ exportScope: scope }); keepStr('exportScope', scope); };
export const setExportKind = (kind: ExportKind) => { set({ exportKind: kind }); keepStr('exportKind', kind); };
export const setExportModel = (model: ExportModel) => { set({ exportModel: model }); keepStr('exportModel', model); };
export const setExportPadding = (padding: number) => { set({ exportPadding: padding }); keep('exportPadding', padding); };
/** The texture destination: Blender is the generic set plus the FBX whose materials link the maps. */
export const setExportTarget = (target: ExportTarget) => {
  set(target === 'blender' ? { texturePreset: 'generic', exportFbx: true } : { texturePreset: target, exportFbx: false });
  keep('exportFbx', target === 'blender' ? 1 : 0);
};
/** File › Export…: open the dialog, optionally on a tab, format or destination. */
export const openExport = (o: { kind?: ExportKind; model?: ExportModel; target?: ExportTarget } = {}) => {
  if (o.kind) setExportKind(o.kind);
  if (o.model) setExportModel(o.model);
  if (o.target) setExportTarget(o.target);
  set({ exportOpen: true });
};
export const closeExport = () => set({ exportOpen: false });
/** The dialog's Export button: whichever tab it is on. */
export const runExport = () => {
  const s = get();
  if (s.exportKind === 'model') { void (s.exportModel === 'fbx' ? exportFbx() : exportObjParts()); return; }
  void exportTextures();
};
/** File › Export ▸ Textures: the engine renders every part in scope at `exportSize` (texture/mod.rs) from the project
 *  as saved, and writes the PNGs into a folder it asks for; `exportFbx`: the generic set plus the FBX with each part's
 *  material linked to its maps, so Blender's own FBX import comes in textured. The project is saved first (into its
 *  file, or the autosave folder before the first save), because that is what the engine reads. */
export const exportTextures = () => task('Exporting textures…', async () => {
  await unwrapChanged();
  const project = (get().saved && get().project) || await writeProject(get().project ? 'save' : 'auto');
  if (!project) return;
  const s = get(), base = baseName(), preset = s.exportFbx ? 'generic' : s.texturePreset;
  // where each fill's maps and each decal's image are on disk (blob: imports fall back to their painted pixels)
  const [library, decalShelf] = await Promise.all([loadMaterialLibrary().catch(() => []), loadDecalLibrary().catch(() => [])]);
  const materials: Record<string, Record<string, string>> = {}, decals: Record<string, string> = {};
  for (const p of s.parts) {
    for (const l of setIfAny(p.soup)?.layers ?? []) {
      if (l.fill?.asset === SOLID) materials[SOLID] = {}; // no maps: the engine draws its tint, roughness and metallic
      const m = l.fill && (s.materials.find((x) => x.id === l.fill!.asset) ?? library.find((x) => x.id === l.fill!.asset));
      if (m) materials[m.id] = Object.fromEntries((['basecolor', 'normal', 'roughness', 'metallic', 'height'] as const).flatMap((k) => { const u = mapUrl(m, k); return u ? [[k, u]] : []; }));
      const d = l.decal && (s.decals.find((x) => x.id === l.decal!.asset) ?? decalShelf.find((x) => x.id === l.decal!.asset));
      if (d && !d.shape) decals[d.id] = decalUrl(d); // a shape has no file: the engine draws it from the layer
    }
  }
  const blobs: [string, Uint8Array][] = [];
  let fbx: string | undefined;
  if (s.exportFbx) {
    const ps = exportParts();
    if (!ps) return;
    const slots: [Channel, FbxSlot][] = [['color', 'DiffuseColor'], ['metal', 'ReflectionFactor'], ['rough', 'ShininessExponent'], ['normal', 'NormalMap']];
    for (const { i, part } of ps) {
      const ts = setIfAny(s.parts[i].soup);
      part.material = part.name; // one texture set per part, even with one atlas
      if (ts) part.maps = Object.fromEntries(slots.filter(([ch]) => ch === 'color' || ts.channels.includes(ch)).map(([ch, slot]) => [slot, `${base}-${part.name}-${CHANNELS[ch].file}.png`]));
    }
    fbx = `${base}.fbx`;
    blobs.push(['fbx', toFbx(ps.map((x) => x.part), s.params.sharp, s.unit)]);
  }
  const req = { project, size: s.exportSize, preset, base, parts: scopeIndices(s.exportScope), padding: s.exportPadding || undefined, materials, decals, fbx };
  // the engine reports what it is on: show it while the render runs
  const poll = window.setInterval(() => { void textureApi.status().then((t) => { if (t && get().busy) set({ busy: t }); }).catch(() => undefined); }, 700);
  try {
    const done = await textureApi.export(encodePack(JSON.stringify(req), blobs));
    if (done) set({ notice: `Exported ${done.files.length} files at ${s.exportSize}px to ${done.dir}` });
  } finally { window.clearInterval(poll); }
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
    return { activePart: active, csel: shift || ctrl ? s.csel : null, layerSel, layerAnchor };
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
  set({ csel: own.size ? flushed(part, out.positions, kind, own) : null, activePart: part });
}
/** Select by faces, whatever the mode (in vertex mode their corners, in edge mode their edges). */
function selectFaces(part: number, faces: number[], op: SelOp, polygons = true) {
  const out = get().result?.parts[part];
  if (!out) return;
  const kind = kindOf(get().selectMode);
  selectElems(part, kind === 'faces' ? faces : flushed(part, out.positions, 'faces', faces)[kind], op, polygons);
}
export function showWorkspace(workspace: Workspace, unwrap = true) {
  // Poly Doc has no islands (it doesn't unwrap) and no UV view: island select mode becomes face, framing keys target 3D
  if (workspace === 'doc') { if (get().selectMode === 'island') setSelectMode('face'); pointer.view = '3d'; }
  // the plane gizmo belongs to UV Magician's 3D view: leaving the workspace puts a moved plane back
  if (get().symEdit) cancelSymPlane();
  set(workspace === 'uv' ? { workspace } : { workspace, unfold: 0 });
  try { localStorage.setItem('workspace', workspace); } catch { /* private mode */ }
  if (unwrap && workspace !== 'doc') void unwrapStale(); // Van Gogh paints through the UVs
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
export const setPaint = (p: Partial<State['paint']>) => set((s) => {
  const paint = { ...s.paint, ...p };
  // the stack held on the Eyedropper belongs to it: switching tool (or to Color) lets it go
  if (paint.grab && (paint.tool !== 'picker' || paint.pickMode !== 'material')) paint.grab = null;
  // and a polyline half drawn belongs to Draw
  if (drawn && (paint.tool !== 'decal' || paint.decalMode !== 'draw')) { drawn = null; return { paint, drawLine: null }; }
  return { paint };
});
export const setPaintTab = (paintTab: State['paintTab']) => set({ paintTab });
export const setAssetTab = (assetTab: State['assetTab']) => set({ assetTab, paintTab: 'assets' });
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
/** Each triangle's neighbours across its edges (corners welded by position), per output part. */
const nbrCache = new WeakMap<ArrayLike<number>, Int32Array[]>();
function neighbours(pos: ArrayLike<number>) {
  let nb = nbrCache.get(pos);
  if (nb) return nb;
  const ids = new Map<string, number>(), v = (k: number) => { const key = `${pos[k].toFixed(4)},${pos[k + 1].toFixed(4)},${pos[k + 2].toFixed(4)}`; let id = ids.get(key); if (id == null) ids.set(key, (id = ids.size)); return id; };
  const tris = pos.length / 9, edges = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) {
    const c = [v(t * 9), v(t * 9 + 3), v(t * 9 + 6)];
    for (let e = 0; e < 3; e++) { const a = c[e], b = c[(e + 1) % 3], k = a < b ? `${a}_${b}` : `${b}_${a}`; (edges.get(k) ?? edges.set(k, []).get(k)!).push(t); }
  }
  const lists: number[][] = Array.from({ length: tris }, () => []);
  for (const ts of edges.values()) for (const a of ts) for (const b of ts) if (a !== b) lists[a].push(b);
  nb = lists.map((l) => Int32Array.from(l));
  nbrCache.set(pos, nb);
  return nb;
}
const triNormal = (p: ArrayLike<number>, t: number) => {
  const o = t * 9, ax = p[o + 3] - p[o], ay = p[o + 4] - p[o + 1], az = p[o + 5] - p[o + 2], bx = p[o + 6] - p[o], by = p[o + 7] - p[o + 1], bz = p[o + 8] - p[o + 2];
  const x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx, l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
/** Surface pick: the triangles reached from `tri` without crossing an edge bent more than `angle`° and without turning
 *  more than twice that from the clicked face (a panel, a flank; 90° takes a whole bore): the region a hard-surface
 *  artist means by "this face" when it isn't one polygon or one UV island. The second limit stops a chain of small
 *  bevel steps from walking round the whole part. */
export function surfaceTris(pos: ArrayLike<number>, tri: number, angle: number) {
  const nb = neighbours(pos), cos = Math.cos((angle * Math.PI) / 180), seen = new Uint8Array(nb.length), out = [tri], ns = new Map<number, number[]>();
  const n = (t: number) => ns.get(t) ?? ns.set(t, triNormal(pos, t)).get(t)!;
  const n0 = n(tri), far = Math.cos((Math.min(180, angle * 2) * Math.PI) / 180) - 1e-6;
  seen[tri] = 1;
  for (let k = 0; k < out.length; k++) {
    const t = out[k], a = n(t);
    for (const u of nb[t]) {
      if (seen[u]) continue;
      const b = n(u);
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < cos || n0[0] * b[0] + n0[1] * b[1] + n0[2] * b[2] < far) continue;
      seen[u] = 1; out.push(u);
    }
  }
  return out;
}
/** The triangles the Wand or Bucket takes from a click on triangle `tri` of part `i`: its polygon, its island, or the part. */
function trisBy(i: number, tri: number) {
  const out = get().result!.parts[i], by = get().paint.by;
  if (by === 'part') return out.island.map((_, t) => t);
  if (by === 'island') return out.island.flatMap((x, t) => (x === out.island[tri] ? [t] : []));
  if (by === 'surface') return surfaceTris(out.positions, tri, get().paint.angle);
  const pid = polygonsOf(out.source, get().parts[i].poly);
  return pid[tri] < 0 ? [tri] : Array.from(pid).flatMap((p, t) => (p === pid[tri] ? [t] : []));
}
let hoverKey = '';
// another tool (or workspace), or letting go of the held material, leaves no hover target
useApp.subscribe((s, p) => {
  if (s.paintHover && (s.paint.tool !== p.paint.tool || s.workspace !== p.workspace || (!s.paint.grab && !!p.paint.grab))) paintHoverAt(-1);
});
/** The pointer is over triangle `tri` of part `i` (off the model: no tri): the face, island or part (options bar's
 *  Face / Island / Part) a Bucket / Wand click or a dropped material would take, kept in `paintHover` for the outline. */
export function paintHoverAt(i: number, tri = -1) {
  const out = get().result?.parts[i];
  if (!out || tri < 0 || !get().uvs[i]) { if (hoverKey) { hoverKey = ''; set({ paintHover: null }); } return; }
  const by = get().paint.by, pid = by === 'face' ? polygonsOf(out.source, get().parts[i].poly)[tri] : 0;
  const surf = by === 'surface' ? surfaceTris(out.positions, tri, get().paint.angle) : null;
  const key = by === 'part' ? `${i}` : by === 'island' ? `${i}:i${out.island[tri]}` : surf ? `${i}:s${surf.reduce((m, t) => Math.min(m, t), Infinity)}:${surf.length}` : pid < 0 ? `${i}:t${tri}` : `${i}:p${pid}`;
  if (key === hoverKey) return;
  hoverKey = key;
  set({ paintHover: { part: i, tris: surf ?? trisBy(i, tri) } });
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
/** Select › Grow / Shrink: every part's selection widened or narrowed by `by` texels (Photoshop's Expand / Contract). */
export function growPaintSelection(by: number) {
  const ids = visibleParts().filter((i) => texSet(i).sel);
  if (!ids.length) return;
  const ts = ids.map(texSet);
  painted.push(ts);
  paintRedo.length = 0;
  ids.forEach((i, k) => growSelection(ts[k], Math.round(by * ts[k].size / 1024) || Math.sign(by), get().uvs[i]));
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
  // in a shared atlas every part drawn in that square is under the shape, not just the first
  const at = uvTiles().at, o = at[i], uvs = get().uvs;
  const same = o ? at.flatMap((q, j) => (q && q[0] === o[0] && q[1] === o[1] && uvs[j] ? [j] : [])) : [i];
  selectDoc(new Map(same.map((j) => [j, maskPolygon(texSet(j), poly)])), opOfMods(mods));
}
/** Ctrl+click: part `i` becomes the one the panels show, opened in the Parts tree. */
export function pickPaintPart(i: number) {
  set((s) => ({ activePart: i, paintOpen: s.paintOpen.includes(i) ? s.paintOpen : [...s.paintOpen, i] }));
}
export const togglePaintOpen = (i: number) => set((s) => ({ paintOpen: s.paintOpen.includes(i) ? s.paintOpen.filter((x) => x !== i) : [...s.paintOpen, i] }));
/** The layers that make up a part's materials: fills (a material or a solid), generators and bevels. A decal is a
 *  placed mark, and hand paint lives in its own part's UVs, so neither would mean the same thing on another part. */
const isMaterialLayer = (l: PaintLayer) => !l.decal && !!(l.fill || l.gen || l.bevel);
/** Eyedropper › Materials: lift part `from`'s material layers onto the cursor (settings only: their pixels are baked
 *  again on each target). A click on a part, an island or a face then applies them; Esc drops them. */
export function grabMaterials(from: number) {
  const st = get();
  if (st.busy || !st.parts[from] || !st.result?.parts[from] || !st.uvs[from]) return;
  const layers = texSet(from).layers.filter(isMaterialLayer);
  if (!layers.length) {
    set({ notice: `${st.parts[from].name} has no materials to pick up (a fill, a solid, a generator or a bevel).` });
    return;
  }
  const grabbed: GrabbedLayer[] = layers.map((l) => ({
    name: l.name, visible: l.visible, opacity: l.opacity,
    ...(l.blend ? { blend: { ...l.blend } } : {}),
    ...(l.fill ? { fill: { ...l.fill, channels: [...l.fill.channels], offset: [...l.fill.offset] as [number, number] } } : {}),
    ...(l.gen ? { gen: { ...l.gen, clip: null } } : {}),
    ...(l.bevel ? { bevel: { ...l.bevel } } : {}),
  }));
  const topLayer = [...layers].reverse().find((l) => l.fill), top = topLayer?.fill;
  const asset = top && top.asset !== SOLID ? materialOf(top.asset) : null;
  const grab: MaterialGrab = {
    from, fromName: st.parts[from].name, name: asset?.name ?? topLayer?.name ?? layers[layers.length - 1].name,
    layers: grabbed, thumb: asset ? thumbUrl(asset) || null : null, tint: top?.tint ?? null, count: grabbed.length,
  };
  setPaint({ grab });
  // the shelf may not have been opened yet: read its manifest so the cursor chip shows the material, not a checker
  if (top && top.asset !== SOLID && !asset) {
    void loadMaterialLibrary().then((shelf) => {
      const a = shelf.find((m) => m.id === top.asset), held = get().paint.grab;
      if (a && held && held.from === from && held.layers.some((l) => l.fill?.asset === top.asset)) setPaint({ grab: { ...held, thumb: thumbUrl(a) || null, name: a.name } });
    }).catch(() => { /* the chip keeps its checker; applying loads the maps itself */ });
  }
  set({ notice: `Picked up ${grab.count} material layer${grab.count === 1 ? '' : 's'} from ${grab.fromName} — click a part, island or face to apply, Esc drops.` });
}

/** Let the materials held on the Eyedropper go (Esc). */
export const dropMaterials = () => { if (get().paint.grab) setPaint({ grab: null }); };

/** Put the held material stack on part `i` at triangle `tri`: Whole Part replaces the part's material layers (its
 *  decals and hand paint stay), a face / island / surface adds them masked to that region. The stack is kept for the
 *  next target; Esc drops it. One undo step each. */
export function applyGrab(i: number, tri: number): Promise<void> {
  const st = get(), res = st.result, grab = st.paint.grab, out = res?.parts[i], uv = st.uvs[i];
  if (st.busy || !grab || !st.parts[i] || !res || !out || !uv) return Promise.resolve();
  const whole = st.paint.by === 'part';
  if (!whole && tri < 0) {
    set({ notice: 'Click a face on the model (or in the UV view) to apply there, or switch the target to Part.' });
    return Promise.resolve();
  }
  if (whole && i === grab.from) {
    set({ notice: 'That is where those materials came from — click another part, an island or a face.' });
    return Promise.resolve();
  }
  const tris = whole ? null : trisBy(i, tri);
  const targetName = st.parts[i].name;
  pickPaintPart(i);
  const job = () => task(`Applying materials to ${targetName}…`, async () => {
    // a fill's maps load before anything changes; a missing one still applies, in its tint on white
    const ids = [...new Set(grab.layers.flatMap((l) => (l.fill && l.fill.asset !== SOLID ? [l.fill.asset] : [])))];
    const maps = new Map<string, MaterialPixels>();
    if (ids.length) {
      // the shelf is read on demand (a project's fills can be applied before the Materials tab was ever opened)
      const loaded = get().materials, known = new Set(loaded.map((m) => m.id));
      const shelf = ids.every((id) => known.has(id)) ? loaded : [...loaded, ...(await loadMaterialLibrary())];
      for (const id of ids) {
        const a = shelf.find((m) => m.id === id);
        if (!a) continue;
        try { maps.set(id, await materialPixels(a)); } catch { /* the fill still applies, in its tint on white */ }
      }
    }
    const now = get();
    // the model was re-opened or re-unwrapped while the maps loaded: these layers no longer describe this part
    if (now.result !== res) return;
    const target = now.result.parts[i], tuv = now.uvs[i];
    if (!target || !tuv) return;
    const ts = texSet(i), span = modelSize(now.result), mask = tris ? maskTris(ts, target.positions, tuv, tris) : undefined;
    step(ts);
    const wanted = new Set<Channel>(ts.channels);
    for (const l of grab.layers) {
      if (l.fill) for (const ch of l.fill.channels) wanted.add(ch);
      if (l.bevel) wanted.add('normal');
      if (l.gen) { wanted.add('color'); wanted.add('rough'); wanted.add('metal'); }
    }
    ts.channels = FILL_CHANNELS.filter((ch) => wanted.has(ch));
    const copies = grab.layers.map((src) => {
      const layer: PaintLayer = {
        ...newLayer(0), name: src.name, visible: src.visible, opacity: src.opacity,
        ...(src.blend ? { blend: { ...src.blend } } : {}),
        ...(src.fill ? { fill: { ...src.fill, channels: [...src.fill.channels], offset: [...src.fill.offset] as [number, number] } } : {}),
        // a generator's clip is its mask (the composite applies the layer's mask as well: one of them, not both)
        ...(src.gen ? { gen: { ...src.gen, clip: mask ?? null } } : {}),
        ...(src.bevel ? { bevel: { ...src.bevel } } : {}),
        ...(mask && !src.gen ? { mask } : {}),
      };
      if (layer.fill) bakeFill(ts, layer, maps.get(layer.fill.asset) ?? {}, target.positions, tuv, span);
      else if (layer.gen) generate(ts, layer);
      else if (layer.bevel) bakeBevel(ts, layer, target.positions, tuv);
      return layer;
    });
    if (whole) {
      // the part keeps its own paint and decals; only its material layers are replaced
      ts.layers = ts.layers.filter((l) => !isMaterialLayer(l));
      ts.layers.unshift(...copies);
      ts.active = copies.length - 1;
    } else {
      // above the part's material stack, under the paint and decals that were made over it
      const at = ts.layers.reduce((a, l, k) => (isMaterialLayer(l) ? k + 1 : a), 0);
      ts.layers.splice(at, 0, ...copies);
      ts.active = at + copies.length - 1;
    }
    composite(ts);
    set((s) => ({ paintChannel: 'material', paint: s.paint.decalSel ? { ...s.paint, decalSel: false } : s.paint }));
    repaint();
    set({ notice: `Applied ${grab.count} material layer${grab.count === 1 ? '' : 's'} from ${grab.fromName} to ${whole ? targetName : `${targetName} (${st.paint.by})`}.` });
  });
  // a generator needs the target's own baked maps: bake first, then apply (two tasks, so neither hides the other's line)
  const raw = grab.layers.some((l) => l.gen) && !texSet(i).bake ? [i] : [];
  return raw.length ? bakePaint(raw).then(job) : job();
}
let last: { part: number; at: number[]; uv: boolean; fill: boolean; decal: boolean; draw?: boolean; moved?: boolean; pressure: number; gpu: boolean; mates?: number[] } | null = null;
/** The other parts drawn in part `i`'s square of the texture view (a shared atlas): a stroke there paints them too. */
const atlasMates = (i: number) => {
  const at = uvTiles().at, o = at[i], uvs = get().uvs;
  return o ? at.flatMap((q, j) => (j !== i && q && q[0] === o[0] && q[1] === o[1] && uvs[j] ? [j] : [])) : [];
};
/** What the GPU preview stamps: an eraser shows as the unpainted base colour (its replay still erases: `erase` stays). */
const gpuBrush = (b: Brush): Brush => (b.erase ? { ...b, values: { ...b.values, color: CHANNELS.color.base } } : b);
/** One texture-view dab on part `j`'s set: its active layer, or that layer's mask when it is a fill or decal. */
function uvDab(j: number, u: number, v: number, pressure: number, b: Brush) {
  const s = texSet(j), l = s.layers[s.active], n = s.size, r = uvRadius(s, pressure);
  // only a part with islands under the dab: dabbing every set in the atlas (and redrawing each) was the lag
  if (s.shell) {
    const cx = u * n, cy = v * n, st = Math.max(1, r / 3);
    let hit = false;
    for (let y = Math.max(0, cy - r); y <= Math.min(n - 1, cy + r) && !hit; y += st)
      for (let x = Math.max(0, cx - r); x <= Math.min(n - 1, cx + r) && !hit; x += st)
        hit = (x - cx) ** 2 + (y - cy) ** 2 <= r * r && s.shell[(y | 0) * n + (x | 0)] > 0;
    if (!hit) return;
  }
  if (l?.fill || l?.decal) maskDabUV(s, l, u, v, r, b);
  else dabUV(s, u, v, r, b);
}
/** A GPU stroke is replaying into the CPU; a new stroke waits for it instead of fighting the same layers. */
let committing = false, undoQueued = false, redoQueued = false;
/** A press on part `i`, triangle `tri`, at world point `at` (on the model) or null (in the texture view), UV (u, v):
 *  every tool's click, on either view. True when a drag should follow (Brush, Eraser). */
export function paintPress(i: number, tri: number, at: [number, number, number] | null, uv: [number, number], mods: PaintMods) {
  const { result, uvs, paint } = get(), out = result?.parts[i];
  if (!out || !uvs[i] || get().busy) return false;
  if (committing) return false;
  if (mods.ctrl) { pickPaintPart(i); return false; }
  // The Eyedropper: Material copies the clicked part's material layers (fills, solids, generators, bevels — not decals,
  // not hand paint) onto the part the panels show; Color takes the surface's colour, roughness and metallic.
  if (paint.tool === 'picker') {
    if (paint.pickMode === 'material') {
      // first click lifts the part's materials onto the cursor, the next applies them where you click
      if (paint.grab) void applyGrab(i, tri); else grabMaterials(i);
      return false;
    }
    if (get().activePart !== i) pickPaintPart(i);
    const ts = texSet(i), v = sample(ts, uv[0], uv[1]);
    setPaint(ts.channels.length > 1 ? v : { color: v.color });
    return false;
  }
  if (paint.tool === 'mirror') { if (at) mirrorPress(i, tri, at.slice() as [number, number, number]); return false; }
  // the part being worked on is the one the panels show (its layers); the texture view's Part / All stays as it is
  if (get().activePart !== i) pickPaintPart(i);
  const s = texSet(i);
  if (paint.tool === 'decal') {
    if (!at) return false;
    // Edit (the default): a click picks the mark under it and a drag slides it; a click on bare surface clears the
    // pick, so the frame and the Decal actions go and the next Delete clears paint rather than removing the layer.
    // Place: one click puts the armed mark there (Alt too).
    if (paint.decalMode === 'draw' && !mods.alt) {
      if (!drawArmed()) { set({ error: 'Pick a line, pad or grip panel (Assets › Geometry) to draw.' }); return false; }
      drawPress(i, tri, at.slice() as [number, number, number]);
      last = { part: i, at: at.slice(), uv: false, fill: false, decal: true, draw: true, pressure: 1, gpu: false };
      return true;
    }
    if (paint.decalMode !== 'place' && !mods.alt) {
      const j = decalUnder(i, at, tri);
      if (j < 0) { deselectDecal(); return false; }
      if (j !== s.active || !paint.decalSel) selectDecal(i, j); else repaintPanel();
      beginPaintEdit();
      last = { part: i, at: at.slice(), uv: false, fill: false, decal: true, pressure: 1, gpu: false };
      return true;
    }
    if (!placeDecal(i, tri, at)) return false;
    last = { part: i, at: at.slice(), uv: false, fill: false, decal: true, pressure: 1, gpu: false };
    return true;
  }
  // Alt+click with a painting tool (Photoshop's): take the colour (and roughness, metallic) under it
  if (mods.alt && (paint.tool === 'brush' || paint.tool === 'bucket')) {
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
  // in a shared atlas the texture view's stroke crosses every part's islands: all their sets, one undo step
  const mates = at ? [] : atlasMates(i);
  paintEditing = true;
  step(s, ...mates.map(texSet));
  const layer = s.layers[s.active], pen = pressureOf(mods), b = brushOf(result!, pen);
  const above = s.layers.slice(s.active + 1).some((l) => l.visible && l.opacity > 0);
  // The GPU preview takes a plain brush (a selection too: the shader reads it), and an eraser on the bottom colour
  // layer, where erasing is exactly painting back toward the unpainted base; anything else stays on the CPU.
  const erase = paint.tool === 'erase';
  const bottom = !s.layers.slice(0, s.active).some((l) => l.visible && l.opacity > 0 && (l.px.color || l.fill || l.decal || l.gen));
  const simple = (paint.tool === 'brush' || (erase && bottom)) && !mates.length && !above && layer && !layer.fill && !layer.decal && !layer.gen && !layer.mask && !layer.blend?.color && !!b.values.color && Object.keys(b.values).every((k) => k === 'color' || k === 'rough' || k === 'metal');
  if (simple && gpuBegin(s, i, at ? 'world' : 'uv', uv, b, erase ? 1 : layer.opacity, out.positions, uvs[i])) {
    last = { part: i, at: at ?? uv, uv: !at, fill: false, decal: false, pressure: pen, gpu: true };
    gpuDab(at, uv, gpuBrush(b), at ? 0 : uvRadius(s, pen) / s.size);
    repaintLive();
    return true;
  }
  const masked = !!(layer?.fill || layer?.decal);
  last = { part: i, at: at ?? uv, uv: !at, fill: masked, decal: false, pressure: pen, gpu: false, mates };
  for (const j of mates) uvDab(j, uv[0], uv[1], pen, b);
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
export function paintDrag(i: number, at: [number, number, number] | null, uv: [number, number], pressure?: number, tri?: number, snap = false) {
  const { result, uvs } = get(), out = result?.parts[i];
  if (!out || !uvs[i] || !last || last.part !== i || last.uv === !!at) return;
  if (pressure != null) last.pressure = Math.max(0.08, Math.min(1, pressure));
  const b = brushOf(result!, last.pressure), s = texSet(i), from = last.at, to = at ?? uv;
  if (last.decal && last.draw) {
    if (at && tri != null && drawn) drawTo(at as [number, number, number], tri);
    return;
  }
  if (last.decal) {
    if (at && to.some((x, k) => x !== from[k])) { dragDecal(at, tri, snap, false); last.moved = true; }
    last.at = to;
    repaintLive();
    return;
  }
  const r = at ? b.radius : uvRadius(s, last.pressure) / s.size;
  const steps = Math.max(1, Math.ceil(Math.hypot(...to.map((x, k) => x - from[k])) / (r / 4)));
  if (last.gpu) {
    for (let k = 1; k <= steps; k++) {
      const p = to.map((x, c) => from[c] + ((x - from[c]) * k) / steps);
      gpuDab(at ? p : null, uv, gpuBrush(b), at ? 0 : uvRadius(s, last.pressure) / s.size);
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
    for (const j of last.mates ?? []) uvDab(j, p[0], p[1], last.pressure, b);
  }
  last.at = to;
  repaintLive();
}
// ponytail: the texture view and panel catch up when the stroke ends, not per dab (a 1K redraw per mouse move)
export const paintEnd = () => {
  paintEditing = false;
  if (!last) return;
  if (last.draw) { last = null; return; }
  if (last.decal) { const moved = last.moved; last = null; if (moved) finishDecalEdit(); repaint(); return; }
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
  for (const j of [last.part, ...(last.mates ?? [])]) {
    const s = texSet(j), d = s.dirty;
    if (d) setUndoRect(s, d);
    bleedAll(s);
  }
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
/** A new document (or a resolution change) makes the old steps meaningless: their sets are another model's. Its
 *  texture sets go too: their WebGL textures stay allocated until disposed, and a session that opens several projects
 *  would otherwise lose the context to them (the model then does not draw). */
export function resetPaintHistory() {
  gpuFinish();
  for (const p of get().parts) { const s = setIfAny(p.soup); if (s) disposeSet(s); }
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
  const at = insertAt(s);
  s.layers.splice(at, 0, { ...newLayer(0), name: 'Metal sheen' });
  s.active = at;
  fillAll(s, { radius: 0, flow: 1, hardness: 1, erase: false, values: { rough: [0.25 * 255], metal: [255] } });
});
export const addPaintLayer = () => layers((s) => { s.layers.splice(s.active + 1, 0, newLayer(s.layers.length + 1)); s.active++; });
export const deletePaintLayer = () => layers((s) => {
  if (s.layers.length <= 1) return;
  const mark = !!s.layers[s.active]?.decal;
  s.layers.splice(s.active, 1);
  s.active = Math.min(s.active, s.layers.length - 1);
  // a mark goes off the model with its layer: the layer below is active in the panel, not picked as a mark
  if (mark) set((st) => ({ paint: { ...st.paint, decalSel: false } }));
});
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
  // a copy of a mark is picked like a placed one, so its gizmo is there to drag (not a mark with no handles)
  if (l.decal) set((st) => ({ paint: { ...st.paint, decalSel: true } }));
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
export function editPaintLayer(j: number, l: Partial<Pick<PaintLayer, 'name' | 'visible' | 'opacity' | 'blend'>>, undoable = true) {
  if (!get().parts[get().activePart]) return;
  const s = texSet(get().activePart), was = s.layers[j];
  if (!was) return;
  // a rename stays on this set; opacity and visibility follow All sets (layer objects are replaced, not their buffers,
  // so the step need not copy them and the active layer stays as it is)
  const mates = l.name ? [] : matesOf(was);
  if (undoable) step(s, ...mates); else ensureStep(s, ...mates);
  s.layers[j] = { ...s.layers[j], ...l };
  for (const t of mates) t.layers[t.active] = { ...t.layers[t.active], ...l };
  for (const t of [s, ...mates]) scheduleComposite(t);
  repaintPanel();
}
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
let paintEditing = false, editWatch = false;
/** A slider or a drag is writing a set's pixels in place right now. */
export const paintEditingNow = () => paintEditing;
export const beginPaintEdit = () => {
  sliderStep = get().parts[get().activePart] ? texSet(get().activePart) : null;
  paintEditing = true;
  if (editWatch || typeof window === 'undefined') return;
  editWatch = true;
  const off = () => {
    paintEditing = false;
    editWatch = false;
    window.removeEventListener('pointerup', off);
    window.removeEventListener('pointercancel', off);
    window.removeEventListener('blur', off);
  };
  window.addEventListener('pointerup', off);
  window.addEventListener('pointercancel', off);
  window.addEventListener('blur', off);
};
/** The first edit of a drag: take the step the pointerdown deferred. */
function ensureStep(...ts: TexSet[]) { if (sliderStep === ts[0]) { sliderStep = null; step(...ts); } }
export const setLinkSets = (linkSets: boolean) => set({ linkSets });
/** View › Reference image…: a picture to paint against, shown over the 3D view; null closes it. */
export function setRefImage(refImage: State['refImage']) {
  const old = get().refImage;
  if (old && old.url !== refImage?.url) URL.revokeObjectURL(old.url);
  set({ refImage });
}
export function pickRefImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => { const f = input.files?.[0]; if (f) setRefImage({ url: URL.createObjectURL(f), opacity: get().refImage?.opacity ?? 0.85 }); };
  input.click();
}
/** Save the project to `path` without the dialog (scripts and agents; the editor's Save as… shows the dialog). */
export const saveProjectTo = (path: string) => { set({ project: path }); return writeProject('save'); };
/** The parts an add or edit goes to: the active one, and with All sets on every other visible part too. */
const targetParts = () => { const a = get().activePart; return [a, ...(get().linkSets ? visibleParts().filter((j) => j !== a) : [])].filter((i) => get().parts[i]); };
/** With All sets on, the other visible parts' layer of the same name and kind as `l` (Edge Wear on every part), each
 *  made its set's active layer so the undo step copies it. */
function matesOf(l: PaintLayer): TexSet[] {
  if (!get().linkSets) return [];
  return visibleParts().filter((j) => j !== get().activePart).flatMap((j) => {
    const t = texSet(j), k = t.layers.findIndex((x) => x !== l && x.name === l.name && !x.fill === !l.fill && !x.gen === !l.gen && !x.decal === !l.decal && !x.bevel === !l.bevel);
    if (k < 0) return [];
    t.active = k;
    return [t];
  });
}
/** Where a new fill, solid, decal or sheen goes: above the active layer, but under the generators stacked over it,
 *  so Edge Wear and Dirt stay on top of what is added later (as Substance stacks them). */
function insertAt(s: TexSet) { let a = s.active; while (a >= 0 && s.layers[a]?.gen) a--; return a + 1; }
/** A click in the Layers panel: the layer becomes the active one, and picking a mark also picks it on the model, so a
 *  mark found in the stack gets its frame back after a click on bare surface cleared it. */
export const pickPaintLayer = (j: number) => {
  const s = texSet(get().activePart);
  s.active = j;
  if (s.layers[j]?.decal && !get().paint.decalSel) set((st) => ({ paint: { ...st.paint, decalSel: true } }));
  repaint();
};
/** Part `i` gets Roughness, Metallic, Normal and Height channels (PBR, glTF's metal/rough plus a normal map),
 *  or loses them. */
export function setPbr(i: number, on: boolean) {
  set({ activePart: i });
  layers((s) => { s.channels = on ? [...FILL_CHANNELS] : ['color']; });
  if (!on && (get().paintChannel === 'rough' || get().paintChannel === 'metal' || get().paintChannel === 'normal' || get().paintChannel === 'height')) set({ paintChannel: 'material' });
}
/** Show part `i`'s channel `ch` in the UV view. */
export const pickPaintChannel = (i: number, ch: Shown) => set({ activePart: i, paintChannel: ch });

// ---- the material shelf ----
/** The library itself was read (an opened project may have put its own imported materials on the shelf first). */
let libraryLoaded = false;
/** Read public/materials/index.json once. Imported folders are already in `materials`. */
export function loadMaterials() {
  if (libraryLoaded || get().materialsLoading) return;
  libraryLoaded = true;
  set({ materialsLoading: true, materialsError: null });
  loadMaterialLibrary()
    .then((materials) => set((s) => ({ materials: [...s.materials, ...materials.filter((m) => !s.materials.some((x) => x.id === m.id))], materialsLoading: false })))
    .catch((e) => { libraryLoaded = false; set({ materialsLoading: false, materialsError: e instanceof Error ? e.message : String(e) }); });
}
const materialOf = (id: string) => get().materials.find((m) => m.id === id) ?? null;
function addImported(m: MaterialAsset) { set((s) => ({ materials: [m, ...s.materials.filter((x) => x.id !== m.id)] })); }
export const importMaterialFiles = (name: string, files: File[]) => task('Importing a material…', async () => {
  const m = await materialFromFiles(name, files);
  if (!m) throw new Error('No base color map was found in that folder.');
  addImported(m);
});

// ---- the decal shelf ----
let decalsLoaded = false;
/** Read public/decals/index.json once; imported marks already live in `decals`. */
export function loadDecals() {
  if (decalsLoaded || get().decalsLoading) return;
  decalsLoaded = true;
  set({ decalsLoading: true, decalsError: null });
  loadDecalLibrary()
    .then((decals) => set((s) => ({
      decals: [...s.decals, ...decals.filter((d) => !s.decals.some((x) => x.id === d.id))], decalsLoading: false,
      paint: !s.paint.decalAsset && decals.length ? { ...s.paint, decalAsset: (decals.find((d) => !d.shape) ?? decals[0]).id } : s.paint,
    })))
    .catch((e) => { decalsLoaded = false; set({ decalsLoading: false, decalsError: e instanceof Error ? e.message : String(e) }); });
}
const decalOf = (id: string) => get().decals.find((d) => d.id === id) ?? null;
/** Arm a mark for placement: its ink becomes the starting tint, the Decal tool is selected and the next click on the
 *  model places one (after that the tool is back in edit mode, where a click selects a mark). */
export function pickDecal(id: string) {
  const a = decalOf(id);
  if (!a) return;
  cancelDraw(); // a half-drawn polyline belongs to the asset it was started with
  set((s) => ({
    paint: { ...s.paint, tool: 'decal', decalMode: a.shape && isLine(a.shape.pattern) ? 'draw' : 'place', decalAsset: id, decalTint: s.paint.color, ...(a.size ? { decalSize: a.size } : {}) },
    paintTab: 'assets', assetTab: a.shape ? 'geometry' : 'decals', error: null,
  }));
}
export const importDecal = (file: File) => task('Importing a decal…', async () => {
  const a = await decalFromFile(file);
  set((s) => ({
    decals: [a, ...s.decals.filter((x) => x.id !== a.id)],
    paint: { ...s.paint, tool: 'decal', decalAsset: a.id, decalTint: s.paint.color },
    paintTab: 'assets', assetTab: 'decals', error: null,
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
/** Is `at` (a point on the surface) on the mark itself? A mark is its footprint, not the ink: a sparse stencil or a
 *  groove-only grip panel is as easy to click as a solid one, and a shape is its outline (which may reach past the
 *  projector's rectangle). Only the projector's depth limits it, so the whole mark can be grabbed from any face it was
 *  wrapped over — a curved grip puts the panel's flanks tens of units behind the tangent plane, where a strict
 *  "inside the rectangle" test used to make most of the mark unclickable. */
function insideDecal(d: Decal, at: [number, number, number], span: number) {
  const f = decalFrame(d, span), dx = at[0] - f.cx, dy = at[1] - f.cy, dz = at[2] - f.cz;
  const along = dx * f.nx + dy * f.ny + dz * f.nz;
  if (Math.abs(along) > f.depth) return false;
  const hw = f.width / 2, hh = f.height / 2;
  // the bake flips the pattern, so the outline the mark was shaped with is flipped in its own frame too
  const a = (dx * f.uxr + dy * f.uyr + dz * f.uzr) * (d.flipH ? -1 : 1);
  const b = (dx * f.vxr + dy * f.vyr + dz * f.vzr) * (d.flipV ? -1 : 1);
  const sh = d.shape;
  // no outline: the projector's rectangle is the mark (a little past its edge, so the frame itself can be grabbed)
  if (!sh?.outline) return Math.abs(a) <= hw * 1.06 && Math.abs(b) <= hh * 1.06;
  const m = Math.max(sh.cell, Math.min(hw, hh) * 0.03);
  // a free outline: the outline itself says where the mark is, even where it reaches past the projector's rectangle
  return shapeHeight(sh, a, b, hw, hh) !== null
    || shapeHeight(sh, a + m, b, hw, hh) !== null || shapeHeight(sh, a - m, b, hw, hh) !== null
    || shapeHeight(sh, a, b + m, hw, hh) !== null || shapeHeight(sh, a, b - m, hw, hh) !== null;
}
/** The decal layer of part `i` under a point on its surface, topmost first, or -1. A click picks the mark itself, not
 *  the texels it inks, so a sparse stencil is as easy to grab as a solid one; a triangle facing away from the mark's
 *  projector is not where its ink is (the mark on the far side of a slide is not the one being clicked). */
export function decalUnder(i: number, at: [number, number, number], tri?: number): number {
  const st = get(), s = st.parts[i] ? setIfAny(st.parts[i].soup) : null, out = st.result?.parts[i];
  if (!s || !out) return -1;
  const span = modelSize(st.result!), n = tri != null && tri >= 0 ? faceNormal(out, tri) : null;
  for (let j = s.layers.length - 1; j >= 0; j--) {
    const d = s.layers[j].decal;
    if (!d) continue;
    // only a face turned clearly away is not where this mark's ink is; a mark dragged over a curved panel is still
    // picked on the flanks the projector's facing no longer matches
    if (n && n[0] * d.normal[0] + n[1] * d.normal[1] + n[2] * d.normal[2] < -0.05) continue;
    if (insideDecal(d, at, span)) return j;
  }
  return -1;
}
/** Select the mark on part `i` whose layer is `j` (a click on the model): the part is opened and the gizmo moves there. */
export function selectDecal(i: number, j: number) {
  if (!get().parts[i] || !texSet(i).layers[j]?.decal) return;
  set((s) => ({ activePart: i, paint: { ...s.paint, decalSel: true } }));
  texSet(i).active = j;
  repaintPanel();
}
/** Nothing is picked any more (a click on bare surface or the empty view): the frame, its handles and the Decal
 *  actions go. The layer stays the active one in the Layers panel, so its settings and opacity are still there. */
export function deselectDecal() {
  const st = get(), s = st.parts[st.activePart] ? texSet(st.activePart) : null;
  if (!st.paint.decalSel || !s?.layers[s.active]?.decal) return;
  set({ paint: { ...st.paint, decalSel: false } });
  repaintPanel();
}
/** Bake one decal layer from its current projector. `live` is a drag or slider still in motion: the bake then
 *  recomposites only the box it changed and the full pass waits for the drag to stop. */
function rebakeDecal(i: number, layer: PaintLayer, live = false) {
  const st = get(), out = st.result?.parts[i], uv = st.uvs[i];
  if (!out || !uv) return;
  const span = modelSize(st.result!), s = texSet(i);
  // a shape is its own relief: no image to load
  if (layer.decal?.shape) { bakeShape(s, layer, out.positions, uv, span); composite(s); repaint(); return; }
  const a = layer.decal && decalOf(layer.decal.asset);
  if (!a) return;
  void decalPixels(a).then((px) => {
    const now = get();
    if (!now.result?.parts[i] || now.uvs[i] !== uv || !texSet(i).layers.includes(layer)) return;
    const box = bakeDecal(s, layer, px, out.positions, uv, span);
    if (live && box) {
      composite(s, box[0], box[1], box[2], box[3], undefined, false);
      repaintLive();
      settleDecal(i);
    } else {
      composite(s);
      repaint();
    }
  }).catch((e) => set({ error: e instanceof Error ? e.message : String(e) }));
}
/** After the last live bake of a drag: one full composite, for the mip padding and the panel's readout. */
let decalSettle: ReturnType<typeof setTimeout> | undefined;
function settleDecal(i: number) {
  clearTimeout(decalSettle);
  decalSettle = setTimeout(() => {
    if (!get().parts[i] || !get().result?.parts[i]) return;
    composite(texSet(i));
    repaint();
  }, 160);
}
/** A grip texture's sizes are shares of the model on the shelf, world units on the model. */
const shapeAt = (sh: Shape, span: number): Shape => ({ ...sh, corner: sh.corner * span, border: sh.border * span, depth: sh.depth * span, cell: sh.cell * span, amount: sh.amount * span });
/** Add a decal layer at a hit on part `i`, of the armed mark (`paint.decalAsset`). One click places: the tool is back
 *  in edit mode afterwards, so the next click selects the mark that was just made. */
function placeDecal(i: number, tri: number, at: [number, number, number], made?: Decal) {
  const st = get(), out = st.result?.parts[i], uv = st.uvs[i], a = decalOf(st.paint.decalAsset) ?? st.decals[0];
  if (!out || !uv || !a) {
    if (!st.decals.length) set({ error: 'The decal shelf is still loading; try again in a moment.' });
    return false;
  }
  const s = texSet(i), normal = faceNormal(out, tri), span = modelSize(st.result!);
  const decal: Decal = made ?? {
    asset: a.id, center: [...at] as [number, number, number], normal, up: decalUp(normal),
    width: Math.max(span * st.paint.decalSize / 100, span * 0.01), rotation: st.paint.decalRotation,
    aspect: a.width / a.height, tint: st.paint.decalTint, roughness: 0.55, metallic: 0,
    channels: a.shape ? ['normal', 'height'] : ['color', 'rough', 'metal'],
    ...(a.shape ? { shape: shapeAt(a.shape, span) } : {}),
  };
  step(s);
  if (a.shape && !s.channels.includes('normal')) s.channels = [...FILL_CHANNELS];
  const layer: PaintLayer = { ...newLayer(s.layers.length + 1), name: a.name, decal };
  const at0 = insertAt(s);
  s.layers.splice(at0, 0, layer);
  s.active = at0;
  set((now) => ({ activePart: i, paintChannel: 'material', error: null, paint: { ...now.paint, decalMode: made ? 'draw' : 'edit', decalSel: true } }));
  rebakeDecal(i, layer);
  repaintPanel();
  return true;
}
/** The polyline being drawn (Decal tool, Draw): its points on the surface and their triangles. A click adds a corner,
 *  a drag lays freehand points along the way; `closeR` is how near the first point (world units, ~12 px where it was
 *  pressed) a click closes it. */
let drawn: { part: number; pts: [number, number, number][]; tris: number[]; closeR: number; at: number } | null = null;
/** The armed asset when it can be drawn: a line kind (open or closed) or a panel / pad (its outline, closed). */
const drawArmed = () => { const a = decalOf(get().paint.decalAsset); return a?.shape && a.shape.pattern !== 'fastener' ? a : null; };
const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const showDrawn = () => set({ drawLine: drawn ? drawn.pts.map((p) => [...p] as [number, number, number]) : null });
/** A press in Draw: the first starts a polyline, a press on its first point closes it, a quick second press on its
 *  last point (a double-click) finishes it open, any other adds a corner. */
function drawPress(i: number, tri: number, at: [number, number, number]) {
  const px = view3d.worldDelta?.(12, 0, at), r = px ? Math.hypot(...px) : modelSize(get().result!) * 0.01;
  const now = performance.now();
  if (!drawn || drawn.part !== i) { drawn = { part: i, pts: [at], tris: [tri], closeR: r, at: now }; showDrawn(); return; }
  const d = drawn, n = d.pts.length, quick = now - d.at < 400;
  d.at = now;
  if (n >= 3 && dist3(at, d.pts[0]) < d.closeR) { finishDraw(true); return; }
  if (quick && dist3(at, d.pts[n - 1]) < r * 0.5) { finishDraw(false); return; }
  d.pts.push(at); d.tris.push(tri); d.closeR = r;
  showDrawn();
}
/** A drag in Draw: freehand points every couple of thousandths of the model. */
function drawTo(at: [number, number, number], tri: number) {
  const d = drawn!, r = get().result;
  if (r && dist3(at, d.pts[d.pts.length - 1]) > modelSize(r) * 0.002) { d.pts.push(at); d.tris.push(tri); showDrawn(); }
}
/** Esc: drop the polyline being drawn. True when there was one. */
export function cancelDraw() { if (!drawn) return false; drawn = null; showDrawn(); return true; }
/** Backspace: take back its last corner. */
export function undoDrawPoint() {
  if (!drawn) return false;
  drawn.pts.pop(); drawn.tris.pop();
  if (!drawn.pts.length) drawn = null;
  showDrawn();
  return true;
}
/** Douglas–Peucker: the corners that keep a freehand run within `tol` (indices, ends kept). */
function simplify(pts: [number, number][], tol: number): number[] {
  const keep = new Set([0, pts.length - 1]);
  const walk = (a: number, b: number) => {
    let far = -1, fd = tol;
    const [ax, ay] = pts[a], ex = pts[b][0] - ax, ey = pts[b][1] - ay, l2 = ex * ex + ey * ey || 1;
    for (let k = a + 1; k < b; k++) {
      const t = Math.max(0, Math.min(1, ((pts[k][0] - ax) * ex + (pts[k][1] - ay) * ey) / l2));
      const dd = Math.hypot(pts[k][0] - ax - ex * t, pts[k][1] - ay - ey * t);
      if (dd > fd) { fd = dd; far = k; }
    }
    if (far >= 0) { keep.add(far); walk(a, far); walk(far, b); }
  };
  walk(0, pts.length - 1);
  return [...keep].sort((x, y) => x - y);
}
/** Enter, a double-click or a click on the first point: the polyline becomes a wrapped relief decal whose outline is
 *  the line, laid out in the surface's own coordinates round its middle (`expMap`), so it follows the model over
 *  bevels and curves as it was drawn. A line kind stays open unless closed; a panel or pad is always its closed outline. */
export function finishDraw(close = false) {
  const d = drawn, st = get(), out = d && st.result?.parts[d.part], a = drawArmed();
  drawn = null;
  showDrawn();
  if (!d || !out || !a?.shape) return;
  const line = isLine(a.shape.pattern), closed = !line || close, { pts, tris } = d;
  if (pts.length < (closed ? 3 : 2)) { if (!line) set({ error: 'An outline needs three points or more.' }); return; }
  const span = modelSize(st.result!), sh = shapeAt(a.shape, span), run = [0];
  for (let k = 1; k < pts.length; k++) run.push(run[k - 1] + dist3(pts[k], pts[k - 1]));
  const total = run[run.length - 1];
  if (total < Math.max(sh.border, span * 0.002) * 2) return; // a click, not a line
  // framed at the line's middle, facing the face there
  const m = Math.max(0, run.findIndex((x) => x >= total / 2)), normal = faceNormal(out, tris[m]);
  const decal: Decal = {
    asset: a.id, center: [...pts[m]] as [number, number, number], normal, up: decalUp(normal), width: 1, rotation: 0, aspect: 1,
    tint: st.paint.decalTint, roughness: 0.55, metallic: 0, channels: ['normal', 'height'], wrap: true, shape: sh,
  };
  const f = decalFrame(decal, span), pos = out.positions;
  const map = expMap(pos, [f.cx, f.cy, f.cz], [f.nx, f.ny, f.nz], [f.uxr, f.uyr, f.uzr], [f.vxr, f.vyr, f.vzr], total * 1.5 + sh.border * 4);
  // each point on the map; where the walk didn't reach (another shell), flat along the frame
  let ab = pts.map((p, k) => mapAt(pos, map, tris[k], p) ?? (() => {
    const dx = p[0] - f.cx, dy = p[1] - f.cy, dz = p[2] - f.cz;
    return [dx * f.uxr + dy * f.uyr + dz * f.uzr, dx * f.vxr + dy * f.vyr + dz * f.vzr] as [number, number];
  })());
  // a freehand run keeps only the corners that matter (the bake walks every segment per texel)
  ab = simplify(ab, Math.max(sh.border * 0.08, span * 0.0002)).map((k) => ab[k]);
  const pad = line ? sh.border : 0;
  let hw = Math.max(pad, 1e-6), hh = Math.max(pad, 1e-6);
  for (const [x, y] of ab) { hw = Math.max(hw, Math.abs(x) + pad); hh = Math.max(hh, Math.abs(y) + pad); }
  placeDecal(d.part, tris[m], pts[m], { ...decal, width: hw * 2, aspect: hw / hh, shape: { ...sh, closed: line ? closed : undefined, outline: ab.map(([x, y]) => [x / hw, y / hh]) } });
}
/** `d` mirrored across the plane through the model's middle square to `axis` (Blender's Symmetrize): the point
 *  reflected and set on the nearest triangle of part `i` facing the reflected way, its up reflected, its turn reversed
 *  and the mark flipped, so it is the mirror image (a slanted grip panel slants the other way). */
function mirrorFrame(r: Output, i: number, d: Decal, axis: 0 | 1 | 2): Pick<Decal, 'center' | 'normal' | 'up' | 'rotation' | 'flipH'> | null {
  const mid = modelCentre()[axis];
  const ref = (p: [number, number, number], point: boolean) => { const q = [...p] as [number, number, number]; q[axis] = point ? 2 * mid - p[axis] : -p[axis]; return q; };
  const want = ref(d.center, true), rn = ref(d.normal, false), rl = Math.hypot(...rn) || 1;
  const pos = r.parts[i].positions;
  let best = -1, bestD = Infinity, bn: [number, number, number] = [0, 0, 0];
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    if ((nx * rn[0] + ny * rn[1] + nz * rn[2]) / rl < 0.5) continue; // must face the reflected way, or it is the back
    const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3, cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3, cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
    const dd = (cx - want[0]) ** 2 + (cy - want[1]) ** 2 + (cz - want[2]) ** 2;
    if (dd < bestD) { bestD = dd; best = t; bn = [nx, ny, nz]; }
  }
  if (best < 0) return null;
  const o = best * 9, [nx, ny, nz] = bn;
  const off = (want[0] - pos[o]) * nx + (want[1] - pos[o + 1]) * ny + (want[2] - pos[o + 2]) * nz;
  // a reflection turns the frame's handedness over: up reflected with the turn reversed keeps the mark's up, and the
  // flip puts its right back on the far side (frame u = up × n)
  return { center: [want[0] - nx * off, want[1] - ny * off, want[2] - nz * off], normal: bn, up: ref(d.up, false), rotation: -d.rotation, flipH: !d.flipH };
}
/** The Mirror tool's copy of the selected mark for a pointer at `at` on part `i`: within reach of the spot symmetric to
 *  the mark across the model's middle on X, Y or Z it snaps there (`mirrorFrame`); elsewhere the mirror image lands
 *  under the pointer, reflected across the axis whose facing fits that face best. Null with no mark selected. */
function mirrorAt(i: number, tri: number, at: [number, number, number]): { decal: Decal; snapped: boolean } | null {
  const st = get(), src = activeDecal(), out = st.result?.parts[i];
  if (!src || !out || tri < 0) return null;
  const d = src.decal, span = modelSize(st.result!);
  let best: Decal | null = null, bestD = Math.max(d.width, span * 0.06);
  for (const k of [0, 1, 2] as const) {
    const m = mirrorFrame(st.result!, i, d, k);
    // a mark on the middle plane mirrors onto itself across it: not a place to put a copy
    if (!m || dist3(m.center, d.center) < d.width * 0.25) continue;
    const dd = dist3(m.center, at);
    if (dd < bestD) { bestD = dd; best = { ...d, ...m }; }
  }
  if (best) return { decal: best, snapped: true };
  const n = faceNormal(out, tri);
  // reflecting across k turns the facing to n best where d.normal[k] · n[k] is lowest
  const k = [0, 1, 2].reduce((b, a) => (d.normal[a] * n[a] < d.normal[b] * n[b] ? a : b), 0);
  const up = [...d.up] as [number, number, number];
  up[k] = -up[k];
  return { decal: { ...d, center: at, normal: n, up: carryUp(up, n), rotation: -d.rotation, flipH: !d.flipH }, snapped: false };
}
let mirrorKey = '';
/** The pointer over part `i` (-1: off the model) with the Mirror tool: show where the copy would go. */
export function mirrorHover(i: number, tri = -1, at?: [number, number, number]) {
  const aim = i >= 0 && at ? mirrorAt(i, tri, at) : null;
  const key = aim ? `${i}:${aim.decal.center.join()}` : '';
  if (key === mirrorKey) return;
  mirrorKey = key;
  set({ mirrorAim: aim ? { part: i, ...aim } : null });
}
/** A Mirror tool click: on a mark it picks that mark to mirror; anywhere else, with a mark picked, it puts a mirrored
 *  copy where the hover showed — its own layer with the same settings, nothing linked — and hands over to the Decal
 *  tool with the copy selected. One undo step. */
function mirrorPress(i: number, tri: number, at: [number, number, number]) {
  const j = decalUnder(i, at, tri);
  if (j >= 0) { selectDecal(i, j); mirrorKey = ''; set({ mirrorAim: null, error: null }); return; }
  const aim = mirrorAt(i, tri, at), src = activeDecal();
  if (!aim || !src) { set({ error: 'Click a mark to pick it, then click where its mirror goes.' }); return; }
  const from = texSet(src.part).layers[texSet(src.part).active], s = texSet(i), d = aim.decal;
  step(s);
  if (d.shape && !s.channels.includes('normal')) s.channels = [...FILL_CHANNELS];
  const layer: PaintLayer = {
    ...newLayer(s.layers.length + 1), name: `${from.name} mirror`, opacity: from.opacity, blend: from.blend ? { ...from.blend } : undefined,
    decal: { ...d, center: [...d.center] as [number, number, number], normal: [...d.normal] as [number, number, number], up: [...d.up] as [number, number, number], channels: [...d.channels] },
  };
  const at0 = insertAt(s);
  s.layers.splice(at0, 0, layer);
  s.active = at0;
  mirrorKey = '';
  set((now) => ({ activePart: i, mirrorAim: null, error: null, paint: { ...now.paint, tool: 'decal', decalMode: 'edit', decalSel: true } }));
  rebakeDecal(i, layer);
  repaintPanel();
}
/** A mark dragged from the shelf and let go on part `i` at `at` (triangle `tri`): armed and placed there, as a click
 *  with the Decal tool would, so its gizmo is ready. */
export function dropDecal(id: string, i: number, tri: number, at: [number, number, number]) {
  if (get().busy || !decalOf(id)) return;
  const a = decalOf(id)!;
  set((s) => ({ paint: { ...s.paint, tool: 'decal', decalAsset: id, decalTint: s.paint.color, ...(a.size ? { decalSize: a.size } : {}) } }));
  placeDecal(i, tri, at);
}
/** `up` carried onto a new facing: its part along that plane, or the upright stand-in when it would vanish. */
function carryUp(up: [number, number, number], normal: [number, number, number]): [number, number, number] {
  const d = up[0] * normal[0] + up[1] * normal[1] + up[2] * normal[2];
  const x = up[0] - normal[0] * d, y = up[1] - normal[1] * d, z = up[2] - normal[2] * d, len = Math.hypot(x, y, z);
  return len > 0.2 ? [x / len, y / len, z / len] : decalUp(normal);
}
/** Shift while moving a mark (and the panel's Center): put it on the model's middle across the axis the mark faces
 *  along — a gun's two flanks, a scope's bore — so a marking lines up with the one opposite without eyeballing it.
 *  Only when it is near: a drag across the model should not be yanked to its centre. */
function snapMiddle(c: [number, number, number], normal: [number, number, number], force = false): boolean {
  const r = get().result;
  if (!r) return false;
  const ax = [0, 1, 2].reduce((m, k) => (Math.abs(normal[k]) > Math.abs(normal[m]) ? k : m), 0);
  let lo = Infinity, hi = -Infinity;
  for (const p of r.parts) for (let k = ax; k < p.positions.length; k += 3) { if (p.positions[k] < lo) lo = p.positions[k]; if (p.positions[k] > hi) hi = p.positions[k]; }
  const mid = (lo + hi) / 2;
  if (!force && Math.abs(c[ax] - mid) > modelSize(r) * 0.05) return false;
  if (c[ax] === mid) return false;
  c[ax] = mid;
  return true;
}
/** Slide the active mark to a point on the surface. Its own plane is kept while the pointer stays on one smooth face
 *  (re-deriving the facing from every triangle it crossed made the mark spin and jump); it turns onto a new face only
 *  when the surface really turns away, more than 15°. `snap` (Shift) catches the model's middle. */
export function dragDecal(at: [number, number, number], tri?: number, snap = false, bake = true) {
  const i = get().activePart, s = texSet(i), out = get().result?.parts[i];
  if (!out || !s.layers[s.active]?.decal) return;
  ensureStep(s);
  // the step swaps the active layer for its copy: edit that one, not the one the undo keeps
  const l = s.layers[s.active];
  let { normal, up } = l.decal!;
  if (tri != null && tri >= 0) {
    const n2 = faceNormal(out, tri);
    if (n2[0] * normal[0] + n2[1] * normal[1] + n2[2] * normal[2] < 0.966) { normal = n2; up = carryUp(up, normal); }
  }
  const c: [number, number, number] = [...at] as [number, number, number];
  if (snap) snapMiddle(c, normal);
  l.decal = { ...l.decal!, center: c, normal, up };
  if (bake) laterRebake(i, l); else repaintLive();
}
/** A live edit (drag, gizmo, slider) re-bakes at most once a frame. */
let decalRaf = 0;
function laterRebake(i: number, l: PaintLayer) {
  repaintLive();
  if (decalRaf) return;
  const run = () => { decalRaf = 0; const now = get(); if (now.parts[i] && texSet(i).layers.includes(l)) rebakeDecal(i, l, true); };
  decalRaf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : setTimeout(run, 16) as unknown as number;
}
/** The active layer's decal and its part, for the 3D gizmo (null when the active layer isn't one, or none is picked). */
export function activeDecal() {
  const s = get(), i = s.activePart, ts = s.parts[i] && s.result?.parts[i] ? setIfAny(s.parts[i].soup) : null;
  const d = ts?.layers[ts.active]?.decal;
  return d && s.paint.decalSel ? { part: i, decal: d } : null;
}
/** Edit / Place: what a click on the model does with the Decal tool (the tile in the Decals tab arms one placement). */
// Draw with nothing drawable armed starts with the groove; leaving Draw drops a half-drawn polyline
export function setDecalMode(decalMode: DecalMode) {
  if (decalMode !== 'draw') cancelDraw();
  set((s) => ({ paint: { ...s.paint, decalMode, ...(decalMode === 'draw' && !drawArmed() ? { decalAsset: 'shape-groove' } : {}) } }));
}
/** Arrow keys: move the mark across its own plane, `du` / `dv` steps of 0.4% of the model. */
export function nudgeDecal(du: number, dv: number, undoable = true) {
  const a = activeDecal();
  if (!a) return;
  const f = decalFrame(a.decal, modelDiagonal()), k = modelDiagonal() * 0.004;
  updateDecal({ center: [
    a.decal.center[0] + (f.uxr * du + f.vxr * dv) * k,
    a.decal.center[1] + (f.uyr * du + f.vyr * dv) * k,
    a.decal.center[2] + (f.uzr * du + f.vzr * dv) * k,
  ] }, undoable);
}
/** Put the mark back on the model's middle across the axis it faces (whatever the pointer last did). */
export function centerDecal() {
  const a = activeDecal();
  if (!a) return;
  const c: [number, number, number] = [...a.decal.center] as [number, number, number];
  if (snapMiddle(c, a.decal.normal, true)) updateDecal({ center: c });
}
/** Turn the projector onto the surface under the mark: the faces round its centre, by how near they are. A mark
 *  dragged over a bevel keeps its old lean until this is asked for (or the surface turns away by more than 15°). */
export function alignDecal() {
  const a = activeDecal(), out = get().result?.parts[get().activePart];
  if (!a || !out) return;
  const { center, width, aspect } = a.decal, r = Math.max(width, width / Math.max(aspect, 1e-3)) * 0.6;
  let sx = 0, sy = 0, sz = 0, wsum = 0;
  const pos = out.positions;
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9;
    const dx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3 - center[0], dy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3 - center[1], dz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3 - center[2];
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd > r * r) continue;
    const n = faceNormal(out, t), w = 1 / (1 + 4 * dd / (r * r));
    sx += n[0] * w; sy += n[1] * w; sz += n[2] * w; wsum += w;
  }
  const nl = Math.hypot(sx, sy, sz);
  if (wsum <= 0 || nl < 1e-6) return;
  const normal: [number, number, number] = [sx / nl, sy / nl, sz / nl];
  updateDecal({ normal, up: carryUp(a.decal.up, normal) });
}
/** Ctrl+D for a mark: a copy above it, nudged a tenth of its width along U so both are visible and can be dragged apart. */
export function duplicateDecal() {
  const a = activeDecal();
  if (!a) return;
  duplicatePaintLayer();
  nudgeDecal(0.5, 0, false); // part of the duplicate's own undo step
}
/** Change the active decal's size, rotation, tint, finish or placed asset. */
export function updateDecal(patch: Partial<Decal>, undoable = true, bake = true) {
  if (get().busy) return;
  const i = get().activePart, s = texSet(i);
  if (!s.layers[s.active]?.decal) return;
  if (undoable) step(s); else ensureStep(s);
  // the step swaps the active layer for its copy: edit that one, not the one the undo keeps
  const l = s.layers[s.active], next = { ...l.decal!, ...patch };
  l.decal = next;
  if (patch.asset) {
    const a = decalOf(patch.asset);
    // a grip preset is only the relief: the mark keeps its proportions
    if (a) { l.name = a.name; if (!a.shape) next.aspect = a.width / a.height; }
  }
  if (undoable) rebakeDecal(i, l); else if (bake) laterRebake(i, l);
  repaintPanel();
}
/** Finish a decal edit whose expensive texture bake was deferred during direct manipulation. */
export function finishDecalEdit() {
  const s = get(), i = s.activePart, ts = s.parts[i] ? texSet(i) : null, l = ts?.layers[ts.active];
  if (!ts || !l?.decal) return;
  rebakeDecal(i, l);
}
/** Swap the active grip texture's relief for a preset's (pattern, cell, height, border): its place, size, outline and
 *  corners stay as they are. */
export function setGripPreset(id: string) {
  const a = decalOf(id), d = activeDecal()?.decal, r = get().result;
  if (!a?.shape || !d?.shape || !r) return;
  const { pattern, cell, amount, border, depth, profile, head, drive, washer } = shapeAt(a.shape, modelSize(r));
  updateDecal({ asset: id, shape: { ...d.shape, pattern, cell, amount, border, depth, profile, head, drive, washer } });
}
/** Fit the active grip texture to the selected faces (Select Faces, W) or the whole part: the pattern alone (no outline
 *  or groove border) wrapped round the surface from their middle, on a panel big enough to reach every corner, and the
 *  faces' texels as the layer's mask so it stops at their edges. */
export function fitDecal(to: 'faces' | 'part') {
  const st = get(), i = st.activePart, out = st.result?.parts[i], uv = st.uvs[i], d = activeDecal()?.decal;
  if (st.busy || !out || !uv || !d?.shape) return;
  const s = texSet(i), pos = out.positions, n = s.size, tris: number[] = [];
  for (let t = 0; t < pos.length / 9; t++) {
    // a face is in when the texel under its UV middle is selected
    const x = Math.floor(((uv[t * 6] + uv[t * 6 + 2] + uv[t * 6 + 4]) / 3) * n), y = Math.floor(((uv[t * 6 + 1] + uv[t * 6 + 3] + uv[t * 6 + 5]) / 3) * n);
    if (to === 'part' || (s.sel && s.sel[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))] >= 128)) tris.push(t);
  }
  if (!tris.length) { set({ error: 'Select the faces to fit to first (Select Faces, W).' }); return; }
  let sx = 0, sy = 0, sz = 0, cx = 0, cy = 0, cz = 0, area = 0;
  for (const t of tris) {
    const o = t * 9;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x, w = Math.hypot(fx, fy, fz);
    sx += fx; sy += fy; sz += fz; area += w;
    cx += (w * (pos[o] + pos[o + 3] + pos[o + 6])) / 3; cy += (w * (pos[o + 1] + pos[o + 4] + pos[o + 7])) / 3; cz += (w * (pos[o + 2] + pos[o + 5] + pos[o + 8])) / 3;
  }
  if (area <= 0) return;
  const center: [number, number, number] = [cx / area, cy / area, cz / area], nl = Math.hypot(sx, sy, sz);
  // a closed part faces every way at once: keep the mark's own facing there
  const normal: [number, number, number] = nl > area * 0.05 ? [sx / nl, sy / nl, sz / nl] : d.normal;
  let reach = 0;
  for (const t of tris) for (let k = 0; k < 9; k += 3) reach = Math.max(reach, Math.hypot(pos[t * 9 + k] - center[0], pos[t * 9 + k + 1] - center[1], pos[t * 9 + k + 2] - center[2]));
  // the wrap walks the surface, which is longer than the straight line: 2.5× covers half way round a sphere
  const half = reach * 2.5 + d.shape.cell;
  step(s);
  const l = s.layers[s.active];
  l.decal = { ...d, center, normal, up: carryUp(d.up, normal), width: half * 2, aspect: 1, wrap: true, shape: { ...d.shape, border: 0, corner: 0, outline: undefined } };
  if (to === 'faces') l.mask = maskTris(s, pos, uv, tris); else delete l.mask;
  rebakeDecal(i, l);
  repaintPanel();
}

/** A new fill layer above the active one, with `asset` projected tri-planar over the part (the default that does not
 *  break at a packed atlas's seams). An existing selection becomes its mask. */
/** The shelf tile being dragged (HTML drag data can't be read until the drop). */
export const shelfDrag = { id: '' };
export function assignMaterial(id: string, all = false, onto?: { part: number; tris: number[] }) {
  if (get().busy) return;
  const { activePart, parts, result } = get();
  if (!parts[activePart] || !result) return;
  const asset = materialOf(id);
  if (!asset) return;
  if (onto) set({ activePart: onto.part });
  const targets = (onto ? [onto.part] : all ? visibleParts() : targetParts()).filter((i) => parts[i] && result.parts[i] && get().uvs[i]);
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
      const fill: Fill = { asset: id, projection: 'triplanar', tiling: asset.scale ?? 1, tiles: 4, rotation: 0, offset: [0, 0], normalStrength: 1, tint: asset.colorless ? st.paint.color : '#ffffff', channels: [...FILL_CHANNELS] };
      const layer: PaintLayer = { ...newLayer(ts.layers.length + 1), name: asset.name, fill, ...(over && st.paint.fillBlend !== 'normal' ? { blend: { color: st.paint.fillBlend } } : {}), ...(onto ? { mask: maskTris(ts, out.positions, uv, onto.tris) } : ts.sel ? { mask: ts.sel.slice() } : {}) };
      const at = insertAt(ts);
      ts.layers.splice(at, 0, layer);
      ts.active = at;
      ts.channels = [...FILL_CHANNELS];
      bakeFill(ts, layer, maps, out.positions, uv, modelSize(st.result));
      composite(ts);
    }
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
  const others = get().linkSets ? visibleParts().filter((j) => j !== i) : [];
  const mates = matesOf(current), partOf = (t: TexSet) => others.find((j) => texSet(j) === t) ?? -1;
  const fills = mates.filter((t) => t.layers[t.active].fill);
  if (undoable) step(ts, ...fills); else ensureStep(ts, ...fills);
  const seq = ++fillSeq;
  refill(i, ts, patch, seq);
  for (const t of fills) refill(partOf(t), t, patch, seq);
}
/** Set `ts`'s active fill to its settings plus `patch` and bake it again (a solid has no maps to load). */
function refill(i: number, ts: TexSet, patch: Partial<Fill>, seq: number) {
  const l = ts.layers[ts.active], f = { ...l.fill!, ...patch };
  const asset = f.asset === SOLID ? null : materialOf(f.asset);
  if (i < 0 || (f.asset !== SOLID && !asset)) return;
  l.fill = f;
  void (asset ? materialPixels(asset) : Promise.resolve<MaterialPixels>({}))
    // a task later, so a slider's queued moves have all taken their seq and only the newest bakes
    .then((maps) => new Promise<MaterialPixels>((done) => setTimeout(() => done(maps))))
    .then((maps) => {
      if (seq !== fillSeq) return;
      const st = get(), out = st.result?.parts[i];
      if (!out || !ts.layers.includes(l)) return;
      bakeFill(ts, l, maps, out.positions, st.uvs[i], modelSize(st.result!));
      composite(ts);
      repaint();
    })
    .catch((e) => set({ error: e instanceof Error ? e.message : String(e) }));
}
/** A solid fill layer (Substance's fill with plain values): the paint colour, roughness and metallic over the selection
 *  (or the whole part), kept as settings so its colour can change later without repainting. */
export function addSolidFill() {
  const r = get().result;
  if (get().busy || !r) return;
  const targets = targetParts().filter((i) => r.parts[i] && get().uvs[i]), p = get().paint;
  if (!targets.length) return;
  const sets = targets.map(texSet);
  step(...sets);
  sets.forEach((ts, k) => {
    const i = targets[k];
    const fill: Fill = { asset: SOLID, projection: 'triplanar', tiling: 1, tiles: 4, rotation: 0, offset: [0, 0], normalStrength: 1, tint: p.color, roughness: p.rough, metallic: p.metal, channels: ['color', 'rough', 'metal'] };
    const layer: PaintLayer = { ...newLayer(ts.layers.length + 1), name: 'Solid', fill, ...(ts.sel ? { mask: ts.sel.slice() } : {}) };
    const at = insertAt(ts);
    ts.layers.splice(at, 0, layer);
    ts.active = at;
    if (!ts.channels.includes('metal')) ts.channels = [...FILL_CHANNELS];
    bakeFill(ts, layer, {}, r.parts[i].positions, get().uvs[i], modelSize(r));
    composite(ts);
  });
  set({ paintChannel: 'material' });
  repaint();
}
/** White/black the active fill's mask, invert it, or remove it (white). */
export const setFillMask = (value: number) => layers((s) => { const l = s.layers[s.active]; if (l?.fill) maskFill(s, l, value); });
export const invertFillMask = () => layers((s) => { const l = s.layers[s.active]; if (l?.fill) maskInvert(s, l); });
export const clearFillMask = () => layers((s) => { const l = s.layers[s.active]; if (l?.fill) delete l.mask; });

/** Every channel of the active part, one PNG each (Base Color sRGB, Roughness and Metallic greyscale),
 *  the packed ORM (R AO, G roughness, B metallic) and a small JSON that names the colour spaces. */

// ---- baking and generators (Substance's Bake Mesh Maps and smart masks) ----
/** Bake AO and edge maps for every visible part, every part casting occlusion on the others. */
/** Quick bake: the active part only, with every visible part casting occlusion. `allParts` is the slow
 *  version that bakes every texture set; the future Bakery tab owns the full low/high-poly workflow. */
export const bakePaint = (allParts: boolean | number[] = false) => task('Baking mesh maps…', async () => {
  const { result, uvs, activePart, parts } = get();
  if (!result) return;
  const casters = parts.flatMap((p, i) => (p.visible && result.parts[i] ? [result.parts[i].positions] : []));
  const targets = (Array.isArray(allParts) ? allParts : allParts ? visibleParts() : [activePart]).filter((i) => parts[i] && result.parts[i] && uvs[i]);
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
  edge: { name: 'Edge Wear', amount: 0.25, soft: 0.2, width: 0.008, grunge: 0.5, scale: 0.03, color: '#a39f98', rough: 0.4, metal: 1 },
  dirt: { name: 'Dirt', amount: 0.4, soft: 0.3, width: 0.012, grunge: 0.4, scale: 0.05, color: '#3d3226', rough: 0.9, metal: 0 },
  ao: { name: 'Ambient Occlusion', amount: 0.6, soft: 0.6, width: 0.01, grunge: 0, scale: 0.05, color: '#000000', rough: 0.8, metal: 0 },
};
/** A generator layer above the active one, inside the selection if there is one; on every visible part with All sets.
 *  A part with no mesh maps yet is baked first, instead of the button doing nothing. */
export async function addGenerator(kind: GenKind) {
  if (get().busy) return;
  const targets = targetParts().filter((i) => get().result?.parts[i] && get().uvs[i]);
  const raw = targets.filter((i) => !texSet(i).bake);
  if (raw.length) await bakePaint(raw);
  const sets = targets.map(texSet).filter((s) => s.bake);
  if (!sets.length) return;
  step(...sets);
  const { name, ...g } = GEN_START[kind];
  for (const s of sets) {
    const l: PaintLayer = { ...newLayer(0), name, gen: { kind, ...g, clip: s.sel } };
    generate(s, l);
    s.layers.splice(s.active + 1, 0, l);
    s.active++;
    scheduleComposite(s);
  }
  repaintPanel();
}
/** Bevel: a layer on each target part writing rounded-edge normals (paint.ts `bakeBevel`); no bake needed first. */
export function addBevel() {
  const st = get();
  if (st.busy || !st.result) return;
  const targets = targetParts().filter((i) => st.result!.parts[i] && st.uvs[i]);
  if (!targets.length) return;
  const sets = targets.map(texSet), b: Bevel = { radius: modelSize(st.result) * 0.004, profile: 'round', angle: 30, concave: false };
  step(...sets);
  for (const [k, i] of targets.entries()) {
    const ts = sets[k], l: PaintLayer = { ...newLayer(0), name: 'Bevel', bevel: b };
    if (!ts.channels.includes('normal')) ts.channels = [...FILL_CHANNELS];
    bakeBevel(ts, l, st.result.parts[i].positions, st.uvs[i]);
    const at = insertAt(ts);
    ts.layers.splice(at, 0, l);
    ts.active = at;
    scheduleComposite(ts);
  }
  set({ paintChannel: 'material' });
  repaintPanel();
}
let bevelLater: ReturnType<typeof setTimeout> | undefined;
/** The active bevel layer's settings changed (and the same-named one on each linked set). A slider drag
 *  (`undoable` false) shares one step and bakes once it pauses: a whole part's edges take a moment. */
export function editBevel(b: Partial<Bevel>, undoable = true) {
  const st = get(), i = st.activePart;
  if (!st.parts[i] || !st.result) return;
  const s = texSet(i), l0 = s.layers[s.active];
  if (!l0?.bevel) return;
  const mates = matesOf(l0).filter((t) => t.layers[t.active].bevel);
  if (undoable) step(s, ...mates); else ensureStep(s, ...mates);
  const jobs = [s, ...mates].map((t) => {
    const l = t.layers[t.active];
    l.bevel = { ...l.bevel!, ...b };
    return [t, l] as const;
  });
  const run = () => {
    const now = get();
    for (const [t, l] of jobs) {
      const j = now.parts.findIndex((p) => setIfAny(p.soup) === t), out = now.result?.parts[j], uv = now.uvs[j];
      if (!out || !uv || !t.layers.includes(l)) continue;
      bakeBevel(t, l, out.positions, uv);
      scheduleComposite(t);
    }
  };
  clearTimeout(bevelLater);
  if (undoable) run(); else bevelLater = setTimeout(run, 150);
  repaintPanel();
}
let bakingGen = false;
/** The active generator layer's settings changed: made again (`undoable` false: inside a slider drag's step). A project
 *  reopened without its baked maps (they are derived, not saved) bakes them first: the generator's saved pixels are
 *  already on screen, but its sliders would do nothing until the AO and edge maps exist again. */
export function editGen(g: Partial<Gen>, undoable = true) {
  const st = get(), i = st.activePart;
  if (!st.parts[i]) return;
  const s = texSet(i), l0 = s.layers[s.active];
  if (!l0?.gen) return;
  const mates = matesOf(l0).filter((t) => t.layers[t.active].gen);
  const targets = [s, ...mates];
  if (undoable) step(s, ...mates); else ensureStep(s, ...mates);
  for (const t of targets) {
    const l = t.layers[t.active];
    t.layers[t.active] = { ...l, gen: { ...l.gen!, ...g } };
  }
  if (targets.some((t) => !t.bake)) {
    const parts = targets.map((t) => st.parts.findIndex((p) => setIfAny(p.soup) === t)).filter((j) => j >= 0);
    // the bake's own final pass regenerates every generator from the settings they hold by then
    if (parts.length && !bakingGen && !st.busy) { bakingGen = true; void bakePaint(parts).finally(() => { bakingGen = false; }); }
    repaintPanel();
    return;
  }
  for (const t of targets) {
    generate(t, t.layers[t.active]);
    scheduleComposite(t);
  }
  repaintPanel();
}
