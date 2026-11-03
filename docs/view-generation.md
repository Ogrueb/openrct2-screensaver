# How views are generated

What `tools/mksequence.py` does with a park when a playlist does not list its views by hand
(method `spots`, the default). Every value named in parentheses is a `[views]` option of the
playlist, settable per park in its `[park.views]` table or profile; the defaults suit most parks.
The README's "Playlists and views" section covers the playlist format, panning and window scaling.

## 1. The overview

Every park starts with an overview of the whole park. The plugin zooms it out until all of the
content fits the window (a small park whose footprint fits at zoom 0 goes no further than zoom 0),
centered as near to the elements' mean position as keeps all of the content on screen. The
overview keeps the park's saved angle.

## 2. The view budget

A park's number of views grows with the ground its content covers, on a log scale: 4 views
(`base_views`) up to about one screen of built tiles (`budget_tiles`), one more per doubling, at
most 8 (`count`); fewer if the park runs out of spots worth showing.

## 3. Spots and their scores

Close-ups take turns between zoom levels (`zoom_min` to `zoom_max`, -2 to 1 by default, always
closer than the overview; on parks wider than a screen, no zoom whose cell is wider than half the
content, `wide_limit`, so no close-up is a second overview).

- **Where spots are.** Cells on two grids offset by half a cell. A cell whose elements leave a
  tall empty band (a scene under a suspended lid) becomes one spot per layer, and a spot taller
  than a screen is offered one screen of height at a time.
- **What counts.** A tile counts at most as many elements as 90% of tiles have, so one stacked
  tower cannot drown out the rest. Rides, track and paths outweigh static scenery: those
  elements carry half of a park's scoring weight however few there are (`activity`), and each
  view aims where that weight is.
- **Angle.** Every spot is a candidate from each angle (`rotation = "auto"`), scored by how busy
  it is times how much of it is not hidden behind taller things in front.
- **Frame fill.** The score is multiplied by the square of the frame fill: the share of a window
  `fill_window` (2) times the screen (`screen`, 1920x1080 game pixels, the window the views are
  judged in; the fill counts the surroundings too) that shows built content when the map is
  painted from that angle. Bare land and water count `fill_land` (0.3); the void, the black
  backdrop many parks fake with a flat lowland or a sheet of scenery, and cliff walls count
  nothing. So a spot at the park's edge is seen from inside the park rather than with the void or
  a wall filling half the screen, and a close-up that would show the whole park again scores low
  (`fill_min` 0.5 drops it outright).
- **Spacing.** The same spot from another angle counts as a new view at up to half its score,
  so small parks get their content from several sides and large parks mostly distinct spots.
  Views from the same angle stay apart by half the larger view's size; a spot dropped for being
  too close adds its score to the nearest close-up, so busy areas get longer holds.

## 4. Districts and the circuit

The close-ups are grouped into districts (`districts = true`; the grouping is
`tools/districts.py`'s watershed of the element density). Each district gets a home angle (the
angle showing most of its spots) and a home zoom (where its spots score most). A close-up keeps
them unless a change earns its place: it turns away when the home angle shows under `home_seen`
(0.7) of its spot and its own angle `home_gain` (25%) more, and keeps its own zoom when its spot
scores that much more there than at the home zoom. At most `change_budget` (half) of the
close-ups change, and a spot shown again from another angle keeps that angle.

The views are then ordered into a circuit: the cheapest closed loop by pan time, angle and zoom
changes and shape, visiting each district once (`route_district`, 6 s per return to a district
left earlier). `route = "picks"` keeps the pick order instead, and `"random"` is the generator
as it was before districts, towers, nudges, beads, pan timing and ride pans existed.

## 5. Towers

