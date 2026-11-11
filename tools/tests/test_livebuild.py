"""Builds the game starts (mksequence.py --live-build, engine patch "build a title sequence in the
background"): the install registers the generator, and a live build writes its result for the plugin
without touching the installed sequence or plugin.store.json."""
import contextlib, io, json, os, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import livefile, mksequence, userdata  # noqa: E402


class LiveBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.user = os.path.join(self.tmp.name, "OpenRCT2")
        os.makedirs(self.user)
        self.playlist = os.path.join(self.tmp.name, "my list.toml")
        with open(self.playlist, "w") as f:
            f.write('name = "My List"\n\n[[park]]\nfile = "a.park"\n')

    def tearDown(self):
        self.tmp.cleanup()

    def result(self):
        _, path = mksequence.live_build_paths("My List", self.user)
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def run_live(self, fake_build=None):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if fake_build:
                with mock.patch.object(mksequence, "build", fake_build):
                    return mksequence.live_build("My List", self.user)
            return mksequence.live_build("My List", self.user)

    def test_register_generator_names_this_python_and_script(self):
        path = mksequence.register_generator(self.user, "My List", self.playlist)
        self.assertEqual(path, os.path.join(self.user, "screensaver", "generator.json"))
        with open(path) as f:
            data = json.load(f)
        self.assertEqual(data["python"], os.path.abspath(sys.executable))
        self.assertTrue(data["script"].endswith("mksequence.py") and os.path.isabs(data["script"]))
        self.assertEqual(data["playlists"], {"My List": os.path.abspath(self.playlist)})
        # A second playlist keeps the first.
        mksequence.register_generator(self.user, "Other", self.playlist)
        with open(path) as f:
            self.assertEqual(set(json.load(f)["playlists"]), {"My List", "Other"})

    def test_unknown_playlist_fails_with_a_reason(self):
        self.assertEqual(self.run_live(), 1)
        result = self.result()
        self.assertIs(result["ok"], False)
        self.assertIn("--install", result["error"])
        self.assertEqual(result["buildVersion"], 1)
        self.assertNotIn("version", result, "never read as a live file")
        self.assertEqual(livefile.list_all(self.user), [])

    def test_result_for_the_plugin(self):
        mksequence.register_generator(self.user, "My List", self.playlist)
        calls = []

        def fake_build(path, out, **kwargs):
            calls.append((path, out, kwargs))
            self.assertTrue(kwargs["skip_missing"])
            kwargs["progress"](1, 2, {"key": "b.park", "name": "B", "state": "building", "warnings": []})
            progress = self.result()
            self.assertIsNone(progress["ok"])
            self.assertEqual((progress["park"], progress["parks"]), (2, 2))
            # Squares in play order: the second park's state sits second, before the first reports
            self.assertEqual([s["state"] for s in progress["parkStates"]], ["pending", "building"])
            kwargs["progress"](0, 2, {"key": "a.park", "name": "A", "state": "missing", "warnings": []})
            kwargs["progress"](1, 2, {"key": "b.park", "name": "B", "state": "built", "warnings": ["a warning"]})
            companion_dir = os.path.join(out, "My List.companions")
            os.makedirs(companion_dir)
            return {"name": "My List", "layout": "plugin", "dir": os.path.join(out, "My List"),
                    "parks": [{"name": "A", "warnings": ["a warning"]}],
                    "playlist": {"version": 1, "sequence": "My List", "parks": []}, "titleMusic": "ride",
                    "companionDir": companion_dir, "companions": [], "source": os.path.abspath(path), "live": None}

        self.assertEqual(self.run_live(fake_build), 0)
        path, out, kwargs = calls[0]
        self.assertEqual(path, os.path.abspath(self.playlist))
        self.assertEqual(out, os.path.join(self.user, "screensaver", "build", "live"))
        self.assertEqual(kwargs["user_dir"], self.user)
        result = self.result()
        self.assertIs(result["ok"], True)
        self.assertEqual(result["playlist"]["source"], os.path.abspath(self.playlist))
        self.assertEqual(result["warnings"], ["A: a warning"])
        self.assertEqual(result["titleMusic"], "ride")
        self.assertEqual([(s["key"], s["state"], s["warnings"]) for s in result["parkStates"]],
                         [("a.park", "missing", 0), ("b.park", "built", 1)])
        tagged = [(m["level"], m.get("park")) for m in result["messages"]]
        self.assertIn(("error", "a.park"), tagged)
        self.assertIn(("warn", "b.park"), tagged)
        self.assertIn(("ok", None), tagged)
        self.assertFalse(os.path.exists(os.path.join(self.user, "plugin.store.json")), "the game's storage is left alone")
        self.assertFalse(os.path.exists(os.path.join(self.user, "sequence")), "and so is the installed sequence")

    def test_live_edits_are_baked_before_the_build(self):
        mksequence.register_generator(self.user, "My List", self.playlist)
        os.makedirs(livefile.folder(self.user))
        with open(livefile.path("My List", self.user), "w") as f:
            json.dump({"version": 1, "sequence": "My List", "saved": 1000, "source": os.path.abspath(self.playlist),
                       "edits": {}, "props": {"titles": "on"}}, f)
        seen = []

        def fake_build(path, out, **kwargs):
            with open(path) as f:
                seen.append(f.read())
            self.assertIsNone(livefile.for_playlist(path, "My List", self.user), "baked, so not applied twice")
            return {"name": "Renamed", "layout": "plugin", "playlist": {}, "parks": []}

        self.run_live(fake_build)
        self.assertIn("titles", seen[0])
        self.assertEqual(self.result()["messages"][0]["level"], "info")

    def test_missing_park_is_left_out(self):
        mksequence.register_generator(self.user, "My List", self.playlist)
        states = []
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(ValueError):  # the only park is missing
                mksequence.build(self.playlist, os.path.join(self.tmp.name, "out"), skip_missing=True,
                                 progress=lambda i, n, p: states.append(p["state"]), use_live=False)
        self.assertEqual(states, [])

    def test_clearing_a_build_keeps_the_games_live_builds(self):
        build = os.path.join(self.tmp.name, "build")
        for rel in ("old/a.park", "old.result.json", "live/My List/b.park", "live/My List.result.json"):
            os.makedirs(os.path.dirname(os.path.join(build, rel)), exist_ok=True)
            open(os.path.join(build, rel), "w").close()
        userdata.clear_build(build)
        self.assertEqual(os.listdir(build), ["live"])
        self.assertTrue(os.path.exists(os.path.join(build, "live", "My List", "b.park")))

    def test_renamed_playlist_is_not_taken(self):
        mksequence.register_generator(self.user, "My List", self.playlist)

        def fake_build(path, out, **kwargs):
            return {"name": "Renamed", "layout": "plugin", "playlist": {}, "parks": []}

        self.assertEqual(self.run_live(fake_build), 1)
        self.assertIn("Renamed", self.result()["error"])


if __name__ == "__main__":
    unittest.main()
