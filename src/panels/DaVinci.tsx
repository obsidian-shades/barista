// Da Vinci: the showcase render. A turntable in a dark room lit by softboxes and rim strips; the model opens to Geppetto's pose and closes
// again once a turn; Record writes that turn as a WebM, Still a photograph through the same bloom / grade chain (4K by
// default). Look and light are real settings: Export › Blender ready › Showcase scene writes them into a packed .blend.
import type { ReactNode } from 'react';
import { posed as isPosed } from '../rig';
import { recordShow, setShow, showWorkspace, toggleShowPlay, useApp } from '../store';
import { ColorPick } from '../ui/ColorPick';
import { cycleOf } from '../views/RenderView';
import { Panel } from './Dock';

export function ShowOptionsBar() {
  const play = useApp((s) => s.showPlay), rec = useApp((s) => s.showRec), has = useApp((s) => !!s.result);
  const cycle = useApp((s) => cycleOf(s.show)), still = useApp((s) => s.show.still);
  const size = still ? `${Math.round(still / 1000)}K` : 'view';
  return (
    <div className="options">
      <span className="toolname">Turntable</span>
      <button onClick={toggleShowPlay} disabled={!!rec} title="Play or pause the turntable and the open / close">{play ? 'Pause' : 'Play'}</button>
      <button onClick={() => recordShow('video')} disabled={!has || !!rec} title={`Record one whole cycle (${cycle.toFixed(1)} s) from its start as a WebM`}>{rec === 'video' ? 'Recording…' : 'Record turn'}</button>
      <button onClick={() => recordShow('still')} disabled={!has || !!rec} title={`Save this frame as a ${size} PNG through the cinematic composer`}>{rec === 'still' ? 'Rendering…' : `Still ${size}`}</button>
      <span className="hint">Look, light and the still size are in the panel; Blender gets the same cycle and grade in File › Export</span>
    </div>
  );
}

const row = (label: ReactNode, body: ReactNode, title?: string) => <label title={title}><span>{label}</span><span>{body}</span></label>;

export function DaVinci() {
  const show = useApp((s) => s.show), posed = useApp((s) => isPosed(s.pose)), rigged = useApp((s) => s.rig.bones.length > 0);
  const slide = (k: 'spin' | 'tween' | 'rimPower' | 'key' | 'bloom' | 'dof' | 'grain' | 'exposure', min: number, max: number, step: number, unit = '') => <>
    <input type="range" min={min} max={max} step={step} value={show[k]} onChange={(e) => setShow({ [k]: +e.target.value })} />
    <output>{+show[k].toPrecision(2)}{unit}</output>
  </>;
  return (
    <aside className="dock">
      <Panel title="Showcase" grow>
        <div className="settings">
          <div className="tsec"><span className="caps">Motion</span></div>
          {row('Spin', slide('spin', 0, 120, 1, '°/s'), 'Degrees a second; 0 holds still (a 6 s cycle)')}
          <label className="toggle"><input type="checkbox" checked={show.open} onChange={(e) => setShow({ open: e.target.checked })} /><span>Open &amp; close</span></label>
          {row('Tween', slide('tween', 0.2, 3, 0.1, ' s'), 'How long opening and closing each take')}
          {show.open && !rigged && <p className="hint">Nothing moves yet: in Geppetto (<button onClick={() => showWorkspace('rig')}>open</button>) press Shift+A to auto-rig, and each moving part gets a bone and a range.</p>}
          {show.open && rigged && !posed && <p className="hint">Opens every moving part to the end of its range. To choose another open, pose it in Geppetto (<button onClick={() => showWorkspace('rig')}>open</button>).</p>}
          <div className="tsec"><span className="caps">Cinematic</span><span className="hint">live + Blender</span></div>
          <label className="toggle" title="Bloom, depth of field, AgX tone mapping and the film grade"><input type="checkbox" checked={show.cine} onChange={(e) => setShow({ cine: e.target.checked })} /><span>Bloom &amp; film grade</span></label>
          <label className="toggle" title="Haze and dust motes in the exported Blender scene (not in this view)"><input type="checkbox" checked={show.dust} onChange={(e) => setShow({ dust: e.target.checked })} /><span>Haze &amp; dust (Blender)</span></label>
          <label className="toggle" title="A slow camera roll in the exported Blender scene (not in this view)"><input type="checkbox" checked={show.handheld} onChange={(e) => setShow({ handheld: e.target.checked })} /><span>Handheld camera (Blender)</span></label>
          <label className="toggle" title="A 2.39:1 letterbox in the view; the Blender render uses the same aspect instead of bars"><input type="checkbox" checked={show.letterbox} onChange={(e) => setShow({ letterbox: e.target.checked })} /><span>2.39 frame</span></label>
          {show.cine && row('Bloom', slide('bloom', 0, 1, 0.05), 'How much the highlights and rim strips halate')}
          {show.cine && row('Focus', slide('dof', 0, 1, 0.05), 'Depth of field; 0 is a completely sharp lens')}
          {show.cine && row('Grain', slide('grain', 0, 1, 0.05), 'Film grain; stronger in the shadows')}
          {row('Exposure', slide('exposure', -2, 2, 0.05, ' EV'), 'Exposure in stops, live and in Blender')}
          <div className="tsec"><span className="caps">Light</span></div>
          {row('Key', slide('key', 0, 3, 0.05), 'The overhead softbox, the key card and the key lamp')}
          {row('Rim', slide('rimPower', 0, 3, 0.05), 'The two strips behind the model that outline it')}
          {row('Rim colour', <ColorPick value={show.rim} onChange={(rim) => setShow({ rim })} swatches={['#ffffff', '#dfe6ff', '#ffe2c4', '#a45bff', '#3de0ff']} title="Rim colour" />)}
          {row('Backdrop', <ColorPick value={show.bg} onChange={(bg) => setShow({ bg })} swatches={['#050506', '#000000', '#14161b', '#2a2d33', '#e9e9ec']} title="Backdrop" />)}
          <div className="tsec"><span className="caps">Still</span></div>
          <label title="How large the Still button writes; View is the canvas as it is, 4K is a 3840 px long edge"><span>Size</span>
            <select value={show.still} onChange={(e) => setShow({ still: +e.target.value })} aria-label="Still size">
              <option value={0}>View</option>
              <option value={2048}>2K</option>
              <option value={3840}>4K</option>
            </select>
          </label>
          <p className="hint">Export a Blender-ready model with “Showcase scene” to get a packed .blend: the same turntable, pose, lights, dust and grade, with Cycles, motion blur and a 4K MP4 output.</p>
        </div>
      </Panel>
    </aside>
  );
}
