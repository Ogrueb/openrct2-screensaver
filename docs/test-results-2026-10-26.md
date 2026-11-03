# Local test run, 2026-10-26

Windows 11, OpenRCT2 v0.5.6 portable (`openrct2.com`), RCT2 Triple Thrill Pack (GOG).
Checklist: `docs/testing.md`. Observations by the owner; console output read by Claude.

## 1. Generated title sequence (stock layout, no plugin)
- [x] Sequence is listed under Options → Miscellaneous → Title sequence and plays.
- [x] Every park loads. Console shows only `Image table size shorter than expected` warnings
      for objects FSCGHMRX and FSCTILSC (object data, not the sequence).
- [~] Views: mostly good. **Small parks that fit on one screen are not centered and get
      several views of mostly empty space** (the 32-tile grid splits them up). Tin Train's
      single view is at (8, 8).
- [x] Rotation (separate one-park test, Sambhava's Rest, same spot at rotations 0–3): four
      distinct 90° angles. The spot is not exactly re-centered across rotations (expected:
      `LOCATION` centers at ground height).
- [x] Holds last about as long as written (10 s; 8 s in the rotation test, roughly timed).
- [ ] Hold vs game speed: not testable without the plugin (no speed controls on the title screen).
- [~] Load time: large parks take several seconds; the previous park's frame is frozen
      meanwhile. A park reloading at `RESTART` also freezes briefly.

## 2. Plugin
- [x] Console: `[RCT Screensaver] playing "RCT Screensaver Examples" (10 parks)`.
- [x] Intransient plugin starts on the title screen and keeps running across park loads.
- [x] Views advance on their own; parks advance after the last view and wrap around.
- [x] Right/Left step views; Shift+Right/Left step parks (arrow bindings fire).
- [x] Up/Down change speed visibly via `gamesetspeed` (levels 1–4 = 1×–8×, as the README says).
      **Speed resets to 1× whenever a new park loads**; the plugin should re-apply it after each load.
- [x] Space holds; pressing again releases, then the view runs a full hold before advancing.
- [x] S toggles shuffle. Park order is reshuffled on each press (and each wrap); view order
      within a park is reshuffled every time a park is entered.
- [?] Viewport moveTo/rotation/zoom not undone during a `WAIT`: no snapping noticed.
- [x] Starting a game stops the player (`Stopped/Unloaded/Unregistered`); returning to the
      title screen restarts the playlist.
- Note: `Importing legacy shortcuts...` is printed on every park load.

## 3. Park behavior
- [x] Sambhava's Rest and Constellations: areas in view render normally without their
      companion plugins (Animator, Object Animator); their animations simply don't run.
- [x] Constellations ride 79 (AdvancedTrack): no visible issues.
- [~] Frame rate: looks smooth on Sambhava's Rest and Troubadours et Baladins. The FPS counter
      does not render on the title screen, so no numbers.
- [x] Decay: a held view at speed 4 for 10+ minutes left no visible litter.

## Follow-ups
1. Plugin: re-apply the chosen game speed after every park load (it resets to 1×).
2. View generation: center small parks (one view when the content fits on a screen) instead of
   splitting them into 32-tile grid cells.
3. Park loads freeze the previous frame for several seconds on large parks; consider a fade or
   a loading card later.
4. No frame-rate numbers yet: the FPS counter does not draw on the title screen.
5. Deferred by the owner: running parks' companion plugins (Animator, Object Animator,
   AdvancedTrack) and checking their compatibility. Revisit once the basic approach works;
   no sign of them running was seen.
