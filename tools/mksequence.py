"""Build an OpenRCT2 title sequence folder from a playlist file.

Usage: python3 tools/mksequence.py <playlist.toml> [-o OUTDIR] [--seed N]
                                   [--layout plugin|stock] [--install] [--user-dir DIR]

Writes OUTDIR/<name>/ (script.txt plus a copy of every park) and OUTDIR/<name>.playlist.json.
With --install, also copies the folder into OpenRCT2's user "sequence" directory, stores the
playlist in the plugin's shared storage (plugin.store.json), and copies the built plugin if
present. See playlists/example.toml for the playlist format. Every build also writes
OUTDIR/<name>.result.json; `--install-built OUTDIR/<name>.result.json` installs that build later
without building again (the settings page's Install, bundles that carry a build).

Views set in the plugin's view editor are kept in <playlist>.views.json next to the playlist:
--install first moves any edits saved in plugin.store.json for this playlist's parks into that
file. A park listed there plays those views exactly (no generation, no fitting), as long as one
of them was placed by hand or the list was rearranged (reordered, deleted from, holds changed);
generated views carried over unchanged are generated afresh. "Use playlist views" in the editor
(or deleting the park's entry) goes back to the playlist's views; views dropped from the editor
are kept in <playlist>.views.bak.json. --ignore-edits builds without the views file.

Parks' profiles (parks/*.toml, see tools/profiles.py) are merged under each park's playlist entry:
their fixes always, their extras (animation views, shows) when the playlist sets
park_plugins = true. --ignore-profiles builds without them.

Layouts:
  plugin  Each park is LOAD, its first view, then a long wait. The RCT Screensaver plugin
          drives views and park changes. Without the plugin this shows one view per park.
  stock   Every view is written as LOCATION/WAIT steps, for OpenRCT2 without the plugin.
"""
import argparse, collections, hashlib, json, pickle, math, statistics, os, random, re, shutil, subprocess, sys, tempfile, time, tomllib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import companions, parkinfo, profiles, userdata  # noqa: E402

VIEW_DEFAULTS = {
    "method": "spots",  # how views are generated when a park lists none: "spots" or "grid"
    "only": "all",      # "rides": keep only the overview and the ride pans (ride_pans), for test playlists
    "count": 8,         # maximum generated views per park, including the overview ("spots": the
                        # cap on the budget below; fewer when the park has fewer spots worth showing)
    "cell": 32,         # grid cell size in tiles at zoom 0 (roughly one screen); halves per zoom in
    "zoom_min": -2,     # "spots": closest zoom for close-ups
    "zoom_max": 1,      # "spots": widest zoom for close-ups
    "park_time": 30.0,  # "spots": seconds per park with up to base_views views
    "base_views": 4,    # "spots": views covered by park_time
    "view_time": 5.0,   # "spots": seconds added per view beyond base_views; the minimum per view
    "overview_time": 1.0,  # "spots": of each view_time added, seconds that go to the overview
    "budget_tiles": 256,  # "spots": view budget = base_views + log2(built tiles / budget_tiles),
                          # between base_views and count (256 tiles is about one zoom-0 screen)
    "min_score": 0.25,  # drop cells scoring below this fraction of the park's best cells
    "count_cap": 0.9,   # "spots": a tile counts at most as many elements as this quantile of tiles
    "layer_gap": 0.5,   # "spots": cells split into layers at empty height bands this tall (screens)
    "detail_span": 5,   # "spots": cells under 1/detail_span of the content's size are weighted down
    "activity": 0.5,    # "spots": share of a park's scoring weight that goes to rides, track and
                        # paths (the rest to static scenery), however few of them there are
    "grid_anchor": "content",  # "spots": cells and height windows start at the content's edge
                               # ("content") or at fixed multiples in map coordinates ("map"), and
                               # with "map" view anchors snap to quarter-cell steps
    "tie_margin": 0,    # "spots": candidates ranked within this share of the best are a tie, won by
                        # the larger share of ride, track and path weight (0: off; e.g. 0.05)
    "wide_limit": 0.5,  # "spots": on parks wider than a screen, no close-up whose cell is wider
                        # than this share of the content, which would be a second overview (0: off)
    "track_activity": "all",  # "spots": which track counts as active: "all", or "moving" (only
                              # rides with a vehicle moving in the saved park), or a number: the
                              # share of active weight the track of other rides keeps (e.g. 0.5;
                              # "moving" is 0), the rest counting as static
    "large_scenery": "tile",  # "spots": large scenery counts once per tile it covers ("tile") or
                              # once per object, its weight shared out over its tiles ("object")
    "aim": "spot",      # "spots": a close-up centres on its spot's weight ("spot") or on the
                        # weight not hidden from the angle it is seen from ("visible")
    "screen": [1920, 1080],  # "spots": window the views are framed for, in game pixels (tower fit, cell slicing,
                             # beads, ride overshoot): the one judged in, `window` below (2026-10-30; was 3840x2160)
    "fill_window": 2.0,  # "spots": the frame fills are measured over this multiple of `screen` (the 3840x2160 window
                         # the fill heuristics were tuned on: the surroundings count too, so a spot whose wider
                         # neighbourhood is void or the park's edge loses to one seen from inside)
    "window": [1920, 1080],  # game window the views and pan speeds were judged in, in game pixels (after
                             # OpenRCT2's scale factor: the owner's 4K monitor at 2.0); the plugin scales
                             # zooms and pan speeds from it to the window it plays in
    "fill_land": 0.3,   # "spots": how much a frame block of bare land or water counts against built content (1)
    "cover_share": 0.3,  # "spots": an element laid over this share of the map's tiles is backdrop, not content
    "floor_share": 0.5,  # "spots": a ground height over this share of the map, mostly unbuilt, is backdrop
    "water_depth": 24,  # "spots": elements under water up to this deep (height steps) are not seen
    "fill_min": 0.5,    # "spots": no close-up whose frame fill is below this (0: off)
    "fill_power": 2.0,  # "spots": candidates score times frame fill to this power (0: off)
    "hide_own": False,  # "spots": a spot's own elements in front of it don't count as hiding it
    "hide_weighted": False,  # "spots": hidden share measured by element weight, not count
    "falloff": "fixed",  # "spots": scores fall off near chosen views within a zoom-0 cell
                         # ("fixed") or within the larger of the two views' cells ("cell")
    "angle_repeat": 0.5,  # "spots": a spot shown again from another angle keeps this much score
    "overview_lead": 2.0,  # "spots": seconds the overview holds longer than any close-up
    "rotation": "auto", # "auto" ("spots": each close-up from the angle hiding least of it; else
                        # "cycle"), "cycle" (turn from the park's saved angle each view), "keep", 0-3
    "zoom": 0,          # "grid": -2 (closest) to 3; or "keep" for the park's saved zoom
    "hold": 10.0,       # seconds per view
    "pan": 0.0,         # share of each view's hold spent panning on to the next view (plugin layout;
                        # 0: held still, then a cut); a view can set its own. Generated views with
                        # pan_timing take their share from the pan's length instead (any pan > 0 turns it on).
                        # "auto": pan_timing on, and AUTO_PAN for listed and companion views
    "motion": "pans",   # "pans" or "static" (settings UI "Motion"): static holds every view still, then cuts,
                        # overviews included: no ride pans, beads or nudges (STATIC)
    "pan_timing": True,  # "spots": each generated view's moving time from its pan's length at route_speed
                         # of the tolerance, its still time from its score (pan_timing)
    "move_min": 2.0,    # "spots": shortest moving time of a timed pan, seconds
    "park_cap": 150.0,  # "spots": longest park, seconds; over it beads go first, then the lowest close-ups
                        # (owner, 2026-10-29: 120 kept every view on the examples, pacing good; +30 for the ride pans)
    "park_min": 30.0,   # "spots": shortest park, seconds: a shorter one's still times grow until it lasts this long
                        # (0: off); with park_cap, the settings UI's "Park duration"
    "time_scale": 1.0,  # every generated hold, pan and the plugin's change, arrival and return holds times this
                        # (settings UI "Time scaling"; above 1 is slower); park_min and park_cap are in scaled seconds.
                        # Event views (cues, shows) keep their time: the effect sets it
    "change_hold": 2.0,  # seconds the camera stays still after an angle or zoom change (plugin `changeHold`)
    "arrive_hold": 1.0,  # seconds a pan rests at the next spot before its angle or zoom changes (`arriveHold`)
    "return_hold": 2.0,  # seconds the camera holds at the first view after a park's return pan (`returnHold`)
    "return_pan": True,  # a park's last view pans back to its first (false: it cuts to the next park)
    "companion_pans": "run",  # "pause": the park's companion plugins hold their tick handlers while the camera
                              # moves (each companion's pause_during_pans; a profile's [companion.X] can still set it)
    "pan_changes": "end",  # a pan's angle and zoom change as it arrives ("end") or sets off ("start"); "off": a
                           # pan that changes them is a cut instead (the plugin decides; overviews keep their own)
    "inertia": False,   # pans start and stop slowly (cubic ease) instead of moving at one speed
    "overview_pan": 0.1,  # an overview's pan share (to the first close-up), whatever `pan` is
    "overview_pan_changes": "end",  # and its angle and zoom change on arrival
    "zoom_threshold": 0,  # screen px/s above which a pan travels zoomed out, at any zoom (0: the tolerance)
    "pan_tolerance": 500,  # fastest legible pan, screen px/s at zoom -2 (owner, 2026-10-28: 800 still
                           # legible on the speed ladder; 500 to be conservative)
    "pan_tolerance_step": 100,  # less per zoom level out (-1: 400, 0: 300, 1: 200; never under one step)
    "fit": True,        # plugin keeps views on the park's content (one centred view if it fits a screen)
    "route": "circuit",  # order of generated close-ups: "circuit" (a closed loop scored for travel
                         # time and shape, see circuit_order), "random" (the generator as it was before
                         # the circuit: the pick order and selection without RANDOM_OFF's steps; owner,
                         # 2026-10-29: "Circuit or Random pick order") or "picks" (the pick order alone)
    "events": True,      # views on companions' animations (cut-ins, waiting views, route stops) and shows when
                         # the park has them (`animations`, `show`, park_plugins); false leaves them all out, with no
                         # change to the other views (owner, 2026-10-31)
    "route_speed": 0.6,  # "circuit": share of the speed tolerance a pan is timed at
    "route_change": 3.0,  # "circuit": seconds a pan costs for an angle change, and per zoom level
    "districts": True,  # "spots": close-ups keep their district's home angle and zoom unless a
                        # change earns its place (district_views; the grouping is tools/districts.py's)
    "home_seen": 0.7,   # "districts": a close-up turns away from the home angle only when the home
                        # angle shows less than this share of its spot
    "home_gain": 0.25,  # "districts": and another angle shows at least this much more of it; a close-up
                        # keeps its own zoom only when its spot scores this much more there than at the home zoom
    "change_budget": 0.5,  # "districts": at most this share of a park's close-ups change angle or zoom
    "route_district": 6.0,  # "circuit": seconds a route costs for every return to a district it has left
    "nudge": 0.25,      # "spots": share of a close-up's cell its anchor may move to put the pans to and
                        # from it over content (nudge_pans; 0 leaves the picks where they are)
    "nudge_keep": 0.95, # "spots": a nudged view keeps at least this share of its own frame fill
    "path_samples": 9,  # "spots": windows sampled along a pan for its path fill
    "beads": True,      # "circuit": a pan longer than bead_seconds of travel gets a bead: an unpicked spot
                        # near its line as a pass-through view (plan: pan-based generation, phase 4)
    "bead_seconds": 8.0,  # "beads": longest pan without a bead, seconds at route_speed of the tolerance
    "bead_still": 1.0,  # "beads": seconds a bead rests before panning on
    "show_pan": 0.5,    # a show view's pan share: its camera path (parks/*.toml) moves for this share of
                        # the path's time, each leg at its scheduled start, then rests (0: as scheduled)
    "bead_pan": 0.8,    # "beads": a bead's pan share (its hold is bead_still / (1 - bead_pan))
    "bead_band": 0.25,  # "beads": how far off the pan's line a bead may sit, as a share of the screen's height
    "angle_weights": [1, 1, 1, 1],  # "spots" with rotation "auto": score factor per angle, counted from
                        # the park's saved one (0: never); a per-park bias (parks/*.toml), e.g. The Koi Pond
    "tower_views": 2,   # "spots": up to this many of a park's towers (districts.py: structures rising
                        # tower_rise steps above their surroundings), tallest first, get a view of their
                        # whole height when no close-up shows it (0: off)
    "tower_fit": 0.8,   # "tower_views": share of the screen's height a tower is zoomed to fill
    "tower_close": 1,   # "tower_views": zoom levels closer than that fit the view then goes (owner, 2026-10-30:
                        # at the fit the towers looked a level too far); a tower taller than the window is then
                        # framed with its top tower_top of the window's height under the frame's top
    "tower_top": 0.15,
    "ride_pans": 1,     # "spots": up to this many pairs of views per park whose pan follows a long ride
    "ride_tiles": 24,   # "ride_pans": a ride needs this many track tiles (with a moving vehicle)
    "ride_run": 20,     # "ride_pans": shortest run worth following, tiles between its ends
    "ride_band": 4,     # "ride_pans": the track path between its ends keeps within this many tiles of the line
    "ride_detour": 1.5,  # "ride_pans": and is at most this times as long as the line (a coaster weaves)
    "ride_fill": 0.85,  # "ride_pans": least frame fill along the run (from the chosen angle); a railway along
                        # the park's edge filled 0.82, the owner's good picks 0.87-0.97 (2026-10-29)
    "ride_visible": 0.2,  # "ride_pans": least share of the run's track not hidden behind what stands in front
                          # of it; a dark ride or tunnel shows nothing, a coaster through theming 0.3-0.5
                          # (Constellations, Sambhava: good views by the owner; what is built over a tile's
                          # track does not count, as theming over a coaster hides little of it)
    "ride_float": 96,   # "ride_pans": track this far (world units, 12 steps) above everything within 2 tiles floats
    "ride_floating": 0.25,  # "ride_pans": a run floating over this share of its length is not followed (Troubadours'
                            # sky-level tracks 0.45-0.53; real coasters 0-0.23 on the examples)
    "ride_heading": 10,  # "ride_pans": a train's heading on the run counts this many track pieces for its direction
    "ride_zoom": -1,    # "ride_pans": zoom of the pair of views
    "ride_status": "open",  # "ride_pans": only rides with this status ("open"; "any" takes testing and closed
                            # rides whose trains move too: props with a train, mostly)
    "ride_edge": 1.0,   # "ride_pans": most of a window that may lie outside the content box, at the run's
                        # ends and along it (the box projected at the view's angle; a run near the park's
                        # edge shows the void or the land beyond); 1 = no limit
    "ride_void": 1.0,   # "ride_pans": most of a window that may show the void (beyond the map, the backdrop,
                        # earth walls), at the ends and along the run; 1 = no limit
    "ride_tries": 40,   # "ride_pans": runs of a ride judged (longest first) before giving up on it
    "ride_overshoot": 0.2,  # "ride_pans": the end view is pulled back along the run by this share of the window's
                            # width, so the pan stops before it runs past the track's end
    "circuit_variants": 1,  # "circuit": orders written per park, the cheapest first; the plugin plays a
                            # different one on each visit
    "variant_margin": 0.1,  # "circuit": an alternative order may cost this share more than the cheapest
    "circuit_reverse": False,  # "circuit": each order's reverse is a variant too
    "tower_fill": 0,    # "tower_views": no tower view whose frame fill (at its best angle) is below this
                        # (0: off; a tall tower's frame is mostly sky, 0.2-0.4 on the examples)
}
# route = "random": the pan-based generation steps that came with or after the circuit (phases
# 3-6: district homing, tower views, nudges, beads, timing from pan length, ride pans) are off, so
# the views are the earlier generator's, in its pick order (score / (1 + views at the zoom level),
# which varies angle and zoom from one view to the next). Event views come on top as in any order.
STATIC = {"pan": 0.0, "overview_pan": 0.0, "ride_pans": 0, "beads": False, "nudge": 0}  # motion = "static": nothing pans, so no
# ride pans, beads (pass-through views on long pans) or nudges (anchors moved for the pans' path fill)
AUTO_PAN = 0.6  # pan = "auto": the share of views pan_timing does not time (listed views, companion views)
RANDOM_OFF = {"districts": False, "tower_views": 0, "nudge": 0, "beads": False, "pan_timing": False, "ride_pans": 0}
LAYOUTS = ("plugin", "stock")
MAX_LOCATION = 255   # title sequence LOCATION stores tile coordinates in 8 bits
MAX_WAIT_MS = 65535  # WAIT stores milliseconds in 16 bits
PLUGIN_PARK_WAIT_MS = 4 * 60 * 60 * 1000  # plugin layout: built-in player idles this long per park
ANIMATION_VIEWS = 4  # `animations = true`: at most this many views per park (`animation_views`)
CUE_WAIT = 30.0  # an animation view with a cue waits at most this long past its hold for it (`cue_wait`)
CUE_HOLD = 5.0  # and its hold, the least it plays: the effect deciding the rest (`cue_hold`)
CUE_MOVE = 4.0  # with `pan` > 0, seconds it pans on to the next view after the effect (`cue_move`)
PAN_CHANGES = ("start", "end", "off")  # [views] pan_changes ("off": the plugin cuts where a pan would change them)
TITLE_MUSIC = ("keep", "ride", "theme", "off")  # a playlist's title_music (settings UI "Ride music as title music")
TITLES = ("overview", "on", "off")  # a playlist's titles (settings UI "Show titles"): the park name captions
STORE_NAMESPACE = "RCTScreensaver"        # plugin shared storage namespace
OVERVIEW_SCREEN = (1920, 1080)  # window assumed for the overview's zoom in script.txt
MAX_ZOOM = 3
BOUNDS_TRIM = 0.01  # ignore this fraction of elements on each side when measuring a park's extent
PLUGIN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin", "dist",
                           "rct-screensaver.js")
ICONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin", "icons")


def screen_extent(bounds, rotation):
    """Screen-space (x, y) ranges of the content box at a rotation, as the plugin's fit.ts."""
    xs, ys = [], []
    for h in (bounds["z0"], bounds["z1"]):
        for x, y in ((bounds["x0"], bounds["y0"]), (bounds["x1"] + 1, bounds["y0"]),
                     (bounds["x0"], bounds["y1"] + 1), (bounds["x1"] + 1, bounds["y1"] + 1)):
            a, b = [(x, y), (y, -x), (-x, -y), (-y, x)][rotation & 3]
            xs.append((b - a) * 32)
            ys.append((a + b) * 16 - h)
    return (min(xs), max(xs)), (min(ys), max(ys))


def fill_screen(opts):
    """The window the frame fills are measured over: `screen` times `fill_window` (see VIEW_DEFAULTS)."""
    return tuple(int(round(int(n) * float(opts["fill_window"]))) for n in opts["screen"])


def fit_zoom(extent, screen):
    (x0, x1), (y0, y1) = extent
    for zoom in range(-2, MAX_ZOOM + 1):
        if x1 - x0 <= screen[0] * 2 ** zoom and y1 - y0 <= screen[1] * 2 ** zoom:
            return zoom
    return MAX_ZOOM


def overview_zoom(bounds, rotation, screen=OVERVIEW_SCREEN):
    """Closest zoom at which the content box fits on the screen. A small park (its footprint,
    heights left out, fits at zoom 0 or closer) is shown no wider than zoom 0, so a tall build
    on it is not seen from far away. Mirrors the plugin's fitOverview."""
    flat = {**bounds, "z1": bounds["z0"]}
    full = fit_zoom(screen_extent(bounds, rotation), screen)
    return min(full, 0) if fit_zoom(screen_extent(flat, rotation), screen) <= 0 else full


def outside_content(view, bounds):
    """Whether a view's centre is off the content box on screen (at the view's angle)."""
    (x0, x1), (y0, y1) = screen_extent(bounds, view["rotation"])
    x, y = view["x"] + 0.5, view["y"] + 0.5
    a, b = [(x, y), (y, -x), (-x, -y), (-y, x)][view["rotation"] & 3]
    sx, sy = (b - a) * 32, (a + b) * 16 - view["z"]
    return not (x0 <= sx <= x1 and y0 <= sy <= y1)


def spot_holds(views, scores, opts):
    """Hold times for an overview plus close-ups: park_time for up to base_views views, plus
    view_time per view beyond that (overview_time of it to the overview). Every view gets at
    least view_time; what is left goes to the close-ups in proportion to their scores, except
    that the overview always holds overview_lead longer than any close-up (taking the time from
    the close-ups' shares). Returns the park's total."""
    n = len(views)
    extra = max(0, n - int(opts["base_views"]))
    minimum = float(opts["view_time"])
    total = max(float(opts["park_time"]) + extra * minimum, n * minimum)
    if n == 1:
        views[0]["hold"] = total
        return total
    overview = minimum + extra * float(opts["overview_time"])
    rest = max(0.0, total - overview - (n - 1) * minimum)
    weight = sum(scores) or 1
    top = max(scores) / weight
    # overview = total - (n - 1) * minimum - rest must be >= minimum + rest * top + lead.
    rest = max(0.0, min(rest, (total - n * minimum - float(opts["overview_lead"])) / (1 + top)))
    views[0]["hold"] = round(total - (n - 1) * minimum - rest, 1)
    for view, score in zip(views[1:], scores):
        view["hold"] = round(minimum + rest * score / weight, 1)
    return round(sum(v["hold"] for v in views), 1)


FRONT = [(1, 1), (-1, 1), (-1, -1), (1, -1)]  # tile step toward the camera, per rotation
ACTIVE_TYPES = {1, 2, 4}  # path, track, entrance (TILE_TYPES): where guests and rides move
STILL_TRACK = 8  # element type given to track of rides with no moving vehicle (static, past TILE_TYPES)
HEIGHT_PER_TILE = 16  # screen pixels of height difference that count as one tile apart


