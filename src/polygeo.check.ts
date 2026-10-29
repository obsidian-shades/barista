// node src/polygeo.check.ts: every Poly Doc geometry tool on small flat grids of quads, where the right answer is known.
import assert from 'node:assert';
import { addLoops, carryUVs, cleanVerts, connect, curveEdges, knifeOn, gridFill, loopCut, merge, meshCheck, poles, relax, rotateEdge, shapeLoop, slide, subdivide, type Geo, type Sel } from './polygeo.ts';
import { dissolveFaces, ownPolygons, topoOfSoup, trisToQuads } from './polyedit.ts';

/** A flat grid of quads with column edges at `xs` and row edges at `ys`, minus the cells in `skip` ("x,y"). */
function grid(xs: number[], ys: number[], skip: string[] = []): Geo {
  const cells: number[] = [];
  for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
    if (skip.includes(`${i},${j}`)) continue;
    const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
    cells.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0);
  }
  const soup = new Float32Array(cells), n = soup.length / 9;
  return { soup, ...trisToQuads(soup, ownPolygons(n), Array.from({ length: n }, (_, i) => i))! };
}
const at = (g: Geo, x: number, y: number) => topoOfSoup(g.soup).at.get(`${Math.fround(x)},${Math.fround(y)},0`)!;
const sel = (s: Partial<Sel>): Sel => ({ faces: [], verts: [], edges: [], ...s });
const sides = (g: Geo) => [...g.sides].sort((a, b) => a - b);
const all = (g: Geo) => Array.from({ length: g.poly.length }, (_, i) => i);
const facingUp = (g: Geo) => {
  for (let f = 0; f < g.soup.length / 9; f++) {
    const p = g.soup.subarray(f * 9, f * 9 + 9);
    assert.ok((p[3] - p[0]) * (p[7] - p[1]) - (p[4] - p[1]) * (p[6] - p[0]) > 0, `triangle ${f} turned over`);
  }
};
const xy = (g: Geo, v: number) => { const t = topoOfSoup(g.soup); return [t.pos[v * 3], t.pos[v * 3 + 1]]; };
const vertAt = (g: Geo, x: number, y: number) => topoOfSoup(g.soup).at.has(`${Math.fround(x)},${Math.fround(y)},0`);

// Subdivide one of two quads: 4 quads, and the neighbour becomes a 5-gon
const two = grid([0, 1, 2], [0, 1]);
const sd = subdivide(two, sel({ faces: [0] }))!;
assert.deepEqual(sides(sd.geo), [4, 4, 4, 4, 5]); facingUp(sd.geo);

// Relax pulls a crooked inside vertex back toward even spacing and keeps it on the plane
const crooked = grid([0, 1, 2, 3], [0, 1, 2, 3]);
{
  const soup = crooked.soup.slice();
  for (let i = 0; i < soup.length; i += 3) if (soup[i] === 1 && soup[i + 1] === 1) { soup[i] = 1.4; soup[i + 1] = 1.3; }
  const g = { ...crooked, soup }, r = relax(g, sel({ faces: all(g) }))!, v = at(g, 1.4, 1.3), [x, y] = xy(r.geo, v);
  assert.ok(Math.hypot(x - 1, y - 1) < 0.5 && r.geo.soup.every((c, i) => i % 3 !== 2 || Math.abs(c) < 1e-6), 'relax');
}

// Connect two opposite corners of a quad: it splits into two triangles; two opposite edges: into two quads
assert.deepEqual(sides(connect(two, sel({ verts: [at(two, 0, 0), at(two, 1, 1)] }))!.geo), [3, 3, 4]);
const cut = connect(two, sel({ edges: [[at(two, 0, 0), at(two, 1, 0)], [at(two, 1, 1), at(two, 0, 1)]] }))!;
assert.deepEqual(sides(cut.geo), [4, 4, 4]); facingUp(cut.geo); // the neighbour gains nothing: its edges weren't cut
assert.equal(cut.edges!.length, 1);

