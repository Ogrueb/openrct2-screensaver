#!/usr/bin/env python3
"""Draws the park name caption's frame (gold, silver or wood), marble mat, wood divider and velvet band, and the Aero and Canvas styles' pieces (plugin/src/ui/captions.ts) as PNG pieces in plugin/icons/.

A carved and gilded moulding, lit from the top left: an outer lip, a rounded rail, a row of beads,
a cove, and a bright fillet with a shadow onto the mat inside. The frame is a height field shaded
by its slope, so the top and left sides catch the light and the bottom and right fall into shade,
and the corners are mitred. It is cut into four corners (THICK x THICK game pixels) and four edge
tiles (TILE long) that repeat along each side; the bead row repeats every BEAD pixels, which
divides TILE, so the tiles join without seams. Every piece is drawn at each scale factor the
plugin may ask for (as tools/mkicons.py does for the icons), antialiased by 4x4 supersampling.
Stdlib only.

Silver and wood carve their band differently (STYLES "carving"): silver joins the moulding into one cushion
and debosses a rinceau (a wavy stem with self-similar scrolls) into it, both sides' scrolls overlapping in the
corner squares; wood twists a single-run rope (ROPE_PITCH) clockwise round the frame, with a boss at each corner.

The velvet band's tiles come in each colour the settings offer (VELVETS).

Usage: python tools/mkframe.py [--out plugin/icons] [--preview build/frame.png] [--marble photo.jpg]
"""

import argparse
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "plugin", "icons")

THICK = 14  # game px: the moulding's width (plugin/src/ui/theme.ts CAPTION.frame)
TILE = 16  # game px: an edge tile's length (CAPTION.frameTile)
BEAD = 4  # game px between beads
SCALES = (1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4)  # as mkicons.py
SAMPLES = 4

# Gold, dark to light, by brightness 0-1.
RAMP = [(0.0, (46, 28, 4)), (0.3, (112, 76, 18)), (0.55, (176, 132, 40)), (0.75, (226, 184, 82)),
        (0.9, (248, 222, 140)), (1.0, (255, 248, 210))]
# Amber for the patterned band, the bead row (owner, 2026-11-02).
AMBER = [(0.0, (34, 10, 0)), (0.3, (90, 32, 2)), (0.55, (146, 64, 8)), (0.75, (188, 100, 20)),
         (0.9, (222, 146, 52)), (1.0, (246, 196, 120))]  # darker (owner, 2026-11-03)
# Silver and a carved walnut moulding (owner, 2026-11-03: the frame's style is a setting), each with its
# own darker band for its carving; wood is grained and less glossy.
SILVER = [(0.0, (30, 32, 36)), (0.3, (88, 92, 100)), (0.55, (150, 155, 164)), (0.75, (200, 204, 212)),
          (0.9, (232, 234, 240)), (1.0, (255, 255, 255))]
PEWTER = [(0.0, (20, 22, 28)), (0.3, (60, 64, 74)), (0.55, (100, 106, 118)), (0.75, (140, 146, 158)),
          (0.9, (180, 186, 196)), (1.0, (220, 224, 232))]
WALNUT = [(0.0, (28, 14, 4)), (0.3, (74, 40, 16)), (0.55, (120, 70, 32)), (0.75, (160, 100, 50)),
          (0.9, (196, 136, 78)), (1.0, (226, 176, 120))]
EBONY = [(0.0, (16, 8, 2)), (0.3, (44, 22, 8)), (0.55, (72, 40, 16)), (0.75, (100, 58, 26)),
         (0.9, (130, 82, 42)), (1.0, (170, 116, 66))]
# Each style's carving (owner, 2026-11-03): gold keeps the bead row; wood a rope twisting the same way all round
# (a 4 px pitch, a boss at each corner); silver one broad embossed cushion in place of the rail, beads and cove,
# with a rinceau (scrolls growing smaller scrolls) debossed into it, running on through the corners.
STYLES = {
    "gold": {"ramp": RAMP, "band": AMBER, "glint": 0.35, "grain": 0.0, "carving": "beads"},
    "silver": {"ramp": SILVER, "band": PEWTER, "glint": 0.45, "grain": 0.0, "carving": "rinceau"},
    "wood": {"ramp": WALNUT, "band": EBONY, "glint": 0.1, "grain": 0.18, "carving": "rope"},
}
style = STYLES["gold"]
LIGHT = (-0.55, -0.6, 0.58)  # towards the light: up, left and out of the screen


def ramp(b, stops=RAMP):
    b = max(0.0, min(1.0, b))
    for (b0, c0), (b1, c1) in zip(stops, stops[1:]):
        if b <= b1:
            t = (b - b0) / (b1 - b0)
            return tuple(c0[i] + (c1[i] - c0[i]) * t for i in range(3))
    return stops[-1][1]


