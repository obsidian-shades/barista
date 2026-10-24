#!/usr/bin/env python3
"""Draw Barista's built-in decal library.

    python tools/decals.py

Everything here is generated from code: 2048 px masters, downsampled to 1024, transparent PNG. The
manifest (`public/decals/index.json`) records the aspect, category and default ink so Van Gogh can
place a decal at the right size and tint. Originals, CC0.
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "decals"
S = 2048  # draw at 2x the published size, then downsample for crisp edges
FONT = Path(__file__).resolve().parent / "fonts"
WHITE = (255, 255, 255, 255)
INK = (238, 240, 244, 255)
DIM = (180, 184, 192, 255)
YELLOW = (242, 193, 78, 255)
RED = (255, 86, 72, 255)
PURPLE = (185, 136, 255, 255)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    """Local OFL faces only, so every rasterised glyph is redistributable with the decals."""
    paths = [FONT / name, Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    for p in paths:
        try:
            return ImageFont.truetype(str(p), size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def agency(size: int) -> ImageFont.FreeTypeFont:
    return font("BarlowCondensed-ExtraBold.ttf", size)


def stencil(size: int) -> ImageFont.FreeTypeFont:
    return font("AllertaStencil-Regular.ttf", size)


def tech(size: int) -> ImageFont.FreeTypeFont:
    return font("BarlowCondensed-Bold.ttf", size)


def mono(size: int) -> ImageFont.FreeTypeFont:
    return font("ShareTechMono-Regular.ttf", size)


def jp(size: int) -> ImageFont.FreeTypeFont:
    return font("MPLUS1p-Bold.ttf", size)


def letters(d: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, f: ImageFont.FreeTypeFont,
            fill=WHITE, spacing: int = 0, anchor: str = "la"):
    """Draw with tracking; PIL has no letter-spacing, and stencils live on it."""
    if not spacing:
        d.text(xy, text, font=f, fill=fill, anchor=anchor)
        return
    widths = [d.textlength(ch, font=f) for ch in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x, y = xy
    if anchor.startswith("m"):
        x -= total / 2
    elif anchor.startswith("r"):
        x -= total
    for ch, w in zip(text, widths):
        d.text((x, y), ch, font=f, fill=fill, anchor="l" + anchor[1:])
        x += w + spacing


def fit_text(d: ImageDraw.ImageDraw, box: tuple[int, int, int, int], text: str, f: ImageFont.FreeTypeFont,
             fill=WHITE, spacing: int = 0):
    """Draw centred, shrinking until it fits the box."""
    x0, y0, x1, y1 = box
    for size in range(f.size, 8, -2):
        f2 = f.font_variant(size=size) if hasattr(f, "font_variant") else f
        w = sum(d.textlength(ch, font=f2) for ch in text) + spacing * (len(text) - 1)
        if w <= x1 - x0:
            letters(d, ((x0 + x1) / 2, (y0 + y1) / 2), text, f2, fill, spacing, "mm")
            return f2
    return f


def plate(d: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], cut: int = 24, width: int = 5,
          color=INK):
    """A panel with clipped corners, the shape used all over the reference guns."""
    x0, y0, x1, y1 = xy
    poly = [(x0 + cut, y0), (x1 - cut, y0), (x1, y0 + cut), (x1, y1 - cut),
            (x1 - cut, y1), (x0 + cut, y1), (x0, y1 - cut), (x0, y0 + cut)]
    d.line(poly + [poly[0]], fill=color, width=width, joint="curve")
    return poly


def corner_ticks(d: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], length: int = 48, color=INK):
    x0, y0, x1, y1 = xy
    for x, y, dx, dy in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        d.line([(x, y), (x + dx * length, y)], fill=color, width=5)
        d.line([(x, y), (x, y + dy * length)], fill=color, width=5)


def barcode(d: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], color=WHITE, seed: int = 1):
    x0, y0, x1, y1 = xy
    rng = random.Random(seed)
    x = x0
    while x < x1:
        w = rng.choice([4, 4, 7, 10, 14])
        if rng.random() > 0.28:
            d.rectangle((x, y0, min(x1, x + w), y1), fill=color)
        x += w + rng.choice([5, 7, 9])
    d.rectangle((x0, y0, x1, y0 + 3), fill=color)


def qr(d: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], color=WHITE, seed: int = 3):
    x0, y0, x1, y1 = xy
    n = 15
    cell = (x1 - x0) / n
    rng = random.Random(seed)
    for y in range(n):
        for x in range(n):
            if rng.random() < 0.45:
                d.rectangle((x0 + x * cell, y0 + y * cell, x0 + (x + 1) * cell - 2, y0 + (y + 1) * cell - 2), fill=color)
    for ox, oy in ((0, 0), (n - 4, 0), (0, n - 4)):
        d.rectangle((x0 + ox * cell, y0 + oy * cell, x0 + (ox + 3) * cell, y0 + (oy + 3) * cell), fill=color)
        d.rectangle((x0 + (ox + 1) * cell, y0 + (oy + 1) * cell, x0 + (ox + 2) * cell, y0 + (oy + 2) * cell), fill=(0, 0, 0, 0))


def wing(d: ImageDraw.ImageDraw, cx: int, cy: int, w: int, h: int, color=WHITE):
    """Angular hard-surface wing pair, built from feathers that step down to the tips."""
    for side in (-1, 1):
        for i in range(4):
            drop = i * h * 0.18
            d.polygon([(cx + side * 22, cy - h * 0.18 + i * 12),
                       (cx + side * (w * (0.45 + i * 0.12)), cy - h * 0.55 + drop),
                       (cx + side * (w * (0.42 + i * 0.14)), cy - h * 0.25 + drop + h * 0.08),
                       (cx + side * 28, cy + 18 + i * 9)], fill=color)
        d.polygon([(cx + side * 18, cy - h * 0.08),
                   (cx + side * w * 0.36, cy - h * 0.42),
                   (cx + side * 34, cy - h * 0.22)], fill=color)


def fresh(w: int = S, h: int = S) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def save(im: Image.Image, w: int, h: int, name: str):
    im = im.resize((w, h), Image.Resampling.LANCZOS)
    im.save(OUT / f"{name}.png", optimize=True)
    return f"{name}.png"


def grunge(im: Image.Image, amount: float = 0.012, seed: int = 7) -> Image.Image:
    """Break the ink with a few transparent chips so stencils don't look like clip art."""
    rng = random.Random(seed)
    a = im.getchannel("A")
    d = ImageDraw.Draw(a)
    for _ in range(int(a.width * a.height * amount / 100)):
        x, y = rng.randrange(a.width), rng.randrange(a.height)
        r = rng.randint(1, 3)
        d.ellipse((x, y, x + r, y + r), fill=0)
    im.putalpha(a)
    return im


