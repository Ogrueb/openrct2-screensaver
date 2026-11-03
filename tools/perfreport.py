#!/usr/bin/env python3
"""Numbers from engine perf logs (`openrct2 --perf-log`, engine patch 0016), for performance tests.

Reads one perf log, or a run folder written by tools/perfrun.py (one sub-folder per cell and
repeat, each with `perf.log` and `cell.json`), and writes `report.md` and `report.json` next to
it. With --compare it sets each cell against the cell of the same name in another run (a run
folder, or a `report.json` kept as a baseline) and says which differences are larger than the
spread between repeats.

Frames are labelled from the log alone: still or panning (the camera moved since the previous
frame), zoom and rotation (the main viewport, every frame), park and view (the plugin's marks),
and park switches (the frame during which a load event was written). Frames before the first
view, during the first `--warmup` seconds and within a second of mouse input are left out.

Per group of frames it gives frames per second, the frame interval's p50/p95/p99, the share of
frames that missed a 25 ms tick (interval over 1.5 ticks), ticks per second (under 40 means the
simulation fell behind), and the work per frame split into simulation (tick minus plugin),
plugin, input, paint and present. Work is the time spent, not the time waited, so it shows
headroom under the 25 ms budget even when the frame rate is capped at 40.

Memory: growth per hour and per park switch (least squares after warm-up), the image list's
largest free run, the QuickJS heap, and the working set on each revisit of a park.

Usage: python3 tools/perfreport.py <run folder or perf.log> [--compare <run folder or report.json>]
       [--warmup 30] [--threshold 5] [--quiet]
"""

import argparse
import json
import math
import os
import re
import statistics
import sys
from collections import defaultdict

TICK_MS = 25.0
MISSED = 1.5 * TICK_MS          # an interval this long means at least one 40 fps frame was missed
INPUT_EXCLUDE_MS = 1000.0       # frames this long after a mouse input mark are left out
STAGES = ("sim", "script", "input", "paint", "present")
STAGE_RE = re.compile(r"\s(\w+)=([\d.]+)ms")
VALUES_RE = re.compile(r"(\w+)=(\S+)")

FRAME_FIELDS = ("t", "interval", "ticks", "tick", "script", "input", "paint", "present", "vx", "vy", "zoom", "rot")
SAMPLE_FIELDS = ("t", "sample_ms", "private", "working", "handles", "gdi", "js_malloc", "js_used",
                 "img_used", "img_free_runs", "img_largest", "guests", "staff", "vehicles", "litter",
                 "entities", "rides")


# ---------------------------------------------------------------------------------------------
# Reading

class Log:
    """One perf log: config, frames (dicts), samples (dicts) and events (t, kind, text)."""

    def __init__(self):
        self.config = {}
        self.frames = []
        self.samples = []
        self.events = []
        self.bad_lines = 0


def parse_log(lines):
    log = Log()
    for line in lines:
        line = line.rstrip("\r\n")
        if not line or line.startswith("#"):
            continue
        kind = line[:1]
        try:
            if kind == "F":
                parts = line.split(",")
                if len(parts) != 13:
                    raise ValueError("short frame line")
                vals = [float(x) for x in parts[1:9]] + [int(x) for x in parts[9:13]]
                log.frames.append(dict(zip(FRAME_FIELDS, vals)))
            elif kind == "M":
                parts = line.split(",")
                if len(parts) != 18:
                    raise ValueError("short sample line")
                vals = [float(parts[1]), float(parts[2])] + [int(x) for x in parts[3:18]]
                log.samples.append(dict(zip(SAMPLE_FIELDS, vals)))
            elif kind == "E":
                _, t, ekind, text = line.split(",", 3)
                log.events.append((float(t), ekind, text))
            elif kind == "C":
                _, t, text = line.split(",", 2)
                log.config.update(dict(kv.split("=", 1) for kv in text.split() if "=" in kv))
            else:
                log.bad_lines += 1
        except (ValueError, IndexError):
            log.bad_lines += 1   # a line cut short by a crash or a forced stop
    return log


