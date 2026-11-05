"""Playlist bundles round trip (tools/bundle.py): with and without the park files and a build."""
import json, os, sys, tempfile, tomllib, unittest, zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bundle  # noqa: E402


def write(path, data, mode="w"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode) as f:
        f.write(data)


class Bundles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        src = os.path.join(self.root, "src")
        write(os.path.join(src, "parks", "a.park"), b"park a", "wb")
        write(os.path.join(src, "parks", "deep", "b.park"), b"park b", "wb")
        self.playlist = os.path.join(src, "lists", "mine.toml")
        write(self.playlist, 'name = "My List"\n\n[[park]]\nfile = "../parks/a.park"\n\n'
                             '[[park]]\nfile = "../parks/deep/b.park"\nhold = 9\n')
        write(os.path.join(src, "lists", "mine.views.json"), '{"a.park": {"views": []}}')
        self.profile = os.path.join(src, "profiles", "a-park.toml")
        write(self.profile, '[match]\nname = "A"\n')
        self.out = os.path.join(self.root, "out.zip")
        self.dest = {k: os.path.join(self.root, "dest", k) for k in ("playlists", "profiles", "parks", "build")}

    def tearDown(self):
        self.tmp.cleanup()

    def unpack(self, park_dir=None):
        d = self.dest
        return bundle.import_bundle(self.out, park_dir, d["playlists"], d["profiles"], d["parks"], d["build"], log=lambda s: None)

    def parks_of(self, result):
        with open(result["playlist"], "rb") as f:
            data = tomllib.load(f)
        base = os.path.dirname(result["playlist"])
        return data, [os.path.normpath(os.path.join(base, e["file"])) for e in data["park"]]

    def test_without_parks_finds_them_in_the_park_folder(self):
        manifest = bundle.export(self.playlist, self.out, profile_files=[self.profile], log=lambda s: None)
        self.assertFalse(manifest["includesParks"])
        with zipfile.ZipFile(self.out) as z:
            self.assertFalse(any(n.startswith("parks/") for n in z.namelist()))
        library = os.path.join(self.root, "library")
        write(os.path.join(library, "x", "a.park"), b"park a", "wb")
        result = self.unpack(library)
        self.assertEqual(result["missing"], ["b.park"])
        data, paths = self.parks_of(result)
        self.assertEqual(paths[0], os.path.join(library, "x", "a.park"))
        self.assertFalse(os.path.exists(paths[1]))
        self.assertEqual(data["park"][1]["hold"], 9)
        self.assertTrue(os.path.exists(os.path.join(self.dest["playlists"], "my-list.views.json")))
        self.assertTrue(os.path.exists(os.path.join(self.dest["profiles"], "a-park.toml")))

    def test_with_parks_and_build(self):
        build = os.path.join(self.root, "build")
        write(os.path.join(build, "My List", "script.txt"), "LOAD a.park\n")
        write(os.path.join(build, "My List.playlist.json"), "{}")
        write(os.path.join(build, "My List.result.json"), json.dumps({"name": "My List", "source": self.playlist}))
        bundle.export(self.playlist, self.out, parks=True, build_dir=build, log=lambda s: None)
        result = self.unpack()
        self.assertEqual(result["missing"], [])
        self.assertTrue(result["built"])
        _, paths = self.parks_of(result)
        with open(paths[1], "rb") as f:
            self.assertEqual(f.read(), b"park b")
        with open(os.path.join(self.dest["build"], "My List.result.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["source"], os.path.abspath(result["playlist"]))
        self.assertTrue(os.path.exists(os.path.join(self.dest["build"], "My List", "script.txt")))

    def test_unticked_park_goes_by_name_only(self):
        with open(self.playlist, encoding="utf-8") as f:
            text = f.read()
        write(self.playlist, text.replace("hold = 9\n", "hold = 9\nuse = false\n"))
        manifest = bundle.export(self.playlist, self.out, parks=True, log=lambda s: None)
        with zipfile.ZipFile(self.out) as z:
            self.assertEqual(sorted(n for n in z.namelist() if n.startswith("parks/")), ["parks/a.park"])
        self.assertIsNone(manifest["parks"][1]["sha256"])
        result = self.unpack()
        self.assertEqual(result["missing"], ["b.park"])
        data, _ = self.parks_of(result)
        self.assertEqual(data["park"][1]["use"], False)
        self.assertEqual(data["park"][1]["hold"], 9)

    def test_bad_member_is_refused(self):
        with zipfile.ZipFile(self.out, "w") as z:
            z.writestr("../evil", "x")
        with self.assertRaises(ValueError):
            self.unpack()


if __name__ == "__main__":
    unittest.main()
