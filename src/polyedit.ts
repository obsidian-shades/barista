// Poly Doc's fixes. A part's polygons are groups of its soup triangles (`poly`: soup triangle → polygon, `sides`: corners
// per polygon), so these edits regroup triangles and never move them: the UVs and stretch stay valid as they are.
// Dissolve merges the polygons on either side of the picked edges (Blender's Dissolve Edges / Faces); Tris to Quads
// pairs lone triangles into the squarest, flattest quads (Blender's Alt+J). A merge that wouldn't leave a polygon with one
// simple outline (a ring, a hole, a pinch) is skipped, as Blender won't make one.
import type { PartOut } from './api.ts';
import { topoOf, type Topo } from './topo.ts';

export interface Polys { poly: Int32Array; sides: Int32Array }

const welded = new WeakMap<Float32Array, Topo>();
export const topoOfSoup = (soup: Float32Array) => { let t = welded.get(soup); if (!t) welded.set(soup, t = topoOf(Array.from(soup))); return t; };

/** Every soup triangle its own polygon: where a file has triangles only. */
export const ownPolygons = (tris: number): Polys => ({ poly: Int32Array.from({ length: tris }, (_, t) => t), sides: new Int32Array(tris).fill(3) });

/** Corner count of the polygon made of `tris`, or 0 if its outline isn't one simple loop. */
export function outline(t: Topo, tris: number[]): number {
  const on = new Map<number, number>();
  for (const f of tris) for (let k = 0; k < 3; k++) { const e = t.edge[f * 3 + k]; on.set(e, (on.get(e) ?? 0) + 1); }
  const next = new Map<number, number[]>();
  let n = 0;
  for (const [e, c] of on) {
    if (c > 2) return 0;
    if (c === 2) continue;
    n++;
    for (const [a, b] of [[t.ends[e * 2], t.ends[e * 2 + 1]], [t.ends[e * 2 + 1], t.ends[e * 2]]]) (next.get(a) ?? next.set(a, []).get(a)!).push(b);
  }
  if ([...next.values()].some((v) => v.length !== 2)) return 0;
  // one loop through every outline vertex
  let [prev, cur] = [-1, next.keys().next().value!], seen = 0;
  const start = cur;
  do { const [a, b] = next.get(cur)!; [prev, cur] = [cur, a === prev ? b : a]; seen++; } while (cur !== start && seen <= n);
  return seen === n ? n : 0;
}

/** Renumber polygons 0..n−1 in triangle order, carrying their side counts. */
export function compact(poly: Int32Array, sides: Map<number, number>): Polys {
  const id = new Map<number, number>(), out = new Int32Array(poly.length), s: number[] = [];
  poly.forEach((p, t) => { let q = id.get(p); if (q === undefined) { id.set(p, q = id.size); s.push(sides.get(p)!); } out[t] = q; });
  return { poly: out, sides: Int32Array.from(s) };
}

/** Merge the polygons on either side of each soup-triangle pair (the two sides of a picked edge). Null if nothing merged. */
export function dissolve(soup: Float32Array, cur: Polys, pairs: [number, number][]): Polys | null {
  const t = topoOfSoup(soup), poly = cur.poly.slice(), sides = new Map<number, number>();
  cur.sides.forEach((n, p) => sides.set(p, n));
  const members = new Map<number, number[]>();
  poly.forEach((p, f) => (members.get(p) ?? members.set(p, []).get(p)!).push(f));
  let merged = false;
  for (const [a, b] of pairs) {
    const pa = poly[a], pb = poly[b];
    if (pa === pb) continue;
    const all = [...members.get(pa)!, ...members.get(pb)!], n = outline(t, all);
    if (!n) continue;
    for (const f of members.get(pb)!) poly[f] = pa;
    members.set(pa, all); members.delete(pb); sides.set(pa, n); sides.delete(pb);
    merged = true;
  }
  return merged ? compact(poly, sides) : null;
}

