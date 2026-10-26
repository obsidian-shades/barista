// Van Gogh: paint textures straight onto the model, through the UVs UV Magician made, in the same frame as UV Magician
// (tool strip | 3D | texture | panel). Photoshop's way: a selection (Marquee, Lasso, Wand) that every paint tool
// (Brush, Eraser, Bucket) stays inside, on the model and in the texture view alike; the options bar holds the current
// tool's settings; the panel the parts (collapsible, with their channels: Substance's texture sets) and the active
// part's Layers, as Photoshop's panel lays them out.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CHANNELS, SOLID, blendOf, thumbOf, type BlendMode, type BrushTip, type Channel, type Decal, type Fill, type Pattern, type Gen, type GenKind } from '../paint';
import { MATERIAL_GROUPS, TILE_KINDS, materialGroup, thumbUrl, tileKind } from '../materials';
import { decalUrl } from '../decals';
import { decalDragOver, decalDrop, shelfDragOver, shelfDrop } from '../views/Viewport3D';
import { targetInfo } from '../exporting';
import { Parts, eye } from './Dock';
import { ColorWheel } from './ColorWheel';
import { ToolStrip, type ToolDef } from '../shell/PolyTools';
import { ViewControls } from '../shell/Chrome';
import { glyph, Icon } from '../ui/Icon';
import {
  activeDecal, shelfDrag, addGenerator, addSolidFill, setLinkSets, addMetalLayer, addPaintLayer, assignMaterial, bakeAllPaint, bakePaint, beginPaintEdit, clearFillMask, deletePaintLayer, duplicatePaintLayer, editGen, editPaintLayer, fillPaintSelection, importDecal, importMaterialFiles,
  invertFillMask, loadDecals, loadMaterials, modelDiagonal, movePaintLayerTo, openExport, pickDecal, pickPaintLayer, pickPaintPart, setDecalSize, setDecalRotation, setFillBlend, setFillMask, setLayerBlend, setPaint, setPaintAO, setPaintTab, setPbr, texSet, undoPaint, updateDecal, updateFill, useApp, type PaintTool,
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
    decal: { name: 'Decal', key: 'D', tip: 'Place the mark armed in the Decals tab; click the model to place it, drag a mark to move it', run: () => setPaint({ tool: 'decal' }), on: () => true,
      icon: glyph('M8 2.5l5.5 5.5L8 13.5 2.5 8zM8 5.2l2.8 2.8L8 10.8 5.2 8z') },
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

/** Substance's shelf: built-in CC0 sets plus folders imported this session. Click adds a fill layer.
 *  Tiles (800+ of the pack) have their own tab, browsed by kind; the Materials tab leaves them out. */
const PAGE = 36;

function Materials({ tiles = false }: { tiles?: boolean }) {
  const all = useApp((s) => s.materials), loading = useApp((s) => s.materialsLoading), error = useApp((s) => s.materialsError);
  const part = useApp((s) => s.parts[s.activePart]?.name ?? '—');
  const fillBlend = useApp((s) => s.paint.fillBlend);
  const [q, setQ] = useState(''), [group, setGroup] = useState('all'), [limit, setLimit] = useState(PAGE), [allParts, setAllParts] = useState(false), input = useRef<HTMLInputElement>(null);
  useEffect(() => { loadMaterials(); }, []);
  const list = useMemo(() => all.filter((m) => (materialGroup(m) === 'tile') === tiles), [all, tiles]);
  const keyOf = tiles ? tileKind : materialGroup;
  useEffect(() => { setLimit(PAGE); }, [q, group, list.length]);
  const groups = useMemo(() => (tiles ? [...TILE_KINDS.map(([k]) => [k, k] as const), ['Other', 'Other'] as const] : MATERIAL_GROUPS).flatMap(([id, name]) => {
    const n = list.filter((m) => keyOf(m) === id).length;
    return n ? [[id, name, n] as const] : [];
  }), [list, tiles]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter((m) => (group === 'all' || keyOf(m) === group)
      && (!needle || `${m.name} ${m.category} ${m.catalog ?? ''} ${m.tags.join(' ')} ${m.role ?? ''}`.toLowerCase().includes(needle)));
  }, [list, q, group, tiles]);
  const visible = shown.slice(0, limit);
  // Infinite scroll: the next page loads as the end of the grid comes near (re-observed per page, so a
  // short page that leaves the sentinel in view keeps loading).
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = more.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting) setLimit((n) => n + PAGE * 2); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, shown.length]);
  const add = (files: FileList | null) => {
    if (!files?.length) return;
    const name = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0] || 'Imported material';
    void importMaterialFiles(name, Array.from(files));
  };
  return (
    <div className="matshelf">
      <div className="matsticky">
      <div className="matbar">
        <input className="matsearch" type="search" placeholder={tiles ? 'Search tiles' : 'Search materials'} value={q} onChange={(e) => setQ(e.target.value)} />
        <button title="Import a folder of PBR maps (Substance's exported textures, ambientCG, any baker)" onClick={() => input.current?.click()}>Import</button>
      </div>
      <div className="mathint">
        <span className="hint">Fill goes to <b>{part}</b> · {shown.length} of {list.length}</span>
        <label className="allparts" title="Apply to every visible part's texture set"><input type="checkbox" checked={allParts} onChange={(e) => setAllParts(e.target.checked)} />All parts</label>
      </div>
      <div className="mathint">
        <label className="fillblend" title={fillBlend === 'normal'
          ? 'A material added over paint already there covers it, as a new base layer would. Pick Multiply or Overlay to tint what is below instead: the choice sticks for the next materials too (and is the Base Color blend in the Layers panel).'
          : `New materials over paint already there blend their Base Color with ${fillBlend}: the layers below stay visible through the texture. The choice sticks until you change it.`}>
          Blend over paint
          <select value={fillBlend} onChange={(e) => setFillBlend(e.target.value as BlendMode)}>
            <option value="normal">Normal (covers)</option>
            <option value="multiply">Multiply</option>
            <option value="screen">Screen</option>
            <option value="overlay">Overlay</option>
            <option value="add">Add</option>
          </select>
        </label>
      </div>
      <div className="matgroups">
        <span className="caps">{tiles ? 'Tile' : 'Material'}</span>
        <button className={group === 'all' ? 'on' : ''} onClick={() => setGroup('all')}>All</button>
        {groups.map(([id, name, n]) => (
          <button key={id} className={group === id ? 'on' : ''} onClick={() => setGroup(id)}>
            {name} <span className="matcount">{n}</span>
          </button>
        ))}
      </div>
      </div>
      {error && <div className="hint fix">{error}</div>}
      {loading && !list.length && <div className="hint">Loading the shelf…</div>}
      <div className="matgrid">
        {visible.map((m) => (
          <button key={m.id} className="mattile" title={`${m.name} — ${m.category}${m.catalog ? ` · ${m.catalog}` : ''}${m.notes ? `\n${m.notes}` : ''}\n${m.width}×${m.height} · ${m.license} · ${m.source}`} onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => holdTile(e, m.id, thumbUrl(m))} onClick={() => { if (!tileDragged) assignMaterial(m.id, allParts); }}>
            <img src={thumbUrl(m)} alt="" loading="lazy" draggable={false} />
            <span>{m.name}</span>
          </button>
        ))}
      </div>
      {shown.length > limit && <div ref={more} className="moremats hint">Loading more · {shown.length - limit} left</div>}
      {!loading && !shown.length && <div className="hint">No material matches.</div>}
      <input ref={input} type="file" multiple style={{ display: 'none' }} onChange={(e) => { add(e.target.files); e.target.value = ''; }} {...({ webkitdirectory: '' } as Record<string, string>)} />
    </div>
  );
}

