"""Per-park profiles: what a park needs beyond the general view heuristics, kept once per park
in parks/<slug>.toml and merged into every playlist that plays it.

A profile is matched to a park by the name saved in the park (not the playlist's shown name)
and, if given, its map size and file name:

  [match]
  name = "Constellations"   saved park name (a working title as saved, e.g. "Xtreme97 Workbench 2021")
  map = [122, 122]          map size in tiles (optional; tells apart parks saved under one name)
  file = "x.zip"            zip or .park basename (optional; only breaks a remaining tie)

  name = "Gardens of Light" (top level, above [match]) the name shown for the park when the playlist
                            gives none (a park saved under a working title, such as "Dream")
  companions = false        (top level, above [match]) none of the park's companion plugins runs (the
                            settings UI's Scripts switch);
                            a playlist entry's own `companions` list still wins
  [views]                   fixes: generator keys, as under a playlist's [park.views]; always applied
  [extras]                  extras: animations, animation_hold, animation_views, animation_cues
                            (false: animation views keep a fixed hold instead of waiting for their
                            trigger), cue_hold (seconds such a view plays at least, default 5),
                            cue_wait (seconds it waits past that for its trigger, 30), cue_move
                            (seconds it pans on after the effect when the playlist pans, 4), show,
                            show_hold, show_at (where the show plays among the park's views: an
                            index, -1 last);
                            applied only when the playlist sets park_plugins = true

  [companion.Animator]      fixes for one of the park's companions (by its registered name):
  pause_during_pans = true  hold its tick handlers while the camera moves
  pause_above_zoom = 0      and while the camera is zoomed out beyond this level
  zoom_rates = { "1" = 0.1 }  at these zoom levels, run only this share of its ticks (slower)
  [[companion.Animator.patch]]  change what it reads from park storage: every object there
  id = "fademist"           with this id gets these fields (dotted paths) set
  set = { intervalTicks = 15, "randomize.viewport.maxDistance" = 20 }

  [[spot]]                  where a companion animates, when its data doesn't say
  companion = "Object Animator"
  name = "stars"
  z = 528                   height (optional; else the ride's track or what stands there)
                            (zoom, rotation, hold: optional too, in place of the placed ones)
  boxes = [[47, 67, 53, 67]]  tile boxes x0, y0, x1, y1, inclusive
  cue = {tick = 2400, ticks = 5200, lead = 3}   optional: the view waits for this and stays while
                            it runs (plugin View.cue: ride + tiles, cars, or tick on the park's
                            clock; ticks the effect lasts; follow = ride, train; cut = true plays it
                            out of turn when cued)

  [animation."Shooting 1"]  one of the park's companion animations, by name (mksequence.py
                            --animations lists them): off = true drops it (false brings
                            back one that is off by default: AdvancedTrack's lifts), hold = seconds,
  cue = {wait = 60}         z = height, zoom, rotation, cue = false plays it for a fixed hold, a cue table changes
                            its cue (wait, ticks, follow = ride or false, train, cut, lead);
                            applied with park_plugins, like [extras]

  [show.eclipse]            a companion's show (docs/companion-plugins.md), started by button
  companion = "Object Animator"   presses on its hidden window; names are global across profiles
  steps = [...]             press / until / wait / ticks steps
  view = {x = 55, y = 60, zoom = 1, rotation = 2}   where the camera goes, or
  spot = {boxes = [...]}    a spot placed like an animation view (zoom, rotation: set them
                            instead of the placed ones)
  hold = 120.0              the most it may take, seconds at 1x
  path = [{x = 55, y = 60, ticks = 1500}, ...]   with view: the camera glides on from the view
                            through these tiles, each reached `ticks` game ticks after the last
                            (no x/y: stays put); angle and zoom are the view's, and so is the
                            height unless a point gives z (units of 1/8 step, as views' z)
  path_step = 1             with path: the glide waits until the show reaches this step (an index
                            into steps, -1 the last); without it, it starts with the view

Merge order for a park (lowest first): the playlist's [views] (and --set), the profile's [views]
and, with park_plugins, its [extras], then the playlist's own [[park]] entry and [park.views].
A playlist entry can name its profile (profile = "koi-pond", the file's stem) or turn it off
(profile = false); `mksequence.py --ignore-profiles` builds without any. Spot and show
definitions describe the companions' code, so they are read whether profiles are applied or not.
"""
import os, re, shutil, tomllib

