"""Survey a park library for rides the screensaver can follow: which parks have a moving ride with
a run that tools/mksequence.py's ride_pans would pan along, and how big each park is, for picking
test parks. Reads the parks directly (no game needed).

Usage: python tools/ridesurvey.py <playlist.toml | park files or folders ...> [-o OUT]
                                  [--no-fill] [--set option=value] ...

A playlist (such as the one tools/importparks.py writes) gives its parks; a folder gives every
.park, .sv6 is skipped. Writes OUT (default build/ridesurvey.txt) as a table, one park per line,
and OUT's .json with the full ride_pans report (the run picked and the runs turned down), and
prints the table as it goes. --no-fill skips the frame-fill rasters (the slow part, several
seconds per park), so the ride_fill gate is not applied. --set changes a [views] option.
"""
import argparse, collections, json, os, sys, time, tomllib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mksequence, parkinfo  # noqa: E402


def survey(path, member, opts, fill):
    member, data = parkinfo.read_park_bytes(path, member)
    hdr, chunks, body = parkinfo.load(data)
    saved_name = parkinfo.parse_park(parkinfo.chunk_reader(chunks, body, 6), hdr["target"])["name"]
    name = parkinfo.display_name(saved_name, path, member)[0]
    tiles = lambda: parkinfo.chunk_reader(chunks, body, 0x30)  # noqa: E731
    _, counts, surface, heights = parkinfo.visible_element_counts(tiles())
    map_wh = mksequence.map_size(tiles())
    box = mksequence.content_bounds(counts, heights, surface)
    rides = parkinfo.track_rides(tiles())
    vehicles = parkinfo.parse_vehicles(parkinfo.chunk_reader(chunks, body, 0x31))
    moving = {v[3] for v in vehicles if v[4]}
    track = {}
    for (x, y, _), ride in rides.items():
        track.setdefault(ride, set()).add((x, y))
    candidates = sorted(len(t) for r, t in track.items() if r in moving and len(t) >= int(opts["ride_tiles"]))
    out = {"name": name, "file": os.path.basename(path) + ("|" + member if member else ""),
           "map": [map_wh[0], map_wh[1]], "builtTiles": len(counts), "elements": sum(counts.values()),
           "movingRides": len(candidates), "largestRide": candidates[-1] if candidates else 0}
    if box and candidates:
        water = parkinfo.water_heights(tiles())
        rasters = mksequence.frame_rasters(heights, surface, water, map_wh, opts) if fill else None
        views = [{"overview": True, "x": int(box["cx"]), "y": int(box["cy"]), "z": box["zm"], "hold": 1.0,
                  "_pool": {"rasters": rasters}}]
        chunk = parkinfo.chunk_reader(chunks, body, 0x32)
        info = parkinfo.parse_rides(chunk, hdr["target"]) if chunk else {}
        views = mksequence.ride_pans(views, rides, parkinfo.track_pieces(tiles()), vehicles, heights, surface, box, opts, info, water)
        why = views[0].get("why", {})
        out["rides"] = why.get("rides", [])
        out["turnedDown"] = why.get("ridesTurnedDown", [])
    else:
        out["rides"], out["turnedDown"] = [], []
    return out


def line(p):
    run = p["rides"][0] if p["rides"] else None
    pick = ("ride %d %s: run %g tiles, %d px, fill %.2f, visible %.2f, edge %.2f, void %.2f, direction %+g, rot %d" % (
        run["ride"], repr(run["name"]) if run["name"] else "", run["run"], run["px"], run["fill"], run["visible"],
        run["edge"], run["void"], run["direction"], run["rotation"])) if run else "no run"
    down = p["turnedDown"]
    if down:
        failed = collections.Counter()
        for d in down:
            failed.update(d.get("failed", {}))
        pick += "; %d turned down (%s)" % (len(down), ", ".join("%s %d" % kv for kv in failed.most_common()))
    return "%-40s %4dx%-4d %6d tiles %7d elements %3d moving rides (largest %4d)  %s" % (
        p["name"][:40], p["map"][0], p["map"][1], p["builtTiles"], p["elements"], p["movingRides"], p["largestRide"], pick)


def parks_of(args):
    for item in args:
        if item.lower().endswith(".toml"):
            with open(item, "rb") as f:
                playlist = tomllib.load(f)
            base = os.path.dirname(os.path.abspath(item))
            for e in playlist.get("park", []):
                yield os.path.join(base, e["file"]), e.get("member")
        elif os.path.isdir(item):
            for n in sorted(os.listdir(item)):
                if n.lower().endswith((".park", ".zip")):
                    yield os.path.join(item, n), None
        else:
            yield item, None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("parks", nargs="+", help="a playlist .toml, park files, zips or folders")
    ap.add_argument("-o", "--out", default="build/ridesurvey.txt")
    ap.add_argument("--no-fill", action="store_true", help="skip the frame-fill rasters (faster; no ride_fill gate)")
    ap.add_argument("--set", action="append", default=[], metavar="OPTION=VALUE", help="a [views] option (TOML value)")
    args = ap.parse_args()
    opts = dict(mksequence.VIEW_DEFAULTS)
    for item in args.set:
        opts.update(tomllib.loads(item))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    results = []
    with open(args.out, "w", encoding="utf-8") as f:
        for path, member in parks_of(args.parks):
            start = time.time()
            try:
                p = survey(path, member, opts, not args.no_fill)
            except Exception as e:  # a park the reader cannot handle: note it and go on
                p = {"name": os.path.basename(path), "file": os.path.basename(path), "error": str(e)}
                text = "%-40s ERROR %s" % (p["name"][:40], e)
            else:
                text = line(p)
            p["seconds"] = round(time.time() - start, 1)
            results.append(p)
            print(text, flush=True)
            f.write(text + "\n")
            f.flush()
    with open(os.path.splitext(args.out)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=1)
    print("wrote %s (%d parks)" % (args.out, len(results)))


if __name__ == "__main__":
    main()
