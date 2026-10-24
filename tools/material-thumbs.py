#!/usr/bin/env python3
"""Make 256 px thumbnails and a contact sheet for public/materials.

Run after tools/fetch-materials.mjs:

    python tools/material-thumbs.py

Writes a 256 px lit PBR sphere to <id>/thumb.jpg, contact-sheet.jpg and a four-map
strip for one metal, then records `thumb` in index.json. Pillow + numpy; no network.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "public" / "materials"
INDEX = LIB / "index.json"
BG = (27, 28, 30)
FG = (232, 232, 230)
DIM = (150, 152, 155)


def font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


try:
    import numpy as np
except ImportError:  # a fresh Python without the workspace's scientific stack
    np = None


def _img(path, size: int):
    if path is None:
        return None
    path = Path(path)
    if not path.exists():
        return None
    return np.asarray(Image.open(path).convert("RGB").resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32) / 255


def _sample(im, u, v):
    """Bilinear lookup on a repeating square map; u/v are arrays in 0..1."""
    h, w = im.shape[:2]
    x = (u % 1.0) * w - 0.5
    y = (v % 1.0) * h - 0.5
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    x0 %= w
    y0 %= h
    x1 = (x0 + 1) % w
    y1 = (y0 + 1) % h
    a = im[y0, x0] * (1 - fx) + im[y0, x1] * fx
    b = im[y1, x0] * (1 - fx) + im[y1, x1] * fx
    return a * (1 - fy) + b * fy


def pbr_from_paths(base_path, normal_path=None, rough_path=None, metal_path=None, ao_path=None,
                   size: int = 256) -> Image.Image:
    """A lit PBR sphere from five map files (any may be None except base colour)."""
    base = _img(base_path, size)
    if np is None or base is None:
        return ImageOps.fit(Image.open(base_path).convert("RGB"), (size, size), method=Image.Resampling.LANCZOS)
    nrm = _img(normal_path, size)
    rough = _img(rough_path, size)
    metal = _img(metal_path, size)
    ao = _img(ao_path, size)

    yy, xx = np.mgrid[0:size, 0:size]
    x = (xx + 0.5) / size * 2 - 1
    y = 1 - (yy + 0.5) / size * 2
    r2 = x * x + y * y
    z = np.sqrt(np.maximum(0, 1 - r2))
    N = np.stack([x, -y, z], -1)
    # Put the UV seam at the back and fade the detail normal at the poles, where any tangent basis
    # degenerates. The silhouette stays clean and the material still shows its brush and grain.
    u = (np.arctan2(N[..., 0], N[..., 2]) / (2 * np.pi) + 0.5) % 1
    v = 0.5 + np.arcsin(np.clip(N[..., 1], -1, 1)) / np.pi
    col = _sample(base, u, v)
    ro = _sample(rough, u, v)[..., 0] if rough is not None else np.full((size, size), 0.5, dtype=np.float32)
    me = _sample(metal, u, v)[..., 0] if metal is not None else np.zeros((size, size), dtype=np.float32)
    occl = _sample(ao, u, v)[..., 0] if ao is not None else np.ones((size, size), dtype=np.float32)
    if nrm is not None:
        n = _sample(nrm, u, v) * 2 - 1
        T = np.stack([N[..., 2], np.zeros_like(z), -N[..., 0]], -1)
        T = T / np.maximum(np.linalg.norm(T, axis=-1, keepdims=True), 1e-6)
        B = np.cross(N, T)
        fade = np.clip((1 - np.abs(N[..., 1]) ** 4) * 1.6, 0, 1)[..., None]
        Np = N + (T * n[..., 0:1] + B * n[..., 1:2]) * 0.58 * fade
        Np = Np / np.maximum(np.linalg.norm(Np, axis=-1, keepdims=True), 1e-6)
    else:
        Np = N

    V = np.array([0, 0, 1], dtype=np.float32)
    key = np.array([-0.45, 0.72, 0.68], dtype=np.float32); key /= np.linalg.norm(key)
    fill = np.array([0.72, 0.18, 0.35], dtype=np.float32); fill /= np.linalg.norm(fill)
    rim = np.array([0.1, 0.55, -0.7], dtype=np.float32); rim /= np.linalg.norm(rim)

    def spec(Nn, L, roughness):
        H = L + V; H /= np.linalg.norm(H)
        ndh = np.clip((Nn * H).sum(-1), 0, 1)
        ndl = np.clip((Nn * L).sum(-1), 0, 1)
        ndv = np.clip((Nn * V).sum(-1), 0, 1)
        a = np.maximum(roughness, 0.045) ** 2
        a2 = a * a
        d = a2 / (np.pi * ((ndh * ndh * (a2 - 1) + 1) ** 2) + 1e-6)
        k = (a + 1) ** 2 / 8
        g = (ndl / (ndl * (1 - k) + k)) * (ndv / (ndv * (1 - k) + k))
        return np.clip(d * g / (4 * ndv * ndl + 1e-4), 0, 20)

    F0 = 0.04 * (1 - me[..., None]) + col * me[..., None]
    s1 = spec(Np, key, ro)[..., None] * F0 * (0.55 + 0.45 * (1 - ro[..., None])) * 2.1
    s2 = spec(Np, fill, ro)[..., None] * F0 * 0.55
    s3 = spec(Np, rim, ro)[..., None] * F0 * 0.45
    dif = col * (1 - me[..., None]) * (0.24 + 0.9 * np.clip((Np * key).sum(-1, keepdims=True), 0, 1))
    env = np.array([0.12, 0.13, 0.155], dtype=np.float32) + np.array([0.62, 0.64, 0.72], dtype=np.float32) * np.clip(Np[..., 1:2], 0, 1) ** 1.25
    out = dif + s1 + s2 + s3 + env * F0 * 0.7
    out = out * 1.15
    out = out / (1 + out * 0.72)
    out = np.clip(out * occl[..., None], 0, 1) ** (1 / 2.2)

    bg = np.array([0.085, 0.089, 0.1], dtype=np.float32) + np.array([0.028, 0.03, 0.04], dtype=np.float32) * np.clip(1 - yy[..., None] / size, 0, 1)
    alpha = np.clip((1 - r2) * size * 0.95, 0, 1)[..., None]
    im = Image.fromarray(((bg * (1 - alpha) + out * alpha) * 255).astype(np.uint8)).convert("RGBA")
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse((size * 0.16, size * 0.70, size * 0.84, size * 0.94), fill=(0, 0, 0, 90))
    im = Image.alpha_composite(im, shadow.filter(ImageFilter.GaussianBlur(size * 0.055))).convert("RGB")
    # A one-pixel rim keeps a black finish from disappearing into the dark shelf.
    d = ImageDraw.Draw(im)
    d.ellipse((size * 0.022, size * 0.022, size * 0.978, size * 0.978), outline=(150, 155, 170), width=1)
    return im


def pbr_thumb(mdir: Path, size: int = 256) -> Image.Image:
    """A material folder's five maps as a lit PBR sphere."""
    maps = {k: mdir / f"{k}.jpg" for k in ("basecolor", "normal", "roughness", "metallic", "ao")}
    return pbr_from_paths(maps["basecolor"], maps["normal"], maps["roughness"], maps["metallic"], maps["ao"], size)


