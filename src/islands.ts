// Derived views of a result: which corners make each island, picking in UV space, and where the seams run in 3D.
import type { Output } from './api';

export interface IslandRef { part: number; corners: number[] }

const cache = new WeakMap<Output, IslandRef[]>();
export function islandsOf(r: Output): IslandRef[] {
  let out = cache.get(r);
  if (!out) {
    out = [];
    r.parts.forEach((p, part) => p.island.forEach((id, t) => {
      if (id < 0) return; // Progressive loading uses negative ids for mesh-only preview triangles.
      (out![id] ??= { part, corners: [] }).corners.push(t * 3, t * 3 + 1, t * 3 + 2);
    }));
    cache.set(r, out);
  }
  return out;
}

/** The triangle under (u, v): its part and index, or null. `at`: each part's offset in the view (see uvTiles), null if not shown. */
export function pickTri(r: Output, uvs: Float32Array[], at: ([number, number] | null)[], U: number, V: number): { part: number; tri: number } | null {
  for (let pi = 0; pi < r.parts.length; pi++) {
    const o0 = at[pi];
    if (!o0 || !uvs[pi]) continue;
    const u = U - o0[0], v = V - o0[1];
    const a = uvs[pi], isl = r.parts[pi].island;
    for (let t = 0; t < isl.length; t++) {
      const o = t * 6;
      const d1 = side(a[o], a[o + 1], a[o + 2], a[o + 3], u, v), d2 = side(a[o + 2], a[o + 3], a[o + 4], a[o + 5], u, v), d3 = side(a[o + 4], a[o + 5], a[o], a[o + 1], u, v);
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return { part: pi, tri: t };
    }
  }
  return null;
}
const side = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

/** Island borders on the model, as line segments (xyz xyz): edges whose two sides have different UVs, and (`open`)
 *  edges with one side only. */
export function seamSegments(positions: number[], uvs: number[], open = true): number[] {
  const key = (c: number) => `${positions[c * 3]},${positions[c * 3 + 1]},${positions[c * 3 + 2]}`;
  const seen = new Map<string, { a: number; b: number; n: number; seam: boolean }>();
  for (let c = 0; c < positions.length / 3; c++) {
    const a = c, b = c - (c % 3) + ((c + 1) % 3), ka = key(a), kb = key(b), k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const e = seen.get(k);
    if (!e) { seen.set(k, { a, b, n: 1, seam: false }); continue; }
    e.n++;
    // the other side runs the edge the other way: its b sits where our a does
    const same = (x: number, y: number) => uvs[x * 2] === uvs[y * 2] && uvs[x * 2 + 1] === uvs[y * 2 + 1];
    const [p, q] = key(e.a) === ka ? [e.a, e.b] : [e.b, e.a];
    if (!same(p, a) || !same(q, b)) e.seam = true;
  }
  const out: number[] = [];
  for (const e of seen.values()) {
    if ((open && e.n === 1) || e.seam) out.push(...positions.slice(e.a * 3, e.a * 3 + 3), ...positions.slice(e.b * 3, e.b * 3 + 3));
  }
  return out;
}
