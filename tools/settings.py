"""The playlist generator's settings page: pick parks, set the generator's options, build and install.

Usage: python tools/settings.py [playlist.toml] [--openrct2 PATH] [--port 8766] [--no-browser]

Serves tools/settings.html on 127.0.0.1 and opens it in the browser. The page edits one playlist
(TOML; the main screen's options and the park list) and the parks' profiles (parks/*.toml; the
per-park adjustments, parameters and plugin-driven views), and runs the tools: a folder scan
(read directly, or through importparks.py when it holds RCT2 saves or loose objects),
mksequence.py to build and then install that build, renderviews.py for previews, bundle.py to
export and import playlist bundles. docs/settings-ui.md maps each
control to its key; docs/settings-ui-wiring.md has the design.

The page is a generator: it writes playlists and profiles without asking (owner, 2026-10-31),
editing an existing file in place where it can (comments kept) and rewriting it otherwise. What it
writes goes to the user folder (tools/userdata.py: Documents/OpenRCT2/screensaver on Windows):
playlists/ and parks/ there, so the repository's playlists and profiles stay the shipped defaults (a
saved repository playlist becomes a copy there; a profile saved there replaces the repository's of the
same name). The old file is kept in its backups/ (the last 100 copies per file). Files written whole
start with a header line saying so. The last build (build/, removed when the server quits: the game plays its installed copy) and two sets of renders (renders/, and
renders-previous/ for comparing) are kept there too.

The server stops by itself once no page has been open for a while (each open page pings it), and
the server removes the staging build when it quits. Its token is kept with its settings, so a
restarted server takes the old tabs back, and starting it again while it runs only opens the page
(Settings.cmd at the repository's root starts it without a console window).

Every API call carries the token printed in the page's URL, and the server answers only requests
addressed to 127.0.0.1 or localhost on its own port, so other web pages can't drive it.
The tool's own settings (OpenRCT2 path, last playlist, library folder, token) are kept in the
user folder's settings.json.
"""
import argparse, hashlib, http.server, json, os, re, secrets, shutil, subprocess, sys, threading, time, tomllib, \
    urllib.parse, urllib.request, webbrowser, zipfile

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import bundle, companions, drawviews, mksequence, parkinfo, profiles, renderviews, tomlwrite, userdata  # noqa: E402

ROOT = os.path.dirname(TOOLS)
PAGE = os.path.join(TOOLS, "settings.html")
HOME = userdata.home()  # the user's own files (see above)
CONFIG = os.path.join(HOME, "settings.json")
OLD_CONFIG = os.path.join(ROOT, "build", "settings-ui.json")  # before the user folder
CACHE = os.path.join(HOME, "facts.json")
BACKUPS = os.path.join(HOME, "backups")
SEQUENCE_OUT = os.path.join(HOME, "build")  # the last build only: the game plays the installed copy
PARK_CACHE = os.path.join(HOME, "park-cache")  # resolved parks, so a build redoes only the parks that changed
RENDERS = os.path.join(HOME, "renders")
RENDERS_PREVIOUS = os.path.join(HOME, "renders-previous")  # the set before, for comparing
DRAW_RENDERS = os.path.join(HOME, "draw-renders")  # the drawing page's four-angle renders, by park contents
DRAW_PAGE = os.path.join(TOOLS, "drawviews.html")
BUNDLE_PARKS = os.path.join(HOME, "bundles")  # park files that came in bundles, a folder per playlist
USER_PLAYLISTS = userdata.playlists()
USER_PARKS = userdata.parks()
# A new playlist pans: the generator's own default is pan = 0 (every view held still, then a cut)
NEW_VIEWS = {"motion": "pans", "pan": "auto"}
LOGS = os.path.join(ROOT, "build", "logs")  # every job's output, one file per run
PLAYLISTS = os.path.join(ROOT, "playlists")  # the shipped ones; saved copies go to USER_PLAYLISTS
HEADER = "Written by tools/settings.py (the generator's settings page); comments are not kept."
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # no console window for tools run from the page
LEGACY = (".sv6", ".sc6", ".sv4", ".sc4")  # RCT saves importparks.py converts with OpenRCT2
OBJECTS = (".parkobj", ".dat")  # loose objects importparks.py installs
PARK_FILES = (".park", ".zip")


def size_class(map_size):
    """The Parks screen's size filter, by the longer map side: small < 100, large 100-199, very large 200+."""
    side = max(map_size)
    return "small" if side < 100 else "large" if side < 200 else "very large"


def written_here(path):
    """Whether a file was written by this page (its first line is the header)."""
    try:
        with open(path, encoding="utf-8") as f:
            return f.readline().strip() == "# " + HEADER
    except OSError:
        return False


BACKUPS_KEPT = 100  # copies kept per file (playlists 1-7 KB, profiles 0.1-3 KB; owner, 2026-10-31)


def backup(path):
    """Keeps a copy of a file about to be overwritten under build/settings-ui/backups/, the last
    BACKUPS_KEPT per file."""
    if os.path.exists(path):
        os.makedirs(BACKUPS, exist_ok=True)
        base = os.path.basename(path)
        shutil.copy2(path, os.path.join(BACKUPS, "%s.%s.bak" % (base, time.strftime("%Y%m%d-%H%M%S"))))
        copies = sorted(f for f in os.listdir(BACKUPS) if f.startswith(base + ".") and f.endswith(".bak"))
        for old in copies[:-BACKUPS_KEPT]:
            os.remove(os.path.join(BACKUPS, old))


def write_toml(path, data, in_place=False):
    """Writes data over path, keeping a backup. With in_place, an existing file is edited where it
    can be (tomlwrite.patch: comments and layout kept), else rewritten whole."""
    text = None
    if in_place and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            text = tomlwrite.patch(f.read(), data)
    text = text or tomlwrite.dumps(data, HEADER)
    if tomllib.loads(text) != data:
        raise ValueError("could not write %s faithfully" % path)
    backup(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


# --- park facts ---

class Facts:
    """What the page needs to know of each park file, read from the file alone (no generation):
    names, map size, companion data and track. Kept in build/settings-ui/facts.json by file
    size and time, as a zstd park takes seconds to read on Python before 3.14."""

    def __init__(self, path=CACHE):
        self.path = path
        self.lock = threading.Lock()
        try:
            with open(path, encoding="utf-8") as f:
                self.cache = json.load(f)
        except (OSError, ValueError):
            self.cache = {}

    def raw(self, path, member=None):
        st = os.stat(path)
        key = "%s|%s" % (os.path.abspath(path), member or "")
        with self.lock:
            hit = self.cache.get(key)
            if hit and hit["stamp"] == [st.st_size, st.st_mtime]:
                return hit
        member, data = parkinfo.read_park_bytes(path, member)
        hdr, chunks, body = parkinfo.load(data)
        saved = parkinfo.parse_park(parkinfo.chunk_reader(chunks, body, 6), hdr["target"])["name"]
        tiles = parkinfo.chunk_reader(chunks, body, 0x30)
        size = mksequence.map_size(tiles)
        track = [[x, y, ride] for (x, y, _), ride in
                 parkinfo.track_rides(parkinfo.chunk_reader(chunks, body, 0x30), invisible=True).items()]
        storage_chunk = parkinfo.chunk_reader(chunks, body, 0x38)
        out = {"stamp": [st.st_size, st.st_mtime], "member": member, "savedName": saved,
               "name": parkinfo.display_name(saved, path, member)[0], "mapSize": list(size),
               "storage": json.loads(storage_chunk.str()) if storage_chunk else {}, "track": track}
        with self.lock:
            self.cache[key] = out
        return out

    def save(self):
        with self.lock:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path + ".tmp", "w", encoding="utf-8") as f:
                json.dump(self.cache, f)
            os.replace(self.path + ".tmp", self.path)


