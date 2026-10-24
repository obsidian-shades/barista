"""Run inside Blender headless to inventory a .blend material library.

    blender -b "pack.blend" --python tools/blender-inspect.py -- out.json

Reports each material's Principled inputs, the image nodes upstream, packed sizes, and the
shape of the node graph. Read-only: saves nothing into the .blend.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import bpy


def upstream_image(socket, depth=0):
    """Walk links until an image texture; return (image, route) or (None, reason)."""
    if socket is None or not socket.is_linked or depth > 12:
        return None, None
    link = socket.links[0]
    node = link.from_node
    if node.type == 'TEX_IMAGE' and node.image:
        return node.image, [node.name]
    # Common single-input pass-through nodes (normal map, bump, separate colour, mix, mapping…)
    for inp in node.inputs:
        if inp.is_linked:
            image, route = upstream_image(inp, depth + 1)
            if image is not None:
                return image, [node.name] + route
    return None, None


def image_info(image):
    if image is None:
        return None
    packed = image.packed_file
    return {
        'name': image.name,
        'filepath': image.filepath,
        'source': image.source,
        'size': list(image.size),
        'format': image.file_format,
        'color': image.colorspace_settings.name,
        'packed': bool(packed),
        'packed_size': packed.size if packed else None,
    }


def material_info(mat):
    nodes = list(mat.node_tree.nodes) if mat.use_nodes and mat.node_tree else []
    principled = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if principled is None:
        return {
            'name': mat.name, 'users': mat.users, 'nodes': len(nodes), 'no_principled': True,
            'node_types': sorted({n.type for n in nodes}),
        }
    inputs = {}
    for name in ('Base Color', 'Metallic', 'Roughness', 'Normal', 'Alpha', 'Emission Color', 'Emission Strength',
                 'Specular IOR Level', 'Coat Weight', 'Sheen Weight', 'Transmission Weight'):
        sock = principled.inputs.get(name)
        if sock is None:
            continue
        if sock.is_linked:
            img, route = upstream_image(sock)
            inputs[name] = {'linked': True, 'from': sock.links[0].from_node.type, 'image': image_info(img), 'route': route}
        else:
            value = sock.default_value
            if hasattr(value, '__len__'):
                value = list(value)
            inputs[name] = {'linked': False, 'value': value}
    images = {}
    for node in nodes:
        if node.type == 'TEX_IMAGE' and node.image:
            images[node.image.name] = image_info(node.image)
    return {
        'name': mat.name, 'users': mat.users, 'nodes': len(nodes), 'no_principled': False,
        'inputs': inputs, 'images': images,
        'node_types': sorted({n.type for n in nodes}),
    }


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = Path(args[0]) if args else Path('blender-materials.json')
    started = time.time()
    mats = [material_info(m) for m in bpy.data.materials]
    payload = {
        'file': bpy.data.filepath,
        'materials': len(mats),
        'images': len(bpy.data.images),
        'scene_objects': len(bpy.data.objects),
        'mats': mats,
    }
    out.write_text(json.dumps(payload, indent=1), encoding='utf-8')
    print(f'wrote {out} ({len(mats)} materials, {len(bpy.data.images)} images) in {time.time() - started:.1f}s')


main()
