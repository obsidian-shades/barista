"""Extract the purchased PBR Asset Browser materials from a .blend into a staged pack.

Run inside Blender (one process per .blend; the files are large):

    blender -b --factory-startup "Metals.blend" --python tools/blender-extract.py -- \
        D:\barista-pack-raw Metals

It writes only raw packed image bytes (deduplicated by SHA-1) plus one JSONL line per
material. `tools/build-pack.py` then downsizes to the web library and writes the manifest.
Nothing is saved back into the .blend.

What the files hold, besides the maps: each material is a marked asset (`asset_data`: catalog
simple name, tags, description); the viewer's own materials aren't. Normals go through a
"Normal Inverter" group (green flipped: the maps are DirectX). A Value node drives Mapping's
Scale, the repeat the author tuned per material. Unlinked Principled inputs are constants
(a metal with no metallic map is Metallic 1). Blender cuts ID names, the maps keep the whole one.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

import bpy

CHANNELS = {'Red': 'r', 'Green': 'g', 'Blue': 'b', 'Alpha': 'a'}
ROLE = {
    'Metals': 'weapon', 'Plastic': 'weapon',
    'Fabric': 'character',
    'Concerete': 'environment', 'Concrete': 'environment', 'Bricks': 'environment',
    'Ground': 'environment', 'Marble': 'environment', 'Rocks': 'environment',
    'Tiles': 'environment', 'Woods': 'environment',
    'Foods': 'prop', 'Others': 'prop', 'Randoms': 'prop',
}


def flips_green(node) -> bool:
    """A node group that inverts the green channel (the pack's "Normal Inverter"): DirectX normals."""
    tree = getattr(node, 'node_tree', None)
    return node.type == 'GROUP' and not node.mute and tree is not None and any(
        n.type == 'INVERT' and any(l.from_socket.name == 'Green' for i in n.inputs for l in i.links)
        for n in tree.nodes)


def image_route(socket, depth=0):
    """(image, channel, flipped) upstream of a Principled socket, through the small wrapper nodes
    these libraries use. `channel` is r/g/b/a when a packed map is split, else None; `flipped`
    when a green-invert group sits on the way."""
    if socket is None or not socket.is_linked or depth > 14:
        return None, None, False
    link = socket.links[0]
    node = link.from_node
    if node.type == 'TEX_IMAGE' and node.image:
        return node.image, ('a' if link.from_socket.name == 'Alpha' else None), False
    if node.type == 'SEPARATE_COLOR':
        image, _, flip = image_route(node.inputs.get('Color'), depth + 1)
        return image, CHANNELS.get(link.from_socket.name), flip
    # Normal Map, Normal Inverter group, Mapping/Reroute, Bump, Mix: follow the first linked input.
    for inp in node.inputs:
        if inp.is_linked:
            image, channel, flip = image_route(inp, depth + 1)
            if image is not None:
                return image, channel, flip or flips_green(node)
    return None, None, False


def value_of(socket):
    """An unlinked Principled input's constant: a float, or an sRGB hex for colours."""
    if socket is None or socket.is_linked:
        return None
    v = socket.default_value
    if hasattr(v, '__len__'):
        srgb = [12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055 for c in list(v)[:3]]
        return '#' + ''.join(f'{round(max(0.0, min(1.0, c)) * 255):02x}' for c in srgb)
    return round(float(v), 3)


def mapping_scale(tree) -> float:
    """The UV repeat the author set: Mapping's Scale, usually driven by one Value node."""
    for n in tree.nodes:
        s = n.inputs.get('Scale') if n.type == 'MAPPING' else None
        if s is None:
            continue
        if not s.is_linked:
            return round(float(s.default_value[0]), 3)
        src = s.links[0].from_node
        if src.type == 'VALUE':
            return round(float(src.outputs[0].default_value), 3)
    return 1.0


MAP_SUFFIX = re.compile(r'[_\- ]*(base[_ ]?colou?r|albedo|diffuse|diff|col|color|normal(?:gl|dx)?|nrm|nor'
                        r'|rough(?:ness)?|metal(?:lic|ness)?|height|disp(?:lacement)?|ao|ambient[_ ]?occlusion'
                        r'|opacity|alpha|mask)$', re.I)


def full_name(mat) -> str:
    """The maps' shared stem when the material's name is a cut-off prefix of it
    ("Chocolate_ice_crea" → "Chocolate_ice_cream"), else the material's own name."""
    name = re.sub(r'\.\d{3}$', '', mat.name).strip()
    stems = {MAP_SUFFIX.sub('', Path(n.image.name).stem).strip('_- ')
             for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image}
    stems.discard('')
    if len(stems) == 1:
        stem = stems.pop()
        if len(stem) > len(name) and stem.lower().startswith(name.lower()):
            return stem
    return name


def sniff(data: bytes) -> str | None:
    if data[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    return None


def clean_name(name: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'[_\-.]+', ' ', name)).strip()


def slug(name: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:56] or 'material'


def tags_for(name: str, category: str, asset) -> list[str]:
    words = [w.lower() for w in re.split(r'[^a-zA-Z0-9]+', name) if len(w) > 2]
    own = [t.name.lower() for t in asset.tags]
    return list(dict.fromkeys([category.lower(), 'pack', *own, *words[:8]]))


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(args) < 2:
        print('usage: blender -b file.blend --python tools/blender-extract.py -- OUT CATEGORY')
        return
    out = Path(args[0])
    category = args[1]
    raw = out / 'raw'
    raw.mkdir(parents=True, exist_ok=True)
    jsonl = out / 'materials.jsonl'
    written: dict[str, str] = {}
    # Only the library's marked assets: the viewer sphere's and stroke materials aren't part of it.
    mats = [m for m in bpy.data.materials if m.node_tree and m.asset_data]
    lines = 0

    with jsonl.open('a', encoding='utf-8') as log:
        for index, mat in enumerate(mats):
            tree = mat.node_tree
            principled = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if principled is None:
                continue
            maps, values, dx = {}, {}, False
            for kind, input_name in (('basecolor', 'Base Color'), ('roughness', 'Roughness'),
                                     ('metallic', 'Metallic'), ('normal', 'Normal'), ('opacity', 'Alpha')):
                sock = principled.inputs.get(input_name)
                image, channel, flip = image_route(sock)
                if image is not None:
                    maps[kind] = (image, channel)
                    dx |= kind == 'normal' and flip
                elif kind != 'normal':
                    v = value_of(sock)
                    # Only constants the painter's defaults don't already give (opaque, non-metal).
                    if v is not None and not (kind == 'opacity' and v == 1) and not (kind == 'metallic' and v == 0):
                        values[kind] = v
            # Height and AO hang off the Displacement node or just sit in the tree; classify by name.
            for image in {n.image for n in tree.nodes if n.type == 'TEX_IMAGE' and n.image}:
                low = image.name.lower()
                if 'height' in low or 'displace' in low:
                    maps.setdefault('height', (image, None))
                if re.search(r'(^|[._-])(ao|ambient|occlusion)', low):
                    maps.setdefault('ao', (image, None))
            name = full_name(mat)
            asset = mat.asset_data
            entry = {
                'id': f'pack-{category.lower()}-{index:04d}-{slug(name)}',
                'name': clean_name(name),
                'category': f'Pack {category}',
                'catalog': asset.catalog_simple_name or category,
                'role': ROLE.get(category, 'prop'),
                'tags': tags_for(name, category, asset),
                'notes': asset.description or f'Purchased PBR Asset Browser V3 · {category}',
                'source': f'Purchased PBR pack · {category}',
                'license': 'Purchased — local use only',
                'normal': 'dx' if dx else 'gl',
                'scale': mapping_scale(tree),
                'values': values,
                'maps_raw': {},
            }
            for kind, (image, channel) in maps.items():
                packed = image.packed_file
                if not packed or packed.size < 512:
                    continue
                data = bytes(packed.data)
                ext = sniff(data)
                if ext is None:
                    continue
                digest = hashlib.sha1(data).hexdigest()
                if digest not in written:
                    path = raw / f'{digest}.{ext}'
                    if not path.exists():
                        path.write_bytes(data)
                    written[digest] = str(path)
                entry['maps_raw'][kind] = {'path': written[digest], 'channel': channel, 'file': image.name}
            # A flat-colour material (no albedo map) is still a material: build-pack makes its swatch.
            if 'basecolor' in entry['maps_raw'] or 'basecolor' in values:
                log.write(json.dumps(entry, separators=(',', ':')) + '\n')
                lines += 1
            if lines % 100 == 0 and lines:
                print(f'  {category}: {lines} materials', flush=True)
    print(f'{category}: {lines} materials, {len(written)} unique images, {jsonl}')


main()
