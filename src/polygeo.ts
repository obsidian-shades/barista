// Poly Doc's tools that move or add geometry (unlike polyedit's, which only regroup triangles): the part's soup changes,
// so the part is unwrapped again after. They work on polygons as Blender sees them: an edge inside a polygon (a quad's
// diagonal) isn't an edge. Vertices are the soup's welded vertices (`topoOfSoup`). A tool returns the new geometry and
// what to select after, by position (the store finds those again in the re-unwrapped part).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { compact, outline, topoOfSoup, type Polys } from './polyedit.ts';
import { edgeBetween, trisOf, type Topo } from './topo.ts';
import { cross, dot, len, shapeBadness, sub } from './quality.ts';

export interface Geo extends Polys { soup: Float32Array }
/** A selection in soup terms: triangles, welded vertices, and edges as vertex pairs (only edges you can see). */
export interface Sel { faces: number[]; verts: number[]; edges: [number, number][] }
type V3 = [number, number, number];
/** What a tool made: the geometry, and what to select in it after, by position (faces: soup triangles of the new soup). */
export interface Done { geo: Geo; faces?: number[]; verts?: V3[]; edges?: [V3, V3][] }

/** A polygon's outline as welded vertex ids in winding order, or null if it isn't one simple loop. */
export function loopOf(t: Topo, tris: number[]): number[] | null {
  const dir = new Set<string>(), next = new Map<number, number>();
  for (const f of tris) for (let k = 0; k < 3; k++) dir.add(`${t.vid[f * 3 + k]},${t.vid[f * 3 + (k + 1) % 3]}`);
  for (const f of tris) for (let k = 0; k < 3; k++) {
    const a = t.vid[f * 3 + k], b = t.vid[f * 3 + (k + 1) % 3];
    if (dir.has(`${b},${a}`)) continue;
    if (next.has(a)) return null;
    next.set(a, b);
  }
  if (!next.size) return null;
  const loop = [next.keys().next().value!];
  while (loop.length <= next.size) { const v = next.get(loop[loop.length - 1]); if (v === undefined || v === loop[0]) break; loop.push(v); }
  return loop.length === next.size ? loop : null;
}

export const members = (poly: Int32Array) => {
  const m = new Map<number, number[]>();
  poly.forEach((p, f) => (m.get(p) ?? m.set(p, []).get(p)!).push(f));
  return m;
};

/** Polygon lookups on a part: each polygon's triangles and outline, and the polygons on an edge. */
class Mesh {
  g: Geo; t: Topo; m: Map<number, number[]>; loops = new Map<number, number[] | null>();
  constructor(g: Geo) { this.g = g; this.t = topoOfSoup(g.soup); this.m = members(g.poly); }
  loop(p: number) { if (!this.loops.has(p)) this.loops.set(p, loopOf(this.t, this.m.get(p) ?? [])); return this.loops.get(p)!; }
  /** The polygons on the edge between two vertices (one on an open edge, none if there's no such edge). */
  polysOn(a: number, b: number) { const e = edgeBetween(this.t, a, b); return e < 0 ? [] : [...new Set(this.t.edgeTris[e].map((f) => this.g.poly[f]))]; }
  /** The polygon holding the directed edge a→b in its outline, or −1. */
  polyWith(a: number, b: number) {
    for (const p of this.polysOn(a, b)) { const l = this.loop(p); if (l && l[(l.indexOf(a) + 1) % l.length] === b) return p; }
    return -1;
  }
  pos(v: number): V3 { return [this.t.pos[v * 3], this.t.pos[v * 3 + 1], this.t.pos[v * 3 + 2]]; }
}

const lerp = (a: V3, b: V3, f: number): V3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
const f32 = (p: V3): V3 => [Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])];

/** Newell normal of a loop of points (its area-weighted facing). */
function newell(P: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  P.forEach((a, i) => { const b = P[(i + 1) % P.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); });
  return n;
}

/** A loop (vertex ids into `pos`) cut into triangles facing the loop's way: a quad along its shorter diagonal, more
 *  corners by ear clipping in the loop's plane. */
function triangulate(pos: (v: number) => V3, loop: number[]): [number, number, number][] {
  if (loop.length === 3) return [[loop[0], loop[1], loop[2]]];
  const P = loop.map(pos);
  if (loop.length === 4) {
    return len(sub(P[0], P[2])) <= len(sub(P[1], P[3])) ? [[loop[0], loop[1], loop[2]], [loop[0], loop[2], loop[3]]] : [[loop[0], loop[1], loop[3]], [loop[1], loop[2], loop[3]]];
  }
  const n = newell(P), ref = Math.abs(n[0]) < 0.9 * len(n) ? [1, 0, 0] as V3 : [0, 1, 0] as V3, u = cross(n, ref), w = cross(n, u);
  const flat = P.map((p) => new THREE.Vector2(dot(p, u), dot(p, w)));
  const out = THREE.ShapeUtils.triangulateShape(flat, []).map(([a, b, c]) => [loop[a], loop[b], loop[c]] as [number, number, number]);
  // ear clipping may hand the triangles back the other way round: turn them to face the loop's normal
  return out.map((tri) => (dot(cross(sub(pos(tri[1]), pos(tri[0])), sub(pos(tri[2]), pos(tri[0]))), n) < 0 ? [tri[0], tri[2], tri[1]] : tri));
}

/** The new part: polygons in `replace` become the loops given (several, or none), `add` loops are new polygons, and any
 *  other polygon's triangle on an edge in `mids` splits at that edge's new vertex (the polygon gains a corner). `pos`
 *  is every vertex's position, old ids first. Returns the geometry and, per new loop, its triangles in the new soup. */
function rebuild(M: Mesh, pos: V3[], replace: Map<number, number[][]>, mids: Map<string, number>, add: number[][] = []) {
  const tris: number[][] = [], poly: number[] = [], sides = new Map<number, number>(), grew = new Map<number, Set<string>>();
  M.g.sides.forEach((n, p) => { if (!replace.has(p)) sides.set(p, n); });
  for (let f = 0; f < M.g.poly.length; f++) {
    const p = M.g.poly[f];
    if (replace.has(p)) continue;
    const queue = [[M.t.vid[f * 3], M.t.vid[f * 3 + 1], M.t.vid[f * 3 + 2]]];
    while (queue.length) {
      const tri = queue.pop()!, k = [0, 1, 2].find((k) => mids.has(ekey(tri[k], tri[(k + 1) % 3])));
      if (k === undefined) { tris.push(tri); poly.push(p); continue; }
      const a = tri[k], b = tri[(k + 1) % 3], c = tri[(k + 2) % 3], v = mids.get(ekey(a, b))!;
      (grew.get(p) ?? grew.set(p, new Set()).get(p)!).add(ekey(a, b));
      queue.push([a, v, c], [v, b, c]);
    }
  }
  for (const [p, cut] of grew) sides.set(p, sides.get(p)! + cut.size);
  let id = M.g.sides.length;
  const made: number[][] = [];
  for (const loop of [...[...replace.values()].flat(), ...add]) {
    const first = tris.length;
    for (const tri of triangulate((v) => pos[v], loop)) { tris.push(tri); poly.push(id); }
    sides.set(id++, loop.length);
    made.push(Array.from({ length: tris.length - first }, (_, i) => first + i));
  }
  const soup = new Float32Array(tris.length * 9);
  tris.forEach((tri, f) => tri.forEach((v, k) => soup.set(pos[v], f * 9 + k * 3)));
  return { geo: { soup, ...compact(Int32Array.from(poly), sides) }, made };
}

