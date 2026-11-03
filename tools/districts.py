"""Prototype of district detection for pan-based view generation: a park's points of interest
and the districts they fall in, drawn flat from above and on the game's own renders, so the
grouping can be judged without playing.

Usage: python3 tools/districts.py <playlist.toml> [-o OUTDIR] [--set option=value ...]
                                   [--renders [DIR]]

Writes OUTDIR/<nn>-<park>.png (one per park, from above), OUTDIR/index.html with all of them,
and OUTDIR/districts.json (the points and districts). Stdlib only: the PNGs are written
directly. With --renders DIR (the render cache of tools/drawviews.py, build/drawviews/renders
by default; needs Pillow), also draws the districts on each park's render from every angle,
as the game shows it, into OUTDIR/<nn>-<park>-r<angle>.png; renders missing from the cache are
skipped (run drawviews.py on the PC to make them).

Points of interest (third version, after the owner's looks of 2026-10-28/29):
- Elements under shallow water do not count (sea-floor rocks under a cable car made close-ups on
  open water): on a tile with water up to `water_depth` steps deep, only elements reaching above
  the water level are kept. Deeper water is a scene, not a hiding place (The Koi Pond is built
  70 steps under water; dropping it moved the park's content box onto the backdrop).
- Spots: the close-ups mksequence.spot_views picks with a budget of `district_points` (24) and
  no second angle on a spot, so they are distinct, spaced spots at the zooms that suit them (the
  first ones are the park's usual views). Each is moved onto the nearest built tile, so none sits
  on open water or empty ground between the things it scores.
- Towers: tall objects stand out from their surroundings and get a point of their own, zoomed
  to fit their height. A tile's built top is the highest of its elements that belongs to the
  structure standing there: the height spans of the elements within 2 tiles (a tower's pieces
  sit on neighbouring tiles at different heights) and of the terrain around, piled up from the
  tile's ground until a gap of more than `tower_gap` steps (a track or cable passing overhead,
  or an object floating in the sky, is not part of it; both made false towers; on a tower's own
  tiles the top then climbs on through gaps up to `tower_crown`, for a spire piece set above a
  hollow); a tower is
  `tower_height` steps or taller and
  rises `tower_rise` steps above the `tower_ring` percentile of the built heights 2-6 tiles around it (so a
  tower in a dense town still stands out, and a large building's roof does not); towers join by
  adjacency (within `tower_merge` tiles) into one each, and towers under `tower_share` of the
  park's tallest are left out. Found over the whole map, so a tower at the edge of the content
  box is not trimmed away.
- Animations: a companion plugin's scripted animations (tools/companions.py) are points too,
  whether or not the playlist flags `animations`.

Districts come from the content's continuity, not from the gaps between points: the map's
element counts (per tile, capped at the 95th percentile; zero on tiles whose ground jumps
`district_cliff` steps to a neighbour, so cliffs and terraces divide) are smoothed over
`district_smooth` tiles and split into basins around the density peaks (a watershed); two basins merge where the
density at the saddle between them is at least `district_persist` of the lower peak, so a town
with a shallow dip in the middle is one district while a castle cut off by cliffs is another.
Basins holding no point join a neighbour, and a district with fewer than `district_min` points
joins the neighbour it is best connected to. A district holding more than `district_max` of the
park's points is out of proportion (the owner, 2026-10-29: two thirds of San Avaiki in one
district complicates routing), so basins that could both stand alone do not merge past that
share, and the shallowest dips are what stays unmerged. Every point gets the district of its tile.
"""
import argparse, hashlib, json, math, os, statistics, struct, sys, tempfile, tomllib, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import companions, mksequence, parkinfo  # noqa: E402

DEFAULTS = {
    "district_points": 24,  # spots per park: the picker's choice with this budget
    "water_depth": 24,      # height steps: elements under water up to this deep do not count
    "district_smooth": 2.5,  # tiles: the density map's smoothing radius (gaussian sigma)
    "district_persist": 0.7,  # basins merge where the saddle between them is this share of the lower peak
    "district_cliff": 4,    # height steps: a tile whose ground jumps this much to a neighbour counts as
                            # empty in the density map, so cliffs and terraces separate districts
    "district_min": 3,      # a district with fewer points joins its best-connected neighbour
    "district_max": 0.4,    # share of the park's points: basins that can stand alone do not merge past it
    "tower_height": 32,     # height steps (8 units): a tile this far above the ground can be a tower
    "tower_rise": 24,       # height steps a tower's top must rise above the built height around it
    "tower_gap": 8,         # height steps: a larger gap in the structure on a tile ends its built top
    "tower_ring": 0.8,      # percentile of the built heights 2-6 tiles around that a tower must rise above
    "tower_crown": 32,      # height steps: a tower's top climbs through gaps up to this on its own tiles
    "tower_share": 0.6,     # a tower shorter than this share of the park's tallest is not one (0.4 until
                            # 2026-10-29: a low, wide building at Troubadours' edge got a tower view)
    "tower_merge": 4,       # tiles: towers closer than this are one tower
}
RENDER_MAX = 1800  # longest side of a render with districts drawn on it, pixels
SCALE_PX = 900  # longest side of the drawn content box, pixels
SCREEN = (1920, 1080)  # window the tower zoom is chosen for
COLOURS = [(230, 90, 60), (70, 160, 230), (90, 200, 90), (240, 190, 50), (200, 100, 220),
           (80, 210, 200), (240, 130, 190), (160, 160, 90), (120, 120, 240), (220, 150, 90)]
