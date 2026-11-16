"""The game's park gallery (mksequence.py --live-add --park-list, --live-new-parks, --gallery-details)."""
import contextlib, io, json, os, sys, tempfile, tomllib, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import livefile, mksequence  # noqa: E402


class Gallery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.user = os.path.join(self.tmp.name, "OpenRCT2")
        os.makedirs(self.user)
        self.lib = os.path.join(self.tmp.name, "lib")
        os.makedirs(self.lib)
        for name in ("a.park", "b.park", "c.park", "d.park"):
            with open(os.path.join(self.lib, name), "wb") as f:
                f.write(b"park" * 10)
        self.playlist = os.path.join(self.lib, "my list.toml")
        with open(self.playlist, "w") as f:
            f.write('name = "My List"\n\n[[park]]\nfile = "a.park"\n')
        mksequence.register_generator(self.user, "My List", self.playlist)

    def tearDown(self):
        self.tmp.cleanup()

    def lib_path(self, name):
        return os.path.join(self.lib, name)

    def task(self, name):
        with open(mksequence.task_result_path(name, self.user), encoding="utf-8") as f:
            return json.load(f)

    def run_task(self, fn, *args):
        with mock.patch.object(mksequence, "live_build", return_value=0) as build, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return fn(*args), build

    def files(self, path=None):
        with open(path or self.playlist, "rb") as f:
            return [p["file"] for p in tomllib.load(f)["park"]]

    def test_park_list_file(self):
        path = os.path.join(self.tmp.name, "task-parks.txt")
        with open(path, "w", encoding="utf-8-sig") as f:
            f.write("%s\n\n%s\n" % (self.lib_path("c.park"), self.lib_path("b.park")))
        self.assertEqual(mksequence.read_park_list(path), [self.lib_path("c.park"), self.lib_path("b.park")])
        with open(path, "w") as f:
            f.write("\n")
        with self.assertRaises(ValueError):
            mksequence.read_park_list(path)

    def test_several_parks_go_in_in_their_order_and_build_once(self):
        code, build = self.run_task(mksequence.live_add, "My List", [self.lib_path("c.park"), self.lib_path("b.park")], self.user)
        self.assertEqual(code, 0)
        self.assertEqual(self.files(), ["a.park", "c.park", "b.park"])
        self.assertEqual(build.call_count, 1)
        task = self.task("add")
        self.assertEqual((task["park"], task["parks"]), ("c.park", ["c.park", "b.park"]))

    def test_a_park_that_cannot_be_added_leaves_the_others(self):
        code, build = self.run_task(mksequence.live_add, "My List",
                                    [self.lib_path("a.park"), self.lib_path("d.park")], self.user)
        self.assertEqual(code, 0)
        self.assertEqual(self.files(), ["a.park", "d.park"])
        self.assertTrue(any(m["level"] == "warn" and "a.park" in m["text"] for m in self.task("add")["messages"]))
        code, build = self.run_task(mksequence.live_add, "My List", [self.lib_path("a.park"), self.lib_path("d.park")], self.user)
        self.assertEqual(code, 1)
        build.assert_not_called()

    def test_new_playlist_of_picked_parks(self):
        to = os.path.join(self.user, "screensaver", "playlists", "Evening")
        code, build = self.run_task(mksequence.live_new_parks, [self.lib_path("d.park"), self.lib_path("b.park"),
                                                               os.path.join(self.lib, "notes.txt")], to, self.user)
        self.assertEqual(code, 0)
        build.assert_not_called()
        task = self.task("new")
        self.assertEqual(task["sequence"], "Evening")
        self.assertEqual([p["key"] for p in task["parks"]], ["d.park", "b.park"])
        self.assertEqual([os.path.basename(f) for f in self.files(to + ".toml")], ["d.park", "b.park"])
        self.assertTrue(any("notes.txt" in m["text"] for m in task["messages"]))
        self.assertIn("Evening", mksequence.registered_playlists(self.user))

    def test_new_playlist_needs_a_free_name(self):
        code, _ = self.run_task(mksequence.live_new_parks, [self.lib_path("d.park")],
                                os.path.join(self.tmp.name, "My List.toml"), self.user)
        self.assertEqual(code, 1)
        self.assertIn("another name", self.task("new")["error"])

    def test_details_are_read_once_per_file(self):
        listing = os.path.join(self.tmp.name, "gallery-parks.txt")
        paths = [self.lib_path("a.park"), self.lib_path("b.park"), self.lib_path("gone.park")]
        with open(listing, "w", encoding="utf-8") as f:
            f.write("\n".join(paths))
        facts = {"builders": ["someone"], "scripts": ["Animator"], "events": 2, "name": "A"}
        with mock.patch.object(mksequence, "gallery_park_details", return_value=dict(facts)) as read, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mksequence.gallery_details(listing, self.user), 0)
            self.assertEqual(read.call_count, 2)
            self.assertEqual(mksequence.gallery_details(listing, self.user), 0)
            self.assertEqual(read.call_count, 2, "unchanged files are not read again")
            with open(paths[0], "ab") as f:
                f.write(b"more")
            mksequence.gallery_details(listing, self.user)
            self.assertEqual(read.call_count, 3)
        with open(os.path.join(livefile.folder(self.user), mksequence.GALLERY_DETAILS_FILE)) as f:
            out = json.load(f)
        self.assertTrue(out["done"])
        self.assertEqual(sorted(out["parks"]), sorted(paths[:2]))
        self.assertEqual(out["parks"][paths[1]]["scripts"], ["Animator"])

    def test_an_unreadable_park_is_listed_with_its_error(self):
        listing = os.path.join(self.tmp.name, "gallery-parks.txt")
        with open(listing, "w") as f:
            f.write(self.lib_path("a.park"))
        with contextlib.redirect_stdout(io.StringIO()):
            mksequence.gallery_details(listing, self.user)
        with open(os.path.join(livefile.folder(self.user), mksequence.GALLERY_DETAILS_FILE)) as f:
            park = json.load(f)["parks"][self.lib_path("a.park")]
        self.assertIn("error", park)


if __name__ == "__main__":
    unittest.main()
