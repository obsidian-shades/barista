// Fixed pieces of the shell: the select modes, the menu at the pointer (a list or a pie), the status bar.
import { healthColor } from '../health';
import { closeMenu, kindOf, liveSel, setSelectMode, useApp, type SelectMode } from '../store';

const MODE_NAMES: [SelectMode, string, string][] = [['vert', 'Vertex', '1'], ['edge', 'Edge', '2'], ['face', 'Face', '3'], ['island', 'Island', '4']];
/** Blender's select mode buttons (shared by the 3D and UV views). */
export function SelectModes() {
  const m = useApp((s) => s.selectMode), doc = useApp((s) => s.workspace === 'doc');
  return (
    <span className="seg modes" role="group" aria-label="Select mode">
      {MODE_NAMES.filter(([k]) => !doc || k !== 'island').map(([k, name, key]) => <button key={k} aria-pressed={m === k} title={`${name} select (${key})`} onClick={() => setSelectMode(k)}>{name}</button>)}
    </span>
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
          {menu.items.map((it, i) => {
            const a = (i / menu.items.length) * Math.PI * 2;
            return (
              <button key={it.label} role="menuitem" disabled={it.off} title={it.kbd} style={{ left: Math.sin(a) * 120, top: -Math.cos(a) * 92 }}
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
  const server = useApp((s) => s.server), busy = useApp((s) => s.busy), error = useApp((s) => s.error), edited = useApp((s) => s.edited);
  const source = useApp((s) => s.source), stats = useApp((s) => s.result?.stats), parts = useApp((s) => s.parts.length), doc = useApp((s) => s.workspace === 'doc');
  // Poly Doc reads the mesh only: polygons and triangles of every part, nothing from the unwrap
  const mesh = useApp((s) => s.parts.reduce((a, p) => [a[0] + (p.sides?.length ?? p.soup.length / 9), a[1] + p.soup.length / 9], [0, 0]).join());
  const sel = useApp((s) => { const c = liveSel(s), kind = kindOf(s.selectMode); return c ? `${s.selectMode === 'island' ? s.selected.length : c[kind].size} ${s.selectMode === 'island' ? 'islands' : kind === 'verts' ? 'vertices' : kind}` : ''; });
  return (
    <div className="status">
      <span className={`dot ${server}`} title={`Engine ${server}`}>Engine {server === 'up' ? 'ready' : server}</span>
      {source && <span>{source}{parts > 1 && ` · ${parts} parts`}</span>}
      {doc ? parts > 0 && <>
        <span><span className="num">{(+mesh.split(',')[0]).toLocaleString()}</span> polygons</span>
        <span><span className="num">{(+mesh.split(',')[1]).toLocaleString()}</span> triangles</span>
      </> : stats && <>
        <span><span className="num">{stats.tris.toLocaleString()}</span> triangles</span>
        <span><span className="num">{stats.islands}</span> islands</span>
        <span>stretch <span className="num">{pct(stats.mean_stretch)}</span></span>
      </>}
      {sel && <span>{sel} selected</span>}
      {edited && <span title="UVs moved by hand since the last unwrap; Auto Unwrap starts over">edited by hand</span>}
      {busy && <span className="busy">{busy}</span>}
      {error && <span className="err" title={error}>{error}</span>}
      <span className="hint">{doc ? 'Hold Z: views · J connect · M merge · Ctrl+R loop cut · Ctrl+X dissolve · Alt+J tris to quads' : 'Right click or Q: Cut, Stitch, Unwrap…'}</span>
      <span className="build">v{__VERSION__}</span>
    </div>
  );
}
