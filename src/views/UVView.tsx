// The UV editor, with the 3D view's selection (Blender's UV sync selection). Click picks a vertex, edge, face or
// island (the select mode), Shift toggles, Ctrl takes away, Alt+click an edge loop; drag a selected element to
// move the selection, drag empty space to box-select (B: box from anywhere). Wheel zooms at the pointer, middle drag
// pans, Ctrl+middle drag zooms; Home frames all, numpad . the selection. G R S move, rotate, scale the selection
// with the mouse (click keeps it, right click puts it back); pinned UVs show red. Shows the picked part's UVs alone,
// or the whole model: each part's square as a tile.
import { useEffect, useMemo, useRef } from 'react';
import { islandColor, stretchColor, uvMapCanvas, type UVMap } from '../colors';
import { pickTri } from '../islands';
import {
  texSet, paintPress, paintDrag, paintEnd, painting, selectPaintInUV, deselectPaint, type PaintMods, beginEdit, cancelXform, clearSelection, confirmXform, kindOf, liveSel, nudge, pinsOf, pointer, xformMouse, repack, selectElems, selectLoop, setUvScope, setTextureResolution, setUvMap, TEXTURE_RESOLUTIONS, TILE, useApp, uvTiles, contextMenu, openMenu, closeMenu,
  type SelOp, type MenuItem,
} from '../store';
import { topoOf } from '../topo';
import { canvasOf } from '../paint';
import { materialCanvas } from '../matview';
import { gpuPreviewCanvas } from '../gpupaint';
import { IslandBar } from '../shell/IslandBar';
import { SEL } from './Viewport3D';

/** Part UVs `a` as a white-on-clear mask, n² (top row v = 1), kept per UV array: what a shared atlas shows of each
 *  part's set. Built once; a clip path of every triangle per frame was the texture view's lag in an atlas. */
const masks = new WeakMap<ArrayLike<number>, Map<number, HTMLCanvasElement>>();
function islandMask(a: ArrayLike<number>, n: number) {
  const sizes = masks.get(a) ?? new Map<number, HTMLCanvasElement>(), hit = sizes.get(n);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const m = cv.getContext('2d')!;
  m.fillStyle = m.strokeStyle = '#fff'; m.lineWidth = 1; m.lineJoin = 'round';
  m.beginPath();
  for (let o = 0; o < a.length; o += 6) { m.moveTo(a[o] * n, (1 - a[o + 1]) * n); m.lineTo(a[o + 2] * n, (1 - a[o + 3]) * n); m.lineTo(a[o + 4] * n, (1 - a[o + 5]) * n); m.closePath(); }
  m.fill(); m.stroke(); // the stroke closes the hairlines antialiasing leaves between neighbouring triangles
  masks.set(a, sizes.set(n, cv));
  return cv;
}
/** One scratch canvas: a part's texture (and selection shade) cut to its islands. */
const scratch = document.createElement('canvas');
function masked(src: CanvasImageSource, shade: CanvasImageSource | null, a: ArrayLike<number>, n: number) {
  if (scratch.width !== n) scratch.width = scratch.height = n;
  const c = scratch.getContext('2d')!;
  c.globalCompositeOperation = 'copy'; c.drawImage(src, 0, 0, n, n);
  c.globalCompositeOperation = 'source-over'; if (shade) c.drawImage(shade, 0, 0, n, n);
  c.globalCompositeOperation = 'destination-in'; c.drawImage(islandMask(a, n), 0, 0);
  c.globalCompositeOperation = 'source-over';
  return scratch;
}
/** The texture view's UV wire in Van Gogh, drawn once per layout and view (it was redrawn after every stroke). */
const wire = { key: '', cv: document.createElement('canvas') };

type Drag =
  | { kind: 'pan' | 'zoom' | 'box'; x: number; y: number; x0: number; y0: number; op: SelOp }
  | { kind: 'move'; x: number; y: number; x0: number; y0: number; moved: boolean; part: number; id: number }
  | null;

const opOf = (e: { shiftKey: boolean; ctrlKey: boolean }, click: boolean): SelOp => (e.shiftKey ? (click ? 'toggle' : 'add') : e.ctrlKey ? 'sub' : 'set');

