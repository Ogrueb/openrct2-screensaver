"""Import park downloads (zips or unpacked folders) into a park library with a playlist.

Usage: python3 tools/importparks.py <download.zip | folder> ... -o <library dir>
                                    [--openrct2 <openrct2.com>] [--user-dir DIR] [--each]
                                    [--skip-known DIR] [--name NAME] [--force]

For each download:
- archiver junk (__MACOSX/, ._*, .DS_Store, Thumbs.db) is ignored;
- of several parks in one download (versions, "install one only"), the most recently saved one
  wins, then the largest; the others are listed in the playlist as comments;
- loose object files shipped beside the park (.parkobj, .DAT, which readmes ask to install) are
  copied into OpenRCT2's user object folder, under object/rct-screensaver/, unless an object with
  the same identifier is installed already; installed.json there records which imports (by the downloads
  given) use each file, so importing a folder again replaces only that folder's objects;
- RCT1 and RCT2 saves and scenarios (.sv4, .sc4, .sv6, .sc6) are converted to .park with `openrct2 convert` (needs --openrct2;
  the objects above are installed first, as some saves don't open without them);
- the park is stored gzip-compressed as <library>/<download>.park: OpenRCT2 v0.5.x saves with
  zstd, which Python before 3.14 reads only with tools/unzstd.py, slowly;
- plugin .js files shipped with it are copied to <library>/<download>/ for the companion host;
- it gets a name: the saved one, unless that is a placeholder (a "Workbench" save, blank,
  formatting codes only) or shared with another imported park; then the name of a logo or
  icon image in the download, else the download's own name.

Writes <library>/<name>.toml, a playlist of every imported park (rewritten by each import, so copy
it before editing), and <library>/import.json (what was done per download). Parks already in
the library are reused unless their download changed or --force is given.

A folder holding .zip files is read as a folder of downloads (each zip and subfolder is one), and
a folder of several loose saves with no object files beside them (an RCT1/RCT2 Parks folder) as
one park per save; any other folder is one download, unless --each says each of its entries is one. A download
named again later on the command line (e.g. a folder of fixed re-releases) replaces the earlier.
"""
import argparse, hashlib, json, os, re, shutil, struct, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parkinfo  # noqa: E402
from mksequence import default_user_dir, slug  # noqa: E402

OBJECT_EXTENSIONS = (".parkobj", ".dat")
SAVE_EXTENSIONS = (".park",) + parkinfo.LEGACY_EXTENSIONS
OBJECT_SUBDIR = "rct-screensaver"  # under the user object folder
GZIP, ZSTD = 1, 2


def downloads(paths, each=False):
    """The downloads named on the command line, expanding folders of downloads."""
    out = []
    for path in paths:
        path = os.path.abspath(path)
        if not os.path.isdir(path):
            out.append(path)
            continue
        entries = sorted(os.path.join(path, e) for e in os.listdir(path) if not parkinfo.is_junk(e))
        saves = [e for e in entries if os.path.isfile(e) and e.lower().endswith(SAVE_EXTENSIONS)]
        objects = [e for e in entries if os.path.isfile(e) and e.lower().endswith(OBJECT_EXTENSIONS)]
        # A folder of loose saves (several parks side by side, no objects beside them, e.g. an
        # RCT1/RCT2 Parks folder) holds one park per file, not one download with versions.
        loose = len(saves) > 1 and not objects
        if each or loose or any(e.lower().endswith(".zip") for e in entries):
            out += [e for e in entries if os.path.isdir(e) or e.lower().endswith(".zip") or e in saves]
        else:
            out.append(path)
    # A download given again later (a fixed re-release, same name) replaces the earlier one.
    # Names are compared by letters and digits only: re-releases often swap _ for -.
    by_name = {}
    for path in out:
        key = parkinfo.alnum(download_name(path))
        by_name.pop(key, None)
        by_name[key] = path
    return sorted(by_name.values(), key=download_name)


