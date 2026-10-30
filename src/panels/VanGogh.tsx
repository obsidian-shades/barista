// Van Gogh: paint textures straight onto the model, through the UVs UV Magician made, in the same frame as UV Magician
// (tool strip | 3D | texture | panel). Photoshop's way: a selection (Marquee, Lasso, Wand) that every paint tool
// (Brush, Eraser, Bucket) stays inside, on the model and in the texture view alike; the options bar holds the current
// tool's settings; the panel the parts (collapsible, with their channels: Substance's texture sets) and the active
// part's Layers, as Photoshop's panel lays them out.
import { useDeferredValue, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { CHANNELS, SOLID, blendOf, thumbOf, type BlendMode, type BrushTip, type Channel, type Bevel, type Decal, type Drive, type Fill, type Head, type Pattern, type Profile, type Shape, isLine, type Gen, type GenKind, type PaintLayer } from '../paint';
import { MATERIAL_GROUPS, TILE_KINDS, materialGroup, thumbUrl, tileKind } from '../materials';
import { ColorPick } from '../ui/ColorPick';
import { GRIP_SHAPES, RELIEF_SHAPES, decalUrl, reliefSphere, reliefThumb, type DecalAsset } from '../decals';
import { decalDragOver, decalDrop, shelfDragOver, shelfDrop } from '../views/Viewport3D';
import { targetInfo } from '../exporting';
import { Channels, Parts, eye } from './Dock';
import { ColorWheel } from './ColorWheel';
import { ToolStrip, type ToolDef } from '../shell/PolyTools';
import { SelectionControls } from '../shell/Chrome';
import { ico, Icon, ICON } from '../ui/Icon';
import {
  activeDecal, addBevel, editBevel, fitDecal, finishDraw, setGripPreset, shelfDrag, addGenerator, addSolidFill, alignDecal, centerDecal, duplicateDecal, setDecalMode, setLinkSets, addMetalLayer, addPaintLayer, assignMaterial, bakeAllPaint, bakePaint, beginPaintEdit, clearFillMask, deletePaintLayer, deletePickedLayers, duplicatePickedLayers, editGen, editPaintLayer, fillPaintSelection, importDecal, importMaterialFiles,
  invertFillMask, loadDecals, loadMaterials, modelDiagonal, movePaintLayerTo, openExport, pickDecal, pickPaintLayer, pickedLayers, pointer, setStackView, showPaintLayer, setAssetTab, setFillBlend, setFillMask, setLayerBlend, setPaint, setPaintAO, setPaintTab, setPbr, texSet, undoPaint, updateDecal, updateFill, useApp, type PaintTool,
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
    decal: { name: 'Decal', key: 'D', tip: 'Click a mark on the model to select it, drag it to slide it over the surface; its handles scale, stretch and turn it, and a click on bare surface deselects. Place writes the mark armed in Assets > Stickers or Geometry (or Alt+click)', run: () => setPaint({ tool: 'decal', decalMode: 'edit' }), on: () => true,
      icon: ico(['M4 3h12v8l-5 6H4z', 'f'], 'M4 3h12v8l-5 6H4z', ['M16 11h-3.8a1.2 1.2 0 0 0-1.2 1.2V17z', 'F'], ['M10 5.5l1.1 2.3 2.4.3-1.8 1.7.5 2.4-2.2-1.2-2.2 1.2.5-2.4-1.8-1.7 2.4-.3z', 'A']) },
    mirror: { name: 'Mirror', key: 'Ctrl+M', tip: 'Copy a mark to the other side of the model: click the mark, then hover where its mirror image should go — near the spot opposite it across X, Y or Z the outline snaps there (solid) — and click to place it. The copy is its own layer with the same settings', run: () => setPaint({ tool: 'mirror' }), on: () => true,
      icon: ico(['M10 2v16', 'd'], ['M8 4H3l2 6-2 6h5z', 'f'], 'M8 4H3l2 6-2 6h5z', ['M12 4h5l-2 6 2 6h-5z', 'a']) },
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

/** The sticker shelf (prints, stencils, engraves): choose a mark, then click the model. Marks are layers, so paint, masks and export behave alike. */
function Decals() {
  const list = useApp((s) => s.decals), loading = useApp((s) => s.decalsLoading), error = useApp((s) => s.decalsError);
  const armed = useApp((s) => s.paint.decalAsset);
  const [q, setQ] = useState(''), [cat, setCat] = useState('All'), input = useRef<HTMLInputElement>(null);
  useEffect(() => { loadDecals(); }, []);
  const imageDecals = useMemo(() => list.filter((d) => !d.shape && !d.relief), [list]);
  const cats = useMemo(() => ['All', ...Array.from(new Set(imageDecals.map((d) => d.category)))], [imageDecals]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return imageDecals.filter((d) => (cat === 'All' || d.category === cat) && (!needle || `${d.name} ${d.category} ${d.tags.join(' ')}`.toLowerCase().includes(needle)));
  }, [imageDecals, q, cat]);
  return (
    <div className="matshelf decalshelf">
      <div className="matsticky">
        <div className="matbar">
          <input className="matsearch" type="search" placeholder="Search stickers" value={q} onChange={(e) => setQ(e.target.value)} />
          <button title="Import a transparent PNG sticker from disk" onClick={() => input.current?.click()}>Import</button>
        </div>
        <div className="matchips">
          {cats.map((c) => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
        </div>
      </div>
      {error && <div className="hint fix">{error}</div>}
      {loading && !list.length && <div className="hint">Loading stickers…</div>}
      <div className="decalgrid">
        {shown.map((d) => (
          <button key={d.id} className={`decaltile${d.id === armed ? ' on' : ''}`} title={`${d.name} — ${d.category}${d.notes ? `\n${d.notes}` : ''}\n${d.width}×${d.height} · ${d.license}`} onPointerDown={(e) => holdTile(e, d.id, decalUrl(d), decalDragOver, decalDrop, false)} onClick={() => { if (!tileDragged) pickDecal(d.id); }}>
            <span className="decalimg"><DecalImg a={d} /></span>
            <span>{d.shape ? 'Grip texture' : d.name}</span>
          </button>
        ))}
      </div>
      {!loading && !shown.length && <div className="hint">No sticker matches.</div>}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importDecal(f); e.target.value = ''; }} />
    </div>
  );
}

/** Shape based grip reliefs and map based reliefs are geometry assets, kept separate from image decals. */
function Geometry() {
  const list = useApp((s) => s.decals), loading = useApp((s) => s.decalsLoading), error = useApp((s) => s.decalsError);
  const armed = useApp((s) => s.paint.decalAsset);
  const [q, setQ] = useState(''), [cat, setCat] = useState('All');
  useEffect(() => { loadDecals(); }, []);
  const shapes = useMemo(() => list.filter((d) => !!d.shape || !!d.relief), [list]);
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
      {!loading && !shapes.some((d) => d.relief) && <div className="hint">DECALmachine reliefs: run <code>node tools/dm-decals.mjs "&lt;addon&gt;\assets"</code> to import its decals' normal and height maps into this tab.</div>}
      <div className="decalgrid">
        {shown.map((d) => <button key={d.id} className={`decaltile relieftile${d.id === armed ? ' on' : ''}`} title={`${d.name}${d.notes ? `\n${d.notes}` : ''}`} onPointerDown={(e) => holdTile(e, d.id, decalUrl(d), decalDragOver, decalDrop, false)} onClick={() => { if (!tileDragged) pickDecal(d.id); }}>
          <span className="decalimg"><DecalImg a={d} /></span><span>{d.name}</span>
        </button>)}
      </div>
      {!loading && !shown.length && <div className="hint">No geometry matches.</div>}
    </div>
  );
}

/** One settings row on the panel's grid: name | control | value (no value: the control spans both). Every layer's
 *  settings are built from these, so labels, sliders and readouts line up from section to section. */
function Row({ label, tip, value, children }: { label: ReactNode; tip?: string; value?: ReactNode; children: ReactNode }) {
  return (
    <label className={`prow${value === undefined ? ' span' : ''}`} title={tip}>
      <span className="pname">{label}</span>
      {children}
      {value !== undefined && <span className="num readout">{value}</span>}
    </label>
  );
}
/** A titled group of rows. */
function Sec({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="psec">
      <div className="tsec"><span className="caps">{title}</span>{hint && <span className="hint">{hint}</span>}</div>
      {children}
    </section>
  );
}
/** A slider row: `fmt` shows the value. Dragging is one undo step (the first change takes it). */
function Slide({ label, tip, value, min, max, step, fmt, set, dim }: { label: ReactNode; tip: string; value: number; min: number; max: number; step: number; fmt: (v: number) => ReactNode; set: (v: number) => void; dim?: boolean }) {
  return (
    <Row label={label} tip={tip} value={fmt(value)}>
      <input type="range" className={dim ? 'dim' : undefined} min={min} max={max} step={step} value={value} onPointerDown={beginPaintEdit} onChange={(e) => set(+e.target.value)} />
    </Row>
  );
}
const pct = (v: number) => `${Math.round(v * 100)}%`;
/** One precision for every readout of a size or angle: two significant figures (18 · 4.2 · 0.55), never a trailing "18.". */
const sig = (v: number) => (Math.abs(v) >= 10 || Math.abs(v) < 5e-4 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));

