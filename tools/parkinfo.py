"""Inspect OpenRCT2 .park files (OrcaStream container) without the game.

Usage: python3 tools/parkinfo.py <file.park | archive.zip> ...
Prints one JSON report per park; .park files inside a .zip are read in place. Parks saved by
OpenRCT2 v0.5.x are zstd-compressed; tools/unzstd.py reads them with the standard library alone.

Layout per OpenRCT2 src/openrct2/core/OrcaStream.hpp and park/ParkFile.cpp:
integers <=4 bytes are stored as 4 bytes, 64-bit as 8; strings are NUL-terminated;
arrays are prefixed by (count u32, elementSize u32) with elementSize 0 meaning variable.
"""
import gzip, io, json, os, re, struct, sys, zipfile
from collections import Counter

import nedesigns, unzstd

OBJ_TYPES = ["ride", "smallScenery", "largeScenery", "walls", "banners", "paths", "pathAdditions",
             "sceneryGroup", "parkEntrance", "water", "scenarioMeta", "terrainSurface", "terrainEdge",
             "station", "music", "footpathSurface", "footpathRailings", "audio", "peepNames",
             "peepAnimations", "climate"]
TILE_TYPES = ["surface", "path", "track", "smallScenery", "entrance", "wall", "largeScenery", "banner"]
ENTITY_TYPES = ["vehicle", "guest", "staff", "litter", "steamParticle", "moneyEffect", "crashedVehicleParticle",
                "explosionCloud", "crashSplash", "explosionFlare", "jumpingFountain", "balloon", "duck"]
CHUNK_NAMES = {1: "authoring", 2: "objects", 3: "scenario", 4: "general", 5: "climate", 6: "park",
               8: "research", 9: "notifications", 0x20: "interface", 0x30: "tiles", 0x31: "entities",
               0x32: "rides", 0x33: "banners", 0x36: "cheats", 0x37: "restrictedObjects",
               0x38: "pluginStorage", 0x39: "preview", 0x80: "packedObjects"}
SHIPPED_PREFIXES = ("rct1.", "rct1aa.", "rct1ll.", "rct1beta.", "rct2.", "rct2ww.", "rct2tt.", "openrct2.",
                    "official.", "toonies.")


class Reader:
    def __init__(self, data, pos=0):
        self.d, self.p = data, pos

    def raw(self, n):
        v = self.d[self.p:self.p + n]
        self.p += n
        return v

    def u32(self):
        return struct.unpack_from("<I", self.raw(4))[0]

    def i32(self):
        return struct.unpack_from("<i", self.raw(4))[0]

    def u64(self):
        return struct.unpack_from("<Q", self.raw(8))[0]

    def i64(self):
        return struct.unpack_from("<q", self.raw(8))[0]

    def str(self):
        end = self.d.index(b"\0", self.p)
        s = self.d[self.p:end].decode("utf-8", "replace")
        self.p = end + 1
        return s

    def array_header(self):
        return self.u32(), self.u32()

    def u8(self):
        return self.raw(1)[0]

    def u16(self):
        return struct.unpack_from("<H", self.raw(2))[0]

    def i16(self):
        return struct.unpack_from("<h", self.raw(2))[0]

    def skip_array(self, element):
        """An OrcaStream array (count, element size, elements): skips it, reading each element
        with `element(self)` only when the elements vary in size (size 0)."""
        count, size = self.array_header()
        if size:
            self.p += count * size
        else:
            for _ in range(count):
                element(self)


def load(data):
    f = data
    magic, target, minv, nchunks, usize, comp, csize = struct.unpack_from("<IIIIQIQ", f, 0)
    assert magic == 0x4B524150, "not a .park file"
    chunks = {}
    off = 64
    for _ in range(nchunks):
        cid, coff, clen = struct.unpack_from("<IQQ", f, off)
        chunks[cid] = (coff, clen)
        off += 20
    body = f[off:off + csize]
    if comp == 1:
        body = gzip.decompress(body)
    elif comp == 2:
        body = unzstd.decompress(body)
    return {"target": target, "min": minv, "fileSize": len(f), "uncompressed": usize}, chunks, body


def fnv1a(data):
    """OpenRCT2's park checksum (Crypt.OpenRCT2.cpp): 64-bit FNV-1a over little-endian 8-byte
    words, the last partial word zero-padded. Returns the 8 bytes as stored in the header."""
    mask = (1 << 64) - 1
    h = 0xCBF29CE484222325
    whole = len(data) // 8 * 8
    for (word,) in struct.iter_unpack("<Q", data[:whole]):
        h = ((h ^ word) * 0x100000001B3) & mask
    if whole < len(data):
        h = ((h ^ int.from_bytes(data[whole:], "little")) * 0x100000001B3) & mask
    return h.to_bytes(8, "little")


