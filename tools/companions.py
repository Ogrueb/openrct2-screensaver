"""Companion plugins: the plugins some parks ship in their zip, run on the title screen.

Each companion becomes its own intransient plugin file: the host (plugin/dist/companion-host.js)
followed by the companion's code wrapped in a function, which the host starts after each load of
one of its parks and stops before the next. See docs/companion-plugins.md.

Playlist keys, per [[park]]:
  companions = "auto"       every .js file in the park's zip (default; a park given as a plain
                            .park file has none unless listed)
  companions = []           none
  companions = ["a.js"]     these files: members of the park's zip, or paths relative to the playlist
                            With "auto", a park also gets the newest version of any companion
                            another park in the playlist ships, if it holds that companion's data.
  companion_camera = true   let the companions move the camera (default false: the screensaver's)
  animations = true         add a view on each of the companions' animations (flagged `animation`)
  animation_views = 4       at most this many of them
  show = "eclipse"          end the park's visit with one of its companions' shows (defined in parks/*.toml)
A view in the park's own `view` list can be flagged too: animation = "<name>", or show = "<name>".
Top level:
  companion_debug = true    log every ignored window, menu item and camera move to the console
"""
import collections, hashlib, json, os, re, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import profiles  # noqa: E402

HOST_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin", "dist",
                         "companion-host.js")
# Plugins a download ships that change nothing on screen (editors, multiplayer tools): never run
# as companions when found automatically (EvenMoreParks sweep, 2026-10-31: Yatagarasu ships Peep
# Editor). A playlist's `companions = [...]` list still runs whatever it names.
UTILITY_PLUGINS = {"Peep Editor"}
FILE_PREFIX = "rct-screensaver-companion-"  # installed plugin files; the install replaces them all


def is_junk(member):
    """macOS resource forks (__MACOSX/, ._*) that archivers leave in zips."""
    return "__MACOSX/" in member or member.split("/")[-1].startswith("._")


def find(entry, base_dir, member):
    """[(label, code)] for a park entry's companions."""
    path = os.path.join(base_dir, entry["file"])
    wanted = entry.get("companions", "auto")
    is_zip = path.lower().endswith(".zip")
    if wanted == "auto":
        if not is_zip:
            return []
        with zipfile.ZipFile(path) as z:
            found = [(m.split("/")[-1], z.read(m).decode("utf-8-sig"))
                     for m in sorted(z.namelist()) if m.lower().endswith(".js") and not is_junk(m)]
        return [(label, code) for label, code in found if not is_utility(code, label)]
    if not isinstance(wanted, list):
        raise ValueError("%s: companions must be \"auto\" or a list of files" % entry["file"])
    found = []
    for name in wanted:
        local = os.path.join(base_dir, name)
        if os.path.isfile(local):
            with open(local, encoding="utf-8-sig") as f:
                found.append((os.path.basename(name), f.read()))
        elif is_zip:
            with zipfile.ZipFile(path) as z:
                members = [m for m in z.namelist() if m == name or m.split("/")[-1] == name]
                if not members:
                    raise ValueError("%s: companion %r is neither a file nor in the zip" % (entry["file"], name))
                found.append((members[0].split("/")[-1], z.read(members[0]).decode("utf-8-sig")))
        else:
            raise ValueError("%s: companion file %r not found" % (entry["file"], name))
    return found


def is_utility(code, label):
    """Whether a bundled script is one of UTILITY_PLUGINS (by its registerPlugin name)."""
    try:
        return metadata(code, label)["name"] in UTILITY_PLUGINS
    except ValueError:
        return False


