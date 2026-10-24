// Poly Doc's tool strip and options bar, laid out like Photoshop (and espresso-level-designer's shell): one icon per
// tool down the left, the tool you last used named in the bar on top with its settings and what it just did. A click
// runs the tool on the selection; it's off (dimmed) until the selection fits, and its tooltip says what it needs.
// Spectrum has no mesh-editing icons, so these are line glyphs in its stroke weight, on the same 20×20 grid as the
// filled chrome icons (`ui/Icon`).
import type { ReactNode } from 'react';
import { polygonsOf, topoOf } from '../topo';
import { healthReport, RULES, type RuleId } from '../health';
import { ownPolygons } from '../polyedit';
import { ViewControls } from './Chrome';
import { glyph, Icon } from '../ui/Icon';
import {
  addLoopsSel, collapseShortestSel, connectSel, dissolveSel, gridFillSel, limitedDissolveSel, liveSel, loopCutSel, mergeIntoNeighbourSel, mergePolySel, openMenu, pointer,
  relaxAroundSel, relaxPolySel, rotateEdgeSel, selectElems, selectLinked, selectPolygons, selectRule, selectionCount, setDocOpt, setSelectMode, shapeLoopSel, slideSel,
  setMoveOnSurface, setSlideBorders, startDocMove, subdivideSel, triangulateSel, trisToQuadsSel, useApp, type DocTool, type MenuItem,
} from '../store';

/** What's selected, counted as Blender counts it: polygons, edges you can see, vertices (as "f,e,v"). */
function countKey(s: ReturnType<typeof useApp.getState>) {
  const c = liveSel(s), out = c && s.result?.parts[c.part];
  if (!c || !out) return '0,0,0';
  const pid = polygonsOf(out.source, s.parts[c.part]?.poly), t = topoOf(c.of), faceMode = s.selectMode === 'face' || s.selectMode === 'island';
  const shown = faceMode ? [] : [...c.edges].filter((e) => { const [a, b] = t.edgeTris[e]; return b === undefined || pid[a] < 0 || pid[a] !== pid[b]; });
  return `${faceMode ? new Set([...c.faces].map((f) => (pid[f] < 0 ? -1 - f : pid[f]))).size : 0},${shown.length},${s.selectMode === 'vert' || faceMode ? c.verts.size : 0}`;
}
const counts = (key: string) => key.split(',').map(Number) as [number, number, number];
function useCounts() { return counts(useApp(countKey)); }

/** The fixes worth trying for each Health rule, best first (each the usual cure for what the rule flags). */
const CURES: Partial<Record<RuleId, [string, () => unknown][]>> = {
  triMin: [['Merge into Neighbour', mergeIntoNeighbourSel], ['Collapse Shortest Edge', collapseShortestSel]],
  triMax: [['Merge into Neighbour', mergeIntoNeighbourSel], ['Collapse Shortest Edge', collapseShortestSel]],
  zero: [['Collapse Shortest Edge', collapseShortestSel], ['Merge into Neighbour', mergeIntoNeighbourSel]],
  quadWarp: [['Triangulate (fix the diagonal)', triangulateSel], ['Relax Around', relaxAroundSel]],
  ngonBent: [['Triangulate (fix the diagonals)', triangulateSel], ['Grid Fill', gridFillSel]],
  quadSkew: [['Relax Around', relaxAroundSel], ['Triangulate', triangulateSel]],
  quadTaper: [['Relax Around', relaxAroundSel], ['Triangulate', triangulateSel]],
  quadJacobian: [['Triangulate', triangulateSel], ['Relax Around', relaxAroundSel]],
  faceted: [['Add Loops on Curve', addLoopsSel], ['Relax Around', relaxAroundSel]],
  outline: [['Triangulate', triangulateSel]],
};

/** Poly Doc's right-click menu: what's wrong with the face under the mouse (Health's rules, with why and the limit),
 *  the fixes for that, then every tool that can run on the selection and a few ways to select. Right-clicking a face
 *  that isn't selected selects it first, so the menu is about what you clicked. */