def profile(d):
    """Height of the moulding at depth d (0 at the outside, THICK at the mat)."""
    if d < 1.0:
        return 0.2 * d  # outer lip
    if d < 5.0:
        return 0.2 + 1.6 * math.sin(math.pi * (d - 1.0) / 4.0) + 0.3 * (d - 1.0) / 4.0  # rounded rail
    if d < 9.0:
        return 0.5  # the bead row's bed (the beads stand on it)
    if d < 12.0:
        return 0.5 - 0.6 * math.sin(math.pi * (d - 9.0) / 3.0)  # cove
    if d < 13.0:
        return 0.5 + 0.9 * math.sin(math.pi * (d - 12.0))  # bright fillet
    return -0.4 * (d - 13.0)  # down to the mat


def bead(d, t):
    """The beads: half spheres on the bed, BEAD apart along the side."""
    u = (t - THICK) % BEAD - BEAD / 2
    v = d - 7.0
    r2 = 1.45 ** 2 - u * u - v * v
    return math.sqrt(r2) * 0.8 if r2 > 0 else 0.0


ROPE_PITCH = 4  # game px between the rope's strands (divides TILE)
ROPE_SLANT = 0.5  # strands lean this much along the side per px across it (steeper ones lay along the light on the sides)
DEBOSS_IN, DEBOSS_OUT = 2.0, 12.0  # the rinceau's band across the silver cushion (depth from the outside)
DEBOSS = 0.9  # how deep the rinceau is pressed into it


def carved(x, y, w, h):
    """Height at (x, y) game px in a w x h frame (None off the moulding), and whether it is in the band colour."""
    sides = ((x, y), (w - x, y), (y, x), (h - y, x))  # (depth, along) for left, right, top, bottom
    d, t = min(sides, key=lambda s: s[0])
    if d >= THICK:
        return None, False
    kind = style.get("carving", "beads")
    band = 5.0 <= d < 9.0
    if kind == "beads":
        return profile(d) + bead(d, t), band
    if kind == "rope":
        if not band:
            return profile(d), False
        ex, ey = min(x, w - x), min(y, h - y)
        if 5.0 <= ex < 9.0 and 5.0 <= ey < 9.0:  # a round boss where the rope turns the corner
            q = math.hypot(ex - 7.0, ey - 7.0) / 2.3
            return profile(d) + (math.sqrt(1 - q * q) * 1.2 if q < 1 else -0.1), True
        # Along the frame clockwise, so the strands lean the same way on every side.
        along = x if d == y else y if d == w - x else -x if d == h - y else -y
        v = (d - 5.0) / 4.0
        base = math.sqrt(max(0.0, 1 - (2 * v - 1) ** 2)) * 1.1
        strand = 0.5 + 0.5 * math.cos(2 * math.pi * (along + ROPE_SLANT * (d - 5.0)) / ROPE_PITCH)
        return profile(d) + base * (0.45 + 0.55 * strand ** 0.6), True
    # Silver: one cushion; the rinceau pressed into it from each side, both where they meet in a corner.
    # Each line runs edge to edge in whole periods: inside the corner squares one period is squeezed into
    # THICK, so every line starts and ends at the same phase.
    # The lines run clockwise (as the rope does), so each corner is a quarter turn of the next.
    recess = 0.0
    clockwise = ((x, h - y), (w - x, y), (y, x), (h - y, w - x))
    for k, (dd, tt) in enumerate(clockwise):
        if DEBOSS_IN <= dd < DEBOSS_OUT and dd < THICK and (dd == d or (min(x, w - x) < THICK and min(y, h - y) < THICK)):
            length = h if k < 2 else w
            if tt < THICK:
                u = (tt - THICK) * TILE / THICK
            elif tt > length - THICK:
                u = (length - 2 * THICK) + (tt - (length - THICK)) * TILE / THICK
            else:
                u = tt - THICK
            recess = max(recess, rinceau_at(u, (dd - DEBOSS_IN) / (DEBOSS_OUT - DEBOSS_IN)))
    return cushion(d) - DEBOSS * recess, recess > 0.25


def height(x, y, w, h):
    """Height at (x, y) game px in a w x h frame, or None off the moulding."""
    return carved(x, y, w, h)[0]


def cushion(d):
    """Silver's profile: an outer lip, then one broad rounded emboss down to the mat."""
    if d < 1.0:
        return 0.2 * d
    if d < 12.6:
        return 0.2 + 1.5 * math.sin(math.pi * (d - 1.0) / 11.6) ** 0.55
    if d < 13.0:
        return 0.2
    return -0.4 * (d - 13.0)