/** Dissolve Faces: the polygons of these soup triangles merge into one per connected patch. A patch whose outline
 *  wouldn't be one simple loop (a ring round a hole) is merged edge by edge as far as it goes. Null if nothing merged. */
export function dissolveFaces(soup: Float32Array, cur: Polys, tris: Iterable<number>): Polys | null {
  const t = topoOfSoup(soup), picked = new Set<number>();
  for (const f of tris) picked.add(cur.poly[f]);
  const inPick = (f: number) => picked.has(cur.poly[f]);
  const poly = cur.poly.slice(), sides = new Map<number, number>(), seen = new Uint8Array(poly.length), rest: [number, number][] = [];
  cur.sides.forEach((n, p) => sides.set(p, n));
  let merged = false;
  for (let f0 = 0; f0 < poly.length; f0++) {
    if (seen[f0] || !inPick(f0)) continue;
    const patch = [f0], pairs: [number, number][] = [];
    seen[f0] = 1;
    for (let i = 0; i < patch.length; i++) for (let k = 0; k < 3; k++) for (const g of t.edgeTris[t.edge[patch[i] * 3 + k]]) {
      if (g === patch[i] || !inPick(g)) continue;
      if (cur.poly[g] !== cur.poly[patch[i]]) pairs.push([patch[i], g]);
      if (!seen[g]) { seen[g] = 1; patch.push(g); }
    }
    const ids = new Set(patch.map((f) => cur.poly[f]));
    if (ids.size < 2) continue;
    const n = outline(t, patch);
    if (!n) { rest.push(...pairs); continue; }
    const keep = cur.poly[f0];
    for (const f of patch) poly[f] = keep;
    for (const p of ids) if (p !== keep) sides.delete(p);
    sides.set(keep, n);
    merged = true;
  }
  const done = merged ? compact(poly, sides) : cur;
  return (rest.length && dissolve(soup, done, rest)) || (merged ? done : null);
}

const sub = (p: Float32Array, a: number, b: number) => [p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]];
const angle = (u: number[], v: number[]) => Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v) || 1))));
const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];

/** Pair lone triangles among `tris` (soup ids) into quads, best first: flat (normals within `maxBend`) and square
 *  (corners near 90°), convex only. Null if no pair qualifies. */
export function trisToQuads(soup: Float32Array, cur: Polys, tris: Iterable<number>, maxBend = (40 * Math.PI) / 180): Polys | null {
  const t = topoOfSoup(soup), count = new Map<number, number>();
  cur.poly.forEach((p) => count.set(p, (count.get(p) ?? 0) + 1));
  const pick = new Set([...tris].filter((f) => count.get(cur.poly[f]) === 1 && cur.sides[cur.poly[f]] === 3));
  // corner positions by welded vertex, from the soup
  const at = new Float32Array(t.nv * 3);
  for (let c = 0; c < t.vid.length; c++) at.set(soup.subarray(c * 3, c * 3 + 3), t.vid[c] * 3);
  const cands: { a: number; b: number; cost: number }[] = [];
  for (let e = 0; e < t.ends.length / 2; e++) {
    const [a, b] = t.edgeTris[e];
    if (b === undefined || t.edgeTris[e].length !== 2 || !pick.has(a) || !pick.has(b)) continue;
    const u = t.ends[e * 2], v = t.ends[e * 2 + 1];
    const opp = (f: number) => [0, 1, 2].map((k) => t.vid[f * 3 + k]).find((x) => x !== u && x !== v)!;
    const c = opp(a), d = opp(b);
    // the quad c, u, d, v: its corners, and how far it bends along the shared edge
    const ring = [c, u, d, v], corners = ring.map((x, i) => angle(sub(at, ring[(i + 3) % 4], x), sub(at, ring[(i + 1) % 4], x)));
    const bend = angle(cross(sub(at, u, c), sub(at, v, c)), cross(sub(at, v, d), sub(at, u, d)));
    if (bend > maxBend || corners.reduce((s, x) => s + x, 0) < 2 * Math.PI - 0.05 || corners.some((x) => x > Math.PI * 0.97)) continue;
    cands.push({ a, b, cost: corners.reduce((s, x) => s + Math.abs(x - Math.PI / 2), 0) + bend });
  }
  cands.sort((x, y) => x.cost - y.cost);
  const used = new Set<number>(), pairs: [number, number][] = [];
  for (const { a, b } of cands) if (!used.has(a) && !used.has(b)) { used.add(a); used.add(b); pairs.push([a, b]); }
  return pairs.length ? dissolve(soup, cur, pairs) : null;
}

