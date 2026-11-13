# Performance testing (roadmap: potential enhancements, with the overnight soaks)

Every test is an unattended, scripted run on the PC. The game writes a perf log, and a report
script turns the logs into numbers and A/B verdicts, so nothing has to be judged by eye.
Plan and decisions: Claude Doc "Performance testing: process sketch" (owner, 2026-11-02).
Owner's answers: the perf patch stays in every build until release, as this is the last phase
before release. Runs use sandbox user folders. Overnight runs start only after the owner's
explicit OK, every time. The survey takes a sample of 20 parks. PresentMon comes later, after
the first results.

## Parts

| Part | What it does |
|---|---|
| Engine patch 0021 | `--perf-log <file>` writes the perf log (format below). `--perf-quit-after <s>` quits after that many seconds. `--no-background-loading` loads title parks the stock way, for A/B runs (`TitleSequence.backgroundLoading` then reads false). Plugin API: `screensaver.perfLog` and `screensaver.perfMark(text)`. |
| Plugin | Every camera-log event (`view`, `move`, `stop`, `change`, `plan`, ...) and each park load goes into the perf log as a mark, whether or not the camera log is on. The `bench` setting plays the first order of every park, never shuffles, and turns mouse input into an `input` mark instead of showing the controls bar. `profilerExport` starts OpenRCT2's function profiler and exports it every minute. |
| `tools/perfrun.py` | `run`: runs a suite's cells in sandboxes, then calls the report. `sample`: writes a playlist of parks spread over simulation size. `baseline`: keeps a run's report as the suite's baseline. |
| `tools/perfreport.py` | Labels each frame (still or panning, zoom, park, view, park switch) and computes the numbers per group. It also compares a run with a baseline, or pairs of cells within a run. |
| `perf/*.toml` | Five suites: quick, renderers, survey, features, soak. |

## Running on the PC

These steps run in a Remote Control session in `RCT\RCT-screensaver`. Each one names how long
it takes. Before any run longer than an hour, ask the owner.

