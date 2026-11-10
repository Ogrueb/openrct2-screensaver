# RCT Screensaver

A live-rendered, wallpaper-style backdrop built on [OpenRCT2](https://github.com/OpenRCT2/OpenRCT2)'s
title screen: it plays a list of parks, moving the camera between views of each one, with a
minimal interface for holding a view, stepping between views and parks, speed, shuffle, park name
captions and a few display settings.

Three parts, all in this repository, none of them a fork of OpenRCT2:

- **Engine patches** (`engine/`): a small series against the OpenRCT2 v0.5.6 release that adds a
  screensaver mode to the title screen (borderless window, the stock menus hidden, an overlay for
  the interface, a `--screensaver` launch flag), loads the next park in the background so switches
  cost about a frame, plays the parks' ride music, and keeps the interface readable in parks with
  a custom palette. GitHub Actions builds them into a replacement `openrct2.exe`.
- **The plugin** (`plugin/`): an OpenRCT2 plugin that plays the playlist, drives the camera,
  draws the controls bar, captions, settings panel and view editor, and runs the parks' own
  companion plugins.
- **The generator** (`tools/`, Python): picks the views for each park (an overview, then close-ups
  of its busiest spots, towers and rides, joined by pans), builds the title sequence and installs
  it, with a settings page in the browser and a tool for drawing views by hand.

Running it requires OpenRCT2 v0.5.6 and the original RollerCoaster Tycoon 2 (or RCT Classic)
game files, which are not included; neither are any parks (see `ExampleParks/README.md`).

## Support

| | |
|---|---|
| Operating system | Windows 10/11 (x64), and Linux x64 (tested on Fedora under Wayland, 2026-11-05; X11 untested). The mode's captions use the Segoe UI and Georgia system fonts on Windows and fall back to DejaVu, Liberation or Noto Sans on Linux. `Settings.cmd` and `.sv6` conversion use `openrct2.com` on Windows; `settings.sh` starts the settings page on Linux and macOS. On macOS only the Python tools run (no engine build). |
| OpenRCT2 | v0.5.6 (`engine/VERSION`), the portable or installed release, with the two patched executables in place of the stock ones. On an unpatched v0.5.6 the plugin falls back to playing on the stock title screen, without the screensaver mode (below). |
| Python | 3.11 or later, on PATH (`pythonw` for `Settings.cmd`). No third-party packages. |
| Node | Only to rebuild the plugin (22 or later); the built plugin is committed. |

## Installing

1. **Patched engine.** Download the engine build (`openrct2.exe` and `openrct2.com`) from the
   project's releases, or build it yourself with the "Engine build" workflow (`engine/README.md`).
   Keep a copy of the stock pair, then replace both files in your OpenRCT2 v0.5.6 install. The
   data files are unchanged by the patches, and nothing else in the install is touched.
2. **Parks.** Put park downloads (zips as published on New Element Designs, loose `.park` files,
   or RCT2 `.sv6` saves) in a folder. The ten example parks that the shipped playlists use are
   listed with their download pages in `ExampleParks/README.md`.
3. **Settings page.** Run `Settings.cmd` on Windows or `./settings.sh` on Linux and macOS (or
   `python tools/settings.py` anywhere). It opens the generator's
   page in your browser: point Source parks at your folder and Scan, set the options you want,
   Build, then Install (OpenRCT2 must be closed). The page writes everything under
   `Documents\OpenRCT2\screensaver\`; Install puts the title sequence in
   `Documents\OpenRCT2\sequence\`, the plugin in `Documents\OpenRCT2\plugin\` (with its icons under
   `plugin\rct-screensaver\icons\` and one `rct-screensaver-companion-*.js` per park script), and
   the playlist and settings in `plugin.store.json` (other plugins' data is left alone; a `.bak`
   copy is kept).

   The command-line equivalent, for a playlist written by hand, is

   ```sh
   python tools/mksequence.py playlists/example.toml --install
   ```

   Pass `--user-dir` if your OpenRCT2 user folder is not `Documents\OpenRCT2`.
4. **Run it.** Start OpenRCT2 and click the Screensaver button on the main menu (the fifth button,
   a monitor with a park), or start `openrct2.exe --screensaver` to go straight into the mode. Esc
   returns to the menu, or quits when the game was started with the flag.

Upgrading: replace the two executables again and run Install again (the plugin, its icons and the
companion scripts are replaced; views you set in the editor are kept, see "Setting views by hand").

### Linux

The patched engine for Linux (beta) is a whole build, not two replaced files: download
`openrct2-v0.5.6-openrct2-screensaver-linux-x64-beta.AppImage` from the project's releases (or the
`linux-x64-appimage` zip from the "Engine build" workflow, unzipped first). The AppImage carries its
own libraries, so it runs on any current distribution; unpack it rather than mounting it (no FUSE
needed, and the tools get a plain executable):

```sh
mkdir -p ~/openrct2-ss && cd ~/openrct2-ss
cp ~/Downloads/openrct2-v0.5.6-openrct2-screensaver-linux-x64-beta.AppImage .
chmod +x openrct2-*.AppImage && ./openrct2-*.AppImage --appimage-extract
~/openrct2-ss/squashfs-root/AppRun        # the game; asks for the RCT2 folder on its first start
```

Give it the folder holding RCT2's `Data`, `ObjData` and `Tracks` (copied from a Windows install
or GOG). The user folder is `~/.config/OpenRCT2` (Install writes there; the page's own files go to
`~/.config/OpenRCT2/screensaver/`), and the settings page wants `squashfs-root/AppRun` as its
OpenRCT2 path. `python3-tkinter` (or your distribution's Tk package) gives the page its file
dialogs. Run it with `squashfs-root/AppRun --screensaver` for the mode straight away. The
`linux-x64` tarball from the same workflow is built on Ubuntu 24.04 and needs that release's
libraries (ICU 74, libzip 4); prefer the AppImage elsewhere. OpenRCT2's "Minimise fullscreen on
focus loss" (Options, Display) makes a borderless window minimize when another window takes the
focus; turn it off to keep the mode in the background.

### The stock engine

On an unpatched OpenRCT2 the plugin still works, as it did before the screensaver mode: it plays
the installed playlist on the title screen as soon as the game starts, with the same keys, cuts
between parks (the screen freezes while a park loads), opens its view editor as a
window (E, or the toolbox menu's "RCT Screensaver: edit views"), and has "restart playlist" and
"toggle debug log" in the toolbox menu. There are no captions, no controls bar and no settings
panel, and selecting the sequence under Options → Miscellaneous → Title sequence avoids loading
OpenRCT2's default sequence first. A park that recolors the palette's black through its water
object (Gardens of Light) washes out the stock interface there; the patched engine keeps the
interface black on its own (see "Palette" below).

## Running it

The screensaver mode shows only the park. Moving the mouse shows the cursor and the controls bar
at the bottom (and the stock exit button bottom right, which does what Esc does); both hide again
2.5 s after the mouse stops.

| Key | Bar | Action |
|---|---|---|
| Right / Left | ⏭ ⏮ | Next / previous view (continues into the next / previous park) |
| Shift+Right / Shift+Left | ⏭ ⏮ (outer) | Next / previous park |
| Space | Hold | Hold / release the current view (pauses a pan where it is) |
| Up / Down | Speed | Speed 1×–8×; wraps on the bar (right click or wheel to slow down); kept across parks and restarts |
| S | Shuffle | Shuffle parks on / off (the next park at random, each once per round; views keep their order) |
| | Titles | Park name captions on the overview only, on every view, or off |
| | Music | The parks' ride music on / off (ride music follows the view and cross-fades between parks) |
| | Time of day | Day (the stock title screen), full night, or the day/night cycle as in play |
| E | Edit views | The view editor (below) |
| | Settings | Window style, renderer, multithreading, changing weather, weather effects, light effects, volumes, caption placement, and the Title frame (gold, silver and wood portrait frames, Minimal dark and light, Aero, Canvas, each with an accent color) |
| Esc | Exit | Back to the main menu, or quit after `--screensaver` |

Everything the mode changes (window style, music, effects, volumes, speed, captions) is applied in
memory and stored in the plugin's settings (`RCTScreensaver.settings` in `plugin.store.json`); the
game's own `config.ini` is never edited, and the stock title screen comes back exactly as it was.
Keys can be rebound in OpenRCT2's shortcut settings.

Park changes dip through black (the next park is already loaded in the background; set
`"fadeMs": 0` in the settings to cut instead). Captions fade in with each park: the park's name and
its builders, from the playlist (`name`, `author`), the park's profile or the New Element Designs
catalog.

### Wallpaper and screensaver hosting

The mode is a normal borderless window; the project does not put it behind the desktop icons or
run as a Windows `.scr` itself. Tools such as Lively Wallpaper or Wallpaper Engine can run any
program as a wallpaper: give them `openrct2.exe --screensaver` (with `--user-data-path <folder>`
if you also play OpenRCT2 normally at the same time, as both instances would otherwise share
`plugin.store.json`). A window behind the desktop icons gets no keyboard or mouse input, so the
keys and the bar work only when the game window itself has the focus. Multiple monitors are out
of scope. On Linux, start `AppRun --screensaver` from an autostart entry
(`~/.config/autostart/*.desktop`, `Exec=` that command) to bring the mode up at login; screensaver
daemons such as XScreenSaver hand their programs a window to draw in, which the mode does not take.

## Playlists and views

A playlist is a TOML file naming the parks to play and the options for generating their views.
`playlists/example.toml` is commented, and the settings page writes one for you;
`tools/mksequence.py` builds a title sequence from it. The defaults suit most parks.

### The playlist file

- **Top level:** `name` (the title sequence's name), `order` (`"playlist"` or `"shuffle"`, shuffled
  once at build time), `layout` (`"plugin"`, or `"stock"` to play without the plugin),
  `park_scripts` (run the parks' bundled plugins), `park_plugins` (add each park's extras from its
  profile) and `title_music` (`"ride"` plays the parks' own ride music instead of a title theme).
- **`[views]`:** the generation and panning options described below and in
  `docs/view-generation.md`. A park's `[park.views]` table, its profile in `parks/`, or a listed
  view can override any of them.
- **`[[park]]` entries:** `file` (a `.park`, a zip or a folder; `member` picks a park inside a zip),
  `name` and `author` for the captions (filled from the New Element Designs catalog when left out),
  `use = false` to skip a park, and the park's own options: a `view` list to play fixed views,
  `companions`, `animations`, `show` (see "Parks' own plugins").

### Panning

- **Pan share.** Each view is held still, then the camera cuts to the next, unless the view has a
  `pan` share: then it spends that share of its hold (at the end) panning slowly to the next view,
  arriving as that view's hold starts (`pan = 0`, the default, holds still and cuts; `1` keeps
  moving). `motion = "static"` holds every view still, with no ride pans, beads or nudges.
- **Angle and zoom changes** happen only as a pan arrives (`pan_changes = "end"`, the default) or
  as it sets off (`"start"`), never mid-pan (`"off"`: a pan that would turn or zoom cuts instead,
  overviews excepted); opposite angles and zooms two or more levels apart
  change half at each end. The camera rests `arrive_hold` (1 s) at the next view's spot before a
  change on arrival and stays still `change_hold` (2 s) after each change, both added to the
  view's time. `inertia = true` makes a pan start and stop slowly instead of moving at one speed.
- **Speed.** A pan faster than the speed tolerance at the zoom it runs at (`pan_tolerance`, 500
  screen pixels a second at zoom -2, `pan_tolerance_step` 100 less per level out) travels a zoom
  level out (between views at different zooms, at most at the wider one), and the build gives a
  generated pan still over it more time, in 100 ms steps, until it is not. The build reports pans
  over the tolerance.
- **The overview** always pans 10% of its hold to the first close-up, changing angle and zoom on
  arrival (`overview_pan`).
- **The return.** A park's last view pans back to its first (`return_pan`), zooming out as it
  goes when the first view is wider; a park playing alone (a one-park playlist, or the editor's
  Play) carries on from there, and otherwise the camera holds at the first view for
  `return_hold` (2 s) before the next park.
- **Cuts.** Key presses and the editor cut.

Pan options can be set in `[views]`, on a park's views or on a listed view, in the view editor,
or in the browser tool. `playlists/pan-compare.toml` plays four of the example parks with every
close-up panning 60% of its hold, and `playlists/speed-ladder.toml` pans one length at each zoom
and speed, for judging pan speed. Design notes: `docs/view-panning.md`.

### Window size

Views and pan speeds were judged in one game window, `[views] window` (1920x1080 game pixels: a
4K monitor at OpenRCT2's scale factor 2.0), which the playlist carries. OpenRCT2's zoom levels are
fixed scales, so in a smaller window the same zoom shows less of the park. The plugin moves views
out by whole zoom levels until the window shows at least the frame they were set for, both its
width and its height (one level at 960x540 or 960x600, that is 1080p or 1200p at scale 2.0), and
holds pans to a speed tolerance that shrinks with the window. The scale factor needs no setting of
its own: the plugin sees the window in game pixels, which already count it. Views set in the
editor or the browser tool keep the window they were set in and are scaled the same way. The
plugin setting `scaleToWindow = false` plays every zoom as set.

### Generated views

Generated views (method `spots`, the default) are made in stages, each with its own `[views]`
options; `docs/view-generation.md` describes every stage and option:

1. An **overview** of the whole park, zoomed by the plugin to fit the window.
2. A **view budget** that grows with the park's built area: 4 to 8 views.
3. **Close-ups** of the busiest spots, scored by rides and paths over static scenery, by how
   much of the spot is visible from each angle, and by how much of the frame shows the park
   rather than the void or a cliff wall.
4. **Districts**: the close-ups grouped by the park's layout, each district with a home angle
   and zoom, and the views ordered into the cheapest circuit through them.
5. **Tower views** for tall structures no close-up shows whole.
6. **Nudges and beads**: close-ups shifted so the pans between them sweep content, and a
   pass-through view on any long pan.
7. A **ride pan** along the longest straight run of a moving ride's track.
8. **Timing**: 30 s per park for up to 4 views, 5 s per further view, plus the moving time of
   the pans, capped at `park_cap` (150 s); `park_min` stretches short parks and `time_scale`
   slows or speeds everything.
9. Optional **variants** of the circuit, played in turn on each visit.

Every build writes `<sequence>.scores.json` with why each view was picked, and the build warns
about listed or editor views that look outside a park's content.

### Palette

Some parks recolor palette entry 10 through their water object (Gardens of Light's pale sky).
Stock OpenRCT2 uses that entry both for the space outside the map and for the interface's black,
so the menus wash out there. The patched engine (`engine/`, patch 0001) keeps the interface's
black separate from the void color, so the park's own backdrop shows and the interface stays
readable; the generator leaves the park's palette alone.

### Fitting

The plugin keeps views on each park's content for the current window size and zoom: a view
that would show empty space past the park is moved inwards, and views that end up on the same
spot are merged. When that leaves fewer views than `count`, a park that fits on one screen gets
a view from each angle centered on what is built (measured from the loaded park), and a park taller than the screen gets views spread from its
base to its top, turning the angle each time. Set
`fit = false` in a playlist's `[views]` (or a park's) to show views exactly as listed.

### Parks' own plugins

Some parks ship a plugin in their zip (Animator on Sambhava's Rest, Object Animator on
Constellations). `--install` turns each one into a title-screen plugin,
`plugin/rct-screensaver-companion-<name>.js` in OpenRCT2's user directory, that runs only while
its park is showing and replaces the ones from the previous install. Its windows stay hidden and
the camera stays the screensaver's. Many parks hold data for a plugin they don't ship (most often
AdvancedTrack, which authors expect installed): a park gets the newest version of such a plugin
that any park in the same playlist ships. Details: `docs/companion-plugins.md`.

Per park:

- `companions = []` turns them off; `companions = ["file.js"]` picks files (in the zip or next to
  the playlist); `companion_camera = true` lets them move the camera. `companion_debug = true` at
  the top of the playlist logs what they were stopped from doing.
- `animations = true` adds a view on each of the companions' animations after the park's other
  views (`animation_hold` seconds each, default `hold`; at most `animation_views`, 4, per park).
  Animator's, AdvancedTrack's lifts, AnimationService's and RCTAnimator's are read from the park's
  own data, Object Animator's from a table in `tools/companions.py`.
- `show = "eclipse"` (Constellations), `"travel"` (Bene Volantes) or `"invasion"` (Yucca Desert
  Park) ends the park's visit with the companion's scripted show: a view on it, held until the
  show is over (at most `show_hold`; 120 s, 240 s for the invasion).
- A view in a park's `view` list can be flagged by hand with `animation = "<name>"` or
  `show = "<name>"`. Flagged views are played as placed, not moved or merged by fitting, and add
  their own time to the park's.

## Settings page

```
python tools/settings.py [playlist] [--openrct2 "<OpenRCT2 folder>/openrct2.com"]
```

opens the generator's settings in the browser (a local server on 127.0.0.1:8766; `--port`,
`--no-browser`). Pick a folder of park downloads and Scan to start a playlist, or open one from
`playlists/`; set the views, timing and enhancements, order and pick parks on the Parks screen,
then Build, and Render, Install or Export a bundle (Import opens one). Per-park adjustments and the two editors write
the park's profile (`parks/<slug>.toml`), so they apply in every playlist that plays the park.
The page writes without asking (comments kept where it edits a file in place) and keeps the last
100 copies of each file it overwrote in the user folder's `backups/` (`Documents\OpenRCT2\screensaver\`
on Windows). What each control sets:
`docs/settings-ui.md`.

## Importing park downloads

`tools/importparks.py` turns a folder of park downloads (as zipped by New Element Designs and
others) into a park library and a playlist for it:

```sh
python tools/importparks.py "<downloads folder>" -o "<library folder>" --openrct2 "<OpenRCT2 folder>/openrct2.com" --skip-known ExampleParks
python tools/mksequence.py "<library folder>/RCT_Screensaver_Imported.toml" --install
```

Per download it picks one park (the most recently saved version, then the largest), installs
loose object files that ship beside it (`.parkobj`, `.DAT`; some parks don't open without them)
into `Documents\OpenRCT2\object\rct-screensaver\` (once per object, and not when an object with the
same identifier is already installed, which OpenRCT2 would report as a conflict), converts RCT2 saves (`.sv6`) with
`openrct2 convert`, and stores the park gzip-compressed (OpenRCT2 v0.5.x saves with zstd, which
Python reads natively only from 3.14; `tools/unzstd.py` decodes it in plain Python, a few seconds
per park). Parks' plugins are copied beside them for the companion host. Names follow the rule
above, and a saved name two imported parks share counts as a working title too. The playlist
notes each park's source, other versions, installed objects and warnings (objects a park uses
but neither packs nor ships); it is rewritten by each import, so copy it before editing. Parks
already in the library are reused unless their download changed (`--force` redoes them).

Parks larger than 256 tiles across play like any other: OpenRCT2 handles maps up to 1001 tiles,
and the plugin moves the camera itself. Only the title script's own `LOCATION` command stops at
tile 255, so the plugin layout leaves it out there.

## Setting views by hand

Press E in the screensaver mode (or the bar's Edit views button; on the stock engine, E on the title
screen or toolbox menu → "RCT Screensaver: edit views") to open the view editor. Playback pauses while it is open, unless you press "Play": then the park's views play
with their pans, looping in that park (it never moves on to the next park), and each change you
make plays on again from the selected view a second later (a further change restarts the wait).
Moving the camera by hand turns Play off. Pick a park from the list at the top to load it; the
list below shows its views, and clicking one moves the camera there. The arrow keys pan the
camera (Shift pans faster), and the buttons rotate and zoom it. "Add view" adds the camera as a
new view after the selected one, "Set to camera" replaces the selected view, and the spinner
changes how long the selected view is held. "Pan" sets how much of the hold the view spends panning
to the next view, "Turn" whether angle and zoom change as the pan starts or ends, and "Inertia"
whether it starts and stops slowly (turn on Play to watch).
"Use playlist views" drops your changes for that park.
The "Set by" column marks the views you placed ("you") apart from those carried over from the
generated ones ("auto"). Zoom in goes two levels closer than OpenRCT2's usual limit.

The first change to a park starts from the views it was playing. From then on the park plays
your views exactly as set: they are not moved or merged by fitting. Selecting views saves
nothing. At install, a park's views are kept only if you placed one of them or rearranged the
list (moved, deleted, or changed a hold); otherwise they are generated afresh.
`--ignore-edits` builds from the playlist alone (edits are still moved into the views file). Changes are saved as you
make them (in `plugin.store.json`) and play straight away. The next
`tools/mksequence.py --install` moves them into a file next to the playlist
(`playlists/example.views.json`), so they survive rebuilds and can be kept with the playlist.
"Use playlist views" still works for those parks: the next install drops them from that file
and keeps them in `playlists/example.views.bak.json`.

On the patched engine, the screensaver mode's editor also writes its edits (views, Playlist
properties, park order) to a live file, `screensaver/live/<playlist name>.json` in OpenRCT2's user
folder. Every build applies it, so a rebuild never loses edits made in the game, and
`python tools/bakelive.py` writes it into the playlist files (views into the views file, properties
and park order into the TOML, comments kept) without closing the game. The settings page offers the
same as "Bake into playlist". `--ignore-live` builds without it.

### Drawing views in the browser

A quicker way to set many views: draw them as boxes on pictures of each park. The settings page
opens this as its view-drawing page (Edit views in the park list or on the renders page), on its last
build; the command below runs it on its own.

```sh
python tools/drawviews.py playlists/example.toml --openrct2 "<OpenRCT2 folder>/openrct2.com"
```

This builds the playlist, has OpenRCT2 render every park from all four angles (in the background,
a few seconds each, cached in `build/drawviews/renders`), and opens a page in the browser.
OpenRCT2 itself does not need to be running. Each box is exactly what the screen will show: drag
on the picture to draw one, and its size snaps to the nearest zoom level with the screen's shape.
Drag a box by its edge or label to move it; `+`/`-` (or Shift+wheel) zoom it, Delete removes it,
`[`/`]` (or `,`/`.`) reorder. Hold times are shared out automatically as views are added or
removed (the playlist's `park_time` for up to `base_views` views, plus `view_time` per further
view, with the overview `overview_lead` seconds longer than the longest close-up), except holds
you type in the list, which stay as set (🔒 releases one). `O` marks the selected view as the
park's overview. `Q`/`E` turn the
picture to another angle, looking at the same spot at the same zoom (with Shift they turn the
selected view). Ctrl+Z undoes. "Generated"
shows the playlist's own views as dashed boxes for reference.

Changes are saved as you make them into the same `playlists/example.views.json` the editor's views
go to, and a park you change there plays exactly as drawn after the next `mksequence.py --install`
("Use playlist views", or deleting all of a park's views, drops them again). Boxes are drawn for the screen size in OpenRCT2's
`config.ini` (window or fullscreen size, over the UI scale); pass `--screen 2560x1440` to choose
another. Changes made in the in-game editor for the same park replace the drawn ones at the next
install, so use one or the other per park.

Playlist parks can also set `name =` (shown name, when the park file carries another) and
`author =` (a credit, kept as data for now). Without `name`, a park saved under a working title
("Six Frags Workbench 2023", a blank name, color codes only) is named after a logo or icon image
in its zip, else after the zip's file name. A zip with several parks plays the most recently
saved one (then the largest) unless `member =` picks one; `__MACOSX` and `._*` files are ignored.

The plugin setting `debug` logs its state to the console every second (`openrct2.com` shows it); the
stock engine's toolbox menu toggles it.

`--layout stock` builds a sequence that plays every view without the plugin (views jump,
coordinates must be within tile 255, views are not fitted, playback always loops).

## Performance

Measured on the owner's PC (AMD laptop, integrated Radeon, 4K monitor) with the scripted suites in
`perf/` (`tools/perfrun.py`, `tools/perfreport.py`, PresentMon alongside; method in
`docs/performance-testing.md`; the reports are kept in the project files, not the repository). The mode draws at 40 fps (25 ms a frame).
What the numbers say:

- **Window size is the one thing that limits frame rate.** OpenRCT2 draws at window ÷ scale factor,
  so a 4K monitor at scale 2.0 draws 1080p game pixels: 38.8 fps with no missed frames on the example
  parks, every feature on. A 4K window at scale 1.0 draws four times the pixels and runs at 18-23 fps
  on either renderer. Keep scale 2.0 on 4K.
- **Software renderer with multithreading is the right default.** At 1920x1200 the software and OpenGL
  renderers both sit at the 40 fps cap; OpenGL is only faster at full 4K. Software is also what the
  palette patch and light effects need. Multithreading doubles the software renderer's frame rate and
  must stay on.
- **Simulation size is the other cost: 1-2 ms per 1,000 entities per tick.** A park with 20,000
  entities still plays normally; one with 29,000 vehicles (Ol' Smokey's Showboat) ticks at 35-47 ms and
  plays in slow motion on any renderer and window. Such parks are the park's problem, not the
  screensaver's; a build-time warning is planned. Game speed above 2x multiplies that cost.
- **Pans, the plugin, companions, ride music, sound and background loading cost nothing worth
  turning off.** Pans run at the cap at 1080p and are smoother than the frames around a cut.
  Background loading cuts a park switch from 240 ms to 25 ms of main-thread time; the rest is masked
  by the dip through black.
- **Vsync and the present path need no work.** On OpenGL the "present" time is the main thread
  blocked for the GPU's frame (it tracks PresentMon's GPU busy within 1-2 ms), not a vsync wait
  (`Present` returns in 0.3 ms, Independent Flip). It only matters at full 4K.
- **Memory does not leak in an hour**, settling at about 1 MB per park switch once parks repeat. The
  first visit to a park costs 25-65 MB on OpenGL and 1-15 MB on software, so a very large library
  favors the software renderer on a long run. QuickJS, handles and GDI objects stay flat.

## Developing

### Layout

| Path | Contents |
|---|---|
| `ExampleParks/` | Where the example parks go (`README.md` there lists their downloads) |
| `playlists/` | Playlist files (TOML); `parks/` holds per-park profiles (`tools/profiles.py`) |
| `plugin/` | OpenRCT2 plugin (TypeScript) that plays an installed playlist on the title screen |
| `tools/mksequence.py` | Builds a title sequence from a playlist and installs it |
| `tools/bundle.py` | Packs a playlist (optionally with its parks and build) into a bundle for another computer, and unpacks one |
| `tools/parkinfo.py` | Inspects `.park` files without the game (map size, objects, plugins, …) |
| `tools/importparks.py` | Imports park downloads (zips, `.sv6` saves) into a park library with a playlist |
| `tools/nedesigns.py` | Park names and builders from the New Element Designs catalog (`tools/data/nedesigns.json`), matched to downloads by name |
| `tools/unzstd.py` | Reads the zstd compression of parks saved by OpenRCT2 v0.5.x, in plain Python |
| `tools/settings.py` | The generator's settings page in the browser: edits a playlist and the park profiles, builds, installs and renders |
| `tools/tomlwrite.py` | Writes TOML (playlists, profiles) for the settings page |
| `tools/drawviews.py` | Draw views by hand in the browser, on renders of each park from all four angles |
| `tools/renderviews.py` | Renders every view of a built playlist to PNG (OpenRCT2 headless screenshots) with a contact sheet |
| `tools/ridesurvey.py` | Surveys a park library for rides the generator can pan along, with each park's size, to pick test parks |
| `tools/cameralog.py` | Per-view camera timings (stills, pans, speeds, the pauses around angle/zoom changes) from a game log written after `mksequence.py --install --camera-log` |
| `engine/` | The engine patches, their README and the version they apply to |
| `perf/`, `tools/perfrun.py`, `tools/perfreport.py` | Performance test suites and tools (`docs/performance-testing.md`) |
| `docs/` | Notes, analysis, planned work (`roadmap.md`) and the local test checklist |

### Building the plugin

The built plugin is committed, so installing needs only Python. To change it (Node 22+):

```sh
cd plugin
npm ci
npm run build   # type-check against OpenRCT2's API, then bundle to dist/rct-screensaver.js
npm test        # unit tests, then the mock title screen (skipped unless playlists/example.toml is built)
node test/companion-mock.mjs <companion.js> <park name> <w> <h> [storage.json] [--show <name>]  # check a companion plugin
```

### Engine patches

`engine/README.md` lists the series and how to work on it; `docs/engine-patches.md` holds the
design and measurements. The "Engine build" workflow builds Windows x64 executables on every push to
`main` that touches `engine/`, and by hand for any branch ("Release build" leaves out the
diagnostics patch).

### Tests

`python -m unittest discover -s tools/tests` (Python, no game needed) and `npm test` in `plugin/`.
`docs/testing.md` is the checklist for runs in the real game.

## License

GPLv3 (`LICENSE`). The engine patches are derived from OpenRCT2, which is GPLv3, and the repository
includes OpenRCT2's plugin API declarations (`plugin/types/openrct2.d.ts`). Park files and their
builders' scripts are not part of the repository; `tools/data/nedesigns.json` holds park names,
release dates and builder names from the New Element Designs catalog (crawled from the site's
public API, 2026-10-30).

The caption frame's marble mat (`plugin/icons/marble-*.png`, made by `tools/mkframe.py`) is a
transformative crop of a marble texture photo by Hosking Industries, blurred, tinted and
lightened; the original is credited to them.