class Relief:
    """A carving drawn as strokes into a height map (0-1) over one TILE-long repeat of a band, wrapping along it."""
    RES = 8  # samples per game px

    def __init__(self, length, band):
        self.L, self.b = length, band
        self.w, self.h = length * self.RES, int(band * self.RES)
        self.m = [[0.0] * self.w for _ in range(self.h)]

    def stamp(self, x, y, r, hgt):
        R = self.RES
        for iy in range(max(0, int((y - r) * R)), min(self.h, int((y + r) * R) + 2)):
            for ix in range(int((x - r) * R), int((x + r) * R) + 2):
                q = math.hypot((ix + 0.5) / R - x, (iy + 0.5) / R - y) / r
                if q < 1:
                    j = ix % self.w
                    self.m[iy][j] = max(self.m[iy][j], hgt * math.sqrt(1 - q * q))

    def stroke(self, pts, r0, r1, hgt):
        for i in range(len(pts) - 1):
            (x0, y0), (x1, y1) = pts[i], pts[i + 1]
            steps = max(1, int(math.hypot(x1 - x0, y1 - y0) * self.RES / 2))
            for k in range(steps + 1):
                f = (i + k / steps) / (len(pts) - 1)
                r = r0 + (r1 - r0) * f
                self.stamp(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps, r, hgt * (0.6 + 0.4 * r / r0))

    def at(self, u, v):
        R = self.RES
        x, y = (u % self.L) * R - 0.5, v * self.b * R - 0.5
        x0, y0 = math.floor(x), max(0, min(self.h - 2, math.floor(y)))
        fx, fy = x - x0, max(0.0, min(1.0, y - y0))
        g = lambda i, j: self.m[j][i % self.w]
        top = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * fx
        bottom = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * fx
        return top + (bottom - top) * fy


def _spiral(cx, cy, r, a0, turns, sign):
    n = int(40 * turns)
    return [(cx + r * (1 - 0.85 * i / n) * math.cos(a0 + sign * 2 * math.pi * turns * i / n),
             cy + r * (1 - 0.85 * i / n) * math.sin(a0 + sign * 2 * math.pi * turns * i / n)) for i in range(n + 1)]


def _scrolls(rel, cx, cy, r, a0, sign, depth, hgt):
    """A scroll curling inwards, a smaller scroll of the other hand sprouting from it (self-similar)."""
    pts = _spiral(cx, cy, r, a0, 1.15, sign)
    rel.stroke(pts, max(0.22, r * 0.16), 0.15, hgt)
    if depth > 0:
        k = len(pts) // 5
        (x, y), (x2, y2) = pts[k], pts[k + 1]
        ang = math.atan2(y2 - y, x2 - x) - sign * math.pi / 2
        r2 = r * 0.48
        _scrolls(rel, x + r2 * math.cos(ang), y + r2 * math.sin(ang), r2, ang + math.pi, -sign, depth - 1, hgt * 0.85)


_RINCEAU = []


def rinceau_at(u, v):
    """The rinceau's depth 0-1 at u game px along the side, v 0-1 across its band: a wavy stem with a scroll
    curling off each crest and trough, each growing a smaller scroll, two levels deep; repeats every TILE."""
    if not _RINCEAU:
        b = DEBOSS_OUT - DEBOSS_IN
        rel = Relief(TILE, b)
        rel.stroke([(i / 8, b / 2 + 0.26 * b * math.sin(2 * math.pi * i / 8 / TILE)) for i in range(TILE * 8 + 1)], 0.4, 0.4, 0.75)
        for k, sign in ((0, 1), (1, -1)):
            _scrolls(rel, TILE / 4 + k * TILE / 2, b / 2 - sign * 0.06 * b, 0.38 * b, -sign * math.pi / 2, sign, 2, 0.9)
        _RINCEAU.append(rel)
    return _RINCEAU[0].at(u, v)


def shade(x, y, w, h, eps=0.05):
    z, band = carved(x, y, w, h)
    if z is None:
        return None
    zx1, zx0 = height(x + eps, y, w, h), height(x - eps, y, w, h)
    zy1, zy0 = height(x, y + eps, w, h), height(x, y - eps, w, h)
    dx = ((zx1 if zx1 is not None else z) - (zx0 if zx0 is not None else z)) / (2 * eps)
    dy = ((zy1 if zy1 is not None else z) - (zy0 if zy0 is not None else z)) / (2 * eps)
    n = (-dx, -dy, 1.0)
    length = math.sqrt(sum(c * c for c in n))
    ll = math.sqrt(sum(c * c for c in LIGHT))
    lambert = sum(a * b for a, b in zip(n, LIGHT)) / (length * ll)
    b = 0.12 + 0.78 * max(0.0, lambert)
    # A sharp glint where the surface faces the light most.
    b += style["glint"] * max(0.0, lambert - 0.88) / 0.12
    d = min(x, w - x, y, h - y)
    if style["grain"]:
        # Grain running along each side, wavering with a period that divides TILE so the tiles join.
        sides = ((x, y), (w - x, y), (y, x), (h - y, x))
        dd, t = min(sides, key=lambda s: s[0])
        g = math.sin(2 * math.pi * (dd * 0.55 + 0.35 * math.sin(2 * math.pi * t / TILE)))
        b *= 1 - style["grain"] * (0.5 + 0.5 * g) ** 3
    if d < 0.6:
        b *= 0.35  # the outer edge's dark line
    if d > THICK - 0.8:
        return (0, 0, 0, 0.55)  # the shadow the fillet casts on the mat
    return (*ramp(b, style["band"] if band else style["ramp"]), 1.0)