Towers are structures rising `tower_rise` steps above the built tops around them, found by
`tools/districts.py`. A tower that no close-up shows whole near the middle of its screen (the
middle third of its width) at the tower's own zoom or closer gets a view of its own
(`tower_views`, up to 2 per park, tallest first, within `count`): centered on the tower at
mid-height (its top found through gaps up to `tower_crown` steps, for a spire set above a
hollow), zoomed so its height fills `tower_fit` (80%) of the window and then `tower_close` (1)
level closer, from the nearest close-up's angle unless another angle's frame fill is a quarter
better, so the camera pans up the tower. A tower taller than the window is framed from its top
(`tower_top` 0.15 under the frame's top).

The plugin shows tower views as placed (`fixed`), since fitting would center a window wider than
the park on the park instead. Set `tower_views = 0` in a park's `[park.views]` where its tallest
structures are scenery mountains rather than towers.

## 6. Nudges and beads

With the circuit in order, each close-up may move within a quarter of its cell (`nudge`, 0
leaves the picks alone) to where the pans into and out of it sweep the most content (the mean
frame fill of `path_samples` windows along each pan, at the zoom the pan runs at), as long as
its own frame fill keeps `nudge_keep` (95%) of what it had. Pans shorter than a quarter screen
do not count.

A pan between close-ups longer than `bead_seconds` (8) of travel at `route_speed` of the
tolerance gets a bead (`beads`): a pass-through view on the way, taken from the spots the picker
left unchosen (same angle, between a quarter and three quarters of the way along, within
`bead_band` (a quarter of the screen's height) of the line, a quarter screen clear of either
end). A bead rests `bead_still` (1 s) and pans on (`bead_pan`, 80%), on top of the park's time.

## 7. Ride pans

A ride whose vehicles move and whose track has `ride_tiles` (24) tiles or more can give a pair
of views whose pan follows it (`ride_pans`, up to 1 per park). The pair is the two ends of the
longest straight run of its track inside the park's content: `ride_run` (20) tiles at least, one
connected stretch of track staying within `ride_band` (4) tiles of the line between them and at
most `ride_detour` (1.5) times as long. The pan runs in the direction the trains go (a train on
the run, else the track's build direction), at `ride_zoom` (-1) and the track's height, from the
angle where the run is longest on screen and over the most content (`ride_fill` 0.8 at least, so
not along the park's edge) and shows enough of the track (`ride_visible` 0.2, so no dark rides).
Only open rides count (`ride_status`), the run scoring most (length times fill) wins, and the
end view is pulled back by `ride_overshoot` (20% of the window) so the pan stops on the track.
The pair stays together in the circuit and counts as one point of interest.

`only = "rides"` keeps only the overview and the ride pans, for test playlists.

## 8. Timing

The still time follows one rule: a park plays for 30 s (`park_time`) with up to 4 views, and each
further view adds 5 s (`view_time`), 1 s of it to the overview (`overview_time`). Every view gets
at least 5 s, the rest goes to the close-ups by score, and the overview always holds at least
2 s longer than any close-up.

With panning on (any `pan` > 0), each generated view's time is its still time plus the moving
time of its pan to the next view (`pan_timing`): the pan's length at the zoom it runs at over
`route_speed` (60%) of the speed tolerance there, at least `move_min` (2 s), so the pan share
differs per view. The park's time grows with the moving time up to `park_cap` (150 s); over it
beads go first, then the lowest-scoring close-ups.

## 9. Variants

`circuit_variants` (1) asks for that many orders of the circuit per park, the cheapest first and
the rest within `variant_margin` (10%) of it (`circuit_reverse` adds each order's reverse). The
plugin plays the next order on each visit to the park; the visit count persists across runs.

## The older method

Method `grid` picks the busiest 32-tile cells, all at one zoom, each held for `hold`.

## Checking the result

Every build writes `<sequence>.scores.json` with why each view was picked (scores, fills,
nudges, beads, timing, the ride runs considered and turned down), `--route` prints the route
metrics per park, and `tools/renderviews.py` renders every view with the pans drawn over them.
The build warns about listed or editor views that look outside a park's content.
