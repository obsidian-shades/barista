# Van Gogh painting performance

Measured in headless Edge on the 28,741-triangle gun (10 parts, 117 islands), 1K and 4K texture
sets, CPU compositing. Numbers are wall time for a 10-move stroke, including the 20 ms pause
between moves; subtract ~200 ms for the gesture itself. Treat them as relative, not a benchmark of
another machine.

## What was slow

The first profile of a 1K stroke showed one clear offender:

| Function | Share of the cold stroke |
| --- | --- |
| `ensureShell` | **612 of 1,557 samples** (~306 ms) |
| `composite` | 36 samples |
| `raster` / `dab` | 59 samples |
| `bleed` | 24 samples |

`ensureShell` rasterised every UV triangle into an n×n mask on the CPU. It is cached per UV array,
so only the first stroke on a part paid it — but at 4K the mask is 16× larger and the first stroke
was several seconds. `bleed` (mip padding) then ran on every dab, and the whole DataTexture was
uploaded to the GPU on every dab, even for a small stroke.

Baking was worse structurally: it baked **all visible parts** in one `task`, each at 96 depth
directions. A 10-part 1K bake took ~91 s and blocked the main thread for up to 1.6 s at a time.

## Changes

### Shell mask on the GPU

[`src/uvshell.ts`](../src/uvshell.ts) renders the UV triangles once into an n×n render target and
reads the mask back; `ensureShell` falls back to the CPU rasteriser when WebGL is unavailable
(Node checks, old browsers). The 306 ms CPU pass disappeared from the profile; the shell is now a
render plus a readback.

### Only the painted channels

`composite(..., only)` takes the channels a brush actually wrote. Painting Base Color no longer
recomposites Roughness, Metallic, Normal and Height on every dab. The normal/height loops are
skipped entirely when their channels are not in `only`.

### Dirty-rectangle texture uploads

For a live dab, `composite` uploads only the dirty rows using three.js
`DataTexture.addUpdateRange()` (the same mechanism three uses for partial buffer updates). At the
end of the stroke, `bleedAll` uploads the padded region once. This removes the 4K full-texture
upload from the per-dab path.

**Ranges accumulate until the draw.** three uploads every pending range on the next render and only
then clears them, so `composite` must *add* to the list, never clear it per call: while a banded pass
(undo, layer edit, GPU commit) runs, a `clearUpdateRanges()` in every band discarded all the bands
before the last one, and the GPU kept an older patchwork while the CPU texture was correct — the
"texture corrupted itself after painting and Ctrl+Z" look (a stroke landing only in some rows, an
undo leaving part of itself on screen). `bleedAll` adds its padded box to the pending ranges too,
and asks for one whole-texture upload only when that box is the whole texture.

### Mip padding once per stroke

`bleed()` is no longer called by `lay` on every dab. `paintEnd` calls `bleedAll`, which uses the
stroke's accumulated dirty rectangle (plus the mip pad) instead of flooding the whole 4K texture.
`fillTris`/`fillAll` still pad immediately, since they are one-shot operations.

### Live redraw, cheaply

- `paintLive` is a throttled counter (one `requestAnimationFrame`) separate from `paintRev`.
  `PartMesh` repaints the 3D view; `UVView` redraws the texture view.
- During a live stroke the texture view shows the painted channel from its `DataTexture`, not the
  lit material offscreen render. The material render happens once at stroke end.
- The checker canvas is `useMemo`'d instead of rebuilt on every redraw.
- `canvasOf` can render a **preview size** (1K) while export still reads the full resolution.
- `materialCanvas` caps its offscreen render at 1K: it is displayed in a ~500 px square, so
  rendering a 4K lit preview only to scale it down was wasted work.

### Non-blocking undo and layer edits

Undo used to restore the layer and then run a full **5-channel 4K composite** plus `shade()` in
one synchronous call. Opacity changes were worse: every slider event recomposited the whole 4K set.

- `keep()` now records the affected `undoRect`; `undo()` restores the layer instantly and
  `requestComposite` recomposites only that box in 64-row bands.
- Full layer changes (opacity, blend, order, add/delete) go through the same queue, also in bands.
  Requests **merge** into the pass already running instead of cancelling it: a cancelled pass used
  to leave the part of its box it had not reached showing the older layer state, which is what a
  Ctrl+Z followed immediately by a stroke (or a second Ctrl+Z) looked like: a texture with a
  half-undone stroke still on it. A merged request composites the union of the boxes asked for.