export function polyContextMenu() {
  let s = useApp.getState();
  const c0 = liveSel(s), hovering = pointer.part >= 0 && pointer.tri >= 0;
  if (hovering && (!c0 || ((s.selectMode === 'face' || s.selectMode === 'island') && !(c0.part === pointer.part && c0.faces.has(pointer.tri))))) {
    if (s.selectMode !== 'face') setSelectMode('face');
    selectElems(pointer.part, [pointer.tri]);
    s = useApp.getState();
  }
  const c = liveSel(s), partIx = c?.part ?? s.activePart, part = s.parts[partIx], out = s.result?.parts[partIx];
  if (!part || !out) return;
  const g = { soup: part.soup, ...(part.poly && part.sides ? { poly: part.poly, sides: part.sides } : ownPolygons(part.soup.length / 9)) };
  const tri = hovering && pointer.part === partIx ? pointer.tri : c && c.faces.size ? [...c.faces][0] : -1;
  const p = tri >= 0 ? g.poly[out.source[tri]] : -1, sides = p >= 0 ? g.sides[p] : 0;
  const issues = p >= 0 ? [...(healthReport(g).issues.get(p) ?? [])].sort((a, b) => b.score - a.score).filter((i, k, all) => all.findIndex((j) => j.rule === i.rule) === k) : [];
  const kc = counts(countKey(s)), items: MenuItem[] = [];
  const head = (label: string) => items.push({ label, run: () => {}, kind: 'head' });
  if (p >= 0) {
    head('Health');
    if (!issues.length) items.push({ label: 'Solid: passes every rule', run: () => {}, kind: 'info', tone: 0 });
    for (const i of issues) {
      const r = RULES[i.rule];
      items.push({ label: `${r.name}${i.value ? `: ${i.value}` : ''}`, run: () => {}, kind: 'info', tone: i.score, title: `${r.why}\nGood: ${r.good}\nSource: ${r.source}` });
    }
    const cures = new Map<() => unknown, string>(); // one entry per fix, labelled by the worst rule it answers
    for (const i of issues) for (const [label, run] of CURES[i.rule] ?? []) if (!cures.has(run)) cures.set(run, label);
    if (cures.size && kc[0]) { head('Suggested'); for (const [run, label] of cures) items.push({ label, run: () => void run() }); }
  }
  // only what would do something here: Tris to Quads needs triangles, Grid Fill an even n-gon of 6+ (or a hole's edges)
  const picked = c ? [...new Set([...c.faces].map((f) => g.poly[out.source[f]]))].map((q) => g.sides[q]) : [];
  const fits = (id: DocTool) => (id === 'quads' ? picked.includes(3) : id === 'grid' ? kc[1] > 0 || picked.some((n) => n >= 6 && n % 2 === 0) : true);
  const tools = (Object.keys(ALL) as DocTool[]).filter((id) => ALL[id].on(kc) && fits(id));
  if (tools.length) { head('Tools'); for (const id of tools) items.push({ label: ALL[id].name, kbd: ALL[id].key, title: ALL[id].tip, run: () => void runTool(id) }); }
  if (kc[0] && !tools.length) items.push({ label: 'Triangulate', run: () => void triangulateSel() });
  head('Select');
  if (issues[0]) items.push({ label: `Every ${RULES[issues[0].rule].name.toLowerCase()}`, run: () => selectRule(issues[0].rule) });
  if (sides) items.push({ label: `Every ${sides === 3 ? 'triangle' : sides === 4 ? 'quad' : 'n-gon'}`, run: () => selectPolygons(sides > 4 ? 5 : sides, sides > 4 ? Infinity : sides) });
  items.push({ label: 'Linked', kbd: 'Ctrl+L', run: selectLinked });
  const kind = sides === 3 ? 'Triangle' : sides === 4 ? 'Quad' : sides ? `N-gon (${sides} sides)` : 'Selection';
  openMenu(`${kind} · ${part.name}`, items);
}

export type Counts = [faces: number, edges: number, verts: number];
export interface ToolDef { name: string; key?: string; tip: string; icon: ReactNode; run: () => unknown; on: (c: Counts) => boolean }

