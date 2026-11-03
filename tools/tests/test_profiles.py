"""Profiles in the user folder replace the repository's of the same name (tools/profiles.py)."""
import os, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import profiles  # noqa: E402


class UserProfiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("RCT_SCREENSAVER_HOME")
        os.environ["RCT_SCREENSAVER_HOME"] = self.tmp.name
        self.user = os.path.join(self.tmp.name, "parks")
        os.makedirs(self.user)

    def tearDown(self):
        if self.old is None:
            os.environ.pop("RCT_SCREENSAVER_HOME", None)
        else:
            os.environ["RCT_SCREENSAVER_HOME"] = self.old
        self.tmp.cleanup()

    def test_repository_profiles_without_user_folder_copies(self):
        loaded = profiles.load()
        self.assertIn("sambhavas-rest", loaded)
        self.assertEqual(loaded["sambhavas-rest"]["source"], "repo")

    def test_user_copy_replaces_and_new_one_adds(self):
        with open(os.path.join(self.user, "sambhavas-rest.toml"), "w", encoding="utf-8") as f:
            f.write('[match]\nname = "Sambhava\'s Rest"\n\n[views]\ncount = 3\n')
        with open(os.path.join(self.user, "my-park.toml"), "w", encoding="utf-8") as f:
            f.write('[match]\nname = "My Park"\n')
        loaded = profiles.load()
        self.assertEqual(loaded["sambhavas-rest"]["source"], "user")
        self.assertEqual(loaded["sambhavas-rest"]["views"], {"count": 3})
        self.assertEqual(loaded["my-park"]["source"], "user")
        self.assertEqual(profiles.load(user=False)["sambhavas-rest"]["source"], "repo")


if __name__ == "__main__":
    unittest.main()
