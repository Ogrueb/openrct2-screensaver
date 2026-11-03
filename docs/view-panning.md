# View panning (2026-10-28)

Status: the plugin side is finished (owner, 2026-10-28: "an acceptable state"). Generating views
for panning (heuristics) is the open part, in a separate piece of work.

Roadmap item 1. A view can now pan on to the next one instead of cutting to it:

- **`pan`** (per view, 0 to 1, default 0): the share of the view's hold spent panning to the
  next view, at the end of the hold. The camera arrives as the next view's hold starts. `0` holds
  still for the whole hold, then cuts, exactly as before. `0.5` holds still for the first half,
  then pans. `1` keeps moving the whole time.
- Static and panning play are meant to differ in how the default views are generated: views
  generated with no pan, or views generated with pan values. The generator's heuristics for that
  come later. For now `[views] pan` gives every generated view one share.
- A generated overview always pans 10% of its hold to the first close-up, with angle and zoom
  changing on arrival (owner, 2026-10-28; `overview_pan`, `overview_pan_changes`).

All in the plugin (`plugin/src/pan.ts`); no engine patch.

History: a first version replaced cuts with short glides on a zoom-out-and-in
path. The owner tried it on the PC. Horizontal movement was mostly smooth, but zoom and angle steps
mid-move break the smooth effect, and timing made for static views was too fast for moving ones.
A second version used a `still` share and a separate motion mode. The owner replaced
that with the per-view `pan` share above (default 0) and approved angle and zoom changes at the
start of a pan by default.

## How a pan moves

- **Path**: a straight line from one view's center (x, y, z) to the next. It moves every game
  tick (`context.setInterval(…, 1)`; OpenRCT2 runs plugin intervals once per tick, 40 times a
  second) with `Viewport.moveTo`. Positions follow real time, so game speed doesn't change a pan.
- **Inertia** (per view, `inertia`, default off), for progress t from 0 to 1 over the pan's
  moving time T and its distance D:
  - off: position u(t) = t, one speed D/T throughout.
  - on: u(t) = 4t³ for the first half, 1 − 4(1 − t)³ for the second (cubic ease); speed
    12t²·(D/T) at first, so it starts and stops slowly and peaks mid-pan at 3 times the average.
  - A sine ease (u = (1 − cos πt)/2, peak 1.57 times the average) was tried first: never more than
    about 10.6% of the distance from linear, it looked the same at these speeds. The cubic ease was
    clearly visible, so the choice became this on/off switch (owner, 2026-10-28).
- **Angle and zoom never change mid-pan.** OpenRCT2 can only change them in steps, so they change
  at the ends of the pan (`panChanges`):
  - `"end"` (default, owner 2026-10-28): the camera travels as the view it leaves and changes on
    arrival.
  - `"start"`: it changes as the pan sets off.
  - A two-step change is split between the ends (owner): opposite angles (0 and 2) turn one step
    as the pan sets off and one on arrival, and zooms two or more levels apart change by half at
    each end (an odd change puts the larger half at the `panChanges` end).
- **A moment around each change** (plugin settings; owner): before a change on arrival the camera
  rests at the next view's spot, still at the angle and zoom it traveled at (`arriveHold`, 1 s);
  after a change as a pan sets off, it stays still at the new angle or zoom before it moves, and a
  view whose angle or zoom changed as the camera arrived stays still at least that long before it
  pans on (`changeHold`, 2 s). All of it is time added to the view's hold (its pan keeps its full
  time), so no angle or zoom is on screen only in passing. These pauses are plain stills on the
  view's own spot, so they have no pan setting of their own.
- **Zoom on the way**: a pan faster on average than the speed tolerance at the zoom it runs at
  (owner, 2026-10-28: the zoom it travels at, whether set as it sets off or on arrival; tolerance
  below; with inertia the top speed is 3 times the average) travels a level further out, and on
  while still too fast there, where that is allowed, stepping out as it sets off (with the moment
  above) and back in on arrival:
  - between views at the same zoom, one zoom level out at most (owner: never more);
  - between views at different zooms, no further out than the wider of the two views, so it never
    shows a zoom neither view has.
  The plugin doesn't cap speed: the move keeps its time. Generation does (below). (Before the
  tolerance this used a flat 100 px/s, `panSpeed`, then `symmetricZoomThreshold`. A draft applied the limit to every pan, so most
  pans zoomed out to about the overview. Before the second rule, generated views 20-50 tiles apart
  at different zooms panned at 450-1,900 px/s on the examples, which looked like jumping.)
