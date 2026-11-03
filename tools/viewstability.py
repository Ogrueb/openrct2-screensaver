"""Measure how stable a playlist's generated views are: rebuild each park's views with every
spot's score jittered by a small random factor (fixed seeds), standing in for a small change to
the scoring, and count the close-ups that move.
A stable picker moves few; one where a small score change cascades through later picks moves many.

Usage: python3 tools/viewstability.py <playlist.toml> [--runs 5] [--jitter 0.05]
                                      [--set option=value ...] [--park TEXT]

--set overrides a [views] option for every park (value in TOML syntax, e.g. --set
grid_anchor='"map"' or --set wide_limit=0.5), to compare variants without editing the playlist.
A close-up counts as unmoved when a jittered build has one at the same zoom and angle within
MATCH_TILES tiles and MATCH_HEIGHT world units of height. Needs no game.
"""
import argparse, os, statistics, sys, tomllib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mksequence  # noqa: E402

MATCH_TILES = 3
MATCH_HEIGHT = 48


def same(a, b):
    return (a["zoom"] == b["zoom"] and a["rotation"] == b["rotation"] and abs(a["x"] - b["x"]) <= MATCH_TILES
            and abs(a["y"] - b["y"]) <= MATCH_TILES and abs(a["z"] - b["z"]) <= MATCH_HEIGHT)


def close_ups(park):
    return [v for v in park["views"] if not v.get("overview")]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("playlist")
    ap.add_argument("--runs", type=int, default=5, help="jittered builds per park (default 5)")
    ap.add_argument("--jitter", type=float, default=0.05, help="largest score change, as a share (default 0.05)")
    ap.add_argument("--set", action="append", default=[], metavar="OPTION=VALUE", help="override a [views] option")
    ap.add_argument("--park", help="only parks whose file or name contains this text")
    args = ap.parse_args()
    with open(args.playlist, "rb") as f:
        playlist = tomllib.load(f)
    base_dir = os.path.dirname(os.path.abspath(args.playlist))
    defaults = {**mksequence.VIEW_DEFAULTS, **playlist.get("views", {})}
    for item in args.set:
        defaults.update(tomllib.loads(item))
    total_moved = total = 0
    print("%-28s %7s %10s %9s" % ("park", "views", "moved/run", "min lead"))
    for i, entry in enumerate(playlist.get("park", [])):
        label = entry.get("name") or os.path.basename(entry["file"])
        if args.park and args.park.lower() not in (label + entry["file"]).lower():
            continue
        if entry.get("view"):
            continue  # listed views, nothing generated
        base = close_ups(mksequence.resolve_park(entry, i, base_dir, defaults, "plugin"))
        moved = []
        for seed in range(1, args.runs + 1):
            run = close_ups(mksequence.resolve_park(entry, i, base_dir, {**defaults, "jitter": args.jitter,
                                                                           "jitter_seed": seed}, "plugin"))
            moved.append(sum(1 for v in base if not any(same(v, w) for w in run)))
        leads = [v["why"]["lead"] for v in base if v.get("why", {}).get("lead")]
        print("%-28s %7d %10.1f %9s" % (label[:28], len(base), statistics.mean(moved),
                                       "%.3f" % min(leads) if leads else "-"))
        total_moved += statistics.mean(moved)
        total += len(base)
    print("%-28s %7d %10.1f   (%.0f%% of close-ups move under %g%% jitter)"
          % ("all", total, total_moved, 100 * total_moved / max(1, total), 100 * args.jitter))


if __name__ == "__main__":
    main()
