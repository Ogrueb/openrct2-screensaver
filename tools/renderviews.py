"""Render every view of a built playlist to PNG with OpenRCT2's headless screenshot command, plus
an index.html contact sheet (and renders.json, the files per park key, for the settings page), so views can be judged (and compared between builds) without
playing the screensaver.

Usage: python tools/renderviews.py <OUTDIR/name.playlist.json> --openrct2 <path to openrct2>
                                   [-o OUTDIR] [--park TEXT] [--angles] [--size 1920x1080]

Reads the parks from the sequence folder next to the playlist file (as written by mksequence.py).
Views are rendered as stored, before the plugin's run-time fitting: the overview at its stored
zoom, close-ups centred on their spot. OpenRCT2's screenshot command takes no zoom below 0, so a
close-up at zoom -1 or -2 is rendered at zoom 0 over the same area (half or a quarter of the
size). Needs a working OpenRCT2 install (with RCT2 data); does not touch a running game.
"""
import argparse, hashlib, html, json, os, re, shutil, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parkinfo  # noqa: E402


def file_hash(path):
    """The park file's SHA-1: the settings page compares it with a later build's copy, to tell whether
    an old render still shows the park's map."""
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def saved_rotation(path):
    with open(path, "rb") as f:
        _, chunks, body = parkinfo.load(f.read())
    return parkinfo.parse_interface(parkinfo.chunk_reader(chunks, body, 0x20))["rotation"]


def to_screen(x, y, z, rotation):
    """World coordinates to zoom-0 screen coordinates, as OpenRCT2 projects them (plugin fit.ts)."""
    a, b = [(x, y), (y, -x), (-x, -y), (-y, x)][rotation & 3]
    return b - a, (a + b) / 2 - z


TURNS = {1: "\u21bb", 2: "\u21bb\u21bb", 3: "\u21ba"}  # the angle's step to the next view: +1, +2, -1