import userdata

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "parks")
EXTRAS = ("animations", "animation_hold", "animation_views", "animation_cues", "cue_hold", "cue_wait", "cue_move", "show", "show_hold", "show_at")


def tiles(boxes):
    """Tile list of inclusive boxes [x0, y0, x1, y1]."""
    out = []
    for x0, y0, x1, y1 in boxes:
        out += [(x, y) for x in range(min(x0, x1), max(x0, x1) + 1) for y in range(min(y0, y1), max(y0, y1) + 1)]
    return out


def load(directory=PROFILE_DIR, user=True):
    """{stem: profile} of every parks/*.toml, each with its file's stem under "id", its file under
    "path" and "source" ("repo" or "user"). With user, the profiles the settings page saved in the
    user folder (userdata.parks()) come on top: one with a repository profile's file name replaces it."""
    profiles = {}
    for folder, source in ((directory, "repo"), (userdata.parks() if user else None, "user")):
        if folder and os.path.isdir(folder):
            for stem, profile in read_folder(folder).items():
                profiles[stem] = dict(profile, source=source)
    return profiles


def read_folder(directory):
    profiles = {}
    for file_name in sorted(os.listdir(directory)):
        if not file_name.endswith(".toml"):
            continue
        stem = file_name[:-5]
        with open(os.path.join(directory, file_name), "rb") as f:
            profile = tomllib.load(f)
        if not (profile.get("match") or {}).get("name"):
            raise ValueError("parks/%s: [match] needs a name" % file_name)
        if not isinstance(profile.get("name", ""), str):
            raise ValueError("parks/%s: name must be a string (the park's shown name)" % file_name)
        if profile.get("companions", False) is not False:
            raise ValueError("parks/%s: companions can only be false (no companion of the park runs)" % file_name)
        unknown = set(profile.get("extras", {})) - set(EXTRAS)
        if unknown:
            raise ValueError("parks/%s: unknown [extras] key(s) %s (known: %s)"
                             % (file_name, ", ".join(sorted(unknown)), ", ".join(EXTRAS)))
        for companion, settings in profile.get("companion", {}).items():
            unknown = set(settings) - {"pause_during_pans", "pause_above_zoom", "zoom_rates", "patch"}
            if unknown:
                raise ValueError("parks/%s: unknown [companion.%s] key(s) %s" % (file_name, companion, ", ".join(sorted(unknown))))
            for patch in settings.get("patch", []):
                if not isinstance(patch.get("id"), str) or not isinstance(patch.get("set"), dict) or set(patch) - {"id", "set"}:
                    raise ValueError("parks/%s: a [[companion.%s.patch]] needs an id and a set table only" % (file_name, companion))
        for name, change in profile.get("animation", {}).items():
            unknown = set(change) - {"off", "hold", "z", "zoom", "rotation", "cue"} if isinstance(change, dict) else {"(not a table)"}
            if unknown:
                raise ValueError("parks/%s: unknown [animation.\"%s\"] key(s) %s (known: off, hold, z, zoom, rotation, cue)"
                                 % (file_name, name, ", ".join(sorted(unknown))))
        profile["id"] = stem
        profile["path"] = os.path.join(directory, file_name)
        profiles[stem] = profile
    return profiles