let tileDragged = false;
/** Hold a shelf tile and move: its picture follows the pointer, the model shows where it would go (a material: what it
 *  would cover; a decal: its frame), letting go there applies it (Esc cancels). A press that doesn't move stays a click. */
function holdTile(e: ReactPointerEvent, id: string, src: string, over = shelfDragOver, drop = shelfDrop, round = true) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLImageElement | null = null;
  tileDragged = false;
  const end = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('keydown', esc);
    ghost?.remove(); shelfDrag.id = ''; document.body.style.cursor = '';
  };
  const move = (m: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
      ghost = Object.assign(document.createElement('img'), { src, className: round ? 'matghost' : 'matghost decalghost', alt: '' });
      document.body.append(ghost);
      shelfDrag.id = id; tileDragged = true;
    }
    ghost.style.transform = `translate(${m.clientX}px, ${m.clientY}px)`;
    const on = over(m.clientX, m.clientY);
    ghost.classList.toggle('over', on);
    document.body.style.cursor = on ? 'copy' : 'grabbing';
  };
  const up = (u: PointerEvent) => { const dropped = !!ghost; end(); if (dropped) drop(id, u.clientX, u.clientY); };
  const esc = (k: KeyboardEvent) => { if (k.key === 'Escape') { end(); over(-1, -1); } };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('keydown', esc);
}

