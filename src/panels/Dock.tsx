// The panel dock: UV tools (unwrapping, seams, hand edits after Mio3 UV) on top, Parts (like espresso's layers) below.
import { useEffect, useState, type ReactNode } from 'react';
import { islandsOf } from '../islands';
import {
  alignSel, alignSeamsSel, averageScalesSel, circleBoundarySel, clearSeams, copyShapeSel, distributeSel, flipSel, mergeSel, normalizeSel, offsetBoundarySel, orientSel, orientWorldSel, pasteShapeSel, relaxSel, repack, rotateSel, selectAll, selectEdgeLoop, cutSelection, stitchSelection, setParams, unwrapSelected,
  rectifySel, selectFlipped, selectMirror, selectPart, partsMenu, clearAllSeams, selectSide, selectSimilar, selectZeroArea, setPartTextured, setPartVisible, shuffleSel, sortSel, stackSel, stretchSel, straightenSel, symmetrizeSel, liveSel, unwrap, useApp, type Edge,
} from '../store';

// Number field that commits on Enter or blur, like espresso's Field: one unwrap per edit, not per keystroke.
function Field({ value, onCommit, ...rest }: { value: number; onCommit: (v: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value'>) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => { const v = +text; if (Number.isFinite(v) && v !== value) onCommit(v); else setText(String(value)); };
  return <input type="number" {...rest} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

/** The automatic unwrap's settings: changing one unwraps the active part again. */
function UnwrapSettings() {
  const params = useApp((s) => s.params), busy = useApp((s) => !!s.busy);
  return (
    <div className="settings">
      <label title="Edges bending more than this always become seams (a cube's 90° edges, a cylinder's rims).">Sharp edges
        <span><Field disabled={busy} min={1} max={180} step={5} value={params.sharp} aria-label="Sharp edge angle" onCommit={(v) => setParams({ sharp: v })} />°</span></label>
      <label title="An island stretching less than this is kept as is, without trying to split it.">Good enough
        <span><Field disabled={busy} min={0.5} max={50} step={1} value={+(params.tol * 100).toFixed(2)} aria-label="Good enough stretch" onCommit={(v) => setParams({ tol: v / 100 })} />%</span></label>
      <label title="What a seam costs against stretch. Higher: fewer, longer islands that stretch more. Lower: more islands, less stretch.">Seam cost
        <span><Field disabled={busy} min={0} max={5} step={0.05} value={params.seam_weight} aria-label="Seam cost" onCommit={(v) => setParams({ seam_weight: Math.max(0, v) })} /></span></label>
      <label className="toggle" title="Hang islands off each other along shared edges wherever they fit without overlapping: a cube becomes its cross.">
        <input type="checkbox" disabled={busy} checked={params.join} onChange={(e) => setParams({ join: e.target.checked })} />Join into nets</label>
      <label className="toggle" title="Pack every part into one shared UV square. Off: each part gets its own square.">
        <input type="checkbox" disabled={busy} checked={params.one_atlas} onChange={(e) => setParams({ one_atlas: e.target.checked })} />One atlas</label>
    </div>
  );
}

export function Panel({ title, children, grow }: { title: string; children: ReactNode; grow?: boolean }) {
  return (
    <div className={`dock-group${grow ? ' grow' : ''}`}>
      <div className="dock-tabs"><span role="tab" aria-selected="true">{title}</span></div>
      <div className="pbody">{children}</div>
    </div>
  );
}

export const eye = (on: boolean) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="2.5" />{!on && <path d="M4 20L20 4" />}
  </svg>
);

const checker = (on: boolean) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="4" height="4" /><rect x="12" y="4" width="4" height="4" />
    <rect x="8" y="8" width="4" height="4" /><rect x="16" y="8" width="4" height="4" />
    <rect x="4" y="12" width="4" height="4" /><rect x="12" y="12" width="4" height="4" />
    <rect x="8" y="16" width="4" height="4" /><rect x="16" y="16" width="4" height="4" />
    {!on && <path d="M4 20L20 4" fill="none" stroke="currentColor" strokeWidth="1.8" />}
  </svg>
);

/** The parts list (espresso's layers). `doc`: Poly Doc's, which counts polygons instead of islands (it doesn't unwrap). */
export function Parts({ doc = false }: { doc?: boolean }) {
  const parts = useApp((s) => s.parts), result = useApp((s) => s.result), layerSel = useApp((s) => s.layerSel), activePart = useApp((s) => s.activePart);
  const isl = result ? islandsOf(result) : [], picked = new Set(layerSel);
  const seams = (parts[activePart]?.marked.length ?? 0) / 6;
  const counts = (p: (typeof parts)[number], n: number) => `${(p.soup.length / 9).toLocaleString()} triangles · ${n} islands · ${p.seams.length / 6} seams${p.marked.length ? ` (${p.marked.length / 6} marked)` : ''}`;
  return (
    <>
      <ul className={`layers${doc ? ' doc' : ''}`} aria-label="Parts (right click for more)" onContextMenu={(e) => { e.preventDefault(); partsMenu(e.clientX, e.clientY, null); }}>
        {parts.map((p, i) => {
          const mine = isl.flatMap((x, id) => (x.part === i ? [id] : [])), tex = p.textured !== false;
          return (
            <li key={i} aria-selected={picked.has(i)} className={`layer${i === activePart ? ' active' : ''}${picked.has(i) ? ' on' : ''}`} onClick={(e) => selectPart(i, e.shiftKey, e.ctrlKey || e.metaKey)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); partsMenu(e.clientX, e.clientY, i); }} title={`${p.name}: ${counts(p, mine.length)}`}>
              <button aria-pressed={p.visible} title={p.visible ? 'Hide part' : 'Show part'} aria-label={`${p.visible ? 'Hide' : 'Show'} ${p.name}`} onClick={(e) => { e.stopPropagation(); setPartVisible(i, !p.visible); }}>{eye(p.visible)}</button>
              {!doc && <button aria-pressed={tex} title={tex ? 'Hide checker texture' : 'Show checker texture'} aria-label={`${tex ? 'Hide texture on' : 'Show texture on'} ${p.name}`} onClick={(e) => { e.stopPropagation(); setPartTextured(i, !tex); }}>{checker(tex)}</button>}
              <span className="lname">{p.name}</span>
              <span className="ltype num">{doc ? `${(p.sides?.length ?? p.soup.length / 9).toLocaleString()} poly` : `${mine.length} isl`}</span>
            </li>
          );
        })}
      </ul>
      {seams > 0 && <button className="wide" onClick={clearSeams}>Clear {seams} marked seam{seams > 1 ? 's' : ''} on {parts[activePart]?.name}</button>}
    </>
  );
}

