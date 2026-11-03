#!/usr/bin/env python3
"""Draws the main menu's Screensaver button icon (engine patch 0015) in OpenRCT2's palette.

The stock menu buttons are 80x80 palette sprites; the engine has no sprite for ours and its data
files (g2.dat) are not replaced by the patched build, so the icon is compiled in: rows of runs of
palette indices in src/openrct2-ui/screensaver/MenuIcon.h, drawn with Rectangle::fill. The picture
is a monitor showing a park with a coaster hill and loop. Colours are snapped to the standard game
palette (indices 10-229, as 0-9 are special and 230+ animate), read from the engine tree's
ImageImporter.h. Stdlib only.

Usage: python tools/mkmenuicon.py --engine ../openrct2 [--preview build/menu-icon.png]
"""

import argparse
import os
import re
import struct
import zlib

GRID = 80  # the picture is laid out on the stock icons' 80 px grid
SIZE = 68  # and drawn this size (owner, 2026-11-02: slightly smaller than the stock icons, bottom-aligned)

# Layers, back to front: (colour, shape); shapes as in mkicons.py.
OUTLINE = (35, 35, 23)
BEZEL = (195, 195, 183)
BEZEL_DARK = (131, 131, 111)
BEZEL_LIGHT = (243, 243, 239)
SKY_TOP = (47, 123, 215)
SKY = (99, 151, 207)
HILL = (63, 143, 39)
HILL_DARK = (39, 107, 23)
TRACK = (207, 35, 35)
SUPPORT = (243, 243, 239)
CAR = (255, 215, 23)
STAND = (115, 115, 91)