def decal_garuda():
    im, d = fresh()
    cx, cy = S // 2, S // 2
    d.ellipse((cx - 560, cy - 560, cx + 560, cy + 560), outline=INK, width=8)
    d.arc((cx - 610, cy - 610, cx + 610, cy + 610), 200, 340, fill=DIM, width=4)
    wing(d, cx, cy + 80, 760, 420)
    d.polygon([(cx, cy - 300), (cx + 90, cy - 90), (cx, cy + 10), (cx - 90, cy - 90)], fill=WHITE)
    letters(d, (cx, cy + 320), "GARUDA", agency(168), WHITE, 18, "mm")
    letters(d, (cx, cy + 455), "AEROSPACE DIVISION", mono(44), DIM, 16, "mm")
    letters(d, (cx, cy - 640), "G-7", mono(36), DIM, 12, "mm")
    return grunge(im, 0.006, 2), 1024, 1024


def decal_proto():
    im, d = fresh(S, 1024)
    box = (90, 100, S - 90, 924)
    plate(d, box, 42, 6)
    corner_ticks(d, (130, 140, S - 130, 884), 34)
    letters(d, (150, 175), "PROTO_COMP", agency(300), WHITE, 8)
    letters(d, (154, 485), "MP4  //  M'R3", tech(150), INK, 18)
    d.line([(150, 680), (S - 150, 680)], fill=DIM, width=4)
    letters(d, (154, 710), "UNDER DEVELOPMENT", mono(68), WHITE, 10)
    letters(d, (154, 795), "QHO) 73.30  GKJG  C0441", mono(38), DIM, 7)
    d.rectangle((S - 360, 730, S - 150, 845), outline=INK, width=5)
    qr(d, (S - 338, 748, S - 172, 827), seed=8)
    return grunge(im, 0.004, 11), 1024, 512


