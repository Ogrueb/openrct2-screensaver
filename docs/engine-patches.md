# Engine patches: background park loading

Design notes and measurements for the OpenRCT2 patch set (`engine/README.md` lists the series as
built). Facts below were read from the v0.5.6 source; the plan at the end is kept as written before
building, and each section's date says when it was built and measured.

## Goal

A park switch on the title screen without the freeze: the old park keeps animating until the
next one is ready in memory, then the switch happens within one frame. The fade to black in
the plugin then goes away (or stays as an optional transition).

## Where a park switch spends its time (v0.5.6 source)

`TitleSequencePlayer::LoadParkFromStream` (`src/openrct2-ui/title/TitleSequencePlayer.cpp`)
runs on the main thread, with viewport rendering inhibited, in this order:

1. **Read and decompress the whole `.park`.** `ParkFileImporter::LoadFromStream` builds an
   `OrcaStream`, whose constructor gunzips the entire file into memory. It then reads only the
   object list. Pure data work, no game state touched.
2. **Read the required object files from disk.** `ObjectManager::LoadObjects` already does this
   on a `JobPool` of worker threads (`ObjectRepository::LoadObject` is thread-safe by design),
   but the main thread blocks on the join. This is the part the plugin's `objectManager.load()`
   experiment moved earlier (saving 0.1 to 0.4 s of a 0.3 to 1.4 s switch, with stutters because
   that API also runs step 3 for each object, sequentially).
3. **Register the new objects and unload the old ones.** `Object::Load()` per new object hands its
   decoded images to the global image table and loads strings; `UnloadObjectsExcept` frees the
   objects the next park does not use. Main thread, but cheap: the heavy decoding happened in 2.
4. **Import into the game state.** `ParkFile::Import` fills `GameState_t`: `gameStateInitAll`
   (resets the full 1001×1001 map, rides, entities, finances, date, cheats), the tiles chunk
   (16 MB of tile elements memcpy'd, a fix-up pass over every element, the tile pointer index
   rebuilt), then banners, rides, entities and the small chunks. This is the "park file parse and
   map rebuild" the plugin could not preload.
5. **Prepare for playback.** `PrepareParkForPlayback`: main view, entity spatial index, scrolling
   text cache, news queue, palette (`Drawing::LoadPalette`), then `MapAnimations::MarkAllTiles`
   and `GameNotifyMapChanged`, and the first draw of the new park.

Steps 1 and 2 are the bulk of the disk and CPU work and touch no shared state. Step 4 is the
bulk of the rest and is all writes into the game state.

### Measured on the owner's PC (2026-10-26, stage 0 timing build, Examples playlist)

Milliseconds per stage, from `rct-screensaver-engine.log`:

| Park | read | objects | import | prepare | total |
|---|---|---|---|---|---|
| Tin Train (first load) | 58 | 70 | 106 | 38 | 272 |
| Tin Train (again) | 57 | 35 | 105 | 37 | 234 |
| Ghillie Dhu | 28 | 47 | 72 | 3 | 150 |
| The Koi Pond | 46 | 54 | 75 | 4 | 178 |
| Qhyre Rock | 24 | 61 | 70 | 3 | 157 |
| San Avaiki | 52 | 84 | 77 | 3 | 217 |
| Troubadours et Baladins | 75 | 104 | 85 | 6 | 269 |
| Constellations | 139 | 596 | 84 | 5 | 825 |
| Sambhava's Rest | 79 | 237 | 86 | 5 | 407 |
| Dream | 59 | 516 | 103 | 6 | 684 |
| Sonnental | 42 | 58 | 80 | 4 | 183 |

A second pass through the playlist was 10 to 20% faster on the heavy parks (Constellations 696 ms,
Dream 558 ms), so the disk cache helps a little. Object loading is the stage that varies (up to 600 ms), and read plus objects is 55 to 90%
of every switch; both move to the background in approach B. Import is a steady 70 to 105 ms
whatever the park (the map is always the full grid), which is what B leaves as a hitch of
3 to 4 game ticks; A removes it. Prepare is negligible after the first park.

### Stage 1 (background read) measured, same PC, same playlist

