"""Playlist bundles: one zip that carries a playlist to another machine (owner, 2026-10-31).

Usage:
  python tools/bundle.py export PLAYLIST.toml OUT.zip [--parks] [--build DIR] [--profile FILE...]
  python tools/bundle.py import BUNDLE.zip [--park-dir DIR] [--playlists DIR] [--profiles DIR]
                                          [--parks-to DIR] [--build-to DIR]

A bundle holds:
  bundle.json         format, the playlist's name, whether parks and a build are included, and each
                      park's file name, size and SHA-256 (to find it again where parks are not included)
  playlist.toml       the playlist, its park files as parks/<file name>
  playlist.views.json the view editor's pinned views, when the playlist has them
  profiles/*.toml     the park profiles the user changed (the shipped ones come with the screensaver)
  parks/              with --parks: the park files themselves (optional)
  build/              with --parks and --build: the built sequence (sequence folder, playlist, companions),
                      so the receiver can render and install without building

Importing writes the playlist into the user's playlists folder, the profiles into the user's profiles
folder (a backup of any file replaced goes to the caller), the parks (when included) under
--parks-to, and the build (when included) into --build-to. Parks the bundle does not carry are looked
for in --park-dir by file name (the SHA-256 picks between several); the rest stay listed as missing.
The structure of the screensaver's own folders is unchanged: a bundle is only packed from them and
unpacked into them.
"""
import argparse, datetime, hashlib, json, os, re, shutil, sys, tomllib, zipfile

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import mksequence, tomlwrite  # noqa: E402

FORMAT = 1
HEADER = "Imported from a playlist bundle by tools/bundle.py; comments are not kept."


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def export(playlist_path, out_path, parks=False, build_dir=None, profile_files=(), log=print):
    """Writes the bundle; returns its manifest. build_dir is the folder holding the playlist's built
    sequence (<name>/, <name>.playlist.json, ...); it goes in only with the parks."""
    with open(playlist_path, "rb") as f:
        data = tomllib.load(f)
    base = os.path.dirname(os.path.abspath(playlist_path))
    name = data.get("name") or os.path.splitext(os.path.basename(playlist_path))[0]
    entries, files, used = [], [], set()
    for e in data.get("park", []):
        path = os.path.normpath(os.path.join(base, e["file"]))
        if not os.path.exists(path) and e.get("use", True):
            raise ValueError("%s is missing; a bundle needs every park it plays (untick it to leave it out)" % path)
        file_name = os.path.basename(path)
        stem, ext = os.path.splitext(file_name)
        n = 2
        while file_name.lower() in used:  # two parks of one name from different folders
            file_name, n = "%s-%d%s" % (stem, n, ext), n + 1
        used.add(file_name.lower())
        files.append((path, file_name))
        entries.append(dict(e, file="parks/" + file_name))
    manifest = {"format": FORMAT, "name": name, "created": datetime.datetime.now().isoformat(timespec="seconds"),
                "includesParks": bool(parks), "includesBuild": False,
                # An unticked park that is missing itself is listed by name only
                "parks": [{"file": file_name, "size": os.path.getsize(path), "sha256": sha256(path)} if os.path.exists(path)
                          else {"file": file_name, "size": None, "sha256": None} for path, file_name in files],
                "profiles": []}
    built = None
    if parks and build_dir:
        built = os.path.join(build_dir, name)
        if not (os.path.isdir(built) and os.path.exists(built + ".result.json")):
            raise ValueError("no build of %s in %s; build it first" % (name, build_dir))
        manifest["includesBuild"] = True
    tmp = out_path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("playlist.toml", tomlwrite.dumps(dict(data, park=entries), HEADER))
        views = mksequence.edits_path(playlist_path)
        if os.path.exists(views):
            z.write(views, "playlist.views.json")
        for profile in profile_files:
            z.write(profile, "profiles/" + os.path.basename(profile))
            manifest["profiles"].append(os.path.basename(profile))
        if parks:
            for path, file_name in files:
                if not os.path.exists(path):
                    continue
                log("park %s" % file_name)
                z.write(path, "parks/" + file_name, zipfile.ZIP_STORED)  # parks are compressed already
        if built:
            for suffix in (".playlist.json", ".scores.json", ".result.json"):
                if os.path.exists(built + suffix):
                    z.write(built + suffix, "build/" + name + suffix)
            for folder in (built, built + ".companions"):
                for top, _, names in os.walk(folder):
                    for n in names:
                        full = os.path.join(top, n)
                        z.write(full, "build/" + os.path.relpath(full, build_dir).replace(os.sep, "/"),
                                zipfile.ZIP_STORED if n.endswith(".park") else zipfile.ZIP_DEFLATED)
        z.writestr("bundle.json", json.dumps(manifest, indent=1))
    os.replace(tmp, out_path)
    log("wrote %s (%d parks%s%s, %d profiles)" % (out_path, len(files), ", park files included" if parks else "",
                                                  ", build included" if built else "", len(manifest["profiles"])))
    return manifest


def find_park(folder, want):
    """A park file in folder (or below it) with the bundle's file name; the SHA-256 picks between several."""
    if not folder or not os.path.isdir(folder):
        return None
    hits = []
    for top, _, names in os.walk(folder):
        hits += [os.path.join(top, n) for n in names if n.lower() == want["file"].lower()]
    if len(hits) > 1:
        same = [h for h in hits if os.path.getsize(h) == want["size"] and sha256(h) == want["sha256"]]
        hits = same or hits
    return hits[0] if hits else None


