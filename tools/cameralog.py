#!/usr/bin/env python3
"""Per-view camera timings from an OpenRCT2 log written with the plugin's camera log on.

Install with `mksequence.py ... --install --camera-log`, play, then run this on the game's log
(stdout of openrct2.exe). For every view it prints how long the view lasted, how long the camera
stood still before panning, how long it moved, its average screen speed, and the stills around
each angle or zoom change, and flags any that are shorter than the plugin's settings (a still
under `changeHold` after a change, a rest under `arriveHold` before a change on arrival) or
pans cut short or faster than the speed tolerance at their travel zoom (`pan_tolerance` in
mksequence.py: 500 px/s at zoom -2, 100 less per level out; generation stretches pans to fit it,
so in play only listed views should show here; overviews are exempt; a park's return pan, which
zooms out as it goes, is checked at its widest zoom).

With --triggers it lists instead when each event view's trigger fired (a car arriving on its
tiles, logged whichever view was on screen): per park and animation, the park tick of each
arrival per visit, the first, the lap between arrivals, and a profile entry that turns the view
into a timeline cut-in at those times (parks/<park>.toml, owner 2026-10-30).

Usage: python3 tools/cameralog.py build/logs/openrct2-<launch>.log [--change-hold 2] [--arrive-hold 1]
       [--tolerance 500] [--tolerance-step 100] [--all] [--triggers]
"""

import argparse
import json
import re
import statistics
import sys

LINE = re.compile(r"\[RCT Screensaver\] camera (\d+) (\w+) ?(.*)$")
PARK = re.compile(r"\[RCT Screensaver\] park (\d+)/\d+: (.*)$")
HELD = re.compile(r"\[RCT Screensaver\] (holding|released) view")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
SLACK = 60  # ms: one plugin update (25 ms ticks, 100 ms player updates) of timing jitter


def values(text):
    return dict(kv.split("=", 1) for kv in text.split() if "=" in kv)


def read(path):
    """Views in play order: dicts with the events that happened while each was on screen."""
    views, parks, held = [], {}, False
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            # The game wraps some console lines in quotes and colour codes.
            line = ANSI.sub("", line).strip().strip("'")
            m = PARK.search(line)
            if m:
                parks[int(m.group(1))] = m.group(2).strip()
                continue
            if HELD.search(line):
                held = True
                if views:
                    views[-1]["held"] = True
                continue
            m = LINE.search(line)
            if not m:
                continue
            t, event, rest = int(m.group(1)), m.group(2), m.group(3)
            if event == "view":
                rest, _, name = rest.partition(" | ")
                v = values(rest)
                views.append({"t": t, "park": int(v.get("park", 0)), "view": v.get("view", "?"),
                              "panned": "panned" in rest.split(), "overview": "overview" in rest.split(), "hold": int(v.get("hold", 0)),
                              "changes": [], "plan": None, "move": None, "stop": None,
                              "held": False, "name": ""})
                views[-1]["name"] = name.strip() or parks.get(views[-1]["park"], "")
            elif not views:
                continue
            elif event == "plan":
                views[-1]["plan"] = None if rest.strip() == "cut" else values(rest)
            elif event == "change":
                views[-1]["changes"].append((t, rest.strip()))
            elif event == "move":
                views[-1]["move"] = t
            elif event == "stop":
                views[-1]["stop"] = t
                stop = values(rest)
                if "peak" in stop:
                    views[-1]["peak"] = int(stop["peak"])
                if "ticks" in stop:
                    views[-1]["ticks"] = int(stop["ticks"])
    if held:
        print("note: the view was held (Space) during the run; held views are marked and not flagged")
    return views


