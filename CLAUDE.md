# RCT Screensaver: working notes

Wallpaper-style live backdrop built on OpenRCT2's title screen: plays a list of parks and
views with controls for holding a view, cycling views, moving between parks, and speed.
See README.md for usage.

## Decisions
- **Build on top of OpenRCT2, never fork it.** This repo holds tools, a plugin, and (later)
  a small patch set against OpenRCT2 plus a build script. Target the latest OpenRCT2
  release (currently v0.5.6), not `develop`.
- **Title screen, not a separate renderer.** Extend the title scene. Wrapper scope (owner,
  2026-10-31, `docs/wallpaper-wrapper.md`): one borderless window, our minimal UI drawn by an engine
  patch in place of the stock windows, a screensaver mode from a main menu toggle or a launch flag;
  multi-monitor out of scope; wallpaper/`.scr` hosting left to other tools (per-OS). The mode's
  settings are separate (plugin storage, applied in memory, never `config.ini`), and the main menu
  gets only the toggle button: the editor and other title-screen additions live inside the mode.
  Mode UI (`docs/screensaver-ui.md`, owner 2026-11-02): controls bar and load cover, then captions, then a
  simple editor (a "live" editor is a roadmap enhancement); the look follows the stock main menu (square
  buttons, sharp corners, partly transparent backings). The controls bar (`plugin/src/ui/`) shows on mouse
  move and hides with the cursor: previous park, previous view, Hold, next view, next park, then a smaller
  row below: speed, shuffle, titles, music (an off/ride-music toggle), time of day (day, night, cycle; icons; titles drive the park name captions, `ui/captions.ts`, top left) (caption styles, owner 2026-11-03: gold, silver, wood portrait frames, Minimal dark and light, Aero (a frost texture, no blur), Canvas in a gallery frame; an Accent color; picked in the settings panel's Title frame flyout), edit views (the
  view editor on the overlay, `ui/editor-panel.ts`; the stock engine keeps its window; an Events list under the route for timed event views, 2026-11-10; live editing, stage 1 of the live editor (owner 2026-11-09, `docs/enhancements.md` section 2): a drag on the park moves the selected view, the wheel zooms it, a view set from the camera sits at the height of what is at the screen's centre so turns pivot on it (a Fit height button was unclear in the owner's test, 2026-11-10), Ctrl+Z/Ctrl+Y undo; the map on M, `ui/view-map.ts`, 2026-11-10: every view a box or marker with dotted pan lines, drag boxes, corner handle zooms, right-click adds, double-click frames, event views locked; since 2026-11-10 three panes, the owner's design: views with a park dropdown and drag reordering top left, an icon toolbox bottom left, restore points and Playlist properties top right, saved in the game and written to the playlist by `--install`, `docs/screensaver-ui.md` "Editing UI"), settings (a panel with the stock
  options that apply to the mode: window style, light effects, weather gloom; owner 2026-11-02). Icons are
  PNGs drawn by `tools/mkicons.py` at every output size.
- **Languages:** Python wherever there is a choice (stdlib only). The plugin must be
  JavaScript, so it is TypeScript compiled with Node to a single file.
  Docs and visible text (UI labels, page text, CLI help and messages, logs) use US English; code
  names and API keys follow OpenRCT2's UK spelling (`Colour`, `centre`) (owner, 2026-11-03).