def save(data, replace):
    """A copy of the .park file `data` with chunks replaced ({chunk id: new bytes}), gzipped,
    with the chunk table and checksum rebuilt."""
    hdr, chunks, body = load(data)
    magic, target, minv, nchunks = struct.unpack_from("<IIII", data, 0)
    order = sorted(chunks, key=lambda c: chunks[c][0])
    parts, table, off = [], [], 0
    for cid in order:
        start, length = chunks[cid]
        part = replace.get(cid, body[start:start + length])
        table.append(struct.pack("<IQQ", cid, off, len(part)))
        parts.append(part)
        off += len(part)
    new_body = b"".join(parts)
    packed = gzip.compress(new_body, 6)
    header = struct.pack("<IIIIQIQ", magic, target, minv, len(order), len(new_body), 1, len(packed))
    header += fnv1a(new_body) + bytes(64 - len(header) - 8)
    return header + b"".join(table) + packed


def objects_spans(r):
    """Chunk 2 (objects) as [(type, identifier, start, end)] for each JSON object descriptor,
    with start/end the identifier string's byte span in the body (NUL excluded)."""
    out = []
    for _ in range(r.u32() & 0xFFFF):
        otype = r.u32()
        for _ in range(r.u32()):
            kind = r.u32()
            if kind == 1:
                r.raw(16)
            elif kind == 2:
                start = r.p
                ident = r.str()
                out.append((OBJ_TYPES[otype] if otype < len(OBJ_TYPES) else str(otype), ident, start, r.p - 1))
                r.str()
            elif kind != 0:
                raise ValueError("unknown descriptor kind %d" % kind)
    return out


def packed_spans(r):
    """Chunk 0x80 (packed objects) as [(identifier or None, entry start, entry end, data)] for
    each object; a .parkobj's data is its zip."""
    out = []
    for _ in range(r.u32()):
        start = r.p
        kind = r.u32()
        ident = None
        if kind == 0:
            r.raw(16)
        else:
            ident = r.str()
        size = r.u32()
        out.append((ident, start, r.p + size, r.raw(size)))
    return out


