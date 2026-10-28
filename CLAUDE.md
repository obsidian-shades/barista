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
`symmetry` a part with exactly one mirror plane is solved on one half and mirrored; a plane drawn in the editor (UV Magician's
"Symmetry plane" tool: move/rotate the gizmo, then Apply → `PartIn.symmetry`) is used as drawn — the normal kept, the distance moved onto
the nearest layer of vertices, details with no partner charted once — so a near-symmetric model still gets the mirrored layout.
`mesh` weld + make winding consistent/outward, deterministic `Map`/`Set`; a soup's flat convex triangle pairs are read back as one polygon (`recover_quads`), so no seam runs down a diagonal the file never drew · `region` charts like an artist blocks out hard surface:
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
cone-tip and hole seams follow the cheapest path, searched over directed edges with a bend cost (`TURN`: a right angle ≈ 2.5
edges, free where the two edges share no polygon) so a seam follows a loop instead of stepping across one · `join` hangs islands off each other along shared edges into nets
(Paper Model-style priority: flattest, then longest shared border, then breadth-first from the biggest; no overlap, must stay compact).
Two big islands whose shared border won't hinge rigidly become a book (`chart::book`): spine = the longest straight part of one shared
stretch, the child re-flattened with its spine pinned onto the parent's so it opens on the far side; a pair that still folds stays two
islands (carving the fold off left slits and slivers). A small orphan (<3% of the part, e.g. a groove wall carved off) lying in a notch or
hole of a bigger island (half its outline shared), or a sliver, is filled back before anything hangs: glued along every shared edge (turned
over if wound the other way); if the parent closed the notch up, the orphan and a few rings round it are re-laid (Tutte inside the held ring,
then SLIM, `refill`); kept if clean and the pair stays within `tol` · `region` also keeps hidden interior patches (ray cone sees no way out)
out of exterior charts · `pack` squares nets up (a book's spine along an axis), rasterises them and drops each (4 turns) at its
lowest-top spot (xatlas-style), one square per part unless `one_atlas` · `judge` measures the seams themselves on the charts before `join` — length/√area, share on hidden surface, short dead ends (spurs), staircase turns, seams inside a polygon — as `Stats.seams`, checked by `tests/seams.rs` and printed by the gun benchmark ·
`edit` hand edits: relax, stitch, and `reseam` (a seam toggled in the editor re-solves only the islands it touches, each
fit back onto where it lay at the part's texel density, never the fit's own scale, which shrinks onto a projected shell; a
stitched edge stays stitched: if the solve would cut it open again, the piece is flattened as its seams leave it; the rest, hand
edits and all, stays; only Unwrap/params/knife re-unwrap the whole part; U on a selection and every island of a part seamed by hand
(`manual`, Clear all seams) are Blender's own manual Unwrap, `abf` (a port of `uv_parametrizer.cc`: Fill Holes with polyfill +
beautify, ABF++, angle based LSCM held by the user's pins or its own symmetry / extrema pins, average islands scale; a closed piece is
projected), checked against Blender itself: `blender -b --factory-startup --python tools/blender-unwrap-ref.py -- ref.json`, then
`cargo run --release --example blender_parity -- ref.json [svg dir]` (each island's shape and size within 0.1%); the editor's Align / Pack switches, `afterAlign` /
`afterPack`, then straighten the islands it changed and fit them in, store `tidy`: `src/fitpack.ts` keeps every other island
where it is and puts each changed one back where it lay if clear, else nudged nearby, else at the lowest free spot by its shape;
no room or past 60 ms → the full engine pack, which Ctrl+P always is; check `node src/fitpack.check.ts`) ·
`shapes` the core test shapes · `ideal` the known ideal net per core shape · `lib` pipeline and `check()` ·
`stroke` the Cut tool: `snap` (stroke → nearest edge path, mesh unchanged) and `knife` (cut faces along the stroke-from-eye
plane walk, re-triangulate, new edges as seams; the editor then replaces the part's triangles).

## Projects (`.barista`: `engine/src/project.rs`, `src/project.ts`, `src/save.ts`)
One SQLite file (rusqlite `bundled`): `meta` (format 2, app version, the file's revision, the document JSON) and `blob`
(name → lz4 bytes). A save is a snapshot plus only the blobs that changed: `docOf` captures the document in the tick Ctrl+S
happened (big arrays by reference — the store replaces them on an edit — the in-place hand-edited UVs copied), then
`save.ts` compares each blob's content key with what the file holds and names the unchanged ones in a `keep` list, making
the bytes of the rest a few at a time and yielding between them, so a save never freezes the viewport and the tools stay
usable while it writes (`saving` is the status line; a stroke or slider drag in progress makes the save wait for the
pointer up). The file carries a revision that every save bumps: a save against an older revision is refused (`stale`) and
the editor writes the whole project again, so two windows on one project can never leave it half of each. A save that
replaces the file outright (Save As, the first save, a stale retry) is written beside it and renamed over; an incremental
one updates the SQLite file in one transaction (no WAL, so no side files) and a crash leaves the last good save. Engines
older than format 2 are detected (`/api/project-format`) and sent every blob. The `project-open` pack carries each blob
**as the file stores it** (lz4, `"lz4": true` in its JSON; Gun_Low 97 MB instead of 811 MB, which alone took 3 s to move
into the page) and the editor unpacks each tile straight into its layer (`unlz4` in project.ts, ~2.7 GB/s); it is not
gzipped on top (the JSON routes keep their compression). `load` opens read-only, so a wrong path is never created empty;
a new set starts as the base values (`blank` in paint.ts) instead of a composite pass the open would only redo.
**The composite is saved too** (`SavedSet.comp`, tiles `set/<part>/0/comp_color|comp_orm|comp_normal|comp_height|comp_cov/…`):
opening shows it as saved and composites only sets saved without one (Gun_Low on the RTX: 4.5 s → 2.2 s with the viewport).
It is kept only when `compSettled` (made over the whole stack — a restored stack is `unlaid` until a whole composite —
nothing queued, nothing `dirty`, no live GPU stroke); otherwise the save leaves it out and that set composites on open.
Every write to the composite moves its tiles' stamps (`stampTiles`: composite, bleed, blank), and `docOf` copies only
tiles whose stamp the file does not hold, in the snapshot's tick (the store passes its cache as `reuse`), so a dab saves a
few tiles. ponytail: stamps are per tile, not per map (a colour dab resends that tile's ORM too), and a whole recomposite
resends the set's composite even where bytes did not change (~65 MB raw per 2K part); hash tiles if saves get heavy.
`project-format` must be a POST: sent as a GET it 405'd, so the browser editor took every engine for format 0 and every
save (autosave too) rewrote the whole project. `project-save` takes up to 4 GB (a full save of Gun_Low is ~1.3 GB raw). Opening unpacks the sets first and lays
each stack out with the banded `requestComposite`, so a 100 MB project composites without holding the viewport; the editor
and engine swap a project as a
Pack (u32 JSON length, JSON, then u32 name length, name, u32 data length, data); routes `project-save` (Pack in,
`{path, rev, stale, written}` out) and `project-open` (`{path?, recover?}` in, Pack `{path, rev, doc}` out), Tauri commands
of the same names (raw body / `ipc::Response`; the Pack still stages in 8 MB pieces). The engine shows the Open / Save
dialogs itself (`rfd`), so the browser editor and the app match.
`docOf` / `docFrom` (project.ts) are the store's document: source, unit, params, parts (soup / poly / sides / normals /
uv as blobs, seams and flags in JSON), the engine result (`out/<i>/…`), pins, scene, paint settings, and per part its
texture set's stack (`SavedSet`, paint.ts `saveSet` / `restoreSet`) with each layer buffer as 256 px tiles
`set/<part>/<layer id>/<channel|mask|clip>/<tx>_<ty>` and the part's selection under `set/<part>/0/sel/…`, empty tiles
left out. A buffer's content key carries its own `PaintLayer.ver` stamp, so a colour stroke writes the colour tiles and
leaves the layer's roughness and normal alone, and `tilesOf` reuses one scratch tile so a sparse layer (a decal's
footprint) allocates only its non-empty tiles. Format 2 also keeps the files a project brought with it: an imported material's maps
(`asset/material/<id>/<kind>`), an imported decal (`asset/decal/<id>`), a `.hdr`/`.exr` loaded from disk (`asset/hdri`)
and View › Reference image (`asset/ref`), so a project opens as it was saved without the folders it came from (built-in
pack maps and shipped decals are paths, never copied). Bakes are still not saved — they are derived: the saved generator
pixels show at once, and the first generator edit after reopening bakes the maps again in the background (`editGen`).
Store: `project` (path) and `saved`; any change to parts, uvs, result, uvRev, paintRev, params or resolution clears
`saved` (the title's dot, AppTabs). File › Open project… / Save (Ctrl+S) / Save as (Ctrl+Shift+S) / Recover autosave…;
Open Recent keeps projects by path; saves run one at a time (one staged Pack). Autosave every 2 min when unsaved: into
the project's file, or `%APPDATA%\Barista\autosave\<name>-<pid>.barista` before the first save. Questions are one modal
(`shell/AskDialog.tsx`, store `ask` / `answerAsk`): opening a model asks paint resolution, workspace, sharp edges, One atlas, Join into nets and auto unwrap (`openOpts`, remembered in localStorage;
File › Ask how to open models turns it off; no unwrap = mesh-only stale parts, which Unwrap then does all of), and anything
replacing an unsaved document or closing the window asks Save / Don't save / Cancel (`confirmDiscard`; Tauri `onCloseRequested`,
needs `core:window:allow-destroy`; browser `beforeunload`). A freshly opened model counts as saved (the redraw the
environment map's arrival asks for is not a paint edit); opening frees the previous document's texture sets (their
WebGL textures), resets Unfold, and unwraps the parts Poly Doc left mesh-only, so a reopened project never comes back
with every UV at 0. Opening frames the model by snapping the camera to its bounds (`FitOnOpen`, not drei's animated
`Bounds`: these models sit thousands of units from the origin, and a fit made before the canvas had a size — or one
that only fitted its first layout — left the view pointed at empty space). Real project benchmark: with the engine
running, `node --max-old-space-size=8192 tools/project-bench.ts C:\path\Gun_Low.barista` opens a **copy** (the original is
never written), checks that a save with no edits writes nothing, saves a dab incrementally, and reopens the copy to compare
every colour byte; it prints open / snapshot / prepare / write timings. Gun_Low (100 MB, 7 parts, 2K, 30 layers): open
~0.26 s plus ~1.1 s to unpack in Node; in the editor on the RTX ~2.2 s with a saved composite (4.5 s without; 5.3 s before these changes), a no-edit save 0 blobs in ~2 ms (~60 ms in the browser editor), a dab 4 tiles / 1 MB, its write ~50–90 ms. Check:
`node src/project.check.ts`, `cargo test project`, `tools/project-bench.ts`.

## Texture export (`engine/src/texture/`: `mod.rs`, `layers.rs`, `bake.rs`)
The editor paints at a working resolution (the set's size); File › Export… (Ctrl+Shift+E) is one dialog for both `src/shell/ExportDialog.tsx`
and `src/exporting.ts`: the four presets plus Blender ready, each card saying what it writes (generic = every map and an ORM;
Unreal = DX normal + ORM; HDRP = MaskMap R metal / G AO / B 0 / A smoothness; URP = Metallic/Smoothness; Blender = generic maps
plus the FBX with each part's material linked to its PNGs: `ExportPart.maps` → FBX Texture + Video on DiffuseColor /
ReflectionFactor / ShininessExponent / NormalMap, which Blender's importer wires itself). Its settings are the size (to 16K),
which parts (visible / selected / all), the gutter (padding in texels; Auto = max(4, size/64)) and Triangulate. The Maps tab
and the File menu's quick entries only open that dialog. Exporting saves the project (its file, or the autosave folder before
the first save), then sends `texture-export` a Pack: `ExportReq` (project path, `size`, preset, prefix, part indices, `padding`,
each fill's map URLs and each decal's URL) plus the FBX. The engine reads the `.barista`, and per part at the export size:
`Mesh::owners` (each texel's triangle, paint.ts `raster` with `bordersOf` tolerances, first triangle wins, bands in parallel),
then per texel (rows in parallel) every visible layer: fills (`fill_at`, tri-planar / UV, the material files decoded with
`image`), decals (`DecalFrame::at`), generators (`gen_at` on AO from `Occlusion`: 96 CPU depth maps of the visible parts,
and `Edges` distances) are rendered fresh; hand paint, layer masks and generator clips are the working-res tiles
upsampled (`Up::sample`: bilinear over neighbours on the surface only); a fill / decal whose asset has no file (`blob:`
imports) falls back to its pixels. `Edges` keeps whole edge segments and answers exact point-to-segment distances: sampling
points every `reach/8` made an Edge Wear band narrower than that spacing bead into dots at any texture size (its `width`
is a share of the model: 0.8% by default, 0.4% in the gun5 set) — the dots were world-space gaps, not the UV unwrap. Composite as paint.ts (blends, whiteout normals, additive height), `pad` = paint.ts
`bleed` (the gutter, only off the surface), PNGs (`png`, rows flipped) per preset into a folder the engine asks
for (`rfd`); `texture-status` is the busy line. URLs `/…` resolve under `$BARISTA_PUBLIC` or `public/`. Undo, the live
view and the editor's bake stay at the working resolution; gun5 at 8K: ~90 s, the tab under 1 GB. Test: `cargo test texture`.

## Rules
- `engine/tests/core_shapes.rs` + `ideal.rs` are the spec: cube → Latin cross, cylinder → tin can, cone → sector + disc on its arc
  (all 1 piece, 0% stretch), torus → one seamless rectangle, knot → one strip. The unwrapper must reach these on its own:
  never special-case a shape, never let `ideal.rs` feed back into the algorithm.
- `engine/examples/gun.rs` is the real-model benchmark (testdata/gun.soup): `cargo run --release --example gun -- ../testdata/gun.soup <out_dir>`
  writes per-part PNGs (3D checker views + UV layout); `CHARTS=1` renders the charting alone. Judge those images, not just the numbers.
- Running server locks `engine/target/release`: test with `CARGO_TARGET_DIR=target/check cargo test --release`.
- `src/api.ts` mirrors `engine/src/lib.rs` (Params, Stats, Output): change both together.
- Every user action lives in `src/store.ts`; components only read state and call those.
- The editor works like Blender (left-click select, middle-drag orbit, Alt+middle orbit snap, numpad views, 1-4 vertex/edge/face/island, A / Alt+A / Ctrl+I /
  L / Ctrl+L, Alt+click loop, B box; right click (list) or Q (pie): Cut = make seams, Stitch = join along edges (seams or
  hand tears; with faces selected, Cut takes their outline, Stitch the edges between them); in UV: G/R/S modal with X/Y, typed values, Ctrl snap; P / Alt+P pins, which
  `reseam` holds in place; U unwraps the selection; Live Unwrap lays a pin's islands out as it's dragged). After an auto unwrap every
  island border is a seam (`Part.seams`, clearing one joins its islands); `Part.marked` are the hand-marked ones, all Auto Unwrap keeps.
  3D navigation: the wheel zooms toward the cursor (`zoomToCursor`, `zoomSpeed` 3 ≈ 14% a notch, no distance limits); near / far
  follow the camera every frame (`ClipPlanes`: distance / 500 … distance × 4 + model size × 4), never fixed at framing, so a big FBX
  can be zoomed into without the near plane slicing it; Home / Space recenter to the model, numpad . frames the selection;
  Alt+middle snaps the orbit to 15°.
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
The options bar is the tool's own strip (`shell/Chrome.tsx`): the tool name, then the Mode group — Vertex /
Edge / Face / Island (Poly Doc disables Island: it has no UVs), the icons are the label; Van Gogh's Select-by modes
(Face / Surface / Island / Part) appear only for Select Faces, Bucket and the Materials eyedropper — then the tool's settings. The workspace view
mode lives in the 3D view header (Poly Doc Wire / Smooth / Health = `docView`; Van Gogh Studio / MatCap / Flat =
`scene.lighting`), next to the Shading popover; UV Magician's UV header carries Checker / Stretch / Islands = `mode`,
the Part / All scope, UV options and Fit (UV options opens a dialog anchored under its button: reference map, resolution,
islands). All are mirrored by the Z pie and View › Display, so Z never cycles or means
something else in another workspace.
The Shading popover (`views/SceneSettings.tsx`, in the 3D header, Blender's Viewport Shading): Lighting Studio (lights + environment map) /
MatCap (`src/shading.ts`: spheres drawn on a canvas, no image files: clay, studio grey, red wax, jade, chrome, toon, normals) / Flat
(unlit); Poly Doc Face color (Single / Random per part = `docColor`); Background
Theme / World (the map, `hdriBackground`) / Custom; Options: Backface Culling, Outline (a 1 px silhouette from the
part ids in the Workbench normals pass, not an extra mesh: drei's `Outlines` built a second creased shell that could cover
the surface), Specular, X-Ray + alpha, Shadow + amount, Cavity (world space, `cavityOf`: neighbours' height over each
vertex's tangent plane; Ridge / Valley); Overlays.
`PartMesh` builds one colour attribute (colour mode × cavity) and picks the material by lighting.
All three workspaces share one frame so switching never moves anything (`.space`: a 32 px options bar row that wraps instead of clipping,
then strip | views | panel; UV Magician's bar is `UVOptionsBar`: last strip tool `uvTool`, its Mode group, Unwrap selection,
Live Unwrap; Van Gogh's is `PaintOptionsBar`: the tool's settings and, for the tools that use it, its Select-by modes). File › Open Recent (`src/recent.ts`,
IndexedDB, newest 10 by name): a File System Access handle where the browser has `showOpenFilePicker` (Chromium, WebView2: reread from
disk, permission asked once), else a copy up to 64 MB; a file that can't be reopened drops off the list.
The workspaces: a tool strip on the left (`ToolStrip` in `shell/PolyTools.tsx`; UV Magician's is `shell/UVTools.tsx`: box select,
loop, linked, Cut, Stitch, Pin, Unpin; the one-shot island commands are in the contextual `IslandBar` and the dock's collapsed
sections) and draggable dividers (`shell/Resizer.tsx`, espresso's dock resizer: the panel's width `dockWidth`, and in UV Magician the
3D / UV share `viewSplit`, both kept in localStorage). Poly Doc's panel has the Parts list too (`Parts workspace="doc"`: polygon counts,
no checker toggle). Panels collapse from their headers; Van Gogh pins Layers to the bottom.
Layout (Photoshop / espresso-level-designer): options bar on top (`PolyOptionsBar`: current tool, Mode group, its settings `docOpts` = slide
amount, Limited Dissolve angle, Relax rounds, `fixNote`), tool strip on the left (`PolyToolStrip`, `shell/PolyTools.tsx`:
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
eraser stay inside; document-wide like Photoshop's (`selectDoc`: replacing it empties every other part's), shown as a selection
(`shade`: orange tint and border inside, black outside; an overlay mesh in 3D, drawn over the texture). Tools (Photoshop keys): Marquee M / Lasso L (on the model:
screen shape, only what's seen, `depthOf`; in the texture view: UV polygon; a click deselects), Select Faces W, Bucket G
(both take Face = the file's polygon / Island / Part, options bar), Brush B, Eraser E, Eyedropper I (and Alt+click with
Brush / Bucket). The Eyedropper's `pickMode` is **Materials** — a click lifts the clicked part's material layers (fills,
solids, generators, bevels; not decals or hand paint) onto the cursor (`grabMaterials`, `paint.grab`; a round chip of the top
fill's preview follows the pointer and the target for the options bar's Face / Island / Part is outlined on hover), and the
next click applies them (`applyGrab`): Whole Part replaces that part's own material layers, a face / island / surface adds
them masked there; Esc drops the stack (`dropMaterials`), and each apply is one undo step — or **Color**, which samples
base colour, roughness and metallic. Shift adds, Alt takes away; Ctrl+click picks the part (opens it in the Parts tree), and painting a part makes it the active one. The texture view's Part / All changes only from its own buttons (an atlas model opens in All); in a shared atlas each part's set draws clipped to its own triangles, a click goes to the part under it, and a Brush / Eraser stroke there paints every part in the square (`atlasMates`, one undo step, CPU path). Ctrl+A select all,
Ctrl+D deselect, Ctrl+Shift+I invert, Alt+Backspace fill selection (no selection: the layer), Delete clear, Ctrl+J duplicate,
Ctrl+Shift+N new layer, Ctrl+[ ] move layer, [ ] brush size, Ctrl+Z / Ctrl+Shift+Z (20 steps across sets, copy-on-write
layers; a step undone is kept for redo, a slider's step is taken by its first change, not its pointerdown, and a
selection step shares the layers — an island pick is document-wide, so it must not copy every part's buffers). A dab on
the model is a world-space sphere (triangles near it rasterised in UV), in the texture view a texel circle (size % of the
texture); each texel takes a dab once (strongest weight) so triangle edges never show, and paint bleeds 1.5 px only across
UV borders (`bordersOf`), so a face fill stops exactly at its edges inside an island. Panel (Layers tab): Texture sets as a list of pictures of each part in its paint (`matview.partShot`, Parts paint mode), then the layers, the selected layer's opacity / blend / fill / decal / generator settings unfolded under its row (click it again to fold). Parts tree (collapsible,
`paintOpen`; channels under each, click one to see it in the texture view), Layers as Photoshop's (opacity on top, rows
with eye + thumbnail, drag to reorder, double-click renames; Fill / Duplicate / New / Delete along the bottom), pinned
to the bottom of the dock; the Blend row edits the blend of the channel being viewed (`paintChannel`), as Substance's
stack does: each channel keeps its own mode (`PaintLayer.blend` per channel; `DEFAULT_BLEND` normal for colour / rough /
metal, height **adds** around mid grey, normals always the whiteout combine, so its select is disabled). The brush starts
on Base Color alone (`paint.on`), so a colour stroke leaves the material's roughness and metallic under it; tick Rough /
Metal in the options bar to paint those too. Export is the engine's (see `## Texture export`), never the browser's. Painted texels don't follow a re-unwrap;
One atlas parts each still get their own set.
Solid fill (layer bar square, `addSolidFill`): a fill whose asset is `SOLID` (paint.ts), no maps, colour = tint plus its roughness /
metallic, editable later; the engine's `fill_at` draws it the same (`plain`). New fills, solids, decals and sheens go in under the
generators above the active layer (`insertAt`). **All sets** (Layers bar, `linkSets`): adds go to every visible part and fill / generator /
opacity edits go to the same-named layer on each (`matesOf`, made active so the undo step copies it). Generators bake a part with no
mesh maps first. Select by **Surface** (`surfaceTris`: flood up to edges bent > angle and < 2× angle from the clicked face), Select ›
Grow / Shrink (Ctrl+Shift+= / -, `growSelection`, texel space). **Mirror tool** (strip, Ctrl+M; `mirrorHover` / `mirrorPress`, `MirrorPreview`): a click on a mark picks it; hovering shows its mirrored copy's outline where a click would put it — within reach of the spot symmetric to it across the model's middle on X, Y or Z it snaps there (solid; `mirrorFrame`: the point reflected onto the nearest triangle facing the reflected way, up reflected, rotation negated, `flipH` toggled, so it is the mirror image), elsewhere it lies under the pointer (dashed); a click places it as its own layer with the same settings (nothing linked) and hands over to the Decal tool with the copy selected. `decal.check.ts` pins the snap and the reflected frame.
**Bevel** (Maps › Generators › Bevel, `addBevel` / `editBevel`; `PaintLayer.bevel`): a whole-part bevel faked in the Normal map: within Radius of every edge sharper than Angle (concave ones when ticked) the face's normal leans toward the face across, a fillet's angle at that distance (Round) or the halfway turn (Chamfer); leans from several edges add, so corners round both ways (`bevelEdges` / `bevelNormal` / `bakeBevel`; engine `layers::BevelSrc`, rendered fresh at the export size; tests `paint.check.ts` and `bevel_matches_the_editor` pin 30° at half the radius, 45° chamfer). No bake needed; it uses the part's flat face normals, so it wants Smooth within Sharp edges. **Engrave** (`Decal.engrave`) bends the normal along the ink's edge and lowers the height, in the engine too
(`DecalFrame::at`). **Grip textures** (Decals › Grip, `GRIP_SHAPES` in decals.ts): decals with a `Decal.shape` and no image —
a rounded panel, an optional groove border and a pattern inside (stipple / grooves / checkering / none), sizes in world units
(shares of the model on the shelf), so stretching a panel never stretches its dots; `bakeShape` writes Normal and Height, and with
the layer's **Colour** ticked (`channels` gains color / rough / metal) also the mark's tint / roughness / metallic inside and
`Decal.rim`'s on the border band (`onRim`; Own border, finish presets Rubber … Bare metal; engine `on_rim` the same),
the shelf shows them as one Grip texture tile, the preset picked in the layer's settings (`setGripPreset`: only pattern, cell, height and border change, never the mark's place, size or outline); Fit to faces / Fit to part (`fitDecal`) wrap the pattern alone (no border or outline) over the faces picked with Select Faces or the whole part, the faces as the layer's mask; the engine's `DecalFrame::shape_at` / `shape_height` the same (test `shape_relief_matches_the_editor` pins them to the editor's
numbers). The shallow relief a sculpt-and-bake would give, placed and edited like any mark. **Reliefs** (Geometry tab, `RELIEF_SHAPES`): one tile per tool, the variants
are its settings (`RELIEF_SLIDERS`, profile / head / drive selects, VanGogh.tsx `ReliefSettings`); more `Shape.pattern`s on the
same layer, bake and engine path (`shapeHeight` / `relief`, pinned point by point in `relief_kinds_match_the_editor`). Lines run along
the outline as a polyline (`Shape.closed` joins it; `border` = width): `groove` (`profile` round / V / square / chamfer), `bead` (a
weld, crescent ripples), `stitch` (slanted thread dashes in a channel), `rivets` (a head every `cell`, each turned to the line),
`scratch` (a V with burred lips, tapered, its depth broken up by `vnoise`). `fastener`: one head (`head` dome / pan / countersunk /
socket cap / hex bolt, `drive` slot / Phillips / Pozidriv / Torx / hex / square, `washer`). `pad`: raised or, below 0, pressed in,
over a `profile` edge. **Draw** (`decalMode`; arming a line enters it, a pad or grip panel can too): clicks lay corners, a drag
lays freehand points, a click on the first point closes it, Enter / a quick second click on the last point / the bar's Finish
ends it, Backspace / Esc (`drawPress`, `finishDraw`, `undoDrawPoint`, `cancelDraw`; `DrawnLine` shows corners and a rubber band);
`finishDraw` frames a wrapped decal at the line's middle, stores each corner where it lands on `expMap` (`mapAt`), Douglas–Peucker
thins freehand runs; a panel or pad is always its closed outline; drawn lines aren't mirrored. `expMap` / `exp_map` seed on the
triangle the centre lies on (`triDist`: by summed corner distance a small triangle beside a big face won and nothing baked). The
slope is never sampled finer than half a texel of the triangle (`texelSize` / `texel_sizes`), so hard rims don't alias. Previews:
`reliefSphere` (decals.ts) draws the relief over a lit sphere in its own coordinates — the shelf tiles and the layer's live
`ReliefPreview`. Each starts 30% of the
model tall (`DecalAsset.size`). **Outline** (`Shape.outline`, corners as shares of the half width / height, None = the
rectangle): the Decal gizmo shows a handle per corner (drag over the decal's plane), a + per edge (adds a corner) and
Alt+click removes one; every corner is rounded by `corner` into a short arc (`filleted`, then `polySd`). **Wrap**
(`Decal.wrap`): instead of the flat projector the shape follows `expMap` — a discrete exponential map (Schmidt, Grimm &
Wyvill 2006): the soup welded, the triangle nearest the centre seeded flat, Dijkstra outward with each step turned into the
reaching vertex's tangent plane and its frame carried by the least rotation between normals — so a strip bends over a
bevel or round a back strap without stretching; the engine's `exp_map` does the same steps (test `wrap_map_unfolds_a_fold`:
a 90° fold unfolds exactly). Edits go to the active decal. Layer runs of 3+ decals fold into one row. View › Reference image… floats a picture over the 3D view
(`views/RefImage.tsx`; kept in the project as `asset/ref`). `saveProjectTo(path)` saves without the dialog (scripts). A
save that writes the whole file (Save As, the first save, a stale retry) writes `<file>.saving` then renames; an
incremental one updates the SQLite file in place; errors name the file and folder; autosaves are per process
(`<name>-<pid>.barista`).
Color panel on top of the dock (`panels/ColorWheel.tsx`, Affinity's): hue ring (clockwise from red at the right) round
an HSV triangle (tip the hue, white, black), swatch, eyedropper, H S L, hex, Flow; the dock scrolls (`.paintdock`).
Every other colour field is `ui/ColorPick.tsx` (never `<input type="color">`, which opens the OS dialog): a swatch opening Photoshop's picker as a top-layer popover (over the Scene popover) — saturation / brightness square, hue strip, hex (3 or 6 digits), R G B and H S B, the screen eyedropper, presets + the store's `recentColors`; new / original halves (click original to go back); Escape restores, Enter or a click away keeps; `onStart` takes the undo step (`beginPaintEdit`) before the first change.
GPU composite (`src/gpucomp.ts`): any composite box of 256² or more (undo, opacity, visibility, blends, fills, generators, a stroke's commit) runs as shader passes, one per layer per channel in a float target (full-width bands, ~1024² a band), each layer's region uploaded into a reused scratch texture with `texSubImage2D` (three's update ranges only do RGBA), read back into the set's composite arrays (straight in when the box spans whole rows), so undo, save, export and every reader are unchanged; within 1 level of the CPU composite (rounding). A new viewport renderer drops its targets. Node and GPUs without float targets keep the CPU path. 2K, four PBR layers: ~300 ms in the software-GL pane vs ~3 s on the CPU.
GPU bakes (`src/gpubake.ts`): the per-texel loops run as shader kernels on the viewport's renderer (`gpuBake`: bands of 1024² texels, float inputs per texel, one pass per output, byte or float readback into the same CPU arrays): fills tri-planar (`TRIPLANAR`, per-triangle `triFrame`) and UV (`UVFILL`), generators' coverage (`GENERATOR`), the bevel (`BEVEL`: edges and their cell grid as an open-addressed table, `cellTable`; the first of two recorded triangles that leans wins), and the bake's AO (`AO`: 32 views' depth maps a chunk in one float atlas) and edge distances (`EDGES`). The CPU keeps rasterising (`raster`: same seam / crease coverage) and only records each texel's point and triangle; its loops stay the reference and Node's path. The generators' noise lattice hash is integer (`hashu`, the same in paint.ts, the shader and the engine's `layers::hashu`, pinned in `paint.check.ts` and `hashu_matches_the_editor`); the grip stipple keeps the old sin hash. Within 1 level of the CPU (AO within 0.03); RTX 4070 at 2K: bevel 6.3 s → 0.4 s, generators 0.7 → 0.25 s, UV fill 0.7 → 0.16 s, tri-planar 2.5 → 0.5 s, the bake 10 s → 1 s. A tri-planar fill's normal is the face normal plus each plane's detail along that plane's tangent / bitangent (UDN), so a flat map bakes (0, 0, 1) and the mesh's smooth / weighted shading survives; summing the planes' whole normals bent non-axis faces up to ~20° into facets (`paint.check.ts`: a flat map keeps a tilted face; engine `fill_at` the same). Check: open `/src/gpubake.check.html` on the dev server in a browser with a GPU (title ends ok / FAIL). Still CPU: decal and grip-shape bakes (footprint-sized), selection grow, the stroke replay, the engine's export.
GPU brush (`src/gpupaint.ts`): a live stroke is stamped into a render target the model shows directly, then replayed on the CPU on release; it takes the plain brush, strokes inside a selection (the mask as a texture) and the eraser on the bottom colour layer (painted toward the unpainted base), and the texture view reads it back shrunk to 512 on the GPU. Fill / decal masks, blends, layers above and atlas strokes stay on the CPU.
Brush cursor (Substance's): on the model two rings on the face under the mouse (`BrushCursor`: dashed = the dab's
reach, solid = hardness), in the texture view CSS rings at the mouse. Bake (`src/bake.ts`, Mesh Maps panel, every visible part,
every part occluding the others): AO the GPU way, the model's depth from 96 directions (orthographic, an offscreen
renderer), per texel the cosine-weighted share of its sky seen (texel point + face normal from `surfaceOf`, lifted 1.5
depth texels); edge maps = distance to the nearest sharp (> 20°) convex / concave edge over its strength, each edge a
whole segment in a reach-sized grid (not sampled points: an Edge Wear band narrower than the old reach/8 sampling beaded
into dots). Material view (Substance's, `src/matview.ts`; Shift+right-drag turns the light, `turnLight`, its own `lightRev` so the document stays saved; a floor catches the sun's shadow, Shading › Shadow (`scene.paintShadow`) turns that cast shadow and the floor off; Shading › **Lift** (`scene.paintLift`, on = 0.4, off = 0 and the true studio) is a work light (`matview.fillOf`): a second sun opposite the key, low so tops don't clip, and the plate ×1.6, so both sides are lit and still shade by where they face (glowing the base colour instead flattened the model and washed out the lit side); Background › World shows the plate): in Studio lighting with no plate, Van Gogh lights the model by a bundled
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
tri-planar fill layer. The shelf's **Blend over paint** (store `paint.fillBlend`, `setFillBlend`) is the Base Color blend
new fills come in with: Normal covers what is below (a new base), Multiply / Overlay tint it; it also switches the active
fill right away and sticks, and picking a Base Color blend on any layer (`setLayerBlend`) sets it, so layering textures
over a colour does not mean adding, then walking back to the Layers panel. A fill over an empty set still comes in Normal.
Browse is nine visible **Material** chips (Metal, Wood, Stone & Masonry, Tile & Ceramic,
Concrete & Ground, Fabric & Leather, Polymer & Carbon, Organic & Food, Other) plus search, infinite scroll and **All parts**;
tiles (811) have their own **Tiles** tab instead, chips by kind from the name (`TILE_KINDS`: Hex, Roof, Terracotta…);
search and chips stay sticky over the grid (`.matsticky`); the precise source category stays in the tile tooltip and search text. The core/pack switch, role filter and
smart-finish rows were removed; the smart-material recipes were deleted. Cerakote and Anodized Metal head the shelf
(`FINISHES` in `materials.ts`: the pack's painted / silver metal PBR maps under the finish's name). Cerakote is `colorless`:
no base colour map, only the coating's roughness / normal / height, so its colour is the fill's tint on white (a new one
starts in the paint colour; grey tile). A fill with no colour map (solid or colorless) is white × tint, editor and engine (`fill_at`).
The Layers bar's Metal sheen (`addMetalLayer`) adds a layer filling the selection with Metallic 1 / Roughness 0.25 only. `src/decals.ts` +
`public/decals/` hold 20 original CC0 transparent marks, plus the grip shapes. A decal is a `PaintLayer.decal`
(`bakeDecal` in `paint.ts`): a tangent projector at its point, front-facing and depth-limited, baked to
BaseColor/Roughness/Metallic so masks, blend modes and export behave like any layer. The Decal tool **selects and
transforms**, it does not stamp: `paint.decalMode` is `edit` (the tool and D) — a click picks the mark under that point
(`decalUnder`, the top layer, its own facing): anywhere inside its own outline and the projector's depth, not only the
projector's rectangle — a curved grip's panel lies tens of units behind the tangent plane, where a rectangle/0.4% test
made most of the mark unclickable — and a click on bare surface (or the empty view) deselects
(`paint.decalSel`, so the gizmo and the Decal actions go) — or `place`, which
one click puts the armed mark there and then returns to edit (a tile clicked in the Decals tab arms one; Alt+click always
places, and a tile dragged onto the model places it too). The active mark's frame is always drawn (`DecalGizmo`), with
handles while the Decal tool is on, all sized in screen pixels (`px` from the camera distance) and billboarded so each
glyph faces the view (a square is a square from any angle, never a foreshortened sliver): the middle disc slides
it over the surface, corner squares scale, the side bars stretch one axis (the `aspect` the engine already reads), the
knob turns it (Shift 15°), and a grip shape's outline has its own corner + / Alt+click handles. A shape's boundary is
that outline: it is drawn on the part's surface (`surfaceProjector`: a ray along the projector's normal, or the nearest
surface point when the ray misses) and the projector's rectangle is not drawn beside it — on a curved grip the two did
not agree, which read as a second, misfitting outline; the knob and the scale square sit on the outline's own box, and a
corner drag moves by the pointer's delta so a dot on the surface does not jump. The handles are picked
in screen space before the canvas sees the pointerdown (`decalHandles.hit`, captured on the canvas's parent), so a
corner whose pad sits behind the surface still scales instead of starting a slide of the whole mark; the one being
dragged turns blue with the frame (`GRAB`). A drag keeps the
projector's own plane while the pointer stays on one face and only turns onto a new one when the surface turns more
than 15° (`dragDecal`) — re-deriving it from every triangle made the mark spin and jump; Shift snaps it onto the model's
middle across the face it lies on (`snapMiddle`, and the Center button), Face turns it onto the surface under it
(`alignDecal`). The keys: arrows nudge across its plane (Shift far, Alt fine), `[` `]` size, `,` `.` turn 5°, Ctrl+J
duplicates it nudged (`duplicateDecal`), and Width / Height / Rotate are typed fields as well as sliders. Flip H / Flip V
(`Decal.flipH/flipV`, mirrored in the engine's `DecalFrame`) and ±90° sit in the options bar and under Layers. The bake
works only inside the mark's texel footprint: `projectedUVBox` clips each triangle to the projector's box and carries it
back through its barycentrics, so a live drag re-inks its own box, clears last bake's box and recomposites just that
(`footprints`; `composite(..., pad=false)` during a drag, one full pass 160 ms after it stops, `settleDecal`). Bucket /
Wand hover and a material dragged from the shelf
onto the model tint and outline what they'd take (`paintHover`, `paintHoverAt`: Face / Island / Part); the drop fills it
masked to that (`assignMaterial(id, false, onto)`). The shelf drag is a pointer drag (`holdTile` in VanGogh.tsx: the ball
follows the pointer as `.matghost`, Esc cancels, a press that doesn't move stays a click), not HTML drag-and-drop, which
the Tauri window takes on Windows; the 3D view raycasts the screen point itself (`shelfDragOver` / `shelfDrop`, `Picker`).
Decal tiles drag the same way (`decalDragOver` / `decalDrop`): over a face turned toward the camera the mark's frame shows
where it lands at the next mark's size and rotation (`DecalPreview`), and letting go places it (`dropDecal`, Decal tool on). A purchased 4,981-material Blender pack is
installed locally at `public/materials-pack` (git-ignored, excluded from `dist`): `tools/extract-pack.ps1` runs
`blender-extract.py` over the `.blend` files into `D:\barista-pack-raw` (marked assets only, with their catalog; the
full name from the maps' file stem when Blender cut it; DirectX normals where an unmuted "Normal Inverter" group sits on
the way, flipped to GL at build; the Mapping scale as `scale`, a new fill's tiling; constant Principled inputs as 4 px
maps; opacity), then `tools/build-pack.py` caches 1K maps
and writes the pack manifest; `tools/pack-thumbs.py` renders the lit PBR sphere previews, and infinite scroll (an IntersectionObserver sentinel) handles the size. `node
src/paint.check.ts` covers projection, finish overrides and old-footprint clearing, per-channel blends and their defaults,
undo/redo, and the height stack; `node src/decal.check.ts` the Decal tool's pick: a click on a mark selects it, bare surface
deselects it (layer untouched) and Delete takes the layer out; `node src/pick.check.ts` the Eyedropper's Material grab and apply
(fills, solids, generators and bevel held on the cursor, applied whole-part or masked to an island, decals and hand paint left
behind, one undo step each, Esc dropping it); `node
src/paintundo.check.ts` drives the store's own undo against a stroke that starts
before the banded composite finishes. Next: layer masks, groups / passthrough, normal / height (and baking from a high poly),
packed exports (Unreal ORM, Unity mask map).