def still_track(heights, rides, vehicles, keep=0):
    """Count the track of rides with no vehicle moving (in the saved park) as static scenery,
    all but `keep` of it: track used as decoration, or a ride standing still, looks no busier
    than a wall. Rides whose vehicles move keep all their track active, however long it is."""
    moving = {v[3] for v in vehicles if v[4]}
    still = Piece(STILL_TRACK, 1, keep)
    for (x, y), entry in heights.items():
        entry[2] = [(base, clear, still if kind == 2 and rides.get((x, y, base), -1) not in moving else kind)
                    for base, clear, kind in entry[2]]


class Piece(int):
    """An element type with a share of an element's weight (a large scenery tile counting
    1 / its object's tile count) and of it the part that counts as active (track of a ride
    standing still). Compares as its type, so type checks are unchanged."""
    def __new__(cls, kind, share, active=None):
        piece = super().__new__(cls, kind)
        piece.share = share
        piece.active = active
        return piece


def share(kind):
    return getattr(kind, "share", 1)


def activeness(kind):
    """The part of an element's weight that counts as active: 1 for ACTIVE_TYPES, else 0."""
    active = getattr(kind, "active", None)
    return (1 if kind in ACTIVE_TYPES else 0) if active is None else active


def split(kind):
    """An element's (active, static) counts."""
    a = activeness(kind)
    return a, (1 - a) * share(kind)


def large_scenery_once(heights, pieces):
    """Count each large scenery object once, however many tiles it covers: every tile gets
    1 / (the object's piece count) of an element's weight, so a big building weighs no more
    than a small one and does not outscore the rides by size alone."""
    tiles = {}  # object entry index -> pieces, from the highest piece index seen in the park
    for entry, piece in pieces.values():
        tiles[entry] = max(tiles.get(entry, 1), piece + 1)
    for (x, y), entry in heights.items():
        entry[2] = [(base, clear, Piece(kind, 1 / tiles[pieces[(x, y, base)][0]])
                     if kind == 6 and (x, y, base) in pieces else kind)
                    for base, clear, kind in entry[2]]


def tile_top(tile, heights, surface):
    """World height of the top of whatever is on a tile, ground included."""
    x, y = tile
    ground = surface[y * 1001 + x] if 0 <= x < 1001 and 0 <= y < 1001 else 0
    return max(ground, heights[tile][1] if tile in heights else 0) * 8


def covers(tile, h, heights, surface, own=None):
    """Whether something on a tile occupies world height h: the ground, or an element. With
    own = (tiles, lo, hi), a spot's own elements (on its tiles, base heights lo..hi) don't count:
    what stands in front of a spot's content but belongs to the spot is what its view shows."""
    x, y = tile
    if 0 <= x < 1001 and 0 <= y < 1001 and surface[y * 1001 + x] * 8 > h:
        return True
    if tile not in heights:
        return False
    mine = own is not None and tile in own[0]
    return any(base * 8 <= h < clear * 8 and not (mine and own[1] <= base <= own[2])
               for base, clear, _ in heights[tile][2])


