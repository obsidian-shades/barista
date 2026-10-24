"""Extract the purchased PBR Asset Browser materials from a .blend into a staged pack.

Run inside Blender (one process per .blend; the files are large):

    blender -b --factory-startup "Metals.blend" --python tools/blender-extract.py -- \
        D:\barista-pack-raw Metals

It writes only raw packed image bytes (deduplicated by SHA-1) plus one JSONL line per
material. `tools/build-pack.py` then downsizes to the web library and writes the manifest.
Nothing is saved back into the .blend.
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


def image_route(socket, depth=0):
    """(image, channel) upstream of a Principled socket, through the small wrapper nodes these
    libraries use. `channel` is r/g/b/a when a packed map is split, else None."""
    if socket is None or not socket.is_linked or depth > 14:
        return None, None
    node = socket.links[0].from_node
    if node.type == 'TEX_IMAGE' and node.image:
        return node.image, None
    if node.type == 'SEPARATE_COLOR':
        channel = CHANNELS.get(socket.links[0].from_socket.name)
        image, _ = image_route(node.inputs.get('Color'), depth + 1)
        return image, channel
    # Normal Map, Normal Map group, Mapping/Reroute, Bump: follow the first linked input.
    for inp in node.inputs:
        if inp.is_linked:
            image, channel = image_route(inp, depth + 1)
            if image is not None:
                return image, channel
    return None, None


def sniff(data: bytes) -> str | None:
    if data[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    return None


def clean_name(name: str) -> str:
    name = re.sub(r'\.\d{3}$', '', name)
    return re.sub(r'[_\-.]+', ' ', name).strip()


def slug(name: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:56] or 'material'


def tags_for(name: str, category: str) -> list[str]:
    words = [w.lower() for w in re.split(r'[^a-zA-Z0-9]+', name) if len(w) > 2]
    return list(dict.fromkeys([category.lower(), 'pack', *words[:8]]))


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
    seen_images: set[str] = set()
    mats = [m for m in bpy.data.materials if m.use_nodes and m.node_tree]
    lines = 0

    with jsonl.open('a', encoding='utf-8') as log:
        for index, mat in enumerate(mats):
            tree = mat.node_tree
            principled = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if principled is None:
                continue
            maps = {}
            for kind, input_name in (('basecolor', 'Base Color'), ('roughness', 'Roughness'),
                                     ('metallic', 'Metallic'), ('normal', 'Normal')):
                sock = principled.inputs.get(input_name)
                image, channel = image_route(sock)
                if image is not None:
                    maps[kind] = (image, channel)
            # Height and AO hang off the Displacement node or just sit in the tree; classify by name.
            for image in {n.image for n in tree.nodes if n.type == 'TEX_IMAGE' and n.image}:
                low = image.name.lower()
                if 'height' in low or 'displace' in low:
                    maps.setdefault('height', (image, None))
                if re.search(r'(^|[._-])(ao|ambient|occlusion)', low):
                    maps.setdefault('ao', (image, None))
            if 'basecolor' not in maps:
                continue
            entry = {
                'id': f'pack-{category.lower()}-{index:04d}-{slug(mat.name)}',
                'name': clean_name(mat.name),
                'category': f'Pack {category}',
                'role': ROLE.get(category, 'prop'),
                'tags': tags_for(mat.name, category),
                'notes': f'Purchased PBR Asset Browser V3 · {category}',
                'source': f'Purchased PBR pack · {category}',
                'license': 'Purchased — local use only',
                'normal': 'gl',
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
                entry['maps_raw'][kind] = {'path': written[digest], 'channel': channel}
                if image.name not in seen_images:
                    seen_images.add(image.name)
            if 'basecolor' in entry['maps_raw']:
                log.write(json.dumps(entry, separators=(',', ':')) + '\n')
                lines += 1
            if lines % 100 == 0 and lines:
                print(f'  {category}: {lines} materials', flush=True)
    print(f'{category}: {lines} materials, {len(written)} unique images, {jsonl}')


main()
