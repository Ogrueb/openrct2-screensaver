# Linux test pass

The test plan for the Linux engine build (`docs/enhancements.md`, Linux item, requirements 4 and 5) on
the owner's Fedora VM in VirtualBox. Work through the parts in order; each row is a box to tick or a
note to write. Anything that fails goes to `docs/known-issues.md` with the display server named
(X11/XWayland or Wayland), or comes back to a cloud session as a fix.

Record for every run: Fedora release (`cat /etc/fedora-release`), session type
(`echo $XDG_SESSION_TYPE`), the engine run number the tarball came from, and the renderer.

## 0. Prepare the VM (once)

**VirtualBox settings** (VM powered off):
- Display → Screen: Graphics Controller **VMSVGA**, Video Memory 128 MB or more, **Enable 3D
  Acceleration** on (without it only the software renderer can be tested; note which you had).
- Guest Additions installed in Fedora (`sudo dnf install virtualbox-guest-additions`, then reboot), so
  the VM window resizes the desktop and the mouse integrates.
- A shared folder or drag-and-drop to copy files in from the Windows PC.

**Packages** in a terminal:
```sh
sudo dnf install git python3 python3-tkinter
python3 --version          # 3.11 or later
```
`python3-tkinter` is only for the settings page's file dialogs.

**RCT2 data files**: copy the whole RCT2 install folder from the PC (the one holding `Data/`,
`ObjData/`, `Tracks/`) to, say, `~/RCT2`. OpenRCT2 asks for it on first start.

**The patched engine**: download the artifact `openrct2-v0.5.6-openrct2-screensaver-linux-x64` from
the latest green "Engine build" run (Actions tab of the repository; the zip holds the tarball), then:
```sh
mkdir -p ~/openrct2-ss && cd ~/openrct2-ss
unzip ~/Downloads/openrct2-v0.5.6-openrct2-screensaver-linux-x64.zip
tar -xzf openrct2-v0.5.6-openrct2-screensaver-linux-x64.tar.gz
ls OpenRCT2                # openrct2, openrct2-cli, libopenrct2.so, data/, doc/
```
The engine is now `~/openrct2-ss/OpenRCT2/openrct2`.

**The repository and parks**:
```sh
cd ~ && git clone https://github.com/Ogrueb/openrct2-screensaver.git
```
Copy the ten example park zips from the PC's `ExampleParks\` into `~/openrct2-screensaver/ExampleParks/`
(the same file names; `playlists/example.toml` finds them there).

## 1. The build starts (decides tarball vs AppImage)

```sh
cd ~/openrct2-ss/OpenRCT2
./openrct2-cli --version
ldd ./openrct2 | grep "not found"
```
- [ ] `--version` prints `v0.5.6 (… on openrct2-screensaver)`.
- [ ] `ldd` prints nothing (no missing libraries). If it lists any, write them down; try
      `sudo dnf install <the library's package>` (e.g. `dnf provides '*/libzip.so.5'`). If a library is
      missing in a version Fedora doesn't ship (a `.so.N` number Fedora lacks), the tarball fails on
      Fedora and the AppImage fallback is next: stop here and report the list.
- [ ] `./openrct2` opens the game, asks for the RCT2 folder (give `~/RCT2`), and reaches the stock
      title screen with music. Close it.

## 2. Install the screensaver

```sh
cd ~/openrct2-screensaver
python3 tools/mksequence.py playlists/example.toml --install --ignore-edits
ls ~/.config/OpenRCT2/sequence ~/.config/OpenRCT2/plugin
```
- [ ] The build runs without errors and installs into `~/.config/OpenRCT2/` (sequence folder, plugin,
      `plugin.store.json`).
- [ ] With the game running, `--install` refuses ("OpenRCT2 appears to be running"); with it closed,
      it installs. (This checks the Linux running check, `pgrep`.)

## 3. Screensaver mode, first under Wayland (Fedora's default GNOME session)

Start from the terminal so its output shows: `cd ~/openrct2-ss/OpenRCT2 && ./openrct2`.

Fonts first, as the one thing expected to differ on Fedora: the overlay looks for DejaVu or Liberation
under Debian/Arch paths (`/usr/share/fonts/truetype/dejavu/`, `/usr/share/fonts/TTF/`), and Fedora
keeps them elsewhere (`/usr/share/fonts/dejavu-sans-fonts/`, `/usr/share/fonts/liberation-sans*/`).
- [ ] **Without fonts found**: enter the mode (below) and note what text does: captions and button
      labels missing, boxes, or a crash. Missing text is the expected result; a crash is a bug.