Main-thread milliseconds per switch, with `register` (objects registered and loaded, previous
park's objects unloaded) now separate; `read` and `objects` ran on the background thread.

| Park | read (bg) | objects (bg) | register | import | prepare | main thread |
|---|---|---|---|---|---|---|
| Ghillie Dhu | 31 | 26 | 6 | 73 | 2 | 81 |
| The Koi Pond | 45 | 32 | 12 | 74 | 3 | 90 |
| Qhyre Rock | 26 | 6 | 21 | 70 | 2 | 93 |
| San Avaiki | 50 | 34 | 44 | 75 | 2 | 121 |
| Troubadours et Baladins | 76 | 37 | 59 | 78 | 3 | 140 |
| Constellations | 131 | 401 | 71 | 77 | 3 | 151 |
| Sambhava's Rest | 87 | 113 | 131 | 82 | 3 | 217 |
| Dream | 65 | 647 | 22 | 77 | 3 | 101 |

The main-thread part fell from 150 to 825 ms to 81 to 217 ms. Import stays flat at 70 to 80 ms
(approach A removes it). `register` grows from park to park and does not track the number of new
objects (Dream, mostly new objects, took 22 ms), so it is probably the unloading of the previous
park's objects, or image-table fragmentation; stage 2 splits it to find out.

### Stage 2 (game-state swap) measured, same PC, same playlist

Patches 0004 to 0006 and 0008 (numbered 0003 to 0006 at the time). The import ran on the loader thread; `early` is object registration done
in 4 ms slices before the switch. Main-thread milliseconds at the switch:

| Park | register | import (bg) | swap | finish | prepare | main thread |
|---|---|---|---|---|---|---|
| Ghillie Dhu | 2 | 73 | 0 | 10 | 2 | 15 |
| The Koi Pond | 5 | 77 | 0 | 11 | 4 | 20 |
| Qhyre Rock | 8 | 80 | 0 | 10 | 2 | 20 |
| San Avaiki | 34 | 77 | 0 | 10 | 2 | 46 |
| Troubadours et Baladins | 53 | 81 | 0 | 11 | 3 | 67 |
| Constellations | 69 | 79 | 0 | 11 | 3 | 83 |
| Sambhava's Rest | 114 | 91 | 0 | 11 | 3 | 128 |
| Dream | 16 | 103 | 0 | 12 | 3 | 31 |

The swap costs nothing measurable and `finish` (window intents, palette, research flags, plugin
storage, peep animation conversion, save-var fixes) a steady 10 to 12 ms. What remained on the
heavy parks was `Object::Load()` of the new objects (handing images to the image table, about
0.2 ms per object), because the import finishes only a few ticks after the objects are read and
few slices fit in. Patch 0007 therefore holds the switch until every object is registered, so the
switch is unload, swap, finish and prepare only. No crash or visible glitch over several cycles
of the playlist on either build.

### Patch 0007 measured: the switch waits for registration

Main-thread milliseconds at the switch, every park, one cycle including the wrap:

| Park | early (sliced, before) | unload | finish | prepare | main thread |
|---|---|---|---|---|---|
| Ghillie Dhu | 3 | 1 | 11 | 2 | 16 |
| The Koi Pond | 12 | 4 | 11 | 3 | 20 |
| Qhyre Rock | 19 | 6 | 10 | 2 | 20 |
| San Avaiki | 47 | 3 | 10 | 2 | 19 |
| Troubadours et Baladins | 58 | 7 | 11 | 3 | 22 |
| Constellations | 71 | 10 | 11 | 3 | 27 |
| Sambhava's Rest | 132 | 13 | 11 | 3 | 31 |
| Dream | 9 | 13 | 11 | 3 | 30 |
| Sonnental | 10 | 13 | 11 | 3 | 30 |
| Tin Train (wrap) | 9 | 11 | 9 | 2 | 25 |

Every switch is 16 to 31 ms of main-thread work, about one game tick, down from 150 to 825 ms
stock. The old park plays until the switch. Only the two loads at start-up (the engine's own
first load and the plugin's `play()`) still use the synchronous path, by design. What is left:
unloading the previous park's objects (1 to 13 ms), `finish` (10 to 11 ms) and `prepare`.

## Approach A: stage a second game state, then swap (built: patches 0004 to 0007)

The title player comment above `parkImporter->Import(gameState)` already says "TODO: Have a
separate GameState and exchange once loaded", and `swapGameState(std::unique_ptr<GameState_t>&)`
exists in `GameState.cpp` with no callers. `GameState_t` holds the map (`tileElements`),
rides, entities, banners, park data, date, weather, cheats and research, so a second instance is
a complete park (about 35 MB extra memory).

Patched title-screen load, `.park` files only:

- **Background thread** (one `std::thread` owned by the player; started when the LOAD command is
  reached): step 1, step 2 into a private list of read-but-unregistered objects, then step 4 into
  a fresh `GameState_t`.
- **Main thread, when the thread reports done:** step 3, `swapGameState`, then step 5 and the
  deferred global fix-ups below. Until then `Update()` returns without advancing the position,
  so the old park keeps simulating and drawing. `position` stays on the LOAD command until the
  swap, so the plugin's "park loaded" detection works unchanged.
- **Fallback:** any failure in the background path, or a non-`.park` file, uses the stock
  synchronous path.

Why step 4 can run on another thread with a small patch: nearly every helper it calls
(`MapInit`, `SetTileElements`, `RideInitAll`, `GetRide`, `GetBanner`, `TileElementIterator`,
`FinanceInit`, `ResetDate`, `CheatsReset`, entity import) reaches the state through
`getGameState()`. Making that accessor honor a thread-local override (`thread_local
GameState_t* tlsState; return tlsState ? *tlsState : *_gameState;`) makes the loader thread fill
the staging state while the main thread keeps using the live one. Object entry indices in the
file are copied verbatim (file object order equals loaded-list order, `ObjectToLoad.Index`), so
the import does not need the new objects registered yet.

What step 4 touches outside `GameState_t`, and what to do with each:

| Global | Used by | Plan |
|---|---|---|
| Tile pointer index `_tileIndex`, `_tileElementsInUse` (`Map.cpp`) | `SetTileElements`, all map lookups | Same thread-local override, or move into `GameState_t`; rebuild on swap (1M pointer writes, a few ms) |
| `MapAnimations` static lists | `MapInit` → `ClearAll`, `MarkAllTiles` | Skip on the loader thread; run `ClearAll` + `MarkAllTiles` after the swap |
| UI intents (`ContextBroadcastIntent`), `ContextInit`, `Drawing::LoadPalette` | `MapInit`, `gameStateInitAll` | Skip on the loader thread; run after the swap |
| Script engine `ClearParkStorage`, `EntityTweener`, patrol areas, `Weather::reset` (reads the live climate object) | `gameStateInitAll` | Skip on the loader thread; run after the swap (weather is overwritten by the climate chunk anyway) |
| `gInMapInitCode`, `gInUpdateCode` | map code asserts | Make thread-local |
| Object manager, object repository | Read-only lookups during import; file reads in step 2 | Main thread does not change objects on the title screen during a load; step 3 runs only at swap time |

The risk is the long tail of statics not in this list. It is bounded: the patch is title-screen
only, `.park` only, falls back to the stock path, and the playlist is the test set. A stuck or
crashing background load shows up as such in testing rather than corrupting a saved game.

Patch size estimate: 400 to 600 lines across `TitleSequencePlayer.cpp`, `GameState.cpp/.h`,
`Map.cpp`, `ObjectManager.cpp/.h` (an entry point that takes pre-read objects), `ParkFile.cpp`
(skip flags), plus one scripting getter so the plugin can tell the patch is present.

## Approach B: preload only, keep the import on the main thread (built first: patch 0003)

Background thread does steps 1 and 2 only; the main thread does 3, 4 and 5 at switch time. No
game-state trick, so the patch is about a third the size and has no hidden-static risk. What
remains is a hitch of the import plus prepare: unknown until measured, probably 50 to 200 ms on
the large parks, so a few dropped frames rather than a freeze. B is also the first half of A, so
it is not wasted work if the hitch turns out to be visible.

## Approach C: keep objects loaded across parks

Listed on the roadmap. With A or B it is unnecessary: the object manager already keeps objects
shared by consecutive parks loaded (`UnloadObjectsExcept`), and reading the rest happens in the
background. Dropped.

## Plugin side

- No new load API: the plugin keeps calling `TitleSequence.seek(load)`; the patched player
  starts the background load there and swaps when ready. The switch lands 0.3 to 1.4 s after the
  seek instead of freezing for that long. The plugin can seek that much before a view's hold ends.
- One read-only getter (for example `titleSequence.backgroundLoading`) lets the plugin disable
  the fade and raise `LOAD_TIMEOUT_MS` when the patched build is running.
- Later, if exact switch timing matters: split into `preload(i)` and `seek(i)`.

## The interface's black (patch 0001)

The game palette, indices 10 to 245, comes from the loaded water object's palette image
(`Drawing::LoadPalette`, `src/openrct2/drawing/Palette.cpp`). Dream and Gardens of Light ship
custom water objects whose palette makes index 10 light. Index 10 is the color of the void
past the map edge and of every black pixel in the scene (the ground and scenery of those parks
are drawn with it, which is the point: a white world), but also the interface's black (text
outlines and shadows, the darkest shade of the black window color, the plugin's cover
window), so the menus wash out.

Patch 0001 keeps the two apart at the pixel level. Everywhere the water palette is copied into
the game palette (`LoadPalette`, the lightning flash in `UpdatePaletteEffects`,
`GfxTransposePalette`) the park's color for index 10 moves to the otherwise unused index 9
(`PaletteIndex::sceneBlack`) and index 10 is set back to the stock black (23, 35, 35); the
dynamic palette range becomes 9 to 245 so the day-night tint covers both. The viewport painter
then substitutes index 9 for index 10 in every pixel it has drawn (`ViewportSubstituteSceneBlack`
at the end of `ViewportPaintColumn`, after the weather gloom and money strings), so the void,
the ground, scenery, remapped ride colors and the blank tiles all show the park's color as
before, while the interface drawn on top (windows, text, interface sprites, translucent fills)
keeps index 10 and so stays black. The pass is a linear scan of the column's pixels, far
cheaper than painting them. It needs the pixels, so it only works with the software renderer
(the default); with the OpenGL renderer the scene's index 10 shows black instead. Screenshots
taken with `openrct2 screenshot` go through the same painter and match. The patch is not
limited to the title screen; in a normal game the interface stays readable in such parks too.
Confirmed by the owner (2026-10-27).

Two earlier versions were tested on the owner's PC and rejected (2026-10-27): keeping index 10
black and painting only the void with the park's color (Gardens of Light needs its ground
white, not just the void), and moving the interface's text and widget shades to index 9 while
the scene kept index 10 (interface sprites and translucent fills still carry index 10 pixels).

