// Van Gogh: paint textures straight onto the model, through the UVs UV Magician made, in the same frame as UV Magician
// (tool strip | 3D | texture | panel). Photoshop's way: a selection (Marquee, Lasso, Wand) that every paint tool
// (Brush, Eraser, Bucket) stays inside, on the model and in the texture view alike; the options bar holds the current
// tool's settings; the panel the parts (collapsible, with their channels: Substance's texture sets) and the active
// part's Layers, as Photoshop's panel lays them out.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CHANNELS, thumbOf, type Channel, type Gen, type GenKind, type Shown } from '../paint';
import { Panel, eye } from './Dock';
import { ColorWheel } from './ColorWheel';
import { glyph, ToolStrip, type ToolDef } from '../shell/PolyTools';
import {
  addGenerator, bakePaint, editGen, setPaintAO, addPaintLayer, beginPaintEdit, deletePaintLayer, deselectPaint, duplicatePaintLayer, editPaintLayer, exportPaint, fillPaintSelection, invertPaintSelection, movePaintLayerTo, pickPaintChannel, pickPaintLayer,
  pickPaintPart, setPaint, setPbr, texSet, togglePaintOpen, undoPaint, useApp, type FillBy, type PaintTool,
} from '../store';

const PAINT_TOOLS: Partial<Record<PaintTool | 'undo', ToolDef>>[] = [
  {
    marquee: { name: 'Marquee', key: 'M', tip: 'Drag a rectangle on the model or the texture to select (Shift adds, Alt takes away, a click deselects)', run: () => setPaint({ tool: 'marquee' }), on: () => true,
      icon: glyph('', 'M2.5 3.5h11v9h-11z') },
    lasso: { name: 'Lasso', key: 'L', tip: 'Draw round what to select, on the model or the texture (Shift adds, Alt takes away)', run: () => setPaint({ tool: 'lasso' }), on: () => true,
      icon: glyph('M8 3c3.6 0 6 1.4 6 3.2S11.6 9.5 8 9.5 2 8 2 6.2 4.4 3 8 3zM4.5 9c-1 1.2-.6 2.6.8 3 .8.3.6 1.5-.3 2') },
    wand: { name: 'Select Faces', key: 'W', tip: 'Click to select a face, an island or the whole part (options bar); Shift adds, Alt takes away', run: () => setPaint({ tool: 'wand' }), on: () => true,
      icon: glyph('M2 14l8-8M10.5 1.5v2M13 4l-1.4 1.4M14.5 6.5h-2M8.5 4.5L10 6') },
  },
  {
    brush: { name: 'Brush', key: 'B', tip: 'Paint where you drag, on the model or the texture; Alt+click picks a colour', run: () => setPaint({ tool: 'brush' }), on: () => true,
      icon: glyph('M13.5 2.5l-7 7M6.5 9.5c-2 0-3 1.5-3 3s-1 1.5-2 1.5c3 1 6 0 6-3z') },
    erase: { name: 'Eraser', key: 'E', tip: 'Take paint off the active layer where you drag', run: () => setPaint({ tool: 'erase' }), on: () => true,
      icon: glyph('M9.5 2.5l4 4-7 7h-4l-1.5-1.5zM6 6l4 4M7 13.5h7') },
    bucket: { name: 'Bucket', key: 'G', tip: 'Click to fill a face, an island or the whole part (options bar), on the model or the texture; inside the selection', run: () => setPaint({ tool: 'bucket' }), on: () => true,
      icon: glyph('M3 7l5-5 5 5-5 5zM13.5 10.5c0 1.5-1 2.5-1 2.5s-1-1-1-2.5 1-2 1-2 1 .5 1 2z') },
    picker: { name: 'Eyedropper', key: 'I', tip: 'Click to take the colour (and roughness, metallic) under the mouse', run: () => setPaint({ tool: 'picker' }), on: () => true,
      icon: glyph('M2 14l1-3 6.5-6.5 2 2L5 13zM9.5 4.5l1.5-1.5a1.4 1.4 0 0 1 2 2L11.5 6.5') },
  },
  {
    undo: { name: 'Undo', key: 'Ctrl+Z', tip: 'Take back the last stroke, fill, selection or layer change', run: undoPaint, on: () => true,
      icon: glyph('M5 3L2 6l3 3M2 6h7a4 4 0 0 1 0 8H6') },
  },
];
const ALL = Object.assign({}, ...PAINT_TOOLS) as Record<PaintTool | 'undo', ToolDef>;