/** Every vertex's position, as a list rebuild can grow. */
const positions = (M: Mesh): V3[] => Array.from({ length: M.t.nv }, (_, v) => M.pos(v));
/** The same triangles with some vertices moved (`moved`: vertex → new position). */
function moveVerts(M: Mesh, moved: Map<number, V3>): Geo {
  const soup = Float32Array.from({ length: M.g.soup.length }, (_, i) => {
    const v = M.t.vid[(i / 3) | 0], p = moved.get(v);
    return p ? p[i % 3] : M.g.soup[i];
  });
  return { soup, poly: M.g.poly, sides: M.g.sides };
}

/** The part's surface as it was, to put moved points back on. */
function onSurface(soup: Float32Array) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(soup.slice(), 3));
  const bvh = new MeshBVH(geo), q = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  return (p: V3): V3 => { bvh.closestPointToPoint(q.set(p[0], p[1], p[2]), hit); return [hit.point.x, hit.point.y, hit.point.z]; };
}

/** The selected edges as chains of vertices: open paths end to end, or closed loops (last vertex joins the first). */
function chains(edges: [number, number][]): { verts: number[]; closed: boolean }[] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
  const seen = new Set<number>(), out: { verts: number[]; closed: boolean }[] = [];
  const walk = (start: number) => {
    const verts = [start];
    seen.add(start);
    for (let cur = start, prev = -1; ;) {
      const next = adj.get(cur)!.find((w) => w !== prev && !seen.has(w));
      if (next === undefined) break;
      seen.add(next); verts.push(next); prev = cur; cur = next;
    }
    const closed = verts.length > 2 && adj.get(verts[verts.length - 1])!.includes(start);
    out.push({ verts, closed });
  };
  for (const [v, n] of adj) if (!seen.has(v) && n.length === 1) walk(v); // paths from their ends
  for (const v of adj.keys()) if (!seen.has(v)) walk(v); // what's left is loops
  return out.filter((c) => c.verts.length > 1 && [...c.verts].every((v) => adj.get(v)!.length <= 2));
}

// ---- reshape ----

/** Even Out (Relax): spreads the selected polygons' vertices evenly without changing the shape. Inside vertices move
 *  toward the middle of their polygon-edge neighbours and are put back on the original surface; vertices on a feature
 *  line (the selection's border, an open edge, a crease sharper than `crease`°) slide along that line instead, put back
 *  on it, so outlines and hard edges keep their exact course; corners (where a line turns more than 35°, or lines meet)
 *  stay. `slide` false: the selection's border stays put too. Runs `iterations` rounds (enough to settle). */
export function relax(g: Geo, s: Sel, iterations = 30, slide = true, crease = 35): Done | null {
  const M = new Mesh(g), t = M.t, sel = new Set<number>(), picked = new Set(s.faces.map((f) => g.poly[f]));
  g.poly.forEach((p, f) => { if (picked.has(p)) sel.add(f); });
  if (!sel.size) return null;
  const normal = (f: number) => { const n = cross(sub(M.pos(t.vid[f * 3 + 1]), M.pos(t.vid[f * 3])), sub(M.pos(t.vid[f * 3 + 2]), M.pos(t.vid[f * 3]))); const l = len(n) || 1; return n.map((x) => x / l) as V3; };
  const touches = new Uint8Array(t.nv), outside = new Uint8Array(t.nv);
  for (let f = 0; f < g.poly.length; f++) for (let k = 0; k < 3; k++) (sel.has(f) ? touches : outside)[t.vid[f * 3 + k]] = 1;
  // polygon edges (not a polygon's own diagonals), and which of them are feature lines
  const nbr: Set<number>[] = Array.from({ length: t.nv }, () => new Set()), feat: Set<number>[] = Array.from({ length: t.nv }, () => new Set());
  const cos = Math.cos((crease * Math.PI) / 180);
  for (let e = 0; e < t.ends.length / 2; e++) {
    const fs = t.edgeTris[e], va = t.ends[e * 2], vb = t.ends[e * 2 + 1];
    if (fs.length === 2 && g.poly[fs[0]] === g.poly[fs[1]]) continue;
    nbr[va].add(vb); nbr[vb].add(va);
    const inside = fs.filter((f) => sel.has(f)).length;
    const feature = fs.length !== 2 || inside === 1 || dot(normal(fs[0]), normal(fs[1])) < cos;
    if (feature && inside > 0) { feat[va].add(vb); feat[vb].add(va); }
  }
  const free: number[] = [], sliding: number[] = [];
  for (let v = 0; v < t.nv; v++) {
    if (!touches[v] || !nbr[v].size) continue;
    const onBorder = outside[v] === 1, lines = feat[v];
    if (onBorder && !slide) continue;
    if (!lines.size) { if (!onBorder) free.push(v); continue; }
    if (lines.size !== 2) continue; // lines meet here: a corner
    const [a, b] = [...lines], u = sub(M.pos(v), M.pos(a)), w = sub(M.pos(b), M.pos(v));
    if (dot(u, w) / ((len(u) * len(w)) || 1) < Math.cos((35 * Math.PI) / 180)) continue; // the line turns here: a corner
    sliding.push(v);
  }
  if (!free.length && !sliding.length) return null;
  // where each sliding vertex may go: its own stretch of line as it was, between its two neighbours on it (never round a
  // corner onto another line, which would fold the faces there flat)
  const orig = positions(M), rails = new Map<number, [V3, V3][]>();
  for (const v of sliding) rails.set(v, [...feat[v]].map((w) => [orig[w], orig[v]] as [V3, V3]));
  const onRail = (v: number, p: V3): V3 => {
    let best = p, bd = Infinity;
    for (const [a, b] of rails.get(v)!) {
      const ab = sub(b, a), tt = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1))), q = lerp(a, b, tt), d = len(sub(p, q));
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  };
  const snap = onSurface(g.soup), pos = positions(M);
  const mean = (vs: Iterable<number>) => { const s: V3 = [0, 0, 0]; let n = 0; for (const w of vs) { for (let k = 0; k < 3; k++) s[k] += pos[w][k]; n++; } return s.map((x) => x / (n || 1)) as V3; };
  // smart Laplacian: a move is kept only if no polygon round the vertex gets worse by Health's shape rules (Verdict's
  // metrics), so evening out never folds, skews or tapers a face
  const around = new Map<number, number[][]>();
  for (const v of [...free, ...sliding]) around.set(v, [...new Set(trisOf(t, v).map((f) => g.poly[f]))].map((p) => M.loop(p)).filter((l): l is number[] => !!l));
  const badness = (v: number) => around.get(v)!.map((l) => shapeBadness(l.map((w) => pos[w])));
  const step = (v: number, to: V3) => {
    const was = pos[v], b0 = badness(v);
    pos[v] = to;
    // each face round it judged on its own: none may get worse than it was (past a hair), whatever its neighbours are like
    if (badness(v).some((b, i) => b > Math.max(b0[i], 0.15))) pos[v] = was;
  };
  for (let it = 0; it < iterations; it++) {
    for (const v of free) step(v, snap(lerp(pos[v], mean(nbr[v]), 0.5)));
    for (const v of sliding) step(v, onRail(v, lerp(pos[v], mean(feat[v]), 0.5)));
  }
  return { geo: moveVerts(M, new Map([...free, ...sliding].map((v) => [v, pos[v]]))), faces: [...sel] };
}