def download_name(path):
    return os.path.splitext(os.path.basename(path.rstrip("/\\")))[0] if not os.path.isdir(path) \
        else os.path.basename(path.rstrip("/\\"))


def file_slug(name):
    return re.sub(r"[^\w.\-\[\]]+", "_", name, flags=re.ASCII).strip("_") or "park"


def object_id(name, blob):
    """The identifier of a loose object file: a .parkobj's id, a .DAT's 8-character name."""
    if name.lower().endswith(".parkobj"):
        try:
            return parkinfo.parkobj_json(blob).get("id")
        except Exception:
            return None
    return blob[4:12].decode("latin-1").rstrip() if len(blob) >= 16 else None


OWNERS = "installed.json"  # in our object folder: {file name: {"id": ..., "sources": [import sources]}}


EARLIER = "(installed before the record)"  # the source of files found in the folder without a record


def load_owners(user_dir):
    """Our object folder's record of which imports use each file. Files in a folder from before
    the record (or with a broken one) are kept under EARLIER, which no import replaces: parks
    imported before it may need them (an earlier version emptied the folder, losing them)."""
    ours = os.path.join(user_dir, "object", OBJECT_SUBDIR)
    try:
        with open(os.path.join(ours, OWNERS), encoding="utf-8") as f:
            owners = json.load(f)["files"]
        return {n: o for n, o in owners.items() if os.path.exists(os.path.join(ours, n))}
    except (OSError, ValueError, KeyError, TypeError):
        pass
    owners = {}
    if os.path.isdir(ours):
        for n in sorted(os.listdir(ours)):
            if n.lower().endswith(OBJECT_EXTENSIONS):
                with open(os.path.join(ours, n), "rb") as f:
                    blob = f.read() if n.lower().endswith(".parkobj") else f.read(16)
                owners[n] = {"id": object_id(n, blob), "sources": [EARLIER]}
    return owners


def save_owners(user_dir, owners, source, claimed):
    """Records that the import `source` (its downloads) uses exactly the files in `claimed`;
    deletes files no import uses."""
    ours = os.path.join(user_dir, "object", OBJECT_SUBDIR)
    for name in list(owners):
        sources = [l for l in owners[name]["sources"] if l != source] + ([source] if name in claimed else [])
        if sources:
            owners[name]["sources"] = sources
        else:
            try:
                os.remove(os.path.join(ours, name))
            except OSError:
                pass
            del owners[name]
    if owners or os.path.isdir(ours):
        os.makedirs(ours, exist_ok=True)
        with open(os.path.join(ours, OWNERS), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "files": owners}, f, indent=1, ensure_ascii=False)


def installed_objects(user_dir, owners=None):
    """{identifier: path} of the objects already in the user object folder: outside our folder,
    plus our folder's files recorded in `owners`."""
    root = os.path.join(user_dir, "object")
    ours = os.path.join(root, OBJECT_SUBDIR)
    found = {}
    for top, dirs, names in os.walk(root):
        if os.path.abspath(top) == os.path.abspath(root) and OBJECT_SUBDIR in dirs:
            dirs.remove(OBJECT_SUBDIR)
        for n in names:
            if n.lower().endswith(OBJECT_EXTENSIONS):
                path = os.path.join(top, n)
                with open(path, "rb") as f:
                    blob = f.read() if n.lower().endswith(".parkobj") else f.read(16)
                ident = object_id(n, blob)
                if ident:
                    found.setdefault(ident, path)
    for name, o in (owners or {}).items():
        if o.get("id"):
            found.setdefault(o["id"], os.path.join(ours, name))
    return found