export function UVView() {
  const result = useApp((s) => s.result), mode = useApp((s) => s.mode), uvRev = useApp((s) => s.uvRev), loading = useApp((s) => s.loading), textureResolution = useApp((s) => s.textureResolution), uvMap = useApp((s) => s.uvMap);
  const xform = useApp((s) => s.xform), pins = useApp((s) => s.pins);
  const csel = useApp((s) => liveSel(s)), selectMode = useApp((s) => s.selectMode), viewReq = useApp((s) => s.viewReq);
  // Van Gogh: the picked channel's texture under the UVs, and no UV editing (it would move the paint)
  const paint = useApp((s) => s.workspace === 'paint'), channel = useApp((s) => s.paintChannel), paintRev = useApp((s) => s.paintRev), paintLive = useApp((s) => s.paintLive), lightRev = useApp((s) => s.lightRev);
  const parts = useApp((s) => s.parts), activePart = useApp((s) => s.activePart), oneAtlas = useApp((s) => s.params.one_atlas), uvScope = useApp((s) => s.uvScope);
  const box = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  // The checker is a canvas generated at the paint resolution: do not rebuild it on every live stroke tick.
  const checker = useMemo(() => uvMapCanvas(uvMap, textureResolution), [uvMap, textureResolution]);
  // view: UV (0,0) sits at screen (ox, oy + H·size), one UV unit is `size` px; the tiles span W × H units
  const view = useRef({ size: 0, ox: 0, oy: 0, H: 1, fitted: false, layout: '' });
  const drag = useRef<Drag>(null);
  const redraw = useRef(() => {});
  const firstReq = useRef(viewReq.n);
  // the right click that cancels a transform doesn't also open the menu
  const noMenu = useRef(false);
  // Van Gogh: a stroke, or a Marquee / Lasso shape (UV points in the part's own square), under way
  const stroke = useRef<{ part: number; mods: PaintMods; shape?: [number, number][] } | null>(null);
  // Van Gogh's brush in the texture view: rings at the mouse, the dab's size (dashed) and its hardness (solid)
  const rings = useRef<HTMLDivElement>(null);
  const showRings = (sx: number, sy: number) => {
    const el = rings.current, p = useApp.getState().paint;
    if (!el) return;
    el.style.display = paint && (p.tool === 'brush' || p.tool === 'erase') ? '' : 'none';
    const d = 2 * (p.size / 100) * view.current.size;
    Object.assign(el.style, { left: `${sx}px`, top: `${sy}px`, width: `${d}px`, height: `${d}px` });
    (el.firstChild as HTMLElement).style.transform = `scale(${Math.max(0.02, p.hardness)})`;
  };

  useEffect(() => { view.current.fitted = false; }, [result]);

  useEffect(() => {
    const draw = () => {
      const el = box.current!, c = cv.current!, dpr = devicePixelRatio, w = el.clientWidth, h = el.clientHeight, v = view.current;
      // laid out at 0 × 0 (a workspace switch mid-layout): drawImage of the empty wire canvas threw and took the app down;
      // the ResizeObserver draws once it has a size
      if (!w || !h) return;
      const tiles = uvTiles(), W = tiles.cols * TILE - (TILE - 1), H = tiles.rows * TILE - (TILE - 1), layout = `${tiles.cols}x${tiles.rows}`;
      if (layout !== v.layout) { v.layout = layout; v.fitted = false; }
      if (!v.fitted || !v.size) {
        v.size = Math.max(1, Math.min((w - 32) / W, (h - 32) / H)); v.H = H;
        v.ox = (w - v.size * W) / 2; v.oy = (h - v.size * H) / 2; v.fitted = true;
      }
      c.style.width = `${w}px`; c.style.height = `${h}px`;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const x = c.getContext('2d')!;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      const S = v.size, X = (u: number) => v.ox + u * S, Y = (t: number) => v.oy + (v.H - t) * S;
      // A live stroke only needs the texture; walking every UV triangle in a dense model was the
      // texture view's biggest cost. The wire returns when the stroke ends.
      const liveView = paint && painting() && paintLive > 0;
      // one square per tile (just one unless the whole model is shown part by part), named when there are several
      const squares: [[number, number], number][] = tiles.at.flatMap((o, pi) => (o ? [[o, pi] as [[number, number], number]] : []));
      const list = squares.length ? squares : [[[0, 0], -1] as [[number, number], number]];
      list.forEach(([[u0, v0], pi], k) => {
        // a shared atlas puts every part in one square: its ground (and checker) once, or each part wiped the last
        const first = list.findIndex(([o]) => o[0] === u0 && o[1] === v0) === k;
        if (first) { x.fillStyle = '#15171a'; x.fillRect(X(u0), Y(v0 + 1), S, S); }
        if (paint && parts[pi]) {
          const ts = texSet(pi);
          // While a stroke is live, show the painted channel straight from its DataTexture; the lit material
          // view is a full offscreen render and waits for the stroke to end.
          const live = liveView;
          const mat = !live && channel === 'material' && result?.parts[pi] && useApp.getState().uvs[pi] ? materialCanvas(ts, result.parts[pi].positions, useApp.getState().uvs[pi], useApp.getState().paintAO) : null;
          const shown = channel === 'material' ? 'color' : (channel === 'ao' || channel === 'curv' ? !!ts.bake : ts.channels.includes(channel)) ? channel : 'color';
          const preview = Math.min(ts.size, live ? 512 : 1024);
          const gpu = live || ts.preview ? gpuPreviewCanvas(pi) : null;
          // a shared atlas: every part has its own set over the same square, so each shows only on its own triangles
          // (unclipped, the last part's set covered the whole atlas)
          const shared = squares.some(([o, pj]) => pj !== pi && o[0] === u0 && o[1] === v0), a = useApp.getState().uvs[pi];
          const src = gpu ?? mat ?? canvasOf(ts, shown, preview), shade = ts.sel ? canvasOf(ts, 'shade', preview) : null;
          if (shared && a) x.drawImage(masked(src, shade, a, preview), X(u0), Y(v0 + 1), S, S);
          else {
            x.drawImage(src, X(u0), Y(v0 + 1), S, S);
            if (shade) x.drawImage(shade, X(u0), Y(v0 + 1), S, S);
          }
        }
        else if (first && mode === 'checker' && parts[pi]?.textured !== false) { x.globalAlpha = 0.75; x.drawImage(checker, X(u0), Y(v0 + 1), S, S); x.globalAlpha = 1; }
        x.strokeStyle = '#383d43';
        x.strokeRect(X(u0) + 0.5, Y(v0 + 1) + 0.5, S, S);
        if (tiles.cols * tiles.rows > 1 && parts[pi]) {
          x.fillStyle = pi === activePart ? '#cfcfcf' : '#8a8f96';
          x.font = '11px sans-serif';
          x.fillText(parts[pi].name, X(u0) + 2, Y(v0 + 1) - 4);
        }
      });
      const { uvs } = useApp.getState();
      if (paint && result && !liveView) {
        const key = `${uvRev}|${v.size}|${v.ox}|${v.oy}|${w}|${h}|${dpr}|${tiles.at.map((o) => (o ? o.join(',') : '-')).join(' ')}|${loading ? 'l' : ''}`;
        if (wire.key !== key) {
          wire.key = key;
          wire.cv.width = c.width; wire.cv.height = c.height;
          const g = wire.cv.getContext('2d')!;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.lineWidth = 0.5; g.strokeStyle = 'rgba(80,150,255,.55)';
          result.parts.forEach((p, pi) => {
            const at = tiles.at[pi], a = uvs[pi];
            if (!at || !a || (loading && !loading.done[pi])) return;
            // ponytail: stroked 64 triangles a path (one huge path rasterises far slower); WebGL if parts grow past ~100k
            for (let t0 = 0; t0 < p.island.length; t0 += 64) {
              g.beginPath();
              for (let t = t0; t < Math.min(t0 + 64, p.island.length); t++) { const o = t * 6; g.moveTo(X(a[o] + at[0]), Y(a[o + 1] + at[1])); g.lineTo(X(a[o + 2] + at[0]), Y(a[o + 3] + at[1])); g.lineTo(X(a[o + 4] + at[0]), Y(a[o + 5] + at[1])); g.closePath(); }
              g.stroke();
            }
          });
        }
        x.drawImage(wire.cv, 0, 0, w, h);
      }
      if (result && !liveView) {
        x.lineWidth = 0.5;
        result.parts.forEach((p, pi) => {
          const at = tiles.at[pi];
          if (!at || (loading && !loading.done[pi])) return;
          const fill = paint ? 'checker' : mode;
          const a = uvs[pi], U = (q: number) => X(q + at[0]), V = (q: number) => Y(q + at[1]), sel = csel?.part === pi ? csel : null;
          const tri = (t: number) => { const o = t * 6; x.moveTo(U(a[o]), V(a[o + 1])); x.lineTo(U(a[o + 2]), V(a[o + 3])); x.lineTo(U(a[o + 4]), V(a[o + 5])); x.closePath(); };
          // fills one triangle at a time (each its own colour), the wire in batches
          for (let t = 0; t < p.island.length; t++) {
            const on = !!sel?.faces.has(t);
            if (fill === 'checker' && !on) continue;
            x.beginPath(); tri(t);
            x.fillStyle = on ? (fill === 'checker' ? `${SEL}55` : SEL) : `rgb(${(fill === 'islands' ? islandColor(p.island[t]) : stretchColor(p.stretch[t])).map((q) => (q * 255) | 0)})`;
            x.fill();
          }
          // ponytail: wire stroked 64 triangles a path (one huge path rasterises far slower); WebGL if parts grow past ~100k
          x.strokeStyle = fill === 'checker' ? 'rgba(255,255,255,.4)' : 'rgba(0,0,0,.28)';
          for (let t0 = paint ? p.island.length : 0; t0 < p.island.length; t0 += 64) { // Van Gogh's wire is the cached one above
            x.beginPath();
            for (let t = t0; t < Math.min(t0 + 64, p.island.length); t++) tri(t);
            x.stroke();
          }
          const pinned = pinsOf(useApp.getState(), pi);
          if (pinned) {
            x.fillStyle = '#e2483a';
            for (const c1 of pinned) x.fillRect(U(a[c1 * 2]) - 3, V(a[c1 * 2 + 1]) - 3, 6, 6);
          }
          if (!sel && selectMode !== 'vert') return;
          const topo = topoOf(p.positions);
          if (sel && selectMode !== 'island') {
            x.strokeStyle = SEL; x.lineWidth = 1.5;
            x.beginPath();
            // face mode: just the selected faces' own edges (a neighbour shares the edge, not the selection)
            const own = selectMode === 'face';
            for (let c1 = 0; c1 < topo.edge.length; c1++) {
              if (own ? !sel.faces.has((c1 / 3) | 0) : !sel.edges.has(topo.edge[c1])) continue;
              const c2 = c1 - (c1 % 3) + ((c1 + 1) % 3);
              x.moveTo(U(a[c1 * 2]), V(a[c1 * 2 + 1])); x.lineTo(U(a[c2 * 2]), V(a[c2 * 2 + 1]));
            }
            x.stroke();
            x.lineWidth = 0.5;
          }
          if (selectMode === 'vert') {
            for (let c1 = 0; c1 < topo.vid.length; c1++) {
              const on = !!sel?.verts.has(topo.vid[c1]), r = on ? 2.5 : 1.5;
              x.fillStyle = on ? SEL : '#111';
              x.fillRect(U(a[c1 * 2]) - r, V(a[c1 * 2 + 1]) - r, r * 2, r * 2);
            }
          }
        });
      }
      const sh = stroke.current?.shape, so = sh && tiles.at[stroke.current!.part];
      if (sh && so) {
        x.strokeStyle = '#e0e0e0'; x.fillStyle = '#ffffff10'; x.setLineDash([4, 3]);
        x.beginPath();
        sh.forEach(([u, w], k) => (k ? x.lineTo(X(u + so[0]), Y(w + so[1])) : x.moveTo(X(u + so[0]), Y(w + so[1]))));
        x.closePath(); x.fill(); x.stroke(); x.setLineDash([]);
      }
      const d = drag.current;
      if (d?.kind === 'box') {
        x.strokeStyle = '#d0d0d0'; x.fillStyle = '#ffffff10'; x.setLineDash([4, 3]);
        x.fillRect(d.x0, d.y0, d.x - d.x0, d.y - d.y0); x.strokeRect(d.x0, d.y0, d.x - d.x0, d.y - d.y0); x.setLineDash([]);
      }
    };
    redraw.current = draw;
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, [result, mode, uvRev, csel, selectMode, parts, activePart, oneAtlas, uvScope, loading, pins, textureResolution, uvMap, paint, channel, paintRev, paintLive, lightRev]);

  // a transform in progress follows the mouse anywhere; left click keeps it, right click puts it back
  const transforming = !!xform;
  useEffect(() => {
    if (!transforming) return;
    const move = (e: PointerEvent) => { const p = toUV(e); xformMouse(p.u, p.v, e.ctrlKey); };
    const down = (e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.button === 0) confirmXform();
      else if (e.button === 2) { noMenu.current = true; cancelXform(); }
    };
    const menu = (e: Event) => e.preventDefault();
    addEventListener('pointermove', move);
    addEventListener('pointerdown', down, true);
    addEventListener('contextmenu', menu, true);
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerdown', down, true); removeEventListener('contextmenu', menu, true); };
  }, [transforming]);

  // Home: everything; numpad .: the selection
  useEffect(() => {
    if (viewReq.view !== 'uv' || viewReq.n === firstReq.current) return;
    const v = view.current, el = box.current!;
    if (viewReq.op === 'all') { v.fitted = false; redraw.current(); return; }
    const c = liveSel(), at = uvTiles().at[c?.part ?? -1], a = c && useApp.getState().uvs[c.part];
    if (!c || !at || !a) return;
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    const faceMode = useApp.getState().selectMode === 'face' || useApp.getState().selectMode === 'island';
    for (const f of faceMode ? [...c.faces].flatMap((f) => [f * 3, f * 3 + 1, f * 3 + 2]) : selCornersOf(c)) {
      u0 = Math.min(u0, a[f * 2]); u1 = Math.max(u1, a[f * 2]); v0 = Math.min(v0, a[f * 2 + 1]); v1 = Math.max(v1, a[f * 2 + 1]);
    }
    if (u0 === Infinity) return;
    const span = Math.max(u1 - u0, v1 - v0, 0.02), w = el.clientWidth, h = el.clientHeight;
    v.size = Math.min(w, h) * 0.8 / span;
    v.ox = w / 2 - ((u0 + u1) / 2 + at[0]) * v.size;
    v.oy = h / 2 - (v.H - (v0 + v1) / 2 - at[1]) * v.size;
    redraw.current();
  }, [viewReq]);

  const toUV = (e: { clientX: number; clientY: number }) => {
    const r = cv.current!.getBoundingClientRect(), v = view.current, sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, u: (sx - v.ox) / v.size, v: v.H - (sy - v.oy) / v.size };
  };
  /** Screen position of a part's corner. */
  const screen = (a: Float32Array, c: number, tile: [number, number]) => {
    const v = view.current;
    return [v.ox + (a[c * 2] + tile[0]) * v.size, v.oy + (v.H - a[c * 2 + 1] - tile[1]) * v.size];
  };
  /** The nearest corner edge within 10 px: its part, corners and edge id. */
  const edgeUnder = (sx: number, sy: number) => {
    const s = useApp.getState(), at = uvTiles().at;
    let best: { part: number; c1: number; c2: number; edge: number; d: number } | null = null;
    s.result?.parts.forEach((p, pi) => {
      const tile = at[pi], a = s.uvs[pi];
      if (!tile || !a || (s.loading && !s.loading.done[pi])) return;
      const topo = topoOf(p.positions);
      for (let c1 = 0; c1 < topo.edge.length; c1++) {
        const c2 = c1 - (c1 % 3) + ((c1 + 1) % 3), [x1, y1] = screen(a, c1, tile), [x2, y2] = screen(a, c2, tile);
        const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy, q = l2 ? Math.max(0, Math.min(1, ((sx - x1) * dx + (sy - y1) * dy) / l2)) : 0;
        const d = Math.hypot(sx - x1 - q * dx, sy - y1 - q * dy);
        if (d <= 10 && (!best || d < best.d)) best = { part: pi, c1, c2, edge: topo.edge[c1], d };
      }
    });
    return best as { part: number; c1: number; c2: number; edge: number; d: number } | null;
  };
  /** The element of the select mode's kind under the pointer: a vertex (nearest corner within 10 px), an edge, or a face. */
  const under = (p: { sx: number; sy: number; u: number; v: number }): { part: number; id: number } | null => {
    const s = useApp.getState(), m = s.selectMode;
    if (!s.result) return null;
    if (m === 'edge') { const e = edgeUnder(p.sx, p.sy); return e && { part: e.part, id: e.edge }; }
    if (m === 'vert') {
      const at = uvTiles().at;
      let best: { part: number; id: number; d: number } | null = null;
      s.result.parts.forEach((q, pi) => {
        const tile = at[pi], a = s.uvs[pi];
        if (!tile || !a) return;
        const topo = topoOf(q.positions);
        for (let c = 0; c < topo.vid.length; c++) {
          const [x1, y1] = screen(a, c, tile), d = Math.hypot(p.sx - x1, p.sy - y1);
          if (d <= 10 && (!best || d < best.d)) best = { part: pi, id: topo.vid[c], d };
        }
      });
      return best;
    }
    const hit = pickTri(s.result, s.uvs, uvTiles().at, p.u, p.v);
    return hit && { part: hit.part, id: hit.tri };
  };

  const down = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toUV(e), start = { x: p.sx, y: p.sy, x0: p.sx, y0: p.sy };
    pointer.view = 'uv'; pointer.u = p.u; pointer.v = p.v; pointer.x = e.clientX; pointer.y = e.clientY;
    if (e.button === 1) { drag.current = { kind: e.ctrlKey ? 'zoom' : 'pan', ...start, op: 'set' }; return; }
    const state = useApp.getState();
    if (paint) return paintDown(e, p);
    if (e.button !== 0 || !result || state.loading) return;
    if (state.boxArmed) { useApp.setState({ boxArmed: false }); drag.current = { kind: 'box', ...start, op: e.ctrlKey ? 'sub' : 'add' }; return; }
    if (e.altKey) {
      const hit = edgeUnder(p.sx, p.sy);
      if (hit && (state.selectMode === 'vert' || state.selectMode === 'edge')) void selectLoop(hit.part, hit.edge, e.shiftKey);
      return;
    }
    const hit = under(p);
    if (!hit) { drag.current = { kind: 'box', ...start, op: opOf(e, false) }; return; }
    if (e.shiftKey || e.ctrlKey) { selectElems(hit.part, [hit.id], opOf(e, true)); return; }
    const c = liveSel(), on = c?.part === hit.part && c[kindOf(state.selectMode)].has(hit.id);
    if (!on) selectElems(hit.part, [hit.id]);
    drag.current = { kind: 'move', ...start, moved: false, part: hit.part, id: hit.id };
  };
  /** The part whose square holds UV point (u, v) as the view lays them out, and the point in that square. */
  const squareAt = (u: number, v: number) => {
    // the part whose triangle is under the point first: in a shared atlas every part's square is the same one
    const s = useApp.getState(), at = uvTiles().at, hit = s.result ? pickTri(s.result, s.uvs, at, u, v) : null;
    const inside = (o: [number, number] | null) => !!o && u >= o[0] && u <= o[0] + 1 && v >= o[1] && v <= o[1] + 1;
    const i = hit && inside(at[hit.part]) ? hit.part : inside(at[s.activePart]) ? s.activePart : at.findIndex(inside);
    return i < 0 ? null : { part: i, uv: [u - at[i]![0], v - at[i]![1]] as [number, number] };
  };
  // Van Gogh: every tool works here as on the model; Marquee and Lasso draw in UV space, a click deselects
  const paintDown = (e: React.PointerEvent, p: { u: number; v: number }) => {
    const s = useApp.getState(), sq = squareAt(p.u, p.v), mods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, pressure: e.pressure, pen: e.pointerType === 'pen' }, tool = s.paint.tool;
    if (e.button !== 0 || !result || s.loading) return;
    if ((tool === 'marquee' || tool === 'lasso') && !mods.ctrl) { stroke.current = { part: sq?.part ?? s.activePart, mods, shape: [sq?.uv ?? [p.u, p.v]] }; return; }
    if (!sq) return;
    const hit = pickTri(result, s.uvs, uvTiles().at, p.u, p.v), tri = hit?.part === sq.part ? hit.tri : -1;
    if (tri < 0 && (tool === 'wand' || tool === 'bucket') && !mods.ctrl) return;
    if (paintPress(sq.part, tri, null, sq.uv, mods)) stroke.current = { part: sq.part, mods };
    redraw.current();
  };
  const move = (e: React.PointerEvent) => {
    const p = toUV(e), d = drag.current, v = view.current, st = stroke.current;
    pointer.view = 'uv'; pointer.u = p.u; pointer.v = p.v; pointer.x = e.clientX; pointer.y = e.clientY;
    showRings(p.sx, p.sy);
    if (st) {
      const o = uvTiles().at[st.part];
      if (!o) return;
      const uv: [number, number] = [p.u - o[0], p.v - o[1]];
      if (st.shape) st.shape = useApp.getState().paint.tool === 'marquee' ? [st.shape[0], [uv[0], st.shape[0][1]], uv, [st.shape[0][0], uv[1]]] : [...st.shape, uv];
      else { paintDrag(st.part, null, uv, e.pointerType === 'pen' ? e.pressure : 1); useApp.setState({}); } // the 3D view redraws on any store update
      redraw.current();
      return;
    }
    if (!d) return;
    if (d.kind === 'move') {
      if (!d.moved && Math.hypot(p.sx - d.x0, p.sy - d.y0) < 3) return;
      if (!d.moved) { d.moved = true; beginEdit(); }
      nudge((p.sx - d.x) / v.size, -(p.sy - d.y) / v.size);
    }
    if (d.kind === 'pan') { v.ox += p.sx - d.x; v.oy += p.sy - d.y; }
    if (d.kind === 'zoom') {
      const f = Math.exp(-(p.sy - d.y) * 0.01);
      v.size *= f; v.ox = d.x0 - (d.x0 - v.ox) * f; v.oy = d.y0 - (d.y0 - v.oy) * f;
    }
    d.x = p.sx; d.y = p.sy;
    if (d.kind !== 'move') redraw.current();
  };
  const up = () => {
    const st = stroke.current;
    stroke.current = null;
    if (st?.shape) {
      const us = st.shape.map((q) => q[0]), vs = st.shape.map((q) => q[1]), n = texSet(st.part).size;
      if (st.shape.length < 3 || (Math.max(...us) - Math.min(...us) + Math.max(...vs) - Math.min(...vs)) * n < 2) { if (!st.mods.shift && !st.mods.alt) deselectPaint(); }
      else selectPaintInUV(st.part, st.shape, st.mods);
      return redraw.current();
    }
    if (st) return paintEnd();
    const d = drag.current;
    drag.current = null;
    // a click on something already selected: just that, as in Blender
    if (d?.kind === 'move' && !d.moved) return selectElems(d.part, [d.id]);
    if (d?.kind !== 'box' || !result) return;
    const v = view.current, U = (sx: number) => (sx - v.ox) / v.size, V = (sy: number) => v.H - (sy - v.oy) / v.size;
    const [u0, u1] = [U(Math.min(d.x0, d.x)), U(Math.max(d.x0, d.x))], [v0, v1] = [V(Math.max(d.y0, d.y)), V(Math.min(d.y0, d.y))];
    const s = useApp.getState(), at = uvTiles().at, kind = kindOf(s.selectMode);
    let best: { part: number; ids: number[] } | null = null;
    result.parts.forEach((p, pi) => {
      const o = at[pi], a = s.uvs[pi];
      if (!o || !a) return;
      const topo = topoOf(p.positions), ids = new Set<number>();
      const inside = (u: number, w: number) => u + o[0] >= u0 && u + o[0] <= u1 && w + o[1] >= v0 && w + o[1] <= v1;
      const cin = (c: number) => inside(a[c * 2], a[c * 2 + 1]);
      for (let c = 0; c < topo.vid.length; c++) {
        if (kind === 'verts' && cin(c)) ids.add(topo.vid[c]);
        if (kind === 'edges' && cin(c) && cin(c - (c % 3) + ((c + 1) % 3))) ids.add(topo.edge[c]);
        if (kind === 'faces' && c % 3 === 0 && inside((a[c * 2] + a[c * 2 + 2] + a[c * 2 + 4]) / 3, (a[c * 2 + 1] + a[c * 2 + 3] + a[c * 2 + 5]) / 3)) ids.add(c / 3);
      }
      if (ids.size && (!best || ids.size > best.ids.length)) best = { part: pi, ids: [...ids] };
    });
    const hit = best as { part: number; ids: number[] } | null;
    if (hit) selectElems(hit.part, hit.ids, d.op);
    else if (d.op === 'set') clearSelection();
    redraw.current();
  };
  const wheel = (e: React.WheelEvent) => {
    const p = toUV(e), v = view.current, f = Math.exp(-e.deltaY * 0.0015);
    v.size *= f; v.ox = p.sx - (p.sx - v.ox) * f; v.oy = p.sy - (p.sy - v.oy) * f;
    redraw.current();
  };
  const frame = () => { view.current.fitted = false; redraw.current(); };
  // The UV view's own menu: checker resolution, packing and framing. The color mode is the Display control in the
  // options bar (also Z and View › Display), so it is not repeated here.
  const display = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    pointer.x = r.right; pointer.y = r.bottom + 2;
    const item = (label: string, run: () => void): MenuItem => ({ label, run: () => { closeMenu(); run(); } });
    const res = TEXTURE_RESOLUTIONS.map((n) => item(`${textureResolution === n ? '✓ ' : ''}${n}×${n}`, () => setTextureResolution(n)));
    const maps: [UVMap, string, string][] = [['checker', 'Checker', 'density, shear, stretch'], ['grid', 'UV grid', 'labelled cells: name where a seam lands'], ['uv', 'UV ramp', 'u red, v green: turn and seam jumps'], ['arrows', 'Arrows', 'direction only']];
    const kind = maps.map(([k, label, why]) => item(`${uvMap === k ? '✓ ' : ''}${label} — ${why}`, () => setUvMap(k)));
    openMenu('UV options', [
      { kind: 'head', label: 'Reference map', run: () => {} }, ...kind,
      { kind: 'head', label: 'Resolution', run: () => {} }, ...res,
      { kind: 'head', label: 'Islands', run: () => {} },
      item('Pack islands', () => void repack()),
      item('Frame all', frame),
    ]);
  };

  return (
    <section className="view">
      <header className="vbar uvbar">
        <span className="caps">{paint ? 'Texture' : 'UV layout'}{uvScope === 'part' && parts[activePart] ? ` · ${parts[activePart].name}` : ' · whole model'}</span>
        <span className="vtools">
          <span className="seg" role="group" aria-label="Show UVs of">
            <button aria-pressed={uvScope === 'part'} title="Just the part you picked (click a part in 3D or in Parts)" onClick={() => setUvScope('part')}>Part</button>
            <button aria-pressed={uvScope === 'all'} title={oneAtlas ? 'Every part, in the shared atlas' : 'Every part, each square side by side'} onClick={() => setUvScope('all')}>All</button>
          </span>
          <span className="sep" />
          {!paint && <button className="scene-btn" aria-haspopup="menu" title="Checker resolution, packing, framing" onClick={(e) => display(e.currentTarget)}>UV options</button>}
          <button title="Frame all (Home)" onClick={frame}>Fit</button>
        </span>
      </header>
      <div className="vbody uvbody" ref={box}>
        {paint && <div className="brushring" ref={rings} style={{ display: 'none' }}><div /></div>}
        <canvas ref={cv} className={paint ? 'painting' : undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up} onWheel={wheel} onPointerLeave={() => { if (rings.current) rings.current.style.display = 'none'; }}
          onContextMenu={(e) => { e.preventDefault(); if (noMenu.current) noMenu.current = false; else if (!paint) contextMenu(); }} />
        {!paint && !xform && <IslandBar />}
        {xform && <div className="xform-info">{xform.info}<span>X / Y axis · type a value · Ctrl snaps · click or Enter keeps · Esc or right click cancels</span></div>}
        {loading && (loading.phase === 'error'
          ? <div className="uv-spin" role="alert"><span className="err">{loading.error ?? 'Loading failed'}</span></div>
          : <div className="uv-spin" role="status" aria-label={loading.phase === 'read' ? 'Loading model' : `Unwrapping ${loading.active ?? ''}`}><span className="uv-spinner" /></div>)}
      </div>
    </section>
  );
}

/** Corners of the selected vertices (vertex and edge modes). */
function selCornersOf(c: { of: number[]; verts: Set<number> }) {
  const t = topoOf(c.of), out: number[] = [];
  for (let k = 0; k < t.vid.length; k++) if (c.verts.has(t.vid[k])) out.push(k);
  return out;
}
