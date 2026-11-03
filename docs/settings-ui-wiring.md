# Generator settings UI: wiring (built 2026-10-31)

How the settings UI (mockup "Screensaver generator settings") drives the tools. The control →
key mapping is in `docs/settings-ui.md`; every control there has a key.

## Shape

`tools/settings.py` is a local server, stdlib only, built the same way as `tools/drawviews.py`:
`http.server` on 127.0.0.1, it opens the browser, and the page lives next to it as
`tools/settings.html`. The page ports the mockup's five screens (main, Parks, Edit parameters,
Edit plugin-driven views, plus the tooltips as `title` text) to plain HTML and JS, with the same
look. The Design canvas stays the mockup and is never shipped.

The page holds no state of its own. The server reads and writes three things:

- **the playlist TOML**: main-screen settings in `[views]` and the top-level keys, plus the park
  list and its order as `[[park]]` entries;
- **park profiles** (`parks/<slug>.toml`): the per-park adjustments, the parameter editor and the
  plugin-driven views editor. The roadmap calls the adjustments the profile editor, so they apply
  in every playlist that plays the park (an accepted limitation, listed in the roadmap);
- **the tool's own settings** in the user folder's `settings.json`: the OpenRCT2 path for renders
  and `.sv6` conversion, the last playlist, the library folder and the server's token.

## The user folder (owner, 2026-10-31)