export function PaintToolStrip() {
  const tool = useApp((s) => s.paint.tool), has = useApp((s) => !!s.result);
  return <ToolStrip label="Van Gogh tools" groups={PAINT_TOOLS} pressed={(id) => id === tool} on={() => has} pick={(id) => void ALL[id].run()} />;
}

/** The active part's channels (Base Color alone until it gets PBR). */
const useChannels = () => {
  useApp((s) => s.paintRev);
  const part = useApp((s) => (s.parts[s.activePart] ? s.activePart : -1));
  return part < 0 ? (['color'] as Channel[]) : texSet(part).channels;
};
const BY: [FillBy, string, string][] = [['face', 'Face', 'One face (its whole polygon)'], ['island', 'Island', 'The UV island'], ['part', 'Part', 'The whole part']];

/** Photoshop's options bar: the current tool and its settings. */
export function PaintOptionsBar() {
  const p = useApp((s) => s.paint), channels = useChannels(), t = ALL[p.tool];
  const slider = (label: string, key: 'size' | 'flow' | 'hardness' | 'rough' | 'metal', min: number, max: number, step: number, title: string) => (
    <label title={title}>{label}
      <input type="range" min={min} max={max} step={step} value={p[key]} onChange={(e) => setPaint({ [key]: +e.target.value })} />
      <span className="num">{key === 'size' ? `${p.size}%` : `${Math.round(p[key] * 100)}%`}</span>
    </label>
  );
  // with PBR, each channel has a tick: off, the brush leaves that channel alone
  const tick = (ch: Channel) => channels.length > 1 && <input type="checkbox" title={`Paint ${CHANNELS[ch].name}`} checked={p.on[ch]} onChange={(e) => setPaint({ on: { ...p.on, [ch]: e.target.checked } })} />;
  const by = (
    <span className="seg" role="group" aria-label="Takes">
      {BY.map(([v, label, title]) => <button key={v} aria-pressed={p.by === v} title={title} onClick={() => setPaint({ by: v })}>{label}</button>)}
    </span>
  );
  const values = <>
    <label title="Base Color">{tick('color')}Colour<input type="color" value={p.color} onChange={(e) => setPaint({ color: e.target.value })} /></label>
    {channels.includes('rough') && <label>{tick('rough')}{slider('Rough', 'rough', 0, 1, 0.01, 'Roughness: 0 mirror, 100% chalk')}</label>}
    {channels.includes('metal') && <label>{tick('metal')}{slider('Metal', 'metal', 0, 1, 0.01, 'Metallic: 0 for everything but bare metal')}</label>}
  </>;
  const selecting = p.tool === 'marquee' || p.tool === 'lasso' || p.tool === 'wand';
  return (
    <div className="options">
      <span className="toolname">{t.icon}{t.name}</span>
      {p.tool === 'wand' && by}
      {selecting && <>
        <button title="Select nothing (Ctrl+D)" onClick={deselectPaint}>Deselect</button>
        <button title="Select the rest instead (Ctrl+Shift+I)" onClick={invertPaintSelection}>Invert</button>
        <button title="Fill the selection on the active layer with the colour (Alt+Backspace)" onClick={() => fillPaintSelection()}>Fill</button>
        <button title="Clear the selection on the active layer (Delete)" onClick={() => fillPaintSelection(true)}>Clear</button>
        <span className="hint">Shift adds · Alt takes away</span>
      </>}
      {p.tool === 'bucket' && <>{by}{values}</>}
      {p.tool === 'brush' && values}
      {(p.tool === 'brush' || p.tool === 'erase') && <>
        {slider('Size', 'size', 0.2, 20, 0.2, 'Brush radius: a share of the model, or of the texture in the texture view ([ and ])')}
        {slider('Flow', 'flow', 0.05, 1, 0.05, 'How much each dab lays down; strokes build up')}
        {slider('Hardness', 'hardness', 0, 1, 0.05, 'How much of the radius paints at full strength before it fades')}
      </>}
      {p.tool === 'picker' && <><span className="swatch" style={{ background: p.color }} /><span className="hint">Click the model or the texture to take its colour</span></>}
    </div>
  );
}

