"""The view editor's Playlist properties and park order (plugin RCTScreensaver.playlistProps) move into the
playlist file on install (mksequence.pull_props), and the store's entry goes (update_plugin_store)."""
import json, os, sys, tempfile, tomllib, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import mksequence  # noqa: E402

PLAYLIST = """# my playlist
name = "Mine"
titles = "on"

[views]
time_scale = 2.0  # slower
change_hold = 2.0

[[park]]
file = "a.park"

[[park]]
file = "b.park"

[[park]]
file = "c.park"
"""


class PlaylistProps(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.playlist = os.path.join(self.dir, "mine.toml")
        with open(self.playlist, "w", encoding="utf-8") as f:
            f.write(PLAYLIST)
        self.store = os.path.join(self.dir, "plugin.store.json")

    def write_store(self, props):
        with open(self.store, "w", encoding="utf-8") as f:
            json.dump({"RCTScreensaver": {"playlistProps": {"Mine": props}, "settings": {}}}, f)

    def read(self):
        with open(self.playlist, "rb") as f:
            return tomllib.load(f)

    def test_props_and_order_written(self):
        self.write_store({"order": ["c.park", "a.park"], "inertia": True, "panChanges": "off", "changeHold": 3.0,
                          "returnHold": 1.0, "titleMusic": "ride", "titles": None})
        found, changed = mksequence.pull_props(self.playlist, self.store)
        self.assertTrue(found)
        self.assertIn("park order", changed)
        data = self.read()
        self.assertEqual([p["file"] for p in data["park"]], ["c.park", "a.park", "b.park"], "unnamed parks keep their place after")
        self.assertEqual(data["views"]["pan_changes"], "off")
        self.assertIs(data["views"]["inertia"], True)
        self.assertEqual(data["views"]["change_hold"], 1.5, "holds back to unscaled seconds (time_scale 2)")
        self.assertEqual(data["views"]["return_hold"], 0.5)
        self.assertEqual(data["title_music"], "ride")
        self.assertNotIn("titles", data, "Unset titles removes the key")
        self.assertTrue(os.path.exists(self.playlist + ".bak"))

    def test_reorder_keeps_comments(self):
        with open(self.playlist, "w", encoding="utf-8") as f:
            f.write(PLAYLIST.replace('file = "b.park"', 'file = "b.park"  # bee\n[park.views]\ncount = 3'))
        self.write_store({"order": ["b.park", "c.park", "a.park"]})
        mksequence.pull_props(self.playlist, self.store)
        with open(self.playlist, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("# bee", text)
        self.assertIn("# slower", text)
        data = self.read()
        self.assertEqual([p["file"] for p in data["park"]], ["b.park", "c.park", "a.park"])
        self.assertEqual(data["park"][0]["views"]["count"], 3, "a park's subtables move with it")

    def test_unchanged_writes_nothing(self):
        self.write_store({"order": ["a.park", "b.park", "c.park"]})
        self.assertEqual(mksequence.pull_props(self.playlist, self.store), (True, []))
        self.assertFalse(os.path.exists(self.playlist + ".bak"))

    def test_no_entry(self):
        with open(self.store, "w", encoding="utf-8") as f:
            json.dump({}, f)
        self.assertEqual(mksequence.pull_props(self.playlist, self.store), (False, []))

    def test_store_entry_removed_and_install_stamped(self):
        self.write_store({"inertia": True})
        result = {"name": "Mine", "playlist": {"version": 1, "sequence": "Mine", "parks": []}, "titleMusic": "keep"}
        mksequence.update_plugin_store(self.store, result, (), False, props_pulled=True)
        with open(self.store, encoding="utf-8") as f:
            ours = json.load(f)["RCTScreensaver"]
        self.assertNotIn("Mine", ours["playlistProps"])
        self.assertIsInstance(ours["playlist"]["installed"], int)

    def test_install_takes_every_edit_in(self):
        """The build pane dims parks edited since the last build: after an install, none."""
        with open(self.store, "w", encoding="utf-8") as f:
            json.dump({"RCTScreensaver": {"edits": {"a.park": {"views": [{"x": 1}], "arranged": True},
                                                    "b.park": {"views": [{"x": 2}]}},
                                          "builtEdits": {"c.park": {"views": []}}}}, f)
        result = {"name": "Mine", "playlist": {"version": 1, "sequence": "Mine", "parks": []}, "titleMusic": "keep"}
        mksequence.update_plugin_store(self.store, result, [("a.park", False)], False)
        with open(self.store, encoding="utf-8") as f:
            ours = json.load(f)["RCTScreensaver"]
        self.assertEqual(ours["edits"], {"b.park": {"views": [{"x": 2}]}}, "the pinned edit moved to the views file")
        self.assertEqual(ours["builtEdits"], ours["edits"], "what stays counts as built")

    def test_generation_written(self):
        self.write_store({"generation": {"motion": "static", "route": "random", "variants": 2, "reverse": True,
                                         "ridePans": "only", "parkMin": 20, "parkCap": 90, "timeScale": 1.5,
                                         "parkScripts": False, "parkViews": True}, "changeHold": 3.0})
        found, changed = mksequence.pull_props(self.playlist, self.store)
        self.assertTrue(any(c.startswith("generation ") for c in changed), changed)
        v = self.read()["views"]
        self.assertEqual((v["motion"], v["route"], v["circuit_variants"], v["circuit_reverse"]), ("static", "random", 2, True))
        self.assertEqual((v.get("ride_pans", 1), v["only"]), (1, "rides"))
        self.assertEqual((v["park_min"], v["park_cap"], v["time_scale"]), (20, 90, 1.5))
        self.assertIs(self.read()["park_scripts"], False)
        self.assertIs(self.read()["park_plugins"], True)
        self.assertEqual(v["change_hold"], 1.5, "holds divided by the time scale they were set under")
        with open(self.playlist, encoding="utf-8") as f:
            self.assertIn("# my playlist", f.read())

    def test_generation_ride_pans_and_defaults(self):
        data = mksequence.apply_props({"views": {"only": "rides", "ride_pans": 1}, "park_scripts": False, "park_plugins": True},
                                      {"generation": {"ridePans": "exclude", "parkScripts": True, "parkViews": False}})
        self.assertEqual(data["views"], {"ride_pans": 0}, "only = rides goes with exclude")
        self.assertNotIn("park_scripts", data, "on is the default")
        self.assertNotIn("park_plugins", data, "off is the default")
        data = mksequence.apply_props({"views": {"ride_pans": 0}}, {"generation": {"ridePans": "include"}})
        self.assertEqual(data["views"]["ride_pans"], 1)
        self.assertNotIn("only", data["views"])

    def test_generation_checked(self):
        for bad in ({"variants": 0}, {"route": "zigzag"}, {"timeScale": 9}, {"parkViews": "yes"}):
            with self.assertRaises(ValueError):
                mksequence.apply_props({}, {"generation": bad})
        self.assertEqual(mksequence.apply_props({"name": "x"}, {"generation": {"someday": 1}}), {"name": "x"}, "unknown keys pass")

    def test_generation_values(self):
        defaults = dict(mksequence.VIEW_DEFAULTS, only="rides", time_scale=2)
        values = mksequence.generation_values(defaults, {"park_scripts": False})
        self.assertEqual(values["ridePans"], "only")
        self.assertIs(values["parkScripts"], False)
        self.assertEqual(values["timeScale"], 2.0)
        self.assertEqual(set(values), set(mksequence.GENERATION))

    def test_off_accepted(self):
        self.assertIn("off", mksequence.PAN_CHANGES)


if __name__ == "__main__":
    unittest.main()
