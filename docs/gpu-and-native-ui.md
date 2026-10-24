# GPU compute and native UI: what is possible for Barista

**Short answer:** yes, the app can use the CPU and GPU much harder — but **not CUDA from the
web UI**. The practical path is a GPU painter in the existing frontend, optionally a native Rust GPU
sidecar later, and only then a native UI if measured input/latency/memory limits demand it.
Rewriting the UI is not what makes painting fast.

**Shipped:** a first GPU live preview lives in [`src/gpupaint.ts`](../src/gpupaint.ts). It is WebGL2
because the viewport is three.js/WebGL, so the brush render target can be sampled by the model with
no cross-API copy. Live color strokes are ~8 ms/move at 4K; the CPU path remains the fallback and
the authoritative layer/undo/export store. Raw WebGPU and full GPU layer compositing are the next
backend step.

---

## 1. CUDA in a browser / WebView

A browser page — including the Tauri WebView2 window — has no CUDA driver access. JavaScript
cannot load `cuda.dll`/`libcuda.so`, launch kernels, or allocate CUDA memory. WebAssembly does
not expose the GPU either. The only GPU APIs a page gets are **WebGL** and **WebGPU**, and the
browser's GPU process owns them.

- MDN describes WebGPU as the successor to WebGL with first-class **GPGPU compute**, but it is
  exposed through the browser's own abstraction over Direct3D 12 / Vulkan / Metal — not CUDA.
  ([MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API))
