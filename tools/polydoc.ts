// Poly Doc without the editor, for agents: the same Health rules and fixes as the workspace, run headless on an FBX,
// reported one line per part so a run costs a few hundred tokens.
//   node tools/polydoc.ts <in.fbx> [--do OP]... [--detail] [-o out.fbx]
// OPs, applied in order to every part (each guarded: refused on a part if it'd turn more faces red or add open / non-manifold edges):
//   quads              Tris to Quads on lone triangles (regroup)
//   dissolve[:deg]     Limited Dissolve, default 5° (regroup)
//   tri:RULE[,RULE]    Triangulate the polygons those rules flag red whose triangles come out fine (e.g. tri:quadWarp,ngonBent)
//   defacet            Add Loops on Curve: a loop through each quad Faceted curve flags red, its points on the arc
//   relax[:RULE,..]    Even Out (moves vertices, kept on the surface): the whole part, or Relax Around the polygons those rules flag red
//   clean              duplicate faces: the copy in the bigger polygon goes; a back-to-back pair (a folded zero-area flap) both go
//   weld:DIST          Merge by Distance: each cluster of edges shorter than DIST (file units) collapses to a point
//   flip               n-gons with slivers (earcut clips zero-area ears at corners in a line) re-triangulated by Lawson
//                      flips: same polygons, same points, and nothing for the engine to drop at export
//   degen[:ratio]      Degenerate Dissolve: each polygon with area < ratio × perimeter² (default 1e-3: a sliver
//                      or corners in a line) collapses its shortest edge (Poly Doc's Collapse Shortest Edge cure)
//   delpoly:ID[,ID]    delete polygons by id (ids as --detail prints them, p12 → 12): internal caps, stray faces
// --part NAME scopes the --do ops after it to one part (--part '*' for all again).
// -o unwraps every part with the engine (ENGINE, default http://localhost:3000; `pnpm server`) and writes the FBX.
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { bake, fbxUnit, toFbx } from '../src/files.ts';
import { fbxPolygons, polygonOfTriangles } from '../src/fbxpoly.ts';
import { healthReport, healthSummary, RULES, setModelSize, type RuleId } from '../src/health.ts';
import { compact, limitedDissolve, outline, ownPolygons, topoOfSoup, triangulate, trisToQuads, type Polys } from '../src/polyedit.ts';
import { addLoops, loopOf, members, merge, meshCheck, relax, type Geo } from '../src/polygeo.ts';
import { polygonsOf } from '../src/topo.ts';
import { shapeBadness, type V } from '../src/quality.ts';
import type { Output } from '../src/api.ts';

const args = process.argv.slice(2), ops: [string, string][] = [];
let scope = '*', input = '', output = '', detail = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--do') ops.push([scope, args[++i]]);
  else if (args[i] === '--part') scope = args[++i];
  else if (args[i] === '-o') output = args[++i];
  else if (args[i] === '--detail') detail = true;
  else input = args[i];
}
if (!input) { console.log('usage: node tools/polydoc.ts <in.fbx> [--do quads|dissolve[:deg]|tri:RULE,..|relax[:rounds]]... [--detail] [-o out.fbx]'); process.exit(1); }

// ---- load (files.readParts, minus the browser) ----
const file = readFileSync(input), buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
const root = new FBXLoader().parse(buf, '');
root.updateMatrixWorld(true);
const fp = await fbxPolygons(buf), unit = fbxUnit(buf), parts: { name: string; g: Geo }[] = [];
root.traverse((m) => {
  if (!(m instanceof THREE.Mesh)) return;
  const soup = bake(m);
  if (!soup.length) return;
  const polys = fp.get((m as THREE.Mesh & { ID?: number }).ID ?? NaN);
  const raw = polys && (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry).attributes.position.array;
  const poly = polys && raw && polygonOfTriangles(polys, raw);
  parts.push({ name: m.name || `Part ${parts.length + 1}`, g: { soup, ...(poly ? { poly, sides: Int32Array.from(polys!, (c) => c.length) } : ownPolygons(soup.length / 9)) } });
});

