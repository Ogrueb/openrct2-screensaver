# Example parks: analysis

Static analysis of the example parks (`ExampleParks/README.md` says where to download them),
produced with `tools/parkinfo.py` (reads `.park` files directly, no game data required). A snapshot
from 2026-10-23, read against OpenRCT2 `develop` of that day (park format version 63); the project
since targets v0.5.6.

```sh
python3 tools/parkinfo.py ExampleParks/*.zip
```

## Summary

| Park (in-game name) | Map | Content bounds (tiles) | Non-surface elements | Max elements / tile | Invisible elements | Rides | Guests | Objects (packed) | Plugin storage |
|---|---|---|---|---|---|---|---|---|---|
| Tin Train | 17² | 1–15 × 1–15 | 2.9k | 41 | 34 | 4 | 236 | 240 (159) | AdvancedTrack (empty) |
| Ghillie Dhu | 102² | 1–100 × 1–100 | 40k | 218 | 0 | 10 | 351 | 574 (473) | — |
| Xtreme97 Workbench 2021 (`the koi pond.park`) | 252² | 0–250 × 1–250 | 81k | 376 | 56 | 28 | 187 | 637 (533) | — |
| Qhyre Rock | 152² | 1–82 × 21–76 | 5.8k | 108 | 38 | 11 | 0 (park closed) | 434 (345) | — |
| San Avaiki | 62×67 | 1–60 × 1–65 | 45k | 126 | 524 | 114 | 718 | 887 (820) | AdvancedTrack (empty) |
| Troubadours et Baladins | 179×142 | 1–159 × 13–117 | 53k | 186 | 124 | 74 | 2,319 | 1,200 (1,148) | AdvancedTrack (empty) |
| Constellations | 122² | 1–116 × 23–96 | 79k | 170 | 2,174 | 77 | 1,183 | 1,387 (1,309) | AdvancedTrack (1 ride feature) |
| Sambhava's Rest | 152² | 1–149 × 1–149 | 103k | 643 | 4,858 | 202 | 1,582 | 1,449 (1,372) | Animator (4 animations) |
| Dream (Gardens of Light, 2 versions) | 203² | 1–194 × 15–200 | 36k | 174 | 350 | 32 | 394 | 1,108 (1,056) | 6 plugins, all empty |
| Sonnental | 257² | 6–157 × 1–132 | 35k | 264 | 43 | 25 | 429 | 679 (634) | 5 plugins, all empty |

All parks: OpenRCT2 `.park` format versions 13–40, gzip-compressed, "no money" mode.

Notes on accuracy: guest counts are the park's stored `numGuestsInPark` counter, not
an entity count. "Invisible" counts only the tile element invisible flag.

## Findings

### Map size
The largest map is 257² but all content lies within tiles 0–250, so the title
sequence `LOCATION` command's 8-bit coordinate limit does not block any of these
parks. A plugin using `ui.mainViewport.moveTo()` avoids the limit regardless.

### Objects
Every non-shipped object is packed into its park. The unpacked remainder (≈90–200
per park) are original RCT2 objects supplied by the RCT2 install.

### Companion plugins
The title sequence player loads parks via its own path
(`openrct2-ui/title/TitleSequencePlayer.cpp`, `LoadParkFromFile`) and does not call
`GameLoadScripts()`, so only `intransient` plugins run in title mode. Park plugin
storage is still loaded, but nothing consumes it.

- **Animator** (deanosrs, `local`, Sambhava's Rest): runs 4 animations stored in park
  storage on `interval.tick` (train recolor on ride entry, mist fade, scenery
  visibility). Reads but never moves the viewport. Without it the park is static and
  its hidden elements stay hidden.
- **Constellations "Object Animator"** (Simon Shepherd, `remote`): activates only when
  `park.name === "Constellations"`. Opens a control window on load and reopens it
  when closed until the eclipse has run. The eclipse animation moves the main
  viewport (tile 55,60, zoom 1, rotation 2) and changes ride open/closed status.
  Needs a shim or exclusion for unattended playback.
- **AdvancedTrack** (Oli414): Constellations stores one track feature for ride 79.
  Behavior without the plugin not yet tested.

### Unattended simulation
Ten of eleven parks are open with 187–2,319 guests; expect litter and breakdowns
over long runs. Qhyre Rock is closed with no guests. Periodic reloads in the
playlist rotation should cover this.

### Performance candidates
Sambhava's Rest (103k elements, 643 on one tile, 202 rides) and Troubadours et
Baladins (2,319 guests) are the first parks to benchmark.