def parkobj_json(blob):
    """The object.json of a .parkobj (zip) as a dict."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        return json.loads(z.read("object.json").decode("utf-8-sig"))


def string_table(r):
    count, _ = r.array_header()
    table = [(r.str(), r.str()) for _ in range(count)]
    for lang, text in table:
        if lang == "en-GB":
            return text
    return table[0][1] if table else ""


def parse_objects(r):
    by_type = {}
    for _ in range(r.u32() & 0xFFFF):
        otype = r.u32()
        n = r.u32()
        entries = []
        for _ in range(n):
            kind = r.u32()
            if kind == 1:
                e = r.raw(16)
                entries.append(("dat", e[4:12].decode("latin-1").rstrip(), struct.unpack_from("<I", e)[0]))
            elif kind == 2:
                ident = r.str()
                ver = r.str()
                entries.append(("json", ident, ver))
            elif kind != 0:
                raise ValueError("unknown descriptor kind %d" % kind)
        by_type[OBJ_TYPES[otype] if otype < len(OBJ_TYPES) else str(otype)] = entries
    return by_type


def parse_packed(r):
    out = []
    for _ in range(r.u32()):
        kind = r.u32()
        if kind == 0:
            e = r.raw(16)
            size = r.u32()
            r.raw(size)
            out.append(("dat", e[4:12].decode("latin-1").rstrip(), size))
        else:
            ident = r.str()
            size = r.u32()
            r.raw(size)
            out.append(("parkobj", ident, size))
    return out


def parse_scenario(r, version):
    category = r.u32()
    return {"scenarioName": string_table(r), "parkName": string_table(r), "details": string_table(r)}


def parse_park(r, version):
    name = r.str()
    r.i64(); r.i64(); r.i64()   # cash, loan, max loan
    r.u32()                     # interest
    flags = r.u64()
    if version <= 18:
        r.i32()
    else:
        r.i64()                 # entrance fee
    r.u32(); r.u32(); r.u32()   # staff colours
    r.u64()                     # same price throughout park
    months, types = r.u32(), r.u32()
    r.raw(8 * months * types)
    r.i64()                     # historical profit
    count, size = r.array_header()
    for _ in range(count):      # marketing campaigns: type, weeksLeft, flags, rideId
        r.u32(); r.u32(); r.u32(); r.u32()
    if version <= 6:
        count, size = r.array_header()
        r.raw(count * 8)
    else:
        count, size = r.array_header()
        r.raw(count * 8)
    r.i64(); r.i64()            # value, company value
    park_size = r.u32()
    guests = r.u32()
    heading = r.u32()
    rating = r.u32()
    return {"name": name, "open": bool(flags & 1), "noMoney": bool(flags & (1 << 11)),
            "guestsInPark": guests, "guestsHeading": heading, "rating": rating, "ownedTiles": park_size}


def parse_tiles(r):
    w, h = r.u32(), r.u32()
    n = r.u32()
    raw = r.raw(n * 16)
    types = Counter()
    invisible = Counter()
    ghost = 0
    zero_clear = 0
    max_stack = 0
    stack_hist = Counter()
    max_z = 0
    ext = [10**9, 10**9, -1, -1]
    tile_idx = 0
    stack = 0
    non_surface = 0
    for i in range(n):
        t, fl, base, clear = raw[i * 16], raw[i * 16 + 1], raw[i * 16 + 2], raw[i * 16 + 3]
        et = (t & 0x3C) >> 2
        name = TILE_TYPES[et] if et < len(TILE_TYPES) else str(et)
        types[name] += 1
        stack += 1
        if fl & 0x20:
            invisible[name] += 1
        if fl & 0x10:
            ghost += 1
        if et != 0:
            non_surface += 1
            if clear <= base and et not in (5,):  # walls legitimately can be thin
                zero_clear += 1
            x, y = tile_idx % 1001, tile_idx // 1001  # elements are stored on the full technical grid
            ext[0], ext[1] = min(ext[0], x), min(ext[1], y)
            ext[2], ext[3] = max(ext[2], x), max(ext[3], y)
        max_z = max(max_z, clear)
        if fl & 0x80:
            max_stack = max(max_stack, stack)
            stack_hist[min(stack, 100) // 10 * 10] += 1
            stack = 0
            tile_idx += 1
    return {"mapSize": (w, h), "tileElements": n, "byType": dict(types), "invisible": dict(invisible),
            "ghost": ghost, "nonWallZeroClearance": zero_clear, "maxElementsOnOneTile": max_stack,
            "tilesByStackDepth": dict(sorted(stack_hist.items())), "maxClearanceZ": max_z,
            "contentBounds": ext, "tilesCounted": tile_idx}


def visible_element_counts(r):
    """Per-tile count of visible, non-ghost, non-surface elements as {(x, y): n}, each tile's
    surface base height (in 8-unit height steps) indexed by y * 1001 + x, and per tile the sum
    of those elements' base heights, their highest clearance height and each element's
    (base, clearance, type) as {(x, y): [sum, top, [(base, clearance, type), ...]]}, with type
    an index into TILE_TYPES."""
    w, h = r.u32(), r.u32()
    n = r.u32()
    raw = r.raw(n * 16)
    counts = Counter()
    heights = {}
    surface = bytearray(1001 * 1001)
    tile_idx = 0
    for i in range(n):
        t, fl = raw[i * 16], raw[i * 16 + 1]
        if t & 0x3C:
            if not fl & 0x30:
                tile = (tile_idx % 1001, tile_idx // 1001)
                counts[tile] += 1
                th = heights.setdefault(tile, [0, 0, []])
                th[0] += raw[i * 16 + 2]
                th[1] = max(th[1], raw[i * 16 + 3])
                th[2].append((raw[i * 16 + 2], raw[i * 16 + 3], (t & 0x3C) >> 2))
        elif tile_idx < len(surface):
            surface[tile_idx] = raw[i * 16 + 2]
        if fl & 0x80:
            tile_idx += 1
    return (w, h), counts, surface, heights


def water_heights(r):
    """Each tile's water level in height steps (0 where the tile holds no water), indexed by
    y * 1001 + x like visible_element_counts' surface."""
    r.u32(), r.u32()
    n = r.u32()
    raw = r.raw(n * 16)
    water = bytearray(1001 * 1001)
    tile_idx = 0
    for i in range(n):
        t, fl = raw[i * 16], raw[i * 16 + 1]
        if not t & 0x3C and tile_idx < len(water):
            water[tile_idx] = raw[i * 16 + 6] * 2
        if fl & 0x80:
            tile_idx += 1
    return water


def parse_interface(r):
    return {"viewX": r.i32(), "viewY": r.i32(), "zoom": r.i32(), "rotation": r.u32()}


def chunk_reader(chunks, body, cid):
    return Reader(body, chunks[cid][0]) if cid in chunks else None


PARK_MAGIC = b"PARK"
PARK_EXTENSIONS = (".park", ".sv6")  # a few parks saved by OpenRCT2 carry RCT2's extension
LEGACY_EXTENSIONS = (".sv6", ".sc6", ".sv4", ".sc4")
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp")
JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}


