// Build a fresh, editable reference project directly from an FBX. The old project is never read.
// Uses Barista's FBX reader, Rust unwrap engine, material actions, project serializer and FBX writer.
//   node tools/style-barista-project.ts <input.fbx> <output-directory>
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { bake, fbxUnit } from '../src/files.ts';
import { fbxPolygons, polygonOfTriangles } from '../src/fbxpoly.ts';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('usage: node tools/style-barista-project.ts <input.fbx> <output-directory>');
const source = resolve(sourceArg), outputDir = resolve(outputArg), base = 'Gun_Low_from_scratch';
mkdirSync(outputDir, { recursive: true });
const projectPath = join(outputDir, `${base}.barista`), fbxPath = join(outputDir, `${base}.fbx`);

function compressLz4(input: Uint8Array): Uint8Array {
  const out: number[] = [input.length & 255, (input.length >>> 8) & 255, (input.length >>> 16) & 255, (input.length >>> 24) & 255];
  const table = new Int32Array(1 << 16); table.fill(-1);
  const hash = (i: number) => Math.imul((input[i] | (input[i + 1] << 8) | (input[i + 2] << 16) | (input[i + 3] << 24)), 2654435761) >>> 16;
  const extra = (n: number) => { while (n >= 255) { out.push(255); n -= 255; } out.push(n); };
  let at = 0, anchor = 0;
  while (at + 4 <= input.length) {
    const h = hash(at), ref = table[h]; table[h] = at;
    if (ref < 0 || at - ref > 65535 || input[ref] !== input[at] || input[ref + 1] !== input[at + 1] || input[ref + 2] !== input[at + 2] || input[ref + 3] !== input[at + 3]) { at++; continue; }
    let length = 4; while (at + length < input.length && input[ref + length] === input[at + length]) length++;
    const literalCount = at - anchor, matchExtra = length - 4, tokenAt = out.length;
    out.push((Math.min(15, literalCount) << 4) | Math.min(15, matchExtra));
    if (literalCount >= 15) extra(literalCount - 15);
    for (let j = anchor; j < at; j++) out.push(input[j]);
    const distance = at - ref; out.push(distance & 255, distance >>> 8);
    if (matchExtra >= 15) extra(matchExtra - 15);
    at += length; anchor = at;
    for (let j = Math.max(anchor - length + 1, 0); j + 4 <= anchor; j++) table[hash(j)] = j;
    void tokenAt;
  }
  const literalCount = input.length - anchor;
  out.push(Math.min(15, literalCount) << 4);
  if (literalCount >= 15) extra(literalCount - 15);
  for (let j = anchor; j < input.length; j++) out.push(input[j]);
  return Uint8Array.from(out);
}

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
function png(width: number, height: number, pixels: Uint8Array, channels: 1 | 4) {
  const chunk = (name: string, data: Uint8Array) => {
    const type = new TextEncoder().encode(name), out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(type, 4); out.set(data, 8); view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
  };
  const header = new Uint8Array(13), h = new DataView(header.buffer);
  h.setUint32(0, width); h.setUint32(4, height); header[8] = 8; header[9] = channels === 4 ? 6 : 0;
  const rows = new Uint8Array(height * (width * channels + 1));
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * channels, (y + 1) * width * channels), y * (width * channels + 1) + 1);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())];
  return Buffer.concat(parts);
}

