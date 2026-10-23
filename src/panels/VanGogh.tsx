// Van Gogh: paint textures straight onto the model, through the UVs UV Magician made, in the same frame as UV Magician
// (tool strip | 3D | texture | panel). Photoshop's way: a selection (Marquee, Lasso, Wand) that every paint tool
// (Brush, Eraser, Bucket) stays inside, on the model and in the texture view alike; the options bar holds the current
// tool's settings; the panel the parts (collapsible, with their channels: Substance's texture sets) and the active
// part's Layers, as Photoshop's panel lays them out.
import { useMemo, useState } from 'react';
import { CHANNELS, thumbOf, type Channel, type Gen, type GenKind } from '../paint';
import { Panel, Parts, eye } from './Dock';
import { ColorWheel } from './ColorWheel';
import { ToolStrip, type ToolDef } from '../shell/PolyTools';
import { ViewControls } from '../shell/Chrome';
import { glyph, Icon } from '../ui/Icon';
import {
  addGenerator, bakePaint, editGen, setPaintAO, addPaintLayer, beginPaintEdit, deletePaintLayer, duplicatePaintLayer, editPaintLayer, fillPaintSelection, movePaintLayerTo, pickPaintLayer,
  setPaint, texSet, undoPaint, useApp, type PaintTool,
} from '../store';

const PAINT_TOOLS: Partial<Record<PaintTool, ToolDef>>[] = [
  {
    marquee: { name: 'Marquee', key: 'M', tip: 'Drag a rectangle on the model or the texture to select (Shift adds, Alt takes away, a click deselects)', run: () => setPaint({ tool: 'marquee' }), on: () => true,
      icon: glyph('', 'M2.5 3.5h11v9h-11z') },
    lasso: { name: 'Lasso', key: 'L', tip: 'Draw round what to select, on the model or the texture (Shift adds, Alt takes away)', run: () => setPaint({ tool: 'lasso' }), on: () => true,
      icon: glyph('M8 3c3.6 0 6 1.4 6 3.2S11.6 9.5 8 9.5 2 8 2 6.2 4.4 3 8 3zM4.5 9c-1 1.2-.6 2.6.8 3 .8.3.6 1.5-.3 2') },
    wand: { name: 'Select Faces', key: 'W', tip: 'Click to select a face, an island or the whole part (options bar); Shift adds, Alt takes away', run: () => setPaint({ tool: 'wand' }), on: () => true,
      icon: glyph('M2 14l8-8M10.5 1.5v2M13 4l-1.4 1.4M14.5 6.5h-2M8.5 4.5L10 6') },
  },
  {
    brush: { name: 'Brush', key: 'B', tip: 'Paint where you drag, on the model or the texture; Alt+click picks a color', run: () => setPaint({ tool: 'brush' }), on: () => true,
      icon: glyph('M13.5 2.5l-7 7M6.5 9.5c-2 0-3 1.5-3 3s-1 1.5-2 1.5c3 1 6 0 6-3z') },
    erase: { name: 'Eraser', key: 'E', tip: 'Take paint off the active layer where you drag', run: () => setPaint({ tool: 'erase' }), on: () => true,
      icon: glyph('M9.5 2.5l4 4-7 7h-4l-1.5-1.5zM6 6l4 4M7 13.5h7') },
    bucket: { name: 'Bucket', key: 'G', tip: 'Click to fill a face, an island or the whole part (options bar), on the model or the texture; inside the selection', run: () => setPaint({ tool: 'bucket' }), on: () => true,
      icon: glyph('M3 7l5-5 5 5-5 5zM13.5 10.5c0 1.5-1 2.5-1 2.5s-1-1-1-2.5 1-2 1-2 1 .5 1 2z') },
    picker: { name: 'Eyedropper', key: 'I', tip: 'Click to take the color (and roughness, metallic) under the mouse', run: () => setPaint({ tool: 'picker' }), on: () => true,
      icon: glyph('M2 14l1-3 6.5-6.5 2 2L5 13zM9.5 4.5l1.5-1.5a1.4 1.4 0 0 1 2 2L11.5 6.5') },
  },
];
const ALL = Object.assign({}, ...PAINT_TOOLS) as Record<PaintTool, ToolDef>;

export function PaintToolStrip() {
  const tool = useApp((s) => s.paint.tool), has = useApp((s) => !!s.result);
  return <ToolStrip label="Van Gogh tools" groups={PAINT_TOOLS} pressed={(id) => id === tool} mode={() => true} on={() => has} pick={(id) => void ALL[id].run()} />;
}

/** The active part's channels (Base Color alone until it gets PBR). */
const useChannels = () => {
  useApp((s) => s.paintRev);
  const part = useApp((s) => (s.parts[s.activePart] ? s.activePart : -1));
  return part < 0 ? (['color'] as Channel[]) : texSet(part).channels;
};

/** Photoshop's options bar: the current tool and its settings. The right end is the shared ViewControls cluster:
 *  select-by (Face / Island / Part) | display | Shading. */