setModelSize(parts.map((p) => p.g.soup)); // density is judged at the whole model's scale

// ---- look ----
const red = (g: Geo) => [...healthReport(g).issues.values()].filter((is) => is.some((i) => i.score >= 0.6)).length;
/** Non-manifold edges, and the open rims' length (splitting a rim edge isn't a new hole). */
/** The rules that flag more polygons red in `b` than in `a`. */
const worse = (a: Geo, b: Geo) => {
  const n = (g: Geo) => { const c = new Map<string, number>(); for (const is of healthReport(g).issues.values()) for (const i of is) if (i.score >= 0.6) c.set(i.rule, (c.get(i.rule) ?? 0) + 1); return c; };
  const [x, y] = [n(a), n(b)];
  return [...y].filter(([r, k]) => k > (x.get(r) ?? 0)).map(([r, k]) => `${r} ${x.get(r) ?? 0}→${k}`).join(', ');
};
const holes = (g: Geo) => {
  const m = meshCheck(g), P = topoOfSoup(g.soup).pos, d = ([a, b]: [number, number]) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
  return { nm: m.nonManifold.length, rim: m.open.reduce((s, e) => s + d(e), 0) };
};
function line(name: string, g: Geo) {
  const k = [0, 0, 0];
  for (const n of g.sides) k[n === 3 ? 0 : n === 4 ? 1 : 2]++;
  const m = meshCheck(g), broken = Object.entries({ nonManifold: m.nonManifold.length, open: m.open.length, flipped: m.flipped.length, zero: m.zero.length, duplicate: m.duplicate.length })
    .filter(([, n]) => n).map(([r, n]) => `${r} ${n}`).join(', ');
  const fix = new Map<RuleId, number>(), look = new Map<RuleId, number>(), worst: string[] = [];
  for (const [p, is] of healthReport(g).issues) for (const i of is) {
    const to = i.score >= 0.6 ? fix : look;
    to.set(i.rule, (to.get(i.rule) ?? 0) + 1);
    if (detail && i.score >= 0.6 && worst.length < 6) worst.push(`  p${p} ${i.rule}: ${i.value}`);
  }
  const list = (m: Map<RuleId, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ') || '-';
  const s = healthSummary({ positions: g.soup } as never, healthReport(g).score), pc = (x: number) => `${Math.round(x * 100)}%`;
  console.log(`${name}: ${k[0]}t ${k[1]}q ${k[2]}n | mesh: ${broken || 'ok'} | red: ${list(fix)} | yellow: ${list(look)} | area ${pc(s.solid)} ok ${pc(s.look)} look ${pc(s.fix)} fix`);
  if (worst.length) console.log(worst.join('\n'));
}

// ---- fix ----
const all = (g: Geo) => Array.from({ length: g.poly.length }, (_, i) => i);
const regroup = (g: Geo, p: Polys | null): Geo | null => p && { soup: g.soup, ...p };
/** The part without these soup triangles; a polygon that lost some keeps its outline's corner count, or falls apart
 *  into triangles if what's left isn't one simple loop. */
function drop(g: Geo, gone: Set<number>): Geo | null {
  if (!gone.size) return null;
  const keep = Array.from({ length: g.poly.length }, (_, f) => f).filter((f) => !gone.has(f)), soup = new Float32Array(keep.length * 9);
  keep.forEach((f, i) => soup.set(g.soup.subarray(f * 9, f * 9 + 9), i * 9));
  const poly = Int32Array.from(keep, (f) => g.poly[f]), sides = new Map<number, number>(), hit = new Set([...gone].map((f) => g.poly[f]));
  g.sides.forEach((n, p) => sides.set(p, n));
  const t = topoOfSoup(soup);
  let id = g.sides.length;
  for (const p of hit) {
    const tris = keep.flatMap((_, i) => (poly[i] === p ? [i] : []));
    const n = tris.length ? outline(t, tris) : 0;
    if (n) sides.set(p, n);
    else { sides.delete(p); for (const i of tris) { poly[i] = id; sides.set(id++, 3); } }
  }
  return { soup, ...compact(poly, sides) };
}

/** The polygons these rules (comma list) flag red. */
const flagged = (g: Geo, rules: string) => { const r = new Set(rules.split(',')); return [...healthReport(g).issues].filter(([, is]) => is.some((i) => r.has(i.rule) && i.score >= 0.6)).map(([p]) => p); };

function run(op: string, g: Geo): Geo | null {
  const [name, arg] = op.split(':');
  if (name === 'quads') return regroup(g, trisToQuads(g.soup, g, all(g)));
  if (name === 'dissolve') return regroup(g, limitedDissolve(g.soup, g, all(g), arg ? +arg : 5));
  if (name === 'tri') {
    // only polygons whose own triangles come out fine (a skewed quad split in two is two slivers)
    const S = g.soup, corner = (f: number, k: number): V => [S[f * 9 + k * 3], S[f * 9 + k * 3 + 1], S[f * 9 + k * 3 + 2]];
    const mem = members(g.poly), ok = flagged(g, arg).filter((p) => mem.get(p)!.every((f) => shapeBadness([0, 1, 2].map((k) => corner(f, k))) < 0.6));
    const hit = new Set(ok);
    return regroup(g, triangulate(g, all(g).filter((f) => hit.has(g.poly[f]))));
  }
  if (name === 'clean') {
    const size = (f: number) => g.sides[g.poly[f]], gone = new Set<number>(), t = topoOfSoup(g.soup), first = new Map<string, number>();
    for (let f = 0; f < g.poly.length; f++) {
      const k = [0, 1, 2].map((c) => t.vid[f * 3 + c]).sort((a, b) => a - b).join(), o = first.get(k);
      if (o === undefined) { first.set(k, f); continue; }
      // wound the other way: a zero-area flap folded back onto itself (a degenerate face against a polygon's sliver), both go
      const same = [0, 1, 2].some((c) => t.vid[o * 3] === t.vid[f * 3 + c] && t.vid[o * 3 + 1] === t.vid[f * 3 + (c + 1) % 3]);
      if (same) gone.add(size(f) >= size(o) ? f : o); else gone.add(f).add(o);
    }
    return drop(g, gone);
  }
  if (name === 'weld') {
    const t = topoOfSoup(g.soup), P = t.pos, edges: [number, number][] = [];
    for (let e = 0; e < t.ends.length / 2; e++) {
      const a = t.ends[e * 2], b = t.ends[e * 2 + 1];
      if (Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]) < +arg) edges.push([a, b]);
    }
    return edges.length ? merge(g, { faces: [], verts: [], edges }, true)?.geo ?? null : null;
  }
  if (name === 'flip') {
    // Lawson flips inside each polygon that has a sliver: an inside diagonal flips while that raises the smaller
    // corner angle of its two triangles (each flip raises the sorted angles, so it ends): a run of corners in a
    // line gets fanned from a far corner instead of clipped into zero-area ears
    const S = g.soup.slice(), at = (f: number, k: number): V => [S[f * 9 + k * 3], S[f * 9 + k * 3 + 1], S[f * 9 + k * 3 + 2]];
    const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], d = (a: V, b: V) => Math.hypot(...sub(a, b));
    const cr = (a: V, b: V, c: V): V => { const u = sub(b, a), w = sub(c, a); return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; };
    const ang = (a: V, b: V, c: V) => { const u = sub(b, a), w = sub(c, a); return Math.atan2(Math.hypot(...cr(a, b, c)), u[0] * w[0] + u[1] * w[1] + u[2] * w[2]); };
    const low = (P: V[]) => Math.min(ang(P[0], P[1], P[2]), ang(P[1], P[2], P[0]), ang(P[2], P[0], P[1]));
    const thin = (P: V[]) => { const l = Math.max(d(P[0], P[1]), d(P[1], P[2]), d(P[2], P[0])); return Math.hypot(...cr(P[0], P[1], P[2])) / 2 < 1e-3 * l * l; };
    const key = (p: V) => p.join(), tri = (f: number) => [0, 1, 2].map((k) => at(f, k));
    const mem = members(g.poly), polys = [...mem].filter(([q, fs]) => g.sides[q] > 4 && fs.some((f) => thin(tri(f))));
    const normal = new Map(polys.map(([q, fs]) => [q, fs.reduce((n, f) => { const c = cr(...(tri(f) as [V, V, V])); return [n[0] + c[0], n[1] + c[1], n[2] + c[2]] as V; }, [0, 0, 0] as V)]));
    let flips = 0;
    for (;;) {
      const byEdge = new Map<string, number[]>();
      for (const [, fs] of polys) for (const f of fs) for (let k = 0; k < 3; k++) { const e = [key(at(f, k)), key(at(f, (k + 1) % 3))].sort().join('|'); (byEdge.get(e) ?? byEdge.set(e, []).get(e)!).push(f); }
      const flip = () => {
        for (const [q, fs] of polys) for (const f of fs) for (let k = 0; k < 3; k++) {
          const F = tri(f), p = F[k], r = F[(k + 1) % 3], b = F[(k + 2) % 3];
          const h = byEdge.get([key(p), key(r)].sort().join('|'))!.find((x) => x !== f && g.poly[x] === q);
          if (h === undefined) continue;
          const H = tri(h), x = H.find((c) => key(c) !== key(p) && key(c) !== key(r))!, n = normal.get(q)!;
          const A: V[] = [p, x, b], B: V[] = [x, r, b], up = (P: V[]) => { const c = cr(P[0], P[1], P[2]); return c[0] * n[0] + c[1] * n[1] + c[2] * n[2] > 0; };
          if (!up(A) || !up(B) || Math.min(low(A), low(B)) <= Math.min(low(F), low(H)) + 1e-9) continue;
          S.set(A.flat(), f * 9); S.set(B.flat(), h * 9);
          return true;
        }
        return false;
      };
      if (!flip()) break; // ponytail: re-indexes per flip, O(flips × sliver polygons); fine at game-asset sizes
      flips++;
    }
    return flips ? { soup: S, poly: g.poly, sides: g.sides } : null;
  }
  if (name === 'degen') {
    const t = topoOfSoup(g.soup), P = t.pos, d = (a: number, b: number) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    const S = g.soup, area = (f: number) => { const o = f * 9, u = [S[o + 3] - S[o], S[o + 4] - S[o + 1], S[o + 5] - S[o + 2]], v = [S[o + 6] - S[o], S[o + 7] - S[o + 1], S[o + 8] - S[o + 2]];
      return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; };
    const edges: [number, number][] = [];
    for (const [, tris] of members(g.poly)) {
      const l = loopOf(t, tris);
      if (!l) continue;
      const sides = l.map((v, i) => [v, l[(i + 1) % l.length]] as [number, number]), per = sides.reduce((s, [a, b]) => s + d(a, b), 0);
      if (tris.reduce((s, f) => s + area(f), 0) < (arg ? +arg : 1e-3) * per * per) edges.push(sides.reduce((m, e) => (d(...e) < d(...m) ? e : m)));
    }
    return edges.length ? merge(g, { faces: [], verts: [], edges }, true)?.geo ?? null : null;
  }
  if (name === 'delpoly') { const ids = new Set(arg.split(',').map(Number)); return drop(g, new Set(all(g).filter((f) => ids.has(g.poly[f])))); }
  if (name === 'defacet') { const hit = new Set(flagged(g, 'faceted')); return addLoops(g, { faces: all(g).filter((f) => hit.has(g.poly[f])), verts: [], edges: [] })?.geo ?? null; }
  if (name === 'relax') {
    if (!arg) return relax(g, { faces: all(g), verts: [], edges: [] })?.geo ?? null;
    // Relax Around: the flagged polygons and the ring of polygons round them
    const t = topoOfSoup(g.soup), hit = new Set(flagged(g, arg)), near = new Set<number>(), around = new Set<number>();
    for (const f of all(g)) if (hit.has(g.poly[f])) for (let k = 0; k < 3; k++) near.add(t.vid[f * 3 + k]);
    for (const f of all(g)) if ([0, 1, 2].some((k) => near.has(t.vid[f * 3 + k]))) around.add(g.poly[f]);
    return around.size ? relax(g, { faces: all(g).filter((f) => around.has(g.poly[f])), verts: [], edges: [] })?.geo ?? null : null;
  }
  throw new Error(`unknown op ${op} (rules: ${Object.keys(RULES).join(' ')})`);
}