- **When it cuts instead**:
  - (not a park's last view: it pans back to the first view, owner 2026-10-28. When the park
    loops alone, in the editor's Play or a playlist of one park, the first view
    plays on; otherwise the camera holds there `returnHold` (2 s) and the next park follows. The
    first try kept the last view's angle and zoom, which was far too slow to get back in time;
    now a return pan to a wider first view (usually the overview) zooms out as it goes: one zoom
    level as it sets off (moving at once: the owner cut the 2 s still there), the further levels mid-pan, each level held for an
    equal share of the move at one screen speed, so the ground covered doubles with each level.
    Any turn comes on arrival, after the 1 s rest (owner: an early try turned as it set off). Its speed is checked, and stretched by
    generation, against the tolerance at the widest zoom; `cameralog.py` reads it from the plan
    line's `out=`.)
  - a show view
  - a next view at the same spot (only the angle or zoom differs)
  - a pan shorter than 0.5 s
  - key presses (Left/Right cut straight to a view)
  - the view editor (no movement while it is open)
- **Hold** (Space) pauses a pan where it is, and releasing carries on. A still view gets its full
  hold again, as before.
- **Sound** (patched engine, patch 0009): positional sounds follow the camera, so a view that pans
  on doesn't fade them out ahead of the change. Cuts fade as before.
- **Timing**: a pan is part of the leaving view's hold, so a park's total time is unchanged,
  except for the moments added after angle and zoom changes.

## Where it's set

- Playlists:
  - `pan`, `pan_changes` and `inertia` in `[views]` or a park's views.
  - `pan`, `pan_changes` and `inertia` on a listed view.
  - `mksequence.py` writes `pan`, `panChanges` and `inertia` per view, and only `pan > 0` and
    non-default values.
  - `mksequence.py --set pan=0.5` tries a share on every park without editing the playlist (any
    `[views]` option can be set this way).
- In-game view editor:
  - a "Pan" spinner (10% steps)
  - "Turn: start/end" and "Inertia: on/off" switches for the selected view
  - a "Pan" column
  - Like a hold change, any of these counts as arranging the list, so the park's views are kept
    at install.
  - "Play" (owner, 2026-10-28): plays the park's views with their pans while the editor is open,
    looping in the park (never the next park). Each edit or selection shows the selected view and
    plays on from it 1 s later; a further edit restarts the wait. Moving the camera by hand stops
    it.
- Browser tool (`tools/drawviews.py`):
  - per view, a "% pan" field and start/end and linear/inertia switches
  - dashed lines on the picture show each pan's path
- Plugin settings (`RCTScreensaver.settings`): `panTolerance`, `panToleranceStep` (for playlists that don't carry their own), `changeHold`, `arriveHold`, plus `panChanges` and `inertia` as the
  defaults for views that don't set them; `scaleToWindow` (default on, below).

## Window size and shape (phase 7, 2026-10-30)

A zoom level is a fixed scale (zoom 0: one world pixel per screen pixel), so a view keeps its
zoom and shows less of the park in a smaller window. The owner's 2026-10-29 test in a 1080p window
"pulled every view in": 1920x1080 is 16:9 like the 4K window, so that was the resolution (each
view showed a quarter of the area it was framed for), not the aspect ratio. Before this phase only
the overview (fitted to the window) and the merge distance (a share of the window) followed the
window; close-up zooms, pan tolerances and hand-set views were in absolute pixels.

- **Zoom offset** (`plugin/src/scale.ts`, `mksequence.zoom_offset`): the playlist carries the
  game window its views were judged in (`screen`, from `[views] window`, 1920x1080; absent: the
  same). That is game pixels after OpenRCT2's scale factor: the owner's testing ran on a 4K monitor
  at scale 2.0 (owner, 2026-10-30), and the PC's 1920x1200 screen at 2.0 is 960x600. The plugin
  sees `ui.width`/`ui.height` in game pixels, so the scale factor is already counted (stock v0.5.6
  gives plugins no way to read it, and none is needed: the world a window shows depends only on its
  game pixels and the zoom). The plugin takes `scale` = the smaller of window width ÷ frame width and
  window height ÷ frame height, and moves every view `ceil(log2(1 / scale) - 0.25)` levels out
  (clamped to -2..3). Matching the smaller side ("contain") keeps the whole frame on screen in a
  window of another shape, so a tower view zoomed to fill 0.8 of the height keeps its top, and a
  wide window adds sides rather than cropping top and bottom; the 0.25 slack allows a frame at most
  19% tighter before a level out. OpenRCT2 has only whole levels, so a window between powers of two
  shows more than the frame:

  | game window | e.g. | offset | frame shown (width × height) |
  |---|---|---|---|
  | 1920x1080 | 4K at 2.0, 1080p at 1.0 | 0 | 1 × 1 |
  | 1920x1200 | 1200p at 1.0 | 0 | 1 × 1.11 |
  | 2560x1440 | 1440p at 1.0 | 0 | 1.33 × 1.33 |
  | 1280x720 | 1440p at 2.0 | 1 | 1.33 × 1.33 |
  | 960x540, 960x600 | 1080p/1200p at 2.0 | 1 | 1 × 1 (1.11 high) |
  | 1720x720 | 3440x1440 at 2.0 | 1 | 1.79 × 1.33 |
  | 3840x2160 | 4K at 1.0 | -1 | 1 × 1 |

  The generator's `[views] screen` was 3840x2160 (frame fill, tower fit, beads, ride overshoot), twice
  the judged window per side. Since 2026-10-30 it is 1920x1080 like `window`: tower fit, cell slicing,
  beads and the ride overshoot use the window that plays, while the frame fills keep their larger window
  (`fill_window` 2 × the screen, the surroundings counting too), as the views the owner accepted were
  picked with it; `ride_overshoot` 0.2 and `tower_close` 1 keep the accepted pull-back and tower zooms.

- **Fitting** runs after the offset, in the window's own pixels as before (moving views onto the
  content, merging those within a quarter of the window, the overview fitted to the window).
  The small-park overview cap (zoom 0) and the per-angle fallback's zoom limit move with the offset.
- **Pan tolerance** (owner, 2026-10-28: a share of the window, "100 px per level at 4K, so 50 for
  1080, 75 for 1440p"): `panTolerance(zoom - offset) × min(1, scale)` at the zoom the pan runs at.
  It is read at the frame's zoom (the zoom the generator checked) so the plugin makes the same
  travel-zoom decisions the generator planned: a 960x540 window plays a -2 pan at -1, at half the
  pixel speed, against 250 px/s. Never above the measured pixel speed (a larger window keeps 500).
  A view's `zoomThreshold` scales by `min(1, scale)`. The camera log's `plan` lines carry the
  tolerance used (`tol=`), which `cameralog.py` checks against, and a `screen` line names the window
  and the offset.
- **Hand-set views**: the editor saves the window size with a park's edits (`screen`), the browser
  tool its `--screen`; `mksequence.py --install` carries it into the views file and the playlist
  (`viewScreen`), and the plugin scales those views from it. Edits saved before this have no size
  and play as set. The browser tool shows generated views as they play on its screen.
- `scaleToWindow = false` (plugin setting) plays every zoom as set, as before.
- Left alone: generation's own sizes (the 32-tile cell "about one screen" and the layer gap use a
  1920x1080 screen; frame fill, tower fit, beads and ride overshoot use `[views] screen`), so
  generated views are the same for every window and only their playback scales.
- `tools/renderviews.py` renders at 1920x1080 by default, the judged window; renders made with
  `--size 3840x2160` show four times the area that played.

## Checking timings

`mksequence.py --install --camera-log` turns on the plugin's camera log (`cameraLog` setting; an
install without the flag turns it off): one line per view, pan plan, start and stop of movement,
and angle or zoom change, each with its time. `python3 tools/cameralog.py <game log>` turns that
into a table per view (total, still, moving, average px/s, rest before an arrival change, shortest
still after a change) and flags stills shorter than `changeHold`, rests shorter than `arriveHold`,
pans cut short, and pans over the tolerance at their zoom.