def safe_member(name):
    if name.startswith(("/", "\\")) or ".." in re.split(r"[\\/]", name) or ":" in name:
        raise ValueError("bad path in bundle: %s" % name)
    return name


def import_bundle(bundle_path, park_dir=None, playlists_dir=None, profiles_dir=None, parks_to=None, build_to=None,
                  backup=None, log=print):
    """Unpacks a bundle. Returns {"playlist": path, "missing": [file names], "built": bool, "name": name}.
    backup(path) is called before any existing file is replaced."""
    backup = backup or (lambda path: None)
    with zipfile.ZipFile(bundle_path) as z:
        for n in z.namelist():
            safe_member(n)
        manifest = json.loads(z.read("bundle.json"))
        if manifest.get("format") != FORMAT:
            raise ValueError("unknown bundle format %r (this screensaver reads %d)" % (manifest.get("format"), FORMAT))
        data = tomllib.loads(z.read("playlist.toml").decode("utf-8"))
        name = manifest["name"]
        slug = mksequence.slug(name) or "bundle"
        os.makedirs(playlists_dir, exist_ok=True)
        target = os.path.join(playlists_dir, slug + ".toml")
        # Park files: from the bundle, else found in the park folder
        located, missing = {}, []
        if manifest.get("includesParks"):
            folder = os.path.join(parks_to, slug)
            os.makedirs(folder, exist_ok=True)
            for want in manifest["parks"]:
                if "parks/" + want["file"] not in z.namelist():  # unticked and missing when exported
                    missing.append(want["file"])
                    continue
                dest = os.path.join(folder, want["file"])
                # The same file already there stays as it is (a new file time would make every park look
                # changed to the build's park cache)
                if not (os.path.exists(dest) and os.path.getsize(dest) == want.get("size") and sha256(dest) == want.get("sha256")):
                    with z.open("parks/" + want["file"]) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
                located[want["file"]] = dest
        else:
            for want in manifest["parks"]:
                found = find_park(park_dir, want)
                if found:
                    located[want["file"]] = found
                else:
                    missing.append(want["file"])
        entries = []
        for e in data.get("park", []):
            file_name = e["file"].split("/", 1)[-1]
            path = located.get(file_name) or os.path.join(park_dir or playlists_dir, file_name)  # missing: where it was looked for
            try:
                rel = os.path.relpath(path, playlists_dir)
            except ValueError:  # another drive
                rel = path
            entries.append(dict(e, file=rel.replace("\\", "/")))
        text = tomlwrite.dumps(dict(data, park=entries), HEADER)
        backup(target)
        with open(target, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        views = mksequence.edits_path(target)
        if "playlist.views.json" in z.namelist():
            backup(views)
            with open(views, "wb") as f:
                f.write(z.read("playlist.views.json"))
        for profile in manifest.get("profiles", []):
            os.makedirs(profiles_dir, exist_ok=True)
            dest = os.path.join(profiles_dir, os.path.basename(profile))
            backup(dest)
            with open(dest, "wb") as f:
                f.write(z.read("profiles/" + os.path.basename(profile)))
        built = False
        if manifest.get("includesBuild") and build_to:
            shutil.rmtree(build_to, ignore_errors=True)
            for n in z.namelist():
                if n.startswith("build/") and not n.endswith("/"):
                    dest = os.path.join(build_to, *n[len("build/"):].split("/"))
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with z.open(n) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
            result = os.path.join(build_to, name + ".result.json")
            with open(result, encoding="utf-8") as f:
                info = json.load(f)
            info["source"] = os.path.abspath(target)  # the build now belongs to the imported playlist
            with open(result, "w", encoding="utf-8") as f:
                json.dump(info, f, indent=1)
            built = True
    log("imported %s: %d parks%s%s" % (target, len(manifest["parks"]),
                                       ", %d missing (%s)" % (len(missing), ", ".join(missing)) if missing else "",
                                       ", build included" if built else ""))
    return {"playlist": target, "missing": missing, "built": built, "name": name}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("export")
    ex.add_argument("playlist")
    ex.add_argument("out")
    ex.add_argument("--parks", action="store_true", help="include the park files (and the build, with --build)")
    ex.add_argument("--build", help="folder with the playlist's built sequence")
    ex.add_argument("--profile", action="append", default=[], help="a user profile to include")
    im = sub.add_parser("import")
    im.add_argument("bundle")
    im.add_argument("--park-dir", help="where to look for parks the bundle does not carry")
    im.add_argument("--playlists", required=True)
    im.add_argument("--profiles", required=True)
    im.add_argument("--parks-to", required=True)
    im.add_argument("--build-to")
    im.add_argument("--json", help="write the result here as JSON")
    args = ap.parse_args()
    try:
        if args.cmd == "export":
            export(args.playlist, args.out, args.parks, args.build, args.profile)
        else:
            result = import_bundle(args.bundle, args.park_dir, args.playlists, args.profiles, args.parks_to,
                                   args.build_to)
            if args.json:
                with open(args.json, "w", encoding="utf-8") as f:
                    json.dump(result, f)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, tomllib.TOMLDecodeError) as e:
        sys.exit("error: %s" % e)


if __name__ == "__main__":
    main()
