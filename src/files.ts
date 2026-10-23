// Model files in and out. Every mesh in an FBX/glTF/OBJ/STL becomes its own part; results export as one binary FBX
// (what Blender and Substance Painter both read) or one OBJ per part.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { PartOut } from './api';
import { fbxPolygons, polygonOfTriangles, type Polygons } from './fbxpoly.ts';

/** `poly`: per soup triangle, the file's polygon it came from, and `sides`: per polygon, its corner count (FBX);
 *  absent when the file has triangles only. `normals`: the file's own normals per soup corner (world space), what
 *  Blender shades with (smoothing, sharp edges, custom normals); absent when it has none. */
export interface PartData { name: string; soup: Float32Array; poly?: Int32Array; sides?: Int32Array; normals?: Float32Array }

/** The parts, and the file's unit in cm (FBX `UnitScaleFactor`; glTF, OBJ and STL are metres): three's loaders hand back
 *  raw coordinates in that unit, and the export writes it back so the model comes back at its own size. */
export async function readParts(file: File): Promise<{ parts: PartData[]; unit: number }> {
  const url = URL.createObjectURL(file), ext = file.name.split('.').pop()?.toLowerCase();
  try {
    const obj = ext === 'stl' ? new THREE.Mesh(await new STLLoader().loadAsync(url))
      : ext === 'obj' ? await new OBJLoader().loadAsync(url)
      : ext === 'fbx' ? await new FBXLoader().loadAsync(url)
      : (await new GLTFLoader().loadAsync(url)).scene;
    obj.updateMatrixWorld(true);
    const polys = ext === 'fbx' ? await fbxPolygons(await file.arrayBuffer()) : new Map<number, Polygons>();
    const parts: PartData[] = [], names = new Set<string>();
    obj.traverse((m) => {
      if (!(m instanceof THREE.Mesh)) return;
      const soup = bake(m);
      if (!soup.length) return;
      let name = m.name || m.parent?.name || `Part ${parts.length + 1}`;
      for (let i = 2; names.has(name); i++) name = `${m.name || 'Part'} ${i}`;
      names.add(name);
      const fp = polys.get((m as THREE.Mesh & { ID?: number }).ID ?? NaN);
      const raw = fp && (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry).attributes.position.array;
      const poly = (fp && raw && polygonOfTriangles(fp, raw)) || undefined;
      parts.push({ name, soup, poly, sides: poly && Int32Array.from(fp!, (c) => c.length), normals: bakeNormals(m) });
    });
    if (!parts.length) throw new Error('No triangles in that file');
    return { parts, unit: ext === 'fbx' ? fbxUnit(await file.arrayBuffer()) : 100 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function fbxUnit(buf: ArrayBuffer): number {
  const s = new TextDecoder('latin1').decode(buf); // one char per byte, so indices are byte offsets
  const ascii = /"UnitScaleFactor",\s*"double",\s*"Number",\s*"[^"]*",\s*([-+\d.eE]+)/.exec(s);
  // binary: P with props S"UnitScaleFactor" S"double" S"Number" S"" D<value>
  const bin = /\x0f\0\0\0UnitScaleFactorS\x06\0\0\0doubleS\x06\0\0\0NumberS\0\0\0\0D/.exec(s);
  const unit = ascii ? +ascii[1] : bin ? new DataView(buf, bin.index + bin[0].length, 8).getFloat64(0, true) : 1;
  return unit > 0 ? unit : 1;
}

// One mesh in world space, triangles only, as xyz per corner.
export function bake(m: THREE.Mesh): Float32Array {
  const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry, p = g.attributes.position;
  const out = new Float32Array(p.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); v.toArray(out, i * 3); }
  return out;
}

// Its normals the same way, per corner in world space (undefined if the file has none).
function bakeNormals(m: THREE.Mesh): Float32Array | undefined {
  const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry, n = g.attributes.normal;
  if (!n) return undefined;
  const out = new Float32Array(n.count * 3), v = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
  for (let i = 0; i < n.count; i++) { v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); v.toArray(out, i * 3); }
  return out;
}

