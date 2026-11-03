# Parks' companion plugins

Some parks are published with a plugin that brings them to life: animations, recolors, light
shows. This note covers how OpenRCT2 v0.5.6 stores and runs those plugins, why none of them run
on the title screen today, and how the screensaver could run them. Read against the patched
engine (`engine/patches`, v0.5.6) on 2026-10-27; the plugin code read is the copy shipped in
each park's zip.

## What a park actually carries

A `.park` file never contains plugin code. It has one optional chunk, `pluginStorage` (0x38):
a JSON object keyed by plugin name, holding whatever each plugin saved with
`context.getParkStorage()` (`ParkFile.cpp`, `ReadWritePluginStorageChunk`). The code itself is a
`.js` file the author puts in the download zip, and players copy it into their `plugin` folder
by hand.

In the examples (storage sizes in bytes of JSON, from `tools/parkinfo.py`):

| Park | `.js` in zip | Plugin storage |
|---|---|---|
| Sambhava's Rest | `animator-0.0.1-lhc-r2.js` (Animator 0.0.1, `local`, GPL-3.0, API 56) | Animator 1,694; AdvancedTrack 27; Release Cleaner 25; bene-volantes 2 |
| Constellations | `Constellations-FINAL-LHC.js` (Object Animator 0.1.1, `remote`, MIT, API 83) | AdvancedTrack 336; CheatSaver 2 |
| Tin Train, San Avaiki, Troubadours | none | AdvancedTrack 2-27 |
| Gardens of Light, Sonnental | none | 5-7 plugins, all empty (2 bytes, `{}`) or near-empty |
| Ghillie Dhu, Koi Pond, Qhyre Rock | none | none |

Most storage entries are residue: a plugin installed on the builder's PC writes an empty or
default record into every park saved with it. Only Animator (Sambhava) and AdvancedTrack
(Constellations) hold real data, and only the two parks above ship code. So "does the park need
a plugin" is answered by the zip's `.js` files, not by storage keys.

## How plugins run, and why not on the title screen

OpenRCT2 sorts plugins by their declared `type` (`ScriptEngine.cpp`):

- `intransient`: started once at launch, runs everywhere, title screen included. The
  screensaver plugin is one.
- `local` and `remote` ("transient"): loaded and started only after `GameLoadScripts()`, which
  every normal park load calls (`Context::LoadParkFromFile`, new game, network join), and
  stopped and unloaded by `GameUnloadScripts()` before the next load. So each one starts fresh
  per park, after the park is in memory. In single player `remote` behaves like `local`.

The title sequence player (`TitleSequencePlayer.cpp`, stock and patched) loads parks through
its own path and never calls `GameLoadScripts()`, so transient plugins stay dormant on the title
screen even when installed. That matches the 2026-10-26 test: Sambhava and Constellations
render, their animations don't run.

What the title player does do:

- It reads `pluginStorage` and installs it as the park storage, so
  `context.getParkStorage("Animator")` returns the title park's data. With background loading
  (patch 0004) this is deferred to `FinishImport`, which runs before the switch.
- It fires `map.change` before and `map.changed` after each park switch. `map.changed` is
  delivered to intransient plugins only (`HookEngine::IsValidHookForPlugin`).
- The simulation runs, so `interval.tick` fires (it is called from the game tick with the
  game state mutable).
- With no network game, `IsGameStateMutable()` is always true, so a plugin can execute actions
  (`ridesetstatus`, which the screensaver already does with `gamesetspeed`) and write tile
  elements directly (colors, `isHidden`) on the title screen.

Nothing a plugin does on the title screen reaches a file: the title player reloads each park
from the sequence copy, and nothing saves it.

## What the two plugins do

