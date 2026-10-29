// Copy DECALmachine's decals into the Geometry tab's relief library.
//
// DECALmachine decals are not images painted on a surface: each is a quad with a matched material and three
// maps — normal, ao_curv_height (RGB = AO / curvature / height) and masks (R = coverage) — plus decal.png, the
// asset browser's render of it. That is exactly what the Geometry tab writes (Normal + Height from a projector),
// so this copies the maps into public/assets/geometry/decalmachine and writes the index the shelf loads.
//
//   node tools/dm-decals.mjs "C:\path\to\Blender – DECALmachine v2.16.1\assets"
//
// The assets are DECALmachine's, not Barista's: the output folder is git-ignored (like public/assets/materials/pack) and
// stays a local, personal-use import. The DECALmachine licence does not allow redistributing its assets.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'geometry', 'decalmachine');
const URL_BASE = '/assets/geometry/decalmachine';
const kinds = [
  ['Decals/Examples', 'detail', 'Detail', 'Details', 14, 'A DECALmachine greeble / panel-detail decal, as relief.'],
  ['Decals/Example Panels', 'panel', 'Panel', 'Panels', 14, 'A DECALmachine panel decal, as relief.'],
  ['Trims', 'trim', 'Trim', 'Trims', 25, 'A DECALmachine trim decal: a strip cut from a trim sheet, as relief.'],
];

/** PNG width and height from its IHDR (the only header data needed; no decoding). */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const root = process.argv[2];
if (!root || !existsSync(root)) {
  console.error('Usage: node tools/dm-decals.mjs "<DECALmachine assets folder>"');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const decals = [];
for (const [dir, slug, prefix, category, size, notes] of kinds) {
  const base = join(root, dir);
  if (!existsSync(base)) { console.warn(`no ${dir} in ${root}`); continue; }
  // a decal folder holds all three maps; anything else (a trim sheet holding its trims) is a container to look in
  const isDecal = (p) => ['normal.png', 'ao_curv_height.png', 'masks.png'].every((f) => existsSync(join(p, f)));
  const folders = [];
  for (const name of readdirSync(base).sort()) {
    const p = join(base, name);
    if (!statSync(p).isDirectory()) continue;
    if (isDecal(p)) { folders.push([name, p]); continue; }
    for (const sub of readdirSync(p).sort()) {
      const q = join(p, sub);
      if (statSync(q).isDirectory() && isDecal(q)) folders.push([`${name}-${sub}`, q]);
    }
  }
  for (const [name, src] of folders) {
    const id = `dm-${slug}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const maps = { normal: 'normal.png', height: 'ao_curv_height.png', mask: 'masks.png' };
    if (!Object.values(maps).every((f) => existsSync(join(src, f)))) { console.warn(`skip ${src}: a map is missing`); continue; }
    const [w, h] = pngSize(join(src, maps.normal));
    const dest = join(OUT, id);
    mkdirSync(dest, { recursive: true });
    for (const f of [...Object.values(maps), 'decal.png']) {
      if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dest, f));
    }
    decals.push({
      id, name: `${prefix} ${name.replace(/^.*-/, '')}`, category,
      tags: ['decalmachine', 'relief', 'normal', 'height', slug],
      notes, file: `${URL_BASE}/${id}/decal.png`,
      relief: { normal: `${URL_BASE}/${id}/normal.png`, height: `${URL_BASE}/${id}/ao_curv_height.png`, mask: `${URL_BASE}/${id}/masks.png` },
      width: w, height: h, size,
      license: 'DECALmachine asset, local use', source: 'DECALmachine 2.16.1',
    });
  }
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify({
  version: 1, source: 'DECALmachine 2.16.1 (imported locally)',
  license: 'DECALmachine assets: personal use, not redistributable', decals,
}, null, 1));
console.log(`wrote ${decals.length} relief decals to ${OUT}`);