# Textures: the mat's soft marble (MARBLE game px square, cut into CELL cells laid in turn over the
# mat) and the dark wood-grain divider (WOOD_H high, WOOD_LEN long, cut into CELL-long pieces).
MARBLE = 128
CELL = 32
WOOD_LEN = 128
WOOD_H = 9
BEVEL = 3  # game px of bevel at the wood divider's top and bottom (owner, 2026-11-03: stronger)
# The marble mat: a photo (--marble), cropped, softened and scaled to MARBLE_W x MARBLE_H game px, larger
# than any mat, so the plugin shows the part a mat needs (the overlay's crop) without repeats.
MARBLE_W = 576
MARBLE_H = 256
MARBLE_SCALES = (1, 2, 3)
MARBLE_ALPHA = 0.8
ROSE_GOLD = (214, 160, 140)
ROSE_TINT = 0.35  # share of the half-way blend towards ROSE_GOLD
MARBLE_LIGHTEN = 0.12  # towards white (owner, 2026-11-03: softer and lighter)
# The byline's velvet band (owner, 2026-11-03): a tile VELVET_W x VELVET_H game px that repeats across the
# band, in each colour the settings offer, at VELVET_ALPHA.
VELVET_W = 192
VELVET_H = 96
VELVET_ALPHA = 0.94
VELVET_DEPTH = 0.13  # how far the pile's sheen lightens and shades the colour (a light texture)
VELVETS = {
    "green": (30, 66, 50), "burgundy": (78, 16, 34), "navy": (26, 36, 78),
    "slate": (48, 56, 66), "ivory": (234, 226, 204),
}


def lattice(n, seed):
    import random
    rnd = random.Random(seed)
    return [[rnd.random() for _ in range(n)] for _ in range(n)]


def noise(grid, x, y):
    """Periodic value noise: x, y in lattice units, wrapping at the grid's size."""
    n = len(grid)
    x0, y0 = math.floor(x), math.floor(y)
    fx, fy = x - x0, y - y0
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    g = lambda i, j: grid[j % n][i % n]
    top = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx
    bottom = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx
    return top + (bottom - top) * sy


OCTAVES = [(4, lattice(4, 11)), (8, lattice(8, 12)), (16, lattice(16, 13)), (32, lattice(32, 14))]


def fbm(u, v):
    """Fractal noise over a unit square that tiles (u, v in 0-1)."""
    total, amp, norm = 0.0, 1.0, 0.0
    for n, grid in OCTAVES:
        total += amp * noise(grid, u * n, v * n)
        norm += amp
        amp *= 0.5
    return total / norm


def marble(x, y):
    """Soft cream marble with grey veins; x, y game px (tiles every MARBLE)."""
    u, v = (x % MARBLE) / MARBLE, (y % MARBLE) / MARBLE
    # Heavier veins (owner, 2026-11-03): a main vein system and finer branches.
    turb = fbm(u, v)
    main = abs(math.sin(math.pi * (u + v + 1.4 * turb))) ** 0.28  # 0 on a vein
    fine = abs(math.sin(math.pi * (3 * u - v + 2.2 * fbm((u + 0.5) % 1, (v + 0.25) % 1)))) ** 0.18
    cloud = fbm((u + 0.37) % 1, (v + 0.61) % 1)
    base = (238 - 26 * cloud, 232 - 26 * cloud, 220 - 22 * cloud)
    grey = (96, 92, 88)
    t = 0.75 * (1 - main) + 0.35 * (1 - fine)
    t = min(0.85, t)
    return tuple(base[i] + (grey[i] - base[i]) * t for i in range(3)) + (0.80,)