**Animator** (Sambhava's Rest). `main()` builds the animation list from park storage once
(`getParkStorage().get("<namespace>.<name>")`), then subscribes to `interval.tick`. The
animations recolor train cars as they enter a ride, fade mist, and toggle scenery visibility
(`isHidden`) by writing tile elements in place. It opens a window only from its own editor. It
never moves the viewport during playback (it reads it when recording an animation).

**Object Animator** (Constellations). `main()` returns unless `park.name === "Constellations"`,
then registers a menu item, starts four ambient animations on `interval.tick` (spinning stars,
a Tesla launch, a horoscope spinner, a lift that lights up; triggered by vehicles reaching a tile
or always on), and opens its "Celestial Controls" window. The eclipse is started from that
window's button: it moves the main viewport to tile (55, 60) at zoom 1, rotation 2, darkens and
recolors objects map-wide, and switches ride music with `ridesetstatus`. Closing the window
before the eclipse has run reopens it. It keeps its own records in park storage under
"Object Animator".

Both read their state once in `main()` and assume a fresh start per park, which is exactly the
transient lifecycle. Neither checks `context.mode`.

## Running them alongside the screensaver

Requirements, whichever way they are run:

1. **Per-park lifecycle.** Start a park's companions after its load (`map.changed`), stop them
   and drop every subscription, interval, timeout and window before the next (`map.change`).
   Running one across parks would apply Sambhava's animations to the next park's tiles.
2. **Only the park's own companions.** The playlist decides which code runs with which park;
   the player's other installed gameplay plugins must not start on the title screen.
3. **No interface clutter.** Companion windows must not appear on the screensaver (Object
   Animator's controls), or reappear when closed. Menu items are harmless (no toolbar).
4. **Camera ownership.** The screensaver sets the viewport once per view (`showView` in
   `player.ts`) and doesn't reassert it, so a companion move (the eclipse) would hold until the
   next view. The screensaver must either win, or hand the camera over for a show.
5. **Storage under the right name.** `getParkStorage()` without a name resolves to the calling
   plugin's registered name, so a companion has to be seen under its own name.
6. **Cost.** Object Animator is 551 KB of JavaScript (webpack, lodash). Compiling it on every
   Constellations load may add a visible hitch; measure it against the 15-30 ms switch.

### Option A: a companion host plugin (stock engine)

`mksequence.py --install` copies each park's `.js` from its zip into a generated intransient
plugin, `rct-screensaver-companions.js`, each wrapped in its own function scope with shim
globals. On the title screen only (`context.mode === "title"`), it starts a park's companions on
`map.changed` and disposes them on `map.change`:

- `registerPlugin` captures the metadata and `main`, called once the park is loaded.
- `context.subscribe`, `setInterval` and `setTimeout` are wrapped so the host can dispose all of
  them at the switch.
- `context.getParkStorage(name)` defaults to the companion's own name.
- `ui.openWindow` returns a closed stand-in (or opens and closes at once), so control windows
  never show; `ui.mainViewport` can be wrapped to ignore or forward camera moves.
- Per park, the playlist can say which companions run and whether they may take the camera.

Works on the stock and patched engines, needs no engine change, and gives the screensaver full
control (windows, camera, a scripted "show" such as triggering the eclipse once per visit). The
costs: companions share one JS context with each other (function scopes keep their top-level
names apart, but a library that patches built-ins would leak), the shims must cover every API a
companion uses, and the code is evaluated with `new Function` (QuickJS-NG contexts have eval
enabled by default; to confirm on the PC). The host is separate from the screensaver plugin, so a
failing companion cannot stop playback. Third-party code is copied only into the user's local
plugin folder at install, never into this repo.

### Option B: engine patch for transient plugins on the title screen

The title player would call `GameUnloadScripts()` before and `GameLoadScripts()` after each title
park, so transient plugins run per park exactly as in a game. Faithful (own contexts, real
lifecycle, no shims), but every installed `local`/`remote` plugin would start on every title
park, so it needs an allow-list (a plugin directory per sequence, or a list in the sequence), and
windows and camera still need the screensaver's handling from the outside, where it can only
close windows after they appear. It also adds plugin compile time to the switch the background
loader keeps at 15-30 ms, unless that is moved off the switch too.

### Prototype (option A, 2026-10-27)

`tools/companions.py`, called by `mksequence.py`, writes one plugin per distinct companion (same
code for several parks is written once): `plugin/dist/companion-host.js`
(`plugin/src/companion-host.ts`) followed by
`RCTScreensaverCompanionHost(config, function (registerPlugin, context, ui, park, console) { <code> })`.
One file per companion rather than one shared host keeps each in its own JS context, under its own
`targetApiVersion` (which changes some API results, such as entity types before API 33). No
`eval` is needed: the code is pasted into the wrapper function. The plugin registers as
`<name> (RCT Screensaver)`, intransient, and starts the companion on `map.changed` when `park.name`
and `map.size` match one of its parks and `context.mode` is `"title"`. Window stand-ins keep the
widget descriptions, so a companion that updates its own controls (Object Animator does, every
tick) keeps working. Mock run (`plugin/test/companion-mock.mjs`): Animator loads and starts in
about 5 ms, Object Animator in about 11 ms.

### Animation views and shows (2026-10-27)

The owner asked for views on the animations, and for the eclipse as a final, long-held view.

- **Animation spots.** Animator's come from its park storage: the tile each trigger watches
  (`rideEnters`) and the tile boxes its actions change, merged when their centers are within 8
  tiles (the honey pots' two triggers, the mist's two animations). Their height is the trigger
  ride's track (the honey pot track is invisible on the trigger tiles, so its bounding box is
  searched) or the middle of what stands there. Object Animator's are hard-coded in its code, so
  their park's profile (`parks/*.toml`, `[[spot]]`) keeps them per companion. The angle is the one that
  hides least of the spot at its height (the `spots` method's hidden test), the zoom the closest
  that holds the spot with a half-size margin.
- **Flagged views** (`animation`, `show`) skip fitting and merging in the plugin, come after the
  other views, with the show last, and don't count toward
  `parkTime` or the view budget.
- **Shows** are button presses on the companion's hidden window, scripted in their park's profile (`[show.<name>]` in `parks/*.toml`). The eclipse:
  press `alignBtn`, wait until `disalignBtn` is visible (the shadow has crossed and paused), wait
  8 s, press `disalignBtn`, and wait until `alignBtn` is back (the eclipse has ended and the music
  is restored). The screensaver starts a show by executing the companion plugin's custom action
  (`rctscreensaver-show-<companion>`) when the show view appears. The host reports the end by
  executing `rctscreensaver-showdone`, which the screensaver registers, and the view ends 3 s
  later. Its hold is only the cap. The eclipse takes about 88 s at 1x in the mock (half at 2x),
  since its frames are counted in game ticks. Its view is where the eclipse itself moves the
  camera: (55, 60), zoom 1, rotation 2.

### Event-timed animation views (2026-10-30)

A fixed hold catches an animation only by chance: a lift runs when a train arrives, a recolor
when a car passes a sensor. Animation views now wait for the trigger and stay while the effect
runs (`View.cue`, `plugin/src/player.ts`):

- **Cue.** A car of `ride` on `tiles` (every car of each train is checked, every 4 ticks), one of
  `cars` (entity ids as saved in the park) on `tiles`, or `tick`, a game tick on the park's clock
  (ticks since the park loaded, which is when the host starts its companions; for timelines such
  as the Special Effects Editor's). `ticks` is how long the effect runs once cued.
- **Timing.** The view plays its hold (`cue_hold`, 5 s for generated ones) at least, waits up to
  `wait` (`cue_wait`, 30 s) past it for the cue, then stays until the effect's `ticks` and a 2 s
  tail are over (capped at twice the expected time, in case ticks stop). A timeline cue already
  past is not waited for. Once the cue has fired an event view's end is known, and it pans on to
  the next view like any other (owner, 2026-10-30): generated event views get a hold of
  `cue_hold` or the effect and its tail, whichever is longer, plus `cue_move` (4 s) of pan when
  the playlist pans; the plugin waits for the effect to end before the pan, and cuts instead when
  another cut-in is due before the pan would end. The editor lists them as set by "event".
  The editor's Play lists cut-in views in place but passes them by, playing them when cued as
  playback does (2026-10-30: they waited in place for their next lap, up to 35 s).
  Timeline cut-ins are listed where they are expected to play (owner, 2026-10-31): after the
  route view on screen when the cue first comes due (`tick / 40 - lead` s against the route's
  holds, in the build's `place_cuts` and the plugin's `placeCuts` after fitting), not after the
  route. Only the listing changes; pans between route views skip them (`pan_pairs`).
  Event views are an optional addition (owner, 2026-10-31): `[views] events = false` (or
  `--set events=false`) builds the park without any animation view, the companions still running;
  the other views and their order stay the same, as which views the park cap drops is decided on
  the route without its stops. With `route = "random"` (the pre-circuit generator in its pick order),
  stops take their cheapest place in that order and pan on with `[views] pan`, and cut-ins keep
  their ticks.
- **Follow.** With `follow`, the camera eases toward a train of that ride while the effect runs:
  the train that set the cue off when it is the same ride, else train `train` (default 0).
- **Cut-ins.** A view with `cut = true` leaves the view order and interrupts playback when its cue
  fires (not during a show or another event view), once per visit; playback then goes on after
  the view it cut. With a timeline cue it fires `lead` seconds before the effect starts and the
  camera pans there from wherever it is (from 1.5 s of lead; less cuts), arriving as the effect
  starts; one that fires late (another event view was playing) still plays while its effect
  runs. A timeline cut-in also interrupts another cut-in once that one's effect has started, so
  back-to-back events follow one another by pans (Yucca's finale: the first test returned to an
  ordinary view for a few ms between them, then cut in with under a second's lead). A park's views loop on, instead of the next park coming, until every timeline cut-in has
  played (Yucca's invasion runs to about 190 s, longer than the park's own views).
- **Timeline views (Yucca, 2026-10-30).** The owner asked for one view per UFO on schedule in place
  of the overview show: `parks/yucca-desert-park.toml` places seven `[[spot]]`s with timeline cues
  (shack 2400, water tower 3200, ghost town 4200, then the finale staggered so its overlapping
  events follow one another: butte 6000, cow 6300, entrance rocks 6750, crater 7100), zoom 0.
  `[[spot]]` takes `zoom`, `rotation` and `hold` in place of the placed ones.
- **Measured timings (owner, 2026-10-30: save them in the park's profile).** With the camera log
  on, the plugin logs every arrival on each car cue's tiles, whichever view is on screen
  (`camera … trigger view=N tick=T | animation | park`). `tools/cameralog.py <log> --triggers`
  lists each animation's first arrival and lap per visit and prints a profile entry turning the
  view into a timeline cut-in: `cue = {tick = first, lead = 3, cut = true, every = lap}`. A
  timeline cue with `every` comes again each lap (the plugin takes the first occurrence not yet
  over) and does not hold the park back the way a one-off timeline does; one whose effect has
  already started when it could cut in (another event view held it up) waits for its next lap.
  A cut-in view stays at least 4 s (`CUT_STAY_S`, or its whole effect if shorter) before
  another cuts in, and a repeating cut-in held up past its start still plays, after a short pan,
  while 4 s of its effect remain (live test 3: Base X's Break Ice 1 and Void's Block2Paint2 were
  left 26 ms after arriving, as the next one's lead had passed). A cut-in view that ends within 4 s (`CHAIN_S`) of the next timeline cut-in's lead pans on to it
  at once, and a following camera stops following while it pans away (first live test,
  2026-10-30: an ordinary view flashed between Void's cut-ins, Base X's camera flipped between
  two ice views). A view on several
  triggers gets the lap at which its arrivals repeat (the smallest step of arrivals whose gaps
  agree within 5%). First measurements (2026-10-30, 15 min, arrivals identical within 4 ticks on
  every visit): Base X's four effects run off ride 3 on a 3120-tick lap (icicle 2004, ice 2212 and
  2360, fountains 2968); Void's on a 1120-tick lap (88, 112, 328, 520). Both profiles now play them
  as timeline cut-ins. A timeline cue is not logged as a trigger, so remeasuring needs it removed.
- **Continuous animations are route stops (owner, 2026-10-30).** A view on an animation without
  a cue (Constellations' alchemist, Sambhava's mist) plays whenever the camera is there, so on a
  generated park it no longer waits at the end: `route_stops` in `mksequence.py` inserts it into
  the circuit where it adds the least pan cost (never inside a ride pair), flagged `fixed`, and
  pan_timing times its pans like any other view's. Its still (the animation's hold) is not counted
  against `park_cap`. The plugin plays a `fixed` animation view in its place and fitting leaves
  it as placed; event views and shows still come after the others.
- **Off by default:** AdvancedTrack's lifts (owner's review, 2026-10-30: Tower of Terror's and
  Pixar's run inside their towers, Expo Miami's is on a flat ride AdvancedTrack skips). A profile's
  `[animation."lift (ride N)"] off = false` brings one back.
- **Sources.** `tools/companions.py` derives cues from the companions' data (`animation_cues =
  false` turns them off):

  | Companion | Cue | Effect ticks |
  |---|---|---|
  | Animator (`rideEnters`) | the ride's head car on the trigger tile; follows that train | (length + 1) × intervalTicks |
  | AdvancedTrack lifts | a car of the ride on the lift's start tile | 50 (lock) + abs(endZ − startZ) × 100 / speed |
  | AnimationService sensors | one of the sensor's `entities`, else the ride's car, in its box | longest target animation: (last frame index + 1) × tickInterval × (numLoops + 1); none if endless |
  | RCTAnimator `carOnTrack` | a car of the ride on the trigger tile; follows the ride whose cars the frames change | the Delays of FramesToPlay frames |

  AnimationService triggers enabled by another in a chain are cued whether enabled or not, and
  RCTAnimator's trigger also checks the car's height and direction, which the cue does not.
  A profile `[[spot]]` can carry a `cue` table (a `tick` cue for a timeline, say).
- **Camera log:** `cue fired tick=… start=… ticks=…` and `cue cut view=…`.
- **Animation list.** `mksequence.py --animations` prints every animation each park's companions
  have (with `animations = true`): its tiles, height, cue, any profile change, and the view that
  shows it (merged animations share one), or why none (`off`, over `animation_views`). The same
  list is in `<sequence>.scores.json` (`animations`). A park's profile changes one by name:

  ```toml
  [animation."Shooting 1"]
  cue = {ticks = 600, follow = false}   # a shorter stay, no following
  [animation."pumps"]
  off = true
  [animation."Falling Icicle"]
  cue = {wait = 60}                     # its train comes round less often
  ```

  Keys: `off`, `hold`, `z`, `zoom`, `rotation`, `cue` (`false` for a fixed hold, or a table merged into the derived
  cue; `follow = false` drops the following). Applied with `park_plugins`, like `[extras]`.

### Per-park settings from profiles (2026-10-30)

A park's profile (`parks/*.toml`, `[companion.<name>]`) can change how the host runs one of its
companions on that park, passed in the host's park list:

- **Storage patches** (`[[companion.<name>.patch]]`, `id` and `set`): `getParkStorage().get()`
  and `getAll()` return a copy in which every object with that `id` has the given fields (dotted
  paths) set. Animator reads its animations once in `main()`, so a patch holds for the visit,
  and the park's own storage stays as saved. Sambhava's Rest: `fademist` every 15 ticks (50 as
  saved) with a clear radius of 20 tiles (13), so the mist clears faster where a view rests.
- **Pause during pans** (`pause_during_pans = true`): the host compares the main viewport's
  center, zoom and rotation every tick; while it changes, and for 8 ticks after, the companion's
  `interval.tick` handlers and intervals are skipped (timeouts, the host's own show steps and
  tick count run on). A cut pauses it for those 8 ticks only. Sambhava's Rest, against the
  camera judder during pans.
- **Pause above a zoom** (`pause_above_zoom = 0`): the same hold while the main viewport is zoomed
  out beyond that level. Animator's clear radius grows with the zoom (zoom + 3 times), so
  Sambhava's overview (zoom 2) burnt off most of the mist (owner's live test, 2026-10-30); with
  0 the mist clears only on the close-ups (zoom -2 to 0). The level is the viewport's own, so
  on a smaller window, where phase 7 moves views out a level, the limit cuts in a level sooner.
  `zoom_rates = { "1" = 0.05 }` slows it instead at the levels named: there it runs only that
  share of its ticks (Sambhava: a twentieth at zoom 1, paused beyond, every tick at 0 and closer).
  Neither pause holds the companion's first 2 ticks: Animator makes the mist visible on its first
  tick (its fade starts 15 ticks on), and a pause from the start at the overview kept the mist
  away until the first close-up (owner's live test, 2026-10-30).

- **Stale vehicles.** A ride's `vehicles` can name a car whose entity is gone. Object Animator's and
  Animator's car triggers look each one up and threw `cannot read property 'trackLocation' of null`
  every tick (Sambhava's Rest, 2026-10-27; reported during Constellations' eclipse, 2026-10-30), so the
  host hands companions a `map` whose rides list only cars that exist. The host already catches what a
  companion throws (stopping it for the park after 20 errors), so this kept the triggers working
  rather than the game running.

Unit check: `node test/companion-host-unit.mjs` (part of `npm test`).

A show can also wait in game ticks (`waitTicks`, from the step's start), and a show view can
carry a camera `path` (tiles, each reached a number of game ticks after the last), which the
plugin follows every game tick while the view is up, at the view's height unless a point sets
`z` (the ground's height along the way pulled the eclipse's glide short where the land falls away).
With a `pan` share on the show view, the camera glides through the points at one speed for that
share of the path's time and then holds at the end (owner, 2026-10-30: the eclipse pan was far too
slow at its full schedule, and its rests between legs read as stopping short; the hold belongs at
the end). Generated show views get `[views] show_pan`, 0.5, and the editor can change it; absent,
each point is reached on schedule. The camera log notes `path end` with the tile at the center.

Where a show plays and when its camera moves are separate (owner, 2026-10-30, indexes so -1 is the
last): `show_at` (an extra, or on the playlist's park entry) is the show view's place among the
park's views, -1 the last (the default), 1 right after the overview; the generator and the plugin
both put it there. The show's `steps` run inside the companion host from the moment the view
appears, and a `ticks` step waits for the companion's own tick count since the park loaded, so a
show on a timeline (Yucca's invasion) can be placed early and still wait for its moment. The host
reports each step as it reaches it (`rctscreensaver-showstep`), and `path_step` in the show's
definition holds the camera path until that step (an index into the steps, -1 the last): with
`steps = [{ticks = 5900}, {ticks = 7700}]` and `path_step = 1` the camera rests on the view until
tick 5900 and then glides, however early the view came. A show view never pans on to the next view, and it stays
until the camera reaches the path's end even if the show reports done first (at most twice its
hold). Storage patch paths can index arrays (`frames.0.actions.0.randomize.factor`). The eclipse uses both, so its slow glide
along the shadow's diagonal keeps time with the shadow at any game speed (`parks/constellations.toml`).

### More parks (2026-10-27)

The owner's larger survey (161 parks, `MoreParks/` on the test PC) adds seven zips that ship a
plugin, five plugins in all, and many parks whose storage names a plugin they don't ship.

| Plugin (type, API) | Parks that ship it | What it does on the title screen |
| --- | --- | --- |
| AdvancedTrack 1.3.3 (local, 47), 1.3.6 (local, 105) | 5th Dimension Tower of Terror, Birth of an Ocean; Pixar Animation Studios | Track switches, block brakes, and lifts that carry a train up or down (drop towers). Writes raw `tile.data`; 1.3.3 uses the flags byte of an older layout, so the newest version is the one to run. Quits under multiplayer only. |
| Special Effects Editor 1.0.7 (remote, 83) | Yucca Desert Park | A one-off timeline from the park's load, counted in game ticks and days: the shack burns on day 3, UFOs appear from tick 2400 to 7100, descend, abduct a cow, terraform the butte and fly away; a coin-operated rocket ride bobs. Posts a message a day. |
| AnimationService Spacek 0.3.3 (intransient, 92) | Void Extraction Research Base | 39 animations on 29 triggers (positions in world coordinates): the launched coaster's prelaunch gantry and trains repainted per block. Intransient, so it already runs on the title screen if the owner installs it; the install now warns when it is. |
| RCTAnimator Runtime 0.6 (remote, 84) | Base X | 13 animations in `Levis.Animations` (pumps, fountains, a falling icicle, shooting, breaking ice), played by its own custom game actions every tick; buttons only for button-triggered animations (none here); can move the camera per frame (no frame does here). |
| bene-volantes (local, 80) | Bene Volantes | Swaps the backdrop scenery around the ship to one of four locations, from buttons in its window (disabled during the 7 s change). Storage: the current location. |

What changed for them:

- **Host.** Custom actions the companion registers are registered for real once and routed to the
  current run (RCTAnimator needs them; OpenRCT2 refuses a second registration of a name).
  `ui.getWindow`, `closeWindows` and `closeAllWindows` work on the companion's stand-ins by
  classification (bene-volantes and RCTAnimator look their window up). Show steps `press` and
  `until` wait for a widget that is visible and enabled, and a new step `ticks` waits until the
  companion has run that many game ticks since its park loaded. The generated file drops the
  bundle's `"use strict"`, which applied to the companion's code too: AnimationService assigns
  undeclared variables and threw in strict mode.
- **Utility plugins.** Scripts a download ships that change nothing on screen are not run as
  companions when found automatically (`UTILITY_PLUGINS` in `tools/companions.py`, by their
  registerPlugin name): Peep Editor, shipped with Yatagarasu (EvenMoreParks sweep, 2026-10-31).
  A park's `companions = [...]` list still runs whatever it names. The sweep found no other park
  needing views: every effect companion's data sits only in its own park (Base X, Bene Volantes,
  Void Extraction Research Base, Sambhava's Rest), all profiled; other parks hold empty stubs.
  Memories of Mauritius is a new AdvancedTrack park whose two lifts (off by default) share the
  name "lift (ride 3)", so a profile cannot address them one by one.
- **Library.** Most parks of 2023-2026 carry AdvancedTrack data without shipping the plugin; their
  authors expected it installed. A playlist now gathers the newest version of each companion any
  of its parks ships, runs that version on every park that ships an older one, and adds it to a
  park (`companions = "auto"`) whose storage under the plugin's key holds real data. AdvancedTrack
  data counts only if a feature's ride has track on one of the feature's tiles, and only such
  features get animation views: Constellations and Murder in McAllan carry the same stale lift
  from another park (x 159 on maps of 122 and 134 tiles), and Valley of the Kings' two lifts name
  ride 25, whose track is elsewhere (owner's check, 2026-10-28: nothing to see there). On 5th
  Dimension Tower of Terror, 2 of its 14 features are live.
- **Animation spots** now also come from AdvancedTrack's lifts, AnimationService's position
  sensors and RCTAnimator's frames and car triggers. A park gets at most `animation_views` (4) of
  them, the ones where most animations meet.
- **Shows.** `travel` (Bene Volantes): through all four locations, 10 s at each, ending at the
  saved one, about 44 s. `invasion` (Yucca Desert Park): waits until tick 9000 of the park's run
  (225 s at 1x); it starts when the view appears, so at 2x it covers the second half of the
  invasion when the park's other views come first. Both views are placed like animation views.
- **Not needed.** CheatSaver, Release Cleaner, RideEditor, dynamicdashboard, statistics, Measuring
  Tape, Multi teleport, Adventure and SplitVision appear only as storage; none changes how a park
  looks. Most of their entries are empty (`{}`).

The test playlist for these parks lives outside the repository with the parks themselves.

### Recommendation

Prototype option A on Sambhava's Rest and Constellations first: it meets every requirement
above without engine work, and the window and camera rules are easier to enforce from inside the
shim. Fall back to B (or a narrow patch, such as loading plugin files from the sequence folder)
only if a companion depends on its own JS context or on an API the shim can't cover.

First checks on the PC, with a throwaway host plugin:

1. `new Function` evaluates in an intransient plugin on the title screen.
2. Animator animates Sambhava's Rest on the title screen (mist, train recolors), and stops
   cleanly when the next park loads.
3. Object Animator's ambient animations run with its window suppressed; time its evaluation.
4. Triggering the eclipse from the host, and whether the screensaver should follow its camera.

## What more sample parks should cover

The two examples are one style each. A fuller survey should include:

- **More plugins, and repeats of the same one.** Other animation plugins (the storage keys
  suggest AnimationService, Levis.Animations, bene-volantes), and several parks using Animator
  at different versions, to decide whether companions are deduplicated by name and version.
- **Different packaging.** Plugins as separate downloads or links in a README, in subfolders, or
  several per zip; parks that need a plugin the zip doesn't include.
- **Storage-only plugins.** AdvancedTrack with real data (Constellations, 336 bytes), CheatSaver,
  Release Cleaner: confirm the park looks right without them, or what breaks.
- **Start conditions.** Shows started by a button or tool (`ui.activateTool`), by the in-game
  date or time (`interval.day`), by guest actions (`action.execute` hooks), or by
  `map.changed`, which transient plugins never receive.
- **Camera and sound.** Plugins that move the viewport, follow vehicles, or rely on ride music.
- **Scale and API range.** Large bundles, plugins built for old API versions (Animator targets
  56) and ones that need a newer API than v0.5.6's 124, and any that check `context.mode` or
  `network.mode`.
- **Permanent edits.** Plugins that build, remove or recolor scenery for good rather than per
  frame, which matters if the screensaver restarts them on every revisit.