FONT = {  # 3x5 digits for labels
    "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"], "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"], "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "010", "010", "010"],
    "8": ["111", "101", "111", "101", "111"], "9": ["111", "101", "111", "001", "111"],
}


def load_park(entry, base_dir, defaults, library):
    """A playlist park's element data, view options and companion animation views, as
    mksequence.resolve_park reads them."""
    path = os.path.join(base_dir, entry["file"])
    member, data = parkinfo.read_park_bytes(path, entry.get("member"))
    hdr, chunks, body = parkinfo.load(data)
    saved_name = parkinfo.parse_park(parkinfo.chunk_reader(chunks, body, 6), hdr["target"])["name"]
    name = entry.get("name") or parkinfo.display_name(saved_name, path, member)[0]
    saved = parkinfo.parse_interface(parkinfo.chunk_reader(chunks, body, 0x20))
    _, counts, surface, heights = parkinfo.visible_element_counts(parkinfo.chunk_reader(chunks, body, 0x30))
    water = parkinfo.water_heights(parkinfo.chunk_reader(chunks, body, 0x30))
    counts, heights = above_water(counts, heights, surface, water, int(defaults["water_depth"]))
    opts = {**defaults, **entry.get("views", {}), "saved_rotation": saved["rotation"]}
    # Companion animations, whether or not the playlist asks for views on them
    found = companions.find(entry, base_dir, member)
    storage_chunk = parkinfo.chunk_reader(chunks, body, 0x38)
    storage = json.loads(storage_chunk.str()) if storage_chunk else {}
    track_all = {(x, y, ride) for (x, y, _), ride in
                 parkinfo.track_rides(parkinfo.chunk_reader(chunks, body, 0x30), invisible=True).items()}
    found = companions.complete(found, library, storage, track_all, entry)
    track = parkinfo.track_rides(parkinfo.chunk_reader(chunks, body, 0x30))
    animations = mksequence.companion_views({**entry, "animations": True, "show": None}, found, storage, saved_name,
                                            heights, surface, saved["rotation"], 10.0, track, track_all)
    return name, counts, surface, heights, opts, animations


def above_water(counts, heights, surface, water, depth):
    """The element counts and heights without the elements under shallow water: on a tile
    whose water level is above its ground by up to `depth` steps, only elements whose top
    reaches above the water stay. Deeper water is left alone: a scene built under it is the
    scene."""
    counts, heights = dict(counts), dict(heights)
    for (x, y), (_, _, elements) in list(heights.items()):
        level = water[y * 1001 + x]
        if not surface[y * 1001 + x] < level <= surface[y * 1001 + x] + depth:
            continue
        kept = [e for e in elements if e[1] > level]
        if kept:
            counts[(x, y)] = len(kept)
            heights[(x, y)] = [sum(b for b, _, _ in kept), max(c for _, c, _ in kept), kept]
        else:
            del counts[(x, y)], heights[(x, y)]
    return counts, heights


def built_tops(counts, heights, surface, gap, reach=2):
    """Each tile's built top: the highest of its own elements that belongs to the structure
    standing there. The structure's height spans are read from the elements within `reach`
    tiles (a tower's pieces sit on neighbouring tiles at different heights) and the terrain
    around (a tower on a slope stands on the higher ground), piled up from the tile's ground
    until a gap of more than `gap` height steps: a track or cable passing overhead, or an
    object floating in the sky, is not part of the structure."""
    ground = lambda t: surface[t[1] * 1001 + t[0]]
    tops = {}
    for t in counts:
        spans = []
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                u = (t[0] + dx, t[1] + dy)
                if u in heights:
                    spans += [(b, c) for b, c, _ in heights[u][2]]
                if 0 <= u[0] < 1001 and 0 <= u[1] < 1001:
                    spans.append((0, ground(u)))
        limit = ground(t)
        for base, clearance in sorted(spans):
            if base > limit + gap:
                break
            limit = max(limit, clearance)
        tops[t] = max((c for _, c, _ in heights[t][2] if c <= limit), default=ground(t))
    return tops


