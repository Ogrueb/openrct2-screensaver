# Local test checklist

Run on the Windows PC with RCT2 installed (the Linux build has its own pass, `docs/testing-linux.md`). OpenRCT2's user directory there is
`Documents\OpenRCT2\` (contains `config.ini`, `sequence\`, `plugin\`, `plugin.store.json`).
Plugin `console.log` output goes to standard output: start OpenRCT2 from a terminal with
the console build (`openrct2.com`, next to `openrct2.exe`) to see it.

Each item records what was assumed from reading the source, so a failure points at the
assumption to revisit.

## 1. Generated title sequence (stock OpenRCT2, no plugin)
Install with `python3 tools/mksequence.py playlists/example.toml --layout stock --install`
(OpenRCT2 closed), then remove `Documents\OpenRCT2\plugin\rct-screensaver.js` for this part.

- [ ] Sequence appears under Options → Miscellaneous → Title sequence and plays.
- [ ] Every park loads (format versions 13–40, heavy hacks). Note any console errors.
- [ ] Views land on the intended area. `LOCATION` centers at ground height; check
      whether views in parks with high structures sit too low.
- [ ] Rotation is right for each view (rotation is relative to the park's saved view).
- [ ] A 10 s hold lasts 10 s, and does not change with game speed.
- [ ] Load time per park, and what is shown while loading.

## 2. Plugin
Install with `python3 tools/mksequence.py playlists/example.toml --install` (OpenRCT2
closed). Start OpenRCT2 via `openrct2.com`. On the stock engine the plugin plays on the title screen
and the toolbox menu has "RCT Screensaver: toggle debug log"; on the patched engine enter the
screensaver mode first (the checks below then apply inside it, with the `debug` plugin setting for
the log).

- [ ] Console shows `[RCT Screensaver] playing "RCT Screensaver Examples" (10 parks)`.
- [ ] An `intransient` plugin starts on the title screen and keeps running across park
      loads by the title player.
- [ ] `ui.mainViewport.moveTo`, `.rotation` and `.zoom` work on the title screen and are
      not undone by the sequence player during a `WAIT`.
- [ ] Plugin shortcuts bound to arrow keys fire despite the built-in scroll bindings.
- [ ] `context.executeAction("gamesetspeed", …)` changes speed on the title screen.
- [ ] `TitleSequence.play()` and `seek()` to a `LOAD` work from the title screen.
- [ ] Each control in the README key table does what it says; Space toggles.
- [ ] Views advance after their hold time; a held view stays put until released.
- [ ] Starting a game from the title menu stops the player; returning to the title screen
      restarts it.

### Follow-ups from 2026-10-26
- [ ] Speed set with Up stays the same after the next park loads (Shift+Right), and after
      restarting OpenRCT2.
- [ ] Tin Train and other parks that fit on the screen show one centered view, not views of
      the empty map edge. Try a smaller window and a larger one: more views appear as the
      window shrinks.
- [ ] Large parks: views no longer show the void past the map or park edge.

- [ ] Park changes fade to black, stay black while loading (no frozen frame of the old
      park), then fade in on the new park. No title bar or window border shows on the cover.
- [ ] Shift+Right then quickly Shift+Left fades back without loading anything.
- [ ] Starting a game during a fade leaves no black window behind.

### View editor
On the stock engine the editor is a window on the title screen; in the screensaver mode it is drawn
on the overlay with the same controls (`docs/screensaver-ui.md`).
- [ ] E opens the editor; playback pauses (no view or park change).
- [ ] Arrows pan the camera, Shift+arrows pan faster; rotate and zoom buttons work.
- [ ] Add view / Set to camera / Delete / Move up / Move down / hold spinner change the list,
      and the new views play as set after closing the editor (E).
- [ ] The park picker loads the chosen park (with the fade) and the list follows it.
- [ ] Restart OpenRCT2: edits are still there. Close it and run `--install`: the edits move to
      `playlists/example.views.json` and still play.
- [ ] Check whether mouse dragging can scroll the camera on the title screen (not expected).

Live editing (screensaver mode only, `docs/screensaver-ui.md` "Live editing"):
- [ ] With a view selected, drag the park: the picture follows the mouse, and on release the view's
      tile changes in the list and "Set by" says "you". A plain click on the park changes nothing.
- [ ] A drag that runs over the panel or the bar keeps going until the button is let go.
- [ ] The wheel over the park zooms the selected view one level per step; over the list it scrolls.
- [ ] Centre a tall building, then Rotate left or right: the building stays in the centre (the camera
      turns about its top, not about the ground behind it). Set to camera there, and a pan's turn into
      that view also keeps the building centred.
- [ ] Rotate ten or more times in a row over uneven buildings: after each full turn the picture is back
      where it started (no drift).
- [ ] Ctrl+Z and the Undo button step back through drags, zooms, holds, adds and deletes; Ctrl+Y (or
      Ctrl+Shift+Z) and Redo step forward; undoing everything shows "auto" views again.
- [ ] With Play on, a drag stops Play and moves no view.
- [ ] With the settings panel open, a click on the park closes it (no drag).

Editing UI (`docs/screensaver-ui.md` "Editing UI"):
- [ ] Three panes: views top left, toolbox bottom left (clear of the bar), restore points and Playlist
      properties top right. Every icon shows; hovering a button shows its name and key.
- [ ] Inactive buttons are flat and gray: Redo with nothing to redo, Reset view on a playlist view, Restore
      selected with no row highlighted, Copy, Paste, Import, Export, Save with nothing changed.
- [ ] Drag a view row by its grip: an orange line shows where it lands, the row moves there; Ctrl+Z undoes.
      An event row doesn't drag while the lock is on.
- [ ] On a park with event views, select one with the lock on: Set to camera, Delete, Hold, Pan and Reset
      view are gray, the hint says it's locked, and a drag on the park moves only the camera. Unlock on the
      map: the same tools work. During Play, add or delete a view above a cut-in that has played: it doesn't
      play again on that visit.
- [ ] On a park with timed events: they're in the Events list under the route (E1, E2, ...), not among the
      route rows; Plays counts down for a clock cut-in; clicking one selects it; its row doesn't drag. On
      the map they're labeled E1, E2 and no pan line leads to them.
- [ ] Hold the park field and release on another park: it loads. Click the field: the playlist order stays
      open; drag a park to another place, then close and step through the parks: they follow the new order.
- [ ] Move a view, select it, Reset view: it goes back.
- [ ] Save checkpoint, change things, highlight the checkpoint, Restore selected: the views come back.
- [ ] Playlist properties: Angle and zoom change Off makes turning pans cut and hides two holds; Title
      music Theme plays the theme at once; Save, restart the game: they are still in force.
- [ ] The pin off: the panes fade after the mouse rests; a move brings them back.
- [ ] A 1080p window at scale 2 (960x540 game pixels): the top-right box shows folded; its header unfolds it.
- [ ] Close the game, run `--install`: the park order and saved properties are now in the playlist file
      (comments kept, `.toml.bak` beside it) and still play.
- [ ] The keys: Insert, C, Delete, Enter/Shift+Enter, Page Up/Down, L (map), P, [ ], Shift+[ ].

The map (M or the Map button; `docs/screensaver-ui.md` "The map"):
- [ ] M steps the camera out; each view at this angle is a numbered box the size of its window, views at
      other angles are numbered markers; dotted lines join the views in play order (dense yellow: a pan,
      sparse cyan: a cut). Boxes stay on their spots while you pan (drag empty park, arrows) and zoom (wheel).
- [ ] Drag a box: it follows the mouse and the view moves on release; the camera stays. Drag the selected
      box's orange corner: the box snaps a zoom level bigger or smaller.
- [ ] Right-click empty park: a new view appears there. Ctrl+Z removes it.
- [ ] Double-click a box: the map closes on that view. Click a row in the list with the map on: the map
      centres on it.
- [ ] On a park with event views: their boxes say "event (locked)" and don't drag until the panel's
      Event views button unlocks them.
- [ ] Close the editor and reopen: the map is off. Install and play: map edits play as set.

### View panning (`docs/view-panning.md`)
- [ ] Default (`pan` unset): views still and cut exactly as before.
- [ ] A view with `pan` holds still, then pans to the next view and arrives exactly; angle/zoom
      change only as the pan sets off ("start") or arrives ("end").
- [ ] Inertia on starts and stops slowly, off keeps one speed; far pans at one zoom step out a level.
- [ ] Opposite angles turn once at each end; the camera rests 1 s at the spot before a change on
      arrival and stays still ≥ 2 s after each change.
- [ ] Timings: install with `--camera-log`, play a loop, then `python3 tools/cameralog.py <log>`
      prints each view's still, pan, speed, rest and post-change still and flags short ones.
- [ ] A park's last view pans back to its first: a one-park playlist carries on there
      without a reload; with several parks the camera holds there 2 s, then the next park follows.
      To a wider first view (the overview) it steps one zoom out as it sets off and moves at once, steps further out
      during the pan, and turns on arrival after a 1 s rest.
- [ ] Space pauses a pan and resumes it; Left/Right cut; a park's last view cuts to the next park.
- [ ] Sounds (patched engine) keep playing through pans and fade around cuts as before.
- [ ] Editor: Pan/Turn/Speed change the selected view; selecting a view cuts; nothing moves while open
      unless Play is on. With Play: the park's views pan and loop in the park; an edit replays from
      the selected view 1 s later (repeated edits restart the wait); arrows/rotate/zoom stop Play.
- [ ] Browser tool: "% pan", start/end and linear/inertia save to the views file and play after install.
- [ ] Frame rate while panning on large parks (Europa-Park, Sonnental) vs. still views.

## 3. Park behavior (observe during 1–2)
- [ ] Sambhava's Rest and Constellations look acceptable without companion plugins.
- [ ] Constellations ride 79 (AdvancedTrack feature) does not stall or break.
- [ ] Frame rate on Sambhava's Rest and Troubadours et Baladins.
- [ ] Decay over a long run (litter, breakdowns, guests leaving).

## 4. Patched engine (background park loading)
Install a build from the "Engine build" workflow (replace `openrct2.exe` and `openrct2.com` in the
portable install; keep the stock pair in `stock-backup\`). The plugin detects the patch and skips
the fade. Timings go to `Documents\OpenRCT2\rct-screensaver-engine.log`, one line per park load.

- [ ] Park switches show the old park animating until the new one appears; no fade, no freeze.
- [ ] Each line has `early`, `register`, `import`, `swap`, `finish` stages; `total` (main-thread
      part) is about 15-30 ms; `[preloaded=...]` near 0.
- [ ] The wrap from the last park to the first uses the background path too.
- [ ] No wrong tiles, leftover sprites, odd colors or crashes over several cycles.
- [ ] Shift+Right then quickly Shift+Left while a load is pending: the stale load is dropped
      without a crash and the park shown is the one asked for.
- [x] Palette (patch 0001): Gardens of Light (and
      Dream) show their white world, ground and backdrop past the map edge included, while the
      title menu, the plugin's windows and text outlines stay black. Other parks look unchanged
      (owner, 2026-10-27). Still to look at: a night-time park, and a normal game (any scenario),
      where nothing should look different.

### Screensaver mode (patches 0011-0013)
First checked with a throwaway test plugin (2026-10-31, since removed); the mode's own UI covers the
same ground now (`docs/screensaver-ui.md`). Run each check with Options → Display → Drawing engine
set to software (hardware display), then again with OpenGL, at scale 2.0. Passed on the owner's PC in
both engines (2026-10-31; the fps cap not yet measured).

- [x] The main menu has a fifth button (a monitor with a park, tooltip "Screensaver"); nothing else
      in the menu changed.
- [x] The button closes the title windows, goes borderless and shows the park with only the
      overlay's elements (captions, the controls bar on a mouse move), sharp at the monitor's own
      resolution (not blocky game pixels).
- [x] The mouse reaches the plugin: the bar shows on a move, buttons react, the cursor hides with it.
- [x] The game's other windows (the screensaver's editor, companion stand-ins) don't show, and
      clicks don't reach them; the screensaver's keys still work.
- [x] Esc leaves the mode: the title menu is back, the window style is as before, the overlay is
      gone. `config.ini` is unchanged (light effects, weather gloom, uncapped FPS, window mode).
- [x] `openrct2.exe --screensaver` starts in the mode (a stock-looking frame first is expected);
      Esc quits the game.
- [ ] With "uncap FPS" on in the game's own settings, the mode still runs at 40 fps (no extra
      CPU over the stock title screen).

### Plugin follows the mode (wrapper step 2)
Passed on the owner's PC 2026-11-01 (run-19 engine, `playlists/example.toml`), except title music.
- [x] On the patched engine the title screen plays the user's own title sequence, with no
      "RCT Screensaver" toolbox entries; the playlist's keys do nothing there.
- [x] The menu's Screensaver button (or `--screensaver`) starts the playlist; keys work.
- [x] Esc (from the menu) stops it: the user's own title sequence comes back, a held view is
      released, and the next entry starts the playlist again.
- [x] E in the mode opens the overlay's view editor (`docs/screensaver-ui.md`); outside the mode it
      does nothing on the patched engine.
- [ ] With `title_music = "ride"` installed, ride music plays in the mode only; `config.ini` keeps
      its own `title_theme`.

### Builds from the game (patch 0017, 2026-11-11)
Needs an engine build with patch 0017 and an install from this version (it writes
`Documents\OpenRCT2\screensaver\generator.json`).
- [ ] The build pane sits bottom right under the top-right box (folds to its header on a short window);
      the playlist's Save button is gone and a property change is kept after closing and reopening the editor.
- [ ] In the mode's editor, **Build and play** (or Ctrl+B) shows "Park n of m · name" with a running time,
      the squares fill in play order (a check per park; unchanged parks fill at once), no console window
      opens, and the game keeps playing smoothly meanwhile. With the editor closed, the bar shows
      "Building n/m".
- [ ] Build and play is inactive (Ctrl+B too) while every edit is built; an edit makes it active. The pane
      clears the exit button in the bottom right corner. Messages list newest first. Between builds the
      pane shows no line over the squares (the header says "built · playing") and the squares are taller;
      the park being built has diagonal stripes crawling across its square.
- [ ] After moving a park in the order the squares follow at once, none dimmed (a Playlist property
      change dims none either); a view edit dims only its park's square at once ("edited, needs a build"),
      and after the build it is lit again; while a build runs, parks not reached yet keep last build's
      colour, dimmed only when edited; square tooltips and "Park n of m" use the parks' own names; a warning park is
      amber with "!", and its message opens the park on a click. A park file renamed away builds as a red
      square with "file not found" while the rest builds.
- [ ] After a build, the playlist's TOML and views file hold the game's edits (`.bak` beside the TOML), and
      `python tools/bakelive.py --list` says nothing is waiting.
- [ ] When it is done the park on screen dips through black and plays on from the new build; the line says
      "Built at hh:mm, now playing". An edit made before the build (a reordered park, a changed hold) plays.
- [ ] A change only the generator makes shows up: e.g. Use playlist views on a hand-set park, then Build and
      play: generated views come back. After a park order change the next park follows the new order.
- [ ] Cancel build stops it (no python process left in Task Manager); the playlist plays on unchanged.
- [ ] After a restart of the game, the new build plays (the installed sequence and playlist match).
- [ ] With the settings page open on the same playlist, a build from the game marks its renders old
      (strip and contact sheet), and a build on the page leaves `screensaver\build\live` in place.
- [ ] With `generator.json` removed, the line says why the build cannot start.

### Import and Export playlist (patch 0018, 2026-11-12)
Passed in the game on 2026-11-12 (example playlist and a three-park bundle, Windows). Needs an engine build
with patch 0018 and an install from this version (`generator.json` with the playlist's file).
- [x] In the mode's editor, Export playlist opens Windows' Save dialog over the game (not behind it), named
      after the playlist, in Documents the first time and the last folder after. Closing it starts nothing.
- [x] Saving: the header says "exporting", then the messages list "Exported n parks ... to <file>" (and "Took
      in your edits" when there were unbuilt edits). The zip opens in the settings page's Import and holds
      the parks, the views file and any changed profiles of those parks.
- [x] Import playlist opens the Open dialog; picking a bundle shows "importing", then the squares of the
      imported playlist build ("Building the import · Park n of m"). When it is done the screen dips to the
      imported playlist's first park, the editor stays open on it, and the messages say "Imported "<name>" ...
      now playing". The playlist is in `Documents\OpenRCT2\screensaver\playlists`, its parks under `bundles`.
- [x] After a restart of the game, the imported playlist plays. Build and play then builds it (not the old one).
- [x] Importing a playlist whose parks have scripts that are not installed yet (or differ) lists an amber "<park>:
      park script ... starts after a restart of the game" per park using such a script, its square amber too; after a restart the scripts run on their
      parks. Scripts already installed with the same code give no warning.
- [x] Importing a bundle of the playlist that is playing replaces it, in the bundle's park order at once (reorder
      the parks in the editor before the import to see it).
- [x] A broken zip says why once, in the messages (no line above them); Cancel import stops it and the playlist
      plays on.

### Parks and playlists (patch 0019, 2026-11-12)
Needs an engine build with patch 0019 and an install from this version (`generator.json` and
`screensaver\live\playlists.json`).
- [ ] In the mode's editor, a click on the park field opens Playlist order with a tick per park. Ticking a park
      off greys it ("(left out)"), Next park passes it over at once, and the build pane's Build and play lights up.
      Ticking off every park but one leaves the last on ("One park at least stays in use").
- [ ] Build and play: the playlist file gets `use = false` on that park (comments kept); after the build the
      park is listed under NOT IN THE BUILD. Ticking it there says "needs a build"; the next build plays it again.
- [ ] Add park… (last row) opens Windows' Open dialog for `.park` and `.zip`; the picked park is added at the
      end of the playlist file and the playlist built ("Added <file> to <playlist>"), then plays with it. A park
      already in the playlist says so.
- [ ] Playlists (button in the list's header) lists every installed playlist with its park count, the playing
      one marked. A click on another builds it ("Building "<name>" · Park n of m") and plays it with the editor
      open; a click back switches back, the edits made in the first one still there.
- [ ] New playlist from a folder… opens the folder dialog; the new playlist ("RCT Screensaver <folder>") is
      written to `Documents\OpenRCT2\screensaver\playlists`, built and played, and listed under Playlists.
- [ ] Duplicate this playlist… opens the Save dialog in that folder ("<name> copy.toml"); the copy is named after
      the file, built and played; the original keeps its file and edits.
- [ ] After a restart of the game, the last playlist built from the game plays.

### Live file (patch 0016, 2026-11-10)
Passed in the game on 2026-11-10 (example playlist, Windows), except the settings page's panel, checked
through its function only. Needs an engine build with patch 0016 and an install from this version
(it records the playlist file in the installed playlist).
- [x] An edit in the mode's editor (a view moved, the park order, Playlist properties' Save) writes
      `Documents\OpenRCT2\screensaver\live\<playlist name>.json` at once (spaces as `_`).
- [x] With the game still open, `python tools/bakelive.py --list` names the playlist and what changed;
      `python tools/bakelive.py` writes it: the views file gains the park, the TOML the order and
      properties (comments kept, `.bak` beside it); a second run says nothing is waiting.
- [ ] The settings page shows "Edits from the game's view editor" with Bake into playlist while edits
      wait, and the build is marked out of date after an edit in the game.
- [x] A build without baking plays the edits too; `--ignore-live` leaves them out.
- [x] Copy views (or Ctrl+C) on one park, Paste views (Ctrl+V) on another: the views replace that park's,
      its event views stay, Undo returns; the button says "Copied n" / "Pasted n". A copy pastes into the
      settings page's drawing page (Paste there), and the drawing page's Copy pastes into the game; text that
      is not views says "No views" and changes nothing. (owner's game test 2026-11-12: passed; the
      round trip with the drawing page not tried)

## 5. Loose objects across imports (importparks.py)
`object/rct-screensaver/installed.json` records which import (the downloads given, by path) uses
each loose object file; importing a folder again replaces only that folder's objects.

- [ ] Cloud/any machine: `python -m unittest discover -s tools/tests` (fake `.DAT` downloads in a
      temporary user directory: a second folder keeps the first's objects, a re-import drops only
      its own unused files, objects installed elsewhere are not copied, a folder from before the
      record keeps its files under "(installed before the record)", which no import removes).
- [ ] PC, in a throwaway user directory (`--user-dir build\objtest`, so the real one is untouched):
      (`openrct2 convert` takes no options, so `.sv6` conversion still runs with the real user folder;
      only the loose objects go to the throwaway one)
      copy two EvenMoreParks downloads that ship loose objects into two folders (e.g. `...dreamport`
      into `build\objA`, `...rowling_versus_tolkien` into `build\objB`), import each into its own
      library (`importparks.py build\objA -o build\libA --user-dir build\objtest --openrct2 ...`, the
      same for B), then check `build\objtest\object\rct-screensaver\`: both downloads' files are there
      and `installed.json` lists each under its folder. Delete `build\objA`'s download, import A again:
      only A's files go. Then scan both folders from the settings page, one after the other, and
      check the same in the real user directory.
