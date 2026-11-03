# Wallpaper wrapper: screensaver mode design (agreed 2026-10-31)

Roadmap step 2. Evaluated and scoped in thread "Evaluate screensaver and wallpaper wrapper
approaches" (owner, 2026-10-31). Effort is given in PRs and live test rounds on the owner's PC, not
calendar time. File and function names below were read from the v0.5.6 source (`engine/VERSION`);
anything marked *(verify)* still needs a spike.

## Scope (owner, 2026-10-31)

- **MVP: one normal borderless window** showing the screensaver with our own minimal UI.
- **Multi-monitor is out of scope.**
- **No wallpaper or screensaver hosting of our own.** Putting a window behind the desktop icons
  (WorkerW) or running as a `.scr` is per-OS work left to tools such as Lively Wallpaper, Wallpaper
  Engine or a screensaver launcher. Our job is to be an app they can start.
- **A screensaver mode inside the game**, entered from a main menu toggle or a launch flag.
- **The mode's settings are separate** from the game's: entering the mode never changes
  `config.ini`.
- **The main menu is left alone except for the toggle button.** The view editor and our other
  title-screen additions move into the mode, which keeps our exposure to upstream changes small.

## How OpenRCT2 draws a frame (v0.5.6)

- `X8DrawingEngine::PaintWindows` (`src/openrct2/drawing/X8DrawingEngine.cpp`) calls
  `WindowDrawAll`, which draws every window into the 8-bit screen buffer, in game pixels. The park
  itself is one of these windows: the main window's viewport. The title menu, exit, options, logo
  and version windows sit on top of it.
