"""Draw a playlist's views by hand in the browser, on renders of each park from all four angles.

The settings page (tools/settings.py) serves the same page on its last build (/draw); this runs it alone.

Usage: python tools/drawviews.py <playlist.toml> --openrct2 <path to openrct2>
                                 [--screen WIDTHxHEIGHT] [--port 8765] [--no-browser]

Builds the playlist (as mksequence.py does, into build/drawviews), has OpenRCT2 render each
park's content from every angle (its headless screenshot command, cached in
build/drawviews/renders), and serves a page on localhost where each view is a box drawn on
those renders: the box is exactly what the screen shows, so its size snaps to a zoom level and
its shape is the screen's. Changes are saved as they are made into <playlist>.views.json, the
file the in-game view editor's views are kept in, so the next `mksequence.py --install` plays
them exactly as drawn (not fitted). OpenRCT2 does not need to be running; the screen size
defaults to the one in OpenRCT2's config.ini.
"""
import argparse, configparser, hashlib, http.server, json, math, os, re, subprocess, sys, threading, \
    urllib.parse, webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mksequence  # noqa: E402

TILE = 32
PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "drawviews.html")
MAX_PIXELS = 4096  # longest side of a render; wider parks are rendered zoomed out
MARGIN = 0.2  # of the content's screen size, rendered around it on each side (plus MARGIN_PX)
MARGIN_PX = 256
VIEW_KEYS = ("x", "y", "z", "rotation", "zoom", "hold", "manual", "overview", "holdSet", "pan", "panChanges", "zoomThreshold")


def to_screen(x, y, z, rotation):
    """World coordinates to zoom-0 screen coordinates, as OpenRCT2 projects them (plugin fit.ts)."""
    a, b = [(x, y), (y, -x), (-x, -y), (-y, x)][rotation & 3]
    return b - a, (a + b) // 2 - z


def to_world(sx, sy, z, rotation):
    """Screen coordinates back to world (x, y) on the plane at height z."""
    a = sy + z - sx / 2
    b = sy + z + sx / 2
    return [(a, b), (-b, a), (-a, -b), (b, -a)][rotation & 3]


def render_plan(box, rotation):
    """Where to point OpenRCT2's screenshot so it covers the content box (plus a margin) at an
    angle: the screenshot's world point, zoom and size, and the screen position of its top left
    corner (zoom-0 screen pixels), exactly as OpenRCT2 places the image."""
    (x0, x1), (y0, y1) = mksequence.screen_extent(box, rotation)
    mx = (x1 - x0) * MARGIN + MARGIN_PX
    my = (y1 - y0) * MARGIN + MARGIN_PX
    x0, x1, y0, y1 = x0 - mx, x1 + mx, y0 - my, y1 + my
    zoom = 0
    while zoom < 3 and max(x1 - x0, y1 - y0) / 2 ** zoom > MAX_PIXELS:
        zoom += 1
    width, height = math.ceil((x1 - x0) / 2 ** zoom), math.ceil((y1 - y0) / 2 ** zoom)
    # The world point on the line of sight through the middle that passes nearest the content's
    # middle: OpenRCT2's command line reads a negative number as an option, so keep it on the map.
    sx, sy = (x0 + x1) / 2, (y0 + y1) / 2
    (ax, ay), (bx, by) = to_world(sx, sy, 0, rotation), to_world(sx, sy, 1, rotation)
    tx, ty = (box.get("cx", (box["x0"] + box["x1"] + 1) / 2) * TILE, box.get("cy", (box["y0"] + box["y1"] + 1) / 2) * TILE)
    dx, dy = bx - ax, by - ay
    t = ((tx - ax) * dx + (ty - ay) * dy) / (dx * dx + dy * dy)
    z = round(max(box["z0"], min(box["z1"], t)))
    wx, wy = (max(0, round(c)) for c in to_world(sx, sy, z, rotation))
    cx, cy = to_screen(wx, wy, z, rotation)
    # Screenshot.cpp: viewPos = centre - (size << zoom) / 2, which the renderer then snaps down to
    # a whole pixel at the render's zoom (measured: an odd left at zoom 1 lands 1 pixel further left).
    step = 1 << zoom
    left, top = cx - (width << zoom) // 2, cy - (height << zoom) // 2
    return {"x": wx, "y": wy, "z": z, "zoom": zoom, "rotation": rotation, "width": width, "height": height,
            "left": left - left % step, "top": top - top % step}