export function PaintOptionsBar() {
  const p = useApp((s) => s.paint), channels = useChannels(), t = ALL[p.tool];
  const slider = (label: string, key: 'size' | 'flow' | 'hardness' | 'rough' | 'metal', min: number, max: number, step: number, title: string) => (
    <label title={title}>{label}
      <input type="range" min={min} max={max} step={step} value={p[key]} onChange={(e) => setPaint({ [key]: +e.target.value })} />
      <span className="num readout">{key === 'size' ? `${p.size}%` : `${Math.round(p[key] * 100)}%`}</span>
    </label>
  );
  // with PBR, each channel has a tick: off, the brush leaves that channel alone
  const tick = (ch: Channel) => channels.length > 1 && <input type="checkbox" title={`Paint ${CHANNELS[ch].name}`} checked={p.on[ch]} onChange={(e) => setPaint({ on: { ...p.on, [ch]: e.target.checked } })} />;
  const values = <>
    <label title="Base Color">{tick('color')}Color<input type="color" className="cswatch" value={p.color} onChange={(e) => setPaint({ color: e.target.value })} /></label>
    {channels.includes('rough') && <label>{tick('rough')}{slider('Rough', 'rough', 0, 1, 0.01, 'Roughness: 0 mirror, 100% chalk')}</label>}
    {channels.includes('metal') && <label>{tick('metal')}{slider('Metal', 'metal', 0, 1, 0.01, 'Metallic: 0 for everything but bare metal')}</label>}
  </>;
  return (
    <div className="options">
      <span className="toolname">{t.icon}{t.name}</span>
      {p.tool === 'bucket' && values}
      {p.tool === 'brush' && values}
      {(p.tool === 'brush' || p.tool === 'erase') && <>
        {slider('Size', 'size', 0.2, 20, 0.2, 'Brush radius: a share of the model, or of the texture in the texture view ([ and ])')}
        {slider('Flow', 'flow', 0.05, 1, 0.05, 'How much each dab lays down; strokes build up')}
        {slider('Hardness', 'hardness', 0, 1, 0.05, 'How much of the radius paints at full strength before it fades')}
      </>}
      {p.tool === 'picker' && <span className="swatch" style={{ background: p.color }} />}
      <ViewControls />
    </div>
  );
}

/** The active part's layers as Photoshop's Layers panel: opacity on top, the stack top first with thumbnails (drag to
 *  reorder, double-click to rename), the new / duplicate / delete buttons along the bottom. */
function Layers() {
  const rev = useApp((s) => s.paintRev), part = useApp((s) => (s.parts[s.activePart] ? s.activePart : -1));
  const [drag, setDrag] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null), [name, setName] = useState('');
  const s = part < 0 ? null : texSet(part);
  const thumbs = useMemo(() => (s ? s.layers.map((l) => thumbOf(s, l)) : []), [s, rev]);
  if (!s) return null;
  const l = s.layers[s.active];
  const commit = () => { if (renaming !== null && name.trim()) editPaintLayer(renaming, { name: name.trim() }); setRenaming(null); };
  return (
    <div className="pslayers">
      <label className="lopacity" title="The active layer's opacity">Opacity
        <input type="range" min={0} max={1} step={0.01} value={l.opacity} onPointerDown={beginPaintEdit} onChange={(e) => editPaintLayer(s.active, { opacity: +e.target.value }, false)} />
        <span className="num readout">{Math.round(l.opacity * 100)}%</span>
      </label>
      {l.gen && <GenSettings g={l.gen} />}
      <ul className="layers doc thumbs" aria-label="Layers (drag to reorder, double-click to rename)">
        {s.layers.map((x, j) => (
          <li key={x.id} className={`layer${j === s.active ? ' on' : ''}${drag !== null && drag !== j ? ' droppable' : ''}`} draggable
            onDragStart={() => setDrag(j)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag !== null) movePaintLayerTo(drag, j); setDrag(null); }}
            onClick={() => pickPaintLayer(j)} onDoubleClick={() => { setRenaming(j); setName(x.name); }}>
            <button aria-pressed={x.visible} title={x.visible ? 'Hide layer' : 'Show layer'} onClick={(e) => { e.stopPropagation(); editPaintLayer(j, { visible: !x.visible }); }}>{eye(x.visible)}</button>
            <img className="lthumb" src={thumbs[j]} alt="" draggable={false} />
            {renaming === j ? (
              <input className="lname-edit" value={name} autoFocus onChange={(e) => setName(e.target.value)} onBlur={commit} onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setRenaming(null); }} />
            ) : (
              <span className="lname">{x.gen && <span className="genmark" title="Generator layer: made from the baked maps">◆ </span>}{x.name}</span>
            )}
            <span className="ltype num">{x.opacity < 1 ? `${Math.round(x.opacity * 100)}%` : ''}</span>
          </li>
        )).reverse()}
      </ul>
      <div className="lbar">
        <button title="Fill the active layer (or the selection) with the color (Alt+Backspace)" aria-label="Fill" onClick={() => fillPaintSelection()}>{glyph('M3 7l5-5 5 5-5 5zM13.5 10.5c0 1.5-1 2.5-1 2.5s-1-1-1-2.5 1-2 1-2 1 .5 1 2z')}</button>
        <button title="Duplicate the layer (Ctrl+J)" aria-label="Duplicate layer" onClick={duplicatePaintLayer}><Icon name="duplicate" size={16} /></button>
        <button title="New layer (Ctrl+Shift+N)" aria-label="New layer" onClick={addPaintLayer}><Icon name="plus" size={16} /></button>
        <button title="Delete the layer" aria-label="Delete layer" disabled={s.layers.length < 2} onClick={deletePaintLayer}><Icon name="trash" size={16} /></button>
      </div>
    </div>
  );
}