/** Move: these vertices shifted by `delta`, each put back on the original surface when `onSurface` (so the shape stays).
 *  The tool G calls it on every mouse move from the geometry it started with. */
export function moveOnSurface(g: Geo, verts: number[], delta: V3, stayOnSurface: boolean, snap?: (p: V3) => V3): Geo {
  const M = new Mesh(g), moved = new Map<number, V3>();
  for (const v of verts) { const p = add3(M.pos(v), delta); moved.set(v, stayOnSurface && snap ? snap(p) : p); }
  return moveVerts(M, moved);
}
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** The original surface to put moved points back on (built once per drag). */
export const surfaceOf = (soup: Float32Array) => onSurface(soup);

/** Subdivide: each selected polygon becomes quads round its centre (a quad → 4, an n-gon → n), cut at its edges'
 *  midpoints; a neighbour gains a corner on every edge it shares, as in Blender. */
export function subdivide(g: Geo, s: Sel): Done | null {
  const M = new Mesh(g), pos = positions(M), mids = new Map<string, number>(), replace = new Map<number, number[][]>();
  const mid = (a: number, b: number) => { let v = mids.get(ekey(a, b)); if (v === undefined) { mids.set(ekey(a, b), v = pos.length); pos.push(lerp(pos[a], pos[b], 0.5)); } return v; };
  for (const p of new Set(s.faces.map((f) => g.poly[f]))) {
    const l = M.loop(p);
    if (!l) continue;
    const c = pos.length;
    pos.push(l.map((v) => pos[v]).reduce((a, b) => [a[0] + b[0] / l.length, a[1] + b[1] / l.length, a[2] + b[2] / l.length] as V3, [0, 0, 0] as V3));
    replace.set(p, l.map((v, i) => [v, mid(v, l[(i + 1) % l.length]), c, mid(l[(i + l.length - 1) % l.length], v)]));
  }
  if (!replace.size) return null;
  const r = rebuild(M, pos, replace, mids);
  return { geo: r.geo, faces: r.made.flat() };
}

/** Connect (J): in each polygon holding two or more of the selected vertices, a new edge between them (more than two:
 *  split again and again); with edges selected instead, a polygon with two of them is cut between their midpoints. */
export function connect(g: Geo, s: Sel): Done | null {
  const M = new Mesh(g), pos = positions(M), mids = new Map<string, number>(), replace = new Map<number, number[][]>(), cuts: [V3, V3][] = [];
  const split = (l: number[], pick: Set<number>): number[][] => {
    for (let i = 0; i < l.length; i++) for (let j = i + 2; j < l.length; j++) {
      if (!pick.has(l[i]) || !pick.has(l[j]) || (i === 0 && j === l.length - 1)) continue;
      cuts.push([pos[l[i]], pos[l[j]]]);
      return [...split(l.slice(i, j + 1), pick), ...split([...l.slice(j), ...l.slice(0, i + 1)], pick)];
    }
    return [l];
  };
  if (s.verts.length >= 2) {
    const pick = new Set(s.verts);
    for (const p of new Set(s.verts.flatMap((v) => trisOf(M.t, v).map((f) => g.poly[f])))) {
      const l = M.loop(p);
      if (!l || l.filter((v) => pick.has(v)).length < 2) continue;
      const parts = split(l, pick);
      if (parts.length > 1) replace.set(p, parts);
    }
  } else {
    const on = new Set(s.edges.map(([a, b]) => ekey(a, b)));
    for (const p of new Set(s.edges.flatMap(([a, b]) => M.polysOn(a, b)))) {
      const l = M.loop(p);
      if (!l) continue;
      const cut = l.flatMap((v, i) => (on.has(ekey(v, l[(i + 1) % l.length])) ? [i] : []));
      if (cut.length !== 2) continue;
      const ring: number[] = [], pick = new Set<number>();
      l.forEach((v, i) => {
        ring.push(v);
        if (!cut.includes(i)) return;
        const w = l[(i + 1) % l.length];
        let m = mids.get(ekey(v, w));
        if (m === undefined) { mids.set(ekey(v, w), m = pos.length); pos.push(lerp(pos[v], pos[w], 0.5)); }
        ring.push(m); pick.add(m);
      });
      replace.set(p, split(ring, pick));
    }
  }
  if (!replace.size) return null;
  return { geo: rebuild(M, pos, replace, mids).geo, edges: cuts.map(([a, b]) => [f32(a), f32(b)]) };
}

