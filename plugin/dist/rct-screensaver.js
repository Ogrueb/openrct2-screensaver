"use strict";
(() => {
  // src/storage.ts
  var NAMESPACE = "RCTScreensaver";
  function isPinned(view) {
    return view.animation !== void 0 && !view.fixed || view.show !== void 0 || view.cue !== void 0;
  }
  function isCut(view) {
    return !!view.cue?.cut && typeof view.cue.tick === "number";
  }
  function placeCuts(views) {
    const due = (v) => v.cue.tick / 40 - (v.cue.lead ?? 0);
    const cuts = views.filter(isCut).sort((a, b) => due(a) - due(b));
    if (cuts.length === 0) {
      return views;
    }
    const rest = views.filter((v) => !isCut(v));
    const starts = [];
    let t = 0;
    rest.forEach((v, i) => {
      if (!isPinned(v)) {
        starts.push([i, t]);
        t += v.hold;
      }
    });
    const after = /* @__PURE__ */ new Map();
    for (const c of cuts) {
      let k = starts.length > 0 ? starts[0][0] : rest.length - 1;
      for (const [i, start] of starts) {
        if (start <= due(c)) {
          k = i;
        }
      }
      after.set(k, [...after.get(k) ?? [], c]);
    }
    return [...rest.flatMap((v, i) => [v, ...after.get(i) ?? []]), ...after.get(-1) ?? []];
  }
  function loadPlaylistProps(sequence) {
    const all = context.sharedStorage.get(NAMESPACE + ".playlistProps", {});
    return { ...all[sequence] ?? {} };
  }
  function savePlaylistProps(sequence, props) {
    const all = context.sharedStorage.get(NAMESPACE + ".playlistProps", {});
    all[sequence] = props;
    context.sharedStorage.set(NAMESPACE + ".playlistProps", all);
    liveProps[sequence] = props;
    writeLive();
  }
  var CHECKPOINTS_PER_PARK = 10;
  function loadCheckpoints() {
    return context.sharedStorage.get(NAMESPACE + ".checkpoints", {});
  }
  function saveCheckpoints(all) {
    context.sharedStorage.set(NAMESPACE + ".checkpoints", all);
  }
  var TITLES = ["overview", "on", "off"];
  function titlesOf(settings) {
    return settings.titlesOverride ?? settings.titles;
  }
  var DEFAULT_SETTINGS = {
    autostart: true,
    shuffle: false,
    debug: false,
    speed: 1,
    fadeMs: 600,
    panTolerance: 500,
    panToleranceStep: 100,
    panChanges: "end",
    inertia: false,
    changeHold: 2,
    arriveHold: 1,
    returnHold: 2,
    cameraLog: false,
    scaleToWindow: true,
    window: "borderless",
    titleMusic: "keep",
    titles: "overview",
    captionPlace: "topLeft",
    captionFrame: "gold",
    captionBand: "green",
    lightEffects: false,
    weatherGloom: false,
    weather: false,
    timeOfDay: "day",
    masterVolume: null,
    soundVolume: null,
    musicVolume: null,
    drawingEngine: null,
    multiThreading: null,
    editorPinned: true,
    bench: false,
    profilerExport: ""
  };
  function loadSettings() {
    const stored = context.sharedStorage.get(NAMESPACE + ".settings", {});
    return { ...DEFAULT_SETTINGS, ...stored };
  }
  function saveSettings(settings) {
    const { titlesOverride: _, ...saved } = settings;
    context.sharedStorage.set(NAMESPACE + ".settings", saved);
  }
  function loadEdits() {
    return context.sharedStorage.get(NAMESPACE + ".edits", {});
  }
  function saveEdits(edits) {
    context.sharedStorage.set(NAMESPACE + ".edits", edits);
    liveEdits = edits;
    writeLive();
  }
  function filesApi() {
    return typeof screensaver !== "undefined" && screensaver !== null && typeof screensaver.writeFile === "function" ? screensaver : void 0;
  }
  function liveFileName(sequence) {
    const base = sequence.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100) || "playlist";
    return base + ".json";
  }
  var liveEdits;
  var liveSaved;
  function lastLiveSave() {
    if (liveSaved === void 0) {
      const api = filesApi();
      const playlist = api ? loadPlaylist() : void 0;
      if (!api || !playlist) {
        return void 0;
      }
      try {
        const file = JSON.parse(api.readFile(liveFileName(playlist.sequence)) || "null");
        liveSaved = file && file.sequence === playlist.sequence && typeof file.saved === "number" ? file.saved : 0;
      } catch {
        liveSaved = 0;
      }
    }
    return liveSaved || void 0;
  }
  var liveProps = {};
  function writeLive() {
    const api = filesApi();
    const playlist = api ? loadPlaylist() : void 0;
    if (!api || !playlist) {
      return false;
    }
    const all = liveEdits ?? loadEdits();
    const keys = new Set(playlist.parks.map((p) => p.key ?? p.fileName));
    const edits = {};
    for (const key of Object.keys(all)) {
      if (keys.has(key)) {
        edits[key] = all[key];
      }
    }
    const props = liveProps[playlist.sequence] ?? loadPlaylistProps(playlist.sequence);
    const file = {
      version: 1,
      sequence: playlist.sequence,
      source: playlist.source,
      installed: playlist.installed,
      saved: Date.now(),
      edits,
      props
    };
    const ok = api.writeFile(liveFileName(playlist.sequence), JSON.stringify(file, null, 1));
    if (ok) {
      liveSaved = file.saved;
    }
    if (!ok) {
      console.log(`[rct-screensaver] could not write ${liveFileName(playlist.sequence)} in ${api.filesFolder}`);
    }
    return ok;
  }
  function loadVisits() {
    return context.sharedStorage.get(NAMESPACE + ".visits", {});
  }
  function saveVisits(visits) {
    context.sharedStorage.set(NAMESPACE + ".visits", visits);
  }
  function loadPlaylist() {
    return context.sharedStorage.get(NAMESPACE + ".playlist");
  }
  function savePlaylist(playlist) {
    context.sharedStorage.set(NAMESPACE + ".playlist", playlist);
  }
  function resolveSequence(playlist) {
    if (playlist.version !== 1) {
      return `unsupported playlist version ${playlist.version}`;
    }
    const sequence = titleSequenceManager.titleSequences.find((s) => s.name === playlist.sequence);
    if (!sequence) {
      return `title sequence "${playlist.sequence}" not found`;
    }
    const commands = sequence.commands;
    const parks = sequence.parks;
    for (const park of playlist.parks) {
      const command = commands[park.load];
      if (!command || command.type !== "load" || parks[command.index]?.fileName !== park.fileName) {
        return `title sequence "${playlist.sequence}" does not match the installed playlist (${park.fileName}); re-run tools/mksequence.py --install`;
      }
    }
    return sequence;
  }

  // src/builder.ts
  function buildApi() {
    return typeof screensaver !== "undefined" && screensaver !== null && typeof screensaver.build === "function" && typeof screensaver.applyBuild === "function" ? screensaver : void 0;
  }
  function buildFileName(sequence) {
    return "build-" + liveFileName(sequence);
  }
  function readBuildResult(sequence) {
    const text = filesApi()?.readFile(buildFileName(sequence));
    if (!text) {
      return void 0;
    }
    try {
      const result = JSON.parse(text);
      return result && result.buildVersion === 1 && result.sequence === sequence ? result : void 0;
    } catch {
      return void 0;
    }
  }
  var POLL_MS = 500;
  var STALE_MS = 5e3;
  function log(message2) {
    console.log(`[RCT Screensaver] ${message2}`);
  }
  function clock(ms) {
    const s = Math.max(0, Math.round(ms / 1e3));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function timeOfDay(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  var Builder = class {
    constructor(api = buildApi()) {
      this.api = api;
      // the build this plugin started
      this.started = 0;
      this.lastPoll = 0;
      // the last build's result (its squares and messages stay shown)
      this.notes = [];
      this.builtFrom = 0;
    }
    get available() {
      return this.api !== void 0 && filesApi() !== void 0;
    }
    get running() {
      return this.sequence !== void 0;
    }
    start(sequence) {
      if (!this.api || this.running) {
        return;
      }
      try {
        this.api.build(sequence);
      } catch (e) {
        this.outcome = { phase: "failed", text: `Build failed: ${message(e)}`, warning: true };
        this.last = void 0;
        this.notes = [{ level: "error", text: `The build did not start: ${message(e)}` }];
        log(`build of "${sequence}" did not start: ${message(e)}`);
        return;
      }
      this.last = this.last ?? readBuildResult(sequence);
      this.sequence = sequence;
      this.started = Date.now();
      this.progress = void 0;
      this.outcome = void 0;
      this.notes = [];
      log(`building "${sequence}"`);
    }
    cancel() {
      if (this.api && this.running && this.api.cancelBuild()) {
        log("build cancelled");
      }
    }
    /** Called on the plugin's update: follows a running build and takes it in when it is done. */
    update() {
      if (!this.api || !this.sequence || Date.now() - this.lastPoll < POLL_MS) {
        return;
      }
      this.lastPoll = Date.now();
      const sequence = this.sequence;
      const status = this.api.buildStatus;
      const result = readBuildResult(sequence);
      const current = result && result.started >= this.started - STALE_MS ? result : void 0;
      if (status.state === "running") {
        this.progress = current ?? this.progress;
        return;
      }
      this.sequence = void 0;
      this.progress = void 0;
      this.last = current;
      const took = Date.now() - this.started;
      if (status.state === "cancelled") {
        this.outcome = { phase: "idle", text: "Build cancelled" };
        this.notes = [{ level: "info", text: "Build cancelled; the playlist plays on as it was" }];
        return;
      }
      if (status.state !== "done" || !current?.ok || !current.playlist) {
        const why = current?.ok === false && current.error ? current.error : status.error || "the generator failed";
        this.outcome = { phase: "failed", text: `Build failed: ${why}`, warning: true };
        this.notes = current?.messages?.some((m) => m.level === "error") ? [] : [{ level: "error", text: `Build failed: ${why} (log: screensaver/build.log in the user folder)` }];
        log(`build of "${sequence}" failed: ${why} (log: screensaver/build.log in the user folder)`);
        return;
      }
      const error = this.onReady ? this.onReady(current) : "nothing to play it";
      if (error) {
        this.outcome = { phase: "failed", text: `Built, but not taken in: ${error}`, warning: true };
        this.notes = [{ level: "error", text: `Built, but not taken in: ${error}` }];
        log(`build of "${sequence}" not taken in: ${error}`);
        return;
      }
      this.builtFrom = current.started;
      const warnings = current.warnings?.length ?? 0;
      const at = timeOfDay(current.finished ?? Date.now());
      this.outcome = {
        phase: "done",
        text: `Built at ${at}, now playing${warnings ? `; ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}`
      };
      this.notes = [{ level: "ok", text: `Built ${at} in ${clock(took)}, now playing` }];
      for (const w of current.warnings ?? []) {
        log(`build warning: ${w}`);
      }
      log(`build of "${sequence}" now playing`);
    }
    /** The line the editor shows (the controls bar's chip and the pane's header take theirs from it). */
    get line() {
      if (!this.available) {
        return { phase: "unavailable", text: "Building from the game needs the patched engine" };
      }
      if (this.running) {
        const p = this.progress;
        const name = p?.parkKey && this.nameOf?.(p.parkKey) || p?.parkName;
        const where = p?.parks ? `Park ${p.park} of ${p.parks}${name ? " \xB7 " + name : ""}` : "Starting";
        return { phase: "running", text: where };
      }
      return this.outcome ?? { phase: "idle", text: "Builds the playlist with your edits and plays it" };
    }
    /** The running build's time so far, ms. */
    get elapsed() {
      return this.running ? Date.now() - this.started : 0;
    }
    /** The running build's park and count, for the controls bar's chip. */
    get count() {
      const p = this.progress;
      return this.running && p?.parks ? { park: p.park ?? 0, parks: p.parks } : void 0;
    }
    /** The parks of the running build, else of the last one, in play order: while one runs, a park not
     *  reached yet carries its state from the build before (`previous`, drawn dimmed); otherwise the
     *  squares follow the playing order at once, a reorder included. */
    get parks() {
      if (this.running) {
        const before = new Map((this.last?.parkStates ?? []).filter((p) => p.key).map((p) => [p.key, p]));
        return (this.progress?.parkStates ?? []).map((p) => {
          const old = p.state === "pending" && p.key ? before.get(p.key) : void 0;
          return old && old.state !== "pending" && old.state !== "building" ? { ...old, previous: true } : p;
        });
      }
      const states = this.last?.parkStates ?? [];
      const order = this.orderOf?.();
      if (!order?.length) {
        return states;
      }
      const rank = new Map(order.map((k, i) => [k, i]));
      return states.map((p, i) => ({ p, i })).sort((a, b) => (rank.get(a.p.key ?? "") ?? order.length + a.i) - (rank.get(b.p.key ?? "") ?? order.length + b.i)).map((x) => x.p);
    }
    /** The messages of the running build, else of the last one, newest first. */
    get messages() {
      const r = this.running ? this.progress : this.last;
      return [...this.notes, ...[...r?.messages ?? []].reverse()];
    }
    /** Edits saved in the game since the playing build started (or since the install). */
    pendingEdits(installed) {
      const saved = lastLiveSave();
      return saved !== void 0 && saved > Math.max(this.builtFrom, installed ?? 0);
    }
  };
  function message(e) {
    const m = e?.message;
    return typeof m === "string" ? m : String(e);
  }
  var builder = new Builder();

  // src/fit.ts
  var TILE = 32;
  var MIN_SEPARATION = 0.25;
  var MIN_ZOOM = -2;
  var MAX_ZOOM = 3;
  var OVERVIEW_FILL = 0.95;
  function toScreen(x, y, z, rotation) {
    const [a, b] = [[x, y], [y, -x], [-x, -y], [-y, x]][rotation & 3];
    return { x: b - a, y: (a + b) / 2 - z };
  }
  function toWorld(p, z, rotation) {
    const a = p.y + z - p.x / 2;
    const b = p.y + z + p.x / 2;
    const [x, y] = [[a, b], [-b, a], [-a, -b], [b, -a]][rotation & 3];
    return { x, y };
  }
  function frameAxis(centre, size, lo, hi) {
    return hi - lo <= size ? Math.min(lo + size / 2, Math.max(hi - size / 2, centre)) : Math.min(hi - size / 2, Math.max(lo + size / 2, centre));
  }
  function clampAxis(centre, size, lo, hi) {
    if (hi - lo <= size) {
      return (lo + hi) / 2;
    }
    return Math.min(hi - size / 2, Math.max(lo + size / 2, centre));
  }
  function extentOf(bounds, rotation, z) {
    const corners = [];
    for (const h of [bounds.z0 ?? z, bounds.z1 ?? z]) {
      for (const [x, y] of [
        [bounds.x0, bounds.y0],
        [bounds.x1 + 1, bounds.y0],
        [bounds.x0, bounds.y1 + 1],
        [bounds.x1 + 1, bounds.y1 + 1]
      ]) {
        corners.push(toScreen(x * TILE, y * TILE, h, rotation));
      }
    }
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    return { xlo: Math.min(...xs), xhi: Math.max(...xs), ylo: Math.min(...ys), yhi: Math.max(...ys) };
  }
  function viewAt(view, p) {
    const world = toWorld(p, view.z, view.rotation);
    return { ...view, x: (world.x - TILE / 2) / TILE, y: (world.y - TILE / 2) / TILE };
  }
  function contentExtent(bounds, rotation, z, measure2) {
    const measured2 = measure2?.(rotation);
    if (measured2) {
      return measured2;
    }
    const zm = bounds.zm ?? ((bounds.z0 ?? z) + (bounds.z1 ?? z)) / 2;
    const centre = bounds.cx !== void 0 && bounds.cy !== void 0 ? toScreen(bounds.cx * TILE, bounds.cy * TILE, zm, rotation) : void 0;
    return { ...extentOf(bounds, rotation, z), z: zm, cx: centre?.x, cy: centre?.y };
  }
  function lookAt(base, x, y, z, rotation) {
    const world = toWorld({ x, y }, z, rotation);
    return { ...base, rotation, x: (world.x - TILE / 2) / TILE, y: (world.y - TILE / 2) / TILE, z };
  }
  function fitZoom(e, screen) {
    let zoom = MIN_ZOOM;
    while (zoom < MAX_ZOOM && (e.xhi - e.xlo > screen.width * Math.pow(2, zoom) * OVERVIEW_FILL || e.yhi - e.ylo > screen.height * Math.pow(2, zoom) * OVERVIEW_FILL)) {
      zoom++;
    }
    return zoom;
  }
  function fitOverview(view, bounds, screen, measure2, wide = 0) {
    const e = contentExtent(bounds, view.rotation, view.z, measure2);
    const flat = extentOf({ ...bounds, z1: bounds.z0 }, view.rotation, view.z);
    const zoom = fitZoom(flat, screen) <= wide ? Math.min(fitZoom(e, screen), wide) : fitZoom(e, screen);
    const scale = Math.pow(2, zoom);
    const x = frameAxis(e.cx ?? (e.xlo + e.xhi) / 2, screen.width * scale * OVERVIEW_FILL, e.xlo, e.xhi);
    const y = frameAxis(e.cy ?? (e.ylo + e.yhi) / 2, screen.height * scale * OVERVIEW_FILL, e.ylo, e.yhi);
    return { ...lookAt(view, x, y, Math.round(e.z ?? view.z), view.rotation), zoom };
  }
  function fitViews(views, bounds, screen, budget = views.length, measure2, zoomOffset = 0) {
    const overview = views.find((v) => v.overview);
    const others = views.filter((v) => !v.overview);
    const head = overview ? [fitOverview(overview, bounds, screen, measure2, zoomOffset)] : [];
    const fitted = [...head, ...clampViews(others, bounds, screen, head[0]?.rotation)];
    if (fitted.length >= budget || views.length === 0) {
      return fitted;
    }
    const first = others.find((v) => v.animation === void 0 && !v.fixed) ?? others[0] ?? head[0];
    const count = budget - head.length;
    const result = [];
    for (let k = 0; k < count; k++) {
      const rotation = ((overview ?? first).rotation + k + head.length) % 4;
      const e = contentExtent(bounds, rotation, first.z, measure2);
      let zoom = first.zoom;
      while (zoom < MAX_ZOOM && e.xhi - e.xlo > screen.width * Math.pow(2, zoom)) {
        zoom++;
      }
      if (e.xhi - e.xlo > screen.width * Math.pow(2, zoom) || zoom > Math.max(zoomOffset, first.zoom)) {
        return fitted;
      }
      const base = { ...first, zoom };
      const width = screen.width * Math.pow(2, zoom);
      const height = screen.height * Math.pow(2, zoom);
      const rows = Math.min(count, Math.max(1, Math.ceil((e.yhi - e.ylo) / height)));
      const row = k % rows;
      const y = rows === 1 ? (e.ylo + e.yhi) / 2 : e.yhi - height / 2 - row * (e.yhi - e.ylo - height) / (rows - 1);
      result.push(lookAt(base, (e.xlo + e.xhi) / 2, y, Math.round(e.z ?? base.z), rotation));
    }
    return [...head, ...result, ...fitted.filter((v) => v.animation !== void 0)];
  }
  function clampViews(views, bounds, screen, overviewRotation) {
    const result = [];
    const centres = [];
    for (const view of views) {
      const scale = Math.pow(2, view.zoom);
      const width = screen.width * scale;
      const height = screen.height * scale;
      const e = extentOf(bounds, view.rotation, view.z);
      const centre = toScreen(view.x * TILE + TILE / 2, view.y * TILE + TILE / 2, view.z, view.rotation);
      if (view.fixed) {
        centres.push({ ...centre, width, height });
        result.push(view);
        continue;
      }
      const fitted = {
        x: clampAxis(centre.x, width, e.xlo, e.xhi),
        y: clampAxis(centre.y, height, e.ylo, e.yhi)
      };
      if (view.rotation === overviewRotation && e.xhi - e.xlo <= width && e.yhi - e.ylo <= height) {
        continue;
      }
      const duplicate = result.some((other, i) => other.rotation === view.rotation && Math.abs(centres[i].x - fitted.x) < Math.min(width, centres[i].width) * MIN_SEPARATION && Math.abs(centres[i].y - fitted.y) < Math.min(height, centres[i].height) * MIN_SEPARATION);
      if (duplicate) {
        continue;
      }
      centres.push({ ...fitted, width, height });
      result.push(viewAt(view, fitted));
    }
    return result;
  }

  // src/editor.ts
  var CLASSIFICATION = "rctscreensaver.editor";
  var WIDTH = 300;
  var HEIGHT = 268;
  var TILE2 = 32;
  var PAN_STEP = 64;
  var PAN_FAST = 4;
  var MIN_ZOOM2 = -2;
  var MAX_ZOOM2 = 3;
  var MIN_HOLD = 1;
  var MAX_HOLD = 600;
  var DEFAULT_HOLD = 10;
  var PAN_SHARE_STEP = 0.1;
  var UNDO_DEPTH = 100;
  var MAX_Z = 2040;
  var Z_STEP = 8;
  var MAP_OUT = 2;
  var EDITOR_COLUMNS = ["#", "Tile", "Angle", "Zoom", "Hold", "Pan", "Set by"];
  var EVENT_COLUMNS = ["#", "Kind", "Name", "Trigger", "Hold", "Plays"];
  var TICKS_PER_SECOND = 40;
  function clock2(ticks) {
    const s = Math.max(0, Math.round(ticks / TICKS_PER_SECOND));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function round2(n) {
    return Math.round(n * 100) / 100;
  }
  function topZ(tx, ty) {
    const size = map.size;
    if (tx < 0 || ty < 0 || size && (tx >= size.x || ty >= size.y)) {
      return void 0;
    }
    try {
      let top;
      for (const e of map.getTile(tx, ty).elements) {
        if (e.isHidden) {
          continue;
        }
        const h = e.type === "surface" ? Math.max(e.baseZ, e.waterHeight ?? 0) : e.clearanceZ ?? e.baseZ;
        top = top === void 0 ? h : Math.max(top, h);
      }
      return top;
    } catch {
      return void 0;
    }
  }
  function surfaceZ(p, rotation, top = topZ) {
    for (let z = MAX_Z; z >= 0; z -= Z_STEP) {
      const w = toWorld(p, z, rotation);
      const h = top(Math.floor(w.x / TILE2), Math.floor(w.y / TILE2));
      if (h !== void 0 && h >= z) {
        return z;
      }
    }
    return void 0;
  }
  function groundZ(x, y) {
    try {
      const surface = map.getTile(Math.floor(x / TILE2), Math.floor(y / TILE2)).elements.find((e) => e.type === "surface");
      return surface ? surface.baseZ : 0;
    } catch {
      return 0;
    }
  }
  var Editor = class {
    // by park key, as saved
    constructor(player2, view = new WindowView()) {
      this.player = player2;
      this.view = view;
      this.shown = false;
      this.camera = { x: 0, y: 0, z: 0, rotation: 0, zoom: 0 };
      this.selected = -1;
      this.undoStacks = /* @__PURE__ */ new Map();
      // a drag on the park
      this.map = false;
      // the map: every view a box on a camera stepped out
      this.mapPark = -1;
      // the park the map's camera was set on
      this.eventsUnlocked = false;
      // the map lets event views be dragged
      this.opened = /* @__PURE__ */ new Map();
      // the current park's playlist views (Reset view)
      this.checkpoints = loadCheckpoints();
    }
    get isOpen() {
      return this.shown;
    }
    open() {
      if (this.shown) {
        return;
      }
      this.shown = true;
      this.player.setEditing(true);
      this.player.onViewShown = (view2) => this.viewShown(view2);
      this.selected = this.player.viewIndex;
      const view = this.player.currentViews[this.selected];
      if (view) {
        this.cameraFromView(view);
      } else {
        this.cameraFromViewport();
      }
      this.noteOpened();
      this.view.open(this);
      this.refresh();
    }
    /** Remembers the current park's views the first time the editor shows them ("Editor opened"). */
    noteOpened() {
      const key = this.player.parkKey;
      if (this.base && this.base.park !== this.player.parkIndex) {
        this.base = void 0;
      }
      if (key !== void 0 && !this.player.isLoading && !this.opened.has(key)) {
        this.opened.set(key, { time: Date.now(), snapshot: this.snapshot() });
      }
    }
    close() {
      if (this.shown) {
        this.view.close();
        this.closed();
      }
    }
    /** Moves the camera by a number of steps on screen (right and down are positive). */
    pan(dx, dy, fast = false) {
      this.stopPreview();
      const step = PAN_STEP * (fast ? PAN_FAST : 1);
      this.moveCamera(dx * step, dy * step);
    }
    /** Moves the camera by window pixels (right and down are positive), on the plane at its height. */
    moveCamera(dx, dy) {
      this.followViewport(ui.mainViewport);
      const c = this.camera;
      const scale = Math.pow(2, c.zoom);
      const p = toScreen(c.x, c.y, c.z, c.rotation);
      const world = toWorld({ x: p.x + dx * scale, y: p.y + dy * scale }, c.z, c.rotation);
      c.x = world.x;
      c.y = world.y;
      this.applyCamera();
    }
    // Live editing: the mouse on the park.
    /** A press on the park: a drag starts. It edits the selected view only if Play was off (a
     * drag during Play just stops it where it is). */
    dragStart() {
      this.gesture = { commit: !this.player.isPreviewing && this.selectedIndex >= 0 && !this.selectedLocked, moved: false };
      this.stopPreview();
    }
    /** The mouse moved by window pixels during a drag: the park follows it. */
    dragBy(dx, dy) {
      if (!this.gesture || dx === 0 && dy === 0) {
        return;
      }
      this.gesture.moved = true;
      this.moveCamera(-dx, -dy);
    }
    /** The drag ended: the selected view goes where the camera is, as one change. */
    dragEnd() {
      const g = this.gesture;
      this.gesture = void 0;
      if (g?.commit && g.moved) {
        this.update();
      }
    }
    get dragging() {
      return this.gesture !== void 0;
    }
    /** The wheel over the park: zooms the camera a level (delta > 0 in) and the selected view with
     * it; during Play it only stops Play. */
    wheel(delta) {
      const commit = !this.map && !this.player.isPreviewing && this.selectedIndex >= 0 && !this.selectedLocked;
      this.zoom(delta > 0 ? -1 : 1);
      if (commit) {
        this.update();
      }
    }
    /** Puts the camera's point at the height of what is seen at the screen's centre (a building's
     * top, the ground or water), without moving the picture: a view set there turns about it, and the
     * camera stays where it was over the void. */
    anchor() {
      const c = this.camera;
      const pv = this.pivot;
      if (pv && Math.abs(c.x - pv.x) <= 1 && Math.abs(c.y - pv.y) <= 1 && Math.abs(c.z - pv.z) <= 1) {
        return;
      }
      const p = toScreen(c.x, c.y, c.z, c.rotation);
      const z = surfaceZ(p, c.rotation);
      if (z !== void 0) {
        const world = toWorld(p, z, c.rotation);
        this.camera = { ...c, x: world.x, y: world.y, z };
      }
      this.pivot = { x: this.camera.x, y: this.camera.y, z: this.camera.z };
    }
    // Undo and redo, per park.
    stacks() {
      const park = this.player.parkIndex;
      let s = this.undoStacks.get(park);
      if (!s) {
        s = { undo: [], redo: [] };
        this.undoStacks.set(park, s);
      }
      return s;
    }
    snapshot() {
      const views = this.player.isLoading ? [] : this.player.currentViews.map((v) => ({ ...v }));
      return { views, selected: this.selected, edited: this.player.isEdited };
    }
    sameAs(s) {
      return s.edited === this.player.isEdited && JSON.stringify(s.views) === JSON.stringify(this.player.currentViews);
    }
    /** Runs a change, remembering the views before it if it changed them. */
    change(apply) {
      if (this.player.isLoading) {
        return;
      }
      const before = this.snapshot();
      apply();
      if (!this.sameAs(before)) {
        const s = this.stacks();
        s.undo.push(before);
        if (s.undo.length > UNDO_DEPTH) {
          s.undo.shift();
        }
        s.redo = [];
        this.refresh();
      }
    }
    undo() {
      this.step(true);
    }
    redo() {
      this.step(false);
    }
    get canUndo() {
      return !this.player.isLoading && (this.undoStacks.get(this.player.parkIndex)?.undo.length ?? 0) > 0;
    }
    get canRedo() {
      return !this.player.isLoading && (this.undoStacks.get(this.player.parkIndex)?.redo.length ?? 0) > 0;
    }
    step(back) {
      if (this.player.isLoading) {
        return;
      }
      const s = this.stacks();
      const target = (back ? s.undo : s.redo).pop();
      if (!target) {
        return;
      }
      (back ? s.redo : s.undo).push(this.snapshot());
      this.restore(target);
    }
    restore(to) {
      if (!to.edited) {
        this.player.revertViews();
        this.selected = this.player.viewIndex;
        this.refresh();
        return;
      }
      const show = Math.min(to.selected, to.views.length - 1);
      this.selected = show;
      this.player.setViews(to.views.map((v) => ({ ...v })), show, true);
      if (show < 0) {
        this.refresh();
      }
      this.replay();
    }
    rotate(delta) {
      this.stopPreview();
      this.anchor();
      this.camera.rotation = (this.camera.rotation + delta + 4) % 4;
      this.applyCamera();
    }
    zoom(delta) {
      this.stopPreview();
      this.camera.zoom = Math.min(MAX_ZOOM2, Math.max(MIN_ZOOM2, this.camera.zoom + delta));
      this.applyCamera();
    }
    /** Play on or off: the park's views play with their pans while the editor stays open. */
    togglePreview() {
      const on = !this.player.isPreviewing;
      this.map = false;
      if (!on) {
        this.cameraFromViewport();
      }
      this.player.setPreview(on, Math.max(0, this.selected));
      this.refresh();
    }
    /** Moving the camera by hand stops the preview where it is. */
    stopPreview() {
      if (this.player.isPreviewing) {
        this.player.setPreview(false);
        this.cameraFromViewport();
      }
    }
    /** After an edit or a selection: play on from the selected view a second later. */
    replay() {
      if (this.player.isPreviewing && this.selected >= 0) {
        this.player.restartPreview(this.selected);
      }
    }
    /** The view was closed (or its window). */
    closed() {
      if (!this.shown) {
        return;
      }
      this.shown = false;
      this.map = false;
      this.player.onViewShown = void 0;
      this.player.setEditing(false);
    }
    select(index) {
      this.selected = index;
      if (this.map) {
        this.centreOn(index);
        return;
      }
      this.player.showViewAt(index);
      this.replay();
    }
    // The map (ui/view-map.ts): the camera stepped out, every view a box.
    get mapMode() {
      return this.map;
    }
    get eventsLocked() {
      return !this.eventsUnlocked;
    }
    toggleEventLock() {
      this.eventsUnlocked = !this.eventsUnlocked;
      this.refresh();
    }
    /** The map on or off: on, the camera steps out from the selected view; off, it frames it. */
    toggleMap() {
      if (this.player.isLoading || !this.view.supportsMap) {
        return;
      }
      this.stopPreview();
      this.map = !this.map;
      if (this.map) {
        const view = this.player.currentViews[this.selected];
        this.camera.zoom = Math.min(MAX_ZOOM2, (view?.zoom ?? this.camera.zoom) + MAP_OUT);
        this.mapPark = this.player.parkIndex;
        this.applyCamera();
      } else if (this.selectedIndex >= 0) {
        this.player.showViewAt(this.selected);
      } else {
        this.refresh();
      }
    }
    /** A box double-clicked on the map: back to the frame, on that view. */
    frame(index) {
      this.map = false;
      this.select(index);
    }
    /** On the map, puts the camera back on the viewport when the engine turned or zoomed it (a park
     *  load sets its own angle a frame after the plugin's), so the boxes match the picture. */
    syncMap() {
      if (!this.map || this.player.isLoading) {
        return;
      }
      const vp = ui.mainViewport;
      if (vp.rotation !== this.camera.rotation || vp.zoom !== this.camera.zoom) {
        this.applyCamera();
      }
    }
    /** The camera as it is (the map projects the views through it). */
    get cameraPose() {
      return { ...this.camera };
    }
    /** Pans the camera by window pixels (the map's drag on empty park). */
    panBy(dx, dy) {
      this.stopPreview();
      this.moveCamera(dx, dy);
    }
    /** Zooms the camera a level (delta > 0 in) without touching a view (the map's wheel). */
    zoomCamera(delta) {
      this.zoom(delta > 0 ? -1 : 1);
    }
    /** Selects a view without moving the camera (a click on its box). */
    pick(index) {
      if (this.player.currentViews[index]) {
        this.selected = index;
        this.refresh();
      }
    }
    /** Centres the camera on a view, turning to its angle so it shows as a box. */
    centreOn(index) {
      const view = this.player.currentViews[index];
      if (view) {
        this.camera = { ...this.camera, x: view.x * TILE2 + TILE2 / 2, y: view.y * TILE2 + TILE2 / 2, z: view.z, rotation: view.rotation };
        this.applyCamera();
      }
    }
    /** Moves a view to a tile position (its height and the rest unchanged): a box dragged on the map. */
    moveView(index, x, y) {
      this.mapEdit(index, (v) => ({ x: round2(x), y: round2(y) }));
    }
    /** Changes a view's zoom: a box's corner dragged on the map. */
    zoomView(index, zoom) {
      this.mapEdit(index, () => ({ zoom: Math.min(MAX_ZOOM2, Math.max(MIN_ZOOM2, Math.round(zoom))) }));
    }
    mapEdit(index, edit) {
      const target = this.player.currentViews[index];
      if (target && this.eventsLocked && this.isEvent(target)) {
        return;
      }
      this.change(() => {
        const views = this.views();
        const view = views[index];
        if (!view) {
          return;
        }
        views[index] = { ...view, ...edit(view), manual: true };
        delete views[index].overview;
        this.selected = index;
        this.player.setViews(views, -1);
        this.refresh();
      });
    }
    /** Adds a view at a world point after the selected one, at the camera's angle and the selected
     * view's zoom (a right click on the map). */
    addAt(x, y, z) {
      this.change(() => {
        const views = this.views();
        const at = this.selected >= 0 ? this.selected + 1 : views.length;
        const near = views[this.selected];
        views.splice(at, 0, {
          x: round2((x - TILE2 / 2) / TILE2),
          y: round2((y - TILE2 / 2) / TILE2),
          z: Math.round(z),
          rotation: this.camera.rotation,
          zoom: near?.zoom ?? Math.max(MIN_ZOOM2, this.camera.zoom - MAP_OUT),
          hold: near?.hold ?? DEFAULT_HOLD,
          manual: true
        });
        this.selected = at;
        this.player.setViews(views, -1);
        this.refresh();
      });
    }
    /** What a view's pan does next: a pan (true) or a cut, for the map's lines. */
    pans(view) {
      return this.player.panOf(view) > 0;
    }
    /** The park's views as they play (generated ones fitted to the window). */
    get currentViews() {
      return this.player.currentViews;
    }
    /** The views to change: the park's current views, copied (generated ones are fitted).
     * Empty while a park is loading, so nothing is changed until its views are on screen. */
    views() {
      if (this.player.isLoading) {
        return [];
      }
      const first = !this.player.isEdited;
      return this.player.currentViews.map((v, i) => first ? { ...v, origin: i } : { ...v });
    }
    cameraView(hold) {
      const c = this.camera;
      return {
        x: round2((c.x - TILE2 / 2) / TILE2),
        y: round2((c.y - TILE2 / 2) / TILE2),
        z: Math.round(c.z),
        rotation: c.rotation,
        zoom: c.zoom,
        hold,
        manual: true
      };
    }
    add() {
      if (this.map) {
        this.anchor();
        this.addAt(this.camera.x, this.camera.y, this.camera.z);
        return;
      }
      this.change(() => {
        this.anchor();
        const views = this.views();
        const at = this.selected >= 0 ? this.selected + 1 : views.length;
        views.splice(at, 0, this.cameraView(views[this.selected]?.hold ?? DEFAULT_HOLD));
        this.save(views, at);
      });
    }
    update() {
      if (this.selectedLocked) {
        return;
      }
      if (this.map) {
        this.anchor();
        const c = this.camera;
        this.mapEdit(this.selected, () => ({
          x: round2((c.x - TILE2 / 2) / TILE2),
          y: round2((c.y - TILE2 / 2) / TILE2),
          z: Math.round(c.z),
          rotation: c.rotation
        }));
        return;
      }
      this.change(() => {
        const views = this.views();
        if (!views[this.selected]) {
          return;
        }
        this.anchor();
        views[this.selected] = { ...views[this.selected], ...this.cameraView(views[this.selected].hold) };
        delete views[this.selected].overview;
        this.save(views, this.selected);
      });
    }
    remove() {
      if (this.selectedLocked) {
        return;
      }
      this.change(() => {
        const views = this.views();
        if (!views[this.selected]) {
          return;
        }
        views.splice(this.selected, 1);
        this.save(views, Math.min(this.selected, views.length - 1), true);
      });
    }
    move(delta) {
      this.change(() => {
        const views = this.views();
        const to = this.selected + delta;
        if (!views[this.selected] || to < 0 || to >= views.length) {
          return;
        }
        [views[this.selected], views[to]] = [views[to], views[this.selected]];
        this.save(views, to, true);
      });
    }
    changeHold(delta) {
      if (this.selectedLocked) {
        return;
      }
      this.change(() => {
        const views = this.views();
        const view = views[this.selected];
        if (!view) {
          return;
        }
        view.hold = Math.min(MAX_HOLD, Math.max(MIN_HOLD, Math.round(view.hold) + delta));
        this.player.setViews(views, -1, true);
        this.replay();
        this.refresh();
      });
    }
    /** Changes the share of the selected view's hold spent panning to the next view. */
    changePan(delta) {
      this.togglePan((v) => ({ pan: Math.round(Math.min(1, Math.max(0, this.player.panOf(v) + delta)) * 10) / 10 }));
    }
    toggleTurn() {
      this.togglePan((v) => ({ panChanges: this.player.panChangesOf(v) === "start" ? "end" : "start" }));
    }
    toggleInertia() {
      this.togglePan((v) => ({ inertia: !this.player.inertiaOf(v) }));
    }
    /** Moves a view to another place in the list (a row dragged in the editing UI). */
    moveTo(from, to) {
      this.change(() => {
        const views = this.views();
        if (!views[from] || to < 0 || to >= views.length || from === to) {
          return;
        }
        const [moved] = views.splice(from, 1);
        views.splice(to, 0, moved);
        this.save(views, to, true);
      });
    }
    /** Whether a view can be dragged or moved: event views only with the lock off. */
    movable(index) {
      const v = this.player.currentViews[index];
      return !!v && (!this.isEvent(v) || this.eventsUnlocked);
    }
    isEvent(v) {
      return isPinned(v) || v.animation !== void 0;
    }
    /** The selected view is an event view under the lock: nothing changes it (owner, 2026-11-10),
     *  as its timing comes from the park (its clock, a train, a show), not from the list. */
    get selectedLocked() {
      const v = this.player.currentViews[this.selected];
      return !!v && this.eventsLocked && this.isEvent(v);
    }
    /** The current park's playlist views, as reverting would give them (kept until the park changes). */
    baseViews() {
      if (!this.base || this.base.park !== this.player.parkIndex) {
        this.base = { park: this.player.parkIndex, views: this.player.baseViews() };
      }
      return this.base.views;
    }
    /** The selected view's playlist version, if it differs from the view (Reset view). */
    resetTarget() {
      const v = this.player.currentViews[this.selected];
      if (!v || v.origin === void 0 || !this.player.isEdited || this.player.isLoading) {
        return void 0;
      }
      const base = this.baseViews()[v.origin];
      if (!base) {
        return void 0;
      }
      const { origin: _, ...rest } = v;
      return JSON.stringify(rest) === JSON.stringify(base) ? void 0 : base;
    }
    get canResetView() {
      return !this.selectedLocked && this.resetTarget() !== void 0;
    }
    /** Puts the selected view back as the playlist has it (the rest of the list unchanged). */
    resetView() {
      const base = this.resetTarget();
      if (!base || this.selectedLocked) {
        return;
      }
      this.change(() => {
        const views = this.views();
        views[this.selected] = { ...base, origin: views[this.selected].origin };
        this.save(views, this.selected);
      });
    }
    // Restore points (the editing UI's top-right box).
    restorePoints() {
      const key = this.player.parkKey;
      if (key === void 0) {
        return [];
      }
      const points = [];
      const opened = this.opened.get(key);
      if (opened) {
        points.push({ id: "session", label: "Editor opened", tag: "session", time: opened.time });
      }
      for (const c of [...this.checkpoints[key] ?? []].reverse()) {
        points.push({ id: `checkpoint.${c.n}`, label: `Checkpoint ${c.n}`, time: c.time });
      }
      if (this.player.installedHandSet) {
        points.push({ id: "install", label: "Last install", tag: "install", time: this.player.installedAt });
      }
      points.push({ id: "generated", label: "Generated", tag: "build", time: this.player.builtAt });
      return points.map((p, i) => ({ p, i })).sort((a, b) => (b.p.time ?? -Infinity) - (a.p.time ?? -Infinity) || a.i - b.i).map(({ p }) => p);
    }
    /** Saves the current park's views as a checkpoint (at most CHECKPOINTS_PER_PARK, the oldest goes). */
    saveCheckpoint() {
      const key = this.player.parkKey;
      if (key === void 0 || this.player.isLoading) {
        return;
      }
      const all = this.checkpoints;
      const list = all[key] ?? [];
      const n = list.reduce((m, c) => Math.max(m, c.n), 0) + 1;
      list.push({
        n,
        time: Date.now(),
        views: this.player.currentViews.map((v) => ({ ...v })),
        screen: [ui.width, ui.height],
        camera: { ...this.camera },
        selected: this.selected,
        onMap: this.map
      });
      all[key] = list.slice(-CHECKPOINTS_PER_PARK);
      saveCheckpoints(all);
      this.refresh();
    }
    /** Goes back to a restore point; one change, so Undo returns. */
    restoreTo(id) {
      const key = this.player.parkKey;
      if (key === void 0) {
        return;
      }
      this.change(() => {
        if (id === "session") {
          const opened = this.opened.get(key);
          if (opened) {
            this.restore(opened.snapshot);
          }
        } else if (id === "install") {
          this.player.restoreInstalled();
        } else if (id === "generated") {
          this.player.revertViews();
        } else if (id.startsWith("checkpoint.")) {
          const c = (this.checkpoints[key] ?? []).find((cp) => `checkpoint.${cp.n}` === id);
          if (c) {
            const sel = Math.max(0, Math.min(c.views.length - 1, c.selected ?? 0));
            this.selected = sel;
            this.player.setViews(c.views.map((v) => ({ ...v })), sel, true);
            if (c.camera && !!c.onMap === this.map) {
              this.camera = { ...c.camera };
              this.applyCamera();
            }
            this.selected = sel;
            this.refresh();
            return;
          }
        }
        this.selected = this.player.viewIndex;
        this.refresh();
      });
    }
    /** The panes stay shown (the pin); off, they hide with the cursor like the controls bar. */
    get pinned() {
      return this.player.liveSettings.editorPinned !== false;
    }
    togglePinned() {
      const settings = this.player.liveSettings;
      settings.editorPinned = !this.pinned;
      saveSettings(settings);
      this.refresh();
    }
    /** The playback, for the editing UI's park order and Playlist properties. */
    get playback() {
      return this.player;
    }
    /** Where the park's views come from, for the restore points' header. */
    source() {
      if (this.player.isLoading) {
        return { text: "loading park...", warning: false };
      }
      if (!this.player.canEdit) {
        return { text: "can't edit: re-run --install", warning: true };
      }
      return { text: this.player.isEdited ? "edited \xB7 saved in the game" : "playlist views", warning: false };
    }
    goToPark(index) {
      const n = this.player.parkNames.length;
      if (n > 0) {
        this.player.goToPark((index % n + n) % n);
        this.refresh();
      }
    }
    revert() {
      this.change(() => this.player.revertViews());
    }
    /** Changes how the selected view pans on; like a hold, a change to how the list plays. */
    togglePan(edit) {
      if (this.selectedLocked) {
        return;
      }
      this.change(() => {
        const views = this.views();
        const view = views[this.selected];
        if (!view) {
          return;
        }
        Object.assign(view, edit(view));
        if (view.pan === 0) {
          delete view.pan;
        }
        this.player.setViews(views, -1, true);
        this.replay();
        this.refresh();
      });
    }
    /** Saves the views; `arranged` when the list itself was changed by hand (not just a view). */
    save(views, show, arranged = false) {
      this.selected = show;
      if (show < 0) {
        this.player.setViews(views, -1, arranged);
        this.refresh();
        return;
      }
      this.player.setViews(views, show, arranged);
      this.replay();
    }
    /** A view was shown (selected, the park finished loading, or Play moved on): follow it, so
     * the list highlights the view on screen and edits apply to it. */
    viewShown(view) {
      this.noteOpened();
      if (this.map && !this.player.isPreviewing) {
        this.selected = this.player.viewIndex;
        if (this.mapPark !== this.player.parkIndex && view) {
          this.cameraFromView(view);
          this.camera.zoom = Math.min(MAX_ZOOM2, view.zoom + MAP_OUT);
          this.mapPark = this.player.parkIndex;
        }
        this.applyCamera();
        return;
      }
      if (view) {
        this.cameraFromView(view);
      } else {
        this.cameraFromViewport();
      }
      this.selected = this.player.viewIndex;
      this.refresh();
    }
    cameraFromView(view) {
      this.camera = {
        x: view.x * TILE2 + TILE2 / 2,
        y: view.y * TILE2 + TILE2 / 2,
        z: view.z,
        rotation: view.rotation,
        zoom: view.zoom
      };
    }
    cameraFromViewport() {
      const vp = ui.mainViewport;
      const centre = vp.getCentrePosition();
      this.camera = { x: centre.x, y: centre.y, z: groundZ(centre.x, centre.y), rotation: vp.rotation, zoom: vp.zoom };
    }
    /** The engine keeps the view inside the map's scroll limits (on the frame after moveTo), so the
     * view can stop short of the camera's point. The camera follows where the view really went (on the plane at its height);
     * otherwise it runs on past the limit while the picture stays put, and the map's boxes, drawn from
     * the camera, slide off their spots. */
    followViewport(vp) {
      const l = vp.left, r = vp.right, t = vp.top, b = vp.bottom;
      if (![l, r, t, b].every(Number.isFinite) || r <= l || b <= t) {
        return;
      }
      const c = this.camera;
      const scale = Math.pow(2, vp.zoom);
      if (vp.rotation !== c.rotation || Math.abs((r - l) / scale - ui.width) > 0.25 * ui.width) {
        return;
      }
      const want = toScreen(c.x, c.y, c.z, c.rotation);
      const got = { x: (l + r) / 2, y: (t + b) / 2 };
      const slack = 4 * Math.pow(2, Math.max(0, c.zoom));
      if (Math.abs(got.x - want.x) <= slack && Math.abs(got.y - want.y) <= slack) {
        return;
      }
      const world = toWorld(got, c.z, c.rotation);
      c.x = world.x;
      c.y = world.y;
    }
    applyCamera() {
      const c = this.camera;
      const vp = ui.mainViewport;
      vp.rotation = c.rotation;
      vp.zoom = c.zoom;
      c.zoom = vp.zoom;
      vp.moveTo({ x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) });
      this.followViewport(vp);
      this.refresh();
    }
    // What the views show.
    get parkNames() {
      return this.player.parkNames;
    }
    get parkIndex() {
      return this.player.parkIndex;
    }
    get selectedIndex() {
      return this.player.currentViews[this.selected] ? this.selected : -1;
    }
    get isPlaying() {
      return this.player.isPreviewing;
    }
    /** The route's views: those that play in their place in the list (fixed animation stops too). */
    routeIndices() {
      const views = this.player.currentViews;
      return views.map((_, i) => i).filter((i) => !isPinned(views[i]));
    }
    /** The event views (cut-ins on the park's clock, car cues, shows, cued animations), apart from
     *  the route as their timing comes from the park (owner, 2026-11-10), in the order they play:
     *  cut-ins at their tick, the rest after the route, as listed. */
    eventIndices() {
      const views = this.player.currentViews;
      const routeTicks = this.routeIndices().reduce((t, i) => t + views[i].hold * TICKS_PER_SECOND, 0);
      const at = (i) => {
        const cue = views[i].cue;
        return isCut(views[i]) ? cue.tick - (cue.lead ?? 0) * TICKS_PER_SECOND : routeTicks + i / 1e3;
      };
      return views.map((_, i) => i).filter((i) => isPinned(views[i])).sort((a, b) => at(a) - at(b));
    }
    /** A view's number as listed: 1, 2, ... on the route, E1, E2, ... for event views. */
    labelOf(index) {
      const route = this.routeIndices().indexOf(index);
      return route >= 0 ? String(route + 1) : `E${this.eventIndices().indexOf(index) + 1}`;
    }
    /** The event list's rows: number, kind, name, trigger, hold and when it plays. */
    eventRows() {
      const views = this.player.currentViews;
      const route = this.routeIndices();
      const after = route.length ? `after view ${route.length}` : "after the route";
      const now = this.player.parkClock;
      return this.eventIndices().map((i, k) => {
        const v = views[i];
        const cue = v.cue;
        let kind = "animation";
        let trigger = "runs on its own";
        let plays = after;
        if (cue && cue.tick !== void 0) {
          kind = "clock";
          trigger = `at ${clock2(cue.tick)}` + (cue.every ? `, every ${clock2(cue.every)}` : "");
          if (cue.cut) {
            const start = cue.tick - (cue.lead ?? 0) * TICKS_PER_SECOND;
            let next = start;
            if (cue.every && next < now) {
              next += Math.ceil((now - next) / cue.every) * cue.every;
            }
            plays = this.player.cutPlayed(i) && !cue.every ? "played" : next <= now ? "now" : `in ${clock2(next - now)}`;
          }
        } else if (cue) {
          kind = "train";
          trigger = (cue.ride !== void 0 ? `a car of ride ${cue.ride}` : "listed cars") + (cue.tiles ? " on its tiles" : "");
        } else if (v.show) {
          kind = "show";
          trigger = `show "${v.show.name}"`;
        }
        return [`E${k + 1}`, kind, v.animation ?? v.show?.name ?? "", trigger, `${v.hold} s`, plays];
      });
    }
    /** Moves the selected route view past its neighbor on the route (Ctrl+Up, Ctrl+Down), over any
     *  event views between them, as those play by their own timing. */
    moveOnRoute(delta) {
      const route = this.routeIndices();
      const pos = route.indexOf(this.selected);
      const to = route[pos + delta];
      if (pos < 0 || to === void 0) {
        return;
      }
      this.moveTo(this.selected, to);
    }
    rows() {
      const route = this.routeIndices();
      const events = this.eventIndices();
      const label2 = (i) => route.includes(i) ? String(route.indexOf(i) + 1) : `E${events.indexOf(i) + 1}`;
      return this.player.currentViews.map((v, i) => [
        label2(i),
        `${Math.round(v.x)}, ${Math.round(v.y)}`,
        String(v.rotation),
        String(v.zoom),
        `${v.hold} s`,
        `${Math.round(this.player.panOf(v) * 100)}%`,
        v.manual ? "you" : v.cue || v.animation !== void 0 || v.show ? "event" : "auto"
      ]);
    }
    holdText() {
      const view = this.player.currentViews[this.selected];
      return view ? `Hold view ${this.labelOf(this.selected)}: ${view.hold} s` : "Hold: select a view";
    }
    panText() {
      const view = this.player.currentViews[this.selected];
      return view ? `Pan: ${Math.round(this.player.panOf(view) * 100)}%` : "Pan: -";
    }
    turnText() {
      const view = this.player.currentViews[this.selected];
      return !view ? "-" : this.player.panChangesOf(view) === "start" ? "Turn: start" : "Turn: end";
    }
    inertiaText() {
      const view = this.player.currentViews[this.selected];
      return !view ? "-" : this.player.inertiaOf(view) ? "Inertia: on" : "Inertia: off";
    }
    /** The camera and where the views come from; `warning` when they cannot be edited. */
    status() {
      const c = this.camera;
      const warning = !this.player.isLoading && !this.player.canEdit;
      const source = this.player.isLoading ? "loading park..." : warning ? "re-run mksequence.py --install to edit" : this.player.isEdited ? "hand-set views" : "playlist views (edit to set your own)";
      return {
        text: `Camera ${Math.round((c.x - TILE2 / 2) / TILE2)}, ${Math.round((c.y - TILE2 / 2) / TILE2)} angle ${c.rotation} zoom ${c.zoom} | ${source}`,
        warning
      };
    }
    refresh() {
      if (this.shown) {
        this.view.refresh();
      }
    }
  };
  var WindowView = class {
    open(editor2) {
      this.editor = editor2;
      this.window = ui.openWindow({
        classification: CLASSIFICATION,
        x: 8,
        y: Math.max(30, ui.height - HEIGHT - 8),
        width: WIDTH,
        height: HEIGHT,
        title: "RCT Screensaver: views",
        widgets: this.widgets(),
        onClose: () => {
          this.window = void 0;
          editor2.closed();
        }
      });
    }
    close() {
      const w = this.window;
      this.window = void 0;
      w?.close();
    }
    widgets() {
      const row = (y, items) => {
        const w = Math.floor((WIDTH - 10 - 2 * (items.length - 1)) / items.length);
        return items.map(([name, text, onClick], i) => ({
          type: "button",
          name,
          text,
          onClick,
          x: 5 + i * (w + 2),
          y,
          width: w,
          height: 14
        }));
      };
      return [
        {
          type: "dropdown",
          name: "park",
          x: 5,
          y: 18,
          width: WIDTH - 10,
          height: 14,
          items: this.editor.parkNames,
          selectedIndex: this.editor.parkIndex,
          onChange: (i) => this.editor.goToPark(i)
        },
        {
          type: "listview",
          name: "views",
          x: 5,
          y: 36,
          width: WIDTH - 10,
          height: 104,
          scrollbars: "vertical",
          isStriped: true,
          showColumnHeaders: true,
          canSelect: true,
          columns: [
            { header: "#", width: 22 },
            { header: "Tile", width: 62 },
            { header: "Angle", width: 36 },
            { header: "Zoom", width: 36 },
            { header: "Hold", width: 44 },
            { header: "Pan", width: 44 },
            { header: "Set by" }
          ],
          onClick: (item) => this.editor.select(item)
        },
        ...row(144, [
          ["add", "Add view", () => this.editor.add()],
          ["update", "Set to camera", () => this.editor.update()],
          ["delete", "Delete", () => this.editor.remove()]
        ]),
        ...row(160, [
          ["up", "Move up", () => this.editor.move(-1)],
          ["down", "Move down", () => this.editor.move(1)],
          ["revert", "Use playlist views", () => this.editor.revert()]
        ]),
        {
          type: "spinner",
          name: "hold",
          x: 5,
          y: 176,
          width: WIDTH - 10,
          height: 14,
          onDecrement: () => this.editor.changeHold(-1),
          onIncrement: () => this.editor.changeHold(1)
        },
        {
          type: "spinner",
          name: "pan",
          x: 5,
          y: 192,
          width: 130,
          height: 14,
          tooltip: "Share of the hold spent panning to the next view (0%: held still, then a cut)",
          onDecrement: () => this.editor.changePan(-PAN_SHARE_STEP),
          onIncrement: () => this.editor.changePan(PAN_SHARE_STEP)
        },
        {
          type: "button",
          name: "panChanges",
          x: 137,
          y: 192,
          width: 78,
          height: 14,
          text: "",
          tooltip: "Angle and zoom change as the pan sets off, or as it arrives",
          onClick: () => this.editor.toggleTurn()
        },
        {
          type: "button",
          name: "inertia",
          x: 217,
          y: 192,
          width: WIDTH - 222,
          height: 14,
          text: "",
          tooltip: "Inertia: the pan starts and stops slowly; off, it moves at one speed",
          onClick: () => this.editor.toggleInertia()
        },
        ...row(208, [
          ["rotl", "Rotate left", () => this.editor.rotate(-1)],
          ["rotr", "Rotate right", () => this.editor.rotate(1)],
          ["zoomin", "Zoom in", () => this.editor.zoom(-1)],
          ["zoomout", "Zoom out", () => this.editor.zoom(1)]
        ]),
        {
          type: "button",
          name: "play",
          x: 5,
          y: 224,
          width: WIDTH - 10,
          height: 14,
          text: "",
          tooltip: "Play this park's views with their pans (looping here); edits play on from the selected view a second later",
          onClick: () => this.editor.togglePreview()
        },
        { type: "label", name: "status", x: 5, y: 242, width: WIDTH - 10, height: 12, text: "" },
        {
          type: "label",
          name: "help",
          x: 5,
          y: 254,
          width: WIDTH - 10,
          height: 12,
          text: "Arrows pan the camera (Shift: faster). E closes."
        }
      ];
    }
    refresh() {
      const w = this.window;
      if (!w) {
        return;
      }
      const e = this.editor;
      w.findWidget("park").selectedIndex = e.parkIndex;
      const list = w.findWidget("views");
      list.items = e.rows();
      list.selectedCell = e.selectedIndex >= 0 ? { row: e.selectedIndex, column: 0 } : null;
      w.findWidget("hold").text = e.holdText();
      w.findWidget("pan").text = e.panText();
      w.findWidget("panChanges").text = e.turnText();
      w.findWidget("inertia").text = e.inertiaText();
      w.findWidget("play").text = e.isPlaying ? "Play: on (stops when you move the camera)" : "Play: off";
      w.findWidget("play").isPressed = e.isPlaying;
      const status = e.status();
      w.findWidget("status").text = (status.warning ? "{RED}" : "") + status.text;
    }
  };

  // src/mode.ts
  function screensaverApi() {
    return typeof screensaver === "undefined" ? void 0 : screensaver;
  }
  function perfLogging() {
    const api = screensaverApi();
    return api?.perfLog === true && typeof api.perfMark === "function";
  }
  function perfMark(text) {
    if (perfLogging()) {
      screensaverApi().perfMark(text);
    }
  }
  var TITLE_MUSIC_NONE = 0;
  var TITLE_MUSIC_OPENRCT2 = 2;
  var TITLE_MUSIC_RIDE = 5;
  function modeSettings(settings) {
    let titleMusic = null;
    if (settings.titleMusic === "ride") {
      titleMusic = TITLE_MUSIC_RIDE;
    } else if (settings.titleMusic === "theme") {
      titleMusic = TITLE_MUSIC_OPENRCT2;
    } else if (settings.titleMusic === "off") {
      titleMusic = TITLE_MUSIC_NONE;
    }
    return {
      window: settings.window,
      titleMusic,
      gameSpeed: null,
      lightEffects: settings.lightEffects,
      weatherGloom: settings.weatherGloom,
      weather: settings.weather,
      timeOfDay: settings.timeOfDay,
      masterVolume: settings.masterVolume,
      soundVolume: settings.soundVolume,
      musicVolume: settings.musicVolume,
      drawingEngine: settings.drawingEngine,
      multiThreading: settings.multiThreading
    };
  }

  // src/ui/theme.ts
  var THEME = {
    // The backing strip behind a group of buttons (the stock menu darkens the park behind its row).
    backing: "#0a140e8c",
    // The park name caption's portrait frame: black text on veined marble (80% opaque), the byline on a
    // velvet band below the wood divider (owner, 2026-11-03; its colours in VELVET).
    captionMat: "#00000000",
    // under the marble cells (which carry the 80% opacity)
    captionTitle: "#000000",
    captionShade: "#00000040",
    // the engraving's edge in shadow (above and left)
    captionGlint: "#ffffffa0",
    // and its lit edge (below and right)
    backingLight: "#ffffff1a",
    // its bevel: top and left edges
    backingDark: "#00000073",
    // bottom and right edges
    // Buttons: the stock menu's translucent dark green, lighter under the mouse, darker and sunk
    // while pressed or on (a toggle that is on stays sunk, as the game shows a pressed tab).
    face: "#2c5a3a80",
    faceHover: "#4a8a5ca6",
    faceDown: "#16301fb3",
    faceOn: "#3d7a50b3",
    // The other active state of a button with more than two states (titles on every view, the time
    // of day's cycle): the game's translucent olive/yellow.
    faceAlt: "#8a7a2eb3",
    faceAltHover: "#a8963ac0",
    // The border of a field whose list is open (the park dropdown).
    fieldOpen: "#e0c860",
    // The speed button's face, green at 1× to orange at 8× in even steps (owner, 2026-11-02).
    speedSlow: "#3d7a50b3",
    speedFast: "#c8782ab3",
    bevelLight: "#ffffff52",
    bevelDark: "#00000099",
    bevel: 1,
    text: "#ffffff",
    textShadow: "#000000c0",
    // The tooltip above a button under the mouse.
    tipBacking: "#000000b8",
    tipText: "#f0f0f0",
    tipSize: 15,
    // The view editor is read, not glanced at: nearly opaque (owner, 2026-11-02).
    editorBacking: "#0a140ee6",
    editorList: "#0d1d13f0",
    warning: "#ff7a6a",
    // a status that needs action (the editor's "re-run --install")
    // An inactive button (owner, 2026-11-10: flat, pressed in and gray), its text and its icon's opacity.
    faceOff: "#2a2e2c80",
    textOff: "#ffffff5c",
    iconOff: 0.35,
    textDim: "#ffffffa0",
    // key hints, section labels, times
    textGood: "#8fd6a0",
    // the editor's "edited · saved in the game"
    // The build pane (owner, 2026-11-11): its parks' squares, message marks and header states
    buildFace: "#3d7a50d0",
    // Build and play
    buildDone: "#3d9a5c",
    // a park built
    buildCurrent: "#6fcf8a",
    // the park being built
    buildWarn: "#c8962a",
    // built with warnings
    buildFail: "#b8403a",
    // failed, or its file is missing
    buildInfo: "#4a6a8a",
    pending: "#ffb000",
    // edits not built yet
    dragLine: "#ff6a1a",
    // where a dragged row goes (the mockups' orange)
    rowDimmed: "#00000099",
    // over a row being dragged
    dragGhost: "#3f7a51f5",
    // the dragged row itself, lifted (nearly opaque, over the rows it passes)
    tipPad: 6
  };
  var BAR = {
    // Halfway from the first sizes (40 and 30) to the stock menu's 82 px buttons (owner, 2026-11-02).
    primary: 61,
    // button side: previous/next park and view, hold
    secondary: 46,
    // speed, shuffle, titles, music, settings
    iconPrimary: 34,
    iconSecondary: 24,
    pad: 7,
    // backing around the buttons
    gap: 3,
    // between buttons of a row
    rowGap: 6,
    // between the primary row and the secondary row below it
    bottom: 28,
    // from the window's bottom edge
    speedText: 18
  };
  var PANEL = {
    width: 380,
    pad: 12,
    titleSize: 18,
    rowHeight: 32,
    rowGap: 6,
    textSize: 15,
    valueWidth: 180,
    // the value button or slider at each row's right
    above: 6
    // gap between the panel and the bar
  };
  var FLYOUT = {
    beside: 6,
    // gap between the panel and the flyout
    tileWidth: 132,
    // a style's tile: its preview over its name
    tileHeight: 96,
    gap: 6,
    previewPad: 6,
    tileLabel: 22,
    // the name's line at the tile's foot
    labelSize: 13,
    accentLabel: 22,
    // the "Accent" line above the swatches
    swatchHeight: 28,
    previewName: "Park name",
    previewAuthor: "Builder"
  };
  var EDITOR = {
    x: 16,
    // every pane's distance from the window's edges
    y: 16,
    width: 540,
    // the views pane
    pad: 8,
    gap: 3,
    titleHeight: 32,
    titleSize: 17,
    rowHeight: 24,
    visibleRows: 10,
    eventRows: 4,
    // the event list's rows shown, a scroll bar past that
    eventsGap: 8,
    // between the route list and the event list
    textSize: 14,
    cellMargin: 14,
    // added to each list column's widest text
    scrollBar: 12,
    // a list's scroll bar, when it overflows
    grip: 18,
    // the drag handle column of the views and parks
    parkRow: 26,
    // the park dropdown's rows
    dragStart: 5,
    // pixels the mouse moves before a press on a row drags it
    holdOpen: 300,
    // ms: a press on the park field held this long opens the list until release
    // The toolbox
    tool: 38,
    // a tool button's side
    toolIcon: 20,
    // its icon (tools/mkicons.py GAME_SIZES)
    groupGap: 10,
    labelSize: 11,
    // VIEW, CAMERA, EVENTS, HOLD, PAN
    labelHeight: 15,
    switchHeight: 34,
    // Frame | Map
    hintSize: 12,
    hintHeight: 20,
    stepValue: 58,
    // the hold and pan value between its - and +
    footerGap: 14,
    // between redo and Reset view
    playWidth: 96,
    // The top-right box
    boxWidth: 420,
    boxRow: 28,
    // a restore point
    boxRows: 3.5,
    // restore points shown (a half row says there are more; owner, 2026-11-10)
    boxHead: 12,
    // the RESTORE POINTS line
    boxButton: 32,
    propRow: 30,
    propHeader: 30,
    segHeight: 24,
    segPad: 10,
    // each side of a segment's text
    stepButton: 26,
    stepValueBox: 56,
    holdStep: 0.5,
    // seconds per - or + of the Playlist timing holds
    holdMax: 10,
    // The build pane, bottom right
    buildButton: 40,
    buildBottom: 72,
    // the pane's distance from the window's bottom: over the mode's exit button (64 tall)
    square: 22,
    // a park's square of the build's progress (fewer than squaresMax parks)
    squaresMax: 30
    // above, a bar with the count
  };
  var TIMING = {
    hideAfter: 2500,
    // without mouse movement (never while the mouse is over the bar)
    fadeIn: 150,
    fadeOut: 400
  };
  var VELVET = {
    green: { text: "#e8c878", shadow: "#00000099" },
    burgundy: { text: "#e8c878", shadow: "#00000099" },
    navy: { text: "#e8c878", shadow: "#00000099" },
    slate: { text: "#ecd9a8", shadow: "#00000099" },
    ivory: { text: "#2a1a0a", shadow: "#ffffff66" }
  };
  var ACCENT = {
    green: { strip: "#2c5a3a", mat: "#284e3a", aero: { rim: "#6fad8ebd", bright: "#e2efe8e6", bevel: "#d7e8e0d9" } },
    burgundy: { strip: "#6e182e", mat: "#62182a", aero: { rim: "#bd677ebd", bright: "#f2e1e5e6", bevel: "#edd5dcd9" } },
    navy: { strip: "#20326e", mat: "#222e5c", aero: { rim: "#6a9fdfbd", bright: "#e1ecf9e6", bevel: "#d6e5f6d9" } },
    slate: { strip: "#465260", mat: "#3e4650", aero: { rim: "#8e9cacbd", bright: "#e8ebeee6", bevel: "#e0e4e8d9" } },
    ivory: { strip: "#c4b48c", mat: "#ece4d0", aero: { rim: "#dfd7bebd", bright: "#f9f7f2e6", bevel: "#f6f4edd9" } }
  };
  var CAPTION_STYLES = {
    minimalDark: {
      frame: 1,
      backing: "#0a140ebf",
      border: "#ffffff40",
      title: "#ffffff",
      byline: "#c8d4cc",
      shadow: "#00000096",
      rule: "#ffffff33"
    },
    minimalLight: { frame: 0, strip: 6, backing: "#f2efe8d9", title: "#161616", byline: "#4a4a4a", rule: "#00000026" },
    aero: {
      frame: 7,
      // AERO_RIM: outline, bright line, rim; then the inner panel's bevel row
      radius: 8,
      // AERO_RADIUS: the corner pieces' side
      outline: "#141e32bf",
      title: "#0b1622",
      byline: "#1d3048",
      glow: "#ffffff46",
      glowFar: "#ffffff28",
      // glow: the text again round itself
      ruleDark: "#00000030",
      ruleLight: "#ffffffa0",
      frostWidth: 192,
      frostHeight: 96
      // FROST_W x FROST_H
    },
    canvas: {
      frame: 19,
      // GALLERY (10) + the mat (9)
      gallery: 10,
      bevel: 2,
      // the mat's cream bevel round the opening, lit edges (bottom, right) and shaded ones (top, left)
      bevelLit: "#f0e8d6",
      bevelShade: "#d4c8b0",
      frameShadow: "#0000004d",
      dropShadow: "#00000024",
      // three steps of it, offset down and right
      title: "#2a1c12",
      titleGlint: "#fffaeb5a",
      byline: "#5a4430",
      rule: "#5a462e50",
      linenWidth: 192,
      linenHeight: 96
      // CANVAS_W x CANVAS_H
    },
    // Fonts (system fonts, patch 0015; the default sans where missing): Segoe UI for Minimal and Aero.
    sans: "segoeui.ttf",
    sansBold: "segoeuib.ttf",
    sansItalic: "segoeuii.ttf",
    titleSize: 30,
    bylineSize: 15
  };
  var CAPTION = {
    margin: 28,
    // from the window's top and left edges (the bar keeps 28 px from the bottom)
    maxWidth: 560,
    padX: 18,
    padY: 10,
    // above and below the byline section
    titlePadY: 16,
    // above and below the title (owner, 2026-11-03: the title takes more of the frame)
    frame: 14,
    // the gold moulding's width (tools/mkframe.py THICK)
    frameTile: 16,
    // its edge tiles' length (TILE)
    marbleWidth: 576,
    // the marble texture's size (MARBLE_W x MARBLE_H): no mat is larger
    marbleHeight: 256,
    velvetWidth: 192,
    // a velvet tile (VELVET_W x VELVET_H), repeated across the byline's band
    velvetHeight: 96,
    woodPieces: 4,
    // pieces along the wood strip (WOOD_LEN / 32)
    woodPiece: 32,
    // each piece's length
    ruleHeight: 9,
    // the wood divider (WOOD_H), bevelled at its top and bottom
    titleFont: "georgiab.ttf",
    // a system font (patch 0015); the default sans where it is missing
    titleSize: 34,
    bylineFont: "georgiai.ttf",
    bylineSize: 16,
    fadeOut: 500,
    // (it fades in with the park: settings.fadeMs)
    barGap: 12,
    // from the controls bar's backing while it shows (hidden, the bottom placements keep the margin)
    minBeside: 300,
    // bottom left goes above the bar when less room than this is left beside it
    z: 40
    // under the load cover (Z.cover), so a dip to black covers it
  };
  var Z = {
    cover: 50,
    backing: 100,
    face: 101,
    bevel: 102,
    icon: 103,
    tip: 110
  };

  // src/cover.ts
  var OVERLAY_ID = "rcts.cover";
  var Cover = class {
    constructor(fadeMs, overlay) {
      this.fadeMs = fadeMs;
      this.overlay = overlay;
      this.from = 0;
      this.to = 0;
      this.started = 0;
      this.duration = 0;
      this.shown = false;
    }
    /** Current opacity, 0 (clear) to 1 (black). */
    opacity() {
      if (this.duration <= 0) {
        return this.to;
      }
      const t = Math.min(1, (Date.now() - this.started) / this.duration);
      return this.from + (this.to - this.from) * t;
    }
    /** True once the fade has reached its target and has been drawn at least once there. */
    settled(settleMs = 0) {
      return Date.now() - this.started >= this.duration + settleMs;
    }
    fadeTo(target) {
      if (!this.overlay) {
        return;
      }
      const from = this.opacity();
      this.from = from;
      this.to = target;
      this.started = Date.now();
      this.duration = this.fadeMs * Math.abs(target - from);
      if (target > 0 || this.shown) {
        this.overlay.set(OVERLAY_ID, {
          type: "rect",
          x: 0,
          y: 0,
          width: ui.width,
          height: ui.height,
          fill: "#000000",
          opacity: from,
          z: Z.cover
        });
        this.overlay.fade(OVERLAY_ID, target, this.duration);
        this.shown = true;
      }
    }
    /** Removes the rectangle once a fade to clear has finished. */
    update() {
      if (this.shown && this.to === 0 && this.settled()) {
        this.close();
      }
    }
    close() {
      if (this.shown) {
        this.overlay?.remove(OVERLAY_ID);
        this.shown = false;
      }
      this.from = this.to = 0;
      this.duration = 0;
    }
  };

  // src/measure.ts
  var TILE3 = 32;
  var TRIM = 0.01;
  var MAX_TILES = 128 * 128;
  function scan(bounds) {
    const all = [];
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        let count = 0;
        let zlo = Infinity;
        let zhi = -Infinity;
        let zsum = 0;
        for (const e of map.getTile(x, y).elements) {
          if (e.type === "surface") {
            zlo = Math.min(zlo, e.baseZ);
          } else if (!e.isHidden && !e.isGhost) {
            count++;
            zsum += e.baseZ;
            zlo = Math.min(zlo, e.baseZ);
            zhi = Math.max(zhi, e.clearanceZ);
          }
        }
        if (count > 0) {
          all.push({ x, y, zlo, zhi, weight: count * count, count, zsum });
        }
      }
    }
    const detailed = all.filter((t) => t.count >= 2);
    return detailed.length > 0 ? detailed : all;
  }
  function trimmed(values) {
    values.sort((a, b) => a[0] - b[0]);
    const total = values.reduce((s, v) => s + v[1], 0);
    let seen = 0;
    let lo = values[0][0];
    let hi = values[values.length - 1][0];
    let loFound = false;
    for (const [v, w] of values) {
      seen += w;
      if (!loFound && seen > total * TRIM) {
        lo = v;
        loFound = true;
      }
      if (seen >= total * (1 - TRIM)) {
        hi = v;
        break;
      }
    }
    return [lo, hi];
  }
  function measureLoaded(bounds) {
    if ((bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1) > MAX_TILES) {
      return void 0;
    }
    let tiles;
    try {
      tiles = scan(bounds);
    } catch {
      return void 0;
    }
    if (tiles.length === 0) {
      return void 0;
    }
    const elements = tiles.reduce((s, t) => s + t.count, 0);
    const z = tiles.reduce((s, t) => s + t.zsum, 0) / elements;
    const cx = tiles.reduce((s, t) => s + (t.x + 0.5) * t.count, 0) / elements;
    const cy = tiles.reduce((s, t) => s + (t.y + 0.5) * t.count, 0) / elements;
    const cache = [];
    return (rotation) => {
      if (cache[rotation] === void 0) {
        const xs = [];
        const ys = [];
        for (const t of tiles) {
          for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            for (const h of [t.zlo, t.zhi]) {
              const p = toScreen((t.x + dx) * TILE3, (t.y + dy) * TILE3, h, rotation);
              xs.push([p.x, t.weight]);
              ys.push([p.y, t.weight]);
            }
          }
        }
        const [xlo, xhi] = trimmed(xs);
        const [ylo, yhi] = trimmed(ys);
        const centre = toScreen(cx * TILE3, cy * TILE3, z, rotation);
        cache[rotation] = { xlo, xhi, ylo, yhi, z, cx: centre.x, cy: centre.y };
      }
      return cache[rotation];
    };
  }

  // src/pan.ts
  var MAX_ZOOM3 = 3;
  var MIN_PAN_MS = 500;
  function panTolerance(zoom, base = 500, step = 100) {
    return Math.max(step, base - step * (zoom + 2));
  }
  var Pan = class {
    /**
     * A pan from `from` to `to`, moving for `moveMs`. A pan faster on average than `tolerance` at
     * the zoom it runs at (screen px/s) travels zoomed out, a level at a time while it is still
     * too fast there, where that is allowed (one level between views at one zoom, up to the wider
     * view's zoom between zooms). It is not a speed cap: the move keeps its time (generation
     * stretches pans that are too fast). With `inertia`
     * it starts and stops slowly (cubic ease, top speed 3 times the average); without, it moves
     * at one speed. After a change at the start it waits `changeHold` ms before moving; before a
     * change on arrival it rests `arriveHold` ms. With `stepOut`, a pan to a wider view zooms out
     * as it goes (see the top of this file); `speed` is then its one screen speed.
     */
    constructor(from, to, moveMs, tolerance, changes, inertia, changeHold, arriveHold, stepOut = false) {
      this.from = from;
      this.to = to;
      this.moveMs = moveMs;
      this.inertia = inertia;
      if (stepOut && to.zoom > from.zoom) {
        const start = toScreen(from.x, from.y, from.z, from.rotation);
        const end = toScreen(to.x, to.y, to.z, from.rotation);
        const levels = range(from.zoom + 1, to.zoom);
        const weights = levels.map((z) => 2 ** z);
        const total = weights.reduce((s, w) => s + w, 0);
        let sum = 0;
        this.levels = levels;
        this.reach = weights.map((w) => (sum += w) / total);
        this.travel = { rotation: from.rotation, zoom: levels[0] };
        const distance2 = Math.hypot(end.x - start.x, end.y - start.y);
        this.speed = distance2 / (total * moveMs / levels.length) * 1e3;
        this.changesAtStart = true;
        this.changesAtEnd = from.rotation !== to.rotation;
        this.lead = 0;
        this.rest = this.changesAtEnd ? arriveHold : 0;
        return;
      }
      const turn = (to.rotation - from.rotation + 4) % 4;
      const turnFirst = turn === 2 ? 1 : changes === "start" ? turn === 3 ? -1 : turn : 0;
      const rotation = (from.rotation + turnFirst + 4) % 4;
      const dz = to.zoom - from.zoom;
      const zoomFirst = Math.abs(dz) <= 1 ? changes === "start" ? dz : 0 : changes === "start" ? dz - Math.trunc(dz / 2) : Math.trunc(dz / 2);
      let zoom = from.zoom + zoomFirst;
      const a = toScreen(from.x, from.y, from.z, rotation);
      const b = toScreen(to.x, to.y, to.z, rotation);
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      const speedAt = (z) => distance / 2 ** z * 1e3 / Math.max(1, moveMs);
      const widest = dz === 0 ? Math.min(MAX_ZOOM3, from.zoom + 1) : Math.max(from.zoom, to.zoom);
      while (zoom < widest && speedAt(zoom) > tolerance(zoom)) {
        zoom++;
      }
      this.travel = { rotation, zoom };
      this.levels = [zoom];
      this.reach = [1];
      this.speed = speedAt(zoom);
      this.changesAtStart = rotation !== from.rotation || zoom !== from.zoom;
      this.changesAtEnd = rotation !== to.rotation || zoom !== to.zoom;
      this.lead = this.changesAtStart ? changeHold : 0;
      this.rest = this.changesAtEnd ? arriveHold : 0;
    }
    /** ms from setting off to the next view: the lead after a change at the start, the move, and
     * the rest before a change on arrival. */
    get duration() {
      return this.lead + this.moveMs + this.rest;
    }
    /** False when the pan is too short to see or goes nowhere: the view change cuts. */
    get worthwhile() {
      const f = this.from;
      const t = this.to;
      return this.moveMs >= MIN_PAN_MS && Math.hypot(t.x - f.x, t.y - f.y, t.z - f.z) >= 16;
    }
    /** The widest zoom the pan runs at (its speed is checked against the tolerance there). */
    get widestZoom() {
      return this.levels[this.levels.length - 1];
    }
    /** The travel angle and zoom as it sets off (for tests and the debug log). */
    get travelling() {
      return { ...this.travel };
    }
    /** The camera `ms` after the pan set off; the next view exactly once it is over. */
    at(ms) {
      if (ms >= this.duration) {
        return { ...this.to };
      }
      let t = Math.min(1, Math.max(0, ms - this.lead) / this.moveMs);
      t = this.inertia ? cubic(t) : t;
      const n = this.levels.length;
      const level = Math.min(n - 1, Math.floor(t * n));
      const before = level > 0 ? this.reach[level - 1] : 0;
      const u = before + (this.reach[level] - before) * (t * n - level);
      const f = this.from;
      return {
        x: f.x + (this.to.x - f.x) * u,
        y: f.y + (this.to.y - f.y) * u,
        z: f.z + (this.to.z - f.z) * u,
        rotation: this.travel.rotation,
        zoom: this.levels[level]
      };
    }
  };
  function range(a, b) {
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  function cubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - 4 * (1 - t) * (1 - t) * (1 - t);
  }

  // src/scale.ts
  var DESIGN_SCREEN = { width: 1920, height: 1080 };
  var ZOOM_SLACK = 0.25;
  var MIN_ZOOM3 = -2;
  var MAX_ZOOM4 = 3;
  var NO_SCALING = { offset: 0, scale: 1 };
  function scalingFor(design, window) {
    if (!design || design.width <= 0 || design.height <= 0 || window.width <= 0 || window.height <= 0) {
      return NO_SCALING;
    }
    const scale = Math.min(window.width / design.width, window.height / design.height);
    const offset = Math.ceil(Math.log2(1 / scale) - ZOOM_SLACK);
    return { offset: Object.is(offset, -0) ? 0 : offset, scale };
  }
  function scaleViews(views, scaling) {
    if (scaling.offset === 0) {
      return views;
    }
    return views.map((v) => ({ ...v, zoom: Math.min(MAX_ZOOM4, Math.max(MIN_ZOOM3, v.zoom + scaling.offset)) }));
  }
  function scaleTolerance(tolerance, scaling) {
    const factor = Math.min(1, scaling.scale);
    return (zoom) => tolerance(zoom - scaling.offset) * factor;
  }
  function screenOf(pair) {
    return pair && pair.length === 2 ? { width: pair[0], height: pair[1] } : void 0;
  }

  // src/player.ts
  var MIN_SPEED = 1;
  var MAX_SPEED = 4;
  var UPDATE_SETTLE_MS = 150;
  var LOAD_TIMEOUT_MS = 3e3;
  var BACKGROUND_LOAD_TIMEOUT_MS = 6e4;
  var SHOW_TAIL_MS = 3e3;
  var SOUND_FADE_MS = 750;
  var PREVIEW_DELAY_MS = 1e3;
  var TICKS_PER_SECOND2 = 40;
  var CUE_WAIT_S = 20;
  var CUE_TAIL_TICKS = 80;
  var CAR_CHECK_TICKS = 4;
  var FOLLOW_EASE = 0.08;
  var DIVERT_MIN_MS = 1500;
  var MIN_DIVERT_MOVE_MS = 1e3;
  var CUT_STAY_S = 4;
  var LATE_MIN_TICKS = 160;
  var CHAIN_S = 4;
  function log2(message2) {
    console.log(`[RCT Screensaver] ${message2}`);
  }
  function range2(n) {
    return Array.from({ length: n }, (_, i) => i);
  }
  var Player = class {
    constructor(playlist, sequence, settings, overlay) {
      this.playlist = playlist;
      this.sequence = sequence;
      this.settings = settings;
      this.parkOrder = [];
      this.parkPos = 0;
      // shuffle: the park after this one, picked on S and on each park load
      this.unplayed = /* @__PURE__ */ new Set();
      // shuffle: parks not played yet this round
      this.history = [];
      // shuffle: the parks played before this one, for previous park
      this.views = [];
      // current park's views, fitted to the window
      this.viewOrder = [];
      this.viewPos = 0;
      this.viewStarted = 0;
      // Date.now() when the current view was shown
      this.camEpoch = Date.now();
      // camera log times count from here
      this.panReturning = false;
      // the current pan goes back to the park's first view
      this.panMoving = false;
      // camera log: the current pan has started / finished moving
      this.panArrived = false;
      // camera log: the last tick's screen point
      this.panPeak = 0;
      // camera log: fastest tick of the current pan, screen px/s
      this.panTicks = 0;
      // camera log: ticks the current pan has moved on
      this.soundsFaded = false;
      // the current view's sounds have faded out ahead of its end
      this.loadingPark = false;
      // waiting for the built-in player to finish a LOAD
      this.seeked = 0;
      // park changes dip through black on the overlay (screensaver mode)
      this.dipping = false;
      // the cover is fading in over a ready park, which waits for it
      this.holding = false;
      this.editing = false;
      // the view editor is open: no automatic advance, unless previewing
      this.previewing = false;
      // the editor plays the park's views (with pans), looping in the park
      this.running = false;
      this.edits = loadEdits();
      // and as saved in the game's storage
      this.scalingLogged = "";
      this.panPlanned = false;
      // planned for the current view (pan undefined: it cuts instead)
      this.panStarted = 0;
      // Date.now() when the pan sets off
      this.heldAt = 0;
      // Date.now() when the view was held
      this.bonusMs = 0;
      // added to the current view's hold, so an angle or zoom change stays a moment
      this.pathTicks = 0;
      // game ticks the current view's camera path has run
      this.showOver = false;
      // the show has finished, but the camera is still on its path
      this.pathStarted = false;
      // the show has reached the step the camera path waits for
      this.parkTicks = 0;
      // where a camera following a train is
      this.cutsDone = /* @__PURE__ */ new Set();
      // a cut-in the camera pans to
      this.divertTo = -1;
      // in the editor's preview: the listed position of the cut-in the camera pans to
      this.triggersIn = /* @__PURE__ */ new Set();
      // camera log: car cues (by view) with a car on their tiles
      this.arrivedChanged = false;
      this.installedMusic = "keep";
      /** Which of a park's orders (its views, or one of `variants`) plays on the current visit:
       *  the first visit ever plays the cheapest order and each later visit the next
       *  (circuit_variants); the visit count persists in storage across runs. */
      this.visits = loadVisits();
      this.dip = !!overlay && settings.fadeMs > 0 && backgroundLoading(sequence) && canHoldSwitch(sequence);
      this.cover = new Cover(settings.fadeMs, this.dip ? overlay : void 0);
      this.savedProps = loadPlaylistProps(playlist.sequence);
      this.props = { ...this.savedProps };
      this.noteInstalledMusic(settings.titleMusic);
      this.applyPresentation();
    }
    /** The editor's Title music and Show titles, where set, over the viewer's settings (the mode's
     *  title music takes effect when the caller configures the mode). */
    applyPresentation() {
      if (this.props.titleMusic !== void 0) {
        this.settings.titleMusic = this.props.titleMusic;
      }
      if (this.props.titles !== void 0) {
        this.settings.titlesOverride = this.props.titles ?? void 0;
      }
    }
    /** The settings playback runs with (shared with the controls bar). */
    get liveSettings() {
      return this.settings;
    }
    /** True while the view is held (Space, or the controls bar's hold button). */
    get isHeld() {
      return this.holding;
    }
    get isRunning() {
      return this.running;
    }
    get debug() {
      return this.settings.debug;
    }
    setDebug(on) {
      this.settings.debug = on;
    }
    start() {
      if (this.playlist.parks.length === 0) {
        log2("playlist has no parks");
        return;
      }
      this.running = true;
      this.holding = false;
      this.settings.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, this.settings.speed));
      this.parkOrder = this.orderFromProps();
      this.unplayed.clear();
      this.history = [];
      if (!this.sequence.isPlaying) {
        this.sequence.play();
      }
      log2(`playing "${this.playlist.sequence}" (${this.playlist.parks.length} parks)`);
      this.enterPark(this.settings.shuffle ? context.getRandom(0, this.parkOrder.length) : 0, false);
    }
    stop() {
      this.running = false;
      this.soundsFaded = false;
      fadeSounds(this.sequence, 1, SOUND_FADE_MS);
      this.cover.close();
      this.releaseSwitch();
      this.clearPan();
    }
    /** Plays a new build of the playlist (the engine has put its sequence in place and reloaded the
     *  script): the park on screen is entered again from the new sequence (it dips through black as a
     *  park change does), at its place in the new order, or the first park when the build dropped it. */
    swapPlaylist(playlist) {
      const keyOf = (p) => p.key ?? p.fileName;
      const current = this.running && this.parkOrder.length ? keyOf(this.currentPark()) : void 0;
      this.playlist = playlist;
      if (!this.running) {
        return;
      }
      this.parkOrder = this.orderFromProps();
      this.unplayed.clear();
      this.history = [];
      this.upNext = void 0;
      this.loadingPark = false;
      this.dipping = false;
      const at = this.parkOrder.findIndex((i) => keyOf(playlist.parks[i]) === current);
      log2(`playing the new build of "${playlist.sequence}" (${playlist.parks.length} parks)`);
      if (this.parkOrder.length) {
        this.enterPark(Math.max(0, at), false);
      }
    }
    /** Stops, and hands the title screen back to the user's own title sequence. */
    release() {
      this.stop();
      if (this.sequence.isPlaying) {
        this.sequence.stop();
      }
    }
    /** Moves a panning camera on; called every game tick (40 times a second). */
    stepCamera() {
      const now = Date.now();
      if (this.pan && !this.holding && this.playing() && now >= this.panStarted) {
        const ms = now - this.panStarted;
        if (!this.panMoving && ms >= this.pan.lead) {
          this.panMoving = true;
          this.camLog("move", `ms=${Math.round(this.pan.duration - this.pan.lead - this.pan.rest)}`);
        }
        const pose = this.pan.at(ms);
        if (this.settings.cameraLog && this.panMoving && !this.panArrived) {
          const p = toScreen(pose.x, pose.y, pose.z, pose.rotation);
          if (this.panLast) {
            const px = Math.hypot(p.x - this.panLast.x, p.y - this.panLast.y) / 2 ** pose.zoom;
            this.panPeak = Math.max(this.panPeak, px * TICKS_PER_SECOND2);
          }
          this.panLast = { x: p.x, y: p.y };
          this.panTicks++;
        }
        if (!this.panArrived && ms >= this.pan.duration - this.pan.rest) {
          this.logPanStop();
        }
        this.applyPose(pose);
      }
    }
    /** Called every game tick: the park's clock, event cues and show paths keep game time with
     * the companions, which count their frames in game ticks too. */
    tick() {
      if (this.loadingPark) {
        return;
      }
      this.parkTicks++;
      this.stepCue();
      this.stepPath();
    }
    /** Moves the camera along a show view's path. */
    stepPath() {
      const view = this.views[this.viewOrder[this.viewPos]];
      if (!view?.path || !this.pathStarted || this.holding || this.loadingPark || !this.playing()) {
        return;
      }
      this.pathTicks++;
      this.applyPose(pathPose(view, this.pathTicks));
      if (this.pathTicks === pathArrival(view)) {
        const c = ui.mainViewport.getCentrePosition();
        this.camLog("path", `end ticks=${this.pathTicks} center=${Math.floor(c.x / 32)},${Math.floor(c.y / 32)}`);
      }
      if (this.showOver && this.pathTicks >= pathArrival(view)) {
        this.leaveShow();
      }
    }
    /** Called every ~100 ms of real time. */
    update() {
      if (!this.running) {
        return;
      }
      this.cover.update();
      if (!this.sequence.isPlaying) {
        log2("title sequence stopped playing; restarting");
        this.sequence.play();
        this.enterPark(this.parkPos, false);
        return;
      }
      if (this.loadingPark) {
        const timeout = backgroundLoading(this.sequence) ? BACKGROUND_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS;
        if (!this.parkIsLoaded() && (Date.now() - this.seeked > timeout || this.loadSkipped())) {
          log2(`"${this.currentPark().name}" did not load; skipping it`);
          this.skipFailedPark();
          return;
        }
        if (this.dip && !this.parkIsLoaded()) {
          const sequence = this.sequence;
          if (!this.dipping && sequence.nextParkReady) {
            this.dipping = true;
            this.cover.fadeTo(1);
          } else if (this.dipping && sequence.holdSwitch && this.cover.settled(UPDATE_SETTLE_MS)) {
            sequence.holdSwitch = false;
          }
        }
        if (this.parkIsLoaded()) {
          this.loadingPark = false;
          this.releaseSwitch();
          this.parkTicks = 0;
          this.refitLoaded();
          this.applySpeed();
          this.showView(false, "load");
          this.cover.fadeTo(0);
        }
        return;
      }
      const advancing = !this.holding && this.playing();
      const elapsed = Date.now() - this.viewStarted;
      if (advancing && !this.panPlanned) {
        this.planPan();
      }
      if (advancing && elapsed >= this.currentHold() * 1e3 && !this.onPath() && (!!this.pendingCue || !this.onCue())) {
        if (!this.pendingCue && this.chainCut()) {
          return;
        }
        this.next(true);
      } else if (advancing && !this.soundsFaded && !this.pan && this.msLeft(elapsed) <= SOUND_FADE_MS) {
        this.soundsFaded = true;
        fadeSounds(this.sequence, 0, SOUND_FADE_MS);
      } else if (!advancing && this.soundsFaded) {
        this.soundsFaded = false;
        fadeSounds(this.sequence, 1, SOUND_FADE_MS);
      }
    }
    /** `byPlayback`: playback moved on by itself (not a key). */
    next(byPlayback = false) {
      if (this.pendingCue && this.divertTo >= 0) {
        this.viewPos = this.divertTo;
        this.divertTo = -1;
        this.showView(byPlayback, "cutin");
        return;
      }
      this.dropCut();
      if (this.editing || byPlayback && this.loopsAlone()) {
        this.viewPos = this.nextInLoop(this.viewPos);
        this.showView(byPlayback, "loop");
      } else if (this.viewPos + 1 < this.viewOrder.length) {
        this.viewPos++;
        this.showView(byPlayback, "next");
      } else {
        this.nextPark();
      }
    }
    /** The position after `pos` in a looping park, past any cut-in view the editor lists in place. */
    nextInLoop(pos) {
      const n = this.viewOrder.length;
      for (let k = 1; k <= n; k++) {
        const next = (pos + k) % n;
        if (!(this.editing && this.previewing && this.views[this.viewOrder[next]]?.cue?.cut)) {
          return next;
        }
      }
      return n > 0 ? (pos + 1) % n : 0;
    }
    previous() {
      if (this.dropCut()) {
        this.showView(false, "uncut");
      } else if (this.viewPos > 0) {
        this.viewPos--;
        this.showView(false, "previous");
      } else {
        this.previousPark(true);
      }
    }
    nextPark() {
      const pos = this.upNext ?? (this.parkPos + 1) % this.parkOrder.length;
      if (this.settings.shuffle) {
        this.history.push(this.parkPos);
      }
      this.enterPark(pos, false);
    }
    previousPark(atLastView = false) {
      const pos = (this.settings.shuffle ? this.history.pop() : void 0) ?? (this.parkPos - 1 + this.parkOrder.length) % this.parkOrder.length;
      this.enterPark(pos, atLastView);
    }
    /** Shuffle picks the next park at random from those not played yet this round (every park
     * plays once per round); it only changes the order of parks, never of a park's views. */
    pickNext() {
      this.upNext = void 0;
      if (!this.settings.shuffle || this.parkOrder.length < 2) {
        return;
      }
      this.unplayed.delete(this.parkPos);
      if (this.unplayed.size === 0) {
        this.unplayed = new Set(range2(this.parkOrder.length).filter((p) => p !== this.parkPos));
      }
      const pool = [...this.unplayed];
      this.upNext = pool[context.getRandom(0, pool.length)];
    }
    toggleHold() {
      this.holding = !this.holding;
      if (this.holding) {
        this.heldAt = Date.now();
      } else if (this.pan) {
        const held = Date.now() - this.heldAt;
        this.viewStarted += held;
        this.panStarted += held;
      } else {
        this.viewStarted = Date.now();
      }
      log2(this.holding ? "holding view" : "released view");
    }
    toggleShuffle() {
      this.settings.shuffle = !this.settings.shuffle;
      saveSettings(this.settings);
      this.unplayed.clear();
      this.history = [];
      this.pickNext();
      log2(`shuffle ${this.settings.shuffle ? "on" : "off"}`);
    }
    changeSpeed(delta) {
      const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, this.settings.speed + delta));
      if (speed !== this.settings.speed) {
        this.settings.speed = speed;
        saveSettings(this.settings);
      }
      this.applySpeed();
      log2(`speed ${speed}`);
    }
    setEditing(on) {
      this.editing = on;
      this.previewing = false;
      const current = this.viewOrder[this.viewPos];
      this.pendingCue = void 0;
      this.divertTo = -1;
      this.viewOrder = this.makeViewOrder();
      const pos = this.viewOrder.indexOf(current);
      this.viewPos = pos >= 0 ? pos : Math.min(this.viewPos, Math.max(0, this.viewOrder.length - 1));
      this.clearPan();
      if (!on) {
        this.viewStarted = Date.now();
      }
    }
    /** Playback runs: always outside the editor; inside it while previewing, once the wait after
     * the last edit is over (the view's hold starts then, see restartPreview). */
    playing() {
      return !this.editing || this.previewing && Date.now() >= this.viewStarted;
    }
    /** The current park's views loop on their own: in the editor's preview, or when the playlist
     * has one park. */
    loopsAlone() {
      return this.editing || this.parkOrder.length === 1 || this.timelineAhead();
    }
    /** A cut-in view on the park's clock (a timeline cue) is still to come this visit: the park's
     * views loop on until it has played, rather than the park changing before its moment. */
    timelineAhead() {
      return this.views.some((v, i) => v.cue?.cut && v.cue.tick !== void 0 && !v.cue.every && !this.cutsDone.has(i) && this.parkTicks < v.cue.tick + v.cue.ticks);
    }
    get isPreviewing() {
      return this.previewing;
    }
    /** Editor: plays the park's views with their pans (looping in the park), or stops. */
    setPreview(on, from = this.viewOrder[this.viewPos] ?? 0) {
      this.previewing = on && this.editing;
      if (this.previewing) {
        this.restartPreview(from);
      } else {
        this.clearPan();
      }
    }
    /** Editor: shows view `from` and plays on from it `delayMs` from now (an edit restarts it). */
    restartPreview(from, delayMs = PREVIEW_DELAY_MS) {
      if (!this.previewing) {
        return;
      }
      const pos = this.viewOrder.indexOf(from);
      this.viewPos = pos >= 0 ? pos : 0;
      this.showView(false, "preview");
      this.viewStarted = Date.now() + delayMs;
    }
    get parkNames() {
      return this.playlist.parks.map((p) => p.name);
    }
    /** The parks' keys in play order. */
    get playOrderKeys() {
      return this.parkOrder.map((i) => this.playlist.parks[i].key ?? this.playlist.parks[i].fileName);
    }
    /** The playlist index of the park with this key, or -1. */
    parkIndexOf(key) {
      return this.playlist.parks.findIndex((p) => (p.key ?? p.fileName) === key);
    }
    /** Playlist indices of the parks in play order (the view editor's Playlist order). */
    get playOrder() {
      return [...this.parkOrder];
    }
    /** How many views each park has (by playlist index): its edits', else the playlist's. */
    viewCountOf(index) {
      if (index === this.parkIndex && !this.loadingPark) {
        return this.views.length;
      }
      const park = this.playlist.parks[index];
      const edit = park?.key !== void 0 ? this.edits[park.key] : void 0;
      return edit?.views?.length ?? (edit?.reset ? park.defaultViews?.length : void 0) ?? park?.views.length ?? 0;
    }
    /** The play order from the editor's saved order (parks it does not name keep theirs, after it). */
    orderFromProps() {
      const parks = this.playlist.parks;
      const order = this.props.order ?? [];
      const rank = (i) => {
        const r = order.indexOf(parks[i].key ?? parks[i].fileName);
        return r < 0 ? order.length + i : r;
      };
      return range2(parks.length).sort((a, b) => rank(a) - rank(b));
    }
    /** Moves a park in the play order (positions), keeping the park on screen; saved at once. */
    moveParkInOrder(from, to) {
      const n = this.parkOrder.length;
      if (from === to || from < 0 || to < 0 || from >= n || to >= n) {
        return;
      }
      const current = this.parkOrder[this.parkPos];
      const [moved] = this.parkOrder.splice(from, 1);
      this.parkOrder.splice(to, 0, moved);
      this.parkPos = this.parkOrder.indexOf(current);
      this.unplayed.clear();
      this.history = [];
      this.pickNext();
      const order = this.parkOrder.map((i) => this.playlist.parks[i].key ?? this.playlist.parks[i].fileName);
      this.props.order = order;
      this.savedProps.order = order;
      savePlaylistProps(this.playlist.sequence, this.savedProps);
    }
    get sequenceName() {
      return this.playlist.sequence;
    }
    /** The playlist's own values for the editor's Playlist properties, as built. */
    get playlistDefaults() {
      const p = this.playlist;
      return {
        inertia: p.inertia ?? this.settings.inertia,
        panChanges: p.panChanges ?? this.settings.panChanges,
        changeHold: p.changeHold ?? this.settings.changeHold,
        arriveHold: p.arriveHold ?? this.settings.arriveHold,
        returnHold: p.returnHold ?? this.settings.returnHold,
        titleMusic: this.installedMusic,
        titles: p.titles ?? null
      };
    }
    /** The title music the install set (settings.titleMusic as playback started), for the editor. */
    noteInstalledMusic(music) {
      this.installedMusic = music === "ride" || music === "theme" ? music : "keep";
    }
    /** The Playlist properties in force: the editor's over the playlist's own. */
    get playlistProps() {
      const d = this.playlistDefaults;
      const p = this.props;
      return {
        inertia: p.inertia ?? d.inertia,
        panChanges: p.panChanges ?? d.panChanges,
        changeHold: p.changeHold ?? d.changeHold,
        arriveHold: p.arriveHold ?? d.arriveHold,
        returnHold: p.returnHold ?? d.returnHold,
        titleMusic: p.titleMusic ?? d.titleMusic,
        titles: p.titles !== void 0 ? p.titles : d.titles
      };
    }
    /** Changes a Playlist property: in force at once (from the next pan), saved with savePlaylistProps. */
    setPlaylistProp(key, value) {
      this.props[key] = value;
      if (key === "titleMusic" || key === "titles") {
        if (key === "titleMusic") {
          this.settings.titleMusic = value ?? this.installedMusic;
        } else {
          this.settings.titlesOverride = value === void 0 ? this.playlist.titles : value ?? void 0;
        }
        return;
      }
      this.clearPan();
    }
    /** The Playlist properties differ from what is saved in the game's storage. */
    get playlistPropsUnsaved() {
      return JSON.stringify(this.props) !== JSON.stringify(this.savedProps);
    }
    savePlaylistProps() {
      this.savedProps = { ...this.props };
      savePlaylistProps(this.playlist.sequence, this.savedProps);
      saveSettings(this.settings);
    }
    /** When the playlist was built and installed (ms since 1970), if known. */
    get builtAt() {
      return this.playlist.built;
    }
    get installedAt() {
      return this.playlist.installed;
    }
    /** The current park's key (its edits, checkpoints), or undefined if it cannot be edited. */
    get parkKey() {
      return this.currentPark()?.key;
    }
    /** The current park's views were set by hand at install (its views file): "Last install" differs
     *  from "Generated". */
    get installedHandSet() {
      return this.currentPark()?.handSet === true;
    }
    /** The views the park would play without the editor's edits: the playlist's own ("Generated", or
     *  with `installed` the views as installed, hand-set ones included). */
    baseViews(installed = false) {
      const park = this.currentPark();
      if (!park || park.key === void 0) {
        return [];
      }
      const saved = this.edits[park.key];
      delete this.edits[park.key];
      if (!installed && park.handSet) {
        this.edits[park.key] = { reset: true };
      }
      try {
        return this.viewsFor(park, !this.loadingPark);
      } finally {
        if (saved) {
          this.edits[park.key] = saved;
        } else {
          delete this.edits[park.key];
        }
      }
    }
    /** Drops the editor's edits of the current park, back to its views as installed. */
    restoreInstalled() {
      const park = this.currentPark();
      if (park.key === void 0 || !this.edits[park.key]) {
        return;
      }
      delete this.edits[park.key];
      saveEdits(this.edits);
      const views = this.viewsFor(park);
      this.remapCues(views);
      this.views = views;
      this.viewOrder = this.makeViewOrder();
      this.viewPos = 0;
      this.showView(false, "revert");
    }
    /** Playlist index of the current park. */
    get parkIndex() {
      return this.parkOrder[this.parkPos];
    }
    get isLoading() {
      return this.loadingPark;
    }
    /** Game ticks since the current park loaded: the clock its timeline cut-ins play on. */
    get parkClock() {
      return this.parkTicks;
    }
    /** Whether the cut-in at `index` has played on this visit (a non-repeating one plays once). */
    cutPlayed(index) {
      return this.cutsDone.has(index);
    }
    /** The current park's views in playlist order (as fitted, unless set in the editor). */
    get currentViews() {
      return this.views;
    }
    /** Index into currentViews of the view on screen. */
    get viewIndex() {
      return this.viewOrder[this.viewPos] ?? -1;
    }
    /** What the park name captions show, and whether the park's first view (its overview) is on
     * screen or being panned back to; undefined while a park loads. */
    get caption() {
      if (this.loadingPark || !this.running) {
        return void 0;
      }
      const park = this.currentPark();
      if (!park) {
        return void 0;
      }
      const returning = this.panReturning && this.panMoving;
      return { key: park.key ?? park.name, name: park.name, author: park.author, firstView: this.viewPos === 0 || returning };
    }
    /** True when the current park's views were set in the editor. */
    get isEdited() {
      const park = this.currentPark();
      const edit = park.key !== void 0 ? this.edits[park.key] : void 0;
      return edit ? !edit.reset : park.handSet === true;
    }
    get canEdit() {
      return this.currentPark().key !== void 0;
    }
    goToPark(index) {
      const pos = this.parkOrder.indexOf(index);
      if (pos >= 0 && pos !== this.parkPos) {
        this.enterPark(pos, false);
      }
    }
    showViewAt(index) {
      const pos = this.viewOrder.indexOf(index);
      if (pos >= 0) {
        this.viewPos = pos;
        this.showView(false, "select");
      }
    }
    /** Replaces the current park's views with hand-set ones and saves them; `show` is displayed. */
    setViews(views, show = -1, arranged = false) {
      const key = this.currentPark().key;
      if (key === void 0) {
        return;
      }
      if (JSON.stringify(views) !== JSON.stringify(this.views) || arranged && !this.edits[key]?.arranged) {
        const screen = [ui.width, ui.height];
        this.edits[key] = arranged || this.edits[key]?.arranged ? { views, arranged: true, screen } : { views, screen };
        saveEdits(this.edits);
      }
      const current = show >= 0 ? show : this.viewOrder[this.viewPos] ?? 0;
      this.clearPan();
      this.remapCues(views);
      this.views = views;
      this.viewOrder = range2(views.length);
      this.viewPos = Math.max(0, Math.min(views.length - 1, current));
      if (show >= 0) {
        this.showView(false, "edit");
      }
    }
    /** Carries the visit's cut-in record over to a new list of the same park's views: cut-ins are
     *  tracked by index, and an edit (a move, an insert, a delete) shifts the indices. Each event
     *  view is matched by its trigger (cue, animation, show), so a played cut-in stays played and
     *  a pending one stays pending wherever it now sits; one no longer in the list is dropped. */
    remapCues(views) {
      const keyOf = (v) => v && (v.cue || v.show || v.animation) ? JSON.stringify([v.cue, v.show, v.animation]) : void 0;
      const taken = /* @__PURE__ */ new Set();
      const find = (i) => {
        const key = keyOf(this.views[i]);
        if (key === void 0) {
          return -1;
        }
        let best = -1;
        views.forEach((v, j) => {
          if (!taken.has(j) && keyOf(v) === key && (best < 0 || Math.abs(j - i) < Math.abs(best - i))) {
            best = j;
          }
        });
        if (best >= 0) {
          taken.add(best);
        }
        return best;
      };
      const done = /* @__PURE__ */ new Set();
      for (const i of [...this.cutsDone].sort((a, b) => a - b)) {
        const j = find(i);
        if (j >= 0) {
          done.add(j);
        }
      }
      this.cutsDone = done;
      if (this.pendingCue) {
        taken.clear();
        const j = find(this.pendingCue.index);
        this.pendingCue = j >= 0 ? { ...this.pendingCue, index: j } : void 0;
      }
    }
    /** Drops the current park's hand-set views, going back to the playlist's. */
    revertViews() {
      const park = this.currentPark();
      if (park.key === void 0 || !this.isEdited) {
        return;
      }
      if (park.handSet) {
        this.edits[park.key] = { reset: true };
      } else {
        delete this.edits[park.key];
      }
      saveEdits(this.edits);
      const views = this.viewsFor(this.currentPark());
      this.remapCues(views);
      this.views = views;
      this.viewOrder = this.makeViewOrder();
      this.viewPos = 0;
      this.showView(false, "revert");
    }
    /** Camera log: the current pan has reached the next view's spot. */
    logPanStop() {
      this.panArrived = true;
      this.camLog("stop", `peak=${Math.round(this.panPeak)} ticks=${this.panTicks}`);
    }
    /** A camera log line (setting `cameraLog`): ms since the playlist started, an event and its
     * values, read by tools/cameralog.py. */
    camLog(event, values) {
      if (this.settings.cameraLog) {
        log2(`camera ${Date.now() - this.camEpoch} ${event} ${values}`);
      }
      perfMark(`${event} ${values}`);
    }
    describe() {
      const park = this.currentPark();
      const vp = ui.mainViewport;
      const centre = vp.getCentrePosition();
      return `park ${this.parkPos + 1}/${this.parkOrder.length} "${park?.name}" view ${this.viewPos + 1}/${this.viewOrder.length} ${this.loadingPark ? "loading " : ""}${this.holding ? "held " : ""}| viewport centre (${Math.round(centre.x / 32)}, ${Math.round(centre.y / 32)}) rot ${vp.rotation} zoom ${vp.zoom} | seq pos ${this.sequence.position} | speed ${context.gameSpeed} shuffle ${this.settings.shuffle}`;
    }
    currentPark() {
      return this.playlist.parks[this.parkOrder[this.parkPos]];
    }
    /** The speed tolerance a pan from `view` is held to at each zoom: the view's own threshold,
     * else the park's (as the generator used it), else the settings', all set for the playlist's
     * screen and scaled to the window. */
    toleranceOf(view) {
      const scaling = this.scalingFrom(screenOf(this.playlist.screen) ?? DESIGN_SCREEN);
      if (view.zoomThreshold) {
        const threshold = view.zoomThreshold;
        return scaleTolerance(() => threshold, scaling);
      }
      const [base, step] = this.currentPark().panTolerance ?? [this.settings.panTolerance ?? 500, this.settings.panToleranceStep ?? 100];
      return scaleTolerance((zoom) => panTolerance(zoom, base, step), scaling);
    }
    /** The game window, in viewport pixels. */
    window() {
      return { width: ui.width, height: ui.height };
    }
    /** How views set for `screen` play in the window (none when the setting is off or the
     *  screen is unknown). */
    scalingFrom(screen) {
      return this.settings.scaleToWindow === false ? NO_SCALING : scalingFor(screen, this.window());
    }
    /** Logs the window against the playlist's screen when it changes (camera log). */
    logScaling() {
      const design = screenOf(this.playlist.screen) ?? DESIGN_SCREEN;
      const scaling = this.scalingFrom(design);
      const text = `window=${ui.width}x${ui.height} design=${design.width}x${design.height} offset=${scaling.offset} scale=${Math.round(scaling.scale * 1e3) / 1e3}`;
      if (text !== this.scalingLogged) {
        this.scalingLogged = text;
        this.camLog("screen", text);
      }
    }
    /** The share of a view's hold spent panning on to the next view (0: held still, then a cut). */
    panOf(view) {
      return Math.min(1, Math.max(0, view.pan ?? 0));
    }
    panChangesOf(view) {
      return this.changesSetting(view) === "start" ? "start" : "end";
    }
    /** Where a view's pan changes the angle and zoom: the editor's Playlist property (not on overviews:
     *  they keep their own, owner's rule), else the view's, else the settings'. "off": such a pan cuts. */
    changesSetting(view) {
      return (!view.overview ? this.props.panChanges : void 0) ?? view.panChanges ?? this.settings.panChanges;
    }
    inertiaOf(view) {
      return (this.props.inertia ?? view.inertia ?? this.settings.inertia) === true;
    }
    /** A pan hold in ms: the playlist's (settings UI, times its time scaling), else the plugin setting's. */
    holdMs(key, fallback) {
      return Math.max(0, (this.props[key] ?? this.playlist[key] ?? this.settings[key] ?? fallback) * 1e3);
    }
    /** Plans the current view's pan to the next view of the park, if it gets one. */
    planPan() {
      this.panPlanned = true;
      this.pan = void 0;
      const view = this.views[this.viewOrder[this.viewPos]];
      const nextPos = this.editing && this.previewing ? this.nextInLoop(this.viewPos) : this.viewPos + 1;
      let next = nextPos > this.viewPos ? this.views[this.viewOrder[nextPos]] : void 0;
      const first = this.views[this.viewOrder[nextPos > this.viewPos ? 0 : nextPos]];
      const returning = !next && !!first && !first.show && this.currentPark()?.returnPan !== false;
      const toParkChange = returning && !this.loopsAlone();
      if (returning) {
        next = first;
      }
      const effectMs = view?.cue ? this.effectLeftMs() : 0;
      if (!view || !next || view === next || view.show || effectMs === void 0 || this.panOf(view) === 0) {
        this.camLog("plan", "cut");
        return;
      }
      if (this.changesSetting(view) === "off" && (next.rotation !== view.rotation || next.zoom !== view.zoom)) {
        this.camLog("plan", "cut");
        return;
      }
      let still = (1 - this.panOf(view)) * view.hold * 1e3;
      const cueExtra = Math.max(0, Date.now() - this.viewStarted + effectMs - still);
      still += cueExtra;
      if (view.cue && this.cutDueWithin(still + this.panOf(view) * view.hold * 1e3)) {
        this.camLog("plan", "cut");
        return;
      }
      const changeHold = this.holdMs("changeHold", 2);
      const arriveHold = this.holdMs("arriveHold", 1);
      const returnHold = toParkChange ? this.holdMs("returnHold", 2) : 0;
      const tolerance = this.toleranceOf(view);
      const pan = new Pan(
        poseOf(view),
        poseOf(next),
        view.hold * 1e3 - (still - cueExtra),
        tolerance,
        this.panChangesOf(view),
        this.inertiaOf(view),
        changeHold,
        arriveHold,
        returning
      );
      if (pan.worthwhile) {
        const extra = this.arrivedChanged ? Math.max(0, changeHold - still) : 0;
        still += extra;
        this.bonusMs = extra + cueExtra + pan.lead + pan.rest + returnHold;
        this.pan = pan;
        this.panReturning = returning;
        this.panStarted = this.viewStarted + still;
        const t = pan.travelling;
        this.camLog("plan", `still=${Math.round(still)} lead=${pan.lead} rest=${pan.rest} travel=r${t.rotation}z${t.zoom}${pan.levels.length > 1 ? ` out=${pan.widestZoom}` : ""} speed=${Math.round(pan.speed)} tol=${Math.round(tolerance(pan.widestZoom))} return=${returnHold} hold=${Math.round(this.currentHold() * 1e3)}`);
      } else {
        this.camLog("plan", "cut");
      }
    }
    clearPan() {
      if (this.pan && this.panMoving && !this.panArrived && Date.now() - this.panStarted >= this.pan.duration - 100) {
        this.logPanStop();
      }
      this.pan = void 0;
      this.panReturning = false;
      this.panPlanned = false;
      this.panMoving = false;
      this.panArrived = false;
      this.panLast = void 0;
      this.panPeak = 0;
      this.panTicks = 0;
      this.bonusMs = 0;
    }
    /** Event cues, every game tick: cuts in a cued cut-in view, marks the current view's effect
     * as started when its cue fires, and keeps a following camera on its train. */
    stepCue() {
      if (this.settings.cameraLog && this.parkTicks % CAR_CHECK_TICKS === 0) {
        this.logTriggers();
      }
      if (this.holding || this.editing && !this.previewing || !this.playing()) {
        return;
      }
      const index = this.viewOrder[this.viewPos];
      const view = this.views[index];
      const effectEnd = view?.cue && this.cueAt !== void 0 ? this.cueAt + view.cue.ticks : 0;
      const afterCut = !!view?.cue?.cut && this.cueAt !== void 0 && this.parkTicks >= this.cueAt && (Date.now() - this.viewStarted >= CUT_STAY_S * 1e3 || this.parkTicks >= effectEnd);
      if (view && !view.show && (!view.cue || afterCut) && !this.pendingCue) {
        for (const [i, v] of this.views.entries()) {
          if (v.cue?.cut && !this.cutsDone.has(i) && (!view.cue || v.cue.tick !== void 0)) {
            const fired = this.cueFires(v.cue);
            if (fired && v.cue.tick !== void 0 && v.cue.every && fired.at + v.cue.ticks - this.parkTicks < LATE_MIN_TICKS && fired.at < this.parkTicks) {
              continue;
            }
            if (fired) {
              this.cutsDone.add(i);
              this.cutIn(i, fired);
              return;
            }
          }
        }
      }
      const cue = view?.cue;
      if (!cue) {
        return;
      }
      if (this.cueAt === void 0) {
        const fired = this.cueFires(cue);
        if (fired) {
          this.cueAt = fired.at;
          this.cueTrain = fired.train;
          if (this.soundsFaded) {
            this.soundsFaded = false;
            fadeSounds(this.sequence, 1, SOUND_FADE_MS);
          }
          this.camLog("cue", `fired tick=${this.parkTicks} start=${fired.at} ticks=${cue.ticks}${fired.train !== void 0 ? ` train=${fired.train}` : ""}`);
          if (!this.pendingCue) {
            this.clearPan();
            this.panPlanned = false;
          }
        }
      } else if (cue.follow !== void 0 && !this.pendingCue && this.parkTicks >= this.cueAt && this.parkTicks < this.cueAt + cue.ticks) {
        this.followTrain(view, cue);
      }
    }
    /** Camera log: each time a car arrives on a car cue's tiles, whichever view is on screen, so a
     * measuring run gives each trigger's first tick and lap (tools/cameralog.py --triggers). */
    logTriggers() {
      for (const [i, v] of this.views.entries()) {
        if (!v.cue || v.cue.tick !== void 0 || v.cue.ride === void 0 && !v.cue.cars) {
          continue;
        }
        let on = false;
        try {
          on = carOnTiles(v.cue) !== void 0;
        } catch (e) {
          on = false;
        }
        if (on && !this.triggersIn.has(i)) {
          this.camLog("trigger", `view=${i + 1} tick=${this.parkTicks} | ${v.animation ?? ""} | ${this.currentPark()?.name ?? ""}`);
        }
        if (on) {
          this.triggersIn.add(i);
        } else {
          this.triggersIn.delete(i);
        }
      }
    }
    /** Milliseconds until the current event view's effect and its tail are over, once its cue
     * has fired; undefined while it waits. */
    effectLeftMs() {
      const cue = this.views[this.viewOrder[this.viewPos]]?.cue;
      if (!cue || this.cueAt === void 0) {
        return void 0;
      }
      return Math.max(0, (this.cueAt + cue.ticks + CUE_TAIL_TICKS - this.parkTicks) * 1e3 / TICKS_PER_SECOND2);
    }
    /** Another timeline cut-in's lead begins within `ms` (and CHAIN_S): better to wait for it here. */
    cutDueWithin(ms) {
      const current = this.viewOrder[this.viewPos];
      return this.views.some((v, i) => {
        if (i === current || !v.cue?.cut || v.cue.tick === void 0 || this.cutsDone.has(i)) {
          return false;
        }
        const start = nextOccurrence(v.cue, this.parkTicks);
        const from = start - (v.cue.lead ?? 0) * TICKS_PER_SECOND2;
        return from - this.parkTicks <= (ms / 1e3 + CHAIN_S) * TICKS_PER_SECOND2;
      });
    }
    /** A cut-in view ending shortly before another timeline cut-in's lead begins: pans on to that
     * one now, with the longer lead, rather than cutting to an ordinary view for a moment (Void,
     * 2026-10-30: one flashed between two cut-ins). True if it did. */
    chainCut() {
      const view = this.views[this.viewOrder[this.viewPos]];
      if (!view?.cue?.cut || this.editing) {
        return false;
      }
      for (const [i, v] of this.views.entries()) {
        if (v !== view && v.cue?.cut && v.cue.tick !== void 0 && !this.cutsDone.has(i)) {
          const fired = this.cueFires(v.cue, CHAIN_S);
          if (fired && fired.at >= this.parkTicks) {
            this.cutsDone.add(i);
            this.cutIn(i, fired);
            return true;
          }
        }
      }
      return false;
    }
    /** The cue's effect starts at park tick `at` (now, for a car), or it has not fired yet. A
     * timeline cue can fire up to `earlyS` seconds before its lead. */
    cueFires(cue, earlyS = 0) {
      if (cue.tick !== void 0) {
        const start = nextOccurrence(cue, this.parkTicks);
        const from = start - ((cue.lead ?? 0) + earlyS) * TICKS_PER_SECOND2;
        return this.parkTicks >= from && this.parkTicks < start + cue.ticks ? { at: start } : void 0;
      }
      if (cue.ride === void 0 && !cue.cars || this.parkTicks % CAR_CHECK_TICKS !== 0) {
        return void 0;
      }
      let train;
      try {
        train = carOnTiles(cue);
      } catch (e) {
        return void 0;
      }
      return train === void 0 ? void 0 : { at: this.parkTicks, train };
    }
    /** Plays cut-in view `index` after the view on screen, which is cut short: at once, or with
     * a timeline cue's `lead`, by a pan that arrives as the effect starts. */
    cutIn(index, fired) {
      const view = this.views[index];
      const leadMs = (fired.at - this.parkTicks) * 1e3 / TICKS_PER_SECOND2;
      const inPlace = this.editing ? this.viewOrder.indexOf(index) : -1;
      if (inPlace < 0) {
        this.viewOrder.splice(this.viewPos + 1, 0, index);
      }
      const panMs = view.cue?.tick !== void 0 ? Math.max(leadMs, DIVERT_MIN_MS) : leadMs;
      if (panMs >= DIVERT_MIN_MS && this.divert(view, panMs)) {
        this.pendingCue = { index, ...fired };
        this.divertTo = inPlace;
        this.camLog("cue", `divert view=${index + 1} tick=${this.parkTicks} start=${fired.at}`);
        return;
      }
      this.viewPos = inPlace >= 0 ? inPlace : this.viewPos + 1;
      this.showView(true, "cutin");
      this.cueAt = fired.at;
      this.cueTrain = fired.train;
      this.camLog("cue", `cut view=${index + 1} tick=${this.parkTicks} start=${fired.at}`);
    }
    /** Pans from where the camera is now to `view`, ending the current view as it arrives; false
     * when the pan is not worth it (then the caller cuts). */
    divert(view, ms) {
      const current = this.views[this.viewOrder[this.viewPos]];
      if (!current) {
        return false;
      }
      const now = Date.now();
      const from = this.pan ? this.pan.at(now - this.panStarted) : this.followAt ?? poseOf(current);
      const changeHold = this.holdMs("changeHold", 2);
      const arriveHold = this.holdMs("arriveHold", 1);
      const pan = new Pan(
        from,
        poseOf(view),
        Math.max(MIN_DIVERT_MOVE_MS, ms - arriveHold),
        this.toleranceOf(current),
        this.panChangesOf(current),
        this.inertiaOf(current),
        changeHold,
        arriveHold
      );
      if (!pan.worthwhile) {
        return false;
      }
      this.clearPan();
      this.pan = pan;
      this.panPlanned = true;
      this.panStarted = now;
      this.viewStarted = now + pan.duration - current.hold * 1e3;
      return true;
    }
    /** Leaving a cut-in view: it comes out of the view order again, so playback goes on from the
     * view it interrupted. True if the current view was one. */
    dropCut() {
      const view = this.views[this.viewOrder[this.viewPos]];
      if (!view?.cue?.cut || this.editing) {
        return false;
      }
      this.viewOrder.splice(this.viewPos, 1);
      this.viewPos--;
      return true;
    }
    /** Eases the camera toward the train an event view follows. */
    followTrain(view, cue) {
      const car = trainHead(cue.follow, cue.follow === cue.ride ? this.cueTrain : void 0, cue.train);
      if (!car) {
        return;
      }
      const at = this.followAt ?? poseOf(view);
      this.followAt = {
        ...at,
        x: at.x + (car.x - at.x) * FOLLOW_EASE,
        y: at.y + (car.y - at.y) * FOLLOW_EASE,
        z: at.z + (car.z - at.z) * FOLLOW_EASE
      };
      this.applyPose(this.followAt);
    }
    /** True while an event view waits for its cue (at most `wait` past its hold) or its effect
     * runs (at most twice the time it should take, in case ticks stop). */
    onCue() {
      const view = this.views[this.viewOrder[this.viewPos]];
      const cue = view?.cue;
      if (!cue) {
        return false;
      }
      const elapsed = Date.now() - this.viewStarted;
      const wait = (cue.wait ?? CUE_WAIT_S) * 1e3;
      if (this.cueAt === void 0) {
        const missed = cue.tick !== void 0 && !cue.every && this.parkTicks >= cue.tick + cue.ticks;
        return !missed && elapsed < view.hold * 1e3 + wait;
      }
      const left = this.cueAt + cue.ticks + CUE_TAIL_TICKS - this.parkTicks;
      return left > 0 && elapsed < (view.hold + wait / 1e3 + (cue.ticks + CUE_TAIL_TICKS) / TICKS_PER_SECOND2) * 2e3;
    }
    /** Milliseconds the current view has left as far as is known now (an event view's effect
     * not yet cued counts as its wait running out). */
    msLeft(elapsed) {
      const view = this.views[this.viewOrder[this.viewPos]];
      const left = this.currentHold() * 1e3 - elapsed;
      const cue = view?.cue;
      if (!cue || !this.onCue()) {
        return left;
      }
      if (this.cueAt === void 0) {
        return view.hold * 1e3 + (cue.wait ?? CUE_WAIT_S) * 1e3 - elapsed;
      }
      return Math.max(left, (this.cueAt + cue.ticks + CUE_TAIL_TICKS - this.parkTicks) * 1e3 / TICKS_PER_SECOND2);
    }
    /** True while a show view's camera has yet to reach the end of its path: game ticks can run
     * slower than the hold's clock, and the view stays until the camera arrives (at most twice
     * its hold, in case ticks stop). */
    onPath() {
      const view = this.views[this.viewOrder[this.viewPos]];
      return !!view?.path && this.pathTicks < pathArrival(view) && Date.now() - this.viewStarted < view.hold * 2e3;
    }
    currentHold() {
      const view = this.views[this.viewOrder[this.viewPos]];
      return view ? view.hold + this.bonusMs / 1e3 : 10;
    }
    applySpeed() {
      const speed = this.settings.speed;
      if (speed === context.gameSpeed) {
        return;
      }
      context.executeAction("gamesetspeed", { speed }, (result) => {
        if (result.error) {
          log2(`could not set speed ${speed}: ${result.errorMessage ?? result.error}`);
        }
      });
    }
    makeViewOrder() {
      const order = this.buildViewOrder();
      this.camLog("order", `views=${this.views.length} order=${order.join(",")} cuts=${this.views.filter((v) => v.cue?.cut).length}${this.editing ? " editing" : ""} | ${this.currentPark()?.name ?? ""}`);
      return order;
    }
    buildViewOrder() {
      const order = range2(this.views.length).filter((i) => this.editing || !this.views[i].cue?.cut);
      const inPlace = (v) => !isPinned(v) || this.editing && !!v.cue?.cut;
      const free = order.filter((i) => inPlace(this.views[i]));
      const pinned = order.filter((i) => !inPlace(this.views[i]) && !this.views[i].show);
      const shows = order.filter((i) => this.views[i].show);
      const out = [...free, ...pinned];
      for (const i of shows) {
        const at = this.views[i].showAt ?? -1;
        out.splice(Math.max(0, Math.min(out.length, at < 0 ? out.length + 1 + at : at)), 0, i);
      }
      return out;
    }
    /** A companion reports that the show started by the current view has reached a step: a
     * camera path waiting for that step (pathStep) sets off. */
    showStep(name, step) {
      const view = this.views[this.viewOrder[this.viewPos]];
      if (view?.show?.name === name && view.pathStep !== void 0 && step >= view.pathStep) {
        this.pathStarted = true;
      }
    }
    /** A companion reports that the show started by the current view is over. */
    showDone(name) {
      const view = this.views[this.viewOrder[this.viewPos]];
      if (view?.show?.name !== name) {
        return;
      }
      log2(`show "${name}" finished`);
      if (view.path && this.pathStarted && this.pathTicks < pathArrival(view)) {
        this.showOver = true;
        return;
      }
      this.leaveShow();
    }
    /** Leaves the show view shortly, unless its hold runs out first. */
    leaveShow() {
      const view = this.views[this.viewOrder[this.viewPos]];
      this.showOver = false;
      this.viewStarted = Math.min(this.viewStarted, Date.now() - (view.hold * 1e3 - SHOW_TAIL_MS));
    }
    variantOf(park, advance) {
      const count = 1 + (park.variants?.length ?? 0);
      if (count < 2 || park.handSet || this.settings.bench) {
        return park;
      }
      const key = park.key ?? park.fileName;
      let visit = this.visits[key];
      if (visit === void 0) {
        visit = 0;
        this.visits[key] = visit;
        saveVisits(this.visits);
      } else if (advance) {
        visit += 1;
        this.visits[key] = visit;
        saveVisits(this.visits);
      }
      const pick = visit % count;
      return pick === 0 ? park : park.variants[pick - 1];
    }
    /** The park's views; `loaded` once the park is on the map, so it can be measured; `advance`
     *  on entering the park, which moves it to its next order. */
    viewsFor(park, loaded = false, advance = false) {
      this.logScaling();
      const edited = park.key !== void 0 ? this.edits[park.key] : void 0;
      if (edited?.views) {
        return scaleViews(edited.views, this.scalingFrom(screenOf(edited.screen)));
      }
      if (park.handSet && !edited?.reset) {
        return scaleViews(park.views, this.scalingFrom(screenOf(park.viewScreen)));
      }
      const variant = this.variantOf(park, advance);
      if (advance && variant !== park) {
        this.camLog("variant", `${(this.visits[park.key ?? park.fileName] ?? 0) % (1 + (park.variants?.length ?? 0)) + 1}/${1 + (park.variants?.length ?? 0)}`);
      }
      const scaling = this.scalingFrom(screenOf(this.playlist.screen) ?? DESIGN_SCREEN);
      const all = scaleViews(park.handSet ? park.defaultViews ?? [] : variant.views, scaling).map((v) => v.cue && typeof v.cue.ticks !== "number" ? { ...v, cue: { ...v.cue, ticks: 0 } } : v);
      if (!park.bounds) {
        return placeCuts(all);
      }
      const views = all.filter((v) => !isPinned(v));
      const pinned = all.filter(isPinned);
      const measure2 = loaded ? measureLoaded(park.bounds) : void 0;
      const fitted = fitViews(views, park.bounds, this.window(), park.viewCount, measure2, scaling.offset);
      const total = fitted.reduce((s, v) => s + v.hold, 0);
      const parkTime = variant.parkTime ?? park.parkTime;
      if (parkTime && total > 0 && Math.abs(total - parkTime) > 0.5) {
        return placeCuts([...fitted.map((v) => ({ ...v, hold: Math.round(v.hold * parkTime / total * 10) / 10 })), ...pinned]);
      }
      return placeCuts([...fitted, ...pinned]);
    }
    /** Fits the current park's views again now that its elements can be measured. */
    refitLoaded() {
      const views = this.viewsFor(this.currentPark(), true);
      const resized = views.length !== this.views.length;
      this.remapCues(views);
      this.views = views;
      if (resized) {
        this.viewOrder = this.makeViewOrder();
        this.viewPos = Math.min(this.viewPos, Math.max(0, views.length - 1));
      }
    }
    enterPark(pos, atLastView) {
      const sameAsLoaded = !this.loadingPark && this.parkIsLoaded(pos);
      this.clearPan();
      this.cutsDone.clear();
      this.triggersIn.clear();
      this.pendingCue = void 0;
      this.parkPos = pos;
      this.pickNext();
      const park = this.currentPark();
      this.views = this.viewsFor(park, false, !sameAsLoaded);
      this.viewOrder = this.makeViewOrder();
      this.viewPos = atLastView ? Math.max(0, this.viewOrder.length - 1) : 0;
      if (sameAsLoaded) {
        this.loadingPark = false;
        this.refitLoaded();
        this.cover.fadeTo(0);
        this.applySpeed();
        this.showView(false, "reenter");
        return;
      }
      log2(`park ${pos + 1}/${this.parkOrder.length}: ${park.name}`);
      perfMark(`park ${pos + 1}/${this.parkOrder.length} ${park.name}`);
      this.loadingPark = true;
      if (!this.soundsFaded) {
        this.soundsFaded = true;
        fadeSounds(this.sequence, 0, SOUND_FADE_MS);
      }
      if (this.dip) {
        this.dipping = false;
        this.sequence.holdSwitch = true;
      }
      this.seekToPark();
    }
    seekToPark() {
      const park = this.currentPark();
      this.seeked = Date.now();
      try {
        this.sequence.seek(park.load);
      } catch (e) {
        log2(`failed to load "${park.name}": ${e}`);
        this.skipFailedPark();
      }
    }
    /** Lets a held park switch go (the dip's cover, if any, fades out with the load). */
    releaseSwitch() {
      this.dipping = false;
      if (this.dip && this.sequence.isPlaying) {
        this.sequence.holdSwitch = false;
      }
    }
    /** Shows the next park after a failed load, rather than waiting on a black screen. */
    skipFailedPark() {
      this.loadingPark = false;
      this.releaseSwitch();
      this.cover.fadeTo(0);
      if (this.parkOrder.length > 1) {
        this.nextPark();
      } else {
        this.soundsFaded = false;
        fadeSounds(this.sequence, 1, SOUND_FADE_MS);
      }
    }
    /** True once the built-in player has executed this park's LOAD and is idling after it. */
    /** The built-in player has moved past the park's commands without loading it. */
    loadSkipped() {
      const position = this.sequence.position;
      const load = this.currentPark().load;
      return position !== null && Date.now() - this.seeked > 500 && (position < load || position >= this.nextLoad(load));
    }
    nextLoad(load) {
      return Math.min(...this.playlist.parks.map((p) => p.load).filter((l) => l > load), Infinity);
    }
    parkIsLoaded(pos = this.parkPos) {
      const position = this.sequence.position;
      if (position === null) {
        return false;
      }
      const load = this.playlist.parks[this.parkOrder[pos]].load;
      return position > load && position < this.nextLoad(load);
    }
    /** `by`: what showed it, for the camera log (diagnosing the order on a park's second visit). */
    showView(byPlayback = false, by = "") {
      const view = this.views[this.viewOrder[this.viewPos]];
      const panned = this.pan !== void 0 && Date.now() - this.panStarted >= this.pan.duration - 100;
      this.arrivedChanged = panned && this.pan.changesAtEnd;
      this.clearPan();
      this.viewStarted = Date.now();
      this.pathTicks = 0;
      this.showOver = false;
      this.pathStarted = view?.pathStep === void 0;
      this.cueAt = this.cueTrain = this.followAt = void 0;
      if (this.pendingCue && this.pendingCue.index === this.viewOrder[this.viewPos]) {
        this.cueAt = this.pendingCue.at;
        this.cueTrain = this.pendingCue.train;
      }
      this.pendingCue = void 0;
      this.divertTo = -1;
      this.soundsFaded = false;
      if (!panned) {
        fadeSounds(this.sequence, 0, 0);
      }
      fadeSounds(this.sequence, 1, SOUND_FADE_MS);
      this.onViewShown?.(view, byPlayback);
      this.camLog("view", `park=${this.parkPos + 1} view=${this.viewPos + 1}/${this.viewOrder.length} ${panned ? "panned" : "cut"}${view?.overview ? " overview" : ""} hold=${Math.round((view?.hold ?? 0) * 1e3)}${by ? ` by=${by}` : ""} index=${this.viewOrder[this.viewPos] ?? -1}${view?.cue ? " cue" : ""} | ${this.currentPark()?.name ?? ""}`);
      if (!view) {
        return;
      }
      this.applyPose(poseOf(view));
      if (view.show) {
        const name = view.show.name;
        context.executeAction(view.show.action, { show: name }, (result) => {
          if (result.error) {
            log2(`show "${name}" not started: ${result.errorMessage ?? result.error}`);
          }
        });
      }
    }
    applyPose(pose) {
      const vp = ui.mainViewport;
      if (vp.rotation !== pose.rotation || vp.zoom !== pose.zoom) {
        this.camLog("change", `r${vp.rotation}z${vp.zoom}>r${pose.rotation}z${pose.zoom}`);
      }
      if (vp.rotation !== pose.rotation) {
        vp.rotation = pose.rotation;
      }
      if (vp.zoom !== pose.zoom) {
        vp.zoom = pose.zoom;
      }
      vp.moveTo({ x: Math.round(pose.x), y: Math.round(pose.y), z: Math.round(pose.z) });
    }
  };
  function poseOf(view) {
    return { x: view.x * 32 + 16, y: view.y * 32 + 16, z: view.z, rotation: view.rotation, zoom: view.zoom };
  }
  function pathPose(view, ticks) {
    const path = view.path ?? [];
    const glide = pathGlide(view);
    let x = view.x, y = view.y, z = view.z, left = ticks;
    for (const p of path) {
      const legTicks = glide ? glide.ticks * legLength({ x, y, z }, p) / glide.length : p.ticks;
      if (left < legTicks) {
        const k = left / Math.max(1, legTicks);
        x += (p.x - x) * k;
        y += (p.y - y) * k;
        z += (p.z - z) * k;
        break;
      }
      left -= legTicks;
      x = p.x;
      y = p.y;
      z = p.z;
    }
    return { ...poseOf(view), x: x * 32 + 16, y: y * 32 + 16, z };
  }
  function legLength(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y, (b.z - a.z) / 32);
  }
  function pathGlide(view) {
    const share = view.pan ?? 0;
    let total = 0, length = 0, at = { x: view.x, y: view.y, z: view.z };
    for (const p of view.path ?? []) {
      total += p.ticks;
      length += legLength(at, p);
      at = p;
    }
    return share > 0 && length > 0 ? { length, ticks: Math.max(1, Math.min(1, share) * total) } : void 0;
  }
  function pathArrival(view) {
    const glide = pathGlide(view);
    if (glide) {
      return Math.ceil(glide.ticks);
    }
    let ticks = 0, arrival = 0, at = { x: view.x, y: view.y, z: view.z };
    for (const p of view.path ?? []) {
      ticks += p.ticks;
      if (legLength(at, p) > 0) arrival = ticks;
      at = p;
    }
    return arrival;
  }
  function nextOccurrence(cue, ticks) {
    const tick = cue.tick;
    if (!cue.every || ticks < tick + cue.ticks) {
      return tick;
    }
    return tick + Math.ceil((ticks - tick - cue.ticks + 1) / cue.every) * cue.every;
  }
  function carOnTiles(cue) {
    const on = (car) => {
      const t = cue.tiles;
      const x = Math.floor(car.x / 32), y = Math.floor(car.y / 32);
      return !t || x >= Math.min(t[0], t[2]) && x <= Math.max(t[0], t[2]) && y >= Math.min(t[1], t[3]) && y <= Math.max(t[1], t[3]);
    };
    if (cue.cars) {
      for (const id of cue.cars) {
        const car = map.getEntity(id);
        if (car && car.type === "car" && on(car)) {
          return id;
        }
      }
      return void 0;
    }
    const ride = map.getRide(cue.ride);
    for (const head of ride?.vehicles ?? []) {
      let id = head;
      for (let n = 0; id !== null && n < 64; n++) {
        const car = map.getEntity(id);
        if (!car) {
          break;
        }
        if (on(car)) {
          return head;
        }
        id = car.nextCarOnTrain;
      }
    }
    return void 0;
  }
  function trainHead(ride, head, index = 0) {
    const car = head !== void 0 ? map.getEntity(head) : null;
    if (car) {
      return car;
    }
    const id = map.getRide(ride)?.vehicles[index];
    return id !== void 0 ? map.getEntity(id) ?? void 0 : void 0;
  }
  function fadeSounds(sequence, level, ms) {
    const fade = sequence.fadeSounds;
    if (typeof fade === "function") {
      fade.call(sequence, level, ms);
    }
  }
  function canHoldSwitch(sequence) {
    return typeof sequence.nextParkReady === "boolean";
  }
  function backgroundLoading(sequence) {
    return sequence.backgroundLoading === true;
  }

  // src/ui/kit.ts
  function contains(r, x, y, margin = 0) {
    return x >= r.x - margin && x < r.x + r.width + margin && y >= r.y - margin && y < r.y + r.height + margin;
  }
  var measured = /* @__PURE__ */ new Map();
  function measure(overlay, text, size, bold = false) {
    const key = `${overlay.scale}|${size}|${bold}|${text}`;
    let m = measured.get(key);
    if (!m) {
      if (measured.size > 200) {
        measured.clear();
      }
      m = overlay.measureText(text, { size, bold });
      measured.set(key, m);
    }
    return m;
  }
  var Layer = class {
    constructor(overlay, prefix) {
      this.overlay = overlay;
      this.prefix = prefix;
      this.sent = /* @__PURE__ */ new Map();
      this.shown = false;
      this.base = /* @__PURE__ */ new Map();
    }
    get visible() {
      return this.shown;
    }
    // each element's own opacity (an inactive button's icon)
    render(scene) {
      for (const [id, element] of scene) {
        const own = element.opacity ?? 1;
        this.base.set(id, own);
        const full = { ...element, opacity: this.shown ? own : 0 };
        const key = JSON.stringify(full);
        if (this.sent.get(id) !== key) {
          this.overlay.set(this.prefix + id, full);
          this.sent.set(id, key);
        }
      }
      for (const id of [...this.sent.keys()]) {
        if (!scene.has(id)) {
          this.overlay.remove(this.prefix + id);
          this.sent.delete(id);
          this.base.delete(id);
        }
      }
    }
    /** Fades every element in or out; elements set later take the new state. */
    show(on, ms) {
      if (on === this.shown) {
        return;
      }
      this.shown = on;
      for (const id of this.sent.keys()) {
        const to = on ? this.base.get(id) ?? 1 : 0;
        this.overlay.fade(this.prefix + id, to, ms);
        const element = JSON.parse(this.sent.get(id));
        this.sent.set(id, JSON.stringify({ ...element, opacity: to }));
      }
    }
    clear() {
      for (const id of this.sent.keys()) {
        this.overlay.remove(this.prefix + id);
      }
      this.sent.clear();
      this.base.clear();
      this.shown = false;
    }
  };
  function bevel(scene, id, r, light, dark, width, z) {
    const w = width;
    scene.set(`${id}.t`, { type: "rect", x: r.x, y: r.y, width: r.width, height: w, fill: light, z });
    scene.set(`${id}.l`, { type: "rect", x: r.x, y: r.y + w, width: w, height: r.height - w, fill: light, z });
    scene.set(`${id}.b`, { type: "rect", x: r.x + w, y: r.y + r.height - w, width: r.width - w, height: w, fill: dark, z });
    scene.set(`${id}.r`, { type: "rect", x: r.x + r.width - w, y: r.y + w, width: w, height: r.height - 2 * w, fill: dark, z });
  }
  function backing(scene, id, r, fill = THEME.backing) {
    scene.set(id, { type: "rect", x: r.x, y: r.y, width: r.width, height: r.height, fill, z: Z.backing });
    bevel(scene, id, r, THEME.backingLight, THEME.backingDark, THEME.bevel, Z.backing);
  }
  function button(scene, id, r, state, content, overlay) {
    const off = state.disabled === true;
    const sunk = !off && (state.down || state.on);
    const onFace = state.alt ? THEME.faceAlt : THEME.faceOn;
    const face = off ? THEME.faceOff : state.face && !state.down ? state.face : state.down ? THEME.faceDown : state.hover ? state.on && state.alt ? THEME.faceAltHover : THEME.faceHover : state.on ? onFace : THEME.face;
    scene.set(id, { type: "rect", x: r.x, y: r.y, width: r.width, height: r.height, fill: face, z: Z.face });
    bevel(
      scene,
      id,
      r,
      sunk || off ? THEME.bevelDark : THEME.bevelLight,
      sunk ? THEME.bevelLight : off ? THEME.backingLight : THEME.bevelDark,
      THEME.bevel,
      Z.bevel
    );
    const nudge = sunk ? 1 : 0;
    const colour = off ? THEME.textOff : THEME.text;
    const opacity = off ? THEME.iconOff : void 0;
    if (content.icon && content.text !== void 0) {
      const size = content.iconSize ?? 16;
      const px = iconPixels(size, overlay.scale);
      const side = px / overlay.scale;
      const textSize = content.textSize ?? 12;
      const hintSize = Math.max(9, textSize - 4);
      const tm = measure(overlay, content.text, textSize, true);
      const hm = content.hint ? measure(overlay, content.hint, hintSize) : { width: 0, height: 0 };
      const gap = Math.round(side * 0.4);
      const total = side + gap + tm.width + (content.hint ? gap + hm.width : 0);
      const x0 = (content.left ? r.x + Math.round(side * 0.5) : r.x + Math.round((r.width - total) / 2)) + nudge;
      scene.set(`${id}.icon`, {
        type: "image",
        src: iconPath(content.icon, px),
        z: Z.icon,
        x: x0,
        y: r.y + (r.height - side) / 2 + nudge,
        ...opacity !== void 0 ? { opacity } : {}
      });
      scene.set(`${id}.text`, {
        type: "text",
        text: content.text,
        size: textSize,
        bold: true,
        colour,
        shadow: THEME.textShadow,
        x: x0 + side + gap,
        y: r.y + (r.height - tm.height) / 2 + nudge,
        z: Z.icon
      });
      if (content.hint) {
        scene.set(`${id}.hint`, {
          type: "text",
          text: content.hint,
          size: hintSize,
          colour: THEME.textDim,
          x: x0 + side + gap + tm.width + gap,
          y: r.y + (r.height - hm.height) / 2 + nudge + 1,
          z: Z.icon
        });
      }
    } else if (content.icon) {
      const size = content.iconSize ?? 16;
      const px = iconPixels(size, overlay.scale);
      const side = px / overlay.scale;
      scene.set(`${id}.icon`, {
        type: "image",
        src: iconPath(content.icon, px),
        z: Z.icon,
        x: r.x + (r.width - side) / 2 + nudge,
        y: r.y + (r.height - side) / 2 + nudge,
        ...opacity !== void 0 ? { opacity } : {}
      });
    } else if (content.text !== void 0) {
      const size = content.textSize ?? 12;
      const h = measure(overlay, content.text, size, true).height;
      scene.set(`${id}.text`, {
        type: "text",
        text: content.text,
        size,
        bold: true,
        colour,
        shadow: THEME.textShadow,
        align: "center",
        x: r.x + r.width / 2 + nudge,
        y: r.y + (r.height - h) / 2 + nudge,
        z: Z.icon
      });
    }
  }
  function slider(scene, id, r, value, hover) {
    const v = Math.max(0, Math.min(1, value));
    const trackH = Math.max(4, Math.round(r.height / 4));
    const track = { x: r.x, y: r.y + Math.round((r.height - trackH) / 2), width: r.width, height: trackH };
    scene.set(id, { type: "rect", ...track, fill: THEME.faceDown, z: Z.face });
    bevel(scene, id, track, THEME.bevelDark, THEME.bevelLight, THEME.bevel, Z.bevel);
    scene.set(`${id}.fill`, { type: "rect", x: track.x, y: track.y, width: Math.round(track.width * v), height: track.height, fill: THEME.faceOn, z: Z.face });
    const knobW = Math.round(r.height * 0.6);
    const knob = { x: Math.round(r.x + v * (r.width - knobW)), y: r.y, width: knobW, height: r.height };
    scene.set(`${id}.knob`, { type: "rect", ...knob, fill: hover ? THEME.faceHover : THEME.face, z: Z.icon });
    bevel(scene, `${id}.knob`, knob, THEME.bevelLight, THEME.bevelDark, THEME.bevel, Z.icon + 1);
  }
  function sliderValue(r, x) {
    const knobW = Math.round(r.height * 0.6);
    return Math.max(0, Math.min(1, (x - r.x - knobW / 2) / (r.width - knobW)));
  }
  function label(scene, id, text, r, size, overlay, bold = false) {
    const h = measure(overlay, text, size, bold).height;
    scene.set(id, {
      type: "text",
      text,
      size,
      bold,
      colour: THEME.text,
      shadow: THEME.textShadow,
      x: r.x,
      y: r.y + (r.height - h) / 2,
      z: Z.icon
    });
  }
  function tooltip(scene, id, text, anchorX, bottom, overlay, screenWidth) {
    const size = THEME.tipSize;
    const pad = THEME.tipPad;
    const m = measure(overlay, text, size);
    const width = Math.ceil(m.width) + 2 * pad;
    const height = Math.ceil(m.height) + 2 * pad;
    const x = Math.max(2, Math.min(screenWidth - width - 2, Math.round(anchorX - width / 2)));
    const y = bottom - height;
    scene.set(id, { type: "rect", x, y, width, height, fill: THEME.tipBacking, z: Z.tip });
    scene.set(`${id}.text`, { type: "text", text, size, colour: THEME.tipText, x: x + pad, y: y + pad, z: Z.tip + 1 });
  }
  var ICON_PIXELS = [20, 24, 25, 30, 34, 35, 36, 40, 42, 48, 50, 51, 60, 68, 72, 80, 85, 96, 102, 136];
  var ICON_FOLDER = "rct-screensaver/icons";
  function iconPixels(size, scale) {
    const want = size * scale;
    return ICON_PIXELS.reduce((best, px) => Math.abs(px - want) < Math.abs(best - want) ? px : best);
  }
  function iconPath(name, px) {
    return `${ICON_FOLDER}/${name}-${px}.png`;
  }

  // src/ui/controls.ts
  var QUIT_SPRITE = "sprite:23210";
  var QUIT_SIZE = { width: 40, height: 64 };
  var PRIMARY = ["prevPark", "prevView", "hold", "nextView", "nextPark"];
  var SECONDARY = ["speed", "shuffle", "titles", "music", "time", "edit", "settings"];
  var TITLES_NEXT = { overview: "on", on: "off", off: "overview" };
  var TIME_NEXT = { day: "night", night: "cycle", cycle: "day" };
  var TIME_TEXT = { day: "day", night: "night", cycle: "day and night cycle" };
  var TIME_ICON = { day: "day", night: "night", cycle: "day-night" };
  var TITLES_TEXT = { overview: "each park's first view", on: "every view", off: "off" };
  var WINDOW_NEXT = {
    borderless: "windowed",
    windowed: "keep",
    keep: "borderless",
    fullscreen: "borderless"
  };
  var WINDOW_TEXT = {
    borderless: "Borderless",
    windowed: "Windowed",
    keep: "As in Options",
    fullscreen: "Fullscreen"
  };
  var OPTIONS = [
    { id: "window", label: "Window", kind: "cycle" },
    { id: "captionPlace", label: "Park titles", kind: "cycle" },
    { id: "captionFrame", label: "Title frame", kind: "cycle" },
    { id: "renderer", label: "Renderer", kind: "cycle" },
    { id: "multiThreading", label: "Multithreading", kind: "toggle" },
    { id: "weather", label: "Changing weather", kind: "toggle" },
    { id: "weatherGloom", label: "Weather effects", kind: "toggle" },
    { id: "lightEffects", label: "Light effects", kind: "toggle" },
    { id: "masterVolume", label: "Master volume", kind: "slider" },
    { id: "soundVolume", label: "Sound effects", kind: "slider" },
    { id: "musicVolume", label: "Music", kind: "slider" }
  ];
  var VOLUME_KEYS = {
    masterVolume: "sound.master_volume",
    soundVolume: "sound.sound_volume",
    musicVolume: "sound.ride_music_volume"
  };
  var PLACE_NEXT = {
    topLeft: "bottomLeft",
    bottomLeft: "topCenter",
    topCenter: "bottomCenter",
    bottomCenter: "topLeft"
  };
  var PLACE_TEXT = {
    topLeft: "Top left",
    bottomLeft: "Bottom left",
    topCenter: "Top center",
    bottomCenter: "Bottom center"
  };
  var FRAME_TEXT = {
    gold: "Gold",
    silver: "Silver",
    wood: "Wood",
    minimalDark: "Minimal dark",
    minimalLight: "Minimal light",
    aero: "Aero",
    canvas: "Canvas"
  };
  var FRAME_ROWS = [["gold", "silver", "wood"], ["minimalDark", "minimalLight", "aero"], ["canvas"]];
  var BANDS = ["green", "burgundy", "navy", "slate", "ivory"];
  var RENDERER_NEXT = { null: "software", software: "opengl", opengl: null };
  var RENDERER_TEXT = { null: "As in Options", software: "Software", opengl: "OpenGL" };
  function shownOptions(_settings) {
    return OPTIONS;
  }
  function secondaryButtonSide() {
    const primaryWidth = PRIMARY.length * BAR.primary + (PRIMARY.length - 1) * BAR.gap;
    return Math.min(BAR.secondary, Math.floor((primaryWidth - (SECONDARY.length - 1) * BAR.gap) / SECONDARY.length));
  }
  function barArea() {
    const b = BAR;
    const width = 2 * b.pad + PRIMARY.length * b.primary + (PRIMARY.length - 1) * b.gap;
    const height = 2 * b.pad + b.primary + b.rowGap + secondaryButtonSide();
    return { x: Math.round((ui.width - width) / 2), y: ui.height - b.bottom - height, width, height };
  }
  function speedFactor(speed) {
    return 2 ** (Math.max(1, Math.min(4, speed)) - 1);
  }
  function mix(a, b, t) {
    const ch = (s, i) => parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16);
    let out = "#";
    for (let i = 0; i < 4; i++) {
      out += Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0");
    }
    return out;
  }
  function speedFace(speed, hover) {
    const t = (Math.max(1, Math.min(4, speed)) - 1) / 3;
    const face = mix(THEME.speedSlow, THEME.speedFast, t);
    return hover ? mix(face, "#ffffffc0", 0.2) : face;
  }
  var MIN_SPEED2 = 1;
  var MAX_SPEED2 = 4;
  var ControlsBar = class {
    // the flyout's caption previews, by style, accent and scale
    constructor(mode2, player2, settings, editorHooks) {
      this.mode = mode2;
      this.player = player2;
      this.settings = settings;
      this.editorHooks = editorHooks;
      this.mouse = { x: -1, y: -1 };
      this.lastMove = 0;
      this.boxes = /* @__PURE__ */ new Map();
      this.strip = { x: 0, y: 0, width: 0, height: 0 };
      // the Title frame flyout beside it, while open
      this.previews = /* @__PURE__ */ new Map();
      this.layer = new Layer(mode2.overlay, "rcts.bar.");
    }
    /** Starts hidden, with the cursor hidden; the first mouse move shows both. */
    open() {
      this.mode.cursorVisible = false;
      this.render();
    }
    close() {
      this.layer.clear();
      this.downOn = void 0;
      this.panel = void 0;
      this.flyout = void 0;
      this.mode.cursorVisible = true;
    }
    onMouse(e) {
      this.mouse = { x: e.x, y: e.y };
      if (e.type === "move") {
        this.lastMove = Date.now();
        this.setShown(true);
        if (this.downOn) {
          this.slide(this.downOn, false);
        }
      } else if (e.type === "down") {
        this.lastMove = Date.now();
        const hit = this.hit();
        if (!this.layer.visible) {
          this.setShown(true);
        } else if (hit && hit !== "panel" && hit !== "flyout" && e.button === 0) {
          this.downOn = hit;
          this.slide(hit, false);
        } else if (hit === "speed" && e.button === 1) {
          this.speed(-1, true);
        } else if (hit === "panel") {
          this.flyout = void 0;
        } else if (!hit && this.panel) {
          this.panel = void 0;
          this.flyout = void 0;
        }
      } else if (e.type === "up" && e.button === 0) {
        const hit = this.hit();
        if (this.downOn && this.isSlider(this.downOn)) {
          this.slide(this.downOn, true);
        } else if (this.downOn && hit === this.downOn) {
          this.activate(hit);
        }
        this.downOn = void 0;
      } else if (e.type === "wheel" && this.layer.visible && this.hit() === "speed") {
        this.lastMove = Date.now();
        this.speed(e.delta > 0 ? 1 : -1, false);
      }
      this.render();
    }
    /** Whether a point is on the bar or its settings panel and flyout (shown or not). */
    covers(x, y) {
      const quit = this.boxes.get("quit");
      return contains(this.strip, x, y, 8) || quit !== void 0 && contains(quit, x, y) || this.panel !== void 0 && contains(this.panel, x, y, 8) || this.flyout !== void 0 && contains(this.flyout, x, y, 8);
    }
    /** Whether the settings panel is open (a click elsewhere closes it). */
    get panelOpen() {
      return this.panel !== void 0;
    }
    /** The mouse moved over something else (the editor panel): the bar stays as it is, awake. */
    mouseSeen() {
      this.lastMove = Date.now();
      this.setShown(true);
    }
    /** Every ~100 ms: hides the bar after the mouse has been still, and follows key changes. */
    update() {
      if (this.editorHooks?.editorOpen() && this.editorHooks.editorPinned()) {
        this.lastMove = Date.now();
        this.setShown(true);
      }
      const over = this.covers(this.mouse.x, this.mouse.y);
      if (this.layer.visible && !this.downOn && !over && Date.now() - this.lastMove > TIMING.hideAfter) {
        this.panel = void 0;
        this.flyout = void 0;
        this.setShown(false);
      }
      this.render();
    }
    /** Whether the bar shows (fading in or shown); the captions move above it while it does. */
    get shown() {
      return this.layer.visible;
    }
    setShown(on) {
      if (on !== this.layer.visible) {
        this.layer.show(on, on ? TIMING.fadeIn : TIMING.fadeOut);
        this.mode.cursorVisible = on;
      }
    }
    hit() {
      for (const [id, r] of this.boxes) {
        if (contains(r, this.mouse.x, this.mouse.y)) {
          return id;
        }
      }
      if (this.flyout && contains(this.flyout, this.mouse.x, this.mouse.y)) {
        return "flyout";
      }
      return this.panel && contains(this.panel, this.mouse.x, this.mouse.y) ? "panel" : void 0;
    }
    activate(id) {
      const p = this.player();
      switch (id) {
        case "prevPark":
          p?.previousPark();
          break;
        case "prevView":
          p?.previous();
          break;
        case "hold":
          p?.toggleHold();
          break;
        case "nextView":
          p?.next();
          break;
        case "nextPark":
          p?.nextPark();
          break;
        case "speed":
          this.speed(1, true);
          break;
        case "shuffle":
          p?.toggleShuffle();
          break;
        case "titles":
          this.settings.titles = TITLES_NEXT[titlesOf(this.settings)] ?? "overview";
          this.settings.titlesOverride = void 0;
          saveSettings(this.settings);
          break;
        case "time":
          this.settings.timeOfDay = TIME_NEXT[this.settings.timeOfDay] ?? "day";
          this.applyMode();
          break;
        case "music":
          this.settings.titleMusic = this.settings.titleMusic === "off" ? "ride" : "off";
          this.applyMode();
          break;
        case "quit":
          this.mode.exit();
          break;
        case "edit":
          this.panel = void 0;
          this.flyout = void 0;
          this.editorHooks?.toggleEditor();
          break;
        case "settings":
          this.panel = this.panel ? void 0 : { x: 0, y: 0, width: 0, height: 0 };
          this.flyout = void 0;
          break;
        case "option.window":
          this.settings.window = WINDOW_NEXT[this.settings.window] ?? "borderless";
          this.applyMode();
          break;
        case "option.captionPlace":
          this.settings.captionPlace = PLACE_NEXT[this.settings.captionPlace] ?? "topLeft";
          saveSettings(this.settings);
          break;
        case "option.captionFrame":
          this.flyout = this.flyout ? void 0 : { x: 0, y: 0, width: 0, height: 0 };
          break;
        case "option.renderer":
          this.settings.drawingEngine = RENDERER_NEXT[String(this.settings.drawingEngine)] ?? null;
          this.applyMode();
          break;
        case "option.multiThreading":
          this.settings.multiThreading = !this.multiThreading();
          this.applyMode();
          break;
        case "option.lightEffects":
          this.settings.lightEffects = !this.settings.lightEffects;
          this.applyMode();
          break;
        case "option.weatherGloom":
          this.settings.weatherGloom = !this.settings.weatherGloom;
          this.applyMode();
          break;
        case "option.weather":
          this.settings.weather = !this.settings.weather;
          this.applyMode();
          break;
        default:
          if (id.startsWith("frame.")) {
            this.settings.captionFrame = id.slice("frame.".length);
            saveSettings(this.settings);
          } else if (id.startsWith("accent.")) {
            this.settings.captionBand = id.slice("accent.".length);
            saveSettings(this.settings);
          }
      }
    }
    isSlider(id) {
      return id === "option.masterVolume" || id === "option.soundVolume" || id === "option.musicVolume";
    }
    /** Sets a volume slider from the mouse; applied as it moves, saved on release. */
    slide(id, save) {
      if (!this.isSlider(id)) {
        return;
      }
      const r = this.boxes.get(id);
      if (!r) {
        return;
      }
      const key = id.slice("option.".length);
      const value = Math.round(sliderValue(r, this.mouse.x) * 20) * 5;
      if (value !== this.settings[key] || save) {
        this.settings[key] = value;
        if (save) {
          this.applyMode();
        } else {
          this.mode.configure(modeSettings(this.settings));
        }
      }
    }
    /** A volume as shown: the mode's own, else the game's. */
    /** Multithreaded rendering in the mode: its own setting, else the game's (Options). */
    multiThreading() {
      if (typeof this.settings.multiThreading === "boolean") {
        return this.settings.multiThreading;
      }
      try {
        return Boolean(context.configuration.get("general.multithreading") ?? true);
      } catch {
        return true;
      }
    }
    volume(id) {
      const own = this.settings[id];
      if (typeof own === "number") {
        return own;
      }
      try {
        return context.configuration.get(VOLUME_KEYS[id]) ?? 100;
      } catch {
        return 100;
      }
    }
    /** Saves the settings and applies the mode's part of them at once (patch 0011). */
    applyMode() {
      saveSettings(this.settings);
      this.mode.configure(modeSettings(this.settings));
    }
    /** One step faster or slower; a click wraps round (4× then 1×), the wheel stops at the ends. */
    speed(delta, wrap) {
      const p = this.player();
      if (!p) {
        return;
      }
      let target = this.settings.speed + delta;
      if (wrap) {
        target = target > MAX_SPEED2 ? MIN_SPEED2 : target < MIN_SPEED2 ? MAX_SPEED2 : target;
      }
      p.changeSpeed(target - this.settings.speed);
    }
    layout() {
      const b = BAR;
      const rowWidth = (n, side) => n * side + (n - 1) * b.gap;
      const primaryWidth = rowWidth(PRIMARY.length, b.primary);
      const secondary = secondaryButtonSide();
      const width = 2 * b.pad + primaryWidth;
      this.strip = barArea();
      this.boxes.clear();
      const row = (ids, side, y) => {
        let x = this.strip.x + Math.round((width - rowWidth(ids.length, side)) / 2);
        for (const id of ids) {
          this.boxes.set(id, { x, y, width: side, height: side });
          x += side + b.gap;
        }
      };
      this.boxes.set("quit", { x: ui.width - QUIT_SIZE.width, y: ui.height - QUIT_SIZE.height, ...QUIT_SIZE });
      row(PRIMARY, b.primary, this.strip.y + b.pad);
      row(SECONDARY, secondary, this.strip.y + b.pad + b.primary + b.rowGap);
      if (this.panel) {
        const p = PANEL;
        const titleHeight = Math.round(p.titleSize * 1.6);
        const options = shownOptions(this.settings);
        const ph = 2 * p.pad + titleHeight + options.length * p.rowHeight + (options.length - 1) * p.rowGap;
        this.panel = {
          x: Math.round((ui.width - p.width) / 2),
          y: this.strip.y - p.above - ph,
          width: p.width,
          height: ph
        };
        let y = this.panel.y + p.pad + titleHeight;
        for (const o of options) {
          this.boxes.set(`option.${o.id}`, {
            x: this.panel.x + p.width - p.pad - p.valueWidth,
            y,
            width: p.valueWidth,
            height: p.rowHeight
          });
          y += p.rowHeight + p.rowGap;
        }
        if (this.flyout) {
          this.layoutFlyout();
        }
      }
    }
    /** The Title frame flyout beside the panel, level with its row (kept above the bar): its tiles and swatches. */
    layoutFlyout() {
      const f = FLYOUT;
      const panel = this.panel;
      const row = this.boxes.get("option.captionFrame");
      const titleHeight = Math.round(PANEL.titleSize * 1.6);
      const gridWidth = 3 * f.tileWidth + 2 * f.gap;
      const width = 2 * PANEL.pad + gridWidth;
      const height = 2 * PANEL.pad + titleHeight + FRAME_ROWS.length * (f.tileHeight + f.gap) + f.accentLabel + f.swatchHeight;
      const bottom = this.strip.y - PANEL.above;
      const y = Math.max(4, Math.min(row.y - PANEL.pad - titleHeight, bottom - height));
      const right = panel.x + panel.width + f.beside;
      const leftX = panel.x - f.beside - width;
      const x = right + width <= ui.width ? right : leftX >= 0 ? leftX : Math.max(0, Math.min(ui.width - width, right));
      this.flyout = { x, y, width, height };
      let ty = y + PANEL.pad + titleHeight;
      for (const ids of FRAME_ROWS) {
        ids.forEach((id, i) => this.boxes.set(`frame.${id}`, {
          x: this.flyout.x + PANEL.pad + i * (f.tileWidth + f.gap),
          y: ty,
          width: f.tileWidth,
          height: f.tileHeight
        }));
        ty += f.tileHeight + f.gap;
      }
      const sw = (gridWidth - (BANDS.length - 1) * f.gap) / BANDS.length;
      BANDS.forEach((band, i) => this.boxes.set(`accent.${band}`, {
        x: this.flyout.x + PANEL.pad + i * (sw + f.gap),
        y: ty + f.accentLabel,
        width: sw,
        height: f.swatchHeight
      }));
    }
    /** A caption preview of a style in the current accent, fitted to a flyout tile (laid out once per style). */
    preview(style, w, h) {
      const overlay = this.mode.overlay;
      const key = `${style}|${this.settings.captionBand}|${overlay.scale}|${w}x${h}`;
      let look = this.previews.get(key);
      if (!look) {
        const full = captionLook(overlay, FLYOUT.previewName, FLYOUT.previewAuthor, style, this.settings.captionBand, 600, 1);
        const zoom = Math.min(w / full.width, h / full.height);
        look = captionLook(overlay, FLYOUT.previewName, FLYOUT.previewAuthor, style, this.settings.captionBand, 600, zoom);
        if (this.previews.size > 40) {
          this.previews.clear();
        }
        this.previews.set(key, look);
      }
      return look;
    }
    render() {
      const overlay = this.mode.overlay;
      this.layout();
      const scene = /* @__PURE__ */ new Map();
      backing(scene, "strip", this.strip);
      const p = this.player();
      const held = p?.isHeld ?? false;
      const hover = this.layer.visible ? this.hit() : void 0;
      const state = (id, on = false) => ({ hover: hover === id, down: this.downOn === id && hover === id, on });
      for (const id of [...PRIMARY, ...SECONDARY]) {
        const primary = PRIMARY.includes(id);
        const content = id === "speed" ? { text: `${speedFactor(this.settings.speed)}\xD7`, textSize: BAR.speedText } : { icon: this.icon(id, held), iconSize: primary ? BAR.iconPrimary : BAR.iconSecondary };
        const alt = id === "titles" && titlesOf(this.settings) === "on" || id === "time" && this.settings.timeOfDay === "cycle";
        const face = id === "speed" ? speedFace(this.settings.speed, hover === id) : void 0;
        button(scene, id, this.boxes.get(id), { ...state(id, this.isOn(id, held) || alt), alt, face }, content, overlay);
      }
      if (builder.running && !this.editorHooks?.editorOpen()) {
        const count = builder.count;
        const text = count ? `Building ${count.park}/${count.parks}` : "Building";
        const m = measure(overlay, text, 13, true);
        const chip = { x: this.strip.x + this.strip.width - Math.ceil(m.width) - 16, y: this.strip.y - 26, width: Math.ceil(m.width) + 16, height: 22 };
        scene.set("build.chip", { type: "rect", ...chip, fill: THEME.faceOn, z: Z.face });
        scene.set("build.chipt", {
          type: "text",
          text,
          size: 13,
          bold: true,
          colour: THEME.text,
          shadow: THEME.textShadow,
          x: chip.x + 8,
          y: chip.y + (chip.height - m.height) / 2,
          z: Z.icon
        });
      }
      const quit = this.boxes.get("quit");
      button(scene, "quit", quit, state("quit"), {}, overlay);
      scene.set("quit.icon", { type: "image", src: QUIT_SPRITE, x: quit.x, y: quit.y, z: Z.icon });
      if (this.panel) {
        const pp = PANEL;
        backing(scene, "panel", this.panel);
        label(
          scene,
          "panel.title",
          "Screensaver settings",
          { x: this.panel.x + pp.pad, y: this.panel.y + pp.pad, width: 0, height: Math.round(pp.titleSize * 1.6) },
          pp.titleSize,
          overlay,
          true
        );
        for (const o of shownOptions(this.settings)) {
          const r = this.boxes.get(`option.${o.id}`);
          const id = `option.${o.id}`;
          if (o.kind === "slider") {
            const v = this.volume(o.id);
            label(scene, `panel.${o.id}`, `${o.label}  ${v}%`, { x: this.panel.x + pp.pad, y: r.y, width: 0, height: r.height }, pp.textSize, overlay);
            slider(scene, id, r, v / 100, hover === id || this.downOn === id);
          } else {
            label(scene, `panel.${o.id}`, o.label, { x: this.panel.x + pp.pad, y: r.y, width: 0, height: r.height }, pp.textSize, overlay);
            const on = o.kind === "toggle" && this.optionText(o.id) === "On" || o.id === "captionFrame" && this.flyout !== void 0;
            button(scene, id, r, state(id, on), { text: this.optionText(o.id), textSize: pp.textSize }, overlay);
          }
        }
      }
      if (this.panel && this.flyout) {
        const f = FLYOUT;
        const fly = this.flyout;
        backing(scene, "flyout", fly);
        const row = this.boxes.get("option.captionFrame");
        const joinX = fly.x > this.panel.x ? this.panel.x + this.panel.width : fly.x + fly.width;
        if (Math.abs(fly.x - this.panel.x - this.panel.width) === f.beside || Math.abs(this.panel.x - fly.x - fly.width) === f.beside) {
          scene.set("flyout.join", {
            type: "rect",
            x: joinX,
            y: row.y + 4,
            width: f.beside,
            height: row.height - 8,
            fill: THEME.backing,
            z: Z.backing
          });
        }
        label(
          scene,
          "flyout.title",
          "Title frame",
          { x: fly.x + PANEL.pad, y: fly.y + PANEL.pad, width: 0, height: Math.round(PANEL.titleSize * 1.6) },
          PANEL.titleSize,
          overlay,
          true
        );
        for (const style of STYLES) {
          const id = `frame.${style}`;
          const r = this.boxes.get(id);
          const st = state(id, this.settings.captionFrame === style);
          button(scene, id, r, st, {}, overlay);
          const nudge = st.down || st.on ? 1 : 0;
          const look = this.preview(style, r.width - 2 * f.previewPad, r.height - f.previewPad - f.tileLabel);
          look.draw(
            scene,
            `${id}.preview.`,
            r.x + (r.width - look.width) / 2 + nudge,
            r.y + f.previewPad + (r.height - f.previewPad - f.tileLabel - look.height) / 2 + nudge,
            Z.icon
          );
          const name = FRAME_TEXT[style];
          const m = measure(overlay, name, f.labelSize);
          label(
            scene,
            `${id}.label`,
            name,
            { x: r.x + (r.width - m.width) / 2 + nudge, y: r.y + r.height - f.tileLabel + nudge, width: 0, height: f.tileLabel - 2 },
            f.labelSize,
            overlay
          );
        }
        const first = this.boxes.get(`accent.${BANDS[0]}`);
        label(scene, "flyout.accent", "Accent", { x: fly.x + PANEL.pad, y: first.y - f.accentLabel, width: 0, height: f.accentLabel }, f.labelSize, overlay);
        const ms = overlay.scale <= 1 ? 1 : overlay.scale <= 2 ? 2 : 3;
        for (const band of BANDS) {
          const id = `accent.${band}`;
          const r = this.boxes.get(id);
          const st = state(id, this.settings.captionBand === band);
          button(scene, id, r, st, {}, overlay);
          const nudge = st.down || st.on ? 1 : 0;
          const w = r.width - 6;
          const h = r.height - 6;
          scene.set(`${id}.swatch`, {
            type: "image",
            src: `${ICON_FOLDER}/velvet-${band}-${ms * 100}.png`,
            x: r.x + 3 + nudge,
            y: r.y + 3 + nudge,
            width: w,
            height: h,
            cropX: 0,
            cropY: 0,
            cropWidth: w * ms,
            cropHeight: h * ms,
            z: Z.icon
          });
        }
      }
      if (hover === "quit" && !this.downOn) {
        tooltip(scene, "tip", "Exit (Esc)", quit.x + quit.width / 2, quit.y - 4, overlay, ui.width);
      } else if (hover && hover !== "panel" && hover !== "flyout" && !hover.startsWith("option.") && !this.downOn && !this.panel) {
        const r = this.boxes.get(hover);
        tooltip(scene, "tip", this.tip(hover, held), r.x + r.width / 2, this.strip.y - 4, overlay, ui.width);
      }
      this.layer.render(scene);
    }
    optionText(id) {
      switch (id) {
        case "window":
          return WINDOW_TEXT[this.settings.window] ?? this.settings.window;
        case "captionPlace":
          return PLACE_TEXT[this.settings.captionPlace] ?? "Top left";
        case "captionFrame":
          return `${FRAME_TEXT[this.settings.captionFrame] ?? "Gold"}  \u203A`;
        case "renderer":
          return RENDERER_TEXT[String(this.settings.drawingEngine)] ?? "As in Options";
        case "lightEffects":
          return this.settings.lightEffects ? "On" : "Off";
        case "multiThreading":
          return this.multiThreading() ? "On" : "Off";
        case "weatherGloom":
          return this.settings.weatherGloom ? "On" : "Off";
        case "weather":
          return this.settings.weather ? "On" : "Off";
        default:
          return `${this.volume(id)}%`;
      }
    }
    isOn(id, held) {
      switch (id) {
        case "hold":
          return held;
        case "shuffle":
          return this.settings.shuffle;
        case "titles":
          return titlesOf(this.settings) !== "off";
        case "music":
          return this.settings.titleMusic !== "off";
        case "time":
          return this.settings.timeOfDay !== "day";
        case "edit":
          return this.editorHooks?.editorOpen() ?? false;
        case "settings":
          return this.panel !== void 0;
        default:
          return false;
      }
    }
    icon(id, held) {
      switch (id) {
        case "prevPark":
          return "prev-park";
        case "prevView":
          return "prev-view";
        case "hold":
          return held ? "play" : "pause";
        case "nextView":
          return "next-view";
        case "nextPark":
          return "next-park";
        case "shuffle":
          return "shuffle";
        case "titles":
          return titlesOf(this.settings) === "off" ? "titles-off" : "titles";
        case "music":
          return this.settings.titleMusic === "off" ? "music-off" : "music";
        case "time":
          return TIME_ICON[this.settings.timeOfDay] ?? "day";
        case "edit":
          return "edit";
        case "settings":
          return "settings";
        default:
          return "";
      }
    }
    tip(id, held) {
      switch (id) {
        case "prevPark":
          return "Previous park (Shift+\u2190)";
        case "prevView":
          return "Previous view (\u2190)";
        case "hold":
          return held ? "Release (Space)" : "Hold this view (Space)";
        case "nextView":
          return "Next view (\u2192)";
        case "nextPark":
          return "Next park (Shift+\u2192)";
        case "speed":
          return `Speed ${speedFactor(this.settings.speed)}\xD7 (\u2191 \u2193; right-click slower)`;
        case "shuffle":
          return `Shuffle parks: ${this.settings.shuffle ? "on" : "off"} (S)`;
        case "titles":
          return `Titles: ${TITLES_TEXT[titlesOf(this.settings)] ?? titlesOf(this.settings)}`;
        case "music":
          return `Ride music: ${this.settings.titleMusic === "off" ? "off" : "on"}`;
        case "time":
          return `Time of day: ${TIME_TEXT[this.settings.timeOfDay] ?? this.settings.timeOfDay}`;
        case "edit":
          return `Edit views (E)${this.editorHooks?.editorOpen() ? ": close" : ""}`;
        case "settings":
          return "Settings";
      }
    }
  };

  // src/ui/captions.ts
  var Captions = class {
    constructor(mode2, player2, settings, editorOpen, barShown = () => false) {
      this.mode = mode2;
      this.player = player2;
      this.settings = settings;
      this.editorOpen = editorOpen;
      this.barShown = barShown;
      this.shownKey = "";
      // the park, place, look, bar and window the scene was laid out for
      this.shownPark = "";
      this.layer = new Layer(mode2.overlay, "rcts.cap.");
    }
    close() {
      this.layer.clear();
      this.shownKey = "";
      this.shownPark = "";
    }
    /** Every ~100 ms: shows the caption when the setting and the view on screen call for it. */
    update() {
      const c = this.player()?.caption;
      const wanted = c !== void 0 && !this.editorOpen() && (titlesOf(this.settings) === "on" || titlesOf(this.settings) === "overview" && c.firstView);
      if (!c || !wanted) {
        this.layer.show(false, CAPTION.fadeOut);
        return;
      }
      const bar2 = this.barShown();
      const layoutKey = `${c.key}|${this.settings.captionPlace}|${this.settings.captionFrame}|${this.settings.captionBand}|${bar2}|${ui.width}x${ui.height}|${this.mode.overlay.scale}`;
      if (layoutKey !== this.shownKey) {
        if (this.layer.visible && c.key !== this.shownPark) {
          this.layer.show(false, 0);
        }
        this.layer.render(this.scene(c.name, c.author, bar2));
        this.shownKey = layoutKey;
        this.shownPark = c.key;
      }
      this.layer.show(true, Math.max(0, this.settings.fadeMs));
    }
    scene(name, author, barShown) {
      const s = CAPTION;
      const place = this.settings.captionPlace;
      const bar2 = barArea();
      const besideBar = bar2.x - s.margin - s.barGap;
      const beside = place === "bottomLeft" && besideBar >= s.minBeside;
      const room = Math.min(s.maxWidth, beside ? besideBar : ui.width - 2 * s.margin);
      const look = captionLook(this.mode.overlay, name, author, this.settings.captionFrame, this.settings.captionBand, room, 1);
      const box = placeBox(place, look.width, look.height, bar2, beside || !barShown);
      const scene = /* @__PURE__ */ new Map();
      look.draw(scene, "", box.x, box.y, s.z);
      return scene;
    }
  };
  var PORTRAIT = ["gold", "silver", "wood"];
  var STYLES = ["gold", "silver", "wood", "minimalDark", "minimalLight", "aero", "canvas"];
  function captionLook(overlay, name, author, frame, accent, room, zoom) {
    const s = CAPTION;
    const st = CAPTION_STYLES;
    const style = frame && STYLES.includes(frame) ? frame : "gold";
    const band = accent && VELVET[accent] ? accent : "green";
    const portrait = PORTRAIT.includes(style);
    const sans = !portrait && style !== "canvas";
    const t = portrait ? s.frame : {
      minimalDark: st.minimalDark.frame,
      minimalLight: st.minimalLight.frame,
      aero: st.aero.frame,
      canvas: st.canvas.frame
    }[style];
    const left = style === "minimalLight" ? st.minimalLight.strip : 0;
    const ruleH = portrait ? s.ruleHeight : style === "aero" ? 2 : 1;
    const k = zoom;
    const maxText = Math.max(120, room / k - 2 * (t + s.padX) - left);
    const titleStyle = sans ? { font: style === "aero" ? st.sans : st.sansBold, size: st.titleSize, bold: style !== "aero" } : { font: s.titleFont, size: s.titleSize, bold: true };
    const bylineStyle = sans ? { font: style === "aero" ? st.sansItalic : st.sans, size: st.bylineSize } : { font: s.bylineFont, size: s.bylineSize };
    const measure2 = (text, ts) => {
      const m = overlay.measureText(text, { ...ts, size: ts.size * k, wrap: maxText * k });
      return { width: m.width / k, height: m.height / k };
    };
    const title = measure2(name, titleStyle);
    const byline = author ? `by ${author}` : "";
    const by = byline ? measure2(byline, bylineStyle) : { width: 0, height: 0 };
    const tile = s.frameTile;
    const matW = Math.ceil((Math.min(maxText, Math.max(title.width, by.width)) + 2 * s.padX + left) / tile) * tile;
    const lowerH = byline ? ruleH + 2 * s.padY + by.height : 0;
    const needH = 2 * s.titlePadY + title.height + lowerH;
    const matH = Math.min(s.marbleHeight, Math.ceil(needH / tile) * tile);
    const upperH = matH - lowerH;
    const W = matW + 2 * t;
    const H = matH + 2 * t;
    const scale = overlay.scale * k;
    return {
      width: W * k,
      height: H * k,
      draw(scene, prefix, bx, by0, z) {
        const put = (id, e) => {
          const out = { ...e, x: bx + e.x * k, y: by0 + e.y * k, z: z + (e.z ?? 0) };
          if (e.width !== void 0) out.width = e.width * k;
          if (e.height !== void 0) out.height = e.height * k;
          if (e.size !== void 0) out.size = e.size * k;
          if (e.wrap !== void 0) out.wrap = e.wrap * k;
          scene.set(prefix + id, out);
        };
        const rect = (id, x, y, width, height, fill, dz = 0) => put(id, { type: "rect", x, y, width, height, fill, z: dz });
        const image = (id, src, x, y, width, height, dz, crop) => put(id, {
          type: "image",
          src: `${ICON_FOLDER}/${src}`,
          x,
          y,
          width,
          height,
          z: dz,
          ...crop ? { cropX: crop[0], cropY: crop[1], cropWidth: crop[2], cropHeight: crop[3] } : {}
        });
        const tiles = (id, src, pct, tw, th, x, y, w, h, dz) => {
          const f = pct / 100;
          for (let row = 0; row * th < h; row++) {
            for (let col = 0; col * tw < w; col++) {
              const cw = Math.min(tw, w - col * tw) + (k < 1 && (col + 1) * tw < w ? 1 / k : 0);
              const ch = Math.min(th, h - row * th) + (k < 1 && (row + 1) * th < h ? 1 / k : 0);
              image(`${id}.${row}.${col}`, src(pct), x + col * tw, y + row * th, cw, ch, dz, [0, 0, cw * f, ch * f]);
            }
          }
        };
        const text = (id, value, ts, x, y, colour, dz, shadow) => put(id, { type: "text", text: value, ...ts, wrap: maxText, x, y, colour, z: dz, ...shadow ? { shadow } : {} });
        const tx = t + s.padX + left;
        const ty = t + Math.round((upperH - title.height) / 2);
        const ruleY = t + upperH;
        const byY = ruleY + ruleH + s.padY;
        const ms = marbleScale(scale);
        if (portrait) {
          drawPortrait();
        } else if (style === "minimalDark" || style === "minimalLight") {
          const m = style === "minimalDark" ? st.minimalDark : st.minimalLight;
          put("box", {
            type: "rect",
            x: 0,
            y: 0,
            width: W,
            height: H,
            fill: m.backing,
            z: 0,
            ...style === "minimalDark" ? { border: st.minimalDark.border, borderWidth: 1 } : {}
          });
          if (style === "minimalLight") {
            rect("strip", 0, 0, st.minimalLight.strip, H, ACCENT[band].strip, 1);
          }
          const shadow = style === "minimalDark" ? st.minimalDark.shadow : void 0;
          text("title", name, titleStyle, tx, ty, m.title, 2, shadow);
          if (byline) {
            rect("rule", t + s.padX + left, ruleY, matW - 2 * s.padX - left, 1, m.rule, 1);
            text("byline", byline, bylineStyle, tx, byY, m.byline, 2, shadow);
          }
        } else if (style === "aero") {
          const a = st.aero;
          const g = ACCENT[band].aero;
          const r = a.radius;
          const pct = framePct(scale);
          image("corner.tl", `aero-${band}-tl-${pct}.png`, 0, 0, r, r, 1);
          image("corner.tr", `aero-${band}-tr-${pct}.png`, W - r, 0, r, r, 1);
          image("corner.bl", `aero-${band}-bl-${pct}.png`, 0, H - r, r, r, 1);
          image("corner.br", `aero-${band}-br-${pct}.png`, W - r, H - r, r, r, 1);
          const layers = [
            ["outline", 0, 1, a.outline],
            ["bright", 1, 1, g.bright],
            ["rim", 2, t - 2, g.rim],
            ["bevel", t, 1, g.bevel]
          ];
          for (const [id, d, w, fill] of layers) {
            rect(`rim.t.${id}`, r, d, W - 2 * r, w, fill, 1);
            rect(`rim.b.${id}`, r, H - d - w, W - 2 * r, w, fill, 1);
            rect(`rim.l.${id}`, d, r, w, H - 2 * r, fill, 1);
            rect(`rim.r.${id}`, W - d - w, r, w, H - 2 * r, fill, 1);
          }
          put("box", { type: "rect", x: r, y: r, width: W - 2 * r, height: H - 2 * r, fill: "#00000000", z: 0 });
          tiles("frost", (p) => `aero-frost-${band}-${p}.png`, ms * 100, a.frostWidth, a.frostHeight, r, r, W - 2 * r, H - 2 * r, 0);
          image("gloss", `aero-gloss-${ms * 100}.png`, r, 2, W - 2 * r, H - 4, 2);
          const glow = (id, value, ts, x, y, colour) => {
            const near = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
            const far = [[-2, 0], [2, 0], [0, -2], [0, 2]];
            near.forEach(([dx, dy], i) => text(`${id}.glow${i}`, value, ts, x + dx, y + dy, a.glow, 3));
            far.forEach(([dx, dy], i) => text(`${id}.far${i}`, value, ts, x + dx, y + dy, a.glowFar, 3));
            text(id, value, ts, x, y, colour, 4);
          };
          glow("title", name, titleStyle, tx, ty, a.title);
          if (byline) {
            rect("rule.dark", t + s.padX, ruleY, matW - 2 * s.padX, 1, a.ruleDark, 3);
            rect("rule.light", t + s.padX, ruleY + 1, matW - 2 * s.padX, 1, a.ruleLight, 3);
            glow("byline", byline, bylineStyle, tx, byY, a.byline);
          }
        } else {
          const c = st.canvas;
          const f = c.gallery;
          const pct = framePct(scale);
          [[2, 3], [3, 4], [4, 6]].forEach(([dx, dy], i) => rect(`shadow.${i}`, dx, dy, W, H, c.dropShadow, -1));
          const piece = (id, part, x, y, w, h) => image(`frame.${id}`, `gallery-${part}-${pct}.png`, x, y, w, h, 3);
          piece("tl", "tl", 0, 0, f, f);
          piece("tr", "tr", W - f, 0, f, f);
          piece("bl", "bl", 0, H - f, f, f);
          piece("br", "br", W - f, H - f, f, f);
          piece("t", "t", f, 0, W - 2 * f, f);
          piece("b", "b", f, H - f, W - 2 * f, f);
          piece("l", "l", 0, f, f, H - 2 * f);
          piece("r", "r", W - f, f, f, H - 2 * f);
          put("box", { type: "rect", x: f, y: f, width: W - 2 * f, height: H - 2 * f, fill: ACCENT[band].mat, z: 0 });
          rect("mat.shadow.t", f, f, W - 2 * f, 2, c.frameShadow, 1);
          rect("mat.shadow.l", f, f + 2, 2, H - 2 * f - 2, c.frameShadow, 1);
          const b = c.bevel;
          rect("bevel.t", t - b, t - b, matW + 2 * b, b, c.bevelShade, 1);
          rect("bevel.l", t - b, t, b, matH + b, c.bevelShade, 1);
          rect("bevel.b", t, t + matH, matW + b, b, c.bevelLit, 1);
          rect("bevel.r", t + matW, t, b, matH, c.bevelLit, 1);
          tiles("linen", (p) => `canvas-${p}.png`, ms * 100, c.linenWidth, c.linenHeight, t, t, matW, matH, 1);
          text("title.glint", name, titleStyle, tx + 1, ty + 1, c.titleGlint, 2);
          text("title", name, titleStyle, tx, ty, c.title, 3);
          if (byline) {
            rect("rule", t + s.padX, ruleY, matW - 2 * s.padX, 1, c.rule, 2);
            text("byline", byline, bylineStyle, tx, byY, c.byline, 3);
          }
        }
        function drawPortrait() {
          const pct = framePct(scale);
          put("box", { type: "rect", x: t, y: t, width: matW, height: matH, fill: THEME.captionMat, z: 0 });
          image(
            "marble",
            `marble-${ms * 100}.png`,
            t,
            t,
            matW,
            matH,
            0,
            [Math.max(0, (s.marbleWidth - matW) / 2) * ms, 0, Math.min(matW, s.marbleWidth) * ms, matH * ms]
          );
          const piece = (id, part, x, y, w, h) => image(id, `frame-${style}-${part}-${pct}.png`, x, y, w, h, 3);
          const right = W - t;
          const bottom = H - t;
          piece("frame.tl", "tl", 0, 0, t, t);
          piece("frame.tr", "tr", right, 0, t, t);
          piece("frame.bl", "bl", 0, bottom, t, t);
          piece("frame.br", "br", right, bottom, t, t);
          for (let i = 0; i < matW / tile; i++) {
            piece(`frame.t${i}`, "t", t + i * tile, 0, tile, t);
            piece(`frame.b${i}`, "b", t + i * tile, bottom, tile, t);
          }
          for (let i = 0; i < matH / tile; i++) {
            piece(`frame.l${i}`, "l", 0, t + i * tile, t, tile);
            piece(`frame.r${i}`, "r", right, t + i * tile, t, tile);
          }
          text("title.glint", name, titleStyle, tx + 1, ty + 1, THEME.captionGlint, 1);
          text("title.shade", name, titleStyle, tx - 1, ty - 1, THEME.captionShade, 1);
          text("title", name, titleStyle, tx, ty, THEME.captionTitle, 2);
          if (byline) {
            const wp = s.woodPiece;
            for (let i = 0; i * wp < matW; i++) {
              const w = Math.min(wp, matW - i * wp);
              image(
                `rule.${i}`,
                `wood-${i % s.woodPieces}-${pct}.png`,
                t + i * wp,
                ruleY,
                w,
                s.ruleHeight,
                2,
                w < wp ? [0, 0, w * pct / 100, s.ruleHeight * pct / 100] : void 0
              );
            }
            const bandTop = ruleY + s.ruleHeight;
            tiles(
              "velvet",
              (p) => `velvet-${band}-${p}.png`,
              ms * 100,
              s.velvetWidth,
              s.velvetHeight,
              t,
              bandTop,
              matW,
              t + matH - bandTop,
              1
            );
            text("byline", byline, bylineStyle, tx, byY, VELVET[band].text, 2, VELVET[band].shadow);
          }
        }
      }
    };
  }
  function placeBox(place, w, h, bar2, low) {
    const s = CAPTION;
    const centreX = Math.round((ui.width - w) / 2);
    const top = s.margin;
    const bottom = low ? ui.height - s.margin - h : bar2.y - s.barGap - h;
    switch (place) {
      case "bottomLeft":
        return { x: s.margin, y: bottom, width: w, height: h };
      case "topCenter":
        return { x: centreX, y: top, width: w, height: h };
      case "bottomCenter":
        return { x: centreX, y: bottom, width: w, height: h };
      default:
        return { x: s.margin, y: top, width: w, height: h };
    }
  }
  function framePct(scale) {
    return FRAME_SCALES.reduce((best, pct) => Math.abs(pct / 100 - scale) < Math.abs(best / 100 - scale) ? pct : best);
  }
  var FRAME_SCALES = [100, 125, 150, 175, 200, 250, 300, 400];
  function marbleScale(scale) {
    return scale <= 1 ? 1 : scale <= 2 ? 2 : 3;
  }

  // src/ui/view-map.ts
  var TILE4 = 32;
  var MIN_ZOOM4 = -2;
  var MAX_ZOOM5 = 3;
  var HANDLE = 14;
  var MARKER = 26;
  var DOUBLE_CLICK_MS = 400;
  var CLICK_SLOP = 4;
  var DOT = 3;
  var PAN_GAP = 8;
  var CUT_GAP = 20;
  var MAX_DOTS = 80;
  var TEXT_SIZE = 14;
  var EDGE = 24;
  var MAP_COLOURS = {
    generated: "#ce93d8",
    manual: "#4fc3f7",
    event: "#ffb000",
    selected: "#ff6a1a",
    pan: "#ffd54fe0",
    cut: "#4dd0e1c0",
    labelBacking: "#000000b0",
    text: "#ffffff"
  };
  var Z_LINE = 40;
  var Z_BOX = 42;
  var Z_LABEL = 44;
  function isEvent(view) {
    return view.cue !== void 0 || view.animation !== void 0 || view.show !== void 0;
  }
  function screenOf2(view, rotation) {
    return toScreen(view.x * TILE4 + TILE4 / 2, view.y * TILE4 + TILE4 / 2, view.z, rotation);
  }
  var ViewMap = class {
    constructor(overlay, now = () => Date.now()) {
      this.overlay = overlay;
      this.now = now;
      this.placed = [];
      this.lastDown = { time: -Infinity, x: 0, y: 0, index: -1 };
      this.layer = new Layer(overlay, "rcts.map.");
    }
    get dragging() {
      return this.drag !== void 0;
    }
    clear() {
      this.drag = void 0;
      this.placed = [];
      this.layer.clear();
    }
    /** Window pixels of a screen point (zoom 0 units) through the camera. */
    toWindow(p, cam) {
      const c = toScreen(cam.x, cam.y, cam.z, cam.rotation);
      const k = Math.pow(2, -cam.zoom);
      return { x: ui.width / 2 + (p.x - c.x) * k, y: ui.height / 2 + (p.y - c.y) * k };
    }
    /** The screen point (zoom 0 units) under a window pixel. */
    fromWindow(x, y, cam) {
      const c = toScreen(cam.x, cam.y, cam.z, cam.rotation);
      const k = Math.pow(2, cam.zoom);
      return { x: c.x + (x - ui.width / 2) * k, y: c.y + (y - ui.height / 2) * k };
    }
    /** The view as the drag in progress shows it (moved or zoomed, not saved yet). */
    shownView(index, view, cam) {
      const d = this.drag;
      if (d?.kind === "box" && d.index === index && d.moved) {
        const s = screenOf2(view, cam.rotation);
        const k = Math.pow(2, cam.zoom);
        const w = toWorld({ x: s.x + (d.x - d.x0) * k, y: s.y + (d.y - d.y0) * k }, view.z, cam.rotation);
        return { ...view, x: (w.x - TILE4 / 2) / TILE4, y: (w.y - TILE4 / 2) / TILE4 };
      }
      if (d?.kind === "handle" && d.index === index) {
        return { ...view, zoom: d.zoom };
      }
      return view;
    }
    place(editor2) {
      const cam = editor2.cameraPose;
      this.placed = editor2.currentViews.map((original, index) => {
        const view = this.shownView(index, original, cam);
        const c = this.toWindow(screenOf2(view, cam.rotation), cam);
        if (view.rotation === cam.rotation) {
          const k = Math.pow(2, view.zoom - cam.zoom);
          const w = ui.width * k;
          const h = ui.height * k;
          return { index, view, cx: c.x, cy: c.y, box: { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h } };
        }
        const mw = isPinned(view) ? MARKER + 12 : MARKER;
        return { index, view, cx: c.x, cy: c.y, marker: { x: c.x - mw / 2, y: c.y - MARKER / 2, width: mw, height: MARKER } };
      });
    }
    /** The selected box's zoom handle (bottom right corner), if it can be dragged. */
    handleOf(editor2) {
      const p = this.placed[editor2.selectedIndex];
      if (!p?.box || isEvent(p.view) && editor2.eventsLocked) {
        return void 0;
      }
      const b = p.box;
      return { x: b.x + b.width - HANDLE / 2, y: b.y + b.height - HANDLE / 2, width: HANDLE, height: HANDLE };
    }
    /** The view under a window pixel: markers first, then the selected box, then the others (the
     * later ones on top). A large box counts only near its edge, so a press inside it still pans. */
    hit(editor2, x, y) {
      for (const p of this.placed) {
        if (p.marker && contains(p.marker, x, y)) {
          return p.index;
        }
      }
      const order = [...this.placed].reverse();
      const sel = this.placed[editor2.selectedIndex];
      if (sel) {
        order.unshift(sel);
      }
      for (const p of order) {
        if (p.box && contains(p.box, x, y)) {
          const big = p.box.width > ui.width / 2 || p.box.height > ui.height / 2;
          const inner = { x: p.box.x + EDGE, y: p.box.y + EDGE, width: p.box.width - 2 * EDGE, height: p.box.height - 2 * EDGE };
          if (!big || !contains(inner, x, y)) {
            return p.index;
          }
        }
      }
      return void 0;
    }
    /** A mouse event on the park while the map is on; true when it was the map's. */
    onMouse(e, editor2) {
      this.place(editor2);
      const d = this.drag;
      if (e.type === "wheel") {
        editor2.zoomCamera(e.delta);
        return true;
      }
      if (e.type === "down" && e.button === 0) {
        const handle = this.handleOf(editor2);
        if (handle && contains(handle, e.x, e.y, 4)) {
          const view2 = editor2.currentViews[editor2.selectedIndex];
          this.drag = { kind: "handle", index: editor2.selectedIndex, zoom: view2.zoom };
          return true;
        }
        const index = this.hit(editor2, e.x, e.y);
        if (index === void 0) {
          this.drag = { kind: "pan", x: e.x, y: e.y };
          return true;
        }
        const last = this.lastDown;
        const double = index === last.index && this.now() - last.time < DOUBLE_CLICK_MS && Math.abs(e.x - last.x) <= CLICK_SLOP && Math.abs(e.y - last.y) <= CLICK_SLOP;
        this.lastDown = { time: this.now(), x: e.x, y: e.y, index };
        if (double) {
          this.lastDown.time = -Infinity;
          editor2.frame(index);
          return true;
        }
        editor2.pick(index);
        const view = editor2.currentViews[index];
        if (!(isEvent(view) && editor2.eventsLocked)) {
          this.drag = { kind: "box", index, x0: e.x, y0: e.y, x: e.x, y: e.y, moved: false };
        }
        return true;
      }
      if (e.type === "down" && e.button === 1) {
        this.drag = { kind: "right", x0: e.x, y0: e.y, moved: false };
        return true;
      }
      if (e.type === "move" && d) {
        if (d.kind === "pan") {
          editor2.panBy(d.x - e.x, d.y - e.y);
          d.x = e.x;
          d.y = e.y;
        } else if (d.kind === "box") {
          d.x = e.x;
          d.y = e.y;
          d.moved = d.moved || Math.abs(e.x - d.x0) > CLICK_SLOP || Math.abs(e.y - d.y0) > CLICK_SLOP;
          this.render(editor2);
        } else if (d.kind === "handle") {
          const p = this.placed[d.index];
          const view = editor2.currentViews[d.index];
          if (p && view) {
            const half = {
              w: ui.width * Math.pow(2, view.zoom - editor2.cameraPose.zoom) / 2,
              h: ui.height * Math.pow(2, view.zoom - editor2.cameraPose.zoom) / 2
            };
            const ratio = Math.max(Math.abs(e.x - p.cx) / half.w, Math.abs(e.y - p.cy) / half.h, 1e-3);
            d.zoom = Math.min(MAX_ZOOM5, Math.max(MIN_ZOOM4, view.zoom + Math.round(Math.log2(ratio))));
            this.render(editor2);
          }
        } else if (d.kind === "right") {
          d.moved = d.moved || Math.abs(e.x - d.x0) > CLICK_SLOP || Math.abs(e.y - d.y0) > CLICK_SLOP;
        }
        return true;
      }
      if (e.type === "up" && d) {
        const shown = d.kind === "box" ? this.shownView(d.index, editor2.currentViews[d.index], editor2.cameraPose) : void 0;
        this.drag = void 0;
        if (d.kind === "box" && d.moved && e.button === 0 && shown) {
          editor2.moveView(d.index, shown.x, shown.y);
        } else if (d.kind === "handle" && e.button === 0) {
          if (d.zoom !== editor2.currentViews[d.index]?.zoom) {
            editor2.zoomView(d.index, d.zoom);
          }
        } else if (d.kind === "right" && e.button === 1 && !d.moved) {
          const index = this.hit(editor2, e.x, e.y);
          if (index !== void 0) {
            editor2.pick(index);
          } else {
            const cam = editor2.cameraPose;
            const p = this.fromWindow(e.x, e.y, cam);
            const z = surfaceZ(p, cam.rotation) ?? cam.z;
            const w = toWorld(p, z, cam.rotation);
            editor2.addAt(w.x, w.y, z);
          }
        }
        this.render(editor2);
        return true;
      }
      return false;
    }
    render(editor2) {
      if (editor2.playback.isLoading) {
        this.clear();
        return;
      }
      this.place(editor2);
      const scene = /* @__PURE__ */ new Map();
      const views = this.placed;
      const route = new Set(editor2.routeIndices());
      const stops = views.filter((p) => route.has(p.index));
      if (stops.length > 1) {
        stops.forEach((p, i) => {
          const q = stops[(i + 1) % stops.length];
          this.line(scene, `line.${i}`, p.cx, p.cy, q.cx, q.cy, editor2.pans(editor2.currentViews[p.index]));
        });
      }
      const labels = editor2.rows().map((r) => r[0]);
      const sel = editor2.selectedIndex;
      for (const p of views) {
        const event = isEvent(p.view);
        const colour = p.index === sel ? MAP_COLOURS.selected : event ? MAP_COLOURS.event : p.view.manual ? MAP_COLOURS.manual : MAP_COLOURS.generated;
        const text = `${labels[p.index]}${event ? editor2.eventsLocked ? " event (locked)" : " event" : ""}`;
        if (p.box) {
          const width = p.index === sel ? 3 : 2;
          scene.set(`box.${p.index}`, {
            type: "rect",
            ...round(p.box),
            fill: "#00000000",
            border: colour,
            borderWidth: width,
            z: Z_BOX + (p.index === sel ? 1 : 0)
          });
          this.tag(scene, `tag.${p.index}`, text, p.box.x + width, p.box.y + width, colour);
        } else if (p.marker) {
          scene.set(`mark.${p.index}`, {
            type: "rect",
            ...round(p.marker),
            fill: MAP_COLOURS.labelBacking,
            border: colour,
            borderWidth: 2,
            z: Z_BOX
          });
          scene.set(`mark.${p.index}.text`, {
            type: "text",
            text: labels[p.index],
            size: TEXT_SIZE,
            bold: true,
            colour: MAP_COLOURS.text,
            x: Math.round(p.cx),
            y: Math.round(p.cy - TEXT_SIZE * 0.65),
            align: "center",
            z: Z_LABEL
          });
        }
      }
      const handle = this.handleOf(editor2);
      if (handle) {
        scene.set("handle", { type: "rect", ...round(handle), fill: MAP_COLOURS.selected, border: "#000000", borderWidth: 1, z: Z_LABEL });
      }
      this.layer.render(scene);
      this.layer.show(true, 0);
    }
    /** A number tag at a box's top left corner. */
    tag(scene, id, text, x, y, colour) {
      const m = measure(this.overlay, text, TEXT_SIZE, true);
      scene.set(id, {
        type: "rect",
        x: Math.round(x),
        y: Math.round(y),
        width: Math.ceil(m.width) + 10,
        height: Math.ceil(m.height) + 4,
        fill: MAP_COLOURS.labelBacking,
        z: Z_LABEL
      });
      scene.set(`${id}.text`, { type: "text", text, size: TEXT_SIZE, bold: true, colour, x: Math.round(x) + 5, y: Math.round(y) + 2, z: Z_LABEL + 1 });
    }
    /** A dotted line between two window points, clipped to the window: dense for a pan, sparse for a cut. */
    line(scene, id, x0, y0, x1, y1, pan) {
      const clipped = clip(x0, y0, x1, y1, ui.width, ui.height);
      if (!clipped) {
        return;
      }
      const [ax, ay, bx, by] = clipped;
      const length = Math.hypot(bx - ax, by - ay);
      const gap = Math.max(pan ? PAN_GAP : CUT_GAP, length / MAX_DOTS);
      const n = Math.floor(length / gap);
      for (let i = 0; i <= n; i++) {
        const t = n === 0 ? 0 : i / n;
        scene.set(`${id}.${i}`, {
          type: "rect",
          x: Math.round(ax + (bx - ax) * t - DOT / 2),
          y: Math.round(ay + (by - ay) * t - DOT / 2),
          width: DOT,
          height: DOT,
          fill: pan ? MAP_COLOURS.pan : MAP_COLOURS.cut,
          z: Z_LINE
        });
      }
    }
  };
  function round(r) {
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function clip(x0, y0, x1, y1, w, h) {
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const edges = [[-dx, x0], [dx, w - x0], [-dy, y0], [dy, h - y0]];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) {
          return void 0;
        }
      } else {
        const r = q / p;
        if (p < 0) {
          t0 = Math.max(t0, r);
        } else {
          t1 = Math.min(t1, r);
        }
      }
    }
    return t0 <= t1 ? [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy] : void 0;
  }

  // src/ui/editor-panel.ts
  var PAN_SHARE_STEP2 = 0.1;
  var HINT_FRAME = "Drag the park: moves the view. Wheel: zooms it.";
  var HINT_LOCKED = "An event view, locked: dragging the park moves the camera.";
  var HINT_MAP = "Drag a box or its corner. Right-click: adds a view.";
  var DRAG_Z = Z.tip - 2;
  var CHOICES = {
    inertia: [["Off", false, "Even pan speed"], ["On", true, "Eased pans"]],
    panChanges: [
      ["Off", "off", "Cut on angle or zoom change"],
      ["Start", "start", "Turn and zoom at pan start"],
      ["End", "end", "Turn and zoom at pan end"]
    ],
    titleMusic: [
      ["Ride", "ride", "Ride music"],
      ["Theme", "theme", "Title theme"],
      ["Unset", "keep", "Viewer's setting"]
    ],
    titles: [
      ["Overview", "overview", "First view"],
      ["On", "on", "Every view"],
      ["Off", "off", "No names"],
      ["Unset", null, "Viewer's setting"]
    ]
  };
  var Scroll = class {
    constructor() {
      this.first = 0;
    }
    clamp(count, visible) {
      this.first = Math.max(0, Math.min(this.first, Math.max(0, Math.ceil(count - visible))));
    }
    by(rows, count, visible) {
      this.first += rows;
      this.clamp(count, visible);
    }
    /** Lays the bar out in `track` (none when everything shows). */
    layout(track, count, visible) {
      this.clamp(count, visible);
      if (count <= visible) {
        this.track = this.thumb = void 0;
        return;
      }
      const h = Math.max(12, Math.round(track.height * visible / count));
      const span = Math.max(1, Math.ceil(count - visible));
      this.track = track;
      this.thumb = { x: track.x, y: track.y + Math.round((track.height - h) * this.first / span), width: track.width, height: h };
    }
    draw(scene, id) {
      if (this.track && this.thumb) {
        scene.set(`${id}.track`, { type: "rect", ...this.track, fill: THEME.editorList, z: Z.face });
        scene.set(`${id}.thumb`, { type: "rect", ...this.thumb, fill: THEME.faceOn, z: Z.icon });
      }
    }
    /** The first row for the thumb dragged to `y` (from a press at y0 when the first row was first0). */
    dragTo(y, y0, first0, count, visible) {
      if (!this.track || !this.thumb) {
        return;
      }
      const span = Math.max(1, this.track.height - this.thumb.height);
      this.first = first0 + Math.round((y - y0) / span * Math.max(0, count - visible));
      this.clamp(count, visible);
    }
  };
  var EditorPanel = class {
    constructor(mode2, now = () => Date.now()) {
      this.mode = mode2;
      this.now = now;
      this.supportsMap = true;
      this.mouse = { x: -1, y: -1 };
      this.boxes = /* @__PURE__ */ new Map();
      this.tips = /* @__PURE__ */ new Map();
      this.off = /* @__PURE__ */ new Set();
      // inactive buttons
      this.frames = [];
      // the panes shown, for what the mouse is over
      this.paneViews = { x: 0, y: 0, width: 0, height: 0 };
      this.listRect = { x: 0, y: 0, width: 0, height: 0 };
      // the event views' rows, when the park has any
      this.clockShown = -1;
      // the park clock's second the event list last showed
      this.loadingShown = false;
      // the build's messages
      this.views = new Scroll();
      this.parks = new Scroll();
      this.events = new Scroll();
      this.points = new Scroll();
      this.followed = -1;
      // the restore point highlighted
      this.propsOpen = true;
      // the Playlist properties unfolded
      this.buildShown = "";
      // the build pane unfolded by hand (undefined: when there is room)
      this.boxBottom = 0;
      // where the top-right box ends, for the build pane under it
      this.messages = new Scroll();
      // the top-right box unfolded by hand (undefined: by the window's width)
      this.lastMove = 0;
      // the pin off: the panes hide this long after the mouse last moved
      this.hidden = false;
      this.layer = new Layer(mode2.overlay, "rcts.ed.");
      this.map = new ViewMap(mode2.overlay);
    }
    get isOpen() {
      return this.editor !== void 0;
    }
    open(editor2) {
      this.editor = editor2;
      this.views.first = 0;
      this.dropdown = void 0;
      this.picked = void 0;
      this.hidden = false;
      this.lastMove = this.now();
      this.render();
      this.layer.show(true, TIMING.fadeIn);
      this.render();
    }
    close() {
      this.editor = void 0;
      this.downOn = void 0;
      this.drag = void 0;
      this.rowDrag = void 0;
      this.thumbDrag = void 0;
      this.dropdown = void 0;
      this.layer.clear();
      this.map.clear();
    }
    refresh() {
      this.render();
    }
    /** Called every update: with the pin off the panes hide once the mouse has rested a while. */
    update() {
      const e = this.editor;
      e?.syncMap();
      const second = e && this.eventsRect && !this.hidden ? Math.floor(e.playback.parkClock / 40) : -1;
      const build = e && !this.hidden ? this.buildSignature(e) : this.buildShown;
      if (second >= 0 && second !== this.clockShown && !this.busy || e && e.playback.isLoading !== this.loadingShown || build !== this.buildShown && !this.busy) {
        this.render();
      }
      if (!e || e.pinned || this.hidden || this.busy || this.over(this.mouse.x, this.mouse.y)) {
        return;
      }
      if (this.now() - this.lastMove >= TIMING.hideAfter) {
        this.hidden = true;
        this.layer.show(false, TIMING.fadeOut);
      }
    }
    get busy() {
      return this.downOn !== void 0 || this.rowDrag !== void 0 || this.thumbDrag !== void 0 || this.dropdown !== void 0;
    }
    over(x, y) {
      return this.frames.some((f) => contains(f, x, y));
    }
    wake() {
      this.lastMove = this.now();
      if (this.hidden) {
        this.hidden = false;
        this.layer.show(true, TIMING.fadeIn);
      }
    }
    /** Handles a mouse event over the panes (or a press that started on them); false lets it through. */
    onMouse(e) {
      const ed = this.editor;
      if (!ed || this.drag || this.map.dragging) {
        return false;
      }
      if (e.type !== "wheel") {
        if (e.x !== this.mouse.x || e.y !== this.mouse.y) {
          this.wake();
        }
        this.mouse = { x: e.x, y: e.y };
      }
      const inside = this.over(this.mouse.x, this.mouse.y);
      let used = inside || this.busy;
      if (e.type === "move") {
        this.moved();
      } else if (e.type === "down" && e.button === 0) {
        used = this.pressed(inside) || used;
      } else if (e.type === "down") {
        used = inside || this.dropdown !== void 0;
        if (this.dropdown && !inside) {
          this.dropdown = void 0;
        }
      } else if (e.type === "up" && e.button === 0) {
        used = this.released() || used;
      } else if (e.type === "wheel") {
        const step = e.delta > 0 ? -1 : 1;
        if (this.parksRect && contains(this.parksRect, this.mouse.x, this.mouse.y)) {
          this.parks.by(step, ed.parkNames.length, this.parkRows());
        } else if (contains(this.listRect, this.mouse.x, this.mouse.y)) {
          this.views.by(step, ed.routeIndices().length, EDITOR.visibleRows);
        } else if (this.eventsRect && contains(this.eventsRect, this.mouse.x, this.mouse.y)) {
          this.events.by(step, ed.eventIndices().length, EDITOR.eventRows);
        } else if (this.pointsRect && contains(this.pointsRect, this.mouse.x, this.mouse.y)) {
          this.points.by(step, ed.restorePoints().length, EDITOR.boxRows);
        } else if (this.messagesRect && contains(this.messagesRect, this.mouse.x, this.mouse.y)) {
          this.messages.by(step, builder.messages.length, EDITOR.boxRows);
        }
      }
      this.render();
      return used;
    }
    moved() {
      const t = this.thumbDrag;
      if (t) {
        t.scroll.dragTo(this.mouse.y, t.y0, t.first0, t.count(), t.visible);
        return;
      }
      const r = this.rowDrag;
      if (r && !r.moving && Math.abs(this.mouse.y - r.y0) + Math.abs(this.mouse.x - r.x0) >= EDITOR.dragStart) {
        r.moving = r.list === "parks" ? this.dropdown?.persistent === true : this.editor.movable(r.from);
        if (!r.moving && r.list === "views") {
          this.rowDrag = void 0;
        }
      }
      if (r?.moving) {
        this.autoScroll(r);
      }
    }
    /** A dragged row near its list's top or bottom edge scrolls the list. */
    autoScroll(r) {
      const ed = this.editor;
      const rect = r.list === "views" ? this.listRect : this.parksRect;
      if (!rect) {
        return;
      }
      const rowsTop = rect.y + (r.list === "views" ? EDITOR.rowHeight : EDITOR.parkRow);
      const step = this.mouse.y < rowsTop ? -1 : this.mouse.y > rect.y + rect.height ? 1 : 0;
      if (step && r.list === "views") {
        this.views.by(step, ed.routeIndices().length, EDITOR.visibleRows);
      } else if (step) {
        this.parks.by(step, ed.parkNames.length, this.parkRows());
      }
    }
    pressed(inside) {
      const ed = this.editor;
      const hit = this.hit();
      if (this.dropdown && (!hit || !hit.startsWith("park.") && !hit.startsWith("parks."))) {
        this.dropdown = void 0;
        return true;
      }
      if (!inside && !hit) {
        return false;
      }
      this.downOn = hit;
      if (hit === "field") {
        this.dropdown = { persistent: false, downAt: this.now() };
        this.parks.first = Math.max(0, ed.playback.playOrder.indexOf(ed.parkIndex) - 2);
      } else if (hit?.startsWith("row.") || hit?.startsWith("park.")) {
        const views = hit.startsWith("row.");
        this.rowDrag = { list: views ? "views" : "parks", from: Number(hit.slice(views ? 4 : 5)), x0: this.mouse.x, y0: this.mouse.y, moving: false };
      } else if (hit?.endsWith(".thumb")) {
        const which = hit.slice(0, -6);
        const scroll = this.scrollOf(which);
        const count = which === "parks" ? () => ed.parkNames.length : which === "points" ? () => ed.restorePoints().length : which === "messages" ? () => builder.messages.length : which === "events" ? () => ed.eventIndices().length : () => ed.routeIndices().length;
        const visible = which === "parks" ? this.parkRows() : which === "points" || which === "messages" ? EDITOR.boxRows : which === "events" ? EDITOR.eventRows : EDITOR.visibleRows;
        this.thumbDrag = { scroll, y0: this.mouse.y, first0: scroll.first, count, visible };
      } else if (hit?.endsWith(".track")) {
        const which = hit.slice(0, -6);
        const scroll = this.scrollOf(which);
        const page = which === "parks" ? this.parkRows() : which === "points" || which === "messages" ? 3 : which === "events" ? EDITOR.eventRows : EDITOR.visibleRows;
        const count = which === "parks" ? ed.parkNames.length : which === "points" ? ed.restorePoints().length : which === "messages" ? builder.messages.length : which === "events" ? ed.eventIndices().length : ed.routeIndices().length;
        scroll.by(this.mouse.y < (scroll.thumb?.y ?? 0) ? -page : page, count, page);
      }
      return true;
    }
    released() {
      const ed = this.editor;
      const hit = this.hit();
      const down = this.downOn;
      this.downOn = void 0;
      this.thumbDrag = void 0;
      const r = this.rowDrag;
      this.rowDrag = void 0;
      const dd = this.dropdown;
      if (down === "field" && dd && !dd.persistent) {
        if (hit?.startsWith("park.")) {
          this.goToPark(Number(hit.slice(5)));
          this.dropdown = void 0;
        } else if (hit === "field" && this.now() - dd.downAt < EDITOR.holdOpen) {
          dd.persistent = true;
        } else {
          this.dropdown = void 0;
        }
        return true;
      }
      if (r?.moving) {
        const to = this.dropIndex(r);
        if (r.list === "views") {
          ed.moveTo(r.from, to);
        } else {
          ed.playback.moveParkInOrder(r.from, to);
        }
        return true;
      }
      if (down && hit === down && !this.off.has(hit)) {
        this.activate(hit);
      }
      return down !== void 0;
    }
    scrollOf(which) {
      return which === "parks" ? this.parks : which === "points" ? this.points : which === "messages" ? this.messages : which === "events" ? this.events : this.views;
    }
    /** Where a dragged row lands: the gap nearest the mouse, as an index after the row leaves its place.
     *  A route view lands among the route views: the event views listed between them stay put. */
    dropIndex(r) {
      const ed = this.editor;
      const views = r.list === "views";
      const rect = views ? this.listRect : this.parksRect;
      const rowH = views ? EDITOR.rowHeight : EDITOR.parkRow;
      const route = ed.routeIndices();
      const count = views ? route.length : ed.parkNames.length;
      const first = views ? this.views.first : this.parks.first;
      const gap = Math.max(0, Math.min(count, Math.round((this.mouse.y - rect.y - rowH) / rowH) + first));
      if (!views) {
        return gap > r.from ? gap - 1 : gap;
      }
      const fromPos = route.indexOf(r.from);
      const rest = route.filter((i) => i !== r.from);
      const p = fromPos >= 0 && gap > fromPos ? gap - 1 : gap;
      if (!rest.length) {
        return r.from;
      }
      const after = (i) => i > r.from ? i - 1 : i;
      return p < rest.length ? after(rest[p]) : after(rest[rest.length - 1]) + 1;
    }
    /** Handles a mouse event on the park (off the panes and the bar, or during a drag that started on
     * the park): a left drag moves the camera and with it the selected view, the wheel zooms it. */
    onPark(e) {
      const editor2 = this.editor;
      if (!editor2) {
        return false;
      }
      this.wake();
      if (editor2.mapMode || this.map.dragging) {
        return this.map.onMouse(e, editor2);
      }
      if (e.type === "down" && e.button === 0) {
        this.drag = { x: e.x, y: e.y };
        editor2.dragStart();
      } else if (e.type === "move" && this.drag) {
        const dx = e.x - this.drag.x;
        const dy = e.y - this.drag.y;
        this.drag = { x: e.x, y: e.y };
        editor2.dragBy(dx, dy);
      } else if (e.type === "up" && e.button === 0 && this.drag) {
        this.drag = void 0;
        editor2.dragEnd();
      } else if (e.type === "wheel") {
        editor2.wheel(e.delta);
      } else {
        return false;
      }
      if (e.type !== "wheel") {
        this.mouse = { x: e.x, y: e.y };
      }
      return true;
    }
    /** A drag on the park is going on (every mouse event is the park's until it ends). */
    get dragging() {
      return this.drag !== void 0 || this.map.dragging;
    }
    hit() {
      let found;
      for (const [id, r] of this.boxes) {
        if (contains(r, this.mouse.x, this.mouse.y)) {
          if (id.startsWith("park.") || id.startsWith("parks.")) {
            return id;
          }
          if (this.parksRect && contains(this.parksRect, this.mouse.x, this.mouse.y)) {
            continue;
          }
          found = found ?? id;
        }
      }
      return found;
    }
    goToPark(pos) {
      const ed = this.editor;
      const order = ed.playback.playOrder;
      const n = order.length;
      if (n > 0) {
        ed.goToPark(order[(pos % n + n) % n]);
      }
    }
    activate(id) {
      const e = this.editor;
      if (!e) {
        return;
      }
      if (id.startsWith("row.") || id.startsWith("event.")) {
        e.select(Number(id.slice(id.indexOf(".") + 1)));
        return;
      }
      if (id.startsWith("park.")) {
        this.goToPark(Number(id.slice(5)));
        return;
      }
      if (id.startsWith("msg.") || id.startsWith("sq.")) {
        const key = id.startsWith("msg.") ? builder.messages[Number(id.slice(4))]?.park : builder.parks[Number(id.slice(3))]?.key;
        const index = key ? e.playback.parkIndexOf(key) : -1;
        if (index >= 0 && index !== e.parkIndex) {
          e.goToPark(index);
        }
        return;
      }
      if (id.startsWith("point.")) {
        this.picked = e.restorePoints()[Number(id.slice(6))]?.id;
        return;
      }
      if (id.startsWith("seg.")) {
        const [, key, i] = id.split(".");
        const choice = CHOICES[key]?.[Number(i)];
        if (choice) {
          this.setProp(key, choice[1]);
        }
        return;
      }
      if (id.startsWith("step.")) {
        const [, key, sign] = id.split(".");
        const k = key;
        const v = e.playback.playlistProps[k] + (sign === "more" ? EDITOR.holdStep : -EDITOR.holdStep);
        this.setProp(k, Math.round(Math.max(0, Math.min(EDITOR.holdMax, v)) * 100) / 100);
        return;
      }
      const pos = e.playback.playOrder.indexOf(e.parkIndex);
      switch (id) {
        case "close":
          e.close();
          break;
        case "prevPark":
          this.goToPark(pos - 1);
          break;
        case "nextPark":
          this.goToPark(pos + 1);
          break;
        case "frameMode":
          if (e.mapMode) e.toggleMap();
          break;
        case "mapMode":
          if (!e.mapMode) e.toggleMap();
          break;
        case "add":
          e.add();
          break;
        case "update":
          e.update();
          break;
        case "delete":
          e.remove();
          break;
        case "rotl":
          e.rotate(-1);
          break;
        case "rotr":
          e.rotate(1);
          break;
        case "zoomin":
          e.zoom(-1);
          break;
        case "zoomout":
          e.zoom(1);
          break;
        case "lock":
          e.toggleEventLock();
          break;
        case "holdLess":
          e.changeHold(-1);
          break;
        case "holdMore":
          e.changeHold(1);
          break;
        case "panLess":
          e.changePan(-PAN_SHARE_STEP2);
          break;
        case "panMore":
          e.changePan(PAN_SHARE_STEP2);
          break;
        case "undo":
          e.undo();
          break;
        case "redo":
          e.redo();
          break;
        case "reset":
          e.resetView();
          break;
        case "pin":
          e.togglePinned();
          break;
        case "play":
          e.togglePreview();
          break;
        case "checkpoint":
          e.saveCheckpoint();
          break;
        case "restore":
          if (this.picked) e.restoreTo(this.picked);
          break;
        case "boxHead":
          this.boxOpen = this.boxFolded();
          break;
        case "propsHead":
          this.propsOpen = !this.propsOpen;
          break;
        case "buildHead":
          this.buildOpen = this.buildFolded();
          break;
        case "build":
          this.toggleBuild();
          break;
      }
    }
    /** Build and play, or Cancel build (also Ctrl+B). */
    toggleBuild() {
      const e = this.editor;
      if (builder.running) {
        builder.cancel();
      } else if (e && builder.available && builder.pendingEdits(e.playback.installedAt)) {
        e.playback.savePlaylistProps();
        this.messages.first = 0;
        builder.start(e.playback.sequenceName);
      }
      this.render();
    }
    /** A Playlist property changed: in force at once and saved, like the views (owner, 2026-11-11). */
    setProp(key, value) {
      const p = this.editor.playback;
      p.setPlaylistProp(key, value);
      p.savePlaylistProps();
      if (key === "titleMusic") {
        this.mode.configure(modeSettings(p.liveSettings));
      }
    }
    // Layout
    parkRows() {
      return Math.max(1, Math.floor(((this.parksRect?.height ?? 0) - EDITOR.parkRow) / EDITOR.parkRow));
    }
    /** The top-right box shows only its header: by hand, else when the window is too narrow for it
     *  beside the views pane (owner, 2026-11-10). */
    boxFolded() {
      if (this.boxOpen !== void 0) {
        return !this.boxOpen;
      }
      return ui.width < EDITOR.x + EDITOR.width + 2 * EDITOR.x + EDITOR.boxWidth + EDITOR.x;
    }
    place(id, r, tip, disabled = false) {
      this.boxes.set(id, r);
      if (tip) {
        this.tips.set(id, tip);
      }
      if (disabled) {
        this.off.add(id);
      }
      return r;
    }
    render() {
      const e = this.editor;
      if (!e) {
        return;
      }
      this.loadingShown = e.playback.isLoading;
      this.hovered = this.hit();
      this.boxes.clear();
      this.tips.clear();
      this.off.clear();
      this.frames = [];
      const scene = /* @__PURE__ */ new Map();
      this.viewsPane(e, scene);
      this.toolbox(e, scene);
      this.topRight(e, scene);
      this.buildPane(e, scene);
      const hover = this.hit();
      const tip = hover && !this.busy ? this.tips.get(hover) : void 0;
      if (tip) {
        const r = this.boxes.get(hover);
        const below = r.y < 80;
        const h = Math.ceil(measure(this.mode.overlay, tip, THEME.tipSize).height) + 2 * THEME.tipPad;
        tooltip(scene, "tip", tip, r.x + r.width / 2, below ? r.y + r.height + 4 + h : r.y - 4, this.mode.overlay, ui.width);
      }
      this.layer.render(scene);
      if (e.mapMode && !e.playback.isLoading) {
        this.map.render(e);
      } else {
        this.map.clear();
      }
    }
    state(id, on = false, alt = false) {
      const hover = this.hit() === id;
      return { hover, down: this.downOn === id && hover, on, alt, disabled: this.off.has(id) };
    }
    /** The views pane: the park's title row over its views, or the park list while it is open. */
    viewsPane(e, scene) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      const x0 = s.x + s.pad;
      const inner = s.width - 2 * s.pad;
      let y = s.y + s.pad;
      const t = s.titleHeight;
      const order = e.playback.playOrder;
      const pos = order.indexOf(e.parkIndex);
      const many = order.length > 1;
      this.place("prevPark", { x: x0, y, width: t, height: t }, "Previous park", !many || e.playback.isLoading);
      const closeX = x0 + inner - t;
      const nextX = closeX - s.groupGap - t;
      this.place("nextPark", { x: nextX, y, width: t, height: t }, "Next park", !many || e.playback.isLoading);
      this.place("close", { x: closeX, y, width: t, height: t }, "Close (E)");
      const field = this.place(
        "field",
        { x: x0 + t + s.gap, y, width: nextX - s.gap - (x0 + t + s.gap), height: t },
        many ? "Hold: jump to a park. Click: reorder" : void 0
      );
      y += t + s.gap;
      const rows = e.rows();
      const route = e.routeIndices();
      const events = e.eventIndices();
      const sel = e.selectedIndex;
      if (sel !== this.followed) {
        this.followed = sel;
        const r = route.indexOf(sel);
        const k = events.indexOf(sel);
        if (r >= 0 && (r < this.views.first || r >= this.views.first + s.visibleRows)) {
          this.views.first = r;
        }
        if (k >= 0 && (k < this.events.first || k >= this.events.first + s.eventRows)) {
          this.events.first = k;
        }
      }
      const listH = s.rowHeight * (s.visibleRows + 1);
      const bar2 = route.length > s.visibleRows ? s.scrollBar + 2 : 0;
      this.listRect = { x: x0, y, width: inner - bar2, height: listH };
      this.views.layout({ x: x0 + inner - s.scrollBar, y: y + s.rowHeight, width: s.scrollBar, height: s.visibleRows * s.rowHeight }, route.length, s.visibleRows);
      let bottom = y + listH;
      if (events.length) {
        const shown = Math.min(events.length, s.eventRows);
        const top = bottom + s.eventsGap + s.rowHeight;
        const ebar = events.length > s.eventRows ? s.scrollBar + 2 : 0;
        this.eventsRect = { x: x0, y: top, width: inner - ebar, height: s.rowHeight * (shown + 1) };
        this.events.layout({ x: x0 + inner - s.scrollBar, y: top + s.rowHeight, width: s.scrollBar, height: shown * s.rowHeight }, events.length, s.eventRows);
        bottom = top + this.eventsRect.height;
      } else {
        this.eventsRect = void 0;
        this.events.first = 0;
      }
      this.paneViews = { x: s.x, y: s.y, width: s.width, height: bottom + s.pad - s.y };
      this.frames.push(this.paneViews);
      backing(scene, "frame", this.paneViews, THEME.editorBacking);
      button(scene, "prevPark", this.boxes.get("prevPark"), this.state("prevPark"), { icon: "prev-view", iconSize: s.toolIcon }, overlay);
      button(scene, "nextPark", this.boxes.get("nextPark"), this.state("nextPark"), { icon: "next-view", iconSize: s.toolIcon }, overlay);
      button(scene, "close", this.boxes.get("close"), this.state("close"), { icon: "close", iconSize: s.toolIcon }, overlay);
      const fieldOpen = this.dropdown !== void 0;
      scene.set("field", { type: "rect", ...field, fill: fieldOpen ? THEME.faceDown : this.hit() === "field" ? THEME.faceHover : THEME.editorList, z: Z.face });
      bevel(scene, "field", field, THEME.bevelDark, THEME.bevelLight, THEME.bevel, Z.bevel);
      if (fieldOpen) {
        scene.set("field.open", { type: "rect", ...field, fill: "#00000000", border: THEME.fieldOpen, borderWidth: 2, z: Z.icon });
      }
      const count = many ? `${pos + 1} / ${order.length}` : "";
      if (many) {
        foldMark(scene, "field.mark", fieldOpen, field.x + field.width - 24, field.y + field.height / 2, overlay);
      }
      const countW = count ? measure(overlay, count, s.textSize, true).width + 22 : 0;
      const name = fit(overlay, e.parkNames[e.parkIndex] ?? "No park", s.titleSize, field.width - countW - 28, true);
      label(scene, "text.park", name, { x: field.x + 8, y: field.y, width: 0, height: field.height }, s.titleSize, overlay, true);
      if (count) {
        label(scene, "text.count", count, { x: field.x + field.width - 6 - countW, y: field.y, width: 0, height: field.height }, s.textSize, overlay, true);
      }
      this.viewsList(e, scene, rows, route);
      if (this.eventsRect) {
        this.eventsList(e, scene, events);
      }
      if (this.dropdown) {
        this.parkList(e, scene);
      } else {
        this.parksRect = void 0;
      }
    }
    viewsList(e, scene, rows, route) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      const list = this.listRect;
      scene.set("list", { type: "rect", ...list, fill: THEME.editorList, z: Z.face });
      const cols = columnStarts(list.width - s.grip, route.map((i) => rows[i]), overlay, EDITOR_COLUMNS).map((c) => c + s.grip);
      EDITOR_COLUMNS.forEach((h, c) => label(
        scene,
        `head.${c}`,
        h,
        { x: list.x + cols[c] + 4, y: list.y, width: 0, height: s.rowHeight },
        s.textSize,
        overlay,
        true
      ));
      const top = list.y + s.rowHeight;
      const hover = this.hovered;
      const r = this.rowDrag?.list === "views" && this.rowDrag.moving ? this.rowDrag : void 0;
      for (let i = 0; i < s.visibleRows; i++) {
        const index = route[this.views.first + i];
        const row = rows[index];
        if (index === void 0 || !row) {
          break;
        }
        const box = this.place(`row.${index}`, { x: list.x, y: top + i * s.rowHeight, width: list.width, height: s.rowHeight });
        const fill = index === e.selectedIndex ? THEME.faceOn : hover === `row.${index}` && !r ? THEME.faceHover : i % 2 ? THEME.face : void 0;
        scene.set(`row.${index}`, { type: "rect", ...box, fill: fill ?? "#00000000", z: Z.face });
        const cells = this.cells(e, row);
        if (e.movable(index)) {
          grip(scene, `grip.${i}`, box.x + 5, box.y + box.height / 2);
        }
        cells.forEach((cell, c) => label(
          scene,
          `cell.${i}.${c}`,
          cell,
          { x: box.x + cols[c] + 4, y: box.y, width: 0, height: box.height },
          s.textSize,
          overlay
        ));
        if (r && r.from === index) {
          scene.set(`dim.${i}`, { type: "rect", ...box, fill: THEME.rowDimmed, z: Z.icon + 1 });
        }
      }
      this.views.draw(scene, "views");
      if (this.views.track) {
        this.place("views.track", this.views.track);
        this.place("views.thumb", this.views.thumb);
      }
      if (r) {
        this.dragged(scene, list, s.rowHeight, this.views.first, route.length, r, (ghost) => {
          this.cells(e, rows[r.from]).forEach((cell, c) => label(
            scene,
            `ghost.${c}`,
            cell,
            { x: ghost.x + cols[c] + 4, y: ghost.y, width: 0, height: ghost.height },
            s.textSize,
            overlay
          ));
        });
      }
    }
    /** The event views: when they play and on what, apart from the route, as no drag or list place
     *  changes their timing (owner, 2026-11-10); a click selects one. */
    eventsList(e, scene, events) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      const list = this.eventsRect;
      const title = { x: list.x, y: list.y - s.rowHeight, width: list.width, height: s.rowHeight };
      label(scene, "text.events", `Events  ${events.length}`, { x: title.x + 4, y: title.y, width: 0, height: title.height }, s.textSize, overlay, true);
      const note = e.eventsLocked ? "play on the park's timing (locked)" : "play on the park's timing";
      const noteX = title.x + 4 + measure(overlay, `Events  ${events.length}`, s.textSize, true).width + 12;
      scene.set("text.events.note", {
        type: "text",
        text: note,
        size: s.hintSize,
        colour: THEME.textDim,
        x: noteX,
        y: Math.round(title.y + (title.height - s.hintSize * 1.25) / 2),
        z: Z.icon
      });
      scene.set("events", { type: "rect", ...list, fill: THEME.editorList, z: Z.face });
      const rows = e.eventRows();
      this.clockShown = Math.floor(e.playback.parkClock / 40);
      const cols = columnStarts(list.width - s.grip, rows, overlay, EVENT_COLUMNS).map((c) => c + s.grip);
      EVENT_COLUMNS.forEach((h, c) => label(
        scene,
        `ehead.${c}`,
        h,
        { x: list.x + cols[c] + 4, y: list.y, width: 0, height: s.rowHeight },
        s.textSize,
        overlay,
        true
      ));
      const top = list.y + s.rowHeight;
      const hover = this.hovered;
      for (let i = 0; i < s.eventRows; i++) {
        const k = this.events.first + i;
        const index = events[k];
        if (index === void 0) {
          break;
        }
        const box = this.place(`event.${index}`, { x: list.x, y: top + i * s.rowHeight, width: list.width, height: s.rowHeight });
        const fill = index === e.selectedIndex ? THEME.faceOn : hover === `event.${index}` ? THEME.faceHover : i % 2 ? THEME.face : void 0;
        scene.set(`event.${index}`, { type: "rect", ...box, fill: fill ?? "#00000000", z: Z.face });
        rows[k].forEach((cell, c) => label(
          scene,
          `ecell.${i}.${c}`,
          fit(overlay, cell, s.textSize, (cols[c + 1] ?? list.width) - cols[c] - 6),
          { x: box.x + cols[c] + 4, y: box.y, width: 0, height: box.height },
          s.textSize,
          overlay
        ));
      }
      this.events.draw(scene, "events");
      if (this.events.track) {
        this.place("events.track", this.events.track);
        this.place("events.thumb", this.events.thumb);
      }
    }
    /** A row's cells as shown: who set each view, event views marked locked while they are. */
    cells(e, row) {
      const by = row[6] === "auto" ? "generated" : row[6] === "event" && e.eventsLocked ? "event (locked)" : row[6];
      return [...row.slice(0, 6), by];
    }
    /** A row being dragged: lifted under the mouse, with an orange line where it would go. */
    dragged(scene, list, rowH, first, count, r, cells) {
      const ghost = { x: list.x + 6, y: Math.round(this.mouse.y - rowH / 2), width: list.width - 6, height: rowH };
      scene.set("ghost", { type: "rect", ...ghost, fill: THEME.dragGhost, z: DRAG_Z });
      bevel(scene, "ghost", ghost, THEME.bevelLight, THEME.bevelDark, THEME.bevel, DRAG_Z);
      grip(scene, "ghost.grip", ghost.x + 5, ghost.y + rowH / 2, DRAG_Z + 1);
      const before = scene.size;
      cells(ghost);
      let k = 0;
      for (const [id, el] of scene) {
        if (k++ >= before) {
          scene.set(id, { ...el, z: DRAG_Z + 1 });
        }
      }
      const gap = Math.max(0, Math.min(count, Math.round((this.mouse.y - list.y - rowH) / rowH) + first));
      const shown = Math.max(0, Math.min(EDITOR.visibleRows + 4, gap - first));
      const lineY = list.y + rowH + shown * rowH - 1;
      if (gap >= first && lineY <= list.y + list.height + 1) {
        scene.set("dropline", { type: "rect", x: list.x, y: lineY, width: list.width, height: 3, fill: THEME.dragLine, z: DRAG_Z + 2 });
      }
    }
    /** The park list, over the views list: the playlist's order, its rows dragged to reorder it. */
    parkList(e, scene) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      const order = e.playback.playOrder;
      const area = { x: this.listRect.x, y: this.listRect.y, width: this.paneViews.width - 2 * s.pad, height: this.listRect.height };
      this.parksRect = area;
      const visible = this.parkRows();
      const bar2 = order.length > visible ? s.scrollBar + 2 : 0;
      this.parks.layout(
        { x: area.x + area.width - s.scrollBar, y: area.y + s.parkRow, width: s.scrollBar, height: visible * s.parkRow },
        order.length,
        visible
      );
      const z = Z.tip - 4;
      scene.set("parks", { type: "rect", ...area, fill: "#0b170fff", z });
      bevel(scene, "parks", area, THEME.bevelDark, THEME.bevelLight, THEME.bevel, z);
      scene.set("parks.open", { type: "rect", ...area, fill: "#00000000", border: THEME.fieldOpen, borderWidth: 2, z: z + 3 });
      const head = this.dropdown?.persistent ? "Playlist order" : "Release on a park to go there";
      label(scene, "parks.head", head, { x: area.x + 8, y: area.y, width: 0, height: s.parkRow }, s.textSize, overlay, true);
      scene.set("parks.head", { ...scene.get("parks.head"), z: z + 2 });
      if (this.dropdown?.persistent) {
        const help = "drag to reorder \xB7 click to go";
        const w = measure(overlay, help, s.textSize - 2).width;
        label(scene, "parks.help", help, { x: area.x + area.width - bar2 - 8 - w, y: area.y, width: 0, height: s.parkRow }, s.textSize - 2, overlay);
        scene.set("parks.help", { ...scene.get("parks.help"), colour: THEME.textDim, z: z + 2 });
      }
      const width = area.width - bar2;
      const top = area.y + s.parkRow;
      const hover = this.hovered;
      const r = this.rowDrag?.list === "parks" && this.rowDrag.moving ? this.rowDrag : void 0;
      const countW = measure(overlay, "000 views", s.textSize).width;
      for (let i = 0; i < visible; i++) {
        const p = this.parks.first + i;
        const index = order[p];
        if (index === void 0) {
          break;
        }
        const box = this.place(`park.${p}`, { x: area.x, y: top + i * s.parkRow, width, height: s.parkRow });
        const jump = !this.dropdown?.persistent && hover === `park.${p}`;
        const fill = jump ? THEME.faceAltHover : index === e.parkIndex ? THEME.faceOn : hover === `park.${p}` && !r ? THEME.faceHover : i % 2 ? THEME.face : "#00000000";
        scene.set(`park.${p}`, { type: "rect", ...box, fill, z: z + 1 });
        if (this.dropdown?.persistent) {
          grip(scene, `pgrip.${i}`, box.x + 5, box.y + box.height / 2, z + 2);
        }
        const n = e.playback.viewCountOf(index);
        const texts = [
          [`pn.${i}`, String(p + 1), box.x + s.grip + 4],
          [`pname.${i}`, fit(overlay, e.parkNames[index] ?? "", s.textSize, width - s.grip - 40 - countW - 16), box.x + s.grip + 40],
          [`pcount.${i}`, `${n} view${n === 1 ? "" : "s"}`, box.x + width - 8 - measure(overlay, `${n} view${n === 1 ? "" : "s"}`, s.textSize).width]
        ];
        for (const [id, text, x] of texts) {
          label(scene, id, text, { x, y: box.y, width: 0, height: box.height }, s.textSize, overlay, id.startsWith("pname") && index === e.parkIndex);
          scene.set(id, { ...scene.get(id), z: z + 2, ...id.startsWith("pcount") ? { colour: THEME.textDim } : {} });
        }
        if (r && r.from === p) {
          scene.set(`pdim.${i}`, { type: "rect", ...box, fill: THEME.rowDimmed, z: z + 3 });
        }
      }
      if (this.parks.track) {
        scene.set("parks.track", { type: "rect", ...this.parks.track, fill: THEME.editorList, z: z + 1 });
        scene.set("parks.thumb", { type: "rect", ...this.parks.thumb, fill: THEME.faceOn, z: z + 2 });
        this.place("parks.track", this.parks.track);
        this.place("parks.thumb", this.parks.thumb);
      }
      if (r) {
        const list = { ...area, width };
        this.dragged(scene, list, s.parkRow, this.parks.first, order.length, r, (ghost) => {
          label(scene, "ghost.name", e.parkNames[order[r.from]] ?? "", { x: ghost.x + s.grip + 34, y: ghost.y, width: 0, height: ghost.height }, s.textSize, overlay, true);
        });
      }
    }
    /** The toolbox at the window's bottom left (owner's design, 2026-11-10). */
    toolbox(e, scene) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      const b = s.tool;
      const inner = 8 * b + 5 * s.gap + 2 * s.groupGap;
      const height = s.pad + s.switchHeight + 2 + s.hintHeight + 2 * (s.labelHeight + b) + 4 + 8 + b + s.pad;
      const frame = { x: s.x, y: ui.height - s.y - height, width: inner + 2 * s.pad, height };
      this.frames.push(frame);
      backing(scene, "tools", frame, THEME.editorBacking);
      const x0 = frame.x + s.pad;
      let y = frame.y + s.pad;
      const loading = e.playback.isLoading;
      const noView = e.selectedIndex < 0 || loading;
      const fixedView = noView || e.selectedLocked;
      const half = Math.floor((inner - s.gap) / 2);
      this.place("frameMode", { x: x0, y, width: half, height: s.switchHeight }, "Frame: edit through the camera (M)", loading);
      this.place("mapMode", { x: x0 + inner - half, y, width: half, height: s.switchHeight }, "Map: all views as boxes (M)", loading);
      button(
        scene,
        "frameMode",
        this.boxes.get("frameMode"),
        this.state("frameMode", !e.mapMode),
        { icon: "frame", iconSize: s.toolIcon, text: "Frame", textSize: 15 },
        overlay
      );
      button(
        scene,
        "mapMode",
        this.boxes.get("mapMode"),
        this.state("mapMode", e.mapMode, true),
        { icon: "map", iconSize: s.toolIcon, text: "Map", textSize: 15, hint: "M" },
        overlay
      );
      y += s.switchHeight + 2;
      const hint = fit(overlay, e.mapMode ? HINT_MAP : e.selectedLocked ? HINT_LOCKED : HINT_FRAME, s.hintSize, inner);
      label(scene, "hint", hint, { x: x0, y, width: 0, height: s.hintHeight }, s.hintSize, overlay);
      scene.set("hint", { ...scene.get("hint"), colour: THEME.textDim });
      y += s.hintHeight;
      const groups = [
        ["VIEW", [
          ["add", "add", "Add view (Insert)", loading || !e.playback.canEdit],
          [
            "update",
            "set-camera",
            e.selectedLocked ? "Locked event (unlock on map)" : e.mapMode ? "Move view to center (C)" : "Map only (C)",
            fixedView || !e.mapMode
          ],
          ["delete", "delete", e.selectedLocked ? "Locked event (unlock on map)" : "Delete view (Delete)", fixedView]
        ]],
        ["CAMERA", [
          ["rotl", "rotate-left", "Rotate left (Shift+Enter)", loading],
          ["rotr", "rotate-right", "Rotate right (Enter)", loading],
          ["zoomin", "zoom-in", "Zoom in (Page Up)", loading],
          ["zoomout", "zoom-out", "Zoom out (Page Down)", loading]
        ]],
        ["EVENTS", [
          [
            "lock",
            e.eventsLocked ? "events-locked" : "events-unlocked",
            e.eventsLocked ? "Events locked (L)" : "Events unlocked (L)",
            !e.mapMode,
            !e.eventsLocked
          ]
        ]]
      ];
      let x = x0;
      for (const [name, tools] of groups) {
        this.sectionLabel(scene, `label.${name}`, name, x, y);
        tools.forEach(([id, icon, tip, disabled, on], i) => {
          const r = this.place(id, { x: x + i * (b + s.gap), y: y + s.labelHeight, width: b, height: b }, tip, disabled);
          button(scene, id, r, this.state(id, on === true), { icon, iconSize: s.toolIcon }, overlay);
        });
        x += tools.length * (b + s.gap) - s.gap + s.groupGap;
      }
      y += s.labelHeight + b + 4;
      const stepper = (name, less, more, text, sx, tips) => {
        this.sectionLabel(scene, `label.${name}`, name, sx, y);
        const ry = y + s.labelHeight;
        const l = this.place(less, { x: sx, y: ry, width: b, height: b }, tips[0], fixedView);
        const value = { x: sx + b + s.gap, y: ry, width: s.stepValue, height: b };
        const m = this.place(more, { x: value.x + value.width + s.gap, y: ry, width: b, height: b }, tips[1], fixedView);
        button(scene, less, l, this.state(less), { icon: "less", iconSize: s.toolIcon }, overlay);
        button(scene, more, m, this.state(more), { icon: "add", iconSize: s.toolIcon }, overlay);
        scene.set(`${name}.value`, { type: "rect", ...value, fill: THEME.editorList, z: Z.face });
        bevel(scene, `${name}.value`, value, THEME.bevelDark, THEME.bevelLight, THEME.bevel, Z.bevel);
        label(scene, `text.${name.toLowerCase()}`, text, { x: value.x + value.width / 2, y: ry, width: 0, height: b }, s.textSize, overlay);
        scene.set(`text.${name.toLowerCase()}`, { ...scene.get(`text.${name.toLowerCase()}`), align: "center" });
        return value.x + value.width + s.gap + b;
      };
      const view = noView ? void 0 : e.currentViews[e.selectedIndex];
      const holdEnd = stepper("HOLD", "holdLess", "holdMore", view ? `${view.hold} s` : "-", x0, ["Shorter hold ([)", "Longer hold (])"]);
      stepper(
        "PAN",
        "panLess",
        "panMore",
        view ? `${Math.round(e.playback.panOf(view) * 100)}%` : "-",
        holdEnd + s.groupGap,
        ["Less panning (Shift+[)", "More panning (Shift+])"]
      );
      y += s.labelHeight + b + 8;
      const foot = [
        ["undo", "undo", "Undo (Ctrl+Z)", !e.canUndo, x0],
        ["redo", "redo", "Redo (Ctrl+Y)", !e.canRedo, x0 + b + s.gap],
        ["reset", "reset-view", "Reset to playlist view", !e.canResetView, x0 + 2 * b + s.gap + s.footerGap]
      ];
      for (const [id, icon, tip, disabled, fx] of foot) {
        const r = this.place(id, { x: fx, y, width: b, height: b }, tip, disabled);
        button(scene, id, r, this.state(id), { icon, iconSize: s.toolIcon }, overlay);
      }
      const play = this.place(
        "play",
        { x: x0 + inner - s.playWidth, y, width: s.playWidth, height: b },
        e.isPlaying ? "Stop (P)" : "Play (P)",
        loading
      );
      const pin = this.place(
        "pin",
        { x: play.x - s.gap - b, y, width: b, height: b },
        e.pinned ? "Pinned" : "Unpinned: hides when idle"
      );
      button(scene, "pin", pin, this.state("pin", e.pinned), { icon: "pin", iconSize: s.toolIcon }, overlay);
      button(
        scene,
        "play",
        play,
        this.state("play", e.isPlaying),
        { icon: e.isPlaying ? "pause" : "play", iconSize: s.toolIcon, text: e.isPlaying ? "Stop" : "Play", textSize: 15, hint: "P" },
        overlay
      );
    }
    sectionLabel(scene, id, text, x, y) {
      label(scene, id, text, { x, y, width: 0, height: EDITOR.labelHeight }, EDITOR.labelSize, this.mode.overlay);
      scene.set(id, { ...scene.get(id), colour: THEME.textDim });
    }
    /** The top-right box: the park's restore points, then the Playlist properties. */
    topRight(e, scene) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      const width = s.boxWidth;
      const x0 = ui.width - s.x - width + s.pad;
      const inner = width - 2 * s.pad;
      const top = s.y;
      let y = top + s.pad;
      const folded = this.boxFolded();
      const headH = 20;
      const head = this.place("boxHead", { x: x0, y, width: inner, height: headH }, folded ? "Unfold" : "Fold");
      scene.set("boxHead", { type: "rect", ...head, fill: this.hit() === "boxHead" ? THEME.face : "#00000000", z: Z.face });
      const source = e.source();
      const sw = measure(overlay, source.text, s.boxHead).width;
      foldMark(scene, "box.mark", !folded, x0 - 2, y + headH / 2, overlay);
      const title = `RESTORE POINTS \xB7 ${(e.parkNames[e.parkIndex] ?? "").toUpperCase()}`;
      label(scene, "box.title", fit(overlay, title, s.boxHead, inner - sw - 30), { ...head, x: head.x + 18 }, s.boxHead, overlay);
      scene.set("box.title", { ...scene.get("box.title"), colour: THEME.textDim });
      label(scene, "box.source", source.text, { x: x0 + inner - sw, y, width: 0, height: headH }, s.boxHead, overlay);
      scene.set("box.source", { ...scene.get("box.source"), colour: source.warning ? THEME.warning : THEME.textGood });
      y += headH + 2;
      if (folded) {
        this.pointsRect = void 0;
        const frame2 = { x: x0 - s.pad, y: top, width, height: y - top + s.pad - 2 };
        this.frames.push(frame2);
        backing(scene, "box", frame2, THEME.editorBacking);
        this.boxBottom = frame2.y + frame2.height;
        return;
      }
      const points = e.restorePoints();
      if (this.picked && !points.some((p) => p.id === this.picked)) {
        this.picked = void 0;
      }
      const listH = Math.round(s.boxRow * s.boxRows);
      const bar2 = points.length > s.boxRows ? s.scrollBar + 2 : 0;
      this.pointsRect = { x: x0, y, width: inner, height: listH };
      this.points.layout({ x: x0 + inner - s.scrollBar, y, width: s.scrollBar, height: listH }, points.length, s.boxRows);
      scene.set("points", { type: "rect", ...this.pointsRect, fill: THEME.editorList, z: Z.face });
      const hover = this.hovered;
      const first = Math.floor(this.points.first);
      for (let i = 0; first + i < points.length && i * s.boxRow < listH; i++) {
        const p = points[first + i];
        const h = Math.min(s.boxRow, listH - i * s.boxRow);
        const box = this.place(`point.${first + i}`, { x: x0, y: y + i * s.boxRow, width: inner - bar2, height: h });
        const fill = p.id === this.picked ? THEME.faceOn : hover === `point.${first + i}` ? THEME.faceHover : i % 2 ? void 0 : THEME.face;
        scene.set(`point.${i}`, { type: "rect", ...box, fill: fill ?? "#00000000", z: Z.face });
        if (h === s.boxRow) {
          this.pointRow(scene, i, p, box);
        }
      }
      this.points.draw(scene, "points");
      if (this.points.track) {
        this.place("points.track", this.points.track);
        this.place("points.thumb", this.points.thumb);
      }
      y += listH + 4;
      const halfW = Math.floor((inner - 4) / 2);
      const btn = (id, icon, text, bx, w, tip, disabled) => {
        const r = this.place(id, { x: bx, y, width: w, height: s.boxButton }, tip, disabled);
        button(scene, id, r, this.state(id), { icon, iconSize: s.toolIcon, text, textSize: 14, left: true }, overlay);
      };
      const editable = e.playback.canEdit && !e.playback.isLoading;
      btn("checkpoint", "checkpoint", "Save checkpoint", x0, halfW, "Save views and camera (last 10 kept)", !editable);
      btn(
        "restore",
        "restore",
        "Restore selected",
        x0 + inner - halfW,
        halfW,
        this.picked ? "Restore highlighted point" : "Highlight a point first",
        !editable || !this.picked
      );
      y += s.boxButton + 4;
      btn("copy", "copy", "Copy views", x0, halfW, "Copy views (coming later)", true);
      btn("paste", "paste", "Paste views", x0 + inner - halfW, halfW, "Paste views (coming later)", true);
      y += s.boxButton + 10;
      const ph = this.place("propsHead", { x: x0, y, width: inner, height: s.propHeader }, this.propsOpen ? "Fold" : "Unfold");
      scene.set("propsHead", { type: "rect", ...ph, fill: this.hit() === "propsHead" ? THEME.faceHover : "#00000000", z: Z.face });
      bevel(scene, "propsHead", ph, THEME.backingLight, THEME.backingDark, THEME.bevel, Z.bevel);
      foldMark(scene, "props.mark", this.propsOpen, x0 + 4, y + s.propHeader / 2, overlay);
      label(scene, "props.title", "Playlist", { x: x0 + 24, y, width: 0, height: s.propHeader }, 16, overlay, true);
      const tw = measure(overlay, "Playlist", 16, true).width;
      label(scene, "props.sub", "properties", { x: x0 + 24 + tw + 8, y: y + 1, width: 0, height: s.propHeader }, 13, overlay);
      scene.set("props.sub", { ...scene.get("props.sub"), colour: THEME.textDim });
      const subW = measure(overlay, "properties", 13).width;
      const seq = fit(overlay, e.playback.sequenceName, 13, inner - 24 - tw - 8 - subW - 24);
      const qw = measure(overlay, seq, 13).width;
      label(scene, "props.name", seq, { x: x0 + inner - 8 - qw, y, width: 0, height: s.propHeader }, 13, overlay);
      y += s.propHeader + 4;
      if (this.propsOpen) {
        y = this.properties(e, scene, x0, y, inner);
      }
      const frame = { x: x0 - s.pad, y: top, width, height: y - top + s.pad - 6 };
      this.frames.push(frame);
      backing(scene, "box", frame, THEME.editorBacking);
      this.boxBottom = frame.y + frame.height;
    }
    /** The build pane's state, to redraw it when it changes. */
    buildSignature(e) {
      const line = builder.line;
      return [
        line.phase,
        line.text,
        builder.running ? Math.floor(builder.elapsed / 1e3) : "",
        builder.parks.map((p) => p.state + (p.warnings ?? 0)).join(","),
        builder.messages.length,
        builder.pendingEdits(e.playback.installedAt)
      ].join("|");
    }
    /** The build pane shows only its header: by hand, else when it would run into the top-right box. */
    buildFolded() {
      if (this.buildOpen !== void 0) {
        return !this.buildOpen;
      }
      return ui.height - EDITOR.buildBottom - this.buildHeight(false) < this.boxBottom + EDITOR.gap * 2;
    }
    buildHeight(folded) {
      const s = EDITOR;
      const head = s.propHeader;
      if (folded) {
        return s.pad + head + s.pad;
      }
      return s.pad + head + 6 + 18 + 4 + s.square + 8 + s.buildButton + 10 + s.labelHeight + 3 + Math.round(s.boxRow * s.boxRows) + 8 + s.boxButton + s.pad;
    }
    /** The bottom-right pane: building the playlist from the game (builder.ts; patched engine). */
    buildPane(e, scene) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      const width = s.boxWidth;
      const folded = this.buildFolded();
      const height = this.buildHeight(folded);
      const frame = { x: ui.width - s.x - width, y: ui.height - s.buildBottom - height, width, height };
      const x0 = frame.x + s.pad;
      const inner = width - 2 * s.pad;
      let y = frame.y + s.pad;
      const line = builder.line;
      this.buildShown = this.buildSignature(e);
      this.frames.push(frame);
      backing(scene, "build.frame", frame, THEME.editorBacking);
      const head = this.place("buildHead", { x: x0, y, width: inner, height: s.propHeader }, folded ? "Unfold" : "Fold");
      scene.set("buildHead", { type: "rect", ...head, fill: this.hit() === "buildHead" ? THEME.faceHover : "#00000000", z: Z.face });
      bevel(scene, "buildHead", head, THEME.backingLight, THEME.backingDark, THEME.bevel, Z.bevel);
      foldMark(scene, "build.mark", !folded, x0 + 4, y + s.propHeader / 2, overlay);
      label(scene, "build.title", "Build", { x: x0 + 24, y, width: 0, height: s.propHeader }, 16, overlay, true);
      const tw = measure(overlay, "Build", 16, true).width;
      label(scene, "build.sub", "saves live edits to the playlist", { x: x0 + 24 + tw + 8, y: y + 1, width: 0, height: s.propHeader }, 13, overlay);
      scene.set("build.sub", { ...scene.get("build.sub"), colour: THEME.textDim });
      const count = builder.count;
      const [stateText, stateColour] = line.phase === "unavailable" ? ["needs the patched engine", THEME.textDim] : line.phase === "running" ? [count ? `building ${count.park}/${count.parks}` : "building", THEME.textGood] : line.phase === "failed" ? ["failed", THEME.warning] : builder.pendingEdits(e.playback.installedAt) ? ["edits not built", THEME.pending] : ["built \xB7 playing", THEME.textGood];
      const stw = measure(overlay, stateText, 13).width;
      label(scene, "build.state", stateText, { x: x0 + inner - 8 - stw, y, width: 0, height: s.propHeader }, 13, overlay);
      scene.set("build.state", { ...scene.get("build.state"), colour: stateColour });
      y += s.propHeader + 6;
      if (folded) {
        this.messagesRect = void 0;
        return;
      }
      const running = line.phase === "running";
      const time = running ? clock(builder.elapsed) : "";
      const timeW = time ? measure(overlay, time, 13).width : 0;
      label(scene, "build.line", fit(overlay, line.text, 13, inner - timeW - 12), { x: x0, y, width: 0, height: 18 }, 13, overlay);
      scene.set("build.line", { ...scene.get("build.line"), colour: line.warning ? THEME.warning : line.phase === "done" ? THEME.textGood : THEME.text });
      if (time) {
        label(scene, "build.time", time, { x: x0 + inner - timeW, y, width: 0, height: 18 }, 13, overlay);
        scene.set("build.time", { ...scene.get("build.time"), colour: THEME.textDim });
      }
      y += 18 + 4;
      this.squares(scene, builder.parks, x0, y, inner);
      y += s.square + 8;
      const unavailable = line.phase === "unavailable";
      const nothing = !running && !unavailable && !builder.pendingEdits(e.playback.installedAt);
      const build = this.place(
        "build",
        { x: x0, y, width: inner, height: s.buildButton },
        unavailable ? line.text : running ? "Stop the build; the playlist plays on as it was (Ctrl+B)" : nothing ? "Nothing to build: the playlist files hold every edit" : "Save your live edits to the playlist and build it in the background, then play it (Ctrl+B)",
        unavailable || nothing
      );
      const st = this.state("build");
      button(
        scene,
        "build",
        build,
        { ...st, face: running || unavailable || nothing || st.hover || st.down ? void 0 : THEME.buildFace },
        { icon: running ? "close" : "build", iconSize: s.toolIcon, text: running ? "Cancel build" : "Build and play", textSize: 16, hint: "Ctrl+B" },
        overlay
      );
      y += s.buildButton + 10;
      this.sectionLabel(scene, "build.msgs", "MESSAGES", x0, y);
      y += s.labelHeight + 3;
      const shown = builder.messages;
      const messages = shown.length ? shown : [{ level: "info", text: line.text, park: void 0 }];
      const listH = Math.round(s.boxRow * s.boxRows);
      const bar2 = messages.length > s.boxRows ? s.scrollBar + 2 : 0;
      this.messagesRect = { x: x0, y, width: inner, height: listH };
      this.messages.layout({ x: x0 + inner - s.scrollBar, y, width: s.scrollBar, height: listH }, messages.length, s.boxRows);
      scene.set("build.list", { type: "rect", ...this.messagesRect, fill: THEME.editorList, z: Z.face });
      const first = Math.floor(this.messages.first);
      const marks = { info: ["info", THEME.buildInfo], ok: ["check", THEME.buildDone], warn: ["alert", THEME.buildWarn], error: ["alert", THEME.buildFail] };
      for (let i = 0; first + i < messages.length && i * s.boxRow < listH; i++) {
        const m = messages[first + i];
        const h = Math.min(s.boxRow, listH - i * s.boxRow);
        const id = `msg.${first + i}`;
        const opens = m.park !== void 0 && shown.length > 0 && e.playback.parkIndexOf(m.park) >= 0;
        const row = this.place(
          id,
          { x: x0, y: y + i * s.boxRow, width: inner - bar2, height: h },
          opens ? `${m.text} (click: open the park)` : m.text
        );
        const fill = opens && this.hovered === id ? THEME.faceHover : i % 2 ? void 0 : THEME.face;
        scene.set(`msgr.${i}`, { type: "rect", ...row, fill: fill ?? "#00000000", z: Z.face });
        if (h < s.boxRow) {
          continue;
        }
        const [icon, colour] = marks[m.level] ?? marks.info;
        const px = iconPixels(20, overlay.scale);
        const side = px / overlay.scale;
        const mark = { x: row.x + 6, y: row.y + (s.boxRow - side) / 2, width: side, height: side };
        scene.set(`msgm.${i}`, { type: "rect", ...mark, fill: colour, z: Z.face + 1 });
        scene.set(`msgi.${i}`, { type: "image", src: iconPath(icon, px), x: mark.x, y: mark.y, z: Z.icon });
        label(scene, `msgt.${i}`, fit(overlay, m.text, s.textSize - 1, row.width - 40), { x: row.x + 32, y: row.y, width: 0, height: s.boxRow }, s.textSize - 1, overlay);
      }
      this.messages.draw(scene, "messages");
      if (this.messages.track) {
        this.place("messages.track", this.messages.track);
        this.place("messages.thumb", this.messages.thumb);
      }
      y += listH + 8;
      const halfW = Math.floor((inner - 4) / 2);
      for (const [id, icon, text, bx] of [["import", "import", "Import playlist", x0], ["export", "export", "Export playlist", x0 + inner - halfW]]) {
        const r = this.place(id, { x: bx, y, width: halfW, height: s.boxButton }, `${text} (coming later)`, true);
        button(scene, id, r, this.state(id), { icon, iconSize: s.toolIcon, text, textSize: 14, left: true }, overlay);
      }
    }
    /** A square per park of the build, in play order: built (a check), with warnings (!), failed or
     *  missing (red), the one being built (lit), still to come (empty); a bar past squaresMax parks. */
    squares(scene, parks, x0, y, inner) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      if (!parks.length) {
        return;
      }
      const colourOf = (p) => p.state === "failed" || p.state === "missing" ? THEME.buildFail : p.state === "building" ? THEME.buildCurrent : p.state === "built" || p.state === "cached" ? p.warnings ? THEME.buildWarn : THEME.buildDone : THEME.editorList;
      if (parks.length > s.squaresMax) {
        const done = parks.filter((p) => p.state !== "pending" && p.state !== "building").length;
        const bad = parks.some((p) => p.state === "failed" || p.state === "missing");
        const track = { x: x0, y, width: inner, height: s.square };
        scene.set("sq.track", { type: "rect", ...track, fill: THEME.editorList, z: Z.face });
        bevel(scene, "sq.track", track, THEME.bevelDark, THEME.bevelLight, THEME.bevel, Z.bevel);
        scene.set("sq.fill", { type: "rect", x: x0, y, width: Math.round(inner * done / parks.length), height: s.square, fill: bad ? THEME.buildFail : THEME.buildDone, z: Z.face + 1 });
        const text = `${done} / ${parks.length} parks`;
        label(scene, "sq.count", text, { x: x0 + inner / 2, y, width: 0, height: s.square }, 12, overlay, true);
        scene.set("sq.count", { ...scene.get("sq.count"), align: "center" });
        return;
      }
      const gap = 2;
      const w = (inner - gap * (parks.length - 1)) / parks.length;
      const px = iconPixels(20, overlay.scale);
      const side = px / overlay.scale;
      parks.forEach((p, i) => {
        const r = { x: Math.round(x0 + i * (w + gap)), y, width: Math.max(1, Math.round(w)), height: s.square };
        const what = p.state === "missing" ? "file missing" : p.state === "failed" ? "failed" : p.state === "building" ? "building" : p.state === "pending" ? "waiting" : `${p.state === "cached" ? "unchanged" : "built"}${p.warnings ? `, ${p.warnings} warning${p.warnings > 1 ? "s" : ""}` : ""}`;
        const name = p.key && builder.nameOf?.(p.key) || p.name || `Park ${i + 1}`;
        this.place(`sq.${i}`, r, `${name}: ${p.previous ? "waiting (as in the last build)" : what}`);
        scene.set(`sq.${i}`, { type: "rect", ...r, fill: colourOf(p), z: Z.face, ...p.previous ? { opacity: 0.35 } : {} });
        bevel(scene, `sq.${i}`, r, THEME.bevelDark, THEME.bevelDark, THEME.bevel, Z.bevel);
        const icon = p.state === "failed" || p.state === "missing" ? "close" : p.state === "built" || p.state === "cached" ? p.warnings ? "alert" : "check" : void 0;
        if (icon && r.width >= side && !p.previous) {
          scene.set(`sqi.${i}`, { type: "image", src: iconPath(icon, px), x: r.x + (r.width - side) / 2, y: r.y + (r.height - side) / 2, z: Z.icon });
        }
      });
    }
    pointRow(scene, i, p, box) {
      const overlay = this.mode.overlay;
      const size = EDITOR.textSize;
      label(scene, `pt.${i}`, p.label, { x: box.x + 8, y: box.y, width: 0, height: box.height }, size, overlay);
      if (p.tag) {
        const tx = box.x + 8 + measure(overlay, p.label, size).width + 8;
        const tm = measure(overlay, p.tag, 10);
        const chip = { x: tx, y: Math.round(box.y + (box.height - tm.height - 4) / 2), width: Math.ceil(tm.width) + 8, height: Math.ceil(tm.height) + 4 };
        scene.set(`ptag.${i}`, { type: "rect", ...chip, fill: "#00000000", border: THEME.textDim, borderWidth: 1, z: Z.icon });
        scene.set(`ptagt.${i}`, { type: "text", text: p.tag, size: 10, colour: THEME.textDim, x: chip.x + 4, y: chip.y + 2, z: Z.icon });
      }
      const when = p.time !== void 0 ? formatTime(p.time, Date.now()) : "-";
      const ww = measure(overlay, when, size).width;
      label(scene, `ptime.${i}`, when, { x: box.x + box.width - 8 - ww, y: box.y, width: 0, height: box.height }, size, overlay);
      scene.set(`ptime.${i}`, { ...scene.get(`ptime.${i}`), colour: THEME.textDim });
    }
    /** Motion, timing and presentation; returns the y below them. */
    properties(e, scene, x0, y, inner) {
      const s = EDITOR;
      const overlay = this.mode.overlay;
      const props = e.playback.playlistProps;
      const section = (name) => {
        this.sectionLabel(scene, `sec.${name}`, name, x0, y);
        y += s.labelHeight + 3;
      };
      const rowLabel = (key, text) => label(scene, `prop.${key}`, text, { x: x0, y, width: 0, height: s.propRow }, s.textSize, overlay);
      const segments = (key, text) => {
        rowLabel(key, text);
        const choices = CHOICES[key];
        const widths = choices.map(([t]) => Math.ceil(measure(overlay, t, 13, true).width) + 2 * s.segPad);
        let sx = x0 + inner - widths.reduce((a, w) => a + w, 0) - s.gap * (choices.length - 1);
        const sy = y + Math.round((s.propRow - s.segHeight) / 2);
        choices.forEach(([t, value, tip], i) => {
          const id = `seg.${key}.${i}`;
          const r = this.place(id, { x: sx, y: sy, width: widths[i], height: s.segHeight }, tip);
          button(scene, id, r, this.state(id, props[key] === value), { text: t, textSize: 13 }, overlay);
          sx += widths[i] + s.gap;
        });
        y += s.propRow;
      };
      const stepper = (key, text, tip) => {
        rowLabel(key, text);
        const w = s.stepButton;
        const sy = y + Math.round((s.propRow - w) / 2);
        const right = x0 + inner;
        const more = this.place(`step.${key}.more`, { x: right - w, y: sy, width: w, height: w }, tip);
        const value = { x: more.x - s.gap - s.stepValueBox, y: sy, width: s.stepValueBox, height: w };
        const less = this.place(`step.${key}.less`, { x: value.x - s.gap - w, y: sy, width: w, height: w }, tip);
        button(scene, `step.${key}.less`, less, this.state(`step.${key}.less`), { icon: "less", iconSize: 16 }, overlay);
        button(scene, `step.${key}.more`, more, this.state(`step.${key}.more`), { icon: "add", iconSize: 16 }, overlay);
        scene.set(`stepv.${key}`, { type: "rect", ...value, fill: THEME.editorList, z: Z.face });
        const vid = `stept.${key}`;
        label(scene, vid, `${props[key].toFixed(1)} s`, { x: value.x + value.width / 2, y: sy, width: 0, height: w }, 13, overlay);
        scene.set(vid, { ...scene.get(vid), align: "center" });
        y += s.propRow;
      };
      section("MOTION");
      segments("inertia", "Inertia");
      segments("panChanges", "Angle and zoom change");
      section("TIMING");
      if (props.panChanges !== "off") {
        stepper("changeHold", "Change hold", "Pause after a turn or zoom");
        stepper("arriveHold", "Arrival hold", "Pause before a turn or zoom");
      }
      stepper("returnHold", "Return hold", "Pause at first view before next park");
      section("PRESENTATION");
      segments("titleMusic", "Title music");
      segments("titles", "Show titles");
      return y + 6;
    }
  };
  function foldMark(scene, id, open, x, cy, overlay) {
    const px = iconPixels(20, overlay.scale);
    const side = px / overlay.scale;
    scene.set(id, { type: "image", src: iconPath(open ? "fold-open" : "fold-closed", px), x: Math.round(x), y: Math.round(cy - side / 2), z: Z.icon });
  }
  function grip(scene, id, x, cy, z = Z.icon) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        scene.set(`${id}.${r}${c}`, { type: "rect", x: x + c * 4, y: Math.round(cy - 5 + r * 4), width: 2, height: 2, fill: THEME.textDim, z });
      }
    }
  }
  function fit(overlay, text, size, width, bold = false) {
    if (width <= 0 || measure(overlay, text, size, bold).width <= width) {
      return text;
    }
    let t = text;
    while (t.length > 1 && measure(overlay, t + "\u2026", size, bold).width > width) {
      t = t.slice(0, -1);
    }
    return t.trimEnd() + "\u2026";
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function formatTime(ms, now) {
    const d = new Date(ms);
    const n = new Date(now);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return today ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hm}`;
  }
  function columnStarts(width, rows, overlay, headers) {
    const size = EDITOR.textSize;
    const natural = headers.map((h, c) => Math.max(
      measure(overlay, h, size, true).width,
      ...rows.map((r) => measure(overlay, headers === EDITOR_COLUMNS && c === 6 ? "event (locked)" : r[c] ?? "", size).width)
    ) + EDITOR.cellMargin);
    const total = natural.reduce((a, b) => a + b, 0);
    const widths = total <= width ? natural.map((w) => w + (width - total) / natural.length) : natural.map((w) => w * width / total);
    const starts = [0];
    for (const w of widths.slice(0, -1)) {
      starts.push(starts[starts.length - 1] + Math.round(w));
    }
    return starts;
  }

  // src/main.ts
  var UPDATE_INTERVAL_MS = 100;
  var DEBUG_INTERVAL_MS = 1e3;
  var CAMERA_INTERVAL_MS = 1;
  var player;
  var editor;
  var bar;
  var captions;
  var editorPanel;
  var onTitleScreen = false;
  var lastDebug = 0;
  var mode = screensaverApi();
  var modeStarted = false;
  var lastInputMark = 0;
  var profilerTimer;
  var PROFILER_EXPORT_MS = 6e4;
  function log3(message2) {
    console.log(`[RCT Screensaver] ${message2}`);
  }
  function startPlayer() {
    const settings = loadSettings();
    const playlist = loadPlaylist();
    if (!playlist) {
      log3("no playlist installed; run tools/mksequence.py --install");
      return;
    }
    if (playlist.titles && TITLES.includes(playlist.titles)) {
      settings.titlesOverride = playlist.titles;
    }
    const sequence = resolveSequence(playlist);
    if (typeof sequence === "string") {
      log3(sequence);
      return;
    }
    player = new Player(playlist, sequence, settings, mode?.active ? mode.overlay : void 0);
    startProfiler(settings.profilerExport);
    const inMode = mode?.active && mode.overlay;
    editorPanel = inMode ? new EditorPanel(mode) : void 0;
    editor = new Editor(player, editorPanel);
    player.start();
    if (inMode) {
      bar = new ControlsBar(mode, () => player, settings, {
        toggleEditor: () => toggleEditor(),
        editorOpen: () => editor?.isOpen ?? false,
        editorPinned: () => editor?.pinned ?? true
      });
      bar.open();
      captions = new Captions(mode, () => player, settings, () => editor?.isOpen ?? false, () => bar?.shown ?? false);
    }
  }
  function stopPlayer(release = false) {
    bar?.close();
    bar = void 0;
    captions?.close();
    captions = void 0;
    editor?.close();
    editor = void 0;
    editorPanel = void 0;
    if (release) {
      player?.release();
    } else {
      player?.stop();
    }
    player = void 0;
  }
  function takeBuild(result) {
    const api = buildApi();
    if (!api || !player?.isRunning || !result.playlist) {
      return "the screensaver is not playing";
    }
    if (result.playlist.sequence !== player.sequenceName) {
      return `another playlist is playing ("${player.sequenceName}")`;
    }
    try {
      api.applyBuild(result.sequence);
    } catch (e) {
      return message(e);
    }
    const old = loadPlaylist();
    const playlist = { ...result.playlist, installed: Date.now(), source: result.playlist.source ?? old?.source };
    const check = resolveSequence(playlist);
    if (typeof check === "string") {
      return check;
    }
    savePlaylist(playlist);
    if (result.titleMusic) {
      const settings = player.liveSettings;
      settings.titleMusic = result.titleMusic;
      saveSettings(settings);
      player.noteInstalledMusic(result.titleMusic);
    }
    player.swapPlaylist(playlist);
    return void 0;
  }
  builder.onReady = takeBuild;
  builder.nameOf = (key) => {
    const park = player?.isRunning ? loadPlaylist()?.parks.find((p) => (p.key ?? p.fileName) === key) : void 0;
    return park?.name;
  };
  builder.orderOf = () => player?.isRunning ? player.playOrderKeys : [];
  function update() {
    builder.update();
    if (context.mode !== "title") {
      if (onTitleScreen) {
        onTitleScreen = false;
        stopPlayer();
      }
      return;
    }
    if (!onTitleScreen) {
      onTitleScreen = true;
      if (!mode && loadSettings().autostart) {
        startPlayer();
      }
    }
    if (mode?.active && !modeStarted) {
      modeStarted = true;
      startPlayer();
    }
    if (!player?.isRunning) {
      return;
    }
    player.update();
    bar?.update();
    captions?.update();
    editorPanel?.update();
    if (player.debug && Date.now() - lastDebug >= DEBUG_INTERVAL_MS) {
      lastDebug = Date.now();
      log3(player.describe());
    }
  }
  function onTitle(action) {
    return () => {
      if (context.mode === "title" && player?.isRunning && (!mode || mode.active)) {
        action(player);
      }
    };
  }
  function either(play, edit) {
    return (p) => {
      if (editor?.isOpen) {
        edit?.(editor);
      } else {
        play(p);
      }
    };
  }
  function toggleEditor() {
    if (editor?.isOpen) {
      editor.close();
    } else {
      editor?.open();
    }
  }
  function toggleBuild(p) {
    if (editor?.isOpen && editorPanel?.isOpen) {
      editorPanel.toggleBuild();
    } else if (builder.running) {
      builder.cancel();
    } else if (builder.available && builder.pendingEdits(p.installedAt)) {
      builder.start(p.sequenceName);
    }
  }
  function registerShortcuts() {
    const shortcuts = [
      ["next", "Next view", ["RIGHT"], either((p) => p.next(), (e) => e.pan(1, 0))],
      ["previous", "Previous view", ["LEFT"], either((p) => p.previous(), (e) => e.pan(-1, 0))],
      ["nextpark", "Next park", ["SHIFT+RIGHT"], either((p) => p.nextPark(), (e) => e.pan(1, 0, true))],
      ["previouspark", "Previous park", ["SHIFT+LEFT"], either((p) => p.previousPark(), (e) => e.pan(-1, 0, true))],
      ["faster", "Speed up", ["UP"], either((p) => p.changeSpeed(1), (e) => e.pan(0, -1))],
      ["slower", "Slow down", ["DOWN"], either((p) => p.changeSpeed(-1), (e) => e.pan(0, 1))],
      ["panupfast", "Pan up fast (view editor)", ["SHIFT+UP"], either(() => {
      }, (e) => e.pan(0, -1, true))],
      ["pandownfast", "Pan down fast (view editor)", ["SHIFT+DOWN"], either(() => {
      }, (e) => e.pan(0, 1, true))],
      // In the editor, Space starts and stops Play (playback is paused there otherwise).
      ["hold", "Hold / release view", ["SPACE"], either((p) => p.toggleHold(), (e) => e.togglePreview())],
      ["shuffle", "Shuffle on / off", ["S"], (p) => p.toggleShuffle()],
      ["edit", "Open / close view editor", ["E"], () => toggleEditor()],
      ["undo", "Undo (view editor)", ["CTRL+Z"], either(() => {
      }, (e) => e.undo())],
      ["map", "Map of the views on / off (view editor)", ["M"], either(() => {
      }, (e) => e.toggleMap())],
      ["redo", "Redo (view editor)", ["CTRL+Y", "CTRL+SHIFT+Z"], either(() => {
      }, (e) => e.redo())],
      // The view editor's tools (owner, 2026-11-10; the toolbox's tooltips name them).
      ["addview", "Add a view (view editor)", ["INSERT"], either(() => {
      }, (e) => e.add())],
      ["setview", "Set the view to the camera (view editor)", ["C"], either(() => {
      }, (e) => {
        if (e.mapMode || !editorPanel) e.update();
      })],
      ["deleteview", "Delete the view (view editor)", ["DELETE"], either(() => {
      }, (e) => e.remove())],
      ["viewup", "Move the view up (view editor)", ["CTRL+UP"], either(() => {
      }, (e) => {
        if (e.movable(e.selectedIndex)) e.moveOnRoute(-1);
      })],
      ["viewdown", "Move the view down (view editor)", ["CTRL+DOWN"], either(() => {
      }, (e) => {
        if (e.movable(e.selectedIndex)) e.moveOnRoute(1);
      })],
      ["rotateright", "Rotate right (view editor)", ["RETURN"], either(() => {
      }, (e) => e.rotate(1))],
      ["rotateleft", "Rotate left (view editor)", ["SHIFT+RETURN"], either(() => {
      }, (e) => e.rotate(-1))],
      ["zoomin", "Zoom in (view editor)", ["PAGEUP"], either(() => {
      }, (e) => e.zoom(-1))],
      ["zoomout", "Zoom out (view editor)", ["PAGEDOWN"], either(() => {
      }, (e) => e.zoom(1))],
      ["eventlock", "Lock / unlock event views on the map (view editor)", ["L"], either(() => {
      }, (e) => {
        if (e.mapMode) e.toggleEventLock();
      })],
      ["play", "Play / stop the park's views (view editor)", ["P"], either(() => {
      }, (e) => e.togglePreview())],
      ["holdless", "Shorter hold (view editor)", ["["], either(() => {
      }, (e) => e.changeHold(-1))],
      ["holdmore", "Longer hold (view editor)", ["]"], either(() => {
      }, (e) => e.changeHold(1))],
      ["panless", "Less of the hold panning (view editor)", ["SHIFT+["], either(() => {
      }, (e) => e.changePan(-0.1))],
      ["panmore", "More of the hold panning (view editor)", ["SHIFT+]"], either(() => {
      }, (e) => e.changePan(0.1))],
      // The build pane's button (patched engine), also with the editor closed (owner, 2026-11-11).
      ["build", "Build and play / cancel the build", ["CTRL+B"], (p) => toggleBuild(p)]
    ];
    for (const [id, text, bindings, action] of shortcuts) {
      ui.registerShortcut({
        id: `rctscreensaver.${id}`,
        text: `[RCT Screensaver] ${text}`,
        bindings,
        callback: onTitle(action)
      });
    }
  }
  function registerToolboxItems() {
    ui.registerToolboxMenuItem("RCT Screensaver: restart playlist", () => {
      stopPlayer();
      startPlayer();
    });
    ui.registerToolboxMenuItem("RCT Screensaver: edit views", onTitle(() => editor?.open()));
    ui.registerToolboxMenuItem("RCT Screensaver: toggle debug log", () => {
      const settings = loadSettings();
      settings.debug = !settings.debug;
      saveSettings(settings);
      player?.setDebug(settings.debug);
      log3(`debug log ${settings.debug ? "on" : "off"}`);
    });
  }
  function startProfiler(path) {
    if (!path || profilerTimer !== void 0) {
      return;
    }
    console.executeLegacy("profiler_start");
    log3(`profiler on, exporting to ${path}`);
    profilerTimer = context.setInterval(() => console.executeLegacy(`profiler_export "${path}"`), PROFILER_EXPORT_MS);
  }
  function main() {
    if (typeof ui === "undefined") {
      return;
    }
    registerShortcuts();
    if (mode) {
      mode.configure(modeSettings(loadSettings()));
      if (perfLogging()) {
        log3("the engine writes a perf log");
        perfMark("plugin started");
      }
      mode.onChange((active) => {
        log3(`screensaver mode ${active ? "on" : "off"}`);
        if (!active) {
          modeStarted = false;
          stopPlayer(true);
        }
      });
      mode.onMouse((e) => {
        if (loadSettings().bench) {
          if (Date.now() - lastInputMark >= 1e3) {
            lastInputMark = Date.now();
            perfMark(`input ${e.type}`);
          }
          return;
        }
        const onPark = editorPanel?.isOpen === true && (editorPanel.dragging || !bar?.covers(e.x, e.y) && !bar?.panelOpen);
        if (editorPanel?.onMouse(e) || onPark && editorPanel.onPark(e)) {
          bar?.mouseSeen();
        } else {
          bar?.onMouse(e);
        }
      });
    } else {
      registerToolboxItems();
    }
    context.registerAction("rctscreensaver-showdone", () => ({}), (e) => {
      player?.showDone(e.args.show);
      return {};
    });
    context.registerAction("rctscreensaver-showstep", () => ({}), (e) => {
      player?.showStep(e.args.show, e.args.step);
      return {};
    });
    context.setInterval(update, UPDATE_INTERVAL_MS);
    context.subscribe("interval.tick", () => {
      if (context.mode === "title" && player?.isRunning) {
        player.tick();
      }
    });
    context.setInterval(() => {
      if (context.mode === "title" && player?.isRunning) {
        player.stepCamera();
      }
    }, CAMERA_INTERVAL_MS);
  }
  registerPlugin({
    name: "RCT Screensaver",
    version: "0.1.0",
    authors: ["RCT Screensaver contributors"],
    type: "intransient",
    licence: "UNLICENSED",
    targetApiVersion: 124,
    main
  });
})();
