# Enhancements: requirements

The roadmap's "Potential enhancements" (`docs/roadmap.md`) made actionable (2026-11-03): for each item,
what must be built, where it goes, how the owner checks it, and what still needs a decision. Items are in
the roadmap's priority order. Each requirement is one unit of work (one PR, or less); the acceptance list
is the test pass the owner runs on the PC, to be copied into `docs/testing.md` when the item is built.

Conventions: Python stdlib only; the plugin in TypeScript, `plugin/dist` rebuilt with every change;
every new tuning value a `[views]` option with a default in `VIEW_DEFAULTS` and a line in
`docs/view-generation.md`; every new mode setting in `plugin/src/storage.ts` (plugin storage, never
`config.ini`) and a row in `docs/screensaver-ui.md`'s settings table; new engine work as a patch in its
topic group (`engine/README.md`), regenerated as one series.

## 1. Linux and macOS support (highest priority)

Goal: the screensaver mode and the tools run on OpenRCT2's official Linux build; macOS follows where it
comes for free, with no macOS-only work.

Starting point: `tools/userdata.py` already resolves the user folder on all three systems and checks for a
running game with `pgrep` off Windows; the engine patches compile under CMake (the cloud sessions' check);
patches 0013 and 0015 look fonts up on Linux and macOS paths. Nothing has run there.

Requirements, each shippable alone:

1. **Test machine.** A Linux VM or second drive with a desktop (Ubuntu or Fedora, current release), both an
   X11 and a Wayland session available, OpenRCT2 v0.5.6 from the official release and the RCT2 data
   files, Python 3.11+ and Node 20+. Owner's step; blocks 4-6.
2. **Linux engine build** (`.github/workflows/engine.yml`): a job `Linux x64` beside `Windows x64`, copied
   from OpenRCT2's own Ubuntu CI job (its container image or `apt` list, CMake with the release's
   options), the same "Apply patches" step (the release input leaving out 0020), producing one artifact:
   a tarball of the install tree (`cmake --install` into a prefix; the binary, `libopenrct2.so` if built
   shared, and the `data/` folder), named `openrct2-<tag>-openrct2-screensaver-linux-x64[-release]`.
   An AppImage is a second step only if the tarball proves awkward to run (a decision for after 4).
   Done when: the job is green on a manual run, and the tarball starts on the test machine with
   `./openrct2 --version` reporting the patched version and `--screensaver` entering the mode.
3. **Settings page launcher**: `settings.sh` beside `Settings.cmd` (`#!/bin/sh`, `exec python3
   "$(dirname "$0")/tools/settings.py" "$@"` in the background with output to the log folder, the same
   "only open the page if the server runs" behavior), executable bit set in git. `tools/settings.py` opens
   the browser with `webbrowser` already; check its "OpenRCT2 running" check and the executable path
   default (`openrct2` on `PATH`, else the setting) off Windows. README "Settings page" names both launchers.
4. **Mode test pass** on the Linux build (the owner, with `docs/testing.md` "Screensaver mode" extended
   by the rows below), under X11 and then Wayland:
   - the borderless window at the desktop's size, and `--screensaver` straight into the mode; Esc quits;
   - the overlay's text (patch 0013's font lookup: DejaVu or Liberation present; a missing font must fall
     back, not crash) and icons at scale factors 1 and 2;
   - mouse: the bar shows on move and hides with the cursor; every button works; the view editor's panel;
   - keys: arrows, Space, S, E, Shift as on Windows (SDL key names differ only in the engine, so expect
     no change, but check);
   - ride music and the fades (SDL audio under PulseAudio or PipeWire);
   - patch 0014: renderer switch (software and OpenGL, with and without multithreading; the OpenGL
     path is the one most likely to differ), volumes, weather, time of day;
   - the stock main menu's Screensaver button and its icon (patch 0015);
   - window style changes from the settings panel (borderless, windowed, fullscreen) under both
     display servers: Wayland may refuse to move or resize a window from the program; record what it does.
   Done when: every row passes or is listed in `docs/known-issues.md` with the display server named.