/** Rotate Edge: the edge between two polygons turns one step round the outline they share, as Blender's Rotate Edge CW. */
export function rotateEdge(g: Geo, s: Sel): Done | null {
  const M = new Mesh(g), pos = positions(M), replace = new Map<number, number[][]>(), made: [V3, V3][] = [];
  for (const [u, v] of s.edges) {
    const P = M.polyWith(u, v), Q = M.polyWith(v, u);
    if (P < 0 || Q < 0 || P === Q || replace.has(P) || replace.has(Q)) continue;
    const lp = M.loop(P)!, lq = M.loop(Q)!;
    // P from v round to u, Q from u round to v: together the outline of both, without the edge
    const pv = [...lp.slice(lp.indexOf(v)), ...lp.slice(0, lp.indexOf(v))], qu = [...lq.slice(lq.indexOf(u)), ...lq.slice(0, lq.indexOf(u))];
    if (pv.length < 3 || qu.length < 3) continue;
    const ring = [...pv, ...qu.slice(1, -1)], a = 1, b = pv.length; // the new edge: one step on from v and from u
    replace.set(P, [ring.slice(a, b + 1), [...ring.slice(b), ...ring.slice(0, a + 1)]]); replace.set(Q, []);
    made.push([f32(pos[ring[a]]), f32(pos[ring[b]])]);
  }
  if (!replace.size) return null;
  return { geo: rebuild(M, pos, replace, new Map()).geo, edges: made };
}

/** Merge: every selected vertex to one point at their centre (`collapse`: each connected group of selected edges to its
 *  own centre). Triangles that fold flat are dropped; a polygon left without a simple outline falls back to triangles. */
export function merge(g: Geo, s: Sel, collapse: boolean): Done | null {
  const M = new Mesh(g), groups: number[][] = [];
  if (collapse) {
    const parent = new Map<number, number>(), find = (v: number): number => { const p = parent.get(v) ?? v; if (p === v) return v; const r = find(p); parent.set(v, r); return r; };
    for (const [a, b] of s.edges) parent.set(find(a), find(b));
    const by = new Map<number, number[]>();
    for (const v of new Set(s.edges.flat())) (by.get(find(v)) ?? by.set(find(v), []).get(find(v))!).push(v);
    groups.push(...by.values());
  } else if (s.verts.length > 1) groups.push(s.verts);
  if (!groups.length) return null;
  const to = new Map<number, V3>(), centres: V3[] = [];
  for (const gp of groups) {
    const c = gp.map((v) => M.pos(v)).reduce((a, b) => [a[0] + b[0] / gp.length, a[1] + b[1] / gp.length, a[2] + b[2] / gp.length] as V3, [0, 0, 0] as V3);
    for (const v of gp) to.set(v, c);
    centres.push(f32(c));
  }
  const keep: number[] = [];
  for (let f = 0; f < g.poly.length; f++) {
    const P = [0, 1, 2].map((k) => to.get(M.t.vid[f * 3 + k]) ?? M.pos(M.t.vid[f * 3 + k]));
    if (len(cross(sub(P[1], P[0]), sub(P[2], P[0]))) > 1e-12) keep.push(f);
  }
  const soup = new Float32Array(keep.length * 9);
  keep.forEach((f, i) => { for (let k = 0; k < 3; k++) soup.set(to.get(M.t.vid[f * 3 + k]) ?? M.pos(M.t.vid[f * 3 + k]), i * 9 + k * 3); });
  // the polygons that lost or moved a corner count their sides again; one without a simple outline becomes triangles
  const poly = Int32Array.from(keep, (f) => g.poly[f]), t2 = topoOfSoup(soup), sides = new Map<number, number>(), touched = new Set<number>();
  g.sides.forEach((n, p) => sides.set(p, n));
  keep.forEach((f, i) => { if ([0, 1, 2].some((k) => to.has(M.t.vid[f * 3 + k]))) touched.add(poly[i]); });
  let id = g.sides.length;
  for (const [p, tris] of members(poly)) {
    if (!touched.has(p)) continue;
    const n = outline(t2, tris);
    if (n) sides.set(p, n); else for (const f of tris) { poly[f] = id; sides.set(id++, 3); }
  }
  return { geo: { soup, ...compact(poly, sides) }, verts: centres };
}

/** Loop Cut: from each selected edge, across the ring of quads it starts (both ways, until a non-quad, an open edge or
 *  back round), a new edge loop through the middle of every quad. The non-quad at either end gains a corner. */
export function loopCut(g: Geo, s: Sel, at = 0.5, curve?: Set<number>): Done | null {
  const M = new Mesh(g), pos = positions(M), mids = new Map<string, number>(), replace = new Map<number, number[][]>(), made: [V3, V3][] = [];
  const mid = (a: number, b: number, p = -1) => {
    let v = mids.get(ekey(a, b));
    if (v === undefined) { mids.set(ekey(a, b), v = pos.length); pos.push(curve?.has(p) ? onArc(M, p, a, b, M.polysOn(a, b).filter((q) => !curve.has(q))) : a < b ? lerp(pos[a], pos[b], at) : lerp(pos[b], pos[a], at)); }
    return v;
  };
  for (const [a0, b0] of s.edges) for (const start of M.polysOn(a0, b0)) {
    let p = start, a = a0, b = b0;
    while (p >= 0 && !replace.has(p)) {
      const l = M.loop(p);
      if (!l || l.length !== 4) break;
      const i = l.findIndex((v, k) => ekey(v, l[(k + 1) % 4]) === ekey(a, b)), L = [0, 1, 2, 3].map((k) => l[(i + k) % 4]);
      const m1 = mid(L[0], L[1], p), m2 = mid(L[2], L[3], p);
      replace.set(p, [[L[0], m1, m2, L[3]], [m1, L[1], L[2], m2]]);
      made.push([pos[m1], pos[m2]]);
      [a, b] = [L[2], L[3]];
      p = M.polysOn(a, b).find((q) => q !== p) ?? -1;
    }
    // the polygon past the ring's end only gets its edge split, which rebuild does
    if (p >= 0 && !replace.has(p)) mid(a, b);
  }
  if (!replace.size) return null;
  // a ring that ran into a quad another ring already cut (they cross there) split that quad's edge too: its halves
  // take the new point in, or the edge would crack open
  for (const loops of replace.values()) for (const l of loops) for (let k = l.length - 1; k >= 0; k--) {
    const v = mids.get(ekey(l[k], l[(k + 1) % l.length]));
    if (v !== undefined) l.splice(k + 1, 0, v);
  }
  return { geo: rebuild(M, pos, replace, mids).geo, edges: made.map(([x, y]) => [f32(x), f32(y)]) };
}

/** Polygon p's normal (Newell, unit). */
const polyNormal = (M: Mesh, p: number): V3 => { const n = newell((M.loop(p) ?? []).map((v) => M.pos(v))), l = len(n) || 1; return [n[0] / l, n[1] / l, n[2] / l]; };
/** The surface's normal at v as polygon p sees it: the polygons round v that shade smooth with p (within 45°, as
 *  the export's normals). */