// Rotate the edge between two quads: still two quads, joined along another edge
const rot = rotateEdge(two, sel({ edges: [[at(two, 1, 0), at(two, 1, 1)]] }))!;
assert.deepEqual(sides(rot.geo), [4, 4]); facingUp(rot.geo);
assert.ok(rot.edges![0].map((p) => `${p[0]},${p[1]}`).sort().join() !== '1,0,1,1', 'edge moved');

// Merge the two ends of the shared edge: both quads fold into triangles
const mg = merge(two, sel({ verts: [at(two, 1, 0), at(two, 1, 1)] }), false)!;
assert.deepEqual(sides(mg.geo), [3, 3]); assert.ok(vertAt(mg.geo, 1, 0.5));

// Loop cut from the strip's end edge runs through all three quads
const strip = grid([0, 1, 2, 3], [0, 1]);
const lc = loopCut(strip, sel({ edges: [[at(strip, 0, 0), at(strip, 0, 1)]] }))!;
assert.deepEqual(sides(lc.geo), [4, 4, 4, 4, 4, 4]); facingUp(lc.geo); assert.equal(lc.edges!.length, 3);

// Slide the shared edge halfway along its rails
const sl = slide(two, sel({ edges: [[at(two, 1, 0), at(two, 1, 1)]] }), 0.5)!;
assert.ok(vertAt(sl.geo, 0.5, 0) || vertAt(sl.geo, 1.5, 0), 'slid'); facingUp(sl.geo);

// Space: an unevenly spaced bottom row evens out; Straighten: a crooked column lines up
const uneven = grid([0, 0.3, 2, 3], [0, 1]);
const sp = shapeLoop(uneven, sel({ edges: [[at(uneven, 0, 0), at(uneven, 0.3, 0)], [at(uneven, 0.3, 0), at(uneven, 2, 0)], [at(uneven, 2, 0), at(uneven, 3, 0)]] }), 'space')!;
assert.ok(vertAt(sp.geo, 1, 0) && vertAt(sp.geo, 2, 0), 'spaced');
{
  const g = grid([0, 1, 2], [0, 1, 2]), soup = g.soup.slice();
  for (let i = 0; i < soup.length; i += 3) if (soup[i] === 1 && soup[i + 1] === 1) soup[i] = 1.3;
  const bent = { ...g, soup }, c = [at(bent, 1, 0), at(bent, 1.3, 1), at(bent, 1, 2)];
  const st = shapeLoop(bent, sel({ edges: [[c[0], c[1]], [c[1], c[2]]] }), 'straight')!;
  assert.ok(vertAt(st.geo, 1, 1), 'straightened');
}

// Circle: the outline of a 2×2 grid ends up all at one distance from its centre
{
  const g = grid([0, 1, 2], [0, 1, 2]), ring = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]].map(([x, y]) => at(g, x, y));
  const ci = shapeLoop(g, sel({ edges: ring.map((v, i) => [v, ring[(i + 1) % 8]] as [number, number]) }), 'circle')!, t = topoOfSoup(ci.geo.soup);
  const r: number[] = [];
  for (let v = 0; v < t.nv; v++) { const x = t.pos[v * 3] - 1, y = t.pos[v * 3 + 1] - 1; if (Math.hypot(x, y) > 0.1) r.push(Math.hypot(x, y)); }
  assert.ok(r.length === 8 && Math.max(...r) - Math.min(...r) < 1e-5, `circle radii ${Math.min(...r)}..${Math.max(...r)}`);
}

// Grid Fill: a 2×2 grid dissolved into one 8-corner polygon refills as 4 quads; a 2×1 hole in a 4×3 grid as 2 quads
{
  const g = grid([0, 1, 2], [0, 1, 2]), ng = { soup: g.soup, ...dissolveFaces(g.soup, g, all(g))! };
  assert.deepEqual(sides(ng), [8]);
  const gf = gridFill(ng, sel({ faces: [0] }))!;
  assert.deepEqual(sides(gf.geo), [4, 4, 4, 4]); facingUp(gf.geo);
  const holed = grid([0, 1, 2, 3, 4], [0, 1, 2, 3], ['1,1', '2,1']);
  const hole = [[1, 1], [2, 1], [3, 1], [3, 2], [2, 2], [1, 2]].map(([x, y]) => at(holed, x, y));
  const hf = gridFill(holed, sel({ edges: hole.map((v, i) => [v, hole[(i + 1) % 6]] as [number, number]) }))!;
  assert.equal(hf.geo.sides.length, holed.sides.length + 2); facingUp(hf.geo);
  assert.equal(meshCheck(hf.geo).open.length, 14, 'only the outer border stays open');
}

