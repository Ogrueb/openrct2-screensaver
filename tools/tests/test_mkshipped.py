"""The files shipped in OpenRCT2's data folder (tools/mkshipped.py): the plugin where the engine loads it,
and a generator that runs on its own from a fresh user folder (no generator.json, no source checkout)."""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import mkshipped  # noqa: E402

BUILT = os.path.isfile(os.path.join(mkshipped.ROOT, "plugin", "dist", "rct-screensaver.js")) and \
    os.path.isfile(os.path.join(mkshipped.ROOT, "plugin", "dist", "companion-host.js"))


@unittest.skipUnless(BUILT, "the plugin is not built (npm run build in plugin/)")
class Shipped(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.data = os.path.join(cls.tmp.name, "data")
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            mkshipped.lay_out(cls.data)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_plugin_and_its_icons_sit_where_the_engine_loads_them(self):
        self.assertTrue(os.path.isfile(os.path.join(self.data, "plugin", "rct-screensaver.js")))
        icons = os.listdir(os.path.join(self.data, "plugin", "rct-screensaver", "icons"))
        self.assertIn("build-20.png", icons)

    def test_the_generator_has_what_it_imports(self):
        tools = os.path.join(self.data, "screensaver", "tools")
        for name in mkshipped.TOOLS:
            self.assertTrue(os.path.isfile(os.path.join(tools, name)), name)
        self.assertTrue(os.path.isfile(os.path.join(tools, "data", "nedesigns.json")))
        self.assertTrue(os.path.isfile(os.path.join(self.data, "screensaver", "plugin", "dist", "companion-host.js")))
        self.assertTrue(os.listdir(os.path.join(self.data, "screensaver", "parks")))

    def test_new_playlist_runs_on_a_fresh_user_folder(self):
        user = os.path.join(self.tmp.name, "OpenRCT2")
        os.makedirs(user)
        parks = os.path.join(self.tmp.name, "my parks")
        os.makedirs(parks)
        for name in ("a.park", "b.park"):
            with open(os.path.join(parks, name), "wb") as f:
                f.write(b"park" * 10)
        script = os.path.join(self.data, "screensaver", "tools", "mksequence.py")
        # -I: nothing from the source tree or the current folder; the script finds its own modules
        run = subprocess.run([sys.executable, "-I", script, "--live-new", parks, "--user-dir", user],
                             capture_output=True, text=True, cwd=os.path.join(self.data, "screensaver"))
        self.assertEqual(run.returncode, 0, run.stderr)
        with open(os.path.join(user, "screensaver", "live", "task-new.json"), encoding="utf-8") as f:
            task = json.load(f)
        self.assertTrue(task["ok"], task)
        self.assertEqual(len(task["parks"]), 2)
        # It registers itself: the game runs the same generator for the playlist's builds
        with open(os.path.join(user, "screensaver", "generator.json"), encoding="utf-8") as f:
            generator = json.load(f)
        self.assertEqual(os.path.normcase(generator["script"]), os.path.normcase(os.path.abspath(script)))
        self.assertIn(task["sequence"], generator["playlists"])


if __name__ == "__main__":
    unittest.main()
