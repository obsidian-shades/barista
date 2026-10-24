# Game-first PBR material library

**50** physically based materials from [ambientCG](https://ambientcg.com), all **CC0 1.0** (public
domain): free for commercial work, no attribution required. They are the built-in shelf of Van
Gogh's Materials panel; the app only needs `index.json` plus the per-material folders.

The shelf leads with hard-surface weapon materials matching the reference pistol (brushed and
anodized metals, black oxide, graphite, textured polymer, stipple rubber, carbon twill, leather).
Environment sets for the rest of the level follow, then the original starter materials. Each entry
has a `role` (`weapon`, `character`, `environment`, `prop`) so the panel's **For** filters work.

```
public/materials/
  index.json                 manifest: names, categories, roles, tags, maps, license, source
  contact-sheet.jpg          all 50 lit PBR sphere previews
  maps.jpg                   one material's base color / normal / roughness / metallic
  <id>/
    basecolor.jpg            sRGB
    normal.jpg               tangent-space OpenGL (green = +Y)
    roughness.jpg            linear, white = rough
    metallic.jpg             linear, white = metal (absent on dielectrics)
    ao.jpg                   linear (absent when ambientCG has no AO bake)
    height.jpg               linear displacement / height
    thumb.jpg                256 px lit PBR sphere for the shelf
```

`index.json` records each set's true `width`/`height`: the weapon heroes are 2048x2048, most
support sets are 1024x1024, and some source sets are 1024x512. Do not assume square maps.

Missing `metallic.jpg` means **not a metal** (default 0). Missing `ao.jpg` means no baked AO
for that asset (default 1). That is normal, not a broken set.

## Refresh / add more

The binary folders (maps and per-material thumbnails) are git-ignored; `index.json`,
`CREDITS.md`, `README.md`, `contact-sheet.jpg` and `maps.jpg` are tracked.
After a fresh clone:

```bash
node tools/fetch-materials.mjs          # download all curated sets
python tools/material-thumbs.py         # PBR sphere thumbnails + contact sheet (Pillow + numpy)
node tools/fetch-materials.mjs --verify # check every map is present
```

To add a material, add an entry to `tools/materials.json` (ambientCG asset id, friendly id,
name, category, role, tags; optional `format` such as `2K-JPG`), then:

```bash
node tools/fetch-materials.mjs --only=my-new-material
python tools/material-thumbs.py
```

Keep 1K for large environment sets and use 2K for hero surfaces. 4K is fine for a single project
but should not become the default shelf: a 2K six-map metal decodes to ~84 MB of RGBA.

## Importing your own (including Substance-baked) maps

Name the files however you like, but the app's folder importer will look for these suffixes
(case-insensitive):

| Channel | Recognised name fragments |
| --- | --- |
| Base color | `_BaseColor`, `_Base_Color`, `_Albedo`, `_Color`, `_Diffuse` |
| Normal | `_Normal`, `_NormalGL`, `_Normal_OpenGL` |
| Roughness | `_Roughness`, `_Rough` |
| Metallic | `_Metallic`, `_Metalness`, `_Metal` |
| Ambient occlusion | `_AO`, `_AmbientOcclusion`, `_Occlusion` |
| Height | `_Height`, `_Displacement` |

Normal maps must be tangent-space **OpenGL** (green up). Unreal/Substance DirectX bakes have
green down; flip G on import or at export. glTF and three.js use OpenGL.

## License

The assets are CC0 1.0. See `CREDITS.md` for the per-asset source links.
[CC0 summary](https://creativecommons.org/publicdomain/zero/1.0/) ·
[ambientCG license](https://docs.ambientcg.com/license/).
