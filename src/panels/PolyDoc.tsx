// Poly Doc's panel: looking, not fixing (the tools are in the strip on the left, `shell/PolyTools`). Top to bottom: how
// solid the part is (Health), what's broken (Mesh Check), what the mesh is made of (polygons and poles, each selectable).
// It reads the mesh alone, never the unwrap. Nothing runs by itself: you look, you pick, you fix.
import { useMemo } from 'react';
import { meshCheck, meshTopology, poles } from '../polygeo';
import { ownPolygons } from '../polyedit';
import { health, healthSummary, healthVerdict, ruleCounts, RULES, type RuleKind } from '../health';
import { Panel, Parts } from './Dock';
import { selectFound, selectPolygons, selectRed, selectRule, setDocView, setShowPoles, useApp } from '../store';

/** A count you can click to select what it counts; orange when there's something to look at. */
const Count = ({ label, n, title, warn, run }: { label: string; n: number; title: string; warn?: boolean; run: () => void }) => (
  <button className={`census${warn && n ? ' warn' : ''}`} disabled={!n} title={title} onClick={run}>
    <span>{label}</span><span className="num">{n.toLocaleString()}</span>
  </button>
);

/** The active part as the tools see it: its soup and polygons (one per triangle when the file had none). */
function useGeo() {
  const part = useApp((s) => s.parts[s.activePart]);
  return useMemo(() => part && { soup: part.soup, ...(part.poly && part.sides ? { poly: part.poly, sides: part.sides } : ownPolygons(part.soup.length / 9)) }, [part]);
}

const KIND_LABEL: Record<RuleKind, string> = { broken: 'Broken', bake: 'Bake', craft: 'Craft' };
const KIND_ORDER: RuleKind[] = ['broken', 'bake', 'craft'];

/** How ready the active part is to bake: the share of its surface green, yellow and red, then the rules that colour it,
 *  grouped by what they mean (broken / bake / craft). */
function Health() {
  const g = useGeo(), out = useApp((s) => s.result?.parts[s.activePart]), view = useApp((s) => s.docView);
  const sum = useMemo(() => (g && out ? healthSummary(out, health(out, g)) : null), [g, out]);
  const verdict = useMemo(() => (g && out ? healthVerdict(out, g) : null), [g, out]);
  // each rule that flags something: broken first, then what a bake gets wrong, then craft; worst counts first
  const rules = useMemo(() => (g ? [...ruleCounts(g)].sort((a, b) =>
    KIND_ORDER.indexOf(RULES[a[0]].kind) - KIND_ORDER.indexOf(RULES[b[0]].kind)
    || b[1].fix.length - a[1].fix.length || b[1].look.length - a[1].look.length) : []), [g]);
  if (!sum || !verdict) return null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <>
      <div className="tsec"><span className="caps">Health</span><span className={`hint ${verdict.kind}`} title="What a bake would say about this part">{verdict.text}</span></div>
      <div className="healthbar" title={`Solid ${pct(sum.solid)} · worth a look ${pct(sum.look)} · fix ${pct(sum.fix)} of the surface`}>
        <span style={{ flexGrow: sum.solid, background: 'var(--ok)' }} /><span style={{ flexGrow: sum.look, background: 'var(--warn)' }} /><span style={{ flexGrow: sum.fix, background: 'var(--bad)' }} />
      </div>
      <div className="tgrid two">
        <button aria-pressed={view === 'health'} title="Color every face green (solid) through yellow to red (fix)" onClick={() => setDocView(view === 'health' ? 'wire' : 'health')}>{view === 'health' ? 'Hide Health' : 'Show Health'}</button>
        <button disabled={sum.fix === 0} title="Select the red faces to see what's wrong there" onClick={selectRed}>Select red</button>
      </div>
      {rules.length > 0 && (
        <div className="rules" role="list" aria-label="Health rules">
          {KIND_ORDER.flatMap((kind) => {
            const rs = rules.filter(([id]) => RULES[id].kind === kind);
            if (!rs.length) return [];
            return [
              <div key={kind} className="rkind">{KIND_LABEL[kind]}</div>,
              ...rs.map(([id, r]) => (
                <button key={id} role="listitem" className="rule" onClick={() => selectRule(id)}
                  title={`${RULES[id].why}
Good: ${RULES[id].good}
Source: ${RULES[id].source}
Click to select them; right-click one on the model for fixes.`}>
                  <span className="rname">{RULES[id].name}</span>
                  {r.fix.length > 0 && <span className="num rfix">{r.fix.length}</span>}
                  {r.look.length > 0 && <span className="num rlook">{r.look.length}</span>}
                </button>
              )),
            ];
          })}
        </div>
      )}
    </>
  );
}

