import { useEffect, useRef } from 'react';
import { MenuBar } from './shell/MenuBar';
import { PopupMenu, StatusBar } from './shell/Chrome';
import { Viewport3D } from './views/Viewport3D';
import { UVView } from './views/UVView';
import { Dock } from './panels/Dock';
import { PolyDoc } from './panels/PolyDoc';
import { Geppetto, RigOptionsBar, RigToolStrip } from './panels/Geppetto';
import { PaintOptionsBar, PaintToolStrip, VanGogh } from './panels/VanGogh';
import { AppTabs } from './shell/AppTabs';
import { AskDialog } from './shell/AskDialog';
import { ExportDialog } from './shell/ExportDialog';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PolyOptionsBar, PolyToolStrip, runTool } from './shell/PolyTools';
import { Resizer } from './shell/Resizer';
import { UVOptionsBar, UVToolStrip } from './shell/UVTools';
import {
  answerAsk, cancelKnife, confirmKnife, knifeBack, startKnife, confirmDiscard, armBox, cancelDocMove, cancelXform, cancelSymPlane, closeExport, confirmDocMove, dissolveSel, docMoveAxis, setDockWidth, setViewSplit, startDocMove, updateDocMove, clearSelection, closeMenu, confirmXform, connect, edgeMenu, flipSel, invertSelection, openExport, pickFile, saveProject, pinSelected, pointer, redo, repack,
  applySymPlane, setSymMode,
  pieMenu, scaleSel, cutSelection, stitchSelection, selectAll, selectAllPaint, selectLinked, selectLinkedUnder, setSelectMode, startXform, undo, unwrap, unwrapSelected, useApp, viewOp, viewPie, xformKey, xformSnap, openFile, type SelectMode,
  activeDecal, duplicateDecal, nudgeDecal, updateDecal,
  autoRigModel, armRigConstraint, bonesForParts, cancelRigPick, deleteBone, endChain, redoRig, setRigGizmo, setRigMode, setRigTool, undoRig, updateBone,
  type ViewOp, type XformKind, setPaint, undoPaint, redoPaint, deselectPaint, invertPaintSelection, growPaintSelection, duplicatePickedLayers, addPaintLayer, movePaintLayer, deletePaintLayer, fillPaintSelection, dropMaterials, finishDraw, cancelDraw, undoDrawPoint, type PaintTool, type FillBy,
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
const PAINT_BY: Record<string, FillBy> = { Digit1: 'face', Digit2: 'surface', Digit3: 'island', Digit4: 'material', Digit5: 'part' };
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
  // A question (open options, unsaved changes) is modal: Esc cancels it, nothing behind it.
  if (useApp.getState().ask) { if (k === 'escape') return run(() => answerAsk(null)); return; }
  // The export dialog is modal: its own Esc, nothing behind it.
  if (useApp.getState().exportOpen) { if (k === 'escape') return run(closeExport); return; }
  // A menu at the pointer is modal: every other key belongs to the pie/list until it closes.
  if (useApp.getState().menu) return;
  // Space: recenter the view under the pointer, in every workspace. Mid-transform it still confirms instead.
  const spaceNow = useApp.getState();
  if (k === ' ' && !ctrl && !e.altKey && !e.shiftKey && !spaceNow.xform && !spaceNow.docMove && !spaceNow.docKnife) {
    return run(() => viewOp(pointer.view, 'all'));
  }
  // Placing the mirror plane: G / R switch the gizmo, Enter applies it, Esc puts it back; every other key still works.
  if (useApp.getState().symEdit) {
    if (k === 'escape') return run(cancelSymPlane);
    if (k === 'enter') return run(applySymPlane);
    if (!ctrl && !e.altKey && k === 'g') return run(() => setSymMode('translate'));
    if (!ctrl && !e.altKey && k === 'r') return run(() => setSymMode('rotate'));
  }
  // Ctrl+Shift+E: the export dialog, from every workspace (before the workspace key maps, which claim most keys).
  if (ctrl && k === 'e' && e.shiftKey) return run(() => openExport());
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
  // Geppetto: Tab Edit / Pose; drag bones directly; G / R the optional gizmo; F / T / P arm Follow / Aim / Piston;
  // V B tools; A a bone for the part; Shift+A auto-rig; C connect; Esc cancels a pick or chain; X deletes; own undo.
  if (useApp.getState().workspace === 'rig') {
    const r = useApp.getState();
    if (k === 'tab' && !ctrl) return run(() => setRigMode(r.rigMode === 'edit' && r.rig.bones.length ? 'pose' : 'edit'));
    if (k === 'escape') {
      if (r.rigPick) return run(cancelRigPick);
      if (r.rigChain) return run(endChain);
    }
    if (ctrl && (k === 'z' || k === 'y')) return run(k === 'y' || e.shiftKey ? redoRig : undoRig);
    if (!ctrl && !e.altKey) {
      if (k === 'g') return run(() => setRigGizmo('move'));
      if (k === 'r') return run(() => setRigGizmo('rotate'));
      if (r.rigSel >= 0 && (k === 'f' || k === 't' || k === 'p')) return run(() => armRigConstraint(k === 'f' ? 'follow' : k === 't' ? 'aim' : 'piston'));
      const tool = ({ v: 'select', b: 'bone' } as const)[k as 'v' | 'b'];
      if (tool && r.rigMode === 'edit') return run(() => setRigTool(tool));
      if (k === 'a' && r.rigMode === 'edit') return run(() => (e.shiftKey ? autoRigModel() : bonesForParts([r.activePart])));
      if (k === 'c' && r.rigMode === 'edit' && r.rigSel >= 0 && r.rig.bones[r.rigSel]?.parent >= 0) return run(() => updateBone(r.rigSel, { connected: !r.rig.bones[r.rigSel].connected }));
      if ((k === 'x' || k === 'delete') && r.rigSel >= 0 && r.rigMode === 'edit') return run(deleteBone);
    }
    if (!NUMPAD[e.code] && e.code !== 'NumpadDecimal' && k !== 'home' && !(ctrl && k === 'o')) return;
  }
  // Van Gogh: Photoshop's keys (tools M L W D B E G I; Ctrl+A / Ctrl+D / Ctrl+Shift+I selection; Alt+Backspace fill,
  // Delete clear; Ctrl+J duplicate, Ctrl+Shift+N new layer, Ctrl+[ ] move it; [ ] brush size) and the view keys
  if (useApp.getState().workspace === 'paint') {
    const p = useApp.getState().paint;
    // Esc lets go of the materials held on the Eyedropper (they stay under Ctrl+Z if applied)
    if (k === 'escape' && p.grab) return run(dropMaterials);
    // a polyline being drawn (Decal tool, Draw): Enter finishes it, Esc drops it, Backspace takes back a corner
    if (useApp.getState().drawLine && !ctrl) {
      if (k === 'enter') return run(() => finishDraw());
      if (k === 'escape') return run(cancelDraw);
      if (k === 'backspace' && !e.altKey) return run(undoDrawPoint);
    }
    if (ctrl) {
      if (k === 'z') return run(e.shiftKey ? redoPaint : undoPaint);
      if (k === 'y') return run(redoPaint);
      if (k === 'a') return run(selectAllPaint);
      if (k === 'd') return run(deselectPaint);
      if (k === 'i') return run(invertPaintSelection);
      if (e.shiftKey && (k === '=' || k === '+' || k === '-' || k === '_')) return run(() => growPaintSelection(k === '-' || k === '_' ? -4 : 4));
      if (k === 'j') return run(() => (activeDecal() ? duplicateDecal() : duplicatePickedLayers()));
      if (k === 'm') return run(() => setPaint({ tool: 'mirror' }));
      if (k === 'n' && e.shiftKey) return run(addPaintLayer);
      if (k === '[' || k === ']') return run(() => movePaintLayer(k === ']' ? 1 : -1));
    } else {
      // With a mark selected, the Decal tool's keys are the mark's: arrows slide it across its own plane (Shift: far,
      // Alt: fine), [ ] size it, , . turn it — Blender's feel for the object under the gizmo.
      const mark = p.tool === 'decal' ? activeDecal() : null;
      if (mark) {
        if (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown') {
          const s = e.shiftKey ? 8 : e.altKey ? 0.25 : 2;
          return run(() => nudgeDecal(k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0, k === 'arrowdown' ? -s : k === 'arrowup' ? s : 0));
        }
        if (k === '[' || k === ']') return run(() => updateDecal({ width: Math.max(1e-5, mark.decal.width * (k === ']' ? 1.1 : 1 / 1.1)) }));
        if (k === ',' || k === '.') return run(() => updateDecal({ rotation: ((((mark.decal.rotation + (k === '.' ? 5 : -5) + 180) % 360) + 360) % 360) - 180 }));
      }
      // 1-4: Select by Face / Surface / Island / Part, in the slot the other workspaces' 1-4 modes take
      const by = PAINT_BY[e.code] ?? (e.code ? undefined : PAINT_BY[`Digit${k}`]);
      if (by && !e.altKey && !e.shiftKey) return run(() => setPaint({ by }));
      if (PAINT_KEYS[k]) return run(() => setPaint(k === 'd' ? { tool: 'decal', decalMode: 'edit' } : { tool: PAINT_KEYS[k] }));
      if (k === 'backspace' && e.altKey) return run(() => fillPaintSelection());
      // Delete clears paint, but a mark picked with the Decal tool goes off the model with its layer: deleting a decal
      // must not leave an empty decal row behind in the stack.
      if (k === 'delete') return run(() => (p.tool === 'decal' && activeDecal() ? deletePaintLayer() : fillPaintSelection(true)));
      if (k === '[' || k === ']') return run(() => setPaint({ size: Math.min(20, Math.max(0.2, +(p.size * (k === ']' ? 1.2 : 1 / 1.2)).toFixed(1))) }));
    }
    if (!NUMPAD[e.code] && e.code !== 'NumpadDecimal' && k !== 'home' && !(ctrl && k === 'o')) return;
  }
  // Poly Doc's knife: while it's on, Enter / Space cut, Backspace takes a point back, Esc cancels (view keys still work)
  if (useApp.getState().docKnife && ['enter', ' ', 'backspace', 'escape', 'k'].includes(k)) {
    e.preventDefault();
    return run(k === 'escape' ? cancelKnife : k === 'backspace' ? knifeBack : confirmKnife);
  }
  // Poly Doc keeps the selection, view, file and topology keys; the UV ones (G R S, U, P, C V, Q, F…) do nothing there
  if (useApp.getState().workspace === 'doc' && !NUMPAD[e.code] && e.code !== 'NumpadDecimal' && k !== ' ' && k !== 'home' && !SELECT_MODES[e.code]
    && !useApp.getState().docMove
    && !(ctrl ? ['o', 'z', 'y', 'i', 'l', 'x', 'r'].includes(k) || (k === 'e' && e.shiftKey) : e.altKey ? ['a', 'j'].includes(k) : ['a', 'l', 'b', 'g', 'j', 'k', 'm', 'escape'].includes(k))) return;
  // Poly Doc's G: while moving, keys belong to it (X Y Z lock an axis, Enter keeps, Esc cancels)
  if (useApp.getState().docMove) {
    e.preventDefault();
    if (k === 'escape') cancelDocMove();
    else if (k === 'enter' || k === ' ') confirmDocMove();
    else if (k === 'x' || k === 'y' || k === 'z') docMoveAxis('xyz'.indexOf(k) as 0 | 1 | 2);
    return;
  }
  if (useApp.getState().workspace === 'doc' && !ctrl && !e.altKey && k === 'k') return run(startKnife);
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
  if (e.code === 'NumpadDecimal') return run(() => viewOp(pointer.view, 'selected'));
  if (k === 'home') return run(() => viewOp(pointer.view, 'all'));
  if (ctrl) {
    if (k === 'o') run(pickFile);
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

/** Width of Van Gogh's texture-set column. */
const PARTS_W = 168;

export default function App() {
  useEffect(() => {
    void connect();
    const up = (e: KeyboardEvent) => { if (e.key === 'Control') xformSnap(false); releaseZ(e); };
    const move = (e: PointerEvent) => { mouse.x = e.clientX; mouse.y = e.clientY; pointer.x = e.clientX; pointer.y = e.clientY; if (useApp.getState().docMove) updateDocMove(e.clientX, e.clientY); };
    // while G moves vertices, a click keeps the move and a right-click cancels it (and neither selects nor orbits)
    const press = (e: PointerEvent) => {
      if (useApp.getState().docKnife && e.button === 2) { e.preventDefault(); e.stopPropagation(); return cancelKnife(); }
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
  // Closing with unsaved work asks first: the app window through Save / Don't save / Cancel, a browser tab its own prompt.
  useEffect(() => {
    if (isTauri()) {
      const off = getCurrentWindow().onCloseRequested(async (e) => { if (!(await confirmDiscard())) e.preventDefault(); });
      return () => void off.then((f) => f());
    }
    const warn = (e: BeforeUnloadEvent) => { const s = useApp.getState(); if (!s.saved && s.parts.length) e.preventDefault(); };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, []);
  const workspace = useApp((s) => s.workspace), dockW = useApp((s) => s.dockWidth), split = useApp((s) => s.viewSplit), work = useRef<HTMLDivElement>(null);
  const source = useApp((s) => s.source);
  useEffect(() => { document.title = source ? `${source} — Barista` : 'Barista'; }, [source]);
  const rect = () => work.current!.getBoundingClientRect();
  // the panel's divider sets its width; the one between the 3D and UV views their shares of what's left (40 px strip, 2 × 6 px dividers)
  // Van Gogh's panel adds its texture-set column to the left of the panel the divider sizes
  const extra = workspace === 'paint' ? PARTS_W : 0, dw = dockW + extra;
  const dock = <Resizer label="Resize the panel" onDrag={(x) => setDockWidth(rect().right - x - extra)} onStep={(d) => setDockWidth(dockW - d * 16)} />;
  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void openFile(f); }}>
      <MenuBar />
      <AppTabs />
      {/* one frame for both tools, so switching never moves anything: options bar, then strip | views | panel */}
      <div className="space">
        {workspace === 'doc' ? <PolyOptionsBar /> : workspace === 'paint' ? <PaintOptionsBar /> : workspace === 'rig' ? <RigOptionsBar /> : <UVOptionsBar />}
        {workspace === 'doc' || workspace === 'rig' ? (
          <div className="work doc" ref={work} style={{ gridTemplateColumns: `40px minmax(0, 1fr) 6px ${dockW}px` }}>
            {workspace === 'rig' ? <RigToolStrip /> : <PolyToolStrip />}
            <Viewport3D />
            {dock}
            {workspace === 'rig' ? <Geppetto /> : <PolyDoc />}
          </div>
        ) : (
          <div className="work" ref={work} style={{ gridTemplateColumns: `40px minmax(0, ${split}fr) 6px minmax(0, ${1 - split}fr) 6px ${dw}px`, ['--parts-w' as string]: `${PARTS_W}px` }}>
            {workspace === 'paint' ? <PaintToolStrip /> : <UVToolStrip />}
            <Viewport3D />
            <Resizer label="Resize the 3D and UV views" onDrag={(x) => setViewSplit((x - rect().left - 40) / (rect().width - 52 - dw))} onStep={(d) => setViewSplit(split + d * 0.03)} />
            <UVView />
            {dock}
            {workspace === 'paint' ? <VanGogh /> : <Dock />}
          </div>
        )}
      </div>
      <StatusBar />
      <ExportDialog />
      <AskDialog />
      <PopupMenu />
      <Tooltip />
    </div>
  );
}
