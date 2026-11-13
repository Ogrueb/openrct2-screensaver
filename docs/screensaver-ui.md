# Screensaver mode UI (started 2026-11-02)

The screensaver mode's own interface, drawn by the plugin on the engine's overlay (engine patch
0013, `docs/wallpaper-wrapper.md`). Thread "Draft the Screensaver mode UI".

## Scope and order (owner, 2026-11-02)

1. **Controls bar and load cover** (this round).
2. **Captions** (park name and builders; "Show titles", roadmap "Park name captions").
3. **Editor**, last. A more complex "live" editor (drag boxes on the playing park, replacing the
   drawing page) is a roadmap enhancement, not part of this work.

## Look (owner, 2026-11-02)

The baseline follows the stock main menu: **square buttons, sharp corners, partly transparent
backings.** In `plugin/src/ui/theme.ts`:

- a dark backing strip (55% opaque, faintly green) with a one-pixel bevel, like the darkened row
  behind the stock menu's buttons;
- buttons in the stock menu's translucent dark green, raised (light top and left edges, dark bottom
  and right), lighter under the mouse, sunk while pressed, and **sunk while on** for toggles (hold,
  shuffle, titles, music), as the game shows a pressed tab; a sunk button's icon moves one pixel;
- white icons (`plugin/icons/`, drawn by `tools/mkicons.py`) and text in the overlay's TrueType font
  (Segoe UI on Windows) with a drop shadow;
- a tooltip on a black backing above the button under the mouse, with the key.

Button sizes (owner, 2026-11-02, after the second test): halfway from the first sizes to the stock
menu's 82 px buttons, so 61 px for the primary row and 46 px for the secondary row (in the same
proportion). Buttons with more than two states show one state in an **alternate color**, the
game's translucent olive: Titles on every view (green on the overview only), and the time of day's
Cycle. The speed button runs from green at 1× to orange at 8× in even steps (owner, 2026-11-02). The
secondary row is never wider than the primary row: its buttons shrink to fit (42 px with seven).

Sizes are game pixels, so the bar keeps its size against the park at any window size and scale
factor; the overlay draws it at the window's resolution (sharp at 4K and scale 2.0).

## Controls bar (`plugin/src/ui/controls.ts`)

Bottom center, 28 game pixels above the window's edge. Two rows on one backing (owner, 2026-11-02,
after the live test): the primary buttons, with the secondary row centered below them.

| Row | Button | Click | Key |
|---|---|---|---|
| Primary (61 px) | Previous park | as the key | Shift+Left |
| | Previous view | | Left |
| | Hold | toggles; shows pause, or play while held (sunk) | Space |
| | Next view | | Right |
| | Next park | | Shift+Right |
| Secondary (46 px) | Speed (`1×`, `2×`, `4×`, `8×`: OpenRCT2's speeds 1-4) | faster, wrapping 8× to 1×; right click slower; wheel over it | Up/Down |
| | Shuffle | toggles (sunk while on) | S |
| | Titles | Overview, On, Off in turn (`settings.titles`; the park name captions below) | |
| | Music | toggles off and the parks' ride music (owner, 2026-11-02); applied at once (`screensaver.configure`). A playlist's `title_music = "theme"` stays a playlist setting and plays until switched off here | |
| | Time of day (sun, moon, sun and moon) | Day (raised, the stock title screen), Night (sunk: full night throughout), Cycle (alternate color: the day/night cycle as in play) in turn (`timeOfDay`; owner, 2026-11-02; patch 0014) | |
| | Settings (cog) | opens the settings panel (sunk while open) | |

- **Exit:** the stock title screen's exit button (`SPR_MENU_EXIT`, 40x64 game px in the bottom right
  corner, as in the stock interface) shows and hides with the bar and does what Esc does: back to the
  stock title screen, or quit when the mode was started with `--screensaver` (owner, 2026-11-02; drawn
  by the engine in the standard palette, patch 0015).
- **Showing and hiding:** the bar starts hidden, with the cursor hidden. A mouse move shows both
  (150 ms fade); 2.5 s without movement hides both (400 ms), never while the mouse is over the bar
  or a button is pressed. A click while the bar is hidden only shows it.
- **Keys** work as before. The bar shows what they change (the hold button and speed follow).
- **Settings:** the bar and the player share one `RCTScreensaver.settings` object. Speed and shuffle
  were already kept there. `titles` is new (default "overview"). `titleMusic` gains "off". The
  music choice holds until the next `mksequence.py --install`, which writes the playlist's
  `title_music` again.

## Settings panel

Opened by the cog in the secondary row (owner, 2026-11-02). It holds the parts of the stock options
menu that apply to the screensaver mode. Like the mode's other settings, they are applied in memory
at once (`screensaver.configure`) and kept in `RCTScreensaver.settings`, never in `config.ini`.

| Option | Values (click cycles) | Setting |
|---|---|---|
| Window | Borderless, Windowed, As in Options | `window` |
| Renderer | As in Options, Software, OpenGL; switched live by recreating the window, as the stock Options does | `drawingEngine` |
| Multithreading | On, Off: multithreaded viewport rendering, the stock Options checkbox next to the renderer (owner, 2026-11-02); until clicked, the game's own | `multiThreading` (null: the game's) |
| Changing weather | Off, On: the title screen runs the climate, so a park's weather changes as in play (patch 0014) | `weather` |
| Weather effects | Off, On: rain and snow drawn, with the gloom of bad weather (the stock checkbox sets both) | `weatherGloom` |
| Light effects | Off, On; kept whatever the renderer and time of day (owner, 2026-11-02), shown only with Software at night | `lightEffects` |
| Master volume, Sound effects, Music | sliders 0-100% in steps of 5; until moved, the game's own volume | `masterVolume`, `soundVolume`, `musicVolume` (null: the game's) |

