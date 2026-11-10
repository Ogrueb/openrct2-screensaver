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
