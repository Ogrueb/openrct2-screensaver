"""tools/perfrun.py: suites, config.ini patches, run order, park samples."""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import perfrun  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class IniTest(unittest.TestCase):
    def test_patch_keeps_other_lines_and_adds_missing(self):
        text = '[general]\ngame_path = "C:\\\\RCT2"\ndrawing_engine = SOFTWARE_HWD\n\n[sound]\nmaster_sound = true\n'
        out = perfrun.patch_ini(text, {"general": {"drawing_engine": "OPENGL", "multithreading": True, "window_scale": 1.0},
                                       "sound": {"master_sound": False},
                                       "interface": {"current_title_sequence": "RCT Screensaver Examples"}})
        self.assertIn('game_path = "C:\\\\RCT2"', out)
        self.assertIn("drawing_engine = OPENGL", out)
        self.assertIn("multithreading = true", out)
        self.assertIn("window_scale = 1", out)
        self.assertIn("master_sound = false", out)
        self.assertNotIn("master_sound = true", out)
        self.assertIn('[interface]\ncurrent_title_sequence = "RCT Screensaver Examples"', out)
        general = out.split("[sound]")[0]
        self.assertIn("multithreading", general, "new keys go into their own section")


class SuiteTest(unittest.TestCase):
    def test_every_shipped_suite_loads(self):
        folder = os.path.join(REPO, "perf")
        suites = [f for f in os.listdir(folder) if f.endswith(".toml")]
        self.assertGreaterEqual(len(suites), 5)
        for name in suites:
            suite = perfrun.load_suite(os.path.join(folder, name))
            cells = {c["name"] for c in suite["cells"]}
            for pair in suite.get("pairs", []):
                self.assertTrue(set(pair) <= cells, "%s: pair %s names a cell that is not there" % (name, pair))

    def test_cells_merge_over_base(self):
        base = {"config": {"general": {"multithreading": True}}, "settings": {"speed": 1}, "flags": ["--a"]}
        cell = perfrun.merge_cell(base, {"name": "x", "config": {"general": {"drawing_engine": "OPENGL"}},
                                         "settings": {"titleMusic": "off"}, "flags": ["--b"]})
        self.assertEqual(cell["config"]["general"], {"multithreading": True, "drawing_engine": "OPENGL"})
        self.assertEqual(cell["settings"], {"speed": 1, "titleMusic": "off"})
        self.assertEqual(cell["flags"], ["--a", "--b"])

    def test_interleaved_order(self):
        order = perfrun.cell_order(["a", "b", "c"], 2)
        self.assertEqual(order, [("a", 0), ("b", 0), ("c", 0), ("c", 1), ("b", 1), ("a", 1)])


class SampleTest(unittest.TestCase):
    def test_spread_keeps_both_ends(self):
        items = list(range(100))
        picks = perfrun.spread(items, 4, key=lambda x: x)
        self.assertEqual(picks, [0, 33, 66, 99])
        self.assertEqual(perfrun.spread([3, 1], 4, key=lambda x: x), [1, 3])


class SandboxTest(unittest.TestCase):
    def test_sandbox_settings_and_companions(self):
        with tempfile.TemporaryDirectory() as root:
            user = os.path.join(root, "user")
            os.makedirs(os.path.join(user, "object"))
            with open(os.path.join(user, "config.ini"), "w") as f:
                f.write("[general]\nmultithreading = true\n")
            cell_dir = os.path.join(root, "cell")
            os.makedirs(os.path.join(cell_dir, "user", "plugin"))
            open(os.path.join(cell_dir, "user", "plugin", "rct-screensaver-companion-x.js"), "w").close()
            cell = perfrun.merge_cell({}, {"name": "c", "companions": False, "profiler": True,
                                          "config": {"general": {"multithreading": False}}, "settings": {"speed": 4}})
            sandbox = perfrun.make_sandbox(cell, cell_dir, user, None)
            with open(os.path.join(sandbox, "config.ini")) as f:
                self.assertIn("multithreading = false", f.read())
            import json
            with open(os.path.join(sandbox, "plugin.store.json")) as f:
                settings = json.load(f)["RCTScreensaver"]["settings"]
            self.assertTrue(settings["bench"])
            self.assertEqual(settings["speed"], 4)
            self.assertTrue(settings["profilerExport"].endswith("profiler.csv"))
            self.assertEqual(os.listdir(os.path.join(sandbox, "plugin")), [])
            self.assertTrue(os.path.isdir(os.path.join(sandbox, "object")))
            perfrun.remove_tree(sandbox)
            self.assertTrue(os.path.isdir(os.path.join(user, "object")), "the linked object folder survives")


if __name__ == "__main__":
    unittest.main()
