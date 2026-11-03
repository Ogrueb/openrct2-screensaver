#!/usr/bin/env python3
"""Draws the screensaver mode's icons (controls bar) as PNGs in plugin/icons/.

The engine's overlay draws an image at its own size in output pixels when no width is given, and
scales others nearest-neighbour, so each icon is drawn at every output size the plugin may ask for
(its size in game pixels times OpenRCT2's scale factor, plugin/src/ui/icons.ts). Shapes are on a
24-unit grid, white, antialiased by 4x4 supersampling. Stdlib only.

Usage: python tools/mkicons.py [--out plugin/icons]
"""

import argparse
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "plugin", "icons")

# Icon sizes in game pixels (plugin/src/ui/theme.ts: ICON_PRIMARY, ICON_SECONDARY) and the scale
# factors drawn for; the plugin picks the nearest size drawn.
GAME_SIZES = (24, 34)
SCALES = (1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4)
SAMPLES = 4
COLOUR = (255, 255, 255)


# Shapes: ("poly", [(x, y), ...]) filled even-odd; ("line", [(x, y), ...], width) a polyline with
# round joins and caps; ("ellipse", cx, cy, rx, ry, angle_degrees).

def mirror(shapes):
    out = []
    for s in shapes:
        if s[0] == "poly":
            out.append(("poly", [(24 - x, y) for x, y in s[1]]))
        elif s[0] == "line":
            out.append(("line", [(24 - x, y) for x, y in s[1]], s[2]))
        else:
            out.append(("ellipse", 24 - s[1], s[2], s[3], s[4], -s[5]))
    return out


PREV_PARK = [
    ("poly", [(4, 5), (6.6, 5), (6.6, 19), (4, 19)]),
    ("poly", [(13.4, 5), (13.4, 19), (6.6, 12)]),
    ("poly", [(20.4, 5), (20.4, 19), (13.6, 12)]),
]
PREV_VIEW = [("line", [(14.5, 5.5), (8, 12), (14.5, 18.5)], 3.0)]
PAUSE = [
    ("poly", [(6.5, 5), (10, 5), (10, 19), (6.5, 19)]),
    ("poly", [(14, 5), (17.5, 5), (17.5, 19), (14, 19)]),
]
PLAY = [("poly", [(7.5, 4.5), (7.5, 19.5), (19.5, 12)])]
SHUFFLE = [
    ("line", [(3, 7.5), (7.5, 7.5), (14.5, 16.5), (18, 16.5)], 2.2),
    ("line", [(3, 16.5), (7.5, 16.5), (14.5, 7.5), (18, 7.5)], 2.2),
    ("poly", [(17, 3.5), (17, 11.5), (21.5, 7.5)]),
    ("poly", [(17, 12.5), (17, 20.5), (21.5, 16.5)]),
]
NOTE = [
    ("ellipse", 8.5, 17, 3.6, 2.7, -20),
    ("poly", [(10.6, 4), (12.4, 4), (12.4, 17), (10.6, 17)]),
    ("poly", [(12.4, 4), (18.5, 6.5), (18.5, 10), (12.4, 7.5)]),
]
SLASH = [("line", [(4, 4), (20, 20)], 2.2)]
TITLES = [
    ("poly", [(3, 5), (21, 5), (21, 19), (3, 19), (3, 5), (5, 7), (5, 17), (19, 17), (19, 7), (5, 7)]),
    ("poly", [(7, 9.5), (17, 9.5), (17, 11.5), (7, 11.5)]),
    ("poly", [(7, 13), (13.5, 13), (13.5, 15), (7, 15)]),
]

def gear():
    """A cog: 8 teeth around a hole, one even-odd outline (the outer edge, then the hole)."""
    pts = []
    teeth = 8
    for i in range(teeth * 4):
        a = 2 * math.pi * (i - 0.5) / (teeth * 4)
        r = 10.2 if i % 4 in (0, 1) else 7.6
        pts.append((12 + r * math.cos(a), 12 + r * math.sin(a)))
    pts.append(pts[0])
    hole = [(12 + 3.4 * math.cos(2 * math.pi * k / 24), 12 + 3.4 * math.sin(2 * math.pi * k / 24)) for k in range(25)]
    return [("poly", pts + hole[::-1])]


def circle(cx, cy, r, n=48, start=0.0, end=2 * math.pi):
    return [(cx + r * math.cos(start + (end - start) * k / n), cy + r * math.sin(start + (end - start) * k / n)) for k in range(n + 1)]


def sun(cx=12, cy=12, r=4.6, ray_in=6.6, ray_out=9.6, angles=range(8)):
    """A disc with rays (one per eighth turn in `angles`)."""
    shapes = [("poly", circle(cx, cy, r))]
    for i in angles:
        a = 2 * math.pi * i / 8
        shapes.append(("line", [(cx + ray_in * math.cos(a), cy + ray_in * math.sin(a)),
                                (cx + ray_out * math.cos(a), cy + ray_out * math.sin(a))], 1.9))
    return shapes