// ---- export ----
/** One part to write: its unwrap, its current UVs, the material (= Painter texture set) it goes in, and `faces`: per
 *  output triangle, the polygon it belongs to (−1 or absent: written as triangles, e.g. Triangulate for baking). `normals`: the file's own
 *  normals per output corner (NaN where it had none), written as they are, as Blender's exporter writes its own. */
export interface ExportPart { name: string; material: string; out: PartOut; uv: Float32Array; faces?: Int32Array; normals?: Float32Array }

/** A part as an indexed mesh: positions welded (it imports as one connected mesh), UVs and normals indexed per corner.
 *  Normals are the file's own (`fileN`) where it had them, else smooth across edges flatter than `sharp` degrees and hard
 *  across the rest, as a baker wants them. */
function weld(p: PartOut, uv: Float32Array, sharp: number, fileN?: Float32Array) {
  const xyz: number[] = [], vi: number[] = [], uvs: number[] = [], ti: number[] = [], nrm: number[] = [], ni: number[] = [];
  const index = (ids: Map<string, number>, out: number[], v: number[]) => {
    const k = v.join();
    let id = ids.get(k);
    if (id === undefined) { ids.set(k, id = ids.size); out.push(...v); }
    return id;
  };
  const vids = new Map<string, number>(), tids = new Map<string, number>(), nids = new Map<string, number>();
  const corners = p.positions.length / 3, at = (c: number) => p.positions.slice(c * 3, c * 3 + 3);
  for (let c = 0; c < corners; c++) {
    vi.push(index(vids, xyz, at(c)));
    ti.push(index(tids, uvs, [uv[c * 2], uv[c * 2 + 1]]));
  }
  const unit = (v: number[]) => { const l = Math.hypot(...v); return l ? v.map((x) => x / l) : v; };
  const face: number[][] = [], round: number[][] = Array.from({ length: vids.size }, () => []);
  for (let t = 0; t < corners / 3; t++) {
    const [a, b, c] = [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)], u = b.map((x, k) => x - a[k]), w = c.map((x, k) => x - a[k]);
    face.push([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]); // area-weighted
    for (let k = 0; k < 3; k++) round[vi[t * 3 + k]].push(t);
  }
  const dir = face.map(unit), cos = Math.cos((sharp * Math.PI) / 180);
  for (let c = 0; c < corners; c++) {
    if (fileN && !Number.isNaN(fileN[c * 3])) { ni.push(index(nids, nrm, Array.from(fileN.subarray(c * 3, c * 3 + 3)))); continue; }
    const d = dir[Math.floor(c / 3)], s = [0, 0, 0];
    for (const f of round[vi[c]]) if (d[0] * dir[f][0] + d[1] * dir[f][1] + d[2] * dir[f][2] >= cos) face[f].forEach((x, k) => (s[k] += x));
    const n = unit(s);
    ni.push(index(nids, nrm, n.some(Boolean) ? n : [0, 1, 0])); // a degenerate triangle still gets a valid normal
  }
  return { xyz, vi, uvs, ti, nrm, ni };
}

/** The faces to write, as corner lists in winding order: each polygon's triangles joined back into one loop round its
 *  outline. A polygon whose inside has a seam (its corners would need two UVs) or whose outline isn't one loop goes
 *  out as its triangles. */
