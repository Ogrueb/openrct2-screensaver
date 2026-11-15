"""The view editor's park settings (Playlist properties `parks`): the build lists each park's settings,
a live file's changes apply in memory to a build, and the bake writes them into the parks' profiles in the
user folder, as the settings page's switches and parameters do (profiles.change)."""
import os, sys, tempfile, tomllib, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import mksequence, profiles  # noqa: E402


class ParkSettings(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.old = os.environ.get("RCT_SCREENSAVER_HOME")
        os.environ["RCT_SCREENSAVER_HOME"] = self.home
        self.playlist = os.path.join(self.home, "mine.toml")
        with open(self.playlist, "w", encoding="utf-8") as f:
            f.write('name = "Mine"\n\n[views]\nride_pans = 0\n\n[[park]]\nfile = "a.park"\n')
        self.defaults = {**mksequence.VIEW_DEFAULTS, "ride_pans": 0}

    def tearDown(self):
        if self.old is None:
            os.environ.pop("RCT_SCREENSAVER_HOME", None)
        else:
            os.environ["RCT_SCREENSAVER_HOME"] = self.old

    def test_changes_as_the_settings_page_writes_them(self):
        c = mksequence.settings_changes({"scripts": False, "towers": False, "rides": True, "count": 6,
                                         "parkCap": self.defaults["park_cap"], "pan": "auto", "zoomMin": None}, self.defaults)
        self.assertEqual(c["companions"], False)
        self.assertEqual(c["views"], {"tower_views": 0, "ride_pans": 1, "count": 6, "park_cap": None,
                                      "pan": "auto", "zoom_min": None}, "the playlist's own value leaves no key")
        self.assertEqual(mksequence.settings_changes({"towers": True}, self.defaults)["views"], {"tower_views": None})
        self.assertEqual(mksequence.settings_changes({"scripts": True}, self.defaults), {"companions": None})
        for bad in ({"count": 0}, {"pan": 2}, {"companionPans": "stop"}, {"towers": 1}, {"count": True}):
            with self.assertRaises(ValueError):
                mksequence.settings_changes(bad, self.defaults)

    def test_bake_writes_a_new_profile_and_removes_it_when_plain(self):
        props = {"parks": {"a.park": {"profile": None, "savedName": "Alpha Park", "mapSize": [64, 64], "name": "Alpha",
                                      "set": {"count": 5, "scripts": False}}}}
        self.assertEqual(mksequence.write_park_settings(self.playlist, props), ["Alpha"])
        path = os.path.join(self.home, "parks", "alpha-park.toml")
        with open(path, "rb") as f:
            data = tomllib.load(f)
        self.assertEqual(data["match"], {"name": "Alpha Park", "map": [64, 64]})
        self.assertEqual(data["views"], {"count": 5})
        self.assertIs(data["companions"], False)
        props["parks"]["a.park"].update(profile="alpha-park", set={"count": None, "scripts": True})
        mksequence.write_park_settings(self.playlist, props)
        self.assertFalse(os.path.exists(path), "a profile left with only its match goes")

    def test_shipped_profile_copied_then_dropped_when_back(self):
        shipped = profiles.load(user=False)
        stem, prof = next((k, v) for k, v in sorted(shipped.items()) if "count" not in v.get("views", {}))
        park = {"profile": stem, "savedName": prof["match"]["name"], "mapSize": prof["match"].get("map", [0, 0]), "set": {"count": 7}}
        mksequence.write_park_settings(self.playlist, {"parks": {"k": park}})
        user = os.path.join(self.home, "parks", stem + ".toml")
        with open(user, "rb") as f:
            self.assertEqual(tomllib.load(f)["views"]["count"], 7)
        self.assertEqual(profiles.load()[stem]["source"], "user")
        mksequence.write_park_settings(self.playlist, {"parks": {"k": dict(park, set={"count": None})}})
        self.assertFalse(os.path.exists(user), "the same as shipped: the copy goes")

    def test_live_changes_apply_in_memory(self):
        loaded = {"beta": {"id": "beta", "match": {"name": "Beta"}, "views": {"count": 4}}}
        out = mksequence.park_settings_profiles({"b.park": {"profile": "beta", "set": {"count": 6}},
                                                 "c.park": {"profile": None, "savedName": "Gamma", "mapSize": [10, 12], "set": {"towers": False}}},
                                                self.defaults, loaded)
        self.assertEqual(out["beta"]["views"]["count"], 6)
        self.assertEqual(loaded["beta"]["views"]["count"], 4, "the loaded profiles stay as they are")
        gamma = next(p for p in out.values() if p["match"]["name"] == "Gamma")
        self.assertEqual(gamma["views"], {"tower_views": 0})
        self.assertEqual(gamma["match"]["map"], [10, 12])

    def test_settings_listed(self):
        s = mksequence.park_settings(dict(self.defaults, count=6), {"id": "x", "views": {"count": 6}, "companions": False},
                                     {"park_cap"}, "X", (10, 10), scripts=False)
        self.assertEqual((s["profile"], s["count"], s["rides"], s["scripts"]), ("x", 6, False, False))
        self.assertEqual(sorted(s["adjusted"]), ["count", "scripts"])
        self.assertEqual(s["locked"], ["parkCap"])
        self.assertNotIn("events", s, "a park without event views has no switch")


if __name__ == "__main__":
    unittest.main()


class EventSettings(unittest.TestCase):
    """The Events list's settings (the drawing page's Events panel): spots on or off and their holds, the
    default hold, the show, its camera and hold, and its pan share, written into the profile."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.old = os.environ.get("RCT_SCREENSAVER_HOME")
        os.environ["RCT_SCREENSAVER_HOME"] = self.home
        self.playlist = os.path.join(self.home, "mine.toml")
        with open(self.playlist, "w", encoding="utf-8") as f:
            f.write('name = "Mine"\n\n[[park]]\nfile = "a.park"\n')
        self.defaults = dict(mksequence.VIEW_DEFAULTS)

    def tearDown(self):
        if self.old is None:
            os.environ.pop("RCT_SCREENSAVER_HOME", None)
        else:
            os.environ["RCT_SCREENSAVER_HOME"] = self.old

    def test_changes(self):
        c = mksequence.settings_changes({"animationHold": 12, "show": "", "showPan": 0.25,
                                         "spots": {"Lift": {"off": False, "hold": None}, "Stars": None},
                                         "showDefs": {"eclipse": {"hold": 90, "view": {"x": 10, "y": 12, "zoom": 0, "rotation": 1}}}},
                                        self.defaults)
        self.assertEqual(c["extras"], {"animation_hold": 12, "show": ""})
        self.assertEqual(c["views"], {"show_pan": 0.25})
        self.assertEqual(c["animation"], {"Lift": {"off": False, "hold": None}, "Stars": {"off": None, "hold": None}})
        self.assertEqual(c["show"], {"eclipse": {"hold": 90, "view": {"x": 10, "y": 12, "zoom": 0, "rotation": 1}}})
        self.assertEqual(mksequence.settings_changes({"showPan": self.defaults["show_pan"]}, self.defaults)["views"], {"show_pan": None})
        for bad in ({"animationHold": 0}, {"show": 3}, {"showPan": 2}, {"spots": {"a": {"off": 1}}}, {"spots": {"a": {"z": 3}}},
                    {"showDefs": {"eclipse": {"view": {"x": 1, "y": 2, "zoom": 9, "rotation": 0}}}},
                    {"showDefs": {"eclipse": {"path": [{"x": 1}]}}}):
            with self.assertRaises(ValueError, msg=bad):
                mksequence.settings_changes(bad, self.defaults)

    def test_bake_into_a_shipped_profile(self):
        stem = "constellations"
        prof = profiles.load(user=False)[stem]
        park = {"profile": stem, "savedName": prof["match"]["name"], "mapSize": prof["match"].get("map", [0, 0]),
                "set": {"animationHold": 25, "spots": {"Tesla launch": {"off": True}},
                        "showDefs": {"eclipse": {"hold": 200}}, "showPan": 0.3}}
        mksequence.write_park_settings(self.playlist, {"parks": {"k": park}})
        user = os.path.join(self.home, "parks", stem + ".toml")
        with open(user, "rb") as f:
            data = tomllib.load(f)
        self.assertEqual(data["extras"]["animation_hold"], 25)
        self.assertEqual(data["extras"]["show"], "eclipse", "the rest of [extras] kept")
        self.assertIs(data["animation"]["Tesla launch"]["off"], True)
        self.assertEqual(data["show"]["eclipse"]["hold"], 200)
        self.assertEqual(data["show"]["eclipse"]["view"], prof["show"]["eclipse"]["view"], "the rest of the show kept")
        self.assertEqual(data["views"]["show_pan"], 0.3)
        back = {"animationHold": prof["extras"]["animation_hold"], "spots": {"Tesla launch": None},
                "showDefs": {"eclipse": {"hold": prof["show"]["eclipse"]["hold"]}}, "showPan": None}
        mksequence.write_park_settings(self.playlist, {"parks": {"k": dict(park, set=back)}})
        self.assertFalse(os.path.exists(user), "all back as shipped: the copy goes")

    def test_settings_list_event_facts(self):
        facts = {"spots": [{"name": "Lift", "companion": "AdvancedTrack", "on": False, "offByDefault": True, "status": "off by default"},
                           {"name": "Stars", "companion": "Animator", "on": True, "offByDefault": False, "status": "view: Stars", "view": "Stars", "hold": 8.0}],
                 "shows": [{"name": "eclipse", "hold": 120.0, "own": True, "view": {"x": 1, "y": 2, "zoom": 0, "rotation": 0}}],
                 "show": "eclipse", "animationHold": None, "holdDefault": 8.0, "cueHold": 5.0, "locked": []}
        s = mksequence.park_settings(dict(self.defaults), {"id": "x", "extras": {"show": "eclipse"}}, set(), "X", (10, 10),
                                     events=True, event_facts=facts)
        self.assertEqual(s["spots"], {"Lift": {"off": True}, "Stars": {"off": False, "hold": 8.0}})
        self.assertEqual(s["show"], "eclipse")
        self.assertEqual(s["showDefs"], {"eclipse": {"hold": 120.0, "view": {"x": 1, "y": 2, "zoom": 0, "rotation": 0}}})
        self.assertIn("show", s["adjusted"])
        self.assertEqual(s["showPan"], self.defaults["show_pan"])