def read_log(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return parse_log(f)


def parse_load(text):
    """A load event's text: '<park> read=..ms objects=..ms ... total=..ms' → (park, {stage: ms})."""
    m = STAGE_RE.search(" " + text)
    park = text[:m.start() - 1].strip() if m else text.strip()
    stages = {k: float(v) for k, v in STAGE_RE.findall(" " + text)}
    return park, stages


# ---------------------------------------------------------------------------------------------
# Labelling frames

def label_frames(log, warmup_s=30.0):
    """Adds park, view, overview, motion, switch and keep to every frame."""
    marks = sorted((t, text) for t, kind, text in log.events if kind == "mark")
    loads = sorted(t for t, kind, _ in log.events if kind == "load")
    samples = sorted((s["t"], s["sample_ms"]) for s in log.samples)
    inputs = [t for t, text in marks if text.startswith("input")]

    # Without view marks (the stock title player, plugin off) every frame after warm-up counts.
    park, view, overview = None, None, False
    seen_view = not any(text.startswith("view ") for _, text in marks)
    mi = li = si = ii = 0
    prev = None
    start = log.frames[0]["t"] if log.frames else 0.0
    for f in log.frames:
        t = f["t"]
        begin = t - f["interval"]
        while mi < len(marks) and marks[mi][0] <= t:
            text = marks[mi][1]
            if text.startswith("park "):
                rest = text[5:]
                park = rest.split(" ", 1)[1] if " " in rest else rest
            elif text.startswith("view "):
                body, _, name = text[5:].partition(" | ")
                v = dict(VALUES_RE.findall(body))
                view = v.get("view", "?").split("/")[0]
                overview = "overview" in body.split()
                if name.strip():
                    park = name.strip()
                seen_view = True
            mi += 1
        # A load event written during this frame: the frame holds the switch.
        switch = False
        while li < len(loads) and loads[li] <= t:
            if loads[li] > begin:
                switch = True
            li += 1
        # A sample written after the previous frame lands in this frame's interval: take it out.
        while si < len(samples) and samples[si][0] <= begin + 1e-6:
            if prev is not None and samples[si][0] >= prev["t"] - 1e-6:
                f["interval"] = max(0.0, f["interval"] - samples[si][1])
            si += 1
        while ii < len(inputs) and inputs[ii] + INPUT_EXCLUDE_MS < t:
            ii += 1
        recent_input = ii < len(inputs) and inputs[ii] <= t
        moved = prev is not None and (f["vx"], f["vy"], f["zoom"], f["rot"]) != (prev["vx"], prev["vy"], prev["zoom"], prev["rot"])
        f["park"] = park
        f["view"] = view
        f["overview"] = overview
        f["motion"] = "pan" if moved else "still"
        f["switch"] = switch
        f["sim"] = max(0.0, f["tick"] - f["script"])
        f["work"] = f["tick"] + f["input"] + f["paint"] + f["present"]
        f["keep"] = (seen_view and t - start >= warmup_s * 1000.0 and not recent_input and prev is not None)
        prev = f
    return log.frames


# ---------------------------------------------------------------------------------------------
# Statistics

def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (k - lo)


def rnd(x, n=2):
    return None if x is None else round(x, n)


def frame_stats(frames):
    """Numbers for a group of frames (already filtered)."""
    if not frames:
        return None
    intervals = [f["interval"] for f in frames]
    seconds = sum(intervals) / 1000.0
    ticks = sum(f["ticks"] for f in frames)
    work = [f["work"] for f in frames]
    out = {
        "frames": len(frames),
        "seconds": rnd(seconds, 1),
        "fps": rnd(len(frames) / seconds if seconds > 0 else None, 1),
        "ticks_per_s": rnd(ticks / seconds if seconds > 0 else None, 1),
        "interval_p50": rnd(pct(intervals, 50)),
        "interval_p95": rnd(pct(intervals, 95)),
        "interval_p99": rnd(pct(intervals, 99)),
        "interval_max": rnd(max(intervals)),
        "missed_share": rnd(sum(1 for i in intervals if i > MISSED) / len(frames), 4),
        "work_p50": rnd(pct(work, 50)),
        "work_p95": rnd(pct(work, 95)),
        "work_p99": rnd(pct(work, 99)),
    }
    for s in STAGES:
        vals = [f[s] for f in frames]
        out[s + "_mean"] = rnd(statistics.fmean(vals))
        out[s + "_p95"] = rnd(pct(vals, 95))
    return out


def worst_frames(frames, n=5):
    out = []
    for f in sorted(frames, key=lambda f: -f["interval"])[:n]:
        out.append({"t_s": rnd(f["t"] / 1000.0, 1), "interval": rnd(f["interval"]), "park": f["park"],
                    "view": f["view"], "zoom": f["zoom"], "motion": f["motion"], "switch": f["switch"],
                    **{s: rnd(f[s]) for s in STAGES}})
    return out


def linear_fit(xs, ys):
    """Slope and intercept of a least-squares line, or (None, None)."""
    if len(xs) < 3:
        return None, None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None, None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return slope, my - slope * mx


def correlation(xs, ys):
    if len(xs) < 3:
        return None
    try:
        return statistics.correlation(xs, ys)
    except (statistics.StatisticsError, AttributeError):
        return None


MB = 1024.0 * 1024.0


def memory_stats(log, warmup_s=30.0):
    samples = [s for s in log.samples if s["t"] >= warmup_s * 1000.0] or log.samples
    if not samples:
        return None
    loads = sorted(t for t, kind, _ in log.events if kind == "load")
    hours = [s["t"] / 3600000.0 for s in samples]
    private = [s["private"] / MB for s in samples]
    slope_h, _ = linear_fit(hours, private)
    switches = [sum(1 for t in loads if t <= s["t"]) for s in samples]
    slope_sw, _ = linear_fit(switches, private) if len(set(switches)) > 2 else (None, None)
    js = [s["js_malloc"] / MB for s in samples]
    js_slope, _ = linear_fit(hours, js)
    out = {
        "samples": len(samples),
        "hours": rnd(hours[-1] - hours[0], 2),
        "private_mb_first": rnd(private[0], 1),
        "private_mb_last": rnd(private[-1], 1),
        "private_mb_max": rnd(max(private), 1),
        "private_mb_per_hour": rnd(slope_h, 1),
        "private_mb_per_switch": rnd(slope_sw, 3),
        "working_mb_last": rnd(samples[-1]["working"] / MB, 1),
        "handles_first": samples[0]["handles"], "handles_last": samples[-1]["handles"],
        "gdi_first": samples[0]["gdi"], "gdi_last": samples[-1]["gdi"],
        "js_mb_first": rnd(js[0], 2), "js_mb_last": rnd(js[-1], 2), "js_mb_per_hour": rnd(js_slope, 2),
        "img_used_last": samples[-1]["img_used"],
        "img_largest_free_min": min(s["img_largest"] for s in samples),
        "img_free_runs_max": max(s["img_free_runs"] for s in samples),
        "switches": len(loads),
    }
    # Revisits: the first sample after each load of a park, per park, in order.
    revisits = defaultdict(list)
    for t in loads:
        park = next((parse_load(text)[0] for tt, kind, text in log.events if kind == "load" and tt == t), None)
        after = next((s for s in samples if s["t"] >= t), None)
        if park and after:
            revisits[park].append(rnd(after["private"] / MB, 1))
    growing = {p: v for p, v in revisits.items() if len(v) >= 3 and all(b > a for a, b in zip(v, v[1:]))}
    out["revisit_private_mb"] = {p: v for p, v in revisits.items() if len(v) >= 2}
    out["growing_on_revisit"] = sorted(growing)
    return out


def sim_size(log):
    """Mean simulation counts per park, from the samples (labelled by the latest park mark)."""
    marks = sorted((t, text) for t, kind, text in log.events if kind == "mark")
    per = defaultdict(list)
    for s in log.samples:
        park = None
        for t, text in marks:
            if t > s["t"]:
                break
            if text.startswith("park "):
                rest = text[5:]
                park = rest.split(" ", 1)[1] if " " in rest else rest
        if park:
            per[park].append(s)
    out = {}
    for park, ss in per.items():
        out[park] = {k: round(statistics.fmean(s[k] for s in ss)) for k in ("guests", "staff", "vehicles", "entities", "rides")}
    return out


def switches(log):
    out = []
    for t, kind, text in log.events:
        if kind == "load":
            park, stages = parse_load(text)
            out.append({"t_s": rnd(t / 1000.0, 1), "park": park, **stages})
    return out


def analyse_log(log, warmup_s=30.0):
    frames = label_frames(log, warmup_s)
    kept = [f for f in frames if f["keep"]]
    play = [f for f in kept if not f["switch"]]
    groups = {"all": frame_stats(play)}
    for motion in ("still", "pan"):
        groups[motion] = frame_stats([f for f in play if f["motion"] == motion])
    zooms = sorted({f["zoom"] for f in play})
    for z in zooms:
        for motion in ("still", "pan"):
            groups["zoom %d %s" % (z, motion)] = frame_stats([f for f in play if f["zoom"] == z and f["motion"] == motion])
    groups["overview"] = frame_stats([f for f in play if f["overview"]])
    groups = {k: v for k, v in groups.items() if v}

    per_park = {}
    for park in sorted({f["park"] for f in play if f["park"]}):
        pf = [f for f in play if f["park"] == park]
        st = frame_stats(pf)
        st["by_zoom"] = {str(z): frame_stats([f for f in pf if f["zoom"] == z]) for z in sorted({f["zoom"] for f in pf})}
        per_park[park] = st

    views = []
    by_view = defaultdict(list)
    for f in play:
        by_view[(f["park"], f["view"], f["zoom"])].append(f)
    for (park, view, zoom), vf in by_view.items():
        st = frame_stats(vf)
        if st["frames"] >= 40:
            views.append({"park": park, "view": view, "zoom": zoom, **st})
    views.sort(key=lambda v: -(v["work_p95"] or 0))

    sizes = sim_size(log)
    fits = {}
    parks_with = [p for p in per_park if p in sizes]
    if len(parks_with) >= 3:
        ent = [sizes[p]["entities"] for p in parks_with]
        fits["sim_vs_entities_r"] = rnd(correlation(ent, [per_park[p]["sim_mean"] for p in parks_with]), 3)
        slope, _ = linear_fit(ent, [per_park[p]["sim_mean"] for p in parks_with])
        fits["sim_ms_per_1000_entities"] = rnd(slope * 1000 if slope is not None else None, 3)
        guests = [sizes[p]["guests"] for p in parks_with]
        fits["sim_vs_guests_r"] = rnd(correlation(guests, [per_park[p]["sim_mean"] for p in parks_with]), 3)

    return {
        "config": log.config,
        "frames_total": len(frames), "frames_kept": len(kept), "bad_lines": log.bad_lines,
        "ended": next((kind for _, kind, _ in reversed(log.events) if kind in ("quit", "exit")), "unknown"),
        "groups": groups,
        "parks": per_park,
        "sim_size": sizes,
        "fits": fits,
        "worst_views": views[:10],
        "worst_frames": worst_frames(play),
        "switches": switches(log),
        "switch_frames": [rnd(f["interval"]) for f in kept if f["switch"]],
        "memory": memory_stats(log, warmup_s),
    }


# ---------------------------------------------------------------------------------------------
# Runs: cells and repeats

def find_cells(path):
    """[(cell name, repeat, perf.log path, cell.json dict)] for a run folder, or one log file."""
    if os.path.isfile(path):
        return [(os.path.splitext(os.path.basename(path))[0], 0, path, {})]
    out = []
    for root, _dirs, files in os.walk(path):
        if "perf.log" in files:
            meta = {}
            if "cell.json" in files:
                with open(os.path.join(root, "cell.json"), encoding="utf-8") as f:
                    meta = json.load(f)
            name = meta.get("cell") or os.path.basename(root)
            out.append((name, meta.get("repeat", 0), os.path.join(root, "perf.log"), meta))
    out.sort(key=lambda c: (c[0], c[1]))
    return out


HEADLINE = ("fps", "missed_share", "interval_p95", "work_p50", "work_p95", "sim_mean", "script_mean",
            "paint_mean", "present_mean", "ticks_per_s")


def summarise_cell(results):
    """Repeats of one cell → the median of each headline number per group, and its spread."""
    groups = defaultdict(lambda: defaultdict(list))
    for r in results:
        for g, st in r["groups"].items():
            for k in HEADLINE:
                if st.get(k) is not None:
                    groups[g][k].append(st[k])
    out = {}
    for g, metrics in groups.items():
        out[g] = {k: {"median": rnd(statistics.median(v), 4), "spread": rnd(max(v) - min(v), 4), "n": len(v)}
                  for k, v in metrics.items()}
    return out


def analyse_run(path, warmup_s=30.0):
    cells = find_cells(path)
    by_cell = defaultdict(list)
    details = {}
    for name, repeat, log_path, meta in cells:
        result = analyse_log(read_log(log_path), warmup_s)
        result["repeat"] = repeat
        result["meta"] = meta
        result["exit"] = meta.get("exit")
        by_cell[name].append(result)
        details["%s#%d" % (name, repeat)] = result
    report = {"run": os.path.abspath(path), "warmup_s": warmup_s,
              "cells": {name: summarise_cell(rs) for name, rs in by_cell.items()},
              "details": details}
    meta_path = os.path.join(path, "run.json") if os.path.isdir(path) else None
    if meta_path and os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            report["meta"] = json.load(f)
    return report


# Lower is better for every headline number but fps and ticks per second.
HIGHER_BETTER = {"fps", "ticks_per_s"}


def compare(a, b, threshold_pct=5.0):
    """Cells present in both reports: per group and headline number, B against A."""
    rows = []
    for cell in sorted(set(a["cells"]) & set(b["cells"])):
        for group in sorted(set(a["cells"][cell]) & set(b["cells"][cell])):
            ga, gb = a["cells"][cell][group], b["cells"][cell][group]
            for k in HEADLINE:
                if k not in ga or k not in gb:
                    continue
                va, vb = ga[k]["median"], gb[k]["median"]
                if va is None or vb is None:
                    continue
                diff = vb - va
                rel = (diff / va * 100.0) if va else None
                noise = max(ga[k]["spread"], gb[k]["spread"])
                if abs(diff) <= noise or rel is None or abs(rel) < threshold_pct:
                    verdict = "same"
                else:
                    better = (diff > 0) == (k in HIGHER_BETTER)
                    verdict = "better" if better else "worse"
                rows.append({"cell": cell, "group": group, "metric": k, "a": va, "b": vb,
                             "change_pct": rnd(rel, 1), "noise": noise, "verdict": verdict})
    return rows


def compare_pairs(report, pairs, threshold_pct=5.0):
    """Suite-defined A/B pairs inside one run: [[cell A, cell B], ...]."""
    out = []
    for pair in pairs:
        ca, cb = pair[0], pair[1]
        if ca in report["cells"] and cb in report["cells"]:
            a = {"cells": {"x": report["cells"][ca]}}
            b = {"cells": {"x": report["cells"][cb]}}
            for row in compare(a, b, threshold_pct):
                row["cell"] = "%s → %s" % (ca, cb)
                out.append(row)
    return out


# ---------------------------------------------------------------------------------------------
# Markdown

def fmt(v, digits=1):
    if v is None:
        return "–"
    if isinstance(v, float):
        return ("%." + str(digits) + "f") % v
    return str(v)


def table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join(fmt(c) for c in row) + " |" for row in rows]
    return "\n".join(lines)