def is_junk(member):
    """Files archivers leave behind: macOS resource forks (__MACOSX/, ._*), Finder and
    Explorer metadata."""
    parts = member.replace("\\", "/").split("/")
    return "__MACOSX" in parts or parts[-1].startswith("._") or parts[-1].lower() in JUNK_NAMES


class Archive:
    """The files of a park download: a .zip, a folder it was unpacked to, or a single file.
    Each file is (name relative to the archive, size, modification time); read(name) gives its
    bytes. Junk (is_junk) is left out."""

    def __init__(self, path):
        self.path = path
        self.files = []
        if os.path.isdir(path):
            for root, dirs, names in os.walk(path):
                dirs.sort()
                for n in sorted(names):
                    full = os.path.join(root, n)
                    rel = os.path.relpath(full, path).replace("\\", "/")
                    if not is_junk(rel):
                        st = os.stat(full)
                        self.files.append((rel, st.st_size, st.st_mtime))
        elif path.lower().endswith(".zip"):
            import datetime
            with zipfile.ZipFile(path) as z:
                for info in z.infolist():
                    if not info.is_dir() and not is_junk(info.filename):
                        when = datetime.datetime(*info.date_time).timestamp()
                        self.files.append((info.filename, info.file_size, when))
        else:
            st = os.stat(path)
            self.files.append((os.path.basename(path), st.st_size, st.st_mtime))

    def read(self, name):
        if os.path.isdir(self.path):
            with open(os.path.join(self.path, name), "rb") as f:
                return f.read()
        if self.path.lower().endswith(".zip"):
            with zipfile.ZipFile(self.path) as z:
                return z.read(name)
        with open(self.path, "rb") as f:
            return f.read()

    def head(self, name, n=4):
        if self.path.lower().endswith(".zip") and not os.path.isdir(self.path):
            with zipfile.ZipFile(self.path) as z, z.open(name) as f:
                return f.read(n)
        with open(os.path.join(self.path, name) if os.path.isdir(self.path) else self.path, "rb") as f:
            return f.read(n)

    def parks(self):
        """OpenRCT2 parks in the archive, by content: .park files, and .sv6 files that are
        really .park files."""
        return [f for f in self.files if f[0].lower().endswith(PARK_EXTENSIONS) and self.head(f[0]) == PARK_MAGIC]

    def legacy(self):
        """RCT1/RCT2 saves and scenarios, which OpenRCT2 has to convert first."""
        return [f for f in self.files if f[0].lower().endswith(LEGACY_EXTENSIONS) and self.head(f[0]) != PARK_MAGIC]


def latest(files):
    """The file that wins when an archive has several versions of a park: the most recently
    saved, then the largest."""
    return max(files, key=lambda f: (f[2], f[1]))


def read_park_bytes(path, member=None):
    """Return (name, bytes) for a .park file, or for one park inside a .zip or folder (the
    member given, or else the latest; see latest())."""
    if os.path.isfile(path) and not path.lower().endswith(".zip"):
        with open(path, "rb") as f:
            return path.replace("\\", "/").split("/")[-1], f.read()
    archive = Archive(path)
    parks = archive.parks()
    if not parks:
        raise ValueError("%s contains no .park file" % path)
    if member is None:
        member = latest(parks)[0]
    elif member not in [p[0] for p in parks]:
        raise ValueError("%s has no member %r; available: %s" % (path, member, [p[0] for p in parks]))
    return member, archive.read(member)


# --- display names ---

FORMAT_CODE = re.compile(r"\{[A-Z0-9_]+(?::[^}]*)?\}")
SMALL_WORDS = {"a", "an", "and", "at", "by", "de", "del", "des", "du", "et", "for", "in", "la", "le", "no", "of",
               "on", "or", "sur", "the", "to", "versus", "vs", "von", "with"}


def clean_name(name):
    """A saved park name without OpenRCT2's formatting codes ({RED}, {BLACK}, ...)."""
    return re.sub(r"\s+", " ", FORMAT_CODE.sub("", name)).strip()


def is_placeholder(name):
    """Whether a saved park name is a working title rather than the park's name: blank or
    made of codes and symbols only, a "Workbench" save, or a blank map."""
    name = clean_name(name)
    return (not re.search(r"\w", name) or re.search(r"workbench", name, re.I) is not None
            or re.search(r"\bblank map\b", name, re.I) is not None)


def alnum(text):
    return re.sub(r"[\W_]+", "", text.lower())


