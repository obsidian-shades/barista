// Poly Doc's tool strip and options bar, laid out like Photoshop (and espresso-level-designer's shell): one icon per
// tool down the left, the tool you last used named in the bar on top with its settings and what it just did. A click
// runs the tool on the selection; it's off (dimmed) until the selection fits, and its tooltip says what it needs.
// Spectrum has no mesh-editing icons, so these follow Blender's and Maya's toolbars: the mesh in line, its faces faint,
// what the tool makes or acts on lit in the blue selection accent (`ui/Icon` `ico`), on the same 20×20 grid as the chrome icons.
import type { ReactNode } from 'react';
import { polygonsOf, topoOf } from '../topo';
import { healthReport, RULES, type RuleId } from '../health';
import { ownPolygons } from '../polyedit';
import { SelectionControls } from './Chrome';
import { dot, dots, ico, Icon, ICON } from '../ui/Icon';
import {
  addLoopsSel, cancelKnife, cleanVertsSel, flipFacesSel, partGeo, recalcOutsideSel, collapseShortestSel, confirmKnife, connectSel, startKnife, dissolveSel, gridFillSel, limitedDissolveSel, liveSel, loopCutSel, mergeIntoNeighbourSel, mergePolySel, openMenu, pointer,
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
  flipped: [['Recalculate Outside', recalcOutsideSel], ['Flip', flipFacesSel]],
  insideOut: [['Recalculate Outside', recalcOutsideSel]],
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
  const g = partGeo(part);
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
      icon: ico(['M3 5h14v10H3z', 'f'], 'M3 5h14v10H3z', ['M10 5v10', 'ad']) },
    limited: { name: 'Limited Dissolve', tip: 'Merge the selected faces wherever neighbours meet flatter than the angle in the options bar', run: limitedDissolveSel, on: ([f]) => !!f,
      icon: ico(['M2 6h11v10H2z', 'f'], 'M2 6h11v10H2zM13 6l5-3v10l-5 3', ['M5.7 6v10M9.3 6v10', 'ad']) },
    quads: { name: 'Tris to Quads', key: 'Alt+J', tip: 'Pair the selected triangles into the flattest, squarest quads', run: trisToQuadsSel, on: ([f]) => !!f,
      icon: ico(['M4 4h12v12H4z', 'f'], 'M4 4h12v12H4z', ['M4 16L16 4', 'ad'], [dots([[4, 4], [16, 4], [16, 16], [4, 16]], 1.3), 'F']) },
    connect: { name: 'Connect', key: 'J', tip: 'Vertex mode: a new edge between two vertices of a polygon. Edge mode: cut a polygon between the middles of two of its edges', run: connectSel, on: ([, e, v]) => v >= 2 || e >= 2,
      icon: ico(['M6 3h8l4 7-4 7H6l-4-7z', 'f'], 'M6 3h8l4 7-4 7H6l-4-7z', ['M2 10h16', 'a'], [dots([[2, 10], [18, 10]], 1.7), 'A']) },
    merge: { name: 'Merge', key: 'M', tip: 'All selected vertices to one point at their center', run: () => mergePolySel(false), on: ([, e, v]) => v >= 2 || e >= 1,
      icon: ico('M3.5 3.5l4 4M16.5 3.5l-4 4M3.5 16.5l4-4M16.5 16.5l-4-4M5 8h2.5V5.5M15 8h-2.5V5.5M5 12h2.5v2.5M15 12h-2.5v2.5', [dot(10, 10, 2), 'A']) },
    collapse: { name: 'Collapse', tip: 'Each connected group of selected edges to its own center', run: () => mergePolySel(true), on: ([, e]) => !!e,
      icon: ico('M3.5 4h13M10 7.5v5M7.8 10.5l2.2 2.2 2.2-2.2', [dots([[3.5, 4], [16.5, 4]], 1.4), 'F'], [dot(10, 16, 2), 'A']) },
    rotate: { name: 'Rotate Edge', tip: 'Turn the selected edge one step round the two polygons beside it', run: rotateEdgeSel, on: ([, e]) => !!e,
      icon: ico(['M2.5 6h11v11h-11z', 'f'], 'M2.5 6h11v11h-11z', ['M2.5 17l11-11', 'd'], ['M2.5 6l11 11', 'a'], 'M12 2.2a5.5 5.5 0 0 1 5.8 5.8M15.8 6.3l2 1.9 1.8-2') },
    clean: { name: 'Clean Vertices', tip: 'Dissolve the vertices that shape nothing: dots inside a polygon and corners on a straight edge. Works on the selection, or the whole part with nothing selected', run: cleanVertsSel, on: () => true,
      icon: ico(['M3 5h14v10H3z', 'f'], 'M3 5h14v10H3z', [dots([[10, 5], [8, 10]], 1.6), 'A'], ['M12.5 8.5l4 4M16.5 8.5l-4 4', 'a']) },
    outside: { name: 'Recalculate Outside', key: 'Shift+N', tip: 'Wind every face alike and turn each piece to face outward (closed pieces by their volume, a cavity’s wall stays facing in). Works on the selection, or the whole part with nothing selected', run: recalcOutsideSel, on: () => true,
      icon: ico(['M6 6h8v8H6z', 'f'], 'M6 6h8v8H6z', ['M10 6V1.5M8.2 3.3L10 1.5l1.8 1.8M14 10h4.5M16.7 8.2l1.8 1.8-1.8 1.8M10 14v4.5M8.2 16.7l1.8 1.8 1.8-1.8M6 10H1.5M3.3 8.2L1.5 10l1.8 1.8', 'a']) },
    flip: { name: 'Flip', key: 'Alt+N', tip: 'Turn the selected faces over, so they face the other way', run: flipFacesSel, on: ([f]) => !!f,
      icon: ico(['M3 15L10 4l7 11z', 'f'], 'M3 15L10 4l7 11z', ['M6.5 18.5a5 5 0 0 0 7 0M13.5 18.5l-.3-2.4M13.5 18.5l-2.3.4', 'a']) },
    grid: { name: 'Grid Fill', tip: 'Fill an n-gon (face mode) or a hole’s border (edge mode) with a quad grid. Needs an even number of corners, 6 or more', run: gridFillSel, on: ([f, e]) => !!(f || e),
      icon: ico(['M6 3h8l4 7-4 7H6l-4-7z', 'f'], ['M6 3v14M14 3v14M2 10h16M10 3v14', 'a'], 'M6 3h8l4 7-4 7H6l-4-7z') },
  },
  {
    move: { name: 'Move', key: 'G', tip: 'Drag the selected vertices with the mouse, kept on the surface (options bar); X / Y / Z lock an axis, click keeps, Esc cancels. Health updates as you go', run: () => startDocMove(), on: ([f, e, v]) => !!(f || e || v),
      icon: ico('M10 4v12M4 10h12', ['M10 1.5l2.6 3h-5.2zM10 18.5l2.6-3h-5.2zM1.5 10l3-2.6v5.2zM18.5 10l-3-2.6v5.2z', 'F'], [dot(10, 10, 1.8), 'A']) },
    knife: { name: 'Knife', key: 'K', tip: 'Click points on the model to cut the polygons between them (snaps to corners and edges); Enter or Space cuts, Backspace takes a point back, Esc cancels', run: startKnife, on: () => true,
      icon: ico(['M3 4h14v12H3z', 'f'], 'M3 4h14v12H3z', ['M3 13l14-6', 'a'], [dots([[3, 13], [10, 10], [17, 7]], 1.5), 'A']) },
    relax: { name: 'Even Out', tip: 'Spread the selected faces’ vertices out evenly without changing the shape: inside ones stay on the surface, border and crease ones slide along their line, corners stay. Rounds and Slide borders in the options bar', run: relaxPolySel, on: ([f]) => !!f,
      icon: ICON.relax },
    subdivide: { name: 'Subdivide', tip: 'Cut each selected polygon into quads at its edge midpoints and center', run: subdivideSel, on: ([f]) => !!f,
      icon: ico(['M3 3h14v14H3z', 'f'], 'M3 3h14v14H3z', ['M10 3v14M3 10h14', 'a'], [dots([[10, 3], [17, 10], [10, 17], [3, 10], [10, 10]], 1.4), 'A']) },
  },
  {
    loopcut: { name: 'Loop Cut', key: 'Ctrl+R', tip: 'A new edge loop through the ring of quads the selected edge starts', run: loopCutSel, on: ([, e]) => !!e,
      icon: ico(['M3 7h10v10H3z', 'f'], 'M3 7h10v10H3zM3 7l4-4h10l-4 4M13 17l4-4V3', ['M8 17V7l4-4', 'a']) },
    slide: { name: 'Edge Slide', tip: 'Slide the selected loop along its rails; the amount and the other way are in the options bar', run: () => slideSel(useApp.getState().docOpts.slide), on: ([, e]) => !!e,
      icon: ico('M2 4h16M2 16h16', ['M9 4v12', 'a'], 'M12.5 10H17M15 8l2 2-2 2M5.5 10H3M5 8l-2 2 2 2') },
    space: { name: 'Space', tip: 'Even out the vertices along the selected loop, as it runs', run: () => shapeLoopSel('space'), on: ([, e]) => e >= 2,
      icon: ico('M3 7.5v2M7.7 7.5v2M12.3 7.5v2M17 7.5v2', ['M3 8.5h14', 'd'], 'M2 13.5h16', [dots([[3, 13.5], [7.7, 13.5], [12.3, 13.5], [17, 13.5]], 1.6), 'A']) },
    straighten: { name: 'Straighten', tip: 'Line an open chain of edges up between its ends, laid on the surface', run: () => shapeLoopSel('straight'), on: ([, e]) => e >= 2,
      icon: ico(['M2 13l4-6 4 5 4-7 4 8', 'd'], ['M2 13h16', 'a'], [dots([[2, 13], [18, 13]], 1.6), 'A']) },
    circle: { name: 'Circle', tip: 'Make a closed loop of edges round', run: () => shapeLoopSel('circle'), on: ([, e]) => e >= 3,
      icon: ico(['M5 4l9 1 2.5 8-6.5 5-6.5-4z', 'd'], ['M10 3.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13', 'a'], [dots([[10, 3.5], [16.5, 10], [10, 16.5], [3.5, 10]], 1.4), 'A']) },
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
  const tool = useApp((s) => s.docTool), moving = useApp((s) => !!s.docMove), knifing = useApp((s) => !!s.docKnife), counts = useCounts();
  return <ToolStrip label="Poly Doc tools" groups={POLY_TOOLS} pressed={(id) => (id === 'move' ? moving : id === 'knife' ? knifing : tool === id)} mode={(id) => id === 'move' || id === 'knife'} on={(t) => t.on(counts)} pick={(id) => void runTool(id)} />;
}

