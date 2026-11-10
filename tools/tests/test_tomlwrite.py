"""tomlwrite.patch: edits in place keep comments; what it can't place falls back (None).
Run: python -m unittest discover -s tools/tests"""
import copy, glob, os, sys, tomllib, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import tomlwrite  # noqa: E402

DOC = '''# A profile
[match]
name = "Park"  # saved name
map = [100, 100]

[extras]
animations = true  # comment kept
show = "eclipse"

[show.eclipse]
hold = 120.0
path = [
    {x = 1, y = 2, ticks = 3},  # first leg
]

[[park]]
file = "a.zip"  # park a

[[park]]
file = "b.zip"
[park.views]
count = 5
'''


def edited(change):
    data = tomllib.loads(DOC)
    change(data)
    return data, tomlwrite.patch(DOC, data)


class Patch(unittest.TestCase):
    def check(self, change):
        data, out = edited(change)
        self.assertIsNotNone(out)
        self.assertEqual(tomllib.loads(out), data)
        return out

    def test_change_value_keeps_trailing_comment(self):
        out = self.check(lambda d: d["extras"].__setitem__("animations", False))
        self.assertIn("animations = false  # comment kept", out)

    def test_add_key_to_table_and_new_table(self):
        out = self.check(lambda d: (d["extras"].__setitem__("animation_hold", 20.0),
                                    d.setdefault("views", {}).__setitem__("count", 7)))
        self.assertIn('show = "eclipse"\nanimation_hold = 20.0\n', out)
        self.assertTrue(out.rstrip().endswith("[views]\ncount = 7"))

    def test_remove_key_and_table(self):
        out = self.check(lambda d: (d["extras"].pop("show"), d.pop("show")))
        self.assertNotIn("[show.eclipse]", out)
        self.assertIn("# A profile", out)

    def test_multiline_value_replaced(self):
        self.check(lambda d: d["show"]["eclipse"].__setitem__("path", [{"x": 5, "y": 6, "ticks": 7}]))

    def test_top_level_key_before_first_table(self):
        out = self.check(lambda d: d.__setitem__("companions", False))
        self.assertLess(out.index("companions = false"), out.index("[match]"))

    def test_key_added_after_a_wrapped_comment(self):
        doc = 'music = "keep"   # first line of a comment\n                 # its second line\n\n[views]\ncount = 4\n'
        data = tomllib.loads(doc)
        data["titles"] = "overview"
        out = tomlwrite.patch(doc, data)
        self.assertEqual(tomllib.loads(out), data)
        self.assertIn("# its second line\ntitles = ", out)
        del data["titles"], data["music"]
        out = tomlwrite.patch(doc, data)
        self.assertNotIn("second line", out)

    def test_array_entry_edited_in_place(self):
        out = self.check(lambda d: (d["park"][0].__setitem__("use", False),
                                    d["park"][0].setdefault("views", {}).__setitem__("count", 3)))
        self.assertLess(out.index("use = false"), out.index('file = "b.zip"'))
        self.assertLess(out.index("count = 3"), out.index('file = "b.zip"'))

    def test_reorder_falls_back(self):
        self.assertIsNone(edited(lambda d: d["park"].reverse())[1])

    def test_repo_files_unchanged_by_identity_patch(self):
        for path in glob.glob(os.path.join(ROOT, "playlists", "*.toml")) + glob.glob(os.path.join(ROOT, "parks", "*.toml")):
            with open(path, encoding="utf-8") as f:
                text = f.read()
            self.assertEqual(tomlwrite.patch(text, tomllib.loads(text)), text if text.endswith("\n") else text + "\n", path)


if __name__ == "__main__":
    unittest.main()