def moon():
    """A crescent: a disc less one shifted up and right (even-odd outline, the cut traced back)."""
    r, cx, cy = 8.5, 12, 12
    # Points where the cut circle (centre shifted by (4.2, -3.2), radius 7) crosses the disc.
    ox, oy, rc = cx + 4.2, cy - 3.2, 7.0
    outer, inner = [], []
    for k in range(240):
        a = 2 * math.pi * k / 240
        x, y = cx + r * math.cos(a), cy + r * math.sin(a)
        if (x - ox) ** 2 + (y - oy) ** 2 > rc * rc:
            outer.append((a, (x, y)))
    for k in range(240):
        a = 2 * math.pi * k / 240
        x, y = ox + rc * math.cos(a), oy + rc * math.sin(a)
        if (x - cx) ** 2 + (y - cy) ** 2 < r * r:
            inner.append((a, (x, y)))
    # Order the outer arc so it is continuous, then return along the inner arc.
    def ordered(arc):
        angles = [a for a, _ in arc]
        gap = max(range(len(angles)), key=lambda i: (angles[i] - angles[i - 1]) % (2 * math.pi))
        return [p for _, p in arc[gap:] + arc[:gap]]
    o, i = ordered(outer), ordered(inner)
    # Join the outer arc's end to the nearer end of the inner arc.
    if math.dist(o[-1], i[0]) > math.dist(o[-1], i[-1]):
        i = i[::-1]
    return [("poly", o + i)]


def cycle():
    """Day and night: a small sun at the top left, a small moon at the bottom right, a slash between."""
    out = sun(cx=7, cy=7, r=2.6, ray_in=3.9, ray_out=5.8)
    for shape in moon():
        out.append(("poly", [(16.8 + (x - 12) * 0.55, 16.8 + (y - 12) * 0.55) for x, y in shape[1]]))
    out.append(("line", [(18.5, 4.5), (4.5, 18.5)], 1.6))
    return out


def pencil():
    """A pencil at 45 degrees, tip at the bottom left, with a line under it."""
    def rot(points):
        c, s = math.cos(math.radians(-45)), math.sin(math.radians(-45))
        return [(12 + (x - 12) * c - (y - 12) * s, 12 + (x - 12) * s + (y - 12) * c) for x, y in points]
    body = rot([(6.5, 9.6), (17.0, 9.6), (17.0, 14.4), (6.5, 14.4)])
    cap = rot([(18.2, 9.6), (20.6, 9.6), (20.6, 14.4), (18.2, 14.4)])
    tip = rot([(5.3, 9.6), (5.3, 14.4), (1.6, 12)])
    return [("poly", body), ("poly", cap), ("poly", tip)]


ICONS = {
    "prev-park": PREV_PARK,
    "next-park": mirror(PREV_PARK),
    "prev-view": PREV_VIEW,
    "next-view": mirror(PREV_VIEW),
    "pause": PAUSE,
    "play": PLAY,
    "shuffle": SHUFFLE,
    "music": NOTE,
    "music-off": NOTE + SLASH,
    "titles": TITLES,
    "titles-off": TITLES + SLASH,
    "settings": gear(),
    "edit": pencil(),
    "day": sun(),
    "night": moon(),
    "day-night": cycle(),
}


def inside_poly(pts, x, y):
    c = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            c = not c
    return c


def near_line(pts, w, x, y):
    r2 = (w / 2) ** 2
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        px, py = x1 + t * dx - x, y1 + t * dy - y
        if px * px + py * py <= r2:
            return True
    return False


def inside_ellipse(cx, cy, rx, ry, angle, x, y):
    a = math.radians(angle)
    dx, dy = x - cx, y - cy
    u = dx * math.cos(a) + dy * math.sin(a)
    v = -dx * math.sin(a) + dy * math.cos(a)
    return (u / rx) ** 2 + (v / ry) ** 2 <= 1


def hit(shape, x, y):
    if shape[0] == "poly":
        return inside_poly(shape[1], x, y)
    if shape[0] == "line":
        return near_line(shape[1], shape[2], x, y)
    return inside_ellipse(*shape[1:], x, y)


def bbox(shape):
    if shape[0] == "ellipse":
        _, cx, cy, rx, ry, _ = shape
        r = max(rx, ry)
        return cx - r, cy - r, cx + r, cy + r
    pad = shape[2] / 2 if shape[0] == "line" else 0
    xs = [p[0] for p in shape[1]]
    ys = [p[1] for p in shape[1]]
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def render(shapes, size):
    unit = 24 / size
    boxes = [bbox(s) for s in shapes]
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            covered = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = (px + (sx + 0.5) / SAMPLES) * unit
                    y = (py + (sy + 0.5) / SAMPLES) * unit
                    for s, (x0, y0, x1, y1) in zip(shapes, boxes):
                        if x0 <= x <= x1 and y0 <= y <= y1 and hit(s, x, y):
                            covered += 1
                            break
            alpha = round(255 * covered / (SAMPLES * SAMPLES))
            row += bytes(COLOUR) + bytes([alpha])
        rows.append(bytes(row))
    return rows


def png(rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def sizes():
    return sorted({round(g * s) for g in GAME_SIZES for s in SCALES})


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for name, shapes in ICONS.items():
        for size in sizes():
            with open(os.path.join(args.out, "%s-%d.png" % (name, size)), "wb") as f:
                f.write(png(render(shapes, size), size))
    print("%d icons at sizes %s -> %s" % (len(ICONS), sizes(), os.path.normpath(args.out)))


if __name__ == "__main__":
    main()
