# Linux test pass

The test plan for the Linux engine build (`docs/enhancements.md`, Linux item, requirements 4 and 5) on
the owner's Fedora VM in VirtualBox. Work through the parts in order; each row is a box to tick or a
note to write. Anything that fails goes to `docs/known-issues.md` with the display server named
(X11/XWayland or Wayland), or comes back to a cloud session as a fix.

Record for every run: Fedora release (`cat /etc/fedora-release`), session type
(`echo $XDG_SESSION_TYPE`), the engine run number the tarball came from, and the renderer.

## Already checked headless (2026-11-04)

Run in a cloud session on Ubuntu 24.04 (the build image's own release) with the tarball from engine run
41734931011, the owner's RCT2 `Data`/`ObjData` and the ten example parks. These need no desktop, so the
VM pass below leaves them out except where Fedora itself could change the result.
- [x] `./openrct2-cli --version`: `OpenRCT2, v0.5.6 (82b3097 on openrct2-screensaver)`, plugin API 124.
- [x] `mksequence.py playlists/example.toml --install --ignore-edits`: builds (48 s) and installs the
      sequence, plugin, icons, two companions and `plugin.store.json`; the default user folder is
      `~/.config/OpenRCT2`; `--install` refuses while a process named `openrct2` runs.
- [x] `renderviews.py` with the Linux binary: all 101 renders of the example playlist (89 s), Gardens of
      Light included; `openrct2 screenshot` works with no display.
- [x] `importparks.py`: an `.sv6` download (Helios) converted with `openrct2 convert`; a download with a
      loose `.parkobj` (Concrete Jungle) installed it under `object/rct-screensaver/` and the park renders
      with it.
- [x] `drawviews.py`: renders all ten parks from four angles (40 pictures) and serves its page.
- [x] `settings.sh`: starts the server in the background, a second start only reopens the page
      (2026-11-03).

What the binary links against (`readelf -d`), the libraries Fedora may lack: `libopenrct2.so` needs
`libicuuc.so.74` (ICU 74; Fedora 42 ships ICU 76, so `.so.76`) and `libzip.so.4` (Fedora's libzip is
`.so.5`); `openrct2` needs `libFLAC.so.12`. If `ldd` in part 1 lists any of these as missing, the tarball
does not fit Fedora and the AppImage (which bundles them) is the fallback, as decided.

## 0. Prepare the VM (once)

**VirtualBox settings** (VM powered off):
- Display → Screen: Graphics Controller **VMSVGA**, Video Memory 128 MB or more, **Enable 3D
  Acceleration** on (without it only the software renderer can be tested; note which you had).
- Guest Additions: Fedora's own package only (`sudo dnf install virtualbox-guest-additions`,
  `sudo systemctl enable --now vboxservice`, reboot). Oracle's installer from the VirtualBox CD builds
  kernel modules that fail on current Fedora kernels; remove it first if it was run
  (`sudo /opt/VBoxGuestAdditions-*/uninstall.sh`). They are a convenience only: with VMSVGA the
  desktop resizes without them.
- A way to copy files in: a shared folder (needs the Guest Additions), a network share, or a USB
  stick; the engine zip can also be downloaded inside the VM.

**Packages** in a terminal:
```sh
sudo dnf install git python3 python3-tkinter
python3 --version          # 3.11 or later
```
`python3-tkinter` is only for the settings page's file dialogs.

**RCT2 data files**: copy the whole RCT2 install folder from the PC (the one holding `Data/`,
`ObjData/`, `Tracks/`) to, say, `~/RCT2`. OpenRCT2 asks for it on first start.