def slug_parts(path, park_file=None):
    """A download's file name (New Element Designs style: date-game-authors-title, words joined
    by _ or -) as (authors, title), or (None, the name) when it doesn't follow that pattern.
    Where authors end and the title starts is ambiguous when titles use -, so the longest
    title that the park's own file name contains wins, else the last part."""
    stem = os.path.splitext(os.path.basename(path.rstrip("/\\")))[0]
    parts = re.split(r"(?<!_)-|-(?!_)", stem)  # "_-_" is a dash inside a title
    if len(parts) >= 3 and re.fullmatch(r"\d{6}", parts[0]) and re.fullmatch(r"o?rct\w*", parts[1]):
        split = len(parts) - 1
        if park_file:
            own = alnum(os.path.splitext(os.path.basename(park_file))[0])
            for k in range(3, len(parts)):
                words = parts[k:]
                while len(words) > 1 and words[-1].isdigit():
                    words = words[:-1]  # "-2": a second edition
                if alnum("".join(words)) in own:
                    split = k
                    break
        authors = [a.replace("_", " ").strip() for a in parts[2:split] if a.strip("_")]
        return authors, "-".join(parts[split:])
    while len(parts) > 1 and parts[-1].isdigit():
        parts.pop()  # "Fantasy-3-6294": a site's download ids
    return None, "-".join(parts)


def title_case(text):
    words = text.split(" ")
    out = []
    for i, w in enumerate(words):
        if re.fullmatch(r"[ivx]+('s)?", w) and len(w) <= 6 and w not in ("i", "vi", "xi", "x"):
            out.append(re.sub(r"[ivx]+", lambda m: m.group(0).upper(), w))  # Roman numerals
        elif i and w in SMALL_WORDS:
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def archive_title(path, park_file=None):
    """A park name from its download's file name: "hurricanes_-_rowling_versus_tolkien" gives
    "Hurricanes - Rowling versus Tolkien"; competition tags ("[nedc6]_") are dropped."""
    authors, title = slug_parts(path, park_file)
    if authors is None:
        return title.replace("_", " ").strip()
    title = re.sub(r"^(\[[^\]]*\d[^\]]*\]_*)+", "", title)
    title = re.sub(r"(?<! )-(?! )", " ", title.replace("_-_", " - ").replace("_", " "))
    title = re.sub(r"\s+", " ", title).strip(" -")
    return title_case(title)


def icon_title(names):
    """A park name from a logo or icon image in its download ("Farewell, For Worse Until
    Someday Logo.png"), or None."""
    for name in names:
        stem, ext = os.path.splitext(name.replace("\\", "/").split("/")[-1])
        stem = stem.replace("_", " ")
        if ext.lower() in IMAGE_EXTENSIONS and re.search(r"logo|icon", stem, re.I):
            title = re.sub(r"\b(logo|icon)s?\b", " ", stem, flags=re.I)
            title = re.sub(r"\s+", " ", title).strip(" -,")
            if re.search(r"[A-Za-z]{3}", title):
                return title
    return None


def fallback_name(path, park_file=None, names=None):
    """(name, where it came from) for a park whose saved name is a placeholder: the logo or
    icon in its download, else the download's file name."""
    if names is None:
        names = [f[0] for f in Archive(path).files] if os.path.exists(path) else []
    icon = icon_title(names)
    if icon:
        return icon, "icon"
    return archive_title(path, park_file), "archive name"


def download_authors(path, park_file=None, saved=None):
    """The park's builders: from the New Element Designs catalogue (largest share first) when the
    download matches a park there, else from the download's file name (lower case, as written)."""
    ne = nedesigns.match(path, saved)
    if ne:
        return ne["builders"]
    authors, _ = slug_parts(path, park_file)
    return [a for a in authors or [] if a != "collabo"]


def display_name(saved, path, park_file=None, names=None):
    """(name to show, where it came from) for a park saved as `saved`, from the download at path
    (park_file: the park's file in it): the New Element Designs catalogue's name when the download
    matches a park there (nedesigns.py), else the saved name unless it is a placeholder."""
    ne = nedesigns.match(path, saved)
    if ne:
        return ne["name"], "NE catalog"
    if not is_placeholder(saved):
        return clean_name(saved), "saved name"
    return fallback_name(path, park_file, names)


def parse_entities_vehicle_count(r):
    etype = r.u32()
    return ENTITY_TYPES[etype], r.u32()


