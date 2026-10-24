// node src/health.check.ts: the pre-bake check. Good primitives (a quad or triangulated torus, a cylinder cap fan, a
// cube grid) must be green; the old failures (triangle meshes read as quad meshes, model-relative faceting) must stay
// fixed; real defects (needles, bent quads, bow-ties, inside-out shells) must still be caught.
import assert from 'node:assert';
import { health, healthColor, healthReport, healthVerdict, ruleCounts, RULES } from './health.ts';
import { meshCheck, meshTopology, poles } from './polygeo.ts';
import { ownPolygons, trisToQuads } from './polyedit.ts';

const cells: number[] = [];
for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) cells.push(i, j, 0, i + 1, j, 0, i + 1, j + 1, 0, i, j, 0, i + 1, j + 1, 0, i, j + 1, 0);
const soup = new Float32Array(cells), n = soup.length / 9, grid = { soup, ...trisToQuads(soup, ownPolygons(n), Array.from({ length: n }, (_, i) => i))! };
const out = (positions: ArrayLike<number>, source?: number[]) => ({ positions: Array.from(positions), uvs: [], stretch: (source ?? Array.from({ length: positions.length / 9 }, (_, i) => i)).map(() => 0), island: [0], source: source ?? Array.from({ length: positions.length / 9 }, (_, i) => i) });
assert.ok(health(out(soup), grid).every((s) => s === 0), 'clean grid is green');
assert.ok(health(out(soup, Array.from({ length: n }, (_, i) => i)), grid).every((s) => s === 0), 'UV stretch and flips do not count');

const needle = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0.2, 0]), ng = { soup: needle, ...ownPolygons(1) };
assert.ok(health(out(needle), ng)[0] > 0.9, 'needle is red');
// one quad is one face: both its triangles get the same score, from the quad's own rules
const quad = (pts: number[][]) => { const [a, b, c, d] = pts; const sp = new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]); return { soup: sp, poly: Int32Array.from([0, 0]), sides: Int32Array.from([4]) }; };
const rules = (g: ReturnType<typeof quad>) => (healthReport(g).issues.get(0) ?? []).map((i) => i.rule);
const bent = quad([[0, 0, 0], [1, 0, 0], [1, 1, 0.9], [0, 1, 0]]);
const bs = healthReport(bent).score;
assert.ok(bs[0] === bs[1] && bs[0] > 0.5 && rules(bent).includes('quadWarp'), `bent quad: ${rules(bent)} ${[...bs]}`);
const sheared = quad([[0, 0, 0], [1, 0, 0], [3, 1, 0], [2, 1, 0]]);
assert.ok(rules(sheared).includes('quadSkew'), `sheared quad: ${rules(sheared)}`);
const bevel = quad([[0, 0, 0], [20, 0, 0], [20, 1, 0], [0, 1, 0]]);
assert.equal(healthReport(bevel).score[0], 0, 'a long flat strip (a bevel) is green: aspect alone is not a defect');
assert.ok(healthReport(quad([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])).score[0] === 0, 'a square is solid');

/** A torus as quads, or as triangles (the two ways a file arrives). Seam vertices repeat exactly, so it is closed. */
function torus(nu: number, nv: number, tri = false, R = 1, r = 0.4) {
  const pts = (i: number, j: number) => { const a = (2 * Math.PI * (i % nu)) / nu, b = (2 * Math.PI * (j % nv)) / nv; return [(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b)]; };
  const soup: number[] = [], poly: number[] = [], sides: number[] = [];
  let p = 0;
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = pts(i, j), b = pts(i + 1, j), c = pts(i + 1, j + 1), d = pts(i, j + 1);
    for (const t of [a, b, c, a, c, d]) soup.push(...t);
    if (tri) { poly.push(p, p + 1); sides.push(3, 3); p += 2; } else { poly.push(p, p); sides.push(4); p++; }
  }
  const g = { soup: new Float32Array(soup), poly: Int32Array.from(poly), sides: Int32Array.from(sides) };
  return tri ? { ...g, ...ownPolygons(g.soup.length / 9) } : g;
}
// The regression this rework is for: a good torus (quad or triangulated) is all green. A triangle mesh's regular
// valence is 6, so its vertices are not "5+ poles"; a 12-sided minor circle turns 30° per segment and is not faceted.
for (const [nu, nv] of [[48, 12], [64, 32], [32, 16]]) {
  for (const tri of [false, true]) {
    const g = torus(nu, nv, tri), rep = healthReport(g);
    assert.equal(rep.issues.size, 0, `${tri ? 'triangle' : 'quad'} torus ${nu}×${nv} has no issues: ${[...rep.issues.values()].flat().map((i) => i.rule)}`);
    assert.ok(health(out(g.soup), g).every((s) => s === 0), `${tri ? 'triangle' : 'quad'} torus ${nu}×${nv} is all green`);
  }
}
{
  const g = torus(48, 12), t = meshTopology(g);
  assert.deepEqual({ shells: t.shells, closed: t.closed, genus: t.genus, chi: t.chi, boundaries: t.boundaries }, { shells: 1, closed: 1, genus: 1, chi: 0, boundaries: 0 });
  assert.equal(healthVerdict(out(g.soup), g).text, 'ready to bake', 'a good torus is ready to bake');
}

// A flat pole fan (a cylinder cap / a UV sphere at its pole): thin wedges are normal, and no pole is coloured.
{
  const fan: number[] = [], k = 48;
  for (let i = 0; i < k; i++) {
    const a = (i * 2 * Math.PI) / k, b = (((i + 1) % k) * 2 * Math.PI) / k;
    fan.push(0, 0, 0, Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0);
  }
  const fs = new Float32Array(fan), g = { soup: fs, ...ownPolygons(k) };
  assert.ok(health(out(fs), g).every((s) => s === 0), 'a 48-triangle cap fan is green');
  const p = poles(g);
  assert.equal(p.regular, 6); assert.equal(p.low.length, 0); assert.equal(p.high.length, 1, 'one high-valence fan centre, reported but not coloured');
}

