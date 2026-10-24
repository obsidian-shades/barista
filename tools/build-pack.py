#!/usr/bin/env python3
"""Build the local web library from the staged Blender pack.

    python tools/build-pack.py --raw D:\barista-pack-raw --out public/materials-pack

Reads `materials.jsonl` written by `tools/blender-extract.py`, downsizes each raw map to
1024 px, writes content-addressed JPEGs and 256 px thumbnails, and writes the manifest.
The result is local-only (git-ignored): the purchased pack is not redistributed.

Pillow + a process pool; no network.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps

MAX = 1024
THUMB = 256


def atomic_write(path: Path, data: bytes):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    tmp.write_bytes(data)
    try:
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def process_map(raw: Path, kind: str, channel: str | None, out: Path, size: int) -> dict | None:
    try:
        im = Image.open(raw)
        im.load()
    except Exception:
        return None
    if channel in ('r', 'g', 'b', 'a'):
        im = im.convert('RGB').getchannel(channel.upper()) if channel != 'a' else im.convert('RGBA').getchannel('A')
    elif kind in ('roughness', 'metallic', 'height', 'ao'):
        im = im.convert('L')
    else:
        im = im.convert('RGB')
    w, h = im.size
    scale = min(1.0, size / max(w, h))
    if scale < 1:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
    quality, subsampling = (92, 0) if kind == 'normal' else (88, 2)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=quality, subsampling=subsampling)
    data = buf.getvalue()
    digest = hashlib.sha1(data).hexdigest()
    rel = f'assets/{digest}.jpg'
    atomic_write(out / rel, data)
    return {'path': '/' + out.name + '/' + rel, 'width': im.width, 'height': im.height, 'bytes': len(data)}


def thumb_for(raw: Path, out: Path) -> str | None:
    try:
        im = Image.open(raw).convert('RGB')
        im = ImageOps.fit(im, (THUMB, THUMB), method=Image.Resampling.LANCZOS)
    except Exception:
        return None
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=82)
    data = buf.getvalue()
    digest = hashlib.sha1(data).hexdigest()
    rel = f'thumbs/{digest}.jpg'
    atomic_write(out / rel, data)
    return '/' + out.name + '/' + rel


def work(job: tuple[dict, str, int]):
    entry, out_name, size = job
    out = Path(out_name)
    maps = {}
    base = None
    for kind, info in entry.get('maps_raw', {}).items():
        path = Path(info['path'])
        ch = info.get('channel')
        got = process_map(path, kind, ch, out, size)
        if got:
            maps[kind] = got['path']
            if kind == 'basecolor':
                base = (got['width'], got['height'], path)
    if 'basecolor' not in maps or base is None:
        return None
    thumb = thumb_for(base[2], out)
    tags = list(dict.fromkeys([*(entry.get('tags') or []), 'purchased', 'pack']))
    tags = [t.replace('concerete', 'concrete') for t in tags]
    out_entry = {
        'id': entry['id'],
        'name': entry['name'],
        'category': entry['category'].replace('Concerete', 'Concrete'),
        'role': entry.get('role', 'prop'),
        'library': 'pack',
        'tags': tags,
        'notes': entry.get('notes', 'Purchased PBR Asset Browser V3').replace('Concerete', 'Concrete'),
        'asset': entry['id'],
        'source': entry.get('source', 'Purchased PBR Asset Browser V3'),
        'license': entry.get('license', 'Purchased — local use only'),
        'width': base[0],
        'height': base[1],
        'normal': entry.get('normal', 'gl'),
        'maps': maps,
        'thumb': thumb,
    }
    return out_entry


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', type=Path, default=Path(r'D:\barista-pack-raw'))
    ap.add_argument('--out', type=Path, default=Path(__file__).resolve().parent.parent / 'public' / 'materials-pack')
    ap.add_argument('--size', type=int, default=MAX)
    ap.add_argument('--jobs', type=int, default=max(2, min(8, (os.cpu_count() or 4) - 1)))
    ap.add_argument('--limit', type=int, default=0, help='only the first N materials (a smoke test)')
    args = ap.parse_args()

    src = args.raw / 'materials.jsonl'
    if not src.exists():
        print(f'missing {src}; run tools/blender-extract.py first', file=sys.stderr)
        return 1
    entries = []
    seen = set()
    for line in src.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        e = json.loads(line)
        if e['id'] in seen:
            continue
        seen.add(e['id'])
        entries.append(e)
    if args.limit:
        entries = entries[:args.limit]
    args.out.mkdir(parents=True, exist_ok=True)
    jobs = [(e, str(args.out), args.size) for e in entries]
    done = []
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        for i, got in enumerate(pool.map(work, jobs, chunksize=8), 1):
            if got:
                done.append(got)
            if i % 100 == 0 or i == len(jobs):
                print(f'  {i}/{len(jobs)} materials, {len(done)} written', flush=True)
    done.sort(key=lambda m: (m['category'], m['name'].lower()))
    index = {
        'version': 1,
        'generated': __import__('datetime').date.today().isoformat(),
        'source': 'Purchased PBR Asset Browser V3 (Blender pack)',
        'license': 'Purchased — local use only; do not redistribute',
        'maxSize': args.size,
        'normalConvention': 'gl',
        'materials': done,
    }
    (args.out / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (args.out / 'README.md').write_text(
        '# Local purchased pack\n\n'
        'Built by `tools/build-pack.py` from the PBR Asset Browser V3 .blend files. This folder is\n'
        'git-ignored and must not be redistributed: the source pack is a purchased, licensed library.\n'
        'Maps are cached at 1024 px for the browser; the original 2K textures stay in the .blend files.\n'
        'Run `python tools/pack-thumbs.py` afterwards to render the lit PBR sphere previews.\n',
        encoding='utf-8',
    )
    total = sum(p.stat().st_size for p in args.out.rglob('*') if p.is_file())
    print(f'{len(done)} materials, {total / 1e6:.1f} MB in {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