def analyse(views, args):
    rows, flags = [], []
    # A change on arrival is logged as the pan ends, before the next view starts: it belongs to
    # the next view (the still after it), and the gap since the pan stopped is the rest.
    for i, v in enumerate(views):
        v["rest"] = None
        if v["stop"] is not None:
            arrival = [c for c in v["changes"] if c[0] >= v["stop"]]
            if arrival:
                v["rest"] = arrival[0][0] - v["stop"]
                v["changes"] = [c for c in v["changes"] if c[0] < v["stop"]]
                if i + 1 < len(views):
                    views[i + 1]["changes"] = arrival + views[i + 1]["changes"]
    for i, v in enumerate(views):
        nxt = views[i + 1] if i + 1 < len(views) else None
        end = nxt["t"] if nxt else None
        row = {"park": v["name"] or "park %d" % v["park"], "view": v["view"],
               "arrive": "pan" if v["panned"] else "cut",
               "total": (end - v["t"]) if end is not None else None}
        problems = []
        # Stills after each change in this view: until the camera moves, or the view ends.
        stills = []
        for t, what in v["changes"]:
            if v["move"] is not None and v["move"] >= t:
                stills.append(v["move"] - t)
            elif v["move"] is None and end is not None:
                stills.append(end - t)
        row["after_change"] = min(stills) if stills else None
        # The view's own still time before it pans.
        row["still"] = (v["move"] - v["t"]) if v["move"] is not None else row["total"]
        row["moving"] = (v["stop"] - v["move"]) if v["move"] is not None and v["stop"] is not None else None
        plan = v["plan"] or {}
        row["speed"] = int(plan["speed"]) if "speed" in plan else None
        row["travel"] = plan.get("travel", "")
        # A return pan zooms out as it goes: its speed is checked at the widest zoom
        row["zoom"] = plan.get("out") or row["travel"].partition("z")[2]
        # The plugin logs the tolerance it held the pan to, scaled to the window
        row["tol"] = int(plan["tol"]) if "tol" in plan else None
        row["peak"] = v.get("peak")
        # Ticks the pan moved on, against 40 a second over its moving time
        row["ticks"] = v.get("ticks")
        row["tick_share"] = (v["ticks"] / (row["moving"] / 25)) if v.get("ticks") and row["moving"] else None
        row["rest"] = v["rest"]
        if not v["held"]:
            # Only stills that end in a pan count: a view that cuts away is the old static behaviour.
            # A cut changes everything at once, as before panning; its own start doesn't count.
            moved_stills = [s for (t, _), s in zip(v["changes"], stills)
                            if v["move"] is not None and v["move"] >= t and (v["panned"] or t - v["t"] > SLACK)]
            if moved_stills and min(moved_stills) < args.change_hold * 1000 - SLACK:
                problems.append("still %.1f s after a change" % (min(moved_stills) / 1000))
            if row["rest"] is not None and row["rest"] < args.arrive_hold * 1000 - SLACK:
                problems.append("rest %.1f s before a change" % (row["rest"] / 1000))
            if v["move"] is not None and v["stop"] is None and nxt is not None:
                problems.append("pan cut short")
            zoom = row["zoom"]
            if row["speed"] is not None and zoom and not v["overview"]:  # overviews are exempt (owner)
                tolerance = row["tol"] or max(args.tolerance_step, args.tolerance - args.tolerance_step * (int(zoom) + 2))
                if row["speed"] > tolerance * 1.05:
                    problems.append("%d px/s over %d" % (row["speed"], tolerance))
        row["problems"] = problems
        rows.append(row)
        if problems:
            flags.append(row)
    return rows, flags