def park_facts(facts, entry, base_dir, lib, park_profiles):
    """One park of the playlist as the page shows it: names, size, scripts, plugin-driven views
    (animations and shows the park's companions offer), and its profile."""
    path = os.path.join(base_dir, entry["file"])
    raw = facts.raw(path, entry.get("member"))
    profile = profiles.find(park_profiles, entry, raw["savedName"], raw["mapSize"], os.path.basename(entry["file"]))
    merged = profiles.apply(profile, entry, True)
    track = {tuple(t) for t in raw["track"]}
    try:
        found = companions.complete(companions.find(merged, base_dir, raw["member"]), lib, raw["storage"], track, merged)
    except (ValueError, OSError, zipfile.BadZipFile) as e:
        found, error = [], str(e)
    else:
        error = None
    names = sorted({companions.metadata(code, label)["name"] for label, code in found})
    report = []
    if found:
        companions.animation_spots(found, raw["storage"], raw["savedName"], track, None,
                                   merged.get("animation_overrides"), report)
    shows = sorted(n for n, d in companions.SHOWS.items()
                   if d["companion"] in names and d.get("park") in (None, raw["savedName"]))
    own = {k: v for k, v in (profile or {}).items() if k not in ("id", "path", "source")}
    return {"key": mksequence.park_key(entry), "name": merged.get("name") or raw["name"], "savedName": raw["savedName"],
            "mapSize": raw["mapSize"], "size": size_class(raw["mapSize"]), "scripts": names,
            "animations": [{"name": a["name"], "companion": a["companion"], "box": a["box"], "status": a.get("status", ""),
                            "cue": a.get("used") or a.get("cue")}
                           for a in report],
            "shows": shows, "profile": profile["id"] if profile else None, "profileData": own,
            "profileSource": profile["source"] if profile else None,
            "showDefs": {n: {k: v for k, v in own.get("show", {}).get(n, {}).items()} for n in shows},
            "error": error}


# --- the playlist being edited ---

def scan_folder(folder):
    """Park entries for every park in a folder, read in place: [{file (absolute), member?, author?}].
    Returns (entries, reasons) where reasons lists why importparks.py is needed instead (RCT2
    saves to convert, loose objects to install), if any."""
    entries, reasons = [], []
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        low = name.lower()
        if parkinfo.is_junk(name):
            continue
        if low.endswith(LEGACY):
            reasons.append("%s is an RCT2 save (needs converting)" % name)
        elif low.endswith(OBJECTS):
            reasons.append("%s is a loose object (needs installing)" % name)
        elif low.endswith(".zip") or os.path.isdir(path):
            try:
                archive = parkinfo.Archive(path)
                parks = archive.parks()
            except (OSError, ValueError, zipfile.BadZipFile):
                continue
            if archive.legacy() and not parks:
                reasons.append("%s holds an RCT2 save (needs converting)" % name)
                continue
            if any(f[0].lower().endswith(OBJECTS) for f in archive.files):
                reasons.append("%s ships loose objects (need installing)" % name)
            if parks:
                authors = parkinfo.download_authors(path, parkinfo.latest(parks)[0])
                entry = {"file": os.path.abspath(path)}
                if authors:
                    entry["author"] = ", ".join(authors)
                entries.append(entry)
        elif low.endswith(".park"):
            # Builders from the NE catalogue or the file's name, as for downloads (owner, 2026-11-03)
            entry = {"file": os.path.abspath(path)}
            authors = parkinfo.download_authors(path)
            if authors:
                entry["author"] = ", ".join(authors)
            entries.append(entry)
    return entries, reasons


class Session:
    """The playlist on the page: its file (or none yet), its data, and its base folder (park
    files are relative to it)."""

    def __init__(self, facts):
        self.facts = facts
        self.path = None
        self.base = ROOT
        self.data = {"name": "RCT Screensaver", "order": "playlist", "layout": "plugin", "views": dict(NEW_VIEWS), "park": []}
        self.lock = threading.Lock()

    def open(self, path):
        with open(path, "rb") as f:
            data = tomllib.load(f)
        self.path, self.base, self.data = os.path.abspath(path), os.path.dirname(os.path.abspath(path)), data

    def adopt(self, entries, name):
        """A new, unsaved playlist of scanned parks (absolute paths until it is saved)."""
        self.path, self.base = None, ROOT
        self.data = {"name": name, "order": "playlist", "layout": "plugin", "park_plugins": True, "views": dict(NEW_VIEWS),
                     "park": [dict(e, file=os.path.relpath(e["file"], ROOT)) for e in entries]}

    def save(self, data, path):
        """Writes the page's playlist to path, park files rebased onto its folder. A playlist from the
        repository is saved as a copy in the user folder (its editor views with it), edited from there."""
        path = os.path.abspath(path)
        copied = False
        if self.path and path == self.path and inside(path, ROOT):
            path = os.path.join(USER_PLAYLISTS, os.path.basename(path))
            if not os.path.exists(path):
                os.makedirs(USER_PLAYLISTS, exist_ok=True)
                shutil.copy2(self.path, path)  # in place from here keeps its comments
                if os.path.exists(mksequence.edits_path(self.path)):
                    shutil.copy2(mksequence.edits_path(self.path), mksequence.edits_path(path))
                copied = True
        base = os.path.dirname(path)
        data = dict(data)
        parks = []
        for e in data.get("park", []):
            absolute = os.path.normpath(os.path.join(self.base, e["file"]))
            try:
                rel = os.path.relpath(absolute, base)
            except ValueError:  # another drive
                rel = absolute
            parks.append(dict(e, file=rel.replace("\\", "/")))
        data["park"] = parks
        # Saving over the open playlist edits it in place where it can (comments kept)
        write_toml(path, data, in_place=path == self.path or copied)
        self.path, self.base, self.data = path, base, data

    def state(self, park_profiles):
        entries = self.data.get("park", [])
        lib = companions.library([e for e in entries if os.path.exists(os.path.join(self.base, e["file"]))], self.base)
        parks = []
        for e in entries:
            if not os.path.exists(os.path.join(self.base, e["file"])):
                # Not in the bundle it came in, nor in the park folder: listed red, nothing to adjust
                parks.append({"key": mksequence.park_key(e), "name": os.path.basename(e["file"]), "missing": True,
                              "error": "missing", "mapSize": [0, 0], "size": "small", "scripts": [], "animations": [],
                              "shows": [], "profile": None, "profileData": {}, "showDefs": {}})
                continue
            try:
                parks.append(park_facts(self.facts, e, self.base, lib, park_profiles))
            except (ValueError, OSError, KeyError, zipfile.BadZipFile) as err:
                parks.append({"key": mksequence.park_key(e), "name": e.get("name") or os.path.basename(e["file"]),
                              "error": str(err), "mapSize": [0, 0], "size": "small", "scripts": [], "animations": [],
                              "shows": [], "profile": None, "profileData": {}, "showDefs": {}})
        self.facts.save()
        return {"path": self.path, "relPath": playlist_label(self.path) if self.path else None,
                "writtenHere": bool(self.path) and written_here(self.path), "data": self.data, "parks": parks,
                "built": self.built() is not None, "builtAt": built_at(self.built()),
                "parkBytes": sum(os.path.getsize(os.path.join(self.base, e["file"])) for e in entries
                                 if os.path.exists(os.path.join(self.base, e["file"])))}

    def last_build(self):
        """The last build's result file when it is this playlist's, changed since or not."""
        if not self.path:
            return None
        try:
            names = [n for n in os.listdir(SEQUENCE_OUT) if n.endswith(".result.json")]
        except OSError:
            return None
        for n in names:
            path = os.path.join(SEQUENCE_OUT, n)
            try:
                with open(path, encoding="utf-8") as f:
                    source = json.load(f).get("source")
            except (OSError, ValueError):
                continue
            if source and os.path.normcase(os.path.abspath(source)) == os.path.normcase(os.path.abspath(self.path)):
                return path
        return None

    def built(self):
        """The last build's result file when it is this playlist's and nothing it was built from changed
        since (the playlist, its views file; profile changes remove the build): Render, Install and Export
        bundle use it."""
        path = self.last_build()
        if not path:
            return None
        stamp = os.path.getmtime(path)
        # (profiles too: the drawing page reads the last build, so a profile change keeps it and
        # marks it old instead of removing it; the next build redoes only the parks it changed)
        inputs = [self.path, mksequence.edits_path(self.path)] + profile_files()
        if all(not os.path.exists(i) or os.path.getmtime(i) <= stamp for i in inputs):
            return path
        return None

    def relink(self, folder):
        """Points missing parks at files of the same name in folder (or below it). Returns how many were found."""
        if not self.path:
            raise ValueError("save the playlist first")
        found, parks = 0, []
        for e in self.data.get("park", []):
            if not os.path.exists(os.path.join(self.base, e["file"])):
                hit = bundle.find_park(folder, {"file": os.path.basename(e["file"]), "size": -1, "sha256": ""})
                if hit:
                    e, found = dict(e, file=os.path.abspath(hit)), found + 1
            parks.append(e)
        if found:
            self.save(dict(self.data, park=parks), self.path)
        return found


