# Engine patches

Patches against the OpenRCT2 release named in `VERSION`, applied in file-name order. Design
and plan: `docs/engine-patches.md`.

- `patches/*.patch`: `git format-patch` output, one commit per patch.
- `.github/workflows/engine.yml` builds Windows x64 binaries on GitHub Actions (same scripts as
  OpenRCT2's own CI, 25 to 40 minutes) and uploads `openrct2.exe` and `openrct2.com` as an
  artifact. Installing a build means replacing those two files in a stock install of the same
  release; the data files are unchanged by the patches.
  Its `Linux x64` job (OpenRCT2's Ubuntu 24.04 portable recipe) uploads a whole portable build
  instead, `openrct2-<tag>-openrct2-screensaver-linux-x64.tar.gz` (an `OpenRCT2/` folder with the
  `openrct2` binary, `libopenrct2.so` and `data/`): untar it and run `./openrct2` from the folder.
  Untested on a desktop yet (`docs/enhancements.md`, Linux item).

A release build leaves out 0016 (diagnostics): run the workflow by hand with "Release build" ticked,
which applies 0001-0015 only.

To work on a patch locally, clone OpenRCT2 at the release tag, `git am` the patches in order,
edit (`git rebase -i` to change an earlier patch), and regenerate the whole series in one run with
`git format-patch --zero-commit --no-signature -N v0.5.6 -o <repo>/engine/patches`, after
clearing the folder, so the headers stay uniform.

## The series

Grouped by topic, the groups that could go upstream first, so each group applies on its own
on top of the ones before it. Comments in the patches name no project and use US English.

| Patch | Group | What it does |
|---|---|---|
| 0001 | Palette | The interface keeps the stock black when a water object lightens index 10 |
| 0002 | Ride music | "Ride music" as a title screen music choice, cross-faded across park loads |
| 0003 | Background loading | Read the next park and its objects on a thread |
| 0004 | Background loading | Import the next park into a second game state, then swap |
| 0005 | Background loading | A backward seek keeps background loading |
| 0006 | Background loading | Register the next park's objects a few milliseconds per tick |
| 0007 | Background loading | Switch parks only once all objects are registered |
| 0008 | Plugin API | `TitleSequence.backgroundLoading` |
| 0009 | Plugin API | `TitleSequence.fadeSounds(level, ms)` |
| 0010 | Plugin API | `TitleSequence.nextParkReady` and `holdSwitch` |
| 0011 | Screensaver mode | The mode: settings in memory, `--screensaver`, Esc, mouse to the plugin |
| 0012 | Screensaver mode | The main menu's Screensaver button |
| 0013 | Screensaver mode | The overlay at the window's resolution |
| 0014 | Screensaver mode | Renderer, volumes, weather and time of day settings |
| 0015 | Screensaver mode | The menu icon and game sprites on the overlay |
| 0016 | Diagnostics | Park load timings and the perf log (`--perf-log`); test builds only, dropped for release |

The final patched tree is the same as before the regrouping apart from comments.

## Numbering before 2026-11-03

Older notes, commits and PRs use the numbers by date. Old to new: 0001 → 0016 (timings),
0002 → 0003, 0003 → 0004, 0004 → 0008, 0005-0007 unchanged, 0008 → 0001, 0009 → 0002, 0010 → 0009,
0011-0013 unchanged, 0014 → 0010, 0015 → 0016 (perf log), 0016 → 0014, 0017 → 0015.
