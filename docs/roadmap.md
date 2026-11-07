# Roadmap

What is done, what is being worked on now, and what comes next, in the owner's order
(2026-10-28, with the configurable generator added before Release on 2026-10-29; its wiring
to the settings UI started 2026-10-31, ahead of the wrapper). Last rebuilt 2026-10-30, updated
2026-11-07 (after the v0.2.1 release). Problems in parks or other people's content that the project does not fix are in
`docs/known-issues.md`; the decisions behind each piece are in `CLAUDE.md`.

## At a glance

| # | Step | Status |
|---|------|--------|
| 1 | View panning: plugin side | Done (2026-10-28) |
| 1a | Pan-based view generation, phases 1-6 | Done, accepted by the owner (2026-10-30) |
| 1b | Phase 7: window-width and aspect scaling | Done (PR #61, owner's live check; generator at the 1080 target) |
| 1c | Per-park enhancements (profiles; Koi Pond, eclipse, Sambhava's mist) | Done, live-tested by the owner (2026-10-30); mist and eclipse tuned after it |
| 1d | Event views (cued and timeline animation views), library sweep | Done (2026-10-31; PRs #75-#108): no other parks need event views |
| 1e | Shuffle and random view order | Done (2026-10-31; PRs #105, #106, #109, #110) |
| 5 | Configurable generator (final version) | Done (2026-10-31 to 11-02): the settings page, renders and drawing pages in daily use on the PC; Show titles wired 2026-11-03 |
| 2 | Wallpaper wrapper | Done (2026-10-31 to 11-03; PRs up to #158): screensaver mode, overlay, controls bar, settings panel, view editor, park name captions with frame styles; live-tested by the owner |
| 3 | Performance testing with logging, and optimizations | Now, post-release (framework built 2026-11-02; first runs done 2026-11-03; PresentMon next; overnight soaks moved to potential enhancements) |
| 6 | Release | Done: v0.1.0 (2026-11-03, github.com/Ogrueb/openrct2-screensaver), v0.2.0 (2026-11-05, fixes and a Linux beta), v0.2.1 (2026-11-06, import fixes) |
| 7 | Standalone tool builds (settings page, drawing page) | Now, post-release: split out of the release step |
| L | Basic Linux support | Done (2026-11-03 to 11-05), shipped as a beta AppImage in v0.2.0 |

## Now (post-release)

The project is released (v0.1.0 on 2026-11-03, v0.2.0 on 11-05, v0.2.1 on 11-06); nothing below blocks a
release.

### 3. Performance testing with logging, and any optimizations it calls for

Framework built (2026-11-02, thread "Plan the performance-testing process"; `docs/performance-testing.md`):
engine patch 0016 (perf log), the plugin's bench mode and marks, `tools/perfrun.py` and
`tools/perfreport.py`, suites quick, renderers, survey, features and soak. First runs done
(2026-11-02/03 on the PC; the reports are kept with the PC's `build\perf\` run folders and in the
project files, not in the repository): quick (the baseline), renderers (OpenGL with
multithreading fastest, then picked for the other suites), survey, features and a 1 h short-park soak
(memory 83 MB/h, 1.3 MB per switch as parks repeat; no crash). Next: a PresentMon run (owner's OK,
2026-11-03) to tell the GPU's time from vsync waits in OpenGL's ~31 ms present. The overnight soaks
moved to potential enhancements (owner, 2026-11-03), below.

From the wrapper design (owner, 2026-10-31): consider here whether guests and vehicles out of view
could update less often (a change to the core update loop, so only if the simulation proves the cost).

Owner, 2026-10-27. Thorough A/B runs (each feature on and off, same park, view and window size)
of what the screensaver adds to the engine: the engine patches (background loading, palette
split, ride music and fades), the plugin itself, parks' companion plugins, large-map loading
and the load fade/loading screens, comparing the stock, CI and patched builds by numbers. The
renderer may need to be a test dimension too: software against OpenGL (owner, 2026-10-28). Log
frame times split into simulation update, plugin (script) time and drawing, plus park switch
stalls, to a file per run (engine timing patch or a plugin), so results can be compared and
kept in `docs/`.

Known so far: on the PC (1920×1080, software renderer) some views drop to about 15 fps, worst on
certain zoomed-in views of larger parks; Europa-Park (365×327, 17k guests, 523 rides) plays at
under a third of other parks' frame rate at every zoom, though it loads fine; OpenRCT2's
multithreaded drawing evens it out, but loading screens still stall. Sambhava's mist companion
stalls frames during pans (see per-park enhancements). Measure frame rates across the imported
MoreParks set to see whether large-park slowdowns are common enough for an engine patch, or
whether leaving out oversized parks (a size filter in step 5) is enough. The remaining 15-37 ms
hitch per park switch is visible but accepted (owner, 2026-10-27): not worth more engine
fragility (deferred object unload, sliced finish).

Check for memory leaks (owner, 2026-10-30): the 1 h short-park soak found no leak worth chasing;
the overnight runs are a potential enhancement now (see "Overnight memory soaks" there).

### 7. Standalone tool builds (split out of the release step, 2026-11-07)

The tools still need a Python 3.11+ install (`Settings.cmd`, `./settings.sh`). Left from the
release step:

- Package `tools/drawviews.py` (with its page) as a standalone Windows `.exe` (PyInstaller or
  similar, built in CI) so drawing views needs no Python install (owner, 2026-10-27).
- Package the settings UI server (`tools/settings.py`, see `docs/settings-ui-wiring.md`) the same
  way, and test it there (owner, 2026-10-31): in a frozen build the tools are called in-process,
  not as `python` subprocesses; check SmartScreen and antivirus warnings on the unsigned build.

## Done recently, with the decisions made on the way

### 6. Release (done: v0.1.0 2026-11-03, v0.2.0 11-05, v0.2.1 11-06)

v0.1.0 was published on 2026-11-03 from the public repository `Ogrueb/openrct2-screensaver`, with
the release engine build (0001-0015) and the source archive. Since then (notes in `docs/releases/`):
v0.2.0, fixes found after v0.1.0 (stock windows over the mode, the settings page's folder and build
state, unticked parks in bundles) and the Linux AppImage as a beta; v0.2.1, park import fixes
(a folder of loose RCT1/RCT2 saves imports every save, `.sv4`/`.sc4` convert, a failed convert lists
every missing object), the settings page's footer link to the repository, and a smaller AppImage.
The standalone tool builds moved to step 7 under "Now".

- License: GPLv3 (owner, 2026-11-03; `LICENSE`, the plugin's `package.json`).
- The example parks left the repository (owner, 2026-11-03): `ExampleParks/README.md` lists their
  downloads; the public repository starts from a fresh history without them.
- Package the patched OpenRCT2 builds without the diagnostics patch (0016: load timings, perf log):
  the Engine build workflow's "Release build" input (2026-11-03); v0.1.0 carries the two
  executables, so users need no Actions login.
- The stock-engine stopgaps are gone (owner, 2026-11-03): the generator's palette index 10 rewrite
  (`fix_ui_palette`, `--keep-palette`) and the plugin's fade through a black window around the
  stock engine's park loads. The plugin still plays on a stock engine (autostart, toolbox items,
  the window editor), with cuts between parks; patch 0001 handles the palette.

### 5. Wire the generator scripts to the settings UI (done, 2026-10-31 to 11-02)

Thread "Wire generator scripts to the settings UI", PRs up to #150, live-tested by the owner on the PC
after each round. Built (details per round in `docs/settings-ui-wiring.md`, controls in
`docs/settings-ui.md`):

- **Settings page** (`tools/settings.py` + `settings.html`, `Settings.cmd`): every mockup option
  wired to the playlist, park list with order, adjustments and per-park profiles, builds, renders,
  installs and bundles as logged jobs, a status line that says what the next step is, and parks
  changed since the last build flagged (only those rebuild).
- **Partial rebuilds** (`mksequence.py --cache`): parks known by contents (SHA-1), a generator update
  told apart from park changes; previews and render pictures of unchanged parks kept (`viewsKey`,
  `renderviews.py --reuse`).
- **Renders contact sheet**: one column per set with Compare, manual badges, Edit views links, and
  parks changed since the render marked (views changed, rebuilt, map changed).
- **Drawing page** at `/draw`: opens before a build by building first, route lines like the renders,
  views on other angles as numbered markers, Copy/Paste, Events panel, Tint 1-3 palettes, Reset views
  back to automatic views.
- **Bundles**: export and import of a playlist with its views, changed profiles and optionally parks
  and the build; identical park files are left alone on import. This covers the owner's release note
  of 2026-10-31 (a shared playlist must carry the user's custom park profiles): Export packs the
  user's own profiles of the playlist's parks, and Import writes them to the user's profiles folder,
  where the build finds them. Profiles are read only at build time, so an installed playlist needs none.

Left open: packaging the server as an `.exe` (Release). Show titles was wired on 2026-11-03
(top-level `titles`, `docs/settings-ui.md`). The rest of this section is the record of the decisions made on the way.

Thread "Wire generator scripts to the settings UI". The owner's next stage: connect
`tools/mksequence.py` and the other scripts to the settings mockup
("Screensaver generator settings", a mockup page kept in the project files, not the repository).
First every option in the mockup is checked against what the scripts implement, and the
disconnects (missing options, mismatches, unimplemented features) are fixed; then a UI-to-playlist
mapping doc, the mockup's tooltips corrected to match, and the wiring itself.

- **Title music** (owner's choice, 2026-10-31): `mksequence.py --install` writes the choice into
  the plugin's settings (`RCTScreensaver.settings.titleMusic`), and the screensaver mode applies it
  in memory on entry (2026-11-01, wrapper step 2; it used to edit `config.ini`'s `title_theme`).
- **Parks screen** (mockup, 2026-10-31): an Order column (drag handle, position, up/down arrows)
  and a Scramble button beside Select shown that shuffles the list once; the result is the
  playlist's park order (see step 5 below). The mockup's styling (square beveled corners,
  headings, sliders, scrollbars) was settled in the same thread as the options.

### Phase 7: scale pans and views to the window (done, 2026-10-30)

Thread "Scale pans to window width and aspect" (merged 2026-10-30). Views judged in a 1920x1080 game-pixel window (the owner's 4K monitor at
scale 2.0) move out by whole zoom levels until a smaller window shows at least that frame on both
sides; the pan tolerance becomes a share of the window. The generator then switched to the 1080
target, its fills keeping a 2x window and towers a level closer: 73 of the 91 example views came
out identical to the accepted 4K build. Design in `docs/view-panning.md` ("Window size and shape").

Resolved without an intermediate speed step: the tolerance is a straight share of the window
(`panTolerance(zoom - offset) × min(1, scale)`), and the owner's live check found the scaled views
"about the same" before PR #61 merged.

### Per-park enhancements (done, 2026-10-30)

Thread "Design per-park enhancement storage", design doc "Per-park enhancements: storage and
build-time merge". Some parks fit the general heuristics poorly and get individual handling
rather than distorted heuristics (owner, 2026-10-29).

Storage: one profile per park in the repo (`parks/<slug>.toml`, format in `tools/profiles.py`),
matched by saved park name and map size, merged into every playlist build just under the
playlist's own park entry (editor edits still replace views outright). Fixes always apply;
extras (animation views, shows) only when the playlist sets `park_plugins = true` (owner,
2026-10-30: off unless a playlist enables them). The show and spot tables that were in
`tools/companions.py` now live in the profiles. Still open: whether a local profile folder
beside the library is wanted, and whether library parks' profiles may live in the repo.

Four steps, each its own PR; the owner's live test (2026-10-30, `playlists/enhancements.toml`) found all three working, with two tweaks since:

1. **Profiles and merge** (`tools/profiles.py`, `parks/`, `park_plugins`, `--ignore-profiles`):
   built; `example.toml` and `companions.toml` build byte-identical playlists (the latter now
   takes its extras from the profiles).
2. **The Koi Pond:** built. Its profile sets `rotation = "keep"`: overview, middle level, pond
   and street, all from the saved angle (r2), against pond and cutaways from r0 before; no other
   park changes. `angle_weights` (score factor per angle from the saved one, 0 = never; honored
   by close-ups, tower and ride views) exists as the softer bias: `[1, 0.4, 0.4, 0.4]` gives
   street, pond, and the pond again from r0; `[1, 0, 0, 0]` loses the middle level. Works live.
3. **Sambhava's Rest's mist:** works live. Its profile pauses Animator while the camera
   moves (the host compares the viewport each tick and resumes 8 ticks after it stops; aimed at
   the judder seen with pan 0.6) and patches Animator's `fademist` as the companion reads it:
   every 15 ticks instead of 50, clear radius 20 tiles instead of 13 (both scaled by zoom + 3).
   The `.park` copy is untouched. After the live test (too much mist burnt off at the overview,
   as the radius grows with the zoom) Animator also pauses above zoom 0 (`pause_above_zoom`), so
   the mist clears only on the close-ups; then (second check) every 20 ticks rather than 15, and
   at zoom 1 a tenth of the pace (`zoom_rates`); then (third check) a run every 25 ticks' worth, made
   as runs every 5 ticks with five times the chance factor (smaller steps, no instant hole at the
   center), and a twentieth at zoom 1. The radius patch (`randomize.viewport.maxDistance`) never
   took: the field sits in the animation's frame action, not on the animation, so it was dropped
   (the owner's tuning was at the saved 13). `tower_views = 0` is left out: the owner accepted
   Sambhava's views as they are.
4. **Constellations' eclipse:** works live. The show view carries a camera path in game
   ticks (`path` in the profile, played by the plugin's `stepPath` every tick): from (40,45) up
   the diagonal to (55,60) while the shadow comes in (1500 ticks), still through the full eclipse
   (320 ticks; the show's 8 s wait is now `waitTicks`, so the path keeps time at any speed), and on
   on as it leaves (1800 ticks), at zoom 0 (the eclipse itself sets zoom 1), about 13 px/s
   coming in. The end moved from (70,75) to (112,117) after the live test (the pan should go
   further); then (second check, "far too slow") the moving legs take `show_pan` 0.5 of the
   path's time, about 1.8 times as fast, resting at each leg's end. Third check (still slow, and
   short of the target): the path followed the ground's height, which falls about 500 units on the
   way to (112,117), pulling the camera back by as much; it now keeps the view's height, and the
   share is the show view's own `pan` (0.5 from `show_pan`), applied by the plugin. The view stays
   until the camera arrives. Fourth check (Sambhava approved; the glide "doesn't arrive", the hold
   should be at the end): the camera log showed view 14 re-entered during the 17 s rest after the
   first leg, which restarts the path; the glide is now one even pass through the points for the
   share of the time, then the hold.

### Event views and the library sweep (done, 2026-10-30 to 10-31)

Same thread, continued. Animation views wait for their trigger (a car on tiles, listed cars or a
tick on the park's clock) and stay while the effect runs (`View.cue`); `mksequence.py --animations`
lists every park's animations and a profile's `[animation."<name>"]` changes one. Timeline effects
cut into the circuit on their tick (Base X, Void Extraction Research Base, Sambhava's honey pot,
Yucca's seven UFO views; see "Accepted limitations"), continuous ones are ordinary circuit stops,
and `cameralog.py --triggers` measures train timings into repeating cues. Sambhava's mist lost its
own view (Animator runs wherever the camera is at zoom 0). Event views are optional at build time
(`[views] events = false`, PR #105), with the ordinary views unchanged.

Sweep of EvenMoreParks (2026-10-31, on the PC): all 33 parks with real plugin data or a shipped
script build without failures, and none beyond Base X, Bene Volantes, Void and Sambhava needs event
views; the rest hold empty placeholders for those scripts, stats or editor tools. Utility plugins
found automatically (Peep Editor in Yatagarasu, and the like) are never run (PR #108). Tower lifts
(five parks, Memories of Mauritius among them) stay off by default; Mauritius's two lifts share a
name, so they cannot be switched on separately. "Animated vandalism repairing" (Raveland, 008
Mission Tropico) ships no code, so it cannot run.

### Small open items

- More sample parks from the owner as they come; park credits stay playlist data (`author =`).
  The New Element Designs crawl is done (2026-10-30): `tools/nedesigns.py` gives imported and
  scanned parks their NE names and builders.

### 2. Wallpaper wrapper (done, 2026-10-31 to 11-03)

Host the screensaver as a desktop wallpaper, now that the engine side works. The palette choice
(the park's own palette or the dark-UI rewrite) is decided here, not in the generator. The view
editor moves into the minimal-UI presentation in this stage, with drag boxes in the game.

Scope (owner, 2026-10-31; `docs/wallpaper-wrapper.md`): the MVP is one normal borderless window
with our own minimal UI, drawn by an engine patch (stock title windows hidden, a 32-bit overlay with
alpha and TrueType text after the color conversion); a screensaver mode entered from a main menu
toggle or a launch flag. Multi-monitor is out of scope; wallpaper and `.scr` hosting are left to
other tools (Lively, Wallpaper Engine), which start the game with the flag. The mode's settings stay
out of `config.ini`, and the main menu gains only the toggle button: the view editor and the other
title-screen additions move into the mode (owner, 2026-10-31). Engine patch, overlay API and order of
work in the doc. Esc quits a `--screensaver` launch; the mode imposes 40 fps, inherits the stock
multithreading setting and defaults extra effects to off; any deeper performance work (e.g. less
simulation out of view) waits for step 3.

The mode's UI (thread "Draft the Screensaver mode UI", `docs/screensaver-ui.md`): the owner's order
is the controls bar and load cover, then captions, then a simple editor. The look follows the stock
main menu: square buttons, sharp corners, partly transparent backings. The controls bar was built
2026-11-02.

Done 2026-11-03, live-tested by the owner on the PC after each round (PRs #146, #152, #156-#158):

- **Controls bar:** two rows (previous/next park and view, Hold; speed, shuffle, titles, music, time of
  day, edit views, settings), shown with the cursor; the stock exit button bottom right, as Esc.
- **Settings panel:** window style, renderer, multithreading, weather, light effects, volumes, and the
  caption options; all in plugin storage, never `config.ini`.
- **Main menu:** a Screensaver button with its own icon (a monitor with a park, patch 0015).
- **View editor** on the overlay (the simple one; the live editor stays an enhancement).
- **Park name captions:** a portrait frame (gold, silver with a debossed rinceau, wood with a rope;
  marble mat from the owner's photo, wood divider, velvet byline band in five colors), plus Minimal dark
  and light, frosted Aero and Canvas styles with an accent color, chosen in a Title frame flyout; four
  placements, bottom center above the bar only while the bar shows; fade in with the park; titles on the
  overview, every view or off. Design and settings in `docs/screensaver-ui.md`.

Show titles in the playlist (2026-11-03): the settings page's control writes top-level `titles`, which
overrides the viewer's setting each run until the bar's Titles button is used. Left open: a release check
of the marble texture's source (step 6).

### 5. Configurable generator: the plan (2026-10-29)

Owner, 2026-10-29 (thread "Plan view-generator configuration options"; UI mockup
"Screensaver generator settings"). Options chosen when a playlist is built. Many exist today as
`[views]` keys or command-line flags; the final version sets them from one place and keeps them
in the playlist:

- **Source parks**: a directory, with an optional checklist of its parks. Filters by park size
  (small, large, very large, so oversized parks like Europa-Park can be left out) and for parks
  that ship scripts. An Adjustments toggle on the same list shows the per-park adjustments
  (below) in place of the park details.
- **Park order** (owner, 2026-10-31): the checklist is also the playlist's order, set by hand
  (drag a park up or down) or with a Scramble button that shuffles it once (both in the mockup
  since 2026-10-31); the result is saved as the playlist's order (replacing `order = "shuffle"`
  at build time). In the plugin, S shuffles the park order only (PR #110). There is no shuffle of
  the views inside a park, at build time or in the plugin: their order comes from View order
  (circuit or random).
- **Park time budget**: a minimum and a maximum per park, one slider with two handles (10-300 s).
- **Time scaling factor**: one factor applied uniformly to every hold and pan.
- **Static views or pans.** Under Pan options, in this order:
  - inertia: linear or cubic (default linear);
  - ride-following pans: include, exclude or only (default include);
  - when angle and zoom change (`panChanges`: at end or at start), and the change, arrival and
    return holds.
  These are stored in the playlist, not only in the plugin settings.
- **View order**: circuit or random (`[views] route`, both built since 2026-10-31; random is the
  pre-circuit generator in its pick order, and event views keep their clock times in either). Below it, for both:
  - variants: 1-10, default 1, a limit on the orders per park, not a quota (`circuit_variants`);
  - include reverse: a checkbox on the same line, default off (`circuit_reverse`).
- **Enhancements** (one block): park plugin support (custom scripts, e.g. Constellations' eclipse
  show), with beside it:
  - plugin-driven views: views on the animated spots companion plugins drive (Constellations,
    X-Base, VERB) and Constellations' eclipse show, default on (`animations`, `show`). A link
    beside it opens the park list, which filters on parks with such views; with Adjustments on,
    those parks get a switch for them (`[views] events`, built 2026-10-31) and an edit button (left of the parameters one) for their
    spots (on/off, hold) and show (start view, camera path, pan share, hold);
  - title music: the parks' ride music or a theme, stored in the playlist; `mksequence.py --install`
    puts it in the plugin's settings and the screensaver mode applies it in memory (`config.ini` is
    never edited; owner, 2026-10-31, revised 2026-11-01);
  - show titles: Overview, On or Off (see "Park name captions in the wrapper UI").
- **Per-park adjustments**: shown in the park selection list by its Adjustments toggle, one row
  per park with toggles (e.g. scripts, tower detection, ride pans) and a button to edit that
  park's parameters by hand. This is the editor for the per-park profiles (see "Per-park
  enhancements"), the return pan to the overview among them (a per-park parameter, not a
  playlist option). They apply in every playlist that plays the park (see "Accepted limitations").
- **Preview images**: render each park's views for judging before installing, starting from the
  `districts-iso/index.html` method (the game's four-angle renders with overlays), in a strip
  that scrolls sideways past five parks. The details need adjusting.
- **Not from phase 7** (owner, 2026-10-30): views are generated for a fixed 1920x1080 window and
  scaled to the real window at run time, so the playlist settings have no target screen. The pan
  speed tolerance and the close-up zoom range stay `[views]` options, set per park in its
  parameters (`pan_tolerance`, `zoom_min`, `zoom_max`), not on the main settings: time scaling
  already sets how fast pans run, so the tolerance only decides which views drop (owner).

Generator side audited against the mockup (2026-10-31): every main-screen and per-park control
has a playlist key (Show titles since 2026-11-03); the mapping is in `docs/settings-ui.md`. Next: the UI
itself and the tool steps behind it, drafted in `docs/settings-ui-wiring.md` (a local server like
drawviews.py, park facts, a TOML writer, profile writing, streamed builds, previews).

Not options: hand-set views (the generator provides automatic views and the editor can change
them afterward; no hybrid format is planned) and the palette (the wallpaper wrapper's choice).

## Done

### Screensaver on the title screen (2026-10-26)

- Intransient plugin drives views and timing; the title player only loads parks. TOML playlists
  built into title sequences by `tools/mksequence.py --install`, the full view list passed
  through shared storage.
- Controls: previous/next view and park, speed (kept across park loads), hold, shuffle (park order only since 2026-10-31: the next park at random, each played once per round; views keep their order), view
  editor.
- Park loads masked by a fade to black on the stock engine.
- Run-time view fitting in the plugin: content box, height-aware framing, merging of
  near-duplicates, per-angle views for compact parks (PR #4).

### Automatic views, version 1 (2026-10-26 to 10-27)

- Method `spots`: an overview, then scored close-ups at zoom -2..1 with weights favoring rides,
  hidden-share per angle, a view budget from built tiles and per-park timing (PR #7).
- Wide-view guard (`wide_limit`), the score breakdown in `<sequence>.scores.json`, and
  `tools/viewstability.py` for jitter checks; untested ideas kept as options, off.
- Frame fill (2026-10-29): close-ups scored by how much of their window shows the park rather
  than the void, cliff walls and the map's edge, after the owner's live test found many views
  occluded (PR #38).
- `tools/renderviews.py`: renders a built playlist's views for judging without playing.

### Hand-set views (2026-10-26 to 10-27)

- In-game view editor on the title screen; edits saved per park and moved into
  `<playlist>.views.json` at install (`--ignore-edits` for test builds).
- `tools/drawviews.py`: draw views as boxes on headless renders of each park in the browser
  (PR #13).

### Engine patches (2026-10-26 to 10-27; `engine/`, `docs/engine-patches.md`)

- 0003-0008 background loading (load timings in the test-only 0016): the next park is read, imported
  into a second game state and registered while the current one plays, so a switch costs about
  15-30 ms; `TitleSequence.backgroundLoading` lets the plugin skip the fade.
- 0001 palette split: the void takes the park's color and the interface keeps its black
  (confirmed on Gardens of Light, 2026-10-27).
- Windows x64 builds from GitHub Actions; the owner's Visual Studio clone for fast iteration.
- Object preloading from the plugin was measured and dropped (2026-10-26).

### Music and sound (2026-10-27; PRs #17, #21, #22)

- Patch 0002: "Ride music" as a title screen music choice, following the view, cross-fading
  across park switches, a park's single custom track played evenly.
- Patch 0009 and the plugin: sound effects and ride music fade out before each scheduled view
  change and in on every view.

### Parks' companion plugins (2026-10-26 to 10-28; PRs #14-16, #18, #23)

- Generated host plugin runs each park's bundled `.js` only on its own park and stops it at each
  park change (Animator, Object Animator, AdvancedTrack and others from the larger survey).
- Animation views and scripted shows (Constellations' eclipse, played as the park's last view).
- AdvancedTrack runs only where a lift's ride has track (Valley of the Kings' stale data).

### Park library (2026-10-27; PR #19)

- Survey of 150 new sample parks; `tools/importparks.py` builds a library of `.park` files and a
  playlist (zstd parks, `.sv6` conversion, loose objects, working-title name fallback).
- Known issues from the survey go to `docs/known-issues.md`.

### View panning, plugin side (2026-10-28; PRs #25, #27-31; `docs/view-panning.md`)

- Per-view `pan` share, angle/zoom changes at a pan's ends with holds around them, optional
  inertia, a park's last view panning back to its first, Space pausing a pan, editor Play,
  camera log (`tools/cameralog.py`).
- Speed ladder evaluated by the owner: tolerance 500 px/s at zoom -2, 100 less per level out;
  generation stretches pans over it.

### Pan-based view generation, phases 1-6 (2026-10-28 to 10-30)

Plan: "Pan-based view generation: initial plan" (thread "Plan pan-based view generation"). Goal:
a smooth set of ordered pans between all points of interest, not a linear or zig-zag traverse.
Accepted by the owner on 2026-10-30 after a 20-park batch from the imported library
("minor issues, but accurate enough").

| Phase | What | PRs | Outcome |
|-------|------|-----|---------|
| 1 | Route metrics and district detection prototype (`tools/districts.py`, `--route`) | #32, #33, #34-36 | Baseline: 82% of pans changed angle, 86% zoom |
| 2 | Circuit order: close-ups in the cheapest closed loop, shape penalties (`route = "circuit"`, also for static play; `"picks"` kept) | #37 | Travel 1,467 → 1,113 tiles, no double reversals |
| 3 | Districts with a home angle and zoom, changes only where earned; tower views | #39, #41-44 | Turns 43 → 22; owner: circuit "smooth and natural", towers good enough |
| 4 | Placement: nudges over content, beads on long pans | #45 | Stretching +30 s → +6 s |
| 5 | Timing from pan length, park cap (120 s, then 150 s) | #46 | Owner: "overall pacing is good for now" |
| 6 | Ride-following pans (in the trains' direction, open rides only, gates against edges, floating and hidden track); optional circuit variants and reverses; `tools/ridesurvey.py` | #47-49, #51, #53-54, #57-60 | 107 of 145 library parks get a run; variants approved as optional, default one order |

## Accepted limitations

- **Timeline cut-ins play out of turn, not in a circuit slot** (owner, 2026-10-31). Effects on
  the park's clock (Base X, Void Extraction Research Base, Sambhava's honey pot, Yucca's UFOs) cut
  into the circuit when their tick comes: the camera pans from wherever it is, arriving `lead`
  seconds early, holds through the effect, and rejoins the circuit where it left off. A fixed slot
  would drift off the tick (holds are refitted and rescaled at run time, angle and zoom changes add
  rests, frame drops and game speed change the clock against wall time) and miss short effects,
  and repeating effects don't match the loop's length. So the camera can leave a view early or
  take a long pan to an effect across the park. Cut-in views are listed where they are expected
  to play (`place_cuts`/`placeCuts`); the listing is an estimate, playback follows the clock.
- **Per-park adjustments apply in every playlist** (owner, 2026-10-31). The settings UI's
  Adjustments toggles, Edit parameters and plugin-driven views editor write the park's profile
  (`parks/<slug>.toml`), which every playlist playing that park merges, so a change made while
  editing one playlist changes the others too. A playlist can still override one park by hand in
  its own `[park.views]`; the UI does not offer that.

## Background: view heuristics, first version

### Scoring snapshot (owner, 2026-10-26)

Before the stable-picking work (2026-10-26), the scoring was pinned at a commit of the development
history, which the public repository does not carry. The version 1 defaults below are that scoring
plus the wide-view guard.

### Version 1 defaults (owner, 2026-10-27)

The defaults at the merge of this work are version 1 of the view heuristics: the snapshot
scoring plus the wide-view guard (`wide_limit = 0.5`, on). Every other idea below stays as an
option, off. Open (see "Better default views" under Potential enhancements): the recurring near-ties where a ride view loses to a nearby static
view, and a view budget from distinct content.

Judged on renders (`tools/renderviews.py`), before and after, across every example park:

1. **Vehicle signal**: favor rides that have moving vehicles, without penalizing coasters for
   their long track (a per-vehicle cap on track did, and changed about 50 views). Tested as
   options (off): `track_activity = "moving"` 4 better, 9 worse; `track_activity = 0.5` 2 better,
   2 worse, 6 same, stability 22% moved against 16%.
2. **Large scenery once per object**, not once per tile: `large_scenery = "object"` (off): 5
   close-ups changed, 1 better, 1 worse, 3 same; it barely bites, as most large scenery in the
   examples is 1-tile pieces.
3. **Aim views at what is visible from their angle**: `aim = "visible"` (off): 0 better, 3 worse.
4. **View budget from distinct content** rather than built tiles (not designed yet).

Also tested and left off: `hide_own`, `hide_weighted` (closest, 3 better, 3 worse),
`falloff = "cell"`, `tie_margin` (less stable), `grid_anchor = "map"` (barely helped). Only
`wide_limit = 0.5` was a net gain (6 better, 4 worse); adding `track_activity = 0.5` and
`large_scenery = "object"` to it gave 7 better, 4 worse. The regressions that recur in every
variant are near-ties where a ride view loses to a nearby static view (Troubadours castle,
Constellations coaster ring, Sambhava bazaar, Ghillie Dhu v4).

## Potential enhancements

Each item's requirements, acceptance checks and open decisions are worked out in `docs/enhancements.md`
(2026-11-03); this section keeps the items as the owner raised them.

### Linux and macOS support (owner, 2026-11-03: the highest-priority enhancement)

**Basic Linux support: done (2026-11-03 to 11-05), released as a beta in v0.2.0.** The "Engine build" workflow builds a Linux
tarball (Ubuntu 24.04) and an AppImage (runs on Fedora, whose ICU and libzip differ from Ubuntu's);
`settings.sh` starts the settings page; the owner's pass on a Fedora laptop under Wayland passed the
mode, the bar, keys, editor, park changes, renderers, window styles and the tools (`docs/testing-linux.md`),
and the overlay finds its fonts under any distribution's font folders (patch 0015). The README's
Installing has a Linux section. In-depth performance testing was left out (owner: the patches leave
the performance-sensitive engine code alone). Not tested, known limits: X11/XWayland, sound, scale
factor 2.0 (1.5 passed). Left open: XScreenSaver hosting (the mode does not draw into a window it is
handed) and anything for macOS (no engine build; only the Python tools run there).

OpenRCT2 ships official Linux and macOS builds, and most of this project is already portable:
the generator resolves the user folder on all three systems (`tools/userdata.py`: XDG config on
Linux, Application Support on macOS), checks for a running game with `pgrep` off Windows, takes
the executable's path as an option, and needs only Python and Node; the engine patches compile on
Linux (the cloud sessions' CMake build is the compile check) and the overlay's font lookup has
Linux and macOS paths (patches 0013 and 0015). Nothing has been run on Linux or macOS yet.

Requirements, in order:

1. **A Linux machine** (the obstacle: the owner has none set up). A VM or a second drive with a
   desktop distribution is enough; the tests need a display (X11 and Wayland both), not
   performance. Install OpenRCT2 v0.5.6 from the official release (the AppImage or the distro
   package) and the RCT2 data files.
2. **An engine build for Linux** in `.github/workflows/engine.yml`: a second job copied from
   OpenRCT2's own Ubuntu CI job (CMake, the same patch application as the Windows job). The
   patched engine ships as a whole build (an AppImage or a tarball of the build tree) rather than
   two replaced executables, since Linux installs vary; the README's Installing section gets a
   Linux variant.
3. **A settings page launcher**: `Settings.cmd` is a Windows batch file; on Linux and macOS it
   is `python3 tools/settings.py` (a one-line `settings.sh`, or the README says so).
4. **A test pass of the screensaver mode** on the Linux build: the borderless window and the
   `--screensaver` flag under X11 and Wayland, the overlay's fonts, mouse input for the controls
   bar, ride music, the mode's window-style settings (patch 0014) and the engine's climate
   changes. `docs/testing.md` is the checklist.
5. **The tools with the Linux executable**: `renderviews.py`, `drawviews.py` and `importparks.py`
   call `openrct2 screenshot` and `openrct2 convert` through `--openrct2`; `perfrun.py` launches
   the game. Check each once.
6. **Wallpaper hosting**: Linux has no Lively equivalent, so the screensaver mode itself (the
   launch flag in a desktop entry, or XScreenSaver's program hook) is the documented way; macOS
   would need a `.saver` wrapper, out of scope.
7. **Docs**: README (Installing, Running it, Settings page) and `docs/testing.md` with the
   per-system steps.

Estimate: a day of work plus a test pass on the machine. Not a release blocker (owner).

### Live view editor in the screensaver mode (owner, 2026-11-02)

The mode's UI is built in the order controls bar and load cover, captions, then the editor
(`docs/screensaver-ui.md`). That editor is the simple one. A more complex "live" editor is left as
an enhancement: drag boxes on the playing park, the views list, holds, pans and Play, replacing
the drawing page.

### Weather and day/night in the generator (owner, 2026-11-02)

The mode has the stock effects as settings (Changing weather, Weather effects, Light effects in the
settings panel; Time of day on the bar: day, night, or the stock cycle from each park's date, patch
0014). Fuller support needs generator configuration:

- a configurable day/night cycle length (the stock cycle is one in-game month, about 6 min 50 s at 1×,
  four phases of about 1 min 42 s, and restarts at each park's saved date);
- optionally, views repeated during the opposite phase (a park's views by day, then again by night);
- scheduled weather phases (the stock climate picks the next weather every 48 s at 1×);
- exceptions for shows that set their own light, such as Constellations' eclipse.

Low priority (owner, 2026-11-02): most custom parks have no light emitters OpenRCT2 recognizes (its
light effects come from stock lamp, path and vehicle objects), so night shows little light in them.

### More caption frame styles (owner, 2026-11-03)

Done 2026-11-03 (Minimal dark and light, Aero with a frost texture, Canvas in a gallery frame with an accent
mat; the Title frame flyout): `docs/screensaver-ui.md` "Further styles". Left open from the pilot: Canvas's
plain stretcher edge (mocked up, not chosen) and a real blur for Aero (an engine patch; the frost texture
was preferred). The original item:

The park name caption's frame comes in gold, silver and wood (the settings panel's Title frame, drawn by
`tools/mkframe.py`), with a marble mat and a velvet byline band (`docs/screensaver-ui.md`). More styles
to add as further Title frame choices, each with its own mat and band where the portrait look does not fit:

- **Minimal**: a thin flat border or none, a plain translucent backing, no texture.
- **Aero**: frosted glass, a translucent light backing with a bright edge and soft gloss, after
  Windows Vista/7 window frames.
- **Canvas**: a painting's look: a canvas weave backing, with a plain stretcher edge or a simple
  gallery frame.

### Park name captions in the wrapper UI (owner, 2026-10-30)

Done 2026-11-03 in the screensaver mode (step 2), with the playlist key (`titles`) and the settings
page's control. The original item:

An optional feature of the screensaver wrapper UI (step 2): text boxes showing the current park's
name, with its authors as a byline. The names and authors would come from a New Element Designs
crawl (the authoritative credits list noted under "Small open items") and be stored in the per-park
profiles (`parks/<slug>.toml`), so every playlist that plays the park gets them.

A "Show titles" setting with three choices:

- **Overview**: the boxes show only during the park's overview view. When the return pan is on
  (a park's last view panning back to its first, the overview), they also show during that pan.
- **On**: the boxes show on every view.
- **Off**: no boxes.

The setting is stored in the playlist (owner, 2026-10-30), and a plugin setting
(`RCTScreensaver.settings`) can override it.

### Overnight memory soaks (owner moved them here from step 3, 2026-11-03)

The 1 h short-park soak (2026-11-03, report with the PC's run folder) settled to 83 MB/h,
1.3 MB per switch, over 64 switches of 10 parks, with no crash; first visits to new parks cost 24-38 MB
each (survey, features). Left open: whether that keeps flattening over 9 h, the QuickJS heap's slow
growth (4.7 → 7.3 MB in the hour), thermal throttling on the PC, and the crash after hours of play the
owner saw on 2026-10-30. `perf/soak.toml` is ready: `full` (9 h) first, then `no-background-loading`,
`no-companions`, `opengl` or `two-parks` only if `full` shows growth. Each night needs the owner's OK.

### Name rule for open prop rides (not needed for release)

Bangkok Dynamo's ride pan follows an open ride named `_Traffic` (a prop run as a ride); a rule
excluding names with a leading underscore would skip it.

### Better default views (automatic views v2; owner moved it here from the plan, 2026-11-02)

Improve the `spots` heuristics deliberately: the recurring near-ties where a ride view narrowly
loses to a nearby still view, and a view budget from the park's distinct content rather than
candidate counts (which the half-cell offset grids roughly double). Zoom -2 close-ups on large
parks still pick poor spots, even after weighting them down. Tested ideas are under
"Background: view heuristics, first version" above.

#### Circuit improvements in the random order (owner, 2026-10-31)

`route = "random"` is the generator as it was before the circuit: `RANDOM_OFF` turns off district
homing, tower views, nudges, beads, pan timing and ride pans, and overrides any `[views]` or
`--set` value for them. The enhancement makes each of these an option the random order can take
on, one by one, while keeping its pick order (which varies angle and zoom):

- **Tower views** (`tower_views`): views on towers no close-up shows whole. They take the angle of
  the nearest close-up in the pick order, as there are no district homes.
- **Nudges** (`nudge`): close-ups moved within their cell to where the pans in and out see the most.
  The pans are those of the pick order, which are longer and turn more than the circuit's.
- **Beads** (`beads`): pass-through views on long pans, which the pick order has more of.
- **Pan timing** (`pan_timing`): holds from pan length and the `park_cap`, so pans keep to the
  speed tolerance without `stretch_pans` alone.
- **Ride pans** (`ride_pans`): the pair along a ride's track, kept together at its place in the
  pick order.

District homing stays off, as it is what makes the order a circuit. Each option defaults to off in
the random order (today's behavior), set per playlist in `[views]`, per park in a profile, or with
`--set`; in the configurable generator (step 5) they would sit under the View order choice and show
only for random. To judge on the examples with the renders before any default changes.