function smoothNormal(M: Mesh, p: number, v: number): V3 {
  const np = polyNormal(M, p), n: V3 = [0, 0, 0];
  for (const q of new Set(trisOf(M.t, v).map((f) => M.g.poly[f]))) { const nq = polyNormal(M, q); if (dot(nq, np) > Math.SQRT1_2) for (let k = 0; k < 3; k++) n[k] += nq[k]; }
  const l = len(n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
/** The middle of edge a–b of polygon p put on the arc its ends' normals describe (a circle through a and b, square
 *  to both normals): a new loop rounds a faceted curve out instead of lying on the flat; kept in the plane of each
 *  `flat` polygon. */
function onArc(M: Mesh, p: number, a: number, b: number, flat: number[] = []): V3 {
  const A = M.pos(a), B = M.pos(b), na = smoothNormal(M, p, a), nb = smoothNormal(M, p, b), m = lerp(A, B, 0.5);
  const th = Math.acos(Math.max(-1, Math.min(1, dot(na, nb)))), n = [na[0] + nb[0], na[1] + nb[1], na[2] + nb[2]] as V3, l = len(n);
  if (th < 1e-3 || l < 1e-9) return m;
  // convex where the normals spread apart going from a to b, concave where they close in
  const h = (len(sub(B, A)) / 2) * Math.tan(th / 4) * Math.sign(dot(sub(nb, na), sub(B, A)));
  const d: V3 = [(n[0] / l) * h, (n[1] / l) * h, (n[2] / l) * h];
  // a polygon on the edge that isn't being rounded (a flat cap, the face beside the curve) keeps its plane: the
  // lift loses its part along that polygon's normal, so its outline rounds out within it
  for (const q of flat) { const nq = polyNormal(M, q), k = dot(d, nq); for (let i = 0; i < 3; i++) d[i] -= k * nq[i]; }
  return [m[0] + d[0], m[1] + d[1], m[2] + d[2]];
}

/** Add Loops on faceted curves: each selected quad gets a new loop through its middle, parallel to its coarsest smooth
 *  edge (`curveEdges`), its points on the arc (`loopCut` following the curve, within the plane of any polygon on that
 *  edge that isn't being rounded, so a cap or a face beside the curve stays flat); the ring carries on through the quads
 *  beside it, as Blender's loop cut, cut at their middles. */
export function addLoops(g: Geo, s: Sel): Done | null {
  const M = new Mesh(g), worst = new Map<number, { a: number; b: number; err: number }>();
  const picked = new Set(s.faces.map((f) => g.poly[f]));
  for (const e of curveEdges(g)) if (e.even) for (const p of [e.p, e.q]) if (picked.has(p) && e.err > (worst.get(p)?.err ?? 0)) worst.set(p, e);
  const rails: [number, number][] = [];
  for (const [p, { a, b }] of worst) {
    const l = M.loop(p);
    if (!l || l.length !== 4) continue;
    const i = l.findIndex((v, k) => ekey(v, l[(k + 1) % 4]) === ekey(a, b));
    if (i >= 0) rails.push([l[(i + 1) % 4], l[(i + 2) % 4]]);
  }
  return rails.length ? loopCut(g, { faces: [], verts: [], edges: rails }, 0.5, new Set(worst.keys())) : null;
}

/** Edge Slide: each vertex of the selected edge chains moves `f` of the way along its rail, the polygon edge leading
 *  away from the chain on one side (f > 0) or the other (f < 0), as Blender's GG. */
export function slide(g: Geo, s: Sel, f: number): Done | null {
  const M = new Mesh(g), moved = new Map<number, V3>();
  for (const { verts, closed } of chains(s.edges)) {
    const side = new Map<number, V3[]>(), other = new Map<number, V3[]>();
    const push = (m: Map<number, V3[]>, v: number, w: number) => (m.get(v) ?? m.set(v, []).get(v)!).push(M.pos(w));
    const n = closed ? verts.length : verts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      // the polygon left of a→b holds it in its winding: a's rail there is the corner before a, b's the one after b
      const L = M.loop(M.polyWith(a, b)), R = M.loop(M.polyWith(b, a));
      if (L) { push(side, a, L[(L.indexOf(a) + L.length - 1) % L.length]); push(side, b, L[(L.indexOf(b) + 1) % L.length]); }
      if (R) { push(other, a, R[(R.indexOf(a) + 1) % R.length]); push(other, b, R[(R.indexOf(b) + R.length - 1) % R.length]); }
    }
    for (const v of verts) {
      const rails = (f > 0 ? side : other).get(v);
      if (!rails) continue;
      const target = rails.reduce((x, y) => [x[0] + y[0] / rails.length, x[1] + y[1] / rails.length, x[2] + y[2] / rails.length] as V3, [0, 0, 0] as V3);
      moved.set(v, lerp(M.pos(v), target, Math.abs(f)));
    }
  }
  if (!moved.size) return null;
  const geo = moveVerts(M, moved);
  return { geo, edges: s.edges.map(([a, b]) => [f32(moved.get(a) ?? M.pos(a)), f32(moved.get(b) ?? M.pos(b))]) };
}

/** Loop shaping on the selected edge chains (LoopTools): `space` evens the spacing along the chain as it runs; `straight`
 *  lines an open chain up between its ends, laid back on the surface; `circle` rounds a closed one in its own plane. */
export function shapeLoop(g: Geo, s: Sel, how: 'space' | 'straight' | 'circle'): Done | null {
  const M = new Mesh(g), moved = new Map<number, V3>(), snap = how === 'straight' ? onSurface(g.soup) : null;
  for (const { verts, closed } of chains(s.edges)) {
    const P = verts.map((v) => M.pos(v)), ring = closed ? [...P, P[0]] : P;
    if (how === 'space') {
      const at = [0];
      for (let i = 1; i < ring.length; i++) at.push(at[i - 1] + len(sub(ring[i], ring[i - 1])));
      const total = at[at.length - 1], n = ring.length - 1;
      for (let i = 1; i < (closed ? verts.length : verts.length - 1); i++) {
        const want = (total * i) / n, k = at.findIndex((x) => x >= want) || 1;
        moved.set(verts[i], lerp(ring[k - 1], ring[k], (want - at[k - 1]) / (at[k] - at[k - 1] || 1)));
      }
    } else if (how === 'straight' && !closed) {
      for (let i = 1; i < verts.length - 1; i++) moved.set(verts[i], snap!(lerp(P[0], P[P.length - 1], i / (verts.length - 1))));
    } else if (how === 'circle' && closed) {
      const c = P.reduce((a, b) => [a[0] + b[0] / P.length, a[1] + b[1] / P.length, a[2] + b[2] / P.length] as V3, [0, 0, 0] as V3);
      const n = newell(P), nl = len(n) || 1, N = n.map((x) => x / nl) as V3;
      const r = P.reduce((a, p) => a + len(sub(p, c)), 0) / P.length, d0 = sub(P[0], c), u0 = sub(d0, N.map((x) => x * dot(d0, N)) as V3);
      const ul = len(u0) || 1, U = u0.map((x) => x / ul) as V3, W = cross(N, U);
      verts.forEach((v, i) => { const a = (2 * Math.PI * i) / verts.length; moved.set(v, [0, 1, 2].map((k) => c[k] + r * (Math.cos(a) * U[k] + Math.sin(a) * W[k])) as V3); });
    }
  }
  if (!moved.size) return null;
  return { geo: moveVerts(M, moved), edges: s.edges.map(([a, b]) => [f32(moved.get(a) ?? M.pos(a)), f32(moved.get(b) ?? M.pos(b))]) };
}

/** Grid Fill: a selected polygon with an even number of corners (6 or more), or a selected closed loop of open edges (a
 *  hole), filled with a grid of quads: the outline split into four sides from its sharpest corner, the inside blended
 *  between them (Coons patch), laid on the surface where there was one. */
export function gridFill(g: Geo, s: Sel): Done | null {
  const M = new Mesh(g), pos = positions(M), replace = new Map<number, number[][]>(), add: number[][] = [];
  const snap = onSurface(g.soup);
  const fill = (L: number[], surface: boolean): number[][] | null => {
    const n = L.length;
    if (n < 6 || n % 2) return null;
    // start on the sharpest corner, so a rounded-rectangle hole gets its corners where they belong
    const turn = (i: number) => { const a = sub(pos[L[(i + n - 1) % n]], pos[L[i]]), b = sub(pos[L[(i + 1) % n]], pos[L[i]]); return dot(a, b) / ((len(a) * len(b)) || 1); };
    let s0 = 0;
    for (let i = 1; i < n; i++) if (turn(i) > turn(s0)) s0 = i;
    const at = (k: number) => L[(s0 + k + n) % n], A = Math.floor(n / 4), B = n / 2 - A;
    const grid: number[][] = [];
    for (let i = 0; i <= A; i++) {
      grid.push([]);
      for (let j = 0; j <= B; j++) {
        if (j === 0) grid[i].push(at(i));
        else if (i === A) grid[i].push(at(A + j));
        else if (j === B) grid[i].push(at(2 * A + B - i));
        else if (i === 0) grid[i].push(at(-j));
        else {
          const u = i / A, v = j / B, P = (k: number) => pos[at(k)];
          const p = [0, 1, 2].map((k) => (1 - v) * P(i)[k] + v * P(2 * A + B - i)[k] + (1 - u) * P(-j)[k] + u * P(A + j)[k]
            - ((1 - u) * (1 - v) * P(0)[k] + u * (1 - v) * P(A)[k] + (1 - u) * v * P(-B)[k] + u * v * P(A + B)[k])) as V3;
          grid[i].push(pos.length); pos.push(surface ? snap(p) : p);
        }
      }
    }
    const quads: number[][] = [];
    for (let i = 0; i < A; i++) for (let j = 0; j < B; j++) quads.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
    return quads;
  };
  for (const p of new Set(s.faces.map((f) => g.poly[f]))) { const l = M.loop(p), q = l && fill(l, true); if (q) replace.set(p, q); }
  // a hole: a closed chain of open edges, its outline the other way round from the faces around it
  for (const { verts, closed } of chains(s.edges)) {
    if (!closed || !verts.every((v, i) => M.polysOn(v, verts[(i + 1) % verts.length]).length === 1)) continue;
    const l = M.polyWith(verts[0], verts[1]) >= 0 ? [...verts].reverse() : verts, q = fill(l, false);
    if (q) add.push(...q);
  }
  if (!replace.size && !add.length) return null;
  const r = rebuild(M, pos, replace, new Map(), add);
  return { geo: r.geo, faces: r.made.flat() };
}

// ---- looking ----

/** Mesh check on the soup: edges with more than two faces, vertices where two fans meet at a point, open edges,
 *  faces whose winding disagrees with their neighbours (the smaller side of each connected piece), whole closed
 *  shells wound inside-out (signed volume), faces with no area, and faces lying twice on the same corners.
 *  The zero-area test is relative to the part's own radius (as the engine's weld/drop is), so a model far from the
 *  origin or small in its units isn't judged at the world's scale. */
export function meshCheck(g: Geo) {
  const t = topoOfSoup(g.soup), nf = g.poly.length, nonManifold: [number, number][] = [], open: [number, number][] = [];
  for (let e = 0; e < t.ends.length / 2; e++) {
    const n = t.edgeTris[e].length, pair: [number, number] = [t.ends[e * 2], t.ends[e * 2 + 1]];
    if (n > 2) nonManifold.push(pair); else if (n === 1) open.push(pair);
  }
  // the part's radius (half its bounding-box diagonal), so "no area" means the same at any model scale
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < t.nv; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], t.pos[v * 3 + k]); hi[k] = Math.max(hi[k], t.pos[v * 3 + k]); }
  const R = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 0;
  const zero: number[] = [], seen = new Map<string, number>(), duplicate: number[] = [];
  for (let f = 0; f < nf; f++) {
    const P = [0, 1, 2].map((k) => { const v = t.vid[f * 3 + k]; return [t.pos[v * 3], t.pos[v * 3 + 1], t.pos[v * 3 + 2]] as V3; });
    if (len(cross(sub(P[1], P[0]), sub(P[2], P[0]))) <= 2e-12 * R * R) zero.push(f);
    const key = [0, 1, 2].map((k) => t.vid[f * 3 + k]).sort((a, b) => a - b).join();
    if (seen.has(key)) duplicate.push(f); else seen.set(key, f);
  }
  const isZero = new Set(zero);
  // winding: flood each piece, flipping across an edge both faces run the same way (a face with no area has no
  // facing, so it sits the flood out: it's counted as zero-area instead). A closed piece is then checked by its
  // signed volume: a fully inward closed shell has no minority to flip, and bakes inverted.
  const flip = new Int8Array(nf).fill(-1), flipped: number[] = [], insideOut: number[][] = [];
  const dir = (f: number, a: number, b: number) => [0, 1, 2].some((k) => t.vid[f * 3 + k] === a && t.vid[f * 3 + (k + 1) % 3] === b);
  const closedShells: { piece: number[]; volume: number; lo: V3; hi: V3 }[] = [];
  for (let f0 = 0; f0 < nf; f0++) {
    if (flip[f0] >= 0 || isZero.has(f0)) continue;
    const piece = [f0], inPiece = new Set([f0]);
    flip[f0] = 0;
    for (let i = 0; i < piece.length; i++) for (let k = 0; k < 3; k++) {
      const f = piece[i], e = t.edge[f * 3 + k];
      if (t.edgeTris[e].length !== 2) continue;
      const h = t.edgeTris[e].find((x) => x !== f);
      if (h === undefined || flip[h] >= 0 || isZero.has(h)) continue;
      const a = t.vid[f * 3 + k], b = t.vid[f * 3 + (k + 1) % 3];
      flip[h] = dir(h, a, b) ? 1 - flip[f] : flip[f]; // the same direction on both sides: one of them is turned over
      piece.push(h); inPiece.add(h);
    }
    // closed only if every edge round the piece has exactly its two faces in this piece
    let closed = true;
    for (const f of piece) for (let k = 0; k < 3; k++) {
      const es = t.edgeTris[t.edge[f * 3 + k]];
      if (es.length !== 2 || !inPiece.has(es[0]) || !inPiece.has(es[1])) { closed = false; break; }
    }
    let volume = 0;
    if (closed) for (const f of piece) {
      const [a, b, c] = [0, 1, 2].map((k) => { const v = t.vid[f * 3 + k]; return [t.pos[v * 3], t.pos[v * 3 + 1], t.pos[v * 3 + 2]] as V3; });
      volume += dot(a, cross(flip[f] ? c : b, flip[f] ? b : c)) / 6;
    }
    if (closed && Math.abs(volume) > 1e-10 * R * R * R) {
      const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (const f of piece) for (let k = 0; k < 3; k++) { const v = t.vid[f * 3 + k]; for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], t.pos[v * 3 + j]); hi[j] = Math.max(hi[j], t.pos[v * 3 + j]); } }
      closedShells.push({ piece, volume, lo, hi });
      continue;
    }
    const ones = piece.filter((f) => flip[f]);
    flipped.push(...(ones.length * 2 > piece.length ? piece.filter((f) => !flip[f]) : ones));
  }
  // A negative volume is an inside-out shell — unless it sits inside another closed shell, which is the inner wall of a
  // cavity (a cup, a hollow casting): its normals face into the hole on purpose. Bounding-box containment is enough to
  // tell the two apart without a point-in-mesh cast.
  const inside = (a: typeof closedShells[number], b: typeof closedShells[number]) =>
    [0, 1, 2].every((k) => a.lo[k] >= b.lo[k] - 1e-9 * R && a.hi[k] <= b.hi[k] + 1e-9 * R) && [0, 1, 2].some((k) => a.lo[k] > b.lo[k] + 1e-9 * R || a.hi[k] < b.hi[k] - 1e-9 * R);
  for (const sh of closedShells) {
    if (sh.volume < 0 && !closedShells.some((o) => o !== sh && inside(sh, o))) { insideOut.push(sh.piece); continue; }
    const ones = sh.piece.filter((f) => flip[f]);
    flipped.push(...(ones.length * 2 > sh.piece.length ? sh.piece.filter((f) => !flip[f]) : ones));
  }
  // non-manifold vertices: more than one fan of faces meets at the point (a bow-tie), so the link is not one circle.
  // The edge check above catches edges with 3+ faces; this catches two surfaces touching at a single vertex. A vertex
  // on a non-manifold edge is already reported by that edge (and its fans are split by it), so it isn't repeated here.
  const nonManifoldVert: number[] = [], onNmEdge = new Uint8Array(t.nv);
  for (const [a, b] of nonManifold) onNmEdge[a] = onNmEdge[b] = 1;
  for (let v = 0; v < t.nv; v++) {
    const fs = trisOf(t, v);
    if (fs.length < 2 || onNmEdge[v]) continue;
    const seenV = new Set([fs[0]]), stack = [fs[0]];
    while (stack.length) {
      const f = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        const e = t.edge[f * 3 + k], es = t.edgeTris[e];
        if (es.length !== 2) continue;
        if (t.ends[e * 2] !== v && t.ends[e * 2 + 1] !== v) continue;
        for (const h of es) if (!seenV.has(h)) { seenV.add(h); stack.push(h); }
      }
    }
    if (seenV.size < fs.length) nonManifoldVert.push(v);
  }
  return { nonManifold, nonManifoldVert, open, flipped, insideOut, zero, duplicate };
}