def decal_arts():
    im, d = fresh(S, 1024)
    d.line([(100, 120), (S - 100, 120)], fill=INK, width=7)
    letters(d, (100, 170), "ARTS", agency(410), WHITE, 14)
    d.line([(100, 650), (S - 100, 650)], fill=INK, width=7)
    letters(d, (106, 700), "ROOM RT", mono(78), INK, 12)
    letters(d, (106, 802), "REØZE", mono(78), INK, 12)
    letters(d, (S - 100, 710), "R-07", agency(170), WHITE, 8, "ra")
    for i in range(9):
        d.rectangle((S - 300 + i * 22, 860, S - 286 + i * 22, 900), fill=WHITE if i % 3 else DIM)
    d.rectangle((100, 900, S - 100, 908), fill=DIM)
    return grunge(im, 0.003, 13), 1024, 512


def decal_vx09():
    im, d = fresh(S, 1024)
    letters(d, (100, 95), "VX-09", stencil(450), WHITE, 10)
    letters(d, (108, 600), "SER. 042207C", mono(72), INK, 8)
    letters(d, (108, 700), "BATCH 7 / REV A", mono(48), DIM, 6)
    barcode(d, (108, 800, 900, 900), WHITE, 5)
    d.rectangle((S - 360, 600, S - 100, 900), outline=INK, width=5)
    qr(d, (S - 320, 650, S - 140, 830), seed=12)
    d.line([(100, 570), (S - 100, 570)], fill=INK, width=5)
    return grunge(im, 0.012, 17), 1024, 512


def decal_warning():
    im, d = fresh()
    cx, cy = S // 2, S // 2 - 90
    tri = [(cx, cy - 620), (cx + 660, cy + 500), (cx - 660, cy + 500)]
    d.polygon(tri, outline=WHITE, width=24)
    d.polygon(tri, outline=(0, 0, 0, 0), width=10)
    letters(d, (cx, cy + 20), "!", agency(700), WHITE, 0, "mm")
    letters(d, (cx, cy + 610), "HIGH VOLTAGE", agency(150), WHITE, 10, "mm")
    letters(d, (cx, cy + 760), "高電圧", jp(140), WHITE, 0, "mm")
    letters(d, (cx, cy + 900), "DO NOT OPEN WHILE LIVE", mono(38), DIM, 6, "mm")
    return grunge(im, 0.006, 19), 1024, 1024


def decal_caution_jp():
    im, d = fresh(S, 1024)
    box = (80, 100, S - 80, 924)
    plate(d, box, 34, 7)
    letters(d, (120, 155), "取扱注意", jp(250), WHITE, 2)
    letters(d, (124, 500), "HANDLE WITH CARE", agency(180), WHITE, 12)
    d.line([(124, 720), (S - 124, 720)], fill=DIM, width=5)
    letters(d, (124, 760), "精密機器  /  PRECISION ASSEMBLY", jp(56), DIM, 4)
    letters(d, (S - 100, 165), "C-04", mono(48), DIM, 8, "ra")
    return grunge(im, 0.004, 23), 1024, 512