/** Hand edits on the selected islands, whole islands at a time (Mio3 UV's Align, Arrange and Select). */
function UVTools() {
  const n = useApp((s) => s.selected.length), loading = useApp((s) => !!s.loading), has = useApp((s) => !!s.result && !s.loading);
  const edges = useApp((s) => liveSel(s)?.edges.size ?? 0);
  const hasShape = useApp((s) => !!s.shapeClipboard), manual = useApp((s) => !!s.parts[s.activePart]?.manual);
  const [worldAxis, setWorldAxis] = useState<'auto' | 'x' | 'y' | 'z'>('auto'), [uvAxis, setUvAxis] = useState<0 | 1>(0);
  const b = (label: string, title: string, run: () => void, off = n === 0 || loading) => <button key={label} disabled={off} title={title} onClick={run}>{label}</button>;
  const edge = (e: Edge, label: string, title: string) => b(label, `${title} (a lone island: the square's)`, () => alignSel(e));
  const axis: 0 | 1 | 2 = worldAxis === 'auto' ? (uvAxis === 0 ? 0 : 2) : worldAxis === 'x' ? 0 : worldAxis === 'y' ? 1 : 2;
  return (
    <>
      <div className="tsec"><span className="caps">Unwrap</span></div>
      <button className="primary wide" disabled={!has} title="Start over: unwrap the active part automatically, keeping only the seams you marked (Ctrl+Enter)" onClick={() => void unwrap()}>Auto Unwrap</button>
      <UnwrapSettings />
      <div className="tgrid two">
        {b('Unwrap selection', 'Unwrap just the selected faces again, their islands made by the seams, pins held (U)', () => void unwrapSelected())}
        {b('Normalize', 'Fit selected UV islands into the 0..1 square', normalizeSel)}
        {b('Gridify', 'Map a selected single-boundary triangle chart to a rectangle with evenly spaced boundary edges', () => rectifySel(true))}
        {b('Rectify', 'Map a selected single-boundary triangle chart to a rectangle while preserving boundary lengths', () => rectifySel(false))}
      </div>
      <div className="tsec"><span className="caps">Seams</span><span className="hint">right click or Q</span></div>
      <div className="tgrid">
        <button disabled={!edges || loading} title="Cut along the selected edges (with faces selected: round their outline), making seams there (C)" onClick={cutSelection}>Cut</button>
        <button disabled={!edges || loading} title="Stitch the selected edges (with faces selected: the edges between them) back together, seams or tears (V)" onClick={stitchSelection}>Stitch</button>
        <button disabled={!edges || loading} title="The edge loop through each selected edge (Alt+click picks one directly)" onClick={() => void selectEdgeLoop()}>Select Loop</button>
      </div>
      <button className="wide" disabled={!has} title="Start over by hand: every seam on the active part cleared and its UVs laid flat from none. Then only your cuts (C) and stitches (V) make islands; Auto Unwrap goes back to automatic." onClick={() => void clearAllSeams()}>{manual ? 'Clear all seams (seaming by hand)' : 'Clear all seams, seam by hand'}</button>
      <div className="tsec"><span className="caps">Align</span><span className="hint">{n ? `${n} selected` : 'select islands first'}</span></div>
      <div className="tgrid">
        {edge('top-left', '↖', 'Align top left')}
        {edge('top', '↑', 'Align top')}
        {edge('top-right', '↗', 'Align top right')}
        {edge('left', '←', 'Align left')}
        {edge('center', '✣', 'Align center')}
        {edge('right', '→', 'Align right')}
        {edge('bottom-left', '↙', 'Align bottom left')}
        {edge('bottom', '↓', 'Align bottom')}
        {edge('bottom-right', '↘', 'Align bottom right')}
      </div>
      <div className="tgrid two">
        {b('Align Axis', 'Turn each island so its strongest straight edge direction follows U or V', straightenSel)}
        {b('Orient', 'Turn each island’s longest axis along U', orientSel)}
        {b('Orient World', 'Turn each island so world up points up in UV', orientWorldSel)}
        {b('Sort', 'Order selected islands left to right by their 3D X position', sortSel, n < 2)}
        {b('Distribute', 'Space selected islands evenly along U', () => distributeSel('u'), n < 3)}
      </div>
      <div className="tsec"><span className="caps">Arrange</span></div>
      <div className="tgrid two">
        {b('Same scale', 'Average Island Scales: one texel density for all the selected islands', averageScalesSel)}
        {b('Spread ↔', 'Equal gaps left to right (3 or more islands)', () => distributeSel('u'), n < 3)}
        {b('Spread ↕', 'Equal gaps top to bottom (3 or more islands)', () => distributeSel('v'), n < 3)}
        {b('Relax', 'Re-flatten selected islands from their current shape', () => void relaxSel())}
        {b('Merge', 'Weld selected UV corners within 0.0001 UV units', mergeSel)}
        {b('Circle', 'Circularize the selected island boundary loops', circleBoundarySel)}
        {b('Offset', 'Expand selected island borders by 0.005 UV units', () => offsetBoundarySel(0.005))}
        {b('Align Seams', 'Bring UV copies of shared 3D vertices together across selected islands', alignSeamsSel)}
        {b('Stretch', 'Match selected island widths while preserving each height', stretchSel)}
        {b('Stack', 'Stack selected islands that have matching 3D size and triangle count', stackSel)}
        {b('Shuffle', 'Randomly exchange the positions of selected islands', shuffleSel, n < 2)}
        {b('Copy', 'Copy the first selected island UV shape', copyShapeSel)}
        {b('Paste', 'Paste the copied shape onto matching selected islands, preserving their bounds', pasteShapeSel, n === 0 || !hasShape)}
        {b('Pack', 'Repack islands into the atlas', () => void repack(), !has)}
        {b('↶ 90°', 'Rotate the selection 90° counter-clockwise', () => rotateSel(90))}
        {b('180°', 'Rotate the selection 180°', () => rotateSel(180))}
        {b('↷ 90°', 'Rotate the selection 90° clockwise', () => rotateSel(-90))}
        {b('⇋ Flip', 'Mirror the selection left to right (F; Shift+F up to down)', () => flipSel(true))}
        {b('⇅ Flip V', 'Mirror the selection top to bottom', () => flipSel(false))}
      </div>
      <div className="tsec"><span className="caps">Symmetrize</span></div>
      <label className="hint">UV axis <select value={uvAxis} onChange={(e) => setUvAxis(+e.target.value as 0 | 1)}><option value={0}>X</option><option value={1}>Y</option></select> 3D axis <select value={worldAxis} onChange={(e) => setWorldAxis(e.target.value as typeof worldAxis)}><option value="auto">Auto</option><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label>
      <div className="tgrid two">
        {b('Symmetrize', 'Mirror selected source side UVs onto the matching 3D side', () => symmetrizeSel(axis, uvAxis))}
        {b('Snap', 'Snap nearby opposite-side UVs to the selected side’s mirrored coordinates', () => symmetrizeSel(axis, uvAxis, true))}
      </div>
      <div className="tsec"><span className="caps">Select</span></div>
      <div className="tgrid">
        {b('−X side', 'Islands on the −X half of each shown part', () => selectSide(-1), !has)}
        {b('Mirror', 'Add the spatial mirror twin across each part’s X center', selectMirror)}
        {b('+X side', 'Islands on the +X half of each shown part', () => selectSide(1), !has)}
        {b('Similar', 'Add islands like the selected ones (same part, about the same size and triangle count)', selectSimilar)}
        {b('Flipped', 'Islands with triangles turned over in UV', selectFlipped, !has)}
        {b('All', 'Everything on the active mesh (A)', selectAll, !has)}
        {b('No Region', 'Select islands with effectively zero UV area', selectZeroArea, !has)}
      </div>
    </>
  );
}

export function Dock() {
  return (
    <aside className="dock">
      <Panel title="UV tools" grow><UVTools /></Panel>
      <Panel title="Parts"><Parts /></Panel>
    </aside>
  );
}
