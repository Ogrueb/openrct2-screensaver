"""Playlist bundles from the game (mksequence.py --live-export / --live-import, engine patch "export
and import playlist bundles through the system's file dialog"): the game picks the file, the generator
writes or reads the bundle and reports to task-<export|import>.json in the live folder."""
import contextlib, io, json, os, sys, tempfile, unittest, zipfile
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import livefile, mksequence  # noqa: E402


class LiveBundle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.user = os.path.join(self.tmp.name, "OpenRCT2")
        os.makedirs(self.user)
        self.lib = os.path.join(self.tmp.name, "lib")
        os.makedirs(self.lib)
        for name in ("a.park", "b.park"):
            with open(os.path.join(self.lib, name), "wb") as f:
                f.write(name.encode() * 10)
        self.playlist = os.path.join(self.lib, "my list.toml")
        with open(self.playlist, "w") as f:
            f.write('name = "My List"\n\n[[park]]\nfile = "a.park"\n\n[[park]]\nfile = "b.park"\nuse = false\n')
        mksequence.register_generator(self.user, "My List", self.playlist)

    def tearDown(self):
        self.tmp.cleanup()

    def task(self, name):
        with open(mksequence.task_result_path(name, self.user), encoding="utf-8") as f:
            return json.load(f)

    def quiet(self, fn, *args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return fn(*args)

    def export(self):
        out = os.path.join(self.tmp.name, "picked", "My List.zip")
        os.makedirs(os.path.dirname(out))
        return self.quiet(mksequence.live_export, "My List", out, self.user), out

    def test_export_writes_the_picked_file_with_the_parks(self):
        code, out = self.export()
        self.assertEqual(code, 0)
        with zipfile.ZipFile(out) as z:
            names = set(z.namelist())
            manifest = json.loads(z.read("bundle.json"))
        self.assertIn("parks/a.park", names)
        self.assertNotIn("parks/b.park", names, "an unticked park goes by name only")
        self.assertTrue(manifest["includesParks"])
        result = self.task("export")
        self.assertIs(result["ok"], True)
        self.assertEqual((result["taskVersion"], result["task"], result["sequence"], result["path"]), (1, "export", "My List", out))
        self.assertNotIn("version", result, "never read as a live file")
        self.assertEqual([m["level"] for m in result["messages"]], ["ok", "warn"])

    def test_export_bakes_the_games_edits_first(self):
        os.makedirs(livefile.folder(self.user))
        with open(livefile.path("My List", self.user), "w") as f:
            json.dump({"version": 1, "sequence": "My List", "saved": 1000, "source": os.path.abspath(self.playlist),
                       "edits": {}, "props": {"titles": "on"}}, f)
        code, out = self.export()
        self.assertEqual(code, 0)
        with zipfile.ZipFile(out) as z:
            self.assertIn("titles", z.read("playlist.toml").decode())
        self.assertEqual(self.task("export")["messages"][0]["level"], "info")

    def test_export_carries_the_users_profiles_of_its_parks(self):
        own = os.path.join(self.user, "screensaver", "parks")
        os.makedirs(own)
        with open(os.path.join(own, "mine.toml"), "w") as f:
            f.write('[match]\nname = "Park A"\n\n[views]\npan = 0.5\n')
        with open(os.path.join(own, "other.toml"), "w") as f:
            f.write('[match]\nname = "Elsewhere"\n')
        names = {os.path.abspath(os.path.join(self.lib, "a.park")) + "|": {"savedName": "Park A", "mapSize": [64, 64]}}
        os.makedirs(os.path.join(self.user, "screensaver", "park-cache"))
        with open(os.path.join(self.user, "screensaver", "park-cache", "names.json"), "w") as f:
            json.dump(names, f)
        self.assertEqual([os.path.basename(p) for p in mksequence.user_profile_files(self.playlist, self.user)], ["mine.toml"])
        code, out = self.export()
        self.assertEqual(code, 0)
        with zipfile.ZipFile(out) as z:
            self.assertEqual(json.loads(z.read("bundle.json"))["profiles"], ["mine.toml"])

    def test_export_of_an_unknown_sequence_fails_with_a_reason(self):
        out = os.path.join(self.tmp.name, "x.zip")
        self.assertEqual(self.quiet(mksequence.live_export, "Nope", out, self.user), 1)
        result = self.task("export")
        self.assertIs(result["ok"], False)
        self.assertIn("--install", result["error"])
        self.assertFalse(os.path.exists(out))

    def test_import_unpacks_registers_and_builds(self):
        _, out = self.export()
        other = os.path.join(self.tmp.name, "OpenRCT2-b")
        os.makedirs(other)
        built = []

        def fake_live_build(name, user_dir, imported=False):
            self.assertTrue(imported)
            built.append((name, user_dir))
            return 0

        with mock.patch.object(mksequence, "live_build", fake_live_build):
            code = self.quiet(mksequence.live_import, out, other)
        self.assertEqual(code, 0)
        self.assertEqual(built, [("My List", other)])
        home = os.path.join(other, "screensaver")
        playlist = os.path.join(home, "playlists", "my-list.toml")
        self.assertTrue(os.path.exists(playlist))
        self.assertTrue(os.path.exists(os.path.join(home, "bundles", "my-list", "a.park")))
        with open(os.path.join(home, "generator.json")) as f:
            self.assertEqual(json.load(f)["playlists"], {"My List": os.path.abspath(playlist)})
        user = self.user
        self.user = other
        result = self.task("import")
        self.user = user
        self.assertIs(result["ok"], True)
        self.assertEqual((result["task"], result["sequence"], result["playlist"]), ("import", "My List", playlist))
        self.assertEqual(result["missing"], ["b.park"])

    def test_import_backs_up_a_playlist_it_replaces(self):
        _, out = self.export()
        with mock.patch.object(mksequence, "live_build", lambda name, user_dir, imported=False: 0):
            self.quiet(mksequence.live_import, out, self.user)
            self.quiet(mksequence.live_import, out, self.user)
        backups = os.listdir(os.path.join(self.user, "screensaver", "backups"))
        self.assertTrue(any(b.startswith("my-list.toml.") for b in backups), backups)

    def test_imported_park_scripts_are_installed_with_a_restart_warning(self):
        companion_dir = os.path.join(self.tmp.name, "companions")
        os.makedirs(companion_dir)
        with open(os.path.join(companion_dir, "rct-screensaver-companion-animator.js"), "w") as f:
            f.write("// host")

        def fake_build(path, out, **kwargs):
            return {"name": "My List", "layout": "plugin", "dir": os.path.join(out, "My List"),
                    "parks": [], "playlist": {"version": 1, "sequence": "My List", "parks": []}, "titleMusic": "keep",
                    "companionDir": companion_dir, "companions": [("rct-screensaver-companion-animator.js", {"name": "Animator"}, ["Park A"])],
                    "source": os.path.abspath(path), "live": None}

        def result():
            _, path = mksequence.live_build_paths("My List", self.user)
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        with mock.patch.object(mksequence, "build", fake_build):
            self.assertEqual(self.quiet(mksequence.live_build, "My List", self.user, True), 0)
            first = result()
            self.assertTrue(os.path.exists(os.path.join(self.user, "plugin", "rct-screensaver-companion-animator.js")))
            self.assertEqual(first["warnings"], ["Park script Animator (Park A) starts after a restart of the game"])
            self.assertIn("warn", [m["level"] for m in first["messages"]])
            # The same scripts installed already: nothing waits for a restart
            self.quiet(mksequence.live_build, "My List", self.user, True)
            self.assertEqual(result()["warnings"], [])
            # Another playlist's script leaving the folder does not count: only new or changed ones wait
            with open(os.path.join(self.user, "plugin", "rct-screensaver-companion-other.js"), "w") as f:
                f.write("// other")
            self.quiet(mksequence.live_build, "My List", self.user, True)
            self.assertEqual(result()["warnings"], [])
            self.assertFalse(os.path.exists(os.path.join(self.user, "plugin", "rct-screensaver-companion-other.js")))
            # A plain build from the game leaves the plugin folder alone
            os.remove(os.path.join(self.user, "plugin", "rct-screensaver-companion-animator.js"))
            self.quiet(mksequence.live_build, "My List", self.user)
            self.assertFalse(os.path.exists(os.path.join(self.user, "plugin", "rct-screensaver-companion-animator.js")))

    def test_import_of_a_bad_file_fails_with_a_reason(self):
        bad = os.path.join(self.tmp.name, "bad.zip")
        with open(bad, "w") as f:
            f.write("not a zip")
        self.assertEqual(self.quiet(mksequence.live_import, bad, self.user), 1)
        result = self.task("import")
        self.assertIs(result["ok"], False)
        self.assertTrue(result["error"])
        self.assertEqual(result["messages"][-1]["level"], "error")


if __name__ == "__main__":
    unittest.main()
