#!/usr/bin/env node
// Fetch the starter PBR library from ambientCG (CC0) into public/assets/materials/core.
//
//   node tools/fetch-materials.mjs                 # all curated materials
//   node tools/fetch-materials.mjs --only=metal-gold-polished,wood-oak-light
//   node tools/fetch-materials.mjs --force         # re-download what exists
//   node tools/fetch-materials.mjs --verify        # no network: check index + JPEGs
//
// Each material is one JPG zip on ambientCG (2K for weapon heroes, 1K for support
// sets, or the per-entry `format` override), unpacked to the maps the painter needs
// (basecolor, normal GL, roughness, metallic when present, AO, height). The manifest
// is written to public/assets/materials/core/index.json. The binary folders are git-ignored: run
// this script after a fresh clone.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'public', 'assets', 'materials', 'core');
const SPEC = JSON.parse(await readFile(join(ROOT, 'tools', 'materials.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);
const force = flag('force');
const verifyOnly = flag('verify');

// Map suffix in the ambientCG zip -> name in our folder. Order matters only for logs.
const MAPS = [
  ['Color', 'basecolor'],
  ['NormalGL', 'normal'],
  ['Roughness', 'roughness'],
  ['Metalness', 'metallic'],
  ['AmbientOcclusion', 'ao'],
  ['Displacement', 'height'],
];
const ALL = SPEC.materials;
const TODO = only.length ? ALL.filter((m) => only.includes(m.id)) : ALL;

const fsize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

/** Width/height from a JPEG's SOF marker, for the manifest check. */
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'barista-material-fetch/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function download(url, dest) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'barista-material-fetch/1.0' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1024) throw new Error(`short download (${buf.length} bytes)`);
      await writeFile(dest, buf);
      return buf.length;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw last;
}

/** Unpack a zip with bsdtar (Windows 10+, macOS) or unzip; no npm dependency. */
function unzip(zip, dir) {
  try {
    execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' });
    return;
  } catch {
    try {
      execFileSync('unzip', ['-oq', zip, '-d', dir], { stdio: 'inherit' });
      return;
    } catch {
      throw new Error(`could not unpack ${basename(zip)} (need tar or unzip on PATH)`);
    }
  }
}

async function readManifest() {
  const file = join(LIB, 'index.json');
  if (!existsSync(file)) return { materials: [] };
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return { materials: [] }; }
}

async function verify() {
  const index = await readManifest();
  if (!index.materials?.length) throw new Error('public/assets/materials/core/index.json is missing or empty — run without --verify first');
  let bad = 0, bytes = 0;
  for (const m of index.materials) {
    const dir = join(LIB, m.id);
    const dims = new Set();
    for (const [key, file] of Object.entries(m.maps)) {
      const p = join(dir, file);
      if (!existsSync(p)) { console.error(`MISSING ${m.id}/${file} (${key})`); bad++; continue; }
      const s = await stat(p); bytes += s.size;
      const size = jpegSize(await readFile(p));
      if (!size) { console.error(`NOT JPEG ${m.id}/${file}`); bad++; continue; }
      dims.add(`${size.width}x${size.height}`);
      if (size.width !== m.width || size.height !== m.height) { console.error(`BAD SIZE ${m.id}/${file}: ${size.width}x${size.height}, manifest ${m.width}x${m.height}`); bad++; }
    }
    if (dims.size > 1) { console.error(`MIXED SIZES ${m.id}: ${[...dims].join(', ')}`); bad++; }
    if (!existsSync(join(dir, 'thumb.jpg'))) console.warn(`  no thumb.jpg for ${m.id}`);
  }
  const sizes = [...new Set(index.materials.map((m) => `${m.width}x${m.height}`))].join(', ');
  console.log(`${index.materials.length} materials (${sizes}), ${fsize(bytes)} of maps, ${bad ? `${bad} problem(s)` : 'all maps present and consistent'}`);
  return bad === 0;
}

if (verifyOnly) {
  process.exit((await verify()) ? 0 : 1);
}

await mkdir(LIB, { recursive: true });
const manifest = await readManifest();
const byId = new Map((manifest.materials ?? []).map((m) => [m.id, m]));
const temps = [];
let done = 0, skipped = 0, bytes = 0;

for (const m of TODO) {
  const dir = join(LIB, m.id);
  // Metallic and AO are optional, so "already there" means the three maps every set has.
  const haveCore = ['basecolor', 'normal', 'roughness'].every((f) => existsSync(join(dir, `${f}.jpg`)));
  if (byId.has(m.id) && haveCore && !force) {
    console.log(`skip  ${m.id} (already there)`);
    skipped++;
    continue;
  }
  const format = m.format ?? SPEC.format;
  console.log(`fetch ${m.id}  (${m.asset}, ${format})`);
  const meta = await fetchJson(`https://ambientcg.com/api/v3/assets?id=${encodeURIComponent(m.asset)}&include=downloads,title,url`);
  const asset = meta.assets?.[0];
  if (!asset) throw new Error(`ambientCG has no asset ${m.asset}`);
  const zip = asset.downloads?.find((d) => d.attributes === format);
  if (!zip) throw new Error(`${m.asset} has no ${format} download`);
  const tmp = join(tmpdir(), `barista-material-${m.asset}-${process.pid}`);
  temps.push(tmp);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const zpath = join(tmp, 'asset.zip');
  const n = await download(zip.url, zpath);
  console.log(`      ${zip.url.split('/').pop()}  ${fsize(n)}`);
  const out = join(tmp, 'x');
  await mkdir(out, { recursive: true });
  unzip(zpath, out);
  const files = await readdir(out);
  await mkdir(dir, { recursive: true });
  const maps = {};
  for (const [suffix, key] of MAPS) {
    const hit = files.find((f) => new RegExp(`_${suffix}\\.(jpe?g|png)$`, 'i').test(f));
    if (!hit) continue;
    const to = join(dir, `${key}.jpg`);
    await copyFile(join(out, hit), to);
    maps[key] = `${key}.jpg`;
    bytes += (await stat(to)).size;
  }
  if (!maps.basecolor || !maps.normal || !maps.roughness) throw new Error(`${m.asset}: missing Color/NormalGL/Roughness`);
  const dim = jpegSize(await readFile(join(dir, maps.basecolor)));
  if (!dim) throw new Error(`${m.asset}: basecolor is not a JPEG`);
  const entry = {
    id: m.id,
    name: m.name,
    category: m.category,
    role: m.role ?? 'prop',
    tags: m.tags,
    notes: m.notes,
    asset: m.asset,
    source: asset.url ?? `https://ambientcg.com/a/${m.asset}`,
    license: SPEC.license,
    width: dim.width,
    height: dim.height,
    normal: 'gl',
    maps,
    thumb: existsSync(join(dir, 'thumb.jpg')) ? 'thumb.jpg' : null,
  };
  byId.set(m.id, entry);
  done++;
  console.log(`      ${Object.keys(maps).join(', ')}`);
}

const order = new Map(ALL.map((m, i) => [m.id, i]));
const materials = [...byId.values()].filter((m) => existsSync(join(LIB, m.id, 'basecolor.jpg'))).sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
// Entries can predate the width/height fields (or be skipped on this run): read them back from disk.
for (const m of materials) {
  // A skipped material keeps its old manifest entry; refresh the curatorial fields from tools/materials.json.
  const cur = ALL.find((x) => x.id === m.id);
  if (cur?.role) m.role = cur.role;
  if (m.width && m.height) continue;
  const dim = jpegSize(await readFile(join(LIB, m.id, m.maps.basecolor)));
  if (dim) { m.width = dim.width; m.height = dim.height; }
  delete m.size;
}
const maxSize = Math.max(1024, ...materials.map((m) => Math.max(m.width ?? 0, m.height ?? 0)));
const index = {
  version: 2,
  generated: new Date().toISOString().slice(0, 10),
  source: SPEC.source,
  license: SPEC.license,
  maxSize,
  normalConvention: 'gl',
  materials,
};
await writeFile(join(LIB, 'index.json'), JSON.stringify(index, null, 2) + '\n');
for (const t of temps) await rm(t, { recursive: true, force: true });
console.log(`\n${done} fetched, ${skipped} skipped, ${materials.length} in index, ${fsize(bytes)} written`);
console.log(`index: ${relative(ROOT, join(LIB, 'index.json'))}`);