`mksequence.py` once had the same fix on the playlist side (rewriting the water object so index 10
is dark, losing the backdrop); that stopgap for the stock engine was dropped for the release.

## Ride music on the title screen (patch 0002)

Stock OpenRCT2 plays a title theme on the title screen (Options, Sound, "Title screen music",
config key `title_theme`) and never ride music: `RideAudio::UpdateMusicChannels` returns early
for `LegacyScene::titleSequence`, although rides still register their music instances and the
vehicle and crowd sounds already follow the view. Patch 0002 adds a sixth choice to that
dropdown, labeled "Ride music" (the stock string of the in-game checkbox, so the data files
stay unchanged; `TitleMusicKind::parkMusic`, stored as `title_theme = 5`). With it chosen no
theme plays (`PlayTitleMusic` finds no audio object for it, as with "None") and ride music
plays on the title screen exactly as in game: positioned and attenuated by the main view, at
the ride music volume. On the title screen the choice stands in for the "Ride music" checkbox,
which it ignores; master sound still applies. Picking another choice stops the ride music on the
next tick. Every title park switch retires the ride music channels (`PrepareParkForPlayback`),
since channels are keyed by ride id and the next park reuses ids for other rides. A stock
OpenRCT2 reading `title_theme = 5` shows "OpenRCT2" in the dropdown and plays no theme.
Two follow-ups for the screensaver are part of the same patch (owner, 2026-10-28):