**The patched engine (AppImage)**: the portable tarball does not run on Fedora (2026-11-04:
`libicuuc.so.74` missing, as predicted), so the VM uses the AppImage, which carries its own libraries.
Download the artifact `openrct2-v0.5.6-openrct2-screensaver-linux-x64-appimage` from the latest green
"Engine build" run (Actions tab), then unpack it rather than mounting it (no FUSE needed, and the
tools get a plain executable):
```sh
mkdir -p ~/openrct2-ss && cd ~/openrct2-ss
unzip ~/Downloads/openrct2-v0.5.6-openrct2-screensaver-linux-x64-appimage.zip
chmod +x openrct2-v0.5.6-openrct2-screensaver-linux-x64.AppImage
./openrct2-v0.5.6-openrct2-screensaver-linux-x64.AppImage --appimage-extract
ls squashfs-root           # AppRun, usr/ (usr/bin/openrct2, usr/lib/, usr/share/openrct2/)
```
The engine is now `~/openrct2-ss/squashfs-root/AppRun` (it starts `usr/bin/openrct2` with the bundled
libraries). Everywhere below, `$E` means that path: `E=~/openrct2-ss/squashfs-root/AppRun`.

**The repository and parks**:
```sh
cd ~ && git clone https://github.com/Ogrueb/openrct2-screensaver.git
```
Copy the ten example park zips from the PC's `ExampleParks\` into `~/openrct2-screensaver/ExampleParks/`
(the same file names; `playlists/example.toml` finds them there).

## 1. The build starts

The tarball failed here (2026-11-04: `libicuuc.so.74: cannot open shared object`), as the libraries
above predicted; this part now checks the AppImage.
```sh
E=~/openrct2-ss/squashfs-root/AppRun
$E --version
ldd ~/openrct2-ss/squashfs-root/usr/bin/openrct2 | grep "not found"
```
- [ ] `--version` prints `v0.5.6 (… on openrct2-screensaver)`.
- [ ] `ldd` prints nothing. (The bundled libraries are under `usr/lib`; `ldd` on the bare binary may
      not find them without `AppRun`'s path, so if it lists some, check they exist in
      `squashfs-root/usr/lib/` before counting it a failure.)
- [ ] `$E` opens the game, asks for the RCT2 folder (give `~/RCT2`), and reaches the stock title
      screen with music. Close it.

## 2. Install the screensaver

```sh
cd ~/openrct2-screensaver
python3 tools/mksequence.py playlists/example.toml --install --ignore-edits
ls ~/.config/OpenRCT2/sequence ~/.config/OpenRCT2/plugin
```
- [ ] The install lands in `~/.config/OpenRCT2/` (checked headless; here only to set up the VM).

## 3. Screensaver mode, first under Wayland (Fedora KDE's Plasma session)

Start from the terminal so its output shows: `$E`.

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
- [ ] `$E --screensaver` starts straight in the mode; Esc quits the game.
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

Fedora KDE has no X11 login any more; force the game onto XWayland instead:
```sh
SDL_VIDEODRIVER=x11 $E
```
(`SDL_VIDEODRIVER=wayland` forces native Wayland; the default may already be either, so note what
`echo $XDG_SESSION_TYPE` says and which driver the run used.) Repeat in part 3: the borderless
window and its size, the mouse rows, scale 2, the renderers and the window styles.

## 5. Tools on the desktop

The tools themselves passed headless (above); on the VM only what needs a desktop or a browser:
- [ ] `./settings.sh` opens the page in Fedora's browser; set the OpenRCT2 path to
      `~/openrct2-ss/squashfs-root/AppRun`, Build, Install (game closed), Render previews. The Scan
      folder and Import buttons open a file dialog (needs `python3-tkinter`).
- [ ] `python3 tools/perfrun.py run perf/quick.toml --exe $E` starts the
      game in the mode in its sandboxes, quits it after each cell and writes `report.md` under
      `build/perf/` (the VM's numbers mean nothing; only that it runs and ends the game on Linux).

## 6. Report back

Send the ticked list, the notes on fonts, renderers and window styles, and any terminal output from
failures. Fixes known in advance: the overlay's font paths for Fedora (a small engine patch change, to
make step 3's symlinks unnecessary).
