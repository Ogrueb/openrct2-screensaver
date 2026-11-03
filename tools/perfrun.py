#!/usr/bin/env python3
"""Runs a performance-test suite (perf/*.toml) unattended and reports on it (tools/perfreport.py).

Every cell of the suite runs in its own sandbox: an OpenRCT2 user folder under the run folder,
started with `--user-data-path`, holding a copy of your config.ini with the cell's settings, a
link to your object folder, the screensaver plugin and the suite's playlist (built once per run
with mksequence.py, editor views ignored). Your own OpenRCT2 folder is only read. The game starts
in the screensaver mode with the perf log on (engine patch 0016) and quits itself after the
cell's time; a cell that does not quit is closed, and a crash (an exit code, or a new dump in the
sandbox's crash folder) is recorded and the run goes on.

Commands:
  run <suite.toml> --exe <openrct2.exe>   run every cell (repeats interleaved A B, B A, ...), then
                                          write report.md/report.json in the run folder
  sample <folder or playlist> --count N   write a playlist of N parks spread over simulation size
                                          (guests and ride vehicles read from the park files), for
                                          the survey and bench suites
  baseline <run folder> <suite name>      keep a run's report.json as perf/baselines/<suite>.json,
                                          which later runs of that suite are compared with

Run options: --engine NAME=PATH (more builds, chosen per cell with `engine = "NAME"`), --out DIR
(default build/perf), --user-dir DIR (your OpenRCT2 folder), --only CELL (repeatable),
--seconds N and --repeats N (override the suite), --dry-run (sandboxes and commands only).
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import perfreport  # noqa: E402
import userdata  # noqa: E402

STARTUP_GRACE_S = 120     # loading the first park, before the run's clock matters
CLOSE_GRACE_S = 30        # after a normal close, before the process is ended
CRASH_DIALOG_S = 10       # after a new crash dump, before the crash dialog is closed
WIN = sys.platform == "win32"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


# ---------------------------------------------------------------------------------------------
# Suites

def load_suite(path):
    with open(path, "rb") as f:
        suite = tomllib.load(f)
    suite["_path"] = os.path.abspath(path)
    suite.setdefault("name", os.path.splitext(os.path.basename(path))[0])
    suite.setdefault("seconds", 600)
    suite.setdefault("repeats", 1)
    suite.setdefault("warmup", 30)
    suite.setdefault("cooldown", 10)
    suite.setdefault("base", {})
    cells = suite.get("cell") or [{"name": "base"}]
    names = [c["name"] for c in cells]
    if len(set(names)) != len(names):
        raise ValueError("cell names must differ: %s" % names)
    suite["cells"] = [merge_cell(suite["base"], c) for c in cells]
    return suite


def merge_cell(base, cell):
    """The base settings with a cell's on top (tables merged a level deep)."""
    out = {"config": {}, "settings": {}, "build": {}, "flags": [], "engine": "default", "playlist": None}
    for src in (base, cell):
        for key, value in src.items():
            if key in ("config",):
                for section, values in value.items():
                    out["config"].setdefault(section, {}).update(values)
            elif key in ("settings", "build"):
                out[key].update(value)
            elif key == "flags":
                out["flags"] = out["flags"] + list(value)
            else:
                out[key] = value
    return out


def cell_order(cells, repeats):
    """(cell, repeat) in interleaved order: A B C, then C B A, and so on, so slow drift (heat,
    background work) lands on every cell alike."""
    order = []
    for r in range(repeats):
        seq = cells if r % 2 == 0 else list(reversed(cells))
        order += [(c, r) for c in seq]
    return order


# ---------------------------------------------------------------------------------------------
# Sandboxes

def ini_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return "%g" % value
    if isinstance(value, int):
        return str(value)
    text = str(value)
    if re.fullmatch(r"[A-Z_]+", text):  # an enum such as SOFTWARE_HWD or OPENGL, written bare
        return text
    return '"%s"' % text.replace("\\", "\\\\").replace('"', '\\"')


def patch_ini(text, overrides):
    """config.ini with {section: {key: value}} set, keeping everything else as it was."""
    lines = text.splitlines()
    for section, values in overrides.items():
        header = "[%s]" % section
        try:
            start = next(i for i, line in enumerate(lines) if line.strip().lower() == header.lower())
        except StopIteration:
            lines += ["", header]
            start = len(lines) - 1
        end = next((i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("[")), len(lines))
        for key, value in values.items():
            line = "%s = %s" % (key, ini_value(value))
            found = next((i for i in range(start + 1, end) if lines[i].split("=", 1)[0].strip() == key), None)
            if found is None:
                lines.insert(end, line)
                end += 1
            else:
                lines[found] = line
    return "\n".join(lines) + "\n"