5. **Tools with the Linux executable**: once each on the test machine, `renderviews.py --openrct2
   <path>`, `drawviews.py` (its renders), `importparks.py` with one `.sv6` (`openrct2 convert`) and
   one loose-object download, `perfrun.py run perf/quick.toml --exe <path>` (the perf log with patch 0020,
   and `--user-data-path` sandboxes), and `mksequence.py --install` into the XDG user folder
   (`~/.config/OpenRCT2`). Fix path and process differences as they show (expected: the `.com` vs `.exe`
   choice in `renderviews.py`, process names in `userdata.py`'s running check, `pythonw` in the launcher).
6. **Hosting on Linux**: document the two ways and test one: a desktop entry or autostart entry that
   runs `openrct2 --screensaver`, and XScreenSaver's program hook (a `programs:` line in `~/.xscreensaver`;
   the window must take the `-window-id` it is given, which the mode does not, so this is likely
   documentation of the limit, not a feature). macOS `.saver` wrapper: out of scope, say so.
7. **Docs**: README "Installing" gets a Linux variant of step 1 (untar, run from the tree or symlink the
   binary; the data files' location) and step 4; "Running it" and "Wallpaper and screensaver hosting"
   get the Linux paragraph from 6; `docs/testing.md` gets the per-system rows from 4 and 5.

Progress: 3 done (2026-11-03: `settings.sh`, executable in git; the settings page defaults the OpenRCT2
path to `openrct2` on `PATH` off Windows; the running check is `pgrep -ix openrct2` there, the binary's
name in the tarball). 2: the `Linux x64` job is written (OpenRCT2's noble portable recipe: its
`openrct2-build:26-noble` image, `-DBUILD_SHARED_LIBS=ON -DPORTABLE=ON`, `build-portable` for the
tarball; tests and their build left out; the checkout is put on a branch named `openrct2-screensaver` so
`--version` reads `v0.5.6 (<sha> on openrct2-screensaver)`); green and merged (2026-11-03). 4 and 5: the test plan is `docs/testing-linux.md` (2026-11-04); expect the
overlay's text to be missing on Fedora, whose DejaVu/Liberation paths patch 0013 doesn't know.
5 passed headless on Ubuntu 24.04 (2026-11-04, `docs/testing-linux.md`); the tarball links ICU 74 and
libzip 4, which Fedora 42 likely lacks (the AppImage question).
2 (2026-11-04): Fedora lacked ICU 74 as predicted, so the workflow also builds OpenRCT2's AppImage
(`Linux x64 AppImage`, jammy image, clang 20), which runs there unpacked (`--appimage-extract`).
4 and 5 passed on a Fedora laptop under Wayland with the AppImage (owner, 2026-11-05; results in
`docs/testing-linux.md`): scale checked at 1.5, sound skipped, XWayland skipped (Wayland only), and
in-depth performance testing dropped (owner: the patches leave the performance-sensitive engine code
alone, so platform support is what needs establishing; one quick suite run passed). Fixed from the
pass: the stock Options window stayed visible in the mode (patch 0011), the settings page's Browse
folder and its "Not built yet" after a build on files dated in the future.
Basic Linux support marked done (owner, 2026-11-05) after two last changes: patch 0015 finds the
overlay's fonts by file name under the usual font folders (Fedora's text had needed links), and the
README's Installing has a Linux section (the AppImage, `--appimage-extract`, the RCT2 folder,
`~/.config/OpenRCT2`, an autostart entry for hosting). 6 is documented only (autostart; XScreenSaver's
window hook not supported); X11 stays untested.

Order: 2 and 3 can be built in cloud sessions now (2 is checked by the workflow run itself); 1 is the
owner's; 4-7 follow 1. Estimate: 2-3 a day; 4-7 a day on the machine plus fixes.

Decided (owner, 2026-11-03): the test machine is the owner's existing Fedora VM in VirtualBox (enough
for the functional tests; limits: Fedora's desktop session (KDE Plasma on the owner's VM) is Wayland, so X11 is likely only XWayland,
and OpenGL needs the VM's 3D acceleration on, else only the software renderer is testable there). The
build is the tarball first; if Fedora's library versions do not match the Ubuntu-built binary, the
fallback is OpenRCT2's own AppImage recipe, which bundles them. Still open: whether macOS gets a CI
build at all (OpenRCT2's macOS CI job could be copied the same way, but no one would test it).

## 2. Live view editor in the screensaver mode

Goal: set views on the playing park, in the mode, without the browser's drawing page.

Starting point: the simple editor on the overlay (`plugin/src/ui/editor-panel.ts`: a views list, Add
view and Set to camera, hold and pan, turn, rotate, zoom, Play), the editor logic in
`plugin/src/editor.ts`, and the drawing page's box model (`tools/drawviews.html`: a box on a render is a
view's window at its zoom).

Requirements:

1. **Boxes on the park.** While the editor is open, every view of the park is drawn on the overlay as a
   rectangle in screen space (the view's window at its zoom, projected through the current camera's angle
   and zoom; views from other angles as the numbered markers the drawing page uses), the selected one
   highlighted. The projection is the fitting code's (`plugin/src/fit.ts` already converts views to
   screen space). Boxes must follow the camera every frame while the user pans with the arrow keys.
