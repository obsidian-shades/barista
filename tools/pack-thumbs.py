#!/usr/bin/env python3
"""Replace the purchased pack's flat thumbnails with lit PBR spheres.

    python tools/pack-thumbs.py [--size 256] [--jobs 8] [--limit N]

Reads public/assets/materials/pack/index.json, renders each material's base color / normal /
roughness / metallic / AO on a sphere with the same look as the core shelf, and updates
`thumb` in the manifest. Content-addressed, so unchanged materials are skipped on a rerun.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / 'public'
PACK = PUBLIC / 'assets' / 'materials' / 'pack'

# material-thumbs.py has a hyphen in its name on purpose; load it as the shared PBR renderer.
_spec = importlib.util.spec_from_file_location('barista_material_thumbs', ROOT / 'tools' / 'material-thumbs.py')
mt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mt)


def local(url: str | None) -> str | None:
    if not url:
        return None
    if url.startswith('/assets/materials/pack/'):
        return str(PACK / url[len('/assets/materials/pack/'):])
    if url.startswith('/'):
        return str(PUBLIC / url[1:])
    return str(PACK / url)


def render(job: tuple[str, str, str | None, str | None, str | None, str | None, str | None, int]):
    mid, base, normal, rough, metal, ao, out_path, size = job
    if not Path(base).exists():
        return mid, None
    dest = Path(out_path)
    if not dest.exists():
        im = mt.pbr_from_paths(base, normal, rough, metal, ao, size)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f'.{dest.name}.{os.getpid()}.tmp')
        im.save(tmp, 'JPEG', quality=84)
        os.replace(tmp, dest)
    return mid, '/' + dest.relative_to(PUBLIC).as_posix()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=256)
    ap.add_argument('--jobs', type=int, default=max(2, min(8, (os.cpu_count() or 4) - 1)))
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    index_path = PACK / 'index.json'
    data = json.loads(index_path.read_text(encoding='utf-8'))
    materials = data['materials'][:args.limit] if args.limit else data['materials']
    jobs = []
    for m in materials:
        maps = {k: local(v) for k, v in m.get('maps', {}).items()}
        if not maps.get('basecolor'):
            continue
        key = hashlib.sha1(
            '|'.join(str(maps.get(k, '')) for k in ('basecolor', 'normal', 'roughness', 'metallic', 'ao')).encode()
            + f'|{args.size}'.encode()
        ).hexdigest()
        out = PACK / 'thumbs-pbr' / f'{key}.jpg'
        jobs.append((m['id'], maps['basecolor'], maps.get('normal'), maps.get('roughness'),
                     maps.get('metallic'), maps.get('ao'), str(out), args.size))
    print(f'{len(jobs)} PBR sphere previews', flush=True)
    paths = {}
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        for i, (mid, path) in enumerate(pool.map(render, jobs, chunksize=8), 1):
            if path:
                paths[mid] = path
            if i % 100 == 0 or i == len(jobs):
                print(f'  {i}/{len(jobs)}', flush=True)
    for m in materials:
        if m['id'] in paths:
            m['thumb'] = paths[m['id']]
    index_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'updated {len(paths)} thumbnails', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