/** The decal shelf: choose a mark, then click the model. Marks are layers, so paint, masks and export behave alike. */
function Decals() {
  const list = useApp((s) => s.decals), loading = useApp((s) => s.decalsLoading), error = useApp((s) => s.decalsError);
  const armed = useApp((s) => s.paint.decalAsset), size = useApp((s) => s.paint.decalSize), rotation = useApp((s) => s.paint.decalRotation), tint = useApp((s) => s.paint.decalTint);
  const [q, setQ] = useState(''), [cat, setCat] = useState('All'), input = useRef<HTMLInputElement>(null);
  useEffect(() => { loadDecals(); }, []);
  const cats = useMemo(() => ['All', ...Array.from(new Set(list.map((d) => d.category)))], [list]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter((d) => (cat === 'All' || d.category === cat) && (!needle || `${d.name} ${d.category} ${d.tags.join(' ')}`.toLowerCase().includes(needle)));
  }, [list, q, cat]);
  return (
    <div className="matshelf decalshelf">
      <div className="matbar">
        <input className="matsearch" type="search" placeholder="Search decals" value={q} onChange={(e) => setQ(e.target.value)} />
        <button title="Import a transparent PNG mark from disk" onClick={() => input.current?.click()}>Import</button>
      </div>
      <div className="decalplace">
        <span className="decalbadge">D</span>
        <span className="hint">Pick a mark, then click the model. Drag it to move; size and rotation are under Layers.</span>
      </div>
      <div className="decalsettings">
        <label title="Width of the next mark, as a share of the model's diagonal">Size
          <input type="range" min={2} max={40} step={1} value={size} onChange={(e) => setDecalSize(+e.target.value)} />
          <span className="num readout">{size}%</span>
        </label>
        <label title="Rotation of the next mark">Rotate
          <input type="range" min={-180} max={180} step={5} value={rotation} onChange={(e) => setDecalRotation(+e.target.value)} />
          <span className="num readout">{rotation}°</span>
        </label>
        <label title="Ink for the next mark; white leaves the image as drawn">Ink
          <input type="color" className="cswatch" value={tint} onChange={(e) => setPaint({ decalTint: e.target.value })} />
        </label>
      </div>
      <div className="matchips">
        {cats.map((c) => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
      </div>
      {error && <div className="hint fix">{error}</div>}
      {loading && !list.length && <div className="hint">Loading decals…</div>}
      <div className="decalgrid">
        {shown.map((d) => (
          <button key={d.id} className={`decaltile${d.id === armed ? ' on' : ''}`} title={`${d.name} — ${d.category}${d.notes ? `\n${d.notes}` : ''}\n${d.width}×${d.height} · ${d.license}`} onPointerDown={(e) => holdTile(e, d.id, decalUrl(d), decalDragOver, decalDrop, false)} onClick={() => { if (!tileDragged) pickDecal(d.id); }}>
            <span className="decalimg"><img src={decalUrl(d)} alt="" draggable={false} /></span>
            <span>{d.name}</span>
          </button>
        ))}
      </div>
      {!loading && !shown.length && <div className="hint">No decal matches.</div>}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importDecal(f); e.target.value = ''; }} />
    </div>
  );
}