export function faceLoops(vi: number[], ti: number[], faces: Int32Array | undefined): number[][] {
  const tris = vi.length / 3, out: number[][] = [], groups = new Map<number, number[]>();
  for (let t = 0; t < tris; t++) {
    const p = faces?.[t] ?? -1;
    if (p < 0) out.push([t * 3, t * 3 + 1, t * 3 + 2]);
    else (groups.get(p) ?? groups.set(p, []).get(p)!).push(t);
  }
  const next = (c: number) => c - (c % 3) + ((c + 1) % 3);
  for (const ts of groups.values()) {
    const dir = new Map<string, number>(); // "a,b" → the corner the edge a→b starts at
    for (const t of ts) for (let k = 0; k < 3; k++) dir.set(`${vi[t * 3 + k]},${vi[next(t * 3 + k)]}`, t * 3 + k);
    const from = new Map<number, number>();
    let ok = dir.size === ts.length * 3;
    for (const [key, c] of dir) {
      const back = dir.get(key.split(',').reverse().join());
      if (back === undefined) { ok &&= !from.has(vi[c]); from.set(vi[c], c); }
      else ok &&= ti[c] === ti[next(back)] && ti[next(c)] === ti[back]; // the same UVs on both sides of an inside edge
    }
    const loop: number[] = [];
    if (ok && from.size) {
      let c = from.values().next().value!;
      do { loop.push(c); c = from.get(vi[next(c)]) ?? -1; } while (c >= 0 && c !== loop[0] && loop.length <= from.size);
      ok = c === loop[0] && loop.length === from.size;
    }
    if (ok) out.push(loop);
    else for (const t of ts) out.push([t * 3, t * 3 + 1, t * 3 + 2]);
  }
  return out;
}

const fileName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'part';

/** One OBJ per part, each with its normals and a `usemtl` naming its material (Painter's texture set).
 *  OBJ has no unit and Blender and Painter read it as metres, so positions are converted from `unit` (cm). */
export function toObjs(parts: ExportPart[], sharp: number, unit: number): { name: string; data: Uint8Array }[] {
  const enc = new TextEncoder(), used = new Set<string>();
  return parts.map((part) => {
    let name = fileName(part.name);
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${fileName(part.name)} ${i}`;
    used.add(name.toLowerCase());
    const w = weld(part.out, part.uv, sharp, part.normals), rows = (tag: string, a: number[], k: number) =>
      Array.from({ length: a.length / k }, (_, i) => `${tag} ${a.slice(i * k, i * k + k).join(' ')}`);
    const corner = (c: number) => `${w.vi[c] + 1}/${w.ti[c] + 1}/${w.ni[c] + 1}`;
    const lines = [`# Auto Unwrap`, `o ${part.name.replace(/[\r\n]/g, ' ')}`, ...rows('v', w.xyz.map((x) => x * unit / 100), 3), ...rows('vt', w.uvs, 2), ...rows('vn', w.nrm, 3),
      `usemtl ${part.material.replace(/\s+/g, '_')}`];
    for (const f of faceLoops(w.vi, w.ti, part.faces)) lines.push(`f ${f.map(corner).join(' ')}`);
    return { name: `${name}.obj`, data: enc.encode(lines.join('\n') + '\n') };
  });
}

// Binary FBX 7.4, laid out like Blender's own writer (io_scene_fbx/encode_bin.py): Blender reads binary FBX only.
type Prop = number | bigint | string | { d: number } | Float64Array | Int32Array | Uint8Array; // number → int32, { d } → double
type Node = [name: string, props: Prop[], children?: Node[]];
const FILE_ID = [0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1];
const FOOT_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FOOT_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];