- **View generation is our own configurable code** (`tools/mksequence.py`). Default method
  `spots` (chosen by the owner 2026-10-26): an overview first (flag `overview`, zoomed by the
  plugin to fit the content in the window), then close-ups whose zoom varies freely: cells at
  sizes for zoom_min..zoom_max (32 tiles at zoom 0, halving per level in, inside the content
  box, on two grids offset by half a cell), split into height layers where the elements leave
  an empty band over half a screen tall at that zoom (owner: two interest areas can share a
  column), each scored count (per tile capped at the 90th percentile) × occupancy relative to
  the median of its zoom level's best quarter. Elements are weighted (owner, 2026-10-26: favor
  rides over static scenery) so path, track and entrance elements carry `activity` (0.5) of
  the park's total weight and static scenery the rest; the cap, scores and each spot's anchor
  (x, y, z) use these weights, so views aim at the rides. Frame fill (2026-10-29, after the
  owner's live test of the circuit found many views "highly occluded": the renders showed the
  picked spots clear of buildings but the void, cliff walls and the map's edge filling half the
  frame, and zoom-0 close-ups repeating the overview): `frame_rasters` paints the whole map per
  angle, back to front, into 32 px blocks (elements over their own height span, land, walls under
  terrain drops; the map's backdrop, a ground height over half the map with nothing on it or an
  element sheet over 30% of the tiles, counts as void, like elements under shallow water), and a
  candidate's score is multiplied by its window's fill squared (`fill_power`; bare land 0.3;
  `fill_min` 0.5 drops the rest). The fill window is `fill_window` (2) × `[views] screen` (1920x1080 game pixels, the window judged in: a 4K monitor at scale 2.0; phase 7 below). A cell part taller than a screen at
  its zoom is sliced into screen-tall windows half a screen apart, each its own spot. Spacing counts height (16 px = 1 tile). One rule for every park
  size (owner, 2026-10-26): candidates are (cell, angle) at zooms closer than the overview,
  scored × the share not hidden from that angle (a tile's top T is hidden when a tile k steps
  toward the camera holds ground or an element at height T + 32·k; `rotation = "auto"`), picked by score ÷ (1 + views its zoom
  level has). Same angle: a gap of half the larger cell (≤ a quarter of the content size); the
  overview only rules out whole-box cells from its angle. The same spot from another angle
  keeps ≥ ANGLE_REPEAT (0.5) of its score, must score ≥ min_score, and is taken only while the
  park has < base_views views, so view count still follows distinct spots. Scores fall off
  within a zoom-0 cell of chosen views; a culled cell's score goes to the nearest close-up's
  hold. The plugin's per-angle fallback (zooming out to ≤ 0) is only a safety net. Close-ups
  default to zoom -2..1 (owner brought -2 back 2026-10-26, to re-evaluate if it picks static
  detail; owner: discourage it on large parks, so spots are weighted (5·cell/size)² when the cell
  is under a fifth of the content size; on parks whose overview zoom is > 0, no zoom whose cell exceeds
  `wide_limit` (0.5) of the content size, so no second overview; owner, 2026-10-27); the overview holds ≥ 2 s longer than any close-up (owner), keeps the saved angle, sits
  at the elements' mean position and height, and is capped at zoom 0 only for parks whose flat
  footprint fits at zoom ≤ 0. View budget (owner, 2026-10-26): base_views + log2(built
  tiles / budget_tiles), clamped to base_views..count (4-8 views, 30-50 s on the examples);
  every tuning value is a `[views]` option in VIEW_DEFAULTS (owner: adjustable from one place).
  Timing (owner's rule): 30 s per park for up to 4
  views, +5 s per further view (1 s to the overview), ≥ 5 s each, the rest by score; the plugin
  rescales holds to `parkTime` after fitting. `grid` (one zoom, 32-tile cells) remains.
- **Controls:** Left/Right = previous/next view, Shift+Left/Right = previous/next park,
  Up/Down = speed, Space = hold toggle (press to hold, press again to release), S = shuffle (park order only: while on, the next park is picked at random from those not played this round, on S and at each park load; owner 2026-10-31),
  E = view editor (while open, arrows pan the camera, Shift faster; its Play button plays the park's
  views with pans, looping in the park, replaying from the selected view 1 s after each edit; owner
  2026-10-28).
- **View panning** (`plugin/src/pan.ts`, notes in `docs/view-panning.md`; plugin side finished, owner
  2026-10-28; generation heuristics for panning views are separate work):
  owner: per-view `pan` share (default 0 = held still, then a cut, the old behavior unchanged):
  the end of the view's hold pans to the next view (every game tick). Static vs. panning is to be
  a matter of view generation (heuristics later); `[views] pan` sets one share for now. Angle and
  zoom change only at one end of a pan (`panChanges`, default "end", owner 2026-10-28: mid-pan
  steps break the smooth effect); two-step changes (opposite angles, 2+ zoom levels) split
  between the ends; ≥ `changeHold` (2 s) still after any change and an `arriveHold` (1 s) rest at the spot before
  a change on arrival, added to the view (owner);
  `inertia` on/off (cubic ease vs. linear, default off; sine looked like linear); a pan over
  the speed tolerance at the zoom it runs at (owner 2026-10-28; once a flat 100 px/s `panSpeed`/
  `symmetricZoomThreshold`) travels one level out between views at one zoom, or at most at the wider
  view's zoom between zooms; generated overviews
  always pan 10% with changes at the end (owner); keys/editor cut; a park's last view
  pans back to its first (owner), to a wider first view zooming out as it goes (one level out at the
  start with no still after it, further levels mid-pan, any turn on arrival after the rest, equal time per level at one screen speed, checked at the widest zoom;
  owner 2026-10-28): looping alone (one park, editor Play) the first view plays on,
  otherwise it holds there `returnHold` (2 s) and the next park follows; Space pauses
  a pan. Set in the editor and the browser tool too (`playlists/pan-compare.toml`: four parks at
  pan 0.6). Speed evaluation (owner approved, 2026-10-28): rate `playlists/speed-ladder.toml` (512 px
  pans, zoom -2..1 × 25-400 px/s; first run: 100 px/s the first smooth step, 400 acceptable but too
  brief; second run 1536 px at 200-800 px/s: 800 still legible at -2) → tolerance `pan_tolerance` 500
  px/s at zoom -2, `pan_tolerance_step` 100 less per level out (owner); `mksequence.py` reports pans over
  it (scores.json `pans`), `cameralog.py` flags them; generation stretches any generated pan over it in 100 ms steps until it fits
  (owner; overviews exempt: a special case, no stretch); the park's tolerance travels with the
  playlist (`panTolerance`); a view's `zoom_threshold` replaces it. The first try (short glides) was too fast.
- **Plugin architecture:** the plugin drives views and timing itself; the built-in title
  player only loads parks (plugin seeks to a park's `LOAD`). The default "plugin" sequence
  layout is LOAD + first view + a 4 h wait per park. The full view list reaches the plugin
  via shared storage (`RCTScreensaver.playlist` in `plugin.store.json`), written by
  `mksequence.py --install` while OpenRCT2 is closed. Plugin settings live in
  `RCTScreensaver.settings` (including the chosen speed, re-applied after every park load,
  since loading a park resets it to 1×).
- **Hand-set views:** set in the plugin's title-screen view editor (the title screen leads to
  the planned minimal-UI presentation, so editing lives there, not in normal play). Edits are
  saved per park key (`file` basename, plus `|member`) in `RCTScreensaver.edits` and replace
  that park's views at once, unfitted. `mksequence.py --install` moves them into
  `<playlist>.views.json`, which overrides the TOML's `view` list and generation. A park's
  first edit starts from the views it was playing (fitted to the current window). Only real
  changes are saved, and an edit is pinned at install only if it has a `manual` view or is
  `arranged` (reordered, deleted from, holds changed). `--ignore-edits` skips the views file
  (owner: use it for every test install while tuning the generator). Drawn views get the park's event
  views (animation stops, cut-ins, shows) on top at build where events are on (owner, 2026-11-01).
  Live file (owner, 2026-11-10; `docs/screensaver-ui.md` "Live file"): on the patched engine (patch 0016,
  files in `<user dir>/screensaver/live` and the clipboard) every editor save also writes the playlist's
  edits and properties to `live/<sequence>.json`; every build applies it (`--ignore-live`), and
  `tools/bakelive.py` (the settings page's "Bake into playlist") writes it into the playlist files and marks
  it baked, so users need no install to keep their edits. Builds from the game (engine patch 0017, 2026-11-11;
  `docs/screensaver-ui.md` "Builds from the game"): the editor's Build and play has the engine run the generator
  named in `screensaver/generator.json` (written by `--install`) as `mksequence.py --live-build <sequence>`, then
  `screensaver.applyBuild` copies the build into the playing sequence and reloads its script, and the plugin
  swaps the new playlist in (`builder.ts`, `Player.swapPlaylist`). The editor's bottom-right Build pane (owner,
  2026-11-11): squares per park in play order (`parkStates`), park-tagged messages, Ctrl+B, a bar chip; every live
  build bakes the live file first; Playlist properties save as they change (no Save). Next: Copy/Paste through the clipboard.
- **Palette index 10** is both the void outside the map and the UI black; a packed water
  object that lightens it (Gardens of Light) washes out the stock interface (the white void was intended, but the UI must not suffer).
  Engine patch 0001 splits the two properly (the viewport painter rewrites its own index-10
  pixels to index 9, which holds the park's color; the interface keeps the stock black). The
  generator's rewrite of such water objects in the sequence copy (`fix_ui_palette`, `--keep-palette`), a stopgap for
  the stock engine, was dropped for the release (owner, 2026-11-03). Other UI colors still take the park's palette (stock behavior); a per-pixel split was
  dropped (owner, 2026-10-27: translucent windows/text, and the minimal-UI presentation makes it matter less). Confirmed by the owner on
  Gardens of Light (2026-10-27): the whole world white, interface black, other parks unchanged.
- **Park loads on the stock engine are a cut and a freeze:** the plugin's fade through a
  full-screen black window (dithered scanlines, as the drawing API has no transparency) was a
  stopgap, dropped for the release (owner, 2026-11-03); the patched engine loads in the
  background and the mode dips through black on the overlay. The freeze is mostly `ObjectManager::LoadObjects` loading the new park's objects
  and unloading the old ones; keeping objects loaded across title parks would need an engine patch.
  Preloading the next park's objects from the plugin (`objectManager.load()`) was measured on
  the owner's PC and dropped (2026-10-26): it saves only 0.1-0.4 s of a ~0.3-1.4 s switch, the
  park file parse and map rebuild cannot be preloaded, and a few objects take 150-750 ms to
  load, which stutters playback.
- **Engine patches (`engine/`, design and measurements in `docs/engine-patches.md`):** the
  patched title player reads, imports (into a second `GameState_t`, swapped in) and registers the
  next `.park` while the current park keeps playing; the switch itself costs about 15-30 ms of
  main-thread work. `TitleSequence.backgroundLoading` tells the plugin, which then skips the
  fade. Patches are `git format-patch` output against the tag in `engine/VERSION`;
  `.github/workflows/engine.yml` builds Windows x64 binaries (about 15 min) that replace
  `openrct2.exe`/`openrct2.com` in a stock install, plus a Linux tarball (Ubuntu 24.04 libraries) and an AppImage (any distribution; Fedora uses it), on pushes to `main` touching `engine/`
  or by manual run (pick the branch). The series is grouped by topic (owner, 2026-11-03; table in `engine/README.md`): 0001 palette,
  0002 ride music, 0003-0008 background loading, 0009-0010 plugin API, 0011-0017 screensaver mode, and last
  0018 diagnostics (park load timings and the perf log), which stays for testing and is dropped for release
  (owner, 2026-10-27). Patch comments carry no project name and use US English, so groups can go upstream. Patch 0002 adds "Ride music" to Options → Sound → Title screen music
  (`title_theme = 5`): the parks' ride music follows the view on the title screen instead of a theme. It
  cross-fades across park switches (1.5 s) and plays a park's single custom music object evenly (centered, any view).
  Patch 0009 adds `TitleSequence.fadeSounds(level, ms)`; the plugin fades effects and positional ride music out
  before each scheduled view change (a park's last view included) and in on every view (owner, 2026-10-28). Patches 0011-0013 (2026-10-31, `docs/wallpaper-wrapper.md` "Progress") add the screensaver mode, the
  menu button and the overlay with the `screensaver` plugin API; new code in `src/openrct2-ui/screensaver/`. Patch 0010
  (2026-11-02) lets the plugin hold a background park switch (`TitleSequence.nextParkReady`, `holdSwitch`; at most
  10 s once ready): in the mode, park changes dip through black on the overlay (owner). Patch 0015 draws the main menu's Screensaver icon (a monitor with a park, `tools/mkmenuicon.py`) and game
  sprites on the overlay (`sprite:<index>`: the mode's stock exit button, bottom right, shown with the bar, as Esc). Patch 0014 (2026-11-02) adds the mode settings for
  renderer, volumes, weather effects, and lets the title screen run the climate and set its time of day (stock: play only).
  Generator support for weather and day/night (cycle length, views repeated in the other phase, scheduled weather, show
  exceptions) is a roadmap enhancement (owner, 2026-11-02). A Linux CMake build of the patched tree is
  the fast compile check in cloud sessions; the owner's PC has a Visual Studio clone for
  iteration (`RCT\engine-src\openrct2`, `scripts\vstool.cmd msbuild openrct2.proj /p:Configuration=Release`; without it the build is Debug and plays like a slideshow: full build
  3 min 42 s, incremental 30-40 s; the owner copies `bin\openrct2.exe` into the portable install
  themselves, as the PC's permission check blocks that step for Remote Control sessions).
- **Performance testing** (roadmap step 3, a potential enhancement since 2026-11-07 grouped with the overnight soaks; `docs/performance-testing.md`; owner 2026-11-02: automated
  and log-based, not manual): engine patch 0018 `--perf-log` writes per-frame stage times (tick, plugin,
  input, paint, present, with the camera), 10 s samples (memory, handles, QuickJS heap, image list
  fragmentation, entity counts) and events (load stages, plugin marks); it stays in every build until
  release. `tools/perfrun.py` runs the suites in `perf/` in sandbox user folders (`--user-data-path`,
  approved by the owner) and `tools/perfreport.py` labels frames and compares runs. Dimensions: renderer
  (software/OpenGL × multithreading), cuts/pans, zoom, simulation size (guests, vehicles, entities; owner:
  a dimension of its own) and drawn size, features on/off, memory over hours. Overnight runs only after
  the owner's explicit OK each time; survey sample 20 parks; PresentMon after the first results. First
  runs done 2026-11-03 (reports in the project files); PresentMon approved next; overnight soaks moved to the roadmap's
  potential enhancements (owner, 2026-11-03).
- **Per-park profiles** (`parks/<slug>.toml`, format in `tools/profiles.py`; design doc "Per-park
  enhancements: storage and build-time merge", 2026-10-30): what a park needs beyond the general
  heuristics, kept once per park and merged into every playlist that plays it, matched by saved
  name (+ map size, + file name to break ties). Merge order: playlist `[views]` and `--set` <
  profile `[views]` (fixes, always) and `[extras]` (animation views, shows; only with the
  playlist's `park_plugins = true`, owner: off unless a playlist enables them) < the playlist's
  `[[park]]` entry < editor edits. Companion spots and shows are defined in the profiles (they
  were `SPOTS`/`SHOWS` in `tools/companions.py`) and read even with `--ignore-profiles`.
  Entries can pick (`profile = "<stem>"`) or skip (`profile = false`) one. The Koi Pond's profile
  sets `rotation = "keep"` (all views from the saved angle; a fixed rotation now sets every spots
  view's angle at generation, as the route steps need it); `[views] angle_weights` (default
  [1, 1, 1, 1], from the saved angle, 0 = never) is the softer per-park bias. `[companion.<name>]`
  in a profile patches what that companion reads from park storage (by object `id`) and can pause
  it while the camera moves or is zoomed out past a level (Sambhava's mist: faster fade at rest,
  no work during pans, a twentieth of its pace at zoom 1 via `zoom_rates`, none wider; patch paths
  index arrays, `frames.0.actions.0.randomize.factor`; owner's live test
  2026-10-30: Koi Pond, mist and eclipse work; Sambhava's mist approved). A show view can carry a camera `path` in game ticks
  (the eclipse glides along the shadow's diagonal at zoom 0 to (112,117), at the view's height; the
  show view's own `pan` is the share of the path's time its moving legs take, `[views] show_pan` 0.5
  for generated show views, owner: with a share, one even glide through the points, then the hold at
  the end; the view stays until the camera arrives; show steps can wait
  `waitTicks`; a show's `path_step` (an index into its steps, -1 the last) holds the glide until the
  show reaches that step, which the host reports with `rctscreensaver-showstep`; `show_at`, an index
  into the park's views with -1 the last and the default, places the show view, owner 2026-10-30).
- **Parks' companion plugins** (`docs/companion-plugins.md`): a `.park` holds only plugin data;
  the code ships as `.js` in the zip, and the title player never starts `local`/`remote` plugins.
  `mksequence.py --install` wraps each park's `.js` in a generated intransient plugin
  (`rct-screensaver-companion-*.js`, host in `plugin/src/companion-host.ts`) that runs it only on
  its park (saved name + map size) and stops it at each park change; windows are hidden stand-ins
  and the camera stays the screensaver's unless `companion_camera = true`. Prototype, 2026-10-27.
  Owner, 2026-10-27: a companion's scripted show is a per-park option played as the park's last
  view, held until the show is over (`show = "eclipse"`), and views can be flagged on animation
  spots (`animations = true`, or `animation =` on a view); flagged views are never fitted.
  A playlist runs the newest version of each companion any of its parks ships, on every park
  whose storage holds that companion's data (AdvancedTrack data is often there without the code).
  Event-timed animation views (2026-10-30, `View.cue`): a view waits for its trigger (a car of a
  ride on tiles, listed cars, or a tick on the park's clock), stays while the effect runs, can
  follow a train, and with `cut` interrupts playback when cued; `companions.py` derives cues from
  Animator, AdvancedTrack, AnimationService and RCTAnimator data (`animation_cues`, `cue_hold` 5 s,
  `cue_wait` 30 s). `mksequence.py --animations` lists each park's animations (also in scores.json);
  a profile's `[animation."<name>"]` changes one (`off`, `hold`, `z`, `zoom`, `rotation`, `cue` table or false).
  Timeline cut-ins (owner, 2026-10-30): a `cut` view with a `tick` cue pans there `lead` s ahead, and
  the park's views loop until every one has played (Yucca: seven UFO views on schedule, replacing the
  overview show). Cut-in views are listed after the route view on screen when they first come due
  (owner, 2026-10-31; listing only). Event views are optional at build time (owner, 2026-10-31): `[views] events = false`
  (or `--set events=false`, or the playlist's `park_plugins`) leaves every animation view out with the
  ordinary views and their order unchanged (pan_timing decides drops on the route without its stops;
  only the hold of a view whose pan led to a stop changes). AdvancedTrack lifts are off by default (hidden in towers or never running).
  Measured train timings: the camera log notes each car cue's arrivals; `cameralog.py --triggers` prints
  first tick and lap per animation as a profile cue `{tick, lead, cut, every}` (a repeating timeline cue).
  Continuous animations (no cue) are ordinary stops of a generated park's circuit (owner, 2026-10-30):
  `route_stops` inserts each at its cheapest place, `fixed`, its still on top of `park_cap`.
- **View fitting is done by the plugin at run time**, because it depends on window size and
  zoom: `mksequence.py` stores each park's content box (tiles with 2+ elements weighted by count squared, 1% trimmed
  per side, plus ground and top heights), views sit at their cell's mean element height,
  and the plugin clamps views to them in screen space and merges near-duplicates (same angle,
  closer than a quarter of the smaller screen; with an overview, close-ups that would show the
  whole content are dropped). If that
  leaves fewer views than the park's `count` and the content fits the screen's width, the
  remaining views (after the overview) become one per angle, spread from base to top when the
  content is taller than a screen;
  those are centered on the screen-space extent of the loaded park's own elements (scanned with
  `map.getTile` after the load, same weighting as the content box), falling back to the box. The built `plugin/dist/rct-screensaver.js` is committed so
  local testing needs only Python; rebuild it with any plugin change.
- **Workflow split:** development in cloud sessions (no game data there); running and
  testing in local sessions on the owner's Windows 11 PC, which has RCT2 and Visual
  Studio. Patched engine builds will come from GitHub Actions. Launching the game from a
  session: start `openrct2.exe` with a normal window (PowerShell `Start-Process`, output
  redirected to a new log per launch, `build/logs/openrct2-<YYYYMMDD-HHMMSS>.log` and `.err.log`,
  never overwriting an earlier one (owner, 2026-10-30: a relaunch had overwritten the log holding a
  companion crash)), not from a hidden detached `cmd.exe`: Windows then
  refuses the window the foreground (2026-10-30; the owner had to fight the taskbar either way).
- **Never commit RCT2/RCT Classic game files** anywhere.
- **License: GPLv3** (owner, 2026-11-03; `LICENSE`), as the engine patches derive from OpenRCT2 and
  the repo includes its `plugin/types/openrct2.d.ts`. The plugin's `package.json` says
  `GPL-3.0-or-later`.
- **Park files never go into the repository** (owner, 2026-11-03): the example parks are downloads
  listed in `ExampleParks/README.md` (the folder is git-ignored); derived data (profiles, analysis,
  the NE catalog) may ship. Playlists that need the owner's library stay on the PC.

## OpenRCT2 facts established from source (v0.5.6-era `develop`)
- Title sequences: `script.txt` + parks in a folder (or zipped `.parkseq`) under the user
  `sequence` directory. Parser: `src/openrct2/scenes/title/TitleSequence.cpp`.
  `#` starts a comment anywhere; `LOAD` takes the rest of the line as the file name;
  tokens are capped at 127 chars. `LOCATION` x/y are 8-bit tiles; `WAIT` is 16-bit ms
  converted to game ticks (40/s); `ZOOM` is absolute; `ROTATE` is relative to the
  current view (after `LOAD`, the park's saved rotation).
- `END` does not stop playback: like `RESTART` it is only a marker and the player wraps
  to the start (`TitleSequencePlayer::IncrementPosition`).
- Only `intransient` plugins run on the title screen. The title player loads parks
  without `GameLoadScripts()`, so park companion plugins (`local`/`remote`) do not run.
- Plugin API: `TitleSequencePark.load()` switches to normal game mode, so it cannot
  change parks on the title screen. `TitleSequence.play()` previews a sequence on the
  title screen; `seek(i)` to a `LOAD` command loads that park cleanly in either
  direction. Seeking forward to a non-`LOAD` command fast-forward the simulation
  through intermediate `WAIT`s; seeking backward reloads the park.
  `TitleSequence.commands = …` saves the script to disk. `play()` loads the sequence
  and executes its first `LOAD` synchronously; `seek()` to a `LOAD` only sets the position,
  and the park loads on the player's next update (the freeze happens there).
- Plugin API version for v0.5.6 is 124; plugins run on QuickJS-NG (ES2020+ is fine).
  `gamesetspeed` accepts 1–4 (up to 8 only with debugging tools); `context.gameSpeed`
  returns that 1-based value despite its doc comment.
- Shared storage keys are dotted paths into nested JSON objects
  (`RCTScreensaver.playlist` → `{"RCTScreensaver": {"playlist": …}}`). OpenRCT2 reads
  `plugin.store.json` when plugins load and writes it on every `set()`.
- Arrow-key map scrolling is disabled on the title screen
  (`InputManager::handleViewScrolling`), but arrows remain bound to the scroll shortcuts.
- `.park` files store tile elements on the full 1001×1001 grid regardless of map size.
  Maps up to 1001 tiles open in the stock engine; parks past tile 255 (Europa-Park 365×327) need
  no engine patch, only the title script's `LOCATION` is 8-bit (left out by the plugin layout).

## Layout
- `ExampleParks/`: the example parks' download list (`README.md`); the zips are local only. Analysis: `docs/example-parks.md`.
- `parks/`: per-park profiles (see "Per-park profiles" above). Settings and coordinates only, never game files.
- `playlists/`: TOML playlists. `tools/mksequence.py` builds a title sequence from one.
- `tools/parkinfo.py`: reads `.park` files directly (no game needed), from a file, zip or folder;
  also the shared download rules: junk (`__MACOSX`, `._*`) ignored, the latest then largest park
  wins, working-title names (Workbench, blank, codes only) fall back to a logo/icon image in the
  download, then the download's name (owner, 2026-10-27).
- `tools/nedesigns.py` + `tools/data/nedesigns.json`: the New Element Designs catalog (4981 parks: name,
  release date, builders by share; crawled 2026-10-30 from the site's public API, crawl and match scripts
  in the project files' `nedesigns-crawl/`). A download named like NE's zips (`YYMMDD-game-builders-name`,
  or `name-<NE id>`) is matched as the crawl's match.py did (476/476 EvenMoreParks downloads agree);
  `parkinfo.display_name` takes the NE name first and `parkinfo.download_authors` the NE builders
  (importparks.py, the settings page's scan, loose `.park` files included); other download names never match.
  A build checks every entry without `author` against the catalog (and the file name) and fills it,
  with a warning either way, so captions get their byline (owner, 2026-11-03).
- `tools/importparks.py`: park downloads → library of gzip `.park` files + playlist; converts
  `.sv6` with `openrct2 convert`, installs loose objects under the user `object/rct-screensaver/`
  (`installed.json` there: which import, by its downloads, uses each file; an import replaces only
  its own, 2026-10-31). Python unit tests: `python -m unittest discover -s tools/tests`.
- `tools/livefile.py`, `tools/bakelive.py`: the game's live file (edits from the mode's editor) and baking
  it into the playlist files (see "Hand-set views").
- `tools/unzstd.py`: zstd for v0.5.x parks (stdlib `compression.zstd` on 3.14+, else
  `zstandard`/the `zstd` tool, else a plain-Python decoder, ~3-6 s per park).
- `tools/viewstability.py`: rebuilds views with each spot's score jittered (±5% by default) and
  counts close-ups that move; `--set option=value` compares variants. Baseline (2026-10-26):
  16% move at ±5%, 30% at ±10% (v1 defaults with the wide guard, 2026-10-27: 15% at ±5%), mostly near-ties (picks often lead the runner-up by < 3%).
  Each build also writes `<sequence>.scores.json`: why each view was picked.
- `tools/drawviews.py` + `tools/drawviews.html`: draw views as boxes in the browser on headless
  renders of each park from all four angles (`openrct2 screenshot` with a known viewport, so a box
  maps exactly to a view); saves pinned (`arranged`) entries into `<playlist>.views.json` as it
  goes. Separate from the in-game editor by the owner's choice (2026-10-27); both stay now that the mode's
  map drags boxes too, as they work in different contexts (owner, 2026-11-10). The settings page serves it as its view-drawing page (owner,
  2026-11-01: Edit views in the park list or on the renders page, on the last build; Copy/Paste of a
  park's views and event settings as text; the Events panel, with event times in seconds; Reset views
  only there; owner, 2026-11-02: opens before a build by building first, manual parks badged on both pages,
  inertia playlist-wide only; a generator update is told apart from park changes; renders reuse unchanged pictures). `mksequence.py --cache DIR` keeps resolved parks so a build redoes only changed ones
  (`ParkCache`, `changed_parks`; the park list flags them).
- `tools/districts.py`: prototype for pan-based generation (second version, 2026-10-29): each park's
  points of interest (the picker's choice with a budget of 24, snapped onto built tiles; towers found
  from height above their surroundings, zoomed to fit; companion animation spots) grouped into
  districts by the content's continuity (watershed of the smoothed element density with cliffs as
  dividers, basins merged across shallow dips), drawn flat from above (stdlib only) and with
  `--renders` on drawviews.py's cached four-angle renders (Pillow), for judging without the game. Third
  version (2026-10-29, after the owner's look at v2): elements under water do not count (sea-floor
  rocks under a cable made close-ups on open water; `parkinfo.water_heights`; only water up to `water_depth` 24 steps deep, as The Koi Pond is a scene built 70 steps under water), towers are read from
  the structure's height profile over 2 tiles (`tower_gap` 8 cuts off tracks and cables passing
  overhead and objects floating in the sky, both of which made false towers) against the
  `tower_ring` (0.8) percentile of the built tops around, and basins that could stand alone do not
  merge past `district_max` (0.4) of the park's points (two thirds of San Avaiki in one district
  was out of proportion). Still open: a lighthouse and a lookout on San Avaiki's coast stand
  only 11-15 steps above the town around them, under `tower_rise` (24).
  `mksequence.py --route` prints route metrics (length, turns, bends, sweeps) per park; always in
  `<sequence>.scores.json`. `[views] route` (phase 2, 2026-10-29): `"circuit"` (default; owner: static play uses it
  too) reorders a park's generated close-ups into the cheapest closed loop by pan time, change costs and
  shape penalties (`circuit_order`); `"picks"` is the old pick order; `"random"` (2026-10-31; the owner's
  "Circuit or Random pick order", 2026-10-29) is the generator as it was before the circuit: phases
  3-6 off (`RANDOM_OFF`: no district homing, tower views, nudges, beads, pan timing or ride pans), the
  views in their pick order, which varies angle and zoom; no shuffle (the old method never had one).
  Event views come on top: route stops at their cheapest place, panning with `[views] pan`, and
  timeline cut-ins on their ticks. Phase 3 (2026-10-29,
  `district_views`, `[views] districts`): close-ups labeled by districts.py's watershed get their
  district's home angle and zoom unless a change earns its place (`home_seen` 0.7, `home_gain` 0.25,
  `change_budget` 0.5; angle repeats keep their angle), identical views merge, and the circuit pays
  `route_district` (6 s) per return to a district (turns 43 → 22, zoom changes 21 → 17 on the examples).
  Tower views (2026-10-29, after the owner's live check of phase 3 found the circuit "smooth and
  natural" but towers still without time above their base): `tower_views` in `spot_views` adds up to 2
  views per park on districts.py's towers that no close-up shows whole within the middle half of its
  window (mid-height, zoom fitting `tower_fit` 0.8 of the window's height, nearest close-up's angle, no
  median close-up score for the hold; over `count` the lowest close-ups go; `_tower` views keep their
  zoom in district_views). Second round after the owner's review (Sonnental's tower at the frame's
  edge, Constellations' #8 low, Ghillie Dhu's not flagged, Troubadours' edge building half backdrop,
  Sambhava's "towers" are mountains): a close-up counts as showing a tower only at the tower's zoom or
  closer; the angle switches from the nearest close-up's when another's frame fill is a quarter better
  (absolute fills are no gate: the views the owner liked fill 0.2-0.4, mostly sky; `tower_fill` 0 off);
  tower views are `fixed` (plugin `View.fixed`: fitting neither moves nor merges them, as a zoom-0
  window wider than the content was centered on the content and the box's top cut a tower view short).
  Sambhava's tallest structures are scenery stacks on its mountains; `[park.views] tower_views = 0`
  is the per-park escape (owner: Sambhava not relevant for further tuning). Third round (owner's
  review of the second): "shown" needs the tower in the middle third of the width (Ghillie Dhu's
  edge tower sat at the quarter line); `tower_share` 0.6 (a low, wide building at Troubadours' edge);
  a tower's top climbs through gaps up to `tower_crown` (32) on its tiles and their neighbors
  (Constellations' observatory spire sits 22 steps above a hollow: its view was too low); tower views
  run after district_views, taking the neighbor's final angle and district (Qhyre Rock's tower had
  taken a pre-homing angle). 14 tower views on 8 of the examples. Owner, 2026-10-29: tower heuristics
  good enough (Ghillie Dhu and Troubadours pass; Constellations' spire "not worth further tweaking";
  Sonnental's second tower is a mountain but acceptable).
  Phase 4, placement (2026-10-29): `nudge_pans` moves each generated close-up (not towers, beads,
  companion views or the overview) within `nudge` (0.25) of its cell to the offset where the pans
  into and out of it have the best `path_fill` (mean frame fill of `path_samples` 9 windows along the
  pan at its run zoom, in the departing angle), keeping `nudge_keep` 0.95 of its own fill; pans under
  a quarter screen do not count (Tin Train's four angle views of one spot would wobble). `bead_views`
  then puts a pass-through view on every close-up pan longer than `bead_seconds` 8 × `route_speed` ×
  tolerance at the pan's zoom (the wider view's): the best unpicked pool candidate at that zoom
  (closer levels, then one wider, as fallbacks), same angle as the departing view, 0.25-0.75 along,
  within `bead_band` 0.25 of the screen height off the line and a quarter screen width from both
  ends (the plugin's merge threshold is a quarter of the smaller screen side); hold `bead_still` 1 s
  ÷ (1 − `bead_pan` 0.8) = 5 s added to the park's time. Examples: 17 nudges on 7 parks, 10 beads on
  5 parks, stretching down from +30 s to +6 s in all; one Gardens pan (3205 px at −2) has no spot
  within the band. In-district spacing (the plan's "closer than a quarter screen") was already met:
  the half-cell gap at zoom 0 is 16 tiles, under the 4K screen's 30. Scores file: `why.nudges`,
  `why.beads` on the overview; `--route` prints nudges and beads per park.
  Phase 5, timing from pan length (2026-10-29, owner's go-ahead after "beads seem functional"):
  `pan_timing` runs on the resolved generated views (after `resolve`, before `stretch_pans`) when
  `pan` > 0: hold = still (spot_holds' split by score; a bead's `bead_still`) + moving time (the pan's
  length at the zoom plan_pan gives, the return pan's zoom-out included, over `route_speed` 0.6 of the
  tolerance, ≥ `move_min` 2 s), pan share = move ÷ hold; a same-spot pan keeps no share (the plugin
  cuts). Over `park_cap` 90 s beads go first (lowest spot score), then the lowest close-ups (never the
  overview, towers, companion views or the first close-up), the still budget shrinking by view_time
  each; the plugin's change holds still come on top. Examples at a 90 s cap: 30-50 s still + 2-50 s
  moving; the cap bites on 5 parks (Ghillie Dhu, San Avaiki, Troubadours, Sambhava, Gardens: every
  bead and 1-2 close-ups dropped, 7 views each). `park_cap = 120` keeps every view (parks 84-116 s);
  `route_speed = 0.8` keeps most (parks 76-89 s, three drop one view). Owner, 2026-10-29, after the live
  test: "overall pacing is good for now", cap raised to 120 (the default; every example view kept).
  Scores file: `why.timing` on the overview (still, moving, dropped) and per view; the build prints
  `timing: … still + … moving`.
  Phase 6 (2026-10-29, owner's go-ahead with "overall pacing good for now", cap 120): `ride_pans`
  (before circuit_order) gives a park up to `ride_pans` 1 pair of views on a moving ride's track
  (`parkinfo.track_rides` + `parse_vehicles`; ≥ `ride_tiles` 24 tiles): `track_parts` splits the track
  into connected parts and `track_run` finds the longest chord (≥ `ride_run` 20 tiles) with track
  within `ride_band` 3 tiles (and 3 tiles' height) of every point of the line, so the pan sweeps along
  the ride whatever the track's own course (a first version chained tiles nearest-neighbor and looked
  for low-tortuosity runs: tracks fragment at crossings, so runs came out short or not at all). Pair
  views: the run's ends at `ride_zoom` -1, track height + 16, the angle with the longest screen chord ×
  path fill, `fixed`, keys `ride`/`ride_end`, the nearest close-up's district; a pair counts as one
  point (over `count` the lowest loose close-ups go), stays consecutive in circuit_order (legs, in its own order since the second round: a flipped leg ran the pair against the trains; a reversed order is no variant of a park with a pair), formerly either
  direction), gets no beads and is not nudged. 7 of the examples get one (runs 37-78 tiles, 3100-5500 px
  pans at -1: 13-23 s each), which puts four parks over the 120 s cap again (beads and 2-3 views dropped).
  Variety: `circuit_variants` (default 1; `playlists/example.toml` sets 2 for the owner's test) keeps the
  orders within `variant_margin` 0.1 of the cheapest, `circuit_reverse` adds reverses; each order is
  nudged, beaded and timed on its own copy of the views (resolve_park `variants`), the playlist carries
  them as `variants: [{views, parkTime}]`, and the plugin (`variantOf` in player.ts) plays the first
  order on a park's first visit and the next on each later entry (camera log `variant k/n`; hand-set
  parks keep their views). The mock test drops `variants` before its checks.
  Second round (owner's live review of the first: Ghillie Dhu and Constellations and Sambhava good,
  San Avaiki's traced the park's edge, Troubadours' panned outside the park, Gardens' "tracks nothing
  visible", Sonnental's was static scenery; preferably in the trains' direction; cap +30 s): the chord
  coverage test let a line through a mesh of coaster track pass, so `track_run` now wants one connected
  stretch of track (breadth-first through a corridor `ride_band` 4 tiles wide, path ≤ `ride_detour` 1.5
  × chord; 3/1.3 lost the Constellations and Sambhava runs the owner liked), both ends inside the content
  box, `ride_fill` 0.8 along the run (San Avaiki's coast railway 0.68-0.77, Sonnental's ride 10 0.67-0.76),
  and `ride_visible` 0.2 of the run's track not hidden behind what stands in front (a dark ride 0; what is
  built over a tile's track does not count: theming over Constellations' coaster would have failed it).
  Direction: `parkinfo.track_pieces` (build direction of each piece: 0 −x, 1 +y, 2 +x, 3 −y,
  OpenRCT2's CoordsDirectionDelta) summed along the path, plus any train on the path (`parse_vehicles`
  now returns the car's orientation 0-31, 0 facing −x; velocity sign) at `ride_heading` 10 pieces each;
  both agreed where both existed. On an out-and-back stretch the piece sum nearly cancels (Constellations
  −2, Sonnental −3: unverified). Runs scored length × fill (not length). `park_cap` 150. Gardens' phantom
  run (45,76)→(88,77) had track all along it in the data; unexplained, gone with the corridor test.
  Owner's review of the second round (2026-10-29): Ghillie Dhu, San Avaiki, Constellations (it "tracks
  through to view 7"; longer pan sequences out of scope) and Gardens good, Sambhava acceptable,
  Sonnental pans against the trains (acceptable; the build-direction guess was wrong there), Troubadours
  showed track only at its first view: ride 58 (and 57, 61, 21) runs at height 448 over a town topping out
  at 312, a sky-level track network of unknown purpose, so a run is turned down when more than
  `ride_floating` 0.25 of its tiles sit `ride_float` 96 units above everything within 2 tiles (coasters
  0-0.23 on the examples); Troubadours then follows ride 9 (`floating` in `ridesTurnedDown`).
  Reviews: give the owner view numbers (1-based in play order, as the renders index them, the pan
  running from view N into N+1) for every view or pan to check (owner, 2026-10-29).
  Variety (owner, 2026-10-29): approved as an optional system, default a single order
  (`circuit_variants` 1; `example.toml` one order); reverse orders are acceptable as interleaved
  variety (`circuit_reverse`); the plugin's visit counter persists (`RCTScreensaver.visits`), so
  the orders keep alternating across runs. `[views] only = "rides"` keeps only the overview and the
  ride pans (test playlists); `tools/ridesurvey.py` surveys a library (playlist or folder) for parks
  with a followable run (ride_pans on a bare overview; ~2.5 s per park with the fill rasters).
  Third round (2026-10-29, the owner's review of `playlists/ride-pans.toml`, ten medium parks from the
  imported library with `only = "rides"`: 6 good, Rowling vs. Tolkien's railway at the park's edge,
  Mandala "too close to edge", New Babylon's track not visible, Memnon a scenery track; "ending view
  tends to slightly overshoot the track"): `parkinfo.parse_rides` reads the rides chunk (type, status,
  mode, name, trains, stats; OrcaStream stores every integer up to 32 bits as 4 bytes, 64-bit as 8,
  strings null-terminated, arrays as count + element size + elements; `RIDE_TYPE_NAMES`), and
  `ride_status` "open" follows only open rides (Memnon's `_Traffic` was testing: NE parks run props as
  testing or closed rides with a train, and closed rides keep a stale velocity); `ride_fill` 0.85 (the
  edge railway 0.82, good picks 0.87-0.97); track under its tile's ground or water counts hidden;
  `ride_overshoot` 0.1 pulls the end view back by that share of the window along the run; a run that
  fails a gate gives way to the ride's next longest (`track_run` accept callback). Measured but not
  gated (`ride_edge`, `ride_void` 1.0 = off): the share of a window outside the content box's hull on
  screen and the void it shows; good picks reach edge 0.34 / void 0.46, Mandala's "too close to edge"
  run measures 0.01 / 0.00 (unexplained; to look at in the renders). `tools/ridesurvey.py` prints both.
  Owner, 2026-10-29: the Koi Pond, Constellations' eclipse show and Sambhava's mist companion (judders
  the camera during pans) need individual handling, left as
  enhancements; testing stays on the 4K 16:9 window (a 1080p window pulled every view in: the
  resolution, as 1080p is 16:9 too; handled in phase 7, below). Last batch
  (`playlists/ride-pans-2.toml`, 20 unused library parks, 2026-10-30): the owner accepted the pan
  heuristics as they stand ("minor issues, but accurate enough"); further phases go to other threads.
  Phase 7, window size and shape (2026-10-30, `plugin/src/scale.ts`, notes in `docs/view-panning.md`):
  zoom levels are fixed scales, so views judged in `[views] window` (1920x1080 game pixels: the owner
  tests on a 4K monitor at OpenRCT2's scale factor 2.0, owner 2026-10-30; the plugin sees game pixels,
  so the scale factor is already counted; carried in the playlist as `screen`) move out by whole levels until the window shows at least that frame on both sides
  ("contain": `ceil(log2(1/scale) - 0.25)`, scale = the smaller of the width and height ratios; one
  level at 960x540/960x600, i.e. 1080p/1200p at scale 2.0); fitting then runs in the window's pixels as before
  (the small-park overview cap moves with the offset). Pan tolerance: `panTolerance(zoom - offset) ×
  min(1, scale)` (owner, 2026-10-28: a share of the window), logged as `tol=`
  for cameralog.py. Editor edits and drawviews saves record their window (`screen`, `viewScreen` in
  the playlist) and scale the same way; older edits play as set. Plugin setting `scaleToWindow`.
  Generator side (2026-10-30, owner: "switch to a 1080 target, but some recalibration will be needed"):
  `[views] screen` is now 1920x1080 like `window`. A first try with every use of `screen` at 1080
  re-picked 3-6 close-ups per park (the owner preferred the 4K picks: Sonnental 4K-9 over HD-8, Sambhava 4K
  7-9, Troubadours 4K-2; HD beads/views at San Avaiki's edge): at 1080 the frame fill no longer saw a
  spot's surroundings, so edge spots and zoom-0 views got in and the district homes drifted. So the fills
  keep their window: `fill_window` 2 × the screen (candidate fills, tower angle fills, ride path fill
  and void, nudges), while the geometry uses the screen (tower fit and the "shown whole" test, cell
  slicing, bead band and margins, ride overshoot and edge). `ride_overshoot` 0.2 keeps the accepted
  pull-back (4.3 tiles on Ghillie Dhu); towers go `tower_close` (1) level in after the `tower_fit` fit
  (owner: the fitted views looked a level too far; the 4K zooms come back), a tower taller than the
  window framed from its top (`tower_top` 0.15 of the window under the frame's top) instead of
  mid-height. Result: 73 of the 91 example views identical to the accepted 4K build (the rest nudges
  and beads a few tiles off, Constellations' circuit reordered by the new tower anchors).
- `tools/perfrun.py`, `tools/perfreport.py`, `perf/*.toml` (suites), `perf/baselines/` and
  `perf/local/` (accepted reports and PC-made samples, both kept on the PC, not committed): performance tests, `docs/performance-testing.md`.
- `tools/cameralog.py`: per-view pan timings from a game log written after `mksequence.py --install
  --camera-log` (plugin setting `cameraLog`); flags short stills/rests and pans over the speed tolerance.
- `tools/renderviews.py`: renders a built playlist's views with `openrct2 screenshot` (on the PC) to
  `build/renders/index.html`, for judging views without playing the screensaver. Captions carry the pan
  share and `EVENT <animation|show>` (owner, 2026-10-31); an SVG over each render draws the line to where
  its pan goes (the next view, cut at the frame with its length in screens; solid yellow for a pan, dashed
  cyan for a cut, with a legend) and the angle and zoom changes on the way; each park starts with a "total"
  render (the overview's angle, zoomed out until every view fits: all views numbered, every pan and cut drawn;
  owner, 2026-11-01), which the settings page's strip shows (after a newer build: the plain overview where the park file's
  SHA-1 is unchanged, else a placeholder); `renders.json` lists each park's files by park key.
- `plugin/`: TypeScript plugin (type-check with `tsc`, bundle with esbuild); `npm test`
  runs it against a mock title screen API.
- `docs/companion-plugins.md`: how parks' bundled plugins load, and how to run them on the title screen.
- `tools/settings.py` + `tools/settings.html`: the generator's settings page (built 2026-10-31 from the
  mockup, wiring in `docs/settings-ui-wiring.md`): local server like drawviews.py with a per-run token and
  Host/Origin checks; edits a playlist and park profiles in place (`tools/tomlwrite.py` `patch`: comments
  kept; a change it can't place rewrites the file; never asks before a write (owner, 2026-10-31: the
  page is a generator); the last 100 backups per file, opened by the page's Backups buttons). Everything it writes goes to the
  user folder `Documents\OpenRCT2\screensaver\` (`tools/userdata.py`; owner, 2026-10-31): playlists,
  profiles (a user profile replaces the shipped `parks/` one of the same name; the shipped ones are the
  tuned defaults), backups, the last build (removed when the server quits; importing a bundle clears it and the renders) and the latest and
  previous renders (the contact sheet is one column of parks with build facts; a Compare box in its top bar shows the previous set as a second, separately scrolling column with its own headers). The server stops once no page is open
  (pings), keeps its token across restarts, and `Settings.cmd`
  starts it without a console (`settings.sh` in the background on Linux and macOS),
  scans a folder (direct, or importparks.py when it holds `.sv6` or loose objects), runs builds,
  installs and renders as jobs (each logged to `build/logs/settings-*.log`; a failure's path stays on
  screen). Reset profile removes the user's copy. Profiles take a top-level `companions = false` (its Scripts switch) and
  `name` (the shown name when the playlist gives none: Gardens of Light is saved as "Dream"). Owner's live
  test (2026-10-31): `park_min` defaults to 30 s, time scaling goes to 3.0, scrollbars never auto-hide,
  warnings sit in the footer next to Cancel/Save (no pop-ups), previews match parks by key (renderviews.py
  writes `renders.json`) and open the contact sheet.
- `tools/bundle.py`: playlist bundles (owner, 2026-10-31): a zip of the playlist, its views file and the user's
  changed profiles, optionally with the ticked parks' files and the build (unticked parks by name only, 2026-11-05); import unpacks into the user folder (parks
  under `bundles/<slug>/`, a build into `build/`) and looks for parks it lacks in the park folder by file name.
  The settings page's top bar: Build (highlighted), then Render, Install (`mksequence.py --install-built
  <name>.result.json`, which every build writes) and Export, grayed until the open playlist has a current
  build; Import sits next to New. Stages (owner, 2026-10-31): nothing loaded → New and Import (alternate shade)
  lead, Build unavailable; a playlist → Build leads; built → Install leads, Export shaded. A status line in the
  top bar's center. Missing parks show red ("Z missing!", park list) and can be unticked and reordered; a
  ticked missing park blocks Build.
- `docs/settings-ui.md`: each settings UI control and the playlist key or tool it drives (audit
  2026-10-31: added `motion`, `park_min`, `time_scale`, `change_hold`/`arrive_hold`/`return_hold` in the
  playlist, `return_pan`, `companion_pans`, `pan = "auto"`, top-level `park_scripts` and `title_music`
  (`--install` puts it in the plugin's settings and the screensaver mode applies it in memory, 2026-11-01; it used to set `config.ini` `title_theme`), `[[park]] use = false`; `events = false` drops shows too).
- `docs/view-generation.md`: the generator's stages and every `[views]` option, for users (the README
  keeps a nine-line summary; owner, 2026-11-03: the full text there was a wall).
- `docs/testing.md`: what local test runs need to check; `docs/testing-linux.md` the Linux build's pass (Fedora; basic Linux support done 2026-11-05: the
  AppImage under Wayland, README "Linux" under Installing; X11 and sound untested).
- `docs/roadmap.md`: planned work, and what was done with the decisions made on the way.
- `docs/known-issues.md`: problems in parks or third-party content that the project does not fix.
