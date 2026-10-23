// The polygons three's FBXLoader triangulates away: per model, each polygon's corners, read straight from a binary FBX
// (`Vertices`, and `PolygonVertexIndex` with a polygon's last corner stored as −(i+1)). The loader triangulates polygon
// by polygon, in order, but its earcut drops a triangle now and then on awkward n-gons, so each triangle is given to
// the next polygon holding all three of its corners.
// ponytail: binary FBX only (what Blender writes); ASCII FBX comes in as triangles.

interface Node { name: string; props: unknown[]; kids: Node[] }
interface RawArray { type: string; encoding: number; bytes: Uint8Array }

function parse(buf: ArrayBuffer): Node[] | null {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (new TextDecoder().decode(u8.subarray(0, 18)) !== 'Kaydara FBX Binary') return null;
  const wide = dv.getUint32(23, true) >= 7500; // 64-bit record fields from FBX 7.5
  let at = 27;
  const word = () => { const v = wide ? Number(dv.getBigUint64(at, true)) : dv.getUint32(at, true); at += wide ? 8 : 4; return v; };
  const node = (): Node | null => {
    const end = word(), nprops = word();
    word(); // property list length
    const nameLen = u8[at++];
    if (end === 0) return null;
    const name = new TextDecoder().decode(u8.subarray(at, at + nameLen));
    at += nameLen;
    const props: unknown[] = [];
    for (let i = 0; i < nprops; i++) {
      const t = String.fromCharCode(u8[at++]);
      if (t === 'L') { props.push(dv.getBigInt64(at, true)); at += 8; }
      else if (t === 'I') { props.push(dv.getInt32(at, true)); at += 4; }
      else if (t === 'D') { props.push(dv.getFloat64(at, true)); at += 8; }
      else if (t === 'F') { props.push(dv.getFloat32(at, true)); at += 4; }
      else if (t === 'Y') { props.push(dv.getInt16(at, true)); at += 2; }
      else if (t === 'C') { props.push(!!u8[at]); at += 1; }
      else if (t === 'S' || t === 'R') { const n = dv.getUint32(at, true); props.push(t === 'S' ? new TextDecoder().decode(u8.subarray(at + 4, at + 4 + n)) : null); at += 4 + n; }
      else if ('fdlib'.includes(t)) {
        const encoding = dv.getUint32(at + 4, true), n = dv.getUint32(at + 8, true);
        props.push({ type: t, encoding, bytes: u8.subarray(at + 12, at + 12 + n) } satisfies RawArray);
        at += 12 + n;
      } else throw new Error(`FBX property type ${t}`);
    }
    const kids: Node[] = [];
    while (at < end) { const k = node(); if (k) kids.push(k); else break; }
    at = end;
    return { name, props, kids };
  };
  const top: Node[] = [];
  while (at < u8.length - 13) { const n = node(); if (!n) break; top.push(n); }
  return top;
}

async function bytesOf(a: RawArray): Promise<ArrayBuffer> {
  if (a.encoding !== 1) return a.bytes.slice().buffer;
  return new Response(new Blob([a.bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
}
const ints = async (a: RawArray) => new Int32Array(await bytesOf(a));
const doubles = async (a: RawArray) => (a.type === 'd' ? new Float64Array(await bytesOf(a)) : Float64Array.from(new Float32Array(await bytesOf(a))));

/** A model's polygons: per polygon its corners' positions as the loader's float32 buffer holds them (xyz keys). */
export type Polygons = string[][];
const key = (x: number, y: number, z: number) => `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`;

/** Model id (as FBXLoader's `object.ID`, a number) → its polygons. Empty if the file isn't binary FBX. */
export async function fbxPolygons(buf: ArrayBuffer): Promise<Map<number, Polygons>> {
  const out = new Map<number, Polygons>();
  let top: Node[] | null;
  try { top = parse(buf); } catch { return out; }
  if (!top) return out;
  const geo = new Map<bigint, Polygons>();
  for (const g of top.find((n) => n.name === 'Objects')?.kids ?? []) {
    const pvi = g.name === 'Geometry' && g.kids.find((k) => k.name === 'PolygonVertexIndex')?.props[0];
    const vs = g.kids.find((k) => k.name === 'Vertices')?.props[0];
    if (!pvi || !vs) continue;
    const p = await doubles(vs as RawArray), polys: Polygons = [];
    let cur: string[] = [];
    for (const v of await ints(pvi as RawArray)) {
      const i = v < 0 ? ~v : v;
      cur.push(key(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
      if (v < 0) { polys.push(cur); cur = []; }
    }
    geo.set(g.props[0] as bigint, polys);
  }
  for (const c of top.find((n) => n.name === 'Connections')?.kids ?? []) {
    const polys = c.props[0] === 'OO' && geo.get(c.props[1] as bigint);
    if (polys) out.set(Number(c.props[2] as bigint), polys);
  }
  return out;
}

/** Per triangle of the loader's buffer (`pos`, xyz per corner, before the model's transform), its polygon; null if
 *  a triangle fits none of the polygons left (the loader moved the points, e.g. a geometric transform). */
export function polygonOfTriangles(polys: Polygons, pos: ArrayLike<number>): Int32Array | null {
  // ponytail: linear walk, assumes the loader keeps polygon order (it does: one pass over PolygonVertexIndex)
  const tris = pos.length / 9, poly = new Int32Array(tris), sets = polys.map((c) => new Set(c));
  let i = 0;
  for (let t = 0; t < tris; t++) {
    const k = [0, 1, 2].map((c) => key(pos[t * 9 + c * 3], pos[t * 9 + c * 3 + 1], pos[t * 9 + c * 3 + 2]));
    while (i < sets.length && !k.every((x) => sets[i].has(x))) i++;
    if (i === sets.length) return null;
    poly[t] = i;
  }
  return poly;
}