`mksequence.py --route` prints each park's route metrics (always written to `<sequence>.scores.json`
under `route`): the closed route's length in tiles against the shortest order of the same views,
pans that turn or change zoom, bends between consecutive pans (straight under 30°, bend, reverse
over 150°), straight runs of 3+ pans, double reversals (a raster) and `sweep`, the rank correlation
of visit order with position (0 for a loop, 1 for a sweep across the park). Baseline before the circuit: 82% of pans changed
angle and 86% zoom (pan-based view generation, phase 1, `docs/roadmap.md`).

`[views] route` orders a park's generated close-ups (phase 2 of the plan, 2026-10-29): `"circuit"`
(the default) keeps the overview first, starts at the close-up nearest its center and searches every
order of the rest for the cheapest closed loop, where a pan costs its moving time (screen distance at
the wider of its zooms over `route_speed` (0.6) of the tolerance there) plus `route_change` (3 s) per
angle change and zoom level, and the loop's shape adds penalties for sweeps (pans beyond two in a
straight run, two reversals in a row, a pan running back alongside an earlier one, a visit order sorted
along an axis) and a small reward per 45-135° bend. `"picks"` keeps the order the views were picked in.
On the examples (`--ignore-edits --set pan=0.6`) the closed route over the seven larger parks fell from
1,467 to 1,113 tiles (shortest possible 929), zoom changes from 36 to 22, double reversals from 7 to 0,
and stretching from +79 s to +38 s; sweep correlations sit at 0.1-0.64. Static play uses the same order.