/** The smooth edges between polygons (meeting at 0.02°–45°, where the export shades across) and how coarsely the curve
 *  they stand for is sampled. `bend`: the turn from one face to the next; `radius`: the circle that turn implies
 *  (edge length / 2 sin(bend / 2)); `err`: the chord sagitta of that circle (how far the flat faces cut inside it) —
 *  a scale-free measure of faceting, unlike a share of the model's bounding box. `wp`, `wq`: each side's width across
 *  the edge; `even`: within 3× of each other, segments of one curve (a wide face beside a narrow one is a chamfer or a
 *  bevel, drawn that way on purpose). A turn past 45° is a crease or a corner, not a sampled smooth curve. */
export function curveEdges(g: Geo): { a: number; b: number; p: number; q: number; bend: number; radius: number; err: number; wp: number; wq: number; even: boolean }[] {
  const M = new Mesh(g), t = M.t, info = new Map<number, { n: V3; area: number; size: number }>();
  const of = (p: number) => {
    let i = info.get(p);
    if (!i) {
      const fs = M.m.get(p)!, n: V3 = [0, 0, 0];
      let area = 0;
      for (const f of fs) { const c = cross(sub(M.pos(t.vid[f * 3 + 1]), M.pos(t.vid[f * 3])), sub(M.pos(t.vid[f * 3 + 2]), M.pos(t.vid[f * 3]))); area += len(c) / 2; for (let k = 0; k < 3; k++) n[k] += c[k]; }
      const vs = [...new Set(fs.flatMap((f) => [0, 1, 2].map((k) => t.vid[f * 3 + k])))], l = len(n) || 1;
      let size = 0;
      for (const x of vs) for (const y of vs) size = Math.max(size, len(sub(M.pos(x), M.pos(y))));
      info.set(p, i = { n: [n[0] / l, n[1] / l, n[2] / l], area, size });
    }
    return i;
  };
  const out: { a: number; b: number; p: number; q: number; bend: number; radius: number; err: number; wp: number; wq: number; even: boolean }[] = [];
  for (let e = 0; e < t.ends.length / 2; e++) {
    const fs = t.edgeTris[e];
    if (fs.length !== 2 || g.poly[fs[0]] === g.poly[fs[1]]) continue;
    const [p, q] = [g.poly[fs[0]], g.poly[fs[1]]], a = t.ends[e * 2], b = t.ends[e * 2 + 1], P = of(p), Q = of(q);
    const bend = Math.acos(Math.max(-1, Math.min(1, dot(P.n, Q.n)))), el = len(sub(M.pos(a), M.pos(b))) || 1;
    if (bend < 0.02 * Math.PI / 180 || bend >= Math.PI / 4) continue;
    const w = (X: typeof P) => Math.min(X.area / el, X.size);
    const radius = el / (2 * Math.sin(bend / 2)), err = radius * (1 - Math.cos(bend / 2));
    out.push({ a, b, p, q, bend, radius, err, wp: w(P), wq: w(Q), even: Math.max(w(P), w(Q)) <= 3 * Math.min(w(P), w(Q)) });
  }
  return out;
}