2. **Drag.** Mouse down inside a box drags it (the view's x, y, z move so the box follows the cursor on
   the ground plane at the view's height; z unchanged); a handle on the box's corner changes its zoom by
   whole levels (the box snaps to the next size). Dragging the backing pans the camera. Mouse events
   come from the overlay's input path (patch 0011 passes mouse input to the plugin while the bar is
   shown); the overlay API needs no change unless hit-testing proves too slow, in which case a patch
   adds a `screensaver.hitTest` or the like.
3. **Add at the cursor.** A right click or an Add button places a new view at the cursor's ground
   position at the camera's zoom and angle; Set to camera stays.
4. **Edits are the simple editor's edits.** The same `RCTScreensaver.edits` entries (per park key, the
   window recorded as `screen`), the same "only real changes are saved" rule and the same pinning at
   install, so nothing changes in `mksequence.py`. Play (loop in the park with pans, replay from the
   selected view 1 s after an edit) is kept.
5. **Events and pans.** A view's cue and fixed flags are shown (an event view's box carries its label
   and is not draggable unless the user unlocks it); the pan line from each view to the next is drawn
   as on the renders (solid for a pan, dashed for a cut).
6. **The drawing page stays** alongside the live editor (owner, 2026-11-10: the two work in different
   contexts, the browser page on the generator's renders and the live editor in the running mode, and
   can exist in parallel). The two-park trial that was to decide a replacement is dropped.

Done when: the owner sets a park's views from scratch in the mode (add, drag, zoom, reorder, hold, pan,
delete), installs with `mksequence.py --install`, and the next run plays them as set; the boxes stay on
their spots at every angle and zoom. Estimate: two to three days, the projection and dragging most of it.

Decided (owner, 2026-11-03): dragging moves the view on a flat plane at its current height (the box
follows the cursor exactly, a view over a tower keeps its height), with Set to camera and a Fit button
to set the height afterward; boxes during Play with the editor closed (a review mode) are left out of
the first version.