def decal_prototype_jp():
    im, d = fresh(S, 1024)
    letters(d, (100, 100), "試作機", jp(300), WHITE, 4)
    letters(d, (104, 520), "PROTOTYPE UNIT", agency(200), WHITE, 14)
    letters(d, (104, 745), "NOT FOR SALE  //  NO. 04", mono(56), DIM, 6)
    d.line([(100, 500), (S - 100, 500)], fill=INK, width=6)
    for i in range(7):
        d.rectangle((S - 130 - i * 58, 100, S - 100 - i * 58, 190), fill=WHITE if i % 2 else DIM)
    return grunge(im, 0.008, 29), 1024, 512


def decal_plasma():
    im, d = fresh(S, 1024)
    letters(d, (100, 110), "プラズマ", jp(270), WHITE, 3)
    letters(d, (104, 505), "PLASMA CELL", agency(220), WHITE, 14)
    d.line([(100, 470), (S - 100, 470)], fill=INK, width=6)
    # energy bolt
    bolt = [(S - 430, 100), (S - 250, 100), (S - 350, 340), (S - 180, 340), (S - 470, 760), (S - 350, 450), (S - 520, 450)]
    d.polygon(bolt, fill=WHITE)
    letters(d, (104, 730), "CAUTION: PRESSURIZED", mono(48), DIM, 6)
    letters(d, (104, 805), "A-17  02/49", mono(40), DIM, 5)
    return grunge(im, 0.005, 31), 1024, 512


def decal_no_step():
    im, d = fresh(S, 1024)
    letters(d, (100, 130), "NO STEP", stencil(380), WHITE, 8)
    d.line([(100, 590), (S - 100, 590)], fill=WHITE, width=9)
    letters(d, (104, 650), "STRUCTURAL PANEL", mono(62), INK, 7)
    # two boots / arrows
    for i in range(2):
        x = 150 + i * 300
        d.polygon([(x, 850), (x + 110, 760), (x + 220, 850), (x + 180, 850), (x + 180, 930), (x + 40, 930), (x + 40, 850)], fill=WHITE)
    letters(d, (S - 100, 830), "NS-2", agency(140), WHITE, 6, "ra")
    return grunge(im, 0.01, 37), 1024, 512


def decal_lift():
    im, d = fresh(512, 1024)
    letters(d, (256, 70), "LIFT", agency(190), WHITE, 8, "ma")
    letters(d, (256, 270), "HERE", agency(190), WHITE, 8, "ma")
    d.line([(90, 500), (422, 500)], fill=INK, width=8)
    # up arrow
    d.polygon([(256, 560), (430, 790), (330, 790), (330, 980), (182, 980), (182, 790), (82, 790)], fill=WHITE)
    letters(d, (256, 930), "L-01", mono(34), (0, 0, 0, 255), 4, "mm")
    return grunge(im, 0.006, 41), 512, 1024


def decal_serial():
    im, d = fresh(S, 1024)
    plate(d, (90, 80, S - 90, 944), 26, 5)
    letters(d, (130, 125), "UNIT DATA", mono(50), DIM, 10)
    letters(d, (130, 205), "SN 2049-77-A", agency(230), WHITE, 6)
    d.line([(130, 500), (S - 130, 500)], fill=DIM, width=4)
    barcode(d, (130, 550, S - 430, 760), WHITE, 21)
    qr(d, (S - 380, 540, S - 140, 780), seed=22)
    letters(d, (130, 815), "MFG  GARUDA  //  LOT 11", mono(42), DIM, 4)
    letters(d, (130, 875), "MADE ON MARS", mono(34), DIM, 8)
    return grunge(im, 0.004, 43), 1024, 512


