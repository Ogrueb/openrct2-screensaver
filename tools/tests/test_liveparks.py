"""Parks and new playlists from the game (mksequence.py --live-add / --live-new / --live-copy, engine patch
"add parks and make playlists through the system's dialogs") and the editor's Use ticks in the live file."""
import contextlib, io, json, os, sys, tempfile, tomllib, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import livefile, mksequence  # noqa: E402

PLAYLIST = '''name = "My List"  # the sequence

# first park
[[park]]
file = "a.park"

[[park]]
file = "b.park"
use = false

[[park]]
file = "c.park"
'''


class LiveParks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.user = os.path.join(self.tmp.name, "OpenRCT2")
        os.makedirs(self.user)
        self.lib = os.path.join(self.tmp.name, "lib")
        os.makedirs(self.lib)
        for name in ("a.park", "b.park", "c.park", "d.park"):
            self.park(os.path.join(self.lib, name))
        self.playlist = os.path.join(self.lib, "my list.toml")
        with open(self.playlist, "w") as f:
            f.write(PLAYLIST)
        mksequence.register_generator(self.user, "My List", self.playlist)

    def tearDown(self):
        self.tmp.cleanup()

    def park(self, path):
        with open(path, "wb") as f:
            f.write(b"park" * 10)

    def task(self, name):
        with open(mksequence.task_result_path(name, self.user), encoding="utf-8") as f:
            return json.load(f)

    def run_task(self, fn, *args):
        """Runs a task with the build after it stubbed (no real parks here)."""
        with mock.patch.object(mksequence, "live_build", return_value=0) as build, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = fn(*args)
        return code, build

    def read(self, path=None):
        with open(path or self.playlist, "rb") as f:
            return tomllib.load(f)

    # --- Use ticks ---

    def test_ticks_apply_over_the_playlist(self):
        data = mksequence.apply_props(self.read(), {"use": {"a.park": False, "b.park": True}})
        self.assertEqual([e.get("use", True) for e in data["park"]], [False, True, True])

    def test_ticks_and_order_are_written_with_comments_kept(self):
        changed = mksequence.write_props(self.playlist, {"order": ["c.park", "a.park", "b.park"], "use": {"b.park": True, "c.park": False}})
        self.assertEqual(changed, ["park order", "parks in use"])
        parks = self.read()["park"]
        self.assertEqual([(e["file"], e.get("use", True)) for e in parks], [("c.park", False), ("a.park", True), ("b.park", True)])
        with open(self.playlist, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("# first park", text)
        self.assertIn("# the sequence", text)

    def test_ticks_are_listed_in_the_live_summary(self):
        self.assertTrue(livefile.summary({"props": {"use": {"a.park": False}}})["use"])
        self.assertEqual(livefile.summary({"props": {"use": {"a.park": False}}})["props"], [])

    # --- the playlists list ---

    def test_registering_lists_the_playlists_for_the_game(self):
        with open(os.path.join(livefile.folder(self.user), "playlists.json"), encoding="utf-8") as f:
            listed = json.load(f)
        self.assertEqual(listed["playlistsVersion"], 1)
        self.assertEqual(listed["playlists"], [{"name": "My List", "file": "my list.toml", "parks": 2}])

    # --- Add park ---

    def test_add_appends_the_park_and_builds(self):
        code, build = self.run_task(mksequence.live_add, "My List", os.path.join(self.lib, "d.park"), self.user)
        self.assertEqual(code, 0)
        build.assert_called_once_with("My List", self.user)
        self.assertEqual([e["file"] for e in self.read()["park"]], ["a.park", "b.park", "c.park", "d.park"])
        with open(self.playlist, encoding="utf-8") as f:
            self.assertIn("# first park", f.read())
        result = self.task("add")
        self.assertEqual((result["task"], result["ok"], result["sequence"]), ("add", True, "My List"))

    def test_add_from_another_folder_is_relative_to_the_playlist(self):
        other = os.path.join(self.tmp.name, "downloads")
        os.makedirs(other)
        self.park(os.path.join(other, "e.park"))
        self.run_task(mksequence.live_add, "My List", os.path.join(other, "e.park"), self.user)
        self.assertEqual(self.read()["park"][-1]["file"], "../downloads/e.park")

    def test_add_of_an_unticked_park_ticks_it_on(self):
        code, _ = self.run_task(mksequence.live_add, "My List", os.path.join(self.lib, "b.park"), self.user)
        self.assertEqual(code, 0)
        self.assertEqual([e.get("use", True) for e in self.read()["park"]], [True, True, True])
        self.assertIn("Ticked", self.task("add")["messages"][-1]["text"])

    def test_add_of_a_park_in_the_playlist_fails(self):
        code, build = self.run_task(mksequence.live_add, "My List", os.path.join(self.lib, "a.park"), self.user)
        self.assertEqual(code, 1)
        build.assert_not_called()
        self.assertIs(self.task("add")["ok"], False)
        self.assertIn("in the playlist already", self.task("add")["error"])

    def test_add_of_an_rct_save_says_where_to_convert_it(self):
        save = os.path.join(self.lib, "old.sv6")
        self.park(save)
        code, _ = self.run_task(mksequence.live_add, "My List", save, self.user)
        self.assertEqual(code, 1)
        self.assertIn("folder scan", self.task("add")["error"])

    def test_add_bakes_the_games_edits_first(self):
        os.makedirs(livefile.folder(self.user), exist_ok=True)
        with open(livefile.path("My List", self.user), "w") as f:
            json.dump({"version": 1, "sequence": "My List", "source": self.playlist, "saved": 5, "edits": {},
                       "props": {"use": {"a.park": False}}}, f)
        self.run_task(mksequence.live_add, "My List", os.path.join(self.lib, "d.park"), self.user)
        self.assertEqual([e.get("use", True) for e in self.read()["park"]], [False, False, True, True])

    # --- New playlist from a folder ---

    def test_new_makes_a_registered_playlist_of_the_folder(self):
        code, build = self.run_task(mksequence.live_new, self.lib, self.user)
        self.assertEqual(code, 0)
        result = self.task("new")
        self.assertEqual(result["sequence"], "RCT Screensaver lib")
        build.assert_called_once_with("RCT Screensaver lib", self.user, imported=True)
        data = self.read(result["playlist"])
        self.assertEqual(data["name"], "RCT Screensaver lib")
        self.assertEqual(len(data["park"]), 4)
        self.assertTrue(all(os.path.isfile(os.path.join(os.path.dirname(result["playlist"]), e["file"])) for e in data["park"]))
        self.assertEqual(mksequence.registered_playlists(self.user)["RCT Screensaver lib"], result["playlist"])

    def test_a_second_new_playlist_of_the_folder_gets_its_own_name(self):
        self.run_task(mksequence.live_new, self.lib, self.user)
        self.run_task(mksequence.live_new, self.lib, self.user)
        self.assertEqual(self.task("new")["sequence"], "RCT Screensaver lib 2")

    def test_new_of_a_folder_without_parks_fails(self):
        empty = os.path.join(self.tmp.name, "empty")
        os.makedirs(empty)
        code, build = self.run_task(mksequence.live_new, empty, self.user)
        self.assertEqual(code, 1)
        build.assert_not_called()
        self.assertIn("no parks", self.task("new")["error"])

    # --- Duplicate ---

    def test_copy_names_the_playlist_after_its_file(self):
        to = os.path.join(self.user, "screensaver", "playlists", "Evening.toml")
        with open(mksequence.edits_path(self.playlist), "w") as f:
            json.dump({"version": 1, "parks": {}}, f)
        code, build = self.run_task(mksequence.live_copy, "My List", to, self.user)
        self.assertEqual(code, 0)
        build.assert_called_once_with("Evening", self.user, imported=True)
        data = self.read(to)
        self.assertEqual(data["name"], "Evening")
        self.assertEqual([e["file"] for e in data["park"]], ["../../../lib/a.park", "../../../lib/b.park", "../../../lib/c.park"])
        self.assertTrue(os.path.exists(mksequence.edits_path(to)))
        self.assertEqual(self.task("copy")["sequence"], "Evening")
        self.assertEqual(self.read()["name"], "My List", "the original stays")

    def test_copy_over_the_playlist_itself_fails(self):
        code, _ = self.run_task(mksequence.live_copy, "My List", self.playlist, self.user)
        self.assertEqual(code, 1)
        self.assertIn("own file", self.task("copy")["error"])

    def test_copy_under_the_same_name_fails(self):
        code, _ = self.run_task(mksequence.live_copy, "My List", os.path.join(self.tmp.name, "My List.toml"), self.user)
        self.assertEqual(code, 1)
        self.assertIn("another name", self.task("copy")["error"])


if __name__ == "__main__":
    unittest.main()
