// The right dock: the workspace's main panel and the Parts tree. Panels collapse from their headers (no fake tabs);
// Van Gogh pins Layers to the bottom so it is always in reach.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { islandsOf } from '../islands';
import { CHANNELS, type Channel, type Shown } from '../paint';
import { Icon } from '../ui/Icon';
import {
  alignSeamsSel, averageScalesSel, circleBoundarySel, clearSeams, copyShapeSel, mergeSel, normalizeSel, offsetBoundarySel, orientSel, orientWorldSel,
  pasteShapeSel, pickPaintChannel, pickPaintPart, rectifySel, selectAll, selectFlipped, selectMirror, selectPart, partsMenu, clearAllSeams, selectSide, selectSimilar, selectZeroArea,
  setAfterAlign, setAfterPack, setParams, setPartTextured, setPartVisible, setPbr, shuffleSel, sortSel, stackSel, stretchSel, straightenSel, symmetrizeSel, texSet, togglePaintOpen,
  unwrap, useApp,
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
  const align = useApp((s) => s.afterAlign), pack = useApp((s) => s.afterPack);
  return (
    <div className="settings">
      <label title="Edges bending more than this always become seams (a cube's 90° edges, a cylinder's rims).">Sharp edges
        <span><Field disabled={busy} min={1} max={180} step={5} value={params.sharp} aria-label="Sharp edge angle" onCommit={(v) => setParams({ sharp: v })} />°</span></label>
      <label title="An island stretching less than this is kept as is, without trying to split it.">Stretch tolerance
        <span><Field disabled={busy} min={0.5} max={50} step={1} value={+(params.tol * 100).toFixed(2)} aria-label="Stretch tolerance" onCommit={(v) => setParams({ tol: v / 100 })} />%</span></label>
      <label title="What a seam costs against stretch. Higher: fewer, longer islands that stretch more. Lower: more islands, less stretch.">Seam cost
        <span><Field disabled={busy} min={0} max={5} step={0.05} value={params.seam_weight} aria-label="Seam cost" onCommit={(v) => setParams({ seam_weight: Math.max(0, v) })} /></span></label>
      <label className="toggle" title="Hang islands off each other along shared edges wherever they fit without overlapping: a cube becomes its cross.">
        <input type="checkbox" disabled={busy} checked={params.join} onChange={(e) => setParams({ join: e.target.checked })} />Join into nets</label>
      <label className="toggle" title="Pack every part into one shared UV square. Off: each part gets its own square.">
        <input type="checkbox" disabled={busy} checked={params.one_atlas} onChange={(e) => setParams({ one_atlas: e.target.checked })} />One atlas</label>
      <label className="toggle" title="After a Cut, Stitch or Unwrap Selection: turn the islands it made so their straight edges run along U or V.">
        <input type="checkbox" checked={align} onChange={(e) => setAfterAlign(e.target.checked)} />Auto-align after edits</label>
      <label className="toggle" title="After a Cut, Stitch or Unwrap Selection: pack the part's islands again to fill the square.">
        <input type="checkbox" checked={pack} onChange={(e) => setAfterPack(e.target.checked)} />Auto-pack after edits</label>
    </div>
  );
}

