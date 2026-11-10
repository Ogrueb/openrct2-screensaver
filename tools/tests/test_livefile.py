"""The game's live file (tools/livefile.py): builds apply it over the playlist's files (mksequence.prepare),
tools/bakelive.py writes it into them and marks it baked, and only its own playlist takes it."""
import json, os, sys, tempfile, tomllib, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import bakelive, livefile, mksequence  # noqa: E402

PLAYLIST = """# my playlist
name = "Mine Too"

[views]
change_hold = 2.0

[[park]]
file = "a.park"  # first

[[park]]
file = "b.park"
"""

VIEW = {"x": 10, "y": 12, "z": 48, "rotation": 1, "zoom": -1, "hold": 6, "manual": True}


class LiveFile(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.user = os.path.join(self.dir, "user")
        self.playlist = os.path.join(self.dir, "mine.toml")
        with open(self.playlist, "w", encoding="utf-8") as f:
            f.write(PLAYLIST)

    def write_live(self, edits=None, props=None, saved=1000, sequence="Mine Too", source=None):
        os.makedirs(livefile.folder(self.user), exist_ok=True)
        with open(livefile.path(sequence, self.user), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "sequence": sequence, "source": source or self.playlist, "saved": saved,
                       "edits": edits or {}, "props": props or {}}, f)

    def prepare(self):
        return mksequence.prepare(self.playlist, user_dir=self.user)

    def test_file_name(self):
        self.assertEqual(livefile.file_name("Mine Too"), "Mine_Too.json")
        self.assertEqual(livefile.file_name("..a/b\\c"), "a_b_c.json")
        self.assertEqual(livefile.file_name(""), "playlist.json")

    def test_build_applies_live(self):
        self.write_live({"a.park": {"views": [VIEW], "screen": [1920, 1080]}, "b.park": {"views": [dict(VIEW, manual=False)]}},
                        {"order": ["b.park", "a.park"], "changeHold": 3.0})
        ctx = self.prepare()
        self.assertEqual([e["file"] for e in ctx["entries"]], ["b.park", "a.park"], "park order from the game")
        self.assertEqual(ctx["defaults"]["change_hold"], 3.0)
        self.assertEqual(ctx["edits"]["a.park"]["views"], [VIEW])
        self.assertNotIn("b.park", ctx["edits"], "an edit that pins nothing is generated afresh")
        ctx = mksequence.prepare(self.playlist, user_dir=self.user, use_live=False)
        self.assertEqual([e["file"] for e in ctx["entries"]], ["a.park", "b.park"], "--ignore-live")

    def test_reset_drops_views_file_views(self):
        mksequence.save_edits(mksequence.edits_path(self.playlist), {"a.park": {"views": [VIEW], "arranged": True}})
        self.assertIn("a.park", self.prepare()["edits"])
        self.write_live({"a.park": {"reset": True}})
        self.assertNotIn("a.park", self.prepare()["edits"])

    def test_other_playlist_ignored(self):
        other = os.path.join(self.dir, "other.toml")
        with open(other, "w", encoding="utf-8") as f:
            f.write(PLAYLIST)
        self.write_live(props={"order": ["b.park"]}, source=other)
        self.assertIsNone(self.prepare()["live"], "same name, another playlist file")

    def test_bake(self):
        self.write_live({"a.park": {"views": [VIEW], "arranged": True}}, {"order": ["b.park", "a.park"], "inertia": True})
        live = livefile.for_playlist(self.playlist, "Mine Too", self.user)
        bakelive.bake(self.playlist, live, self.user)
        with open(self.playlist, encoding="utf-8") as f:
            text = f.read()
        data = tomllib.loads(text)
        self.assertEqual([p["file"] for p in data["park"]], ["b.park", "a.park"])
        self.assertIs(data["views"]["inertia"], True)
        self.assertIn("# first", text, "comments kept")
        self.assertEqual(mksequence.load_edits(mksequence.edits_path(self.playlist))["a.park"]["views"], [VIEW])
        self.assertIsNone(livefile.for_playlist(self.playlist, "Mine Too", self.user), "baked: builds skip it")
        self.assertIsNone(self.prepare()["live"])
        self.write_live({"a.park": {"views": [VIEW], "arranged": True}}, {"inertia": False}, saved=2000)
        self.assertIsNotNone(self.prepare()["live"], "a newer save from the game applies again")


if __name__ == "__main__":
    unittest.main()