def decal_hazard():
    im, d = fresh(S, 1024)
    # rounded plate, diagonal yellow/black stripes
    mask = Image.new("L", (S, 1024), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((40, 40, S - 40, 984), radius=30, fill=255)
    stripes = Image.new("RGBA", (S, 1024), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stripes)
    sd.rectangle((0, 0, S, 1024), fill=YELLOW)
    for x in range(-1024, S + 1024, 260):
        sd.polygon([(x, 1024), (x + 130, 1024), (x + 130 + 1024, 0), (x + 1024, 0)], fill=(20, 21, 24, 255))
    stripes.putalpha(mask)
    im.alpha_composite(stripes)
    # central label
    d.rounded_rectangle((180, 315, S - 180, 710), radius=16, fill=(20, 21, 24, 245), outline=YELLOW, width=6)
    letters(d, (S // 2, 402), "CAUTION", agency(210), YELLOW, 12, "mm")
    letters(d, (S // 2, 585), "MOVING PARTS", mono(68), WHITE, 8, "mm")
    return im, 1024, 512


def decal_reticle():
    im, d = fresh()
    cx, cy = S // 2, S // 2
    for r, w in ((560, 7), (400, 4), (180, 8)):
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=WHITE, width=w)
    for a in (0, 90, 180, 270):
        rad = math.radians(a)
        x, y = math.cos(rad), math.sin(rad)
        d.line([(cx + x * 160, cy + y * 160), (cx + x * 660, cy + y * 660)], fill=WHITE, width=7)
        d.line([(cx + x * 680, cy + y * 680), (cx + x * 760, cy + y * 760)], fill=WHITE, width=7)
    d.rectangle((cx - 60, cy - 60, cx + 60, cy + 60), outline=WHITE, width=6)
    d.ellipse((cx - 12, cy - 12, cx + 12, cy + 12), fill=WHITE)
    letters(d, (cx, 160), "TARGET // 07", mono(56), INK, 10, "mm")
    letters(d, (cx, S - 150), "OPTIC  CAL  +0.0", mono(38), DIM, 7, "mm")
    return grunge(im, 0.003, 47), 1024, 1024


def decal_chevrons():
    im, d = fresh(S, 1024)
    for i in range(3):
        x = 110 + i * 380
        d.polygon([(x, 220), (x + 300, 512), (x, 804), (x + 150, 804), (x + 450, 512), (x + 150, 220)], fill=WHITE)
    letters(d, (S - 100, 880), "01", agency(200), WHITE, 6, "ra")
    letters(d, (104, 90), "FORWARD", mono(44), DIM, 10)
    return grunge(im, 0.006, 53), 1024, 512


def decal_wings():
    im, d = fresh(S, 1024)
    wing(d, S // 2, 470, 900, 500)
    d.polygon([(S // 2, 180), (S // 2 + 100, 410), (S // 2, 520), (S // 2 - 100, 410)], fill=WHITE)
    letters(d, (S // 2, 760), "AIRBORNE", agency(170), WHITE, 16, "mm")
    letters(d, (S // 2, 890), "DIV. 7", mono(42), DIM, 12, "mm")
    return grunge(im, 0.004, 59), 1024, 512


def decal_microdata():
    im, d = fresh(S, 256)
    rng = random.Random(9)
    x = 70
    while x < S - 70:
        w = rng.choice([6, 10, 16, 24])
        h = rng.choice([38, 64, 90])
        d.rectangle((x, 128 - h // 2, x + w, 128 + h // 2), fill=WHITE if rng.random() > 0.3 else DIM)
        x += w + rng.choice([7, 12, 20])
    letters(d, (70, 30), "SYS//", mono(34), DIM, 4)
    return im, 1024, 128


def decal_danger():
    im, d = fresh()
    d.rounded_rectangle((40, 40, S - 40, S - 40), radius=26, outline=RED, width=20)
    d.rounded_rectangle((100, 100, S - 100, S - 100), radius=12, outline=WHITE, width=7)
    letters(d, (S // 2, 260), "DANGER", agency(260), RED, 14, "mm")
    d.line([(200, 520), (S - 200, 520)], fill=WHITE, width=8)
    letters(d, (S // 2, 640), "DO NOT", agency(190), WHITE, 12, "mm")
    letters(d, (S // 2, 820), "ENTER", agency(190), WHITE, 12, "mm")
    letters(d, (S // 2, 990), "立入禁止", jp(95), WHITE, 4, "mm")
    return grunge(im, 0.002, 61), 1024, 1024


def decal_biohazard():
    im, d = fresh()
    cx, cy = S // 2, S // 2 - 60
    # three interlocking crescents
    for a in (-90, 30, 150):
        rad = math.radians(a)
        ox, oy = cx + math.cos(rad) * 190, cy + math.sin(rad) * 190
        d.ellipse((ox - 230, oy - 230, ox + 230, oy + 230), outline=WHITE, width=64)
    d.ellipse((cx - 105, cy - 105, cx + 105, cy + 105), fill=(0, 0, 0, 0), outline=WHITE, width=42)
    letters(d, (cx, cy + 580), "BIOHAZARD", stencil(160), WHITE, 10, "mm")
    letters(d, (cx, cy + 730), "危険物", jp(90), DIM, 4, "mm")
    return grunge(im, 0.005, 67), 1024, 1024


def decal_neon():
    im, d = fresh(S, 1024)
    glow = Image.new("RGBA", im.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    letters(gd, (110, 150), "VX", agency(620), PURPLE, 12)
    letters(gd, (115, 810), "04 // PROTOTYPE", mono(58), PURPLE, 12)
    d.line([(110, 780), (700, 780)], fill=PURPLE, width=7)
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    im.alpha_composite(glow)
    im.alpha_composite(glow)
    sharp, sd = fresh(S, 1024)
    letters(sd, (110, 150), "VX", agency(620), WHITE, 12)
    letters(sd, (115, 810), "04 // PROTOTYPE", mono(58), WHITE, 12)
    sd.line([(110, 780), (700, 780)], fill=WHITE, width=7)
    im.alpha_composite(sharp)
    return im, 1024, 512


def decal_purple_chevron():
    im, d = fresh(S, 512)
    for i in range(2):
        x = 150 + i * 390
        d.polygon([(x, 90), (x + 250, 256), (x, 422), (x + 130, 422), (x + 380, 256), (x + 130, 90)], fill=PURPLE)
    letters(d, (S - 60, 420), "VX", agency(90), PURPLE, 8, "ra")
    return im, 1024, 512


DECALS = [
    ("garuda-mark", "Garuda Mark", "Insignia", ["garuda", "logo", "wing", "badge", "weapon"], "Angular wing-and-star unit mark with a fine technical ring.", WHITE, decal_garuda),
    ("wing-insignia", "Wing Insignia", "Insignia", ["wing", "airborne", "badge", "stencil"], "Wide wing crest and AIRBORNE stencil for stocks and cases.", WHITE, decal_wings),
    ("proto-comp", "PROTO_COMP Plate", "Data", ["technical", "prototype", "label", "gun", "sci-fi"], "The R&D plate from the reference pistol: prototype ID, revision and a data code.", WHITE, decal_proto),
    ("arts-rnd", "ARTS / R&D", "Data", ["arts", "rnd", "label", "receiver", "sci-fi"], "Receiver plate with ROOM RT / REØZE markings and a tally strip.", WHITE, decal_arts),
    ("vx-09", "VX-09 Serial", "Data", ["serial", "unit", "number", "barcode", "weapon"], "Large VX-09 stencil with serial, batch and a barcode.", WHITE, decal_vx09),
    ("serial-plate", "Unit Data Plate", "Data", ["serial", "data plate", "barcode", "qr", "industrial"], "Full unit data plate: serial, barcode, QR and manufacturing line.", WHITE, decal_serial),
    ("micro-data", "Micro Data Strip", "Data", ["data", "strip", "barcode", "detail", "sci-fi"], "A thin strip of machine data for receiver flats and magazines.", WHITE, decal_microdata),
    ("warning-triangle", "High Voltage", "Warning", ["hazard", "voltage", "triangle", "japanese", "warning"], "High-voltage triangle with 高電圧 and a do-not-open line.", WHITE, decal_warning),
    ("caution-jp", "取扱注意", "Warning", ["japanese", "caution", "handle", "warning", "stencil"], "Handle-with-care plate, Japanese-first with an English stencil.", WHITE, decal_caution_jp),
    ("prototype-jp", "試作機", "Warning", ["japanese", "prototype", "warning", "sci-fi", "gun"], "Prototype-unit warning with NOT FOR SALE and tally marks.", WHITE, decal_prototype_jp),
    ("plasma-jp", "プラズマ", "Warning", ["japanese", "plasma", "energy", "warning", "sci-fi"], "Pressurised plasma-cell label with an energy bolt.", WHITE, decal_plasma),
    ("no-step", "NO STEP", "Marking", ["no step", "stencil", "warning", "panel", "military"], "NO STEP stencil with structural-panel note and boot arrows.", WHITE, decal_no_step),
    ("lift-here", "LIFT HERE", "Marking", ["lift", "arrow", "stencil", "crate", "military"], "Vertical lift-point stencil with a heavy up arrow.", WHITE, decal_lift),
    ("hazard-stripes", "Hazard Stripe", "Warning", ["hazard", "stripes", "caution", "yellow", "industrial"], "Yellow and black diagonal hazard band with a moving-parts label.", WHITE, decal_hazard),
    ("danger-enter", "DANGER — Do Not Enter", "Warning", ["danger", "sign", "red", "japanese", "warning"], "Red DANGER plate with DO NOT ENTER and 立入禁止.", WHITE, decal_danger),
    ("biohazard", "Biohazard", "Warning", ["biohazard", "symbol", "danger", "sci-fi", "warning"], "Biohazard trefoil with 危険物 for labs and containment doors.", WHITE, decal_biohazard),
    ("reticle", "Target Reticle", "Marking", ["reticle", "target", "optic", "crosshair", "sci-fi"], "Precision reticle with range ticks and an optic calibration line.", WHITE, decal_reticle),
    ("chevrons", "Forward Chevrons", "Marking", ["chevron", "forward", "arrow", "01", "sci-fi"], "Three forward chevrons with a unit index; reads well on long slides.", WHITE, decal_chevrons),
    ("neon-vx", "Neon VX", "Neon", ["neon", "purple", "glow", "vx", "cyberpunk"], "Glowing violet VX mark for the reference gun's custom build.", PURPLE, decal_neon),
    ("violet-chevron", "Violet Chevrons", "Neon", ["neon", "purple", "chevron", "cyberpunk", "trim"], "Two violet chevrons for accent panels and magazines.", PURPLE, decal_purple_chevron),
]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    entries = []
    for name, label, cat, tags, notes, tint, fn in DECALS:
        im, w, h = fn()
        if name not in ("neon-vx", "violet-chevron", "hazard-stripes", "danger-enter"):
            # pure ink decals tint cleanly; the coloured signs keep their own palette
            pass
        save(im, w, h, name)
        entries.append({
            "id": name, "name": label, "category": cat, "tags": tags, "notes": notes,
            "file": f"{name}.png", "width": w, "height": h,
            "tint": "#b388ff" if tint == PURPLE else "#ffffff",
            "license": "CC0-1.0", "source": "Barista original",
        })
        print(f"  {name}.png  {w}x{h}")
    index = {
        "version": 1, "source": "Barista original decals", "license": "CC0-1.0",
        "decals": entries,
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    (OUT / "README.md").write_text(
        "# Decals\n\nOriginal transparent PNG decals for Van Gogh, drawn by `tools/decals.py`.\n"
        "CC0 1.0: free for commercial work, no attribution required. Tint them in the Decal layer\n"
        "settings; coloured signs (hazard, danger, neon) ship with their own palette.\n\n"
        "The generator uses the SIL OFL fonts in `tools/fonts/` (Barlow Condensed, Share Tech Mono,\n"
        "Allerta Stencil, M PLUS 1p), so the rasterised marks and the tooling are redistributable.\n",
        encoding="utf-8",
    )
    print(f"{len(entries)} decals in {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