- **Cross-fade between parks.** A title park switch moves the playing channels to a fading list
  (`RideAudio::FadeOutAllChannels`, instead of stopping them) whose gain falls to zero over 1.5 s
  of real time while the new park's channels rise from zero over the same span. A per-channel
  gain multiplies the positional volume. Circus music is stopped at once, as it plays an audio
  object's shared sample that the switch unloads; ride music streams are per channel.
- **A park's own soundtrack plays evenly.** When the open music rides of a park use exactly one
  custom music object (any identifier outside `rct1.`, `rct2.`, `rct2tt.`, `rct2ww.`,
  `openrct2.`), that object is taken as the park's soundtrack: on the title screen the first ride
  playing it is heard centered at -700 (the loudest a ride gets in view) whatever the view, and
  other rides using it stay silent, so view jumps neither cut nor pan it. Stock ride music and
  parks with several custom objects stay positional. The soundtrack is chosen once, when the
  park is put on screen (`PrepareParkForPlayback`), from the rides as saved, and plays while its
  ride is open and plays it: companions open and close hidden rides with their own custom music
  for sound effects (Void Extraction's AnimationService opens six `_SFX` rides on train events),
  which must not count. Choosing per tick let them drop the soundtrack to positional and back,
  or delay the choice into the view fades (owner, 2026-10-28).
  While that ride is closed or plays something else, the single custom object the open rides
  play, if there is one, stands in until it plays again: Constellations' eclipse closes its four
  intro music rides (`lhc_music_r101`) and opens four eclipse ones (`lhc_music_r102`), which
  would otherwise be heard only near the eclipse view (owner, 2026-10-28).

All three confirmed by the owner on the PC (2026-10-28).

## Sound fades around view changes (patch 0009)

A view jump on the title screen cuts the old view's sound effects and starts the new view's at
once. The engine cannot see a jump coming, but the plugin schedules every view, so it drives the
fade (owner, 2026-10-28): `TitleSequence.fadeSounds(level, ms)` ramps the sound effects and
positional ride music to `level` (0 to 1) over `ms` of real time from the current level
(`Audio::FadeTitleEffects`; the ramp is computed per mix buffer from atomics, so it is smooth on
the mixer thread). The mixer applies it to the sound effects group on the title screen; ride music
channels multiply it into their gain on top of the park cross-fade, except the park's even
soundtrack and circus music (a sound effect the mixer already fades). Any scene change
(`Audio::StopAll`) resets it to 1.

The plugin (`player.ts`) fades out over `SOUND_FADE_MS` (750 ms) before each scheduled view
change, the last view of a park included, so the old park's effects are silent before the
switch; every view fades in over the same time, the first view of a park included (an overview is
usually too far out for effects, but a park can start closer). A view change the plugin did not
schedule (a key press) cuts the sounds and fades them in; a park change started by a key fades
them out at once, as the park has to load anyway (owner, 2026-10-28). Holding a view or opening the editor
during a fade-out brings them back. A crossfade between two views would need the engine to work
out sounds from two cameras at once; not planned. On a stock engine `fadeSounds` is missing and
the plugin skips it.

## The interface takes the park's palette (deferred)

A park's water object replaces palette indices 10 to 245, which the interface shares with the
scene, so nearly every custom-palette park recolors menus, windows and text (stock behavior;
0001 only rescues black). A per-pixel split was written and dropped (owner, 2026-10-27): it marks
the pixels the viewport painted and converts the rest with the stock palette, but translucent
windows and text remap scene pixels through the park's palette, so they would come out wrong,
and the planned minimal-UI screensaver presentation makes the current interface matter less.
Revisit with that presentation if any interface stays on screen.

## Build and distribution

- OpenRCT2's own Windows CI builds with `scripts/setenv && build` (`msbuild openrct2.proj`,
  which downloads the prebuilt dependency libraries) on `windows-2025-vs2026` and uploads only
  `bin/openrct2.exe` and `bin/openrct2.com`; the data files are unchanged by our patches.