def install_objects(archive, user_dir, installed, owners=None, claimed=None):
    """Copy the download's loose object files into the user object folder, unless an object with
    the same identifier is there already (OpenRCT2 reports every duplicate as a conflict):
    [(file, id, where it is installed)]. Files of our folder it uses (new or already there) go
    into `claimed`; new ones into `owners`."""
    dest = os.path.join(user_dir, "object", OBJECT_SUBDIR)
    owners = {} if owners is None else owners
    claimed = set() if claimed is None else claimed
    out = []
    for name, _, _ in archive.files:
        if not name.lower().endswith(OBJECT_EXTENSIONS):
            continue
        blob = archive.read(name)
        ident = object_id(name, blob)
        if ident not in installed or ident is None:
            target = os.path.join(dest, os.path.basename(name))
            if os.path.exists(target):  # another object under the same file name
                target = os.path.join(dest, "%s-%s" % (hashlib.sha256(blob).hexdigest()[:8], os.path.basename(name)))
            os.makedirs(dest, exist_ok=True)
            with open(target, "wb") as f:
                f.write(blob)
            owners[os.path.basename(target)] = {"id": ident, "sources": []}
            if ident:
                installed[ident] = target
        where = installed.get(ident)
        if where and os.path.dirname(os.path.abspath(where)) == os.path.abspath(dest):
            claimed.add(os.path.basename(where))
        out.append((os.path.basename(name), ident, installed.get(ident)))
    return out