Everything the page writes goes to `Documents\OpenRCT2\screensaver\` (`tools/userdata.py`; beside the
`sequence`, `plugin` and `object` folders the tools install into; `RCT_SCREENSAVER_HOME` moves it):
`playlists/`, `parks/` (profiles), `backups/`, `build/` (the last build only, removed once it is
installed: the game plays its own copy, and Render previews builds first), `renders/` and
`renders-previous/`, `settings.json` and `facts.json`. The repository's `playlists/` and `parks/` are
the shipped defaults: saving a repository playlist saves a copy in the user folder (its editor views
too) and opens that; the first change to a park's profile copies the shipped one there, and a user
profile replaces the repository's of the same file name (`profiles.load`). Reset profile removes the
user's copy, so the shipped profile applies again (or none). A copy that ends up the same as the shipped
profile, or a new one left with only its `[match]`, is removed on save, so the user folder holds only
real changes. Later fixes to a shipped profile do not
reach a park the user has edited until it is reset (a field-by-field merge is a possible follow-up).

## Server lifetime (owner, 2026-10-31)

Each open page pings `GET /api/ping` every 10 s and says `POST /api/bye` (a beacon) when it closes.
The server stops once no page has pinged for 15 s (90 s for a tab that vanished without a bye; 2 min
for the first page after start), never while a tool runs. When it quits it removes the staging build
(owner, 2026-10-31: Install no longer removes it or offers to stop the server; `POST /api/shutdown`
stays for scripts). The token is kept in `settings.json`, so a restarted
server takes the old tabs back; a page whose server is gone says so and reconnects by itself.
`Settings.cmd` at the repository's root starts the server with `pythonw` (no console; its output goes
to `build/logs/settings-<time>.log`), and starting it while it runs only opens the page. What this
means for the packaged `.exe` is for the release stage.

## Previews: latest and previous

Render previews moves the last set to `renders-previous/` before rendering. The main page's strip shows
each park's "total" from the latest set (its first view in sets rendered before totals existed), 360 px
wide, with the render time beside Open renders. After a newer build of the open playlist (owner,
2026-11-01) the drawn routes are old: a park whose park file is the same in the new build (renderviews.py
writes each park's SHA-1, `parkHash`, and the build's `builtMtime` into `renders.json`) shows its
overview without lines, the others a "map changed" placeholder, and the time reads "before the last
build" (`previews`, `rendersStale`). The
comparison lives on the contact sheet (owner, 2026-10-31: the strip shows only overviews). The sheet is one column of parks, each under a sticky header with a
backing and its build facts (views, time per visit, moving time, event views, alternative orders, the
park file), under a line with the build and render times; each view is a full-width figure. Each park
starts with its "total" (owner, 2026-11-01): one extra render from the overview's center and angle,
zoomed out from the overview's zoom until every view's center fits, with every view's place numbered in
play order (views on one spot share a label, "2,3,4") and every pan (solid) or cut (dashed) between them,
the last back to the first (`total_frame`, `route_overlay`; `renders.json` `total` {file, overlay,
caption}). When a
previous set exists, the server adds its `renders.json` to the served latest sheet (`add_previous`,
`window.PREVIOUS`), and a Compare box in the top bar (remembered in the browser) shows it as a
second column beside the latest (owner, 2026-11-01): each column has its own park headers and facts and
scrolls on its own; a click on a park's header brings the same park (by key) to the top of the other
column. The Previews card has an Open renders button once a render exists. The sheet takes the
generator page's colors and scrollbars, with its own dark/light toggle (the same browser setting as
the generator's), and a legend: pan lines solid yellow, cut lines dashed cyan (the view cuts to the
next). `renders.json` carries each view's pan line overlay, so the previous column draws them too.
`renders.json` carries each view's caption and the park's facts for this (sets rendered before show
their images with plain "view N" captions).

## Build, then render, install or export; bundles (owner, 2026-10-31)

The top bar's right side is Build, Render, Install, Export. The page has three stages (owner,
2026-10-31): with nothing loaded (no saved playlist and no parks: every start, as the page loads
nothing until New, Import or the selector picks, or after New) New is
highlighted and Import (Import bundle) has the alternate shade, and Build is unavailable; with a
playlist Build is highlighted; once the playlist is built (and nothing unsaved) Install is highlighted
and Export has the alternate shade. The center of the top bar is a status line in place of the old
"changed" flag: the tool running, nothing loaded, missing parks (in red), unsaved changes, not built,
built at HH:MM, installed at HH:MM. Build saves the playlist when
the page changed it and builds into the user folder's `build/`; every build writes
`<name>.result.json` there (what `mksequence.py --install-built` needs, plus the playlist it came from).
Render, Install and Export stay grayed until the open playlist has a build that is newer than the
playlist and its views file, with nothing unsaved in the page (`Session.built`); a profile change or
reset removes the build. Install runs `mksequence.py --install-built`, so it installs exactly what was
built and rendered; editor views still in `plugin.store.json` stay there and keep playing (a CLI
`--install` moves them into the views file). The build stays after Install (Render and Export still
use it) and is removed when the server quits.

Bundles are a module of their own (`tools/bundle.py`); the screensaver's folders keep their layout and
a bundle is only packed from them and unpacked into them. A bundle is a `.zip`: `bundle.json` (format,
name, each park's file name, size and SHA-256), `playlist.toml` (parks as `parks/<file name>`),
`playlist.views.json`, the user's changed profiles (`profiles/`; shipped ones come with every copy), and
optionally the park files with the build (`parks/`, `build/`). Export asks whether to include the park
files (it shows their size), then for the file name. Import bundle (next to New) first removes the build and both render sets, then writes the playlist
to the user folder's `playlists/<slug>.toml`, its views file next to it, profiles to `parks/` (backups
as for any write), included parks to `bundles/<slug>/` and an included build to `build/`, so Render,
Install and Export are ready at once. Parks the bundle does not carry are looked for by file name in the
Source parks directory (the SHA-256 picks between several); any still missing add "Z missing!" to the
card's "X of Y parks selected" line and show red as "missing" in the park list with no facts, switches
or edit buttons, but they can be unticked and reordered like any park. While a ticked park is missing,
the Source parks card has a strong red border and band, the status line says so, and Build is
unavailable; an unticked missing park blocks nothing (a bundle exported then lists it by name only). Picking another directory (Browse or typing it) searches it for them and
saves the playlist with the found paths (`POST /api/relink`).

## Server API

Every call carries the run's token (`X-Token`); POSTs are JSON. Long work runs as one background
job at a time, which the page polls.

| Call | What it does |
|---|---|
| `GET /api/state` | The playlist (tomllib), `VIEW_DEFAULTS`, the tool's settings, the playlists in `playlists/`, each park's facts and the render previews. |
| `GET /api/job` | The running or last job: title, state, log. |
| `GET /renders/<file>`, `GET /renders-previous/<file>` | Files of the latest and the previous renders. |
| `GET /api/ping?page=<id>` | An open page is alive (see "Server lifetime"). |
| `POST /api/bye?page=<id>&t=<token>` | A page closed (a beacon, so its token rides in the query). |
| `POST /api/shutdown` | Stops the server. |
| `POST /api/new` | Starts a new, empty, unsaved playlist (the selector's New button; named on its first save). |
| `POST /api/config` | The OpenRCT2 path and library folder, kept in `settings.json`. |
| `POST /api/open {playlist}` | Opens another playlist (one the page lists: the user's or a shipped default). |
| `POST /api/browse` | A folder picker (tkinter, in its own process). |
| `POST /api/scan {folder}` | Reads the folder's parks directly into a new, unsaved playlist; a folder holding RCT2 saves (`.sv6`, `.sc6`) or loose objects goes through `importparks.py` first (a job), which also gzips its parks into the library. |
| `POST /api/playlist {data, asNew}` | Writes the playlist; a new one, or a shipped default, goes to the user folder's `playlists/` and its file paths are rebased onto that folder. |
| `POST /api/profile {key, changes}` | Changes one park's profile (found by its key: file name, plus `|member`). A new profile gets its `[match]` (saved name, map size). `null` deletes a key. |
| `POST /api/build {ignoreEdits}` | Runs `mksequence.py` as a job (refused while parks are missing). |
| `POST /api/install` | Runs `mksequence.py --install-built` on the open playlist's build as a job; refused while OpenRCT2 runs. Removes the build after success. |
| `POST /api/render` | Runs `renderviews.py` on the open playlist's build as a job; the previews strip then shows each park's total (every view and the route). |
| `POST /api/export {includeParks}` | Asks for a file name (native dialog), then runs `bundle.py export` as a job, with the user's changed profiles of the playlist's parks, and with `--parks --build` when asked. |
| `POST /api/import` | Asks for a bundle (native dialog), then runs `bundle.py import` as a job and opens the imported playlist. |
| `POST /api/relink {folder}` | Points missing parks at files of the same name in the folder (or below) and saves the playlist. |

Profiles, and the open playlist when saved over itself, are edited in place (`tomlwrite.patch`, owner
2026-10-31): changed values are replaced on their lines, so comments and layout stay. Only a change
it can't place (parks reordered, a change inside `[[spot]]`) rewrites the file, comments dropped.
The page is a generator and never asks before writing (owner, 2026-10-31: playlists 1-7 KB, profiles
0.1-3 KB, backups cost nothing). Every overwritten file is copied to the user folder's `backups/` first,
the last 100 copies per file (playlists 1-7 KB, profiles 0.1-3 KB); the Backups buttons (page footer, Edit parameters) open that folder (`POST /api/backups`). The Edit parameters dialog's Reset profile removes
the user's copy of the profile in one click (a backup is kept), so the shipped one applies again; each row's Reset only removes that key (back to inherited).

Every job writes its whole output to `build/logs/settings-<build|install|render|import>-<time>.log`; a
failed one leaves a message with that path at the top of the main screen until dismissed (owner,
2026-10-31: no pop-up warnings).

**Park facts** (`park_facts`) read the park only, with no generation: shown and saved name, map
size and size class (small < 100, large 100-199, very large 200+), the companions it ships, its
animation spots and shows (as `--animations` lists them), and its profile. The raw reads are
cached in the user folder's `facts.json` by file size and mtime, because a zstd park takes 3-6 s
in plain Python.

**TOML writing**: `tools/tomlwrite.py` writes the subset the project uses; `--check` round-trips
files (every playlist and profile in the repo reads back equal).

## Page rules

- A new playlist (Scan, or no playlist yet) starts with `motion = "pans"` and `pan = "auto"`: the
  generator's own default is `pan = 0`, which holds every view still and cuts, so a scanned playlist
  used to build with ride pans and beads that never moved (owner's test, 2026-10-31). Motion shows
  Static whenever `pan` is 0, and choosing Pans sets `pan = "auto"`.

- Static disables the Pan options block, as the mockup already does. Random disables Variants;
  Include reverse stays on (the pick order's reverse). Turning off Park plugin support also
  disables Plugin-driven views.
- Build saves the playlist first; an unsaved one asks for a name (`name`) and goes to `playlists/<slug>.toml`.
- Shuffle reorders the list in the page, and the new order is saved with the playlist. Unticked
  parks are saved with `use = false`.
- A park shows "adjusted" when its profile, or its `[park.views]`, sets anything.
- Parameters left as "inherited" are not written. Reset deletes the key.
- Show titles writes the top-level `titles` key (since 2026-11-03; it was a grayed placeholder until
  the screensaver mode's captions existed).

## Server decisions (owner, 2026-10-31)

- **Comments in TOML files.** The writer can't keep them. The page saves its own playlists, keeps
  a backup of any file it overwrites, and asks before overwriting a playlist it didn't write (one
  without its header comment), so the notes in hand-written playlists such as `example.toml` are
  never lost silently.
- **Requests from other web pages.** The server makes a random token per run and puts it in the
  URL it opens. Every API call must carry the token, and the server turns away requests whose
  `Host` or `Origin` isn't `127.0.0.1` / `localhost` on its port. This keeps other sites open in
  the browser (and DNS rebinding) from writing files or starting an install.
- **OpenRCT2 runs hidden.** `openrct2.com` (renders, `.sv6` conversion) is started with
  `CREATE_NO_WINDOW` on Windows, so no console window flashes up.
- **Python 3.11+**, because of `tomllib`. On Python older than 3.14, a zstd park takes 3-6 s to
  read, so the first scan of a large folder is slow. Importing (which stores parks as gzip) and
  the facts cache make later scans fast. Accepted.
- **Packaging** as a standalone `.exe` is tested at the release stage (roadmap step 6). A frozen
  build can't run `python mksequence.py`, so the server calls the tools in-process there.
  SmartScreen and antivirus warnings on unsigned PyInstaller builds are checked then too.

## Small generator follow-ups

- Done: profiles accept a top-level `companions = false` (the per-park Scripts toggle).

## Order of work

1. `tomlwrite.py` with its round-trip test, then `parkfacts`, then the `settings.py` API, tested
   against the example playlist from the command line.
2. The page's main and Parks screens, on the API.
3. The Edit parameters and plugin-driven views editors, writing profiles.
4. Build, install and render with streamed output, and the previews strip.
5. A live test on the PC over Remote Control: scan `ExampleParks`, change settings, build,
   install, launch.

## Saving before a build

Build saves the playlist first when the page changed it (Render, Install and Export need a build of the saved playlist),
without asking; an unchanged playlist builds from the file as it is (no write, no backup). A new,
never-saved playlist asks only for its name.

## Drawing views and rebuilding single parks (owner, 2026-11-01)

- **Drawing page.** `drawviews.html` is served at `/draw?t=<token>&park=<key>` (class `Draw` in
  settings.py, endpoints `/api/draw/state|render|image|save|reset`). It reads the open playlist's last
  build (current or not; a profile change marks the build old instead of removing it), renders each
  park from four angles with `drawviews.Renders` into the user folder's `draw-renders/` (by park
  contents), and saves through `drawviews.Store` into the playlist's views file, drawn for the
  playlist's `[views] window`. Run by drawviews.py on its own, the same page has no token and talks to
  that server.
- **Events on drawn views.** At build, a park's drawn views play as drawn (holds kept) and its event
  views (animation spots as route stops, cut-ins, shows) are added as on generated views, where events
  are on; event views saved with an edit are left out. The page's Events panel writes the park's
  profile (`/api/profile`), as the old dialog did; it is gone from the park list.
- **Clipboard.** Copy gives `{"format": "rct-screensaver-views", "version": 1, park, key, screen, views,
  events}` (events: the profile's `[extras] animation_hold`/`show`, `[views] show_pan`/`events`,
  `[animation]`, `[show]`); Paste takes it (or a bare view list), scales zooms from its screen, and
  applies only the events this park has.
- **Single-park rebuilds.** Builds pass `--cache <user folder>/park-cache`: mksequence keeps each
  resolved park under a signature of what it was resolved from (entry, playlist-wide options, the
  park's edit, file, matched profile, companion library and show definitions for parks with companion
  data, the generator's code) and takes unchanged parks from there. `mksequence.changed_parks` lists the
  parks the next build redoes; the park list flags them (**rebuild**) and the status line counts them.

## Drawing page, second round (owner, 2026-11-02)

- **Before a build.** Edit views ↗ is on for every park once the playlist is saved (the page saves it
  first when it changed). `/api/draw/state` answers `needsBuild` when there is no build, and `building`
  with the running build's job; the drawing page then builds (or follows that build: `/api/build`
  returns the running job instead of starting a second) and loads once it is done. It also builds when
  the last build lacks the park asked for. Renders are made as each angle is first shown.
- **Content box.** A build without a park's box (older builds) no longer falls back to a 128-tile box:
  `drawviews.park_box` reads it from the park file (the map's size when nothing is built). The fallback
  cut The Koi Pond's 252-tile map in half.
- **Flags on the main page.** The page fetches its state again when it comes back into view and every
  4 s while another window has the focus, so drawing-page edits show: the status line counts the parks
  to rebuild and Build leads again; those parks' previews give way to "views changed: build and render
  again" and their park-list rows are tinted.
- **Hand-set badges.** State `handSet` lists the parks pinned in the views file (`mksequence.pinned`).
  They carry a **manual** badge in the park list and on their preview; renderviews.py badges the park's
  header (playlist `handSet`) and each view drawn by hand (`manual`), and records both in renders.json
  (`handSet`, `manual`) for the previous column. "before the last build" beside the render date is red.
- **Drawing page.** The list has column keys (#, ↻ angle, 🔍 zoom, ⏱ hold, Pan, Align, Source) and a
  draggable width (kept in the browser, `rctss-draw-aside`); the status sits in the middle of the top
  bar; a park opens on its first view; views from other angles show as numbered circles where they look,
  and a click turns to that view and its row. Inertia is the playlist's `[views] inertia` only: the page
  has no per-view switch, saves none, and builds ignore a view's own `inertia`.
- **Third round (owner, 2026-11-02).** The picture's boxes keep the dark mode's colors in light mode
  (only the shortcut keys in the footer were hard to read); the list starts at 30% of the window; the
  zoom column's key is a plain spyglass; the status has a yellow backing. The badge reads **manual**, and
  the main page counts manual parks next to adjusted ones. A generator update makes every park's cached
  build old: `changed_parks(detail=True)` tells those (`updated`: cached under the previous code version,
  `code.txt` in the cache) from parks changed themselves, and the status line says "Generator updated
  since the last build" instead of flagging every park. Render passes `--reuse` with the set before:
  renderviews.py copies each picture whose park file (SHA-1), camera and size are unchanged
  (renders.json `images`) and renders only the rest.
- **Bundles and the park cache (owner, 2026-11-02).** A bundle import rewrote identical park files, and
  the cache knew a park by its file's size and time, so every park looked changed. Import now leaves a
  park file whose size and SHA-256 match the bundle's alone, and the cache records each file's SHA-1:
  its signature uses the contents, and a file with the same size and a new time is checked by contents
  (names.json is updated when it matches). The drawing page's status has the yellow backing only while
  changes are unsaved.
- **Box colors and partial previews (owner, 2026-11-02).** The drawing page draws the route as the
  renders page does (solid line and arrow for a pan, dashed for a cut, the last view back to the
  first), each line in the color of the view it leaves. Tint 1-3 (kept in the browser, `rctss-draw-tint`) turns the
  whole palette (manual yellow, selected orange, generated gray, the Generated overlay purple) by 120°
  steps; in tints 2 and 3 the gray becomes the color opposite the manual views'. renders.json records each park's
  `viewsKey` (a digest of its built views): after a partial rebuild, a park whose park file and views are
  unchanged keeps its route preview, and only the others turn plain or into placeholders.
- **Old renders on the renders page (owner, 2026-11-02).** The contact sheet marks the parks the strip
  marks: "views changed" (edited or profile changed since the last build), "rebuilt" (built again with
  other views of the same map) or "map changed" (another park file), dims their pictures and counts them in
  the top bar. The settings server adds this when it serves the sheet (`STATUS_JS`, so older sets get it
  too) and the page asks `/api/renders/status` (`App.render_status`) again on focus and every 4 s while
  out of focus. The drawing page's Reset views asks "Drop custom views for this park and revert to
  automatic ones?".