def overlay(view, rotation, after, after_rotation, size):
    """An SVG over a view's render: a line toward the next view (in this view's projection; cut at
    the frame's edge): solid where the view pans there, dashed where it cuts; and the angle and zoom
    changes on the way."""
    w, h = 480, 270
    parts = []
    pan = float(view.get("pan", 0) or 0)
    zoom, next_zoom = int(view.get("zoom", 0)), int(after.get("zoom", 0))
    if True:
        here = to_screen(int(view["x"]) * 32 + 16, int(view["y"]) * 32 + 16, int(view.get("z", 0)), rotation)
        there = to_screen(int(after["x"]) * 32 + 16, int(after["y"]) * 32 + 16, int(after.get("z", 0)), rotation)
        scale = w / (size[0] * 2.0 ** zoom)  # zoom-0 screen units to sheet pixels
        dx, dy = (there[0] - here[0]) * scale, (there[1] - here[1]) * scale
        if abs(dx) + abs(dy) >= 2:
            # cut at the frame's edge (a pan longer than the screen leaves the frame)
            t = min(1.0, (w / 2 - 6) / abs(dx) if dx else 1.0, (h / 2 - 6) / abs(dy) if dy else 1.0)
            x1, y1 = w / 2 + dx * t, h / 2 + dy * t
            screens = (dx * dx / (w * w) + dy * dy / (h * h)) ** 0.5
            parts.append('<line%s x1="%d" y1="%d" x2="%.1f" y2="%.1f" marker-end="url(#%s)"/>' % (
                "" if pan > 0 else ' class="cut"', w // 2, h // 2, x1, y1, "head" if pan > 0 else "headcut"))
            parts.append('<circle cx="%d" cy="%d" r="4"/>' % (w // 2, h // 2))
            if t < 1:
                parts.append('<text x="%.1f" y="%.1f">%.1f screens</text>' % (
                    min(max(x1, 40), w - 40), min(max(y1 + (14 if y1 < h / 2 else -8), 14), h - 6), screens))
    notes = []
    turn = (after_rotation - rotation) % 4
    if turn:
        notes.append("%s angle %d" % (TURNS[turn], after_rotation))
    if next_zoom != zoom:
        notes.append("zoom %s %d" % ("in" if next_zoom < zoom else "out", next_zoom))
    if notes:
        parts.append('<text class="note" x="8" y="%d">%s</text>' % (h - 8, html.escape(" \u00b7 ".join(notes))))
    if not parts:
        return ""
    return ('<svg viewBox="0 0 %d %d"><defs><marker id="head" viewBox="0 0 10 10" refX="8" refY="5" '
            'markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>'
            '<marker id="headcut" class="cut" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" '
            'orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>%s</svg>'
            % (w, h, "".join(parts)))


def track_label(why):
    """TRACK and the ride for the two views of a ride-following pan (mksequence.py's ride_pans), from
    the build's scores file."""
    ride = (why or {}).get("ride") if isinstance(why, dict) else None
    if ride is None:
        return ""
    name = re.sub(r"\{[A-Z_0-9]+\}", "", why.get("name") or "").strip() or "ride %s" % ride  # no colour codes
    return "TRACK %s, %s" % (name, "end" if why.get("end") else "start")


def event_label(view):
    """EVENT and what the view waits for or plays, for views from a park's companion plugins."""
    if view.get("show"):
        return "EVENT show %s" % (view["show"].get("name") if isinstance(view["show"], dict) else view["show"])
    if view.get("animation") or view.get("cue"):
        cue = view.get("cue") or {}
        return "EVENT %s%s" % (view.get("animation", "cue"), ", cut-in" if cue.get("cut") else "")
    return ""


def render(openrct2, park, out, view, rotation, size):
    zoom = int(view.get("zoom", 0))
    w, h = size
    if zoom < 0:
        w, h, zoom = w >> -zoom, h >> -zoom, 0
    args = [openrct2, "screenshot", park, out, str(w), str(h),
            str(int(view["x"]) * 32 + 16), str(int(view["y"]) * 32 + 16), str(int(view.get("z", 0))),
            str(zoom), str(rotation)]
    result = subprocess.run(args, capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return result.returncode == 0 and os.path.exists(out), " ".join(args[1:])


class Reuse:
    """Pictures of an earlier render set (its renders.json "images": picture key -> file) that can stand in
    for a new render: a picture depends only on the park file, where the camera is and the size, so a
    park whose map and views did not change is copied instead of rendered again (owner, 2026-11-02)."""

    def __init__(self, folder, out):
        self.folder, self.out, self.images, self.made = folder, out, {}, {}
        self.rendered = self.reused = 0
        try:
            with open(os.path.join(folder, "renders.json"), encoding="utf-8") as f:
                self.images = json.load(f).get("images", {})
        except (OSError, ValueError, TypeError):
            self.images = {}

    def render(self, openrct2, park, park_hash, name, view, rotation, size):
        """render() into the output folder as `name`, or a copy of the same picture from the earlier set."""
        w, h = size
        key = "%s|%s,%s,%s|%s|%s|%dx%d" % (park_hash, int(view["x"]), int(view["y"]), int(view.get("z", 0)),
                                           int(view.get("zoom", 0)), rotation, w, h)
        out = os.path.join(self.out, name)
        old = self.images.get(key)
        if old and self.folder and os.path.exists(os.path.join(self.folder, old)):
            shutil.copyfile(os.path.join(self.folder, old), out)
            self.made[key] = name
            self.reused += 1
            return True, "(reused %s)" % old
        ok, command = render(openrct2, park, out, view, rotation, size)
        if ok:
            self.made[key] = name
            self.rendered += 1
        return ok, command


def views_key(park):
    """A digest of a park's views as built: the settings page keeps a park's route preview after a
    later build when its park file and this are unchanged (a partial rebuild redid other parks)."""
    return hashlib.sha1(json.dumps(park.get("views", []), sort_keys=True).encode()).hexdigest()


def park_info(park):
    """The build facts shown in a park's header on the contact sheet."""
    views = park["views"]
    moving = sum(float(v.get("pan", 0) or 0) * float(v.get("hold", 0)) for v in views)
    events = sum(1 for v in views if v.get("animation") or v.get("show") or v.get("cue"))
    parts = ["%d view%s" % (len(views), "" if len(views) == 1 else "s"),
             "%.0f s per visit" % float(park.get("parkTime") or sum(float(v.get("hold", 0)) for v in views)),
             "%.0f s moving" % moving if moving else "held still",
             "%d event view%s" % (events, "" if events == 1 else "s") if events else "",
             "%d alternative order%s" % (len(park["variants"]), "" if len(park["variants"]) == 1 else "s") if park.get("variants") else "",
             park.get("key") or park["fileName"]]
    return " \u00b7 ".join(p for p in parts if p)



def total_frame(views, angles, size):
    """The frame of a park's "total" render: the overview's centre and angle, zoomed out from the
    overview's zoom until every view's centre sits inside the frame (with room for its number)."""
    first = views[0]
    centre = to_screen(int(first["x"]) * 32 + 16, int(first["y"]) * 32 + 16, int(first.get("z", 0)), angles[0])
    points = [to_screen(int(v["x"]) * 32 + 16, int(v["y"]) * 32 + 16, int(v.get("z", 0)), angles[0]) for v in views]
    zoom = int(first.get("zoom", 0))
    while zoom < 5:
        half_w, half_h = size[0] * 2.0 ** zoom * 0.45, size[1] * 2.0 ** zoom * 0.42
        if all(abs(px - centre[0]) <= half_w and abs(py - centre[1]) <= half_h for px, py in points):
            break
        zoom += 1
    return dict(first, zoom=zoom), angles[0]


def route_overlay(views, frame, rotation, size):
    """An SVG over a park's total render: every view's centre, numbered in play order, and every line
    between them (the last back to the first), solid where the view pans on and dashed where it cuts;
    all in the total render's projection (the overview's angle)."""
    w, h = 480, 270
    scale = w / (size[0] * 2.0 ** int(frame.get("zoom", 0)))
    cx, cy = to_screen(int(frame["x"]) * 32 + 16, int(frame["y"]) * 32 + 16, int(frame.get("z", 0)), rotation)
    points = []
    for v in views:
        px, py = to_screen(int(v["x"]) * 32 + 16, int(v["y"]) * 32 + 16, int(v.get("z", 0)), rotation)
        points.append((w / 2 + (px - cx) * scale, h / 2 + (py - cy) * scale))
    parts = []
    n = len(views)
    for k in range(n if n > 1 else 0):
        (x0, y0), (x1, y1) = points[k], points[(k + 1) % n]
        d = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        if d < 22:  # the same spot (or nearly): no room for a line between the numbers
            continue
        ux, uy = (x1 - x0) / d, (y1 - y0) / d  # from the edge of one number's disc to the next one's
        pan = float(views[k].get("pan", 0) or 0) > 0
        parts.append('<line%s x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" marker-end="url(#%s)"/>' % (
            "" if pan else ' class="cut"', x0 + ux * 9, y0 + uy * 9, x1 - ux * 11, y1 - uy * 11, "thead" if pan else "theadcut"))
    # Views on one spot share a label ("2,3,4"): a disc for one number, a pill for more
    spots = []
    for k, (x, y) in enumerate(points):
        spot = next((sp for sp in spots if abs(sp[0] - x) < 4 and abs(sp[1] - y) < 4), None)
        if spot:
            spot[2].append(k + 1)
        else:
            spots.append((x, y, [k + 1]))
    for x, y, numbers in spots:
        text = ",".join(str(k) for k in numbers)
        half = max(8.0, 3.3 * len(text) + 4)
        # (the inner group scales from the spot: the settings page's small preview draws labels larger)
        parts.append('<g transform="translate(%.1f %.1f)"><g class="lab"><rect class="num" x="%.1f" y="-8" width="%.1f" height="16" rx="8"/>'
                     '<text class="num" x="0" y="0">%s</text></g></g>' % (x, y, -half, half * 2, text))
    return ('<svg viewBox="0 0 %d %d"><defs><marker id="thead" viewBox="0 0 10 10" refX="8" refY="5" '
            'markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>'
            '<marker id="theadcut" class="cut" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" '
            'orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>%s</svg>' % (w, h, "".join(parts)))


# The contact sheet: one column of parks, each under a header with its build facts. Served by the
# settings page with the previous render set as window.PREVIOUS ({built, rendered, base, token, parks}),
# the Compare box (in the top bar) shows that set as a second column beside it, each column with its own headers and
# its own scrolling (owner, 2026-11-01); a click on a park's header finds the same park in the other.
PAGE_CSS = (
    # The generator page's colours (tools/settings.html), dark and light, and its scrollbars
    ":root,body.dark{--bg:#161b1f;--bar:#1d2429;--card:#1f272c;--line:#2c363d;--well:#192024;--text:#e8ecef;"
    "--text2:#b4bfc6;--muted:#9aa7b0;--accent:#e0a43a;--band:#2b4652;--bandtext:#e8ecef;--scroll:#4a5760;--btn:#232b31;--btnline:#3a464e}"
    "body.light{--bg:#e6d8b8;--bar:#d9c7a0;--card:#f2e9d3;--line:#c4ad82;--well:#e9dcbd;--text:#1f1a10;"
    "--text2:#463b26;--muted:#56492f;--accent:#2f5d3a;--band:#2f5d3a;--bandtext:#f6f0e0;--scroll:#a8916a;--btn:#ece0c2;--btnline:#a8916a}"
    "::-webkit-scrollbar{width:14px;height:14px}::-webkit-scrollbar-track{background:var(--well)}"
    "::-webkit-scrollbar-thumb{background:var(--scroll);border:3px solid var(--well)}::-webkit-scrollbar-corner{background:var(--well)}"
    "@supports (-moz-appearance:none){*{scrollbar-color:var(--scroll) var(--well)}}"
    "html,body{height:100%}body{margin:0;background:var(--bg);color:var(--text);font:14px sans-serif;display:flex;flex-direction:column}"
    ".top{flex:0 0 auto;display:flex;align-items:center;gap:16px;padding:12px 24px;background:var(--bar);border-bottom:1px solid var(--line)}"
    ".top h1{margin:0;font-size:20px}.top .grow{flex:1 1 auto}"
    ".info{color:var(--muted);font-size:13px;margin-top:4px}"
    ".legend{display:flex;align-items:center;gap:14px;color:var(--text2);font-size:13px}"
    ".legend svg{width:34px;height:10px;vertical-align:middle;background:#000;padding:2px 4px}"
    "#theme{height:34px;width:40px;font-size:18px;background:var(--btn);color:var(--text);border:1px solid var(--btnline);cursor:pointer}"
    ".panes{flex:1 1 auto;display:flex;min-height:0}"
    ".pane{flex:1 1 0;min-width:0;overflow-y:auto;padding:0 24px 80px}"
    ".pane > .inner{max-width:1000px;margin:0 auto}"
    "#previous{display:none;border-left:2px solid var(--line)}body.compare #previous{display:block}"
    ".panehead{position:sticky;top:0;z-index:3;background:var(--bg);padding:10px 0 6px;color:var(--muted);font-size:12px;"
    "text-transform:uppercase;letter-spacing:.05em;display:none}body.compare .panehead{display:block}"
    "section.park{margin:12px 0 28px}"
    "section.park header{position:sticky;top:0;z-index:2;background:var(--band);color:var(--bandtext);padding:8px 12px;margin-bottom:8px;"
    "border-left:4px solid var(--accent);box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:pointer}"
    "section.park header .info{color:var(--bandtext);opacity:.8}"
    "body.compare section.park header{top:34px}"
    "section.park h2{margin:0;font-size:17px}"
    ".views{display:flex;flex-direction:column;gap:12px}"
    "figure{margin:0}img{width:100%;aspect-ratio:16/9;object-fit:contain;background:#000;display:block}"
    "figcaption{padding:4px 0;color:var(--text2)}"
    ".shot{position:relative}.shot svg{position:absolute;inset:0;width:100%;height:100%}"
    # Pan lines solid yellow; cut lines (the view cuts to the next) dashed cyan
    "svg line{stroke:#ffd23f;stroke-width:3}svg circle,svg marker path{fill:#ffd23f}"
    "svg line.cut{stroke:#5fd4ff;stroke-dasharray:8 6}svg marker.cut path{fill:#5fd4ff}"
    "svg text{fill:#ffd23f;font:bold 13px sans-serif;text-anchor:middle;paint-order:stroke;stroke:#000;stroke-width:3px}"
    "svg text.note{text-anchor:start}"
    "svg rect.num{fill:#ffd23f;stroke:#000;stroke-width:1.5}svg text.num{fill:#000;stroke:none;font:bold 11px sans-serif;dominant-baseline:central}"
    "section.park.flash header{outline:2px solid #5fd4ff}"
    "a.edit{float:right;margin-left:12px;padding:6px 12px;background:var(--accent);color:#111;font-weight:600;text-decoration:none}"
    "body.light a.edit{background:#8a5a24;color:#f6f0e0}"
    ".hand{display:inline-block;margin-left:10px;padding:1px 8px;font-size:12px;font-weight:600;vertical-align:middle;"
    "background:#c2185b;color:#fff;letter-spacing:.02em}"
    ".shot .hand{position:absolute;top:8px;left:8px;margin:0;z-index:1}"
    "#compare{display:none;align-items:center;gap:8px;height:34px;box-sizing:border-box;padding:0 12px;"
    "background:var(--btn);color:var(--text);border:1px solid var(--accent);cursor:pointer;white-space:nowrap}"
    "#compare .info{margin:0}"
    "#compare input{accent-color:var(--accent);width:18px;height:18px;margin:0}")
# Hand-set parks (views drawn on the drawing page or in the game's editor) and each view drawn by hand
HAND_PARK = ' <span class="hand" title="Views set by hand: they play as drawn">manual</span>'
HAND_BADGE = '<span class="hand" title="Drawn by hand">manual</span>'
LEGEND = ('<div class=legend><span><svg viewBox="0 0 34 10"><line x1="0" y1="5" x2="34" y2="5"/></svg> pans to the next view</span>'
          '<span><svg viewBox="0 0 34 10"><line class="cut" x1="0" y1="5" x2="34" y2="5"/></svg> cuts to the next view</span></div>')
PAGE_JS = r"""
(function () {
  const prev = window.PREVIOUS, latest = document.getElementById("latest");
  // Dark and light like the generator page (same setting, same browser storage)
  const theme = () => document.body.className = document.body.className.replace(/\b(dark|light)\b/g, "").trim() +
    (localStorage.getItem("rctss-theme") === "light" ? " light" : " dark");
  theme();
  document.getElementById("theme").addEventListener("click", () => {
    localStorage.setItem("rctss-theme", document.body.classList.contains("light") ? "dark" : "light"); theme();
  });
  // A click on a park's header brings the same park (by key) to the top of the other column
  const twin = (from, key) => {
    const other = from.closest(".pane").id === "latest" ? document.getElementById("previous") : latest;
    const sec = other && [...other.querySelectorAll("section.park")].find(s => s.dataset.key === key);
    if (!sec || !document.body.classList.contains("compare")) return;
    sec.scrollIntoView({ block: "start" });
    sec.classList.add("flash"); setTimeout(() => sec.classList.remove("flash"), 900);
  };
  document.addEventListener("click", e => {
    if (e.target.closest("a.edit")) return;
    const h = e.target.closest("section.park header"); if (h) twin(h, h.parentNode.dataset.key);
  });
  // Served by the settings page: each park of the latest set opens in its view-drawing page
  if (window.DRAW) latest.querySelectorAll("section.park").forEach(sec => {
    if (!sec.dataset.key) return;
    const a = document.createElement("a");
    a.className = "edit"; a.target = "_blank"; a.textContent = "Edit views ↗";
    a.title = "Draw this park's views and set its event views (the drawing page, on the last build)";
    a.href = window.DRAW + encodeURIComponent(sec.dataset.key);
    sec.querySelector("header").prepend(a);
  });
  if (!prev || !prev.parks) return;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);
  const HAND = ' <span class="hand">manual</span>', HANDV = '<span class="hand">manual</span>';
  const pane = document.createElement("div");
  pane.id = "previous"; pane.className = "pane";
  pane.innerHTML = '<div class="inner"><div class="panehead">Previous render · built ' + esc(prev.built || "?") + ' · rendered ' +
    esc(prev.rendered || "?") + '</div>' + prev.parks.map((p, i) =>
      '<section class="park" data-key="' + esc(p.key || "") + '"><header><h2>' + (i + 1) + '. ' + esc(p.name) + (p.handSet ? HAND : "") + '</h2><div class="info">' +
      esc(p.info || "") + '</div></header><div class="views">' + (p.total && p.total.file ? '<figure><div class="shot"><img loading="lazy" src="' +
      prev.base + p.total.file + '?t=' + prev.token + '" alt="">' + (p.total.overlay || "") + '</div><figcaption>' + esc(p.total.caption || "route") +
      '</figcaption></figure>' : "") + p.views.map((f, k) => f ? '<figure><div class="shot"><img loading="lazy" src="' + prev.base + f +
      '?t=' + prev.token + '" alt="">' + ((p.overlays || [])[k] || "") + ((p.manual || [])[k] ? HANDV : "") + '</div><figcaption>' + esc((p.captions || [])[k] || "view " + (k + 1)) + '</figcaption></figure>' : "").join("") +
      '</div></section>').join("") + '</div>';
  latest.parentNode.appendChild(pane);
  const box = document.createElement("label");
  box.id = "compare";
  box.innerHTML = '<input type="checkbox"> Compare with the previous render <span class="info">(' + esc(prev.rendered || "") + ')</span>';
  const bar = document.querySelector(".top");
  bar.insertBefore(box, bar.querySelector(".legend") || document.getElementById("theme"));
  box.style.display = "flex";
  const input = box.querySelector("input");
  input.checked = localStorage.getItem("rctss-compare") === "1";
  const apply = () => { document.body.classList.toggle("compare", input.checked); localStorage.setItem("rctss-compare", input.checked ? "1" : "0"); };
  input.addEventListener("change", apply);
  apply();
})();
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("playlist", help="the .playlist.json written by mksequence.py")
    ap.add_argument("--openrct2", required=True, help="OpenRCT2 executable (on Windows openrct2.com or openrct2.exe)")
    ap.add_argument("-o", "--out", default="build/renders", help="output directory (default: build/renders)")
    ap.add_argument("--park", help="only parks whose name or file contains this text")
    ap.add_argument("--angles", action="store_true", help="also render each overview from all four angles")
    ap.add_argument("--size", default="1920x1080", help="screen size the views are judged at")
    ap.add_argument("--reuse", help="an earlier render set (folder): pictures it already has are copied, not rendered again")
    args = ap.parse_args()
    size = tuple(int(v) for v in args.size.lower().split("x"))
    with open(args.playlist, encoding="utf-8") as f:
        playlist = json.load(f)
    # Why each view was picked (mksequence.py writes it next to the playlist): ride pans are marked there
    try:
        with open(args.playlist[:-len(".playlist.json")] + ".scores.json", encoding="utf-8") as f:
            scores = {p["name"]: p["views"] for p in json.load(f)["parks"]}
    except (OSError, ValueError, KeyError):
        scores = {}
    seq_dir = os.path.join(os.path.dirname(os.path.abspath(args.playlist)), playlist["sequence"])
    os.makedirs(args.out, exist_ok=True)
    rows = []
    manifest = []
    failed = 0
    built = time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(args.playlist)))
    reuse = Reuse(args.reuse, args.out)
    for i, park in enumerate(playlist["parks"]):
        label = park.get("name") or park["fileName"]
        if args.park and args.park.lower() not in (label + park["fileName"]).lower():
            continue
        path = os.path.join(seq_dir, park["fileName"])
        park_hash = file_hash(path)
        rotation = saved_rotation(path)
        cells = []
        files = []
        captions, manual = [], []  # manual: views drawn by hand (badged)
        overlays = []
        angles = []
        for view in park["views"]:
            rotation = view.get("rotation", rotation)  # like the player: a view keeps the last angle
            angles.append(rotation)
        # The "total": every view's place and the route between them over one render (owner, 2026-11-01);
        # also the settings page's preview of the park
        total = None
        if park["views"]:
            frame, frame_rotation = total_frame(park["views"], angles, size)
            name = "%02d-total.png" % (i + 1)
            ok, command = reuse.render(args.openrct2, path, park_hash, name, frame, frame_rotation, size)
            failed += not ok
            caption = "Route: all %d view%s from the overview's angle (rot %d, zoom %d)" % (
                len(park["views"]), "" if len(park["views"]) == 1 else "s", frame_rotation, frame["zoom"])
            svg = route_overlay(park["views"], frame, frame_rotation, size)
            print("%s %s %s" % ("ok  " if ok else "FAIL", label, caption))
            total = {"file": name if ok else None, "overlay": svg, "caption": caption}
            cells.append('<figure><div class="shot"><img src="%s" alt="">%s</div><figcaption>%s</figcaption></figure>' % (
                name, svg, html.escape(caption)) if ok else '<figure><figcaption>%s<br>failed: %s</figcaption></figure>'
                % (html.escape(caption), html.escape(command)))
        for k, view in enumerate(park["views"]):
            rotation = angles[k]
            name = "%02d-v%d.png" % (i + 1, k + 1)
            ok, command = reuse.render(args.openrct2, path, park_hash, name, view, rotation, size)
            failed += not ok
            files.append(name if ok else None)
            pan = float(view.get("pan", 0) or 0)
            hold = float(view.get("hold", 0))
            why = scores[label][k].get("why") if k < len(scores.get(label, [])) else None
            flags = " \u00b7 ".join(f for f in (track_label(why), event_label(view)) if f)
            caption = "%d%s: (%s, %s, z %s) zoom %s, rot %d, %.1f s%s%s" % (
                k + 1, " overview" if view.get("overview") else "", view["x"], view["y"], view.get("z", 0),
                view.get("zoom", 0), rotation, hold,
                ", pan %d%% (%.1f s moving)" % (round(pan * 100), pan * hold) if pan else ", cut",
                " \u00b7 " + flags if flags else "")
            print("%s %s %s" % ("ok  " if ok else "FAIL", label, caption))
            captions.append(caption)
            manual.append(bool(park.get("handSet") and view.get("manual")))
            # Where the view's pan goes: the next view (the last one returns to the first)
            n = len(park["views"])
            svg = overlay(view, rotation, park["views"][(k + 1) % n], angles[(k + 1) % n], size) if n > 1 else ""
            overlays.append(svg)
            badge = HAND_BADGE if manual[-1] else ""
            cells.append('<figure><div class="shot"><img src="%s" alt="">%s%s</div><figcaption>%s</figcaption></figure>' % (
                name, svg, badge, html.escape(caption)) if ok else '<figure><figcaption>%s%s<br>failed: %s</figcaption></figure>'
                % (badge, html.escape(caption), html.escape(command)))
        if args.angles:
            overview = park["views"][0]
            for r in range(4):
                name = "%02d-angle%d.png" % (i + 1, r)
                ok, command = reuse.render(args.openrct2, path, park_hash, name, overview, r, size)
                failed += not ok
                caption = "overview from rotation %d" % r
                print("%s %s %s" % ("ok  " if ok else "FAIL", label, caption))
                cells.append('<figure><img src="%s" alt=""><figcaption>%s</figcaption></figure>' % (name, caption)
                             if ok else '<figure><figcaption>%s<br>failed: %s</figcaption></figure>'
                             % (caption, html.escape(command)))
        info = park_info(park)
        rows.append('<section class=park id="park%d" data-key="%s"><header><h2>%d. %s%s</h2><div class=info>%s</div></header>'
                    '<div class=views>%s</div></section>'
                    % (i + 1, html.escape(park.get("key") or ""), i + 1, html.escape(label), HAND_PARK if park.get("handSet") else "",
                       html.escape(info), "".join(cells)))
        manifest.append({"key": park.get("key"), "name": label, "anchor": "park%d" % (i + 1), "views": files,
                         "captions": captions, "overlays": overlays, "info": info, "total": total,
                         "handSet": bool(park.get("handSet")), "manual": manual,
                         "parkHash": park_hash, "viewsKey": views_key(park)})
    rendered = time.strftime("%Y-%m-%d %H:%M")
    with open(os.path.join(args.out, "index.html"), "w", encoding="utf-8") as f:
        f.write("<!doctype html><meta charset=utf-8><title>%s views</title><style>%s</style>"
                "<div class=top><div><h1>%s</h1><div class=info>built %s \u00b7 rendered %s \u00b7 %d park%s</div></div>"
                "<div class=grow></div>%s<button id=theme title='Switch between dark and light mode' aria-label='Switch between dark and light mode'>\u25d0</button></div>"
                "<div class=panes><main id=latest class=pane><div class=inner><div class=panehead>Latest render \u00b7 built %s \u00b7 rendered %s</div>%s</div></main></div><script>%s</script>"
                % (html.escape(playlist["sequence"]), PAGE_CSS, html.escape(playlist["sequence"]), built, rendered,
                   len(manifest), "" if len(manifest) == 1 else "s", LEGEND, built, rendered, "".join(rows), PAGE_JS))
    with open(os.path.join(args.out, "renders.json"), "w", encoding="utf-8") as f:
        # builtMtime: which build this set shows (the settings page notices a newer one)
        json.dump({"sequence": playlist["sequence"], "built": built, "builtMtime": os.path.getmtime(args.playlist),
                   "rendered": rendered, "parks": manifest, "images": reuse.made}, f, indent=1)
    print("wrote %s (%d rendered, %d unchanged and reused)" % (os.path.join(args.out, "index.html"), reuse.rendered, reuse.reused))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