def metadata(code, label):
    """Name, version and target API version from the companion's registerPlugin call (or the
    object it passes, when that is a variable)."""
    at = code.find("registerPlugin(")
    if at < 0:
        raise ValueError("companion %s has no registerPlugin call" % label)
    head = code[at:at + 2000]
    passed = re.match(r"registerPlugin\(\s*([A-Za-z_$][\w$]*)\s*\)", head)
    if passed:
        defined = re.search(r"\b%s\s*=\s*\{" % re.escape(passed.group(1)), code)
        if defined:
            head = code[defined.start():defined.start() + 2000]

    def field(key, pattern):
        m = re.search(r"\b%s\s*:\s*%s" % (key, pattern), head)
        return m.group(1) if m else None

    string = r"[\"']([^\"']*)[\"']"
    name = field("name", string)
    if not name:
        raise ValueError("companion %s: can't read its name from registerPlugin" % label)
    version = field("version", string)
    if version is None:
        ident = field("version", r"([A-Za-z_$][\w$]*)")  # a constant defined elsewhere
        m = ident and re.search(r"\b%s\s*=\s*%s" % (re.escape(ident), string), code)
        version = m.group(1) if m else ""
    target = field("targetApiVersion", r"(\d+)")
    return {"name": name, "version": version, "type": field("type", string),
            "targetApiVersion": int(target) if target else None}


def version_key(version):
    """Sort key for version strings: numeric parts compare as numbers ("1.3.10" > "1.3.6")."""
    return [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.split(r"[.\-+ ]", version)]


# Park storage keys a companion's data lives under, where its code doesn't name them literally.
STORAGE_KEYS = {
    "AdvancedTrack": ["Oli414.AdvancedTrack"],
    "AnimationService Spacek": ["AnimationService"],
}


def storage_keys(code, name):
    keys = set(STORAGE_KEYS.get(name, []))
    keys.update(re.findall(r"getParkStorage\(\s*[\"']([^\"']+)[\"']\s*\)", code))
    if re.search(r"getParkStorage\(\s*\)", code):
        keys.add(name)  # the default: the plugin's own name
    return keys


def has_data(value):
    """True if a storage value holds anything beyond empty objects and lists."""
    if isinstance(value, dict):
        return any(has_data(v) for v in value.values())
    if isinstance(value, list):
        return any(has_data(v) for v in value)
    return value is not None


def advancedtrack_live(ride, feature, track):
    """An AdvancedTrack feature is live only if its ride has track on one of its tiles: many
    parks carry stale features copied from another park, or left behind by a deleted ride
    (Valley of the Kings, Murder in McAllan, Constellations)."""
    f = feature
    tiles = [(f.get("startX"), f.get("startY"))] + [(t.get("x"), t.get("y")) for t in f.get("affectedTiles") or []]
    tiles += [((f.get(k) or {}).get("x"), (f.get(k) or {}).get("y")) for k in ("trigger", "action")]
    return any((x, y, ride) in track for x, y in tiles)


def advancedtrack_has_live(data, track):
    return any(advancedtrack_live(ride.get("rideId"), f, track)
               for ride in (data.get("ParkData") or {}).get("rides") or [] for f in ride.get("features") or [])


# Checks that a companion's data matches the park: track = {(x, y, ride)} of every track element.
LIVE_DATA = {"AdvancedTrack": advancedtrack_has_live}


def library(entries, base_dir):
    """The newest version of each companion shipped by any park in the playlist:
    {name: (label, code, meta)}. Parks that carry a companion's data without shipping its code
    (their authors expected it installed) get it from here."""
    best = {}
    for entry in entries:
        if entry.get("companions", "auto") != "auto":
            continue
        for label, code in find(entry, base_dir, entry.get("member")):
            meta = metadata(code, label)
            known = best.get(meta["name"])
            if known is None or version_key(meta["version"]) > version_key(known[2]["version"]):
                best[meta["name"]] = (label, code, meta)
    return best


def complete(found, lib, storage, track, entry):
    """A park's companions with the library applied: each at the newest version in the playlist,
    plus any library companion whose data the park holds (unless the park lists its own)."""
    out, names = [], set()
    for label, code in found:
        name = metadata(code, label)["name"]
        newest = (lib or {}).get(name)
        out.append((newest[0], newest[1]) if newest else (label, code))
        names.add(name)
    if entry.get("companions", "auto") == "auto":
        for name, (label, code, meta) in sorted((lib or {}).items()):
            if name in names:
                continue
            data = [storage[k] for k in storage_keys(code, name) if k in storage]
            live = LIVE_DATA.get(name)
            if any(has_data(d) and (live is None or live(d, track)) for d in data):
                out.append((label, code))
    return out