// Sampling is scale-free: a 12-sided curve (30°) passes, a 9-sided one (40°) is a yellow hint, a 96-sided one is green.
const prism = (sides: number) => {
  const c: number[] = [], pt = (i: number, z: number) => [Math.cos((2 * Math.PI * (i % sides)) / sides), Math.sin((2 * Math.PI * (i % sides)) / sides), z];
  for (let i = 0; i < sides; i++) c.push(...pt(i, 0), ...pt(i + 1, 0), ...pt(i + 1, 2), ...pt(i, 0), ...pt(i + 1, 2), ...pt(i, 2));
  return { soup: new Float32Array(c), poly: Int32Array.from({ length: 2 * sides }, (_, t) => t >> 1), sides: new Int32Array(sides).fill(4) };
};
const faceted = (sides: number, fix = false) => [...healthReport(prism(sides)).issues.values()].filter((is) => is.some((i) => i.rule === 'faceted' && (!fix || i.score >= 0.6))).length;
assert.equal(faceted(9), 9, '9 sides (40° per segment): every face is worth a look');
assert.equal(faceted(9, true), 0, 'faceting is a craft hint, never a red bake blocker');
assert.equal(faceted(12), 0, '12 sides (30° per segment): smooth enough');
assert.equal(faceted(96), 0, '96 sides: smooth enough');
assert.equal([...healthReport(prism(12)).issues.values()].flat().length, 0, '12-sided curve has no issue at all');
assert.ok([...healthReport(prism(720)).issues.values()].some((is) => is.some((i) => i.rule === 'dense')), 'a 720-sided curve is over-dense (a hint, not red)');

// Mesh check: a bow-tie vertex, an inside-out closed shell, and a nested inward shell (a cavity) that must not be flagged.
{
  const bow = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, -1, 0]);
  const m = meshCheck({ soup: bow, ...ownPolygons(2) });
  assert.equal(m.nonManifoldVert.length, 1, 'bow-tie vertex');
  assert.equal(m.nonManifold.length, 0, 'bow-tie has no non-manifold edge');
}
const tetra = (inward = false) => {
  const p = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], f = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]], soup: number[] = [];
  for (const t of f) for (const k of (inward ? [...t].reverse() : t)) soup.push(...p[k]);
  return { soup: new Float32Array(soup), ...ownPolygons(4) };
};
/** A closed axis-aligned box (12 triangles), outward or inward, for the cavity test. */
const box = (s: number, o: number, inward = false) => {
  const p = [[o, o, o], [o + s, o, o], [o + s, o + s, o], [o, o + s, o], [o, o, o + s], [o + s, o, o + s], [o + s, o + s, o + s], [o, o + s, o + s]];
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], soup: number[] = [];
  for (const [a, b, c, d] of q) for (const t of [[a, b, c], [a, c, d]]) for (const k of (inward ? [...t].reverse() : t)) soup.push(...p[k]);
  return { soup: new Float32Array(soup), ...ownPolygons(12) };
};
{
  const good = tetra(), m = meshCheck(good);
  assert.equal(m.insideOut.length, 0); assert.equal(m.flipped.length, 0);
  const bad = tetra(true), mb = meshCheck(bad);
  assert.equal(mb.insideOut.length, 1, 'inside-out tetra is one inverted shell');
  assert.equal(mb.insideOut[0].length, 4); assert.equal(mb.flipped.length, 0, 'no minority faces: the whole shell is told once');
  assert.ok(health(out(bad.soup), bad).every((s) => s === 1), 'inside-out shell is red');
  const t = meshTopology(good);
  assert.deepEqual({ genus: t.genus, chi: t.chi, shells: t.shells, closed: t.closed }, { genus: 0, chi: 2, shells: 1, closed: 1 });
  // A negative shell inside another closed shell is a cavity (a cup, a hollow casting), not an error.
  const hollowSoup = new Float32Array([...box(2, 0).soup, ...box(1, 0.5, true).soup]);
  const hollow = { soup: hollowSoup, ...ownPolygons(24) }, mh = meshCheck(hollow);
  assert.equal(mh.insideOut.length, 0, 'a nested inward shell is read as a cavity');
  assert.equal(mh.flipped.length, 0);
  assert.ok(health(out(hollowSoup), hollow).every((s) => s === 0), 'a hollow box is green');
}

// The rules are classed: a bake-critical quad is 'bake', a shape wrinkle is 'craft', breakage is 'broken'.
assert.equal(RULES.quadWarp.kind, 'bake'); assert.equal(RULES.quadSkew.kind, 'craft'); assert.equal(RULES.nonManifoldVert.kind, 'broken');
{ const q = ruleCounts(bent).get('quadWarp')!; assert.equal(q.look.length + q.fix.length, 1, 'bent quad is flagged once'); }
// Colour is continuous across the middle of the scale (the old ramp jumped from yellow to red at 0.5).
const c = (x: number) => healthColor(x).map((v) => +v.toFixed(3));
assert.ok(Math.abs(c(0.4999)[0] - c(0.5)[0]) < 0.01 && Math.abs(c(0.4999)[1] - c(0.5)[1]) < 0.01, `colour jumps at 0.5: ${c(0.4999)} → ${c(0.5)}`);
assert.ok(Math.abs(c(0.5)[1] - c(0.5001)[1]) < 0.01);
console.log('health ok');