export function Panel({ title, children, grow, pinned }: { title: string; children: ReactNode; grow?: boolean; pinned?: boolean }) {
  const key = `dock:${title}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* private mode */ }
  };
  return (
    <div className={`dock-group${grow ? ' grow' : ''}${pinned ? ' pinned' : ''}${open ? '' : ' closed'}`}>
      <div className="dock-tabs">
        <button aria-expanded={open} onClick={toggle} title={open ? `Collapse ${title}` : `Expand ${title}`}>
          <span className="caps">{title}</span><Icon name="chevron" size={12} className="chev" />
        </button>
      </div>
      {open && <div className="pbody">{children}</div>}
    </div>
  );
}

export const eye = (on: boolean) => <Icon name={on ? 'eye' : 'eye-off'} size={16} />;
const checker = (on: boolean) => <Icon name="checker" size={16} />;

/** The parts list: one tree in every workspace, with the columns that workspace needs. */
export function Parts({ workspace = 'uv' }: { workspace?: 'uv' | 'doc' | 'paint' }) {
  const parts = useApp((s) => s.parts), result = useApp((s) => s.result), layerSel = useApp((s) => s.layerSel), activePart = useApp((s) => s.activePart);
  const paint = workspace === 'paint', doc = workspace === 'doc';
  const open = useApp((s) => s.paintOpen), shown = useApp((s) => s.paintChannel);
  useApp((s) => s.paintRev);
  const paintParts = useApp((s) => s.parts.length);
  const isl = result ? islandsOf(result) : [], picked = new Set(layerSel);
  const seams = (parts[activePart]?.marked.length ?? 0) / 6;
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { if (paint) list.current?.querySelector('.layer.active')?.scrollIntoView({ block: 'nearest' }); }, [paint, activePart, open, paintParts]);
  const counts = (p: (typeof parts)[number], n: number) => {
    const tris = p.soup.length / 9, seams = p.seams.length / 6, marked = p.marked.length / 6;
    return `${tris.toLocaleString()} ${tris === 1 ? 'triangle' : 'triangles'} · ${n} ${n === 1 ? 'island' : 'islands'} · ${seams} ${seams === 1 ? 'seam' : 'seams'}${marked ? ` (${marked} marked)` : ''}`;
  };
  const activeChannels = paint && parts[activePart] ? texSet(activePart).channels : null;
  return (
    <>
      {paint && activeChannels && (
        <div className="partshead">
          <span className="caps">Texture set</span>
          <span className="hint">{parts[activePart]?.name}</span>
          <button className="pbr" aria-pressed={activeChannels.length > 1} title={activeChannels.length > 1 ? 'Back to Base Color only' : 'Add Roughness and Metallic (PBR metal/rough, what glTF, Unity and Unreal read)'}
            onClick={() => setPbr(activePart, activeChannels.length === 1)}>{activeChannels.length > 1 ? 'PBR' : '+ PBR'}</button>
        </div>
      )}
      <ul className={`layers${doc ? ' doc' : ''}${paint ? ' paint tree' : ''}`} ref={list} aria-label="Parts (right click for more)" onContextMenu={(e) => { e.preventDefault(); partsMenu(e.clientX, e.clientY, null); }}>
        {parts.map((p, i) => {
          const mine = isl.flatMap((x, id) => (x.part === i ? [id] : [])), tex = p.textured !== false;
          const isOpen = paint && open.includes(i);
          const chs = paint ? texSet(i).channels : null;
          return [
            <li key={i} aria-selected={picked.has(i)} className={`layer${i === activePart ? ' active' : ''}${picked.has(i) ? ' on' : ''}`}
              onClick={(e) => { if (paint) pickPaintPart(i); else selectPart(i, e.shiftKey, e.ctrlKey || e.metaKey); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); partsMenu(e.clientX, e.clientY, i); }} title={`${p.name}: ${counts(p, mine.length)}`}>
              {paint && <button className="disclosure" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${p.name}`} onClick={(e) => { e.stopPropagation(); togglePaintOpen(i); }}>
                <Icon name="chevron" size={12} className={isOpen ? 'chev' : 'chev closed'} />
              </button>}
              <button aria-pressed={p.visible} title={p.visible ? 'Hide part' : 'Show part'} aria-label={`${p.visible ? 'Hide' : 'Show'} ${p.name}`} onClick={(e) => { e.stopPropagation(); setPartVisible(i, !p.visible); }}>{eye(p.visible)}</button>
              {!doc && !paint && <button aria-pressed={tex} title={tex ? 'Hide checker texture' : 'Show checker texture'} aria-label={`${tex ? 'Hide texture on' : 'Show texture on'} ${p.name}`} onClick={(e) => { e.stopPropagation(); setPartTextured(i, !tex); }}>{checker(tex)}</button>}
              <span className="lname">{p.name}</span>
              <span className="ltype num">{paint ? `${chs!.length > 1 ? 'PBR' : 'Base'}` : doc ? `${(p.sides?.length ?? p.soup.length / 9).toLocaleString()} poly` : `${mine.length} isl`}</span>
            </li>,
            ...(paint && isOpen ? ['material' as Shown, ...chs!, ...(texSet(i).bake ? ['ao', 'curv'] as Shown[] : [])] : []).map((ch) => (
              <li key={`${i}${ch}`} className={`layer sub${i === activePart && ch === shown ? ' on' : ''}${ch === 'ao' || ch === 'curv' ? ' baked' : ''}`}
                onClick={() => pickPaintChannel(i, ch)} title={`Show ${NAMES[ch]} in the texture view`}>
                <span /><span /><span className="lname">{NAMES[ch]}</span><span />
              </li>
            )),
          ];
        })}
      </ul>
      {!paint && seams > 0 && <button className="wide" onClick={clearSeams}>Clear {seams} marked seam{seams > 1 ? 's' : ''} on {parts[activePart]?.name}</button>}
    </>
  );
}

const NAMES: Record<Shown, string> = { ...Object.fromEntries(Object.entries(CHANNELS).map(([k, v]) => [k, v.name])) as Record<Channel, string>, ao: 'Ambient Occlusion (baked)', curv: 'Curvature (baked)', material: 'Material (lit)' };

/** Hand edits on the selected islands, whole islands at a time (Mio3 UV's Align, Arrange and Select). The common
 *  alignment and transform commands live in the island task bar over the view; this dock keeps the long tail. */