def wood(x, y):
    """Dark wood grain along the divider, with a lit top edge and a dark bottom one."""
    u = (x % WOOD_LEN) / WOOD_LEN
    turb = fbm(u, (y / WOOD_H * 0.25) % 1)
    grain = 0.5 + 0.5 * math.sin(2 * math.pi * (1.6 * y / WOOD_H + 1.8 * turb + 0.4 * math.sin(2 * math.pi * u)))
    knot = fbm((u * 2) % 1, 0.5)
    b = 0.2 + 0.55 * grain ** 4 + 0.15 * knot
    # A raised bar (owner, 2026-11-03: an upward bevel at the top and bottom): the top bevel catches the
    # light, the bottom one falls into shade.
    if y < BEVEL:
        b += 0.75 * (1 - y / BEVEL) + 0.15
    elif y > WOOD_H - BEVEL:
        b *= 0.15 + 0.6 * (WOOD_H - y) / BEVEL
    base = (34, 18, 8)
    light = (112, 66, 32)
    return tuple(base[i] + (light[i] - base[i]) * min(1.0, b) for i in range(3)) + (1.0,)


def marble_from_photo(path, out):
    """Crops the photo's upper centre to the texture's shape, softens it with a light gaussian blur and
    writes it at each MARBLE_SCALES scale with MARBLE_ALPHA opacity (needs Pillow)."""
    from PIL import Image, ImageFilter
    im = Image.open(path).convert("RGB")
    w, h = im.size
    cw = round(w * 0.8)  # a wide crop (owner, 2026-11-03)
    ch = round(cw * MARBLE_H / MARBLE_W)
    x0 = (w - cw) // 2
    im = im.crop((x0, 0, x0 + cw, min(h, ch)))
    im = im.filter(ImageFilter.GaussianBlur(radius=max(1.6, cw / 375)))
    # A light rose-gold tint (owner, 2026-11-03): a soft-light blend towards ROSE_GOLD.
    tint = Image.new("RGB", im.size, ROSE_GOLD)
    im = Image.blend(im, Image.blend(im, tint, 0.5), ROSE_TINT)
    im = Image.blend(im, Image.new("RGB", im.size, (255, 255, 255)), MARBLE_LIGHTEN)
    for scale in MARBLE_SCALES:
        tex = im.resize((MARBLE_W * scale, MARBLE_H * scale), Image.LANCZOS).convert("RGBA")
        tex.putalpha(round(255 * MARBLE_ALPHA))
        tex.save(os.path.join(out, "marble-%d.png" % (scale * 100)), optimize=True)


def velvets(out):
    """The velvet tiles: the pile's sheen (soft fractal noise that tiles, crushed into broad light and dark
    patches) and a fine fuzz per pixel, applied to each colour, at each MARBLE_SCALES scale."""
    import random
    rnd = random.Random(7)
    for scale in MARBLE_SCALES:
        pw, ph = VELVET_W * scale, VELVET_H * scale
        field = []
        for py in range(ph):
            row = []
            for qx in range(pw):
                u, v = (qx + 0.5) / pw, (py + 0.5) / ph
                f = fbm(u, (v + 0.5 * fbm((u + 0.3) % 1, v)) % 1)
                sheen = max(0.0, min(1.0, (f - 0.2) / 0.6))
                sheen = sheen * sheen * (3 - 2 * sheen)
                row.append(2 * sheen - 1 + rnd.uniform(-0.3, 0.3))
            field.append(row)
        for name, base in VELVETS.items():
            rows = []
            for line in field:
                row = []
                for k in line:
                    if k > 0:
                        c = tuple(base[i] + (255 - base[i]) * VELVET_DEPTH * 0.6 * k for i in range(3))
                    else:
                        c = tuple(base[i] * (1 + VELVET_DEPTH * k) for i in range(3))
                    row.append(tuple(max(0, min(255, round(v))) for v in c) + (round(255 * VELVET_ALPHA),))
                rows.append(row)
            with open(os.path.join(out, "velvet-%s-%d.png" % (name, scale * 100)), "wb") as f:
                f.write(png(rows))


# ---- The further caption styles (owner, 2026-11-03; mock-ups in the project's caption-styles folder) ----
# Minimal is drawn by the plugin with rects alone. Aero is frosted glass: a frost tile per accent for the
# inner panel, a gloss sheet stretched over it, and rounded corners per accent (the straight rim is rects,
# plugin/src/ui/theme.ts ACCENT). Canvas is a linen tile inside a plain black gallery frame (corners and edge
# tiles as the moulding's) with an accent mat board between them (rects).

# Aero's glass tint per accent (the velvet colours as the Accent setting, lighter so the glass reads as glass);
# theme.ts ACCENT[...].aero holds the rim colours derived from these the same way.
AERO_TINTS = {
    "green": (70, 150, 110), "burgundy": (170, 60, 90), "navy": (64, 132, 214),
    "slate": (110, 128, 148), "ivory": (214, 204, 172),
}
AERO_RIM = 7  # game px: outline, bright line and rim; the inner panel's bevel is the next row
AERO_RADIUS = 8  # the outer corners' radius, and the corner pieces' side
FROST_W, FROST_H = 192, 96  # the frost tile, repeated over the inner panel
FROST_ALPHA = 0.80
GLOSS = 64  # the gloss sheet's side (game px), stretched over the box
GALLERY = 10  # the canvas style's black frame (theme.ts CAPTION_STYLES.canvas)
CANVAS_W, CANVAS_H = 192, 96  # the linen tile
THREAD = 2  # game px between the linen's threads