// Mesh check: a turned-over triangle, a doubled one, one with no area; poles on a fan
{
  const g = grid([0, 1, 2, 3], [0, 1]), soup = g.soup.slice();
  soup.set([soup[3], soup[4], soup[5], soup[0], soup[1], soup[2]], 0); // swap two corners of the first triangle
  const m = meshCheck({ ...g, soup });
  assert.equal(m.flipped.length, 1);
  const extra = new Float32Array([...g.soup, ...g.soup.subarray(0, 9), 5, 0, 0, 6, 0, 0, 7, 0, 0]);
  const m2 = meshCheck({ soup: extra, ...ownPolygons(extra.length / 9) });
  assert.equal(m2.duplicate.length, 1); assert.equal(m2.zero.length, 1); assert.ok(m2.nonManifold.length >= 1);
  assert.deepEqual(poles(grid([0, 1, 2, 3], [0, 1, 2, 3])), { regular: 4, low: [], high: [], big: [] });
  const fan: number[] = [];
  for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3, b = (((i + 1) % 6) * Math.PI) / 3; fan.push(0, 0, 0, Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0); }
  const fs = new Float32Array(fan), fp = poles({ soup: fs, ...ownPolygons(6) });
  assert.equal(fp.regular, 6); assert.equal(fp.high.length, 0, 'a 6-valent fan centre is regular for triangles');
  const fan8: number[] = [];
  for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4, b = (((i + 1) % 8) * Math.PI) / 4; fan8.push(0, 0, 0, Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0); }
  const fp8 = poles({ soup: new Float32Array(fan8), ...ownPolygons(8) });
  assert.equal(fp8.regular, 6); assert.equal(fp8.high.length, 1); assert.equal(fp8.big.length, 1);
}
// Even Out: an unevenly spaced strip evens out along its borders (vertices slide on the outline), corners stay
{
  const strip3 = grid([0, 0.3, 2, 3], [0, 1]), r = relax(strip3, sel({ faces: all(strip3) }))!;
  const xs = [...new Set(Array.from({ length: r.geo.soup.length / 3 }, (_, i) => r.geo.soup[i * 3]).map((x) => +x.toFixed(2)))].sort((a, b) => a - b);
  assert.ok(Math.abs(xs[1] - 1) < 0.05 && Math.abs(xs[2] - 2) < 0.05 && xs[0] === 0 && xs[xs.length - 1] === 3, `evened ${xs}`);
  assert.ok(r.geo.soup.every((c, i) => i % 3 !== 1 || Math.abs(c) < 1e-6 || Math.abs(c - 1) < 1e-6), 'stays on its outline');
}
// Loop Cut: two rings crossing the same quad leave no crack (the first ring's halves take the second's point)
{
  const g = grid([0, 1, 2, 3], [0, 1, 2, 3]), r = loopCut(g, sel({ edges: [[at(g, 0, 1), at(g, 1, 1)], [at(g, 1, 0), at(g, 1, 1)]] }))!;
  const rim = (x: Geo) => { const P = topoOfSoup(x.soup).pos; return meshCheck(x).open.reduce((s, [a, b]) => s + Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1]), 0); };
  assert.ok(Math.abs(rim(r.geo) - 12) < 1e-5 && !meshCheck(r.geo).nonManifold.length, `crossing loop cuts crack: rim ${rim(r.geo)}`);
}
// Add Loops on a faceted curve: a 12-sided prism (wide faces at 30°) gets a loop through each face, its points
// on the circle; a flat grid has no curve edges at all
{
  const ring: number[] = [], R = 1, pt = (i: number, z: number) => [R * Math.cos((i * Math.PI) / 6), R * Math.sin((i * Math.PI) / 6), z];
  for (let i = 0; i < 12; i++) { const [a, b, c, d] = [pt(i, 0), pt((i + 1) % 12, 0), pt((i + 1) % 12, 2), pt(i, 2)]; ring.push(...a, ...b, ...c, ...a, ...c, ...d); }
  const soup = new Float32Array(ring), g: Geo = { soup, poly: Int32Array.from({ length: 24 }, (_, t) => t >> 1), sides: new Int32Array(12).fill(4) };
  assert.ok(curveEdges(g).length === 12 && curveEdges(g).every((e) => e.even), 'twelve 30° edges between even faces');
  assert.equal(curveEdges(grid([0, 1, 2], [0, 1])).length, 0);
  const r = addLoops(g, sel({ faces: all(g) }))!, t = topoOfSoup(r.geo.soup);
  const radii = Array.from({ length: t.nv }, (_, v) => Math.hypot(t.pos[v * 3], t.pos[v * 3 + 1]));
  assert.ok(r.geo.sides.length === 24 && radii.every((x) => Math.abs(x - 1) < 1e-5), `new loops lie on the circle: ${radii.map((x) => x.toFixed(3))}`);
}
// Clean Vertices: a dot inside a dissolved 2×2 patch and the in-line corners round its outline go; a quad is left, unmoved
{
  const g = grid([0, 1, 2], [0, 1, 2]), ng = { soup: g.soup, ...dissolveFaces(g.soup, g, all(g))! }, r = cleanVerts(ng, sel({}))!;
  assert.deepEqual(sides(r.geo), [4]); facingUp(r.geo);
  assert.ok(!vertAt(r.geo, 1, 1) && !vertAt(r.geo, 1, 0) && vertAt(r.geo, 2, 2), 'only the dots that shape nothing go');
  assert.equal(cleanVerts(grid([0, 1, 2], [0, 1]), sel({})), null, 'a corner two polygons need stays');
}