function fbxBytes(nodes: Node[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder(), chunks: Uint8Array[] = [];
  let pos = 0;
  const put = (b: Uint8Array | number[]) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); chunks.push(u); pos += u.length; };
  const prop = (p: Prop): Uint8Array => {
    const raw = (code: string, data: Uint8Array, count?: number) => {
      const head = count === undefined ? 5 : 13, b = new Uint8Array(head + data.length), v = new DataView(b.buffer);
      b[0] = code.charCodeAt(0);
      if (count === undefined) v.setUint32(1, data.length, true);
      else { v.setUint32(1, count, true); v.setUint32(9, data.length, true); } // encoding 0: uncompressed
      b.set(data, head);
      return b;
    };
    const fixed = (code: string, n: number, set: (v: DataView) => void) => { const b = new Uint8Array(1 + n); b[0] = code.charCodeAt(0); set(new DataView(b.buffer, 1)); return b; };
    if (typeof p === 'number') return fixed('I', 4, (v) => v.setInt32(0, p, true));
    if (typeof p === 'bigint') return fixed('L', 8, (v) => v.setBigInt64(0, p, true));
    if (typeof p === 'string') return raw('S', enc.encode(p));
    if (p instanceof Uint8Array) return raw('R', p);
    if (p instanceof Float64Array) return raw('d', new Uint8Array(p.buffer, p.byteOffset, p.byteLength), p.length);
    if (p instanceof Int32Array) return raw('i', new Uint8Array(p.buffer, p.byteOffset, p.byteLength), p.length);
    return fixed('D', 8, (v) => v.setFloat64(0, p.d, true));
  };
  const write = (list: Node[]) => list.forEach(([name, props, kids = []], i) => {
    const ps = props.map(prop), id = enc.encode(name), head = new Uint8Array(13 + id.length), hv = new DataView(head.buffer);
    hv.setUint32(4, ps.length, true);
    hv.setUint32(8, ps.reduce((n, b) => n + b.length, 0), true);
    head[12] = id.length;
    head.set(id, 13);
    put(head);
    ps.forEach(put);
    if (kids.length) write(kids);
    if (kids.length || (!ps.length && i < list.length - 1)) put(new Uint8Array(13)); // end of a child list
    hv.setUint32(0, pos, true); // where this node ends
  });
  put([...enc.encode('Kaydara FBX Binary  \0'), 0x1a, 0, 0xe8, 0x1c, 0, 0]); // version 7400
  write(nodes);
  put(new Uint8Array(13));
  put([...FOOT_ID, 0, 0, 0, 0]);
  put(new Uint8Array(16 - (pos % 16)));
  put([0xe8, 0x1c, 0, 0, ...new Array(120).fill(0), ...FOOT_MAGIC]);
  const out = new Uint8Array(pos);
  chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
  return out;
}