/** A fill's mask: white / black / invert / clear, the brush paints it. */
function MaskSec() {
  return (
    <Sec title="Mask" hint="Brush shows it, Eraser hides it">
      <div className="pbtns four">
        <button title="Make the layer visible everywhere" onClick={() => setFillMask(255)}>White</button>
        <button title="Hide the layer everywhere, then paint it in with the Brush" onClick={() => setFillMask(0)}>Black</button>
        <button title="Swap what the mask hides and shows" onClick={invertFillMask}>Invert</button>
        <button title="Remove the mask (visible everywhere)" onClick={clearFillMask}>Clear</button>
      </div>
    </Sec>
  );
}

/** The active fill layer: its surface (colour, roughness, metallic, normal), projection, the channels it writes, mask. */
function FillSettings({ f }: { f: Fill }) {
  const solid = f.asset === SOLID;
  // roughness / metallic: the material's map, or one value for the whole finish (dragging the slider sets it; the
  // ↺ beside the name goes back to the map)
  const finish = (key: 'roughness' | 'metallic', name: string) => {
    const own = f[key] != null;
    return (
      <Slide key={key} tip={solid ? `${name} of the colour` : `${name}: the material's own map, or drag for one value over the whole fill`}
        label={<>{name}{own && !solid && <button className="reset" title="Back to the material's own map" onClick={(e) => { e.preventDefault(); updateFill({ [key]: undefined }); }}>↺</button>}</>}
        value={f[key] ?? (solid ? 0 : 0.5)} min={0} max={1} step={0.01} dim={!own && !solid} fmt={(v) => (own || solid ? pct(v) : 'Map')} set={(v) => updateFill({ [key]: v }, false)} />
    );
  };
  const writes = (ch: Channel) => (
    <button key={ch} className={f.channels.includes(ch) ? 'on' : ''} aria-pressed={f.channels.includes(ch)} title={`Write this material's ${CHANNELS[ch].name} map`}
      onClick={() => updateFill({ channels: f.channels.includes(ch) ? f.channels.filter((x) => x !== ch) : [...f.channels, ch] })}>{CHANNELS[ch].name}</button>
  );
  return (
    <div className="psettings">
      <Sec title="Surface">
        <Row label={solid ? 'Color' : 'Tint'} tip={solid ? "The fill's colour; change it any time, the layer stays a setting" : "Tint the material's base colour"}>
          <ColorPick value={f.tint} onStart={beginPaintEdit} onChange={(c) => updateFill({ tint: c }, false)} label="Fill tint" />
        </Row>
        {finish('roughness', 'Rough')}
        {finish('metallic', 'Metal')}
        {!solid && <Slide label="Normal" tip="How strongly the material's normal map bends the light" value={f.normalStrength} min={0} max={2} step={0.05} fmt={pct} set={(v) => updateFill({ normalStrength: v }, false)} />}
      </Sec>
      {!solid && <Sec title="Projection">
        <Row label="Mode" tip="UV repeats inside each island; Tri-planar projects in world space and has no seams on a packed atlas">
          <span className="seg">
            <button className={f.projection === 'uv' ? 'on' : ''} aria-pressed={f.projection === 'uv'} onClick={() => updateFill({ projection: 'uv' })}>UV</button>
            <button className={f.projection === 'triplanar' ? 'on' : ''} aria-pressed={f.projection === 'triplanar'} onClick={() => updateFill({ projection: 'triplanar' })}>Tri-planar</button>
          </span>
        </Row>
        {f.projection === 'uv'
          ? <Slide label="Tiling" tip="Repeats inside each UV island: higher = more repeats, a smaller pattern" value={f.tiling} min={0.25} max={8} step={0.25} fmt={(v) => `${v}×`} set={(v) => updateFill({ tiling: v }, false)} />
          : <Slide label="Tiles" tip="Repeats across the whole model: higher = more repeats, a smaller pattern" value={f.tiles} min={0.5} max={16} step={0.5} fmt={(v) => `${v}×`} set={(v) => updateFill({ tiles: v }, false)} />}
        <Slide label="Rotate" tip="Rotate the projection" value={f.rotation} min={-180} max={180} step={5} fmt={(v) => `${Math.round(v)}°`} set={(v) => updateFill({ rotation: v }, false)} />
        <Row label="Writes" tip="Which of the material's relief maps this layer lays down"><span className="seg">{writes('normal')}{writes('height')}</span></Row>
      </Sec>}
      <MaskSec />
    </div>
  );
}

