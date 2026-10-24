import { useEffect, useRef } from 'react';
import { MenuBar } from './shell/MenuBar';
import { PopupMenu, StatusBar } from './shell/Chrome';
import { Viewport3D } from './views/Viewport3D';
import { UVView } from './views/UVView';
import { Dock } from './panels/Dock';
import { PolyDoc } from './panels/PolyDoc';
import { PaintOptionsBar, PaintToolStrip, VanGogh } from './panels/VanGogh';
import { AppTabs } from './shell/AppTabs';
import { PolyOptionsBar, PolyToolStrip, runTool } from './shell/PolyTools';
import { Resizer } from './shell/Resizer';
import { UVOptionsBar, UVToolStrip } from './shell/UVTools';
import {
  armBox, cancelDocMove, cancelXform, confirmDocMove, dissolveSel, docMoveAxis, setDockWidth, setViewSplit, startDocMove, updateDocMove, clearSelection, closeMenu, confirmXform, connect, edgeMenu, exportFbx, flipSel, invertSelection, pickFile, saveProject, pinSelected, pointer, redo, repack,
  pieMenu, scaleSel, cutSelection, stitchSelection, selectAll, selectAllPaint, selectLinked, selectLinkedUnder, setSelectMode, startXform, undo, unwrap, unwrapSelected, useApp, viewOp, viewPie, xformKey, xformSnap, openFile, type SelectMode,
  type ViewOp, type XformKind, setPaint, undoPaint, redoPaint, deselectPaint, invertPaintSelection, duplicatePaintLayer, addPaintLayer, movePaintLayer, fillPaintSelection, type PaintTool,
} from './store';
import { Tooltip } from './ui/Tooltip';

const SELECT_MODES: Record<string, SelectMode> = { Digit1: 'vert', Digit2: 'edge', Digit3: 'face', Digit4: 'island' };
/** Blender's numpad views (Ctrl: the opposite side) and orbit steps. */
const NUMPAD: Record<string, [ViewOp, ViewOp?]> = {
  Numpad1: ['front', 'back'], Numpad3: ['right', 'left'], Numpad7: ['top', 'bottom'],
  Numpad4: ['orbit-left'], Numpad6: ['orbit-right'], Numpad8: ['orbit-up'], Numpad2: ['orbit-down'],
};

const XFORMS: Record<string, XformKind> = { g: 'move', r: 'rotate', s: 'scale' };
/** Van Gogh's tool keys, Photoshop's. */
const PAINT_KEYS: Record<string, PaintTool> = { m: 'marquee', l: 'lasso', w: 'wand', d: 'decal', b: 'brush', e: 'erase', g: 'bucket', i: 'picker' };

/** Where the mouse is (the pie covers the views, so their own tracking stops), and when Z went down. */
const mouse = { x: 0, y: 0 };
let zDown = 0;
/** Z let go after holding it: pick the pie item in the direction the mouse moved, as Blender's pies do. */
function releaseZ(e: KeyboardEvent) {
  const menu = useApp.getState().menu;
  if (e.key.toLowerCase() !== 'z' || !menu?.pie || menu.title !== 'Display' || performance.now() - zDown < 250) return;
  const dx = mouse.x - menu.x, dy = mouse.y - menu.y;
  if (Math.hypot(dx, dy) < 25) return closeMenu();
  // items sit round the hub at i/n of a turn, clockwise from the top (the pie's ellipse: 120 × 92)
  const a = (Math.atan2(dx / 120, -dy / 92) + 2 * Math.PI) % (2 * Math.PI), n = menu.items.length;
  const i = Math.round((a / (2 * Math.PI)) * n) % n, it = menu.items[i];
  closeMenu();
  if (!it.off) it.run();
}

