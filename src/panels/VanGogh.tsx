// Van Gogh: paint textures straight onto the model, through the UVs UV Magician made, in the same frame as UV Magician
// (tool strip | 3D | texture | panel). Photoshop's way: a selection (Marquee, Lasso, Wand) that every paint tool
// (Brush, Eraser, Bucket) stays inside, on the model and in the texture view alike; the options bar holds the current
// tool's settings; the panel the parts (collapsible, with their channels: Substance's texture sets) and the active
// part's Layers, as Photoshop's panel lays them out.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { CHANNELS, SOLID, blendOf, thumbOf, type BlendMode, type BrushTip, type Channel, type Bevel, type Decal, type Fill, type Pattern, type Gen, type GenKind } from '../paint';
import { MATERIAL_GROUPS, TILE_KINDS, materialGroup, thumbUrl, tileKind } from '../materials';
import { ColorPick } from '../ui/ColorPick';
import { GRIP_SHAPES, decalUrl } from '../decals';
import { decalDragOver, decalDrop, shelfDragOver, shelfDrop } from '../views/Viewport3D';
import { targetInfo } from '../exporting';
import { Parts, eye } from './Dock';
import { ColorWheel } from './ColorWheel';
import { ToolStrip, type ToolDef } from '../shell/PolyTools';
import { SelectionControls } from '../shell/Chrome';
import { ico, Icon, ICON } from '../ui/Icon';
import {
  activeDecal, addBevel, editBevel, fitDecal, setGripPreset, shelfDrag, addGenerator, addSolidFill, alignDecal, centerDecal, duplicateDecal, mirrorDecal, setDecalMode, unlinkDecal, setLinkSets, addMetalLayer, addPaintLayer, assignMaterial, bakeAllPaint, bakePaint, beginPaintEdit, clearFillMask, deletePaintLayer, duplicatePaintLayer, editGen, editPaintLayer, fillPaintSelection, importDecal, importMaterialFiles,
  invertFillMask, loadDecals, loadMaterials, modelDiagonal, movePaintLayerTo, openExport, pickDecal, pickPaintLayer, pointer, setAssetTab, setFillBlend, setFillMask, setLayerBlend, setPaint, setPaintAO, setPaintTab, setPbr, texSet, undoPaint, updateDecal, updateFill, useApp, type PaintTool,
} from '../store';

