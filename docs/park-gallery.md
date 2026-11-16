# Park gallery

A persistent library of parks with pictures, first in the stock game's Load window, then in the
screensaver mode's editor as an alternative to the system's file dialog (owner, 2026-11-15, thread
"Explore a park gallery"; options and the library survey in the project files' Claude Doc "Park gallery:
implementation options").

## Decisions (owner, 2026-11-15)

- Engine patches that stand alone on stock OpenRCT2, kept free of screensaver code, so they could go
  upstream; no upstream offers until our builds are complete.
- The gallery is a list of folders (the user's `gallery/` folder plus folders added to it, indexed in
  place without copying).
- One library: the gallery is also the screensaver's park folder, where Add park and New playlist put
  imported parks (Phase 2).
- Tiles first showed the park's embedded preview (the 250x200 screenshot every `.park` saved since park
  version 52 carries, chunk `0x39`; in the owner's 147-park library 84 carry one, 63 older ones and every
  `.sv6` do not). Owner's test the same day: the grid works, but the embedded screenshots are random crops
  around the saved view that rarely show anything characteristic, so the gallery makes its own renders,
  and the engine makes them (owner's pick over the generator, so the gallery stays standalone).
- Render cost accepted (owner, 2026-11-16): each render can cost the title park 10-15 frames while it
  runs; it is a one-off per park, cached afterwards, and a renderer outside the engine stays out of scope.

## Stages

1. **Grid view in the Load window** (engine patch 0021, 2026-11-15). The customize menu (the ▼ beside
   the column headers) gets List view and Grid view (`file_browser_grid_view` in `config.ini`). Each file
   is a tile with its preview reduced by whole steps to at most 125x100 (palette images are sampled, not
   blended), the kind the preview setting picks (screenshot or minimap, falling back to the other), and
   its name below; folders show their icon. Hovering a tile fills the preview pane as a row does.
   Previews of visible tiles are read one at a time on the background worker and kept for the session
   (512 at most, keyed by path and modification time); each has its own image slot while the window is
   open (a shared temporary sprite would show one picture in every tile under OpenGL). Tracks and
   heightmaps keep the list. Strings are plain English literals for now (as the other patches do);
   an upstream version would add language strings.
2. **Preview renders** (engine patch 0022, 2026-11-15). `openrct2 screenshot <file> <image> preview <w> <h>`
   renders a park at its saved rotation framed on its built area. The built area is the generator's content
   box: tiles with two or more elements besides the surface (one when none has two), weighted by the count
   squared, 1% of the weight trimmed per side, leaving out a backdrop (elements alike on over 30% of the
   map's tiles: the same type at the same heights, as the generator's `cover_share`, or the same scenery
   object at any height; the generator's data showed a large scenery sheet at height 2 over 65-97% of The
   Blizzard, Orbis Sky Castle and Studio Ghibli). The frame holds the box's built tiles by weight in screen
   space, 5% trimmed off the left, right and bottom and 2% off the top (a tower keeps its tip), plus a 2%
   margin: a park's tiles make a diamond on screen, so framing all of it left the corners to the backdrop
   (owner's test 2026-11-16: small parks "mostly empty"; in the renders the park filled a third of the frame
   while the box itself was right). Zoom -1 to 3 with a whole reduction of up to 8 (any past zoom 3),
   whichever fits closest, the reduction keeping each block's most common colour; the void transparent.
   The Load window renders each shown file that has no render, one at a time in the background (its own
   executable, hidden, idle priority; on Windows the render also enters background mode, lowering its
   disk and memory priority, after the owner saw the title park slow down), into `<cache>/previews/`
   named from an FNV-1a hash of a render version, path, size and modification time (a failure leaves
   `<hash>.none`; a new version redoes both), and tiles and the preview pane prefer the render (minimap
   mode keeps the minimap). 250x200, the pane's size. The subcommand takes no data path options
   (`Unknown option`), so a render uses the default user folder's settings. Owner's test 2026-11-15:
   every park rendered (41 of 41, `.sv6` included), cached across restarts, a few seconds each.
3. **Gallery folders** (engine patch 0023, 2026-11-16, after the owner found the renders "serviceable at
   this stage"). A Gallery button (two stacked pictures drawn to fill the button, left of the folder buttons; Load Game only) lists the parks
   in the user directory's `gallery` folder (made on first use) and in the folders added to it, subfolders
   included, as a grid whatever the view setting; the title reads "Park gallery" and the path line the
   gallery folder plus the number of added ones. The customize menu adds the shown folder ("Add this folder
   to gallery", grayed when it is one already), and in the gallery "Add folder to gallery..." (the system's
   folder dialog) and "Remove <folder>" for each added one. Added folders are `file_browser_gallery_folders`
   in `config.ini`, separated by `|`. The default-folder button leaves the gallery. Not yet: a cached index
   of name, map size and date (on `FileIndex`, as scenarios and objects have), left for stage 4, where the
   scripting API needs it; the list reads files as the Load window always has. Owner's test (2026-11-16):
   every item passes, the larger icon included; a folder of zip downloads lists nothing (the Load window
   reads only `.park` and `.sv6`).
4. **The editor's Parks panel** (after the standalone live-editor work): a read-only `gallery` scripting
   API (entries with path, name, map size, date, picture) and path arguments for Add park and New playlist,
   so the editor draws the gallery as tiles and adds ticked parks without the system dialog.

## The screensaver editor's pane (2026-11-16)

The pane that uses stage 4's API is the plugin's `ui/gallery.ts`, described in `docs/screensaver-ui.md` "The
park gallery pane": tiles with the preview renders, filters, picks in order, then Add or New playlist with the
picked paths. The generator's part is `--park-list`, `--live-new-parks` and `--gallery-details` in
`tools/mksequence.py` (tests in `tools/tests/test_gallery.py`).
