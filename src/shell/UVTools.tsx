// UV Magician's tool strip, the same Photoshop strip as Poly Doc's. Modes and the core seam/selection tools live here;
// the one-shot island commands (Unwrap, Relax, Pack, Align, Rotate) live in the options bar, the contextual island bar
// and the menus, so the rail never repeats the dock.
import { armBox, cutSelection, liveSel, pinSelected, selectEdgeLoop, selectLinked, selectionCount, setLiveUnwrap, stitchSelection, unwrapSelected, useApp } from '../store';
import { glyph, Icon } from '../ui/Icon';
import { ViewControls } from './Chrome';
import { ToolStrip, type Counts, type ToolDef } from './PolyTools';

type UvTool = 'box' | 'loop' | 'linked' | 'cut' | 'stitch' | 'pin' | 'unpin';
const any = ([f, e, v]: Counts) => !!(f || e || v);

const UV_TOOLS: Partial<Record<UvTool, ToolDef>>[] = [
  {
    box: { name: 'Box Select', key: 'B', tip: 'Drag a box on the model to select what’s inside it (Shift adds, Ctrl takes away)', run: armBox, on: () => true,
      icon: glyph('', 'M2 3h12v10H2z', [[2, 3], [14, 13]]) },
    loop: { name: 'Select Loop', key: 'Alt+click', tip: 'The edge loop through each selected edge', run: selectEdgeLoop, on: ([, e]) => !!e,
      icon: glyph('M3 3h10v10H3z', 'M8 1v14') },
    linked: { name: 'Select Linked', key: 'Ctrl+L', tip: 'Grow the selection to whole islands', run: selectLinked, on: any,
      icon: glyph('M2 4h5v5H2zM9 7h5v5H9zM7 6.5h2') },
  },
  {
    cut: { name: 'Cut', key: 'C', tip: 'Make seams along the selected edges (with faces selected: round their outline)', run: cutSelection, on: ([, e]) => !!e,
      icon: glyph('M5.5 9.5L13 2M10.5 9.5L3 2M4 12a2 2 0 1 0 0.01 0M12 12a2 2 0 1 0 0.01 0') },
    stitch: { name: 'Stitch', key: 'V', tip: 'Join the selected edges back together (with faces selected: the edges between them)', run: stitchSelection, on: ([, e]) => !!e,
      icon: glyph('M2 8h12', 'M4 5l2 6M8 5l2 6M12 5l-2 6') },
  },
  {
    pin: { name: 'Pin', key: 'P', tip: 'Pin the selected UVs where they are', run: () => pinSelected(true), on: any,
      icon: glyph('M8 14.5s-4-4.5-4-8a4 4 0 1 1 8 0c0 3.5-4 8-4 8z', '', [[8, 6.5]]) },
    unpin: { name: 'Unpin', key: 'Alt+P', tip: 'Let the selected UVs go again', run: () => pinSelected(false), on: any,
      icon: glyph('M8 14.5s-4-4.5-4-8a4 4 0 1 1 8 0c0 3.5-4 8-4 8zM2.5 2.5l11 11') },
  },
];

/** UV Magician's options bar: the last tool and what it does, what is selected, Unwrap Selection, Live Unwrap, and the
 *  selection mode. The post-edit Align/Pack settings live with the unwrap settings in the dock, where they belong. */
export function UVOptionsBar() {
  const tool = useApp((s) => s.uvTool), live = useApp((s) => s.liveUnwrap);
  const sel = useApp((s) => { const c = selectionCount(s); return c ? `${c.n} ${c.label}` : ''; });
  const t = tool ? UV_TOOLS.find((g) => g[tool as UvTool])?.[tool as UvTool] : undefined;
  const none = !sel;
  return (
    <div className="options">
      <span className="toolname">{t ? <>{t.icon}{t.name}</> : <><Icon name="cursor" size={16} />Select</>}</span>
      {sel && <span className="hint">{sel} selected</span>}
      <button disabled={none} title="Unwrap just the selected faces again; pins hold (U)" onClick={() => void unwrapSelected()}>Unwrap selection</button>
      <label title="Dragging a pin lays its islands out again as you drag"><input type="checkbox" checked={live} onChange={(e) => setLiveUnwrap(e.target.checked)} />Live Unwrap</label>
      <ViewControls />
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
