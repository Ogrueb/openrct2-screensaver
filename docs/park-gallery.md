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
   renders a park at its saved rotation framed on its built area: tiles with two or more elements besides
   the surface (one when none has two), weighted by the count squared, 1% of the weight trimmed per side
   (the generator's content box), every element's height counted, plus a margin; the closest zoom level
   that fits, and past the widest (3) a larger render reduced by a whole factor keeping each block's most
   common colour; the void transparent. The Load window renders each shown file that has no render, one
   at a time in the background (its own executable, hidden, low priority), into `<cache>/previews/`
   named from an FNV-1a hash of path, size and modification time (a failure leaves `<hash>.none`), and
   tiles and the preview pane prefer the render (minimap mode keeps the minimap). 250x200, the pane's size.
3. **Gallery folders.** A `gallery` folder in the user directory and a list of added folders, a cached
   index (on `FileIndex`, as scenarios and objects have) of name, map size, date and preview, a Gallery
   button in the Load window (opening the gallery in grid view across its folders), Add folder and Add to
   gallery.
4. **The editor's Parks panel** (after the standalone live-editor work): a read-only `gallery` scripting
   API (entries with path, name, map size, date, picture) and path arguments for Add park and New playlist,
   so the editor draws the gallery as tiles and adds ticked parks without the system dialog.
