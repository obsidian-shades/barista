// A part's mesh as Blender's edit mode sees it: welded vertices, edges and faces (the output's triangles), so a
// selection means the same thing in the 3D view and the UV view. Built from the output's corner positions, cached
// per positions array (a reseam keeps the array, so the selection survives it).
export interface Topo {
  /** Welded vertex per corner. */
  vid: Int32Array;
  /** xyz per vertex. */
  pos: Float64Array;
  nv: number;
  /** Edge per corner c: the edge from c to the next corner of its triangle. */
  edge: Int32Array;
  /** Two vertex ids per edge. */
  ends: Int32Array;
  /** Triangles on each edge. */
  edgeTris: number[][];
  /** Vertex at an exact xyz (seams and engine answers name vertices by position). */
  at: Map<string, number>;
}

export const xyzKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

const cache = new WeakMap<number[], Topo>();
export function topoOf(positions: number[]): Topo {
  let t = cache.get(positions);
  if (t) return t;
  const nc = positions.length / 3, vid = new Int32Array(nc), at = new Map<string, number>(), pos: number[] = [];
  for (let c = 0; c < nc; c++) {
    const k = xyzKey(positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]);
    let v = at.get(k);
    if (v === undefined) { v = at.size; at.set(k, v); pos.push(positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]); }
    vid[c] = v;
  }
  const nv = at.size, ids = new Map<number, number>(), ends: number[] = [], edgeTris: number[][] = [], edge = new Int32Array(nc);
  for (let c = 0; c < nc; c++) {
    const a = vid[c], b = vid[c - (c % 3) + ((c + 1) % 3)], key = Math.min(a, b) * nv + Math.max(a, b);
    let e = ids.get(key);
    if (e === undefined) { e = edgeTris.length; ids.set(key, e); ends.push(Math.min(a, b), Math.max(a, b)); edgeTris.push([]); }
    edge[c] = e;
    edgeTris[e].push((c / 3) | 0);
  }
  t = { vid, pos: new Float64Array(pos), nv, edge, ends: new Int32Array(ends), edgeTris, at };
  cache.set(positions, t);
  return t;
}

const polyCache = new WeakMap<number[], { poly: Int32Array | undefined; out: Int32Array }>();
/** Per output triangle: its polygon in the file (−1: none known, a triangle of its own), from the input triangle's
 *  polygon (`poly`, per soup triangle) through the engine's `source`. */
export function polygonsOf(source: number[], poly: Int32Array | undefined): Int32Array {
  const hit = polyCache.get(source);
  if (hit && hit.poly === poly) return hit.out;
  const out = Int32Array.from(source, (s) => poly?.[s] ?? -1);
  polyCache.set(source, { poly, out });
  return out;
}
/** Per output triangle: how many sides its polygon has in the file (`sides`, per polygon; 3 when unknown). */
export function sidesOf(pid: Int32Array, sides: Int32Array | undefined): Int32Array {
  return Int32Array.from(pid, (p) => (p < 0 || !sides ? 3 : sides[p]));
}

/** The vertex at an xyz: exact, else the nearest within 1e-5 (positions that took another float round trip). */
export function vertexAt(t: Topo, x: number, y: number, z: number): number {
  const v = t.at.get(xyzKey(x, y, z));
  if (v !== undefined) return v;
  let best = -1, bd = 1e-5;
  for (let i = 0; i < t.nv; i++) {
    const d = Math.hypot(t.pos[i * 3] - x, t.pos[i * 3 + 1] - y, t.pos[i * 3 + 2] - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** The edge between two vertices, or −1. */
export function edgeBetween(t: Topo, a: number, b: number): number {
  for (const tri of trisOf(t, a)) for (let k = 0; k < 3; k++) {
    const e = t.edge[tri * 3 + k];
    if ((t.ends[e * 2] === a && t.ends[e * 2 + 1] === b) || (t.ends[e * 2] === b && t.ends[e * 2 + 1] === a)) return e;
  }
  return -1;
}

const vtCache = new WeakMap<Topo, number[][]>();
/** Triangles around a vertex. */
export function trisOf(t: Topo, v: number): number[] {
  let vt = vtCache.get(t);
  if (!vt) {
    vt = Array.from({ length: t.nv }, () => []);
    for (let c = 0; c < t.vid.length; c++) vt[t.vid[c]].push((c / 3) | 0);
    vtCache.set(t, vt);
  }
  return vt[v];
}