/** The baked maps, listed under the channels once the part is baked. */
const BAKED: Shown[] = ['ao', 'curv'];
const NAMES: Record<Shown, string> = { ...Object.fromEntries(Object.entries(CHANNELS).map(([k, v]) => [k, v.name])) as Record<Channel, string>, ao: 'Ambient Occlusion (baked)', curv: 'Curvature (baked)', material: 'Material (lit)' };

const chevron = (open: boolean) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : undefined }}><path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
);

/** Each part, collapsible, with its texture set's channels under it: click a channel to see it in the texture view. */
function PartTree() {
  const parts = useApp((s) => s.parts), active = useApp((s) => s.activePart), shown = useApp((s) => s.paintChannel), open = useApp((s) => s.paintOpen);
  useApp((s) => s.paintRev);
  const list = useRef<HTMLUListElement>(null);
  // Ctrl+click on the model picks a part: bring its row into view
  useEffect(() => { list.current?.querySelector('.layer.active')?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  return (
    <ul className="layers doc tree" ref={list} aria-label="Parts and their textures (Ctrl+click the model to pick one)">
      {parts.flatMap((p, i) => {
        const chs = texSet(i).channels, on = open.includes(i);
        return [
          <li key={i} className={`layer${i === active ? ' active' : ''}`} onClick={() => pickPaintPart(i)} title={p.name}>
            <button aria-expanded={on} aria-label={`${on ? 'Collapse' : 'Expand'} ${p.name}`} onClick={(e) => { e.stopPropagation(); togglePaintOpen(i); }}>{chevron(on)}</button>
            <span className="lname">{p.name}</span>
            <button className="ltype" title={chs.length > 1 ? 'Back to Base Color only' : 'Add Roughness and Metallic (PBR metal/rough, what glTF, Unity and Unreal read)'}
              onClick={(e) => { e.stopPropagation(); setPbr(i, chs.length === 1); }}>{chs.length > 1 ? 'PBR ✓' : '+ PBR'}</button>
          </li>,
          ...(on ? ['material' as Shown, ...chs, ...(texSet(i).bake ? BAKED : [])] : []).map((ch: Shown) => (
            <li key={`${i}${ch}`} className={`layer sub${i === active && ch === shown ? ' on' : ''}${ch === 'ao' || ch === 'curv' ? ' baked' : ''}`} onClick={() => pickPaintChannel(i, ch)} title={`Show ${NAMES[ch]} in the texture view`}>
              <span />
              <span className="lname">{NAMES[ch]}</span>
              <span />
            </li>
          )),
        ];
      })}
    </ul>
  );
}

const icon = (d: string) => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

/** The active part's layers as Photoshop's Layers panel: opacity on top, the stack top first with thumbnails (drag to
 *  reorder, double-click to rename), the new / duplicate / delete buttons along the bottom. */
function Layers() {
  const rev = useApp((s) => s.paintRev), part = useApp((s) => (s.parts[s.activePart] ? s.activePart : -1));
  const [drag, setDrag] = useState<number | null>(null);
  const s = part < 0 ? null : texSet(part);
  const thumbs = useMemo(() => (s ? s.layers.map((l) => thumbOf(s, l)) : []), [s, rev]);
  if (!s) return null;
  const l = s.layers[s.active];
  return (
    <div className="pslayers">
      <label className="lopacity" title="The active layer's opacity">Opacity
        <input type="range" min={0} max={1} step={0.01} value={l.opacity} onPointerDown={beginPaintEdit} onChange={(e) => editPaintLayer(s.active, { opacity: +e.target.value }, false)} />
        <span className="num">{Math.round(l.opacity * 100)}%</span>
      </label>
      {l.gen && <GenSettings g={l.gen} />}
      <ul className="layers doc thumbs" aria-label="Layers (drag to reorder, double-click to rename)">
        {s.layers.map((x, j) => (
          <li key={x.id} className={`layer${j === s.active ? ' on' : ''}${drag !== null && drag !== j ? ' droppable' : ''}`} draggable
            onDragStart={() => setDrag(j)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag !== null) movePaintLayerTo(drag, j); setDrag(null); }}
            onClick={() => pickPaintLayer(j)} onDoubleClick={() => { const name = prompt('Layer name', x.name); if (name) editPaintLayer(j, { name }); }}>
            <button aria-pressed={x.visible} title={x.visible ? 'Hide layer' : 'Show layer'} onClick={(e) => { e.stopPropagation(); editPaintLayer(j, { visible: !x.visible }); }}>{eye(x.visible)}</button>
            <img className="lthumb" src={thumbs[j]} alt="" draggable={false} />
            <span className="lname">{x.gen && <span className="genmark" title="Generator layer: made from the baked maps">◆ </span>}{x.name}</span>
            <span className="ltype num">{x.opacity < 1 ? `${Math.round(x.opacity * 100)}%` : ''}</span>
          </li>
        )).reverse()}
      </ul>
      <div className="lbar">
        <button title="Fill the active layer (or the selection) with the colour (Alt+Backspace)" aria-label="Fill" onClick={() => fillPaintSelection()}>{icon('M3 7l5-5 5 5-5 5zM13.5 10.5c0 1.5-1 2.5-1 2.5s-1-1-1-2.5 1-2 1-2 1 .5 1 2z')}</button>
        <button title="Duplicate the layer (Ctrl+J)" aria-label="Duplicate layer" onClick={duplicatePaintLayer}>{icon('M5 5h8v8H5zM3 11V3h8')}</button>
        <button title="New layer (Ctrl+Shift+N)" aria-label="New layer" onClick={addPaintLayer}>{icon('M2.5 2.5h11v11h-11zM8 5v6M5 8h6')}</button>
        <button title="Delete the layer" aria-label="Delete layer" disabled={s.layers.length < 2} onClick={deletePaintLayer}>{icon('M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9')}</button>
      </div>
    </div>
  );
}