- Undo also keeps the state it took back (`TexSet.future`), so Ctrl+Shift+Z / Ctrl+Y redo a paint
  step; a new step starts a new history. A slider takes its undo step on its first change, not on
  pointerdown, so clicking a slider without moving it leaves no empty step.
- A selection step shares the layer stack instead of copying it: an island pick is document-wide, so at 4K it used to
  copy every visible part's active layer (hundreds of megabytes) per click, which is also where a mid-step allocation
  failure could leave the history half pushed.
- The GPU stroke commit pads like a CPU stroke (`bleedAll` after its one composite), so both paths end the same way.
- The layer panel gets a cheap `paintPanel` tick so the slider readout updates immediately; the
  3D/texture views update when the recomposite finishes.
- Measured at 4K, 20 opacity changes: **max main-thread gap 77 ms**, none over 200 ms, panel stays
  interactive. Undo completes in ~0.3 s but the longest main-thread gap is **~89 ms**, with no
  sample over 100 ms; the UI is never fully blocked.
- The GPU stroke commit is async too: the preview stays on screen until the CPU replay and its
  single composite finish (~0.6 s at 4K for 20 dabs), so releasing the mouse does not freeze the
  editor.

### GPU live preview

[`src/gpupaint.ts`](../src/gpupaint.ts) adds a WebGL2 brush preview. It uses the **same renderer** as the
viewport, stamps the live dabs into a render target (initialised from the current composite by
`copyTextureToTexture`), and the model samples that target directly. No cross-API copy, no CPU
compositor in the pointer path.

- The authoritative layer pixels still live on the CPU. On release the recorded points replay once,
  then the real composite/undo/export run.
- 4K, 20 pointer moves: **173 ms total (~8.6 ms/move)** including CDP; 1K is ~7.8 ms.
- The one-time commit after release is **~0.4 s at 4K for 20 dabs** (CPU replay + one composite).
- Only normal-blend, color-capable paint layers take the GPU path; fills, masks, erasers, selections
  and chips use the CPU path unchanged.
- The 2D texture view reads the GPU target back at ≤2K; at 4K it updates at commit, while the 3D view
  is live.

### Bake: active part, chunked

- `Bake mesh maps` now bakes the **active texture set** (7 s for the 1K gun part in the test), with
  every visible part casting occlusion. `All parts` is the explicit slow button.
- `surfaceOf` has an async chunked variant used by the bake; `edgeDistances` and the bake's AO
  normalisation yield between chunks; `eachView` yields every two directions.
- The measured main-thread gap during an active-part bake is **≤ 117 ms** (no sample over 200 ms)
  instead of 1.6 s.

### Dock layout

Van Gogh's right dock keeps **Color permanently at the top** and puts **Layers / Materials / Maps**
in tabs below it, instead of a vertical stack of Materials, Color, Parts, Mesh Maps and a pinned
layer panel. Layers has a compact texture-set dropdown; the full Parts tree is a collapsed section
below the layers. Materials gets the full tab height for the shelf, and Maps holds bake plus the
export preset.

## What remains

- **The CPU fallback is still ~90–100 ms per move at 4K**; the GPU preview is the fast path, but it
  only covers normal-blend color strokes. Full GPU layer compositing (all channels, masks, blend
  modes) is the next step; the current release does a one-shot CPU commit (~0.4 s at 4K for 20
  dabs).
- **The 2D texture view is live up to 2K.** At 4K it updates on release; reading a 4K target every
  frame is slower than the view is worth.
- **Bake is ~7 s per part** at 1K (96 directions). The future Bakery tab should batch the depth
  views across parts (currently each part renders the same 96 views again), bake low→high, and
  expose normal/AO/curvature/position/thickness. That is the dedicated-tab work we paused.
- **All-parts bake** is still ~70 s for 10 parts; it is now an explicit secondary button.
- **The Rust engine is not in this path.** Unwrapping is Rust; painting, compositing, texture
  upload and baking are all the React/three frontend. The server only supplies the UV result.

## Reproduce

The profile was taken with Chrome DevTools Protocol `Profiler` (500 µs sampling) around a synthetic
mouse drag over the 3D view; the bake test instrumented `setInterval(50)` and read the maximum gap.
The scripts were throwaway (not part of the repo); a future performance check can live beside
`src/paint.check.ts`.