def distance(a, b):
    return max(abs(a["x"] - b["x"]), abs(a["y"] - b["y"]), abs(a["z"] - b["z"]) / mksequence.HEIGHT_PER_TILE)


def snap(x, y, built, limit=4):
    """The nearest built tile to (x, y) within `limit` tiles, or (x, y) itself."""
    if (x, y) in built:
        return x, y
    best = None
    for dx in range(-limit, limit + 1):
        for dy in range(-limit, limit + 1):
            t = (x + dx, y + dy)
            if t in built:
                d = math.hypot(dx, dy)
                if best is None or d < best[0]:
                    best = (d, t)
    return best[1] if best else (x, y)


def spot_points(pool, heights, surface, opts):
    """The park's spot points: the close-ups mksequence.spot_views picks with a budget of
    `district_points` views, no second angle on a spot, each moved onto the nearest built tile."""
    n = int(opts["district_points"])
    views = mksequence.spot_views(None, heights, surface, {**opts, "count": n, "base_views": n, "angle_repeat": 0}, pool)
    built = set(pool["detailed"])
    points = []
    for v in views[1:]:
        x, y = snap(v["x"], v["y"], built)
        points.append({"x": x, "y": y, "z": v["z"], "zoom": v["zoom"], "rotation": v["rotation"], "kind": "spot",
                       "cell": max(1, round(int(opts["cell"]) * 2 ** v["zoom"])),
                       "score": round(v["why"]["spot"] * v["why"]["seen"], 3), "active": v["why"]["active"],
                       "moved": round(math.hypot(x - v["x"], y - v["y"]), 1)})
    return points