// Blender's keymap where it has one (left-click select). Keys that act on a view go to the one under the pointer.
function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
  const run = (f: () => unknown) => { e.preventDefault(); f(); };
  // Esc closes the menu at the pointer from every workspace (Van Gogh had no path to it before).
  if (k === 'escape' && useApp.getState().menu) return run(closeMenu);
  // A menu at the pointer is modal: every other key belongs to the pie/list until it closes.
  if (useApp.getState().menu) return;
  // Ctrl+S / Ctrl+Shift+S: the project, from every workspace
  if (ctrl && k === 's' && !e.altKey) return run(() => saveProject(e.shiftKey));
  // Z: the Display pie, in every workspace: hold and release toward a view, or tap and click one. (Mid G/R/S and mid
  // Poly Doc move, Z belongs to the transform instead. Ctrl+Z stays undo everywhere.)
  const now = useApp.getState();
  if (!ctrl && !e.altKey && !e.shiftKey && k === 'z' && !now.xform && !now.docMove) {
    e.preventDefault();
    if (!e.repeat) { zDown = performance.now(); viewPie(); }
    return;
  }
  // Van Gogh: Photoshop's keys (tools M L W D B E G I; Ctrl+A / Ctrl+D / Ctrl+Shift+I selection; Alt+Backspace fill,
  // Delete clear; Ctrl+J duplicate, Ctrl+Shift+N new layer, Ctrl+[ ] move it; [ ] brush size) and the view keys
  if (useApp.getState().workspace === 'paint') {
    const p = useApp.getState().paint;
    if (ctrl) {
      if (k === 'z') return run(e.shiftKey ? redoPaint : undoPaint);
      if (k === 'y') return run(redoPaint);
      if (k === 'a') return run(selectAllPaint);
      if (k === 'd') return run(deselectPaint);
      if (k === 'i') return run(invertPaintSelection);
      if (k === 'j') return run(duplicatePaintLayer);
      if (k === 'n' && e.shiftKey) return run(addPaintLayer);
      if (k === '[' || k === ']') return run(() => movePaintLayer(k === ']' ? 1 : -1));
    } else {
      if (PAINT_KEYS[k]) return run(() => setPaint({ tool: PAINT_KEYS[k] }));
      if (k === 'backspace' && e.altKey) return run(() => fillPaintSelection());
      if (k === 'delete') return run(() => fillPaintSelection(true));
      if (k === '[' || k === ']') return run(() => setPaint({ size: Math.min(20, Math.max(0.2, +(p.size * (k === ']' ? 1.2 : 1 / 1.2)).toFixed(1))) }));
    }
    if (!NUMPAD[e.code] && e.code !== 'NumpadDecimal' && k !== 'home' && !(ctrl && k === 'o')) return;
  }
  // Poly Doc keeps the selection, view, file and topology keys; the UV ones (G R S, U, P, C V, Q, F…) do nothing there
  if (useApp.getState().workspace === 'doc' && !NUMPAD[e.code] && e.code !== 'NumpadDecimal' && k !== ' ' && k !== 'home' && !SELECT_MODES[e.code]
    && !useApp.getState().docMove
    && !(ctrl ? ['o', 'z', 'y', 'i', 'l', 'x', 'r'].includes(k) || (k === 'e' && e.shiftKey) : e.altKey ? ['a', 'j'].includes(k) : ['a', 'l', 'b', 'g', 'j', 'm', 'escape'].includes(k))) return;
  // Poly Doc's G: while moving, keys belong to it (X Y Z lock an axis, Enter keeps, Esc cancels)
  if (useApp.getState().docMove) {
    e.preventDefault();
    if (k === 'escape') cancelDocMove();
    else if (k === 'enter' || k === ' ') confirmDocMove();
    else if (k === 'x' || k === 'y' || k === 'z') docMoveAxis('xyz'.indexOf(k) as 0 | 1 | 2);
    return;
  }
  if (useApp.getState().workspace === 'doc' && !ctrl && !e.altKey && k === 'g') return run(() => startDocMove(mouse.x, mouse.y));
  if (useApp.getState().workspace === 'doc' && !e.altKey) {
    // Blender's J (connect vertex path), M (merge at centre), Ctrl+R (loop cut, here through the selected edge)
    if (!ctrl && k === 'j') return run(() => runTool('connect'));
    if (!ctrl && k === 'm') return run(() => runTool('merge'));
    if (ctrl && k === 'r') return run(() => runTool('loopcut'));
    if (ctrl && k === 'x') return run(() => runTool('dissolve'));
  }
  if (useApp.getState().menu) { if (k === 'escape') run(closeMenu); return; }
  // mid G R S every key belongs to the transform
  if (useApp.getState().xform) {
    e.preventDefault();
    if (k === 'escape') cancelXform();
    else if (k === 'enter' || k === ' ') confirmXform();
    else if (k === 'control') xformSnap(true);
    else if (XFORMS[k]) startXform(XFORMS[k]);
    else xformKey(k);
    return;
  }
  if (NUMPAD[e.code]) return run(() => viewOp('3d', NUMPAD[e.code][ctrl && NUMPAD[e.code][1] ? 1 : 0]!));
  if (e.code === 'NumpadDecimal' || k === ' ') return run(() => viewOp(pointer.view, 'selected'));
  if (k === 'home') return run(() => viewOp(pointer.view, 'all'));
  if (ctrl) {
    if (k === 'o') run(pickFile);
    else if (k === 'e' && e.shiftKey) run(exportFbx);
    else if (k === 'e') run(edgeMenu);
    else if (k === 'enter') run(unwrap);
    else if (k === 'z' && !e.shiftKey) run(undo);
    else if (k === 'y' || (k === 'z' && e.shiftKey)) run(redo);
    else if (k === 'i') run(invertSelection);
    else if (k === 'l') run(selectLinked);
    else if (k === 'p') run(repack);
    else if (k === 'x') run(dissolveSel);
    return;
  }
  if (e.altKey) { if (k === 'a') run(clearSelection); else if (k === 'p') run(() => pinSelected(false)); else if (k === 'j') run(() => runTool('quads')); return; }
  const selectMode = SELECT_MODES[e.code] ?? (e.code ? undefined : SELECT_MODES[`Digit${k}`]); // synthetic events may lack a code
  if (selectMode) return run(() => setSelectMode(selectMode));
  if (k === 'a') run(selectAll);
  else if (k === 'q') run(pieMenu);
  else if (k === 'l') run(() => selectLinkedUnder(e.shiftKey));
  else if (k === 'b') run(armBox);
  else if (XFORMS[k]) run(() => startXform(XFORMS[k]));
  else if (k === 'p') run(() => pinSelected(true));
  else if (k === 'u') run(unwrapSelected);
  else if (k === 'c') run(cutSelection);
  else if (k === 'v') run(stitchSelection);
  else if (k === 'f') flipSel(!e.shiftKey);
  else if (k === '[') scaleSel(1 / 1.1);
  else if (k === ']') scaleSel(1.1);
  else if (k === 'escape') useApp.setState({ boxArmed: false });
}