function UVTools() {
  const n = useApp((s) => s.selected.length), loading = useApp((s) => !!s.loading), has = useApp((s) => !!s.result && !s.loading);
  const hasShape = useApp((s) => !!s.shapeClipboard), manual = useApp((s) => !!s.parts[s.activePart]?.manual);
  const [worldAxis, setWorldAxis] = useState<'auto' | 'x' | 'y' | 'z'>('auto'), [uvAxis, setUvAxis] = useState<0 | 1>(0);
  const b = (label: string, title: string, run: () => void, off = n === 0 || loading) => <button key={label} disabled={off} title={title} onClick={run}>{label}</button>;
  const axis: 0 | 1 | 2 = worldAxis === 'auto' ? (uvAxis === 0 ? 0 : 2) : worldAxis === 'x' ? 0 : worldAxis === 'y' ? 1 : 2;
  const section = (title: string, hint: string, body: ReactNode) => (
    <details className="tsec-details">
      <summary className="tsec"><span className="caps"><Icon name="chevron" size={11} className="chev" />{title}</span><span className="hint">{hint}</span></summary>
      {body}
    </details>
  );
  return (
    <>
      <button className="primary wide" disabled={!has} title="Start over: unwrap the active part automatically, keeping only the seams you marked (Ctrl+Enter)" onClick={() => void unwrap()}>Auto Unwrap</button>
      <UnwrapSettings />
      <div className="tgrid two">
        {b('Normalize', 'Fit selected UV islands into the 0..1 square', normalizeSel)}
        {b('Gridify', 'Map a selected single-boundary triangle chart to a rectangle with evenly spaced boundary edges', () => rectifySel(true))}
        {b('Rectify', 'Map a selected single-boundary triangle chart to a rectangle while preserving boundary lengths', () => rectifySel(false))}
      </div>
      <button className="wide" disabled={!has} title="Start over by hand: every seam on the active part cleared and its UVs laid flat from none. Then only your cuts (C) and stitches (V) make islands; Auto Unwrap goes back to automatic." onClick={() => void clearAllSeams()}>{manual ? 'Clear all seams (seaming by hand)' : 'Clear all seams, seam by hand'}</button>
      {section('Islands', n ? `${n} selected` : 'select islands first', <>
        <div className="tgrid two">
          {b('Align Axis', 'Turn each island so its strongest straight edge direction follows U or V', straightenSel)}
          {b('Orient', 'Turn each island’s longest axis along U', orientSel)}
          {b('Orient World', 'Turn each island so world up points up in UV', orientWorldSel)}
          {b('Sort', 'Order selected islands left to right by their 3D X position', sortSel, n < 2)}
          {b('Same scale', 'Average Island Scales: one texel density for all the selected islands', averageScalesSel)}
          {b('Merge', 'Weld selected UV corners within 0.0001 UV units', mergeSel)}
          {b('Circle', 'Circularize the selected island boundary loops', circleBoundarySel)}
          {b('Offset', 'Expand selected island borders by 0.005 UV units', () => offsetBoundarySel(0.005))}
          {b('Align Seams', 'Bring UV copies of shared 3D vertices together across selected islands', alignSeamsSel)}
          {b('Stretch', 'Match selected island widths while preserving each height', stretchSel)}
          {b('Stack', 'Stack selected islands that have matching 3D size and triangle count', stackSel)}
          {b('Shuffle', 'Randomly exchange the positions of selected islands', shuffleSel, n < 2)}
          {b('Copy', 'Copy the first selected island UV shape', copyShapeSel)}
          {b('Paste', 'Paste the copied shape onto matching selected islands, preserving their bounds', pasteShapeSel, n === 0 || !hasShape)}
        </div>
      </>)}
      {section('Symmetrize', '', <>
        <label className="hint">UV axis <select value={uvAxis} onChange={(e) => setUvAxis(+e.target.value as 0 | 1)}><option value={0}>X</option><option value={1}>Y</option></select> 3D axis <select value={worldAxis} onChange={(e) => setWorldAxis(e.target.value as typeof worldAxis)}><option value="auto">Auto</option><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label>
        <div className="tgrid two">
          {b('Symmetrize', 'Mirror selected source side UVs onto the matching 3D side', () => symmetrizeSel(axis, uvAxis))}
          {b('Snap', 'Snap nearby opposite-side UVs to the selected side’s mirrored coordinates', () => symmetrizeSel(axis, uvAxis, true))}
        </div>
      </>)}
      {section('Select', '', <div className="tgrid">
        {b('−X side', 'Islands on the −X half of each shown part', () => selectSide(-1), !has)}
        {b('Mirror', 'Add the spatial mirror twin across each part’s X center', selectMirror)}
        {b('+X side', 'Islands on the +X half of each shown part', () => selectSide(1), !has)}
        {b('Similar', 'Add islands like the selected ones (same part, about the same size and triangle count)', selectSimilar)}
        {b('Flipped', 'Islands with triangles turned over in UV', selectFlipped, !has)}
        {b('All', 'Everything on the active mesh (A)', selectAll, !has)}
        {b('No Region', 'Select islands with effectively zero UV area', selectZeroArea, !has)}
      </div>)}
    </>
  );
}

export function Dock() {
  return (
    <aside className="dock">
      <Panel title="Unwrap" grow><UVTools /></Panel>
      <Panel title="Parts"><Parts /></Panel>
    </aside>
  );
}