# --- profiles ---

def profile_path(stem):
    """Where the page writes a profile: the user folder's parks/ (the repository's are defaults)."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", stem or ""):
        raise ValueError("bad profile name %r" % stem)
    return os.path.join(USER_PARKS, stem + ".toml")


def inside(path, folder):
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(folder)]) == os.path.abspath(folder)
    except ValueError:  # another drive
        return False


def change_profile(park, changes):
    """Applies the page's changes to a park's profile, creating one when it has none:
    changes = {views: {k: v|None}, extras: {...}, companions: False|None,
    animation: {name: {off, hold}|None}, show: {name: {view, path, hold}}}; None deletes a key."""
    stem = park.get("profile")
    created = False
    if stem:
        path = profile_path(stem)
        if not os.path.exists(path):  # the repository's profile: its copy in the user folder replaces it
            os.makedirs(USER_PARKS, exist_ok=True)
            shutil.copy2(profiles.load()[stem]["path"], path)
            created = True
        with open(path, "rb") as f:
            data = tomllib.load(f)
    else:
        stem = mksequence.slug(park["savedName"]) or "park"
        taken = set(profiles.load())
        n = 2
        while stem in taken:
            stem, n = "%s-%d" % (mksequence.slug(park["savedName"]), n), n + 1
        path = profile_path(stem)
        created = True
        data = {"match": {"name": park["savedName"], "map": list(park["mapSize"])}}
    if "companions" in changes:
        if changes["companions"] is False:
            data["companions"] = False
        else:
            data.pop("companions", None)
    for section in ("views", "extras"):
        for k, v in (changes.get(section) or {}).items():
            table = data.setdefault(section, {})
            if v is None:
                table.pop(k, None)
            else:
                table[k] = v
            if not table:
                data.pop(section)
    for name, change in (changes.get("animation") or {}).items():
        table = data.setdefault("animation", {})
        entry = {**table.get(name, {}), **{k: v for k, v in (change or {}).items() if v is not None}}
        for k, v in (change or {}).items():
            if v is None:
                entry.pop(k, None)
        if entry and change is not None:
            table[name] = entry
        else:
            table.pop(name, None)
        if not table:
            data.pop("animation")
    for name, change in (changes.get("show") or {}).items():
        shows = data.get("show", {})
        if name not in shows:
            raise ValueError("show %r is not defined in parks/%s.toml" % (name, stem))
        for k, v in change.items():
            if v is None:
                shows[name].pop(k, None)
            else:
                shows[name][k] = v
    # Profiles must still load (and keep their spots and shows valid)
    order = ["companions", "match", "views", "extras", "companion", "spot", "animation", "show"]
    data = {k: data[k] for k in sorted(data, key=lambda k: order.index(k) if k in order else len(order))}
    write_toml(path, data, in_place=True)
    try:
        loaded = profiles.load()
        companions.SPOTS, companions.SHOWS = profiles.definitions(loaded)
    except ValueError:
        backups = sorted(f for f in os.listdir(BACKUPS) if f.startswith(os.path.basename(path) + ".")) \
            if os.path.isdir(BACKUPS) else []
        if created or not backups:
            os.remove(path)
        else:
            shutil.copy2(os.path.join(BACKUPS, backups[-1]), path)
        raise
    # A copy that no longer differs from what ships (or a new one left with only its [match]) is
    # removed, so the user folder holds only real changes and later fixes to the shipped profile apply
    shipped = profiles.load(user=False).get(stem)
    plain = lambda p: {k: v for k, v in p.items() if k not in ("id", "path", "source")}
    if (shipped and plain(shipped) == data) or (not shipped and set(data) == {"match"}):
        os.remove(path)
        companions.SPOTS, companions.SHOWS = profiles.definitions(profiles.load())
    return None


def reset_profile(park):
    """Removes the page's copy of a park's profile from the user folder (a backup is kept): the
    repository's profile of that name applies again, or none. Returns "restore" or "remove"."""
    if not park.get("profile"):
        raise ValueError("%s has no profile" % park["name"])
    path = profile_path(park["profile"])
    if not os.path.exists(path):
        raise ValueError("%s's profile is the repository's, unchanged" % park["name"])
    backup(path)
    os.remove(path)
    loaded = profiles.load()
    companions.SPOTS, companions.SHOWS = profiles.definitions(loaded)
    return "restore" if park["profile"] in loaded else "remove"


# --- tools run from the page ---