/** A decal's tile picture: its image, a relief's lit ball, or an imported relief's ball once drawn from its maps. */
function DecalImg({ a }: { a: DecalAsset }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const src = a.relief ? reliefThumb(a, redraw) : decalUrl(a);
  return src ? <img src={src} alt="" draggable={false} /> : null;
}

/** A typed number for a decal's size or angle: Enter or blur commits, so typing an exact width moves the mark once. */
function Num({ value, min, max, step, suffix, onCommit }: { value: number; min: number; max: number; step: number; suffix: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState(sig(value));
  useEffect(() => setText(sig(value)), [value]);
  const commit = () => {
    const v = +text;
    if (!Number.isFinite(v)) { setText(sig(value)); return; }
    const c = Math.min(max, Math.max(min, v));
    if (Math.abs(c - value) > 1e-6) onCommit(c); else setText(sig(value));
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
        <span className="decalimg">{a && <DecalImg a={a} />}</span>
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
      <span className="pbtns decalactions">
        <button onClick={centerDecal} title="Middle of the model across the face the mark lies on">Center</button>
        <button onClick={alignDecal} title="Turn the projector onto the surface under the mark">Face</button>
        <button onClick={duplicateDecal} title="Copy the mark just above it, nudged so both are visible (Ctrl+J)">Duplicate</button>
        <button onClick={deletePaintLayer} title="Delete the mark and its layer (Delete with the Decal tool)">Delete</button>
      </span>
      {d.shape ? <><ShapeSettings d={d} span={span} /><ShapeFinish d={d} /></> : a?.relief ? <ReliefMapsSettings d={d} /> : <InkSettings d={d} />}
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
/** Each relief's sliders, as shares of the model: [field, label, tip, min, max]. A pad's height goes negative for an
 *  indent; the fastener's size is the mark's own Width. */
type ShapeKey = 'cell' | 'amount' | 'border' | 'depth' | 'corner';
const RELIEF_SLIDERS: Record<string, [ShapeKey, string, string, number, number][]> = {
  groove: [['border', 'Width', 'How wide the groove is', 0.02, 2], ['depth', 'Depth', 'How deep it cuts', 0, 1]],
  bead: [['border', 'Width', 'How wide the weld is', 0.05, 3], ['depth', 'Height', 'How high it stands', 0, 1], ['amount', 'Ripple', 'How strong the ripples are', 0, 0.5], ['cell', 'Ripple spacing', 'Distance between ripples', 0.02, 1.5]],
  stitch: [['border', 'Width', 'How wide the stitched row is', 0.05, 2], ['cell', 'Stitch length', 'Distance from one stitch to the next', 0.05, 3], ['depth', 'Thread', 'How proud the thread stands', 0, 0.5], ['amount', 'Channel', 'How deep the channel under it is cut', 0, 0.5]],
  rivets: [['border', 'Head size', 'Diameter of each head', 0.1, 5], ['cell', 'Spacing', 'Distance between heads along the line', 0.1, 10], ['depth', 'Head height', 'How high each head stands', 0, 1.5], ['amount', 'Drive depth', 'How deep the drive is cut', 0, 1.5]],
  scratch: [['border', 'Width', 'How wide the scratch is', 0.02, 1], ['depth', 'Depth', 'How deep it cuts', 0, 0.5], ['amount', 'Breakup', 'How much its depth wanders along it (past Depth, it breaks)', 0, 0.5], ['cell', 'Breakup length', 'How often the depth changes along it', 0.05, 3]],
  pad: [['amount', 'Height', 'How far the panel stands up; below 0 it is pressed in', -1, 1], ['border', 'Edge', 'How wide its edge is', 0, 2], ['corner', 'Corner', "Radius of the outline's corners", 0, 10]],
  fastener: [['depth', 'Head height', 'How high the head stands', 0, 1.5], ['amount', 'Drive depth', 'How deep the drive is cut', 0, 1.5]],
};
const PROFILES: [Profile, string][] = [['round', 'Round'], ['v', 'V'], ['square', 'Square'], ['chamfer', 'Chamfer']];
const HEADS: [Head, string][] = [['dome', 'Dome / rivet'], ['pan', 'Pan'], ['flat', 'Countersunk'], ['cap', 'Socket cap'], ['hexhead', 'Hex bolt']];
const DRIVES: [Drive, string][] = [['none', 'None'], ['slot', 'Slot'], ['phillips', 'Phillips'], ['pozi', 'Pozidriv'], ['torx', 'Torx'], ['hex', 'Hex socket'], ['square', 'Square']];
/** The active relief on the lit sphere, redrawn as its settings change (deferred, so a slider drag stays smooth). */
function ReliefPreview({ d }: { d: Decal }) {
  const key = useDeferredValue(JSON.stringify([d.shape, d.width, d.aspect]));
  const url = useMemo(() => {
    const [sh, w, asp] = JSON.parse(key) as [Shape, number, number];
    return reliefSphere(sh, w / 2, w / 2 / asp, 144, sh.pattern === 'fastener' ? 0.75 : 0.95);
  }, [key]);
  return <div className="relief-preview" title="Its relief on a lit ball (a grip as its texture, a relief as the mark): what its Normal and Height will read as"><img src={url} alt="" width={144} height={144} /></div>;
}
function ReliefSettings({ d, span }: { d: Decal; span: number }) {
  const sh = d.shape!, rows = RELIEF_SLIDERS[sh.pattern] ?? [], line = isLine(sh.pattern);
  const set = (p: Partial<Shape>) => updateDecal({ shape: { ...sh, ...p } });
  const pick = <T extends string>(label: string, tip: string, value: T, opts: [T, string][], key: keyof Shape) => (
    <label title={tip}>{label}
      <select value={value} onChange={(e) => set({ [key]: e.target.value })}>{opts.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
    </label>
  );
  return (
    <>
      <ReliefPreview d={d} />
      {line && <div className="grip-patterns" role="group" aria-label="Line kind" title="What runs along the line; its path stays as drawn">
        {RELIEF_SHAPES.filter((g) => g.category === 'Lines').map((g) => <button key={g.id} className={sh.pattern === g.shape!.pattern ? 'on' : ''} aria-pressed={sh.pattern === g.shape!.pattern} title={g.notes} onClick={() => setGripPreset(g.id)}>{g.name}</button>)}
      </div>}
      {(sh.pattern === 'groove' || sh.pattern === 'pad') && pick(sh.pattern === 'pad' ? 'Edge' : 'Profile', 'The cross-section', sh.profile ?? 'round', PROFILES, 'profile')}
      {(sh.pattern === 'fastener' || sh.pattern === 'rivets') && <>
        {pick('Head', 'The head', sh.head ?? 'dome', HEADS, 'head')}
        {pick('Drive', 'What is cut into the head', sh.drive ?? 'none', DRIVES, 'drive')}
        <label title="A flat washer under the head"><input type="checkbox" checked={!!sh.washer} onChange={(e) => set({ washer: e.target.checked })} />Washer</label>
      </>}
      {rows.map(([key, name, tip, min, max]) => (
        <label key={key} title={tip}>{name}
          <input type="range" min={min} max={max} step={0.01} value={(sh[key] / span) * 100} onPointerDown={beginPaintEdit}
            onChange={(e) => updateDecal({ shape: { ...sh, [key]: key === 'cell' ? Math.max(1e-4, (span * +e.target.value) / 100) : (span * +e.target.value) / 100 } }, false)} />
          <span className="num readout">{sig((sh[key] / span) * 100)}%</span>
        </label>
      ))}
      {line && <label title="Join the line's last point back to its first"><input type="checkbox" checked={!!sh.closed} onChange={(e) => set({ closed: e.target.checked })} />Closed</label>}
      {line && sh.closed && <label title="Round the closed line's corners">Corner
        <input type="range" min={0} max={5} step={0.01} value={(sh.corner / span) * 100} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ shape: { ...sh, corner: (span * +e.target.value) / 100 } }, false)} />
        <span className="num readout">{sig((sh.corner / span) * 100)}%</span>
      </label>}
      {!line && <label title="Bend round the model: the relief follows the surface over bevels and curves instead of projecting flat">Wrap
        <input type="checkbox" checked={!!d.wrap} onChange={(e) => updateDecal({ wrap: e.target.checked })} />
      </label>}
    </>
  );
}
/** What a grip pattern's cell is, for its slider: [label, tip]. */
const CELL_OF: Partial<Record<Pattern, [string, string]>> = {
  grooves: ['Rib spacing', 'Distance between parallel ribs'], stipple: ['Dot size', 'Size of each raised dot'],
  checker: ['Diamond size', 'Size of each checkered diamond'], pyramid: ['Nub pitch', 'Distance from one nub to the next'],
};
function ShapeSettings({ d, span }: { d: Decal; span: number }) {
  const sh = d.shape!;
  if (RELIEF_SHAPES.some((g) => g.shape!.pattern === sh.pattern)) return <ReliefSettings d={d} span={span} />;
  return (
    <>
      <ReliefPreview d={d} />
      <div className="grip-presets" role="group" aria-label="Grip texture presets" title="Choose a starting look; you can adjust its settings below">
        {GRIP_SHAPES.map((g) => <button key={g.id} className={`grip-preset${sh.pattern === g.shape?.pattern ? ' on' : ''}`} aria-pressed={sh.pattern === g.shape?.pattern} title={`${g.name}: ${g.notes ?? ''}`} onClick={() => setGripPreset(g.id)}>
          <span className="decalimg"><img src={decalUrl(g)} alt="" /></span><span>{g.name}</span>
        </button>)}
      </div>
      <span className="pbtns decalactions">
        <button onClick={() => fitDecal('faces')} title="Cover the faces picked with Select Faces (W) with the pattern, wrapped round them and stopping at their edges">Fit to faces</button>
        <button onClick={() => fitDecal('part')} title="Cover the whole part with the pattern, wrapped round it">Fit to part</button>
      </span>
      {sh.pattern !== 'none' && <label title={CELL_OF[sh.pattern]?.[1]}>
        {CELL_OF[sh.pattern]?.[0] ?? 'Size'}
        <input type="range" min={0} max={3} step={0.02} value={(sh.cell / span) * 100} onPointerDown={beginPaintEdit}
          onChange={(e) => updateDecal({ shape: { ...sh, cell: Math.max(1e-4, (span * +e.target.value) / 100) } }, false)} />
        <span className="num readout">{sig((sh.cell / span) * 100)}%</span>
      </label>}
      <details className="tsec-details grip-advanced">
        <summary className="tsec"><span className="caps"><Icon name="chevron" size={11} className="chev" />Fine tune</span><span className="hint">pattern, border, wrap</span></summary>
        <div className="grip-advanced-body">
          <div className="grip-patterns" role="group" aria-label="Pattern">
            {([['stipple', 'Dots'], ['pyramid', 'Nubs'], ['grooves', 'Ribs'], ['checker', 'Crosshatch'], ['none', 'Border only']] as [Pattern, string][]).map(([pattern, label]) =>
              <button key={pattern} className={sh.pattern === pattern ? 'on' : ''} aria-pressed={sh.pattern === pattern} onClick={() => updateDecal({ shape: { ...sh, pattern } })}>{label}</button>)}
          </div>
          {SHAPE_SLIDERS.map(([key, name, tip, max]) => (
            <label key={key} title={tip}>{name}
              <input type="range" min={0} max={max} step={0.02} value={(sh[key] / span) * 100} onPointerDown={beginPaintEdit}
                onChange={(e) => updateDecal({ shape: { ...sh, [key]: Math.max(key === 'cell' ? 1e-4 : 0, (span * +e.target.value) / 100) } }, false)} />
              <span className="num readout">{sig((sh[key] / span) * 100)}%</span>
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

/** Material finishes a panel or its border can take: [name, roughness, metallic]. */
const FINISHES: [string, number, number][] = [['Rubber', 0.85, 0], ['Polymer', 0.6, 0], ['Cerakote', 0.45, 0], ['Anodized', 0.35, 1], ['Bare metal', 0.2, 1]];
type Finish = { tint: string; roughness: number; metallic: number };
/** One finish row: colour, a material preset, roughness and metallic. */
function FinishRow({ label, tip, f, set }: { label: string; tip: string; f: Finish; set: (p: Partial<Finish>, undoable?: boolean) => void }) {
  const preset = FINISHES.find(([, r, m]) => Math.abs(r - f.roughness) < 0.005 && m === f.metallic)?.[0] ?? '';
  return (
    <>
      <label title={tip}>{label}
        <ColorPick value={f.tint} onStart={beginPaintEdit} onChange={(c) => set({ tint: c }, false)} label={`${label} colour`} />
        <select value={preset} title="Material: sets roughness and metallic" onChange={(e) => { const p = FINISHES.find(([n]) => n === e.target.value); if (p) set({ roughness: p[1], metallic: p[2] }); }}>
          <option value="" disabled>Custom</option>
          {FINISHES.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label title="Roughness">Rough
        <input type="range" min={0} max={1} step={0.01} value={f.roughness} onPointerDown={beginPaintEdit} onChange={(e) => set({ roughness: +e.target.value }, false)} />
        <span className="num readout">{Math.round(f.roughness * 100)}%</span>
      </label>
      <label title="Metallic">Metal
        <input type="range" min={0} max={1} step={0.01} value={f.metallic} onPointerDown={beginPaintEdit} onChange={(e) => set({ metallic: +e.target.value }, false)} />
        <span className="num readout">{Math.round(f.metallic * 100)}%</span>
      </label>
    </>
  );
}
/** A grip or relief's own colour and material: the panel inside, and its border band separately. */
function ShapeFinish({ d }: { d: Decal }) {
  const sh = d.shape!, on = d.channels.includes('color');
  const hasRim = !isLine(sh.pattern) && sh.pattern !== 'fastener' && sh.border > 0;
  return (
    <>
      <label title="Paint the mark's own colour and material over what is under it, not only its relief">Colour
        <input type="checkbox" checked={on} onChange={(e) => updateDecal({ channels: e.target.checked ? ['normal', 'height', 'color', 'rough', 'metal'] : ['normal', 'height'] })} />
      </label>
      {on && <FinishRow label={hasRim ? 'Panel' : 'Fill'} tip="Colour and material of the mark" f={d} set={(p, u = true) => updateDecal(p, u)} />}
      {on && hasRim && <>
        <label title="Give the border its own colour and material (off: the same as the panel)">Own border
          <input type="checkbox" checked={!!d.rim} onChange={(e) => updateDecal({ rim: e.target.checked ? { tint: d.tint, roughness: d.roughness, metallic: d.metallic } : undefined })} />
        </label>
        {d.rim && <FinishRow label="Border" tip="Colour and material of the border band" f={d.rim} set={(p, u = true) => updateDecal({ rim: { ...d.rim!, ...p } }, u)} />}
      </>}
    </>
  );
}

/** A relief decal's own maps (DECALmachine's): how hard its normal map reads and how deep its height map is. It lays
 *  down no ink, so the surface's material shows through and only the detail is added. */
function ReliefMapsSettings({ d }: { d: Decal }) {
  const n = d.reliefNormal ?? 1, h = d.reliefHeight ?? 1;
  const slide = (label: string, tip: string, v: number, key: 'reliefNormal' | 'reliefHeight') =>
    <label title={tip}>{label}
      <input type="range" min={0} max={2} step={0.05} value={v} onPointerDown={beginPaintEdit} onChange={(e) => updateDecal({ [key]: +e.target.value }, false)} />
      <span className="num readout">{sig(v)}×</span>
    </label>;
  return (
    <>
      <p className="hint">Relief maps: the mark's own normal and height, projected onto the surface. No ink, so the material under it stays.</p>
      {slide('Normal', 'How strongly the normal map tilts the surface (0: flat, 1: as authored)', n, 'reliefNormal')}
      {slide('Height', 'Contrast of the height map (0: flat, 1: as authored)', h, 'reliefHeight')}
    </>
  );
}

/** An image decal's ink: tint, roughness, metallic and engraving. */
function InkSettings({ d }: { d: Decal }) {  return (
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
  const p = useApp((s) => s.paint), channels = useChannels(), t = ALL[p.tool], drawing = useApp((s) => !!s.drawLine);
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
          <button className={p.decalMode === 'draw' ? 'on' : ''} onClick={() => setDecalMode('draw')} title="Lay the armed line (Geometry › Lines) as a polyline: click corners on the model, drag for freehand, click the first point to close, Enter or double-click to finish. With a pad or grip panel armed, draw its outline">Draw</button>
        </span>
        {p.decalMode === 'draw' ? <>
          <span className="decalhint" title="Click corners on the model, drag for freehand, click the first point to close. Enter or double-click finishes, Backspace takes back a corner, Esc drops the line">click corners · first point closes · Enter finishes</span>
          {drawing && <><button onClick={() => finishDraw()} title="Finish the line open (Enter)">Finish</button><button onClick={() => finishDraw(true)} title="Join it back to its first point">Close</button></>}
        </> : <span className="decalhint" title="The whole manipulator is on the mark: the middle disc slides it, corners scale it, the side bars stretch one axis, the knob turns it">drag to slide · corners scale · bars stretch · knob turns · Shift snaps</span>}
      </>}
      {p.tool === 'decal' && decal && <>
        <button onClick={centerDecal} title="Put the mark on the model's middle across the face it lies on — a gun's flanks, a scope's bore (Shift while dragging catches it there too)">Center</button>
        <button onClick={alignDecal} title="Turn the projector onto the surface under the mark, after a drag left it leaning">Face</button>
        <DecalTurns d={decal} />
      </>}
      {p.tool === 'mirror' && <span className="decalhint">{decal ? 'hover the other side: the outline snaps solid on the mirrored spot · click to place a copy' : 'click a mark to mirror'}</span>}
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
  useApp((s) => s.layerPick);
  const [drag, setDrag] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null), [name, setName] = useState('');
  const [open, setOpen] = useState(true);
  const s = part < 0 ? null : texSet(part);
  const thumbs = useMemo(() => (s ? s.layers.map((l) => thumbOf(s, l)) : []), [s, rev]);
  if (!s) return null;
  const l = s.layers[s.active], picked = pickedLayers(s);
  // Substance's layer stack has one blend per channel, and the stack follows the channel being viewed: so does this.
  const ch: Channel = shown === 'rough' || shown === 'metal' || shown === 'normal' || shown === 'height' ? shown : 'color';
  const mode = blendOf(l, ch);
  const commit = () => { if (renaming !== null && name.trim()) editPaintLayer(renaming, { name: name.trim() }); setRenaming(null); };
  // The material stack (top first), then the decals in their own section: they always paint over the stack
  // (paint.ts `decalsLast` keeps them at its top), so they are listed apart instead of folded in among the fills.
  const order = s.layers.map((_, j) => j).reverse(), stack = order.filter((j) => !s.layers[j].decal), marks = order.filter((j) => s.layers[j].decal);
  const kind = (x: PaintLayer) => (x.fill ? (x.fill.asset === SOLID ? 'Solid' : 'Fill') : x.decal ? (x.decal.shape ? (RELIEF_SHAPES.some((g) => g.shape!.pattern === x.decal!.shape!.pattern) ? 'Relief' : 'Grip') : x.decal.reliefNormal != null ? 'Relief' : 'Decal') : x.bevel ? 'Bevel' : x.gen ? 'Generator' : 'Paint');
  const row = (j: number) => {
    const x = s.layers[j], same = drag !== null && !s.layers[drag].decal === !x.decal;
    return [
      <li key={x.id} className={`layer${j === s.active ? ' on' : picked.includes(j) ? ' picked' : ''}${same && drag !== j ? ' droppable' : ''}`} draggable
        onDragStart={() => setDrag(j)} onDragEnd={() => setDrag(null)} onDragOver={(e) => { if (same) e.preventDefault(); }}
        onDrop={() => { if (drag !== null && same) movePaintLayerTo(drag, j); setDrag(null); }}
        onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) pickPaintLayer(j, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }); else if (j === s.active && picked.length < 2) setOpen(!open); else { pickPaintLayer(j); setOpen(true); } }} onDoubleClick={() => { setRenaming(j); setName(x.name); }}>
        <button aria-pressed={x.visible} title={x.visible ? 'Hide layer' : 'Show layer'} onClick={(e) => { e.stopPropagation(); showPaintLayer(j, !x.visible); }}>{eye(x.visible)}</button>
        <img className="lthumb" src={thumbs[j]} alt="" draggable={false} />
        {renaming === j ? (
          <input className="lname-edit" value={name} autoFocus onChange={(e) => setName(e.target.value)} onBlur={commit} onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setRenaming(null); }} />
        ) : <span className="lname">{x.name}</span>}
        <span className="ltype">{x.opacity < 1 && <span className="num">{Math.round(x.opacity * 100)}%</span>}<span className={`lkind k-${kind(x).toLowerCase()}`}>{kind(x)}</span>
          {j === s.active && <Icon name="chevron" size={11} className={open ? 'chev' : 'chev closed'} />}</span>
      </li>,
      ...(j === s.active && open ? [props] : []),
    ];
  };
  // the selected layer's settings unfold under its row (a click on it again folds them)
  const props = (
    <li key="props" className="lprops">
      <div className="psettings">
        <Sec title="Layer" hint={ch === 'normal' ? 'Normal: always combined' : `blend for ${CHANNELS[ch].name}`}>
          <Slide label="Opacity" tip="The layer's opacity" value={l.opacity} min={0} max={1} step={0.01} fmt={pct} set={(v) => editPaintLayer(s.active, { opacity: v }, false)} />
          <Row label="Blend" tip={ch === 'normal'
            ? 'Normals always combine with what is below (the whiteout blend): a plain mix would flatten the detail'
            : `How this layer's ${CHANNELS[ch].name} meets the layers below. Each channel keeps its own blend (Substance Painter's stack); pick another channel under Channels to set its blend.`}>
            <select value={ch === 'normal' ? 'normal' : mode} disabled={ch === 'normal'} onChange={(e) => setLayerBlend(ch, e.target.value as BlendMode)}>
              <option value="normal">{ch === 'height' ? 'Replace' : 'Normal'}</option>
              <option value="multiply">Multiply</option>
              <option value="screen">Screen</option>
              <option value="overlay">Overlay</option>
              <option value="add">{ch === 'height' ? 'Add (Linear Dodge)' : 'Add'}</option>
            </select>
          </Row>
        </Sec>
      </div>
      {l.fill && <FillSettings f={l.fill} />}
      {l.decal && <DecalSettings d={l.decal} />}
      {l.gen && <GenSettings g={l.gen} />}
      {l.bevel && <BevelSettings b={l.bevel} />}
    </li>
  );
  return (
    <div className="pslayers">
      <ul className="layers doc thumbs" aria-label="Layers (Ctrl / Shift+click picks several, drag to reorder, double-click to rename, click the selected one to fold its settings)">
        {stack.map(row)}
        {marks.length > 0 && <li className="lsec" aria-hidden="true"><span className="caps">Decals</span><span className="hint">{marks.length} · always on top</span></li>}
        {marks.map(row)}
      </ul>
      <div className="lbar">
        <button title="Fill the active layer (or the selection) with the color (Alt+Backspace)" aria-label="Fill" onClick={() => fillPaintSelection()}>{ICON.bucket}</button>
        <button title="Solid fill: a layer of one colour, roughness and metallic (the options bar's, or the brush's) over the selection; it stays editable, so the colour can change later without repainting" aria-label="Solid fill layer" onClick={addSolidFill}>{ICON.solidFill}</button>
        <button title="Metal sheen: a new layer that makes the selection (say islands picked with Select Faces W, Island) shiny metal, Metallic 100% / Roughness 25%, colour untouched; its opacity sets how much" aria-label="Metal sheen layer" onClick={addMetalLayer}>{ICON.metal}</button>
        <button title={picked.length > 1 ? `Duplicate the ${picked.length} picked layers (Ctrl+J)` : 'Duplicate the layer (Ctrl+J)'} aria-label="Duplicate layer" onClick={duplicatePickedLayers}><Icon name="duplicate" size={16} /></button>
        <button title="New layer (Ctrl+Shift+N)" aria-label="New layer" onClick={addPaintLayer}><Icon name="plus" size={16} /></button>
        <button title={picked.length > 1 ? `Delete the ${picked.length} picked layers` : 'Delete the layer'} aria-label="Delete layer" disabled={s.layers.length < 2} onClick={deletePickedLayers}><Icon name="trash" size={16} /></button>
      </div>
    </div>
  );
}

