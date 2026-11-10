#!/usr/bin/env python3
"""Bake the game's live edits into the playlist files.

The screensaver mode's view editor (patched engine) saves its edits in a live file per playlist,
<OpenRCT2 user directory>/screensaver/live/<sequence>.json (tools/livefile.py). Builds apply it
already; this writes it into the playlist itself, so the playlist files hold the edits on their own
(for bundles, other machines, the drawing page):

- views of edited parks -> <playlist>.views.json (a reset drops the park's views there, kept in
  <playlist>.views.bak.json), as mksequence.py --install does with the game's storage;
- Playlist properties and park order -> the playlist's TOML (comments kept where possible, the old
  file in <playlist>.toml.bak).

Then it records the bake (live/baked/<sequence>.json), so builds stop applying what was baked. The
game keeps its own copy and keeps playing it; the game can stay open.

    python tools/bakelive.py                   every live file whose playlist file is known
    python tools/bakelive.py playlist.toml     only this playlist's
    python tools/bakelive.py --list            show what is waiting, change nothing
"""
import argparse, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import livefile, mksequence  # noqa: E402


def describe(live):
    s = livefile.summary(live)
    parts = []
    if s["views"]:
        parts.append("views of " + ", ".join(s["views"]))
    if s["resets"]:
        parts.append("reset " + ", ".join(s["resets"]))
    if s["props"]:
        parts.append("properties " + ", ".join(s["props"]))
    if s["order"]:
        parts.append("park order")
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(float(live.get("saved", 0) or 0) / 1000))
    return "%s (saved %s)" % ("; ".join(parts) or "nothing", when)


def bake(playlist_path, live, user_dir=None):
    """Write one live file into its playlist's files and mark it baked. Returns lines to print."""
    lines = []
    for key, reset in mksequence.merge_edits(playlist_path, live["edits"]):
        lines.append(("reset to playlist views, old views kept in %s.views.bak.json (%s)" if reset else
                      "views -> %s.views.json (%s)") % (os.path.splitext(playlist_path)[0], key))
    changed = mksequence.write_props(playlist_path, live["props"])
    if changed:
        lines.append("%s -> %s (the old file in %s.bak)" % (", ".join(changed), playlist_path, playlist_path))
    livefile.mark_baked(live, user_dir)
    return lines or ["nothing to change: the playlist files already hold these edits"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("playlist", nargs="*", help="playlists (TOML) to bake; default: every live file's own")
    ap.add_argument("--user-dir", help="OpenRCT2 user directory (default: %s)" % userdir_default())
    ap.add_argument("--list", action="store_true", help="list the live files waiting to be baked; change nothing")
    args = ap.parse_args()
    user_dir = args.user_dir
    try:
        if args.playlist:
            jobs = []
            for playlist_path in args.playlist:
                name = mksequence.playlist_name(playlist_path)
                live = livefile.for_playlist(playlist_path, name, user_dir)
                if live is None:
                    print("%s: no live edits waiting (%s)" % (playlist_path, livefile.path(name, user_dir)))
                else:
                    jobs.append((playlist_path, live))
        else:
            jobs = []
            for file_path, live in livefile.list_all(user_dir):
                source = live.get("source")
                waiting = float(live.get("saved", 0) or 0) > livefile.baked_until(live["sequence"], user_dir)
                if not waiting:
                    continue
                if not (isinstance(source, str) and os.path.exists(source)):
                    print("%s: its playlist file is not known or gone (%s); name it: bakelive.py <playlist>"
                          % (file_path, source or "installed before live files"))
                    continue
                if mksequence.playlist_name(source) != live["sequence"]:
                    print("%s: %s is now named %s; name the playlist to bake it" % (file_path, source, mksequence.playlist_name(source)))
                    continue
                jobs.append((source, live))
        if not jobs:
            print("no live edits waiting in %s" % livefile.folder(user_dir))
            return
        for playlist_path, live in jobs:
            print("%s: %s" % (playlist_path, describe(live)))
            if not args.list:
                for line in bake(playlist_path, live, user_dir):
                    print("  " + line)
    except (ValueError, OSError) as e:
        sys.exit("error: %s" % e)


def userdir_default():
    return mksequence.default_user_dir()


if __name__ == "__main__":
    main()