const PAINT_TOOLS: Partial<Record<PaintTool, ToolDef>>[] = [
  {
    marquee: { name: 'Marquee', key: 'M', tip: 'Drag a rectangle on the model or the texture to select (Shift adds, Alt takes away, a click deselects)', run: () => setPaint({ tool: 'marquee' }), on: () => true,
      icon: ico(['M3 4h14v12H3z', 'd']) },
    lasso: { name: 'Lasso', key: 'L', tip: 'Draw round what to select, on the model or the texture (Shift adds, Alt takes away)', run: () => setPaint({ tool: 'lasso' }), on: () => true,
      icon: ico('M10 3c4.4 0 7.5 2 7.5 4.6S14.4 12.2 10 12.2 2.5 10.2 2.5 7.6 5.6 3 10 3zM5.5 11.4c-1.3 1.2-.9 3 .7 3.3 1 .2 1 1.6-.4 2.8') },
    wand: { name: 'Select Faces', key: 'W', tip: 'Click to select a face, an island or the whole part (options bar); Shift adds, Alt takes away', run: () => setPaint({ tool: 'wand' }), on: () => true,
      icon: ico('M2 3h12v12H2zM6 3v12M10 3v12M2 7h12M2 11h12', ['M6 7h4v4H6z', 'A'], ['M10.5 9.5l7 5-3.2.6 1.8 3.3-1.4.8-1.8-3.4-2.4 2.3z', 'F']) },
  },
  {
    decal: { name: 'Decal', key: 'D', tip: 'Click a mark on the model to select it, drag it to slide it over the surface; its handles scale, stretch and turn it, and a click on bare surface deselects. Place writes the mark armed in Assets > Decals (or Alt+click)', run: () => setPaint({ tool: 'decal', decalMode: 'edit' }), on: () => true,
      icon: ico(['M4 3h12v8l-5 6H4z', 'f'], 'M4 3h12v8l-5 6H4z', ['M16 11h-3.8a1.2 1.2 0 0 0-1.2 1.2V17z', 'F'], ['M10 5.5l1.1 2.3 2.4.3-1.8 1.7.5 2.4-2.2-1.2-2.2 1.2.5-2.4-1.8-1.7 2.4-.3z', 'A']) },
  },
  {
    brush: { name: 'Brush', key: 'B', tip: 'Paint where you drag, on the model or the texture; Alt+click picks a color', run: () => setPaint({ tool: 'brush' }), on: () => true,
      icon: ico(['M17.2 1.5l1.3 1.3-6.8 7.2-1.7-1.7z', 'F'], ['M9.3 9l1.7 1.7c.3 2.8-1.6 5.4-5 5.7-1.5.1-2.6.8-3.5 2 .2-3.8 1.3-7 4.1-8.4 1-.6 1.8-1 2.7-1z', 'A']) },
    erase: { name: 'Eraser', key: 'E', tip: 'Take paint off the active layer where you drag', run: () => setPaint({ tool: 'erase' }), on: () => true,
      icon: ico('M11.5 3L17 8.5 9 16.5 3.5 11zM9 16.5h8', ['M6.7 7.8l5.5 5.5L9 16.5 3.5 11z', 'F']) },
    bucket: { name: 'Bucket', key: 'G', tip: 'Click to fill a face, an island or the whole part (options bar), on the model or the texture; inside the selection', run: () => setPaint({ tool: 'bucket' }), on: () => true,
      icon: ICON.bucket },
    picker: { name: 'Eyedropper', key: 'I', tip: 'Click a part to pick up its material layers (fills, solids, generators, bevel — not decals or hand paint), then click a part, island or face (the Face / Island / Part setting) to apply them; Esc drops them. Color mode samples the surface', run: () => setPaint({ tool: 'picker' }), on: () => true,
      icon: ICON.picker },
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
            <img src={thumbUrl(m)} alt="" loading="lazy" draggable={false} style={m.colorless ? { filter: 'grayscale(1)' } : undefined} />
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
  const armed = useApp((s) => s.paint.decalAsset);
  const [q, setQ] = useState(''), [cat, setCat] = useState('All'), input = useRef<HTMLInputElement>(null);
  useEffect(() => { loadDecals(); }, []);
  const imageDecals = useMemo(() => list.filter((d) => !d.shape), [list]);
  const cats = useMemo(() => ['All', ...Array.from(new Set(imageDecals.map((d) => d.category)))], [imageDecals]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return imageDecals.filter((d) => (cat === 'All' || d.category === cat) && (!needle || `${d.name} ${d.category} ${d.tags.join(' ')}`.toLowerCase().includes(needle)));
  }, [imageDecals, q, cat]);
  return (
    <div className="matshelf decalshelf">
      <div className="matsticky">
        <div className="matbar">
          <input className="matsearch" type="search" placeholder="Search decals" value={q} onChange={(e) => setQ(e.target.value)} />
          <button title="Import a transparent PNG mark from disk" onClick={() => input.current?.click()}>Import</button>
        </div>
        <div className="matchips">
          {cats.map((c) => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
        </div>
      </div>
      {error && <div className="hint fix">{error}</div>}
      {loading && !list.length && <div className="hint">Loading decals…</div>}
      <div className="decalgrid">
        {shown.map((d) => (
          <button key={d.id} className={`decaltile${d.id === armed ? ' on' : ''}`} title={`${d.name} — ${d.category}${d.notes ? `\n${d.notes}` : ''}\n${d.width}×${d.height} · ${d.license}`} onPointerDown={(e) => holdTile(e, d.id, decalUrl(d), decalDragOver, decalDrop, false)} onClick={() => { if (!tileDragged) pickDecal(d.id); }}>
            <span className="decalimg"><img src={decalUrl(d)} alt="" draggable={false} /></span>
            <span>{d.shape ? 'Grip texture' : d.name}</span>
          </button>
        ))}
      </div>
      {!loading && !shown.length && <div className="hint">No decal matches.</div>}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importDecal(f); e.target.value = ''; }} />
    </div>
  );
}