/** The tools, in groups: clean up, shape, edge loops. */
export const POLY_TOOLS: Partial<Record<DocTool, ToolDef>>[] = [
  {
    dissolve: { name: 'Dissolve', key: 'Ctrl+X', tip: 'Faces: merge them into one polygon per patch. Edges: merge the polygons either side', run: dissolveSel, on: ([f, e]) => !!(f || e),
      icon: glyph('M2 3h5v10H2zM9 3h5v10H9z', 'M7 4.5v7', [[2, 8], [14, 8]]) },
    limited: { name: 'Limited Dissolve', tip: 'Merge the selected faces wherever neighbours meet flatter than the angle in the options bar', run: limitedDissolveSel, on: ([f]) => !!f,
      icon: glyph('M2 4h8v8H2zM10 4h4v8h-4z', 'M10 4.5l4 7', [[10, 8]]) },
    quads: { name: 'Tris to Quads', key: 'Alt+J', tip: 'Pair the selected triangles into the flattest, squarest quads', run: trisToQuadsSel, on: ([f]) => !!f,
      icon: glyph('M3 3h10v10H3z', 'M3 13L13 3', [[3, 3], [13, 3], [13, 13], [3, 13]]) },
    connect: { name: 'Connect', key: 'J', tip: 'Vertex mode: a new edge between two vertices of a polygon. Edge mode: cut a polygon between the middles of two of its edges', run: connectSel, on: ([, e, v]) => v >= 2 || e >= 2,
      icon: glyph('M3 13L13 3', 'M2 2h12v12H2z', [[3, 13], [13, 3]]) },
    merge: { name: 'Merge', key: 'M', tip: 'All selected vertices to one point at their center', run: () => mergePolySel(false), on: ([, e, v]) => v >= 2 || e >= 1,
      icon: glyph('M3 3l4 4M13 3L9 7M3 13l4-4M13 13L9 9', '', [[8, 8]]) },
    collapse: { name: 'Collapse', tip: 'Each connected group of selected edges to its own center', run: () => mergePolySel(true), on: ([, e]) => !!e,
      icon: glyph('M1.5 8h4M14.5 8h-4M5 5.5 7.5 8 5 10.5M11 5.5 8.5 8l2.5 2.5', '', [[8, 8]]) },
    rotate: { name: 'Rotate Edge', tip: 'Turn the selected edge one step round the two polygons beside it', run: rotateEdgeSel, on: ([, e]) => !!e,
      icon: glyph('M3 3h10v10H3z', 'M8 3L12 7M12 7l-4 4M5 3.5A7 7 0 0 0 3 9', [[8, 8]]) },
    grid: { name: 'Grid Fill', tip: 'Fill an n-gon (face mode) or a hole’s border (edge mode) with a quad grid. Needs an even number of corners, 6 or more', run: gridFillSel, on: ([f, e]) => !!(f || e),
      icon: glyph('M5 2h6l3 6-3 6H5L2 8z', 'M5 2v12M11 2v12M2 8h12') },
  },
  {
    move: { name: 'Move', key: 'G', tip: 'Drag the selected vertices with the mouse, kept on the surface (options bar); X / Y / Z lock an axis, click keeps, Esc cancels. Health updates as you go', run: () => startDocMove(), on: ([f, e, v]) => !!(f || e || v),
      icon: glyph('M8 1.5v13M1.5 8h13M8 1.5l-2 2M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2') },
    relax: { name: 'Even Out', tip: 'Spread the selected faces’ vertices out evenly without changing the shape: inside ones stay on the surface, border and crease ones slide along their line, corners stay. Rounds and Slide borders in the options bar', run: relaxPolySel, on: ([f]) => !!f,
      icon: glyph('M1.5 9c2.2-4 4.3-4 6.5 0s4.3 4 6.5 0', '', [[1.5, 9], [4.75, 6], [8, 9], [11.25, 12], [14.5, 9]]) },
    subdivide: { name: 'Subdivide', tip: 'Cut each selected polygon into quads at its edge midpoints and center', run: subdivideSel, on: ([f]) => !!f,
      icon: glyph('M2 2h12v12H2zM8 2v12M2 8h12', '', [[8, 8]]) },
  },
  {
    loopcut: { name: 'Loop Cut', key: 'Ctrl+R', tip: 'A new edge loop through the ring of quads the selected edge starts', run: loopCutSel, on: ([, e]) => !!e,
      icon: glyph('M1 4h14v8H1zM1 8h14', 'M8 1.5v13', [[8, 4], [8, 12]]) },
    slide: { name: 'Edge Slide', tip: 'Slide the selected loop along its rails; the amount and the other way are in the options bar', run: () => slideSel(useApp.getState().docOpts.slide), on: ([, e]) => !!e,
      icon: glyph('M8 2.5v11M2.5 8h3M13.5 8h-3M4.5 6l-2 2 2 2M11.5 6l2 2-2 2') },
    space: { name: 'Space', tip: 'Even out the vertices along the selected loop, as it runs', run: () => shapeLoopSel('space'), on: ([, e]) => e >= 2,
      icon: glyph('M1.5 10h13', '', [[2, 10], [6, 10], [10, 10], [14, 10]]) },
    straighten: { name: 'Straighten', tip: 'Line an open chain of edges up between its ends, laid on the surface', run: () => shapeLoopSel('straight'), on: ([, e]) => e >= 2,
      icon: glyph('M2 11h12', 'M2 11l3-5 3 4 3-6 3 7', [[2, 11], [14, 11]]) },
    circle: { name: 'Circle', tip: 'Make a closed loop of edges round', run: () => shapeLoopSel('circle'), on: ([, e]) => e >= 3,
      icon: glyph('M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11', '', [[8, 2.5], [13.5, 8], [8, 13.5], [2.5, 8]]) },
  },
];
const ALL = Object.assign({}, ...POLY_TOOLS) as Record<DocTool, ToolDef>;