def hidden_tile(tile, top, rotation, heights, surface, max_top, cache, own=None):
    """Whether the content on a tile up to world height `top` is hidden at a rotation: a tile k
    steps nearer the camera, in the same screen column, is drawn 32 * k units lower, so whatever
    it holds at height top + 32 * k covers that top on screen. (Something floating higher above
    the front tile, like a lid, doesn't.) `own` and the cache are per spot, see covers."""
    key = (tile, top, rotation)
    if key not in cache:
        fx, fy = FRONT[rotation & 3]
        x, y = tile
        cache[key] = any(covers((x + fx * k, y + fy * k), top + 32 * k, heights, surface, own)
                         for k in range(1, (max_top - top) // 32 + 1))
    return cache[key]


FILL_BLOCK = 32  # zoom-0 screen pixels per frame-fill raster block (half a tile's width)


def map_floor(heights, surface, water, size, opts):
    """What a park uses as its backdrop, so the frame fill can count it as void: the ground
    height that covers at least floor_share of the map with nothing built on at least half of
    its tiles (parks on a plateau above a black lowland), or None, and the element signatures
    (base, clearance, type) that cover at least cover_share of the map's tiles (a flat black
    block laid over the unused map). Elements under water (up to water_depth steps deep) are
    not seen either. Returns (floor height, cover signatures)."""
    w, h = size
    tiles = max(1, (w - 2) * (h - 2))
    signatures = collections.Counter()
    for (x, y), (_, _, elements) in heights.items():
        if 1 <= x < w - 1 and 1 <= y < h - 1:
            signatures.update(set(elements))
    cover = {sig for sig, n in signatures.items() if n >= float(opts["cover_share"]) * tiles}
    depth = int(opts["water_depth"])

    def shown(tile):
        """The tile's visible elements: not backdrop cover, not under water."""
        if tile not in heights:
            return []
        level, ground = water[tile[1] * 1001 + tile[0]], surface[tile[1] * 1001 + tile[0]]
        hidden = level if ground < level <= ground + depth else 0
        return [e for e in heights[tile][2] if e not in cover and e[1] > hidden]

    grounds = collections.Counter(surface[y * 1001 + x] for y in range(1, h - 1) for x in range(1, w - 1))
    floor = None
    if grounds:
        height, n = grounds.most_common(1)[0]
        if n >= float(opts["floor_share"]) * tiles:
            empty = sum(1 for y in range(1, h - 1) for x in range(1, w - 1)
                        if surface[y * 1001 + x] == height and not shown((x, y)))
            if empty * 2 >= n:
                floor = height
    return floor, cover, shown


def frame_rasters(heights, surface, water, size, opts):
    """Per rotation, what each block of the screen shows when the whole map is drawn at that
    angle, painted back to front like the game does: built content (a visible element, over
    its own height span, so a kite in the sky is not a tower), bare land or water, or nothing: the void beyond the
    map, the map's backdrop (see map_floor) and the earth walls under terrain drops facing
    the camera and under the map's edge, which hide what stands behind them. Returns per
    rotation (origin bx, origin by, columns, rows, content table, land table): summed-area
    tables over blocks of FILL_BLOCK zoom-0 pixels, so frame_fill counts a window's blocks in
    constant time. size is the map size, border included."""
    w, h = size
    B = FILL_BLOCK
    floor, cover, shown = map_floor(heights, surface, water, size, opts)
    out = {}
    for r in range(4):
        fx, fy = FRONT[r]
        front = ((fx, fy), (fx, 0), (0, fy))
        blocks = {}  # (bx, by) -> 0 wall or backdrop, 1 land, 2 content; the void unmarked
        tiles = sorted(((((x, y), (y, -x), (-x, -y), (-y, x))[r], x, y)
                        for y in range(1, h - 1) for x in range(1, w - 1)), key=lambda t: t[0][0] + t[0][1])
        for (a, b), x, y in tiles:  # far to near
            bx = (b - a) * 32 // B
            ground = surface[y * 1001 + x]
            seen = max(ground, water[y * 1001 + x])  # the water's surface where there is water
            sy = (a + b) * 16 - seen * 8
            by = sy // B
            cols = (bx - 1, bx, bx + 1)
            backdrop = ground == floor and seen == ground
            for col in cols:
                blocks[(col, by)] = 0 if backdrop else 1
            # The wall under the tile, down to the lowest neighbour in front (the map's edge
            # drops to height 0), hides whatever stood behind it.
            bottom = by + 1
            for dx, dy in front:
                nx, ny = x + dx, y + dy
                if 1 <= nx < w - 1 and 1 <= ny < h - 1:
                    level = max(surface[ny * 1001 + nx], water[ny * 1001 + nx])
                    bottom = max(bottom, ((a + b) * 16 + (abs(dx) + abs(dy)) * 16 - level * 8) // B)
                else:
                    bottom = max(bottom, ((a + b) * 16 + (abs(dx) + abs(dy)) * 16) // B)
            for col in cols:
                for row in range(by + 1, bottom):
                    blocks[(col, row)] = 0
            for base, clear, _ in shown((x, y)):  # each element over its own height span
                for col in cols:
                    for row in range(((a + b) * 16 - clear * 8) // B, ((a + b) * 16 - base * 8) // B + 1):
                        blocks[(col, row)] = 2
        if not blocks:
            out[r] = (0, 0, 0, 0, [[0]], [[0]])
            continue
        bx0 = min(k[0] for k in blocks)
        by0 = min(k[1] for k in blocks)
        cols = max(k[0] for k in blocks) - bx0 + 1
        rows = max(k[1] for k in blocks) - by0 + 1
        tables = [[[0] * (cols + 1) for _ in range(rows + 1)] for _ in range(2)]
        for row in range(rows):
            runs = [0, 0]
            for col in range(cols):
                v = blocks.get((bx0 + col, by0 + row), 0)
                if v:
                    runs[v - 1] += 1
                for t, run in zip(tables, runs):
                    t[row + 1][col + 1] = t[row][col + 1] + run
        out[r] = (bx0, by0, cols, rows, tables[1], tables[0])
    return out


def frame_fill(rasters, rotation, x, y, z, zoom, screen, land=0.3):
    """Share of a window centred on world point (x, y in tiles, z world height) at a zoom and
    rotation that shows built content, a block of bare land or water counting `land` of a
    content block and the void, backdrop and earth walls nothing (see frame_rasters)."""
    bx0, by0, cols, rows, content, bare = rasters[rotation & 3]
    a, b = ((x, y), (y, -x), (-x, -y), (-y, x))[rotation & 3]
    cx, cy = (b - a) * 32, (a + b) * 16 - z
    hw, hh = screen[0] * 2 ** zoom / 2, screen[1] * 2 ** zoom / 2
    B = FILL_BLOCK
    c0, c1 = math.floor((cx - hw) / B) - bx0, math.floor((cx + hw) / B) - bx0 + 1
    r0, r1 = math.floor((cy - hh) / B) - by0, math.floor((cy + hh) / B) - by0 + 1
    total = (c1 - c0) * (r1 - r0)
    c0, c1 = max(0, min(cols, c0)), max(0, min(cols, c1))
    r0, r1 = max(0, min(rows, r0)), max(0, min(rows, r1))
    if c1 <= c0 or r1 <= r0:
        return 0.0

    def area(t):
        return t[r1][c1] - t[r0][c1] - t[r1][c0] + t[r0][c0]

    return (area(content) + land * area(bare)) / total


def frame_void(rasters, rotation, x, y, z, zoom, screen):
    """Share of a window (as frame_fill) that shows neither content nor bare land or water: the
    void beyond the map, the backdrop and the earth walls under terrain drops."""
    bx0, by0, cols, rows, content, bare = rasters[rotation & 3]
    a, b = ((x, y), (y, -x), (-x, -y), (-y, x))[rotation & 3]
    cx, cy = (b - a) * 32, (a + b) * 16 - z
    hw, hh = screen[0] * 2 ** zoom / 2, screen[1] * 2 ** zoom / 2
    B = FILL_BLOCK
    c0, c1 = math.floor((cx - hw) / B) - bx0, math.floor((cx + hw) / B) - bx0 + 1
    r0, r1 = math.floor((cy - hh) / B) - by0, math.floor((cy + hh) / B) - by0 + 1
    total = (c1 - c0) * (r1 - r0)
    c0, c1 = max(0, min(cols, c0)), max(0, min(cols, c1))
    r0, r1 = max(0, min(rows, r0)), max(0, min(rows, r1))
    if c1 <= c0 or r1 <= r0:
        return 1.0

    def area(t):
        return t[r1][c1] - t[r0][c1] - t[r1][c0] + t[r0][c0]

    return 1 - (area(content) + area(bare)) / total


def cell_layers(tiles, heights, gap_steps, window_steps, fixed=False):
    """A cell's elements by height: split where their base heights leave an empty band of more
    than gap_steps height steps, and a part taller than window_steps (a screen at the cell's
    zoom) sliced into windows that tall, half a window apart, so a tall scene offers a spot per
    screen of height. Returns [{tile: (static, active, top, static base sum, active base
    sum)}, (lowest base, highest base))], active counting ACTIVE_TYPES elements (see activeness), tops in world
    height and bases in height steps."""
    elements = sorted((base, clear, t, kind) for t in tiles for base, clear, kind in heights[t][2])
    layers, current, reach = [], [], None  # reach: highest top so far in the current layer
    for element in elements:
        if reach is not None and element[0] - reach > gap_steps:
            layers.append(current)
            current, reach = [], None
        current.append(element)
        reach = element[1] if reach is None else max(reach, element[1])
    layers.append(current)
    parts = []
    for layer in layers:
        lo, hi = layer[0][0], max(e[1] for e in layer)
        if hi - lo <= window_steps:
            parts.append(layer)
            continue
        # Windows half a screen apart, from the layer's base or (fixed) from fixed heights.
        start = lo - lo % (window_steps / 2) if fixed else lo
        while True:
            parts.append([e for e in layer if start <= e[0] < start + window_steps])
            if start + window_steps >= hi:
                break
            start += window_steps / 2
    out = []
    for part in parts:
        per = {}
        for base, clear, t, kind in part:
            static, active, top, ss, sa = per.get(t, (0, 0, 0, 0, 0))
            a, st = split(kind)
            active, sa = active + a, sa + base * a
            static, ss = static + st, ss + base * st
            per[t] = (static, active, max(top, clear * 8), ss, sa)
        if per:
            out.append((per, (min(e[0] for e in part), max(e[0] for e in part))))
    return out


def spot_pool(counts, heights, surface, opts, water=None, map_wh=None):
    """The candidates spot_views picks from: the overview, and per zoom level every spot seen
    from each angle, scored (see spot_views). Returns None for a park with no content. water
    (parkinfo.water_heights) and map_wh (the map size) serve the frame fill; without them no
    water is assumed and the map is taken to reach the furthest built or raised tile."""
    bounds = content_bounds(counts, heights, surface)
    if not bounds:
        return None
    if water is None:
        water = bytearray(1001 * 1001)
    if map_wh is None:
        far = max(max(max(x, y) for x, y in heights), max((i % 1001 for i in range(1001 * 1001) if surface[i]), default=0),
                  max((i // 1001 for i in range(1001 * 1001) if surface[i]), default=0))
        map_wh = (far + 2, far + 2)
    views = [{"x": round(bounds["cx"] - 0.5), "y": round(bounds["cy"] - 0.5), "z": bounds["zm"],
              "zoom": overview_zoom(bounds, 0), "overview": True}]
    inside = {t: n for t, n in counts.items()
              if bounds["x0"] <= t[0] <= bounds["x1"] and bounds["y0"] <= t[1] <= bounds["y1"]}
    detailed = {t: n for t, n in inside.items() if n >= 2} or inside
    # Element weights: rides, track and paths (active) make up `activity` of the park's total
    # weight and static scenery the rest, so moving scenes count for more than their numbers.
    activity = float(opts["activity"])
    elements_all = [split(kind) for t in detailed for _, _, kind in heights[t][2]]
    active_share = sum(a for a, _ in elements_all) / (sum(a + st for a, st in elements_all) or 1)
    if 0 < active_share < 1:
        w_static, w_active = (1 - activity) / (1 - active_share), activity / active_share
    else:
        w_static = w_active = 1.0
    tile_weights = sorted(sum(a * w_active + st * w_static for a, st in map(split, (e[2] for e in heights[t][2])))
                          for t in detailed)
    cap = tile_weights[min(len(tile_weights) - 1, int(len(tile_weights) * float(opts["count_cap"])))]
    min_x = min(x for x, _ in detailed)
    min_y = min(y for _, y in detailed)
    base_cell = int(opts["cell"])
    size = max(bounds["x1"] - bounds["x0"], bounds["y1"] - bounds["y0"]) + 1
    overview_zoom_ = views[0]["zoom"]
    saved = opts.get("saved_rotation", 0)
    auto = opts["rotation"] == "auto"
    max_top = max((tile_top(t, heights, surface) for t in heights), default=0)
    hide_own = bool(opts["hide_own"])
    hide_weighted = bool(opts["hide_weighted"])
    falloff_by_cell = opts["falloff"] == "cell"
    fixed = opts["grid_anchor"] == "map"
    if fixed:
        min_x = min_y = 0
    wide_limit = float(opts["wide_limit"]) if overview_zoom_ > 0 else 0
    tie_margin = float(opts["tie_margin"])
    aim_visible = opts["aim"] == "visible"
    screen = fill_screen(opts)  # the fill window (fill_window × the screen)
    fill_land, fill_min, fill_power = (float(opts[k]) for k in ("fill_land", "fill_min", "fill_power"))
    rasters = frame_rasters(heights, surface, water, map_wh, opts) if fill_min or fill_power else None
    # Diagnostics (tools/viewstability.py): each spot's score scaled by a fixed random factor,
    # standing in for a small change to the scoring.
    jitter, jitter_seed = float(opts.get("jitter", 0)), opts.get("jitter_seed", 0)
    levels = {}  # zoom -> [score, x, y, z, cell, rotation, spot score, seen, active, spot (x, y, z), fill]
    for zoom in range(int(opts["zoom_min"]), int(opts["zoom_max"]) + 1):
        if zoom >= overview_zoom_:
            continue  # no wider than the overview: that is what it shows
        cell = max(1, round(base_cell * 2 ** zoom))
        if wide_limit and cell > wide_limit * size:
            continue  # wide enough to be a second overview
        grids = {}
        for offset in sorted({0, cell // 2}):
            for (x, y) in detailed:
                key = (offset, (x - min_x + offset) // cell, (y - min_y + offset) // cell)
                grids.setdefault(key, []).append((x, y))
        screen_steps = OVERVIEW_SCREEN[1] * 2 ** zoom / 8  # a screen's height in height steps
        spots = []
        for tiles in grids.values():
            for layer, (lo, hi) in cell_layers(tiles, heights, screen_steps * float(opts["layer_gap"]),
                                               screen_steps, fixed):
                weights = {t: s * w_static + a * w_active for t, (s, a, _, _, _) in layer.items()}
                total = sum(min(w, cap) for w in weights.values())
                weight = sum(weights.values())
                score = total * len(layer) / (cell * cell)
                # Anchored where the weight is, so a view leans toward the rides in it.
                x = sum(t[0] * w for t, w in weights.items()) / weight
                y = sum(t[1] * w for t, w in weights.items()) / weight
                z = sum(ss * w_static + sa * w_active for _, _, _, ss, sa in layer.values()) / weight * 8
                if fixed:  # snapped, so a small change in weights leaves the view where it was
                    step = max(1, cell / 4)
                    x, y = round(x / step) * step, round(y / step) * step
                    z = round(z / (screen_steps * 2)) * screen_steps * 2  # a quarter screen, world units
                if jitter:
                    key = "%s:%d:%d:%d:%d" % (jitter_seed, zoom, round(x), round(y), round(z / 64))
                    score *= 1 + jitter * (2 * random.Random(key).random() - 1)
                active = sum(a * w_active for _, a, _, _, _ in layer.values()) / weight
                spots.append((score, x, y, z, layer, weight, (set(layer), lo, hi), active))
        if not spots:
            continue
        best = sorted((s[0] for s in spots), reverse=True)
        reference = statistics.median(best[:max(1, len(best) // 4)])  # of the best quarter
        candidates = []
        for score, x, y, z, layer, weight, own, active in spots:
            score /= reference
            if score < float(opts["min_score"]):
                continue
            cache = {}
            for r in range(4) if auto else [None]:
                bias = angle_weight(r, opts) if auto else 1.0
                if bias <= 0:
                    continue
                seen = 1.0
                if auto:  # the share of the spot's weight not hidden by what stands in front
                    hidden = sum(s * w_static + a * w_active if hide_weighted else s + a
                                 for t, (s, a, t_top, _, _) in layer.items()
                                 if hidden_tile(t, t_top, r, heights, surface, max_top, cache, own if hide_own else None))
                    seen = 1 - hidden / (weight if hide_weighted else sum(v[0] + v[1] for v in layer.values()))
                ax, ay, az = x, y, z
                if auto and aim_visible and 0 < seen < 1:  # centred on what this angle shows
                    shown = {t: v for t, v in layer.items()
                             if not hidden_tile(t, v[2], r, heights, surface, max_top, cache, own if hide_own else None)}
                    w = {t: st * w_static + a * w_active for t, (st, a, _, _, _) in shown.items()}
                    total_w = sum(w.values())
                    if total_w:
                        ax = sum(t[0] * v for t, v in w.items()) / total_w
                        ay = sum(t[1] * v for t, v in w.items()) / total_w
                        az = sum(ss * w_static + sa * w_active for _, _, _, ss, sa in shown.values()) / total_w * 8
                        if fixed:
                            step = max(1, cell / 4)
                            ax, ay = round(ax / step) * step, round(ay / step) * step
                            az = round(az / (screen_steps * 2)) * screen_steps * 2
                # How much of the window shows built content from here (see frame_fill): a
                # spot at the map's edge, seen with the void or a cliff wall filling half
                # the screen, loses to one seen from inside the park.
                fill = 1.0
                if rasters:
                    fill = frame_fill(rasters, saved if r is None else r, ax, ay, az, zoom, screen, fill_land)
                    if fill < fill_min:
                        continue
                candidates.append([score * seen * bias, ax, ay, az, cell, r, score, seen, active, (x, y, z), fill])
        if rasters and candidates:
            # Relative to the zoom level's own best quarter, as the spot scores are: a wide
            # window always holds more void than a close one, and the fill must not pull every
            # view to the closest zoom.
            fills = sorted((c[10] for c in candidates), reverse=True)
            fill_reference = statistics.median(fills[:max(1, len(fills) // 4)]) or 1.0
            for c in candidates:
                c[0] *= min(1.0, c[10] / fill_reference) ** fill_power
        levels[zoom] = candidates
    return {"bounds": bounds, "views": views, "detailed": detailed, "size": size, "levels": levels,
            "saved": saved, "auto": auto, "base_cell": base_cell, "falloff_by_cell": falloff_by_cell,
            "tie_margin": tie_margin, "overview_zoom": overview_zoom_, "rasters": rasters}


def spot_views(counts, heights, surface, opts, pool=None, water=None, map_wh=None):
    """An overview of the whole park, then close-ups of its busiest spots at varying zoom,
    by one rule for every park size.

    Spots are grid cells at every size from zoom_min to zoom_max closer than the overview (the
    cell size halves per zoom level in), on two grids offset by half a cell each way so content
    near a cell edge is not split, over the tiles inside the content box with 2+ elements. A
    cell whose elements leave an empty band of height (layer_gap of a screen at that zoom), like
    a scene under a suspended lid, is split into layers, each its own spot. A spot scores its
    element count (each tile counting at most the count_cap quantile of tiles, so one stacked
    tower doesn't outweigh a district) times the fraction of its tiles that hold anything,
    times an activity factor (its share of path, track and entrance elements against the park's,
    so moving scenes beat static scenery; see `activity`), relative to the median of the best
    quarter of its zoom level's spots; spots below min_score are not worth a view.

    Candidates are a spot seen from an angle, scored by the spot's score times the share of its
    elements not hidden behind taller tiles in front (by weight with hide_weighted; not counting
    the spot's own elements with hide_own) (rotation "auto"; otherwise one candidate,
    turned by "cycle"), times (to the power fill_power) the frame fill: the share of a `screen`
    window centred on it that shows built content when the map is painted from that angle,
    relative to the median of the best quarter of its zoom level's candidates (a wide window
    always holds more void than a close one)
    (frame_rasters: bare land and water count fill_land of built content; the void, the map's
    backdrop and cliff walls nothing), so a spot at the map's edge is seen from inside the
    park rather than with the void or a cliff wall filling half the screen; a candidate under
    fill_min is not worth a view. They are picked by score divided by 1 + the views their zoom level
    already has, so zoom levels take turns softly, and weighted down when their cell is small
    next to the content (detail_span), so large parks rarely get tiny details. A park gets up
    to its view budget: base_views, plus one per doubling of its built tiles beyond
    budget_tiles, at most count. Spacing, in tiles with height differences
    counted as HEIGHT_PER_TILE screen pixels per tile: from the same angle, a spot closer to a
    chosen view than half the larger of the two cells (at most a quarter of the content's size)
    is culled, and its score goes to the nearest close-up's hold; from another angle, the same
    spot keeps up to angle_repeat of its score, must still reach min_score, and is taken only
    while the park has fewer than base_views views. Within one zoom-0 cell of a chosen view (with
    falloff "cell": the larger of the two views' cells) a score is scaled down with the distance. The overview (park's saved angle, centred where the
    elements are) only rules out whole-box spots from its own angle.

    The plugin zooms the overview to fit the window at run time; the zoom stored here assumes
    1920x1080. Holds are set by spot_holds."""
    pool = pool or spot_pool(counts, heights, surface, opts, water, map_wh)
    if pool is None:
        return []
    levels = {zoom: list(cells) for zoom, cells in pool["levels"].items()}  # picking pops from them
    bounds, detailed, size = (pool[k] for k in ("bounds", "detailed", "size"))
    views = [dict(pool["views"][0])]
    saved, auto, base_cell, falloff_by_cell, tie_margin = (
        pool[k] for k in ("saved", "auto", "base_cell", "falloff_by_cell", "tie_margin"))
    # View budget from how much ground the park covers, on a log scale (so a park twice the size
    # gets one more view, not twice as many): base_views up to about one screen of built tiles.
    budget = min(int(opts["count"]), max(int(opts["base_views"]), round(
        int(opts["base_views"]) + math.log2(len(detailed) / float(opts["budget_tiles"])))))
    repeat_keep = float(opts["angle_repeat"])
    whole = size  # the overview counts as a view of the whole box from the saved angle
    chosen = [(bounds["cx"], bounds["cy"], bounds["zm"], whole, saved if auto else None, True)]
    picks = []
    why = []

    def gap(cell, cell2):
        return min(max(cell, cell2) / 2, size / 4)

    def distance(x, y, z, x2, y2, z2):
        return max(abs(x - x2), abs(y - y2), abs(z - z2) / HEIGHT_PER_TILE)

    def spaced(c):
        """A candidate's score after spacing and whether it shows a spot already shown from
        another angle, or None if it may not be shown (see spot_views)."""
        score, x, y, z, cell, r = c[:6]
        factor = 1.0
        repeat = False
        for x2, y2, z2, cell2, r2, is_overview in chosen:
            d = distance(x, y, z, x2, y2, z2)
            near = min(1.0, d / (max(cell, cell2) if falloff_by_cell else base_cell))
            if r == r2:
                if d < gap(cell, cell2) and (not is_overview or cell >= size):
                    return None
                factor = min(factor, near)
            else:
                if d < gap(cell, cell2) and not is_overview and len(picks) + 1 >= int(opts["base_views"]):
                    return None  # another angle on a shown spot only fills up to base_views
                repeat = repeat or d < gap(cell, cell2)
                factor = min(factor, repeat_keep + (1 - repeat_keep) * near)
        return score * factor, repeat

    while len(picks) + 1 < budget:
        ranked = []
        used = {zoom: sum(1 for z, _ in picks if z == zoom) for zoom in levels}
        for zoom, cells in levels.items():
            for i, c in enumerate(cells):
                result = spaced(c)
                if result is None:
                    continue
                score, repeat = result
                # Another angle on a spot already shown must still be worth a view.
                if score > 0 and (not repeat or score >= float(opts["min_score"])):
                    detail = min(1.0, float(opts["detail_span"]) * c[4] / size) ** 2
                    ranked.append((score * detail / (1 + used[zoom]), zoom, i, score / c[0], detail, used[zoom]))
        if not ranked:
            break
        ranked.sort(reverse=True)
        if tie_margin:
            # Near-ties go to the candidate with more of its weight in rides, track and paths, so
            # a small change in scores doesn't flip the pick (and the flip favours activity).
            tied = [r for r in ranked if r[0] >= ranked[0][0] / (1 + tie_margin)]
            winner = max(tied, key=lambda r: (levels[r[1]][r[2]][8], r[0]))
            ranked.remove(winner)
            ranked.insert(0, winner)
        rank, zoom, i, spacing, detail, turn = ranked[0]
        c = levels[zoom].pop(i)
        chosen.append((c[1], c[2], c[3], c[4], c[5], False))
        # Why it won: the factors of its rank, and its lead over the runner-up (near 1: a near-tie).
        why.append({"spot": round(c[6], 3), "seen": round(c[7], 3), "fill": round(c[10], 3), "active": round(c[8], 3), "spacing": round(spacing, 3),
                    "detail": round(detail, 3), "zoomTurn": turn, "rank": round(rank, 3),
                    "lead": round(rank / ranked[1][0], 3) if len(ranked) > 1 and ranked[1][0] else None})
        picks.append((zoom, c))
    # Hold scores: what the view shows (its spot's score, times how much of it is seen), plus
    # the score of spots culled for being too close to it (from no angle chosen), averaged over
    # the zoom levels and the two grids, since each covers the same content once.
    scores = [c[0] for _, c in picks]
    culled = {}
    for cells in levels.values():
        for c in cells:
            key = c[9] + (c[4],)  # per spot, wherever each angle's view of it is aimed
            if not any(p[9] + (p[4],) == key for _, p in picks):
                culled[key] = c[6]
    for (x, y, z, cell), score in culled.items():
        near = [(distance(x, y, z, p[1], p[2], p[3]), k) for k, (_, p) in enumerate(picks)
                if distance(x, y, z, p[1], p[2], p[3]) < gap(cell, p[4])]
        if near:
            scores[min(near)[1]] += score / len(levels) / 2
    for (zoom, c), reasons in zip(picks, why):
        view = {"x": round(c[1]), "y": round(c[2]), "z": round(c[3]), "zoom": zoom, "why": reasons,
                "_spot": (zoom, c[9], c[4])}  # its candidates in the pool, for district_views
        if auto:
            view["rotation"] = c[5]
        elif opts["rotation"] == "keep":
            view["rotation"] = saved  # set here, as the route and pan steps need every view's angle
        elif opts["rotation"] == "cycle":
            view["rotation"] = (saved + len(views)) % 4
        else:
            view["rotation"] = int(opts["rotation"]) % 4
        views.append(view)
    spot_holds(views, scores, opts)
    if opts["districts"] and auto:
        summary = district_views(views, pool, counts, heights, surface, opts)
        if summary:
            views[0].setdefault("why", {})["districts"] = summary  # on the overview, for the scores file
    if auto and counts is not None and int(opts["tower_views"]):
        # After the districts, so a tower takes its neighbour's final angle (Qhyre Rock's tower
        # view turned against its close-ups when it took the angle homing then changed).
        hold_scores = [v["hold"] for v in views[1:]]
        if tower_views(views, hold_scores, counts, heights, surface, pool, opts):
            spot_holds(views, hold_scores, opts)
    views[0]["_pool"] = pool  # for bead_views, after the circuit is ordered
    return views


def tower_views(views, scores, counts, heights, surface, pool, opts):
    """Views of a park's towers (owner, 2026-10-29: towers got no time above their base; a
    close-up sits at its cell's mean element height, so a tower's top is off the screen).
    Towers are districts.tower_points' structures (a built top tower_height steps over the
    ground and tower_rise over the built tops around, tallest first, those under tower_share
    of the tallest left out). A tower's zoom is the closest whose screen holds its height in
    tower_fit of the window. A tower that no close-up already shows whole (its column in the
    middle half of the close-up's `screen` width and its full height within the screen, at a
    zoom no wider than the tower's own, so a wide shot with the tower a quarter of its height
    does not count; owner, 2026-10-29: Ghillie Dhu's tower "isn't being flagged") gets a view
    of its own: centred on the tower at mid-height, from the nearest close-up's angle (a pan up
    the tower, no turn) unless another angle's frame fill beats it by a quarter (owner: a tower
    at Troubadours' edge was shown "half backdrop"); with tower_fill set, a tower under it at
    its best angle gets none (off by default: a tall tower's frame is mostly sky, and the views
    the owner liked fill 0.2-0.4). Up to tower_views per park,
    within `count`: over it, the lowest-scoring close-ups go. Tower views take the median
    close-up score for their hold (the holds are then set again), run after district_views
    (no `_spot`: the nearest close-up's final angle and its district, for the circuit), carry
    `_tower` and are `fixed`: the plugin's
    fitting neither moves nor merges them (owner: a window wider than Sonnental's content put
    its tower at the frame's edge, and the content box's top cut Constellations' short)."""
    import districts  # tools/districts.py imports this module; resolved at call time
    towers = districts.tower_points(counts, heights, surface, {**districts.DEFAULTS, **opts})
    if not towers:
        return
    screen = tuple(int(n) for n in opts["screen"])
    close = [v for v in views if "_spot" in v]
    zoom_min, zoom_max = int(opts["zoom_min"]), int(opts["zoom_max"])
    limit = int(opts["tower_views"])
    added, report = [], []
    rasters = pool.get("rasters")
    for t in towers:
        if len(added) >= limit:
            break
        top, base = t["z"] + t["height"] * 4, t["z"] - t["height"] * 4  # world units
        zoom = zoom_min
        while zoom < zoom_max and (top - base) + 128 > float(opts["tower_fit"]) * screen[1] * 2 ** zoom:
            zoom += 1
        fit_zoom = zoom  # the "shown whole" test below uses the fit; the view goes tower_close levels in
        zoom = max(zoom_min, zoom - int(opts["tower_close"]))
        entry = {"x": t["x"], "y": t["y"], "height": t["height"], "zoom": zoom, "fit": fit_zoom}
        # Centred on the tower's middle; a tower taller than the window at this zoom is framed from
        # its top down (the top tower_top of the window's height under the frame's top).
        window_h = screen[1] * 2 ** zoom
        z = t["z"]
        if top - base > window_h:
            z = round(top - (0.5 - float(opts["tower_top"])) * window_h)
        # Shown whole already: the tower's column in the middle half of the window's width and
        # its base to top within its height, on some close-up's screen at a zoom no wider than
        # the tower's own.
        def shows(v):
            if v["zoom"] > fit_zoom:
                return False
            w, h = screen[0] * 2 ** v["zoom"], screen[1] * 2 ** v["zoom"]
            sx, sy = screen_point(v["x"] * 32, v["y"] * 32, v["z"], v["rotation"])
            tx, ty_top = screen_point(t["x"] * 32, t["y"] * 32, top, v["rotation"])
            ty_base = ty_top + (top - base)
            return abs(tx - sx) <= w / 6 and sy - h / 2 <= ty_top and ty_base <= sy + h / 2
        shown = next((v for v in close + added if shows(v)), None)
        if shown is not None:
            report.append({**entry, "shownBy": [shown["x"], shown["y"], shown["zoom"]]})
            continue
        nearest = min(close, key=lambda v: max(abs(v["x"] - t["x"]), abs(v["y"] - t["y"])), default=None)
        rotation = nearest["rotation"] if nearest else views[0].get("rotation", 0)
        if rasters is not None:
            fills = [frame_fill(rasters, r, t["x"], t["y"], z, zoom, fill_screen(opts), float(opts["fill_land"])) for r in range(4)]
            entry["fills"] = [round(f, 2) for f in fills]
            best = max((r for r in range(4) if angle_weight(r, opts) > 0), key=lambda r: (fills[r], r == rotation))
            if fills[best] < float(opts["tower_fill"]):  # 0: never
                report.append({**entry, "dropped": "fill"})
                continue
            if fills[rotation] < 0.8 * fills[best]:
                rotation = best
        added.append({"x": t["x"], "y": t["y"], "z": z, "zoom": zoom, "rotation": rotation, "fixed": True,
                      "why": {"tower": t["height"], "tiles": t["tiles"], "zoom": zoom, "near": nearest["x"] if nearest else None,
                              "fill": entry.get("fills")},
                      "_tower": True, "_district": nearest.get("_district") if nearest else None})
        report.append({**entry, "view": rotation})
    views[0].setdefault("why", {})["towers"] = report  # on the overview, for the scores file
    if not added:
        return False
    median = sorted(scores)[len(scores) // 2] if scores else 1.0
    # Within the park's count: the lowest-scoring close-ups make room.
    over = len(views) + len(added) - int(opts["count"])
    while over > 0 and close:
        k = min(range(len(close)), key=lambda i: scores[i])
        views.remove(close.pop(k))
        del scores[k]
        over -= 1
    for v in added:
        views.append(v)
        scores.append(median)
    return True


def district_views(views, pool, counts, heights, surface, opts):
    """Phase 3 of the pan-based generation plan: a park's close-ups grouped into districts
    (tools/districts.py: the watershed of the element density over the park's spot points),
    each district with a home angle (the angle that shows most of its close-ups' spots, by
    their candidate scores) and a home zoom (the zoom its close-ups score most at). A close-up
    keeps the home settings unless a change earns its place: it turns away when the home angle
    shows under home_seen of its spot and its own angle at least home_gain more; it keeps its
    own zoom when its spot scores home_gain more there than at the home zoom (the candidate at
    the home zoom whose cell holds it, from the same angle), or no such candidate exists; a
    spot shown again from another angle (angle_repeat) keeps that angle, which is its point. At
    most change_budget of the close-ups change, the smallest gains reverting first. Close-ups
    that end up identical merge, the hold going to the one kept. Each view's `why` records its
    district, the home settings and what it kept; the views carry `_district` for
    circuit_order. Returns a summary for the scores file."""
    import districts  # tools/districts.py imports this module; resolved at call time
    close = [v for v in views if "_spot" in v]
    if len(close) < 2 or counts is None:
        return None
    dopts = {**districts.DEFAULTS, **opts}
    points = districts.spot_points(pool, heights, surface, dopts)
    if not points:
        return None
    groups, tile_district, info = districts.districts_of(points, counts, surface, pool["bounds"], dopts)
    labelled = list(tile_district)

    def district_of(v):
        t = (v["x"], v["y"])
        if t in tile_district:
            return tile_district[t]
        near = min(labelled, key=lambda u: (u[0] - t[0]) ** 2 + (u[1] - t[1]) ** 2)
        return tile_district[near]
    levels = pool["levels"]
    screen = tuple(int(n) for n in opts["screen"])

    def angles_of(v):
        """The view's spot as a candidate from each angle: rotation -> candidate."""
        zoom, key, cell = v["_spot"]
        return {c[5]: c for c in levels[zoom] if c[9] == key and c[4] == cell}

    def containing(v, zoom, rotation):
        """The best candidate at a zoom, from an angle, whose cell holds the view's anchor."""
        height = screen[1] * 2 ** zoom  # a screen of height, world units, at that zoom
        found = [c for c in levels.get(zoom, []) if c[5] == rotation
                 and abs(c[1] - v["x"]) <= c[4] / 2 and abs(c[2] - v["y"]) <= c[4] / 2 and abs(c[3] - v["z"]) <= height / 2]
        return max(found, key=lambda c: c[0]) if found else None
    for v in close:
        v["_district"] = district_of(v)
    homes = {}
    for d in set(v["_district"] for v in close):
        members = [v for v in close if v["_district"] == d]
        by_angle = [sum(angles_of(v).get(r, [0])[0] for v in members) for r in range(4)]
        by_zoom = {}
        for v in members:
            by_zoom[v["zoom"]] = by_zoom.get(v["zoom"], 0) + angles_of(v)[v["rotation"]][0]
        homes[d] = (max(range(4), key=lambda r: (by_angle[r], -r)), max(by_zoom, key=lambda z: (by_zoom[z], z)))
    seen_limit, gain = float(opts["home_seen"]), float(opts["home_gain"])
    changes = []  # (gain, view, kind)
    spots = collections.Counter(v["_spot"][1:] for v in close)
    for v in close:
        home_r, home_z = homes[v["_district"]]
        v["why"]["district"] = v["_district"]
        v["why"]["home"] = [home_r, home_z]
        kept = []
        cands = angles_of(v)
        own = cands[v["rotation"]]
        if spots[v["_spot"][1:]] > 1:
            # The same spot shown from another angle (angle_repeat: small parks get their
            # content from several sides): that angle is the point of the view.
            v["why"]["repeat"] = True
        elif v["rotation"] != home_r:
            at_home = cands.get(home_r)
            if at_home is None:
                kept.append(("angle", math.inf))  # the home angle is not worth a view here
            elif at_home[7] < seen_limit and own[7] >= (1 + gain) * at_home[7]:
                kept.append(("angle", own[7] / at_home[7]))
            else:
                v["x"], v["y"], v["z"], v["rotation"] = round(at_home[1]), round(at_home[2]), round(at_home[3]), home_r
                own = at_home
        if v["zoom"] != home_z:
            at_home = containing(v, home_z, v["rotation"])
            if at_home is None:
                kept.append(("zoom", math.inf))
            elif own[0] >= (1 + gain) * at_home[0]:
                kept.append(("zoom", own[0] / at_home[0]))
            else:
                v["x"], v["y"], v["z"], v["zoom"] = round(at_home[1]), round(at_home[2]), round(at_home[3]), home_z
        v["_home"] = (home_r, home_z)
        for kind, g in kept:
            changes.append((g, v, kind))
    budget = max(0, int(float(opts["change_budget"]) * len(close)))
    changes.sort(key=lambda c: c[0])
    while len(changes) > budget:
        g, v, kind = changes.pop(0)
        home_r, home_z = v["_home"]
        if kind == "angle":
            c = angles_of(v)[home_r]
            v["x"], v["y"], v["z"], v["rotation"] = round(c[1]), round(c[2]), round(c[3]), home_r
        else:
            c = containing(v, home_z, v["rotation"])
            v["x"], v["y"], v["z"], v["zoom"] = round(c[1]), round(c[2]), round(c[3]), home_z
    for v in close:
        v["why"]["kept"] = [kind for g, u, kind in changes if u is v]
    # Close-ups made identical by the home settings merge into one.
    seen = {}
    for v in list(close):
        key = (v["x"], v["y"], v["z"], v["zoom"], v["rotation"])
        if key in seen:
            seen[key]["hold"] = round(seen[key]["hold"] + v["hold"], 3)
            views.remove(v)
            close.remove(v)
        else:
            seen[key] = v
    return {"districts": len(groups), "points": len(points), "homes": {str(d): list(h) for d, h in homes.items()},
            "changed": len(changes), "merged": len(views) - len(seen) - sum(1 for v in views if "_spot" not in v)}


def grid_views(counts, heights, surface, opts, **_):
    """Pick the densest grid cells and centre a view on each cell's element centroid, at the
    elements' mean height (so tall builds are framed in the middle, not at their base)."""
    if not counts:
        return []
    cell = max(1, int(opts["cell"]))
    min_x = min(x for x, _ in counts)
    min_y = min(y for _, y in counts)
    cells = {}
    for (x, y), n in counts.items():
        key = ((x - min_x) // cell, (y - min_y) // cell)
        total, sx, sy, sz = cells.get(key, (0, 0, 0, 0))
        cells[key] = (total + n, sx + x * n, sy + y * n, sz + heights[(x, y)][0])
    ranked = sorted(cells.values(), key=lambda c: c[0], reverse=True)
    best = ranked[0][0]
    views = []
    for total, sx, sy, sz in ranked[: int(opts["count"])]:
        if total < best * float(opts["min_score"]):
            break
        views.append({"x": round(sx / total), "y": round(sy / total), "z": round(sz / total) * 8})
    return views


VIEW_METHODS = {"spots": spot_views, "grid": grid_views}


def trimmed_range(values):
    """(lo, hi) of weighted values [(value, weight)], ignoring BOUNDS_TRIM of the weight at each end."""
    total = sum(w for _, w in values)
    lo = hi = None
    seen = 0
    for v, w in sorted(values):
        seen += w
        if lo is None and seen > total * BOUNDS_TRIM:
            lo = v
        if hi is None and seen >= total * (1 - BOUNDS_TRIM):
            hi = v
    return lo, hi


def content_bounds(counts, heights, surface):
    """Box holding the park's built content: tiles x0..x1, y0..y1 and world heights z0..z1.
    Tiles with a single element are left out when there are others (maps filled edge to edge
    with one scenery block or tree per tile), the rest weigh the square of their element count
    so densely built areas count far more than sparse surroundings (a backdrop, an isolated
    path), and the outermost BOUNDS_TRIM of the weight on each side is ignored. cx, cy (tile
    units, so a tile's middle is +0.5) and zm (world height) are where the elements in it are on
    average, counted once each."""
    if not counts:
        return None
    detailed = {tile: n for tile, n in counts.items() if n >= 2} or counts
    weighted = [(tile, n * n) for tile, n in detailed.items()]
    x0, x1 = trimmed_range([(t[0], w) for t, w in weighted])
    y0, y1 = trimmed_range([(t[1], w) for t, w in weighted])
    inside = [(t, w) for t, w in weighted if x0 <= t[0] <= x1 and y0 <= t[1] <= y1]
    z0, _ = trimmed_range([(surface[t[1] * 1001 + t[0]], w) for t, w in inside])
    _, z1 = trimmed_range([(heights[t][1], w) for t, w in inside])
    # Where the content is: its elements' centre and mean height (one tall tower doesn't move them).
    elements = sum(detailed[t] for t, _ in inside)
    cx = sum((t[0] + 0.5) * detailed[t] for t, _ in inside) / elements
    cy = sum((t[1] + 0.5) * detailed[t] for t, _ in inside) / elements
    zm = sum(heights[t][0] for t, _ in inside) / elements
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "z0": z0 * 8, "z1": z1 * 8,
            "cx": round(cx, 2), "cy": round(cy, 2), "zm": round(zm * 8)}


def slug(text, limit=40):
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:limit].rstrip("-") or "park"


def park_key(entry):
    """Stable id of a playlist park, used to match views set in the editor."""
    key = os.path.basename(entry["file"])
    return key + "|" + entry["member"] if entry.get("member") else key


def edits_path(playlist_path):
    return os.path.splitext(playlist_path)[0] + ".views.json"


def load_edits(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("parks", {})


def pinned(edit):
    """Whether an editor edit is kept: it has a view placed by hand, or its list was rearranged.
    Otherwise it is only generated views carried over, which are generated afresh instead."""
    return bool(edit.get("arranged") or any(v.get("manual") for v in edit.get("views", [])))


def save_edits(path, edits):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("{\n \"version\": 1,\n \"parks\": {")
        for i, (key, park) in enumerate(sorted(edits.items())):
            f.write(",\n" if i else "\n")
            f.write("  %s: {%s\"views\": [\n" % (json.dumps(key), "\"arranged\": true, " if park.get("arranged") else ""))
            f.write(",\n".join("   " + json.dumps(v) for v in park["views"]))
            f.write("\n  ]}")
        f.write("\n }\n}\n")


def spot_zoom(tiles):
    """Closest zoom whose screen (about 30 tiles across at zoom 0) holds a spot's tiles with a
    margin of half their size."""
    span = max(max(t[0] for t in tiles) - min(t[0] for t in tiles),
               max(t[1] for t in tiles) - min(t[1] for t in tiles)) + 1
    zoom = -2
    while zoom < MAX_ZOOM and span * 1.5 > 30 * 2 ** zoom:
        zoom += 1
    return zoom


def companion_views(entry, found, storage, park_name, heights, surface, saved_rotation, hold, track, track_all,
                    show_pan=0.0, report=None, cue_pan=0.0):
    """Views on a park's companion animations (`animations = true`) and its show (`show`),
    flagged so the plugin plays them as placed: animations after the other views, the show last."""
    max_top = max((tile_top(t, heights, surface) for t in heights), default=0)

    def place(spot):
        """x, y, z, rotation and zoom for a view on a spot's tiles."""
        tiles = spot["tiles"]
        # Height: the spot's own (from the companion's data or table), its ride's track on those
        # tiles, or the middle of what stands there.
        x0, x1 = min(t[0] for t in tiles), max(t[0] for t in tiles)
        y0, y1 = min(t[1] for t in tiles), max(t[1] for t in tiles)
        ride_bases = sorted(b for (x, y, b), ride in track.items()
                            if ride == spot.get("ride") and x0 <= x <= x1 and y0 <= y <= y1)
        bases = ride_bases or sorted(b for t in tiles if t in heights for b, _, _ in heights[t][2])
        z = spot.get("z") or (bases[len(bases) // 2] if bases else statistics.median(surface[y * 1001 + x] for x, y in tiles)) * 8
        # The angle that hides least of the spot at its height; the park's own on a tie.
        cache = {}
        rotation = min(range(4), key=lambda r: (
            sum(hidden_tile(t, z, r, heights, surface, max_top, cache) for t in tiles), (r - saved_rotation) % 4))
        cx, cy = companions.centre(tiles)
        return {"x": int(cx), "y": int(cy), "z": int(z), "rotation": rotation, "zoom": spot_zoom(tiles)}

    views = []
    if entry.get("animations"):
        limit = entry.get("animation_views", ANIMATION_VIEWS)
        for spot in companions.animation_spots(found, storage, park_name, track_all, limit,
                                               entry.get("animation_overrides"), report):
            v = dict(place(spot), hold=float(spot.get("hold") or entry.get("animation_hold", hold)), animation=spot["name"])
            v.update({k: spot[k] for k in ("zoom", "rotation") if spot.get(k) is not None})  # set in the profile
            if spot.get("cue") and entry.get("animation_cues", True):
                # Event-timed: the view waits for its trigger and stays while the effect runs.
                # Its hold is the least it plays: short, so the effect decides its length.
                v["cue"] = {"wait": float(entry.get("cue_wait", CUE_WAIT)), "ticks": 0, **spot["cue"]}
                # Its hold covers the effect and its 2 s tail, then (owner, 2026-10-30) a pan on to
                # the next view like any other view's: the plugin pans once the cue has fired.
                still = max(float(spot.get("hold") or entry.get("cue_hold", CUE_HOLD)),
                            v["cue"].get("ticks", 0) / 40 + 2)
                move = float(entry.get("cue_move", CUE_MOVE)) if cue_pan > 0 else 0.0
                v["hold"] = round(still + move, 2)
                if move:
                    v["pan"] = round(move / v["hold"], 4)
            views.append(v)
    if entry.get("show"):
        definition = companions.find_show(entry["show"], found, park_name)
        if "spot" in definition:
            v = place(definition["spot"])
            v.update({k: definition["spot"][k] for k in ("zoom", "rotation") if k in definition["spot"]})
        else:
            v = dict(definition["view"])
            v["z"] = surface[v["y"] * 1001 + v["x"]] * 8
            if "path" in definition:
                # The camera glides on during the show at the view's height (the ground's along
                # the way pulled Constellations' glide short where the land falls away, owner's live
                # test 2026-10-30); the plugin speeds its moving legs up to the view's pan share.
                v["path"] = [dict(p, z=p.get("z", v["z"])) for p in definition["path"]]
                if show_pan > 0:
                    v["pan"] = show_pan
                if "pathStep" in definition:
                    v["pathStep"] = definition["pathStep"]  # the glide waits for this step of the show
        if "show_at" in entry:
            v["showAt"] = int(entry["show_at"])  # where it plays among the park's views (-1: last)
        views.append(dict(v, hold=float(entry.get("show_hold", definition["hold"])),
                          show={"action": companions.show_action(definition["companion"]), "name": entry["show"]}))
    return views


def cue_text(cue):
    """A cue in a few words, for --animations."""
    what = ("tick %d%s" % (cue["tick"], " (%.0f s lead)" % cue["lead"] if cue.get("lead") else "") if "tick" in cue
            else "%s on %s" % ("cars " + "/".join(map(str, cue["cars"])) if cue.get("cars") else "ride %s" % cue.get("ride"),
                               ",".join(map(str, cue["tiles"])) if cue.get("tiles") else "any tile"))
    return "%s, %d ticks%s%s%s" % (what, cue.get("ticks", 0), ", follows ride %d" % cue["follow"] if "follow" in cue else "",
                                   ", wait %.0f s" % cue["wait"] if "wait" in cue else "", ", cuts in" if cue.get("cut") else "")


def is_cut(view):
    """Whether a view cuts in on the park's clock (a cue with `tick` and `cut`)."""
    cue = view.get("cue") or {}
    return bool(cue.get("cut")) and "tick" in cue


def place_cuts(views):
    """Lists each cut-in view where it is expected to play (owner, 2026-10-31): after the route
    view that is on screen when its cue first comes due (tick / 40 - lead seconds into the park,
    against the route's holds; past the route's end, after its last view), in time order. Only the
    listing changes: the plugin leaves cut views out of the play order and cuts them in when cued."""
    cuts = sorted((v for v in views if is_cut(v)), key=lambda v: v["cue"]["tick"] / 40 - (v["cue"].get("lead") or 0))
    if not cuts:
        return views
    rest = [v for v in views if not is_cut(v)]
    starts, t = [], 0.0
    for i, v in enumerate(rest):
        if in_route(v):
            starts.append((i, t))
            t += v["hold"]
    after = {}
    for c in cuts:
        due = c["cue"]["tick"] / 40 - (c["cue"].get("lead") or 0)
        k = max([i for i, start in starts if start <= due] or [starts[0][0] if starts else len(rest) - 1])
        after.setdefault(k, []).append(c)
    return [w for i, v in enumerate(rest) for w in [v] + after.get(i, [])] + after.get(-1, [])


def place_shows(views):
    """Moves each show view to its `showAt` index among the park's views (-1 the last, the
    default), as the plugin plays it, so pans and timing follow the order played."""
    shows = [v for v in views if v.get("show")]
    out = [v for v in views if not v.get("show")]
    for v in shows:
        at = v.get("showAt", -1)
        out.insert(max(0, min(len(out), len(out) + 1 + at if at < 0 else at)), v)
    return out


def map_size(tiles):
    """Map size in tiles, as the plugin API's map.size reports it."""
    return tiles.u32(), tiles.u32()


def angle_weight(r, opts):
    """Score factor for views from angle r (`angle_weights`, counted from the saved angle)."""
    weights = opts["angle_weights"]
    if len(weights) != 4:
        raise ValueError("angle_weights needs four values")
    return float(weights[(r - opts.get("saved_rotation", 0)) % 4])


def pan_tolerance(zoom, opts):
    """Fastest legible pan at a zoom level, screen px/s: pan_tolerance at zoom -2, one step less
    per level out, never under one step (plugin/src/pan.ts panTolerance)."""
    step = float(opts["pan_tolerance_step"])
    return max(step, float(opts["pan_tolerance"]) - step * (zoom + 2))


def plan_pan(a, b, move_ms, opts, returning=False):
    """The zoom a pan from view a to view b runs at and its average screen speed there, as the
    plugin plays it (plugin/src/pan.ts): angle and zoom change at the end `panChanges` names
    (two-step changes split), and a pan over the tolerance at its zoom steps out a level at a
    time (one level between views at one zoom, up to the wider view between zooms). A park's
    return pan to a wider first view zooms out as it goes, equal time per level at one screen
    speed, turning on arrival; it is checked at the widest zoom.
    Returns (zoom, speed, tolerance), or None when the plugin cuts instead."""
    pa = (a["x"] * 32 + 16, a["y"] * 32 + 16, a["z"])
    pb = (b["x"] * 32 + 16, b["y"] * 32 + 16, b["z"])
    if move_ms < 500 or math.dist(pa, pb) < 16:
        return None
    start = a.get("panChanges", "end") == "start"
    turn = (b["rotation"] - a["rotation"]) % 4
    first = 1 if turn == 2 else ((-1 if turn == 3 else turn) if start else 0)
    rotation = (a["rotation"] + first) % 4
    dz = b["zoom"] - a["zoom"]
    zoom = a["zoom"] + ((dz if start else 0) if abs(dz) <= 1 else (dz - int(dz / 2) if start else int(dz / 2)))
    (ax, ay), (bx, by) = screen_point(*pa, rotation), screen_point(*pb, rotation)
    distance = math.hypot(bx - ax, by - ay)
    threshold = a.get("zoomThreshold")
    tolerance = (lambda z: threshold) if threshold else (lambda z: pan_tolerance(z, opts))
    if returning and b["zoom"] > a["zoom"]:
        (ax, ay), (bx, by) = screen_point(*pa, a["rotation"]), screen_point(*pb, a["rotation"])
        levels = range(a["zoom"] + 1, b["zoom"] + 1)
        total = sum(2 ** z for z in levels)
        return b["zoom"], math.hypot(bx - ax, by - ay) / (total * move_ms / len(levels)) * 1000, tolerance(b["zoom"])
    speed = lambda z: distance / 2 ** z * 1000 / move_ms
    widest = min(3, a["zoom"] + 1) if dz == 0 else max(a["zoom"], b["zoom"])
    while zoom < widest and speed(zoom) > tolerance(zoom):
        zoom += 1
    return zoom, speed(zoom), tolerance(zoom)


def pan_pairs(views):
    """Each view with the view it pans to and whether that is the park's return pan: the next
    one, and for the last view the first (owner, 2026-10-28), zooming out as it goes. Cut-in
    views (cue.cut) are left out: they play out of turn, and the plugin plans their pans then."""
    views = [v for v in views if not is_cut(v)]
    pairs = [(a, b, False) for a, b in zip(views, views[1:])]
    if len(views) > 1 and not views[0].get("show"):
        pairs.append((views[-1], views[0], True))
    return pairs


def stretch_pans(views, opts):
    """Gives a generated pan that is too fast for the tolerance at its zoom more moving time, in
    100 ms steps, until it is not (owner, 2026-10-28): the view's still time stays, its hold grows.
    Overviews are left alone: their zoom is fitted to the window in play. Returns the number of
    pans stretched and the seconds added."""
    stretched, added = 0, 0.0
    for a, b, returning in pan_pairs(views):
        pan = a.get("pan", 0)
        if not pan or a.get("show") or a.get("overview") or a.get("cue"):
            continue
        move_ms = pan * a["hold"] * 1000
        planned = plan_pan(a, b, move_ms, opts, returning)
        if not planned or planned[1] <= planned[2]:
            continue
        still = a["hold"] - move_ms / 1000
        move_ms = math.ceil(move_ms / 100) * 100
        while True:
            zoom, speed, tolerance = plan_pan(a, b, move_ms, opts, returning)
            if speed <= tolerance:
                break
            move_ms += 100
        hold = round(still + move_ms / 1000, 3)
        added += hold - a["hold"]
        a["hold"], a["pan"] = hold, round(move_ms / 1000 / hold, 4)
        stretched += 1
    return stretched, added


def pan_speeds(views, opts):
    """Each pan's run zoom and average screen speed against the tolerance there. Views are taken
    as listed: fitting at run time moves some a little, and an overview's zoom is set to fit the
    window then, so its pan is marked."""
    out = []
    for i, (a, b, returning) in enumerate(pan_pairs(views)):
        pan = a.get("pan", 0)
        if not pan or a.get("show"):
            continue
        planned = plan_pan(a, b, pan * a["hold"] * 1000, opts, returning)
        if not planned:
            continue  # the plugin cuts
        zoom, speed, tolerance = planned
        entry = {"from": i + 1, "to": (i + 1) % len(views) + 1, "zoom": zoom, "speed": round(speed), "tolerance": round(tolerance),
                 "over": speed > tolerance}
        if a.get("overview"):
            entry["overview"] = True  # zoom fitted at run time
        out.append(entry)
    return out


def convex_hull(points):
    """The convex hull of 2-D points (monotone chain), counter-clockwise."""
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for q in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    for q in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    return lower[:-1] + upper[:-1]


def box_hull(box, rotation):
    """The content box on screen at a rotation (zoom-0 px): the convex hull of its eight corners."""
    pts = []
    for x, y in ((box["x0"], box["y0"]), (box["x1"] + 1, box["y0"]), (box["x1"] + 1, box["y1"] + 1), (box["x0"], box["y1"] + 1)):
        for z in (box["z0"], box["z1"]):
            pts.append(screen_point(x * 32, y * 32, z, rotation))
    return convex_hull(pts)


def outside_share(hull, view, zoom, screen, nx=16, ny=9):
    """The share of a view's window (screen at a zoom, centred on the view) that lies outside the
    content box's hull on screen: what shows the void or the land beyond the park."""
    cx, cy = screen_point(view["x"] * 32 + 16, view["y"] * 32 + 16, view["z"], view["rotation"])
    w, h = screen[0] * 2 ** zoom, screen[1] * 2 ** zoom
    n = len(hull)
    out = 0
    for i in range(nx):
        px = cx - w / 2 + w * (i + 0.5) / nx
        for j in range(ny):
            py = cy - h / 2 + h * (j + 0.5) / ny
            inside = n >= 3
            for k in range(n):
                (ax, ay), (bx, by) = hull[k], hull[(k + 1) % n]
                if (bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0:
                    inside = False
                    break
            out += not inside
    return out / (nx * ny)


def track_parts(tiles):
    """Tiles ({(x, y): z}) split into connected parts (king's-move adjacency), largest first."""
    left = dict(tiles)
    parts = []
    while left:
        start = next(iter(left))
        part, queue = {start: left.pop(start)}, [start]
        while queue:
            x, y = queue.pop()
            for nx in (x - 1, x, x + 1):
                for ny in (y - 1, y, y + 1):
                    if (nx, ny) in left:
                        part[(nx, ny)] = left.pop((nx, ny))
                        queue.append((nx, ny))
        parts.append(part)
    return sorted(parts, key=len, reverse=True)


DIRECTION_VECTORS = [(-1, 0), (0, 1), (1, 0), (0, -1)]  # a track piece's build direction (OpenRCT2 CoordsDirectionDelta)


def track_run(tiles, box, opts, accept=None):
    """The longest run of a track part ({(x, y): z}) a camera can follow in a straight line:
    the two tiles furthest apart inside the content box (chord ≥ ride_run) joined by a path of
    adjacent track tiles that keeps within ride_band tiles of the line between them (and within
    that many tiles' height of it) and is at most ride_detour times as long as the chord, so the
    pan sweeps along one stretch of the ride rather than across a mesh of track. Returns
    (chord, (x, y, z), (x, y, z), path tiles) or None, longest first; `accept(chord, a, b, path)`
    may turn a run down, and the next longest is tried."""
    least, band, detour = float(opts["ride_run"]), float(opts["ride_band"]), float(opts["ride_detour"])
    inside = {t: z for t, z in tiles.items() if box["x0"] <= t[0] <= box["x1"] and box["y0"] <= t[1] <= box["y1"]}
    points = sorted(inside.items())
    pairs = []
    for i, ((x0, y0), z0) in enumerate(points):
        for (x1, y1), z1 in points[i + 1:]:
            chord = math.hypot(x1 - x0, y1 - y0)
            if chord >= least:
                pairs.append((chord, x0, y0, z0, x1, y1, z1))
    pairs.sort(reverse=True)
    reach = int(math.ceil(band))
    mask = {(x + dx, y + dy) for x, y in tiles for dx in range(-reach, reach + 1) for dy in range(-reach, reach + 1)
            if math.hypot(dx, dy) <= band}  # every tile within the band of some track
    for chord, x0, y0, z0, x1, y1, z1 in pairs:
        ux, uy = (x1 - x0) / chord, (y1 - y0) / chord
        steps = int(math.ceil(chord))
        if any((round(x0 + (x1 - x0) * k / steps), round(y0 + (y1 - y0) * k / steps)) not in mask for k in range(1, steps)):
            continue  # track leaves the line somewhere: no path through the corridor either

        def near(t):
            x, y = t
            along = (x - x0) * ux + (y - y0) * uy
            if along < -band or along > chord + band:
                return False
            if abs((x - x0) * uy - (y - y0) * ux) > band:
                return False
            return abs(tiles[t] - (z0 + (z1 - z0) * max(0.0, min(1.0, along / chord)))) <= band * 32
        # Shortest path from one end to the other through the corridor (breadth first).
        start, goal = (x0, y0), (x1, y1)
        prev, queue = {start: None}, [start]
        while queue and goal not in prev:
            nxt = []
            for x, y in queue:
                for nx in (x - 1, x, x + 1):
                    for ny in (y - 1, y, y + 1):
                        t = (nx, ny)
                        if t not in prev and t in tiles and near(t):
                            prev[t] = (x, y)
                            nxt.append(t)
            queue = nxt
        if goal not in prev:
            continue
        path, t = [], goal
        while t is not None:
            path.append(t)
            t = prev[t]
        length = sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(path, path[1:]))
        if length <= detour * chord and (accept is None or accept(chord, (x0, y0, z0), (x1, y1, z1), path)):
            return chord, (x0, y0, z0), (x1, y1, z1), path
    return None


def ride_pans(views, rides, pieces, vehicles, heights, surface, box, opts, info=None, water=None):
    """Phase 6 of the pan-based generation plan, pans along rides: a ride whose vehicles move
    (and which is open, `ride_status`: a closed or testing ride with a train is mostly a prop)
    and whose visible track has ride_tiles tiles or more gives a pair of views at the ends of its
    longest straight run inside the park's content (track_run), at ride_zoom and the track's
    height, in the direction the ride's trains run (the build direction of the track pieces
    along the run, `pieces`), from the angle where the run is longest on screen weighted by the
    frame fill along it and, a little, by the share of the run's track that angle shows (nothing
    standing in front of it), which must be at least ride_visible (a dark ride or tunnel fails), the fill at least ride_fill (a ride along the park's edge fails), and
    no window at the ends or along the run more than ride_edge outside the content box (the
    void or the land beyond the park); a run floating far above everything around it for much
    of its length fails too. A run that fails gives way to the ride's next longest (track_run).
    The end view is pulled back by ride_overshoot of the window, so the pan stops on the
    track. Up to ride_pans pairs per park, the runs scoring most (length × fill) first, one per
    ride; the pair counts as one point of interest: over `count` the lowest-scoring close-ups go.
    Pair views are `fixed` (shown as placed), keep their angle and zoom (district_views has run)
    and stay consecutive in the circuit (circuit_order). Records the rides, and the runs turned
    down, on the overview's `why`."""
    limit = int(opts["ride_pans"])
    if not limit or not views or not views[0].get("overview") or not rides or not box:
        return views
    info = info or {}
    pool = views[0].get("_pool") or {}
    rasters = pool.get("rasters")
    screen = tuple(int(n) for n in opts["screen"])
    fill_win = fill_screen(opts)
    land, samples = float(opts["fill_land"]), max(1, int(opts["path_samples"]))
    zoom = int(opts["ride_zoom"])
    moving = {v[3] for v in vehicles if v[4]}
    if opts["ride_status"] == "open":
        moving = {r for r in moving if r in info and info[r]["status"] == 1}
    elif opts["ride_status"] != "any":
        raise ValueError("ride_status must be \"open\" or \"any\"")
    tiles = {}
    for (x, y, base), ride in rides.items():
        if ride in moving:
            t = tiles.setdefault(ride, {})
            t[(x, y)] = min(t.get((x, y), base * 8), base * 8)
    max_top = max((tile_top(t, heights, surface) for t in heights), default=0)
    fill_min, visible_min = float(opts["ride_fill"]), float(opts["ride_visible"])
    edge_max, void_max = float(opts["ride_edge"]), float(opts["ride_void"])
    hulls = [box_hull(box, r) for r in range(4)]
    runs, turned_down = [], []

    def ride_name(ride):
        return info[ride]["name"] if ride in info else None
    for ride, t in tiles.items():
        if len(t) < int(opts["ride_tiles"]):
            continue
        judged = {}  # (a, b) -> the best angle's (score, rotation, length, fill, visible, edge), or None
        failed = collections.Counter()

        def judge(chord, a, b, path):
            if len(judged) >= int(opts["ride_tries"]):
                return False
            # A run floating far above everything around it for much of its length (Troubadours'
            # sky-level tracks at height 448 over a town topping out at 312: nothing to see there,
            # whatever those rides are) is no run to follow.
            floating = 0
            for x, y in path:
                top = 0
                for dx in range(-2, 3):
                    for dy in range(-2, 3):
                        entry = heights.get((x + dx, y + dy))
                        if entry:
                            top = max([top] + [clear * 8 for _, clear, kind in entry[2] if kind != 2])
                        if 0 <= x + dx < 1001 and 0 <= y + dy < 1001:
                            top = max(top, surface[(y + dy) * 1001 + x + dx] * 8)
                floating += t[(x, y)] > top + float(opts["ride_float"])
            if floating / len(path) > float(opts["ride_floating"]):
                failed["floating"] += 1
                judged[(a, b)] = None
                return False
            # The angle: the longest on screen over the most content, showing enough of the track,
            # with no window off the content box.
            best = None
            for r in range(4):
                if angle_weight(r, opts) <= 0:
                    continue
                va = {"x": a[0], "y": a[1], "z": a[2] + 16, "rotation": r}
                vb = {"x": b[0], "y": b[1], "z": b[2] + 16, "rotation": r}
                length = pan_length(va, vb) / 2 ** zoom
                fill = path_fill(rasters, va, vb, zoom, fill_win, land, samples) if rasters else 1.0
                edge = void = 0.0
                for i in range(samples + 1):
                    k = i / samples
                    vk = {"x": a[0] + (b[0] - a[0]) * k, "y": a[1] + (b[1] - a[1]) * k, "z": a[2] + (b[2] - a[2]) * k + 16,
                          "rotation": r}
                    edge = max(edge, outside_share(hulls[r], vk, zoom, screen))
                    if rasters:
                        void = max(void, frame_void(rasters, r, vk["x"], vk["y"], vk["z"], zoom, fill_win))
                cache = {}
                # Track under its own tile's ground (a tunnel) or under water (a boat ride's
                # channel) is not seen either.
                shown = sum(1 for tile in path if t[tile] >= surface[tile[1] * 1001 + tile[0]] * 8
                            and (not water or t[tile] >= water[tile[1] * 1001 + tile[0]] * 8)
                            and not hidden_tile(tile, t[tile] + 16, r, heights, surface, max_top, cache))
                visible = shown / len(path)
                score = length * fill * (0.7 + 0.3 * visible)
                if edge > edge_max:
                    failed["edge"] += 1
                elif void > void_max:
                    failed["void"] += 1
                elif fill < fill_min:
                    failed["fill"] += 1
                elif visible < visible_min:
                    failed["visible"] += 1
                elif best is None or score > best[0]:
                    best = (score, r, length, fill, visible, edge, void)
            judged[(a, b)] = best
            return best is not None
        run = None
        for part in track_parts(t):
            if len(part) < int(opts["ride_run"]):
                break
            run = track_run(part, box, opts, judge)
            if run or len(judged) >= int(opts["ride_tries"]):
                break
        if not run:
            if judged:
                turned_down.append({"ride": ride, "name": ride_name(ride), "tiles": len(t), "runs": len(judged),
                                    "failed": dict(failed)})
            continue
        chord, a, b, path = run
        score, r, length, fill, visible, edge, void = judged[(a, b)]
        # The trains' direction along the run: the heading of any train on it (its lead car's
        # facing and the sign of its speed; ride_heading each), else the build direction of
        # the run's track pieces, which on an out-and-back stretch can cancel out.
        ux, uy = (b[0] - a[0]) / chord, (b[1] - a[1]) / chord
        along = 0.0
        for (x, y, _), (piece_ride, direction) in pieces.items():
            if piece_ride == ride and (x, y) in path:
                along += DIRECTION_VECTORS[direction][0] * ux + DIRECTION_VECTORS[direction][1] * uy
        on_path = set(path)
        for vx, vy, _, v_ride, velocity, orientation in vehicles:
            if v_ride == ride and velocity and (vx, vy) in on_path:
                angle = orientation / 32 * 2 * math.pi
                along += float(opts["ride_heading"]) * (-math.cos(angle) * ux + math.sin(angle) * uy) * (1 if velocity > 0 else -1)
        if along < 0:
            a, b = b, a
        # The end view stops short of the run's end, so the pan does not run past the track.
        ex, ey = b[0] - a[0], b[1] - a[1]
        px_per_tile = pan_length({"x": 0, "y": 0, "z": 0, "rotation": r}, {"x": ex / chord, "y": ey / chord, "z": 0, "rotation": r})
        back = min(chord / 2, float(opts["ride_overshoot"]) * screen[0] * 2 ** zoom / max(px_per_tile, 1e-6))
        if back > 0:
            k = 1 - back / chord
            bx, by = a[0] + ex * k, a[1] + ey * k
            nearest = min(path, key=lambda q: math.hypot(q[0] - bx, q[1] - by))
            b = (round(bx), round(by), t[nearest])
        runs.append((score, ride, len(t), a, b, chord, r, length, fill, visible, edge, void, along, round(back, 1)))
    runs.sort(reverse=True)
    close = [v for v in views if not v.get("overview") and "animation" not in v and "show" not in v]
    report, added = [], []
    for score, ride, count, a, b, chord, r, length, fill, visible, edge, void, along, back in runs[:limit]:
        nearest = min(close, key=lambda v: math.hypot(v["x"] - a[0], v["y"] - a[1]), default=None)
        pair = []
        why = {"ride": ride, "name": ride_name(ride), "run": round(chord, 1), "trackTiles": count, "px": round(length),
               "fill": round(fill, 3), "visible": round(visible, 2), "edge": round(edge, 2), "void": round(void, 2),
               "direction": round(along, 1),
               "pulledBack": back}
        for end, (x, y, z) in enumerate((a, b)):
            pair.append({"x": x, "y": y, "z": z + 16, "zoom": zoom, "rotation": r, "fixed": True,
                         "hold": float(opts["view_time"]), "ride": ride, "ride_end": end,
                         "why": dict(why, end=end),
                         "_district": nearest.get("_district") if nearest else None})
        added.extend(pair)
        report.append(dict(why, **{"from": [a[0], a[1]], "to": [b[0], b[1]], "tiles": count, "rotation": r}))
    if turned_down:
        views[0].setdefault("why", {})["ridesTurnedDown"] = turned_down
    if not added:
        return views
    count = int(opts["count"])
    over = len(close) + len(added) // 2 - count  # a pair counts as one point of interest
    drop = []
    if over > 0:
        loose = sorted((v for v in close if not v.get("fixed")), key=lambda v: v["hold"])
        drop = loose[:over]
    views[0].setdefault("why", {})["rides"] = report
    rest = [v for v in views if "animation" in v or "show" in v]
    kept = [v for v in views if v not in rest and v not in drop]
    return kept + added + rest


def route_cost(a, b, opts):
    """A pan's cost in the circuit, seconds: its moving time (screen distance at the wider of its
    two zooms, over `route_speed` of the speed tolerance there) plus `route_change` for an angle
    change and per zoom level changed, and one more when it does both."""
    zoom = max(a["zoom"], b["zoom"])
    sa, sb = screen_point(a["x"] * 32, a["y"] * 32, a["z"], a["rotation"]), screen_point(b["x"] * 32, b["y"] * 32, b["z"], a["rotation"])
    px = math.hypot(sb[0] - sa[0], sb[1] - sa[1]) / 2 ** zoom
    threshold = float(opts["zoom_threshold"])
    tolerance = threshold if threshold else pan_tolerance(zoom, opts)
    turns, zooms = a["rotation"] != b["rotation"], abs(a["zoom"] - b["zoom"])
    # Angle and zoom on one pan is two stills: a change too many (plan: one thing at a time).
    return px / (float(opts["route_speed"]) * tolerance) + float(opts["route_change"]) * (turns + zooms + (turns and zooms))


def in_route(v):
    """Whether a view plays in the park's route: everything but shows and the companion
    animation views placed after the others (a continuous animation's view is a route stop,
    `fixed`; route_stops)."""
    return "show" not in v and ("animation" not in v or bool(v.get("fixed")))


def route_stops(views, opts):
    """Makes each view on a continuous companion animation (one without a cue: it plays whenever
    the camera is there) an ordinary stop of the park's route (owner, 2026-10-30): inserted where
    it adds the least route_cost between two neighbouring views, the return to the first view
    included but never inside a ride pair, and flagged `fixed` so the plugin plays it in place,
    as placed, panning in and out like the views around it. Event views (cues) and shows keep
    their places after the others."""
    stops = [v for v in views if "animation" in v and "cue" not in v and "show" not in v]
    route = [v for v in views if "animation" not in v and "show" not in v]
    if not stops or not route:
        for v in views:
            v.pop("_leg", None)
        return views
    for stop in stops:
        def added(i):
            a, b = route[i - 1], route[i % len(route)]
            return route_cost(a, stop, opts) + route_cost(stop, b, opts) - (route_cost(a, b, opts) if len(route) > 1 else 0)
        allowed = [i for i in range(1, len(route) + 1)
                   if not (i < len(route) and route[i - 1].get("_leg") is not None and route[i - 1]["_leg"] == route[i].get("_leg"))]
        stop["fixed"] = True
        if float(opts["pan"]) > 0:
            stop.setdefault("pan", float(opts["pan"]))  # pans on like the views around it (pan_timing may retime it)
        route.insert(min(allowed, key=lambda i: (added(i), i)), stop)
    for v in route:
        v.pop("_leg", None)
    return route + [v for v in views if not in_route(v)]


def route_legs(close):
    """The close-ups as legs of a route: a ride pair (ride_pans) is one leg, always in its own
    order (the trains' direction); every other view is a leg of its own. Indices into close."""
    legs, seen = [], set()
    for i, v in enumerate(close):
        if i in seen:
            continue
        if "ride" in v:
            other = [j for j, u in enumerate(close) if j != i and u.get("ride") == v["ride"] and j not in seen]
            if other:
                legs.append((i, other[0]))
                seen.update((i, other[0]))
                continue
        legs.append((i,))
        seen.add(i)
    return legs


def circuit_order(views, opts):
    """The generated views reordered into a closed circuit (plan: pan-based view generation,
    phase 2): the overview stays first, the close-up nearest its centre comes next, and the other
    close-ups follow in the order with the lowest cost over the closed loop (back to the first
    close-up), searched exhaustively. A pan's cost is its moving time (screen distance at the
    wider of its two zooms, over `route_speed` of the speed tolerance there) plus `route_change`
    seconds for an angle change and per zoom level changed; the loop's shape adds penalties
    (seconds) for what reads as a sweep rather than a tour: each pan beyond two in a straight
    run (within 30 degrees), two reversals (over 150 degrees) in a row, a pan running back
    alongside an earlier one (opposite heading, midpoints within 8 tiles), and a visit order
    sorted along an axis (rank correlation over 0.5, up to 10 s at 1), and `route_district`
    seconds for every return to a district the route left earlier (district_views); a pan
    that changes angle and zoom at once costs a change extra; each bend of 45-135 degrees earns a
    second back. Companion views (animations, shows) stay where they are, at the end."""
    import itertools
    first = [v for v in views if v.get("overview")][:1]
    close = [v for v in views if not v.get("overview") and "animation" not in v and "show" not in v]
    rest = [v for v in views if v not in first and v not in close]
    if len(close) < 3:
        return views
    legs = route_legs(close)
    pts = [(v["x"], v["y"], v["z"] / HEIGHT_PER_TILE) for v in close]

    def pan_cost(i, j):
        return route_cost(close[i], close[j], opts)
    n = len(close)
    district = [v.get("_district") for v in close]
    district_cost = float(opts["route_district"]) if None not in district else 0.0
    costs = [[pan_cost(i, j) if i != j else 0.0 for j in range(n)] for i in range(n)]
    headings = [[math.atan2(pts[j][1] - pts[i][1], pts[j][0] - pts[i][0]) if i != j else 0.0 for j in range(n)] for i in range(n)]
    moves = [[math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) > 0.5 for j in range(n)] for i in range(n)]

    def rank_correlation(values):
        m = len(values)
        ranks = {v: r for r, v in enumerate(sorted(range(m), key=lambda i: values[i]))}
        return 1 - 6 * sum((i - ranks[i]) ** 2 for i in range(m)) / (m * (m * m - 1))

    def shape(order):
        pans = list(zip(order, order[1:] + order[:1]))
        real = [(i, j) for i, j in pans if moves[i][j]]
        penalty = 0.0
        kinds = []
        for (i, j), (k, l) in zip(real, real[1:] + real[:1]):
            d = abs((headings[k][l] - headings[i][j] + math.pi) % (2 * math.pi) - math.pi)
            kinds.append("straight" if d < math.radians(30) else "reverse" if d > math.radians(150) else "bend")
            if math.radians(45) <= d <= math.radians(135):
                penalty -= 1.0
        run = 1
        for kind in kinds:
            run = run + 1 if kind == "straight" else 1
            if run >= 3:
                penalty += 4.0
        penalty += 6.0 * sum(1 for k1, k2 in zip(kinds, kinds[1:] + kinds[:1]) if k1 == k2 == "reverse")
        for a, (i, j) in enumerate(real):
            for k, l in real[a + 1:]:
                d = abs((headings[k][l] - headings[i][j] + math.pi) % (2 * math.pi) - math.pi)
                if d > math.radians(150):
                    mi = ((pts[i][0] + pts[j][0]) / 2, (pts[i][1] + pts[j][1]) / 2)
                    mk = ((pts[k][0] + pts[l][0]) / 2, (pts[k][1] + pts[l][1]) / 2)
                    if math.hypot(mi[0] - mk[0], mi[1] - mk[1]) < 8:
                        penalty += 4.0
        if n >= 4:
            sweep = max(abs(rank_correlation([pts[i][0] for i in order])), abs(rank_correlation([pts[i][1] for i in order])))
            if sweep > 0.5:
                penalty += 20.0 * (sweep - 0.5)
        if district_cost:  # every district once: a return to one left earlier costs
            runs = sum(1 for i, j in zip(order, order[1:] + order[:1]) if district[i] != district[j])
            penalty += district_cost * max(0, runs - len(set(district)))
        return penalty

    def cost(order):
        return sum(costs[i][j] for i, j in zip(order, order[1:] + order[:1])) + shape(order)
    centre = first[0] if first else {"x": statistics.mean(p[0] for p in pts), "y": statistics.mean(p[1] for p in pts)}
    nearest = min(range(n), key=lambda i: (math.hypot(pts[i][0] - centre["x"], pts[i][1] - centre["y"]), i))
    start = next(leg for leg in legs if nearest in leg)
    others = [leg for leg in legs if leg != start]
    wanted, margin = max(1, int(opts["circuit_variants"])), float(opts["variant_margin"])
    best, near = None, []
    for perm in itertools.permutations(others):
        order = [i for leg in (start,) + perm for i in leg]  # a ride pair keeps its order: the trains' way
        if order[1] > order[-1] and len(order) == len(legs):  # a loop and its reverse cost the same: keep one
            continue
        c = cost(order)
        if best is None or c < best[0] - 1e-9:
            best = (c, order)
            near = [(c2, o2) for c2, o2 in near if c2 <= c * (1 + margin)]
        if wanted > 1 and c <= best[0] * (1 + margin):
            near.append((c, order))
    orders = [best[1]]
    for c, order in sorted(near):
        if len(orders) >= wanted:
            break
        if order not in orders:
            orders.append(order)
    if opts["circuit_reverse"] and all(len(leg) == 1 for leg in legs):  # a reversed loop would run a ride pair backwards
        orders += [[o[0]] + o[1:][::-1] for o in list(orders)]
    if len(orders) > 1:
        views[0].setdefault("_variants", []).extend(first + [close[i] for i in o] + rest for o in orders[1:])
    return first + [close[i] for i in orders[0]] + rest


def path_fill(rasters, a, b, zoom, screen, land, samples):
    """Mean frame fill of windows along the straight pan from view a to view b at a zoom, in
    a's angle (changes come at the end of a pan): the share of the band the pan sweeps that
    shows content (plan: pan-based view generation, phase 4)."""
    total = 0.0
    for i in range(samples):
        t = (i + 0.5) / samples
        total += frame_fill(rasters, a["rotation"], a["x"] + (b["x"] - a["x"]) * t, a["y"] + (b["y"] - a["y"]) * t,
                            a["z"] + (b["z"] - a["z"]) * t, zoom, screen, land)
    return total / samples


def pan_length(a, b):
    """Zoom-0 screen pixels a pan from view a to view b covers, in a's angle."""
    sa = screen_point(a["x"] * 32 + 16, a["y"] * 32 + 16, a["z"], a["rotation"])
    sb = screen_point(b["x"] * 32 + 16, b["y"] * 32 + 16, b["z"], a["rotation"])
    return math.hypot(sb[0] - sa[0], sb[1] - sa[1])


def nudge_pans(views, pool, opts):
    """Phase 4 of the pan-based generation plan, pans over content: each generated close-up's
    anchor may move within `nudge` of its cell (a quarter: the anchor of a spot can move that far
    without losing much of its score) to the offset where the pans into and out of it sweep the
    most content (path_fill, at the zoom each pan runs at), as long as its own frame fill keeps
    `nudge_keep` of what it had. Towers, beads, companion views and the overview stay (the
    overview's zoom is fitted in play, so its pan is not planned here); the return pan is a
    special case. Views are taken in play order, each seeing the ones before it moved.
    Records the moves on the overview's `why` for the scores file."""
    rasters = pool.get("rasters") if pool else None
    share = float(opts["nudge"])
    if not share or rasters is None:
        return views
    screen = tuple(int(n) for n in opts["screen"])
    fill_win = fill_screen(opts)
    land, keep, samples = float(opts["fill_land"]), float(opts["nudge_keep"]), max(1, int(opts["path_samples"]))

    def movable(v):
        return not (v.get("overview") or v.get("fixed") or v.get("bead") or "ride" in v or "animation" in v or "show" in v)

    def path(a, b):
        return path_fill(rasters, a, b, max(a["zoom"], b["zoom"]), fill_win, land, samples)

    report = []
    for i, v in enumerate(views):
        if not movable(v):
            continue
        pans = [(views[i - 1], None)] if i > 0 and not views[i - 1].get("overview") else []
        if i + 1 < len(views):
            pans.append((None, views[i + 1]))
        # Only pans at least a quarter screen long count: shorter ones the plugin cuts or barely
        # moves, and nudging their ends would only make the camera wobble between angles.
        pans = [(a, b) for a, b in pans if pan_length(a or v, b or v) >= screen[0] * 2 ** max((a or v)["zoom"], (b or v)["zoom"]) / 4]
        if not pans:
            continue
        own = frame_fill(rasters, v["rotation"], v["x"], v["y"], v["z"], v["zoom"], fill_win, land)
        reach = share * 32 * 2 ** v["zoom"]  # tiles
        steps = sorted({round(reach * k / 2) for k in (-2, -1, 0, 1, 2)})
        best, start = None, None
        for dx in steps:
            for dy in steps:
                moved = {**v, "x": v["x"] + dx, "y": v["y"] + dy}
                fill = own if not (dx or dy) else frame_fill(rasters, v["rotation"], moved["x"], moved["y"], v["z"], v["zoom"], fill_win, land)
                if fill < keep * own:
                    continue
                score = sum(path(a or moved, b or moved) for a, b in pans) / len(pans)
                if not (dx or dy):
                    start = score
                if best is None or score > best[0] + 1e-9 or (score > best[0] - 1e-9 and abs(dx) + abs(dy) < abs(best[1]) + abs(best[2])):
                    best = (score, dx, dy, fill)
        if best is None or start is None or not (best[1] or best[2]) or best[0] < start + 0.01:
            continue
        v["x"], v["y"] = v["x"] + best[1], v["y"] + best[2]
        move = {"from": [v["x"] - best[1], v["y"] - best[2]], "to": [v["x"], v["y"]], "path": [round(start, 3), round(best[0], 3)],
                "fill": [round(own, 3), round(best[3], 3)]}
        v.setdefault("why", {})["nudge"] = move
        report.append(move)
    if report:
        views[0].setdefault("why", {})["nudges"] = report
    return views


def bead_views(views, pool, opts):
    """Phase 4 of the pan-based generation plan, beads: a pan between two close-ups longer than
    bead_seconds of travel (at route_speed of the tolerance at the zoom it runs at, the wider
    of the two) gets a pass-through view on the way, from the spots the picker left unchosen
    (the pool's candidates from the same angle at that zoom) that lie between a quarter and
    three quarters of the way along, within bead_band of the screen's height off the line, and
    at least a quarter screen from either end (the plugin merges closer views), the best score
    first. A bead rests bead_still and pans on (bead_pan), its hold on top of the park's time;
    the stretch and the plugin's pull-back still cover what is left over the tolerance. Only
    generated close-ups get beads: the overview's pan and the return are special cases.
    A pan with no such spot at its zoom takes one from the closer zoom levels, or failing those
    the next wider one, shown at the pan's zoom. Records the pans over the band and the beads on the overview's `why` for the scores file."""
    if not opts["beads"] or pool is None:
        return views
    screen = tuple(int(n) for n in opts["screen"])
    speed = float(opts["route_speed"])
    threshold = float(opts["zoom_threshold"])
    band_px = float(opts["bead_seconds"]) * speed
    off_max = float(opts["bead_band"]) * screen[1]
    close = [v for v in views if not v.get("overview") and "animation" not in v and "show" not in v]
    taken = {(round(v["x"]), round(v["y"])) for v in views}
    report, out = [], list(views)
    hold = round(float(opts["bead_still"]) / (1 - float(opts["bead_pan"])), 3)
    for a, b in zip(close, close[1:]):
        if "ride" in a and a.get("ride") == b.get("ride"):
            continue  # a pan along a ride follows the track, whatever its length
        zoom = max(a["zoom"], b["zoom"])
        tolerance = threshold if threshold else pan_tolerance(zoom, opts)
        r = a["rotation"]
        sa, sb = screen_point(a["x"] * 32 + 16, a["y"] * 32 + 16, a["z"], r), screen_point(b["x"] * 32 + 16, b["y"] * 32 + 16, b["z"], r)
        length = math.hypot(sb[0] - sa[0], sb[1] - sa[1])  # zoom-0 px
        on_screen = length / 2 ** zoom
        if on_screen <= band_px * tolerance:
            continue
        entry = {"from": [a["x"], a["y"]], "to": [b["x"], b["y"]], "zoom": zoom, "px": round(on_screen), "band": round(band_px * tolerance)}
        margin = max(screen[0] * 2 ** zoom / 4, 0.0)
        best = None
        closer = [level for level in sorted(pool["levels"], reverse=True) if level <= zoom] + ([zoom + 1] if zoom + 1 in pool["levels"] else [])
        for level in closer:
            if best is not None:
                break
            for c in pool["levels"][level]:
                if c[5] != r or (round(c[1]), round(c[2])) in taken:
                    continue
                sc = screen_point(c[1] * 32 + 16, c[2] * 32 + 16, c[3], r)
                t = ((sc[0] - sa[0]) * (sb[0] - sa[0]) + (sc[1] - sa[1]) * (sb[1] - sa[1])) / (length * length)
                if not 0.25 <= t <= 0.75 or t * length < margin or (1 - t) * length < margin:
                    continue
                off = abs((sc[0] - sa[0]) * (sb[1] - sa[1]) - (sc[1] - sa[1]) * (sb[0] - sa[0])) / length
                if off > off_max * 2 ** zoom:
                    continue
                if best is None or c[0] > best[0][0]:
                    best = (c, t, off)
        if best is None:
            report.append({**entry, "bead": None})
            continue
        c, t, off = best
        bead = {"x": round(c[1]), "y": round(c[2]), "z": round(c[3]), "zoom": zoom, "rotation": r, "hold": hold,
                "pan": float(opts["bead_pan"]), "bead": True,
                "why": {"bead": True, "spot": round(c[6], 3), "seen": round(c[7], 3), "fill": round(c[10], 3), "along": round(t, 2),
                        "off": round(off / 2 ** zoom), "level": closer[[c in pool["levels"][lv] for lv in closer].index(True)],
                        "pan": entry}}
        out.insert(out.index(b), bead)
        taken.add((bead["x"], bead["y"]))
        report.append({**entry, "bead": [bead["x"], bead["y"]], "along": round(t, 2)})
    if report:
        views[0].setdefault("why", {})["beads"] = report
    return out


def pan_timing(views, opts):
    """Phase 5 of the pan-based generation plan, timing from pan length: each generated view's
    hold becomes its still time (the park's time split by score, as spot_holds gave it; a bead's
    `bead_still`) plus the moving time of its pan to the next view, the pan's length at the zoom
    it runs at (plan_pan, as the plugin plays it, the return pan's zoom-out included) over
    `route_speed` of the tolerance there, at least `move_min`; the pan share follows. The park's
    time grows with the moving time, up to `park_cap`: over it beads go first (lowest spot score),
    then the lowest-scoring close-ups (never the overview, towers, companion views or the first
    close-up), the still budget shrinking by view_time with each; route stops (route_stops) are
    left out of the cap, their stills and pans alike. The overview keeps its own pan
    (exempt from the tolerance, zoom fitted in play) and views on shows do not pan. Any `pan` > 0
    turns this on; the plugin adds its change holds on top. Records the park's still and moving
    time and what was dropped on the overview's `why`."""
    if not opts["pan_timing"] or float(opts["pan"]) <= 0 or len(views) < 2:
        return views
    speed, move_min = float(opts["route_speed"]), float(opts["move_min"])
    cap = float(opts["park_cap"]) / float(opts["time_scale"])  # park_cap is in scaled seconds (scale_time)
    minimum, base = float(opts["view_time"]), int(opts["base_views"])
    probe = 10 ** 7  # ms: long enough for the planner to keep the pan at its base zoom

    def stills(views):
        return {id(v): float(opts["bead_still"]) if v.get("bead") else v["hold"] for v in views}

    def timed(views, still):
        out, moving = [], 0.0
        for a, b, returning in pan_pairs(views):
            if a.get("overview") or not in_route(a):
                out.append((a, still[id(a)], None))  # played as set
                continue
            planned = plan_pan(a, b, probe, opts, returning)
            if planned is None:
                out.append((a, still[id(a)], 0.0))  # the same spot: the plugin cuts
                continue
            zoom, px_per_s, tolerance = planned
            move = max(move_min, px_per_s * probe / 1000 / (speed * tolerance))
            moving += move
            out.append((a, still[id(a)], move))
        if not any(v is views[-1] for v, _, _ in out):
            out.append((views[-1], still[id(views[-1])], None))  # a show, or a park of one view
        return out, moving

    still = stills(views)
    dropped = []
    while True:
        # Event views are exempt from the cap (owner, 2026-10-31): what drops is decided on the
        # route without its stops (continuous animations' views), so including or leaving out
        # event views at build time never changes which ordinary views play.
        plan, moving = timed([v for v in views if "animation" not in v], still)
        total = sum(s + (m or 0) for v, s, m in plan if in_route(v))
        if total <= cap:
            break
        beads = [v for v in views if v.get("bead")]
        pool = beads or [v for v in views[2:] if not (v.get("overview") or v.get("fixed") or "animation" in v or "show" in v)]
        if not pool:
            break
        victim = min(pool, key=lambda v: v["why"].get("spot", 0) if v.get("bead") else still[id(v)])
        dropped.append({"x": victim["x"], "y": victim["y"], "bead": bool(victim.get("bead"))})
        views = [v for v in views if v is not victim]
        if not victim.get("bead"):
            # The still budget loses view_time with the view: the rest shrink in proportion.
            unpinned = [v for v in views if not v.get("bead") and "animation" not in v and "show" not in v]
            before = sum(still[id(v)] for v in unpinned) + still[id(victim)]
            after = max(float(opts["park_time"]) + max(0, len(unpinned) - base) * minimum, len(unpinned) * minimum)
            if before > 0 and after < before:
                for v in unpinned:
                    still[id(v)] = round(still[id(v)] * after / before, 2)
    plan, moving = timed(views, still)
    for v, s, move in plan:
        if move is None:
            continue
        v["hold"] = round(s + move, 2)
        if move:
            v["pan"] = round(move / v["hold"], 4)
        else:
            v.pop("pan", None)  # the same spot: the plugin cuts
        v.setdefault("why", {})["timing"] = {"still": round(s, 2), "move": round(move, 2)}
    views[0].setdefault("why", {})["timing"] = {
        "still": round(sum(s for v, s, m in plan if in_route(v)), 1),
        "moving": round(moving, 1), "cap": cap, "dropped": dropped}
    return views


def park_duration(views, opts):
    """The settings UI's park duration and time scaling, after pan_timing and stretch_pans: a park
    longer than park_cap that pan_timing did not time (static views, route = "random") has its holds
    shortened in proportion; a park shorter than park_min has its still times grown in proportion,
    its pans keeping their moving time; then every hold of the route (its stops included) is
    multiplied by time_scale, pan shares unchanged. park_min and park_cap count scaled seconds.
    Event views (cues, shows, animations off the route) keep their time."""
    scale = float(opts["time_scale"])
    if scale <= 0:
        raise ValueError("time_scale must be above 0")
    route = [v for v in views if in_route(v) and "cue" not in v]
    total = sum(v["hold"] for v in route)
    if not route or total <= 0:
        return views
    cap, floor = float(opts["park_cap"]) / scale, float(opts["park_min"]) / scale
    timed = bool(views[0].get("why", {}).get("timing"))
    if not timed and total > cap:
        for v in route:
            v["hold"] = round(v["hold"] * cap / total, 2)
    elif total < floor:
        moving = sum(v.get("pan", 0) * v["hold"] for v in route)
        still = total - moving
        grow = (floor - moving) / still if still > 0 else 1
        for v in route:
            move = v.get("pan", 0) * v["hold"]
            v["hold"] = round((v["hold"] - move) * grow + move, 2)
            if move:
                v["pan"] = round(move / v["hold"], 4)
    if scale != 1:
        for v in route:
            v["hold"] = round(v["hold"] * scale, 2)
    return views


def route_metrics(views):
    """How a park's views are laid out as a route, for judging generation for panning (plan:
    pan-based view generation, phase 1). The route is the close-ups in play order plus the return
    to the first view, in tile space with height as HEIGHT_PER_TILE. Returns None under two
    close-ups, else: `length` (tiles, the closed route), `shortest` (tiles, the shortest closed
    order over the same views, exhaustive up to 9), `turns` (pans that change angle), `zooms`
    (pans that change zoom, and `zoomSteps`, the levels changed in all), `headings` (the bends
    between consecutive pans: `straight` under 30 degrees, `bend` 30-150, `reverse` over 150),
    `straightRuns` (3+ consecutive pans within 30 degrees of each other), `doubleReversals`
    (two reversals in a row: a raster), `sweep` (the strongest rank correlation of the visit
    order with the x or y position, 0 for a loop, 1 for a sweep across the park; 0 under 4 views)."""
    close = [v for v in views if not v.get("overview") and not v.get("show") and not is_cut(v)]
    if len(close) < 2:
        return None
    pts = [(v["x"], v["y"], v["z"] / HEIGHT_PER_TILE) for v in close]

    def dist(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1])

    def loop_length(order):
        return sum(dist(pts[i], pts[j]) for i, j in zip(order, order[1:] + order[:1]))
    order = list(range(len(pts)))
    length = loop_length(order)
    shortest = length
    if len(pts) <= 9:
        import itertools
        shortest = min(loop_length([0] + list(rest)) for rest in itertools.permutations(order[1:]))
    pans = list(zip(close, close[1:] + close[:1]))
    turns = sum(1 for a, b in pans if a["rotation"] != b["rotation"])
    zooms = sum(1 for a, b in pans if a["zoom"] != b["zoom"])
    zoom_steps = sum(abs(a["zoom"] - b["zoom"]) for a, b in pans)
    headings = []
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        if dist(a, b) > 0.5:
            headings.append(math.atan2(b[1] - a[1], b[0] - a[0]))
    bends = {"straight": 0, "bend": 0, "reverse": 0}
    kinds = []
    for h1, h2 in zip(headings, headings[1:] + headings[:1]):
        d = abs((h2 - h1 + math.pi) % (2 * math.pi) - math.pi)
        kind = "straight" if d < math.radians(30) else "reverse" if d > math.radians(150) else "bend"
        bends[kind] += 1
        kinds.append(kind)
    runs = 0
    run = 1
    for kind in kinds:  # a run of n straight bends is n + 1 pans in line
        run = run + 1 if kind == "straight" else 1
        if run == 3:
            runs += 1
    doubles = sum(1 for k1, k2 in zip(kinds, kinds[1:]) if k1 == k2 == "reverse")

    def rank_correlation(values):
        n = len(values)
        if n < 3:
            return 0.0
        ranks = {v: r for r, v in enumerate(sorted(range(n), key=lambda i: values[i]))}
        d2 = sum((i - ranks[i]) ** 2 for i in range(n))
        return 1 - 6 * d2 / (n * (n * n - 1))
    sweep = max(abs(rank_correlation([p[0] for p in pts])), abs(rank_correlation([p[1] for p in pts]))) \
        if len(pts) >= 4 and length >= 1 else 0.0  # meaningless for a few or stacked views
    return {"length": round(length), "shortest": round(shortest), "turns": turns, "zooms": zooms,
            "zoomSteps": zoom_steps, "headings": bends, "straightRuns": runs, "doubleReversals": doubles,
            "sweep": round(sweep, 2)}


def screen_point(x, y, z, rotation):
    """World point to zoom-0 screen pixels (plugin/src/fit.ts toScreen)."""
    a, b = ((x, y), (y, -x), (-x, -y), (-y, x))[rotation % 4]
    return b - a, (a + b) / 2 - z


def resolve_park(entry, index, base_dir, defaults, layout, edits=None, library=None,
                 park_profiles=None, park_plugins=False):
    path = os.path.join(base_dir, entry["file"])
    key = park_key(entry)
    member, data = parkinfo.read_park_bytes(path, entry.get("member"))
    hdr, chunks, body = parkinfo.load(data)
    # The name saved in the park, unless the playlist gives one; a working title ("... Workbench
    # 2023") falls back to the logo in the park's zip or the zip's name.
    saved_name = parkinfo.parse_park(parkinfo.chunk_reader(chunks, body, 6), hdr["target"])["name"]
    saved = parkinfo.parse_interface(parkinfo.chunk_reader(chunks, body, 0x20))
    # The park's profile (parks/*.toml) goes under the playlist's own entry.
    profile = profiles.find(park_profiles or {}, entry, saved_name, map_size(parkinfo.chunk_reader(chunks, body, 0x30)),
                            os.path.basename(entry["file"]))
    entry = profiles.apply(profile, entry, park_plugins)
    name = entry.get("name") or parkinfo.display_name(saved_name, path, member)[0]  # the profile's name under the entry's
    # The builders for the caption's byline: the entry's (written at import or scan), else checked against the
    # New Element Designs catalogue and the download's name now (owner, 2026-11-03).
    author, author_note = entry.get("author"), None
    if not author:
        found = parkinfo.download_authors(path, member, saved_name)
        if found:
            author = ", ".join(found)
            author_note = "builders not in the playlist; from the NE catalog or the file name: %s" % author
        else:
            author_note = "no builders: none in the playlist, and the file matches nothing in the NE catalog (the caption shows the name alone)"
    _, counts, surface, heights = parkinfo.visible_element_counts(parkinfo.chunk_reader(chunks, body, 0x30))
    opts = {**defaults, **entry.get("views", {}), "saved_rotation": saved["rotation"]}
    if opts["route"] == "random":
        opts.update(RANDOM_OFF)
    if opts["motion"] == "static":
        opts.update(STATIC)
    elif opts["motion"] != "pans":
        raise ValueError("%s: motion must be \"pans\" or \"static\"" % name)
    if opts["pan"] == "auto":
        opts.update(pan=AUTO_PAN, pan_timing=True)
    if opts["companion_pans"] not in ("run", "pause"):
        raise ValueError("%s: companion_pans must be \"run\" or \"pause\"" % name)
    if entry.get("companions", "auto") == []:
        opts["events"] = False  # none of its companions runs (companions = [], or park_scripts = false)
    if not opts["events"]:
        # No views on companions' animations or shows; companions still run (unless companions = false)
        entry = dict(entry, animations=False, show=None)
    if opts["pan_changes"] not in PAN_CHANGES:
        raise ValueError("%s: pan_changes must be \"start\", \"end\" or \"off\"" % name)
    if opts["track_activity"] != "all":
        still_track(heights, parkinfo.track_rides(parkinfo.chunk_reader(chunks, body, 0x30)),
                    parkinfo.parse_vehicles(parkinfo.chunk_reader(chunks, body, 0x31)),
                    0 if opts["track_activity"] == "moving" else float(opts["track_activity"]))
    if opts["large_scenery"] == "object":
        large_scenery_once(heights, parkinfo.large_scenery_pieces(parkinfo.chunk_reader(chunks, body, 0x30)))

    # Playlist views: the TOML's own list, or generated. Views from the editor replace them on
    # screen, but they are kept too so the editor can go back to them.
    views = entry.get("view")
    source = "explicit"
    if not views:
        method = VIEW_METHODS.get(opts["method"])
        if method is None:
            raise ValueError("unknown view method %r (known: %s)" % (opts["method"], ", ".join(VIEW_METHODS)))
        views = method(counts, heights, surface, opts, water=parkinfo.water_heights(parkinfo.chunk_reader(chunks, body, 0x30)),
                       map_wh=map_size(parkinfo.chunk_reader(chunks, body, 0x30)))
        source = opts["method"]
        views = ride_pans(views, parkinfo.track_rides(parkinfo.chunk_reader(chunks, body, 0x30)),
                          parkinfo.track_pieces(parkinfo.chunk_reader(chunks, body, 0x30)),
                          parkinfo.parse_vehicles(parkinfo.chunk_reader(chunks, body, 0x31)),
                          heights, surface, content_bounds(counts, heights, surface), opts,
                          info=parkinfo.parse_rides(parkinfo.chunk_reader(chunks, body, 0x32), hdr["target"])
                          if parkinfo.chunk_reader(chunks, body, 0x32) else {},
                          water=parkinfo.water_heights(parkinfo.chunk_reader(chunks, body, 0x30)))
        if opts["only"] == "rides":  # a test playlist of the ride pans alone
            views = [v for v in views if v.get("overview") or "ride" in v]
        elif opts["only"] != "all":
            raise ValueError("%s: only must be \"all\" or \"rides\"" % name)
        if opts["route"] == "circuit":
            views = circuit_order(views, opts)
        elif opts["route"] not in ("picks", "random"):
            raise ValueError("%s: route must be \"circuit\", \"random\" or \"picks\"" % name)
        elif opts["circuit_reverse"] and len(views) > 2:
            # The pick order has no alternatives to offer (circuit_variants), but its reverse is one
            views[0]["_variants"] = [views[:1] + views[:0:-1]]
        pool = views[0].pop("_pool", None) if views else None
        variants = [views] + (views[0].pop("_variants", []) if views else [])
        for i, vs in enumerate(variants):
            vs = [dict(v, why=dict(v.get("why", {}))) for v in vs]  # each order places and times its own copies
            vs = nudge_pans(vs, pool, opts)
            variants[i] = bead_views(vs, pool, opts)
        views = variants[0]

    def resolve(views, exact):
        resolved = []
        for i, v in enumerate(views):
            rotation = v.get("rotation", opts["rotation"])
            if rotation == "keep":
                rotation = saved["rotation"]
            elif rotation in ("cycle", "auto"):
                rotation = (saved["rotation"] + i) % 4
            zoom = v.get("zoom", opts["zoom"])
            if zoom == "keep":
                zoom = saved["zoom"]
            # Whole tiles, except views from the editor, which keep the camera's exact position.
            x, y = (round(float(v["x"]), 2), round(float(v["y"]), 2)) if exact else (int(v["x"]), int(v["y"]))
            # An editor view is a point on the camera's line of sight at its height z, which can
            # lie off the map for a view of tall content near the edge; the camera is still right.
            lo, hi = (-1001, 2002) if exact and "z" in v else (0, 1001)
            if not (lo <= x < hi and lo <= y < hi):
                raise ValueError("%s: view (%g, %g) is outside the map" % (name, x, y))
            if layout == "stock" and not (0 <= x <= MAX_LOCATION and 0 <= y <= MAX_LOCATION):
                raise ValueError("%s: view (%g, %g) is beyond the stock title sequence limit of %d; "
                                 "use the plugin layout" % (name, x, y, MAX_LOCATION))
            # Height defaults to the ground at the view's tile, matching the built-in LOCATION.
            z = int(v["z"]) if "z" in v else surface[int(y) * 1001 + int(x)] * 8
            view = {"x": x, "y": y, "z": z, "rotation": int(rotation) % 4, "zoom": int(zoom),
                    "hold": float(v.get("hold", opts["hold"]))}
            if exact and v.get("manual"):
                view["manual"] = True  # placed by hand in the editor
            if v.get("overview"):
                view["overview"] = True  # the plugin zooms it to fit the window
            overview = v.get("overview") and not exact  # a generated or listed overview
            pan = float(v.get("pan", opts["overview_pan"] if overview else opts["pan"]))
            if not 0 <= pan <= 1:
                raise ValueError("%s: pan must be between 0 and 1" % name)
            if pan > 0:
                view["pan"] = pan  # share of the hold spent panning on to the next view
                # How it pans, where it differs from the plugin's defaults (views from the
                # editor or drawviews keep what they set)
                opt = "overview_pan_changes" if overview else "pan_changes"
                changes = v.get("panChanges", v.get("pan_changes", opts[opt]))  # editor files: panChanges
                if changes not in PAN_CHANGES or (overview and changes == "off"):
                    raise ValueError("%s: pan_changes must be \"start\", \"end\" or (not for overviews) \"off\"" % name)
                if changes != "end":
                    view["panChanges"] = changes
                if opts["inertia"]:
                    view["inertia"] = True  # starts and stops slowly (playlist-wide, owner 2026-11-02: not per view)
                threshold = float(v.get("zoomThreshold", v.get("zoom_threshold", opts["zoom_threshold"])))
                if threshold > 0:
                    view["zoomThreshold"] = threshold  # replaces the tolerance
            if v.get("fixed"):
                view["fixed"] = True  # a tower view: the plugin neither moves nor merges it
            if v.get("bead"):
                view["bead"] = True  # a pass-through view on a long pan (bead_views), for the reports
            if "ride" in v:
                view["_leg"] = v["ride"]  # a ride pair: route_stops keeps it together
            if "animation" in v:
                view["animation"] = str(v["animation"])  # on a companion's animation: kept as placed
            if "show" in v:
                definition = companions.find_show(v["show"], found, saved_name)
                view["show"] = {"action": companions.show_action(definition["companion"]), "name": v["show"]}
            if "why" in v:
                view["why"] = v["why"]  # score breakdown, for the .scores.json file only
            resolved.append(view)
        return resolved

    found = companions.find(entry, base_dir, member)
    storage_chunk = parkinfo.chunk_reader(chunks, body, 0x38)
    storage = json.loads(storage_chunk.str()) if storage_chunk else {}
    size = map_size(parkinfo.chunk_reader(chunks, body, 0x30))
    track_all = {(x, y, ride) for (x, y, _), ride in
                 parkinfo.track_rides(parkinfo.chunk_reader(chunks, body, 0x30), invisible=True).items()}
    found = companions.complete(found, library, storage, track_all, entry)
    companion_settings = profiles.companion_settings(profile)
    if opts["companion_pans"] == "pause":
        for label, code in found:
            companion_settings.setdefault(companions.metadata(code, label)["name"], {}).setdefault("pause", True)
    track = parkinfo.track_rides(parkinfo.chunk_reader(chunks, body, 0x30)) if entry.get("animations") else {}
    timed = []
    animations = []  # every animation the park's companions have, and what became of it
    for i, vs in enumerate(variants if source != "explicit" else [views]):
        d = resolve(vs, False) + companion_views(
            entry, found, storage, saved_name, heights, surface, saved["rotation"], opts["hold"], track, track_all,
            float(opts["show_pan"]), animations if i == 0 else None, float(opts["pan"]))
        d = place_shows(route_stops(d, opts) if source != "explicit" else d)
        if source != "explicit":
            d = pan_timing(d, opts)  # each generated view's time from its pan's length
        # Generated pans too fast for the speed tolerance get more time (listed views play as listed).
        stretched_pans = stretch_pans(d, opts) if source != "explicit" else (0, 0.0)
        if source != "explicit":
            d = park_duration(d, opts)
        timed.append((place_cuts(d) if source != "explicit" else d, stretched_pans))
    defaults, stretched = timed[0]
    # Alternative circuit orders (circuit_variants): the plugin plays a different one per visit.
    alternatives = [{"views": d, "parkTime": round(sum(v["hold"] for v in d if in_route(v)), 1)}
                    for d, _ in timed[1:]]
    # Views on companion animations and shows play as placed, on top of the park's own time; route
    # stops on continuous animations count with the park's views.
    unpinned = [v for v in defaults if in_route(v)]
    edited = (edits or {}).get(key)
    edited_views = None
    if edited:
        # Drawn views play as drawn (their holds kept), with the park's event views (animation
        # spots, cut-ins, shows) on top where events are on, placed as on generated views (owner,
        # 2026-11-01). Event views saved with an edit are left out: the park's current ones replace them.
        drawn = resolve([v for v in edited["views"] if not (v.get("animation") or v.get("show") or v.get("cue"))], True)
        extra = companion_views(entry, found, storage, saved_name, heights, surface, saved["rotation"], opts["hold"],
                                track, track_all, float(opts["show_pan"]), None, float(opts["pan"])) if drawn else []
        edited_views = place_cuts(place_shows(route_stops(drawn + extra, opts))) if extra else drawn
    box = content_bounds(counts, heights, surface)
    bounds = box if opts["fit"] else None
    warnings = [author_note] if author_note else []
    if entry.get("animations"):
        names = {a["name"] for a in animations}
        for unknown in sorted(set(entry.get("animation_overrides") or {}) - names):
            warnings.append("profile changes animation %s, which the park's companions don't have (see --animations)"
                            % json.dumps(unknown))
    for label, listed in (("view", defaults if source == "explicit" else []),
                          ("editor view", [v for v in edited_views if "animation" not in v and "show" not in v] if edited else [])):
        for i, v in enumerate(listed):
            if box and not v.get("overview") and outside_content(v, box):
                warnings.append("%s %d at (%g, %g) looks outside the park's content" % (label, i + 1, v["x"], v["y"]))
    return {"key": key, "name": name, "author": author, "member": member, "data": data, "savedRotation": saved["rotation"],
            "profile": profile["id"] if profile else None,
            "warnings": warnings,
            "stretched": stretched,
            "beads": (len([q for q in (defaults[0].get("why", {}).get("beads", []) if defaults else [])]),
                      sum(1 for v in defaults if v.get("bead"))),
            "nudged": len(defaults[0].get("why", {}).get("nudges", [])) if defaults else 0,
            "timing": defaults[0].get("why", {}).get("timing") if defaults else None,
            "rides": len(defaults[0].get("why", {}).get("rides", [])) if defaults else 0,
            "variants": alternatives,
            "panTolerance": [float(opts["pan_tolerance"]), float(opts["pan_tolerance_step"])],
            "returnPan": bool(opts["return_pan"]),
            "pans": pan_speeds(edited_views if edited else defaults, opts),
            "route": route_metrics(edited_views if edited else defaults),
            "animations": animations,
            # Companion plugins find their park by its saved name and map size.
            "savedName": saved_name, "mapSize": size, "hasStorage": bool(storage),
            "companions": found,
            "companionCamera": bool(entry.get("companion_camera", False)),
            "companionSettings": companion_settings,
            "fileName": "%02d-%s.park" % (index + 1, slug(name)),
            "views": edited_views if edited else defaults,
            "defaultViews": defaults if edited else None, "source": "editor" if edited else source,
            # The window hand-set views were set in (the plugin keeps their framing in another).
            "viewScreen": edited.get("screen") if edited else None,
            "bounds": bounds, "box": box, "viewCount": len(unpinned) if opts["only"] == "rides" else max(len(unpinned), int(opts["base_views"])) if source == "spots"
            else int(opts["count"]) if source != "explicit" else len(unpinned),
            # The plugin keeps a park's generated views playing this long when fitting merges some.
            "parkTime": round(sum(v["hold"] for v in unpinned), 1) if source == "spots" else None}


class Script:
    """script.txt writer that tracks command indices as OpenRCT2 parses them
    (one per non-blank, non-comment line)."""

    def __init__(self):
        self.lines = []
        self.commands = 0

    def comment(self, text=""):
        self.lines.append("# " + text if text else "")

    def command(self, text):
        self.lines.append(text)
        self.commands += 1
        return self.commands - 1

    def wait(self, ms):
        remaining = max(1, round(ms))
        while remaining > 0:
            chunk = min(remaining, MAX_WAIT_MS)
            self.command("WAIT %d" % chunk)
            remaining -= chunk

    def text(self):
        return "\n".join(self.lines) + "\n"


def write_script(parks, playlist_name, layout):
    """Return script.txt contents; records each park's LOAD command index in park["load"]."""
    s = Script()
    s.comment("Generated by tools/mksequence.py from %s (%s layout) - edit the playlist, not this file."
              % (playlist_name, layout))
    for park in parks:
        # Comments go on their own line: LOAD takes the rest of the line as the file name.
        s.comment()
        s.comment("%s (%s), views: %s" % (park["name"], park["member"], park["source"]))
        park["load"] = s.command("LOAD " + park["fileName"])
        rotation = park["savedRotation"]
        zoom = None
        views = park["views"] if layout == "stock" else park["views"][:1]
        for v in views:
            # ZOOM is unsigned; the closer zoom levels the editor allows are set by the plugin.
            if max(0, v["zoom"]) != zoom:
                zoom = max(0, v["zoom"])
                s.command("ZOOM %d" % zoom)
            if v["rotation"] != rotation:
                s.command("ROTATE %d" % ((v["rotation"] - rotation) % 4))
                rotation = v["rotation"]
            if v["x"] <= MAX_LOCATION and v["y"] <= MAX_LOCATION:
                s.command("LOCATION %d %d" % (round(v["x"]), round(v["y"])))
            if layout == "stock":
                s.wait(v["hold"] * 1000)
        if layout == "plugin":
            s.wait(PLUGIN_PARK_WAIT_MS)
    # OpenRCT2 treats END like RESTART (both are markers; the player wraps to the start).
    s.comment()
    s.command("RESTART")
    return s.text()


ZOOM_SLACK = 0.25  # levels a window may come out tighter than its views' frame before they step out


def zoom_offset(design, window):
    """Zoom levels views framed for screen `design` move out in a window of size `window`, as the
    plugin plays them (plugin/src/scale.ts): whole levels until the window shows at least the
    frame on both sides, up to ZOOM_SLACK of a level tighter before stepping out."""
    if not design or not window or min(design[0], design[1], window[0], window[1]) <= 0:
        return 0
    scale = min(window[0] / design[0], window[1] / design[1])
    return math.ceil(math.log2(1 / scale) - ZOOM_SLACK)


def scale_views(views, offset):
    """Views at the window's zoom levels (zoom_offset), kept within OpenRCT2's -2..3."""
    return [dict(v, zoom=min(3, max(-2, v["zoom"] + offset))) for v in views] if offset else views


def playlist_data(name, parks, screen=None, defaults=None, titles=None):
    """Playlist as stored for the plugin under RCTScreensaver.playlist. `screen` is the window the
    generated views were judged in ([views] window): the plugin scales zooms and pan speeds from it.
    `defaults` (the playlist's [views]) gives the change, arrival and return holds, times time_scale.
    `titles` (the playlist's Show titles) overrides the viewer's own setting each time playback starts,
    until the viewer picks on the bar (owner, 2026-11-03)."""
    entries = []
    for p in parks:
        entry = {"key": p["key"], "name": p["name"], **({"author": p["author"]} if p["author"] else {}), "fileName": p["fileName"], "load": p["load"],
                 "views": [{k: v[k] for k in ("x", "y", "z", "rotation", "zoom", "hold", "manual", "overview", "animation", "show", "fixed", "pan", "panChanges", "inertia", "zoomThreshold", "path", "pathStep", "showAt", "cue") if k in v}
                           for v in p["views"]]}
        if p["defaultViews"] is not None:
            # Views from the editor play exactly as set; the playlist's own are kept for a reset.
            entry["handSet"] = True
            if p.get("viewScreen"):
                entry["viewScreen"] = p["viewScreen"]
            entry["defaultViews"] = [{k: v[k] for k in ("x", "y", "z", "rotation", "zoom", "hold", "overview", "animation", "show", "fixed", "pan", "panChanges", "inertia", "zoomThreshold", "path", "pathStep", "showAt", "cue") if k in v}
                                     for v in p["defaultViews"]]
        if p.get("box"):
            entry["box"] = p["box"]  # the content box: the settings page's view drawing frames its renders on it
        if p["bounds"]:
            entry["bounds"] = p["bounds"]
            entry["viewCount"] = p["viewCount"]
        if p["parkTime"]:
            entry["parkTime"] = p["parkTime"]
        if any(v.get("pan") for v in p["views"]):
            entry["panTolerance"] = p["panTolerance"]  # the plugin zooms out by the same rule
        if not p.get("returnPan", True):
            entry["returnPan"] = False  # the last view cuts to the next park instead of panning back
        if p.get("variants") and p["defaultViews"] is None:
            # Alternative circuit orders, played in turn on each visit (circuit_variants)
            entry["variants"] = [{"views": [{k: v[k] for k in ("x", "y", "z", "rotation", "zoom", "hold", "overview", "animation", "show", "fixed", "pan", "panChanges", "inertia", "zoomThreshold", "path", "pathStep", "showAt", "cue") if k in v}
                                            for v in alt["views"]], "parkTime": alt["parkTime"]} for alt in p["variants"]]
        entries.append(entry)
    data = {"version": 1, "sequence": name, "parks": entries}
    if defaults:
        scale = float(defaults["time_scale"])
        for key, opt in (("changeHold", "change_hold"), ("arriveHold", "arrive_hold"), ("returnHold", "return_hold")):
            data[key] = round(float(defaults[opt]) * scale, 2)
        # The playlist-wide motion settings, as the view editor's Playlist properties show them
        data["inertia"] = bool(defaults["inertia"])
        data["panChanges"] = defaults["pan_changes"]
    data["built"] = int(time.time() * 1000)  # the view editor's "Generated" restore point
    if screen:
        data["screen"] = [int(screen[0]), int(screen[1])]
    if titles:
        data["titles"] = titles
    return data


# --- rebuilding only the parks that changed (owner, 2026-11-01) ---

CODE_FILES = ("mksequence.py", "companions.py", "parkinfo.py", "profiles.py", "districts.py", "unzstd.py", "nedesigns.py")


def code_version():
    h = hashlib.sha1()
    here = os.path.dirname(os.path.abspath(__file__))
    for name in CODE_FILES:
        try:
            with open(os.path.join(here, name), "rb") as f:
                h.update(f.read())
        except OSError:
            pass
    return h.hexdigest()


def _digest(value):
    return hashlib.sha1(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


class ParkCache:
    """Each resolved park kept under a signature of everything it was resolved from: the playlist
    entry, the playlist-wide options, the park's editor edit, its file, the profile it matched, the
    companion library and show definitions (for parks with companion data) and the generator's own
    code. A build takes a park from here when nothing of that changed, so editing one park rebuilds
    that park alone. The park's saved name and map size, which pick its profile, are remembered by
    file (names.json) so the signature needs no reading of the park."""

    KEEP = 400  # cached parks kept (the oldest go)

    def __init__(self, directory):
        self.dir = directory
        os.makedirs(directory, exist_ok=True)
        self.names_path = os.path.join(directory, "names.json")
        try:
            with open(self.names_path, encoding="utf-8") as f:
                self.names = json.load(f)
        except (OSError, ValueError):
            self.names = {}
        self.code = code_version()
        # The code version the cache was last written with: parks cached under it but not under this
        # one changed only by a generator update (the settings page says so instead of flagging them)
        try:
            with open(os.path.join(directory, "code.txt"), encoding="utf-8") as f:
                self.last_code = f.read().strip() or None
        except OSError:
            self.last_code = None

    @staticmethod
    def file_id(entry, base_dir):
        path = os.path.abspath(os.path.join(base_dir, entry["file"]))
        try:
            stat = os.stat(path)
        except OSError:
            return None, None
        return path + "|" + (entry.get("member") or ""), [stat.st_size, stat.st_mtime_ns]

    def signature(self, entry, base_dir, context, park_profiles, code=None):
        """The park's signature, or None when its file is unknown (never resolved, or changed); `code`
        another generator version than this one."""
        ident, stat = self.file_id(entry, base_dir)
        known = self.names.get(ident) if ident else None
        if known and known.get("stat") != stat and known.get("sha1") and stat and known["stat"][0] == stat[0]:
            # Same size, new file time (copied, or unpacked again from a bundle): the same file if its
            # contents are (owner, 2026-11-02: a bundle import flagged every park for a rebuild)
            if self.file_sha1(ident) == known["sha1"]:
                known["stat"] = stat
                self.save_names()
        if not known or known.get("stat") != stat:
            return None
        profile = profiles.find(park_profiles, entry, known["savedName"], known["mapSize"], os.path.basename(entry["file"]))
        parts = {"code": code or self.code, "entry": entry, "file": [ident, known.get("sha1") or stat],  # (its contents: a copy with a new time is the same) "context": context["shared"],
                 "edit": context["edits"].get(park_key(entry)),
                 "profile": {k: v for k, v in (profile or {}).items() if k not in ("path", "source")}}
        if known.get("hasStorage") or known.get("companions"):
            parts["companions"] = context["companions"]
        return _digest(parts)

    def get(self, sig):
        path = os.path.join(self.dir, sig + ".pkl")
        try:
            with open(path, "rb") as f:
                park = pickle.load(f)
        except (OSError, pickle.PickleError, EOFError, AttributeError, ValueError):
            return None
        os.utime(path)  # recently used: kept longest
        return park

    @staticmethod
    def file_sha1(ident):
        h = hashlib.sha1()
        try:
            with open(ident.rsplit("|", 1)[0], "rb") as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
        except OSError:
            return None
        return h.hexdigest()

    def save_names(self):
        try:
            with open(self.names_path + ".tmp", "w", encoding="utf-8") as f:
                json.dump(self.names, f)
            os.replace(self.names_path + ".tmp", self.names_path)
        except OSError:
            pass

    def put(self, entry, base_dir, context, park_profiles, park):
        ident, stat = self.file_id(entry, base_dir)
        if not ident:
            return
        self.names[ident] = {"stat": stat, "sha1": self.file_sha1(ident), "savedName": park["savedName"],
                             "mapSize": list(park["mapSize"]), "hasStorage": park.get("hasStorage", False),
                             "companions": bool(park.get("companions"))}
        self.save_names()
        sig = self.signature(entry, base_dir, context, park_profiles)
        with open(os.path.join(self.dir, sig + ".tmp"), "wb") as f:
            pickle.dump(park, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(os.path.join(self.dir, sig + ".tmp"), os.path.join(self.dir, sig + ".pkl"))
        if self.last_code != self.code:
            with open(os.path.join(self.dir, "code.txt"), "w", encoding="utf-8") as f:
                f.write(self.code)
            self.last_code = self.code
        self.prune()

    def prune(self):
        files = [os.path.join(self.dir, n) for n in os.listdir(self.dir) if n.endswith(".pkl")]
        if len(files) > self.KEEP:
            for path in sorted(files, key=os.path.getmtime)[:len(files) - self.KEEP]:
                os.remove(path)


def prepare(playlist_path, use_edits=True, overrides=None, use_profiles=True, layout=None):
    """What a build reads before resolving its parks: the playlist, its entries in use, edits,
    profiles, the companion library, and the playlist-wide context of a park's signature."""
    with open(playlist_path, "rb") as f:
        playlist = tomllib.load(f)
    base_dir = os.path.dirname(os.path.abspath(playlist_path))
    name = playlist.get("name") or os.path.splitext(os.path.basename(playlist_path))[0]
    if name.startswith("*"):
        raise ValueError("sequence names starting with '*' are reserved by OpenRCT2")
    layout = layout or playlist.get("layout", "plugin")
    if layout not in LAYOUTS:
        raise ValueError("layout must be one of: %s" % ", ".join(LAYOUTS))
    defaults = {**VIEW_DEFAULTS, **playlist.get("views", {}), **(overrides or {})}
    # `use = false` keeps a park in the playlist (its place in the order, its settings) without playing it
    entries = [e for e in playlist.get("park", []) if e.get("use", True)]
    if not entries:
        raise ValueError("playlist has no [[park]] entries in use")
    # park_scripts = false: no park's companion plugins run (settings UI "Park plugin support"); a park
    # entry's own `companions = []` turns off just its own
    park_scripts = playlist.get("park_scripts", True)
    if not isinstance(park_scripts, bool):
        raise ValueError("park_scripts must be true or false")
    if not park_scripts:
        entries = [dict(e, companions=[]) for e in entries]
    edits = {k: v for k, v in load_edits(edits_path(playlist_path)).items() if pinned(v)} if use_edits else {}
    park_profiles = profiles.load() if use_profiles else {}
    park_plugins = playlist.get("park_plugins", False)
    if not isinstance(park_plugins, bool):
        raise ValueError("park_plugins must be true or false")
    context = {"edits": edits,
               "shared": {"defaults": defaults, "layout": layout, "parkPlugins": park_plugins,
                          "profiles": use_profiles},
               "companions": None}
    return {"playlist": playlist, "base_dir": base_dir, "name": name, "layout": layout, "defaults": defaults,
            "entries": entries, "edits": edits, "park_profiles": park_profiles, "park_plugins": park_plugins,
            "context": context}


def companion_context(entries, base_dir, park_profiles):
    """The part of a signature only parks with companion data depend on: the playlist's companion
    library (the newest version of each) and the profiles' spots and shows."""
    library = companions.library(entries, base_dir)
    return library, _digest({"library": {k: [v[0], hashlib.sha1(v[1].encode() if isinstance(v[1], str) else v[1]).hexdigest()]
                                         for k, v in library.items()},
                             "definitions": [{str(k): v for k, v in part.items()} for part in profiles.definitions(park_profiles)]})


def changed_parks(playlist_path, cache_dir, use_edits=True, use_profiles=True, detail=False):
    """Keys of the playlist's parks in use that the next build resolves again (not in the cache). With
    `detail`, a dict: "parks" those changed themselves, "updated" those changed only by a generator update
    since they were cached (owner, 2026-11-02: one park's edit right after an update flagged all ten)."""
    ctx = prepare(playlist_path, use_edits, use_profiles=use_profiles)
    if not os.path.isdir(cache_dir):
        keys = [park_key(e) for e in ctx["entries"]]
        return {"parks": keys, "updated": []} if detail else keys
    cache = ParkCache(cache_dir)
    _, ctx["context"]["companions"] = companion_context(ctx["entries"], ctx["base_dir"], ctx["park_profiles"])
    cached = lambda sig: bool(sig) and os.path.exists(os.path.join(cache_dir, sig + ".pkl"))  # noqa: E731
    out, updated = [], []
    for e in ctx["entries"]:
        if cached(cache.signature(e, ctx["base_dir"], ctx["context"], ctx["park_profiles"])):
            continue
        if cache.last_code and cache.last_code != cache.code and \
                cached(cache.signature(e, ctx["base_dir"], ctx["context"], ctx["park_profiles"], code=cache.last_code)):
            updated.append(park_key(e))
        else:
            out.append(park_key(e))
    return {"parks": out, "updated": updated} if detail else out + updated


def build(playlist_path, out_dir, seed=None, layout=None, use_edits=True, overrides=None,
          use_profiles=True, cache_dir=None):
    ctx = prepare(playlist_path, use_edits, overrides, use_profiles, layout)
    playlist, base_dir, name, layout, defaults = ctx["playlist"], ctx["base_dir"], ctx["name"], ctx["layout"], ctx["defaults"]
    entries, edits, park_profiles, park_plugins = ctx["entries"], ctx["edits"], ctx["park_profiles"], ctx["park_plugins"]
    order = playlist.get("order", "playlist")
    if order == "shuffle":
        random.Random(seed).shuffle(entries)
    elif order != "playlist":
        raise ValueError("order must be 'playlist' or 'shuffle'")
    missing = [e["file"] for e in entries if not os.path.exists(os.path.join(base_dir, e["file"]))]
    if missing:
        raise ValueError("park file%s not found: %s (relative to %s). Park files are not part of the repository; "
                         "the example playlists' parks are downloads from New Element Designs, listed in "
                         "ExampleParks/README.md" % ("s" if len(missing) > 1 else "", ", ".join(missing), base_dir))
    library, ctx["context"]["companions"] = companion_context(entries, base_dir, park_profiles)
    cache = ParkCache(cache_dir) if cache_dir else None
    parks = []
    reused = 0
    for i, e in enumerate(entries):
        sig = cache.signature(e, base_dir, ctx["context"], park_profiles) if cache else None
        park = cache.get(sig) if sig else None
        if park:
            # Unchanged since an earlier build: only its place in the order is new
            park["fileName"] = "%02d-%s.park" % (i + 1, slug(park["name"]))
            reused += 1
            print("[%d/%d] %s (unchanged)" % (i + 1, len(entries), e.get("name") or os.path.basename(e["file"])), file=sys.stderr, flush=True)
        else:
            # Progress on stderr: the report below comes once every park is resolved
            print("[%d/%d] %s" % (i + 1, len(entries), e.get("name") or os.path.basename(e["file"])), file=sys.stderr, flush=True)
            park = resolve_park(e, i, base_dir, defaults, layout, edits, library, park_profiles, park_plugins)
            if cache:
                cache.put(e, base_dir, ctx["context"], park_profiles, park)
        parks.append(park)
    if cache:
        print("rebuilt %d of %d park(s); %d unchanged" % (len(entries) - reused, len(entries), reused), file=sys.stderr, flush=True)
    script = write_script(parks, os.path.basename(playlist_path), layout)

    seq_dir = os.path.join(out_dir, name)
    os.makedirs(seq_dir, exist_ok=True)
    for old in os.listdir(seq_dir):
        if old.lower().endswith(".park") or old == "script.txt":
            os.remove(os.path.join(seq_dir, old))
    for park in parks:
        with open(os.path.join(seq_dir, park["fileName"]), "wb") as f:
            f.write(park["data"])
    with open(os.path.join(seq_dir, "script.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(script)
    titles = playlist.get("titles")
    if titles is not None and titles not in TITLES:
        raise ValueError("titles must be one of: %s" % ", ".join(TITLES))
    data = playlist_data(name, parks, defaults["window"], defaults, titles) if layout == "plugin" else None
    if data:
        with open(seq_dir + ".playlist.json", "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)
    elif os.path.exists(seq_dir + ".playlist.json"):
        os.remove(seq_dir + ".playlist.json")
    # Why each generated view was picked (spot score, share seen, spacing, detail weight, zoom
    # turn, rank and lead over the runner-up), for judging changes to the heuristics.
    with open(seq_dir + ".scores.json", "w", encoding="utf-8") as f:
        json.dump({"parks": [{"name": p["name"], "views": [
            {k: v[k] for k in ("x", "y", "z", "rotation", "zoom", "hold", "overview", "why") if k in v}
            for v in (p["defaultViews"] or p["views"])],
            # Each pan's speed against the tolerance at its travel zoom (pan_tolerance)
            "pans": p["pans"],
            # The views as a route: length, turns, bends, sweeps (route_metrics)
            "route": p["route"],
            # The companions' animations: trigger, cue, profile changes and which view shows each
            "animations": p["animations"],
            # Alternative orders (circuit_variants), as the views' positions
            "variants": [[[v["x"], v["y"]] for v in alt["views"]] for alt in p.get("variants", [])]} for p in parks]}, f, indent=1)
    companion_dir = seq_dir + ".companions"
    written = companions.build(parks, companion_dir, playlist.get("companion_debug", False))
    title_music = playlist.get("title_music", "keep")
    if title_music not in TITLE_MUSIC:
        raise ValueError("title_music must be one of: %s" % ", ".join(TITLE_MUSIC))
    # What --install-built needs to install this build later without building it again (the settings
    # page's Install, bundles carrying a build)
    with open(seq_dir + ".result.json", "w", encoding="utf-8") as f:
        json.dump({"name": name, "layout": layout, "playlist": data, "titleMusic": title_music, "companions": written,
                   "source": os.path.abspath(playlist_path)}, f)
    return {"name": name, "layout": layout, "dir": seq_dir, "parks": parks, "playlist": data, "titleMusic": title_music,
            "companionDir": companion_dir, "companions": written}


def load_built(result_path):
    """A build written earlier (<out>/<name>.result.json), in the form install() takes."""
    with open(result_path, encoding="utf-8") as f:
        result = json.load(f)
    result["dir"] = os.path.join(os.path.dirname(os.path.abspath(result_path)), result["name"])
    result["companionDir"] = result["dir"] + ".companions"
    if not os.path.isdir(result["dir"]):
        raise ValueError("the built sequence %s is missing; build again" % result["dir"])
    return result


# --- installation into OpenRCT2's user directory ---

default_user_dir = userdata.openrct2_dir


def openrct2_running():
    try:
        if sys.platform == "win32":
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq openrct2.exe", "/NH"],
                                 capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
            return "openrct2.exe" in out.lower()
        return subprocess.run(["pgrep", "-ix", "openrct2"], capture_output=True).returncode == 0
    except OSError:
        return False


def read_store(store_path):
    if not os.path.exists(store_path):
        return {}
    with open(store_path, encoding="utf-8") as f:
        text = f.read()
    store = json.loads(text) if text.strip() else {}
    if not isinstance(store, dict):
        raise ValueError("%s is not a JSON object; not modifying it" % store_path)
    return store


def pull_edits(playlist_path, store_path):
    """Move views saved by the plugin's editor for this playlist's parks from the store into
    <playlist>.views.json. Returns (key, reset) pairs; they are removed from the store on install."""
    with open(playlist_path, "rb") as f:
        keys = {park_key(e) for e in tomllib.load(f).get("park", [])}
    stored = read_store(store_path).get(STORE_NAMESPACE, {})
    stored = stored.get("edits") if isinstance(stored, dict) else None
    moved = {k: v for k, v in (stored or {}).items() if k in keys and isinstance(v, dict)}
    # Edits that pin nothing (generated views carried over unchanged) count as a reset.
    moved = {k: v if v.get("reset") or pinned(v) else {"reset": True} for k, v in moved.items()}
    if moved:
        path = edits_path(playlist_path)
        edits = load_edits(path)
        # A reset from the editor drops the park's views; they are kept in a backup file.
        dropped = {k: edits[k] for k, v in moved.items() if v.get("reset") and k in edits}
        if dropped:
            backup = os.path.splitext(path)[0] + ".bak.json"
            save_edits(backup, {**load_edits(backup), **dropped})
        edits.update({k: v for k, v in moved.items() if not v.get("reset")})
        save_edits(path, {k: v for k, v in edits.items() if not moved.get(k, {}).get("reset")})
    return sorted((k, bool(v.get("reset"))) for k, v in moved.items())


def playlist_name(playlist_path, playlist=None):
    """The title sequence's name: the playlist's `name`, else its file name."""
    if playlist is None:
        with open(playlist_path, "rb") as f:
            playlist = tomllib.load(f)
    return playlist.get("name") or os.path.splitext(os.path.basename(playlist_path))[0]


# The view editor's Playlist properties (plugin RCTScreensaver.playlistProps, by sequence name) and
# the playlist keys they set: (plugin key, table or None for the top level, playlist key).
PROPS = (("inertia", "views", "inertia"), ("panChanges", "views", "pan_changes"),
         ("changeHold", "views", "change_hold"), ("arriveHold", "views", "arrive_hold"),
         ("returnHold", "views", "return_hold"), ("titleMusic", None, "title_music"), ("titles", None, "titles"))


def apply_props(playlist, props):
    """The playlist (as tomllib reads it) with the editor's properties and park order applied:
    holds back to unscaled seconds (the plugin's are times time_scale), Unset titles and title music
    removed, parks reordered by key (parks the order does not name keep their place after it)."""
    data = json.loads(json.dumps(playlist))
    views = data.setdefault("views", {})
    scale = float(views.get("time_scale", VIEW_DEFAULTS["time_scale"])) or 1.0
    for key, table, opt in PROPS:
        if key not in props:
            continue
        value = props[key]
        target = views if table == "views" else data
        if key in ("changeHold", "arriveHold", "returnHold"):
            target[opt] = round(float(value) / scale, 2)
        elif key == "panChanges" and value not in PAN_CHANGES:
            raise ValueError("panChanges must be one of: %s" % ", ".join(PAN_CHANGES))
        elif (key == "titles" and value is None) or (key == "titleMusic" and value == "keep"):
            target.pop(opt, None)  # Unset: the viewer's own setting
        else:
            target[opt] = value
    if not views:
        del data["views"]
    order = props.get("order")
    if isinstance(order, list) and data.get("park"):
        rank = {k: i for i, k in enumerate(order)}
        parks = data["park"]
        data["park"] = sorted(parks, key=lambda e: (rank.get(park_key(e), len(order)), parks.index(e)))
    return data


def reorder_parks(text, parks):
    """The playlist's text with its [[park]] sections (each with its subtables, up to the next section)
    moved into the order of `parks`, comments and layout kept; None when the text can't be split so."""
    lines = text.splitlines(keepends=True)
    header = re.compile(r"^\s*\[\[\s*park\s*\]\]")
    sub = re.compile(r"^\s*\[{1,2}\s*park\s*\.")
    other = re.compile(r"^\s*\[")
    starts = [i for i, line in enumerate(lines) if header.match(line)]
    if not starts:
        return None
    blocks, end = [], starts[0]
    for k, start in enumerate(starts):
        stop = starts[k + 1] if k + 1 < len(starts) else len(lines)
        j = start + 1
        while j < stop and not (other.match(lines[j]) and not sub.match(lines[j])):
            j += 1
        if k + 1 < len(starts) and j < stop:
            return None  # another table between two parks: not one run of sections
        blocks.append(lines[start:j])
        end = j
    body = ["".join(b).rstrip("\n") + "\n" for b in blocks]  # blank lines go between the sections
    try:
        current = [tomllib.loads(b)["park"][0] for b in body]
    except (tomllib.TOMLDecodeError, KeyError, IndexError):
        return None
    order = []
    for park in parks:
        if park not in current:
            return None
        i = current.index(park)
        order.append(body[i])
        current[i] = None  # the same entry twice: each block once
    rest = "".join(lines[end:])
    out = "".join(lines[:starts[0]]) + "\n".join(order) + ("\n" + rest if rest.strip() else "")
    try:
        return out if tomllib.loads(out).get("park") == parks else None
    except tomllib.TOMLDecodeError:
        return None


def pull_props(playlist_path, store_path):
    """Move the view editor's Playlist properties and park order for this playlist from the store into
    the playlist file (comments kept where tomlwrite can; the old file in <playlist>.toml.bak). Returns
    (whether the store had an entry for it, the names of what changed); the entry is removed on install."""
    with open(playlist_path, "rb") as f:
        raw = f.read()
    playlist = tomllib.loads(raw.decode("utf-8"))
    name = playlist_name(playlist_path, playlist)
    stored = read_store(store_path).get(STORE_NAMESPACE, {})
    props = (stored.get("playlistProps") or {}).get(name) if isinstance(stored, dict) else None
    if not isinstance(props, dict):
        return False, []
    data = apply_props(playlist, props)
    if data == playlist:
        return True, []
    changed = [k for k, _, _ in PROPS if k in props] + (["park order"] if data.get("park") != playlist.get("park") else [])
    import tomlwrite
    text = reorder_parks(raw.decode("utf-8"), data.get("park")) if data.get("park") != playlist.get("park") else raw.decode("utf-8")
    out = (tomlwrite.patch(text, data) if text is not None else None) or tomlwrite.dumps(data)
    shutil.copy2(playlist_path, playlist_path + ".bak")
    with open(playlist_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    return True, changed


def update_plugin_store(store_path, result, pulled=(), camera_log=False, props_pulled=False):
    """Set (plugin layout) or clear (stock layout, same sequence) RCTScreensaver.playlist and
    drop the editor's views that were pulled into the playlist's views file (and its Playlist
    properties, with `props_pulled`), leaving every other plugin's data untouched. Sets the plugin's
    camera log on or off and the screensaver mode's title music, and stamps the playlist with the
    install time (the view editor's "Last install"). Keeps a .bak copy of the previous file."""
    store = read_store(store_path)
    if os.path.exists(store_path):
        shutil.copy2(store_path, store_path + ".bak")
    ours = store.get(STORE_NAMESPACE)
    if not isinstance(ours, dict):
        ours = {}
    if result["playlist"] is not None:
        ours["playlist"] = dict(result["playlist"], installed=int(time.time() * 1000))
    elif isinstance(ours.get("playlist"), dict) and ours["playlist"].get("sequence") == result["name"]:
        del ours["playlist"]
    if isinstance(ours.get("edits"), dict):
        for key, _ in pulled:
            ours["edits"].pop(key, None)
    if props_pulled and isinstance(ours.get("playlistProps"), dict):
        ours["playlistProps"].pop(result["name"], None)
    settings = ours.setdefault("settings", {})
    if isinstance(settings, dict):
        settings["cameraLog"] = bool(camera_log)
        # The screensaver mode (patched engine) applies the title music in memory on entry;
        # config.ini is never edited.
        settings["titleMusic"] = result.get("titleMusic", "keep")
    store[STORE_NAMESPACE] = ours
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(store_path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(store, f)
    os.replace(tmp, store_path)


def check_installable(user_dir, force=False):
    if not os.path.isdir(user_dir):
        raise ValueError("OpenRCT2 user directory not found: %s (use --user-dir)" % user_dir)
    if openrct2_running() and not force:
        raise ValueError("OpenRCT2 is running; close it first (it rewrites plugin.store.json), "
                         "or pass --force")


def install(result, user_dir, pulled=(), camera_log=False, props_pulled=False):
    steps = []
    target = os.path.join(user_dir, "sequence", result["name"])
    if os.path.isdir(target):
        shutil.rmtree(target)
    shutil.copytree(result["dir"], target)
    steps.append("sequence -> " + target)
    store_path = os.path.join(user_dir, "plugin.store.json")
    update_plugin_store(store_path, result, pulled, camera_log, props_pulled)
    steps.append(("playlist -> " if result["playlist"] else "cleared playlist in ") + store_path)
    if os.path.exists(PLUGIN_FILE):
        os.makedirs(os.path.join(user_dir, "plugin"), exist_ok=True)
        dest = os.path.join(user_dir, "plugin", os.path.basename(PLUGIN_FILE))
        shutil.copy2(PLUGIN_FILE, dest)
        steps.append("plugin -> " + dest)
        # The screensaver mode's icons (tools/mkicons.py), read by the engine's overlay from the
        # user plugin folder; only this folder of ours is replaced.
        if os.path.isdir(ICONS_DIR):
            icons = os.path.join(user_dir, "plugin", "rct-screensaver", "icons")
            if os.path.isdir(icons):
                shutil.rmtree(icons)
            shutil.copytree(ICONS_DIR, icons)
            steps.append("icons -> " + icons)
    elif result["layout"] == "plugin":
        steps.append("plugin not built (plugin/dist/rct-screensaver.js missing); install it separately")
    # Companion plugins: this playlist's replace any installed before (only the generated files).
    plugin_dir = os.path.join(user_dir, "plugin")
    if os.path.isdir(plugin_dir):
        for old in os.listdir(plugin_dir):
            if old.startswith(companions.FILE_PREFIX) and old.endswith(".js"):
                os.remove(os.path.join(plugin_dir, old))
    for file_name, meta, _ in result["companions"]:
        os.makedirs(plugin_dir, exist_ok=True)
        dest = os.path.join(plugin_dir, file_name)
        shutil.copy2(os.path.join(result["companionDir"], file_name), dest)
        steps.append("companion %s -> %s" % (meta["name"], dest))
    # An intransient companion that is also installed as a plugin of its own runs on the title
    # screen by itself too: twice on its parks.
    names = {meta["name"] for _, meta, _ in result["companions"] if meta["type"] == "intransient"}
    if names and os.path.isdir(plugin_dir):
        for other in sorted(os.listdir(plugin_dir)):
            if not other.endswith(".js") or other.startswith(companions.FILE_PREFIX):
                continue
            try:
                with open(os.path.join(plugin_dir, other), encoding="utf-8-sig", errors="replace") as f:
                    name = companions.metadata(f.read(), other)["name"]
            except (ValueError, OSError):
                continue
            if name in names:
                steps.append("warning: %s is also installed as %s, so it runs twice on its parks; "
                             "remove that file or set companions = [] on those parks" % (name, other))
    return steps


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("playlist", nargs="?", help="the playlist (TOML); not with --install-built")
    ap.add_argument("--install-built", metavar="RESULT_JSON",
                    help="install a build made earlier (<out>/<name>.result.json) without building again; "
                         "editor views in the store stay there and keep playing")
    ap.add_argument("-o", "--out", default="build/sequence", help="output directory (default: build/sequence)")
    ap.add_argument("--seed", type=int, help="seed for order = 'shuffle'")
    ap.add_argument("--layout", choices=LAYOUTS, help="overrides the playlist's layout (default: plugin)")
    ap.add_argument("--install", action="store_true", help="install into OpenRCT2's user directory")
    ap.add_argument("--user-dir", help="OpenRCT2 user directory (default: %s)" % default_user_dir())
    ap.add_argument("--force", action="store_true", help="install even if OpenRCT2 appears to be running")
    ap.add_argument("--cache", metavar="DIR",
                    help="keep each resolved park here and take unchanged ones from it on the next build, so editing "
                         "one park rebuilds that park alone (the settings page uses one)")
    ap.add_argument("--ignore-edits", action="store_true",
                    help="play the playlist's own or generated views: views from the editor are still "
                         "moved into the views file, but not used")
    ap.add_argument("--ignore-profiles", action="store_true",
                    help="build without the parks' profiles (parks/*.toml), e.g. while tuning the generator")
    ap.add_argument("--camera-log", action="store_true",
                    help="have the plugin log every view, pan and angle/zoom change with its time "
                         "(read the game's log with tools/cameralog.py); installs without it turn it off")
    ap.add_argument("--route", action="store_true", help="print each park's route metrics (how its views sit as a "
                    "route for panning: length, turns, bends, sweeps); always in <sequence>.scores.json")
    ap.add_argument("--animations", action="store_true", help="list each park's companion animations (with "
                    "animations = true): trigger, cue, profile changes, which view shows each; always in "
                    "<sequence>.scores.json; change one in the park's profile with [animation.\"<name>\"]")
    ap.add_argument("--set", action="append", default=[], metavar="OPTION=VALUE",
                    help="override a [views] option for this build (value in TOML syntax, e.g. --set pan=0.5)")
    args = ap.parse_args()
    try:
        overrides = {}
        for item in args.set:
            overrides.update(tomllib.loads(item))
        user_dir = args.user_dir or default_user_dir()
        if args.install_built:
            check_installable(user_dir, args.force)
            result = load_built(args.install_built)
            for step in install(result, user_dir, (), args.camera_log):
                print("installed", step)
            return
        if not args.playlist:
            ap.error("a playlist is needed (or --install-built)")
        pulled = []
        props_found = False
        if args.install:
            check_installable(user_dir, args.force)
            pulled = pull_edits(args.playlist, os.path.join(user_dir, "plugin.store.json"))
            for key, reset in pulled:
                print(("reset to playlist views, old views kept in %s.views.bak.json (%s)" if reset else
                       "views from the editor -> %s.views.json (%s)")
                      % (os.path.splitext(args.playlist)[0], key))
            props_found, props_changed = pull_props(args.playlist, os.path.join(user_dir, "plugin.store.json"))
            if props_changed:
                print("playlist properties from the editor -> %s (%s; the old file in %s.bak)"
                      % (args.playlist, ", ".join(props_changed), args.playlist))
        result = build(args.playlist, args.out, args.seed, args.layout, not args.ignore_edits, overrides,
                       not args.ignore_profiles, args.cache)
        for park in result["parks"]:
            views = ", ".join("(%g,%g r%d)" % (v["x"], v["y"], v["rotation"]) for v in park["views"])
            print("%-34s %d view(s) [%s] %s" % (park["fileName"], len(park["views"]), park["source"], views))
            if park["profile"]:
                print("  profile: parks/%s.toml" % park["profile"])
            for warning in park["warnings"]:
                print("  warning:", warning)
            close = [q for q in park["pans"] if not q.get("overview")]  # an overview's zoom is fitted in play
            if close:
                over = [q for q in close if q["over"]]
                fastest = max(close, key=lambda q: q["speed"] / q["tolerance"])
                print("  pans: %d, %d over the speed tolerance (fastest %d px/s at zoom %d, tolerance %d)%s%s%s"
                      % (len(close), len(over), fastest["speed"], fastest["zoom"], fastest["tolerance"],
                         "; %d stretched, +%.1f s" % park["stretched"] if park["stretched"][0] else "",
                         "; %d over the bead band, %d beads" % park["beads"] if park["beads"][0] else "",
                         "; %d nudged" % park["nudged"] if park["nudged"] else ""))
            if park["rides"] or park["variants"]:
                print("  %s%s%s" % ("%d ride pan%s" % (park["rides"], "s" if park["rides"] != 1 else "") if park["rides"] else "",
                                    "; " if park["rides"] and park["variants"] else "",
                                    "%d alternative order%s" % (len(park["variants"]), "s" if len(park["variants"]) != 1 else "") if park["variants"] else ""))
            if park["timing"]:
                t = park["timing"]
                print("  timing: %.0f s still + %.0f s moving = %.0f s%s" % (t["still"], t["moving"], t["still"] + t["moving"],
                      "; dropped %d for the %.0f s cap" % (len(t["dropped"]), t["cap"]) if t["dropped"] else ""))
            route = park["route"]
            if route and args.route:
                print("  route: %d tiles (shortest %d), %d turns, %d zoom changes (%d levels), bends %d straight/%d bend/%d reverse, "
                      "%d straight runs, %d double reversals, sweep %.2f"
                      % (route["length"], route["shortest"], route["turns"], route["zooms"], route["zoomSteps"],
                         route["headings"]["straight"], route["headings"]["bend"], route["headings"]["reverse"],
                         route["straightRuns"], route["doubleReversals"], route["sweep"]))
            if args.animations:
                for a in park["animations"]:
                    print("  animation %s (%s): tiles %s%s%s%s; %s" % (
                        json.dumps(a["name"]), a["companion"], ",".join(map(str, a["box"])),
                        " z %d" % a["z"] if a.get("z") is not None else "",
                        "; cue " + cue_text(a["used"]) if a.get("used") else "; cue " + cue_text(a["cue"]) + " (off)" if a.get("cue") else "; no cue",
                        "; profile " + json.dumps(a["changed"]) if a.get("changed") else "", a["status"]))
        for file_name, meta, park_names in result["companions"]:
            print("companion %s %s (%s, %s) for %s" % (meta["name"], meta["version"], meta["type"],
                                                      file_name, ", ".join(park_names)))
        print("wrote %s (%s layout)" % (result["dir"], result["layout"]))
        if args.install:
            for step in install(result, user_dir, pulled, args.camera_log, props_found):
                print("installed", step)
    except (ValueError, OSError) as e:
        sys.exit("error: %s" % e)


if __name__ == "__main__":
    main()