def mkicons():
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mkicons.py")
    spec = importlib.util.spec_from_file_location("mkicons", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rect(x0, y0, x1, y1):
    return ("poly", [(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def layers():
    # Monitor: outline, bezel with a light top-left and dark bottom-right edge, screen inset.
    out = [
        (OUTLINE, rect(27, 60, 53, 66)),          # neck
        (OUTLINE, ("poly", [(18, 76), (62, 76), (56, 66), (24, 66)])),  # stand outline
        (STAND, ("poly", [(20, 75), (60, 75), (55, 67), (25, 67)])),
        (BEZEL_DARK, rect(30, 60, 50, 67)),
        (OUTLINE, rect(2, 6, 78, 62)),
        (BEZEL_LIGHT, rect(3, 7, 77, 61)),
        (BEZEL_DARK, rect(5, 9, 77, 61)),
        (BEZEL, rect(5, 9, 75, 59)),
        (OUTLINE, rect(9, 13, 71, 55)),
    ]
    # Screen: sky in two bands, hills, then the coaster: a hill and a loop with white supports.
    out += [
        (SKY_TOP, rect(10, 14, 70, 26)),
        (SKY, rect(10, 26, 70, 54)),
        (HILL_DARK, ("poly", [(10, 54), (10, 42), (24, 37), (40, 43), (56, 38), (70, 41), (70, 54)])),
        (HILL, ("poly", [(10, 54), (10, 47), (28, 43), (46, 47), (62, 44), (70, 46), (70, 54)])),
    ]
    supports = [(16, 40), (22, 30), (28, 24), (34, 32), (52, 36), (64, 42)]
    for x, top in supports:
        out.append((SUPPORT, ("line", [(x, top + 2), (x, 50)], 1.4)))
    out += [
        (TRACK, ("line", [(10, 46), (16, 40), (22, 30), (27, 23), (30, 22), (34, 28),
                          (38, 38), (42, 44), (48, 44)], 2.6)),
        (TRACK, ("ellipse", 49, 34, 8.5, 9.5, 0)),
        (SKY, ("ellipse", 49, 34, 6.2, 7.2, 0)),
        (HILL_DARK, ("poly", [(42, 41), (56, 41), (56, 43.5), (42, 43.5)])),
        (TRACK, ("line", [(48, 44), (56, 43), (64, 40), (70, 39)], 2.6)),
        (CAR, rect(24.5, 22, 29.5, 25.5)),
        (OUTLINE, rect(24.5, 25.5, 29.5, 26.5)),
    ]
    return out


def draw(shapes):
    hit = mkicons().hit
    pixels = [[None] * SIZE for _ in range(SIZE)]
    for colour, shape in shapes:
        for y in range(SIZE):
            for x in range(SIZE):
                if hit(shape, (x + 0.5) * GRID / SIZE, (y + 0.5) * GRID / SIZE):
                    pixels[y][x] = colour
    return pixels


def palette(engine):
    path = os.path.join(engine, "src", "openrct2", "drawing", "ImageImporter.h")
    text = open(path, encoding="utf-8").read()
    block = text[text.index("StandardPalette"):]
    entries = re.findall(r"\{\s*(\d+),\s*(\d+),\s*(\d+),\s*\d+\s*\}", block)[:256]
    # The entries are BGRAColour: blue, green, red, alpha.
    return [(int(r), int(g), int(b)) for b, g, r in entries]


def nearest(pal, colour):
    best = min(range(10, 230), key=lambda i: sum((a - b) ** 2 for a, b in zip(pal[i], colour)))
    return best


def runs(pixels, pal):
    cache = {}
    out = []
    for y, row in enumerate(pixels):
        x = 0
        while x < SIZE:
            colour = row[x]
            if colour is None:
                x += 1
                continue
            start = x
            while x < SIZE and row[x] == colour:
                x += 1
            if colour not in cache:
                cache[colour] = nearest(pal, colour)
            out.append((y, start, x - start, cache[colour]))
    return out


def trim(spans):
    """The runs moved to the picture's own box (its first row and column at 0)."""
    y0 = min(s[0] for s in spans)
    x0 = min(s[1] for s in spans)
    return [(y - y0, x - x0, n, i) for y, x, n, i in spans]


def bbox(spans):
    return max(x + n for _, x, n, _ in spans), max(y for y, _, _, _ in spans) + 1


def header(spans):
    lines = [
        "// Generated by RCT Screensaver's tools/mkmenuicon.py: the main menu's Screensaver button",
        "// icon, a monitor showing a park, as runs of standard palette indices (y, x, length, index).",
        "",
        "#pragma once",
        "",
        "#include <cstdint>",
        "",
        "namespace OpenRCT2::Ui::Screensaver",
        "{",
        "    struct MenuIconRun",
        "    {",
        "        uint8_t y, x, length, index;",
        "    };",
        "",
        f"    constexpr int32_t kMenuIconWidth = {bbox(spans)[0]};",
        f"    constexpr int32_t kMenuIconHeight = {bbox(spans)[1]};",
        "    constexpr MenuIconRun kMenuIcon[] = {",
    ]
    for i in range(0, len(spans), 6):
        lines.append("        " + " ".join("{ %d, %d, %d, %d }," % s for s in spans[i:i + 6]))
    lines += ["    };", "} // namespace OpenRCT2::Ui::Screensaver", ""]
    return "\n".join(lines)


def preview(spans, pal, path, scale=4):
    size = SIZE * scale
    rows = [bytearray(b"\x28\x28\x28" * size) for _ in range(size)]
    for y, x, length, index in spans:
        r, g, b = pal[index]
        for sy in range(y * scale, (y + 1) * scale):
            rows[sy][x * scale * 3:(x + length) * scale * 3] = bytes((r, g, b)) * (length * scale)
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", required=True, help="the OpenRCT2 source tree to write into")
    parser.add_argument("--preview", help="also write a 4x PNG preview here")
    args = parser.parse_args()
    pal = palette(args.engine)
    spans = trim(runs(draw(layers()), pal))
    out = os.path.join(args.engine, "src", "openrct2-ui", "screensaver", "MenuIcon.h")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(header(spans))
    print(f"{len(spans)} runs -> {out}")
    if args.preview:
        preview(spans, pal, args.preview)
        print(f"preview -> {args.preview}")


if __name__ == "__main__":
    main()