/** Photoshop's options bar: the current tool, then what it selects (the Mode group), then its settings and what it last
 *  did. Display and Shading are view settings: they live in the 3D view header. */
export function PolyOptionsBar() {
  const tool = useApp((s) => s.docTool), opts = useApp((s) => s.docOpts), note = useApp((s) => s.fixNote), busy = useApp((s) => !!s.loading || !!s.busy);
  const slideBorders = useApp((s) => s.slideBorders), onSurface = useApp((s) => s.moveOnSurface), knife = useApp((s) => s.docKnife?.pts.length ?? -1);
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
      <SelectionControls />
      {what && <span className="hint">{what} selected</span>}
      {tool === 'slide' && (
        <>
          {num('Amount', 'slide', 0.05, 1, 0.05, '', 'How far along the rails each press slides, as a share of the rail')}
          <button disabled={busy} title="Slide the other way" onClick={() => void slideSel(-opts.slide)}>{ICON.left} Slide</button>
          <button disabled={busy} title="Slide this way" onClick={() => void slideSel(opts.slide)}>Slide {ICON.right}</button>
        </>
      )}
      {tool === 'limited' && num('Angle', 'angle', 0.5, 45, 0.5, '°', 'Neighbours meeting flatter than this merge')}
      {tool === 'relax' && <>
        {num('Rounds', 'relax', 1, 200, 1, '', 'How many rounds each press runs (30 settles most patches)')}
        <label title="Let the selection's border vertices slide along the border too (off: they stay put)"><input type="checkbox" checked={slideBorders} onChange={(e) => setSlideBorders(e.target.checked)} />Slide borders</label>
      </>}
      {tool === 'move' && <label title="Keep moved vertices on the model's surface, so the shape stays (off: they move freely in the view's plane)"><input type="checkbox" checked={onSurface} onChange={(e) => setMoveOnSurface(e.target.checked)} />On surface</label>}
      {tool === 'knife' && knife >= 0 && <>
        <span className="hint">{knife} point{knife === 1 ? '' : 's'}</span>
        <button disabled={busy || knife < 2} title="Cut along the points (Enter)" onClick={() => void confirmKnife()}>Cut</button>
        <button disabled={busy} title="Drop the cut (Esc)" onClick={cancelKnife}>Cancel</button>
      </>}
      {note && <span className="hint note" role="status" title={note}>{note}</span>}
    </div>
  );
}