/** The active fill layer's material, projection, scale and mask. */
function FillSettings({ f }: { f: Fill }) {
  const slider = (label: string, key: 'tiling' | 'tiles' | 'rotation' | 'normalStrength', min: number, max: number, step: number, title: string, fmt: (v: number) => string) => (
    <label title={title}>{label}
      <input type="range" min={min} max={max} step={step} value={f[key]} onPointerDown={beginPaintEdit} onChange={(e) => updateFill({ [key]: +e.target.value }, false)} />
      <span className="num readout">{fmt(f[key])}</span>
    </label>
  );
  const channel = (ch: Channel) => (
    <label key={ch}><input type="checkbox" checked={f.channels.includes(ch)} onChange={(e) => updateFill({ channels: e.target.checked ? [...f.channels, ch] : f.channels.filter((x) => x !== ch) })} />{CHANNELS[ch].name}</label>
  );
  const mask = (
    <>
      <div className="fillmask">
        <button title="Make the fill visible everywhere" onClick={() => setFillMask(255)}>White</button>
        <button title="Hide the fill everywhere" onClick={() => setFillMask(0)}>Black</button>
        <button title="Swap what the mask hides and shows" onClick={invertFillMask}>Invert</button>
        <button title="Remove the mask (visible everywhere)" onClick={clearFillMask}>Clear</button>
      </div>
      <div className="hint">Brush paints the mask white, Eraser black. Start with Black to paint the material in.</div>
    </>
  );
  if (f.asset === SOLID) return (
    <div className="gensettings fillsettings">
      <label title="The fill's colour; change it any time, the layer stays a setting">Color
        <input type="color" className="cswatch" value={f.tint} onPointerDown={beginPaintEdit} onChange={(e) => updateFill({ tint: e.target.value }, false)} />
      </label>
      {(['roughness', 'metallic'] as const).map((key) => (
        <label key={key} title={key === 'roughness' ? 'Roughness: 0 mirror, 100% chalk' : 'Metallic: 100% for bare or anodized metal'}>{key === 'roughness' ? 'Rough' : 'Metal'}
          <input type="range" min={0} max={1} step={0.01} value={f[key] ?? 0} onPointerDown={beginPaintEdit} onChange={(e) => updateFill({ [key]: +e.target.value }, false)} />
          <span className="num readout">{Math.round((f[key] ?? 0) * 100)}%</span>
        </label>
      ))}
      {mask}
    </div>
  );
  return (
    <div className="gensettings fillsettings">
      <label title="UV repeats inside each island; Tri-planar projects in world space and has no seams on a packed atlas">Projection
        <span className="seg">
          <button className={f.projection === 'uv' ? 'on' : ''} onClick={() => updateFill({ projection: 'uv' })}>UV</button>
          <button className={f.projection === 'triplanar' ? 'on' : ''} onClick={() => updateFill({ projection: 'triplanar' })}>Tri-planar</button>
        </span>
      </label>
      {f.projection === 'uv'
        ? slider('Tiling', 'tiling', 0.25, 8, 0.25, 'Repeats inside each UV island: higher = more repeats, a smaller pattern', (v) => `${v}×`)
        : slider('Tiles', 'tiles', 0.5, 16, 0.5, 'Repeats across the whole model: higher = more repeats, a smaller pattern', (v) => `${v}×`)}
      {slider('Rotate', 'rotation', -180, 180, 5, 'Rotate the projection', (v) => `${Math.round(v)}°`)}
      {slider('Strength', 'normalStrength', 0, 2, 0.05, 'Normal map strength', (v) => `${Math.round(v * 100)}%`)}
      <label title="Tint the material's base color">Tint
        <input type="color" className="cswatch" value={f.tint} onPointerDown={beginPaintEdit} onChange={(e) => updateFill({ tint: e.target.value }, false)} />
      </label>
      {(['roughness', 'metallic'] as const).map((key) => (
        <label key={key} className="foverride" title={`Override the map's ${key} with one value for this finish`}>
          <input type="checkbox" checked={f[key] != null} onChange={(e) => updateFill({ [key]: e.target.checked ? (f[key] ?? 0.5) : undefined })} />
          {key === 'roughness' ? 'Rough' : 'Metal'}
          <input type="range" min={0} max={1} step={0.01} disabled={f[key] == null} value={f[key] ?? 0.5} onPointerDown={beginPaintEdit} onChange={(e) => updateFill({ [key]: +e.target.value }, false)} />
          <span className="num readout">{f[key] == null ? 'map' : `${Math.round(f[key]! * 100)}%`}</span>
        </label>
      ))}
      <div className="fillchans">{channel('normal')}{channel('height')}</div>
      {mask}
    </div>
  );
}

/** A placed decal's projector and ink. The layer's opacity and blend modes sit above it as usual. */
function DecalSettings({ d }: { d: Decal }) {
  const list = useApp((s) => s.decals), span = modelDiagonal(); // eslint-disable-line react-hooks/exhaustive-deps
  const a = list.find((x) => x.id === d.asset);
  const pct = Math.max(1, Math.min(60, (d.width / span) * 100));
  return (
    <div className="gensettings decalsettings">
      <div className="decalpreview">
        <span className="decalimg">{a && <img src={decalUrl(a)} alt="" />}</span>
        <span className="hint">{a?.name ?? 'Imported decal'}<br />{Math.round(pct)}% of the model · {Math.round(d.rotation)}°</span>
      </div>
      <label title="How wide the mark is across the model">Size
        <input type="range" min={1} max={60} step={0.5} value={pct} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ width: span * (+e.target.value) / 100 }, false)} />
        <span className="num readout">{Math.round(pct)}%</span>
      </label>
      <label title="Rotate around the surface normal">Rotate
        <input type="range" min={-180} max={180} step={1} value={d.rotation} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ rotation: +e.target.value }, false)} />
        <span className="num readout">{Math.round(d.rotation)}°</span>
      </label>
      {d.shape ? <ShapeSettings d={d} span={span} /> : <InkSettings d={d} />}
      <DecalTurns d={d} />
      <div className="hint">With the Decal tool active, drag the mark on the model to move it over the surface; its corners scale it, the knob above rotates it (Shift: 15° steps). A click elsewhere adds another.</div>
    </div>
  );
}

