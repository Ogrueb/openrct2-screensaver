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
- Tiles show the park's embedded preview (the 250x200 screenshot every `.park` saved since park
  version 52 carries, chunk `0x39`); parks without one show "No preview available". Sidecar pictures
  (an overview rendered by the generator, or captured when a park plays) are reassessed after that. In
  the owner's 147-park library, 84 carry a preview and 63 (older park versions) do not.

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
2. **Gallery folders.** A `gallery` folder in the user directory and a list of added folders, a cached
   index (on `FileIndex`, as scenarios and objects have) of name, map size, date and preview, a Gallery
   button in the Load window (opening the gallery in grid view across its folders), Add folder and Add to
   gallery.
3. **The editor's Parks panel** (after the standalone live-editor work): a read-only `gallery` scripting
   API (entries with path, name, map size, date, picture) and path arguments for Add park and New playlist,
   so the editor draws the gallery as tiles and adds ticked parks without the system dialog.