export default function App() {
  useEffect(() => {
    void connect();
    const up = (e: KeyboardEvent) => { if (e.key === 'Control') xformSnap(false); releaseZ(e); };
    const move = (e: PointerEvent) => { mouse.x = e.clientX; mouse.y = e.clientY; pointer.x = e.clientX; pointer.y = e.clientY; if (useApp.getState().docMove) updateDocMove(e.clientX, e.clientY); };
    // while G moves vertices, a click keeps the move and a right-click cancels it (and neither selects nor orbits)
    const press = (e: PointerEvent) => {
      if (!useApp.getState().docMove) return;
      e.preventDefault(); e.stopPropagation();
      if (e.button === 2) cancelDocMove(); else if (e.button === 0) confirmDocMove();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerdown', press, true);
    addEventListener('keydown', onKey);
    addEventListener('keyup', up);
    return () => { removeEventListener('keydown', onKey); removeEventListener('keyup', up); removeEventListener('pointermove', move); removeEventListener('pointerdown', press, true); };
  }, []);
  const workspace = useApp((s) => s.workspace), dockW = useApp((s) => s.dockWidth), split = useApp((s) => s.viewSplit), work = useRef<HTMLDivElement>(null);
  const source = useApp((s) => s.source);
  useEffect(() => { document.title = source ? `${source} — Barista` : 'Barista'; }, [source]);
  const rect = () => work.current!.getBoundingClientRect();
  // the panel's divider sets its width; the one between the 3D and UV views their shares of what's left (40 px strip, 2 × 6 px dividers)
  const dock = <Resizer label="Resize the panel" onDrag={(x) => setDockWidth(rect().right - x)} onStep={(d) => setDockWidth(dockW - d * 16)} />;
  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void openFile(f); }}>
      <MenuBar />
      <AppTabs />
      {/* one frame for both tools, so switching never moves anything: options bar, then strip | views | panel */}
      <div className="space">
        {workspace === 'doc' ? <PolyOptionsBar /> : workspace === 'paint' ? <PaintOptionsBar /> : <UVOptionsBar />}
        {workspace === 'doc' ? (
          <div className="work doc" ref={work} style={{ gridTemplateColumns: `40px minmax(0, 1fr) 6px ${dockW}px` }}>
            <PolyToolStrip />
            <Viewport3D />
            {dock}
            <PolyDoc />
          </div>
        ) : (
          <div className="work" ref={work} style={{ gridTemplateColumns: `40px minmax(0, ${split}fr) 6px minmax(0, ${1 - split}fr) 6px ${dockW}px` }}>
            {workspace === 'paint' ? <PaintToolStrip /> : <UVToolStrip />}
            <Viewport3D />
            <Resizer label="Resize the 3D and UV views" onDrag={(x) => setViewSplit((x - rect().left - 40) / (rect().width - 52 - dockW))} onStep={(d) => setViewSplit(split + d * 0.03)} />
            <UVView />
            {dock}
            {workspace === 'paint' ? <VanGogh /> : <Dock />}
          </div>
        )}
      </div>
      <StatusBar />
      <PopupMenu />
      <Tooltip />
    </div>
  );
}