/** Shape based grip reliefs are geometry assets, kept separate from image decals. */
function Geometry() {
  const list = useApp((s) => s.decals), loading = useApp((s) => s.decalsLoading), error = useApp((s) => s.decalsError);
  const armed = useApp((s) => s.paint.decalAsset);
  const [q, setQ] = useState(''), [cat, setCat] = useState('All');
  useEffect(() => { loadDecals(); }, []);
  const shapes = useMemo(() => list.filter((d) => !!d.shape), [list]);
  const cats = useMemo(() => ['All', ...Array.from(new Set(shapes.map((d) => d.category)))], [shapes]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return shapes.filter((d) => (cat === 'All' || d.category === cat) && (!needle || `${d.name} ${d.category} ${d.tags.join(' ')}`.toLowerCase().includes(needle)));
  }, [shapes, q, cat]);
  return (
    <div className="matshelf decalshelf">
      <div className="matsticky">
        <div className="matbar"><input className="matsearch" type="search" placeholder="Search geometry" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="matchips">{cats.map((c) => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}</div>
      </div>
      {error && <div className="hint fix">{error}</div>}
      {loading && !shapes.length && <div className="hint">Loading geometry…</div>}
      <div className="decalgrid">
        {shown.map((d) => <button key={d.id} className={`decaltile${d.id === armed ? ' on' : ''}`} title={`${d.name}${d.notes ? `\n${d.notes}` : ''}`} onPointerDown={(e) => holdTile(e, d.id, decalUrl(d), decalDragOver, decalDrop, false)} onClick={() => { if (!tileDragged) pickDecal(d.id); }}>
          <span className="decalimg"><img src={decalUrl(d)} alt="" draggable={false} /></span><span>{d.name}</span>
        </button>)}
      </div>
      {!loading && !shown.length && <div className="hint">No geometry matches.</div>}
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
        <ColorPick value={f.tint} onStart={beginPaintEdit} onChange={(c) => updateFill({ tint: c }, false)} label="Fill tint" />
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
        <ColorPick value={f.tint} onStart={beginPaintEdit} onChange={(c) => updateFill({ tint: c }, false)} label="Fill tint" />
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

/** The model axes a mirror pair is described by. */
const AXES = ['X', 'Y', 'Z'] as const;
/** A typed number for a decal's size or angle: Enter or blur commits, so typing an exact width moves the mark once. */
function Num({ value, min, max, step, suffix, onCommit }: { value: number; min: number; max: number; step: number; suffix: string; onCommit: (v: number) => void }) {  const [text, setText] = useState(value.toFixed(1));
  useEffect(() => setText(value.toFixed(1)), [value]);
  const commit = () => {
    const v = +text;
    if (!Number.isFinite(v)) { setText(value.toFixed(1)); return; }
    const c = Math.min(max, Math.max(min, v));
    if (Math.abs(c - value) > 1e-6) onCommit(c); else setText(value.toFixed(1));
  };
  return <span className="numfield">
    <input type="number" min={min} max={max} step={step} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    <span className="unit">{suffix}</span>
  </span>;
}

/** A placed decal's projector and ink. The layer's opacity and blend modes sit above it as usual. */
function DecalSettings({ d }: { d: Decal }) {
  const list = useApp((s) => s.decals), span = modelDiagonal(); // eslint-disable-line react-hooks/exhaustive-deps
  useApp((s) => s.paintLive); // a gizmo drag updates these readouts as it goes
  const a = list.find((x) => x.id === d.asset);
  const pct = Math.max(0.1, Math.min(60, (d.width / span) * 100));
  const hpct = Math.max(0.1, Math.min(60, (d.width / Math.max(d.aspect, 1e-4) / span) * 100));
  return (
    <div className="decalsettings">
      <div className="decalpreview" title="On the model: drag the mark to slide it (Shift snaps it to the middle), corners scale, side bars stretch, the knob turns it (Shift 15°), arrows nudge and [ ] resize. A click on bare surface deselects; Delete removes the layer.">
        <span className="decalimg">{a && <img src={decalUrl(a)} alt="" />}</span>
        <span className="hint">{a?.name ?? 'Imported decal'}<br />{Math.round(pct)}% × {Math.round(hpct)}% of the model · {Math.round(d.rotation)}°</span>
      </div>
      <label title="How wide the mark is across the model">Width
        <input type="range" min={1} max={60} step={0.5} value={pct} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ width: span * (+e.target.value) / 100 }, false)} />
        <Num value={pct} min={0.1} max={60} step={0.1} suffix="%" onCommit={(v) => updateDecal({ width: span * v / 100 })} />
      </label>
      <label title="How tall the mark is; with Width it sets the aspect, so a mark can be stretched to fit a panel">Height
        <input type="range" min={1} max={60} step={0.5} value={hpct} onPointerDown={beginPaintEdit}
          onChange={(e) => updateDecal({ aspect: d.width / Math.max(1e-6, span * (+e.target.value) / 100) }, false)} />
        <Num value={hpct} min={0.1} max={60} step={0.1} suffix="%" onCommit={(v) => updateDecal({ aspect: d.width / Math.max(1e-6, span * v / 100) })} />
      </label>
      <label title="Rotate around the surface normal">Rotate
        <input type="range" min={-180} max={180} step={1} value={d.rotation} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ rotation: +e.target.value }, false)} />
        <Num value={d.rotation} min={-180} max={180} step={1} suffix="°" onCommit={(v) => updateDecal({ rotation: v })} />
      </label>
      <span className="seg decalactions">
        <button onClick={centerDecal} title="Middle of the model across the face the mark lies on">Center</button>
        <button onClick={alignDecal} title="Turn the projector onto the surface under the mark">Face</button>
        <button onClick={duplicateDecal} title="Copy the mark just above it, nudged so both are visible (Ctrl+J)">Duplicate</button>
        <button onClick={deletePaintLayer} title="Delete the mark and its layer (Delete with the Decal tool)">Delete</button>
      </span>
      <div className="decalmirror">
        {d.mirror ? <>
          <span className="hint" title="A linked pair: moving, scaling, turning or re-inking either half does both">Mirrored across {AXES[d.mirror.axis]} · linked</span>
          <button onClick={unlinkDecal} title="Keep both marks, each independent from now on">Unlink</button>
        </> : <button onClick={mirrorDecal} title="Put the same mark on the opposite side of the model as a linked pair: moving, scaling, turning or re-inking either one does both (Ctrl+M)">Mirror to other side</button>}
      </div>
      {d.shape ? <ShapeSettings d={d} span={span} /> : <InkSettings d={d} />}
      <DecalTurns d={d} />
    </div>
  );
}

