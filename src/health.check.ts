// node src/health.check.ts: a clean flat grid of quads is all green, whatever the UVs; a needle triangle goes red.
import assert from 'node:assert';
import { health, healthReport } from './health.ts';
import { ownPolygons, trisToQuads } from './polyedit.ts';

const cells: number[] = [];
for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) cells.push(i, j, 0, i + 1, j, 0, i + 1, j + 1, 0, i, j, 0, i + 1, j + 1, 0, i, j + 1, 0);
const soup = new Float32Array(cells), n = soup.length / 9, g = { soup, ...trisToQuads(soup, ownPolygons(n), Array.from({ length: n }, (_, i) => i))! };
const out = (stretch: number[]) => ({ positions: Array.from(soup), uvs: [], stretch, island: stretch.map(() => 0), source: stretch.map((_, i) => i) });
assert.ok(health(out(Array(n).fill(0)), g).every((s) => s === 0), 'clean grid is green');
assert.ok(health(out(Array(n).fill(0).map((_, i) => (i === 4 ? 0.5 : -1))), g).every((s) => s === 0), 'UV stretch and flips do not count');

const needle = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0.2, 0]), ng = { soup: needle, ...ownPolygons(1) };
assert.ok(health({ positions: Array.from(needle), uvs: [], stretch: [0], island: [0], source: [0] }, ng)[0] > 0.9, 'needle is red');
// one quad is one face: both its triangles get the same score, from the quad's own rules
const quad = (pts: number[][]) => { const [a, b, c, d] = pts; const sp = new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]); return { soup: sp, poly: Int32Array.from([0, 0]), sides: Int32Array.from([4]) }; };
const rules = (g: ReturnType<typeof quad>) => (healthReport(g).issues.get(0) ?? []).map((i) => i.rule);
const bent = quad([[0, 0, 0], [1, 0, 0], [1, 1, 0.9], [0, 1, 0]]);
const bs = healthReport(bent).score;
assert.ok(bs[0] === bs[1] && bs[0] > 0.5 && rules(bent).includes('quadWarp'), `bent quad: ${rules(bent)} ${[...bs]}`);
const sheared = quad([[0, 0, 0], [1, 0, 0], [3, 1, 0], [2, 1, 0]]);
assert.ok(rules(sheared).includes('quadSkew'), `sheared quad: ${rules(sheared)}`);
const bevel = quad([[0, 0, 0], [20, 0, 0], [20, 1, 0], [0, 1, 0]]);
assert.ok(healthReport(bevel).score[0] < 0.5 && rules(bevel).includes('quadAspect'), 'a long bevel strip is only worth a look');
assert.ok(healthReport(quad([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])).score[0] === 0, 'a square is solid');
// density: a 12-sided prism's faces are a faceted curve (red); at 96 sides the same curve is fine
const prism = (n: number) => {
  const c: number[] = [], pt = (i: number, z: number) => [Math.cos((2 * Math.PI * (i % n)) / n), Math.sin((2 * Math.PI * (i % n)) / n), z];
  for (let i = 0; i < n; i++) c.push(...pt(i, 0), ...pt(i + 1, 0), ...pt(i + 1, 2), ...pt(i, 0), ...pt(i + 1, 2), ...pt(i, 2));
  return { soup: new Float32Array(c), poly: Int32Array.from({ length: 2 * n }, (_, t) => t >> 1), sides: new Int32Array(n).fill(4) };
};
const faceted = (n: number) => [...healthReport(prism(n)).issues.values()].filter((is) => is.some((i) => i.rule === 'faceted' && i.score >= 0.6)).length;
assert.equal(faceted(12), 12, '12 sides: every face faceted');
assert.equal(faceted(96), 0, '96 sides: smooth enough');
console.log('health ok');