/** A grip texture's relief, as shares of the model (as the decal's Size is): pattern, outline and groove border. */
const SHAPE_SLIDERS: ['cell' | 'amount' | 'border' | 'depth' | 'corner', string, string, number][] = [
  ['cell', 'Cell', 'Size of one stipple dot, groove or diamond', 3],
  ['amount', 'Height', 'How far the pattern stands up (grooves: how deep they cut)', 1],
  ['border', 'Border', 'Width of the groove round the edge (0: none)', 2],
  ['depth', 'Depth', 'How deep the border groove cuts', 1],
  ['corner', 'Corner', 'Radius of the outline\'s corners', 10],
];
function ShapeSettings({ d, span }: { d: Decal; span: number }) {
  const sh = d.shape!;
  return (
    <>
      <label title="What fills the panel">Pattern
        <select value={sh.pattern} onChange={(e) => updateDecal({ shape: { ...sh, pattern: e.target.value as Pattern } })}>
          <option value="stipple">Stipple</option><option value="grooves">Grooves</option><option value="checker">Checkering</option><option value="none">None (border only)</option>
        </select>
      </label>
      {SHAPE_SLIDERS.map(([key, name, tip, max]) => (
        <label key={key} title={tip}>{name}
          <input type="range" min={0} max={max} step={0.02} value={(sh[key] / span) * 100} onPointerDown={beginPaintEdit}
            onChange={(e) => updateDecal({ shape: { ...sh, [key]: Math.max(key === 'cell' ? 1e-4 : 0, (span * +e.target.value) / 100) } }, false)} />
          <span className="num readout">{((sh[key] / span) * 100).toFixed(2)}%</span>
        </label>
      ))}
      <label title="Bend round the model: the panel follows the surface over bevels and curves instead of projecting flat">Wrap
        <input type="checkbox" checked={!!d.wrap} onChange={(e) => updateDecal({ wrap: e.target.checked })} />
        <span className="hint">{d.wrap ? 'follows the surface' : 'flat projection'}</span>
      </label>
      <div className="hint">Outline: drag a corner on the model, click an edge's + to add one, Alt+click a corner to remove it.
        {sh.outline && <> <button onClick={() => updateDecal({ shape: { ...sh, outline: undefined } })}>Reset outline</button></>}</div>
    </>
  );
}

/** An image decal's ink: tint, roughness, metallic and engraving. */
function InkSettings({ d }: { d: Decal }) {
  return (
    <>
      <label title="Tint the mark's ink">Ink
        <input type="color" className="cswatch" value={d.tint} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ tint: e.target.value }, false)} />
      </label>
      <label title="Roughness where the decal covers the surface">Rough
        <input type="range" min={0} max={1} step={0.01} value={d.roughness} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ roughness: +e.target.value }, false)} />
        <span className="num readout">{Math.round(d.roughness * 100)}%</span>
      </label>
      <label title="Metallic where the decal covers the surface; metal decals catch the environment">Metal
        <input type="range" min={0} max={1} step={0.01} value={d.metallic} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ metallic: +e.target.value }, false)} />
        <span className="num readout">{Math.round(d.metallic * 100)}%</span>
      </label>
      <label title="Cut the mark into the surface: its outline bends the normal map and its ink lowers the height (needs PBR, turned on here)">Engrave
        <input type="range" min={0} max={1} step={0.05} value={d.engrave ?? 0} onPointerDown={beginPaintEdit} onChange={(e) => {
          const v = +e.target.value, i = useApp.getState().activePart;
          if (v > 0 && !texSet(i).channels.includes('normal')) setPbr(i, true);
          updateDecal({ engrave: v, channels: v > 0 ? ['color', 'rough', 'metal', 'normal', 'height'] : ['color', 'rough', 'metal'] }, false);
        }} />
        <span className="num readout">{(d.engrave ?? 0) > 0 ? `${Math.round((d.engrave ?? 0) * 100)}%` : 'off'}</span>
      </label>
    </>
  );
}

