# Generator settings UI: what each control sets

The settings UI (mockup "Screensaver generator settings", roadmap step 5) writes a TOML playlist
and runs the tools on it. This page maps every control to the playlist key or tool it drives, and
records the audit of 2026-10-31: where the mockup and the scripts disagreed and what was done.

`[views]` keys can also be set per park (`[park.views]`, or a profile's `[views]` in
`parks/<slug>.toml`); top-level keys are per playlist.

## Main screen

| Control | Playlist key / tool | Notes |
|---|---|---|
| Build | `tools/mksequence.py <playlist>` | Saves first (no prompt) only when the page changed the playlist. Render, Install and Export are grayed until there is a build. |
| Render | `tools/renderviews.py <seq>.playlist.json` | Renders the build's views, each at its own angle (`--angles`: the overview from all four). Needs OpenRCT2, so it runs on the PC. |
| Install | `mksequence.py --install-built <seq>.result.json` | Installs the build as it is. Refuses while OpenRCT2 runs. |
| Bake into playlist | `tools/bakelive.py <playlist>` | Shown above the park list while the game's live file (`docs/screensaver-ui.md` "Live file") has edits the playlist files lack; Build applies them either way. |
| Export | `tools/bundle.py export` | A bundle (.zip) of the playlist, its views and changed profiles; optionally the park files and the build. |
| Import | `tools/bundle.py import` | Next to the playlist selector (highlighted with New while nothing is loaded). Parks not in the bundle are looked for in the Source parks directory; missing ones show red and can be unticked. |
| Source parks: directory | `tools/importparks.py <dir> -o <library>` | Writes a library and a playlist of every park; `.sv6` needs `--openrct2`. The UI then edits that playlist. |
| Motion: static / pans | `[views] motion = "static"` / `"pans"` | **New.** Static sets `pan`, `overview_pan`, `ride_pans` to 0 and turns beads and nudges off, so nothing pans (the overview used to pan 10% even with `pan = 0`, and ride pairs and beads were still generated). |
| View order: circuit / random | `[views] route` | Random is the pick order (the generator before the circuit), not a shuffle. |
| Variants | `[views] circuit_variants` | Circuit only: the pick order has no alternatives. |
| Include reverse | `[views] circuit_reverse` | **Fixed:** with `route = "random"` it now adds the pick order's reverse (it did nothing). |
| Inertia | `[views] inertia` | |
| Ride-following pans: include / exclude / only | `[views] ride_pans = 1` / `0` / `only = "rides"` | |
| Angle and zoom change | `[views] pan_changes` | |
| Change, arrival, return hold | `[views] change_hold`, `arrive_hold`, `return_hold` | **New:** were plugin settings only. Written to the playlist (`changeHold`, `arriveHold`, `returnHold`, times `time_scale`); the plugin prefers them over its settings. |
| Park duration (min, max) | `[views] park_min`, `park_cap` | **`park_min` new** (default 30 s, owner 2026-10-31): a shorter park's still times grow to fill it, pans keep their speed. **Fixed:** `park_cap` only applied with timed pans; static and random parks over it now have their holds shortened in proportion. |
| Time scaling | `[views] time_scale` | **New** (0.5-3.0 on the page). Multiplies every generated hold (pan shares unchanged, so pans slow down or speed up with it) and the three holds above. Park min and max count scaled seconds. Event views (cues, shows) keep their time. Faster than 1× can take pans past the speed tolerance; the plugin then travels them zoomed out. |
| Park plugin support | top-level `park_scripts` | **New:** companions always ran. False installs none and leaves out event views. |
| Plugin-driven views | top-level `park_plugins` (profile extras), `[views] events` | **Fixed:** `events = false` now leaves out show views too (it kept the eclipse). |
| Ride music as title music | top-level `title_music = "ride"` / `"theme"` / `"keep"` | **New** (owner's pick, 2026-10-31): `--install` puts it in the plugin's settings (`titleMusic`), and the screensaver mode applies it in memory on entry: ride music (`title_theme` 5), the OpenRCT2 theme, or the game's own choice. `config.ini` is never edited (2026-11-01). Patched engine only. |
| Show titles | top-level `titles = "overview"` / `"on"` / `"off"` (absent: Viewer's) | **New** (owner, 2026-11-03): the playlist's choice for the screensaver mode's park name captions. The build puts it in the installed playlist (`titles`); each time playback starts the plugin uses it in place of the viewer's own setting, never saving it, until the viewer picks on the bar's Titles button, which is kept from then on. "Viewer's" leaves the key out. |
| Previews strip | `build/renders/` from renderviews.py | Each park's "total" render (every view numbered, with the route's pans and cuts drawn; the first view in older render sets), matched by park key; after a newer build, the overview without lines where the park's map is unchanged, else a "map changed" placeholder; the render time sits beside Open renders through renderviews.py's `renders.json`; a click opens that park in the contact sheet. |

## Parks screen

| Control | Playlist key | Notes |
|---|---|---|
| Use | `[[park]] use = false` | **New:** an unticked park keeps its entry (order, settings) but is not built. |
| Order, drag, Shuffle | the order of `[[park]]` entries | `order = "shuffle"` (build-time shuffle) stays for the command line. |
| Size, Scripts, Special Views filters | UI only | Needs park facts (map size, companions, animations) from a listing step; see the wiring draft. |
| Adjustments: Scripts | `[[park]] companions = []` | Existing key; also leaves out the park's event views. |
| Adjustments: Plugin views | `[park.views] events = false` | |
| Adjustments: Towers | `[park.views] tower_views = 0` | |
| Adjustments: Ride pans | `[park.views] ride_pans = 0` | |

## Edit parameters (per park)

| Row | Key | Notes |
|---|---|---|
| tower_views, park_cap, count, zoom_min, zoom_max, pan_tolerance, ride_pans | `[views]` keys of the same name | |
| companion_pans | `[views] companion_pans = "pause"` | **New:** pauses all the park's companions during pans (a profile's `[companion.X] pause_during_pans` still works per companion). |
| return_pan | `[views] return_pan = false` | **New:** the plugin cuts from the last view to the next park (`returnPan` in the playlist). |
| pan | `[views] pan = "auto"` or a number | **New `"auto"`:** pan_timing on, 0.6 for listed and companion views. 0 makes that park static (overview excepted; use `motion` for all). |
| animations, show | profile `[extras]` | Applied only with `park_plugins`. The mockup shows `animations` inherited as true; the real default is false unless the profile sets it. |

## Edit views (the drawing page)

The park list's **Edit views ↗** (every park of a saved playlist; without a build, the drawing page builds it first) and each park header's
button on the renders page open `tools/drawviews.html`, served by the settings server at
`/draw?park=<key>` on the last build. Views are drawn as boxes on four-angle renders and saved as
they change into the playlist's views file; **Copy**/**Paste** carry a park's views and its event
settings as text; **Reset views** (only here) drops the drawn views. The Events panel (folded in from
the old plugin-driven views dialog) saves to the park's profile as it changes and shows when each event
happens: timeline events at their time in seconds after the park loads (or their repeat), car-cued ones
when a car arrives, continuous ones as route stops.

| Row | Key |
|---|---|
| animation_hold | profile `[extras] animation_hold` |
| Spot on/off, hold | profile `[animation."<name>"] off`, `hold` (names from `mksequence.py --animations` or `scores.json`) |
| show, view, path, hold | profile `[extras] show`, `[show.<name>] view`, `path`, `hold` |
| show_pan | `[views] show_pan` |

## Mockup text corrected

- Random: "the generator's pick order, varying angle and zoom", not "shuffled".
- Render previews: each view at its own angle, not all four.
- Variants: circuit only.