/** A grip texture's relief, as shares of the model (as the decal's Size is): pattern, outline and groove border. */
const SHAPE_SLIDERS: ['cell' | 'amount' | 'border' | 'depth' | 'corner', string, string, number][] = [
  ['amount', 'Height', 'How far the pattern stands up (grooves: how deep they cut)', 1],
  ['border', 'Border', 'Width of the groove round the edge (0: none)', 2],
  ['depth', 'Depth', 'How deep the border groove cuts', 1],
  ['corner', 'Corner', 'Radius of the outline\'s corners', 10],
];
function ShapeSettings({ d, span }: { d: Decal; span: number }) {
  const sh = d.shape!;
  return (
    <>
      <div className="grip-presets" role="group" aria-label="Grip texture presets" title="Choose a starting look; you can adjust its settings below">
        {GRIP_SHAPES.map((g) => <button key={g.id} className={`grip-preset${sh.pattern === g.shape?.pattern ? ' on' : ''}`} aria-pressed={sh.pattern === g.shape?.pattern} title={`${g.name}: ${g.notes ?? ''}`} onClick={() => setGripPreset(g.id)}>
          <span className="decalimg"><img src={decalUrl(g)} alt="" /></span><span>{g.name}</span>
        </button>)}
      </div>
      <span className="seg decalactions" title={d.mirror ? 'Unlink the mirror pair first' : undefined}>
        <button disabled={!!d.mirror} onClick={() => fitDecal('faces')} title="Cover the faces picked with Select Faces (W) with the pattern, wrapped round them and stopping at their edges">Fit to faces</button>
        <button disabled={!!d.mirror} onClick={() => fitDecal('part')} title="Cover the whole part with the pattern, wrapped round it">Fit to part</button>
      </span>
      {sh.pattern !== 'none' && <label title={sh.pattern === 'grooves' ? 'Distance between parallel ribs' : sh.pattern === 'stipple' ? 'Size of each raised dot' : 'Size of each checkered diamond'}>
        {sh.pattern === 'grooves' ? 'Rib spacing' : sh.pattern === 'stipple' ? 'Dot size' : 'Diamond size'}
        <input type="range" min={0} max={3} step={0.02} value={(sh.cell / span) * 100} onPointerDown={beginPaintEdit}
          onChange={(e) => updateDecal({ shape: { ...sh, cell: Math.max(1e-4, (span * +e.target.value) / 100) } }, false)} />
        <span className="num readout">{((sh.cell / span) * 100).toFixed(2)}%</span>
      </label>}
      <details className="grip-advanced">
        <summary>Fine tune</summary>
        <div className="grip-advanced-body">
          <div className="grip-patterns" role="group" aria-label="Pattern">
            {([['stipple', 'Dots'], ['grooves', 'Ribs'], ['checker', 'Crosshatch'], ['none', 'Border only']] as [Pattern, string][]).map(([pattern, label]) =>
              <button key={pattern} className={sh.pattern === pattern ? 'on' : ''} aria-pressed={sh.pattern === pattern} onClick={() => updateDecal({ shape: { ...sh, pattern } })}>{label}</button>)}
          </div>
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
          {sh.outline && <button title="Back to the rectangle (drag a corner on the model, click an edge's + to add one, Alt+click a corner to remove it)" onClick={() => updateDecal({ shape: { ...sh, outline: undefined } })}>Reset outline</button>}
        </div>
      </details>
    </>
  );
}