def link_dir(link, target):
    """A directory link the game follows: a junction on Windows (needs no rights), else a symlink."""
    if not os.path.isdir(target):
        return False
    if WIN:
        subprocess.run(["cmd", "/c", "mklink", "/J", link, target], check=True, capture_output=True,
                       creationflags=NO_WINDOW)
    else:
        os.symlink(target, link, target_is_directory=True)
    return True


def remove_tree(path):
    """Removes a sandbox; a junction is removed as a link, never followed into the real folder."""
    if not os.path.exists(path):
        return
    for root, dirs, _files in os.walk(path, topdown=True):
        for d in list(dirs):
            full = os.path.join(root, d)
            if os.path.islink(full) or (WIN and is_junction(full)):
                os.rmdir(full) if WIN else os.unlink(full)
                dirs.remove(d)
    shutil.rmtree(path)


def is_junction(path):
    try:
        return bool(os.path.isjunction(path))  # Python 3.12+
    except AttributeError:
        return os.path.islink(path)


def make_sandbox(cell, cell_dir, user_dir, result_json, dry_run=False):
    sandbox = os.path.join(cell_dir, "user")
    os.makedirs(sandbox, exist_ok=True)
    real_ini = os.path.join(user_dir, "config.ini")
    text = ""
    if os.path.exists(real_ini):
        with open(real_ini, encoding="utf-8-sig", errors="replace") as f:
            text = f.read()
    with open(os.path.join(sandbox, "config.ini"), "w", encoding="utf-8") as f:
        f.write(patch_ini(text, cell["config"]))
    obj = os.path.join(sandbox, "object")
    if not os.path.exists(obj):
        link_dir(obj, os.path.join(user_dir, "object"))
    if result_json and not dry_run:
        mk = [sys.executable, os.path.join(HERE, "mksequence.py"), "--install-built", result_json,
              "--user-dir", sandbox, "--force"]
        subprocess.run(mk, check=True, capture_output=True, text=True, creationflags=NO_WINDOW)
    if cell.get("companions") is False:
        plugin_dir = os.path.join(sandbox, "plugin")
        for name in os.listdir(plugin_dir) if os.path.isdir(plugin_dir) else []:
            if name.startswith("rct-screensaver-companion-") and name.endswith(".js"):
                os.remove(os.path.join(plugin_dir, name))
    store_path = os.path.join(sandbox, "plugin.store.json")
    store = {}
    if os.path.exists(store_path):
        with open(store_path, encoding="utf-8") as f:
            store = json.load(f)
    ours = store.setdefault("RCTScreensaver", {})
    settings = ours.setdefault("settings", {})
    settings.update({"bench": True, "cameraLog": False, "shuffle": False, "debug": False})
    if cell.get("profiler"):
        settings["profilerExport"] = os.path.abspath(os.path.join(cell_dir, "profiler.csv"))
    settings.update(cell["settings"])
    ours.pop("visits", None)
    ours.pop("edits", None)
    with open(store_path, "w", encoding="utf-8") as f:
        json.dump(store, f)
    return sandbox


# ---------------------------------------------------------------------------------------------
# Running