/** Mirror or quarter-turn the active decal (one undo step each). */
function DecalTurns({ d }: { d: Decal }) {
  const turn = (by: number) => updateDecal({ rotation: ((((d.rotation + by + 180) % 360) + 360) % 360) - 180 });
  return (
    <span className="seg decalturns">
      <button title="Mirror left to right" className={d.flipH ? 'on' : ''} onClick={() => updateDecal({ flipH: !d.flipH })}>Flip H</button>
      <button title="Mirror top to bottom" className={d.flipV ? 'on' : ''} onClick={() => updateDecal({ flipV: !d.flipV })}>Flip V</button>
      <button title="Turn 90° counter-clockwise" onClick={() => turn(90)}>⟲ 90°</button>
      <button title="Turn 90° clockwise" onClick={() => turn(-90)}>⟳ 90°</button>
    </span>
  );
}

/** Photoshop's options bar: the current tool and its settings. The right end is the shared ViewControls cluster:
 *  select-by (Face / Island / Part) | display | Shading. */
export function PaintOptionsBar() {
  const p = useApp((s) => s.paint), channels = useChannels(), t = ALL[p.tool];
  const fill = useApp((s) => {
    if (!s.parts[s.activePart]) return false;
    const set = texSet(s.activePart);
    return !!set.layers[set.active]?.fill;
  });
  useApp((s) => s.paintRev);
  const decal = activeDecal()?.decal;
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
      {p.tool === 'brush' && !fill && values}
      {p.tool === 'brush' && fill && <span className="maskbadge" title="This layer is a fill: the brush paints its mask. Use a paint layer above it to paint color.">Mask</span>}
      {p.tool === 'erase' && fill && <span className="maskbadge" title="Erase the fill's mask here">Mask</span>}
      {(p.tool === 'brush' || p.tool === 'erase') && <>
        {slider('Size', 'size', 0.2, 20, 0.2, 'Brush radius: a share of the model, or of the texture in the texture view ([ and ])')}
        {slider('Flow', 'flow', 0.05, 1, 0.05, 'How much each dab lays down; strokes build up')}
        {slider('Hardness', 'hardness', 0, 1, 0.05, 'How much of the radius paints at full strength before it fades')}
        <label title="Brush tip silhouette and grain">Tip
          <select value={p.tip} onChange={(e) => setPaint({ tip: e.target.value as BrushTip })}>
            <option value="round">Round</option>
            <option value="square">Square</option>
            <option value="chalk">Chalk</option>
            <option value="spray">Spray</option>
            <option value="ring">Ring</option>
          </select>
        </label>
      </>}
      {p.tool === 'decal' && <span className="decalhint" title="Pick the mark in the Decals tab, then click the model">Click to place · drag to move · corners scale · knob rotates</span>}
      {p.tool === 'decal' && <label title="Also place each new mark mirrored on the far side of the model (both flanks in one click)"><input type="checkbox" checked={p.decalMirror} onChange={(e) => setPaint({ decalMirror: e.target.checked })} />Mirror</label>}
      {p.tool === 'decal' && decal && <DecalTurns d={decal} />}
      {p.tool === 'picker' && <span className="swatch" style={{ background: p.color }} />}
      <ViewControls />
    </div>
  );
}

/** The active part's layers as Photoshop's Layers panel: opacity on top, the stack top first with thumbnails (drag to
 *  reorder, double-click to rename), the new / duplicate / delete buttons along the bottom. */