Each pan's `stop` line also carries its fastest tick (`peak`, screen px/s), which shows frame
jitter and the inertia peak.

### Speed evaluation (owner approved the approach, 2026-10-28)

1. Measure speed in screen terms (px/s at the travel zoom, so already relative to zoom), later as a
   share of the window width so window size doesn't change the verdict; log the fastest tick too.
2. Calibrate by eye: `playlists/speed-ladder.toml` pans 512 screen px at zoom -2, -1, 0 and 1, each at
   25, 50, 100, 200 and 400 px/s in that order (2 s still before each, no changes, no travel zoom:
   a view's `zoom_threshold` replaces the tolerance at every zoom). The owner rates each, giving a tolerance
   per zoom (zoom -2 moves in 4 px steps, so slow pans there step visibly).
   First run (512 px, 25-400 px/s; owner, 2026-10-28): too slow is no concern; 100 px/s at zoom -2
   was the first step that looked smooth; 400 px/s at -2 and at -1 still acceptable but too brief
   to judge. Second run: 1536 px at 200, 300, 400, 600 and 800 px/s: 800 px/s at zoom -2 was the
   fastest still legible; to be conservative the tolerance is 500 px/s at zoom -2 and 100 less per
   zoom level out (owner, 2026-10-28; `pan_tolerance`, `pan_tolerance_step`; never under one step).
3. Check offline (built): `mksequence.py` computes each pan's travel zoom and speed as the plugin
   will play it, prints per park how many close-up pans are over the tolerance, and lists every
   pan under `pans` in `<sequence>.scores.json` (overview pans are marked: their zoom is fitted in
   play). `cameralog.py` flags pans over the tolerance in play. On the examples at pan 0.6, 25 of 42
   close-up pans were over it (up to 1,085 px/s at zoom -1) before enforcement.
4. Enforce (owner, 2026-10-28): generation stretches the moving time of any generated pan over the
   tolerance at the zoom it runs at (the plugin's zoom-out included), in 100 ms steps, until it is
   under; the still time stays, the hold grows. Each park's tolerance goes to the plugin with the
   playlist (`panTolerance`), so both use the same rule. Listed and editor views play as set.
   Overview pans are exempt (owner, 2026-10-28: overviews are a special case; they need no
   stretch), though they run over it (160-340 px/s against 100-200 on the examples, their zoom
   fitted to the window in play). On the examples at pan 0.6: every close-up
   pan within the tolerance (checked in the mock with the camera log), 25 pans stretched, about
   67 s added over the 10 parks (most on Constellations, +20 s).

## Known limits

- **40 steps a second.** With "Uncap FPS" on, OpenRCT2 draws faster than plugins run, so the
  camera moves in 25 ms steps. An engine patch could move the camera per frame (the engine
  already tweens entities between ticks).
- **Coarse steps zoomed in**: the viewport position is in whole zoom-0 pixels, so at zoom -1 a
  step is 2 screen pixels, and at -2 it is 4.
- **Small parks whose views share one spot** (Tin Train: every view on one tile) cut at every change,
  as there is nothing to pan between.

## Follow-ups

1. Generating views for panning (an order that visits nearby spots in turn, keeps the angle between
   neighbors, picks zooms that need no travel zoom, and times holds from pan length): done as
   phases 1-6 of pan-based view generation (`docs/roadmap.md`, accepted 2026-10-30).
2. Speed as a share of the window width, so window size doesn't change the verdict: done in phase 7
   (window size and shape, above).
3. Fitting (the plugin moving views inwards to the park's content for the window size and zoom,
   merging near-duplicates, and rescaling holds to the park's time) runs after generation
   stretched the pans, so a pan can come out a little faster than planned; the camera log shows
   it (owner, 2026-10-28: slight changes from fitting are acceptable). Generation stretches the
   last-to-first pans too.
