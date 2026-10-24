# Barista

Asset toolset for the Espresso engine pipeline: Poly Doc (topology), UV Magician (automatic UV unwrap), Van Gogh (texture paint). Rust engine + Axum server (`engine/`), React 19 + react-three-fiber + zustand editor (`src/`), Vite, pnpm.
UI follows espresso-level-designer (`../espresso-level-designer`): Photoshop/Spectrum dark shell, tokens in `src/styles/base.css`.

## Commands
- `pnpm server` (Rust engine on :3000, API only) + `pnpm dev` (the editor, only ever at :5173; proxies /api) · `pnpm test` (cargo tests, a few s) · `pnpm build`
- `pnpm app` the desktop app (Tauri 2, `src-tauri/`: starts Vite, engine in-process as commands named after the routes; `api.ts` uses
  `invoke` inside it, `fetch` in a browser) · `pnpm app:build` the installer. Browser testing still goes through `pnpm server` + :5173.
- `npx tsc --noEmit -p .` for the frontend. UI changes: verify in the browser at :5173. The user runs both servers in their own Terminal
  tabs ("engine", "editor"): restart the engine tab after engine changes rather than starting preview servers of your own.

## How the unwrap works (engine/src)
UVs are always computed on the real mesh's own triangles, never projected from a proxy (that smears triangles across seams).
`mesh` weld + make winding consistent/outward, deterministic `Map`/`Set` · `region` charts like an artist blocks out hard surface:
per shell a box frame from its big flat faces; smooth simple regions (disk, ring, sphere, torus) stay whole, boxy/tangled ones split into
flat patches labelled by the side they face, Potts-smoothed (ICM: area×(1−cos) vs shared border) so groove walls and bevels stay on
the flank they're cut into · `chart` per chart: closed genus-1 → `torus` (harmonic one-forms, seamless, re-cut to the reduced lattice
cell = rectangle), closed otherwise → cut open, holes → `flatten_slim` (projection start, SLIM without flips or outline crossing) else
seam to another border, disk → `flatten` (LSCM then ARAP, both on a prefactored envelope Cholesky, `Chol`); unfolds flat but overlaps → `carve` (paper-model
regrow on that unfolding into pieces that don't overlap themselves, exact triangle tests; each piece keeps the unfolding, SLIM-relaxed
from there; flipped or too-stretched pieces solved again; then `reattach` fills each small piece back into the one it came from,
squashed, whenever that stretch costs less than the seam); clean but stretched → cone-tip seam; still bad → `split`, kept only if cheaper than the stretch (`seam_weight`).
Every finished island that still has red (≥ 50%, `HOT`) the mean hid → `cool` (OptCuts' interior split: cut from the hottest
vertex to the border, relaxed from the layout as it is, kept if clean and less red; never a closed tube, the seamless torus layout).
`examples/gun.rs` prints `hot` = that red share of the area.
Seams are priced by `seam_cost`: length, halved in a right-angle concave crease, quartered on hidden surface (`Mesh::hidden`, from `region`'s ray cone),
×1000 inside a file polygon (`PartIn.polys` → `Mesh::poly`, `Mesh::inside`: a quad's diagonal); `chart::whole` keeps every partition (region charts,
carve, split) polygon-whole and the torus recut moves whole polygons, so Export writes quads and n-gons back whole (test `quads_stay_whole`);
cone-tip and hole seams follow the cheapest path · `join` hangs islands off each other along shared edges into nets
(Paper Model-style priority: flattest, then longest shared border, then breadth-first from the biggest; no overlap, must stay compact).
Two big islands whose shared border won't hinge rigidly become a book (`chart::book`): spine = the longest straight part of one shared
stretch, the child re-flattened with its spine pinned onto the parent's so it opens on the far side; a pair that still folds stays two
islands (carving the fold off left slits and slivers). A small orphan (<3% of the part, e.g. a groove wall carved off) lying in a notch or
hole of a bigger island (half its outline shared), or a sliver, is filled back before anything hangs: glued along every shared edge (turned
over if wound the other way); if the parent closed the notch up, the orphan and a few rings round it are re-laid (Tutte inside the held ring,
then SLIM, `refill`); kept if clean and the pair stays within `tol` · `region` also keeps hidden interior patches (ray cone sees no way out)
out of exterior charts · `pack` squares nets up (a book's spine along an axis), rasterises them and drops each (4 turns) at its
lowest-top spot (xatlas-style), one square per part unless `one_atlas` ·
`edit` hand edits: relax, stitch, and `reseam` (a seam toggled in the editor re-solves only the islands it touches, each
fit back onto where it lay at the part's texel density, never the fit's own scale, which shrinks onto a projected shell; a
stitched edge stays stitched: if the solve would cut it open again, the piece is flattened as its seams leave it; the rest, hand
edits and all, stays; only Unwrap/params/knife re-unwrap the whole part; the editor's Align / Pack switches, `afterAlign` /
`afterPack`, then straighten the islands it changed and fit them in, store `tidy`: `src/fitpack.ts` keeps every other island
where it is and puts each changed one back where it lay if clear, else nudged nearby, else at the lowest free spot by its shape;
no room or past 60 ms → the full engine pack, which Ctrl+P always is; check `node src/fitpack.check.ts`) ·
`shapes` the core test shapes · `ideal` the known ideal net per core shape · `lib` pipeline and `check()` ·
`stroke` the Cut tool: `snap` (stroke → nearest edge path, mesh unchanged) and `knife` (cut faces along the stroke-from-eye
plane walk, re-triangulate, new edges as seams; the editor then replaces the part's triangles).

## Rules
- `engine/tests/core_shapes.rs` + `ideal.rs` are the spec: cube → Latin cross, cylinder → tin can, cone → sector + disc on its arc
  (all 1 piece, 0% stretch), torus → one seamless rectangle, knot → one strip. The unwrapper must reach these on its own:
  never special-case a shape, never let `ideal.rs` feed back into the algorithm.
- `engine/examples/gun.rs` is the real-model benchmark (testdata/gun.soup): `cargo run --release --example gun -- ../testdata/gun.soup <out_dir>`
  writes per-part PNGs (3D checker views + UV layout); `CHARTS=1` renders the charting alone. Judge those images, not just the numbers.
- Running server locks `engine/target/release`: test with `CARGO_TARGET_DIR=target/check cargo test --release`.
- `src/api.ts` mirrors `engine/src/lib.rs` (Params, Stats, Output): change both together.
- Every user action lives in `src/store.ts`; components only read state and call those.
- The editor works like Blender (left-click select, middle-drag orbit, numpad views, 1-4 vertex/edge/face/island, A / Alt+A / Ctrl+I /
  L / Ctrl+L, Alt+click loop, B box; right click (list) or Q (pie): Cut = make seams, Stitch = join along edges (seams or
  hand tears; with faces selected, Cut takes their outline, Stitch the edges between them); in UV: G/R/S modal with X/Y, typed values, Ctrl snap; P / Alt+P pins, which
  `reseam` holds in place; U unwraps the selection; Live Unwrap lays a pin's islands out as it's dragged). After an auto unwrap every
  island border is a seam (`Part.seams`, clearing one joins its islands); `Part.marked` are the hand-marked ones, all Auto Unwrap keeps.
  3D navigation: the wheel zooms toward the cursor (`zoomToCursor`, `zoomSpeed` 3 ≈ 14% a notch, no distance limits); near / far
  follow the camera every frame (`ClipPlanes`: distance / 500 … distance × 4 + model size × 4), never fixed at framing, so a big FBX
  can be zoomed into without the near plane slicing it; Home / numpad . frame all / the selection.
  One selection (`csel`, ids from `src/topo.ts`) is shared by the 3D and UV views; `selected` (islands it touches) is derived from
  it for the island tools. A face is its whole polygon however it's picked (`selectElems` → `wholePolygons`; switching to face mode
  keeps only polygons with every triangle selected, `completePolygons`), except island picks in UV Magician (Ctrl+L, L, island tools),
  which stay exactly the island, since a seam can run through a quad. In Poly Doc, Select Linked grows over connected mesh
  (`wholeMesh`), island mode is off, and the UV keys, menus and right-click menu are off; export first unwraps parts Poly Doc changed.

## Poly Doc (second workspace: `src/panels/PolyDoc.tsx`, `src/shell/PolyTools.tsx`, `src/polygeo.ts`, `src/health.ts`)
Square workspace tabs under the menu bar (`src/shell/AppTabs.tsx`, Photoshop/Affinity's persona switch): Poly Doc | UV Magician | Van Gogh (`workspace` in the store), with the current file and its edited dot on the right.
Poly Doc is a manual inspect-and-fix tool, never automatic, and isolated from the unwrap: it reads the mesh alone (no UVs, no stretch)
and never calls the engine. Opening a model there or any geometry edit shows the bare mesh as the part's output (`meshOnly`, the
loader's `placeholder`) and marks the part `stale`; switching to UV Magician (`showWorkspace` → `unwrapStale`) unwraps every part if
none has UVs yet, else just the stale ones (`unwrapPart`, the others keep their UVs and hand edits).
Polygons: three's loaders triangulate, so `src/fbxpoly.ts` reads binary FBX itself (`Vertices` + `PolygonVertexIndex`, matched to
FBXLoader's `object.ID`) and gives each soup triangle its polygon by corner position (`Part.poly`, `Part.sides`); the engine reports
each output triangle's input index (`PartOut.source`, from `Mesh.src`, since degenerate triangles are dropped), `topo.polygonsOf` joins
the two. Each polygon shades as one face (its triangles' area-weighted normal, Blender's flat shading); UV seams aren't drawn in Poly Doc.
The 3D wire and the selection outline hide edges inside a polygon, a face click takes the whole polygon and an edge click never
picks a hidden diagonal, as Blender does; the Fix hint counts polygons and visible edges, and each fix says what it did (`fixNote`). OBJ/glTF/STL: triangles.
Fixes (`src/polyedit.ts`, store `dissolveSel` / `trisToQuadsSel`, Fix section + Ctrl+X / Alt+J): they regroup soup triangles into
polygons (`Part.poly` / `Part.sides`) and never move them, so UVs and stretch stay valid. Dissolve: faces selected → one polygon per
connected patch (`dissolveFaces`, whole patch at once), edges selected → the two sides of each edge merge; Tris to Quads: lone selected triangles paired greedily, flattest
(bend < 40°) and squarest first, convex only. A merge whose outline wouldn't be one simple loop is skipped. A triangles-only file
starts as one polygon per triangle (`ownPolygons`). Check: `node src/polyedit.check.ts`.
The options bar ends with the same ViewControls cluster in every workspace (`shell/Chrome.tsx`): selection | Display |
Shading. Selection is Vertex / Edge / Face / Island (Poly Doc disables Island: it has no UVs); Van Gogh's same slot is
Face / Island / Part (what Select Faces and Bucket pick). Display is the workspace's view mode (Poly Doc Wire / Smooth /
Health = `docView`; UV Magician Checker / Stretch / Islands = `mode`; Van Gogh Studio / MatCap / Flat = `scene.lighting`),
mirrored by the Z pie and View › Display, so Z never cycles or means something else in another workspace.
The Shading popover (`views/SceneSettings.tsx`, Blender's Viewport Shading): Lighting Studio (lights + environment map) /
MatCap (`src/shading.ts`: spheres drawn on a canvas, no image files: clay, studio grey, red wax, jade, chrome, toon, normals) / Flat
(unlit); Poly Doc Face color (Single / Random per part = `docColor`); Background
Theme / World (the map, `hdriBackground`) / Custom; Options: Backface Culling, Outline (drei `Outlines`), Specular, X-Ray + alpha,
Shadow + amount, Cavity (world space, `cavityOf`: neighbours' height over each vertex's tangent plane; Ridge / Valley); Overlays.
`PartMesh` builds one colour attribute (colour mode × cavity) and picks the material by lighting.
All three workspaces share one frame so switching never moves anything (`.space`: a 32 px options bar row that wraps instead of clipping,
then strip | views | panel; UV Magician's bar is `UVOptionsBar`: last strip tool `uvTool`, selection, Unwrap selection,
Live Unwrap; Van Gogh's is `PaintOptionsBar`: the tool's settings; both end in ViewControls). File › Open Recent (`src/recent.ts`,
IndexedDB, newest 10 by name): a File System Access handle where the browser has `showOpenFilePicker` (Chromium, WebView2: reread from
disk, permission asked once), else a copy up to 64 MB; a file that can't be reopened drops off the list.
The workspaces: a tool strip on the left (`ToolStrip` in `shell/PolyTools.tsx`; UV Magician's is `shell/UVTools.tsx`: box select,
loop, linked, Cut, Stitch, Pin, Unpin; the one-shot island commands are in the contextual `IslandBar` and the dock's collapsed
sections) and draggable dividers (`shell/Resizer.tsx`, espresso's dock resizer: the panel's width `dockWidth`, and in UV Magician the
3D / UV share `viewSplit`, both kept in localStorage). Poly Doc's panel has the Parts list too (`Parts workspace="doc"`: polygon counts,
no checker toggle). Panels collapse from their headers; Van Gogh pins Layers to the bottom.
Layout (Photoshop / espresso-level-designer): options bar on top (`PolyOptionsBar`: current tool, its settings `docOpts` = slide
amount, Limited Dissolve angle, Relax rounds, `fixNote`, then the shared ViewControls), tool strip on the left (`PolyToolStrip`, `shell/PolyTools.tsx`:
line glyphs in Spectrum's stroke weight, grouped clean up / shape / edge loops; a click runs the tool and makes it `docTool`; dimmed
until the selection fits), the panel on the right for looking only. Panel order: Health (verdict + rules grouped broken / bake / craft,
`healthVerdict`), Mesh Check (non-manifold edges and vertices, flipped faces, inside-out closed shells, zero-area / duplicate faces,
open edges: `polygeo.meshCheck`, each selectable), Polygons (census, low/high poles = inside vertices below/above the regular valence
for the part's dominant polygon kind — 4 for quads, 6 for triangles — `polygeo.poles`, dots on the model) and one line of topology
(`meshTopology`: shells, closed, genus, χ, borders).
Even Out (strip, was Relax; `polygeo.relax`): smart Laplacian: inside vertices toward their polygon-edge neighbours' middle, put back
on the original surface; vertices on a feature line (selection border, open edge, crease > 35°) slide along their own two edges of it,
corners stay; a move is kept only if no polygon round the vertex gets worse by Health's shape rules (`src/quality.ts`, shared with
`health.ts`), so it never folds, skews or tapers; `reshape(…, guard)` also refuses a result with more red faces. Rounds (default 30)
and Slide borders in the options bar. Move (G, strip; `startDocMove` / `updateDocMove` / `confirmDocMove` / `cancelDocMove`): the
selection's vertices follow the mouse (camera via `view3d.worldDelta`, registered by the 3D view), kept on the surface
(`moveOnSurface`, `surfaceOf`) unless X / Y / Z locks an axis; click / Enter keeps (one undo step, reselects), Esc / right-click puts
it back; Health recolours live.
Geometry tools (`src/polygeo.ts`; store `reshape` replaces the part's soup, shows it mesh-only and selects what the tool made, found
again by position): Relax, Subdivide, Connect (J: two vertices of a polygon, or the middles of two of its edges), Merge (M,
at centre) / Collapse (each edge group), Rotate Edge, Loop Cut (Ctrl+R through the selected edge's quad ring), Edge Slide (±¼ along the
rails), Space / Straighten (snapped to the surface) / Circle, Grid Fill (an even n-gon ≥ 6, or a hole's closed open-edge loop; Coons
patch). They share `rebuild` (replaced polygons re-triangulated by ear clipping, a neighbour's triangle on a new mid-edge vertex split).
Selections cross between the output and the soup through `polyedit.link` (nearest corner per source triangle). Limited Dissolve (5°)
is a regroup. Poly Doc view (`docView`, the Display control, Z pie or View › Display: hold Z and let go toward an item, or tap Z and click): Wire (flat polygons +
wireframe), Smooth (Auto Smooth within Sharp edges, no wireframe), Health (`src/health.ts`, `healthReport`: the pre-bake check,
not a simulation report. Three layers: **Broken** (non-manifold edges and vertices, whole inside-out closed shells by signed
volume, flipped, zero-area, duplicate, tangled outline: red, score 1); **Bake** (folded or >18° non-planar quads, bent n-gons:
a baker and the engine may triangulate them differently, so MikkTSpace tangents disagree and a normal map shows black seams;
triangulate before baking); **Craft** (needle triangles under 6°, quad skew > 0.7, taper > 0.8, a faceted curve where the
silhouette turns > 32° between segments — yellow only, capped at 0.55 — and over-dense curves under 1° per segment). The shape
limits are Sandia CUBIT / Verdict moved to their game-art ends: 30–60° min angle and 90° max are simulation limits; a pole fan
or a cylinder cap cannot meet them and shades fine. Sampling is scale-free (`polygeo.curveEdges`: turn, chord sagitta and local
radius, not a share of the model), and only curves whose radius is > 0.2% of the model and whose two sides are of like width are
judged (a chamfer or bevel beside a wide face is drawn that way). Poles are topology, not defects: their indices must sum to the
Euler characteristic (Poincaré–Hopf), so a torus may have none and a sphere must have curvature; Health does not colour them, the
census reports low/high poles, genus, χ and borders (`meshTopology`). A polygon's colour is its worst rule on all its triangles
(one face, one colour). The panel groups the rules that flag anything (broken / bake / craft, red / yellow counts, click selects
them); `polyContextMenu` (right-click in Poly Doc, `shell/PolyTools.tsx`) selects the face under the mouse and shows its
diagnosis, the cures for its rules (`CURES`: Triangulate, Merge into Neighbour, Collapse Shortest Edge, Relax Around), only the tools
that would do something there, and Select every-like-this. Instead of Unfold; Edge / UV / Unwrap menus, the seam right-click and UV keys
are off there. Checks: `node src/polygeo.check.ts` (every tool on small grids), `node src/health.check.ts` (a quad and a triangulated
torus are all green; pole fans, long flat strips and 12-sided curves pass; defects and inside-out shells are still caught). The engine's
test cube is half wound inward (the engine fixes winding), so Mesh Check rightly reports 96 flipped there. Design notes and sources:
`docs/health.md`.
Export (FBX and OBJ) writes the polygons: `files.faceLoops` joins each polygon's triangles back into one loop in winding order; a
polygon with a seam inside (its corners would need two UVs) or a hole in its outline (dropped degenerate triangles) goes out as
triangles. Normals: the file's own per corner (`polyedit.outNormals`; Move carries them, `carryNormals`; a rebuilding
tool drops them), else smooth within `sharp`. File › Triangulate on export (`triangulate`) writes triangles for baking. Check: `node src/files.check.ts`.
Agents: `node tools/polydoc.ts <in.fbx> [--detail] [--part NAME] [--do OP]... [-o out.fbx]` runs Poly Doc headless
(same modules; one report line per part, ~1-2k tokens for a whole model). Ops (header of the file): clean (duplicate faces;
back-to-back zero-area flaps both go), flip (n-gons with earcut slivers re-triangulated by Lawson flips), delpoly:IDs (internal
caps), weld:DIST, degen, defacet (Add Loops on Curve), relax[:RULES] (Relax Around), tri:RULES, quads, dissolve. Each is guarded per part (no more red faces,
no new open / non-manifold edges). `-o` unwraps through the running engine and writes the FBX like Export. Usual recipe:
report with --detail → clean, flip → defacet (faceting is a hint now, so it takes every flagged quad) → relax:quadSkew,quadTaper,quadJacobian,triMin → tri:quadWarp,ngonBent,… → -o
(which also lists polygons that still had to go out as triangles, and why).
Next: fixes that move geometry (relax, slide); later a sculpt
decimator and retopo on a high poly.

## Van Gogh (third workspace: `src/panels/VanGogh.tsx`, `src/paint.ts`)
Tabs: Poly Doc | UV Magician | Van Gogh. A lean Substance Painter for game assets, worked like Photoshop, in UV
Magician's frame (tool strip | 3D | texture view | panel); switching there unwraps stale parts first. Every tool works the
same on the model and in the texture view (store `paintPress` / `paintDrag` / `paintEnd`; a drag entering the model
starts painting). Per part a texture set (`setOf`, keyed by the part's soup, size fixed when made): channels Base Color,
and with + PBR Roughness and Metallic (glTF metal/rough: composite `orm` G / B, read by `meshStandardMaterial`), Photoshop
layers (each paints per channel with its own coverage), and a selection mask per texel (`sel`) that paint, fills and the
eraser stay inside; document-wide like Photoshop's (`selectDoc`: replacing it empties every other part's), shaded outside
(`shade`, an overlay mesh in 3D, drawn over the texture). Tools (Photoshop keys): Marquee M / Lasso L (on the model:
screen shape, only what's seen, `depthOf`; in the texture view: UV polygon; a click deselects), Select Faces W, Bucket G
(both take Face = the file's polygon / Island / Part, options bar), Brush B, Eraser E, Eyedropper I (and Alt+click with
Brush / Bucket). Shift adds, Alt takes away; Ctrl+click picks the part (opens it in the Parts tree). Ctrl+A select all,
Ctrl+D deselect, Ctrl+Shift+I invert, Alt+Backspace fill selection (no selection: the layer), Delete clear, Ctrl+J duplicate,
Ctrl+Shift+N new layer, Ctrl+[ ] move layer, [ ] brush size, Ctrl+Z (20 steps across sets, copy-on-write layers). A dab on
the model is a world-space sphere (triangles near it rasterised in UV), in the texture view a texel circle (size % of the
texture); each texel takes a dab once (strongest weight) so triangle edges never show, and paint bleeds 1.5 px only across
UV borders (`bordersOf`), so a face fill stops exactly at its edges inside an island. Panel: Parts tree (collapsible,
`paintOpen`; channels under each, click one to see it in the texture view), Layers as Photoshop's (opacity on top, rows
with eye + thumbnail, drag to reorder, double-click renames; Fill / Duplicate / New / Delete along the bottom), pinned
to the bottom of the dock; File › Export › Textures writes one PNG per channel. Painted texels don't follow a re-unwrap;
One atlas parts each still get their own set.
Color panel on top of the dock (`panels/ColorWheel.tsx`, Affinity's): hue ring (clockwise from red at the right) round
an HSV triangle (tip the hue, white, black), swatch, eyedropper, H S L, hex, Flow; the dock scrolls (`.paintdock`).
Brush cursor (Substance's): on the model two rings on the face under the mouse (`BrushCursor`: dashed = the dab's
reach, solid = hardness), in the texture view CSS rings at the mouse. Bake (`src/bake.ts`, Mesh Maps panel, every visible part,
every part occluding the others): AO the GPU way, the model's depth from 96 directions (orthographic, an offscreen
renderer), per texel the cosine-weighted share of its sky seen (texel point + face normal from `surfaceOf`, lifted 1.5
depth texels); edge maps = distance to the nearest sharp (> 20°) convex / concave edge over its strength, from edges
sampled into a grid. Material view (Substance's, `src/matview.ts`): in Studio lighting with no plate, Van Gogh lights the model by a bundled
plate (`PAINT_HDRI`, Dramatic studio) plus a shadow-casting key (`PaintStudio`; Canvas `shadows`), no lamps, no tone curve
(Substance's Legacy sRGB), and draws the real PBR material (`meshStandardMaterial`: the set's roughness / metallic, or
Substance's defaults 0.5 / 0.3 / 0 from its `lib-sampler`), smooth shaded within Sharp edges; Show AO puts the baked AO in
as its `aoMap`; MatCap / Flat multiply it over instead. `look` (sun strength, environment mean, key direction) + `relight()`:
the plate's brightest patch found (`sunOf`) and the plate turned so it sits on the key's side, its level calibrated to the
mean. The texture view's default, Material (lit), draws the UV layout through the same material and light in its own
renderer (`materialCanvas`: positions = UVs, normals = the model's face normals), so 2D and 3D match; uncovered texture
space is `EMPTY`, a lighter dark than the view round the square (two tones). Judge it on the GPU (headless Edge), not the
pane. Unpainted Base Color is Substance's 0.5 linear (188). Baked AO and Curvature list under
the part (texture view). Generators (smart masks: Edge Wear, Dirt, Occlusion) are layers (`gen`) whose coverage comes
from the bake (`generate`: band from the edge distance, AO, value noise for grunge, amount / softness threshold, the
selection at creation as `clip`); their settings sit above the layer list and make the layer again live.
Materials/Decals: `src/materials.ts` loads the 4,981-material purchased pack (`public/materials-pack`) as the
shelf; the 50-set `public/materials` core is only a fallback when the pack is missing. Clicking a shelf tile adds a
tri-planar fill layer. Browse is nine visible **Material** chips (Metal, Wood, Stone & Masonry, Tile & Ceramic,
Concrete & Ground, Fabric & Leather, Polymer & Carbon, Organic & Food, Other) plus search, paging and **All parts**;
the precise source category stays in the tile tooltip and search text. The core/pack switch, role filter and
smart-finish rows were removed; `smartmaterials.ts` remains in the codebase but is not exposed. `src/decals.ts` +
`public/decals/` hold 20 original CC0 transparent marks; the Decals tab arms one and the Decal tool D places it. A
decal is a `PaintLayer.decal` (`bakeDecal` in `paint.ts`): a tangent projector at the clicked point, front-facing and
depth-limited, baked to BaseColor/Roughness/Metallic so masks, blend modes and export behave like any layer; drag it
on the model to move, or use Size/Rotate/Ink/Rough/Metal under Layers. A purchased 4,981-material Blender pack is
installed locally at `public/materials-pack` (git-ignored, excluded from `dist`): `tools/extract-pack.ps1` runs
`blender-extract.py` over the `.blend` files into `D:\barista-pack-raw`, then `tools/build-pack.py` caches 1K maps
and writes the pack manifest; `tools/pack-thumbs.py` renders the lit PBR sphere previews, and paging handles the size. `node
src/paint.check.ts` covers projection, finish overrides and old-footprint clearing. Next: layer masks, blend modes,
normal / height (and baking from a high poly), packed exports (Unreal ORM, Unity mask map).