def convert(openrct2, archive, member):
    """A legacy save converted by `openrct2 convert`, as .park bytes. It runs with OpenRCT2's own user
    folder: its convert command takes no options (v0.5.6 rejects --user-data-path in any position)."""
    tmp = tempfile.mkdtemp(prefix="rct-import-")
    try:
        src = os.path.join(tmp, "in" + os.path.splitext(member)[1].lower())
        out = os.path.join(tmp, "out.park")
        with open(src, "wb") as f:
            f.write(archive.read(member))
        cmd = [openrct2, "convert", src, out]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        result = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=900,
                                creationflags=flags)
        if result.returncode != 0 or not os.path.exists(out):
            # Without the terminal colour codes OpenRCT2 writes (TOML comments can't hold them).
            log = re.sub(r"\x1b\[[0-9;]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]", "",
                         result.stdout + result.stderr).strip().splitlines()
            raise RuntimeError("openrct2 convert failed (exit %d): %s"
                               % (result.returncode, " / ".join(log[-3:]) or "no output"))
        with open(out, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def gzipped(data):
    """The park, gzip-compressed if it was saved with zstd."""
    if struct.unpack_from("<I", data, 24)[0] == ZSTD:
        return parkinfo.save(data, {})
    return data


def park_facts(data):
    """Saved name, scenario name, map size and the JSON objects it uses but neither packs nor
    ships (OpenRCT2 must find those installed)."""
    hdr, chunks, body = parkinfo.load(data)
    saved = parkinfo.parse_park(parkinfo.chunk_reader(chunks, body, 6), hdr["target"])["name"]
    scenario = parkinfo.parse_scenario(parkinfo.chunk_reader(chunks, body, 3), hdr["target"])["scenarioName"] \
        if 3 in chunks else ""
    tiles = parkinfo.chunk_reader(chunks, body, 0x30)
    size = (tiles.u32(), tiles.u32())
    used = parkinfo.parse_objects(parkinfo.chunk_reader(chunks, body, 2))
    packed = {p[1] for p in parkinfo.parse_packed(parkinfo.chunk_reader(chunks, body, 0x80))} if 0x80 in chunks else set()
    needed = sorted({e[1] for entries in used.values() for e in entries
                     if e[0] == "json" and not e[1].startswith(parkinfo.SHIPPED_PREFIXES) and e[1] not in packed})
    return {"savedName": saved, "scenarioName": scenario, "mapSize": list(size), "needsObjects": needed}


def known_hashes(dirs):
    """sha256 of every park in the downloads under dirs (to skip parks imported elsewhere)."""
    hashes = {}
    for d in dirs:
        for path in downloads([d]):
            archive = parkinfo.Archive(path)
            for name, _, _ in archive.parks():
                hashes[hashlib.sha256(archive.read(name)).hexdigest()] = "%s/%s" % (os.path.basename(path), name)
    return hashes


def import_one(path, args, user_dir, library, previous):
    folder = download_name(path)
    stem = file_slug(folder)
    archive = parkinfo.Archive(path)
    parks = [("park",) + f for f in archive.parks()] + [("legacy",) + f for f in archive.legacy()]
    record = {"download": path, "folder": folder, "notes": [], "warnings": []}
    if not parks:
        record["warnings"].append("no park in this download")
        return record
    # The latest, then largest park wins; if it can't be converted, the next one does.
    parks.sort(key=lambda p: (p[3], p[2]), reverse=True)
    record["objects"] = None
    out_file = os.path.join(library, stem + ".park")
    for chosen in parks:
        kind, member, size, mtime = chosen
        record.update({"member": member, "kind": kind, "others": [p[1] for p in parks if p is not chosen]})
        raw = archive.read(member)
        record["sha256"] = hashlib.sha256(raw).hexdigest()
        if record["sha256"] in args.known:
            record["skipped"] = "same park as %s" % args.known[record["sha256"]]
            return record
        if record["objects"] is None:
            record["objects"] = [{"file": f, "id": i, "installed": w}
                                 for f, i, w in install_objects(archive, user_dir, args.installed, args.owners, args.claimed)]
        old = previous.get(folder)
        if (not args.force and old and old.get("sha256") == record["sha256"] and old.get("file")
                and os.path.exists(out_file)):
            with open(out_file, "rb") as f:
                data = f.read()
            break
        if kind == "legacy":
            if not args.openrct2:
                record["warnings"].append("RCT save %s needs --openrct2 to be converted" % member)
                continue
            try:
                raw = convert(args.openrct2, archive, member)
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
                record["warnings"].append("%s: %s" % (member, e))
                continue
        data = gzipped(raw)
        with open(out_file, "wb") as f:
            f.write(data)
        break
    else:
        return record
    record["file"] = os.path.basename(out_file)
    if kind == "legacy":
        record["notes"].append("converted from %s" % os.path.splitext(member)[1].upper().lstrip("."))
    elif not member.lower().endswith(".park"):
        record["notes"].append("%s is a .park file" % os.path.basename(member))
    record.update(park_facts(data))

    loose = {o["id"] for o in record["objects"]}
    missing = [i for i in record["needsObjects"] if i not in loose]
    if missing:
        record["warnings"].append("uses objects it doesn't pack or ship (must be installed): %s" % ", ".join(missing))

    scripts = [f[0] for f in archive.files if f[0].lower().endswith(".js")]
    companions = []
    for name in scripts:
        dest = os.path.join(library, stem, os.path.basename(name))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(archive.read(name))
        companions.append("%s/%s" % (stem, os.path.basename(name)))
    record["companions"] = companions
    record["authors"] = parkinfo.download_authors(folder, member, record.get("savedName"))
    record["names"] = [f[0] for f in archive.files]
    return record


def name_parks(records):
    """Give each park its shown name (see the module doc)."""
    def key(name):
        return parkinfo.clean_name(name).lower()
    counts = {}
    for r in records:
        if "savedName" in r:
            counts[key(r["savedName"])] = counts.get(key(r["savedName"]), 0) + 1
    for r in records:
        names = r.pop("names", [])
        if "savedName" not in r:
            continue
        name, source = parkinfo.display_name(r["savedName"], r["folder"], r["member"], names)
        if source == "saved name" and counts[key(r["savedName"])] > 1:
            name, source = parkinfo.fallback_name(r["folder"], r["member"], names)
            source += ", saved name shared"
        r["name"], r["nameSource"] = name, source


def toml_string(text):
    return json.dumps(text, ensure_ascii=False)


def write_playlist(path, name, records):
    lines = ["# Parks imported by tools/importparks.py. Each import rewrites this file: copy it to edit.",
             "# Build and install it (close OpenRCT2 first) with:",
             "#   python tools/mksequence.py \"%s\" --install" % path,
             "name = %s" % toml_string(name),
             'order = "playlist"',
             'layout = "plugin"']
    for r in records:
        if "file" not in r:
            continue
        lines += ["", "[[park]]", "# %s: %s%s" % (r["folder"], r["member"], " (%s)" % ", ".join(r["notes"]) if r["notes"] else "")]
        if r["nameSource"] != "saved name":
            lines.append("# name from the %s; saved as %s" % (r["nameSource"], toml_string(r["savedName"])))
        if r["others"]:
            lines.append("# also in the download: %s" % ", ".join(r["others"]))
        if r["objects"]:
            lines.append("# loose objects (installed once each): %s" % ", ".join(o["file"] for o in r["objects"]))
        lines += ["# warning: %s" % re.sub(r"[\x00-\x1f\x7f]", "", w) for w in r["warnings"]]
        lines += ["file = %s" % toml_string(r["file"]), "name = %s" % toml_string(r["name"])]
        if r["authors"]:
            lines.append("author = %s" % toml_string(", ".join(r["authors"])))
        if r["companions"]:
            lines.append("companions = [%s]" % ", ".join(toml_string(c) for c in r["companions"]))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("downloads", nargs="+", help="park downloads: .zip files, folders, or folders of them")
    ap.add_argument("-o", "--out", required=True, help="library folder for the parks and the playlist")
    ap.add_argument("--openrct2", help="OpenRCT2 executable for converting RCT2 saves (on Windows openrct2.com)")
    ap.add_argument("--user-dir", help="OpenRCT2 user directory for loose objects (default: %s); "
                    "save conversion always uses OpenRCT2's own" % default_user_dir())
    ap.add_argument("--each", action="store_true", help="each entry of a given folder is one download")
    ap.add_argument("--skip-known", action="append", default=[], metavar="DIR",
                    help="skip parks identical to one in the downloads in DIR (e.g. ExampleParks)")
    ap.add_argument("--name", default="RCT Screensaver Imported", help="playlist (title sequence) name")
    ap.add_argument("--force", action="store_true", help="convert and copy parks again even if unchanged")
    args = ap.parse_args()
    user_dir = args.user_dir or default_user_dir()
    library = os.path.abspath(args.out)
    os.makedirs(library, exist_ok=True)
    manifest = os.path.join(library, "import.json")
    previous = {}
    if os.path.exists(manifest):
        with open(manifest, encoding="utf-8") as f:
            previous = {r["folder"]: r for r in json.load(f).get("downloads", [])}
    args.known = known_hashes(args.skip_known)
    # Loose objects: installed once per identifier; this import's claims are recorded afresh
    args.owners = load_owners(user_dir)
    args.claimed = set()
    args.installed = installed_objects(user_dir, args.owners)

    records = []
    for path in downloads(args.downloads, args.each):
        record = import_one(path, args, user_dir, library, previous)
        records.append(record)
        state = record.get("skipped") or ("ok" if "file" in record else "not imported")
        print("%-60s %s" % (record["folder"][:60], state))
        for w in record["warnings"]:
            print("  warning:", w)
    # Keyed by what was imported, so another folder imported into the same library keeps its objects
    save_owners(user_dir, args.owners, "|".join(sorted(os.path.normcase(os.path.abspath(d)) for d in args.downloads)),
                args.claimed)
    name_parks(records)
    playlist = os.path.join(library, file_slug(args.name) + ".toml")
    write_playlist(playlist, args.name, records)
    with open(manifest, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "downloads": records}, f, indent=1, ensure_ascii=False)
    done = [r for r in records if "file" in r]
    print("imported %d of %d downloads (%d converted, %d renamed); playlist: %s"
          % (len(done), len(records), sum(r["kind"] == "legacy" for r in done),
             sum(r["nameSource"] != "saved name" for r in done), playlist))


if __name__ == "__main__":
    main()
