"use strict";
(() => {
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
  var EDITOR_COLUMNS = ["#", "Tile", "Angle", "Zoom", "Hold", "Pan", "Set by"];
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
    // a drag on the park
    constructor(player2, view = new WindowView()) {
      this.player = player2;
      this.view = view;
      this.shown = false;
      this.camera = { x: 0, y: 0, z: 0, rotation: 0, zoom: 0 };
      this.selected = -1;
      this.undoStacks = /* @__PURE__ */ new Map();
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
      this.view.open(this);
      this.refresh();
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
      this.gesture = { commit: !this.player.isPreviewing && this.selectedIndex >= 0, moved: false };
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
      const commit = !this.player.isPreviewing && this.selectedIndex >= 0;
      this.zoom(delta > 0 ? -1 : 1);
      if (commit) {
        this.update();
      }
    }
    /** Sets the camera's height to what is under the screen's centre, without moving the picture,
     * and the selected view's with it. */
    fit() {
      this.stopPreview();
      const c = this.camera;
      const p = toScreen(c.x, c.y, c.z, c.rotation);
      const z = surfaceZ(p, c.rotation);
      if (z === void 0) {
        return;
      }
      const world = toWorld(p, z, c.rotation);
      this.camera = { ...c, x: world.x, y: world.y, z };
      this.applyCamera();
      if (this.selectedIndex >= 0) {
        this.update();
      }
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
      return { views: this.views(), selected: this.selected, edited: this.player.isEdited };
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
      this.player.onViewShown = void 0;
      this.player.setEditing(false);
    }
    select(index) {
      this.selected = index;
      this.player.showViewAt(index);
      this.replay();
    }
    /** The views to change: the park's current views, copied (generated ones are fitted).
     * Empty while a park is loading, so nothing is changed until its views are on screen. */
    views() {
      return this.player.isLoading ? [] : this.player.currentViews.map((v) => ({ ...v }));
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
      this.change(() => {
        const views = this.views();
        const at = this.selected >= 0 ? this.selected + 1 : views.length;
        views.splice(at, 0, this.cameraView(views[this.selected]?.hold ?? DEFAULT_HOLD));
        this.save(views, at);
      });
    }
    update() {
      this.change(() => {
        const views = this.views();
        if (!views[this.selected]) {
          return;
        }
        views[this.selected] = { ...views[this.selected], ...this.cameraView(views[this.selected].hold) };
        delete views[this.selected].overview;
        this.save(views, this.selected);
      });
    }
    remove() {
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
    applyCamera() {
      const c = this.camera;
      const vp = ui.mainViewport;
      vp.rotation = c.rotation;
      vp.zoom = c.zoom;
      c.zoom = vp.zoom;
      vp.moveTo({ x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) });
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
    rows() {
      return this.player.currentViews.map((v, i) => [
        String(i + 1),
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
      return view ? `Hold view ${this.selected + 1}: ${view.hold} s` : "Hold: select a view";
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
    y: 16,
    width: 540,
    pad: 10,
    gap: 4,
    titleHeight: 30,
    titleSize: 17,
    rowHeight: 24,
    visibleRows: 10,
    buttonHeight: 28,
    textSize: 14,
    lineHeight: 20,
    sectionGap: 16,
    // between the hold and pan controls on their shared line
    cellMargin: 14,
    // added to each list column's widest text
    scrollBar: 24
    // the list's scroll bar, when it has more than visibleRows views
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

  // src/player.ts
  var MIN_SPEED = 1;
  var MAX_SPEED = 4;
  var UPDATE_SETTLE_MS = 150;
  var LOAD_TIMEOUT_MS = 3e3;
  var BACKGROUND_LOAD_TIMEOUT_MS = 6e4;
  var SHOW_TAIL_MS = 3e3;
  var SOUND_FADE_MS = 750;
  var PREVIEW_DELAY_MS = 1e3;
  var TICKS_PER_SECOND = 40;
  var CUE_WAIT_S = 20;
  var CUE_TAIL_TICKS = 80;
  var CAR_CHECK_TICKS = 4;
  var FOLLOW_EASE = 0.08;
  var DIVERT_MIN_MS = 1500;
  var MIN_DIVERT_MOVE_MS = 1e3;
  var CUT_STAY_S = 4;
  var LATE_MIN_TICKS = 160;
  var CHAIN_S = 4;
  function log(message) {
    console.log(`[RCT Screensaver] ${message}`);
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
      /** Which of a park's orders (its views, or one of `variants`) plays on the current visit:
       *  the first visit ever plays the cheapest order and each later visit the next
       *  (circuit_variants); the visit count persists in storage across runs. */
      this.visits = loadVisits();
      this.dip = !!overlay && settings.fadeMs > 0 && backgroundLoading(sequence) && canHoldSwitch(sequence);
      this.cover = new Cover(settings.fadeMs, this.dip ? overlay : void 0);
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
        log("playlist has no parks");
        return;
      }
      this.running = true;
      this.holding = false;
      this.settings.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, this.settings.speed));
      this.parkOrder = range2(this.playlist.parks.length);
      this.unplayed.clear();
      this.history = [];
      if (!this.sequence.isPlaying) {
        this.sequence.play();
      }
      log(`playing "${this.playlist.sequence}" (${this.playlist.parks.length} parks)`);
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
            this.panPeak = Math.max(this.panPeak, px * TICKS_PER_SECOND);
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
        log("title sequence stopped playing; restarting");
        this.sequence.play();
        this.enterPark(this.parkPos, false);
        return;
      }
      if (this.loadingPark) {
        const timeout = backgroundLoading(this.sequence) ? BACKGROUND_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS;
        if (!this.parkIsLoaded() && (Date.now() - this.seeked > timeout || this.loadSkipped())) {
          log(`"${this.currentPark().name}" did not load; skipping it`);
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
        this.unplayed = new Set(this.parkOrder.filter((i) => i !== this.parkPos));
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
      log(this.holding ? "holding view" : "released view");
    }
    toggleShuffle() {
      this.settings.shuffle = !this.settings.shuffle;
      saveSettings(this.settings);
      this.unplayed.clear();
      this.history = [];
      this.pickNext();
      log(`shuffle ${this.settings.shuffle ? "on" : "off"}`);
    }
    changeSpeed(delta) {
      const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, this.settings.speed + delta));
      if (speed !== this.settings.speed) {
        this.settings.speed = speed;
        saveSettings(this.settings);
      }
      this.applySpeed();
      log(`speed ${speed}`);
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
    /** Playlist index of the current park. */
    get parkIndex() {
      return this.parkOrder[this.parkPos];
    }
    get isLoading() {
      return this.loadingPark;
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
      this.views = views;
      this.viewOrder = range2(views.length);
      this.viewPos = Math.max(0, Math.min(views.length - 1, current));
      if (show >= 0) {
        this.showView(false, "edit");
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
      this.views = this.viewsFor(this.currentPark());
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
        log(`camera ${Date.now() - this.camEpoch} ${event} ${values}`);
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
      return (view.panChanges ?? this.settings.panChanges) === "start" ? "start" : "end";
    }
    inertiaOf(view) {
      return (view.inertia ?? this.settings.inertia) === true;
    }
    /** A pan hold in ms: the playlist's (settings UI, times its time scaling), else the plugin setting's. */
    holdMs(key, fallback) {
      return Math.max(0, (this.playlist[key] ?? this.settings[key] ?? fallback) * 1e3);
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
      return Math.max(0, (this.cueAt + cue.ticks + CUE_TAIL_TICKS - this.parkTicks) * 1e3 / TICKS_PER_SECOND);
    }
    /** Another timeline cut-in's lead begins within `ms` (and CHAIN_S): better to wait for it here. */
    cutDueWithin(ms) {
      const current = this.viewOrder[this.viewPos];
      return this.views.some((v, i) => {
        if (i === current || !v.cue?.cut || v.cue.tick === void 0 || this.cutsDone.has(i)) {
          return false;
        }
        const start = nextOccurrence(v.cue, this.parkTicks);
        const from = start - (v.cue.lead ?? 0) * TICKS_PER_SECOND;
        return from - this.parkTicks <= (ms / 1e3 + CHAIN_S) * TICKS_PER_SECOND;
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
        const from = start - ((cue.lead ?? 0) + earlyS) * TICKS_PER_SECOND;
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
      const leadMs = (fired.at - this.parkTicks) * 1e3 / TICKS_PER_SECOND;
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
      return left > 0 && elapsed < (view.hold + wait / 1e3 + (cue.ticks + CUE_TAIL_TICKS) / TICKS_PER_SECOND) * 2e3;
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
      return Math.max(left, (this.cueAt + cue.ticks + CUE_TAIL_TICKS - this.parkTicks) * 1e3 / TICKS_PER_SECOND);
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
          log(`could not set speed ${speed}: ${result.errorMessage ?? result.error}`);
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
      log(`show "${name}" finished`);
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
      log(`park ${pos + 1}/${this.parkOrder.length}: ${park.name}`);
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
        log(`failed to load "${park.name}": ${e}`);
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
            log(`show "${name}" not started: ${result.errorMessage ?? result.error}`);
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
    }
    get visible() {
      return this.shown;
    }
    render(scene) {
      const opacity = this.shown ? 1 : 0;
      for (const [id, element] of scene) {
        const full = { ...element, opacity };
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
        this.overlay.fade(this.prefix + id, on ? 1 : 0, ms);
        const element = JSON.parse(this.sent.get(id));
        this.sent.set(id, JSON.stringify({ ...element, opacity: on ? 1 : 0 }));
      }
    }
    clear() {
      for (const id of this.sent.keys()) {
        this.overlay.remove(this.prefix + id);
      }
      this.sent.clear();
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
    const sunk = state.down || state.on;
    const onFace = state.alt ? THEME.faceAlt : THEME.faceOn;
    const face = state.face && !state.down ? state.face : state.down ? THEME.faceDown : state.hover ? state.on && state.alt ? THEME.faceAltHover : THEME.faceHover : state.on ? onFace : THEME.face;
    scene.set(id, { type: "rect", x: r.x, y: r.y, width: r.width, height: r.height, fill: face, z: Z.face });
    bevel(scene, id, r, sunk ? THEME.bevelDark : THEME.bevelLight, sunk ? THEME.bevelLight : THEME.bevelDark, THEME.bevel, Z.bevel);
    const nudge = sunk ? 1 : 0;
    if (content.icon) {
      const size = content.iconSize ?? 16;
      const px = iconPixels(size, overlay.scale);
      const side = px / overlay.scale;
      scene.set(`${id}.icon`, {
        type: "image",
        src: iconPath(content.icon, px),
        z: Z.icon,
        x: r.x + (r.width - side) / 2 + nudge,
        y: r.y + (r.height - side) / 2 + nudge
      });
    } else if (content.text !== void 0) {
      const size = content.textSize ?? 12;
      const h = measure(overlay, content.text, size, true).height;
      scene.set(`${id}.text`, {
        type: "text",
        text: content.text,
        size,
        bold: true,
        colour: THEME.text,
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
  var ICON_PIXELS = [24, 30, 34, 36, 42, 48, 51, 60, 68, 72, 85, 96, 102, 136];
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
      if (this.editorHooks?.editorOpen()) {
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

  // src/ui/editor-panel.ts
  var PAN_SHARE_STEP2 = 0.1;
  var HELP = [
    "Drag the park: moves the selected view. Wheel: zooms it.",
    "Arrows pan the camera (Shift: faster). Ctrl+Z undoes. E closes."
  ];
  var EditorPanel = class {
    // a left drag on the park: where the mouse last was
    constructor(mode2) {
      this.mode = mode2;
      this.mouse = { x: -1, y: -1 };
      this.boxes = /* @__PURE__ */ new Map();
      this.texts = /* @__PURE__ */ new Map();
      this.frame = { x: 0, y: 0, width: 0, height: 0 };
      this.list = { x: 0, y: 0, width: 0, height: 0 };
      this.scroll = 0;
      // first row shown
      this.followed = -1;
      this.layer = new Layer(mode2.overlay, "rcts.ed.");
    }
    get isOpen() {
      return this.editor !== void 0;
    }
    open(editor2) {
      this.editor = editor2;
      this.scroll = 0;
      this.render();
      this.layer.show(true, TIMING.fadeIn);
      this.render();
    }
    close() {
      this.editor = void 0;
      this.downOn = void 0;
      this.drag = void 0;
      this.layer.clear();
    }
    refresh() {
      this.render();
    }
    /** Handles a mouse event over the panel (or a press that started on it); false lets it through. */
    onMouse(e) {
      if (!this.editor || this.drag) {
        return false;
      }
      if (e.type !== "wheel") {
        this.mouse = { x: e.x, y: e.y };
      }
      const inside = contains(this.frame, this.mouse.x, this.mouse.y);
      let used = inside || this.downOn !== void 0;
      if (e.type === "down" && e.button === 0 && inside) {
        this.downOn = this.hit();
      } else if (e.type === "up" && e.button === 0) {
        const hit = this.hit();
        if (this.downOn && hit === this.downOn) {
          this.activate(hit);
        }
        used = used || this.downOn !== void 0;
        this.downOn = void 0;
      } else if (e.type === "wheel" && contains(this.list, this.mouse.x, this.mouse.y)) {
        this.scrollBy(e.delta > 0 ? -1 : 1);
      }
      this.render();
      return used;
    }
    /** Handles a mouse event on the park (off the panel and the bar, or during a drag that started on
     * the park): a left drag moves the camera and with it the selected view, the wheel zooms it. */
    onPark(e) {
      const editor2 = this.editor;
      if (!editor2) {
        return false;
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
      return this.drag !== void 0;
    }
    hit() {
      for (const [id, r] of this.boxes) {
        if (contains(r, this.mouse.x, this.mouse.y)) {
          return id;
        }
      }
      return void 0;
    }
    scrollBy(rows) {
      const count = this.editor?.rows().length ?? 0;
      this.scroll = Math.max(0, Math.min(Math.max(0, count - EDITOR.visibleRows), this.scroll + rows));
    }
    activate(id) {
      const e = this.editor;
      if (!e) {
        return;
      }
      if (id === "scrollUp" || id === "scrollDown") {
        this.scrollBy(id === "scrollUp" ? -1 : 1);
        return;
      }
      if (id.startsWith("row.")) {
        e.select(Number(id.slice(4)));
        return;
      }
      switch (id) {
        case "close":
          e.close();
          break;
        case "prevPark":
          e.goToPark(e.parkIndex - 1);
          break;
        case "nextPark":
          e.goToPark(e.parkIndex + 1);
          break;
        case "add":
          e.add();
          break;
        case "update":
          e.update();
          break;
        case "fit":
          e.fit();
          break;
        case "undo":
          e.undo();
          break;
        case "redo":
          e.redo();
          break;
        case "delete":
          e.remove();
          break;
        case "up":
          e.move(-1);
          break;
        case "down":
          e.move(1);
          break;
        case "revert":
          e.revert();
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
        case "turn":
          e.toggleTurn();
          break;
        case "inertia":
          e.toggleInertia();
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
        case "play":
          e.togglePreview();
          break;
      }
    }
    /** Places every control; rows of equal buttons fill the panel's width. */
    layout(e) {
      const s = EDITOR;
      const inner = s.width - 2 * s.pad;
      const x0 = s.x + s.pad;
      let y = s.y + s.pad;
      this.boxes.clear();
      this.texts.clear();
      const buttonRow = (ids, h = s.buttonHeight) => {
        const w = (inner - s.gap * (ids.length - 1)) / ids.length;
        ids.forEach((id, i) => this.boxes.set(id, {
          x: Math.round(x0 + i * (w + s.gap)),
          y,
          width: Math.round(w),
          height: h
        }));
        y += h + s.gap;
      };
      const t = s.titleHeight;
      this.boxes.set("prevPark", { x: x0, y, width: t, height: t });
      this.boxes.set("nextPark", { x: x0 + t + s.gap, y, width: t, height: t });
      this.boxes.set("close", { x: x0 + inner - t, y, width: t, height: t });
      const names = e.parkNames;
      this.texts.set("park", {
        text: names[e.parkIndex] ?? "No park",
        bold: true,
        r: { x: x0 + 2 * (t + s.gap) + 4, y, width: inner - 3 * (t + s.gap) - 4, height: t }
      });
      y += t + s.gap;
      const rows = e.rows();
      this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - s.visibleRows)));
      const sel = e.selectedIndex;
      if (sel !== this.followed) {
        this.followed = sel;
        if (sel >= 0 && (sel < this.scroll || sel >= this.scroll + s.visibleRows)) {
          this.scroll = Math.max(0, Math.min(sel, rows.length - s.visibleRows));
        }
      }
      const scrolls = rows.length > s.visibleRows;
      const bar2 = scrolls ? s.scrollBar : 0;
      this.list = { x: x0, y, width: inner - bar2, height: s.rowHeight * (s.visibleRows + 1) };
      y += s.rowHeight;
      for (let i = 0; i < s.visibleRows && this.scroll + i < rows.length; i++) {
        this.boxes.set(`row.${this.scroll + i}`, { x: x0, y: y + i * s.rowHeight, width: inner - bar2, height: s.rowHeight });
      }
      this.track = void 0;
      if (scrolls) {
        const bx = x0 + inner - bar2 + 2;
        const rowsTop = y;
        const rowsBottom = y + s.visibleRows * s.rowHeight;
        this.boxes.set("scrollUp", { x: bx, y: rowsTop, width: bar2 - 2, height: bar2 - 2 });
        this.boxes.set("scrollDown", { x: bx, y: rowsBottom - (bar2 - 2), width: bar2 - 2, height: bar2 - 2 });
        this.track = { x: bx, y: rowsTop + bar2, width: bar2 - 2, height: rowsBottom - rowsTop - 2 * bar2 };
      }
      y = this.list.y + this.list.height + s.gap;
      buttonRow(["add", "update", "fit", "delete"]);
      buttonRow(["up", "down", "revert"]);
      const half = Math.round((inner - s.sectionGap) / 2);
      const step = (less, more, key, text, x, w) => {
        const b = s.buttonHeight;
        this.boxes.set(less, { x, y, width: b, height: b });
        this.boxes.set(more, { x: x + w - b, y, width: b, height: b });
        this.texts.set(key, { text, center: true, r: { x: x + b, y, width: w - 2 * b, height: b } });
      };
      step("holdLess", "holdMore", "hold", e.holdText(), x0, half);
      step("panLess", "panMore", "pan", e.panText(), x0 + inner - half, half);
      y += s.buttonHeight + s.gap;
      this.boxes.set("turn", { x: x0, y, width: half, height: s.buttonHeight });
      this.boxes.set("inertia", { x: x0 + inner - half, y, width: half, height: s.buttonHeight });
      y += s.buttonHeight + s.gap;
      buttonRow(["rotl", "rotr", "zoomin", "zoomout"]);
      const small = Math.round((inner - 2 * s.gap) / 6);
      this.boxes.set("undo", { x: x0, y, width: small, height: s.buttonHeight });
      this.boxes.set("redo", { x: x0 + small + s.gap, y, width: small, height: s.buttonHeight });
      const px = x0 + 2 * (small + s.gap);
      this.boxes.set("play", { x: px, y, width: x0 + inner - px, height: s.buttonHeight });
      y += s.buttonHeight + s.gap;
      const status = e.status();
      this.texts.set("status", { text: status.text, warning: status.warning, r: { x: x0, y, width: inner, height: s.lineHeight } });
      y += s.lineHeight;
      for (const [i, help] of HELP.entries()) {
        this.texts.set(`help${i}`, { text: help, r: { x: x0, y, width: inner, height: s.lineHeight } });
        y += s.lineHeight;
      }
      this.frame = { x: s.x, y: s.y, width: s.width, height: y + s.pad - s.y };
    }
    render() {
      const e = this.editor;
      if (!e) {
        return;
      }
      const overlay = this.mode.overlay;
      const s = EDITOR;
      this.layout(e);
      const scene = /* @__PURE__ */ new Map();
      backing(scene, "frame", this.frame, THEME.editorBacking);
      const hover = this.hit();
      const state = (id, on = false) => ({ hover: hover === id, down: this.downOn === id && hover === id, on });
      const textButton = (id, text, on = false) => button(scene, id, this.boxes.get(id), state(id, on), { text, textSize: s.textSize }, overlay);
      textButton("prevPark", "\u2039");
      textButton("nextPark", "\u203A");
      textButton("close", "\xD7");
      const rows = e.rows();
      const cols = columnStarts(this.list.width, rows, overlay);
      const header = { x: this.list.x, y: this.list.y, width: this.list.width, height: s.rowHeight };
      scene.set("list", { type: "rect", ...this.list, fill: THEME.editorList, z: Z.face });
      EDITOR_COLUMNS.forEach((h, c) => label(
        scene,
        `head.${c}`,
        h,
        { x: header.x + cols[c] + 4, y: header.y, width: 0, height: header.height },
        s.textSize,
        overlay,
        true
      ));
      for (let i = 0; i < s.visibleRows; i++) {
        const index = this.scroll + i;
        const row = rows[index];
        if (!row) {
          break;
        }
        const r = this.boxes.get(`row.${index}`);
        const fill = index === e.selectedIndex ? THEME.faceOn : hover === `row.${index}` ? THEME.faceHover : i % 2 ? THEME.face : void 0;
        scene.set(`row.${index}`, { type: "rect", ...r, fill: fill ?? "#00000000", z: Z.face });
        row.forEach((cell, c) => label(
          scene,
          `cell.${i}.${c}`,
          cell,
          { x: r.x + cols[c] + 4, y: r.y, width: 0, height: r.height },
          s.textSize,
          overlay
        ));
      }
      if (this.track) {
        textButton("scrollUp", "\u25B2");
        textButton("scrollDown", "\u25BC");
        const t = this.track;
        scene.set("track", { type: "rect", ...t, fill: THEME.editorList, z: Z.face });
        const share = s.visibleRows / rows.length;
        const h = Math.max(8, Math.round(t.height * share));
        const top = t.y + Math.round((t.height - h) * this.scroll / Math.max(1, rows.length - s.visibleRows));
        scene.set("thumb", { type: "rect", x: t.x, y: top, width: t.width, height: h, fill: THEME.face, z: Z.icon });
      }
      textButton("add", "Add view");
      textButton("update", "Set to camera");
      textButton("fit", "Fit height");
      textButton("delete", "Delete");
      textButton("up", "Move up");
      textButton("down", "Move down");
      textButton("revert", "Use playlist views");
      textButton("holdLess", "\u2212");
      textButton("holdMore", "+");
      textButton("panLess", "\u2212");
      textButton("panMore", "+");
      textButton("turn", e.turnText());
      textButton("inertia", e.inertiaText());
      textButton("rotl", "Rotate left");
      textButton("rotr", "Rotate right");
      textButton("zoomin", "Zoom in");
      textButton("zoomout", "Zoom out");
      textButton("undo", "Undo");
      textButton("redo", "Redo");
      textButton("play", e.isPlaying ? "Play: on (moving the camera stops it)" : "Play: off", e.isPlaying);
      for (const [key, t] of this.texts) {
        label(scene, `text.${key}`, t.text, t.r, key === "park" ? s.titleSize : s.textSize, overlay, t.bold);
        if (t.center) {
          scene.set(`text.${key}`, { ...scene.get(`text.${key}`), x: t.r.x + t.r.width / 2, align: "center" });
        }
        if (t.warning) {
          scene.set(`text.${key}`, { ...scene.get(`text.${key}`), colour: THEME.warning });
        }
      }
      this.layer.render(scene);
    }
  };
  function columnStarts(width, rows, overlay) {
    const size = EDITOR.textSize;
    const natural = EDITOR_COLUMNS.map((h, c) => Math.max(
      measure(overlay, h, size, true).width,
      ...rows.map((r) => measure(overlay, r[c] ?? "", size).width)
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
  function log2(message) {
    console.log(`[RCT Screensaver] ${message}`);
  }
  function startPlayer() {
    const settings = loadSettings();
    const playlist = loadPlaylist();
    if (!playlist) {
      log2("no playlist installed; run tools/mksequence.py --install");
      return;
    }
    if (playlist.titles && TITLES.includes(playlist.titles)) {
      settings.titlesOverride = playlist.titles;
    }
    const sequence = resolveSequence(playlist);
    if (typeof sequence === "string") {
      log2(sequence);
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
        editorOpen: () => editor?.isOpen ?? false
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
  function update() {
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
    if (player.debug && Date.now() - lastDebug >= DEBUG_INTERVAL_MS) {
      lastDebug = Date.now();
      log2(player.describe());
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
      ["redo", "Redo (view editor)", ["CTRL+Y", "CTRL+SHIFT+Z"], either(() => {
      }, (e) => e.redo())]
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
      log2(`debug log ${settings.debug ? "on" : "off"}`);
    });
  }
  function startProfiler(path) {
    if (!path || profilerTimer !== void 0) {
      return;
    }
    console.executeLegacy("profiler_start");
    log2(`profiler on, exporting to ${path}`);
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
        log2("the engine writes a perf log");
        perfMark("plugin started");
      }
      mode.onChange((active) => {
        log2(`screensaver mode ${active ? "on" : "off"}`);
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
