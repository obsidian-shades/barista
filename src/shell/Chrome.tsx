// Fixed pieces of the shell: the select modes, the one Display/Shading cluster, the menu at the pointer, the status bar.
import { healthColor } from '../health';
import { closeMenu, displayChoices, setPaint, setSelectMode, texSet, useApp, type FillBy, type SelectMode } from '../store';
import { SceneSettings } from '../views/SceneSettings';

const MODE_NAMES: [SelectMode, string, string][] = [['vert', 'Vertex', '1'], ['edge', 'Edge', '2'], ['face', 'Face', '3'], ['island', 'Island', '4']];
/** Blender's select mode buttons, in the same slot in every workspace that has mesh selection. Poly Doc has no UV
 *  islands, so its Island button is disabled rather than dropped: the row never changes width or position. */
export function SelectModes() {
  const m = useApp((s) => s.selectMode), doc = useApp((s) => s.workspace === 'doc');
  return (
    <span className="seg modes" role="group" aria-label="Select mode" title="What a click selects (1–4)">
      {MODE_NAMES.map(([k, name, key]) => {
        const off = doc && k === 'island';
        return <button key={k} aria-pressed={m === k} disabled={off} onClick={() => setSelectMode(k)}
          title={off ? 'UV islands (UV Magician only)' : `${name} select (${key})`}>{name}</button>;
      })}
    </span>
  );
}

/** Van Gogh's selection granularity, in the same slot as the mesh select modes: what Select Faces and Bucket pick. */
const PAINT_KINDS: [FillBy, string, string][] = [
  ['face', 'Face', 'One face (its whole polygon)'],
  ['surface', 'Surface', 'The connected surface up to edges sharper than the angle: a panel, a flank, a bore'],
  ['island', 'Island', 'The UV island'],
  ['part', 'Part', 'The whole part'],
];
function PaintSelectModes() {
  const by = useApp((s) => s.paint.by), angle = useApp((s) => s.paint.angle);
  return (
    <>
      <span className="seg modes" role="group" aria-label="Select by" title="What Select Faces and Bucket pick">
        {PAINT_KINDS.map(([v, label, title]) => <button key={v} aria-pressed={by === v} title={title} onClick={() => setPaint({ by: v })}>{label}</button>)}
      </span>
      {by === 'surface' && (
        <label title="Surface stops at edges bent more than this, and at twice this from the clicked face (90°: a whole bore)">
          <input type="number" className="inc" min={1} max={90} step={5} value={angle} onChange={(e) => setPaint({ angle: Math.min(90, Math.max(1, +e.target.value || 30)) })} />°
        </label>
      )}
    </>
  );
}

/** The Display modes: the same control in every options bar, mirroring the Z pie and View › Display. */
function DisplayModes() {
  const current = useApp((s) => (s.workspace === 'doc' ? s.docView : s.workspace === 'paint' ? s.scene.lighting : s.mode));
  const choices = displayChoices();
  return (
    <span className="seg modes" role="group" aria-label="Display" title="What the view shows (Z)">
      {choices.map((c) => <button key={c.id} aria-pressed={c.id === current} title={c.title} onClick={c.run}>{c.label}</button>)}
    </span>
  );
}

/** The right end of every options bar: selection | display | Shading. One anatomy, one place to look. */
export function ViewControls() {
  const workspace = useApp((s) => s.workspace);
  return (
    <div className="viewcontrols">
      {workspace === 'paint' ? <PaintSelectModes /> : <SelectModes />}
      <span className="sep" aria-hidden="true" />
      <DisplayModes />
      <span className="sep" aria-hidden="true" />
      <SceneSettings />
    </div>
  );
}

/** The menu at the pointer: a list (right click, Ctrl+E) or a pie round it (Q). Click an item, or anywhere else to
 *  close it. */