def parse_vehicles(r):
    """Ride vehicles from the entities chunk as [(x, y, z, ride, velocity, orientation)], x and y
    in tiles, z in world height and the orientation 0-31 (0 faces -x, 8 +y, 16 +x, 24 -y, the
    car's facing even when running backwards: velocity < 0), or [] if the records can't be read. Vehicles come first in the chunk;
    every integer field is stored as 4 bytes but a few bools as 1, so the record length (fixed
    within a file) is found as the one at which every record starts with its index twice (the
    index, then the entity id) and the guest list follows."""
    etype, n = r.u32(), r.u32()
    if etype != 0 or n == 0:
        return []
    d, p = r.d, r.p
    for stride in range(64, 1024):
        end = p + n * stride
        if end + 4 > len(d) or struct.unpack_from("<I", d, end)[0] != 1:
            continue
        if all(struct.unpack_from("<I", d, p + k * stride)[0] == struct.unpack_from("<I", d, p + k * stride + 4)[0]
               for k in range(n)):
            break
    else:
        return []
    out = []
    for k in range(n):
        # index, id, heightMin, x, y, z, width, heightMax, orientation, subType, pitch, roll,
        # remaining distance, velocity, acceleration, ride
        f = struct.unpack_from("<16i", d, p + k * stride)
        out.append((f[3] // 32, f[4] // 32, f[5], f[15], f[13], f[8]))
    return out


RIDE_TYPE_NAMES = [  # OpenRCT2 ride types (Ride.h, v0.5.6), by index
    "Spiral Roller Coaster", "Stand-up Roller Coaster", "Suspended Swinging Coaster",
    "Inverted Roller Coaster", "Junior Roller Coaster", "Miniature Railway", "Monorail",
    "Mini Suspended Coaster", "Boat Hire", "Wooden Wild Mouse", "Steeplechase", "Car Ride",
    "Launched Freefall", "Bobsleigh Coaster", "Observation Tower", "Looping Roller Coaster", "Dinghy Slide",
    "Mine Train Coaster", "Chairlift", "Corkscrew Roller Coaster", "Maze", "Spiral Slide", "Go-Karts",
    "Log Flume", "River Rapids", "Dodgems", "Swinging Ship", "Swinging Inverter Ship", "Food Stall", "1D",
    "Drink Stall", "1F", "Shop", "Merry-Go-Round", "22", "Information Kiosk", "Toilets", "Ferris Wheel",
    "Motion Simulator", "3D Cinema", "Top Spin", "Space Rings", "Reverse Freefall Coaster", "Lift",
    "Vertical Drop Roller Coaster", "Cash Machine", "Twist", "Haunted House", "First Aid", "Circus",
    "Ghost Train", "Twister Roller Coaster", "Wooden Roller Coaster", "Side-Friction Roller Coaster",
    "Steel Wild Mouse", "Multi-Dimension Roller Coaster", "Multi-Dimension Roller Coaster (alt)",
    "Flying Roller Coaster", "Flying Roller Coaster (alt)", "Virginia Reel", "Splash Boats",
    "Mini Helicopters", "Lay-down Roller Coaster", "Suspended Monorail", "Lay-down Roller Coaster (alt)",
    "Reverser Roller Coaster", "Heartline Twister Coaster", "Mini Golf", "Giga Coaster", "Roto-Drop",
    "Flying Saucers", "Crooked House", "Monorail Cycles", "Compact Inverted Coaster", "Water Coaster",
    "Air Powered Vertical Coaster", "Inverted Hairpin Coaster", "Magic Carpet", "Submarine Ride",
    "River Rafts", "50", "Enterprise", "52", "53", "54", "55", "Inverted Impulse Coaster",
    "Mini Roller Coaster", "Mine Ride", "59", "LIM Launched Roller Coaster", "Hypercoaster", "Hyper-Twister",
    "Monster Trucks", "Spinning Wild Mouse", "Classic Mini Roller Coaster", "Hybrid Coaster",
    "Single Rail Roller Coaster", "Alpine Coaster", "Classic Wooden Roller Coaster",
    "Classic Stand-up Roller Coaster", "LSM Launched Roller Coaster", "Classic Wooden Twister Roller Coaster",
]
RIDE_STATUS = ["closed", "open", "testing", "simulating"]
RIDE_FLAGS = ["onTrack", "tested", "testInProgress", "noRawStats", "passStationNoStopping", "onRidePhoto",
              "breakdownPending", "brokenDown", "dueInspection", "queueFull", "crashed", "hasStalledVehicle",
              "everBeenOpened", "music", "indestructible", "indestructibleTrack", "cableLiftHillComponentUsed",
              "cableLift", "notCustomDesign", "sixFlagsDeprecated", "fixedRatings", "randomShopColours", "reversedTrains"]


def ride_type_name(t):
    return RIDE_TYPE_NAMES[t] if 0 <= t < len(RIDE_TYPE_NAMES) else "type %d" % t


def parse_rides(r, version):
    """The rides chunk (OpenRCT2 ParkFile.cpp ReadWriteRidesChunk, v0.5.6), as {ride index: {type,
    status, mode, name, trains, ...}}: what tells a working ride from a prop. OrcaStream stores
    every integer up to 32 bits as 4 bytes and 64-bit ones as 8, strings null-terminated and
    arrays as (count, element size, elements), so each record is read field by field."""
    out = {}
    count, size = r.array_header()
    for _ in range(count):
        start = r.p
        ride = {}
        rid = r.u32()
        ride["type"] = r.u32()
        ride["subtype"] = r.u32()
        ride["mode"] = r.u32()
        ride["status"] = r.u32()
        r.u32()  # departFlags
        ride["flags"] = r.u32()
        ride["customName"] = r.str()
        ride["nameNumber"] = r.u32()
        r.skip_array(lambda q: q.raw(4 if version <= 18 else 8))  # prices
        r.u32(); r.u32()  # entrance style, vehicle colour settings
        r.skip_array(lambda q: q.raw(12))  # track colours
        r.skip_array(lambda q: q.raw(12))  # vehicle colours
        ride["stations"] = r.u32()
        segment = []

        def station(q):
            q.raw(24)  # start x, y; height, length, depart, train at station
            q.raw(16); q.raw(16)  # entrance, exit: x, y, z, direction
            segment.append(q.i32())
            q.raw(16)  # segment time, queue time, queue length, last peep in queue
        scount, ssize = r.array_header()
        for _ in range(scount):
            at = r.p
            station(r)
            if ssize:
                r.p = at + ssize
        ride["segmentLength"] = sum(segment)
        ride["overallView"] = (r.i32() // 32, r.i32() // 32)
        ride["trains"] = r.u32()
        ride["cars"] = r.u32()
        r.raw(12)  # proposed trains, proposed cars, max trains
        r.raw(4 if version < 5 else 8)  # min/max cars per train
        r.raw(8)  # waiting times
        r.skip_array(lambda q: q.raw(4))  # vehicles
        r.raw(12)  # operation option, lift hill speed, circuits
        r.raw(12)  # boat hire return direction and position
        r.raw(28)  # chairlift bullwheels (2 x 3) and rotation
        r.raw(16)  # slide in use, slide peep, t-shirt colour, slide progress
        r.raw(8); r.raw(12)  # race winner, cable lift, its location
        if r.u32():  # measurement
            r.raw(8)  # flags, last use tick
            items = r.u32()
            r.raw(12)  # current item, vehicle index, station
            r.raw(items * 16)
        r.raw(4 if version < 55 else 8)  # helices (+ special elements)
        ride["maxSpeed"] = r.i32()
        ride["averageSpeed"] = r.i32()
        r.raw(8)  # test segment, timeout
        r.raw(20)  # five g-forces
        r.raw(4); r.raw(12)  # testing flags, test track location
        r.raw(12)  # turn counts
        r.raw(8 if version < 55 else 12)  # inversions (+ combined drops) or inversions, drops, powered lifts
        r.raw(20)  # drop heights, sheltered length, var11C, sheltered sections
        if version >= 6:
            r.raw(8)  # sheltered eighths, holes
        r.raw(12)  # test station, block brakes, air time
        ride["excitement"] = r.i32() / 100
        r.raw(8)  # intensity, nausea
        r.raw(4 if version <= 18 else 8)  # value
        r.u32()  # riders
        ride["buildDate"] = r.i32()
        r.raw(4 if version <= 18 else 8)  # upkeep
        ride["customers"] = r.u32()
        r.u32()
        r.skip_array(lambda q: q.raw(4))  # customer history
        ride["totalCustomers"] = r.u32()
        r.raw(8 + 12 + 4 + 8 + 16)  # total profit, popularity x3, guests' favourite, items sold, income, profit
        r.raw(12)  # satisfaction
        r.raw(28)  # breakdown pending ... breakdown reason
        r.raw(24)  # reliability ... last inspection
        r.skip_array(lambda q: q.raw(4))  # downtime history
        r.raw(16 + 4 + 4 + 4)  # sound modifier ... throttle, vehicle change timeout, issues, issue time
        r.raw(12)  # music
        if size:
            r.p = start + size
        ride["name"] = ride["customName"] or "%s %d" % (ride_type_name(ride["type"]), ride["nameNumber"])
        out[rid] = ride
    return out


def track_rides(r, invisible=False):
    """The ride of every visible track element (or every one, with `invisible`), as
    {(x, y, base height): ride index}."""
    r.u32(), r.u32()
    n = r.u32()
    raw = r.raw(n * 16)
    rides = {}
    tile_idx = 0
    for i in range(n):
        t, fl = raw[i * 16], raw[i * 16 + 1]
        if (t & 0x3C) >> 2 == 2 and (invisible or not fl & 0x30):
            rides[(tile_idx % 1001, tile_idx // 1001, raw[i * 16 + 2])] = struct.unpack_from("<H", raw, i * 16 + 12)[0]
        if fl & 0x80:
            tile_idx += 1
    return rides


def track_pieces(r):
    """Every visible track element as {(x, y, base height): (ride index, direction)}: the
    direction (0-3) a piece was built in, which is the way its ride's trains normally run
    (direction 0 is -x, 1 +y, 2 +x, 3 -y)."""
    r.u32(), r.u32()
    n = r.u32()
    raw = r.raw(n * 16)
    pieces = {}
    tile_idx = 0
    for i in range(n):
        t, fl = raw[i * 16], raw[i * 16 + 1]
        if (t & 0x3C) >> 2 == 2 and not fl & 0x30:
            pieces[(tile_idx % 1001, tile_idx // 1001, raw[i * 16 + 2])] = (struct.unpack_from("<H", raw, i * 16 + 12)[0], t & 3)
        if fl & 0x80:
            tile_idx += 1
    return pieces


def large_scenery_pieces(r):
    """The object and piece of every visible large scenery element, as {(x, y, base height):
    (object entry index, piece index)}; a large scenery object puts one piece on each tile it covers."""
    r.u32(), r.u32()
    n = r.u32()
    raw = r.raw(n * 16)
    pieces = {}
    tile_idx = 0
    for i in range(n):
        t, fl = raw[i * 16], raw[i * 16 + 1]
        if (t & 0x3C) >> 2 == 6 and not fl & 0x30:
            pieces[(tile_idx % 1001, tile_idx // 1001, raw[i * 16 + 2])] = (
                struct.unpack_from("<H", raw, i * 16 + 5)[0], raw[i * 16 + 9])
        if fl & 0x80:
            tile_idx += 1
    return pieces


def parse_preview(r):
    return {"parkName": r.str(), "rating": r.u32(), "year": r.u32(), "month": r.u32(), "day": r.u32(),
            "usesMoney": r.u32(), "cash": r.i64(), "rides": r.u32(), "guests": r.u32()}


def report(name, data):
    hdr, chunks, body = load(data)
    v = hdr["target"]
    out = {"file": name, "header": hdr,
           "chunks": {CHUNK_NAMES.get(k, hex(k)): v_[1] for k, v_ in sorted(chunks.items())}}

    def reader(cid):
        return Reader(body, chunks[cid][0]) if cid in chunks else None

    if (r := reader(3)):
        out["scenario"] = parse_scenario(r, v)
    if (r := reader(6)):
        try:
            out["park"] = parse_park(r, v)
        except Exception as e:
            out["park"] = "parse error: %s" % e
    if (r := reader(0x39)):
        out["preview"] = parse_preview(r)
    if (r := reader(0x32)):
        out["rides"] = r.array_header()[0]
    if (r := reader(0x31)):
        out["firstEntityGroup"] = parse_entities_vehicle_count(r)
    if (r := reader(2)):
        objs = parse_objects(r)
        packed = parse_packed(reader(0x80)) if 0x80 in chunks else []
        packed_names = {p[1] for p in packed}
        summary = {}
        unshipped_unpacked = []
        for t, entries in objs.items():
            if not entries:
                continue
            dat = [e for e in entries if e[0] == "dat"]
            js = [e for e in entries if e[0] == "json"]
            summary[t] = {"dat": len(dat), "json": len(js)}
            for e in js:
                if not e[1].startswith(SHIPPED_PREFIXES) and e[1] not in packed_names:
                    unshipped_unpacked.append(e[1])
        out["objects"] = summary
        out["objectsTotal"] = sum(len(e) for e in objs.values())
        out["packedObjects"] = {"count": len(packed), "dat": sum(p[0] == "dat" for p in packed),
                                "parkobj": sum(p[0] == "parkobj" for p in packed),
                                "bytes": sum(p[2] for p in packed)}
        out["datObjectsTotal"] = sum(s["dat"] for s in summary.values())
        out["jsonNotShippedNotPacked"] = unshipped_unpacked
        out["musicObjects"] = [e[1] for e in objs.get("music", [])]
        out["audioObjects"] = [e[1] for e in objs.get("audio", [])]
        out["packedSample"] = [p[1] for p in packed[:8]]
    if (r := reader(0x38)):
        s = r.str()
        try:
            parsed = json.loads(s)
            out["pluginStorage"] = {k: (len(json.dumps(v_))) for k, v_ in parsed.items()}
        except Exception:
            out["pluginStorage"] = "unparsed (%d bytes)" % len(s)
    if (r := reader(0x30)):
        out["tiles"] = parse_tiles(r)
    print(json.dumps(out, indent=1, default=str))


def main(paths):
    for path in paths:
        if os.path.isfile(path) and not path.lower().endswith(".zip"):
            with open(path, "rb") as f:
                report(path.replace("\\", "/").split("/")[-1], f.read())
        else:
            archive = Archive(path)
            for member, _, _ in archive.parks():
                report(member, archive.read(member))


if __name__ == "__main__":
    main(sys.argv[1:])