function MeshCheck() {
  const g = useGeo(), m = useMemo(() => g && meshCheck(g), [g]);
  if (!m) return null;
  const clean = !m.nonManifold.length && !m.nonManifoldVert.length && !m.flipped.length && !m.insideOut.length && !m.zero.length && !m.duplicate.length;
  return (
    <>
      <div className="tsec"><span className="caps">Mesh check</span><span className="hint">{clean ? 'nothing broken' : 'fix these before baking'}</span></div>
      <div className="censusgrid">
        <Count label="Non-manifold edges" n={m.nonManifold.length} warn run={() => selectFound('nonManifold')} title="Edges with more than two faces on them: bakes and unwraps can't handle these. Select them" />
        <Count label="Non-manifold verts" n={m.nonManifoldVert.length} warn run={() => selectFound('nonManifoldVert')} title="Points where two fans of faces meet only at the vertex (a bow-tie): unwrappers split them apart into a pinhole. Select them" />
        <Count label="Flipped faces" n={m.flipped.length} warn run={() => selectFound('flipped')} title="Faces wound the other way from their neighbours (normals pointing in). Select them" />
        <Count label="Inside-out shells" n={m.insideOut.length} warn run={() => selectFound('insideOut')} title="Whole closed pieces wound inward (negative volume), unless nested inside another shell (a cavity): they vanish with backface culling and bake inverted. Select their faces and recalculate normals in your DCC" />
        <Count label="Zero-area faces" n={m.zero.length} warn run={() => selectFound('zero')} title="Faces with no area (corners on top of each other or in a line). The unwrap drops them; Merge their corners to clean up" />
        <Count label="Duplicate faces" n={m.duplicate.length} warn run={() => selectFound('duplicate')} title="Faces lying twice on the same corners. Select them" />
        <Count label="Open edges" n={m.open.length} run={() => selectFound('open')} title="Edges with one face: the borders of holes and open shells (fine on purpose, a bug if not). Select them; Grid Fill closes a hole" />
      </div>
    </>
  );
}

function Census() {
  const part = useApp((s) => s.parts[s.activePart]), show = useApp((s) => s.showPoles), g = useGeo();
  // counted on the file's own polygon list, as Blender's statistics count them
  const counts = useMemo(() => {
    if (!part?.sides) return null;
    const c = { tris: 0, quads: 0, ngons: 0 };
    for (const n of part.sides) { if (n === 3) c.tris++; else if (n === 4) c.quads++; else c.ngons++; }
    return c;
  }, [part]);
  const p = useMemo(() => g && poles(g), [g]);
  const topo = useMemo(() => g && meshTopology(g), [g]);
  if (!part || !g || !p || !topo) return <p className="hint">No model open.</p>;
  const kind = p.regular === 6 ? 'triangle' : p.regular === 4 ? 'quad' : `${topo.regular}-edge`;
  return (
    <>
      {counts ? (
        <div className="censusgrid">
          <Count label="Quads" n={counts.quads} title="Select every quad" run={() => selectPolygons(4, 4)} />
          <Count label="Triangles" n={counts.tris} warn title="Select every triangle" run={() => selectPolygons(3, 3)} />
          <Count label="N-gons" n={counts.ngons} warn title="Select every polygon with more than 4 sides" run={() => selectPolygons(5, Infinity)} />
        </div>
      ) : <p className="hint">Triangles only (binary FBX keeps its polygons).</p>}
      <p className="hint topo" title="Counted on the welded mesh: a shell is a connected piece of surface; genus is its number of handles (0 sphere/disc, 1 torus); χ is V − E + F; border is a boundary loop. Poles are the vertices whose valence differs from the regular one — they are structural, so Health does not colour them.">
        {topo.shells} shell{topo.shells === 1 ? '' : 's'} · {topo.closed} closed · genus {topo.genus} · χ {topo.chi}
        {topo.boundaries ? ` · ${topo.boundaries} border${topo.boundaries === 1 ? '' : 's'}` : ''}
        {topo.clean ? '' : ' · not an orientable manifold'}
      </p>
      <div className="censusgrid">
        <Count label="Low poles" n={p.low.length} title={`Inside vertices with fewer than ${p.regular} edges (regular for this ${kind} mesh). Poles are required by topology; select them to see where they sit`} run={() => selectFound('low')} />
        <Count label="High poles" n={p.high.length} warn title={`Inside vertices with more than ${p.regular} edges (regular for this ${kind} mesh). High-valence poles make a star of faces; select them to see where they sit`} run={() => selectFound('high')} />
      </div>
      <div className="settings"><label className="toggle"><input type="checkbox" checked={show} onChange={(e) => setShowPoles(e.target.checked)} />Show poles on the model (blue low, red high)</label></div>
    </>
  );
}

export function PolyDoc() {
  const name = useApp((s) => s.parts[s.activePart]?.name);
  return (
    <aside className="dock">
      <Panel title="Mesh" grow>
        <Health />
        <MeshCheck />
        <div className="tsec"><span className="caps">Polygons</span><span className="hint">{name ?? ''}</span></div>
        <Census />
      </Panel>
      <Panel title="Parts"><Parts workspace="doc" /></Panel>
    </aside>
  );
}