class Job:
    """A tool run in the background; the page polls its output."""

    def __init__(self, label, args, on_success=None):
        self.label, self.args, self.on_success = label, args, on_success
        os.makedirs(LOGS, exist_ok=True)
        self.log = os.path.join(LOGS, "settings-%s-%s.log" % (label, time.strftime("%Y%m%d-%H%M%S")))
        self.lines, self.code, self.started = ["> " + " ".join(os.path.basename(a) if i < 2 else a for i, a in enumerate(args))], None, time.time()
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        with open(self.log, "w", encoding="utf-8") as log:
            log.write(self.lines[0] + "\n")
            try:
                proc = subprocess.Popen(self.args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                        encoding="utf-8", errors="replace", creationflags=NO_WINDOW,
                                        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"})
                for line in proc.stdout:
                    self.lines.append(line.rstrip("\n"))
                    log.write(line if line.endswith("\n") else line + "\n")
                    log.flush()
                self.code = proc.wait()
                if self.code == 0 and self.on_success:
                    self.on_success()
            except OSError as e:
                self.lines.append("error: %s" % e)
                self.code = -1
            log.write("exit code %s\n" % self.code)

    def view(self, since=0):
        return {"label": self.label, "lines": self.lines[since:], "next": len(self.lines),
                "done": self.code is not None, "code": self.code, "log": self.log}


def dialog(call, start, name=""):
    """A native file dialog (tkinter, in its own process so it gets its own main thread): call is
    askdirectory, askopenfilename or asksaveasfilename. Returns the path, or "" when cancelled."""
    extra = "" if call == "askdirectory" else \
        ", filetypes=[('Playlist bundle', '*.zip'), ('All files', '*.*')], defaultextension='.zip', initialfile=sys.argv[2]"
    script = ("import sys, tkinter, tkinter.filedialog as d; r = tkinter.Tk(); r.withdraw(); r.attributes('-topmost', True); "
              "print(d.%s(initialdir=sys.argv[1]%s) or '')" % (call, extra))
    out = subprocess.run([sys.executable, "-c", script, start or ROOT, name], capture_output=True, text=True,
                         creationflags=NO_WINDOW, timeout=600)
    if out.returncode != 0:
        raise ValueError("no file dialog here (tkinter missing)")
    return out.stdout.strip()


def browse_folder(start):
    try:
        return dialog("askdirectory", start)
    except ValueError:
        raise ValueError("no folder dialog here (tkinter missing); type the folder instead")


def open_folder(path):
    """Shows a folder in the system's file manager (the page can't open local folders itself)."""
    os.makedirs(path, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(path)
    else:
        try:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            raise ValueError("no file manager to open here; the folder is %s" % path)


IDLE_PAGE = 90  # s without a ping before a page counts as gone (background tabs ping once a minute)
IDLE_GRACE = 15  # s with no page before the server stops (a reload comes back within it)
IDLE_START = 120  # s for the first page to open after start


def playlist_label(path):
    """How the page names a playlist: its file name, marked when it is a repository default."""
    if not path:
        return "unsaved playlist"
    return os.path.basename(path) + (" (default)" if inside(path, ROOT) else "")


def playlist_list(current):
    """The playlists the page can open: the user's, then the repository's defaults not copied yet."""
    out, seen = [], set()
    for folder in (USER_PLAYLISTS, PLAYLISTS):
        if os.path.isdir(folder):
            for f in sorted(os.listdir(folder)):
                if f.endswith(".toml") and (f not in seen or folder == USER_PLAYLISTS):
                    seen.add(f)
                    path = os.path.join(folder, f)
                    out.append({"path": path, "label": playlist_label(path)})
    if current and all(os.path.abspath(p["path"]) != current for p in out):
        out.insert(0, {"path": current, "label": playlist_label(current)})
    return out


def built_at(result):
    return time.strftime("%H:%M", time.localtime(os.path.getmtime(result))) if result else None


# --- the view-drawing page (drawviews.html), on the last build of the open playlist ---

EVENT_KEYS = ("animation", "show", "cue")


class Draw:
    """The drawing page's side: its parks, from the open playlist's last build (current or not: the
    renders show the park files, which a later change of views or profiles leaves as they are), each
    park's four-angle renders (drawviews.Renders, cached in the user folder by park contents) and the
    playlist's views file (drawviews.Store), where drawn views are saved as the page makes them."""

    def __init__(self, app):
        self.app = app
        self.loaded = None  # (playlist.json, its time): what parks and renders were made from
        self.parks = []
        self.renders = None
        self.lock = threading.Lock()

    def load(self):
        result = self.app.session.last_build()
        playlist = result and result[:-len(".result.json")] + ".playlist.json"
        if not playlist or not os.path.exists(playlist):
            raise ValueError("build the playlist first: the drawing page shows the parks of its last build")
        with self.lock:
            stamp = (playlist, os.path.getmtime(playlist))
            if self.loaded != stamp:
                with open(playlist, encoding="utf-8") as f:
                    data = json.load(f)
                seq = os.path.join(os.path.dirname(playlist), data["sequence"])
                self.data, self.parks = data, []
                for p in data["parks"]:
                    path = os.path.join(seq, p["fileName"])
                    self.parks.append(dict(p, data=self.app.file_hash(path).encode(), box=p.get("box") or drawviews.park_box(path)))
                self.renders = drawviews.Renders(self.app.config.get("openrct2") or "openrct2", self.parks, seq, DRAW_RENDERS)
                self.loaded = stamp
            if self.renders:
                self.renders.openrct2 = self.app.config.get("openrct2") or "openrct2"
        return self

    def screen(self):
        w, h = self.data.get("screen") or mksequence.VIEW_DEFAULTS["window"]
        return int(w), int(h)

    def store(self):
        if not self.app.session.path:
            raise ValueError("open a playlist first")
        return drawviews.Store(self.app.session.path, self.screen())

    def state(self):
        """The page's state: every park of the build with its drawn views (if any), its generated
        ones, its event views as built, and what the park list knows of its events (spots, shows,
        their profile settings)."""
        self.load()
        session = self.app.session
        edits = mksequence.load_edits(mksequence.edits_path(session.path)) if session.path else {}
        facts = {f["key"]: f for f in session.state(profiles.load())["parks"] if not f.get("missing")}
        screen = self.screen()
        design = self.data.get("screen") or mksequence.VIEW_DEFAULTS["window"]
        keep = lambda vs: [{k: v[k] for k in drawviews.VIEW_KEYS if k in v} for v in vs]  # noqa: E731
        route = lambda vs: [v for v in vs if not any(k in v for k in EVENT_KEYS)]  # noqa: E731
        parks = []
        for p in self.parks:
            edit = edits.get(p["key"])
            saved = bool(edit and mksequence.pinned(edit))
            generated = mksequence.scale_views(route(p["defaultViews"] if p.get("handSet") else p["views"]),
                                               mksequence.zoom_offset(design, screen))
            views = (mksequence.scale_views(route(edit["views"]), mksequence.zoom_offset(edit.get("screen"), screen))
                     if saved else generated)
            f = facts.get(p["key"], {})
            parks.append({"key": p["key"], "name": p["name"], "fileName": p["fileName"], "box": p["box"], "saved": saved,
                          "views": keep(views), "generated": keep(generated),
                          "events": [{k: v[k] for k in ("x", "y", "z", "rotation", "zoom", "hold", "animation", "show", "cue", "path") if k in v}
                                     for v in p["views"] if any(k in v for k in EVENT_KEYS)],
                          "facts": {k: f.get(k) for k in ("animations", "shows", "showDefs", "profileData", "scripts", "profile")}})
        views_opts = {**mksequence.VIEW_DEFAULTS, **session.data.get("views", {})}
        timing = {k: float(views_opts[k]) for k in ("park_time", "base_views", "view_time", "overview_lead")}
        return {"sequence": self.data["sequence"], "screen": {"width": screen[0], "height": screen[1]}, "timing": timing,
                "screenSource": "the playlist's [views] window", "viewsFile": os.path.basename(mksequence.edits_path(session.path)),
                "defaults": {k: views_opts[k] for k in ("hold", "show_pan", "events")},
                "generator": True, "parks": parks}

    def park(self, query):
        i = int(query["park"][0] if isinstance(query.get("park"), list) else query["park"])
        if not 0 <= i < len(self.parks):
            raise ValueError("no park %d" % i)
        return i

    def save(self, body):
        self.load()
        p = self.parks[self.park(body)]
        views = [drawviews.clean_view(v) for v in body["views"]]
        store = self.store()
        if views:
            store.save(p["key"], views)
        else:
            store.reset(p["key"])  # a park with no views would keep one camera for good
        return {"ok": True, "saved": bool(views)}

    def reset(self, body):
        self.load()
        p = self.parks[self.park(body)]
        self.store().reset(p["key"])
        return {"ok": True}


def draw_page(token):
    """drawviews.html for the settings server: the page finds its server by the token in its URL."""
    with open(DRAW_PAGE, encoding="utf-8") as f:
        return f.read()


def profile_files():
    """Every park profile file, the repository's and the user's: a build is current only while none
    changed since."""
    files = []
    for d in (profiles.PROFILE_DIR, userdata.parks()):
        if d and os.path.isdir(d):
            files += [os.path.join(d, n) for n in os.listdir(d) if n.endswith(".toml")]
            files.append(d)  # (a removed profile changes the folder)
    return files


# The contact sheet's marks for parks whose renders are old (render_status), served with the sheet so
# sets rendered before it get them too; checked again when the page comes back into view and every 4 s
# while it is not in focus (a drawing page or a build in another tab changes them)
STATUS_JS = r"""<style>
.oldnote{display:inline-block;margin-left:10px;padding:1px 8px;font-size:12px;font-weight:600;vertical-align:middle;background:#c62828;color:#fff}
section.park.old .views{opacity:.45}
#oldtop{display:none;margin:0 12px;padding:4px 10px;background:#c62828;color:#fff;font-weight:600;white-space:nowrap}
</style><script>
(function () {
  const NOTES = {
    edited: ["views changed", "Views or profile changed since the last build: build and render again"],
    views: ["rebuilt", "Built again since this render with other views: render again"],
    map: ["map changed", "The park file changed since this render: render again"],
  };
  const latest = document.getElementById("latest") || document;
  const top = document.createElement("span");
  top.id = "oldtop";
  const bar = document.querySelector(".top");
  if (bar) bar.insertBefore(top, bar.querySelector(".grow") ? bar.querySelector(".grow").nextSibling : null);
  const apply = st => {
    const parks = st.parks || {};
    let n = 0;
    latest.querySelectorAll("section.park").forEach(sec => {
      if (sec.closest("#previous")) return;
      const kind = parks[sec.dataset.key], note = sec.querySelector(".oldnote"), h2 = sec.querySelector("h2");
      sec.classList.toggle("old", !!kind);
      if (!kind) { if (note) note.remove(); return; }
      n++;
      const el = note || document.createElement("span");
      el.className = "oldnote"; el.textContent = NOTES[kind][0]; el.title = NOTES[kind][1];
      if (!note && h2) h2.appendChild(el);
    });
    top.textContent = n ? n + (n === 1 ? " park" : " parks") + " changed since this render" : "";
    top.title = n ? "Their pictures no longer show what plays: build if needed, then render again." : "";
    top.style.display = n ? "inline-block" : "none";
  };
  const check = () => fetch(window.STATUS).then(r => r.ok ? r.json() : null).then(st => st && apply(st)).catch(() => {});
  check();
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  setInterval(() => { if (!document.hasFocus()) check(); }, 4000);
})();
</script>"""


def add_previous(page, folder, token):
    """The latest contact sheet as the page serves it: with the previous render set's manifest as
    window.PREVIOUS, so its Compare box can show that set in a second column (renderviews.py)."""
    if folder != "renders":
        return page
    try:
        with open(os.path.join(RENDERS_PREVIOUS, "renders.json"), encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        return page
    data = {"built": manifest.get("built"), "rendered": manifest.get("rendered") or render_time(RENDERS_PREVIOUS), "base": "/renders-previous/",
            "token": token, "parks": manifest.get("parks", [])}
    script = ("<script>window.PREVIOUS = %s;</script>" % json.dumps(data).replace("</", "<\\/")).encode()
    m = re.search(rb"</style>", page)
    at = m.end() if m else 0
    return page[:at] + script + page[at:]


def render_time(folder):
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(os.path.join(folder, "renders.json"))))
    except OSError:
        return None


def load_config():
    for path in (CONFIG, OLD_CONFIG):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    return {}


def save_config(config):
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=1)