def definitions(profiles):
    """Spots and shows of all profiles, as companions.py uses them: ({(companion, park name):
    [spot]}, {show name: definition})."""
    spots, shows = {}, {}
    for profile in profiles.values():
        park = profile["match"]["name"]
        for spot in profile.get("spot", []):
            s = {"name": spot["name"], "tiles": tiles(spot["boxes"])}
            if "z" in spot:
                s["z"] = int(spot["z"])
            if "cue" in spot:
                s["cue"] = dict(spot["cue"])
            for key in ("zoom", "rotation", "hold"):  # in place of the placed ones
                if key in spot:
                    s[key] = spot[key]
            spots.setdefault((spot["companion"], park), []).append(s)
        for name, show in profile.get("show", {}).items():
            if name in shows:
                raise ValueError("parks/%s.toml: show %r is defined twice" % (profile["id"], name))
            d = {"companion": show["companion"], "park": park, "steps": show["steps"], "hold": float(show["hold"])}
            if "view" in show:
                d["view"] = dict(show["view"])
                if "path" in show:
                    x, y, path = show["view"]["x"], show["view"]["y"], []
                    for p in show["path"]:
                        x, y = p.get("x", x), p.get("y", y)
                        path.append({"x": x, "y": y, "ticks": int(p["ticks"])})
                        if "z" in p:
                            path[-1]["z"] = int(p["z"])
                    d["path"] = path
                    if "path_step" in show:
                        step = int(show["path_step"])
                        if not -len(show["steps"]) <= step < len(show["steps"]):
                            raise ValueError("parks/%s.toml: show %r path_step %d is not one of its %d steps"
                                             % (profile["id"], name, step, len(show["steps"])))
                        d["pathStep"] = step % len(show["steps"])  # an index; -1 is the last step
            elif "spot" in show:
                d["spot"] = {"tiles": tiles(show["spot"]["boxes"])}
                for key in ("zoom", "rotation"):  # in place of the ones placement would pick
                    if key in show["spot"]:
                        d["spot"][key] = int(show["spot"][key])
            else:
                raise ValueError("parks/%s.toml: show %r needs a view or a spot" % (profile["id"], name))
            shows[name] = d
    return spots, shows


def find(profiles, entry, saved_name, map_size, file_name):
    """The profile for a playlist park: the one the entry names, else the best match, else None."""
    chosen = entry.get("profile")
    if chosen is False:
        return None
    if isinstance(chosen, str):
        if chosen not in profiles:
            raise ValueError("%s: unknown profile %r (in parks/: %s)" % (saved_name, chosen, ", ".join(sorted(profiles))))
        return profiles[chosen]
    if chosen not in (None, True):
        raise ValueError("%s: profile must be a name or false" % saved_name)
    matches = []
    for profile in profiles.values():
        m = profile["match"]
        if m["name"] != saved_name or ("map" in m and list(m["map"]) != list(map_size)):
            continue
        if "file" in m and m["file"] != file_name:
            continue
        matches.append((("map" in m) + ("file" in m), profile["id"], profile))
    if not matches:
        return None
    matches.sort(key=lambda t: (-t[0], t[1]))
    if len(matches) > 1 and matches[0][0] == matches[1][0]:
        raise ValueError("%s: profiles %s and %s both match; add map or file to [match]"
                         % (saved_name, matches[0][1], matches[1][1]))
    return matches[0][2]


def companion_settings(profile):
    """{companion name: {"patches": [...], "pause": bool}} for the companion host's park list."""
    out = {}
    for companion, settings in (profile or {}).get("companion", {}).items():
        s = {}
        if settings.get("patch"):
            s["patches"] = [{"id": p["id"], "set": dict(p["set"])} for p in settings["patch"]]
        if settings.get("pause_during_pans"):
            s["pause"] = True
        if "pause_above_zoom" in settings:
            s["pauseAboveZoom"] = int(settings["pause_above_zoom"])
        if settings.get("zoom_rates"):
            s["zoomRates"] = {str(int(k)): float(v) for k, v in settings["zoom_rates"].items()}
        out[companion] = s
    return out


def apply(profile, entry, park_plugins):
    """The playlist entry with the profile merged under it: {**profile views, **entry views},
    and with park_plugins the profile's extras under the entry's own keys."""
    if profile is None:
        return entry
    merged = dict(entry)
    if park_plugins:
        for k, v in profile.get("extras", {}).items():
            merged.setdefault(k, v)
        if profile.get("animation"):
            merged["animation_overrides"] = profile["animation"]
    merged["views"] = {**profile.get("views", {}), **entry.get("views", {})}
    if profile.get("name"):
        merged.setdefault("name", profile["name"])  # the shown name, unless the playlist gives one
    if profile.get("companions") is False:
        merged.setdefault("companions", [])  # none of the park's companions runs (the entry can still list some)
    return merged


# --- changing a profile (the settings page's park switches and parameters, the game's park settings) ---

