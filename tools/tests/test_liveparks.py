"""Parks and new playlists from the game (mksequence.py --live-add / --live-new / --live-copy, engine patch
"add parks and make playlists through the system's dialogs") and the editor's Use ticks in the live file."""
import contextlib, io, json, os, sys, tempfile, tomllib, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import livefile, mksequence, parkinfo  # noqa: E402

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

    def test_a_left_out_park_ticked_on_goes_where_the_order_places_it(self):
        # (the editor places a park waiting for a build before it is built: owner, 2026-11-12)
        mksequence.write_props(self.playlist, {"order": ["b.park", "a.park", "c.park"], "use": {"b.park": True}})
        self.assertEqual([(e["file"], e.get("use", True)) for e in self.read()["park"]],
                         [("b.park", True), ("a.park", True), ("c.park", True)])

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

    def test_add_of_an_rct_save_without_openrct2_says_so(self):
        save = os.path.join(self.lib, "old.sv6")
        self.park(save)
        code, _ = self.run_task(mksequence.live_add, "My List", save, self.user)
        self.assertEqual(code, 1)
        self.assertIn("no OpenRCT2", self.task("add")["error"])
        self.assertTrue(any("needs --openrct2" in m["text"] for m in self.task("add")["messages"]))

    def fake_import(self, made):
        """importparks.run stubbed: it 'converts' into the library, writing the parks named in `made`."""
        def run(paths, library, openrct2, user_dir, name="x", echo=print, **kw):
            os.makedirs(library, exist_ok=True)
            lines = []
            for f in made:
                self.park(os.path.join(library, f))
                lines += ["[[park]]", 'file = "%s"' % f, 'name = "%s"' % f[:-5].title(), "author = false"]
            if made:
                os.makedirs(os.path.join(library, "x"), exist_ok=True)
                lines.append('companions = ["x/show.js"]')
            playlist = os.path.join(library, "imported.toml")
            with open(playlist, "w") as fh:
                fh.write('name = "%s"\n' % name + "\n".join(lines) + "\n")
            records = [{"folder": os.path.basename(paths[0]), "warnings": [], "kind": "legacy", "member": "old.SV6",
                        "file": made[0], "name": "Old"}] if made else []
            self.calls.append((paths, library, openrct2))
            return playlist, records, 1
        self.calls = []
        import importparks
        return mock.patch.object(importparks, "run", side_effect=run)

    def test_add_of_an_rct_save_converts_it_into_a_library(self):
        save = os.path.join(self.lib, "old.sv6")
        self.park(save)
        with self.fake_import(["old.park"]):
            code, build = self.run_task(mksequence.live_add, "My List", save, self.user, "/games/openrct2")
        self.assertEqual(code, 0)
        build.assert_called_once()
        paths, library, openrct2 = self.calls[0]
        self.assertEqual((paths, openrct2), ([save], "/games/openrct2"))
        self.assertTrue(library.startswith(os.path.join(self.user, "screensaver", "library")))
        added = self.read()["park"][-1]["file"]
        self.assertTrue(os.path.isfile(os.path.join(self.lib, added)), added)
        texts = [m["text"] for m in self.task("add")["messages"]]
        self.assertTrue(any("converted from SV6" in t for t in texts), texts)
        self.assertTrue(any("restart the game" in t for t in texts), "new objects need a restart")
        self.assertIs(self.read()["park"][-1]["author"], False, "a save has no builders to warn about")

    def test_new_of_a_folder_with_saves_imports_it(self):
        folder = os.path.join(self.tmp.name, "RCT2 saves")
        os.makedirs(folder)
        for n in ("one.sv6", "two.sv6"):
            self.park(os.path.join(folder, n))
        with self.fake_import(["one.park", "two.park"]):
            code, _ = self.run_task(mksequence.live_new, folder, self.user, "/games/openrct2")
        self.assertEqual(code, 0)
        result = self.task("new")
        data = self.read(result["playlist"])
        base = os.path.dirname(result["playlist"])
        self.assertEqual([e["name"] for e in data["park"]], ["One", "Two"])
        self.assertTrue(all(os.path.isfile(os.path.join(base, e["file"])) for e in data["park"]))
        self.assertTrue(os.path.isdir(os.path.join(base, data["park"][-1]["companions"][0].rsplit("/", 1)[0])),
                        "the parks' scripts are found from the new playlist")

    def test_add_of_a_download_with_objects_installs_them_and_reads_it_in_place(self):
        import zipfile
        dl = os.path.join(self.tmp.name, "pack.zip")
        with zipfile.ZipFile(dl, "w") as z:
            z.writestr("pack/park.park", parkinfo.PARK_MAGIC + b"\x00" * 60)
            z.writestr("pack/WALL1.DAT", b"\x00" * 4 + b"WALL1   " + b"\x00" * 8)
        code, _ = self.run_task(mksequence.live_add, "My List", dl, self.user)
        self.assertEqual(code, 0, self.task("add"))
        self.assertEqual(self.read()["park"][-1]["file"], "../pack.zip")
        self.assertIn("WALL1.DAT", os.listdir(os.path.join(self.user, "object", "rct-screensaver")))
        self.assertTrue(any("restart the game" in m["text"] for m in self.task("add")["messages"]))
        # Added again elsewhere (an earlier try installed its objects): still the restart note
        other = os.path.join(self.lib, "other.toml")
        with open(other, "w") as f:
            f.write('name = "Other"\n\n[[park]]\nfile = "a.park"\n')
        mksequence.register_generator(self.user, "Other", other)
        code, _ = self.run_task(mksequence.live_add, "Other", dl, self.user)
        self.assertEqual(code, 0, self.task("add"))
        texts = [m["text"] for m in self.task("add")["messages"]]
        self.assertTrue(any("its objects are in your object folder" in t and "restart" in t for t in texts), texts)

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
        build.assert_not_called()  # (no build: picking it in the game builds it)
        data = self.read(result["playlist"])
        self.assertEqual(data["name"], "RCT Screensaver lib")
        self.assertEqual(len(data["park"]), 4)
        self.assertTrue(all(os.path.isfile(os.path.join(os.path.dirname(result["playlist"]), e["file"])) for e in data["park"]))
        self.assertEqual(mksequence.registered_playlists(self.user)["RCT Screensaver lib"], result["playlist"])
        # its parks, for the game's park list before the first build
        self.assertEqual([p["key"] for p in result["parks"]], ["a.park", "b.park", "c.park", "d.park"])
        self.assertTrue(all(p["name"] for p in result["parks"]))

    def test_add_to_a_new_playlist_works(self):
        """Add park on a playlist New playlist made (its parks as [[park]] tables)."""
        os.remove(os.path.join(self.lib, "d.park"))
        self.run_task(mksequence.live_new, self.lib, self.user)
        made = self.task("new")
        with open(made["playlist"], encoding="utf-8") as f:
            self.assertIn("[[park]]", f.read())
        self.park(os.path.join(self.lib, "d.park"))
        code, _ = self.run_task(mksequence.live_add, made["sequence"], os.path.join(self.lib, "d.park"), self.user)
        self.assertEqual(code, 0, self.task("add"))
        self.assertEqual(len(self.read(made["playlist"])["park"]), 4)

    def test_add_to_a_playlist_with_inline_parks_rewrites_them_as_tables(self):
        """Playlists New playlist made before 2026-11-14 hold their parks as one inline list."""
        with open(self.playlist, "w", encoding="utf-8") as f:
            f.write('# Made from lib\n\nname = "My List"\npark = [\n    {file = "a.park"},\n    {file = "b.park", use = false},\n]\n\n[views]\nmotion = "pans"\n')
        code, _ = self.run_task(mksequence.live_add, "My List", os.path.join(self.lib, "d.park"), self.user)
        self.assertEqual(code, 0, self.task("add"))
        data = self.read()
        self.assertEqual([e["file"] for e in data["park"]], ["a.park", "b.park", "d.park"])
        self.assertEqual((data["park"][1]["use"], data["views"]["motion"]), (False, "pans"))
        with open(self.playlist, encoding="utf-8") as f:
            text = f.read()
        self.assertTrue(text.startswith("# Made from lib\n"), text)

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
        build.assert_not_called()  # (a copy needs no rebuild)
        data = self.read(to)
        self.assertEqual(data["name"], "Evening")
        self.assertEqual([e["file"] for e in data["park"]], ["../../../lib/a.park", "../../../lib/b.park", "../../../lib/c.park"])
        self.assertTrue(os.path.exists(mksequence.edits_path(to)))
        self.assertEqual(self.task("copy")["sequence"], "Evening")
        self.assertFalse(self.task("copy")["built"], "no installed build to take along")
        self.assertEqual(self.read()["name"], "My List", "the original stays")

    def test_copy_takes_the_playing_build_along(self):
        installed = os.path.join(self.user, "sequence", "My List")
        os.makedirs(installed)
        for name in ("script.txt", "a.park"):
            with open(os.path.join(installed, name), "w") as f:
                f.write(name)
        self.assertFalse(self.run_task(mksequence.live_copy, "My List", os.path.join(self.lib, "Evening.toml"), self.user)[0])
        self.assertTrue(self.task("copy")["built"])
        out_dir, _ = mksequence.live_build_paths("Evening", self.user)
        self.assertEqual(sorted(os.listdir(os.path.join(out_dir, "Evening"))), ["a.park", "script.txt"],
                         "where the game takes builds from (applyBuild)")

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
