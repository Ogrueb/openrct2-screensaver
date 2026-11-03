"""Rebuilding only the parks that changed (mksequence.ParkCache), and drawn views getting the park's
event views on top. Builds an example park, so it takes a few seconds."""
import contextlib, io, json, os, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import mksequence  # noqa: E402

PARK = os.path.join(HERE, "..", "..", "ExampleParks", "230206-rct2-xtreme97-qhyre_rock.zip")


@unittest.skipUnless(os.path.exists(PARK), "example park not available")
class ParkCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.playlist = os.path.join(self.tmp.name, "t.toml")
        with open(self.playlist, "w") as f:
            f.write('name = "T"\n\n[[park]]\nfile = %s\n' % json.dumps(os.path.abspath(PARK)))
        self.cache = os.path.join(self.tmp.name, "cache")

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, cache=True):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            result = mksequence.build(self.playlist, os.path.join(self.tmp.name, "out"), use_profiles=False,
                                      cache_dir=self.cache if cache else None)
        return result, err.getvalue()

    def test_builders_from_the_catalogue_at_build(self):
        # The entry has no author: the build checks the NE catalogue (owner, 2026-11-03).
        result, _ = self.build(cache=False)
        self.assertEqual(result["playlist"]["parks"][0]["author"], "Xtreme97")
        self.assertTrue(any("NE catalog" in w for w in result["parks"][0]["warnings"]))

    def test_scanned_loose_park_gets_builders(self):
        import zipfile
        import settings
        folder = os.path.join(self.tmp.name, "scan")
        os.makedirs(folder)
        with zipfile.ZipFile(PARK) as z:
            member = next(n for n in z.namelist() if n.lower().endswith(".park"))
            with open(os.path.join(folder, "230206-rct2-xtreme97-qhyre_rock.park"), "wb") as f:
                f.write(z.read(member))
        entries, _ = settings.scan_folder(folder)
        self.assertEqual(entries[0].get("author"), "Xtreme97")

    def test_unchanged_park_comes_from_the_cache(self):
        first, _ = self.build()
        self.assertEqual(mksequence.changed_parks(self.playlist, self.cache, use_profiles=False), [])
        again, log = self.build()
        self.assertIn("rebuilt 0 of 1", log)
        self.assertEqual(again["playlist"], first["playlist"])
        plain, _ = self.build(cache=False)
        self.assertEqual(plain["playlist"], first["playlist"])

    def test_edited_park_is_rebuilt_with_its_drawn_views(self):
        first, _ = self.build()
        key = first["parks"][0]["key"]
        mksequence.save_edits(mksequence.edits_path(self.playlist), {key: {"arranged": True, "views": [
            {"x": 76, "y": 29, "z": 80, "rotation": 1, "zoom": 0, "hold": 9, "manual": True},
            {"x": 70, "y": 25, "z": 80, "rotation": 1, "zoom": -1, "hold": 6, "manual": True, "animation": "old"}]}})
        self.assertEqual(mksequence.changed_parks(self.playlist, self.cache, use_profiles=False), [key])
        result, log = self.build()
        self.assertIn("rebuilt 1 of 1", log)
        views = result["parks"][0]["views"]
        self.assertEqual([(v["x"], v["hold"]) for v in views], [(76, 9)])  # a saved event view is left out


    def test_generator_update_is_told_apart(self):
        self.build()
        real = mksequence.code_version
        try:
            mksequence.code_version = lambda: "a newer generator"
            detail = mksequence.changed_parks(self.playlist, self.cache, use_profiles=False, detail=True)
        finally:
            mksequence.code_version = real
        self.assertEqual(detail["parks"], [])
        self.assertEqual(len(detail["updated"]), 1)

    def test_same_file_with_a_new_time_comes_from_the_cache(self):
        park = os.path.join(self.tmp.name, "park.zip")  # a copy: its file time is changed below
        shutil.copyfile(PARK, park)
        with open(self.playlist, "w") as f:
            f.write('name = "T"\n\n[[park]]\nfile = %s\n' % json.dumps(park))
        self.build()
        st = os.stat(park)
        os.utime(park, ns=(st.st_atime_ns, st.st_mtime_ns + 10 ** 10))  # copied again: same bytes, later time
        self.assertEqual(mksequence.changed_parks(self.playlist, self.cache, use_profiles=False), [])

if __name__ == "__main__":
    unittest.main()