/** The dominant polygon kind of a part (the mode of its `sides`), the count of polygons with it, and the regular
 *  valence that kind implies: 4 for quads, 6 for triangles, 2s/(s−2) in general. */
function dominantSides(g: Geo): { sides: number; regular: number } {
  const n = new Map<number, number>();
  for (const s of g.sides) n.set(s, (n.get(s) ?? 0) + 1);
  let sides = 4, best = -1;
  for (const [s, c] of n) if (c > best || (c === best && s > sides)) { best = c; sides = s; }
  return { sides, regular: Math.max(2, Math.round((2 * sides) / (sides - 2))) };
}

/** Poles: inside vertices (not on an open edge) whose valence differs from the regular one for this kind of mesh:
 *  fewer (`low`) or more (`high`), and by 2 or more (`big`). For quads regular is 4, so the classic 3- and 5-poles are
 *  low/high; for triangles regular is 6, so a 5- or 7-valence vertex is mild, not the "5+ pole" a quad mesh means.
 *  Poles are structural (Poincaré–Hopf: their indices have to sum to the Euler characteristic), so Health does not
 *  colour them; the census reports them. */
export function poles(g: Geo) {
  const t = topoOfSoup(g.soup), deg = new Int32Array(t.nv), edge = new Uint8Array(t.nv), { regular } = dominantSides(g);
  const low: number[] = [], high: number[] = [], big: number[] = [];
  for (let e = 0; e < t.ends.length / 2; e++) {
    const [a, b] = t.edgeTris[e];
    if (b !== undefined && g.poly[a] === g.poly[b] && t.edgeTris[e].length === 2) continue;
    deg[t.ends[e * 2]]++; deg[t.ends[e * 2 + 1]]++;
    if (t.edgeTris[e].length !== 2) edge[t.ends[e * 2]] = edge[t.ends[e * 2 + 1]] = 1;
  }
  for (let v = 0; v < t.nv; v++) if (!edge[v]) {
    if (deg[v] < regular) low.push(v); else if (deg[v] > regular) high.push(v);
    if (Math.abs(deg[v] - regular) >= 2) big.push(v);
  }
  return { regular, low, high, big };
}