# Box for a park with no content worth bounding (nothing built): a 128-tile map.
EMPTY_BOX = {"x0": 1, "y0": 1, "x1": 126, "y1": 126, "z0": 16, "z1": 16, "zm": 16}


def park_box(path):
    """The content box of the park file at path, read from the file itself, for a build that carries
    none: its built content, else the whole map (EMPTY_BOX assumed a 128-tile map, which cut larger
    maps such as The Koi Pond's 252 tiles in half, owner 2026-11-02)."""
    try:
        with open(path, "rb") as f:
            hdr, chunks, body = mksequence.parkinfo.load(f.read())
        tiles = lambda: mksequence.parkinfo.chunk_reader(chunks, body, 0x30)  # noqa: E731
        _, counts, surface, heights = mksequence.parkinfo.visible_element_counts(tiles())
        box = mksequence.content_bounds(counts, heights, surface)
        if box:
            return box
        w, h = mksequence.map_size(tiles())
    except (OSError, ValueError, KeyError):
        return EMPTY_BOX
    return {"x0": 1, "y0": 1, "x1": max(2, w - 2), "y1": max(2, h - 2), "z0": 16, "z1": 16, "zm": 16}


def default_screen(user_dir):
    """The game's screen size in viewport pixels, from OpenRCT2's config.ini: the fullscreen
    size (or the desktop's, for borderless fullscreen) or the window size, over the UI scale."""
    config = configparser.ConfigParser(interpolation=None)
    try:
        config.read(os.path.join(user_dir, "config.ini"), encoding="utf-8")
        general = config["general"]
    except (configparser.Error, KeyError, UnicodeDecodeError):
        return None, "no config.ini"

    def number(key, cast=int, default=0):
        try:
            return cast(general.get(key, default))
        except ValueError:
            return default

    mode = number("fullscreen_mode")
    size = None
    if mode == 1 and number("fullscreen_width") > 0:
        size, source = (number("fullscreen_width"), number("fullscreen_height")), "fullscreen size"
    elif mode == 2 and sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.SetProcessDPIAware()
        size = ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1)
        source = "desktop size (borderless fullscreen)"
    elif mode == 0 and number("window_width") > 0:
        size, source = (number("window_width"), number("window_height")), "window size"
    if not size or min(size) <= 0:
        return None, "config.ini gives no usable size"
    scale = number("window_scale", float, 1.0) or 1.0
    return (round(size[0] / scale), round(size[1] / scale)), "OpenRCT2's %s, UI scale %g" % (source, scale)


