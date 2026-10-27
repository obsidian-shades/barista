// UV Magician's tool strip, the same Photoshop strip as Poly Doc's. Modes and the core seam/selection tools live here;
// the one-shot island commands (Unwrap, Relax, Pack, Align, Rotate) live in the options bar, the contextual island bar
// and the menus, so the rail never repeats the dock.
import { applySymPlane, armBox, cancelSymPlane, cutSelection, editSymPlane, liveSel, pinSelected, selectEdgeLoop, selectLinked, selectionCount, setLiveUnwrap, setSymMode, stitchSelection, unwrapSelected, useApp } from '../store';
import { ico, Icon } from '../ui/Icon';
import { SelectionControls } from './Chrome';
import { ToolStrip, type Counts, type ToolDef } from './PolyTools';

type UvTool = 'box' | 'loop' | 'linked' | 'cut' | 'stitch' | 'pin' | 'unpin';
const any = ([f, e, v]: Counts) => !!(f || e || v);

const UV_TOOLS: Partial<Record<UvTool, ToolDef>>[] = [
  {
    box: { name: 'Box Select', key: 'B', tip: 'Drag a box on the model to select what’s inside it (Shift adds, Ctrl takes away)', run: armBox, on: () => true,
      icon: ico(['M2 2h13v10H2z', 'd'], ['M10.5 8.5l7 5-3.2.6 1.8 3.3-1.4.8-1.8-3.4-2.4 2.3z', 'F']) },
    loop: { name: 'Select Loop', key: 'Alt+click', tip: 'The edge loop through each selected edge', run: selectEdgeLoop, on: ([, e]) => !!e,
      icon: ico(['M4 5v10M16 5v10M4 5a6 2.2 0 1 0 12 0a6 2.2 0 1 0-12 0M4 15a6 2.2 0 0 0 12 0', ''], ['M4 10a6 2.2 0 0 1 12 0', 'ad'], ['M4 10a6 2.2 0 0 0 12 0', 'a']) },
    linked: { name: 'Select Linked', key: 'Ctrl+L', tip: 'Grow the selection to whole islands', run: selectLinked, on: any,
      icon: ico('M9.2 6.6l1.6-1.6a3.3 3.3 0 0 1 4.7 4.7l-1.6 1.6M10.8 13.4l-1.6 1.6a3.3 3.3 0 0 1-4.7-4.7l1.6-1.6', ['M8 12l4-4', 'a']) },
  },
  {
    cut: { name: 'Cut', key: 'C', tip: 'Make seams along the selected edges (with faces selected: round their outline)', run: cutSelection, on: ([, e]) => !!e,
      icon: ico(['M10 1.5v6', 'a'], 'M7.6 13.4L13.5 3M12.4 13.4L6.5 3M6 13.5a2.2 2.2 0 1 0 0.01 0M14 13.5a2.2 2.2 0 1 0 0.01 0') },
    stitch: { name: 'Stitch', key: 'V', tip: 'Join the selected edges back together (with faces selected: the edges between them)', run: stitchSelection, on: ([, e]) => !!e,
      icon: ico(['M17.6 2.4c.5.5.4 1.2-.1 1.7L8 13.6l-1.6-1.6 9.5-9.5c.5-.5 1.2-.6 1.7-.1z', 'F'], ['M7 13c-1.6 1.6-3.6 1.5-4.4 3.3 1.2-.7 2.6-.3 3.6.5s2.6.7 3.8-.3 2.6-.9 3.9.1', 'a']) },
  },
  {
    pin: { name: 'Pin', key: 'P', tip: 'Pin the selected UVs where they are', run: () => pinSelected(true), on: any,
      icon: ico(['M8 2.5h4v4.8l2.8 3.7H5.2L8 7.3z', 'A'], ['M7 2h6M8 2v5l-3 4h10l-3-4V2', 'a'], 'M10 11v7') },
    unpin: { name: 'Unpin', key: 'Alt+P', tip: 'Let the selected UVs go again', run: () => pinSelected(false), on: any,
      icon: ico('M7 2h6M8 2v5l-3 4h10l-3-4V2', 'M10 11v7M3 3l14 14') },
  },
];

/** UV Magician's options bar: the last tool, its Mode group, what is selected, Unwrap Selection and Live Unwrap. The
 *  UV display, scope and framing controls live in the UV view header; the post-edit Align/Pack settings live with the
 *  unwrap settings in the dock, where they belong. */
export function UVOptionsBar() {
  const tool = useApp((s) => s.uvTool), live = useApp((s) => s.liveUnwrap);
  const sel = useApp((s) => { const c = selectionCount(s); return c ? `${c.n} ${c.label}` : ''; });
  const plane = useApp((s) => s.symPlane), edit = useApp((s) => s.symEdit), has = useApp((s) => !!s.result);
  const t = tool ? UV_TOOLS.find((g) => g[tool as UvTool])?.[tool as UvTool] : undefined;
  const none = !sel;
  return (
    <div className="options">
      <span className="toolname">{t ? <>{t.icon}{t.name}</> : <><Icon name="cursor" size={16} />Select</>}</span>
      <SelectionControls />
      {sel && <span className="hint">{sel} selected</span>}
      <button disabled={none} title="Unwrap just the selected faces again; pins hold (U)" onClick={() => void unwrapSelected()}>Unwrap selection</button>
      <label title="Dragging a pin lays its islands out again as you drag"><input type="checkbox" checked={live} onChange={(e) => setLiveUnwrap(e.target.checked)} />Live Unwrap</label>
      {!edit ? (
        <button className={plane ? 'on' : ''} disabled={!has} onClick={editSymPlane}
          title={plane ? 'Move or turn the mirror plane, then Apply (Esc puts it back)' : 'Spawn the mirror plane: move and turn it, then Apply; Unwrap mirrors across it instead of guessing one'}>
          {plane ? 'Symmetry plane ✓' : 'Symmetry plane'}
        </button>
      ) : (
        <>
          <button className="on" onClick={applySymPlane} title="Unwrap the whole model across the plane as it sits (Enter)">Apply</button>
          <button className={edit.mode === 'translate' ? 'on' : ''} onClick={() => setSymMode('translate')} title="Move the plane (G)">Move</button>
          <button className={edit.mode === 'rotate' ? 'on' : ''} onClick={() => setSymMode('rotate')} title="Turn the plane (R)">Rotate</button>
          <button onClick={cancelSymPlane} title="Put the plane back and keep the UVs as they are (Esc)">Cancel</button>
        </>
      )}
    </div>
  );
}

export function UVToolStrip() {
  const counts = useApp((s) => { const c = liveSel(s); return c ? `${c.faces.size},${c.edges.size},${c.verts.size}` : '0,0,0'; }).split(',').map(Number) as Counts;
  const box = useApp((s) => s.boxArmed), has = useApp((s) => !!s.result);
  return (
    <ToolStrip label="UV Magician tools" groups={UV_TOOLS} on={(t) => has && t.on(counts)} mode={(id) => id === 'box'} pressed={(id) => id === 'box' && box}
      pick={(id) => { useApp.setState({ uvTool: id }); void UV_TOOLS.find((g) => g[id])![id]!.run(); }} />
  );
}