1. **Install the build.** Download the "Engine build" artifact for the commit you are testing
   (Actions, "Engine build"). Put `openrct2.exe` and `openrct2.com` into a copy of the portable
   v0.5.6 install, for example `RCT\openrct2-perf\`, so the everyday install stays as it is.
   Below, `<exe>` is that `openrct2.exe`.
2. **Close OpenRCT2.** Leave the PC alone during a run: mouse movement is marked, and those
   seconds are left out of the numbers.
3. **Quick suite** (10 min). Use it after every engine or plugin change.
   `python tools\perfrun.py run perf\quick.toml --exe <exe>`
   The first good run becomes the baseline:
   `python tools\perfrun.py baseline build\perf\quick-<stamp> quick`
   Later quick runs are compared with `perf/baselines/quick.json` (kept on the PC, not committed), and the command
   exits with code 1 when a number got worse beyond the threshold (5%) and the repeats' spread.
4. **Bench and sample playlists** (once, about 6 s per park read):
   `python tools\perfrun.py sample ..\MoreParks-library --count 4 --out perf\local\bench.toml`
   `python tools\perfrun.py sample ..\MoreParks-library --count 20 --survey-views --out perf\local\survey.toml`
   Both pick parks spread evenly over guests plus ride vehicles. The largest park is always
   included, so Europa-Park comes in if it is in the folder. Each park's counts are written as
   a comment, and in `*.sizes.json` beside the playlist. `perf/local/` is not committed.
5. **Renderers × motion** (about 1.5 h, 8 cells × 2 repeats × 5 min):
   `python tools\perfrun.py run perf\renderers.toml --exe <exe>`
6. **Survey** (about 45 min): set its renderer to the one step 5 recommends (`[base.config]`).
   `python tools\perfrun.py run perf\survey.toml --exe <exe>`
7. **Features** (about 2 h 20 min): `python tools\perfrun.py run perf\features.toml --exe <exe>`
8. **Soak.** First a 1 h pass with short parks:
   `python tools\perfrun.py run perf\soak.toml --exe <exe> --only short-parks`
   Then, after the owner's OK each night, one 9 h run per suspect (a potential enhancement since
   2026-11-03, see `docs/roadmap.md`):
   `python tools\perfrun.py run perf\soak.toml --exe <exe> --only full --seconds 32400`
   Then the same with `--only no-background-loading`, `no-companions`, `opengl` or `two-parks`.
   `two-parks` needs `perf\local\two-parks.toml`, made with `sample <folder> --count 2`.

Start a long run detached, so the Remote Control session can end and does not load the PC:
`Start-Process python -ArgumentList 'tools\perfrun.py','run','perf\soak.toml',... -WindowStyle Hidden -RedirectStandardOutput build\logs\perfrun-<stamp>.log`.
The game window itself stays visible, as drawing stops while it is minimized.

Other options: `--repeats N` and `--seconds N` override the suite. `--only CELL` can be given
more than once. `--keep-sandboxes` keeps each cell's user folder. `--dry-run` makes the
sandboxes and prints the commands without running anything. `--engine NAME=PATH` adds another
build for cells that set `engine = "NAME"`. `--user-dir` points at a different OpenRCT2 folder
to copy settings from.

## What a run leaves

`build\perf\<suite>-<stamp>\`:
- `run.json`: the machine (Windows, CPU, GPU and driver, power plan, busy processes), the commit
  and the exe's hash.
- `build\<key>\`: the playlist as built for the run (`mksequence.log`).
- `cells\<cell>-r<repeat>\`: `perf.log`, `cell.json` (the cell's settings, command, exit code,
  how it ended, crash files), `stdout.log`/`stderr.log`, and `profiler.csv` where the suite asks
  for it. A cell that crashed keeps its `user\` sandbox, with OpenRCT2's dump in `user\crash\`.
- `report.md` and `report.json`.

Copy `report.md` (and `report.json` for a baseline) where the cloud side can read it: put the run
folder in the project files. Reports are not committed to the repository.

The game's crash handler (Breakpad, in every CI build) writes a dump and then asks to upload
it. The harness sees the new dump, closes the dialog without uploading after 10 s and goes on.
If a crash leaves no dump, Windows' LocalDumps registry key is the fallback. It needs an admin
change, so ask the owner first.

## Reading a report

- **Work** is the time spent per frame: simulation, plugin, input, paint and present. Against
  the 25 ms budget, it shows headroom even while the mode caps drawing at 40 fps.
- **Missed** is the share of frames longer than 37.5 ms, so at least one 40 fps frame was
  lost. **Ticks/s** under 40 means the simulation fell behind.
- **sim** is the tick time minus the plugin calls inside it. **paint** is drawing the frame.
  **present** is copying it to the screen, the overlay and vsync waits.
- Groups: `still` and `pan` come from camera movement between frames. `zoom N still/pan` and
  `overview` are split the same way. Each park has its own table, the slowest views are listed
  separately, and the 5 worst frames come with their stage split.
- Park switches are left out of the play numbers and listed apart: main-thread stages, and the
  switch frame's length.
- Memory gives private MB at the start and end, MB per hour and per park switch, the QuickJS
  heap, the image list's smallest largest-free-run, and handles and GDI objects. It also names
  parks whose memory grows on every revisit.
- In the survey, "Simulation against size" is the correlation of tick time with entities and
  with guests, and ms per 1000 entities. A size filter should use whichever count fits.
- A comparison or an A/B pair counts as a change only when it is larger than both the repeats'
  spread and the threshold. Run with `--repeats 2` or more to get a spread.

## Perf log format

One record per line, comma separated, with free text only in the last field. Times are in ms
since the log was opened.

```
# rct-screensaver perf log 1
C,<t>,version=… engine=software|opengl multithreading=0|1 uncap_fps=… vsync=… scale=… fullscreen=… window=WxH
F,<t>,<interval>,<ticks>,<tick>,<script>,<input>,<paint>,<present>,<viewX>,<viewY>,<zoom>,<rotation>
M,<t>,<sampleMs>,<privateBytes>,<workingSet>,<handles>,<gdi>,<jsMalloc>,<jsUsed>,<imgUsed>,<imgFreeRuns>,<imgLargestFree>,<guests>,<staff>,<vehicles>,<litter>,<entities>,<rides>
E,<t>,load,<park> <stage>=<ms>ms … total=<ms>ms
E,<t>,mark,<plugin text: park i/n name | view park=… | move … | stop … | change … | input move>
E,<t>,quit,run time reached
```

`F` is written once per drawn frame. Its interval runs from the end of the previous drawn
frame. `tick` includes the plugin calls made during the tick, and `script` counts every plugin
call wherever it happens. `M` is written every 10 s; its own cost (`sampleMs`, the QuickJS heap
walk) is taken out of the next frame's interval by the report. Lines are flushed with every
sample and event, so a crash loses at most 10 s of frames.

## Limits

- The stock engine cannot write the perf log, and patch 0021 depends on patches 0001-0020, so
  there is no "stock" cell. Engine features are compared by turning them off in the patched
  build instead: `--no-background-loading`, ride music, sound, the plugin (the stock title
  player plays the same views) and companions.
- The screensaver mode always draws at 40 fps (`uncap_fps` off), so uncapped frame pacing is not
  a cell. The work per frame shows the headroom instead.
- OpenGL's GPU time does not appear: `present` shows only the CPU side and its waits. PresentMon
  is the later check for that. The OpenGL texture atlas is not sampled.
- "Cuts" cells are built with `motion = "static"`, the product's static setting. That also drops
  ride pans, beads and nudges, so the view set differs slightly from the "pans" cells. The
  per-zoom groups keep the comparison fair.
- The survey's simulation size comes from the live samples. Drawn size (map, built tiles,
  elements) comes from the park files, in `perf/local/*.sizes.json`.
