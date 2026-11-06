"""Loose objects across park libraries (importparks.py): an import replaces only its own library's
objects. Run: python -m unittest discover -s tools/tests"""
import os, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import importparks  # noqa: E402


class FakeArchive:
    """A download holding loose .DAT objects: {file name: 8-character identifier}."""

    def __init__(self, objects):
        self.blobs = {n: b"\x00" * 4 + ident.ljust(8).encode("latin-1") + b"\x00" * 8 for n, ident in objects.items()}
        self.files = [(n, len(b), 0) for n, b in self.blobs.items()]

    def read(self, name):
        return self.blobs[name]


def run_import(user_dir, source, downloads):
    """What importparks.main does with the objects of `downloads` (FakeArchives) for one import source."""
    owners = importparks.load_owners(user_dir)
    claimed = set()
    installed = importparks.installed_objects(user_dir, owners)
    for archive in downloads:
        importparks.install_objects(archive, user_dir, installed, owners, claimed)
    importparks.save_owners(user_dir, owners, source, claimed)


class LooseObjects(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.user = self.tmp.name
        self.ours = os.path.join(self.user, "object", importparks.OBJECT_SUBDIR)

    def tearDown(self):
        self.tmp.cleanup()

    def files(self):
        return sorted(n for n in os.listdir(self.ours) if n != importparks.OWNERS) if os.path.isdir(self.ours) else []

    def test_second_folder_keeps_first(self):
        run_import(self.user, "folderA", [FakeArchive({"a1.DAT": "AOBJ1", "shared.DAT": "SHARED"})])
        run_import(self.user, "folderB", [FakeArchive({"b1.DAT": "BOBJ1", "shared.DAT": "SHARED"})])
        self.assertEqual(self.files(), ["a1.DAT", "b1.DAT", "shared.DAT"])

    def test_reimport_drops_only_own_unused(self):
        run_import(self.user, "folderA", [FakeArchive({"a1.DAT": "AOBJ1", "shared.DAT": "SHARED"})])
        run_import(self.user, "folderB", [FakeArchive({"shared.DAT": "SHARED"})])
        run_import(self.user, "folderA", [])  # folder A no longer ships anything
        self.assertEqual(self.files(), ["shared.DAT"])  # B still uses it
        run_import(self.user, "folderB", [])
        self.assertEqual(self.files(), [])

    def test_installed_elsewhere_not_copied(self):
        other = os.path.join(self.user, "object", "mine")
        os.makedirs(other)
        with open(os.path.join(other, "x.DAT"), "wb") as f:
            f.write(FakeArchive({"x.DAT": "XOBJ"}).read("x.DAT"))
        run_import(self.user, "folderA", [FakeArchive({"x.DAT": "XOBJ"})])
        self.assertEqual(self.files(), [])

    def test_folder_from_before_the_record_is_kept(self):
        os.makedirs(self.ours)
        with open(os.path.join(self.ours, "old.DAT"), "wb") as f:
            f.write(FakeArchive({"old.DAT": "OLDOBJ"}).read("old.DAT"))
        run_import(self.user, "folderA", [FakeArchive({"a1.DAT": "AOBJ1"})])
        self.assertEqual(self.files(), ["a1.DAT", "old.DAT"])
        run_import(self.user, "folderA", [])  # re-importing never drops the earlier files
        self.assertEqual(self.files(), ["old.DAT"])


if __name__ == "__main__":
    unittest.main()


class Downloads(unittest.TestCase):
    """How a folder given on the command line splits into downloads."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def touch(self, *names):
        for n in names:
            path = os.path.join(self.dir, n)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "wb").close()

    def names(self, each=False):
        return [os.path.basename(p) for p in importparks.downloads([self.dir], each)]

    def test_folder_of_loose_saves_is_one_park_per_file(self):
        self.touch("Fenrir.SV4", "Fiesta!.SV4", "Riverwood Theme Park.SV6", "New.park", "readme.txt")
        self.assertEqual(self.names(), ["Fenrir.SV4", "Fiesta!.SV4", "New.park", "Riverwood Theme Park.SV6"])

    def test_one_save_is_one_download(self):
        self.touch("Park.SV6", "readme.txt")
        self.assertEqual(self.names(), [os.path.basename(self.dir)])

    def test_saves_with_objects_are_one_download(self):
        self.touch("Park v1.SV6", "Park v2.SV6", "SCENERY.DAT")
        self.assertEqual(self.names(), [os.path.basename(self.dir)])

    def test_zips_and_loose_saves_together(self):
        self.touch("A.zip", "B.SV4", "C.SC4")
        self.assertEqual(self.names(), ["A.zip", "B.SV4", "C.SC4"])