def markdown(report, comparison=None, pairs=None):
    out = ["# Performance report", "", "Run: `%s` (warm-up %g s left out)." % (report["run"], report["warmup_s"]), ""]
    meta = report.get("meta") or {}
    if meta:
        out += ["Machine and build: " + ", ".join("%s %s" % (k, v) for k, v in meta.items()
                                                    if isinstance(v, (str, int, float))), ""]
    out += ["## Cells", "",
            "Medians over repeats; work = time spent per frame (simulation, plugin, input, paint, present), "
            "against a 25 ms budget. Missed = share of frames over 37.5 ms.", ""]
    rows = []
    for cell, groups in sorted(report["cells"].items()):
        for g in ("all", "still", "pan"):
            if g in groups:
                m = groups[g]
                rows.append([cell, g] + [m.get(k, {}).get("median") for k in
                                          ("fps", "missed_share", "work_p50", "work_p95", "sim_mean", "script_mean", "paint_mean", "present_mean", "ticks_per_s")]
                            + [max(m[k]["n"] for k in m)])
    out += [table(["cell", "group", "fps", "missed", "work p50", "work p95", "sim", "plugin", "paint", "present", "ticks/s", "runs"], rows), ""]

    for key, d in sorted(report["details"].items()):
        out += ["## %s" % key, ""]
        cfg = d["config"]
        if cfg:
            out += ["Config: " + " ".join("%s=%s" % kv for kv in sorted(cfg.items())), ""]
        out += ["Frames kept %d of %d; ended by %s%s." % (d["frames_kept"], d["frames_total"], d["ended"],
                "; exit code %s" % d["exit"] if d.get("exit") not in (None, 0) else ""), ""]
        zrows = [[g, st["frames"], st["fps"], st["missed_share"], st["work_p50"], st["work_p95"], st["sim_mean"],
                  st["paint_mean"], st["present_mean"]] for g, st in d["groups"].items()
                 if (g.startswith("zoom") or g == "overview") and st["frames"] >= 40]
        if zrows:
            out += [table(["group", "frames", "fps", "missed", "work p50", "work p95", "sim", "paint", "present"], zrows), ""]
        if d["parks"]:
            prow = []
            for park, st in sorted(d["parks"].items(), key=lambda kv: -(kv[1]["work_p95"] or 0)):
                size = d["sim_size"].get(park, {})
                prow.append([park, size.get("guests"), size.get("vehicles"), size.get("entities"), st["fps"],
                             st["missed_share"], st["work_p95"], st["sim_mean"], st["paint_mean"]])
            out += ["Parks, slowest first:", "", table(["park", "guests", "vehicles", "entities", "fps", "missed",
                                                        "work p95", "sim", "paint"], prow), ""]
        if d["fits"]:
            out += ["Simulation against size: " + ", ".join("%s %s" % kv for kv in d["fits"].items()), ""]
        if d["worst_views"]:
            out += ["Slowest views:", "", table(["park", "view", "zoom", "work p95", "missed", "paint", "sim"],
                                                [[v["park"], v["view"], v["zoom"], v["work_p95"], v["missed_share"],
                                                  v["paint_mean"], v["sim_mean"]] for v in d["worst_views"][:5]]), ""]
        if d["switches"]:
            sw = d["switches"]
            totals = [s.get("total") for s in sw if s.get("total") is not None]
            out += ["Park switches: %d, main-thread total p50 %s ms, max %s ms; switch frames p50 %s ms, max %s ms." % (
                len(sw), fmt(pct(totals, 50)), fmt(max(totals) if totals else None),
                fmt(pct(d["switch_frames"], 50)), fmt(max(d["switch_frames"]) if d["switch_frames"] else None)), ""]
        mem = d["memory"]
        if mem:
            out += ["Memory over %s h: private %s → %s MB (%s MB/h, %s MB per switch over %d switches), "
                    "QuickJS %s → %s MB, image list largest free run min %s, handles %s → %s, GDI %s → %s." % (
                        fmt(mem["hours"], 2), fmt(mem["private_mb_first"]), fmt(mem["private_mb_last"]),
                        fmt(mem["private_mb_per_hour"]), fmt(mem["private_mb_per_switch"], 3), mem["switches"],
                        fmt(mem["js_mb_first"], 2), fmt(mem["js_mb_last"], 2), mem["img_largest_free_min"],
                        mem["handles_first"], mem["handles_last"], mem["gdi_first"], mem["gdi_last"]), ""]
            if mem["growing_on_revisit"]:
                out += ["Grows on every revisit: " + ", ".join(mem["growing_on_revisit"]), ""]

    for title, rows in (("Comparison with the earlier run", comparison), ("A/B pairs", pairs)):
        if rows:
            changed = [r for r in rows if r["verdict"] != "same"]
            out += ["## " + title, "", "%d numbers compared, %d changed beyond the repeats' spread and the threshold." % (
                len(rows), len(changed)), ""]
            if changed:
                out += [table(["cell", "frames", "metric", "A", "B", "change %", "verdict"],
                              [[r["cell"], r["group"], r["metric"], r["a"], r["b"], r["change_pct"], r["verdict"]]
                               for r in changed]), ""]
    return "\n".join(out) + "\n"