PROFILE_ORDER = ["companions", "match", "views", "extras", "companion", "spot", "animation", "show"]


def change_data(data, changes):
    """The profile `data` (as read, without id/path/source) with `changes` applied, in a new dict:
    changes = {views: {k: v|None}, extras: {...}, companions: False|None, animation: {name: {off, hold}|None},
    show: {name: {view, path, hold}}}; None deletes a key."""
    data = {k: (dict(v) if isinstance(v, dict) else v) for k, v in data.items() if k not in ("id", "path", "source")}
    if "companions" in changes:
        if changes["companions"] is False:
            data["companions"] = False
        else:
            data.pop("companions", None)
    for section in ("views", "extras"):
        for k, v in (changes.get(section) or {}).items():
            table = data.setdefault(section, {})
            if v is None:
                table.pop(k, None)
            else:
                table[k] = v
            if not table:
                data.pop(section)
    for name, change in (changes.get("animation") or {}).items():
        table = {k: dict(v) for k, v in data.get("animation", {}).items()}
        entry = {**table.get(name, {}), **{k: v for k, v in (change or {}).items() if v is not None}}
        for k, v in (change or {}).items():
            if v is None:
                entry.pop(k, None)
        if entry and change is not None:
            table[name] = entry
        else:
            table.pop(name, None)
        data["animation"] = table
        if not table:
            data.pop("animation")
    for name, change in (changes.get("show") or {}).items():
        shows = {k: dict(v) for k, v in data.get("show", {}).items()}
        if name not in shows:
            raise ValueError("show %r is not defined in the park's profile" % name)
        for k, v in change.items():
            if v is None:
                shows[name].pop(k, None)
            else:
                shows[name][k] = v
        data["show"] = shows
    return {k: data[k] for k in sorted(data, key=lambda k: PROFILE_ORDER.index(k) if k in PROFILE_ORDER else len(PROFILE_ORDER))}


def slug(text, limit=40):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s[:limit].rstrip("-") or "park"


def new_stem(saved_name, taken):
    """A file name for a new profile of a park, not one of `taken`."""
    stem, n = slug(saved_name), 2
    while stem in taken:
        stem, n = "%s-%d" % (slug(saved_name), n), n + 1
    return stem


def change(park, changes, write, user_parks=None):
    """Applies changes (change_data's) to a park's profile in the user folder, creating one when it has
    none; park = {profile: stem or None, savedName, mapSize}. `write(path, data)` writes the file (the
    settings page keeps backups). The repository's profile is copied into the user folder first. A copy
    that no longer differs from what ships (or a new one left with only its [match]) is removed, so the user
    folder holds only real changes and later fixes to the shipped profile apply. A change that leaves the
    profiles unreadable is undone and raises. Returns the profile's stem."""
    user_parks = user_parks or userdata.parks()
    stem = park.get("profile")
    if stem:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", stem):
            raise ValueError("bad profile name %r" % stem)
        path = os.path.join(user_parks, stem + ".toml")
        before = None
        if os.path.exists(path):
            with open(path, "rb") as f:
                before = f.read()
            data = tomllib.loads(before.decode("utf-8"))
        else:
            # The repository's profile: its copy in the user folder replaces it (comments kept)
            known = load()
            if stem not in known:
                raise ValueError("no profile %r" % stem)
            os.makedirs(user_parks, exist_ok=True)
            shutil.copy2(known[stem]["path"], path)
            with open(path, "rb") as f:
                data = tomllib.load(f)
    else:
        stem = new_stem(park["savedName"], set(load()))
        path = os.path.join(user_parks, stem + ".toml")
        before = None
        data = {"match": {"name": park["savedName"], "map": list(park["mapSize"])}}
    data = change_data(data, changes)
    os.makedirs(user_parks, exist_ok=True)
    write(path, data)
    try:
        load()
    except ValueError:
        if before is None:
            os.remove(path)
        else:
            with open(path, "wb") as f:
                f.write(before)
        raise
    shipped = load(user=False).get(stem)
    plain = lambda p: {k: v for k, v in p.items() if k not in ("id", "path", "source")}
    if (shipped and plain(shipped) == data) or (not shipped and set(data) == {"match"}):
        os.remove(path)
    return stem