- The software engine (`HardwareDisplayDrawingEngine::Display`,
  `src/openrct2-ui/drawing/engines/HardwareDisplayDrawingEngine.cpp`) converts the buffer to 32-bit
  through the palette into an SDL texture, scales it to the window (OpenRCT2's scale factor),
  `SDL_RenderCopy`s it, and calls `SDL_RenderPresent`. The debug "dirty visuals" overlay is already
  drawn between the copy and the present, which is the same place our overlay goes.
- The OpenGL engine (`OpenGLDrawingEngine::EndDraw`/`Display`) applies the palette in a shader into
  the screen framebuffer, then `SDL_GL_SwapWindow`. Our overlay goes in just before the swap.
- These are the only two engines in v0.5.6 (`DrawingEngine::softwareWithHardwareDisplay`, `openGL`).

The overlay therefore draws at the window's real resolution, after scaling. On the owner's 4K
monitor at scale 2.0, captions and editor text get 3840x2160 pixels, not the 1920x1080 game pixels.

## The engine patch

New code lives in new files (`src/openrct2-ui/screensaver/`), and upstream files get one-line hooks
into them, so a rebase onto a new OpenRCT2 release touches few lines. These would be patches 0011
onwards, in the order they would be built:

### 0011: the mode

- `Screensaver::Enter()` / `Exit()` / `IsActive()`. On entering, the title-screen windows are
  closed (`titleMenu`, `titleExit`, `titleOptions`, `titleLogo`, `titleVersion`, changelog) rather
  than hidden. Closed windows draw nothing and take no input, and no window code changes. On
  leaving, the title scene reopens them as it does on load (`TitleScene`).
- While the mode is on, `WindowDrawAll` draws only the main window. Plugin windows still exist
  (the editor's old window, companion stand-ins) but never show. This is a one-line check in
  upstream `Window.cpp`.
- **Settings overrides in memory:** the mode applies its own window style (borderless fullscreen),
  title music (patch 0002's ride music or a theme), game speed, the 40 fps cap and its effects
  settings (see "Performance in the mode") on entry, and restores the
  previous values on exit, without `Config::Save`. The values come from the plugin (see below), so
  they are stored in our plugin storage, never in `config.ini`.
- **Launch flag** `--screensaver` (`src/openrct2/command_line/RootCommands.cpp`, one table entry):
  starts on the title screen with the mode on and the window borderless. This is what wallpaper and
  screensaver tools run. Esc in a flag launch quits the game (owner, 2026-10-31), as there is no
  menu the user came from; entered from the menu, Esc goes back to the menu.

### 0012: the main menu toggle

One more image button in `TitleMenu.cpp`'s widget list, beside the four existing ones, calling
`Screensaver::Enter()`. This is the only change to the main menu. Its sprite would be one of the
game's own images, or a small image of ours registered at startup *(verify which is less code)*.

### 0013: the overlay

A retained scene of elements that the plugin describes and the engine draws:

- **Elements:** rectangles (fill color with alpha, optional border), text (size, weight, color,
  alignment, wrap width), and images (a PNG from our install folder: a logo, icons). Each element
  has an id, a position in game pixels (so the plugin keeps working in the coordinates it already
  uses), an opacity, and an optional fade the engine runs by itself (`opacity` to a target over
  `ms`), so a fade costs no plugin work per frame.
- **Rendering:** on change only, the engine rasterizes the scene on the CPU into an RGBA buffer at
  window resolution. Text uses FreeType, which the Windows build already links for OpenRCT2's TTF
  support (`src/openrct2/drawing/TTF.cpp`). Each frame it uploads the buffer only if it changed and
  composites it with alpha blending: an `SDL_Texture` with `SDL_BLENDMODE_BLEND` in the software
  engine, and a textured quad in OpenGL (a small shader, or a blit of a framebuffer with the overlay
  as its texture) *(verify the simplest GL path)*.
- **Font:** an open-license font (for example Inter or Noto Sans, OFL) shipped beside the plugin,
  with a system font as fallback. The game's sprite font stays available for text that should look
  like RCT.

### 0014: input for the mode

- Mouse events (move, button down/up, wheel), in game pixels, go to one plugin callback while the
  mode is on. The plugin hit-tests its own elements, so the engine needs no widget code.
- Keys keep using the plugin's existing shortcuts (`ui.registerShortcut`), which already work on
  the title screen. Esc leaves the mode.

### Plugin API (new global `screensaver`, registered in `src/openrct2-ui/scripting/UiExtensions.cpp`)

```ts
screensaver.active: boolean;                       // read
screensaver.enter(settings?: ModeSettings): void;  // window style, title music, speed
screensaver.exit(): void;
screensaver.onChange(cb: (active: boolean) => void): void;   // menu button, flag, Esc
screensaver.onMouse(cb: (e: MouseEvent) => void): void;
screensaver.overlay.set(id: string, element: OverlayElement): void;
screensaver.overlay.remove(id: string): void;
screensaver.overlay.clear(): void;
screensaver.overlay.fade(id: string, opacity: number, ms: number): void;
screensaver.overlay.measureText(text: string, style: TextStyle): { width: number; height: number };
```

Callbacks sit on our own object, like `ScSocket`'s, so no new hook types are added to upstream's
`HookEngine`.

## How the UI is served (plugin side)

The plugin owns all UI logic. It builds the overlay scene from a small widget kit of its own (TS, in
`plugin/src/ui/`): panel, label, button, list, slider, and drag box with handles. Every widget is a
handful of overlay elements plus a hit rectangle for `onMouse`.

- **Captions:** the park name with its builders as a byline (NEDesigns data via the park profiles,
  carried in the playlist), "Show titles" Overview / On / Off. They fade in and out with real alpha.
- **Load cover:** the park-switch fade becomes an overlay rectangle with real alpha, in place of
  the dithered black window (`plugin/src/cover.ts`). On the patched engine with background loading
  it is rarely needed anyway.
- **Controls bar:** shown when the mouse moves and hidden after a few seconds, like a video
  player: previous/next view and park, hold, speed, shuffle, editor, and exit. The keys stay as
  they are.
- **View editor:** rebuilt on the widget kit inside the mode, with the drag boxes the roadmap
  planned for this stage. Its data and saving (`RCTScreensaver.edits`, `--install` pulling them
  into `<playlist>.views.json`) stay as they are. Only its window changes.

## Other adjustments

- **Playback only in the mode.** Today the plugin autostarts on every visit to the title screen.
  It will start on `screensaver.onChange(true)` and stop on exit, and the stock title screen goes
  back to the user's own title sequence.
- **Nothing added to the stock title screen.** The toolbox entries ("edit views", "restart
  playlist", "toggle debug log") and the E key outside the mode go, and so does the editor's OpenRCT2
  window. The debug log toggle moves into the controls bar or the settings.
- **Mode settings in plugin storage.** `RCTScreensaver.settings` gains the window style and title
  music. The settings page and `mksequence.py --install` write them there, and
  `set_title_music` stops editing `config.ini` (a change from the 2026-10-31 decision that
  `--install` sets `title_theme`, now that the mode can apply it itself).
- **Two instances.** A flag launch by a wallpaper tool while the user plays OpenRCT2 normally would
  share `plugin.store.json`, and the last instance to write wins. Wallpaper tools can pass
  `--user-data-path` to a folder of its own if that matters. This is noted, not solved, for the MVP.
- **Stock engine.** The mode needs the patched build. On the stock engine the plugin keeps playing
  on the title screen as now, without captions or the new editor, and cuts between parks (its
  fade through a black window and the generator's palette rewrite, stopgaps for the stock engine,
  were dropped for the release; owner, 2026-11-03).
- **Packaging:** the README's "Running it" section covers the flag and wallpaper tools (Lively,
  Wallpaper Engine), including that a window behind the desktop icons gets no keyboard input. A
  "Launch screensaver" button on the settings page was planned and not built.

## Performance in the mode (owner, 2026-10-31)

The mode adds no savings of its own over the stock title screen; it only sets a few options on
entry, in memory, and restores them on exit:

- **40 fps, imposed.** The mode turns `uncap_fps` off, so `Context::RunFixedFrame` draws once per
  game tick (40 per second) and sleeps in between. Uncapped, `RunVariableFrame` draws as fast as
  vsync allows, but the plugin moves the camera once per tick, so the extra frames buy nothing.
- **Multithreaded drawing is inherited** from the stock settings, not set by the mode.
- **Extra effects default to off** in the mode's settings: light effects (`enable_light_fx`, which
  also takes the slower `LightFx::RenderToTexture` path in `Display`) and weather gloom. The user
  can turn them on there.

A flag launch also skips the menu by its nature, so it needs no adjustments of ours. Our own work
stays light: the overlay rasterizes and uploads only when its scene changes (a fade is an alpha
change per frame), and the camera and debug logs stay off unless asked for.

Anything beyond this, such as updating guests and vehicles out of view less often (a change to the
game's core update loop), is left to roadmap step 3, performance testing.

## Upstream files touched

| File | Change |
|---|---|
| `openrct2/interface/Window.cpp` (`WindowDrawAll`) | skip non-main windows while the mode is on |
| `openrct2-ui/windows/TitleMenu.cpp` | one button |
| `openrct2-ui/drawing/engines/HardwareDisplayDrawingEngine.cpp` (`Display`) | composite the overlay before present |
| `openrct2-ui/drawing/engines/opengl/OpenGLDrawingEngine.cpp` | composite the overlay before swap |
| `openrct2/command_line/RootCommands.cpp` | `--screensaver` |
| `openrct2-ui/scripting/UiExtensions.cpp` | register `screensaver` |
| mouse input dispatch in `openrct2-ui/input/` | forward events while the mode is on *(verify the spot)* |
| build files (`CMakeLists.txt`, the Visual Studio project) | the new files |

Everything else is in new files.

## Order of work

1. Spike on the PC: an overlay rectangle and a line of FreeType text composited in both engines at
   scale 2, and the title windows closed and reopened. 1 PR plus a test run.
2. 0011 and 0012 with the plugin starting and stopping on the mode, plus the settings move. 1-2 PRs.
3. 0013 and the plugin's widget kit, then captions and the load cover. 2 PRs.
4. 0014 and the controls bar. 1 PR.
5. The editor rebuilt in the mode, with drag boxes. 2-3 PRs and the owner's review rounds.

## Progress

**2026-10-31, first patches (0011-0013): step 1 (the spike) passed.** Written in thread "Build
screensaver mode engine patches". On the owner's PC (4K, scale 2.0) in both the software and
OpenGL engines: the menu button, the overlay panel and its text, mouse events, the plugin's keys,
Esc back to the menu, `--screensaver` straight into the mode with Esc quitting, and `config.ini`
untouched by the mode. Seen in the test and expected at this step: the plugin's playback (and a
held view) carries on after leaving the mode, as it does not follow the mode yet (step 2). Where
the patches differ from the plan above:

- **Patch order:** 0011 is the mode with the launch flag, Esc, mouse forwarding and the
  `screensaver` API; 0012 the menu button; 0013 the overlay. The planned 0014 (input) is folded
  into 0011.
- **No change to `Window.cpp`'s drawing.** Hiding windows in `WindowDrawAll` alone would leave
  stale pixels: `WindowDraw` and the viewport-shift code skip what an opaque window covers. The
  mode instead marks every window but the park's own transparent and invisible (the state the
  window code already treats as "draw the park under it, nothing of it"), each tick for new
  windows, and restores both flags on exit.
- **Settings stay out of `config.ini`** through a save hook in `Config::Save` (`SetSaveHook`):
  while the mode is on, a save made for any reason (window moved, display changed) writes the
  user's own values for the fields the mode overrides.
- **The flag enters on the first tick** of the title screen, so the stock window can show for a
  frame before going borderless.
- **Menu button:** no sprite fits, so it draws a play triangle; tooltip "Screensaver".
- **OpenGL:** a textured quad with a small inline shader (the stock shaders are data files of the
  install, which we do not change), drawn into the back buffer just before the swap. Premultiplied
  alpha in both engines (an SDL custom blend mode in the software engine, falling back to plain
  blending with a warning).
- **Fonts:** `style.font` (a path, absolute or under the user `plugin` folder), else
  `overlay.setDefaultFonts`, else Segoe UI (Arial) on Windows. No font is shipped: the plugin names
  system fonts by file (Segoe UI, Georgia) and the engine's default sans stands in where they are missing.

**2026-11-01, step 2: the plugin follows the mode.** On the patched engine (`screensaver` present,
`plugin/src/mode.ts`) the plugin no longer autostarts: playback starts when the mode comes on and
stops when it goes off, handing the title screen back to the user's own title sequence (a held view
goes with it); its keys act only in the mode; no toolbox entries. At startup it passes the mode its
settings from `RCTScreensaver.settings`: `window` (default "borderless"), `titleMusic` ("keep",
"ride", "theme"; written by `--install` from the playlist's `title_music`, which no longer edits
`config.ini`), `lightEffects` and `weatherGloom` (default off). Speed stays the plugin's own. Until
the editor is rebuilt in the mode (step 5), E does nothing on the patched engine, as its window
would not show. (Rebuilt on the overlay 2026-11-02: `docs/screensaver-ui.md`, "View editor".) The stock engine keeps the old behavior (autostart, toolbox entries, editor). Passed on
the owner's PC the same day (title music with "ride" not yet tried).

