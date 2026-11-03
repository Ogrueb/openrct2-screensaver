"""The playlist's Show titles (top-level `titles`) reaches the installed playlist (mksequence.playlist_data)."""
import os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import mksequence  # noqa: E402


class Titles(unittest.TestCase):
    def test_titles_in_playlist(self):
        for titles in mksequence.TITLES:
            self.assertEqual(mksequence.playlist_data("T", [], titles=titles)["titles"], titles)

    def test_absent_leaves_the_viewer_choice(self):
        self.assertNotIn("titles", mksequence.playlist_data("T", []))


if __name__ == "__main__":
    unittest.main()