function Layers() {
  const rev = useApp((s) => s.paintRev), part = useApp((s) => (s.parts[s.activePart] ? s.activePart : -1));
  useApp((s) => s.paintPanel); // a full recomposite is async; the panel still updates immediately
  const shown = useApp((s) => s.paintChannel);
  const [drag, setDrag] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null), [name, setName] = useState('');
  const [unfolded, setUnfolded] = useState<Set<number>>(new Set());
  const s = part < 0 ? null : texSet(part);
  const thumbs = useMemo(() => (s ? s.layers.map((l) => thumbOf(s, l)) : []), [s, rev]);
  if (!s) return null;
  const l = s.layers[s.active];
  // Substance's layer stack has one blend per channel, and the stack follows the channel being viewed: so does this.
  const ch: Channel = shown === 'rough' || shown === 'metal' || shown === 'normal' || shown === 'height' ? shown : 'color';
  const mode = blendOf(l, ch);
  const commit = () => { if (renaming !== null && name.trim()) editPaintLayer(renaming, { name: name.trim() }); setRenaming(null); };
  // Runs of 3+ decal layers fold into one row (a gun's markings are a dozen layers): the run's bottom layer index -> its
  // size, the rest -> -1 (drawn as nothing). Open when clicked or when the active layer is inside.
  const folded = new Map<number, number>();
  for (let j = 0; j < s.layers.length;) {
    let k = j;
    while (k < s.layers.length && s.layers[k].decal) k++;
    if (k - j >= 3 && !unfolded.has(s.layers[j].id) && (s.active < j || s.active >= k)) { folded.set(j, k - j); for (let m = j + 1; m < k; m++) folded.set(m, -1); }
    j = k > j ? k : j + 1;
  }
  return (
    <div className="pslayers">
      <label className="lopacity" title="The active layer's opacity">Opacity
        <input type="range" min={0} max={1} step={0.01} value={l.opacity} onPointerDown={beginPaintEdit} onChange={(e) => editPaintLayer(s.active, { opacity: +e.target.value }, false)} />
        <span className="num readout">{Math.round(l.opacity * 100)}%</span>
      </label>
      <label className="lopacity" title={ch === 'normal'
        ? 'Normals always combine with what is below (the whiteout blend): a plain mix would flatten the detail'
        : `How this layer's ${CHANNELS[ch].name} meets the layers below. Each channel keeps its own blend (Substance Painter's stack); switch channel in the Parts tree to change another one.`}>
        Blend <span className="hint">{ch === 'normal' ? '· Combine' : `· ${CHANNELS[ch].name}`}</span>
        <select value={ch === 'normal' ? 'normal' : mode} disabled={ch === 'normal'} onChange={(e) => setLayerBlend(ch, e.target.value as BlendMode)}>
          <option value="normal">{ch === 'height' ? 'Replace' : 'Normal'}</option>
          <option value="multiply">Multiply</option>
          <option value="screen">Screen</option>
          <option value="overlay">Overlay</option>
          <option value="add">{ch === 'height' ? 'Add (Linear Dodge)' : 'Add'}</option>
        </select>
      </label>
      {l.fill && <details className="tsec-details fillprops">
        <summary className="tsec"><span className="caps"><Icon name="chevron" size={11} className="chev" />Fill settings</span><span className="hint">{l.fill.projection === 'uv' ? 'UV' : 'Tri-planar'} · {l.fill.projection === 'uv' ? `${l.fill.tiling}×` : `${l.fill.tiles}×`}</span></summary>
        <FillSettings f={l.fill} />
      </details>}
      {l.decal && <details className="tsec-details decalprops" open>
        <summary className="tsec"><span className="caps"><Icon name="chevron" size={11} className="chev" />Decal settings</span><span className="hint">drag on model</span></summary>
        <DecalSettings d={l.decal} />
      </details>}
      {l.gen && <GenSettings g={l.gen} />}
      <ul className="layers doc thumbs" aria-label="Layers (drag to reorder, double-click to rename)">
        {s.layers.map((x, j) => folded.has(j) ? (folded.get(j)! >= 0 ? (
          <li key={`run${x.id}`} className="layer decalrun" title="Decals stacked together; click to show them" onClick={() => setUnfolded(new Set(unfolded).add(x.id))}>
            <span className="lname"><span className="decalmark">◆ </span>Decals</span>
            <span className="ltype num">{folded.get(j)} ▸</span>
          </li>
        ) : null) : (
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
              <span className="lname">{x.fill && <span className="fillmark" title="Fill layer: a PBR material">▤ </span>}{x.decal && <span className="decalmark" title="Decal layer: projected onto the model">◆ </span>}{x.gen && <span className="genmark" title="Generator layer: made from the baked maps">◇ </span>}{x.name}</span>
            )}
            <span className="ltype num">{x.fill ? (x.fill.asset === SOLID ? 'Solid' : 'Fill') : x.decal ? 'Decal' : x.opacity < 1 ? `${Math.round(x.opacity * 100)}%` : ''}</span>
          </li>
        )).reverse()}
      </ul>
      <div className="lbar">
        <button title="Fill the active layer (or the selection) with the color (Alt+Backspace)" aria-label="Fill" onClick={() => fillPaintSelection()}>{glyph('M3 7l5-5 5 5-5 5zM13.5 10.5c0 1.5-1 2.5-1 2.5s-1-1-1-2.5 1-2 1-2 1 .5 1 2z')}</button>
        <button title="Solid fill: a layer of one colour, roughness and metallic (the options bar's, or the brush's) over the selection; it stays editable, so the colour can change later without repainting" aria-label="Solid fill layer" onClick={addSolidFill}>{glyph('M2.5 2.5h11v11h-11z')}</button>
        <button title="Metal sheen: a new layer that makes the selection (say islands picked with Select Faces W, Island) shiny metal, Metallic 100% / Roughness 25%, colour untouched; its opacity sets how much" aria-label="Metal sheen layer" onClick={addMetalLayer}>{glyph('M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z')}</button>
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
        <button className="primary" disabled={!has} title="Bake ambient occlusion and curvature for the active texture set; the other visible parts cast occlusion" onClick={() => void bakePaint()}>{baked ? 'Bake again' : 'Bake this part'}</button>
        <button disabled={!has} title="Bake every visible texture set; slower, but smart materials on other parts need it" onClick={() => void bakeAllPaint()}>All parts</button>
      </div>
      <label className="toggle" title="Shade the model with the baked ambient occlusion (only on screen; the textures stay as painted)"><input type="checkbox" checked={ao} disabled={!baked} onChange={(e) => setPaintAO(e.target.checked)} />Show AO</label>
      <div className="tsec"><span className="caps">Generators</span><span className="hint">{baked ? 'a new layer, inside the selection' : 'bakes this part first'}</span></div>
      <div className="tgrid">
        {GENS.map(([k, name, title]) => <button key={k} disabled={!has} title={title} onClick={() => void addGenerator(k)}>{name}</button>)}
      </div>
    </>
  );
}