API as built (patch comments carry the details):

```ts
screensaver.active / launchedByFlag / settings            // read
screensaver.cursorVisible                                  // read/write, while the mode is on
screensaver.enter(settings?) / exit() / configure(settings)
// settings: { window: "keep"|"windowed"|"borderless"|"fullscreen", titleMusic: number|null,
//             gameSpeed: number|null, lightEffects: boolean, weatherGloom: boolean }
screensaver.onChange(cb: (active: boolean) => void)
screensaver.onMouse(cb: (e: { type: "move"|"down"|"up"|"wheel", x, y, button, delta }) => void)
screensaver.overlay.set(id, { type: "rect"|"text"|"image", x, y, width, height, opacity, z,
    fill, border, borderWidth,                             // rect; colours "#rgb", "#rrggbb(aa)"
    text, font, size, bold, colour, align, wrap, lineHeight, shadow,   // text
    src })                                                 // image (PNG)
screensaver.overlay.remove(id) / clear() / fade(id, opacity, ms)
screensaver.overlay.measureText(text, style) / setDefaultFonts(regular, bold?) / scale
```

The spike's throwaway test plugin was removed once the mode's UI replaced it (checks in `docs/testing.md`).

## Considered and dropped

- Own front end on `libopenrct2` (one simulation, any number of viewports): C++ instead of Python,
  sound and input to rebuild, no stable core API, GPLv3 linking. It only paid off for multi-monitor.
- Own wallpaper host (WorkerW/Progman parenting, tray icon, socket controls) and own `.scr` host:
  per-OS, left to other tools.
- Host-drawn caption overlay (a layered window over the game): replaced by the engine overlay.
- In-game captions drawn with plugin windows and the game font: no alpha, game-pixel resolution.
- One game per monitor, or one window spanning the desktop: multi-monitor is out of scope.
