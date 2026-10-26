// The app's questions, in the export dialog's frame: how to open a model (paint resolution, workspace, unwrap settings) and
// what to do with unsaved changes before the document is replaced or the window closes (store `ask`, `answerAsk`).
import { useEffect, useState } from 'react';
import { answerAsk, setAskOnOpen, TEXTURE_RESOLUTIONS, useApp, type OpenOpts, type Workspace } from '../store';

const WORKSPACES: [Workspace, string][] = [['doc', 'Poly Doc'], ['uv', 'UV Magician'], ['paint', 'Van Gogh']];

const sizeLabel = (n: number) => (n >= 1024 ? `${n / 1024}K` : `${n}`);

export function AskDialog() {
  const ask = useApp((s) => s.ask), last = useApp((s) => s.openOpts);
  const [o, setO] = useState(last), [again, setAgain] = useState(true);
  useEffect(() => { setO(last); setAgain(true); }, [ask, last]);
  const put = (p: Partial<OpenOpts>) => setO((v) => ({ ...v, ...p }));
  if (!ask) return null;
  const cancel = () => answerAsk(null);
  const open = () => { if (!again) setAskOnOpen(false); answerAsk(o); };
  const unsaved = ask.kind === 'unsaved';
  return (
    <div className="exp-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className="exp-dialog ask-dialog" role={unsaved ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="ask-title">
        <header className="exp-head">
          <div>
            <h2 id="ask-title">{unsaved ? 'Save changes?' : 'Open model'}</h2>
            <span className="hint">{ask.name}</span>
          </div>
          <button className="exp-close" aria-label="Cancel" title="Cancel (Esc)" onClick={cancel}>×</button>
        </header>
        {unsaved ? (
          <div className="exp-body"><p className="exp-detail">{ask.name} has changes that aren't saved. They are lost if you don't save them.</p></div>
        ) : (
          <div className="exp-body">
            <div className="exp-grid two">
              <label title="The size Van Gogh paints at. Export renders at its own size (to 16K); this is the working texture.">Paint resolution
                <select value={o.resolution} onChange={(e) => put({ resolution: +e.target.value })} autoFocus>
                  {TEXTURE_RESOLUTIONS.filter((n) => n >= 256).map((n) => <option key={n} value={n}>{sizeLabel(n)} — {n}×{n}</option>)}
                </select>
              </label>
              <label title="Where the model opens: Poly Doc to check and fix the topology first (it doesn't unwrap), UV Magician, or Van Gogh to paint.">Open in
                <select value={o.workspace} onChange={(e) => put({ workspace: e.target.value as Workspace })}>
                  {WORKSPACES.map(([w, label]) => <option key={w} value={w}>{label}</option>)}
                </select>
              </label>
              <label title="Edges bending more than this always become seams (a cube's 90° edges, a cylinder's rims).">Sharp edges (°)
                <input type="number" min={1} max={180} step={5} value={o.sharp} onChange={(e) => put({ sharp: Math.min(180, Math.max(1, +e.target.value || 45)) })} />
              </label>
            </div>
            <label className="toggle" title="Pack every part into one shared UV square. Off: each part gets its own square."><input type="checkbox" checked={o.one_atlas} onChange={(e) => put({ one_atlas: e.target.checked })} />One atlas</label>
            <label className="toggle" title="Hang islands off each other along shared edges wherever they fit without overlapping: a cube becomes its cross."><input type="checkbox" checked={o.join} onChange={(e) => put({ join: e.target.checked })} />Join into nets</label>
            <label className="toggle"><input type="checkbox" checked={o.unwrap && o.workspace !== 'doc'} disabled={o.workspace === 'doc'} onChange={(e) => put({ unwrap: e.target.checked })} />Auto unwrap now</label>
            <p className="exp-detail">{o.workspace === 'doc' ? 'Poly Doc opens the bare mesh; it unwraps when you go to UV Magician or Van Gogh.'
              : o.unwrap ? 'Every part is unwrapped as it opens.' : 'Opens the bare mesh; Unwrap unwraps it later.'}</p>
            <label className="toggle" title="Turn it back on under File › Ask how to open models"><input type="checkbox" checked={!again} onChange={(e) => setAgain(!e.target.checked)} />Don't ask again</label>
          </div>
        )}
        <footer className="exp-foot">
          <span className="hint" />
          {unsaved && <button onClick={() => answerAsk('discard')}>Don't save</button>}
          <button onClick={cancel}>Cancel</button>
          {unsaved ? <button className="primary" autoFocus onClick={() => answerAsk('save')}>Save</button>
            : <button className="primary" onClick={open}>Open</button>}
        </footer>
      </div>
    </div>
  );
}
