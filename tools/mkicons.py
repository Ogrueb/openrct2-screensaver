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
GAME_SIZES = (20, 24, 34)  # 20: the view editor's tool buttons (EDITOR.icon)
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


def arc(cx, cy, r, a0, a1, n=32):
    """Points on a circle from angle a0 to a1 (degrees, clockwise on screen: y points down)."""
    return circle(cx, cy, r, n, math.radians(a0), math.radians(a1))


def head(tip, angle, length=5.2, half=3.6):
    """A filled arrowhead with its tip at `tip`, pointing along `angle` (degrees, screen y down)."""
    a = math.radians(angle)
    ux, uy = math.cos(a), math.sin(a)
    bx, by = tip[0] - ux * length, tip[1] - uy * length
    return ("poly", [tip, (bx - uy * half, by + ux * half), (bx + uy * half, by - ux * half)])


def turn_arrow(clockwise):
    """Rotate right (clockwise) or left: three quarters of a ring with a head at its end."""
    a0, a1 = (-200, 50) if clockwise else (20, 270)
    pts = arc(12, 13, 7.2, a0, a1)
    if not clockwise:
        pts = pts[::-1]
    end, before = pts[-1], pts[-3]
    ang = math.degrees(math.atan2(end[1] - before[1], end[0] - before[0]))
    return [("line", pts[:-2], 2.2), head((end[0] + math.cos(math.radians(ang)) * 2.2, end[1] + math.sin(math.radians(ang)) * 2.2), ang)]


def undo_arrow():
    """Undo: a hook arrow pointing left, curving back down on the right."""
    pts = [(9, 9)] + arc(13.5, 13.5, 4.5, -90, 90)[1:] + [(7, 18)]
    return [("line", pts, 2.2), head((3.5, 9), 180, 5.0, 3.8)]


def magnifier(plus):
    shapes = [("line", circle(10.5, 10.5, 6.2), 2.2), ("line", [(15, 15), (20.5, 20.5)], 3.0),
              ("line", [(7.6, 10.5), (13.4, 10.5)], 2.0)]
    if plus:
        shapes.append(("line", [(10.5, 7.6), (10.5, 13.4)], 2.0))
    return shapes


def padlock(open_=False):
    shackle = arc(12, 12, 4.2, 180, 360) if not open_ else arc(17.5, 11, 4.2, 180, 360)
    body = [(5.5, 12), (18.5, 12), (18.5, 21), (5.5, 21), (5.5, 12),
            (11, 15), (13, 15), (13, 18), (11, 18), (11, 15)]
    if open_:
        legs = [(13.3, 12)] + shackle + [(21.7, 13)]
    else:
        legs = [(7.8, 12)] + shackle + [(16.2, 12)]
    return [("poly", body), ("line", legs, 2.0)]


def sparkle(cx, cy, r):
    """A four-pointed star."""
    w = r * 0.28
    return ("poly", [(cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w),
                     (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w)])


def events_lock(open_=False):
    """Event views locked: sparkles over a padlock (owner, 2026-11-10); open: unlocked."""
    shapes = []
    for shape in padlock(open_):
        if shape[0] == "poly":
            shapes.append(("poly", [(x * 0.82 + 3.6, y * 0.82 + 4.2) for x, y in shape[1]]))
        else:
            shapes.append(("line", [(x * 0.82 + 3.6, y * 0.82 + 4.2) for x, y in shape[1]], shape[2]))
    return shapes + [sparkle(5.2, 5.0, 3.6), sparkle(19.5, 4.2, 2.6), sparkle(12.0, 2.6, 1.9)]


def trash():
    lid = ("poly", [(4.5, 5.5), (19.5, 5.5), (19.5, 7.5), (4.5, 7.5)])
    knob = ("poly", [(9.5, 3), (14.5, 3), (14.5, 5.5), (9.5, 5.5)])
    can = ("poly", [(6, 8.8), (18, 8.8), (17, 21), (7, 21), (6, 8.8),
                    (9, 11), (9.3, 19), (10.7, 19), (10.7, 11), (9, 11),
                    (13.3, 11), (13.3, 19), (14.7, 19), (15, 11), (13.3, 11)])
    return [lid, knob, can]


def target():
    """Set to the camera: a viewfinder's corners round a dot."""
    c = []
    for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        ox, oy = 12 - sx * 8.5, 12 - sy * 8.5
        c.append(("line", [(ox, oy + sy * 4.5), (ox, oy), (ox + sx * 4.5, oy)], 2.0))
    return c + [("poly", circle(12, 12, 3.0))]


def frame_icon():
    """The Frame switch: a picture's frame (a screen) with corner ticks."""
    return [("poly", [(3, 5), (21, 5), (21, 19), (3, 19), (3, 5), (5, 7), (5, 17), (19, 17), (19, 7), (5, 7)]),
            ("line", [(8, 12), (16, 12)], 1.6), ("line", [(12, 9.5), (12, 14.5)], 1.6)]


def map_icon():
    """The Map switch: a map folded in three."""
    return [("line", [(3, 6), (9, 3.5), (15, 6), (21, 3.5), (21, 18), (15, 20.5), (9, 18), (3, 20.5), (3, 6)], 1.9),
            ("line", [(9, 3.5), (9, 18)], 1.6), ("line", [(15, 6), (15, 20.5)], 1.6)]