def _mix(c, d, t):
    return tuple(c[i] + (d[i] - c[i]) * t for i in range(3))


def aero_colours(tint):
    """The glass's layers for a tint, as theme.ts ACCENT[...].aero: rim, bright line, inner panel, its bevel."""
    rim = _mix(tint, (255, 255, 255), 0.22)
    inner = _mix(rim, (255, 255, 255), 0.45)
    return {"outline": ((20, 30, 50), 0.75), "bright": (_mix(rim, (255, 255, 255), 0.8), 0.9), "rim": (rim, 0.74),
            "bevel": (_mix(inner, (255, 255, 255), 0.5), 0.85), "inner": (inner, FROST_ALPHA)}


def aero_corner(colours, x, y):
    """The top left corner's colour at (x, y) game px (the others are mirrored): depth in from the rounded outline."""
    r = AERO_RADIUS
    cx, cy = max(x, r), max(y, r)
    depth = r - math.hypot(x - cx, y - cy) if (x < r and y < r) else min(x, y)
    if depth < 0:
        return None
    layer = ("outline" if depth < 1 else "bright" if depth < 2 else "rim" if depth < AERO_RIM
             else "bevel" if depth < AERO_RIM + 1 else "inner")
    c, a = colours[layer]
    if layer in ("rim", "bright"):
        c = _mix(c, (255, 255, 255), 0.25)  # the gloss on the top rim, at its strongest in the corner
    return c + (a,)


def periodic_noise(nx, ny, seed):
    """Value noise over a unit rectangle on an nx x ny lattice that wraps, so tiles repeat seamlessly."""
    import random
    rnd = random.Random(seed)
    grid = [[rnd.random() for _ in range(nx)] for _ in range(ny)]

    def at(u, v):
        x, y = u * nx, v * ny
        x0, y0 = math.floor(x), math.floor(y)
        fx, fy = x - x0, y - y0
        sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        g = lambda i, j: grid[j % ny][i % nx]
        top = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx
        bottom = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx
        return top + (bottom - top) * sy
    return at