class App:
    def __init__(self, config, playlist=None):
        self.config = config
        self.facts = Facts()
        self.session = Session(self.facts)
        self.jobs = {}
        self.scan_job = None  # (job, library, name): an importparks run whose playlist the page adopts
        self.installed = None  # (result file, its time, when): the build last installed, for the status line
        self.hashes = {}  # park file: (mtime, size, SHA-1), for telling whether a render still shows a park's map
        self.draw = Draw(self)
        self.pages = {}  # open pages (their id: last ping), so the server stops once none is left
        self.last_page = time.time() + IDLE_START - IDLE_GRACE
        self.server = None
        # Nothing is loaded on start (owner, 2026-10-31): New, Import or the selector picks; a playlist
        # given on the command line opens
        if playlist:
            self.session.open(playlist)

    def defaults(self):
        return {k: v for k, v in mksequence.VIEW_DEFAULTS.items()}

    def state(self):
        park_profiles = profiles.load()
        out = self.session.state(park_profiles)
        out.update(config={k: self.config.get(k) for k in ("openrct2", "library", "folder")},
                   defaults=self.defaults(), header=HEADER,
                   playlists=playlist_list(self.session.path), label=playlist_label(self.session.path),
                   renderTimes=[render_time(RENDERS), render_time(RENDERS_PREVIOUS)])
        out["previews"], out["rendersStale"] = self.previews(RENDERS)
        out["rebuild"], out["generatorUpdated"] = self.rebuild()
        out["drawable"] = bool(self.session.last_build())
        out["handSet"] = self.hand_set()
        built = self.session.built()
        if built and self.installed and self.installed[0] == built and os.path.exists(built) \
                and os.path.getmtime(built) == self.installed[1]:
            out["installedAt"] = self.installed[2]
        return out

    def hand_set(self):
        """Keys of the open playlist's parks with views set by hand (pinned in its views file: drawn on the
        drawing page or set in the game's editor), which play as set: the page badges them."""
        path = self.session.path
        if not path:
            return []
        try:
            edits = mksequence.load_edits(mksequence.edits_path(path))
        except (ValueError, OSError):
            return []
        return sorted(k for k, e in edits.items() if mksequence.pinned(e))

    def rebuild(self):
        """Keys of the open playlist's parks the next build resolves again (mksequence.changed_parks):
        the page flags them, as a build redoes only those. Kept until the playlist, its views file,
        a profile or the park cache changes. Also the parks changed only by a generator update since
        their last build (they rebuild too, but are not flagged one by one)."""
        path = self.session.path
        if not path or not os.path.exists(path) or not os.path.isdir(PARK_CACHE):
            return [], []  # (nothing built yet: every park is new)
        def stamp(p):
            try:
                return os.path.getmtime(p)
            except OSError:
                return 0
        folders = [d for d in (profiles.PROFILE_DIR, userdata.parks()) if d and os.path.isdir(d)]
        key = (path, stamp(path), stamp(mksequence.edits_path(path)), stamp(PARK_CACHE),
               tuple(max([stamp(d)] + [stamp(os.path.join(d, n)) for n in os.listdir(d)]) for d in folders))
        if getattr(self, "_rebuild", (None,))[0] != key:
            try:
                d = mksequence.changed_parks(path, PARK_CACHE, detail=True)
                keys = (d["parks"], d["updated"])
            except (ValueError, OSError, tomllib.TOMLDecodeError):
                keys = ([], [])
            self._rebuild = (key, keys)
        return self._rebuild[1]

    def file_hash(self, path):
        stat = os.stat(path)
        known = self.hashes.get(path)
        if not known or known[:2] != (stat.st_mtime, stat.st_size):
            h = hashlib.sha1()
            with open(path, "rb") as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
            known = self.hashes[path] = (stat.st_mtime, stat.st_size, h.hexdigest())
        return known[2]

    def previews(self, folder):
        """Each rendered park's total (or first view) and its place in the contact sheet, by park key (renderviews.py's
        renders.json), so the strip matches parks whatever their order or which of them were built; and
        whether a build came after the renders. Then (owner, 2026-11-01) the routes drawn are old: a park
        whose map is the same in the new build (the same park file) shows its overview without lines, the
        others a placeholder ("map changed")."""
        try:
            with open(os.path.join(folder, "renders.json"), encoding="utf-8") as f:
                manifest = json.load(f)
        except (OSError, ValueError):
            return {}, False
        result = self.session.last_build()
        playlist = result and result[:-len(".result.json")] + ".playlist.json"
        new, new_views = {}, {}  # park key: its file in the newer build, its views' digest
        if playlist and os.path.exists(playlist):
            stamp = os.path.getmtime(playlist)
            # (sets rendered before builtMtime existed: rendered before the build was written)
            if manifest.get("builtMtime") != stamp if "builtMtime" in manifest \
                    else os.path.getmtime(os.path.join(folder, "renders.json")) < stamp:
                try:
                    with open(playlist, encoding="utf-8") as f:
                        data = json.load(f)
                    seq = os.path.join(os.path.dirname(playlist), data["sequence"])
                    new = {p.get("key"): os.path.join(seq, p["fileName"]) for p in data.get("parks", [])}
                    new_views = {p.get("key"): renderviews.views_key(p) for p in data.get("parks", [])}
                except (OSError, ValueError, KeyError):
                    new = {None: None}
        stale = False
        out = {}
        for park in manifest.get("parks", []):
            key = park.get("key")
            if not key:
                continue
            total = park.get("total") or {}
            same_views = False
            if new:
                path = new.get(key)
                same = bool(path and park.get("parkHash") and os.path.exists(path) and self.file_hash(path) == park["parkHash"])
                if same and park.get("viewsKey") and park["viewsKey"] == new_views.get(key):
                    same_views = True  # a partial rebuild redid other parks: this one's route still stands
                else:
                    same_views, stale = False, True
            if new and not same_views:
                first = (park.get("views") or [None])[0] if same else None
                if not first or not os.path.exists(os.path.join(folder, first)):
                    out[key] = {"changed": True}
                    continue
                overlay = ""
                old = True  # (same map, other views: the rendered route is old)
            else:
                old = False
                # The park's "total" (every view and the route over one render) when the set has one,
                # else its first view
                first = total.get("file") or next((v for v in park.get("views", []) if v), None)
                if not first or not os.path.exists(os.path.join(folder, first)):
                    continue
                overlay = total.get("overlay", "") if total.get("file") else ""
            out[key] = {"file": "%s?%d" % (first, int(os.path.getmtime(os.path.join(folder, first)))),
                        "anchor": park.get("anchor", ""), "overlay": overlay}
            if old:
                out[key]["old"] = True
        return out, stale

    def render_status(self):
        """Which parks of the latest render set no longer show what plays, for the contact sheet (owner,
        2026-11-02: as the settings page's strip marks them): "edited" (views or profile changed since
        the last build), "map" (a newer build has another park file) or "views" (a newer build has other
        views of the same map)."""
        try:
            with open(os.path.join(RENDERS, "renders.json"), encoding="utf-8") as f:
                keys = [p.get("key") for p in json.load(f).get("parks", []) if p.get("key")]
        except (OSError, ValueError):
            return {"parks": {}}
        shots, stale = self.previews(RENDERS)
        edited = set() if self.session.built() else set(self.rebuild()[0])
        parks = {}
        for key in keys:
            shot = shots.get(key) or {}
            if key in edited:
                parks[key] = "edited"
            elif shot.get("changed"):
                parks[key] = "map"
            elif shot.get("old"):
                parks[key] = "views"
        return {"parks": parks, "stale": stale}

    def ping(self, page):
        self.pages[page] = self.last_page = time.time()

    def bye(self, page):
        self.pages.pop(page, None)
        self.last_page = time.time()

    def watch(self):
        """Stops the server once no page has pinged for IDLE_GRACE s (a closed tab says bye; one that
        vanished stops pinging), never while a tool runs."""
        while True:
            time.sleep(5)
            now = time.time()
            for page, seen in list(self.pages.items()):
                if now - seen > IDLE_PAGE:
                    self.pages.pop(page, None)
            if self.pages or any(j.code is None for j in self.jobs.values()):
                self.last_page = max(self.last_page, now - IDLE_GRACE / 2)
                continue
            if now - self.last_page > IDLE_GRACE:
                print("no page open: stopping", flush=True)
                self.stop()
                return

    def stop(self):
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def build_job(self):
        """The build running now (its job id), or None."""
        return next((j for j, job in self.jobs.items() if job.label == "build" and job.code is None), None)

    def start(self, label, args, on_success=None):
        job_id = secrets.token_hex(4)
        self.jobs[job_id] = Job(label, args, on_success)
        return job_id

    def scan(self, folder, openrct2):
        folder = os.path.abspath(folder)
        if not os.path.isdir(folder):
            raise ValueError("%s is not a folder" % folder)
        self.config["folder"] = folder
        save_config(self.config)
        entries, reasons = scan_folder(folder)
        name = os.path.basename(folder.rstrip("\\/")) or "Parks"
        if not reasons:
            self.session.adopt(entries, "RCT Screensaver " + name)
            return {"imported": False, "parks": len(entries)}
        # RCT2 saves or loose objects: importparks.py converts and installs into a library
        library = os.path.abspath(self.config.get("library") or os.path.join(ROOT, "build", "library", mksequence.slug(name)))
        args = [sys.executable, os.path.join(TOOLS, "importparks.py"), folder, "-o", library, "--name", "RCT Screensaver " + name]
        if openrct2:
            args += ["--openrct2", openrct2]
        job_id = self.start("import", args)
        self.scan_job = (job_id, library, "RCT Screensaver " + name)
        return {"imported": True, "job": job_id, "reasons": reasons}

    def adopt_import(self):
        job_id, library, name = self.scan_job
        playlist = os.path.join(library, re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + ".toml")
        if not os.path.exists(playlist):
            candidates = [f for f in os.listdir(library) if f.endswith(".toml")]
            if not candidates:
                raise ValueError("the import wrote no playlist")
            playlist = os.path.join(library, candidates[0])
        with open(playlist, "rb") as f:
            data = tomllib.load(f)
        entries = [dict(e, file=os.path.join(library, e["file"])) for e in data.get("park", [])]
        self.session.adopt(entries, data.get("name", name))
        self.scan_job = None