/** A generator layer's settings: dragging a slider makes the layer again live (one undo step a drag). */
function GenSettings({ g }: { g: Gen }) {
  const slider = (label: string, key: 'amount' | 'soft' | 'width' | 'grunge' | 'scale', max: number, title: string, pct = (v: number) => `${Math.round(v * 100)}%`) => (
    <label title={title}>{label}
      <input type="range" min={0} max={max} step={max / 100} value={g[key]} onPointerDown={beginPaintEdit} onChange={(e) => editGen({ [key]: +e.target.value }, false)} />
      <span className="num readout">{pct(g[key])}</span>
    </label>
  );
  const channels = useApp((s) => (s.paintRev, s.parts[s.activePart] ? texSet(s.activePart).channels : []));
  return (
    <div className="gensettings">
      <label title="What it lays down">Color<input type="color" className="cswatch" value={g.color} onChange={(e) => editGen({ color: e.target.value })} /></label>
      {channels.includes('rough') && <label title="Its roughness">Rough<input type="range" min={0} max={1} step={0.01} value={g.rough} onPointerDown={beginPaintEdit} onChange={(e) => editGen({ rough: +e.target.value }, false)} /><span className="num readout">{Math.round(g.rough * 100)}%</span></label>}
      {channels.includes('metal') && <label title="Its metallic">Metal<input type="range" min={0} max={1} step={0.01} value={g.metal} onPointerDown={beginPaintEdit} onChange={(e) => editGen({ metal: +e.target.value }, false)} /><span className="num readout">{Math.round(g.metal * 100)}%</span></label>}
      {slider('Amount', 'amount', 1, 'How much of the surface it covers')}
      {slider('Softness', 'soft', 1, 'How gradually its border fades')}
      {g.kind !== 'ao' && slider('Width', 'width', 0.04, 'How far from the edge it reaches, as a share of the model', (v) => `${(v * 100).toFixed(1)}%`)}
      {slider('Grunge', 'grunge', 1, 'How much noise breaks it up')}
      {g.grunge > 0 && slider('Scale', 'scale', 0.2, 'The noise\'s size, as a share of the model', (v) => `${(v * 100).toFixed(1)}%`)}
    </div>
  );
}

const GENS: [GenKind, string, string][] = [
  ['edge', 'Edge Wear', 'Worn bare metal along the sharp convex edges, broken up by grunge'],
  ['dirt', 'Dirt', 'Grime gathered in the crevices and concave corners'],
  ['ao', 'Occlusion', 'Darkening where the light can’t reach'],
];
/** Substance's Bake Mesh Maps, then generator layers made from them. */
function Bake() {
  const has = useApp((s) => !!s.result && !s.loading && !s.busy), ao = useApp((s) => s.paintAO);
  const baked = useApp((s) => (s.paintRev, !!s.parts[s.activePart] && !!texSet(s.activePart).bake));
  return (
    <>
      <div className="tgrid two">
        <button className="primary" disabled={!has} title="Bake ambient occlusion and curvature for every visible part (every part shades the others)" onClick={() => void bakePaint()}>{baked ? 'Bake again' : 'Bake mesh maps'}</button>
        <label className="toggle" title="Shade the model with the baked ambient occlusion (only on screen; the textures stay as painted)"><input type="checkbox" checked={ao} disabled={!baked} onChange={(e) => setPaintAO(e.target.checked)} />Show AO</label>
      </div>
      <div className="tsec"><span className="caps">Generators</span><span className="hint">{baked ? 'a new layer, inside the selection' : 'bake first'}</span></div>
      <div className="tgrid">
        {GENS.map(([k, name, title]) => <button key={k} disabled={!baked} title={title} onClick={() => addGenerator(k)}>{name}</button>)}
      </div>
    </>
  );
}

export function VanGogh() {
  return (
    <aside className="dock paintdock">
      <div className="dock-scroll">
        <Panel title="Color"><ColorWheel /></Panel>
        <Panel title="Parts"><Parts workspace="paint" /></Panel>
        <Panel title="Mesh Maps"><Bake /></Panel>
      </div>
      <Panel title="Layers" grow pinned><Layers /></Panel>
    </aside>
  );
}