# What a companion's code animates where its data doesn't say (SPOTS, by companion and park), and
# the companions' shows (SHOWS): park data, kept in the parks' profiles (parks/*.toml, see
# tools/profiles.py). Shows are started by pressing buttons in the companion's (hidden) window.
# Steps: press a button once visible and enabled, wait until a widget is visible and enabled,
# wait seconds, or wait until the companion has run a number of game ticks since its park loaded;
# the show ends after the last step. The view is where the show itself puts the camera, or a spot
# placed like an animation view; hold is the most it may take (at 1x speed).
SPOTS, SHOWS = profiles.definitions(profiles.load())


def show_action(name):
    """Custom game action a companion's plugin registers to start its shows."""
    return "rctscreensaver-show-" + slug(name)


def animator_spots(storage, track=None):
    """Spots from Animator's own data in park storage: the tiles its triggers watch and the
    tile boxes its actions change."""
    lists = []

    def walk(value):
        if isinstance(value, list) and value and all(isinstance(a, dict) and "frames" in a for a in value):
            lists.append(value)
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
    walk(storage)
    spots = []
    for animations in lists:
        for a in animations:
            tiles = set()
            trigger = a.get("trigger") or {}
            tile = trigger.get("tile")
            if isinstance(tile, dict) and "x" in tile:
                tiles.add((int(tile["x"]), int(tile["y"])))
            for frame in a.get("frames") or []:
                for action in frame.get("actions") or []:
                    box = action.get("tiles")
                    if isinstance(box, dict) and "from" in box and "to" in box:
                        x0, x1 = sorted((int(box["from"]["x"]), int(box["to"]["x"])))
                        y0, y1 = sorted((int(box["from"]["y"]), int(box["to"]["y"])))
                        tiles.update((x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1))
            if tiles:
                spot = {"name": a.get("name") or a.get("id") or "animation", "tiles": sorted(tiles)}
                if "rideId" in trigger:
                    spot["ride"] = int(trigger["rideId"])  # its height is the ride's track
                interval, length = int(a.get("intervalTicks") or 1), a.get("length")
                if trigger.get("type") == "rideEnters" and "rideId" in trigger and isinstance(tile, dict) \
                        and isinstance(length, int) and length >= 0:
                    # A train's head car on the trigger tile starts a run of `length` steps, one
                    # every intervalTicks on the global tick count (so up to one interval late);
                    # its train-level actions recolour that train, so the camera follows it.
                    x, y = int(tile["x"]), int(tile["y"])
                    spot["cue"] = {"ride": spot["ride"], "tiles": [x, y, x, y],
                                   "ticks": (length + 1) * interval, "follow": spot["ride"]}
                spots.append(spot)
    return spots


ADVANCEDTRACK_LOCK = 50  # ticks a train stays locked on a lift before it travels