Exclusive fullscreen is not offered (owner, 2026-11-02): it switched the monitor to the fullscreen
resolution in the game's settings (1920x1200 on the owner's 4K screen), which broke display scaling.
Borderless fills the screen at its native resolution.

How the effects depend on each other (from the engine source, 2026-11-02). The stock game updates the
weather (`Weather::update`) and the day/night cycle (`ScenarioUpdateDayNightCycle`) only in play, so
on its title screen every park keeps its saved weather, in daylight. Patch 0014 lets the mode run the
climate and set the time of day (the bar's Time of day button):

- Night: the night tint throughout, in both renderers.
- Cycle: the day/night cycle. The time of day follows each park's date, which
  starts at the saved one on every load: a month is 16384 ticks (about 7 minutes at 1×), daylight its
  first eighth, dusk to full night by three eighths, night to five eighths, dawn to seven eighths; so a
  park saved mid-month plays at night and one saved early in the month in daylight.
- Light effects (lamps, ride lights): need night (Night, or Cycle at night) and the software renderer.
  Their palette filter also brightens daylight by 4% per degree over 20 °C (the example parks are saved
  at 14-32 °C, so up to half again: the owner saw "overexposed" daylight, 2026-11-02); the mode leaves
  daylight as it is (patch 0014, `gTitleNeutralDaylight`).
- Weather effects: need bad weather, which a park has when saved in it, or later with Changing weather
  on: the climate picks the next weather every 1920 ticks (48 s at 1×) and moves toward it gradually.
  All ten example parks are saved with the Freeze weather cheat on (as most custom parks are, it seems),
  so Changing weather overrides it on the title screen; the first test of it showed no weather at all.

Software runs at 13-40 FPS at 1920x1080 on the owner's PC (earlier tests); OpenGL is the default.

The panel sits above the bar: a backing with the title "Screensaver settings", then one row per
option, with its label on the left and a value button on the right. A click outside the panel and the
bar closes it, and so does the bar hiding. Tooltips are off while it is open.

## Palette

The mode's interface is drawn on the overlay, after the game has turned the park's 8-bit pixels into
color through the palette (both renderers), with RGBA colors, TrueType text and PNG icons, so no
park palette reaches it: Gardens of Light's light void, the night tint, weather gloom, lightning and the
light effects filter change the park only (owner's item, 2026-11-02). What still takes a park's palette:
stock windows outside the mode (the main menu, Options; stock behavior) and the stock engine's dithered
load cover. The view editor moved onto the overlay for the mode (below).

## Park name captions (`plugin/src/ui/captions.ts`, first draft 2026-11-02)

A portrait frame in the window's top left corner, 28 game px from both edges (owner, 2026-11-02: "portrait
frame" style): a carved gold moulding 14 game px wide (outer lip, rounded rail, a row of beads, cove, bright
fillet; lit from the top left, mitred corners; `tools/mkframe.py` draws its corners and 16 px edge tiles at
every scale), its bead band in dark amber (or the other mouldings, picked in the Title frame flyout below: silver, one
smooth cushion with a scrolling rinceau debossed into it, the scrolls of the two sides overlapping in each corner;
grained walnut with a single-run rope in its ebony band, a 4 px strand pitch running clockwise round the frame, with
a round boss at each corner; owner, 2026-11-03), round a marble mat at 80% opacity: the upper center (0.8 of its width) of a marble
photo the owner chose, softened with a gaussian blur, tinted a light rose gold and lightened (`tools/mkframe.py --marble <photo>`, 576x256
game px at scales 1-3; the plugin shows the part a mat needs with the overlay's crop, patch 0015; the mat
comes in whole 16 px frame tiles). On the marble the park's name in black,
engraved (Georgia bold 34 px, a faint shadowed edge above and left and a light one below and right; 16 px
above and below it, and the frame tiles' slack, so the title takes most of the frame), a
dark wood-grain divider (9 px, raised: strongly beveled up at its top and bottom) running from frame to frame,
a velvet band below it (a soft sheen and fine pile, 94% opaque; tiles of 192x96 game px; the flyout's
Accent: green by default, burgundy, navy, slate or ivory),
and the builders in italics ("by …", Georgia italic 16 px; gold on the dark velvets, dark brown on ivory). Owner, 2026-11-02/03, over six rounds. Georgia is a system font named by file
(patch 0015 looks bare font file names up in the system's font folder); where it is missing the default
sans stands in. The name and byline come from the playlist (`name`, `author`: the
profile's or the NE catalog's credits). Long names wrap at 560 px (or the window's width).

### Further styles (owner, 2026-11-03; mock-ups in the project files' `caption-styles/`)

The Title frame flyout offers four more styles beside the gold, silver and wood portrait frames. Each lays the
caption out the same way (the mat in 16 px tiles, the title's section above a divider, the byline below) with
its own thickness round it, divider and fonts (`theme.ts` `CAPTION_STYLES`; Segoe UI for Minimal and Aero,
by file name as Georgia, the default sans where missing). The Accent (`settings.captionBand`, the velvet
colors by name; `theme.ts` `ACCENT`) colors each where it fits:

- **Minimal dark:** the stock backing's green-black at 75% with a 1 px light border, a white Segoe UI bold
  title (30 px) with a shadow, a hairline divider, the byline in light gray (15 px). No accent.
- **Minimal light:** off-white at 85%, no border, a 6 px strip down the left in the accent, dark text.
- **Aero:** frosted glass with rounded corners (8 px). The overlay can't blur what lies under it, so a frost
  tile stands in for the blur (owner, 2026-11-03): denser glass (80%) mottled at two sizes with a fine
  sparkle, so the park behind shows as soft color rather than detail. A 7 px rim (dark outline, bright
  line, tinted glass; rects, with corner pieces) round the inner panel (its light bevel, the frost tiles),
  a gloss sheet over the upper half stretched to the box, an etched divider, and dark text with a white glow
  (the text drawn again round itself, 12 times). The accent tints the glass (lighter than the velvet).
- **Canvas:** a linen weave (threads 2 px apart; 192x96 tiles) in a plain black gallery frame (10 px, lit
  top and left, mitred; corners and one stretched edge tile per side), with a mat board (9 px) in the accent
  between them: the frame's shadow on its top and left edges and a cream bevel round the opening. A soft
  drop shadow (three steps of a 14% black rect), the title in dark umber (Georgia bold) with a light edge,
  a pencil-thin divider, the byline in brown (Georgia italic).

`tools/mkframe.py` draws the Aero corners (per accent, at every scale), frost tiles (per accent) and gloss,
and the gallery frame and linen, all in plain Python like the moulding.

### Title frame flyout

The settings panel's Title frame button ("Gold ›", sunk while open) opens a flyout beside the panel (right
of it, else left, else over it in a small window), level with the button and kept above the bar (owner,
2026-11-03, after the mock-up): a tile per style with a preview of it ("Park name, by Builder" laid out by
the caption's own code at a smaller zoom, in the current accent) over its name, in rows of portrait frames
(Gold, Silver, Wood), plain styles (Minimal dark, Minimal light, Aero) and Canvas, then the Accent swatches
(the velvets). A click on a tile or swatch applies it at once and keeps the flyout open; the Title frame
button, a click on the panel's backing, or anywhere outside closes it. The panel's separate Title velvet row
is gone (the accent lives in the flyout).

- **Show titles** (the bar's Titles button, `settings.titles`): Overview shows the box on each
  park's first view (its overview) and during the pan back to it; On on every view; Off never. A
  playlist can set it (top-level `titles`, the settings page's Show titles; owner, 2026-11-03): each time
  playback starts the playlist's choice stands in for the viewer's, in memory only (`titlesOverride`,
  never saved), until the viewer clicks Titles, which sets and keeps the viewer's own from there.
- **Placement** (settings panel "Park titles", `settings.captionPlace`; owner, 2026-11-02): top left
  (default), bottom left, top center, bottom center, 28 px from the edges. Bottom left sits beside the
  controls bar, 28 px from the bottom. Bottom center (and bottom left when less than 300 px is left
  beside the bar) keeps the same 28 px margin while the bar is hidden and moves up to 12 px above the bar
  while it shows (owner, 2026-11-03), at once, as the bar starts to fade in or out.
- **Timing:** the frame fades in with the park (owner, 2026-11-02: the load cover's `fadeMs`, so it
  rises with the park after a dip) and out over 500 ms when the view moves on. A new park's caption
  never fades over from the last one's.
- **Layering:** under the load cover, so a dip to black covers it; hidden while the view editor is open.

## View editor (`plugin/src/ui/editor-panel.ts`, owner 2026-11-02)

The editor that the stock toolbox menu opened (`plugin/src/editor.ts`), rebuilt on the overlay for the
mode: windows do not show there. The pencil button on the secondary row (sunk while open) or E opens and
closes it, at the window's top left; it stays up with the bar and the cursor while open. Same controls
as the window: the park (‹ › to step through the playlist, × closes), the views list (# tile angle zoom
hold pan "set by"; a click selects and shows a view, the wheel scrolls past ten rows), Add view, Set to
camera, Delete, Move up and down, Use playlist views, the selected view's hold and pan share (− +),
Turn (start or end) and Inertia, Rotate left and right, Zoom in and out, Play (sunk while on), and a
status line (camera, where the views come from). Arrow keys pan the camera while it is open (Shift:
faster), and Space starts and stops Play. After the owner's first look (2026-11-02): a nearly opaque
backing, list columns as wide as their widest text, hold and pan on one line with their values centered
between − and +. `Editor` keeps the logic for both: the stock engine still gets the window (`WindowView`).
Since 2026-11-10 the overlay's panel is three panes ("Editing UI", below); Turn and Inertia moved to the
playlist-wide properties there.

### Editing UI (owner's design, 2026-11-10; mockups in the project files' `editor-ui/`)

The panel became three panes (round 8 of the mockups accepted, built the same day):

- **Views pane, top left.** The PLAYLIST field, then previous park, the park field (name, "N / M ▾" its place
  in the play order), next park (no close button since 2026-11-12, owner: E and the pencil close the editor). A press on the field held past 0.3 s opens the park list over the views and jumps to
  the park the button is released on; a click opens it as **Playlist order**: rows with grips, Use ticks
  (2026-11-12, "Parks and playlists" below), numbers, names and view counts, dragged to reorder the parks (saved in the game at once, `RCTScreensaver.
  playlistProps.<sequence>.order`, and played in that order at once), clicked to go to a park (the list
  stays); a click anywhere else closes it (Esc is the engine's: it leaves the mode). The views list has a
  grip column: a row dragged 5 px lifts (the dragged row follows the mouse, its place dims, an orange line
  shows where it lands) and drops there as one change (undoable; Ctrl+Up and Ctrl+Down move the selected
  view too). Event views stay put while the event lock is on and say "event (locked)"; generated views say
  "generated". The lock covers every edit of a selected event view (owner, 2026-11-10), as its timing comes
  from the park (its clock, a train, a show), not from its place in the list: Set to camera, Delete, Hold,
  Pan and Reset view go gray, and a drag or the wheel on the park moves only the camera (the hint says so).
  Edits around event views keep the visit's cut-in record: played and pending cut-ins are tracked by their
  trigger, not their row (`Player.remapCues`), so an insert or delete above one neither replays nor skips it. The wheel and the thin scroll bar (thumb drag, track click) scroll past ten rows. The status
  and help lines went (the toolbox's hint and the box's header say it).
- **Event list** (owner, 2026-11-10), under the route list in the views pane, folded away when the park has
  none: the timed event views (cut-ins on the park's clock, car cues, shows, cued animations: `isPinned`)
  apart from the route, as their ordering doesn't follow the route's rules. The route list holds the rest,
  fixed animation stops included (they play in their place), numbered 1..N along the route; events are
  E1, E2, ... in the order they play (cut-ins at their tick less the lead, the rest after the route).
  Columns: kind (clock, train, show, animation), name, trigger ("at 1:00, every 2:00", "a car of ride 3"),
  hold, and Plays ("in 0:42" counting down on the park's clock, "played" for a one-off cut-in done this
  visit, "after view N" for the rest). No drag handles; a click selects, and the lock applies as above. A
  route row dragged (or Ctrl+Up/Down) moves among the route views only. The map numbers events E1, E2 too
  and draws pan lines along the route only.
- **Toolbox, bottom left.** The **Frame | Map** switch on top (Map olive while on, "M" beside it), a
  one-line hint for the mode, then icon buttons under small labels: VIEW (add, set to camera, delete),
  CAMERA (rotate left and right, zoom in and out), EVENTS (the lock: sparkles over a padlock, usable on the
  map only); HOLD and PAN as − value +; a footer of undo, redo, a gap, **Reset view** (the selected view
  back to its playlist version: each view remembers which playlist view it started as, `View.origin`,
  until install), and at the right the **pin** (on by default: the panes stay shown; off, they hide with
  the cursor, and the controls bar with them, `settings.editorPinned`) and **Play** ("P"). Every button's tooltip names it and
  its key. Buttons that would do nothing are flat, pressed in and gray, their icons dimmed (owner).
  Set to camera works on the map only: in Frame mode the selected view already follows the camera (owner's
  test, 2026-11-10), so the button is gray there and C does nothing. Keys: Insert add, C set to camera, Delete, Ctrl+Up/Down move, Enter and Shift+Enter rotate right and
  left, Page Up and Page Down zoom, L the event lock, P Play, [ and ] the hold, Shift+[ and Shift+] the pan
  share, M the map, Ctrl+Z and Ctrl+Y undo and redo, E closes.
- **Top-right box.** A header "RESTORE POINTS · PARK" with where the views come from ("edited · saved in
  the game", "playlist views", or a warning); a click on it folds the box, and a window too narrow for it
  beside the views pane (960 game pixels wide) shows it folded. The restore points, 3.5 rows high (a half
  row: there are more) with a scroll bar, all newest first by their times (presets included; owner,
  2026-11-10): **Editor opened** (the park's views when the editor
  first showed it this run), **Checkpoint n** (Save checkpoint; the 10 most recent per park in
  `RCTScreensaver.checkpoints`; each keeps the camera's position, angle and zoom and the selected view,
  restored with it, the map's camera only on the map), **Last install** (parks whose views came from the views file), **Generated** (the
  playlist's own views), each with its time (today: hh:mm; else the date; install and build times from the
  playlist, `installed` and `built`). Restore selected works on the highlighted row, as one undoable change.
  Fold marks (the box's header, Playlist, the park field) are icons, as the game's font has no triangles;
  the open park field and its list have a gold border, and held to jump, the park under the mouse is gold. On the map, the boxes clear while a park change is under way (the
  views are already the next park's) and come back once it shows; on another park the map steps out from the view shown, at its angle, and follows the viewport when a load turns it. Every Playlist button has a tooltip.
  **Copy views** (Ctrl+C) puts the park's views on the clipboard as the settings page's drawing page writes them
  (`{"format": "rct-screensaver-views", "version": 1, park, key, screen, views}`, `screen` the window), leaving out
  its event views, as those come from the park's own data; **Paste views** (Ctrl+V) replaces the park's views
  with the clipboard's (that text from here or the drawing page, or a bare view list): zooms move out by whole
  levels from the copy's window as edits do (`scale.ts`), event views in the text are left out, the park's own
  event views keep their places, and the views are hand-set (pinned at install). One change, so Undo returns.
  The button says what happened for a moment ("Copied 7", "Pasted 7", "No views" in amber). Both need the
  patched engine's clipboard (patch 0016; 2026-11-12). The drawing page's event settings in a copy are not
  applied in the game: they are profile settings.
  Under it the foldable **Playlist** properties (the playlist's name at the right): Motion (Inertia
  Off/On; Angle and zoom change Off/Start/End, where Off makes every pan that would turn or zoom a cut,
  overviews excepted, and hides the two holds that no longer apply), Timing (change, arrival and return
  holds, half-second steps) and Presentation (Title music Ride/Theme/Unset, Show titles Overview/On/Off/
  Unset; Unset leaves the viewer's own setting). Changes play at once (the music too); **Save** keeps them
  in the game (`RCTScreensaver.playlistProps`); Import and Export moved to the build pane (below).
- **Install** picks both up: `mksequence.py --install` writes the park order and the saved properties into
  the playlist file (`[views] inertia`, `pan_changes` (now also "off"), `change_hold`, `arrive_hold`,
  `return_hold` divided back by `time_scale`; top-level `title_music` and `titles`, removed for Unset; the
  `[[park]]` sections moved as text, comments kept; the old file as `<playlist>.toml.bak`) and drops them
  from the game's storage, as it does with view edits. The live editor on its own, without the generator,
  is a later stage (`docs/enhancements.md` section 2, item 6).
- In map mode the panes take the mouse: a press on them never reaches the boxes underneath.

### Builds from the game (engine patch 0017, 2026-11-11)

The next stage of "the live editor on its own" (`docs/enhancements.md` section 2, item 6): the game builds
the playlist itself and plays the new build without a restart, so installing no longer needs the game
closed.

- **The build pane** (bottom right, under the top-right box and above the mode's exit button; owner's draft 4,
  2026-11-11): a "Build · saves live edits to the playlist" header with where things stand at its right ("edits not built" in amber when the game saved edits after the
  build that plays or the install, "building 6/15", "built · playing", "failed"), folding to the header by
  hand and on its own when the window is too short for it under the box; then "Park n of m · name" with the
  time so far, a square per park, the big **Build and play** button (Cancel build while it runs; Ctrl+B,
  also with the editor closed; inactive, and Ctrl+B does nothing, while every edit is built: owner's test,
  2026-11-11), the MESSAGES list (3.5 rows, scrolls) and Import playlist / Export playlist (see "Import and
  Export" below; inactive on an engine without patch 0018). The playlist's Save button is gone: Playlist properties
  save as they change, as the views do. With the editor closed, the controls bar carries a "Building 6/15"
  chip while a build runs.
- **Squares:** one per park in play order, as the generator lists them (`parkStates`, the playlist file's
  order with the game's edits baked in), so a rebuild of one park keeps its square's place; between builds
  they follow the playing order, so reordering parks moves the squares at once. The generator lists every
  park first, and while a build runs a park not reached yet shows its state from the build before. Only a
  park edited since the last build (or the install) is dimmed, with "edited, needs a build" in its tooltip,
  and it dims as soon as the edit is saved; Playlist properties dim none, as no park needs building for
  them (owner's test, 2026-11-11). The plugin keeps the edits each build took in (`RCTScreensaver.builtEdits`;
  an install sets it to the edits it leaves in the storage). Names are the playing playlist's. Green with a check: built (or unchanged, from the cache); amber
  with "!": built with warnings; red with a cross: failed, or its file is missing (the park is left out and
  the rest builds); lit, with diagonal stripes crawling across it (20 px/s; owner, 2026-11-12): being
  built; empty: still to come. The tooltip names the park and its state; a
  click opens the park. Over 30 parks, a bar with "n / m parks" replaces them.
- **Messages:** newest first: the plugin's own line about the outcome (built and playing, not taken in, cancelled,
  could not start), then the generator's (`messages`: what it took in from the game's edits, each park's
  warnings, missing parks, the count built and unchanged), each marked info, ok, warning or error. A message about a park opens that park on a click.
- **Build and play** calls `screensaver.build(<sequence>)`. The engine runs the generator that `--install`
  registered in `<user dir>/screensaver/generator.json` (this Python, this `mksequence.py`, and the playlist
  file each installed sequence came from), `mksequence.py --live-build <sequence> --user-dir <user dir>`,
  in the background with no console window (below normal priority, output in `screensaver/build.log`).
  A plugin passes only the name: it cannot choose what runs, and its files API cannot write
  `generator.json` (it reaches only `screensaver/live`). One build at a time.
- The build is an ordinary build with the live file applied (`--cache` in `screensaver/park-cache`, so
  only changed parks are rebuilt), written to `screensaver/build/live/<sequence>`. It never touches the
  installed sequence or `plugin.store.json`, both the game's while it runs. Its progress (park n of m) and
  result go to `screensaver/live/build-<sequence>.json` (no `version` key, so the live-file tools skip it):
  the new playlist, the title music, `parkStates` and `messages`. A new plugin version or changed park
  scripts are not reported: neither can change mid-run, and the next install brings them (owner, 2026-11-11).
- **Taking it in:** once the build is done the plugin calls `screensaver.applyBuild(<sequence>)`: the
  engine copies the parks (only changed ones; written beside their place and renamed over) and the script
  into the playing sequence's folder, removes parks the new script no longer names, and reloads the
  script (`ITitleSequencePlayer::Reload`; the park on screen keeps playing). The plugin then stores the new
  playlist (`installed` now, so it is the editor's "Last install"), sets the title music as an install
  does, and re-enters the park on screen from the new script at its place in the new order (a dip through
  black, as a park change), or the first park when the build dropped it.
- The line over the squares shows only while a build runs (the park and time), after a failure ("Build
  failed: <reason>"; a missing `generator.json` means: install once with `mksequence.py --install`) or when
  builds are unavailable; otherwise the header's state and the messages say it all (owner's test,
  2026-11-11: the line repeated the header). With no line the squares grow into its space (owner, 2026-11-12).
- **Every build bakes:** before it builds, `--live-build` writes the live file into the playlist's own files
  (as `tools/bakelive.py` does: views into `<playlist>.views.json`, properties and park order into the TOML,
  backups beside them) and marks it baked, so the playlist files always hold what plays (owner, 2026-11-11:
  rebuild only changed parks, play at once, always bake; no settings in the pane).
- A build still running when the game quits finishes on its own and is not taken in.
- **Parks and the settings page** (owner, 2026-11-11): a park whose file is missing is left out of the build
  with a red square and a message; ticking parks on and off stayed a settings-page matter, with adding parks,
  until the park list took both (owner, 2026-11-12; "Parks and playlists" below).
  The game's park cache (`screensaver/park-cache`) stays apart from the settings page's, so the first build
  from the game redoes every park. The settings page judges its renders against whichever build is newer,
  its own or the game's (`build/live/<sequence>.result.json`), so a build from the game marks them old; the
  page's own builds and bundle imports clear `build/` but keep `build/live`.

### Import and Export (engine patch 0018, 2026-11-12)

The build pane's Import playlist and Export playlist move a playlist between machines as a bundle, the same
zip the settings page's Import and Export use (`tools/bundle.py`), without leaving the game.

- **The game picks the file.** `screensaver.exportPlaylist(sequence)` and `screensaver.importPlaylist()` show
  the system's own Save or Open dialog (OpenRCT2's `ShowFileDialog`: Windows' file dialog, zenity or kdialog on
  Linux) filtered to `*.zip`, starting in Documents and then in the folder last used. The game waits while it is
  open. A closed dialog returns false and starts nothing. A plugin passes no path, so it cannot choose a file to
  write or read.
- The engine then runs the registered generator, as for a build (one task at a time; Cancel and Ctrl+B
  stop it): `mksequence.py --live-export <sequence> --to <file>` or `--live-import <file>`, each with
  `--user-dir`. `buildStatus.task` says which runs.
- **Export** bakes the game's edits into the playlist files (as a build does), then writes the bundle with the
  park files of the ticked parks and the user's own profiles (`screensaver/parks`) of the playlist's parks
  (matched by the park cache's saved names, else by reading the park). Its result goes to
  `live/task-export.json` (`{taskVersion: 1, task, started, ok, finished, path, sequence, messages}`), whose
  messages the pane lists. Nothing plays differently afterwards.
- **Import** unpacks the bundle into the user folder (`screensaver/playlists/<slug>.toml`, parks under
  `screensaver/bundles/<slug>/`, profiles into `screensaver/parks`; a file replaced is backed up to
  `screensaver/backups`), looks for parks it does not carry in the settings page's park folder, registers the
  playlist in `generator.json` and builds it as a live build (`build-<sequence>.json`, the pane's squares).
  Its own result goes to `live/task-import.json` (with `sequence`, `playlist`, `missing`). A live file the game
  kept for an earlier playlist of the same name is marked baked, so it does not apply to the imported one.
- **Playing the import:** once its build is done the plugin calls `applyBuild(<sequence>)`. For a sequence
  that is not playing the engine copies the build into its installed folder, or a new one in the user's
  `sequence` folder, scans the sequences again and starts it. The plugin installs the new playlist in the
  storage, clears the old playlist's view edits and its built edits from the storage (its live file
  keeps them for its next build), and starts the player on the new sequence, opening the editor again. An
  import of the playlist that plays (same name) starts the player afresh too, so the bundle's park order and
  properties replace the ones in memory (owner's test, 2026-11-12: the order took effect only after a restart).
  The imported playlist plays on after a restart. Its parks' companion scripts are put in the user plugin
  folder with the build (replacing the old playlist's), but the game loads plugins only as it starts: for each
  script that is new or changed on disk, the build pane lists a warning per park that uses it, "<park>: park
  script <name> starts after a restart of the game", right under the "Imported" line, and flags that park's square
  amber, already while the build runs for a script not installed yet (owner, 2026-11-12). The messages read newest
  first: the plugin's line, the build's, then the import's own unpacking lines; a script already installed with the same code gives none.

### Parks and playlists (engine patch 0019, 2026-11-12)

The first stage of the Generator page's park and playlist functions in the editor (owner, 2026-11-12, thread
"Explore park selection and playlist creation in the live editor"); the park library with filters and pictures
is the second (`docs/roadmap.md`, live view editor). All of it sits in the views pane's park list, opened by a
click on the park field (Playlist order):

- **Use ticks.** A tick box per park after its grip. Ticked off, a park keeps its place but is passed over by
  Next park, Previous park and shuffle at once (shown "(left out)", its number and name dim); the last park in use
  can't be ticked off (the header says so for a moment). Ticks save at once (`RCTScreensaver.playlistProps.
  <sequence>.use`, park key → on/off, in the live file's `props`); a build bakes them into the playlist file
  (`[[park]] use = false`, removed when ticked on; comments kept). The build lists the parks it left out in the
  playlist (`unused`: key and name), shown under NOT IN THE BUILD with their ticks. Ticked on, a park moves up into the order (after the rest by default),
  marked "needs a build", and can be dragged to where it should play before the build (owner, 2026-11-12); its
  place is saved with the order (`order` names its key) and the build bakes it there.
- **Add park…** (the list's last row) calls `screensaver.addPark(<sequence>)`: the engine shows the system's Open
  dialog (`*.park;*.zip`, starting where the last park or bundle was picked) and runs `mksequence.py --live-add
  <sequence> --park <file>`. The generator bakes the game's edits, appends a `[[park]]` with the file relative to
  the playlist (absolute on another drive) and its builders from the NE catalogue or the file name, or ticks the
  park on again when the playlist has it unticked; a park already in use, a clash of file names, an RCT save or a
  file that is no park fails with the reason (saves and loose objects: the settings page's folder scan converts
  and installs them). Its result goes to `live/task-add.json`, then the playlist builds and plays as with Build
  and play.
- **Playlists** (the PLAYLIST field, a heading of its own over the park field, owner 2026-11-12: it names the
  playing playlist and its parks; a click opens its list from under it over the park row): every playlist the game can build, from
  `live/playlists.json`, which the generator writes whenever it registers one (`--install`, an import, a new
  playlist, a copy): name, file and parks in use, the playing one marked "playing", a missing file in red. A click
  on another builds it (`screensaver.build(<name>)`, only changed parks thanks to the park cache) and plays it as an
  import is played (`applyBuild` of a sequence that is not playing): its edits come from its live file, the
  playing playlist's edits leave the storage and stay in its own live file.
- **New playlist from a folder…** calls `screensaver.newPlaylist()`: the system's folder dialog, then
  `mksequence.py --live-new <folder>`, which reads the folder as the settings page's scan does (`parkinfo.
  scan_folder`; parks and downloads in place, RCT saves and loose objects listed as warnings), writes
  `screensaver/playlists/<slug>.toml` named "RCT Screensaver <folder>" (" 2" and so on when taken), registers it
  and lists it (`live/task-new.json`, with its parks: key and a name from the NE catalog or the file). No build
  follows (owner's tests, 2026-11-12/13): the park list opens on the new playlist's parks ("New playlist: its parks",
  PLAYLIST showing it "not built"), to tick off and drag into order (saved to its own live file), and **Build and play
  this playlist** builds it with them and plays it. Closed without building, it stays in the PLAYLIST list.
- **Duplicate this playlist…** calls `screensaver.copyPlaylist(<sequence>)`: the system's Save dialog in
  `screensaver/playlists` ("<name> copy.toml"), then `mksequence.py --live-copy <sequence> --to <file>`: the
  game's edits baked, the playlist copied with its views file, named after the file (another name than any other
  playlist's), park paths following the new folder; registered; no rebuild (owner's tests, 2026-11-12/13): the
  installed sequence is copied to `screensaver/build/live/<copy>` and the plugin has the engine apply it, so the copy
  plays at once with the playing playlist's edits and properties (without an installed folder, the copy is listed
  to pick, which builds it); `live/task-copy.json`. The game has no
  text input of its own, so the dialog's file name is the name.
- The build pane follows each as it follows a build: the header ("adding the park", "making the playlist",
  "copying the playlist", "building"), Cancel <task>, the squares and the messages; one task at a time.

### Live file (2026-11-10, owner's go-ahead in "Explore saving playlists without the Generator")

On the patched engine (patch 0016's files API), every save of the editor (view edits, a reset, the park
order, Playlist properties' Save) also writes the installed playlist's part of them to
`<user dir>/screensaver/live/<sequence>.json` (characters other than letters, digits, `.`, `_`, `-` as `_`):
`{version: 1, sequence, source, installed, saved, edits, props}`, `edits` in the storage's form for the
playlist's parks only, `props` the saved Playlist properties with `order`. `source` is the playlist file
`--install` recorded in the installed playlist (`Playlist.source`). The game is the file's only writer;
the stock engine writes none and the storage stays as it was, so everything above works unchanged.

- **Builds** (`mksequence.py`, the settings page) apply the live file over the playlist's files
  (`prepare`): properties and park order over the TOML, views over the views file (a reset or an edit
  that pins nothing drops a park's views), only for the playlist of that name whose file is `source`.
  `--ignore-live` leaves it out; `--ignore-edits` leaves out its views too.
- **Bake**: `python tools/bakelive.py [playlist ...]` (no argument: every live file whose `source` is
  known; `--list` only shows them; `--user-dir` for a game that keeps its files elsewhere) writes it into
  the files with the code `--install` uses (`merge_edits`, `write_props`) and records the bake in
  `live/baked/<sequence>.json` (the file's `saved` time), so builds skip it until the game saves again.
  The game can stay open: it keeps its storage, and its next save rewrites the whole file (baking again
  changes nothing already baked). The settings page shows waiting live edits above the park list with a
  "Bake into playlist" button, and a change of the live file marks the build out of date.
- **Install** takes the same edits from the storage and marks the live file baked.

### Live editing (first stage of the live editor, 2026-11-09)

The "Frame" stage of the live editor (`docs/enhancements.md` section 2): the mouse on the park, off the
panel and the bar, edits the selected view directly.

- **Drag** with the left button: the park follows the mouse (the camera moves on the plane at its
  height), and on release the selected view goes where the camera is, as one change (Set to camera).
  A plain click changes nothing; a drag that runs over the panel or the bar keeps going to the release.
  With no view selected, or while Play is on, a drag only moves the camera (and stops Play).
- **Wheel** over the park: the selected view zooms a level per step (up: in).
- **Height, set by itself** (owner's test, 2026-11-10: a Fit height button was "not clear what this does", as
  it changed nothing on screen): a view set from the camera (a drag, the wheel, Set to camera, Add view)
  sits at the height of what is seen at the screen's centre (the first tile top, ground or water met
  walking down the heights that point could show; over the void it keeps its height). The picture never
  moves for it; what it changes is the pivot of a turn: a pan's turn and the Rotate buttons (which anchor
  the camera the same way first) keep what is at the centre in the centre. The anchor is found once and
  kept until the camera moves, so turning again and again pivots on the same point (each angle sees another
  surface at the centre, and anchoring after every turn drifted the camera a little per turn; owner's test
  2026-11-10).
- **Set to camera** keeps the view's pan, turn, inertia and event settings (it used to drop them); a framed
  overview loses its `overview` flag, so it plays as framed.
- **Undo and redo** (the panel's Undo and Redo, Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z): every change to a park's
  views, per park, 100 deep, kept while the plugin runs. Undoing the first edit goes back to the
  playlist's views (as Use playlist views does, which itself can be undone).
- The arrow keys, Rotate and Zoom buttons still move only the camera (then Add view or Set to camera).
- With the settings panel open, a click on the park closes it, as before.

### The map (stages 2-4 of the live editor, 2026-11-10; `plugin/src/ui/view-map.ts`)

M (or the panel's **Map** button) steps the camera two levels out from the selected view and draws every
view of the park on the overlay; M again, or a double click on a box, frames the selected view again.
Play closes the map (it moves the camera through the views).

- **Boxes:** a view at the camera's angle is the box its window covers at its zoom (in the current
  window, as it plays), with its number at the top left; a view at another angle is a numbered marker at
  its spot. Colours as on the drawing page: generated views lilac, hand-set blue, event views amber, the
  selected one orange and thicker.
- **Pan lines:** from each view to the next and from the last back to the first, dotted on the overlay
  (it draws no lines): dense yellow dots for a pan, sparse cyan ones for a cut, clipped to the window.
- **Mouse:** a drag on a box moves its view on the plane at its height (saved on release, the camera
  stays); a box wider or taller than half the window (an overview) is held by a 24 px band along its edge,
  so a press inside it pans. The selected box's corner handle changes its zoom by whole levels (the box
  snaps). A drag on empty park pans, the wheel zooms the camera, a right click on empty park adds a view
  there (after the selected one, at its zoom, at the camera's angle, at the height of what is under the
  cursor), a right click on a box selects it. Clicking a row in the list centres the map on that view
  (turning to its angle).
- **Panel buttons on the map:** Add view adds at the screen's centre, Set to camera moves the selected
  view there (keeping its zoom); Rotate and Zoom move the camera.
- **Event views** (a cue, an animation or a show) are labeled "event" and locked: a click selects them, a
  drag pans. The panel's **Event views: locked/unlocked** button lets them be dragged.
- Every map change goes through the same edits and undo as the rest of the editor.

Left for later: the overlay redraws the whole window while boxes move (the engine unites changes into one
dirty rect); a perf-log run while panning on the map decides whether an engine `line` element or
per-element dirty rects are worth a patch.
- **At the map's edge** the engine stops the view at its scroll limit; the camera follows where the view
  really is, so dragging on past the limit no longer slides the boxes off their spots (found in the
  perf run, 2026-11-10).

## Widget kit (`plugin/src/ui/kit.ts`)

- `Layer`: a group of overlay elements under one id prefix. It sends only new or changed elements,
  and shows and hides as one with the engine's fades (`overlay.fade`), so a fade costs the plugin no
  work per frame.
- `button`, `backing`, `bevel`, `label` and `tooltip` add elements to a scene, and `contains` hit-tests rectangles.
- Icons: the overlay scales images nearest-neighbor, so `tools/mkicons.py` draws each icon at
  every output size the plugin may ask for (16 and 22 game pixels × scale factors 1-4). The plugin
  draws the nearest size at its own resolution. `mksequence.py --install` copies them to the user
  `plugin/rct-screensaver/icons/`.

## Load cover: a dip through black (owner, 2026-11-02)

On the patched engine, parks load in the background and switch in about 20 ms, so there is no freeze to
hide. The plugin used to cut straight to the next park, and it was not told when the switch happened.
The owner chose a dip to black. Engine patch 0010 (`TitleSequence.nextParkReady`, `holdSwitch`) lets
the player hold the switch:

1. On a park change, the player sets `holdSwitch` and seeks. The current park keeps playing, with its
   sounds fading out as before, while the next one is read.
2. Once `nextParkReady`, the overlay's black cover (`cover.ts`, real alpha, faded by the engine) fades in
   over `fadeMs` (600 ms).
3. Once it is black, the player clears `holdSwitch`, and the park switches on the next tick.
4. The cover fades out as the new park's first view shows.

The controls bar stays above the cover. On an engine without patch 0010, the mode cuts as before, and
the stock engine keeps its dithered window.