/** A generator layer's settings: dragging a slider makes the layer again live (one undo step a drag). */
function GenSettings({ g }: { g: Gen }) {
  const slider = (label: string, key: 'amount' | 'soft' | 'width' | 'grunge' | 'scale', max: number, title: string, pct = (v: number) => `${Math.round(v * 100)}%`) => (
    <label title={title}>{label}
      <input type="range" min={0} max={max} step={max / 100} value={g[key]} onPointerDown={beginPaintEdit} onChange={(e) => editGen({ [key]: +e.target.value }, false)} />
      <span className="num">{pct(g[key])}</span>
    </label>
  );
  const channels = useApp((s) => (s.paintRev, s.parts[s.activePart] ? texSet(s.activePart).channels : []));
  return (
    <div className="gensettings">
      <label title="What it lays down">Colour<input type="color" value={g.color} onChange={(e) => editGen({ color: e.target.value })} /></label>
      {channels.includes('rough') && <label title="Its roughness">Rough<input type="range" min={0} max={1} step={0.01} value={g.rough} onPointerDown={beginPaintEdit} onChange={(e) => editGen({ rough: +e.target.value }, false)} /><span className="num">{Math.round(g.rough * 100)}%</span></label>}
      {channels.includes('metal') && <label title="Its metallic">Metal<input type="range" min={0} max={1} step={0.01} value={g.metal} onPointerDown={beginPaintEdit} onChange={(e) => editGen({ metal: +e.target.value }, false)} /><span className="num">{Math.round(g.metal * 100)}%</span></label>}
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
  const ready = useApp((s) => !!s.result && !s.loading && !s.busy);
  return (
    <aside className="dock paintdock">
      <Panel title="Colour"><ColorWheel /></Panel>
      <Panel title="Parts"><PartTree /></Panel>
      <Panel title="Bake"><Bake /></Panel>
      <Panel title="Layers" grow><Layers /></Panel>
      <Panel title="Export">
        <button className="wide" disabled={!ready} title="One PNG per channel of the active part: Base Color (sRGB), Roughness and Metallic (greyscale)" onClick={exportPaint}>Export textures</button>
      </Panel>
    </aside>
  );
}