def triggers(path):
    """{(park, animation): [[park ticks of each arrival] per visit]} from the camera log's
    trigger lines; a visit ends when a park's ticks go back down."""
    out, last = {}, {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = ANSI.sub("", line).strip().strip("'")
            m = LINE.search(line)
            if not m or m.group(2) != "trigger":
                continue
            head, _, rest = m.group(3).partition(" | ")
            animation, _, park = rest.partition(" | ")
            tick = int(values(head).get("tick", 0))
            key = (park.strip(), animation.strip())
            visits = out.setdefault(key, [])
            if not visits or tick < last.get(key, 0):
                visits.append([])
            visits[-1].append(tick)
            last[key] = tick
    return out


def period(visits):
    """(lap, intervals): the median gap between an arrival and the one `step` arrivals later, at the
    smallest step whose gaps agree within 5%. A view on several triggers (Void's Block1Paint4 and
    Paint5, 2026-10-30) sees arrivals alternate 310 and 810 ticks apart, its lap their sum."""
    for step in range(1, 5):
        laps = [v[i + step] - v[i] for v in visits for i in range(len(v) - step)]
        if not laps:
            break
        lap = statistics.median(laps)
        if max(laps) - min(laps) <= 0.05 * lap:
            return round(lap), laps
    laps = [b - a for v in visits for a, b in zip(v, v[1:])]
    return (round(statistics.median(laps)) if laps else None), laps


def print_triggers(found):
    """The trigger timings, and a profile entry for each animation that fired."""
    if not found:
        print("no trigger lines (install with mksequence.py --camera-log, on a plugin from 2026-10-30 on)")
        return
    for (park, animation), visits in sorted(found.items()):
        firsts = [v[0] for v in visits]
        lap, laps = period(visits)
        print("%s | %s: first %s; lap %s; arrivals per visit %s" % (
            park, animation, ", ".join(map(str, firsts)),
            "%d ticks (%.1f s; %s)" % (lap, lap / 40, ", ".join(map(str, laps))) if lap else "unknown (one arrival)",
            [len(v) for v in visits]))
        cue = {"tick": min(firsts), "lead": 3, "cut": True}
        if lap:
            cue["every"] = lap
        # A merged view's cue is its first animation's, which the profile names.
        print("  [animation.%s]\n  cue = {%s}" % (json.dumps(animation.split(" / ")[0]), ", ".join(
            "%s = %s" % (k, "true" if v is True else v) for k, v in cue.items())))


def sec(ms):
    return "" if ms is None else "%.1f" % (ms / 1000)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("log")
    ap.add_argument("--change-hold", type=float, default=2, help="the plugin's changeHold, s (default 2)")
    ap.add_argument("--arrive-hold", type=float, default=1, help="the plugin's arriveHold, s (default 1)")
    ap.add_argument("--tolerance", type=float, default=500,
                    help="fastest legible pan at zoom -2, px/s (mksequence.py pan_tolerance, default 500)")
    ap.add_argument("--tolerance-step", type=float, default=100,
                    help="tolerance lost per zoom level out (pan_tolerance_step, default 100)")
    ap.add_argument("--all", action="store_true", help="print every view, not only one loop of the playlist")
    ap.add_argument("--triggers", action="store_true", help="list when each event view's trigger fired, with "
                    "profile entries for timeline cut-ins")
    args = ap.parse_args()
    if args.triggers:
        print_triggers(triggers(args.log))
        return
    views = read(args.log)
    if not views:
        sys.exit("no camera log lines in %s (install with mksequence.py --camera-log)" % args.log)
    rows, flags = analyse(views, args)
    if not args.all:
        # One loop: stop when the first park and view come round again.
        first = (views[0]["park"], views[0]["view"])
        for i in range(1, len(views)):
            if (views[i]["park"], views[i]["view"]) == first:
                rows = rows[:i]
                break
    head = "%-24s %-6s %-6s %7s %7s %7s %7s %7s %7s %7s %7s %7s  %s" % (
        "park", "view", "in by", "total s", "still s", "moving", "zoom", "px/s", "peak", "ticks", "rest s", "after", "problems")
    print(head)
    print("-" * len(head))
    park = None
    for r in rows:
        name = r["park"] if r["park"] != park else ""
        park = r["park"]
        print("%-24s %-6s %-6s %7s %7s %7s %7s %7s %7s %7s %7s %7s  %s" % (
            name[:24], r["view"], r["arrive"], sec(r["total"]), sec(r["still"]), sec(r["moving"]),
            r["zoom"] if r["moving"] is not None else "",
            "" if r["speed"] is None else r["speed"], "" if r.get("peak") is None else r["peak"],
            "" if r["tick_share"] is None else "%d%%" % round(100 * r["tick_share"]),
            sec(r["rest"]), sec(r["after_change"]),
            ", ".join(r["problems"])))
    speeds = sorted(r["speed"] for r in rows if r["speed"] is not None)
    pans = sum(1 for r in rows if r["moving"] is not None)
    print()
    print("%d views, %d pans in one loop; %d views flagged over the whole log (%d views)" % (
        len(rows), pans, len(flags), len(views)))
    if speeds:
        print("pan speed px/s: median %d, fastest %d" % (speeds[len(speeds) // 2], speeds[-1]))
    print("columns: still = time before the camera moves; moving = pan time; zoom = travel zoom (a return pan's widest); "
          "px/s = average screen speed, peak = fastest tick (its move x 40), ticks = ticks moved / 40 a second; rest = still at the next spot "
          "before a change on arrival; after = shortest still after an angle/zoom change")


if __name__ == "__main__":
    main()
