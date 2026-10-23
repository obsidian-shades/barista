# Auto Unwrap

Automatic UV unwrapper. Rust engine + Axum server (`engine/`), React 19 + react-three-fiber + zustand editor (`src/`), Vite, pnpm.
UI follows espresso-level-designer (`../espresso-level-designer`): Photoshop/Spectrum dark shell, tokens in `src/styles/base.css`.

## Commands
- `pnpm server` (Rust engine on :3000, API only) + `pnpm dev` (the editor, only ever at :5173; proxies /api) · `pnpm test` (cargo tests, a few s) · `pnpm build`
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
from there; flipped or too-stretched pieces solved again); clean but stretched → cone-tip seam; still bad → `split`, kept only if cheaper than the stretch (`seam_weight`) · `join` hangs islands off each other along shared edges into nets
(Paper Model-style priority: flattest, then longest shared border, then breadth-first from the biggest; no overlap, must stay compact).
Two big islands whose shared border won't hinge rigidly become a book (`chart::book`): spine = the longest straight part of one shared
stretch, the child re-flattened with its spine pinned onto the parent's so it opens on the far side, folds carved off (parent kept ≥97%)
— the grip's flanks open round its top like a butterflied net. A small orphan that won't hang (<3% of the part, e.g. a groove wall
carved off) is filled back: pinned along every shared edge, kept if clean and the pair stays within `tol` · `region` also keeps hidden interior patches (ray cone sees no way out)
out of exterior charts · `pack` squares nets up (a book's spine along an axis), rasterises them and drops each (4 turns) at its
lowest-top spot (xatlas-style), one square per part unless `one_atlas` ·
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