- Our workflow: check out OpenRCT2 at tag `v0.5.6`, `git apply engine/patches/*.patch`, run the
  same build, upload the two binaries. Installing a build means replacing those two files in
  the existing v0.5.6 install. Expect 25 to 40 minutes per CI build; incremental builds in Visual
  Studio on the owner's PC are the faster loop once the first full build is done there.

## Status (2026-10-27)

The background loading patches (now 0003 to 0008, with the load timings in 0020) are built by the
workflow and were tested on the owner's PC: stage 0 (timings), stage 1 (approach B), stage 2
(approach A) and the registration slicing. Patch 0001 (interface black, third version) was confirmed by the owner on the PC: Gardens of Light shows its
white world, the interface stays black, other parks keep their dark backdrop. Local Visual Studio
builds on the PC take 3 min 42 s from scratch and 30-40 s incrementally. The remaining hitch
(15-37 ms per switch) is visible but accepted by the owner (2026-10-27): the further steps
below (deferring the unload, slicing `finish`) would add fragility for little gain and are not
planned. The timing log stays for testing and is
dropped for release (owner, 2026-10-27). The workflow builds on pushes to `main` that touch
`engine/` and on manual runs; a branch build is a manual run (Actions, "Engine build",
"Run workflow", pick the branch).

## Screensaver mode (patches 0011-0013, 2026-10-31)