def advancedtrack_spots(data, track):
    """AdvancedTrack's lifts: track pieces that carry a train up or down (drop towers, vertical
    lifts), at the middle of their travel."""
    spots = []
    for ride in (data.get("ParkData") or {}).get("rides") or []:
        for f in ride.get("features") or []:
            tiles = [(t["x"], t["y"]) for t in f.get("affectedTiles") or [] if t.get("x", -1) >= 0]
            if f.get("type") == 1 and tiles and advancedtrack_live(ride["rideId"], f, track):
                # A train on the lift's start tile locks for 50 ticks, then travels
                # |endZ - startZ| * 100 / speed ticks (AdvancedTrack 1.3.6, constants in its code).
                travel = abs(f.get("endZ", 0) - f.get("startZ", 0)) * 100 // max(1, f.get("speed") or 100)
                x, y = f.get("startX"), f.get("startY")
                spot = {"name": "lift (ride %d)" % ride["rideId"], "tiles": sorted(set(tiles)),
                        "z": (f.get("startZ", 0) + f.get("endZ", 0)) // 2, "ride": ride["rideId"]}
                if isinstance(x, int) and isinstance(y, int):
                    spot["cue"] = {"ride": ride["rideId"], "tiles": [x, y, x, y], "ticks": ADVANCEDTRACK_LOCK + travel}
                # Off unless a profile turns it on: lifts run inside towers and buildings (Tower of
                # Terror, Pixar) or not at all (Expo Miami's is on a flat ride, which AdvancedTrack
                # skips), so their views showed nothing (owner's live review, 2026-10-30).
                spot["off"] = True
                spots.append(spot)
    return spots


def animationservice_ticks(animation):
    """Game ticks an AnimationService animation runs: its frames (by `index`, or `maxIndex`)
    every tickInterval, numLoops + 1 times; None when it loops forever."""
    loops = animation.get("numLoops", 0)
    if not isinstance(loops, int) or loops < 0:
        return None
    last = max((max(f.get("index", 0) or 0, f.get("maxIndex", 0) or 0) for f in animation.get("animationFrames") or []), default=0)
    return (last + 1) * int(animation.get("tickInterval") or 1) * (loops + 1)


def animationservice_spots(data, track=None):
    """AnimationService's triggers: the boxes its position sensors watch (world coordinates)."""
    spots = []
    animations = {a.get("name"): a for a in data.get("animations") or [] if isinstance(a, dict)}
    for trigger in data.get("triggers") or []:
        durations = [animationservice_ticks(animations[n]) for n in trigger.get("targetAnimations") or [] if n in animations]
        for sensor in trigger.get("sensors") or []:
            lo, hi = sensor.get("minPosition"), sensor.get("maxPosition")
            if not (isinstance(lo, dict) and isinstance(hi, dict) and "x" in lo and "x" in hi):
                continue
            tiles = [(x, y) for x in range(lo["x"] // 32, hi["x"] // 32 + 1)
                     for y in range(lo["y"] // 32, hi["y"] // 32 + 1)]
            spot = {"name": trigger.get("name") or "trigger", "tiles": tiles}
            if "z" in lo and "z" in hi:
                spot["z"] = (lo["z"] + hi["z"]) // 2
            if isinstance(sensor.get("rideId"), int) and sensor["rideId"] != 65535:
                spot["ride"] = sensor["rideId"]
            # A car in the box (one of `entities`, else a train's head car of the ride) sets the
            # trigger off; it runs its animations, the longest deciding the effect's length. A
            # trigger enabled by another in a chain is cued the same way, enabled or not.
            ticks = [d for d in durations if d is not None]
            if ticks and len(ticks) == len(durations):
                cue = {"tiles": [tiles[0][0], tiles[0][1], tiles[-1][0], tiles[-1][1]], "ticks": max(ticks)}
                cars = [c for c in sensor.get("entities") or [] if isinstance(c, int)]
                if cars:
                    cue["cars"] = cars
                elif "ride" in spot:
                    cue["ride"] = spot["ride"]
                if "cars" in cue or "ride" in cue:
                    spot["cue"] = cue
            spots.append(spot)
    return spots


def levis_delay(frame):
    """A RCTAnimator frame's Delay in game ticks (saved as a string)."""
    try:
        return max(0, int(frame.get("Delay") or 0))
    except (TypeError, ValueError):
        return 0


def levis_spots(data, track=None):
    """RCTAnimator (Levis.Animations): the tiles its frames change, and where a car triggers it."""
    spots = []
    for a in ((data.get("animations") or {}).get("Animations") or []):
        if a.get("Active") is False:
            continue
        tiles, heights = set(), []
        for frame in a.get("Frames") or []:
            for e in frame.get("Elements") or []:
                tiles.add((int(e["TileX"]), int(e["TileY"])))
                if isinstance(e.get("ElementHeight"), int):
                    heights.append(e["ElementHeight"] * 8)
        spot = {"name": a.get("Name") or "animation"}
        frames = a.get("Frames") or []
        for t in a.get("Triggers") or []:
            if t.get("Type") == "carOnTrack":
                x, y = int(t["CarOnTrackX"]) // 32, int(t["CarOnTrackY"]) // 32
                tiles.add((x, y))
                heights.append(int(t["CarOnTrackZ"]))
                spot["ride"] = int(t["CarOnTrackRide"])
                # A car of the ride on the trigger tile plays FramesToPlay frames, each followed by
                # its Delay in ticks; frames that move or recolour another ride's cars are followed.
                count = int(t.get("FramesToPlay") or len(frames)) or len(frames)
                ticks = sum(levis_delay(f) for f in (frames * 2)[:count])
                if ticks > 0:
                    cue = {"ride": spot["ride"], "tiles": [x, y, x, y], "ticks": ticks}
                    cars = [c for f in frames for c in f.get("Cars") or [] if isinstance(c.get("CarRide"), int)]
                    if cars:
                        ride = collections.Counter(c["CarRide"] for c in cars).most_common(1)[0][0]
                        cue["follow"] = ride
                        trains = [c.get("CarTrain") for c in cars if c["CarRide"] == ride]
                        if ride != spot["ride"] and isinstance(trains[0], int) and trains[0] > 0:
                            cue["train"] = trains[0]
                    spot["cue"] = cue
        if tiles:
            heights.sort()
            spot.update(tiles=sorted(tiles), z=heights[len(heights) // 2] if heights else None)
            spots.append(spot)
    return spots


# Spot extractors for companions whose data in park storage says where they animate: companion
# name -> (storage key, extractor).
SPOT_DATA = {
    "Animator": ("Animator", animator_spots),
    "AdvancedTrack": ("Oli414.AdvancedTrack", advancedtrack_spots),
    "AnimationService Spacek": ("AnimationService", animationservice_spots),
    "RCTAnimator Runtime": ("Levis.Animations", levis_spots),
}


def merge_spots(spots, distance=8):
    """Spots whose centres are within `distance` tiles become one (two triggers of one ride, or
    several animations on one tile box). Each keeps a count of the spots merged into it and their
    indices (`members`)."""
    merged = []
    for n, spot in enumerate(spots):
        cx, cy = centre(spot["tiles"])
        for m in merged:
            mx, my = centre(m["tiles"])
            if abs(mx - cx) <= distance and abs(my - cy) <= distance:
                m["tiles"] = sorted(set(m["tiles"]) | set(spot["tiles"]))
                if spot["name"] not in m["name"].split(" / "):
                    m["name"] += " / " + spot["name"]
                for key in ("ride", "z", "cue", "hold", "zoom", "rotation"):
                    if m.get(key) is None:
                        m[key] = spot.get(key)
                m["count"] += 1
                m["members"].append(n)
                break
        else:
            merged.append(dict(spot, tiles=list(spot["tiles"]), count=1, members=[n]))
    return merged


def centre(tiles):
    return sum(t[0] for t in tiles) / len(tiles), sum(t[1] for t in tiles) / len(tiles)


def animation_spots(found, storage, park_name, track, limit=None, overrides=None, report=None):
    """Spots for a park's companions: [{name, tiles, z?, ride?, cue?, hold?}], at most `limit`
    (the ones where most animations meet), in the order found. `overrides` ({animation name:
    {off, hold, z, zoom, rotation, cue}}, a profile's [animation."<name>"]) change single animations before they
    merge: `off` drops one, `cue = false` gives it a fixed hold, a `cue` table changes its cue
    (follow = false: no following). `report`, a list, gets one entry per animation found."""
    overrides = overrides or {}
    spots, entries = [], []
    for label, code in found:
        name = metadata(code, label)["name"]
        extracted = []
        if name in SPOT_DATA:
            key, extract = SPOT_DATA[name]
            extracted += extract(storage.get(key) or {}, track)
        extracted += [dict(s) for s in SPOTS.get((name, park_name), [])]
        for spot in extracted:
            entry = {"companion": name, "name": spot["name"], "box": box(spot["tiles"]),
                     "z": spot.get("z"), "ride": spot.get("ride"), "cue": spot.get("cue")}
            entries.append(entry)
            change = overrides.get(spot["name"], {})
            if change.get("off", spot.pop("off", False)):
                entry["status"] = "off" if change.get("off") else "off by default"
                continue
            if "hold" in change:
                spot["hold"] = float(change["hold"])
            for key in ("z", "zoom", "rotation"):
                if key in change:
                    spot[key] = int(change[key])
            if change.get("cue") is False:
                spot.pop("cue", None)
            elif isinstance(change.get("cue"), dict):
                cue = dict(spot.get("cue") or {}, **change["cue"])
                if cue.get("follow") is False:
                    cue.pop("follow")
                spot["cue"] = cue
            if change:
                entry["changed"] = {k: v for k, v in change.items()}
            entry["used"] = spot.get("cue")
            spots.append(spot)
            entry["spot"] = len(spots) - 1
    merged = merge_spots(spots)
    kept = range(len(merged))
    if limit is not None and len(merged) > limit:
        kept = sorted(sorted(range(len(merged)), key=lambda i: (-merged[i]["count"], i))[:limit])
    # Which view each animation ended up on (merged spots share one), or why none.
    owner = {}
    for i, m in enumerate(merged):
        for j in m["members"]:
            owner[j] = i
    for entry in entries:
        if "spot" in entry:
            i = owner[entry.pop("spot")]
            entry["status"] = ("view: " + merged[i]["name"]) if i in kept else "over the limit (animation_views)"
    if report is not None:
        report += entries
    return [merged[i] for i in kept]


def box(tiles):
    """Inclusive tile box [x0, y0, x1, y1] around tiles."""
    return [min(t[0] for t in tiles), min(t[1] for t in tiles), max(t[0] for t in tiles), max(t[1] for t in tiles)]


def find_show(show, found, park_name):
    """The show definition for a park, checked against its companions."""
    definition = SHOWS.get(show)
    if definition is None:
        raise ValueError("unknown show %r (known: %s)" % (show, ", ".join(sorted(SHOWS))))
    names = {metadata(code, label)["name"] for label, code in found}
    if definition["companion"] not in names:
        raise ValueError("show %r needs the companion %r, which this park doesn't ship"
                         % (show, definition["companion"]))
    if definition.get("park") not in (None, park_name):
        raise ValueError("show %r is for the park %r" % (show, definition["park"]))
    return definition


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "plugin"


def build(parks, out_dir, debug=False):
    """Write one plugin file per distinct companion (same code shared by several parks is
    written once) into out_dir, replacing what was there. Returns [(file, meta, park names)]."""
    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        if old.startswith(FILE_PREFIX) and old.endswith(".js"):
            os.remove(os.path.join(out_dir, old))
    by_code = {}
    for park in parks:
        for label, code in park["companions"]:
            digest = hashlib.sha1(code.encode("utf-8")).hexdigest()
            item = by_code.setdefault(digest, {"label": label, "code": code, "parks": [],
                                               "camera": False, "meta": metadata(code, label)})
            item["parks"].append({"name": park["savedName"], "size": {"x": park["mapSize"][0], "y": park["mapSize"][1]},
                                  **park.get("companionSettings", {}).get(item["meta"]["name"], {})})
            item["camera"] = item["camera"] or park["companionCamera"]
    if by_code and not os.path.exists(HOST_FILE):
        raise ValueError("plugin/dist/companion-host.js missing; build the plugin (npm run build in plugin/)")
    written = []
    used = set()
    for item in by_code.values():
        meta = item["meta"]
        base = FILE_PREFIX + slug(meta["name"])
        file_name, n = base + ".js", 2
        while file_name in used:
            file_name, n = "%s-%d.js" % (base, n), n + 1
        used.add(file_name)
        config = {"name": meta["name"], "version": meta["version"], "file": item["label"],
                  "targetApiVersion": meta["targetApiVersion"], "parks": item["parks"],
                  "camera": item["camera"], "debug": bool(debug)}
        shows = {k: v["steps"] for k, v in SHOWS.items() if v["companion"] == meta["name"]}
        if shows:
            config["showAction"] = show_action(meta["name"])
            config["shows"] = shows
        with open(HOST_FILE, encoding="utf-8") as f:
            # Without the bundle's "use strict" directive: it would apply to the whole file, and
            # companions written for sloppy mode (implicit globals) would throw.
            host = re.sub(r'^\s*"use strict";\s*', "", f.read())
        with open(os.path.join(out_dir, file_name), "w", encoding="utf-8", newline="\n") as f:
            f.write("// Generated by tools/mksequence.py: %s (%s %s) for the RCT Screensaver title screen.\n"
                    % (item["label"], meta["name"], meta["version"]))
            f.write("// The companion's code is its author's, under its own license; not part of this repository.\n")
            f.write(host)
            f.write("\nRCTScreensaverCompanionHost(%s, function (registerPlugin, context, ui, park, console, map) {\n"
                    % json.dumps(config))
            f.write(item["code"])
            f.write("\n});\n")
        written.append((file_name, meta, [p["name"] for p in item["parks"]]))
    return written
