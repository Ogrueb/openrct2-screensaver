"""The live file: the view editor's edits as the game saves them, outside its storage.

On the patched engine, every save in the screensaver mode's view editor (views, Playlist
properties, park order) also writes the installed playlist's edits to
<OpenRCT2 user directory>/screensaver/live/<sequence>.json (plugin/src/storage.ts writeLive;
engine patch "plugin files in the user folder and the clipboard"). The game is that file's only
writer. The tools read it:

- every build (mksequence.py, the settings page) applies it over the playlist's files, so edits
  made in the game are never lost to a rebuild;
- tools/bakelive.py writes it into the playlist's files (views into <playlist>.views.json, the
  properties and park order into the TOML) and records how far it got in live/baked/<sequence>.json,
  so a build no longer applies what was baked (and the file can keep growing in the game);
- mksequence.py --install takes the same edits from the game's storage and marks the file baked.

A live file is applied only to the playlist it came from: its `sequence` is the playlist's name and
its `source`, when given, is the same file.
"""
import json, os, re, time
import userdata


def folder(user_dir=None):
    """The live files' folder in OpenRCT2's user directory (the game's, which --user-dir names when
    the game keeps its files elsewhere, as a portable install does)."""
    return os.path.join(user_dir or userdata.openrct2_dir(), "screensaver", "live")


def file_name(sequence):
    """The live file's name for a title sequence (the plugin's liveFileName does the same)."""
    base = re.sub(r"[^A-Za-z0-9._-]", "_", sequence).lstrip(".")[:100] or "playlist"
    return base + ".json"


def path(sequence, user_dir=None):
    return os.path.join(folder(user_dir), file_name(sequence))


def baked_path(sequence, user_dir=None):
    return os.path.join(folder(user_dir), "baked", file_name(sequence))


def read(file_path):
    """A live file's contents, or None when it is missing or not a version 1 live file."""
    try:
        with open(file_path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("sequence"), str):
        return None
    if not isinstance(data.get("edits"), dict):
        data["edits"] = {}
    if not isinstance(data.get("props"), dict):
        data["props"] = {}
    return data


def baked_until(sequence, user_dir=None):
    """The `saved` time of the last live file baked (or installed) for this sequence, else 0."""
    try:
        with open(baked_path(sequence, user_dir), encoding="utf-8") as f:
            return float(json.load(f).get("saved", 0))
    except (OSError, ValueError, AttributeError, TypeError):
        return 0


def mark_baked(live, user_dir=None, how="bake"):
    """Record that the live file's contents (up to its `saved` time) are in the playlist's files."""
    target = baked_path(live["sequence"], user_dir)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"saved": live.get("saved", 0), "by": how, "at": int(time.time() * 1000)}, f)
    os.replace(tmp, target)


def same_file(a, b):
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def for_playlist(playlist_path, sequence, user_dir=None, include_baked=False):
    """The live file for this playlist (its sequence name, and its file when the live file names one),
    or None. Without `include_baked`, None too when everything in it was baked already."""
    live = read(path(sequence, user_dir))
    if live is None or live["sequence"] != sequence:
        return None
    source = live.get("source")
    if isinstance(source, str) and source and os.path.exists(source) and not same_file(source, playlist_path):
        return None  # another playlist file of the same name
    if not include_baked and float(live.get("saved", 0) or 0) <= baked_until(sequence, user_dir):
        return None
    return live


def summary(live):
    """A short description of what a live file holds: parks with views, resets, properties, order, Use ticks."""
    edits = live.get("edits", {})
    props = live.get("props", {})
    return {"saved": live.get("saved"), "views": sorted(k for k, v in edits.items() if isinstance(v, dict) and not v.get("reset")),
            "resets": sorted(k for k, v in edits.items() if isinstance(v, dict) and v.get("reset")),
            "props": sorted(k for k in props if k not in ("order", "use")), "order": isinstance(props.get("order"), list),
            "use": isinstance(props.get("use"), dict) and bool(props["use"])}


def list_all(user_dir=None):
    """Every live file in the folder (not yet baked or not), as (path, contents)."""
    out = []
    try:
        names = sorted(os.listdir(folder(user_dir)))
    except OSError:
        return out
    for name in names:
        if name.endswith(".json"):
            live = read(os.path.join(folder(user_dir), name))
            if live is not None:
                out.append((os.path.join(folder(user_dir), name), live))
    return out