Design and progress in `docs/wallpaper-wrapper.md`. 0011: the mode (settings applied in memory,
`--screensaver`, Esc, mouse to the plugin, the `screensaver` API); 0012: the main menu button;
0013: the overlay, composited in both drawing engines. New code is in `src/openrct2-ui/screensaver/`
and `scripting/ScScreensaver.hpp`; upstream files get short hooks.

## Holding a park switch (patch 0010, 2026-11-02)

In the screensaver mode, park changes dip through black (owner, 2026-11-02; `docs/screensaver-ui.md`).
The background loader used to switch as soon as the park was imported and its objects were registered,
without telling the plugin. Patch 0010 adds two members to `TitleSequence`. `nextParkReady` is true
once the park read in the background could be switched to. `holdSwitch`, set by the plugin before
`seek()`, keeps the current park playing past that point until the plugin clears it. The plugin fades
the overlay to black, clears the hold, and fades in once the new park shows. A hold lasts at most
10 s once the park is ready, and a failed read is never held, so a plugin that never lets go cannot
stop the sequence. Upstream code touched: `ITitleSequencePlayer` (three virtuals with defaults), the
LOAD branch of `TitleSequencePlayer::Update`, and `ScTitleSequence`.

## Perf log (patch 0020, 2026-11-02; 0016 until 2026-11-10, 0017 until 2026-11-11, 0018 until 2026-11-12, 0019 until later that day)

For performance tests (`docs/performance-testing.md`). `--perf-log <file>` turns on
`src/openrct2/PerfLog.{h,cpp}`. Scoped timers in `Context::Tick`, `RunFixedFrame`/`RunVariableFrame`
(input) and `Context::Draw` (paint, present), and one in `ScriptEngine::ExecutePluginCall`, add up
each frame's stage times. `FrameDrawn()` writes a line after every draw, plus a sample every 10 s
(Windows `K32GetProcessMemoryInfo`, handle and GDI counts, `JS_ComputeMemoryUsage`, image list
stats from `drawing/Image.cpp`, entity and ride counts). The park load timer in the same patch also
writes its line as a `load` event, and the plugin writes `mark` events through `screensaver.perfMark`.
Without the flag every timer is a single null-file check. `--perf-quit-after` calls `ContextQuit()`.
`--no-background-loading` makes `CanLoadInBackground` false (`gOpenRCT2NoBackgroundLoading`). It
stays in every build until release (owner, 2026-11-02).

## Mode settings: renderer, volumes, weather, day and night (patch 0014, 2026-11-02)

