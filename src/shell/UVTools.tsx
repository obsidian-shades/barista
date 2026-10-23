// UV Magician's tool strip, the same Photoshop strip as Poly Doc's: what you do on the model (select, cut and stitch
// seams, unwrap and pin), then the island tools. Each runs what its menu item and key run.
import { armBox, cutSelection, liveSel, pinSelected, relaxSel, repack, selectEdgeLoop, selectLinked, setAfterAlign, setAfterPack, setLiveUnwrap, stitchSelection, unwrapSelected, useApp } from '../store';
import { glyph, ToolStrip, type Counts, type ToolDef } from './PolyTools';

type UvTool = 'box' | 'loop' | 'linked' | 'cut' | 'stitch' | 'unwrap' | 'pin' | 'unpin' | 'live' | 'relax' | 'pack';
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
    unwrap: { name: 'Unwrap Selection', key: 'U', tip: 'Unwrap just the selected faces again; pins hold', run: unwrapSelected, on: any,
      icon: glyph('M6 1.5h4v4h4v4h-4v5H6v-5H2v-4h4z') },
    pin: { name: 'Pin', key: 'P', tip: 'Pin the selected UVs where they are', run: () => pinSelected(true), on: any,
      icon: glyph('M8 14.5s-4-4.5-4-8a4 4 0 1 1 8 0c0 3.5-4 8-4 8z', '', [[8, 6.5]]) },
    unpin: { name: 'Unpin', key: 'Alt+P', tip: 'Let the selected UVs go again', run: () => pinSelected(false), on: any,
      icon: glyph('M8 14.5s-4-4.5-4-8a4 4 0 1 1 8 0c0 3.5-4 8-4 8zM2.5 2.5l11 11') },
    live: { name: 'Live Unwrap', tip: 'On: dragging a pin lays its islands out again as you drag', run: () => setLiveUnwrap(!useApp.getState().liveUnwrap), on: () => true,
      icon: glyph('M8 10.5s-2.5-2.8-2.5-5a2.5 2.5 0 1 1 5 0c0 2.2-2.5 5-2.5 5z', 'M2 13.5c2-1.5 4-1.5 6 0s4 1.5 6 0') },
  },
  {
    relax: { name: 'Relax', tip: 'Re-flatten the selected islands from their current shape', run: relaxSel, on: any,
      icon: glyph('M1.5 9c2.2-4 4.3-4 6.5 0s4.3 4 6.5 0', '', [[1.5, 9], [8, 9], [14.5, 9]]) },
    pack: { name: 'Pack', key: 'Ctrl+P', tip: 'Repack every island into the square', run: repack, on: () => true,
      icon: glyph('M2 2h5v5H2zM9 2h5v3H9zM9 7h5v7H9zM2 9h5v5H2z') },
  },
];

/** UV Magician's options bar, the same row as Poly Doc's: the last tool and what it does, what's selected, Live Unwrap,
 *  and what a seam edit does after it lands (Align, Pack). */
export function UVOptionsBar() {
  const tool = useApp((s) => s.uvTool), live = useApp((s) => s.liveUnwrap), align = useApp((s) => s.afterAlign), pack = useApp((s) => s.afterPack);
  const sel = useApp((s) => { const c = liveSel(s), m = s.selectMode; return c ? (m === 'island' ? `${s.selected.length} island` : m === 'face' ? `${c.faces.size} face` : m === 'edge' ? `${c.edges.size} edge` : `${c.verts.size} vert`) : ''; });
  const t = tool ? UV_TOOLS.find((g) => g[tool as UvTool])?.[tool as UvTool] : undefined;
  return (
    <div className="options">
      <span className="toolname">{t ? <>{t.icon}{t.name}</> : 'UV Magician'}</span>
      <span className="hint">{sel ? `${sel}${sel.startsWith('1 ') ? '' : 's'} selected` : 'Nothing selected'}</span>
      <label title="Dragging a pin lays its islands out again as you drag"><input type="checkbox" checked={live} onChange={(e) => setLiveUnwrap(e.target.checked)} />Live Unwrap</label>
      <label title="After a Cut, Stitch or Unwrap Selection: turn the islands it made so their straight edges run along U or V"><input type="checkbox" checked={align} onChange={(e) => setAfterAlign(e.target.checked)} />Align</label>
      <label title="After a Cut, Stitch or Unwrap Selection: pack the part's islands again to fill the square"><input type="checkbox" checked={pack} onChange={(e) => setAfterPack(e.target.checked)} />Pack</label>
      {t && <span className="hint" title={t.tip}>{t.tip}</span>}
    </div>
  );
}

export function UVToolStrip() {
  const counts = useApp((s) => { const c = liveSel(s); return c ? `${c.faces.size},${c.edges.size},${c.verts.size}` : '0,0,0'; }).split(',').map(Number) as Counts;
  const live = useApp((s) => s.liveUnwrap), box = useApp((s) => s.boxArmed), has = useApp((s) => !!s.result);
  return (
    <ToolStrip label="UV Magician tools" groups={UV_TOOLS} on={(t) => has && t.on(counts)}
      pressed={(id) => (id === 'live' ? live : id === 'box' ? box : false)} pick={(id) => { useApp.setState({ uvTool: id }); void UV_TOOLS.find((g) => g[id])![id]!.run(); }} />
  );
}