def thumb(src: Path, size: int = 256) -> Image.Image:
    """The material folder's own maps make the preview; fall back to the albedo crop if it has none."""
    if np is not None and src.exists() and (src.parent / "roughness.jpg").exists():
        return pbr_thumb(src.parent, size)
    im = Image.open(src).convert("RGB")
    return ImageOps.fit(im, (size, size), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def label(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, size: int, fill=FG):
    draw.text(xy, text, font=font(size), fill=fill)


def main() -> int:
    if not INDEX.exists():
        print(f"missing {INDEX}; run tools/fetch-materials.mjs first", file=sys.stderr)
        return 1
    data = json.loads(INDEX.read_text(encoding="utf-8"))
    materials = data.get("materials", [])
    if not materials:
        print("index has no materials", file=sys.stderr)
        return 1

    tiles = []
    for m in materials:
        src = LIB / m["id"] / m["maps"]["basecolor"]
        if not src.exists():
            print(f"skip {m['id']}: no {src.name}")
            continue
        t = thumb(src)
        t.save(LIB / m["id"] / "thumb.jpg", quality=84, optimize=True)
        m["thumb"] = "thumb.jpg"
        tiles.append((m, t))

    # Contact sheet: 5 x N, 256 px tiles, labels under them.
    cols = 5
    rows = (len(tiles) + cols - 1) // cols
    tw, gap, label_h = 256, 14, 30
    pad = 18
    W = pad * 2 + cols * tw + (cols - 1) * gap
    H = pad * 2 + rows * (tw + label_h) + (rows - 1) * gap
    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    for i, (m, t) in enumerate(tiles):
        x = pad + (i % cols) * (tw + gap)
        y = pad + (i // cols) * (tw + label_h + gap)
        sheet.paste(t, (x, y))
        label(d, (x, y + tw + 5), m["name"], 15)
        label(d, (x, y + tw + 22), f"{m['category']} · CC0", 12, DIM)
    sheet.save(LIB / "contact-sheet.jpg", quality=88, optimize=True)
    print(f"contact sheet: {sheet.width}x{sheet.height}, {len(tiles)} materials")

    # A map strip for the docs: base color, normal, roughness, metallic on one metal.
    example = next((m for m in materials if m["id"] == "metal-gold-polished"), materials[0])
    strip_maps = [("Base color", "basecolor"), ("Normal (GL)", "normal"), ("Roughness", "roughness"), ("Metallic", "metallic")]
    have = [(n, k) for n, k in strip_maps if k in example["maps"]]
    sw = 300
    strip = Image.new("RGB", (len(have) * sw + (len(have) - 1) * gap + pad * 2, sw + label_h + pad * 2), BG)
    ds = ImageDraw.Draw(strip)
    for j, (name, key) in enumerate(have):
        im = Image.open(LIB / example["id"] / example["maps"][key]).convert("RGB")
        im = ImageOps.fit(im, (sw, sw), method=Image.Resampling.LANCZOS)
        x = pad + j * (sw + gap)
        strip.paste(im, (x, pad))
        label(ds, (x, pad + sw + 6), name, 15)
    strip.save(LIB / "maps.jpg", quality=88, optimize=True)
    print(f"map strip: {example['name']} ({', '.join(k for _, k in have)})")

    INDEX.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    total = sum(p.stat().st_size for p in LIB.rglob("*") if p.is_file())
    print(f"{len(tiles)} thumbs, {total / 1e6:.1f} MB in public/materials")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