def make_handler(app, token, port):
    allowed_hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def reply(self, code, body, kind="application/json"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def allowed(self, need_token=True):
            """Only requests addressed to this server by name (no DNS rebinding), from its own
            page (no other origin), carrying the run's token."""
            if self.headers.get("Host") not in allowed_hosts:
                return False
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlparse(origin).netloc not in allowed_hosts:
                return False
            if need_token:
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                given = self.headers.get("X-Token") or (query.get("t") or [""])[0]
                return secrets.compare_digest(given, token)
            return True

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(url.query)
            if not self.allowed(need_token=url.path != "/"):
                self.reply(403, {"error": "forbidden"})
                return
            try:
                if url.path == "/":
                    with open(PAGE, encoding="utf-8") as f:
                        self.reply(200, f.read(), "text/html; charset=utf-8")
                elif url.path == "/api/state":
                    with app.session.lock:
                        self.reply(200, app.state())
                elif url.path == "/api/renders/status":
                    with app.session.lock:
                        self.reply(200, app.render_status())
                elif url.path == "/api/job":
                    job = app.jobs[query["id"][0]]
                    view = job.view(int(query.get("since", ["0"])[0]))
                    if app.scan_job and app.scan_job[0] == query["id"][0] and job.code is not None:
                        if job.code == 0:
                            with app.session.lock:
                                app.adopt_import()
                            view["adopted"] = True
                        else:
                            app.scan_job = None
                    self.reply(200, view)
                elif url.path == "/draw":
                    self.reply(200, draw_page(token), "text/html; charset=utf-8")
                elif url.path == "/api/draw/state":
                    with app.session.lock:
                        if not app.session.last_build():
                            # Opened before a build (owner, 2026-11-02): the page builds the playlist itself
                            self.reply(200, {"error": "the playlist isn't built yet: the drawing page shows the parks of its last build",
                                             "needsBuild": bool(app.session.path), "building": app.build_job()})
                        else:
                            self.reply(200, dict(app.draw.state(), building=app.build_job()))
                elif url.path == "/api/draw/render":
                    d = app.draw.load()
                    plan, _ = d.renders.get(d.park(query), int(query["rotation"][0]) & 3)
                    self.reply(200, plan)
                elif url.path == "/api/draw/image":
                    d = app.draw.load()
                    _, path = d.renders.get(d.park(query), int(query["rotation"][0]) & 3)
                    if not path:
                        self.reply(404, {"error": "render failed"})
                        return
                    with open(path, "rb") as f:
                        self.reply(200, f.read(), "image/png")
                elif url.path == "/api/ping":
                    app.ping(query["page"][0])
                    self.reply(200, {"ok": True})
                elif url.path.startswith(("/renders/", "/renders-previous/")):
                    folder, name = url.path[1:].split("/", 1)
                    if not re.fullmatch(r"[\w.-]+\.(png|html)", name):
                        raise ValueError("bad file")
                    with open(os.path.join(RENDERS if folder == "renders" else RENDERS_PREVIOUS, name), "rb") as f:
                        data = f.read()
                    if name.endswith(".html"):  # the contact sheet's images need the token too
                        data = re.sub(rb'src="([\w.-]+\.png)"', lambda m: b'src="%s?t=%s"' % (m.group(1), token.encode()), data)
                        data = add_previous(data, folder, token)
                        if folder == "renders":  # each park's Edit views button opens the drawing page
                            link = ("<script>window.DRAW = %s;</script>" % json.dumps("/draw?t=%s&park=" % token)).encode()
                            at = data.find(b"</style>")
                            data = data[:at + 8] + link + data[at + 8:] if at >= 0 else link + data
                            # Parks whose views changed since this set: marked, as the settings page's strip does
                            status = ("<script>window.STATUS = %s;</script>" % json.dumps("/api/renders/status?t=%s" % token)
                                      + STATUS_JS).encode()
                            at = data.rfind(b"</body>")
                            data = data[:at] + status + data[at:] if at >= 0 else data + status
                    self.reply(200, data, "image/png" if name.endswith(".png") else "text/html; charset=utf-8")
                else:
                    self.reply(404, {"error": "not found"})
            except (KeyError, ValueError, OSError) as e:
                self.reply(400, {"error": str(e)})

        def do_POST(self):
            if urllib.parse.urlparse(self.path).path == "/api/bye":  # navigator.sendBeacon: no headers of ours
                if self.allowed():
                    app.bye(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("page", [""])[0])
                self.reply(204, b"")
                return
            if not self.allowed() or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                self.reply(403, {"error": "forbidden"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                result = self.post(urllib.parse.urlparse(self.path).path, body)
                self.reply(200, result if result is not None else {"ok": True})
            except (KeyError, ValueError, TypeError, IndexError, OSError, tomllib.TOMLDecodeError) as e:
                self.reply(400, {"error": str(e)})

        def post(self, path, body):
            session = app.session
            if path == "/api/config":
                for k in ("openrct2", "library"):
                    if k in body:
                        app.config[k] = body[k] or None
                save_config(app.config)
            elif path == "/api/new":  # an empty, unsaved playlist (named on its first save)
                with session.lock:
                    session.adopt([], "")
            elif path == "/api/shutdown":
                app.stop()
            elif path == "/api/open":
                with session.lock:
                    target = os.path.abspath(body["playlist"])
                    if not target.endswith(".toml") or not (inside(target, PLAYLISTS) or inside(target, USER_PLAYLISTS)):
                        raise ValueError("not a playlist the page lists")
                    session.open(target)
                    app.config["playlist"] = session.path
                    save_config(app.config)
            elif path == "/api/browse":
                return {"folder": browse_folder(body.get("start"))}
            elif path == "/api/backups":
                open_folder(BACKUPS)
                return {"path": BACKUPS}
            elif path == "/api/scan":
                with session.lock:
                    return app.scan(body["folder"], app.config.get("openrct2"))
            elif path == "/api/playlist":
                # Saves the page's playlist: to its file, or a new one under playlists/ named after it
                name = str(body["data"].get("name") or "").strip()
                if not name or name.startswith("*"):
                    raise ValueError("the playlist needs a name (not starting with *)")
                target = os.path.join(USER_PLAYLISTS, mksequence.slug(name) + ".toml") if body.get("asNew") or not session.path \
                    else session.path
                with session.lock:
                    session.save(body["data"], target)
                    app.config["playlist"] = session.path
                    save_config(app.config)
                return {"path": playlist_label(session.path)}
            elif path == "/api/profile":
                with session.lock:
                    parks = [p for p in session.state(profiles.load())["parks"] if p["key"] == body["key"]]
                    if not parks:
                        raise ValueError("no park %r in the playlist (save it first?)" % body["key"])
                    park = parks[0]
                    change_profile(park, body["changes"])
            elif path == "/api/draw/save":
                with session.lock:
                    return app.draw.save(body)
            elif path == "/api/draw/reset":
                with session.lock:
                    return app.draw.reset(body)
            elif path == "/api/profile/reset":
                with session.lock:
                    parks = [p for p in session.state(profiles.load())["parks"] if p["key"] == body["key"]]
                    if not parks:
                        raise ValueError("no park %r in the playlist (save it first?)" % body["key"])
                    return {"action": reset_profile(parks[0]), "path": "parks/%s.toml" % parks[0]["profile"]}
            elif path == "/api/build":
                if not session.path:
                    raise ValueError("save the playlist first")
                if app.build_job():  # one build at a time: the main page and the drawing page follow the same one
                    return {"job": app.build_job(), "running": True}
                with session.lock:
                    parks = session.state(profiles.load())["parks"]
                used = [e.get("use", True) for e in session.data.get("park", [])]
                if any(p.get("missing") and u for p, u in zip(parks, used)):
                    raise ValueError("some parks are missing; pick the folder that holds them, or untick them")
                shutil.rmtree(SEQUENCE_OUT, ignore_errors=True)  # only the last build is kept
                args = [sys.executable, os.path.join(TOOLS, "mksequence.py"), session.path, "-o", SEQUENCE_OUT,
                        "--cache", PARK_CACHE]
                if body.get("ignoreEdits"):
                    args.append("--ignore-edits")
                return {"job": app.start("build", args)}
            elif path == "/api/install":
                built = session.built()
                if not built:
                    raise ValueError("build the playlist first")
                args = [sys.executable, os.path.join(TOOLS, "mksequence.py"), "--install-built", built]

                def installed():
                    app.installed = (built, os.path.getmtime(built), time.strftime("%H:%M"))
                # The build stays for Render and Export; it goes when the server quits (owner, 2026-10-31)
                return {"job": app.start("install", args, installed)}
            elif path == "/api/export":
                built = session.built()
                if not built:
                    raise ValueError("build the playlist first")
                name = session.data.get("name") or "playlist"
                out = dialog("asksaveasfilename", app.config.get("bundles") or os.path.expanduser("~"),
                             mksequence.slug(name) + ".zip")
                if not out:
                    return {"cancelled": True}
                app.config["bundles"] = os.path.dirname(out)
                save_config(app.config)
                args = [sys.executable, os.path.join(TOOLS, "bundle.py"), "export", session.path, out]
                if body.get("includeParks"):
                    args += ["--parks", "--build", SEQUENCE_OUT]
                # The profiles the user changed (the shipped ones come with every copy of the screensaver)
                with session.lock:
                    parks = session.state(profiles.load())["parks"]
                for p in parks:
                    if p.get("profileSource") == "user":
                        own = os.path.join(USER_PARKS, p["profile"] + ".toml")
                        if os.path.exists(own) and own not in args:
                            args += ["--profile", own]
                return {"job": app.start("export", args), "path": out}
            elif path == "/api/import":
                start = app.config.get("bundles") or os.path.expanduser("~")
                src = dialog("askopenfilename", start)
                if not src:
                    return {"cancelled": True}
                app.config["bundles"] = os.path.dirname(src)
                save_config(app.config)
                # A bundle starts clean: no build or renders of what was open before (owner, 2026-10-31)
                for folder in (SEQUENCE_OUT, RENDERS, RENDERS_PREVIOUS):
                    shutil.rmtree(folder, ignore_errors=True)
                result = os.path.join(HOME, "import-result.json")
                args = [sys.executable, os.path.join(TOOLS, "bundle.py"), "import", src, "--playlists", USER_PLAYLISTS,
                        "--profiles", USER_PARKS, "--parks-to", BUNDLE_PARKS, "--build-to", SEQUENCE_OUT,
                        "--json", result]
                if app.config.get("folder"):
                    args += ["--park-dir", app.config["folder"]]

                def opened():
                    with open(result, encoding="utf-8") as f:
                        imported = json.load(f)
                    os.remove(result)
                    with session.lock:
                        session.open(imported["playlist"])
                        app.config["playlist"] = session.path
                        save_config(app.config)
                return {"job": app.start("import", args, opened)}
            elif path == "/api/relink":
                folder = os.path.abspath(body["folder"])
                if not os.path.isdir(folder):
                    raise ValueError("%s is not a folder" % folder)
                app.config["folder"] = folder
                save_config(app.config)
                with session.lock:
                    return {"found": session.relink(folder)}
            elif path == "/api/render":
                if not app.config.get("openrct2"):
                    raise ValueError("set the OpenRCT2 path first (openrct2.com on Windows, the openrct2 binary elsewhere)")
                result = session.built()
                built = result and result[:-len(".result.json")] + ".playlist.json"
                if not built or not os.path.exists(built):
                    raise ValueError("build the playlist first")
                shutil.rmtree(RENDERS_PREVIOUS, ignore_errors=True)  # one set before this one is kept
                if os.path.isdir(RENDERS):
                    os.replace(RENDERS, RENDERS_PREVIOUS)
                # Pictures of unchanged parks and views are copied from the set before (renderviews.py --reuse)
                args = [sys.executable, os.path.join(TOOLS, "renderviews.py"), built, "--openrct2", app.config["openrct2"],
                        "-o", RENDERS, "--reuse", RENDERS_PREVIOUS]
                return {"job": app.start("render", args)}
            else:
                raise KeyError("no such call %s" % path)
            return None
    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("playlist", nargs="?", help="playlist to open (default: none)")
    ap.add_argument("--openrct2", help="OpenRCT2 executable for previews and RCT2 save conversion (on Windows openrct2.com)")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--no-browser", action="store_true", help="don't open the page in a browser")
    args = ap.parse_args()
    if sys.stdout is None:  # pythonw (Settings.cmd): no console, so the server's output goes to a log
        os.makedirs(LOGS, exist_ok=True)
        sys.stdout = sys.stderr = open(os.path.join(LOGS, "settings-%s.log" % time.strftime("%Y%m%d-%H%M%S")), "a",
                                       encoding="utf-8", buffering=1)
    config = load_config()
    token = config.get("token") or secrets.token_urlsafe(16)  # kept, so tabs survive a restart
    config["token"] = token
    url = "http://127.0.0.1:%d/?t=%s" % (args.port, token)
    if running(args.port, token) and not args.playlist:
        print("already running: %s" % url)
        if not args.no_browser:
            webbrowser.open(url)
        return
    if args.openrct2:
        config["openrct2"] = os.path.abspath(args.openrct2)
    elif not config.get("openrct2") and sys.platform != "win32" and shutil.which("openrct2"):
        # Linux and macOS: an installed OpenRCT2 is on PATH (a portable tarball is not: set its path)
        config["openrct2"] = shutil.which("openrct2")
    try:
        app = App(config, args.playlist and os.path.abspath(args.playlist))
        save_config(config)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), None)
        server.RequestHandlerClass = make_handler(app, token, server.server_address[1])
    except (ValueError, OSError, tomllib.TOMLDecodeError) as e:
        sys.exit("error: %s" % e)
    app.server = server
    threading.Thread(target=app.watch, daemon=True).start()
    url = "http://127.0.0.1:%d/?t=%s" % (server.server_address[1], token)
    print("open %s (Ctrl+C to stop; stops by itself once no page is open)" % url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    # The staging build is only for this session's Render, Install and Export: the game plays its own
    # installed copy (owner, 2026-10-31)
    shutil.rmtree(SEQUENCE_OUT, ignore_errors=True)
    print("stopped; removed the staging build", flush=True)


def running(port, token):
    """Whether this page's server already answers on port (then starting again only opens the page)."""
    try:
        req = urllib.request.Request("http://127.0.0.1:%d/api/ping?page=launcher&t=%s" % (port, token))
        with urllib.request.urlopen(req, timeout=2) as r:
            return r.status == 200
    except (OSError, ValueError):
        return False


if __name__ == "__main__":
    main()