/** Limited Dissolve: among `tris` (soup ids), every edge between two polygons that meet flatter than `angle` degrees is
 *  dissolved, as Blender's Limited Dissolve on a selection. Null if nothing merged. */
export function limitedDissolve(soup: Float32Array, cur: Polys, tris: Iterable<number>, angle = 5): Polys | null {
  const t = topoOfSoup(soup), pick = new Set(tris), cos = Math.cos((angle * Math.PI) / 180);
  const normal = (f: number) => {
    const o = f * 9, u = [soup[o + 3] - soup[o], soup[o + 4] - soup[o + 1], soup[o + 5] - soup[o + 2]], v = [soup[o + 6] - soup[o], soup[o + 7] - soup[o + 1], soup[o + 8] - soup[o + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(n[0], n[1], n[2]) || 1;
    return n.map((x) => x / l);
  };
  const pairs: [number, number][] = [];
  for (let e = 0; e < t.ends.length / 2; e++) {
    const [a, b] = t.edgeTris[e];
    if (b === undefined || t.edgeTris[e].length !== 2 || !pick.has(a) || !pick.has(b) || cur.poly[a] === cur.poly[b]) continue;
    const na = normal(a), nb = normal(b);
    if (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] >= cos) pairs.push([a, b]);
  }
  return pairs.length ? dissolve(soup, cur, pairs) : null;
}

const links = new WeakMap<number[], { soup: Float32Array; toOut: Int32Array; toSoup: Int32Array; triOut: Int32Array }>();
/** How a part's soup and its unwrapped output line up: soup vertex → output vertex, output vertex → soup vertex, soup
 *  triangle → output triangle (−1 where the engine dropped it). Corners pair up by nearest position within each source
 *  triangle, since the engine rescales positions and may turn a triangle's corners round. */
export function link(out: PartOut, soup: Float32Array) {
  const hit = links.get(out.positions);
  if (hit && hit.soup === soup) return hit;
  const s = topoOfSoup(soup), o = topoOf(out.positions);
  const toOut = new Int32Array(s.nv).fill(-1), toSoup = new Int32Array(o.nv).fill(-1), triOut = new Int32Array(soup.length / 9).fill(-1);
  out.source.forEach((src, t) => {
    triOut[src] = t;
    for (let k = 0; k < 3; k++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < 3; j++) {
        const d = Math.hypot(out.positions[t * 9 + k * 3] - soup[src * 9 + j * 3], out.positions[t * 9 + k * 3 + 1] - soup[src * 9 + j * 3 + 1], out.positions[t * 9 + k * 3 + 2] - soup[src * 9 + j * 3 + 2]);
        if (d < bd) { bd = d; best = j; }
      }
      const sv = s.vid[src * 3 + best], ov = o.vid[t * 3 + k];
      toOut[sv] = ov; toSoup[ov] = sv;
    }
  });
  const l = { soup, toOut, toSoup, triOut };
  links.set(out.positions, l);
  return l;
}

/** Triangulate: the polygons of these soup triangles split back into their triangles (Ctrl+T in Blender), so the bake
 *  and the engine use the same diagonals. Null if they're all triangles already. */