/** An image decal's ink: tint, roughness, metallic and engraving. */
function InkSettings({ d }: { d: Decal }) {
  return (
    <>
      <label title="Tint the mark's ink">Ink
        <ColorPick value={d.tint} onStart={beginPaintEdit} onChange={(c) => updateDecal({ tint: c }, false)} label="Decal tint" />
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

/** Photoshop's options bar: the current tool, its settings, and the Select-by group for the tools that use it (Select
 *  Faces, Bucket, the Materials eyedropper). Lighting and Shading live in the 3D view header. */
export function PaintOptionsBar() {
  const p = useApp((s) => s.paint), channels = useChannels(), t = ALL[p.tool];
  const target = p.by === 'part' ? 'the part' : p.by === 'island' ? 'the island' : p.by === 'face' ? 'the face' : 'the surface';
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
    <label title="Base Color">{tick('color')}Color<ColorPick value={p.color} onChange={(c) => setPaint({ color: c })} label="Base Color" /></label>
    {channels.includes('rough') && <label>{tick('rough')}{slider('Rough', 'rough', 0, 1, 0.01, 'Roughness: 0 mirror, 100% chalk')}</label>}
    {channels.includes('metal') && <label>{tick('metal')}{slider('Metal', 'metal', 0, 1, 0.01, 'Metallic: 0 for everything but bare metal')}</label>}
  </>;
  return (
    <div className="options">
      <span className="toolname">{t.icon}{t.name}</span>
      {(p.tool === 'wand' || p.tool === 'bucket' || (p.tool === 'picker' && p.pickMode === 'material')) && <SelectionControls />}
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
      {p.tool === 'decal' && <>
        <span className="seg decalmode">
          <button className={p.decalMode === 'edit' ? 'on' : ''} onClick={() => setDecalMode('edit')} title="Click a mark on the model to select it, drag it to slide it over the surface (Shift: the middle line). A click on bare surface deselects, so a missed grab leaves no mark behind.">Select</button>
          <button className={p.decalMode === 'place' ? 'on' : ''} onClick={() => setDecalMode('place')} title="The next click on the model puts the armed mark there, then the tool is back in Select (Alt+click does it any time)">Place</button>
        </span>
        <span className="decalhint" title="The whole manipulator is on the mark: the middle disc slides it, corners scale it, the side bars stretch one axis, the knob turns it">drag to slide · corners scale · bars stretch · knob turns · Shift snaps</span>
      </>}
      {p.tool === 'decal' && decal && <>
        <button onClick={centerDecal} title="Put the mark on the model's middle across the face it lies on — a gun's flanks, a scope's bore (Shift while dragging catches it there too)">Center</button>
        <button onClick={alignDecal} title="Turn the projector onto the surface under the mark, after a drag left it leaning">Face</button>
        <DecalTurns d={decal} />
      </>}
      {p.tool === 'decal' && <label title="Each new mark lands on both sides of the model as a linked pair. The selected mark is mirrored from its settings (Ctrl+M)"><input type="checkbox" checked={p.decalMirror} onChange={(e) => setPaint({ decalMirror: e.target.checked })} />Mirror new</label>}
      {p.tool === 'picker' && <>
        <span className="seg pickmode" title="What the Eyedropper takes">
          <button className={p.pickMode === 'material' ? 'on' : ''} onClick={() => setPaint({ pickMode: 'material' })} title="Click a part to pick up its material layers (fills, solids, generators, bevel), then click where to apply them; decals and hand paint are left behind">Materials</button>
          <button className={p.pickMode === 'color' ? 'on' : ''} onClick={() => setPaint({ pickMode: 'color' })} title="Take the base color, roughness and metallic under the pointer">Color</button>
        </span>
        {p.pickMode === 'material'
          ? <span className="hint" title={p.grab
            ? `Holding ${p.grab.count} material layer${p.grab.count === 1 ? '' : 's'} from ${p.grab.fromName}. A click applies them to ${target}: the part replaces its own material layers; a face, island or surface adds them masked there. Change the target with Face / Island / Part at the right. Decals, hand paint and layer masks stay. Esc drops them.`
            : 'Click a part to pick up its material layers (fills, solids, generators, bevel — no decals or hand paint), then click a part, island or face to apply them. Esc drops them.'}>
            {p.grab ? <>holding <b>{p.grab.name}</b> · apply to {target} · Esc drops</> : 'click a part to pick up its materials'}
          </span>
          : <span className="swatch" style={{ background: p.color }} />}
      </>}
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
  const [unfolded, setUnfolded] = useState<Set<number>>(new Set()), [open, setOpen] = useState(true);
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
  // the selected layer's settings unfold under its row (a click on it again folds them)
  const props = (
    <li key="props" className="lprops">
      <label className="lopacity" title="The layer's opacity">Opacity
        <input type="range" min={0} max={1} step={0.01} value={l.opacity} onPointerDown={beginPaintEdit} onChange={(e) => editPaintLayer(s.active, { opacity: +e.target.value }, false)} />
        <span className="num readout">{Math.round(l.opacity * 100)}%</span>
      </label>
      <label className="lopacity" title={ch === 'normal'
        ? 'Normals always combine with what is below (the whiteout blend): a plain mix would flatten the detail'
        : `How this layer's ${CHANNELS[ch].name} meets the layers below. Each channel keeps its own blend (Substance Painter's stack); switch channel in the texture set's list to change another one.`}>
        Blend <span className="hint">{ch === 'normal' ? '· Combine' : `· ${CHANNELS[ch].name}`}</span>
        <select value={ch === 'normal' ? 'normal' : mode} disabled={ch === 'normal'} onChange={(e) => setLayerBlend(ch, e.target.value as BlendMode)}>
          <option value="normal">{ch === 'height' ? 'Replace' : 'Normal'}</option>
          <option value="multiply">Multiply</option>
          <option value="screen">Screen</option>
          <option value="overlay">Overlay</option>
          <option value="add">{ch === 'height' ? 'Add (Linear Dodge)' : 'Add'}</option>
        </select>
      </label>
      {l.fill && <FillSettings f={l.fill} />}
      {l.decal && <DecalSettings d={l.decal} />}
      {l.gen && <GenSettings g={l.gen} />}
      {l.bevel && <BevelSettings b={l.bevel} />}
    </li>
  );
  return (
    <div className="pslayers">
      <ul className="layers doc thumbs" aria-label="Layers (drag to reorder, double-click to rename, click the selected one to fold its settings)">
        {s.layers.map((x, j) => folded.has(j) ? (folded.get(j)! >= 0 ? [(
          <li key={`run${x.id}`} className="layer decalrun" title="Decals stacked together; click to show them" onClick={() => setUnfolded(new Set(unfolded).add(x.id))}>
            <span className="lname"><span className="decalmark">◆ </span>Decals</span>
            <span className="ltype num">{folded.get(j)} ▸</span>
          </li>
        )] : []) : [(
          <li key={x.id} className={`layer${j === s.active ? ' on' : ''}${drag !== null && drag !== j ? ' droppable' : ''}`} draggable
            onDragStart={() => setDrag(j)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag !== null) movePaintLayerTo(drag, j); setDrag(null); }}
            onClick={() => { if (j === s.active) setOpen(!open); else { pickPaintLayer(j); setOpen(true); } }} onDoubleClick={() => { setRenaming(j); setName(x.name); }}>
            <button aria-pressed={x.visible} title={x.visible ? 'Hide layer' : 'Show layer'} onClick={(e) => { e.stopPropagation(); editPaintLayer(j, { visible: !x.visible }); }}>{eye(x.visible)}</button>
            <img className="lthumb" src={thumbs[j]} alt="" draggable={false} />
            {renaming === j ? (
              <input className="lname-edit" value={name} autoFocus onChange={(e) => setName(e.target.value)} onBlur={commit} onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setRenaming(null); }} />
            ) : (
              <span className="lname">{x.fill && <span className="fillmark" title="Fill layer: a PBR material">▤ </span>}{x.decal && <span className="decalmark" title="Decal layer: projected onto the model">◆ </span>}{x.decal?.mirror && <span className="mirrormark" title="Linked mirror: this is one half of a pair, and both follow an edit">⇄ </span>}{x.gen && <span className="genmark" title="Generator layer: made from the baked maps">◇ </span>}{x.name}</span>
            )}
            <span className="ltype num">{x.fill ? (x.fill.asset === SOLID ? 'Solid' : 'Fill') : x.decal ? (x.decal.shape ? 'Grip' : 'Decal') : x.bevel ? 'Bevel' : x.gen ? 'Gen' : x.opacity < 1 ? `${Math.round(x.opacity * 100)}%` : ''}
              {j === s.active && <Icon name="chevron" size={11} className={open ? 'chev' : 'chev closed'} />}</span>
          </li>
        ), ...(j === s.active && open ? [props] : [])]).reverse().flat()}
      </ul>
      <div className="lbar">
        <button title="Fill the active layer (or the selection) with the color (Alt+Backspace)" aria-label="Fill" onClick={() => fillPaintSelection()}>{ICON.bucket}</button>
        <button title="Solid fill: a layer of one colour, roughness and metallic (the options bar's, or the brush's) over the selection; it stays editable, so the colour can change later without repainting" aria-label="Solid fill layer" onClick={addSolidFill}>{ICON.solidFill}</button>
        <button title="Metal sheen: a new layer that makes the selection (say islands picked with Select Faces W, Island) shiny metal, Metallic 100% / Roughness 25%, colour untouched; its opacity sets how much" aria-label="Metal sheen layer" onClick={addMetalLayer}>{ICON.metal}</button>
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
      <label title="What it lays down">Color<ColorPick value={g.color} onChange={(c) => editGen({ color: c })} label="Generator color" /></label>
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

/** A bevel layer's settings: the band is a share of the model, so it reads the same on any part. */
function BevelSettings({ b }: { b: Bevel }) {
  const span = modelDiagonal();
  return (
    <div className="gensettings">
      <label title="How far the rounding reaches in from each edge, as a share of the model">Radius
        <input type="range" min={0.05} max={3} step={0.05} value={(b.radius / span) * 100} onPointerDown={beginPaintEdit} onChange={(e) => editBevel({ radius: (span * +e.target.value) / 100 }, false)} />
        <span className="num readout">{((b.radius / span) * 100).toFixed(2)}%</span>
      </label>
      <label title="Round: a fillet's normals, turning gradually; Chamfer: one flat cut at the halfway angle">Profile
        <span className="seg">
          <button className={b.profile === 'round' ? 'on' : ''} onClick={() => editBevel({ profile: 'round' })}>Round</button>
          <button className={b.profile === 'chamfer' ? 'on' : ''} onClick={() => editBevel({ profile: 'chamfer' })}>Chamfer</button>
        </span>
      </label>
      <label title="Only edges whose faces turn more than this are bevelled; raise it to leave soft curves alone">Angle
        <input type="range" min={5} max={120} step={1} value={b.angle} onPointerDown={beginPaintEdit} onChange={(e) => editBevel({ angle: +e.target.value }, false)} />
        <span className="num readout">{Math.round(b.angle)}°</span>
      </label>
      <label title="Round the inside corners as well (a fillet where two faces meet in a groove)">Concave
        <input type="checkbox" checked={b.concave} onChange={(e) => editBevel({ concave: e.target.checked })} />
      </label>
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
        <button disabled={!has} title="Round the part's sharp edges in the normal map, so a hard-edged low poly shades bevelled without the geometry (no bake needed)" onClick={addBevel}>Bevel</button>
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

const TABS = [['layers', 'Layers'], ['assets', 'Assets'], ['maps', 'Maps']] as const;
const ASSET_TABS = [['materials', 'Materials'], ['tiles', 'Tiles'], ['decals', 'Decals'], ['geometry', 'Geometry']] as const;

/** The texture sets as pictures of their parts (click one to paint it, unfold it for its channels), then the active
 *  set's layers, each one's settings folded under its row. */
function LayersTab() {
  const parts = useApp((s) => s.parts.length), active = useApp((s) => s.parts[s.activePart]?.name), link = useApp((s) => s.linkSets);
  return (
    <div className="vgtab layerspane">
      <details className="tsec-details setlist" open>
        <summary className="tsec"><span className="caps"><Icon name="chevron" size={11} className="chev" />Texture sets</span><span className="hint">{parts} parts</span></summary>
        <Parts workspace="paint" />
      </details>
      <div className="tsec">
        <span className="caps">Layers</span><span className="hint">{active}</span>
        <label className="allsets" title="New fills, solids and generators go on every visible part, and editing a layer edits the layer of the same name on each of them"><input type="checkbox" checked={link} onChange={(e) => setLinkSets(e.target.checked)} />All sets</label>
      </div>
      <Layers />
    </div>
  );
}

/** The materials held on the Eyedropper: a round chip of the top fill's preview (or its solid colour) follows the
 *  pointer, and the ring lights up while it is over a part, island or face a click would apply it to. */
function GrabCursor() {
  const grab = useApp((s) => s.paint.grab);
  const over = useApp((s) => !!s.paintHover);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!grab) return;
    const el = ref.current;
    // the click that picked the materials is still the last pointer position: show the chip there at once
    if (el) { el.style.transform = `translate(${pointer.x + 16}px, ${pointer.y + 16}px)`; el.style.visibility = 'visible'; }
    const move = (e: PointerEvent) => {
      const node = ref.current;
      if (!node) return;
      node.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 16}px)`;
      node.style.visibility = 'visible';
    };
    addEventListener('pointermove', move);
    const cursor = document.body.style.cursor;
    document.body.style.cursor = 'copy';
    return () => { removeEventListener('pointermove', move); document.body.style.cursor = cursor; };
  }, [grab]);
  if (!grab) return null;
  return (
    <div ref={ref} className={`grabcursor${over ? ' over' : ''}`} aria-hidden="true" style={grab.tint ? { background: grab.tint } : undefined}>
      {grab.thumb ? <img key={grab.thumb} src={grab.thumb} alt="" onError={(e) => { e.currentTarget.hidden = true; }} /> : grab.tint ? <i style={{ background: grab.tint }} /> : <i className="any" />}
      <span className="grabplus">+</span>
      {grab.count > 1 && <b>{grab.count}</b>}
    </div>
  );
}

export function VanGogh() {
  const tab = useApp((s) => s.paintTab), assetTab = useApp((s) => s.assetTab);
  useEffect(() => { loadDecals(); }, []);
  return (
    <>
      <aside className="dock paintdock">
        <div className="vgcolor" title="Paint color"><ColorWheel /></div>
        <div className="vgtabs" role="tablist" aria-label="Van Gogh panels">
          {TABS.map(([id, name]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setPaintTab(id)}>{name}</button>)}
        </div>
        <div className="vgbody">
          {tab === 'layers' && <LayersTab />}
          {tab === 'assets' && <>
            <div className="asset-tabs" role="tablist" aria-label="Asset shelves">
              {ASSET_TABS.map(([id, name]) => <button key={id} role="tab" aria-selected={assetTab === id} className={assetTab === id ? 'on' : ''} onClick={() => setAssetTab(id)}>{name}</button>)}
            </div>
            {assetTab === 'materials' && <div className="vgtab" key="materials"><Materials /></div>}
            {assetTab === 'tiles' && <div className="vgtab" key="tiles"><Materials tiles /></div>}
            {assetTab === 'decals' && <div className="vgtab"><Decals /></div>}
            {assetTab === 'geometry' && <div className="vgtab"><Geometry /></div>}
          </>}
          {tab === 'maps' && <div className="vgtab"><Bake /><TextureExport /></div>}
        </div>
      </aside>
      <GrabCursor />
    </>
  );
}