const scratch = mkdtempSync(join(tmpdir(), 'barista-fresh-'));
const raw = readFileSync(source), arrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
const root = new FBXLoader().parse(arrayBuffer, ''); root.updateMatrixWorld(true);
const polyMap = await fbxPolygons(arrayBuffer), imported: any[] = [], names = new Set<string>();
root.traverse((mesh) => {
  if (!(mesh instanceof THREE.Mesh)) return;
  const soup = bake(mesh); if (!soup.length) return;
  let name = mesh.name || `Part ${imported.length + 1}`;
  for (let n = 2; names.has(name); n++) name = `${mesh.name || 'Part'} ${n}`;
  names.add(name);
  const polys = polyMap.get((mesh as THREE.Mesh & { ID?: number }).ID ?? NaN);
  const rawPositions = polys && (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry).attributes.position.array;
  const poly = polys && rawPositions && polygonOfTriangles(polys, rawPositions);
  const normals = (() => { const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry, n = g.attributes.normal; if (!n) return undefined; const out = new Float32Array(n.count * 3), v = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld); for (let i = 0; i < n.count; i++) { v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize().toArray(out, i * 3); } return out; })();
  imported.push({ name, soup, poly: poly && Int32Array.from(poly), sides: poly && Int32Array.from(polys!, (c: number[]) => c.length), normals });
});
if (!imported.length) throw new Error('No mesh triangles found in the FBX');
const unwrapInput = join(scratch, 'in.json'), unwrapOutput = join(scratch, 'out.json');
writeFileSync(unwrapInput, JSON.stringify({ parts: imported.map((p) => ({ name: p.name, positions: Array.from(p.soup), polys: p.poly ? Array.from(p.poly) : [] })), params: { sharp: 45, tol: 0.08, seam_weight: 0.1, join: true, atlas: 0, one_atlas: false } }));
const cargo = spawnSync('cargo', ['run', '--release', '--example', 'headless_unwrap_json', '--', unwrapInput, unwrapOutput], { cwd: join(dirname(source), 'barista', 'engine'), encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: resolve('target/check') }, maxBuffer: 1024 * 1024 * 64 });
if (cargo.status !== 0) throw new Error(`Barista Rust unwrap failed: ${cargo.stderr || cargo.stdout}`);
const rust = JSON.parse(readFileSync(unwrapOutput, 'utf8'));
const out = rust.output;
const parts = imported.map((p, i) => ({ ...p, seams: [], marked: [], solved: [], visible: true, textured: true, stale: false }));

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
try {
  const [store, project, paint, files, topo, polyedit] = await Promise.all([
    vite.ssrLoadModule('/src/store.ts'), vite.ssrLoadModule('/src/project.ts'), vite.ssrLoadModule('/src/paint.ts'),
    vite.ssrLoadModule('/src/files.ts'), vite.ssrLoadModule('/src/topo.ts'), vite.ssrLoadModule('/src/polyedit.ts'),
  ]);
  store.useApp.setState({ parts, source: source.split(/[\\/]/).pop(), unit: fbxUnit(arrayBuffer), result: out, uvs: out.parts.map((p: any) => Float32Array.from(p.uvs)), params: { sharp: 45, tol: 0.08, seam_weight: 0.1, join: true, atlas: 0, one_atlas: false }, textureResolution: 512, workspace: 'paint', project: projectPath, saved: true, loading: null, linkSets: true, layerSel: parts.map((_: unknown, i: number) => i), activePart: 0 });
  const setPaint = (color: string, rough: number, metal: number) => store.useApp.setState((s: any) => ({ paint: { ...s.paint, color, rough, metal } }));
  setPaint('#27282d', 0.43, 0.72);
  store.useApp.setState({ activePart: 0, linkSets: true });
  store.addSolidFill();
  const grip = parts.findIndex((p: any) => p.name === 'Grip_Low');
  if (grip >= 0) { store.useApp.setState({ activePart: grip, linkSets: false }); setPaint('#17191d', 0.88, 0.04); store.addSolidFill(); }
  for (const name of ['Trigger_Low', 'Shell_Low', 'Buttons_Low']) {
    const i = parts.findIndex((p: any) => p.name === name);
    if (i >= 0) { store.useApp.setState({ activePart: i, linkSets: false }); setPaint('#7b439f', 0.26, 0.82); store.addSolidFill(); }
  }
  const s = store.useApp.getState();
  const saved = project.docOf(s, (i: number) => paint.setIfAny(s.parts[i].soup));

  const outDb = new DatabaseSync(`${projectPath}.saving`);
  outDb.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE blob(name TEXT PRIMARY KEY, data BLOB NOT NULL);');
  const meta = outDb.prepare('INSERT INTO meta(key,value) VALUES(?,?)');
  meta.run('format', '1'); meta.run('app', '0.1.0'); meta.run('doc', JSON.stringify(saved.doc));
  const put = outDb.prepare('INSERT INTO blob(name,data) VALUES(?,?)');
  for (const [name, raw] of saved.blobs as [string, Uint8Array][]) put.run(name, compressLz4(raw));
  outDb.close(); renameSync(`${projectPath}.saving`, projectPath);

  const outParts = s.parts.map((part: any, i: number) => {
    const out = s.result.parts[i], normals = part.normals?.length === part.soup.length
      ? polyedit.outNormals(out.positions, out.source, part.soup, part.normals) : undefined;
    const name = part.name, filesForPart = { color: `${base}-${name}-BaseColor.png`, rough: `${base}-${name}-Roughness.png`, metal: `${base}-${name}-Metallic.png`, normal: `${base}-${name}-Normal.png` };
    const ts = paint.setIfAny(part.soup);
    if (ts) {
      const n = ts.size, color = new Uint8Array(ts.color.image.data), orm = new Uint8Array(ts.orm.image.data), normal = new Uint8Array(ts.normal.image.data);
      writeFileSync(join(outputDir, filesForPart.color), png(n, n, color, 4));
      writeFileSync(join(outputDir, filesForPart.normal), png(n, n, normal, 4));
      const rough = new Uint8Array(n * n), metal = new Uint8Array(n * n);
      for (let p = 0; p < rough.length; p++) { rough[p] = orm[p * 4 + 1]; metal[p] = orm[p * 4 + 2]; }
      writeFileSync(join(outputDir, filesForPart.rough), png(n, n, rough, 1));
      writeFileSync(join(outputDir, filesForPart.metal), png(n, n, metal, 1));
    }
    return { name, material: name, out, uv: s.uvs[i], faces: part.poly ? topo.polygonsOf(out.source, part.poly) : undefined, normals,
      maps: { DiffuseColor: filesForPart.color, ReflectionFactor: filesForPart.metal, ShininessExponent: filesForPart.rough, NormalMap: filesForPart.normal } };
  });
  writeFileSync(fbxPath, files.toFbx(outParts, s.params.sharp, s.unit));
  console.log(`Saved Barista-styled project: ${projectPath}`);
  console.log(`Exported textured FBX and maps: ${fbxPath}`);
  console.log(`Parts: ${s.parts.map((p: any) => p.name).join(', ')}`);
} finally { await vite.close(); rmSync(scratch, { recursive: true, force: true }); }