- `cuda-wasm` exists on npm, but it is an experimental source-to-WebAssembly/WebGL-style
  translation project, not a way to run CUDA binaries or use the CUDA runtime in production.
  ([cuda-wasm](https://www.npmjs.com/package/cuda-wasm))
- Tauri does not add GPU APIs to the WebView. Its WebGPU story is “whatever the installed
  WebView2/WebKit provides”; the Tauri issue about enabling WebGPU was closed, with WebView2's
  own Chromium support being the relevant path.
  ([tauri#6381](https://github.com/tauri-apps/tauri/issues/6381))

So: **CUDA is a native-process technology.** It can exist in Barista’s Rust process, a sidecar,
or a native viewport — not inside the React page.

## 2. What the web can do today

### WebGPU

WebGPU gives you compute shaders, storage textures, render pipelines and lower CPU overhead than
WebGL. It is the right API for a GPU painter:

- brush stamping into layer textures,
- layer compositing and blend modes,
- normal/roughness/metal/height channels,
- bake passes (AO, curvature, thickness),
- readback only when exporting or making an undo snapshot.

Availability is the caveat. MDN still marks WebGPU “limited availability” rather than Baseline;
Chrome/Edge have shipped it, Safari/Firefox support is newer, and a Tauri app inherits the
WebView2/WebKit runtime on the machine. The app should feature-detect `navigator.gpu` and keep the
CPU path as fallback. ([MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API))

WebView2 is Chromium-based, so WebGPU availability follows the installed WebView2 runtime. Tauri
doesn’t enable experimental browser flags for you; if a machine’s runtime lacks WebGPU, that is a
deployment constraint to test, not something the Rust side can patch into the page.

### WebGL

WebGL2 can do brush rendering and some compositing, but it lacks compute shaders and storage
textures. It is a fallback for older runtimes, not the target for a Substance-class painter.

## 3. What native GPU gives you

A native Rust process can choose:

| API | Vendor | Use |
| --- | --- | --- |
| **wgpu** | NVIDIA, AMD, Intel, Apple | Cross-platform compute/render over D3D12, Vulkan, Metal. Best default for a portable engine. |
| **CUDA** | NVIDIA only | Maximum NVIDIA performance, CUDA libraries, OptiX, cuDNN, custom kernels. |
| **HIP/ROCm** | AMD | AMD equivalent, Linux-heavy. |
| **Metal** | Apple | Apple GPUs; no modern CUDA on Apple Silicon. |

For Rust, `cudarc` provides safe CUDA driver/runtime/NVRTC/cuBLAS/cuDNN bindings and supports
CUDA 11.4–13.x; it is the mature route if CUDA is genuinely required.
([cudarc](https://docs.rs/cudarc/latest/cudarc/), [CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit))

But CUDA costs:

- NVIDIA-only; no Apple Silicon, no AMD/Intel.
- A large toolkit/runtime dependency, driver-version coupling and CI complexity.
- Data must be in CUDA memory. Sharing a WebView’s WebGL/WebGPU texture with CUDA is not a
  portable browser feature; it becomes a native-interop project (D3D12/Vulkan external memory,
  shared handles, fences).
- The UI still cannot call CUDA directly; you need Tauri commands, a shared-memory/IPC bridge,
  or a native viewport.

For painting, **CUDA buys little over WebGPU** — brush stamping and compositing are regular
parallel image work, not CUDA-specific. CUDA matters for OptiX denoising, AI upscaling/inpainting,
cuDNN models, or NVIDIA-only simulation.

## 4. Is the web UI the limiting factor?

Not by itself. Our measured bottleneck was the **CPU paint algorithm**, not React or the DOM:

- CPU per-texel compositing and UV rasterisation,
- walking all triangles per dab,
- redrawing the entire UV wireframe on every live tick,
- uploading the whole DataTexture per dab,
- rendering a full-resolution material preview.

Those are algorithm/GPU issues. Moving the same algorithms into a native UI would still be slow.

The WebView does add real costs near the edge:

- WebView2 compositing adds roughly **1–2 compositor frames** of latency; the host cannot get
  pre-composition layer textures through public APIs. A native viewport can present in the same
  frame as the render. ([platform ceilings](https://github.com/merely-made/wgpu-scry/blob/efa86efa9e6de304bc4ba9113a908f3c4be62829/design_docs/2026-05-07_platform_ceilings.md))
- Pen/touch events are forwarded through the WebView and browser event loop; a native view can
  read tablet/Wintab events more directly.
- Memory and texture limits are the browser’s (WebGPU `maxTextureDimension2D`, buffer limits),
  not the GPU’s full capability.
- Color management, HDR/10-bit, multiple windows, and OS-level file/asset integration are more
  direct natively.

These matter for a **120–240 Hz stylus workflow**, 8K textures, HDR, or multi-window asset tools.
They do not explain a 1K brush being slow.

## 5. Decision thresholds

Use these as gates, not absolutes; measure on the target machine.

| Situation | Best architecture |
| --- | --- |
| ≤ 4K textures, ≤ 8–16 layers, 60 Hz, 1–2 M triangles | **Web UI + WebGPU painter.** Rewriting the UI is not justified. |
| 4K–8K, many layers, heavy bake/AO, 120 Hz stylus | **Web UI + WebGPU**, plus native Rust/wgpu for bake if needed. |
| CUDA/OptiX/AI features, NVIDIA-only pipeline | **Native Rust compute sidecar** (cudarc) behind the web UI, or native viewport. |
| Sub-10 ms input-to-photon, 240 Hz pen, HDR/10-bit, multi-GB assets, multi-window | **Native UI/viewport** becomes worth it. |
| Cross-platform (Windows/macOS/Linux) | Avoid CUDA as the core; use wgpu/WebGPU and CUDA as an optional backend. |

A practical threshold: if the **paint engine** hits 60 fps at the target resolution and the
remaining frame time is UI/compositor/input, native UI can help. If the paint engine is still
CPU-bound, native UI won’t fix it.

## 6. Recommended path for Barista

1. **Keep the web UI.** It is not the current bottleneck, and the tool’s UX is already built there.
2. **Keep the GPU paint engine on the primary path:**
   - the first slice is shipped as the WebGL2 preview in `gpupaint.ts` (live color strokes, CPU commit);
   - the next step is WebGPU or a full GPU compositor: layer/channel textures on the GPU, brush dabs
     into the active layer, compositing in a fragment/compute pass, CPU readback only for export and
     undo;
   - keep the CPU path as the fallback for machines without the GPU path.
   This is the shortest route to Substance-like 4K painting and works on NVIDIA, AMD, Intel and
   Apple.
3. **Use native Rust/wgpu for bake** if the depth/AO bake becomes the next wall. The engine
   already is Rust; a GPU bake can share buffers with the renderer more cheaply than the browser.
4. **Add CUDA only as an optional NVIDIA backend** if you need OptiX/AI/denoise or a specific
   CUDA library. Do not make it the required path.
5. **Consider a native UI only after profiling** shows the WebView input/compositor or browser
   limits dominate — e.g. a 240 Hz tablet workflow, 8K, HDR, or multi-window. At that point the
   realistic options are a Rust viewport (wgpu + egui/custom) or Qt; that is a product rewrite, not
   a performance patch.

## 7. Bottom line

- **CUDA in the page: no. CUDA in a native process: yes, NVIDIA-only.**
- **WebGPU is the right GPU API for this app**: cross-vendor, compute-capable, usable from the
  current Tauri/React frontend.
- **The web UI is not why 1K painting was slow.** The CPU compositor and per-frame redraw were.
- **Rewrite the UI only when input latency, resolution, color, memory or multi-window needs exceed
  what WebGPU + WebView can do** — not to fix brush throughput.

## Sources

- [MDN: WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
- [Tauri: WebGPU support issue](https://github.com/tauri-apps/tauri/issues/6381)
- [WebView2Feedback: WebGPU updates](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2233)
- [cudarc: Rust CUDA bindings](https://docs.rs/cudarc/latest/cudarc/)
- [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit)
- [cuda-wasm (experimental)](https://www.npmjs.com/package/cuda-wasm)
- [WebView2 compositor/latency ceilings](https://github.com/merely-made/wgpu-scry/blob/efa86efa9e6de304bc4ba9113a908f3c4be62829/design_docs/2026-05-07_platform_ceilings.md)
- [wgpu compute backends](https://github.com/gogpu/wgpu/blob/v0.34.5/docs/COMPUTE-BACKENDS.md)