Design (owner's go-ahead, 2026-11-09, thread "Explore live view editor implementation"): two modes on the
overlay editor. **Frame** (the default) makes the selected view the camera: dragging the park moves the shot,
the wheel zooms it, so what is seen is what plays; no engine change. **Map** (Tab) steps the camera out and
draws every view as a box to drag, as requirements 1-3 and 5 describe; its pan lines need a `line` overlay
element (a small patch in the mode group). Stages, one PR each:

1. Frame mode and undo. **Done 2026-11-09**; the Fit height button gave way to setting the height
   by itself on 2026-11-10 (owner's test: no visible effect) (`docs/screensaver-ui.md` "Live editing"; tests in
   `plugin/test/editor-unit.mjs` and `mode-run.mjs`, which now also runs on a small fixture playlist).
2. Map mode: boxes, other-angle markers, drag, a corner handle for zoom, right-click add, double-click
   to frame. **Done 2026-11-10** (built on without a test round, owner's call), on M rather than Tab
   (OpenRCT2 binds Tab to its map window) and with the corner handle instead of Shift+wheel (mouse events
   carry no modifier keys). Perf-log run 2026-11-10 (Tin Train held, OpenGL,
   1920x1200): an idle map costs nothing; panning on the map keeps 40 fps but the median frame's work
   rises from about 8 to 20 ms of the 25 ms budget (plugin 3.3 ms, paint 6.6, present 9), p95 38 ms.
   Box drags were not measured (the run hit the camera running past the map's scroll limit, fixed the
   same day); a run on a large park and with box drags is still to do.
3. Pan lines. **Done 2026-11-10** as dotted lines from overlay rects (no engine change); the `line`
   element waits for the perf run.
4. Event views (locked boxes with labels, an unlock button): **done 2026-11-10**. Requirement 6 settled:
   both editors stay (owner, 2026-11-10).

Owner's test round, 2026-11-10: stages 1-4 pass (rotation over a tall building, the map, box drag and
the corner handle, right-click add with undo, double-click framing, locked event boxes on Constellations
and Sambhava's Rest; install and play after map edits skipped). Repeated turns drifted the camera, as
each turn re-anchored on another surface; fixed the same day (the anchor is kept until the camera moves).

5. Editing UI (owner, 2026-11-10; mockups in the project files' `editor-ui/`, rounds 1-4): a views pane at
   the top left (park name as a dropdown: press and hold opens it and jumps on release, a click keeps it
   open as the playlist's park order with drag handles; views reordered by dragging rows); a toolbox at the
   bottom left (option A: a Frame | Map switch on top with a one-line hint, then View, Camera and the event
   lock, Hold and Pan, and a footer of undo, redo, reset view, the pin toggle and Play; icons with tooltips
   naming their keys; buttons that do nothing gray and flat); a block at the top right with the park's
   restore points (a list 3.5 rows high with a scroll bar: editor opened, checkpoints, last install,
   generated, each with its time; Restore works on the selected entry), Save checkpoint, Copy and Paste
   views (the drawing page's text format; needs a clipboard call in the mode's engine patches), and a
   Playlist section for playlist-wide settings (turns and zoom changes, inertia, time scale). Accepted
   after round 8 (motion moved into the box's foldable Playlist properties with timing and presentation;
   Save, Import, Export; restore points with times; the pin; Copy, Paste, Import and Export inactive for
   now) and built 2026-11-10 (`docs/screensaver-ui.md`, "Editing UI"); shipped as a beta in v0.3.0.
6. Later stage: the live editor on its own, without the generator (owner, 2026-11-10). Edits already
   play from the game's storage on every run; what still needs the generator (writing edits and the park
   order into the playlist files, building, the rest of the settings page's functions) is to be drafted
   for the live editor later. Plan approved 2026-11-10 (thread "Explore saving playlists without the
   Generator"): (a) engine patch 0016, plugin files in `<user dir>/screensaver/live` and the clipboard;
   (b) the plugin writes a live file per playlist on every editor save; (c) builds apply it, the settings
   page shows it and bakes it into the playlist (`tools/bakelive.py`, a plain Python call in the meantime).
   **Built 2026-11-10** (`docs/screensaver-ui.md` "Live file"); passed in the game 2026-11-10, released in v0.3.0. Rejected: the
   game writing the TOML (a second TOML writer), the settings server over a localhost socket (needs it
   running), launching Python from the plugin. Next (approved for the later plan): **the engine starts
   the build**, a patched `screensaver.build(playlist)` running `mksequence.py` with fixed arguments in
   the background, the plugin reading the result through the files API and swapping the new playlist in
   live (which also lets an install happen with the game open). **Built 2026-11-11** (engine patch 0017,
   `docs/screensaver-ui.md` "Builds from the game"): the editor's **Build and play** runs the generator that
   `--install` registered (`screensaver/generator.json`) in the background, shows its progress, and swaps the
   new build in by re-entering the park on screen (the plugin's own code and the parks' scripts come with the
   next install). Its own pane, bottom right (owner's draft 4, 2026-11-11): a square per park in play order
   (checks, amber warnings, red failures), the build's messages (a click on one about a park opens it),
   Ctrl+B, a "Building n/m" chip on the bar, and every build bakes the game's edits into the playlist files;
   the playlist's Save button gave way to saving as you change. A build from the game marks the settings
   page's renders old; ticking parks on and off stays on the settings page (until 2026-11-12, below), as does a shared park cache
   (owner, 2026-11-11). Not yet tested in the game. Copy and Paste views through `screensaver.clipboard` followed
   (2026-11-12), then Import playlist and Export playlist through the system's file dialog (engine patch 0018,
   2026-11-12: the game shows the dialog and runs the generator on the picked bundle; an import is built and
   played instead of the playlist), then parks and playlists in the park list (engine patch 0019, owner 2026-11-12:
   Use ticks, Add park, switching playlists, New playlist from a folder, Duplicate; `docs/screensaver-ui.md` "Parks
   and playlists"). The park library in the game is the next stage (`docs/roadmap.md`). After that: the live editor
   without the generator.

## 3. Weather and day/night in the generator (low priority)

Goal: the playlist decides the light and weather of the show rather than each park's saved date and the
stock climate.

Starting point: patch 0014 gives the title screen the climate and a time of day (day, night, the stock
cycle from the park's saved date); the mode's bar switches it live; the stock cycle is one in-game
month (about 6 min 50 s at 1×, four phases of about 1 min 42 s), restarting at each park's date; the
climate picks the next weather every 48 s at 1×.

Requirements:

1. **Cycle length** (engine, patch 0014 or a new mode patch): a mode setting `dayLength` in seconds of
   wall time at 1× that replaces the month-based phase (the light's phase computed from a counter the
   mode advances per tick, not from the date), and a `dayStart` phase (0-1) applied at each park load so
   a park can start at dusk. Plugin setting and settings panel rows; the bar's time-of-day button keeps
   day, night, cycle.
2. **Views repeated in the other phase** (generator): `[views] day_night = "repeat"` plays the park's
   views once by day and once by night (the park's time doubles; the second pass starts at the overview
   with `dayStart` 0.5), `"split"` plays the first half by day and the second by night (no extra time),
   default `"off"`. The plugin sets the phase at the pass boundary; the playlist carries the choice per
   park (`dayNight`).
3. **Scheduled weather** (generator and plugin): a per-park `weather` list in the profile or
   `[[park]]` entry, `[{at = <s>, weather = "rain"}]`, which the plugin applies on the park's clock through
   a new plugin API call (`screensaver.setWeather`, patch 0014's group) instead of the climate's random
   step; the climate's own changes are off while a schedule runs.
4. **Show exceptions**: a show view (`show = "eclipse"`) sets `light = "keep"` by default so the mode
   leaves the time of day alone while it plays and restores it after; a profile can override.
5. **Settings page**: Enhancements block gets Day and night (off, repeat, split) and the cycle length;
   per-park Adjustments get the weather schedule as text.

Done when: Constellations plays its views by day then by night with the eclipse untouched, and a park
with a rain schedule rains at the set second on three runs. Estimate: 1 half a day of engine work; 2-5 a
day. Owner's note stands: most custom parks show little at night (no recognized light emitters), so this
waits for a reason.

Decisions for the owner: whether "repeat" doubles the park's time or halves each pass's holds; whether
the weather schedule is worth a plugin API patch or the stock climate with a fixed seed is enough.

## 4. Caption frames: what the pilot left open

Done otherwise (2026-11-03). Canvas's plain stretcher edge (a second Canvas style without the gallery
frame) was dropped (owner, 2026-11-09). One leftover, small:

1. **A real blur for Aero**: an engine patch in the screensaver group that lets an overlay element ask
   for the frame behind it blurred (a box blur of the 32-bit frame under the element's rectangle before
   the element is drawn; cost a few hundred µs per caption at 4K, measured with the perf log), and the
   Aero style using it instead of the frost tile when the engine reports the feature. A day. The frost
   texture was preferred; this item exists only if the owner sees Aero on more parks and wants the blur.

## 5. Performance testing and overnight memory soaks

The rest of roadmap step 3 is grouped here (owner, 2026-11-07): next a PresentMon run (owner's OK,
2026-11-03) to tell the GPU's time from vsync waits in OpenGL's ~31 ms present, and simulation
throttling out of view only if the numbers call for it; the framework and first runs are in
`docs/performance-testing.md`. The soaks:


Goal: know whether memory keeps growing past the first hour, and catch the crash the owner saw after
hours of play (2026-10-30).

Starting point: `perf/soak.toml` with cells `full` (9 h), `no-background-loading`, `no-companions`,
`opengl`, `two-parks`; the 1 h short-park result (83 MB/h, 1.3 MB per switch, QuickJS heap 4.7 → 7.3 MB).

Requirements:

1. **Night 1, `full`** (needs the owner's OK that evening): `python tools/perfrun.py run perf/soak.toml
   --exe <patched exe> --only full --seconds 32400`, PC left on, the monitor allowed to sleep but no
   system sleep. Report the next day with `perfreport.py`: MB per hour over each 3 h third, the QuickJS
   heap's course, the image list's largest free run, per-park revisit growth, and whether a crash dump
   exists.
2. **Decision rule**: growth under 30 MB/h in the last third and no crash: done, no further nights. Else
   one night per suspect, in the order the numbers point to: QuickJS heap growing → `no-companions`;
   growth per switch → `no-background-loading`; growth tied to drawing → `opengl` against software;
   `two-parks` to tell park-dependent growth from the plugin's.
3. **Thermal throttling**: the report's frame times over time show a slow rise if the PC throttles;
   `perfrun.py` logs the CPU's clock (`wmic`/`Get-CimInstance` every 10 s sample) so the two are told
   apart. A small addition to the sampler.
4. **A crash's dump** is kept with the run (the cell's `user/crash` folder); the owner's crash of
   2026-10-30 happened on the stock-engine fade path, which is gone, so the first night also tests
   whether it is reproducible at all.
5. **Results** go to `docs/performance-testing.md` ("Soaks") and the report files to the project files
   with the earlier runs.

Done when: rule 2 is met or every suspect has its night and the growth is attributed. Estimate: an hour
of work per night plus the night.

## 6. Better default views (automatic views v2)

Goal: fewer near-tie losses of ride views to still scenery, a view budget that follows distinct content,
and better zoom -2 picks on large parks.

Starting point: the version 1 scoring and the options tested and left off (`docs/roadmap.md`,
"Background: view heuristics, first version"); `tools/viewstability.py` for stability; `renderviews.py`
and the settings page's Compare column for judging.

Requirements, each judged on the ten examples with renders before any default changes:

1. **A judging harness**: `tools/viewcompare.py` (or `viewstability.py --compare A B`) lists, per park,
   the views that differ between two builds with their scores and the runner-up's margin, and writes a
   contact sheet of before and after pairs from the renders; the owner marks each pair better, worse or
   same. Without it every round is the manual count of version 1.
2. **Near-ties**: a `tie_bias` option (default off): when the top two candidates of a cell are within
   `tie_margin` of each other, the one with the higher activity share (ride weight over total) wins.
   Targets: Troubadours castle, Constellations coaster ring, Sambhava bazaar, Ghillie Dhu v4. Judge: those
   four, plus no new regressions in the rest.
3. **Budget from distinct content**: `budget = "content"` (default `"tiles"`): the view count comes
   from the number of distinct cells (each grid's cells merged with its half-offset twin where both score
   above `fill_min`) that clear `min_score`, clamped to `base_views..count`, instead of built tiles.
   Judge: parks that gain or lose views, each gain a view the owner would keep.
4. **Zoom -2 on large parks**: a `close_fill` gate (default off): a zoom -2 candidate needs frame fill
   over `close_fill` (0.6) in its own window, not only the 2× fill window, and a `close_activity` floor
   (its activity share over the park's median). Judge: the zoom -2 picks on the five largest examples.
5. **Random-order options** (the roadmap's sub-item): each of `RANDOM_OFF`'s members becomes a value
   the random order takes from `[views]` when set explicitly (`tower_views`, `nudge`, `beads`,
   `pan_timing`, `ride_pans`); `districts` stays forced off. Tower views take the nearest close-up's
   angle in the pick order; nudges and beads work on the pick order's pans; a ride pair stays together at
   its place. `--set` and profiles work as for the circuit. In the settings page these show under View
   order only when random is chosen. Judge: `playlists/example.toml` with `route = "random"` and each
   option on, on the renders. Half a day each for 1-5.
6. **Name rule for open prop rides** (moved here from its own item, owner, 2026-11-09): a ride pan
   never follows a prop run as an open ride (Bangkok Dynamo's `_Traffic` is open, so `ride_status =
   "open"` keeps it). `[views] ride_names = "named"` (default): a ride whose name begins with `_` or is
   the stock default (an empty `customName` in `parkinfo.parse_rides`, the name then being `<type>
   <nameNumber>`) counts as a prop and is skipped by `ride_pans`; `"any"` keeps today's behavior. A
   skipped ride goes to `ridesTurnedDown` with reason `name`. `tools/ridesurvey.py` prints the rule's
   skips; run it on the imported library once and list any good run lost. Judge: Bangkok Dynamo's run
   moves to another ride or none, and the 107 library runs lose none the owner liked. An hour. Decision:
   whether a default-named ride (`Wooden Roller Coaster 1`) counts as a prop; the safe first version uses
   the underscore only.

Done when: a candidate default set gives more "better" than "worse" on the owner's sheet over the
examples and a 20-park library batch, with stability (±5%) no worse than 15% moved; then the defaults
change in one PR with the before/after sheet attached. Estimate: three days spread over rounds.

Skipped for now (owner, 2026-11-03). When it is taken up: which of 2-4 to try first (recommended: 1
then 2, as the near-ties are the recurring complaint; 6 is an hour and can go first); whether 5 is wanted before the random order has
a user.