// Knife: bottom edge of one quad to the top edge of the next cuts both, crossing the shared edge at its middle
{
  const g = grid([0, 1, 2], [0, 1]), k = knifeOn(g), down: [number, number, number] = [0, 0, -1];
  const tri = (x: number, y: number) => all(g).find((f) => { const p = g.soup.subarray(f * 9, f * 9 + 9), s = (i: number, j: number) => (p[j * 3] - p[i * 3]) * (y - p[i * 3 + 1]) - (p[j * 3 + 1] - p[i * 3 + 1]) * (x - p[i * 3]); return s(0, 1) >= 0 && s(1, 2) >= 0 && s(2, 0) >= 0; })!;
  const pt = (x: number, y: number) => ({ p: k.snap(tri(x, y), [x, y + 0.01, 0], 0.05) as [number, number, number], f: tri(x, y), ray: down });
  const r = k.cut([pt(0.5, 0.01), pt(1.5, 0.98)])!;
  assert.deepEqual(sides(r.geo), [3, 3, 5, 5]); facingUp(r.geo);
  assert.ok(vertAt(r.geo, 1, 0.5) && vertAt(r.geo, 0.5, 0) && r.edges!.length === 2, 'cut through the middle of the shared edge');
  // a click inside the first quad bends the cut there: that corner is new and the quad still splits
  const b = k.cut([pt(0.5, 0.01), { p: [0.4, 0.6, 0], f: tri(0.4, 0.6), ray: down }, pt(0.5, 0.98)])!;
  assert.ok(vertAt(b.geo, 0.4, 0.6) && b.geo.sides.length === 3, `bent cut: ${sides(b.geo)}`);
  // two clicks inside one quad: the cut runs on to its edges and splits it, with no dot left where the clicks were
  const inner = k.cut([{ p: [0.2, 0.5, 0], f: tri(0.2, 0.5), ray: down }, { p: [0.8, 0.5, 0], f: tri(0.8, 0.5), ray: down }])!;
  assert.ok(inner && vertAt(inner.geo, 0, 0.5) && vertAt(inner.geo, 1, 0.5) && !vertAt(inner.geo, 0.2, 0.5), 'cut runs on to the outline');
  assert.deepEqual(sides(inner.geo), [4, 4, 5]); facingUp(inner.geo);
}
// UVs carried through a cut: a 6×3 grid, each column its own island (10 apart in UV), cut corner to corner across every
// seam; each corner keeps its own side's UV, a new vertex on a seam gets one per side
{
  const g = grid([0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3]), down: [number, number, number] = [0, 0, -1], k = knifeOn(g);
  const n = g.soup.length / 9, cx = (f: number) => (g.soup[f * 9] + g.soup[f * 9 + 3] + g.soup[f * 9 + 6]) / 3;
  const island = Array.from({ length: n }, (_, f) => Math.floor(cx(f)));
  const uvs = Array.from({ length: n * 6 }, (_, i) => { const f = (i / 6) | 0, c = ((i % 6) / 2) | 0; return i % 2 ? g.soup[f * 9 + c * 3 + 1] : g.soup[f * 9 + c * 3] + 10 * island[f]; });
  const old = { positions: Array.from(g.soup), island, stretch: Array(n).fill(0), source: all(g) };
  const tri = (x: number, y: number) => all(g).find((f) => { const p = g.soup.subarray(f * 9, f * 9 + 9), s = (i: number, j: number) => (p[j * 3] - p[i * 3]) * (y - p[i * 3 + 1]) - (p[j * 3 + 1] - p[i * 3 + 1]) * (x - p[i * 3]); return s(0, 1) >= 0 && s(1, 2) >= 0 && s(2, 0) >= 0; })!;
  const r = k.cut([{ p: [0.5, 0, 0], f: tri(0.5, 0.1), ray: down }, { p: [5.5, 3, 0], f: tri(5.5, 2.9), ray: down }])!;
  assert.ok(r.origin && r.edges!.length >= 6, 'a cut moves nothing');
  const c = carryUVs(old, uvs, r.geo.soup, r.origin, g.poly)!;
  for (let f = 0; f < c.island.length; f++) for (let j = 0; j < 3; j++) {
    const x = c.positions[f * 9 + j * 3], y = c.positions[f * 9 + j * 3 + 1], side = c.island[f];
    assert.ok(Math.abs(c.uvs[f * 6 + j * 2] - (x + 10 * side)) < 1e-4 && Math.abs(c.uvs[f * 6 + j * 2 + 1] - y) < 1e-4, `corner (${x}, ${y}) of a triangle on island ${side}`);
  }
  assert.equal(new Set(c.island).size, 6);
  // a polygon the engine left out of the output (all its triangles zero-area) doesn't stop the carry: the rest still
  // keeps its UVs (Grip_Low had one, and the whole part went mesh-only)
  const gone = g.poly[tri(5.5, 0.5)], kept = all(g).filter((f) => g.poly[f] !== gone);
  const lean = { positions: kept.flatMap((f) => Array.from(g.soup.subarray(f * 9, f * 9 + 9))), island: kept.map((f) => island[f]), stretch: kept.map(() => 0), source: kept };
  const d = carryUVs(lean, kept.flatMap((f) => uvs.slice(f * 6, f * 6 + 6)), r.geo.soup, r.origin, g.poly);
  assert.ok(d, 'carried past a polygon with no output triangles');
  for (let f = 0; f < d.island.length; f++) if (r.origin[f] !== gone) for (let j = 0; j < 3; j++) {
    const x = d.positions[f * 9 + j * 3], y = d.positions[f * 9 + j * 3 + 1];
    assert.ok(Math.abs(d.uvs[f * 6 + j * 2] - (x + 10 * d.island[f])) < 1e-4 && Math.abs(d.uvs[f * 6 + j * 2 + 1] - y) < 1e-4, `corner (${x}, ${y}) beside the missing polygon`);
  }
}
console.log('polygeo ok');