for (const [only, op] of ops) {
  const notes: string[] = [];
  for (const p of parts) {
    if (only !== '*' && only !== p.name) continue;
    const next = run(op, p.g);
    if (!next) continue;
    const was = red(p.g), now = red(next);
    if (now > was) { notes.push(`${p.name} refused (+${now - was} red: ${worse(p.g, next)})`); continue; }
    const [h0, h1] = [holes(p.g), holes(next)];
    if (h1.nm > h0.nm || h1.rim > h0.rim * 1.01 + 1e-9) { notes.push(`${p.name} refused (${h1.nm > h0.nm ? `+${h1.nm - h0.nm} non-manifold edges` : 'opens the mesh'})`); continue; }
    notes.push(`${p.name} ${p.g.sides.length}→${next.sides.length} polys, red ${was}→${now}`);
    p.g = next;
  }
  console.log(`# ${only === '*' ? '' : only + ' '}${op}: ${notes.join('; ') || 'nothing changed'}`);
}
for (const p of parts) line(p.name, p.g);

// ---- export (store.exportFbx: unwrap, then the polygons back out) ----
if (output) {
  const engine = process.env.ENGINE ?? 'http://localhost:3000';
  const r = await fetch(`${engine}/api/unwrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    parts: parts.map((p) => ({ name: p.name, positions: Array.from(p.g.soup), seams: [], polys: Array.from(p.g.poly) })),
    params: { sharp: 45, tol: 0.08, seam_weight: 0.1, join: true, one_atlas: false } }) }).catch((e) => { throw new Error(`engine not reachable at ${engine} (pnpm server): ${e.message}`); });
  if (!r.ok) throw new Error(`engine: ${r.status} ${await r.text()}`);
  const res = (await r.json()) as Output;
  writeFileSync(output, toFbx(parts.map((p, i) => ({ name: p.name, material: p.name, out: res.parts[i], uv: new Float32Array(res.parts[i].uvs),
    faces: polygonsOf(res.parts[i].source, p.g.poly) })), 45, unit));
  console.log(`wrote ${output} (${res.stats.islands} islands, mean stretch ${res.stats.mean_stretch.toFixed(3)})`);
  // polygons the export had to write as triangles (files.faceLoops): an outline the engine broke by dropping a
  // zero-area triangle, or a UV seam inside
  parts.forEach((p, i) => {
    const o = res.parts[i], t = topoOfSoup(new Float32Array(o.positions)), op = Int32Array.from(o.source, (s) => p.g.poly[s]);
    const uv = (f: number, v: number) => { const c = [0, 1, 2].find((k) => t.vid[f * 3 + k] === v)!; return `${o.uvs[(f * 3 + c) * 2]},${o.uvs[(f * 3 + c) * 2 + 1]}`; };
    let broken = 0, seamed = 0;
    for (const [q, tris] of members(op)) {
      if (tris.length < 2) continue;
      if (!outline(t, tris)) { broken++; continue; }
      if (tris.some((f) => [0, 1, 2].some((k) => t.edgeTris[t.edge[f * 3 + k]].some((g) => g !== f && op[g] === q && [t.vid[f * 3 + k], t.vid[f * 3 + (k + 1) % 3]].some((v) => uv(f, v) !== uv(g, v)))))) seamed++;
    }
    if (broken || seamed) console.log(`  ${p.name}: ${broken + seamed} polygons go out as triangles (${broken} outline broken by dropped zero-area triangles: try flip; ${seamed} with a seam inside)`);
  });
}