class Renders:
    """Renders each park from each angle once, cached by park contents and render plan."""

    def __init__(self, openrct2, parks, seq_dir, out_dir):
        self.openrct2, self.parks, self.seq_dir, self.dir = openrct2, parks, seq_dir, out_dir
        self.locks = {}
        self.lock = threading.Lock()
        os.makedirs(out_dir, exist_ok=True)

    def plan(self, i, rotation):
        park = self.parks[i]
        plan = render_plan(park["box"], rotation)
        ident = hashlib.sha1(park["data"] + json.dumps(plan, sort_keys=True).encode()).hexdigest()[:16]
        return plan, os.path.join(self.dir, "%s-r%d.png" % (ident, rotation))

    def get(self, i, rotation):
        """The render's plan and file, rendering it first if needed; the plan's "error" is set
        when OpenRCT2 failed."""
        plan, path = self.plan(i, rotation)
        with self.lock:
            lock = self.locks.setdefault(path, threading.Lock())
        with lock:
            if not os.path.exists(path):
                park = os.path.join(self.seq_dir, self.parks[i]["fileName"])
                args = [self.openrct2, "screenshot", park, path + ".tmp.png", str(plan["width"]), str(plan["height"]),
                        str(plan["x"]), str(plan["y"]), str(plan["z"]), str(plan["zoom"]), str(rotation)]
                result = subprocess.run(args, capture_output=True, text=True,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if result.returncode != 0 or not os.path.exists(path + ".tmp.png"):
                    return {**plan, "error": (result.stdout + result.stderr).strip()[-500:] or "screenshot failed"}, None
                os.replace(path + ".tmp.png", path)
        return plan, path

    def warm(self, first=0):
        """Renders every park in the background, starting at `first`."""
        def run():
            for k in range(len(self.parks)):
                for rotation in range(4):
                    self.get((first + k) % len(self.parks), rotation)
        threading.Thread(target=run, daemon=True).start()


def clean_view(v):
    """A view as the page sent it, checked and reduced to what the views file keeps."""
    view = {"x": round(float(v["x"]), 2), "y": round(float(v["y"]), 2), "z": int(v["z"]),
            "rotation": int(v["rotation"]) % 4, "zoom": max(-2, min(3, int(v["zoom"]))),
            "hold": max(1.0, min(600.0, round(float(v["hold"]), 1)))}
    if not (-1001 <= view["x"] < 2002 and -1001 <= view["y"] < 2002):
        raise ValueError("view (%g, %g) is outside the map" % (view["x"], view["y"]))
    for flag in ("manual", "overview", "holdSet"):  # inertia is the playlist's ([views] inertia)
        if v.get(flag):
            view[flag] = True
    # Panning on to the next view: a share of the hold, and how it moves
    pan = max(0.0, min(1.0, round(float(v.get("pan") or 0), 2)))
    if pan > 0:
        view["pan"] = pan
    if v.get("panChanges") in ("start", "end"):
        view["panChanges"] = v["panChanges"]
    return view


class Store:
    """The playlist's views file: each saved park is pinned ("arranged"), so it plays as drawn."""

    def __init__(self, playlist_path, screen=None):
        self.path = mksequence.edits_path(playlist_path)
        self.screen = screen  # the screen views are drawn for: the plugin keeps their framing in another
        self.lock = threading.Lock()

    def save(self, key, views):
        with self.lock:
            edits = mksequence.load_edits(self.path)
            edits[key] = {"arranged": True, "views": [clean_view(v) for v in views]}
            if self.screen:
                edits[key]["screen"] = [int(self.screen[0]), int(self.screen[1])]
            mksequence.save_edits(self.path, edits)

    def reset(self, key):
        """Drop a park's views (kept in the .bak.json file, as an editor reset does)."""
        with self.lock:
            edits = mksequence.load_edits(self.path)
            if key in edits:
                backup = os.path.splitext(self.path)[0] + ".bak.json"
                mksequence.save_edits(backup, {**mksequence.load_edits(backup), key: edits.pop(key)})
                mksequence.save_edits(self.path, edits)


def page_state(result, screen, source, store_path, timing):
    edits = mksequence.load_edits(store_path)
    parks = []
    for park in result["parks"]:
        saved = park["key"] in edits and mksequence.pinned(edits[park["key"]])
        keep = lambda vs: [{k: v[k] for k in VIEW_KEYS if k in v} for v in vs]  # noqa: E731
        # Views framed for another screen are shown as the plugin plays them on this one: whole zoom
        # levels out or in (generated views: [views] window; saved ones: the screen they were drawn for).
        design = (result.get("playlist") or {}).get("screen") or mksequence.VIEW_DEFAULTS["window"]
        generated = mksequence.scale_views(park["defaultViews"] if park["defaultViews"] is not None else park["views"],
                                           mksequence.zoom_offset(design, screen))
        views = (mksequence.scale_views(park["views"], mksequence.zoom_offset(park.get("viewScreen"), screen))
                 if park["defaultViews"] is not None else generated)
        parks.append({"key": park["key"], "name": park["name"], "fileName": park["fileName"],
                      "box": park["box"], "saved": saved, "views": keep(views), "generated": keep(generated)})
    return {"sequence": result["name"], "screen": {"width": screen[0], "height": screen[1]}, "timing": timing,
            "screenSource": source, "viewsFile": os.path.basename(store_path), "parks": parks}


def make_handler(state, renders, store):
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
            self.end_headers()
            self.wfile.write(body)

        def park_index(self, query):
            i = int(query["park"][0])
            if not 0 <= i < len(state["parks"]):
                raise ValueError("no park %d" % i)
            return i

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(url.query)
            try:
                if url.path == "/":
                    with open(PAGE, encoding="utf-8") as f:
                        self.reply(200, f.read(), "text/html; charset=utf-8")
                elif url.path == "/api/state":
                    self.reply(200, state)
                elif url.path == "/api/render":
                    plan, _ = renders.get(self.park_index(query), int(query["rotation"][0]) & 3)
                    self.reply(200, plan)
                elif url.path == "/image":
                    _, path = renders.get(self.park_index(query), int(query["rotation"][0]) & 3)
                    if not path:
                        self.reply(404, {"error": "render failed"})
                        return
                    with open(path, "rb") as f:
                        self.reply(200, f.read(), "image/png")
                else:
                    self.reply(404, {"error": "not found"})
            except (KeyError, ValueError) as e:
                self.reply(400, {"error": str(e)})

        def do_POST(self):
            # Only the page itself may write (a page on another site can't set this header
            # without a CORS preflight, which this server never answers).
            if self.headers.get("X-Draw-Views") != "1":
                self.reply(403, {"error": "forbidden"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                i = int(body["park"])
                park = state["parks"][i]
                if self.path == "/api/save":
                    views = [clean_view(v) for v in body["views"]]
                    if views:
                        store.save(park["key"], views)
                    else:
                        store.reset(park["key"])  # a park with no views would keep one camera for good
                    park["views"], park["saved"] = views, bool(views)
                    self.reply(200, {"ok": True, "saved": bool(views)})
                elif self.path == "/api/reset":
                    store.reset(park["key"])
                    park["views"], park["saved"] = park["generated"], False
                    self.reply(200, {"ok": True, "views": park["views"]})
                else:
                    self.reply(404, {"error": "not found"})
            except (KeyError, ValueError, TypeError, IndexError, OSError) as e:
                self.reply(400, {"error": str(e)})
    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("playlist", help="the playlist (.toml); views are saved next to it in <playlist>.views.json")
    ap.add_argument("--openrct2", required=True, help="OpenRCT2 executable (on Windows openrct2.com or openrct2.exe)")
    ap.add_argument("--screen", help="screen size views are drawn for, as WIDTHxHEIGHT in game pixels "
                                     "(default: from OpenRCT2's config.ini, else 1920x1080)")
    ap.add_argument("--user-dir", help="OpenRCT2 user directory, for config.ini (default: %s)"
                    % mksequence.default_user_dir())
    ap.add_argument("-o", "--out", default="build/drawviews", help="build and render directory (default: build/drawviews)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="don't open the page in a browser")
    args = ap.parse_args()
    try:
        if args.screen:
            m = re.fullmatch(r"(\d+)\s*[xX]\s*(\d+)", args.screen.strip())
            if not m:
                raise ValueError("--screen takes WIDTHxHEIGHT, e.g. 1920x1080")
            screen, source = (int(m.group(1)), int(m.group(2))), "--screen"
        else:
            screen, source = default_screen(args.user_dir or mksequence.default_user_dir())
            if not screen:
                screen, source = (1920, 1080), "default (%s)" % source
        print("screen %dx%d (%s)" % (screen[0], screen[1], source))
        print("building %s ..." % args.playlist)
        result = mksequence.build(args.playlist, os.path.join(args.out, "sequence"))
        for park in result["parks"]:
            park["box"] = park["box"] or park_box(os.path.join(result["dir"], park["fileName"]))
        store = Store(args.playlist, screen)
        with open(args.playlist, "rb") as f:
            options = {**mksequence.VIEW_DEFAULTS, **mksequence.tomllib.load(f).get("views", {})}
        timing = {k: float(options[k]) for k in ("park_time", "base_views", "view_time", "overview_lead")}
        state = page_state(result, screen, source, store.path, timing)
        renders = Renders(args.openrct2, result["parks"], result["dir"], os.path.join(args.out, "renders"))
        renders.warm()
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(state, renders, store))
    except (ValueError, OSError) as e:
        sys.exit("error: %s" % e)
    url = "http://127.0.0.1:%d/" % server.server_address[1]
    print("views are saved to %s" % store.path)
    print("open %s (Ctrl+C to stop)" % url)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