/** The Maps tab's way into File › Export…: presets, size, gutter and the FBX option live in the dialog, so a
 *  texture export has one place to be set up. */
function TextureExport() {
  const has = useApp((s) => !!s.result), size = useApp((s) => s.exportSize), res = useApp((s) => s.textureResolution);
  const target = useApp((s) => (s.exportFbx ? 'blender' : s.texturePreset));
  return (
    <>
      <div className="tsec"><span className="caps">Texture export</span><span className="hint">{targetInfo(target).label} · {size / 1024}K</span></div>
      <button className="primary wide" disabled={!has} title="Choose a destination, resolution and gutter, then the engine renders each texture set at full size" onClick={() => openExport({ kind: 'textures' })}>Export textures…</button>
      <div className="hint">Fills, decals and generators are drawn fresh at the export size; hand paint is scaled up from the working resolution ({res}px). Presets, size and gutter are in the export dialog.</div>
    </>
  );
}

const TABS = [['layers', 'Layers'], ['materials', 'Materials'], ['tiles', 'Tiles'], ['decals', 'Decals'], ['maps', 'Maps']] as const;

/** One compact texture-set row instead of the full Parts tree: choose the part, toggle PBR, and keep the
 *  tree itself collapsed below the layers for the rare times it is needed. */
function LayersTab() {
  const parts = useApp((s) => s.parts), active = useApp((s) => s.activePart), rev = useApp((s) => s.paintRev), link = useApp((s) => s.linkSets);
  const channels = parts[active] ? texSet(active).channels : ['color'];
  return (
    <div className="vgtab layerspane">
      <div className="setbar">
        <span className="caps">Texture set</span>
        <select value={active} onChange={(e) => pickPaintPart(+e.target.value)} aria-label="Active texture set">
          {parts.map((p, i) => <option key={i} value={i}>{p.name}</option>)}
        </select>
        <button className="pbr" aria-pressed={channels.length > 1} title={channels.length > 1 ? 'Back to Base Color only' : 'Add Roughness, Metallic, Normal and Height'}
          onClick={() => setPbr(active, channels.length === 1)}>{channels.length > 1 ? 'PBR' : '+ PBR'}</button>
        <label className="allsets" title="New fills, solids and generators go on every visible part, and editing a layer edits the layer of the same name on each of them"><input type="checkbox" checked={link} onChange={(e) => setLinkSets(e.target.checked)} />All sets</label>
      </div>
      <Layers />
      <details className="tsec-details setlist" key={active}>
        <summary className="tsec"><span className="caps"><Icon name="chevron" size={11} className="chev" />All texture sets</span><span className="hint">{parts.length} parts</span></summary>
        <Parts workspace="paint" />
      </details>
    </div>
  );
}

export function VanGogh() {
  const tab = useApp((s) => s.paintTab);
  useEffect(() => { loadDecals(); }, []);
  return (
    <aside className="dock paintdock">
      <div className="vgcolor" title="Paint color"><ColorWheel /></div>
      <div className="vgtabs" role="tablist" aria-label="Van Gogh panels">
        {TABS.map(([id, name]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setPaintTab(id)}>{name}</button>)}
      </div>
      <div className="vgbody">
        {tab === 'layers' && <LayersTab />}
        {tab === 'materials' && <div className="vgtab" key="materials"><Materials /></div>}
        {tab === 'tiles' && <div className="vgtab" key="tiles"><Materials tiles /></div>}
        {tab === 'decals' && <div className="vgtab"><Decals /></div>}
        {tab === 'maps' && <div className="vgtab"><Bake /><TextureExport /></div>}
      </div>
    </aside>
  );
}