/** All parts in one binary FBX: a mesh object per part, one material per distinct `material` (one Painter texture set each). */
export function toFbx(parts: ExportPart[], sharp: number, unit: number): Uint8Array<ArrayBuffer> {
  const D = (d: number) => ({ d }), P = (...p: Prop[]): Node => ['P', p], name = (s: string, cls: string) => `${s.replace(/[\0\x01]/g, '')}\0\x01${cls}`;
  const element = (type: string, kids: Node[]): Node => [`LayerElement${type}`, [0], [['Version', [101]], ['Name', [type === 'UV' ? 'UVMap' : '']], ...kids]];
  const objects: Node[] = [], links: Node[] = [], mats = new Map<string, bigint>();
  let next = 1000n;
  for (const part of parts) {
    const w = weld(part.out, part.uv, sharp, part.normals), geo = next++, model = next++, loops = faceLoops(w.vi, w.ti, part.faces);
    // per polygon-vertex, polygon by polygon: the order every ByPolygonVertex layer follows
    const order = loops.flat(), ends = new Set<number>();
    loops.reduce((n, f) => (ends.add(n + f.length - 1), n + f.length), 0);
    let mat = mats.get(part.material);
    if (mat === undefined) {
      mats.set(part.material, mat = next++);
      objects.push(['Material', [mat, name(part.material, 'Material'), ''], [['Version', [102]], ['ShadingModel', ['phong']], ['MultiLayer', [0]],
        ['Properties70', [], [P('DiffuseColor', 'Color', '', 'A', D(0.8), D(0.8), D(0.8))]]]]);
    }
    objects.push(['Geometry', [geo, name(part.name, 'Geometry'), 'Mesh'], [
      ['Vertices', [new Float64Array(w.xyz)]],
      ['PolygonVertexIndex', [Int32Array.from(order, (c, i) => (ends.has(i) ? ~w.vi[c] : w.vi[c]))]], // a polygon's last corner is stored as -(i+1)
      ['GeometryVersion', [124]],
      element('Normal', [['MappingInformationType', ['ByPolygonVertex']], ['ReferenceInformationType', ['Direct']],
        ['Normals', [new Float64Array(order.flatMap((c) => w.nrm.slice(w.ni[c] * 3, w.ni[c] * 3 + 3)))]]]),
      element('UV', [['MappingInformationType', ['ByPolygonVertex']], ['ReferenceInformationType', ['IndexToDirect']],
        ['UV', [new Float64Array(w.uvs)]], ['UVIndex', [Int32Array.from(order, (c) => w.ti[c])]]]),
      element('Material', [['MappingInformationType', ['AllSame']], ['ReferenceInformationType', ['IndexToDirect']], ['Materials', [new Int32Array(1)]]]),
      ['Layer', [0], [['Version', [100]], ...['Normal', 'UV', 'Material'].map((t): Node => ['LayerElement', [], [['Type', [`LayerElement${t}`]], ['TypedIndex', [0]]]])]],
    ]]);
    objects.push(['Model', [model, name(part.name, 'Model'), 'Mesh'], [['Version', [232]], ['Properties70', []]]]);
    links.push(['C', ['OO', geo, model]], ['C', ['OO', model, 0n]], ['C', ['OO', mat, model]]);
  }
  const axis = (n: string, v: number) => P(n, 'int', 'Integer', '', v);
  return fbxBytes([
    ['FBXHeaderExtension', [], [['FBXHeaderVersion', [1003]], ['FBXVersion', [7400]], ['EncryptionType', [0]], ['Creator', ['Auto Unwrap']],
      ['SceneInfo', [name('GlobalInfo', 'SceneInfo'), 'UserData'], [['Type', ['UserData']], ['Version', [100]],
        ['MetaData', [], [['Version', [100]], ...['Title', 'Subject', 'Author', 'Keywords', 'Revision', 'Comment'].map((k): Node => [k, ['']])]]]]]],
    ['FileId', [new Uint8Array(FILE_ID)]], ['CreationTime', ['1970-01-01 10:00:00:000']], ['Creator', ['Auto Unwrap']],
    // three.js space: Y up, right-handed; in the source file's unit (cm per unit).
    ['GlobalSettings', [], [['Version', [1000]], ['Properties70', [], [axis('UpAxis', 1), axis('UpAxisSign', 1), axis('FrontAxis', 2),
      axis('FrontAxisSign', 1), axis('CoordAxis', 0), axis('CoordAxisSign', 1), P('UnitScaleFactor', 'double', 'Number', '', D(unit))]]]],
    ['Documents', [], [['Count', [1]], ['Document', [1n, 'Scene', 'Scene'], [['RootNode', [0n]]]]]],
    ['References', []],
    ['Definitions', [], [['Version', [100]], ['Count', [objects.length]],
      ...(['Model', 'Geometry', 'Material'] as const).map((t): Node => ['ObjectType', [t], [['Count', [objects.filter((o) => o[0] === t).length]]]])]],
    ['Objects', [], objects],
    ['Connections', [], links],
  ]);
}

export function download(data: BlobPart, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data]));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A small, uncompressed ZIP writer for the OBJ-per-part export. */
export function zipFiles(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder(), chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const b of bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const file of files) {
    const name = enc.encode(file.name), data = file.data, crc = crc32(data);
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30);
    chunks.push(local, data);

    const dir = new Uint8Array(46 + name.length), dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true); dv.setUint16(10, 0, true); dv.setUint32(16, crc, true);
    dv.setUint32(20, data.length, true); dv.setUint32(24, data.length, true); dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true); dir.set(name, 46); central.push(dir);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end], out = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const chunk of all) { out.set(chunk, cursor); cursor += chunk.length; }
  return out;
}