export function PopupMenu() {
  const menu = useApp((s) => s.menu);
  if (!menu) return null;
  const pick = (run: () => void) => () => { closeMenu(); run(); };
  return (
    <div className="popup-scrim" onPointerDown={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}>
      {menu.pie ? (
        <div className="pie" role="menu" aria-label={menu.title} style={{ left: menu.x, top: menu.y }}>
          <span className="pie-hub" />
          <span className="pie-title">{menu.title}</span>
          {menu.items.map((it, i) => {
            const a = (i / menu.items.length) * Math.PI * 2;
            return (
              <button key={it.label} role="menuitem" aria-current={it.on ? 'true' : undefined} data-current={it.on || undefined} disabled={it.off} title={it.kbd} style={{ left: Math.sin(a) * 120, top: -Math.cos(a) * 92 }}
                onPointerDown={(e) => e.stopPropagation()} onClick={pick(it.run)}>{it.label}</button>
            );
          })}
        </div>
      ) : (
        <div className="popup" role="menu" style={{ left: Math.min(menu.x, innerWidth - 300), top: Math.max(8, Math.min(menu.y, innerHeight - 40 - menu.items.length * 25)) }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="popup-title">{menu.title}</div>
          {menu.items.map((it, i) => it.kind === 'head' ? <div key={i} className="popup-head">{it.label}</div>
            : it.kind === 'info' ? (
              <div key={i} className="popup-info" title={it.title}>
                <span className="dot" style={{ background: `rgb(${healthColor(it.tone ?? 0).map((c) => Math.round(c * 255)).join()})` }} />{it.label}
              </div>
            ) : <button key={i} role="menuitem" disabled={it.off} title={it.title} onClick={pick(it.run)}>{it.label}{it.kbd && <kbd>{it.kbd}</kbd>}</button>)}
        </div>
      )}
    </div>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export function StatusBar() {
  const server = useApp((s) => s.server), busy = useApp((s) => s.busy), error = useApp((s) => s.error), notice = useApp((s) => s.notice), edited = useApp((s) => s.edited);
  const stats = useApp((s) => s.result?.stats);
  const workspace = useApp((s) => s.workspace), doc = workspace === 'doc', paint = workspace === 'paint', uv = workspace === 'uv';
  // Poly Doc reads the mesh only: polygons and triangles of every part, nothing from the unwrap
  const mesh = useApp((s) => s.parts.reduce((a, p) => [a[0] + (p.sides?.length ?? p.soup.length / 9), a[1] + p.soup.length / 9], [0, 0]).join());
  // Van Gogh: what is being painted, not the unwrap's statistics
  const painting = useApp((s) => {
    if (s.workspace !== 'paint' || !s.parts[s.activePart]) return '';
    const ts = texSet(s.activePart);
    return `${s.parts[s.activePart].name} · ${ts.layers[ts.active]?.name ?? 'Layer'}`;
  });
  return (
    <div className="status">
      {/* Only a problem belongs in the status bar: a working engine is not news. */}
      {server === 'down' && <span className="dot down" title={error ?? 'Engine not reachable: run `pnpm server`'}>Engine offline</span>}
      {doc ? <>
        <span><span className="num">{(+mesh.split(',')[0]).toLocaleString()}</span> {+mesh.split(',')[0] === 1 ? 'polygon' : 'polygons'}</span>
        <span><span className="num">{(+mesh.split(',')[1]).toLocaleString()}</span> {+mesh.split(',')[1] === 1 ? 'triangle' : 'triangles'}</span>
      </> : paint ? <>
        {painting && <span>{painting}</span>}
        {stats && <span><span className="num">{stats.tris.toLocaleString()}</span> {stats.tris === 1 ? 'triangle' : 'triangles'}</span>}
      </> : stats && <>
        <span><span className="num">{stats.tris.toLocaleString()}</span> {stats.tris === 1 ? 'triangle' : 'triangles'}</span>
        <span><span className="num">{stats.islands}</span> {stats.islands === 1 ? 'island' : 'islands'}</span>
        <span>stretch <span className="num">{pct(stats.mean_stretch)}</span></span>
      </>}
      {edited && uv && <span title="UVs moved by hand since the last unwrap; Auto Unwrap starts over">edited by hand</span>}
      {busy && <span className="busy">{busy}</span>}
      {notice && !busy && <span title={notice}>{notice}</span>}
      {error && server !== 'down' && <span className="err" title={error}>{error}</span>}
      <span className="build">v{__VERSION__}</span>
    </div>
  );
}