def build_playlist(playlist, build_opts, out_dir):
    """Builds the playlist once with these [views] overrides; returns its result.json path."""
    os.makedirs(out_dir, exist_ok=True)
    cmd = [sys.executable, os.path.join(HERE, "mksequence.py"), playlist, "-o", out_dir, "--ignore-edits"]
    if build_opts.get("layout"):
        cmd += ["--layout", build_opts["layout"]]  # "stock": the title player alone, no plugin playback
    for key, value in sorted(build_opts.get("set", {}).items()):
        cmd += ["--set", "%s=%s" % (key, json.dumps(value))]
    log_path = os.path.join(out_dir, "mksequence.log")
    with open(log_path, "w", encoding="utf-8") as log:
        subprocess.run(cmd, check=True, stdout=log, stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
    results = glob.glob(os.path.join(out_dir, "*.result.json"))
    if len(results) != 1:
        raise RuntimeError("expected one build result in %s, found %d" % (out_dir, len(results)))
    return results[0]


def build_key(cell, suite_dir):
    playlist = os.path.normpath(os.path.join(suite_dir, cell["playlist"])) if cell["playlist"] else None
    blob = json.dumps({"playlist": playlist, "build": cell["build"]}, sort_keys=True)
    return playlist, hashlib.sha1(blob.encode()).hexdigest()[:8]


def crash_files(sandbox):
    folder = os.path.join(sandbox, "crash")
    return set(os.listdir(folder)) if os.path.isdir(folder) else set()


def close_process(proc, force=False):
    if proc.poll() is not None:
        return
    if WIN:
        args = ["taskkill", "/PID", str(proc.pid)] + (["/F", "/T"] if force else [])
        subprocess.run(args, capture_output=True, creationflags=NO_WINDOW)
    elif force:
        proc.kill()
    else:
        proc.terminate()


def run_cell(exe, cell, sandbox, cell_dir, seconds):
    perf_log = os.path.join(cell_dir, "perf.log")
    cmd = [exe, "--user-data-path", sandbox, "--screensaver", "--perf-log", perf_log,
           "--perf-quit-after", str(int(seconds))] + list(cell["flags"])
    info = {"command": cmd, "started": datetime.datetime.now().isoformat(timespec="seconds")}
    before = crash_files(sandbox)
    with open(os.path.join(cell_dir, "stdout.log"), "w") as out, open(os.path.join(cell_dir, "stderr.log"), "w") as err:
        start = time.monotonic()
        proc = subprocess.Popen(cmd, stdout=out, stderr=err, cwd=os.path.dirname(exe) or None)
        deadline = start + seconds + STARTUP_GRACE_S
        closed = None
        crash_seen = None
        while proc.poll() is None:
            time.sleep(1)
            now = time.monotonic()
            new = crash_files(sandbox) - before
            if new and crash_seen is None:
                crash_seen = now
            if crash_seen is not None and now - crash_seen > CRASH_DIALOG_S:
                close_process(proc, force=True)
                closed = "crash dialog"
            elif now > deadline and closed is None:
                close_process(proc)
                closed = "timeout"
            elif closed == "timeout" and now > deadline + CLOSE_GRACE_S:
                close_process(proc, force=True)
                closed = "forced"
        info["exit"] = proc.returncode
        info["seconds"] = round(time.monotonic() - start, 1)
    info["closed"] = closed
    info["crash"] = sorted(crash_files(sandbox) - before)
    info["crashed"] = bool(info["crash"]) or closed == "crash dialog" or (proc.returncode not in (0, None) and closed is None)
    return info


def machine_info(exes):
    info = {"platform": platform.platform(), "processor": platform.processor(), "python": platform.python_version(),
            "machine": platform.node()}
    try:
        info["commit"] = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True,
                                        text=True, creationflags=NO_WINDOW).stdout.strip()
    except OSError:
        pass
    for name, exe in exes.items():
        if os.path.exists(exe):
            with open(exe, "rb") as f:
                info["engine " + name] = "%s (sha1 %s)" % (exe, hashlib.sha1(f.read()).hexdigest()[:12])
    if WIN:
        def ps(command):
            try:
                return subprocess.run(["powershell", "-NoProfile", "-Command", command], capture_output=True, text=True,
                                      timeout=30, creationflags=NO_WINDOW).stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                return ""
        info["gpu"] = ps("(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + ' ' + $_.DriverVersion }) -join '; '")
        info["power plan"] = ps("powercfg /getactivescheme")
        info["busy processes"] = ps("Get-Process | Where-Object { $_.CPU -gt 600 } | Sort-Object CPU -Descending | "
                                    "Select-Object -First 8 | ForEach-Object { $_.ProcessName } | Out-String")
    return info