/** A generator layer's settings: dragging a slider makes the layer again live (one undo step a drag). */
function GenSettings({ g }: { g: Gen }) {
  const channels = useApp((s) => (s.paintRev, s.parts[s.activePart] ? texSet(s.activePart).channels : []));
  const share = (v: number) => `${sig(v * 100)}%`;
  return (
    <div className="psettings">
      <Sec title="Surface" hint="what it lays down">
        <Row label="Color" tip="What it lays down"><ColorPick value={g.color} onChange={(c) => editGen({ color: c })} label="Generator color" /></Row>
        {channels.includes('rough') && <Slide label="Rough" tip="Its roughness" value={g.rough} min={0} max={1} step={0.01} fmt={pct} set={(v) => editGen({ rough: v }, false)} />}
        {channels.includes('metal') && <Slide label="Metal" tip="Its metallic" value={g.metal} min={0} max={1} step={0.01} fmt={pct} set={(v) => editGen({ metal: v }, false)} />}
      </Sec>
      <Sec title="Coverage" hint="from the baked maps">
        <Slide label="Amount" tip="How much of the surface it covers" value={g.amount} min={0} max={1} step={0.01} fmt={pct} set={(v) => editGen({ amount: v }, false)} />
        <Slide label="Softness" tip="How gradually its border fades" value={g.soft} min={0} max={1} step={0.01} fmt={pct} set={(v) => editGen({ soft: v }, false)} />
        {g.kind !== 'ao' && <Slide label="Width" tip="How far from the edge it reaches, as a share of the model" value={g.width} min={0} max={0.04} step={0.0004} fmt={share} set={(v) => editGen({ width: v }, false)} />}
        <Slide label="Grunge" tip="How much noise breaks it up" value={g.grunge} min={0} max={1} step={0.01} fmt={pct} set={(v) => editGen({ grunge: v }, false)} />
        {g.grunge > 0 && <Slide label="Scale" tip="The noise's size, as a share of the model" value={g.scale} min={0} max={0.2} step={0.002} fmt={share} set={(v) => editGen({ scale: v }, false)} />}
      </Sec>
      <MaskSec />
    </div>
  );
}