def frost_tiles(out):
    """Aero's frost: the inner panel's colour, mottled at two sizes (24 and 8 game px) with a fine sparkle, so
    the park behind shows as soft colour rather than detail (in place of a blur, which the overlay can't do)."""
    import random
    big, small = periodic_noise(FROST_W // 24, FROST_H // 24, 21), periodic_noise(FROST_W // 8, FROST_H // 8, 22)
    for scale in MARBLE_SCALES:
        rnd = random.Random(23)
        pw, ph = FROST_W * scale, FROST_H * scale
        field = []
        for py in range(ph):
            row = []
            for qx in range(pw):
                u, v = (qx + 0.5) / pw, (py + 0.5) / ph
                f = 3 * (0.6 * big(u, v) + 0.4 * small(u, v) - 0.5)
                sparkle = max(0.0, min(2.4, rnd.gauss(0, 1) - 1.6))
                row.append((f, sparkle))
            field.append(row)
        for name, tint in AERO_TINTS.items():
            inner = aero_colours(tint)["inner"][0]
            rows = []
            for line in field:
                row = []
                for f, sparkle in line:
                    c = tuple(max(0, min(255, round(inner[i] * (1 + 0.07 * f) + 25.5 * sparkle))) for i in range(3))
                    row.append(c + (max(0, min(255, round(255 * (FROST_ALPHA + 0.04 * f)))),))
                rows.append(row)
            with open(os.path.join(out, "aero-frost-%s-%d.png" % (name, scale * 100)), "wb") as f:
                f.write(png(rows))


def gloss(x, y):
    """Aero's gloss over the box, x and y 0-1: the upper half catches the light down to a soft curved shine
    line, with two faint diagonal streaks. White, in alpha."""
    shine = 0.46 + 0.06 * math.sin(math.pi * x)
    g = (0.30 - 0.18 * y / shine) if y < shine else 0.0
    g += 0.07 * (math.exp(-((x - y * 0.55 - 0.30) / 0.07) ** 2) + math.exp(-((x - y * 0.55 - 0.55) / 0.035) ** 2))
    return (255, 255, 255, max(0.0, min(1.0, g)))


def gallery(x, y, w, h):
    """The canvas style's frame at (x, y) in a w x h sample: a flat black face, lit top and left, with a dark
    outer edge and a lit line just inside it; mitred at the corners as the moulding."""
    sides = ((x, "lit"), (w - x, "shade"), (y, "lit"), (h - y, "shade"))
    d, side = min(sides, key=lambda s: s[0])
    if d >= GALLERY:
        return None
    face = (30, 28, 26)
    k = 1.25 if side == "lit" else 0.8
    if d < 1:
        k *= 0.4
    elif d < 2 and side == "lit":
        return (96, 92, 86, 1.0)
    return tuple(v * k for v in face) + (1.0,)


def linen(x, y):
    """The canvas: warp and weft threads THREAD game px apart, over and under in turn, each thread a little
    uneven, with faint mottling; tiles every CANVAS_W x CANVAS_H."""
    u, v = (x % CANVAS_W) / CANVAS_W, (y % CANVAS_H) / CANVAS_H
    col, row = int(x // THREAD) % (CANVAS_W // THREAD), int(y // THREAD) % (CANVAS_H // THREAD)
    fx, fy = (x % THREAD) / THREAD, (y % THREAD) / THREAD
    vthread = math.sin(math.pi * fx) ** 0.7 * (1 + 0.08 * _SLUB_COLS[col])
    hthread = math.sin(math.pi * fy) ** 0.7 * (1 + 0.08 * _SLUB_ROWS[row])
    if (col + row) % 2 == 0:
        b = 0.55 + 0.45 * vthread * (0.75 + 0.25 * math.sin(math.pi * fy))
    else:
        b = 0.55 + 0.45 * hthread * (0.75 + 0.25 * math.sin(math.pi * fx))
    b += 0.09 * (_MOTTLE(u, v) - 0.5)
    b = max(0.0, min(1.0, b))
    return _mix((176, 160, 132), (232, 222, 200), b) + (1.0,)


def _slubs(n, seed):
    import random
    rnd = random.Random(seed)
    return [rnd.gauss(0, 1) for _ in range(n)]


_SLUB_COLS = _slubs(CANVAS_W // THREAD, 31)
_SLUB_ROWS = _slubs(CANVAS_H // THREAD, 32)
_MOTTLE = periodic_noise(CANVAS_W // 16, CANVAS_H // 16, 33)


def render_with(fn, size, scale):
    """A size x size game px sample of fn(x, y, w, h) (None: transparent) at a scale, supersampled."""
    px = round(size * scale)
    unit = size / px
    rows = []
    for py in range(px):
        row = []
        for qx in range(px):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    c = fn((qx + (sx + 0.5) / SAMPLES) * unit, (py + (sy + 0.5) / SAMPLES) * unit, size, size)
                    if c:
                        a = c[3]
                        for i in range(3):
                            acc[i] += c[i] * a
                        acc[3] += a
            alpha = acc[3] / (SAMPLES * SAMPLES)
            row.append(tuple(round(acc[i] / acc[3]) for i in range(3)) + (round(255 * alpha),) if alpha > 0 else (0, 0, 0, 0))
        rows.append(row)
    return rows


def mirror(rows, flip_x, flip_y):
    rows = [list(reversed(r)) if flip_x else list(r) for r in rows]
    return list(reversed(rows)) if flip_y else rows


def styles2(out):
    """Aero's corners, frost and gloss, and Canvas's frame pieces and linen."""
    for scale in SCALES:
        pct = round(scale * 100)
        for name, tint in AERO_TINTS.items():
            colours = aero_colours(tint)
            r = AERO_RADIUS
            tl = render_with(lambda x, y, w, h: aero_corner(colours, x, y), r, scale)
            for part, fx, fy in (("tl", False, False), ("tr", True, False), ("bl", False, True), ("br", True, True)):
                piece = mirror(tl, fx, fy)
                if fy:  # the gloss lies on the top corners only
                    plain = render_with(lambda x, y, w, h: _no_gloss(colours, x, y), r, scale)
                    piece = mirror(plain, fx, fy)
                with open(os.path.join(out, "aero-%s-%s-%d.png" % (name, part, pct)), "wb") as f:
                    f.write(png(piece))
        size = 2 * GALLERY + TILE
        rows = render_with(gallery, size, scale)
        t, e = round(GALLERY * scale), round((GALLERY + TILE) * scale)
        end = len(rows)
        crop = lambda x0, y0, x1, y1: [r[x0:x1] for r in rows[y0:y1]]
        parts = {"tl": crop(0, 0, t, t), "tr": crop(e, 0, end, t), "bl": crop(0, e, t, end), "br": crop(e, e, end, end),
                 "t": crop(t, 0, e, t), "b": crop(t, e, e, end), "l": crop(0, t, t, e), "r": crop(e, t, end, e)}
        for part, piece in parts.items():
            with open(os.path.join(out, "gallery-%s-%d.png" % (part, pct)), "wb") as f:
                f.write(png(piece))
    frost_tiles(out)
    for scale in MARBLE_SCALES:
        with open(os.path.join(out, "aero-gloss-%d.png" % (scale * 100)), "wb") as f:
            f.write(png(texture(lambda x, y: gloss(x / GLOSS, y / GLOSS), GLOSS, GLOSS, scale)))
        with open(os.path.join(out, "canvas-%d.png" % (scale * 100)), "wb") as f:
            f.write(png(texture(linen, CANVAS_W, CANVAS_H, scale)))


def _no_gloss(colours, x, y):
    """A bottom corner (drawn as the top left one before mirroring): the same layers without the gloss."""
    c = aero_corner(colours, x, y)
    if c is None:
        return None
    r = AERO_RADIUS
    cx, cy = max(x, r), max(y, r)
    depth = r - math.hypot(x - cx, y - cy) if (x < r and y < r) else min(x, y)
    if 1 <= depth < AERO_RIM:
        layer = "bright" if depth < 2 else "rim"
        return colours[layer][0] + (colours[layer][1],)
    return c


def texture(fn, w, h, scale, samples=2):
    """A w x h game px texture at a scale, as RGBA rows."""
    pw, ph = round(w * scale), round(h * scale)
    rows = []
    for py in range(ph):
        row = []
        for qx in range(pw):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(samples):
                for sx in range(samples):
                    c = fn((qx + (sx + 0.5) / samples) * w / pw, (py + (sy + 0.5) / samples) * h / ph)
                    for i in range(4):
                        acc[i] += c[i]
            n = samples * samples
            row.append(tuple(round(acc[i] / n) for i in range(3)) + (round(255 * acc[3] / n),))
        rows.append(row)
    return rows


def render(scale):
    """The whole sample frame (2 corners and one tile each way) at a scale, as RGBA rows."""
    size = 2 * THICK + TILE
    px = round(size * scale)
    unit = size / px
    rows = []
    for py in range(px):
        row = []
        for qx in range(px):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    c = shade((qx + (sx + 0.5) / SAMPLES) * unit, (py + (sy + 0.5) / SAMPLES) * unit, size, size)
                    if c:
                        a = c[3]
                        acc[0] += c[0] * a
                        acc[1] += c[1] * a
                        acc[2] += c[2] * a
                        acc[3] += a
            n = SAMPLES * SAMPLES
            alpha = acc[3] / n
            if alpha > 0:
                row.append(tuple(round(acc[i] / acc[3]) for i in range(3)) + (round(255 * alpha),))
            else:
                row.append((0, 0, 0, 0))
        rows.append(row)
    return rows


def cut(rows, scale):
    t = round(THICK * scale)
    e = round((THICK + TILE) * scale)
    end = len(rows)
    crop = lambda x0, y0, x1, y1: [r[x0:x1] for r in rows[y0:y1]]
    return {
        "tl": crop(0, 0, t, t), "tr": crop(e, 0, end, t), "bl": crop(0, e, t, end), "br": crop(e, e, end, end),
        "t": crop(t, 0, e, t), "b": crop(t, e, e, end), "l": crop(0, t, t, e), "r": crop(e, t, end, e),
    }


def png(rows):
    h = len(rows)
    w = len(rows[0]) if h else 0
    raw = b"".join(b"\x00" + bytes(v for p in r for v in p) for r in rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    global style
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--preview", help="also write the sample frame at scale 4 here")
    ap.add_argument("--marble", help="a marble photo to make the mat's texture from (needs Pillow; kept otherwise)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    if args.marble:
        marble_from_photo(args.marble, args.out)
    velvets(args.out)
    styles2(args.out)
    for scale in SCALES:
        for name, style in STYLES.items():
            rows = render(scale)
            for part, piece in cut(rows, scale).items():
                with open(os.path.join(args.out, "frame-%s-%s-%d.png" % (name, part, round(scale * 100))), "wb") as f:
                    f.write(png(piece))
        style = STYLES["gold"]
        # Wood pieces w<k>, cut from the whole strip at this scale.
        strip = texture(wood, WOOD_LEN, WOOD_H, scale, samples=3)
        for k in range(WOOD_LEN // CELL):
            x0, x1 = round(k * CELL * scale), round((k + 1) * CELL * scale)
            with open(os.path.join(args.out, "wood-%d-%d.png" % (k, round(scale * 100))), "wb") as f:
                f.write(png([r[x0:x1] for r in strip]))
        if args.preview and scale == SCALES[-1]:
            with open(args.preview, "wb") as f:
                f.write(png(rows))
    print("frame pieces at scales %s -> %s" % (list(SCALES), os.path.normpath(args.out)))


if __name__ == "__main__":
    main()