def cmd_run(args):
    suite = load_suite(args.suite)
    suite_dir = os.path.dirname(suite["_path"])
    exes = {"default": os.path.abspath(args.exe)} if args.exe else {}
    for item in args.engine:
        name, _, path = item.partition("=")
        exes[name] = os.path.abspath(path)
    cells = [c for c in suite["cells"] if not args.only or c["name"] in args.only]
    for c in cells:
        c["playlist"] = c["playlist"] or suite.get("playlist")
        if c["engine"] not in exes and not args.dry_run:
            raise SystemExit("cell %s needs engine %r: pass --exe or --engine %s=PATH" % (c["name"], c["engine"], c["engine"]))
    seconds = args.seconds or suite["seconds"]
    repeats = args.repeats or suite["repeats"]
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = os.path.abspath(os.path.join(args.out, "%s-%s" % (suite["name"], stamp)))
    os.makedirs(run_dir)
    shutil.copy2(suite["_path"], os.path.join(run_dir, "suite.toml"))
    user_dir = args.user_dir or userdata.openrct2_dir()
    meta = {"suite": suite["name"], "seconds": seconds, "repeats": repeats, **machine_info(exes)}
    with open(os.path.join(run_dir, "run.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)

    # One build per playlist and build options.
    builds = {}
    for c in cells:
        playlist, key = build_key(c, suite_dir)
        if playlist and key not in builds:
            print("building %s (%s)" % (os.path.basename(playlist), key), flush=True)
            builds[key] = None if args.dry_run else build_playlist(playlist, c["build"], os.path.join(run_dir, "build", key))
        c["_result"] = builds.get(key)

    order = cell_order(cells, repeats)
    total_s = len(order) * (seconds + 30 + suite["cooldown"])
    print("%d runs of %d s: about %d min" % (len(order), seconds, round(total_s / 60)), flush=True)
    for i, (cell, repeat) in enumerate(order):
        cell_dir = os.path.join(run_dir, "cells", "%s-r%d" % (cell["name"], repeat))
        os.makedirs(cell_dir)
        sandbox = make_sandbox(cell, cell_dir, user_dir, cell["_result"], args.dry_run)
        exe = exes.get(cell["engine"], "openrct2")
        meta = {"cell": cell["name"], "repeat": repeat, "suite": suite["name"], "engine": cell["engine"],
                "config": cell["config"], "settings": cell["settings"], "build": cell["build"], "flags": cell["flags"]}
        print("[%d/%d] %s r%d" % (i + 1, len(order), cell["name"], repeat), flush=True)
        if args.dry_run:
            meta["command"] = [exe, "--user-data-path", sandbox, "--screensaver", "--perf-log",
                               os.path.join(cell_dir, "perf.log"), "--perf-quit-after", str(seconds)] + cell["flags"]
            print("  " + " ".join(meta["command"]))
        else:
            meta.update(run_cell(exe, cell, sandbox, cell_dir, seconds))
            print("  exit %s after %s s%s" % (meta["exit"], meta["seconds"], "  CRASHED" if meta["crashed"] else ""), flush=True)
        with open(os.path.join(cell_dir, "cell.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=1)
        if not args.keep_sandboxes and not args.dry_run and not meta.get("crashed"):
            remove_tree(sandbox)
        if not args.dry_run and i + 1 < len(order):
            time.sleep(suite["cooldown"])

    if args.dry_run:
        print("dry run: sandboxes in %s" % run_dir)
        return 0
    report_args = [run_dir, "--warmup", str(suite["warmup"]), "--quiet"]
    if suite.get("pairs"):
        report_args += ["--pairs", json.dumps(suite["pairs"])]
    baseline = args.baseline or os.path.join(REPO, "perf", "baselines", "%s.json" % suite["name"])
    if os.path.exists(baseline):
        report_args += ["--compare", baseline]
    code = perfreport.main(report_args)
    print("report: %s" % os.path.join(run_dir, "report.md"))
    return code


# ---------------------------------------------------------------------------------------------
# Park samples

def park_size(path, member=None):
    """Simulation and drawn size of a park, read from the file (no game needed)."""
    import mksequence
    import parkinfo
    member, data = parkinfo.read_park_bytes(path, member)
    hdr, chunks, body = parkinfo.load(data)
    park = parkinfo.parse_park(parkinfo.chunk_reader(chunks, body, 6), hdr["target"])
    vehicles = parkinfo.parse_vehicles(parkinfo.chunk_reader(chunks, body, 0x31))
    rides_chunk = parkinfo.chunk_reader(chunks, body, 0x32)
    rides = rides_chunk.array_header()[0] if rides_chunk else 0
    tiles = lambda: parkinfo.chunk_reader(chunks, body, 0x30)  # noqa: E731
    _, counts, _, _ = parkinfo.visible_element_counts(tiles())
    w, h = mksequence.map_size(tiles())
    return {"file": path, "member": member, "name": parkinfo.display_name(park["name"], path, member)[0],
            "guests": park["guestsInPark"], "vehicles": len(vehicles), "rides": rides,
            "simulation": park["guestsInPark"] + len(vehicles), "map": [w, h],
            "builtTiles": len(counts), "elements": sum(counts.values())}


def spread(items, count, key):
    """count items spread evenly over key's rank (both ends included)."""
    items = sorted(items, key=key)
    if len(items) <= count:
        return items
    picks = sorted({round(i * (len(items) - 1) / (count - 1)) for i in range(count)})
    return [items[i] for i in picks]


def park_paths(source):
    if source.endswith(".toml"):
        with open(source, "rb") as f:
            playlist = tomllib.load(f)
        base = os.path.dirname(os.path.abspath(source))
        return [(os.path.normpath(os.path.join(base, p["file"])), p.get("member")) for p in playlist.get("park", [])]
    out = []
    for name in sorted(os.listdir(source)):
        if name.lower().endswith((".park", ".zip")):
            out.append((os.path.join(source, name), None))
    return out


SAMPLE_VIEWS = """[views]
# Survey: an overview and four close-ups from zoom -2 to 1, held still and cut, 15 s each.
method = "spots"
count = 5
base_views = 5
park_time = 75.0
view_time = 15.0
overview_time = 0.0
overview_lead = 0.0
zoom_min = -2
zoom_max = 1
motion = "static"
pan = 0
park_cap = 600
"""


def cmd_sample(args):
    sizes = []
    for path, member in park_paths(args.source):
        try:
            sizes.append(park_size(path, member))
            s = sizes[-1]
            print("%-40s guests %5d vehicles %4d tiles %6d" % (s["name"][:40], s["guests"], s["vehicles"], s["builtTiles"]), flush=True)
        except Exception as e:  # a park this reader can't parse is left out of the sample
            print("skipped %s: %s" % (os.path.basename(path), e), flush=True)
    picks = spread(sizes, args.count, key=lambda s: s["simulation"])
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    lines = ["# Written by tools/perfrun.py sample: %d of %d parks spread over simulation size (guests + ride vehicles)."
             % (len(picks), len(sizes)),
             'name = "RCT Screensaver Perf %s"' % os.path.splitext(os.path.basename(out))[0].title(),
             'order = "playlist"', 'layout = "plugin"', "park_plugins = false", "park_scripts = %s" % ("true" if args.scripts else "false"), ""]
    lines += [SAMPLE_VIEWS if args.survey_views else "", ""]
    for s in picks:
        rel = os.path.relpath(s["file"], os.path.dirname(out)).replace("\\", "/")
        lines += ["[[park]]", 'file = "%s"' % rel]
        if s["member"] and s["file"].lower().endswith(".zip"):
            lines.append('member = "%s"' % s["member"])
        lines += ["# guests %d, ride vehicles %d, rides %d, map %dx%d, built tiles %d, elements %d" % (
            s["guests"], s["vehicles"], s["rides"], s["map"][0], s["map"][1], s["builtTiles"], s["elements"]), ""]
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    with open(os.path.splitext(out)[0] + ".sizes.json", "w", encoding="utf-8") as f:
        json.dump(sizes, f, indent=1)
    print("wrote %s (%d parks)" % (out, len(picks)))
    return 0


def cmd_baseline(args):
    src = os.path.join(args.run, "report.json")
    if not os.path.exists(src):
        raise SystemExit("no report.json in %s" % args.run)
    dest = os.path.join(REPO, "perf", "baselines", "%s.json" % args.suite)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(src, encoding="utf-8") as f:
        report = json.load(f)
    report.pop("details", None)  # the per-cell summaries are what a comparison needs
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    print("baseline for %s: %s" % (args.suite, dest))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a suite")
    run.add_argument("suite")
    run.add_argument("--exe", help="openrct2.exe of the patched build (engine \"default\")")
    run.add_argument("--engine", action="append", default=[], metavar="NAME=PATH", help="another build, for cells with engine = NAME")
    run.add_argument("--out", default=os.path.join(REPO, "build", "perf"))
    run.add_argument("--user-dir", help="your OpenRCT2 folder (default: %s)" % userdata.openrct2_dir())
    run.add_argument("--only", action="append", help="run only this cell (repeatable)")
    run.add_argument("--seconds", type=int, help="seconds per cell (overrides the suite)")
    run.add_argument("--repeats", type=int, help="repeats per cell (overrides the suite)")
    run.add_argument("--baseline", help="report.json to compare with (default perf/baselines/<suite>.json)")
    run.add_argument("--keep-sandboxes", action="store_true", help="keep each cell's user folder (crashed cells always keep theirs)")
    run.add_argument("--dry-run", action="store_true", help="make the sandboxes and print the commands, run nothing")
    sample = sub.add_parser("sample", help="write a playlist of parks spread over simulation size")
    sample.add_argument("source", help="a folder of .park/.zip files, or a playlist")
    sample.add_argument("--count", type=int, default=20)
    sample.add_argument("--out", default=os.path.join(REPO, "perf", "local", "survey.toml"))
    sample.add_argument("--survey-views", action="store_true", help="add the survey's [views]: overview and four still close-ups, 15 s each")
    sample.add_argument("--scripts", action="store_true", help="run the parks' companion plugins")
    base = sub.add_parser("baseline", help="keep a run's report as the suite's baseline")
    base.add_argument("run")
    base.add_argument("suite")
    args = ap.parse_args(argv)
    return {"run": cmd_run, "sample": cmd_sample, "baseline": cmd_baseline}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