export function triangulate(cur: Polys, tris: Iterable<number>): Polys | null {
  const pick = new Set<number>();
  for (const f of tris) if (cur.sides[cur.poly[f]] > 3) pick.add(cur.poly[f]);
  if (!pick.size) return null;
  const poly = cur.poly.slice(), sides = new Map<number, number>();
  cur.sides.forEach((n, p) => sides.set(p, n));
  let id = cur.sides.length;
  poly.forEach((p, f) => { if (pick.has(p)) { poly[f] = id; sides.set(id++, 3); } });
  for (const p of pick) sides.delete(p);
  return compact(poly, sides);
}

/** The file's normals carried onto the same triangles moved (Poly Doc's Move): each corner's smooth fan (the corners at
 *  its vertex with the same file normal, so never across a sharp edge) turns as the fan's area-weighted face normal
 *  turns. Untouched fans keep the file's normals exactly, so sharp edges and weighted normals survive a move. */
export function carryNormals(was: Float32Array, normals: Float32Array, now: Float32Array): Float32Array {
  // the fans and their old turn, once per move (a drag calls this every frame)
  let c0 = fanCache.get(normals);
  if (!c0 || c0.was !== was) {
    const vid = topoOfSoup(was).vid, fans = new Map<string, number>(), fan = new Int32Array(vid.length), r = (x: number) => Math.round(x * 1e3);
    for (let c = 0; c < vid.length; c++) {
      const k = `${vid[c]},${r(normals[c * 3])},${r(normals[c * 3 + 1])},${r(normals[c * 3 + 2])}`;
      let f = fans.get(k);
      if (f === undefined) fans.set(k, (f = fans.size));
      fan[c] = f;
    }
    c0 = { was, fan, n: fans.size, a: new Float64Array() };
    c0.a = turnOf(was, c0);
    fanCache.set(normals, c0);
  }
  const { fan, a } = c0, b = turnOf(now, c0), out = new Float32Array(normals.length);
  for (let c = 0; c < fan.length; c++) {
    const f = fan[c] * 3, v = [0, 1, 2].map((i) => normals[c * 3 + i] + b[f + i] - a[f + i]), l = Math.hypot(v[0], v[1], v[2]) || 1;
    for (let i = 0; i < 3; i++) out[c * 3 + i] = v[i] / l;
  }
  return out;
}
const fanCache = new WeakMap<Float32Array, { was: Float32Array; fan: Int32Array; n: number; a: Float64Array }>();
/** Each fan's area-weighted face normal, unit length. */
function turnOf(s: Float32Array, { fan, n }: { fan: Int32Array; n: number }) {
  const a = new Float64Array(n * 3);
  for (let o = 0; o + 9 <= s.length; o += 9) {
    const ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2], vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (let k = 0; k < 3; k++) { const f = fan[o / 3 + k] * 3; a[f] += x; a[f + 1] += y; a[f + 2] += z; }
  }
  for (let f = 0; f < n; f++) { const l = Math.hypot(a[f * 3], a[f * 3 + 1], a[f * 3 + 2]) || 1; for (let i = 0; i < 3; i++) a[f * 3 + i] /= l; }
  return a;
}

/** The file's normals per output corner: each output triangle's corner takes the normal of the nearest corner of the
 *  file triangle it came from (`source`, since the engine drops degenerate ones); NaN where it came from none. */
export function outNormals(positions: ArrayLike<number>, source: ArrayLike<number>, soup: Float32Array, normals: Float32Array): Float32Array {
  const n = new Float32Array(positions.length).fill(NaN);
  for (let t = 0; t < source.length; t++) {
    const s = source[t];
    if (s < 0 || s * 9 + 9 > soup.length || s * 9 + 9 > normals.length) continue;
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      let best = 0, bd = Infinity;
      for (let j = 0; j < 3; j++) {
        const q = s * 9 + j * 3, d = (soup[q] - positions[o]) ** 2 + (soup[q + 1] - positions[o + 1]) ** 2 + (soup[q + 2] - positions[o + 2]) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      n.set(normals.subarray(best, best + 3), o);
    }
  }
  return n;
}
