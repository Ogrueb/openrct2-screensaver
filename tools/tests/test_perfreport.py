"""tools/perfreport.py on synthetic perf logs (the format engine patch 0020 writes)."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import perfreport  # noqa: E402


def synth_log(seconds=90, paint_still=6.0, paint_pan=12.0, leak_mb_per_switch=0.0, slow_park=None,
              input_at=None, crash=False):
    """A perf log: two parks alternating every 30 s, each with a still and a panning half."""
    lines = ["# rct-screensaver perf log 1",
             "C,0.0,version=test engine=software multithreading=1 uncap_fps=0 vsync=1 scale=2.00 fullscreen=2 window=1920x1080"]
    t = 0.0
    parks = ["Tin Train", "Big Park"]
    switches = 0
    vx = 0
    next_sample = 0.0
    events = []
    while t < seconds * 1000:
        park_index = int(t // 30000)
        park = parks[park_index % 2]
        if t == 0 or int((t - 25) // 30000) != park_index:
            if t > 0:
                switches += 1
                lines.append("E,%.1f,load,%s read=10.0ms objects=5.0ms total=20.0ms" % (t - 5, park))
            lines.append("E,%.1f,mark,park %d/2 %s" % (t, park_index % 2 + 1, park))
            lines.append("E,%.1f,mark,view park=%d view=1/2 cut overview hold=10000 index=0 | %s" % (t, park_index % 2 + 1, park))
        if input_at is not None and t <= input_at * 1000 < t + 25:
            lines.append("E,%.1f,mark,input move" % t)
        panning = (t % 30000) >= 15000
        if panning:
            vx += 4
        paint = paint_pan if panning else paint_still
        sim = 3.0 * (3 if slow_park == park else 1)
        interval = 25.0 if paint + sim < 20 else 50.0
        if t > 0 and int((t - 25) // 30000) != park_index:
            interval = 45.0  # the switch frame
        t += interval
        lines.append("F,%.1f,%.2f,%d,%.2f,%.2f,%.2f,%.2f,%.2f,%d,%d,%d,%d" % (
            t, interval, 1 if interval < 40 else 2, sim + 0.5, 0.5, 0.3, paint, 1.0, vx, 100, -1 if panning else 0, 0))
        if t >= next_sample:
            next_sample += 10000
            private = (200 + leak_mb_per_switch * switches) * 1024 * 1024
            guests = 3000 if parks[int(t // 30000) % 2] == "Big Park" else 200
            lines.append("M,%.1f,0.80,%d,%d,500,300,4000000,3000000,20000,3,400000,%d,10,40,5,%d,12" % (
                t, private, private + 50 * 1024 * 1024, guests, guests + 60))
    if not crash:
        lines.append("E,%.1f,quit,run time reached" % t)
    else:
        lines.append("F,%.1f,25.0" % (t + 25))  # cut short
    return lines


class ParseTest(unittest.TestCase):
    def test_records(self):
        log = perfreport.parse_log(synth_log(seconds=40))
        self.assertEqual(log.config["engine"], "software")
        self.assertGreater(len(log.frames), 1000)
        self.assertTrue(log.samples)
        self.assertTrue(any(kind == "load" for _, kind, _ in log.events))
        self.assertEqual(log.bad_lines, 0)

    def test_cut_short_line_is_counted_not_fatal(self):
        log = perfreport.parse_log(synth_log(seconds=40, crash=True))
        self.assertEqual(log.bad_lines, 1)

    def test_load_text(self):
        park, stages = perfreport.parse_load("Sambhava's Rest early=132.0ms unload=13.0ms total=31.0ms")
        self.assertEqual(park, "Sambhava's Rest")
        self.assertEqual(stages, {"early": 132.0, "unload": 13.0, "total": 31.0})


class AnalyseTest(unittest.TestCase):
    def analyse(self, **kw):
        return perfreport.analyse_log(perfreport.parse_log(synth_log(**kw)), warmup_s=5)

    def test_still_and_pan_split_by_camera_movement(self):
        r = self.analyse()
        self.assertAlmostEqual(r["groups"]["still"]["paint_mean"], 6.0, places=1)
        self.assertAlmostEqual(r["groups"]["pan"]["paint_mean"], 12.0, places=1)
        self.assertIn("zoom -1 pan", r["groups"])
        self.assertIn("zoom 0 still", r["groups"])
        self.assertEqual(r["ended"], "quit")

    def test_switch_frames_left_out_of_play(self):
        r = self.analyse()
        self.assertEqual(len(r["switches"]), 2)
        self.assertEqual(r["switches"][0]["park"], "Big Park")
        self.assertTrue(r["switch_frames"])
        self.assertLess(r["groups"]["all"]["interval_max"], 45.0)

    def test_parks_and_sim_size(self):
        r = self.analyse(slow_park="Big Park")
        self.assertIn("Big Park", r["parks"])
        self.assertGreater(r["parks"]["Big Park"]["sim_mean"], r["parks"]["Tin Train"]["sim_mean"])
        self.assertEqual(r["sim_size"]["Big Park"]["guests"], 3000)
        self.assertGreater(r["parks"]["Big Park"]["missed_share"], 0.2)  # its pans miss frames
        self.assertLess(r["parks"]["Tin Train"]["missed_share"], 0.01)

    def test_input_seconds_left_out(self):
        quiet = self.analyse()
        touched = self.analyse(input_at=50)
        self.assertLess(touched["frames_kept"], quiet["frames_kept"])
        self.assertAlmostEqual(quiet["frames_kept"] - touched["frames_kept"], 40, delta=2)

    def test_memory_growth_per_switch(self):
        r = self.analyse(seconds=200, leak_mb_per_switch=8)
        self.assertGreater(r["memory"]["private_mb_per_switch"], 5)
        self.assertGreater(r["memory"]["private_mb_per_hour"], 0)
        flat = self.analyse(seconds=200)
        self.assertAlmostEqual(flat["memory"]["private_mb_per_hour"], 0, places=3)
        self.assertIn("Big Park", r["memory"]["growing_on_revisit"])

    def test_sample_time_taken_out_of_next_frame(self):
        log = perfreport.parse_log(["F,25.0,25.00,1,1,0,0,1,1,0,0,0,0",
                                    "M,25.0,10.00,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1",
                                    "F,60.0,35.00,1,1,0,0,1,1,0,0,0,0"])
        frames = perfreport.label_frames(log, 0)
        self.assertAlmostEqual(frames[1]["interval"], 25.0)


class RunTest(unittest.TestCase):
    def make_run(self, root, cells):
        for name, repeat, kw in cells:
            d = os.path.join(root, "cells", "%s-r%d" % (name, repeat))
            os.makedirs(d)
            with open(os.path.join(d, "perf.log"), "w") as f:
                f.write("\n".join(synth_log(**kw)) + "\n")
            with open(os.path.join(d, "cell.json"), "w") as f:
                json.dump({"cell": name, "repeat": repeat, "exit": 0}, f)

    def test_compare_flags_only_real_changes(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            self.make_run(a, [("software", 0, {}), ("software", 1, {}), ("opengl", 0, {})])
            self.make_run(b, [("software", 0, {"paint_still": 9.0}), ("software", 1, {"paint_still": 9.0}),
                              ("opengl", 0, {})])
            ra, rb = perfreport.analyse_run(a, 5), perfreport.analyse_run(b, 5)
            rows = perfreport.compare(ra, rb)
            worse = {(r["cell"], r["group"], r["metric"]) for r in rows if r["verdict"] == "worse"}
            self.assertIn(("software", "still", "paint_mean"), worse)
            self.assertFalse(any(r["cell"] == "opengl" and r["verdict"] != "same" for r in rows))

    def test_main_writes_report_and_fails_on_regression(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            self.make_run(a, [("base", 0, {})])
            self.make_run(b, [("base", 0, {"paint_pan": 16.0})])
            self.assertEqual(perfreport.main([a, "--warmup", "5", "--quiet"]), 0)
            code = perfreport.main([b, "--compare", os.path.join(a, "report.json"), "--warmup", "5", "--quiet"])
            self.assertEqual(code, 1)
            with open(os.path.join(b, "report.md")) as f:
                md = f.read()
            self.assertIn("Comparison with the earlier run", md)
            self.assertIn("worse", md)

    def test_pairs_inside_one_run(self):
        with tempfile.TemporaryDirectory() as a:
            self.make_run(a, [("cuts", 0, {}), ("pans", 0, {"paint_pan": 18.0})])
            report = perfreport.analyse_run(a, 5)
            rows = perfreport.compare_pairs(report, [["cuts", "pans"]])
            self.assertTrue(any(r["verdict"] == "worse" and r["metric"] == "paint_mean" for r in rows))


if __name__ == "__main__":
    unittest.main()