export interface MeshTopology {
  /** Connected pieces of surface. */
  shells: number;
  /** How many of them are closed (no boundary at all). */
  closed: number;
  /** Sum of the pieces' genera; only meaningful when `clean` (a non-manifold piece is skipped). */
  genus: number;
  /** Sum of V − E + F over the pieces. */
  chi: number;
  /** Boundary loops over all pieces. */
  boundaries: number;
  /** Regular valence for the part's dominant polygon kind (4 quads, 6 triangles). */
  regular: number;
  /** False when the pieces don't resolve to a whole genus (non-manifold or non-orientable). */
  clean: boolean;
}

const topologyCache = new WeakMap<Float32Array, { sides: Int32Array; info: MeshTopology }>();
/** The part's surface topology, counted on the welded mesh: shells, closed vs open, boundary loops, Euler
 *  characteristic and genus. Genus is the number of handles: 0 for a sphere or a disc, 1 for a torus, 2 for a
 *  two-handle shape. (Per piece, genus = (2 − χ − boundaries) / 2, which is only a whole number for an orientable
 *  manifold; `clean` says whether it was.) */
export function meshTopology(g: Geo): MeshTopology {
  const hit = topologyCache.get(g.soup);
  if (hit && hit.sides === g.sides) return hit.info;
  const t = topoOfSoup(g.soup), nf = g.poly.length, comp = new Int32Array(nf).fill(-1);
  let shells = 0;
  for (let f0 = 0; f0 < nf; f0++) {
    if (comp[f0] >= 0) continue;
    const id = shells++, queue = [f0];
    comp[f0] = id;
    for (let i = 0; i < queue.length; i++) for (let k = 0; k < 3; k++) {
      const es = t.edgeTris[t.edge[queue[i] * 3 + k]];
      if (es.length !== 2) continue;
      const h = es[0] === queue[i] ? es[1] : es[0];
      if (comp[h] < 0) { comp[h] = id; queue.push(h); }
    }
  }
  const chi: number[] = [], bows: number[] = [];
  let clean = true;
  for (let id = 0; id < shells; id++) {
    const faces: number[] = [];
    for (let f = 0; f < nf; f++) if (comp[f] === id) faces.push(f);
    const verts = new Set<number>(), edges = new Set<number>(), boundary = new Set<number>();
    for (const f of faces) {
      for (let k = 0; k < 3; k++) {
        verts.add(t.vid[f * 3 + k]);
        const e = t.edge[f * 3 + k];
        edges.add(e);
        if (t.edgeTris[e].length === 1) boundary.add(e);
        if (t.edgeTris[e].length > 2) clean = false;
      }
    }
    chi.push(verts.size - edges.size + faces.length);
    // boundary loops: connected components of the boundary-edge graph (degree 2 is one clean loop)
    if (!boundary.size) { bows.push(0); continue; }
    const adj = new Map<number, number[]>();
    for (const e of boundary) for (const [a, b] of [[t.ends[e * 2], t.ends[e * 2 + 1]], [t.ends[e * 2 + 1], t.ends[e * 2]]]) (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    for (const ns of adj.values()) if (ns.length !== 2) clean = false;
    const seen = new Set<number>();
    let loops = 0;
    for (const v of adj.keys()) {
      if (seen.has(v)) continue;
      loops++;
      const stack = [v];
      seen.add(v);
      while (stack.length) for (const w of adj.get(stack.pop()!) ?? []) if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
    bows.push(loops);
  }
  const totals = chi.reduce((s, c, i) => ({ chi: s.chi + c, boundaries: s.boundaries + bows[i] }), { chi: 0, boundaries: 0 });
  let genus = 0;
  for (let id = 0; id < shells; id++) {
    const g2 = (2 - chi[id] - bows[id]) / 2, gi = Math.round(g2);
    if (Math.abs(g2 - gi) > 1e-6 || gi < 0) { clean = false; continue; }
    genus += gi;
  }
  const info: MeshTopology = { shells, closed: bows.filter((b) => b === 0).length, genus, chi: totals.chi, boundaries: totals.boundaries, regular: dominantSides(g).regular, clean };
  topologyCache.set(g.soup, { sides: g.sides, info });
  return info;
}