def tower_points(counts, heights, surface, opts):
    """Towers: adjacent tiles whose built top (see built_tops) is `tower_height` steps or more
    above the ground and `tower_rise` steps above the `tower_ring` percentile of the built tops
    2-6 tiles around them, one point each at mid-height, zoomed to fit the tower's height on
    screen."""
    min_height, rise, gap = int(opts["tower_height"]), int(opts["tower_rise"]), int(opts["tower_gap"])
    ground = lambda t: surface[t[1] * 1001 + t[0]]
    tops = built_tops(counts, heights, surface, gap)
    tall = {t for t, top in tops.items() if top - ground(t) >= min_height}
    # Each tall tile must rise above its neighbourhood, so a tall building's roof is not a
    # tower everywhere, only where something sticks up.
    around = {}
    for t in tall:
        near = [tops.get((t[0] + dx, t[1] + dy), ground(t)) for dx in range(-6, 7) for dy in range(-6, 7)
                if max(abs(dx), abs(dy)) > 1]
        near.sort()
        around[t] = near[min(len(near) - 1, int(len(near) * float(opts["tower_ring"])))]
    sticking = {t for t in tall if tops[t] - around[t] >= rise}
    seen, towers = set(), []
    for start in sorted(sticking):
        if start in seen:
            continue
        stack, cluster = [start], []
        while stack:
            t = stack.pop()
            if t in seen or t not in sticking:
                continue
            seen.add(t)
            cluster.append(t)
            reach = int(opts["tower_merge"])
            stack += [(t[0] + dx, t[1] + dy) for dx in range(-reach, reach + 1) for dy in range(-reach, reach + 1) if dx or dy]
        top = max(tops[t] for t in cluster)
        base = min(ground(t) for t in cluster)
        # The crown: a spire's top piece can sit above a gap wider than tower_gap in the
        # column (Constellations' observatory tower: the top 27 steps were cut off and its
        # view sat too low, owner 2026-10-29), so a tower's top climbs on through the elements
        # on its tiles and their neighbours (a hollow spire's top piece sits on the tile between) as long as each starts within tower_crown steps of the top so far.
        crown = int(opts["tower_crown"])
        own = {(t[0] + dx, t[1] + dy) for t in cluster for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
        above = sorted((b, c) for t in own if t in heights for b, c, _ in heights[t][2] if c > top)
        for b, c in above:
            if b > top + crown:
                break
            top = max(top, c)
        elements = sum(counts[t] for t in cluster)
        x = round(sum(t[0] for t in cluster) / len(cluster))
        y = round(sum(t[1] for t in cluster) / len(cluster))
        height_px = (top - base) * 8  # world units are screen pixels at zoom 0
        zoom = -2
        while zoom < 1 and height_px + 96 > 0.8 * SCREEN[1] * 2 ** zoom:
            zoom += 1
        towers.append({"x": x, "y": y, "z": round((top + base) * 4), "zoom": zoom, "kind": "tower",
                       "cell": max(1, round(32 * 2 ** zoom)), "score": 1.0, "active": 0.0,
                       "height": top - base, "tiles": len(cluster), "elements": elements})
    towers.sort(key=lambda t: -t["height"])
    if towers:
        tallest = towers[0]["height"]
        towers = [t for t in towers if t["height"] >= float(opts["tower_share"]) * tallest]
    return towers


def animation_points(animations):
    return [{"x": v["x"], "y": v["y"], "z": v["z"], "zoom": v["zoom"], "rotation": v["rotation"], "kind": "animation",
             "cell": max(1, round(32 * 2 ** v["zoom"])), "score": 1.0, "active": 1.0, "name": v["animation"]}
            for v in animations]


def gaussian_blur(grid, w, h, sigma):
    """Separable gaussian blur of a w×h list of floats (row-major)."""
    radius = max(1, int(3 * sigma))
    kernel = [math.exp(-0.5 * (k / sigma) ** 2) for k in range(-radius, radius + 1)]
    total = sum(kernel)
    kernel = [k / total for k in kernel]
    tmp = [0.0] * (w * h)
    for y in range(h):
        row = grid[y * w:(y + 1) * w]
        for x in range(w):
            s = 0.0
            for k, kv in enumerate(kernel):
                xx = x + k - radius
                if 0 <= xx < w:
                    s += row[xx] * kv
            tmp[y * w + x] = s
    out = [0.0] * (w * h)
    for x in range(w):
        for y in range(h):
            s = 0.0
            for k, kv in enumerate(kernel):
                yy = y + k - radius
                if 0 <= yy < h:
                    s += tmp[yy * w + x] * kv
            out[y * w + x] = s
    return out


def basins(counts, surface, bounds, opts):
    """Watershed of the smoothed element density over the content box (plus a margin): each
    tile's basin, the basins' peaks, and the saddle (highest crossing density) between each
    pair of neighbouring basins, before any merging (merge_basins does that, once the points
    in each basin are known). Returns (labels {tile: basin}, peaks {basin: density}, saddles
    {(a, b): density})."""
    margin = 4
    x0, y0 = bounds["x0"] - margin, bounds["y0"] - margin
    w, h = bounds["x1"] - bounds["x0"] + 1 + 2 * margin, bounds["y1"] - bounds["y0"] + 1 + 2 * margin
    cap = sorted(counts.values())[int(len(counts) * 0.95)] if counts else 1
    cliff = int(opts["district_cliff"])
    grid = [0.0] * (w * h)
    for (x, y), n in counts.items():
        if 0 <= x - x0 < w and 0 <= y - y0 < h:
            g = surface[y * 1001 + x]
            jump = max(abs(g - surface[(y + dy) * 1001 + x + dx]) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                       if 0 <= x + dx < 1001 and 0 <= y + dy < 1001)
            grid[(y - y0) * w + (x - x0)] = min(n, cap) if jump <= cliff else 0.0
    density = gaussian_blur(grid, w, h, float(opts["district_smooth"]))
    order = sorted(range(w * h), key=lambda i: -density[i])
    label = [-1] * (w * h)
    peaks = {}
    saddles = {}
    floor = max(density) * 0.02  # below this is empty ground: no basin starts there
    for i in order:
        if density[i] <= floor:
            break
        x, y = i % w, i // w
        near = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if (dx or dy) and 0 <= x + dx < w and 0 <= y + dy < h:
                    j = (y + dy) * w + (x + dx)
                    if label[j] >= 0:
                        near.add(label[j])
        if not near:
            label[i] = len(peaks)
            peaks[label[i]] = density[i]
        else:
            # join the neighbouring basin with the highest peak; this tile is a saddle between
            # every pair of basins it touches
            label[i] = max(near, key=lambda b: peaks[b])
            for a in near:
                for b in near:
                    if a < b:
                        key = (a, b)
                        saddles[key] = max(saddles.get(key, 0.0), density[i])
    labels = {}
    for i, b in enumerate(label):
        if b >= 0:
            labels[(i % w + x0, i // w + y0)] = b
    return labels, peaks, saddles


def merge_basins(peaks, saddles, sizes, opts):
    """Merge shallow dips: the pair of basins with the highest saddle share (saddle density
    over the lower peak) first, while any pair reaches district_persist. A merge that would put
    more than district_max of the points (`sizes` counts points per basin, with the total under
    key None) into one basin is skipped when both basins have district_min points of their own,
    so the shallowest dips stay unmerged in a park that would otherwise be one district.
    Returns {basin: root basin}."""
    persist, minimum = float(opts["district_persist"]), int(opts["district_min"])
    cap = float(opts["district_max"]) * sizes.get(None, 0)
    parent = {b: b for b in peaks}
    count = {b: sizes.get(b, 0) for b in peaks}

    def find(b):
        while parent[b] != b:
            parent[b] = parent[parent[b]]
            b = parent[b]
        return b
    while True:
        best = None
        merged = {}
        for (a, b), s in saddles.items():
            ra, rb = find(a), find(b)
            if ra == rb:
                continue
            key = (min(ra, rb), max(ra, rb))
            merged[key] = max(merged.get(key, 0.0), s)
        for (ra, rb), s in merged.items():
            share = s / min(peaks[ra], peaks[rb])
            if share < persist or (best is not None and share <= best[0]):
                continue
            if count[ra] >= minimum and count[rb] >= minimum and count[ra] + count[rb] > cap:
                continue
            best = (share, ra, rb)
        if best is None:
            break
        _, ra, rb = best
        keep, gone = (ra, rb) if peaks[ra] >= peaks[rb] else (rb, ra)
        parent[gone] = keep
        count[keep] += count[gone]
    return {b: find(b) for b in peaks}


def districts_of(points, counts, surface, bounds, opts):
    """Group the points by the basin of their tile (see the module docstring). Returns the
    districts as lists of point indices (largest total score first), the tile labels for
    drawing, and notes."""
    labels, peaks, saddles = basins(counts, surface, bounds, opts)
    basin_of = []
    for p in points:
        b = labels.get((p["x"], p["y"]))
        if b is None:  # off the density map (a tower at the edge): the nearest labelled tile
            near = min(labels, key=lambda t: (t[0] - p["x"]) ** 2 + (t[1] - p["y"]) ** 2, default=None)
            b = labels[near] if near is not None else -1
        basin_of.append(b)
    sizes = {None: len(points)}
    for b in basin_of:
        sizes[b] = sizes.get(b, 0) + 1
    merged = merge_basins(peaks, saddles, sizes, opts)
    raw = len(peaks)

    def find(b):
        while merged.get(b, b) != b:
            b = merged[b]
        return b

    def connection(a, b):
        return max((s for (x, y), s in saddles.items() if {find(x), find(y)} == {a, b}), default=0.0)
    # Small districts join the neighbour they are best connected to (highest saddle), while
    # any district has fewer than district_min points; a neighbour the join keeps within
    # district_max of the points is preferred.
    minimum = int(opts["district_min"])
    cap = float(opts["district_max"]) * len(points)
    while True:
        groups = {}
        for i, b in enumerate(basin_of):
            groups.setdefault(find(b), []).append(i)
        small = [b for b, g in groups.items() if len(g) < minimum and b >= 0]
        if not small:
            break
        b = min(small, key=lambda b: len(groups[b]))
        others = [o for o in groups if o != b and o >= 0]
        if not others:
            break
        target = max(others, key=lambda o: (len(groups[o]) + len(groups[b]) <= cap, connection(b, o), len(groups[o])))
        if connection(b, target) <= 0:
            # not adjacent to any district with points: the nearest by distance
            target = min(others, key=lambda o: min(distance(points[i], points[j]) for i in groups[b] for j in groups[o]))
        merged[b] = target
    groups = {}
    for i, b in enumerate(basin_of):
        groups.setdefault(find(b), []).append(i)
    order = sorted(groups, key=lambda b: -sum(points[i]["score"] for i in groups[b]))
    index = {b: k for k, b in enumerate(order)}
    tile_district = {t: index[find(b)] for t, b in labels.items() if find(b) in index}
    return [groups[b] for b in order], tile_district, {"basins": raw}


# --- drawing ---

class Image:
    def __init__(self, w, h, colour=(24, 24, 28)):
        self.w, self.h = w, h
        self.px = bytearray(bytes(colour) * (w * h))

    def put(self, x, y, c, alpha=1.0):
        if 0 <= x < self.w and 0 <= y < self.h:
            i = (y * self.w + x) * 3
            if alpha >= 1:
                self.px[i:i + 3] = bytes(c)
            else:
                for k in range(3):
                    self.px[i + k] = round(self.px[i + k] * (1 - alpha) + c[k] * alpha)

    def rect(self, x0, y0, x1, y1, c, alpha=1.0):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                self.put(x, y, c, alpha)

    def disc(self, cx, cy, r, c, alpha=1.0):
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    self.put(x, y, c, alpha)

    def ring(self, cx, cy, r, c, width=1.5):
        for y in range(int(cy - r - 1), int(cy + r) + 2):
            for x in range(int(cx - r - 1), int(cx + r) + 2):
                if abs(math.hypot(x - cx, y - cy) - r) <= width / 2:
                    self.put(x, y, c)

    def line(self, x0, y0, x1, y1, c, width=1):
        steps = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
        for s in range(steps + 1):
            t = s / steps
            x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            for dy in range(-(width // 2), width - width // 2):
                for dx in range(-(width // 2), width - width // 2):
                    self.put(int(x) + dx, int(y) + dy, c)

    def text(self, x, y, s, c, scale=3):
        for ch in s:
            glyph = FONT.get(ch)
            if glyph:
                for r, row in enumerate(glyph):
                    for k, bit in enumerate(row):
                        if bit == "1":
                            self.rect(x + k * scale, y + r * scale, x + (k + 1) * scale, y + (r + 1) * scale, c)
            x += 4 * scale

    def png(self):
        raw = b"".join(b"\0" + bytes(self.px[y * self.w * 3:(y + 1) * self.w * 3]) for y in range(self.h))

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def point_colour(p, groups_index):
    return COLOURS[groups_index % len(COLOURS)]


def draw(name, pool, counts, points, groups, tile_district, heights, surface, opts, out_path):
    """Top-down image: the content box's tiles shaded by element count and tinted by district,
    each point of interest as a disc sized by score in its district's colour (towers with a
    white ring, animations with a white dot), each district numbered, the overview's centre
    marked."""
    b = pool["bounds"]
    w_tiles, h_tiles = b["x1"] - b["x0"] + 1, b["y1"] - b["y0"] + 1
    margin = 4
    s = max(2, SCALE_PX // (max(w_tiles, h_tiles) + 2 * margin))
    img = Image((w_tiles + 2 * margin) * s, (h_tiles + 2 * margin) * s)

    def px(x, y):
        return (x - b["x0"] + margin) * s, (y - b["y0"] + margin) * s
    cap = sorted(counts.values())[int(len(counts) * 0.95)] if counts else 1
    for (x, y), n in counts.items():
        x0, y0 = px(x, y)
        if not (0 <= x0 < img.w and 0 <= y0 < img.h):
            continue
        v = 50 + 170 * min(1.0, n / cap)
        c = (v, v, v)
        k = tile_district.get((x, y)) if (x, y) in pool["detailed"] else None
        if k is not None:
            tint = COLOURS[k % len(COLOURS)]
            c = tuple(v * 0.55 + t * 0.45 * (v / 220) for v, t in zip(c, tint))
        img.rect(x0, y0, x0 + s, y0 + s, tuple(int(k) for k in c))
    x0, y0 = px(b["x0"], b["y0"])
    x1, y1 = px(b["x1"] + 1, b["y1"] + 1)
    for (ax, ay, bx, by) in ((x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)):
        img.line(ax, ay, bx, by, (90, 90, 100))
    group_of = {i: k for k, g in enumerate(groups) for i in g}
    for i, p in enumerate(points):
        c = COLOURS[group_of[i] % len(COLOURS)] if i in group_of else (200, 200, 200)
        cx, cy = px(p["x"] + 0.5, p["y"] + 0.5)
        r = min(s, 10) * (0.6 + 1.6 * min(1.0, p["score"]))
        img.disc(cx, cy, r, c, 0.85)
        img.ring(cx, cy, r, (255, 255, 255) if p["kind"] == "tower" else (20, 20, 20))
        if p["kind"] == "animation":
            img.disc(cx, cy, r / 3, (255, 255, 255))
    for k, g in enumerate(groups):
        c = COLOURS[k % len(COLOURS)]
        cx = sum(points[i]["x"] for i in g) / len(g) + 0.5
        cy = sum(points[i]["y"] for i in g) / len(g) + 0.5
        lx, ly = px(cx, cy)
        img.rect(lx - 4, ly - 4, lx + 4 * 3 * len(str(k + 1)) + 2, ly + 5 * 3 + 4, (0, 0, 0), 0.6)
        img.text(int(lx), int(ly), str(k + 1), c, 3)
    ox, oy = px(b["cx"], b["cy"])
    img.line(ox - 8, oy, ox + 8, oy, (255, 255, 255), 2)
    img.line(ox, oy - 8, ox, oy + 8, (255, 255, 255), 2)
    with open(out_path, "wb") as f:
        f.write(img.png())
    return img.w, img.h


def render_files(playlist_path, renders_dir):
    """Per park index, the render cache's file for each angle (as drawviews.py names them: a
    hash of the park's bytes and the render plan) with its plan; only files that exist."""
    import drawviews
    with tempfile.TemporaryDirectory() as tmp:
        result = mksequence.build(playlist_path, tmp, use_edits=False)
    out = {}
    for i, park in enumerate(result["parks"]):
        for r in range(4):
            plan = drawviews.render_plan(park["box"], r)
            ident = hashlib.sha1(park["data"] + json.dumps(plan, sort_keys=True).encode()).hexdigest()[:16]
            path = os.path.join(renders_dir, "%s-r%d.png" % (ident, r))
            if os.path.exists(path):
                out.setdefault(i, {})[r] = (plan, path)
    return out


def draw_on_render(render_path, plan, box, surface, built, points, groups, tile_district, out_path):
    """The districts on a game render (drawviews.py's cache) from the render's angle, cropped
    to the content box: each district's tiles tinted on the ground, each point of interest a
    disc sized by score in its district's colour (towers with a white ring, animations with a
    white dot), each district numbered. Returns the output image's size."""
    from PIL import Image as PImage, ImageDraw, ImageFont
    img = PImage.open(render_path).convert("RGBA")
    r, zoom = plan["rotation"], plan["zoom"]
    (x0, x1), (y0, y1) = mksequence.screen_extent(box, r)
    pad = 0.06 * max(x1 - x0, y1 - y0) + 64
    crop = tuple(int(max(0, min(limit, (v - origin) / 2 ** zoom)))
                 for v, origin, limit in ((x0 - pad, plan["left"], img.size[0]), (y0 - pad, plan["top"], img.size[1]),
                                          (x1 + pad, plan["left"], img.size[0]), (y1 + pad, plan["top"], img.size[1])))
    img = img.crop(crop)
    scale = min(1.0, RENDER_MAX / max(img.size))
    if scale < 1:
        img = img.resize((round(img.size[0] * scale), round(img.size[1] * scale)), PImage.LANCZOS)
    overlay = PImage.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    def px(x, y, z):
        sx, sy = mksequence.screen_point(x, y, z, r)
        return (((sx - plan["left"]) / 2 ** zoom - crop[0]) * scale, ((sy - plan["top"]) / 2 ** zoom - crop[1]) * scale)
    # district tiles as ground diamonds, on built tiles only
    for (x, y), k in tile_district.items():
        if (x, y) not in built:
            continue
        z = surface[y * 1001 + x] * 8
        corners = [px(x * 32, y * 32, z), px(x * 32 + 32, y * 32, z), px(x * 32 + 32, y * 32 + 32, z), px(x * 32, y * 32 + 32, z)]
        d.polygon(corners, fill=COLOURS[k % len(COLOURS)] + (45,))
    group_of = {i: k for k, g in enumerate(groups) for i in g}
    radius = lambda p: 6 + 14 * min(1.0, p["score"])
    for i, p in enumerate(points):
        c = COLOURS[group_of[i] % len(COLOURS)] if i in group_of else (200, 200, 200)
        x, y = px(p["x"] * 32 + 16, p["y"] * 32 + 16, p["z"])
        rr = radius(p)
        outline = (255, 255, 255, 255) if p["kind"] == "tower" else (0, 0, 0, 255)
        d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=c + (210,), outline=outline, width=3 if p["kind"] == "tower" else 2)
        if p["kind"] == "animation":
            d.ellipse((x - rr / 3, y - rr / 3, x + rr / 3, y + rr / 3), fill=(255, 255, 255, 255))
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 28)
    except OSError:
        font = ImageFont.load_default()
    for k, g in enumerate(groups):
        c = COLOURS[k % len(COLOURS)]
        xs, ys = zip(*(px(points[i]["x"] * 32 + 16, points[i]["y"] * 32 + 16, points[i]["z"]) for i in g))
        x, y = sum(xs) / len(xs), sum(ys) / len(ys)
        label = str(k + 1)
        box_ = d.textbbox((x, y), label, font=font)
        d.rectangle((box_[0] - 6, box_[1] - 4, box_[2] + 6, box_[3] + 4), fill=(0, 0, 0, 170))
        d.text((x, y), label, fill=c + (255,), font=font)
    img = PImage.alpha_composite(img, overlay).convert("RGB")
    img.save(out_path, optimize=True)
    return img.size


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("playlist")
    ap.add_argument("-o", "--out", default="build/districts")
    ap.add_argument("--set", action="append", default=[], metavar="OPTION=VALUE",
                    help="override a [views] or district option (TOML value)")
    ap.add_argument("--renders", nargs="?", const="build/drawviews/renders", metavar="DIR",
                    help="also draw the districts on drawviews.py's cached renders from this directory "
                         "(default build/drawviews/renders; needs Pillow)")
    args = ap.parse_args()
    renders = render_files(args.playlist, args.renders) if args.renders else {}
    with open(args.playlist, "rb") as f:
        playlist = tomllib.load(f)
    base_dir = os.path.dirname(os.path.abspath(args.playlist))
    overrides = {}
    for item in args.set:
        k, _, v = item.partition("=")
        overrides[k.strip()] = tomllib.loads("v = %s" % v)["v"]
    defaults = {**mksequence.VIEW_DEFAULTS, **DEFAULTS, **playlist.get("views", {}), **overrides}
    entries = list(playlist.get("park", []))
    library = companions.library(entries, base_dir)
    os.makedirs(args.out, exist_ok=True)
    report = []
    rows = []
    for index, entry in enumerate(entries):
        name, counts, surface, heights, opts, animations = load_park(entry, base_dir, defaults, library)
        pool = mksequence.spot_pool(counts, heights, surface, opts)
        if pool is None:
            continue
        points = spot_points(pool, heights, surface, opts) + tower_points(counts, heights, surface, opts) \
            + animation_points(animations)
        groups, tile_district, info = districts_of(points, counts, surface, pool["bounds"], opts)
        file = "%02d-%s.png" % (index + 1, mksequence.slug(name))
        w, h = draw(name, pool, counts, points, groups, tile_district, heights, surface, opts, os.path.join(args.out, file))
        b = pool["bounds"]
        kinds = {k: sum(1 for p in points if p["kind"] == k) for k in ("spot", "tower", "animation")}
        sizes = ", ".join(str(len(g)) for g in groups)
        print("%-28s box %3dx%-3d points %2d (%d spots, %d towers, %d animations)  districts %d (%s) from %d basins"
              % (name, b["x1"] - b["x0"] + 1, b["y1"] - b["y0"] + 1, len(points), kinds["spot"], kinds["tower"],
                 kinds["animation"], len(groups), sizes, info["basins"]))
        for p in points:
            if p["kind"] == "tower":
                print("  tower at (%d, %d): %d steps tall over %d tiles, zoom %d" % (p["x"], p["y"], p["height"], p["tiles"], p["zoom"]))
        report.append({"name": name, "bounds": b, "points": points, "districts": groups, "basins": info["basins"]})
        angles = []
        for r, (plan, path) in sorted(renders.get(index, {}).items()):
            angle_file = "%02d-%s-r%d.png" % (index + 1, mksequence.slug(name), r)
            size = draw_on_render(path, plan, b, surface, set(pool["detailed"]), points, groups, tile_district, os.path.join(args.out, angle_file))
            angles.append((r, angle_file, size))
        if args.renders and len(angles) < 4:
            print("  %d of 4 renders in the cache" % len(angles))
        rows.append((name, file, w, h, len(points), len(groups), sizes, info, b, angles))
    with open(os.path.join(args.out, "districts.json"), "w") as f:
        json.dump({"options": {k: defaults[k] for k in DEFAULTS}, "parks": report}, f, indent=1)
    with open(os.path.join(args.out, "index.html"), "w", encoding="utf-8") as f:
        f.write("<!doctype html><meta charset=utf-8><title>Districts</title>"
                "<style>body{background:#111;color:#ddd;font:14px sans-serif;margin:20px}"
                "img{max-width:100%%;image-rendering:pixelated}h2{margin:30px 0 4px}p{margin:0 0 8px;color:#aaa}</style>"
                "<h1>District detection</h1><p>Ground tinted by district. Discs: points of interest, sized by score, "
                "colored by district; a white ring marks a tower, a white dot a scripted animation. "
                "White cross (top-down): the overview's center. Options: %s</p>"
                % ", ".join("%s=%s" % (k, defaults[k]) for k in DEFAULTS))
        for name, file, w, h, n, k, sizes, info, b, angles in rows:
            f.write("<h2>%s</h2><p>%d×%d tiles, %d points, %d districts (%s) from %d basins</p>"
                    "<img src=\"%s\" width=%d height=%d>" % (name, b["x1"] - b["x0"] + 1, b["y1"] - b["y0"] + 1,
                                                             n, k, sizes, info["basins"], file, w, h))
            for r, angle_file, size in angles:
                f.write("<p>Angle %d</p><img src=\"%s\" width=%d height=%d>" % (r, angle_file, size[0], size[1]))
    print("wrote", os.path.join(args.out, "index.html"))


if __name__ == "__main__":
    main()