The screensaver panel's options (`docs/screensaver-ui.md`), applied in memory and kept out of
`config.ini` like the mode's other values. `drawingEngine` (0 software, 1 OpenGL; unset: the user's)
switches as Options does, with `Drawing::RefreshVideo()`, and again on leaving the mode; `multiThreading`
(unset: the user's) sets the viewport renderer's threads; light effects
are set only with the software engine. The three volumes, `renderWeatherEffects` with the gloom, and the
window size (a window resized in the mode used to be saved). Two globals in `scenes/title/TitleScene.h`:
`gTitleRunsWeather` widens the `LegacyScene::playing` gate of `Weather::update` to the title screen
(`weather`), and `gTitleTimeOfDay` (`timeOfDay`: day, the stock daylight; night, `gDayNightCycle` held
at 1; cycle, `ScenarioUpdateDayNightCycle` as in play, with `dayNightCycle` set) its time of day.
`Weather::update` ignores a park's Freeze weather cheat on the title screen (all ten example parks
have it on). `gTitleNeutralDaylight` drops LightFX's hot-weather brightening of daylight (4% per degree
over 20 °C) while the mode is on. Cleared on leaving.

## Menu icon and stock sprites on the overlay (patch 0015, 2026-11-02)

The main menu's Screensaver button shows a monitor with a park and a coaster on it (owner: a more
descriptive icon than the play triangle). The patched build replaces only the executables, so the
icon cannot go into `g2.dat`: `tools/mkmenuicon.py --engine <tree>` draws it at the stock buttons'
80 px, snaps it to the standard palette (indices 10-229) and writes
`src/openrct2-ui/screensaver/MenuIcon.h` as runs, which `TitleMenu.cpp` fills. Owner, 2026-11-02: drawn at
68 px (laid out on the 80 px grid), centered across the button and standing near its bottom. An overlay image's
`src` may be `sprite:<image index>`: the sprite is drawn into an 8-bit render target and mapped through
`StandardPalette`, so the mode's exit button is the stock `SPR_MENU_EXIT` (23210) whatever palette the
park sets; with no size given a sprite is sized in game pixels (a PNG in output pixels). A text
element's `font` may be a bare file name, looked up in the system's font folder when it is not under the
plugin folder (`georgiai.ttf` for the captions' italic byline). An image element can show part of its
image (`cropX`, `cropY`, `cropWidth`, `cropHeight` in the image's pixels): the caption's marble mat is one
large texture cropped to each mat's size.

## Plugin files and the clipboard (patch 0016, 2026-11-10)

The plugin API has no file access beyond `plugin.store.json`, so edits made in the screensaver mode's
view editor reached the playlist's files only through `mksequence.py --install` (owner, 2026-11-10:
"asking the user to run the Generator just to apply their edits is awkward"). The patch adds to the
`screensaver` global:

- `readFile(name)` (the text, or null), `writeFile(name, text)` (true when written) and `listFiles()`, all
  in one folder, `<user directory>/screensaver/live` (`filesFolder`). A name is 1-128 characters of
  letters, digits, `.`, `_` and `-`, not starting with `.`, ending in `.json`: no separators, so nothing
  outside the folder is reachable. Files up to 8 MiB. A write goes to `<name>.tmp` first and is renamed
  over the old file, so the tools never read half a file.
- `clipboard`: the system clipboard's text (SDL), get and set, for the editor's Copy and Paste views
  (still inactive in the editor).

The plugin writes the live file on every save of the editor (`plugin/src/storage.ts` `writeLive`);
the tools' side is `tools/livefile.py` and `tools/bakelive.py` (`docs/screensaver-ui.md`, "Live file").
The game uses the folder of its own user directory, which on a portable install is not
`Documents\OpenRCT2`: the tools then need `--user-dir`. The diagnostics patch moved to 0017 (on 2026-11-11 to 0018, on 2026-11-12 to 0019, then 0020).

## Plan (as made before building)

0. **Pipeline and timings.** The workflow above, plus a first patch that only logs the time
   spent in each of steps 1 to 5 per park load. Gives the real breakdown on the owner's PC and
   proves the build and install loop.
1. **Approach B** (preload in the background, swap objects and import at switch time).
   Measure the remaining hitch.
2. **Approach A** (staged game state) if the hitch is visible.
3. **Dream palette fix** and the plugin getter, small patches alongside 1 or 2.