def load_report(path):
    if path.endswith(".json") and os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("path", help="run folder (tools/perfrun.py) or one perf log")
    ap.add_argument("--compare", help="earlier run folder or report.json (baseline)")
    ap.add_argument("--pairs", help="JSON list of [cell A, cell B] pairs to compare inside the run")
    ap.add_argument("--warmup", type=float, default=30.0, help="seconds left out at the start of each log")
    ap.add_argument("--threshold", type=float, default=5.0, help="smallest change in %% reported as a difference")
    ap.add_argument("--out", help="folder for report.md and report.json (default: the run folder)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    report = analyse_run(args.path, args.warmup)
    comparison = None
    if args.compare:
        base = load_report(args.compare) or analyse_run(args.compare, args.warmup)
        comparison = compare(base, report, args.threshold)
        report["comparison"] = {"with": os.path.abspath(args.compare), "rows": comparison}
    pairs = None
    if args.pairs:
        pairs = compare_pairs(report, json.loads(args.pairs), args.threshold)
        report["pairs"] = pairs
    out_dir = args.out or (args.path if os.path.isdir(args.path) else os.path.dirname(os.path.abspath(args.path)))
    md = markdown(report, comparison, pairs)
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as f:
        f.write(md)
    if not args.quiet:
        print(md)
        print("wrote %s" % os.path.join(out_dir, "report.md"))
    worse = [r for r in (comparison or []) if r["verdict"] == "worse"]
    return 1 if worse else 0


if __name__ == "__main__":
    sys.exit(main())