/** Run a tool and make it the one the options bar shows. */
export function runTool(id: DocTool) {
  useApp.setState({ docTool: id });
  return ALL[id].run();
}

/** A Photoshop tool strip: groups of icon buttons, a line between groups; a tool is dimmed while it can't run.
 *  `mode` says which entries are persistent modes: only those get `aria-pressed` and stay lit, so a one-shot command
 *  never looks like a mode. The `title` sits on the wrapper, where a disabled button can still show it. */
export function ToolStrip<T extends string>({ label, groups, pressed, mode, on, pick }: {
  label: string; groups: Partial<Record<T, ToolDef>>[]; pressed: (id: T) => boolean; mode: (id: T) => boolean; on: (t: ToolDef) => boolean; pick: (id: T) => void;
}) {
  const busy = useApp((s) => !!s.loading || !!s.busy);
  return (
    <div className="tools" role="toolbar" aria-label={label}>
      {groups.map((group, i) => (
        <div key={i} className="tgroup">
          {(Object.keys(group) as T[]).map((id) => {
            const t = group[id]!;
            return (
              <span key={id} className="toolslot" title={`${t.name}${t.key ? ` (${t.key})` : ''}\n${t.tip}`}>
                <button aria-pressed={mode(id) ? pressed(id) : undefined} disabled={busy || !on(t)} aria-label={t.name} onClick={() => pick(id)}>{t.icon}</button>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function PolyToolStrip() {
  const tool = useApp((s) => s.docTool), moving = useApp((s) => !!s.docMove), counts = useCounts();
  return <ToolStrip label="Poly Doc tools" groups={POLY_TOOLS} pressed={(id) => (id === 'move' ? moving : tool === id)} mode={(id) => id === 'move'} on={(t) => t.on(counts)} pick={(id) => void runTool(id)} />;
}

/** Photoshop's options bar: the current tool, its settings, and what it last did. The right end is always the same
 *  ViewControls cluster (selection | display | Shading), so it never moves between workspaces. */
export function PolyOptionsBar() {
  const tool = useApp((s) => s.docTool), opts = useApp((s) => s.docOpts), note = useApp((s) => s.fixNote), busy = useApp((s) => !!s.loading || !!s.busy);
  const slideBorders = useApp((s) => s.slideBorders), onSurface = useApp((s) => s.moveOnSurface);
  const t = tool && ALL[tool];
  const what = useApp((s) => { const c = selectionCount(s); return c ? `${c.n} ${c.label}` : ''; });
  const num = (label: string, key: keyof typeof opts, min: number, max: number, step: number, unit: string, title: string) => (
    <label title={title}>{label}
      <input type="number" className="inc" min={min} max={max} step={step} value={opts[key]} onChange={(e) => Number.isFinite(+e.target.value) && setDocOpt(key, Math.min(max, Math.max(min, +e.target.value)))} />{unit}
    </label>
  );
  return (
    <div className="options">
      <span className="toolname">{t ? <>{t.icon}{t.name}</> : <><Icon name="cursor" size={16} />Select</>}</span>
      {what && <span className="hint">{what} selected</span>}
      {tool === 'slide' && (
        <>
          {num('Amount', 'slide', 0.05, 1, 0.05, '', 'How far along the rails each press slides, as a share of the rail')}
          <button disabled={busy} title="Slide the other way" onClick={() => void slideSel(-opts.slide)}>{glyph('M12 8H4M6 6 4 8l2 2')} Slide</button>
          <button disabled={busy} title="Slide this way" onClick={() => void slideSel(opts.slide)}>Slide {glyph('M4 8h8M10 6l2 2-2 2')}</button>
        </>
      )}
      {tool === 'limited' && num('Angle', 'angle', 0.5, 45, 0.5, '°', 'Neighbours meeting flatter than this merge')}
      {tool === 'relax' && <>
        {num('Rounds', 'relax', 1, 200, 1, '', 'How many rounds each press runs (30 settles most patches)')}
        <label title="Let the selection's border vertices slide along the border too (off: they stay put)"><input type="checkbox" checked={slideBorders} onChange={(e) => setSlideBorders(e.target.checked)} />Slide borders</label>
      </>}
      {tool === 'move' && <label title="Keep moved vertices on the model's surface, so the shape stays (off: they move freely in the view's plane)"><input type="checkbox" checked={onSurface} onChange={(e) => setMoveOnSurface(e.target.checked)} />On surface</label>}
      {note && <span className="hint note" role="status" title={note}>{note}</span>}
      <ViewControls />
    </div>
  );
}
