"""Lay out the screensaver's files as they ship inside OpenRCT2's data folder, for an engine release.

Usage: python tools/mkshipped.py OUT [--python-zip PYTHON_EMBED_ZIP]

Writes into OUT (a data folder, or an empty folder merged into one later):
  plugin/rct-screensaver.js            the plugin; the patched engine loads plugins from <data>/plugin
  plugin/rct-screensaver/icons/*.png   its icons (the overlay looks there after the user plugin folder)
  screensaver/tools/                   the generator (mksequence.py and what it imports, tools/data)
  screensaver/parks/                   the shipped park profiles
  screensaver/plugin/dist/companion-host.js   the host the generator wraps parks' scripts in
  screensaver/python/                  with --python-zip: Python's embeddable package (Windows), which the
                                       engine runs the generator with when no generator.json names one
A file of the same name in the user's plugin folder replaces the shipped plugin (mksequence.py --install
puts the source tree's copy there).
"""
import argparse, os, shutil, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The generator's tools: everything the game's build buttons run (mksequence.py --live-*) and the command
# line tools that go with a playlist. Not the PC-only tools (renders, perf runs, icon drawing, the
# settings page's browser files stay in the source archive).
TOOLS = ("mksequence.py", "companions.py", "parkinfo.py", "profiles.py", "districts.py", "unzstd.py",
         "nedesigns.py", "livefile.py", "bakelive.py", "bundle.py", "importparks.py", "tomlwrite.py",
         "userdata.py")


def copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)


def lay_out(out, python_zip=None):
    plugin = os.path.join(ROOT, "plugin", "dist", "rct-screensaver.js")
    host = os.path.join(ROOT, "plugin", "dist", "companion-host.js")
    for need in (plugin, host):
        if not os.path.isfile(need):
            raise SystemExit("missing %s: build the plugin first (npm run build in plugin/)" % need)
    copy(plugin, os.path.join(out, "plugin", "rct-screensaver.js"))
    icons = os.path.join(out, "plugin", "rct-screensaver", "icons")
    if os.path.isdir(icons):
        shutil.rmtree(icons)
    shutil.copytree(os.path.join(ROOT, "plugin", "icons"), icons)
    ship = os.path.join(out, "screensaver")
    if os.path.isdir(ship):
        shutil.rmtree(ship)
    for name in TOOLS:
        copy(os.path.join(ROOT, "tools", name), os.path.join(ship, "tools", name))
    shutil.copytree(os.path.join(ROOT, "tools", "data"), os.path.join(ship, "tools", "data"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(ROOT, "parks"), os.path.join(ship, "parks"))
    copy(host, os.path.join(ship, "plugin", "dist", "companion-host.js"))
    copy(os.path.join(ROOT, "LICENSE"), os.path.join(ship, "LICENSE"))
    if python_zip:
        python = os.path.join(ship, "python")
        with zipfile.ZipFile(python_zip) as z:
            z.extractall(python)
        if not os.path.isfile(os.path.join(python, "python.exe")):
            raise SystemExit("%s holds no python.exe: not Python's embeddable package" % python_zip)
    count = sum(len(files) for _, _, files in os.walk(out))
    print("laid out %d files in %s" % (count, out))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", help="the folder to write (OpenRCT2's data folder, or one merged into it)")
    ap.add_argument("--python-zip", help="Python's Windows embeddable package (python-3.x-embed-amd64.zip)")
    args = ap.parse_args()
    lay_out(args.out, args.python_zip)


if __name__ == "__main__":
    sys.exit(main())