- [ ] **With fonts**: link Fedora's DejaVu into a path the overlay knows, then restart the game:
      ```sh
      ls /usr/share/fonts/dejavu-sans-fonts/      # if empty: sudo dnf install dejavu-sans-fonts
      sudo mkdir -p /usr/share/fonts/TTF
      sudo ln -s /usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf /usr/share/fonts/TTF/
      sudo ln -s /usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf /usr/share/fonts/TTF/
      ```
      Text now shows. (Captions styled with Segoe UI or Georgia fall back to DejaVu on Linux;
      expected.)

The mode (rows as in `docs/testing.md` "Screensaver mode" and "Plugin follows the mode"):
- [ ] The main menu has the Screensaver button with its monitor-and-park icon.
- [ ] The button goes borderless at the desktop's size and plays the playlist; the overlay is sharp
      at the screen's own resolution.
- [ ] Mouse: the controls bar shows on a move and hides with the cursor; every bar button works
      (previous/next park and view, Hold, speed, shuffle, titles, music, time of day, edit views,
      settings); the exit button bottom right leaves the mode.
- [ ] The view editor (E or its bar button) opens its panel; arrows pan, Shift faster; Play loops.
- [ ] Keys: Left/Right, Shift+Left/Right, Up/Down, Space, S, E, Esc behave as on Windows.
- [ ] Park changes dip through black (background loading); no freeze over a second.
- [ ] Esc leaves the mode: title menu back, window style as before, `~/.config/OpenRCT2/config.ini`
      unchanged (compare a copy taken before).
- [ ] `./openrct2 --screensaver` starts straight in the mode; Esc quits the game.
- [ ] Scale factor 2: Options → Display → scale 2.0, enter the mode again; icons and text sharp and
      the right size. Back to 1.0 afterwards and check once more.

Sound (PipeWire on current Fedora):
- [ ] Effects and ride music play; the music button switches ride music on and off.
- [ ] Sound fades out before a view change and in after it; a park change cross-fades.

Mode settings (the settings panel, patch 0014):
- [ ] Renderer: software, software multithreaded, OpenGL (only with 3D acceleration on). Each draws
      the park correctly; note which fail or look wrong.
- [ ] Volumes, weather effects and time of day (day, night, cycle) change what they should.
- [ ] Window style: borderless, windowed, fullscreen. Under Wayland the compositor may refuse to move
      or resize the window from the program; write down exactly what each choice does.

## 4. The same under X11 (XWayland)

Fedora's GNOME session has no X11 login any more; force the game onto XWayland instead:
```sh
SDL_VIDEODRIVER=x11 ./openrct2
```
(`SDL_VIDEODRIVER=wayland` forces native Wayland; the default may already be either, so note what
`echo $XDG_SESSION_TYPE` says and which driver the run used.) Repeat in part 3: the borderless
window and its size, the mouse rows, scale 2, the renderers and the window styles.

## 5. Tools with the Linux binary

Set `E=~/openrct2-ss/OpenRCT2/openrct2` first. Each tool once; on failure keep the output.
- [ ] Settings page: `./settings.sh` opens the page in the browser (logs in `build/logs/`); a second
      `./settings.sh` only opens the page again. Set the OpenRCT2 path to `$E`, Build, Install
      (game closed), Render previews.
- [ ] Renders: `python3 tools/renderviews.py build/sequence/<name>.playlist.json --openrct2 $E`
      writes `build/renders/index.html` with pictures (not black or empty). Try `openrct2-cli` in
      place of `openrct2` if the GUI binary fails headless.
- [ ] Drawing page: `python3 tools/drawviews.py playlists/example.toml --openrct2 $E` renders the
      four angles and opens the page; drawing a box saves.
- [ ] Import: `python3 tools/importparks.py <a download with an .sv6> -o ~/rct-library --openrct2 $E`
      converts the save; a download with loose objects installs them under
      `~/.config/OpenRCT2/object/rct-screensaver/`.
- [ ] Performance: `python3 tools/perfrun.py run perf/quick.toml --exe $E` runs its cells in sandboxes
      (the game starts in the mode and quits by itself) and writes `report.md` under `build/perf/`.
      The VM's numbers mean nothing; only that it runs.

## 6. Report back

Send the ticked list, the notes on fonts, renderers and window styles, and any terminal output from
failures. Fixes known in advance: the overlay's font paths for Fedora (a small engine patch change, to
make step 3's symlinks unnecessary).