/** A bevel layer's settings: the band is a share of the model, so it reads the same on any part. */
function BevelSettings({ b }: { b: Bevel }) {
  const span = modelDiagonal();
  return (
    <div className="psettings">
      <Sec title="Bevel" hint="in the normal map">
        <Slide label="Radius" tip="How far the rounding reaches in from each edge, as a share of the model" value={(b.radius / span) * 100} min={0.05} max={3} step={0.05} fmt={(v) => `${sig(v)}%`} set={(v) => editBevel({ radius: (span * v) / 100 }, false)} />
        <Row label="Profile" tip="Round: a fillet's normals, turning gradually; Chamfer: one flat cut at the halfway angle">
          <span className="seg">
            <button className={b.profile === 'round' ? 'on' : ''} aria-pressed={b.profile === 'round'} onClick={() => editBevel({ profile: 'round' })}>Round</button>
            <button className={b.profile === 'chamfer' ? 'on' : ''} aria-pressed={b.profile === 'chamfer'} onClick={() => editBevel({ profile: 'chamfer' })}>Chamfer</button>
          </span>
        </Row>
        <Slide label="Angle" tip="Only edges whose faces turn more than this are bevelled; raise it to leave soft curves alone" value={b.angle} min={5} max={120} step={1} fmt={(v) => `${Math.round(v)}°`} set={(v) => editBevel({ angle: v }, false)} />
        <Row label="Concave" tip="Round the inside corners as well (a fillet where two faces meet in a groove)">
          <span className="pcheck"><input type="checkbox" checked={b.concave} onChange={(e) => editBevel({ concave: e.target.checked })} />Inside corners too</span>
        </Row>
      </Sec>
      <MaskSec />
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

// the first tab is the texture sets (parts) and their stack; 'Layers' is the stack's own toggle inside it
const TABS = [['layers', 'Texture sets'], ['assets', 'Assets'], ['maps', 'Maps']] as const;
const ASSET_TABS = [['materials', 'Materials'], ['tiles', 'Tiles'], ['decals', 'Stickers'], ['geometry', 'Geometry']] as const;

/** The texture sets as pictures of their parts (click one to paint it, unfold it for its channels), then the active
 *  set's layers, each one's settings folded under its row. */
function LayersTab() {
  const active = useApp((s) => s.parts[s.activePart]?.name), link = useApp((s) => s.linkSets), view = useApp((s) => s.stackView);
  return (
    <div className="layerspane">
      <div className="vgparts" aria-label="Texture sets"><Parts workspace="paint" /></div>
      <div className="vgstack">
        <div className="asset-tabs" role="tablist" aria-label="Layers or channels">
          {STACK_VIEWS.map(([id, label]) => <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'on' : ''} onClick={() => setStackView(id)}>{label}</button>)}
        </div>
        {view === 'layers' ? (
          <div className="vgtab stackpane">
            <div className="tsec">
              <span className="hint">{active}</span>
              <label className="allsets" title="New fills, solids and generators go on every visible part, and editing a layer edits the layer of the same name on each of them"><input type="checkbox" checked={link} onChange={(e) => setLinkSets(e.target.checked)} />All sets</label>
            </div>
            <Layers />
          </div>
        ) : <div className="vgtab"><Channels /></div>}
      </div>
    </div>
  );
}
const STACK_VIEWS = [['layers', 'Layers'], ['channels', 'Channels']] as const;

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