def pin():
    """Keep the editor shown: a push pin."""
    return [("poly", [(8, 3), (16, 3), (16, 4.8), (14.6, 4.8), (14.6, 10.5), (18, 14), (18, 15.5),
                      (6, 15.5), (6, 14), (9.4, 10.5), (9.4, 4.8), (8, 4.8)]),
            ("line", [(12, 15.5), (12, 21.5)], 1.8)]


def bookmark_plus():
    outline = [(6, 3), (18, 3), (18, 21), (12, 16.5), (6, 21), (6, 3)]
    return [("line", outline, 2.0), ("line", [(9, 9), (15, 9)], 2.0), ("line", [(12, 6), (12, 12)], 2.0)]


def clock_back():
    """Restore: a clock with an arrow running back round it."""
    ring = arc(12.5, 12, 8, -150, 180)
    return [("line", ring, 2.0), head((4.0, 9.0), 120, 4.6, 3.4),
            ("line", [(12.5, 7.5), (12.5, 12.5), (16, 14.5)], 2.0)]


def copy_icon():
    return [("line", [(9, 9), (20, 9), (20, 20), (9, 20), (9, 9)], 2.0),
            ("line", [(5.5, 15.5), (4, 15.5), (4, 4), (15.5, 4), (15.5, 5.5)], 2.0)]


def paste_icon():
    return [("line", [(8, 5), (5, 5), (5, 21.5), (19, 21.5), (19, 5), (16, 5)], 2.0),
            ("poly", [(8.5, 3), (15.5, 3), (15.5, 7), (8.5, 7)]),
            ("line", [(8.5, 11.5), (15.5, 11.5)], 1.6), ("line", [(8.5, 15), (15.5, 15)], 1.6),
            ("line", [(8.5, 18.5), (13, 18.5)], 1.6)]


def floppy():
    return [("poly", [(3.5, 3.5), (17, 3.5), (20.5, 7), (20.5, 20.5), (3.5, 20.5), (3.5, 3.5),
                      (5.5, 5.5), (5.5, 18.5), (18.5, 18.5), (18.5, 7.8), (16.2, 5.5), (5.5, 5.5)]),
            ("poly", [(7.5, 5.5), (15, 5.5), (15, 10), (7.5, 10)]),
            ("poly", [(7.5, 13), (16.5, 13), (16.5, 18.5), (7.5, 18.5), (7.5, 13), (9.3, 14.6), (9.3, 18.5), (14.7, 18.5), (14.7, 14.6), (9.3, 14.6)])]


def tray(up):
    shapes = [("line", [(3.5, 14), (3.5, 20), (20.5, 20), (20.5, 14)], 2.0)]
    if up:
        shapes += [("line", [(12, 16), (12, 7)], 2.0), head((12, 2.8), -90, 5.0, 4.0)]
    else:
        shapes += [("line", [(12, 3), (12, 12)], 2.0), head((12, 16.6), 90, 5.0, 4.0)]
    return shapes


def reset_view():
    """Reset the selected view: a full turn back to a dot (the view's own spot)."""
    ring = arc(12, 12, 7.8, -60, 250)[::-1]
    return [("line", ring, 2.2), head((17.6, 3.6), -20, 5.0, 3.8), ("poly", circle(12, 12, 2.2))]


CLOSE = [("line", [(6, 6), (18, 18)], 2.6), ("line", [(18, 6), (6, 18)], 2.6)]
PLUS = [("line", [(12, 4.5), (12, 19.5)], 2.6), ("line", [(4.5, 12), (19.5, 12)], 2.6)]
MINUS = [("line", [(4.5, 12), (19.5, 12)], 2.6)]


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
    # The view editor (docs/screensaver-ui.md, "Editor"; owner, 2026-11-10)
    "close": CLOSE,
    "add": PLUS,
    "less": MINUS,
    "set-camera": target(),
    "delete": trash(),
    "rotate-left": mirror(turn_arrow(True)),
    "rotate-right": turn_arrow(True),
    "zoom-in": magnifier(True),
    "zoom-out": magnifier(False),
    "events-locked": events_lock(),
    "events-unlocked": events_lock(True),
    "undo": undo_arrow(),
    "redo": mirror(undo_arrow()),
    "reset-view": reset_view(),
    "pin": pin(),
    "frame": frame_icon(),
    "map": map_icon(),
    "checkpoint": bookmark_plus(),
    "restore": clock_back(),
    "copy": copy_icon(),
    "paste": paste_icon(),
    "save": floppy(),
    # Build the playlist from the game (a hammer)
    "build": [("line", [(14.5, 9), (4.5, 19)], 3.0), ("poly", [(11.9, 3.2), (20.3, 11.6), (17.1, 14.8), (8.7, 6.4)])],
    "import": tray(False),
    # The build pane: a park built (its square), and its messages' marks
    "check": [("line", [(4.5, 12.5), (9.5, 17.5), (19.5, 6.5)], 3.2)],
    "alert": [("line", [(12, 4), (12, 14.5)], 3.2), ("poly", circle(12, 19, 2.0))],
    "info": [("line", [(12, 10.5), (12, 20)], 3.0), ("poly", circle(12, 5.5, 2.0))],
    # Fold marks (the game's font has no triangles): a list or section open, or folded.
    "fold-open": [("poly", [(6.5, 9), (17.5, 9), (12, 15.5)])],
    "fold-closed": [("poly", [(9, 6.5), (15.5, 12), (9, 17.5)])],
    "export": tray(True),
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
        if dx == 0 and dy == 0:
            dx = 1e-9  # a repeated point: the segment is a dot
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
