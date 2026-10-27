# Barista

Asset toolset for the Espresso engine pipeline: Poly Doc (topology), UV Magician (automatic UV unwrap), Van Gogh (texture paint). Rust engine + Axum server (`engine/`), React 19 + react-three-fiber + zustand editor (`src/`), Vite, pnpm.
UI follows espresso-level-designer (`../espresso-level-designer`): Photoshop/Spectrum dark shell, tokens in `src/styles/base.css`.

## Commands
- `pnpm server` (Rust engine on :3000, API only) + `pnpm dev` (the editor, only ever at :5173; proxies /api) · `pnpm test` (cargo tests, a few s) · `pnpm build`
- `npx tsc --noEmit -p .` for the frontend. UI changes: verify in the browser at :5173. The user runs both servers in their own Terminal
  tabs ("engine", "editor"): restart the engine tab after engine changes rather than starting preview servers of your own.

## How the unwrap works (engine/src)
UVs are always computed on the real mesh's own triangles, never projected from a proxy (that smears triangles across seams).
`symmetry` a part with exactly one mirror plane is solved on one half and mirrored; a plane placed in the editor (UV Magician's
"Symmetry plane" tool: move/rotate the gizmo, then Apply → `PartIn.symmetry`) is used as drawn — the normal kept, the distance moved onto
the nearest layer of vertices, details with no partner charted once — so a near-symmetric model still gets the mirrored layout.
`mesh` weld + make winding consistent/outward, deterministic `Map`/`Set`; a soup's flat convex triangle pairs are read back as one polygon (`recover_quads`), so no seam runs down a diagonal the file never drew · `region` charts like an artist blocks out hard surface:
per shell a box frame from its big flat faces; smooth simple regions (disk, ring, sphere, torus) stay whole, boxy/tangled ones split into
flat patches labelled by the side they face, Potts-smoothed (ICM: area×(1−cos) vs shared border) so groove walls and bevels stay on
the flank they're cut into · `chart` per chart: closed genus-1 → `torus` (harmonic one-forms, seamless, re-cut to the reduced lattice
cell = rectangle), closed otherwise → cut open, holes → `flatten_slim` (projection start, SLIM without flips or outline crossing) else
seam to another border, disk → `flatten` (LSCM then ARAP, both on a prefactored envelope Cholesky, `Chol`); unfolds flat but overlaps → `carve` (paper-model
regrow on that unfolding into pieces that don't overlap themselves, exact triangle tests; each piece keeps the unfolding, SLIM-relaxed
from there; flipped or too-stretched pieces solved again); clean but stretched → cone-tip seam, and every cut path (`chart::cut_path`) is searched over directed edges with a bend cost (`TURN`: a right angle ≈ 2.5 edges, free where the two edges share no polygon) so a seam follows a loop instead of stepping across one; still bad → `split`, kept only if cheaper than the stretch (`seam_weight`) · `join` hangs islands off each other along shared edges into nets
(Paper Model-style priority: flattest, then longest shared border, then breadth-first from the biggest; no overlap, must stay compact).
Two big islands whose shared border won't hinge rigidly become a book (`chart::book`): spine = the longest straight part of one shared
stretch, the child re-flattened with its spine pinned onto the parent's so it opens on the far side, folds carved off (parent kept ≥97%)
— the grip's flanks open round its top like a butterflied net. A small orphan that won't hang (<3% of the part, e.g. a groove wall
carved off) is filled back: pinned along every shared edge, kept if clean and the pair stays within `tol` · `region` also keeps hidden interior patches (ray cone sees no way out)
out of exterior charts · `pack` squares nets up (a book's spine along an axis), rasterises them and drops each (4 turns) at its
lowest-top spot (xatlas-style), one square per part unless `one_atlas` · `judge` measures the seams themselves on the charts
before `join` — length/√area, share on hidden surface, short dead ends (spurs), staircase turns, seams inside a polygon — as
`Stats.seams`, checked by `tests/seams.rs` and printed by the gun benchmark ·
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
- Van Gogh's shelf is the purchased 4,981-material pack in git-ignored `public/materials-pack`, loaded by
  `src/materials.ts`; the 50-set `public/materials` core is a fallback only. Install with
  `tools/extract-pack.ps1` + `tools/build-pack.py`; `tools/pack-thumbs.py` makes the lit PBR sphere previews.
  Categories are nine visible Material chips, no core/pack, role or smart-finish rows. Decals are
  `src/decals.ts` + `public/decals/` (20 original CC0 marks) baked as `PaintLayer.decal` by `bakeDecal` in
  `src/paint.ts`. The Decal tool selects and transforms (`paint.decalMode` edit / place): a click picks the mark under it
  (`decalUnder`), a click on bare surface deselects it (`paint.decalSel`, hiding the gizmo; Delete with the tool removes the
  layer) — a mark is picked anywhere inside its own outline and the projector's depth, not just the projector's rectangle:
  a curved grip puts the panel's flanks tens of units behind the tangent plane, where a rectangle test made most of the
  mark unclickable — a drag slides it over the surface keeping its plane until the face turns >15° (`dragDecal`), Shift snaps
  it to the model's middle; the gizmo (`DecalGizmo`) keeps screen-sized, camera-facing handle glyphs — middle disc moves, corners scale, side
  bars stretch (the `aspect`), the knob rotates (Shift 15°); a grip shape's outline is its boundary and is drawn on the
  part's surface (`surfaceProjector`), with no projector rectangle beside it; each handle is picked in screen space before
  the canvas (a corner behind the surface still scales, never slides the mark) and the grabbed one turns blue with the
  frame. **Mirror** (`mirrorFrame`): Mirror new at placement, Mirror to other side / Ctrl+M for the selected mark, and
  Unlink (in Decal settings) make or break a linked pair (`Decal.mirror {of, axis}`, editor-only): either half's transform,
  look, opacity or visibility updates both in one undo step, and a Ctrl+J copy is a new mark, not a third side. The keys are
  arrows / `[` `]` / `,` `.` / Ctrl+J (nudge,
  size, turn, duplicate), with typed Width / Height / Rotate in the panel. Placement is a shelf drag, a Decals-tab tile
  click (one placement), or Alt+click — never a stray click. The bake is footprint-indexed (`projectedUVBox` + 
  `footprints`), recompositing only the box a drag changed. The Eyedropper (I) has two modes (`paint.pickMode`): **Materials**
  lifts the clicked part's material layers — fills, solids, generators, bevels (not decals or hand paint) — onto the cursor
  (`grabMaterials`, `paint.grab`): a round chip of the top fill's preview follows the pointer, the target for the options bar's
  Face / Island / Part is outlined on hover, a click applies them (`applyGrab`) — Whole Part replaces that part's material
  layers, a face / island / surface adds them masked there — and Esc drops the stack (`dropMaterials`). Each apply is one undo
  step; the grab is settings only, the pixels bake on the target. **Color** samples base colour, roughness and metallic under
  the pointer. Verify with `node src/paint.check.ts`,
  `node src/decal.check.ts` (pick / deselect / delete through the store), `node src/pick.check.ts` (the Eyedropper's copy)
  and the browser at :5173.
