"use strict";
(() => {
  // src/companion-host.ts
  var SHOW_POLL_MS = 100;
  var SHOW_DONE_ACTION = "rctscreensaver-showdone";
  var SHOW_STEP_ACTION = "rctscreensaver-showstep";
  var PAUSE_SETTLE_TICKS = 8;
  var WARMUP_TICKS = 2;
  var MAX_ERRORS = 20;
  var REPEAT_LINES = 5;
  function host(config, factory) {
    const tag = `[RCT Screensaver companion: ${config.name}]`;
    const log = (text) => console.log(`${tag} ${text}`);
    const debug = (text) => {
      if (config.debug) log(text);
    };
    let run = null;
    const registeredActions = /* @__PURE__ */ new Set();
    class Run {
      // the camera is moving or zoomed out, and the park's profile asks for a pause
      constructor(park2) {
        this.park = park2;
        this.disposables = [];
        this.intervals = /* @__PURE__ */ new Set();
        this.timeouts = /* @__PURE__ */ new Set();
        this.errors = 0;
        this.stopped = false;
        this.windows = [];
        // stand-ins, newest last
        this.show = null;
        // the show running, if any
        this.ticks = 0;
        // game ticks since the companion started
        this.paused = false;
        this.actions = /* @__PURE__ */ new Map();
      }
      /** Calls into the companion, logging what it throws instead of passing it on. */
      guard(where, fn) {
        return (...args) => {
          if (this.stopped) return void 0;
          try {
            return fn(...args);
          } catch (e) {
            this.errors++;
            log(`error in ${where}: ${e}${e instanceof Error && e.stack ? "\n" + e.stack : ""}`);
            if (this.errors >= MAX_ERRORS) {
              log(`${MAX_ERRORS} errors; stopped until the next park`);
              this.stop();
            }
            return void 0;
          }
        };
      }
      stop() {
        if (this.stopped) return;
        this.stopped = true;
        for (const d of this.disposables) d.dispose();
        for (const id of this.intervals) context.clearInterval(id);
        for (const id of this.timeouts) context.clearTimeout(id);
        this.disposables = [];
        this.intervals.clear();
        this.timeouts.clear();
        this.actions.clear();
      }
    }
    function shimContext(r) {
      const overrides = {
        subscribe(hook, callback) {
          if (hook === "map.changed" || hook === "map.change") {
            debug(`ignored subscription to ${hook}`);
            return { dispose() {
            } };
          }
          const guarded = r.guard(hook, callback);
          const handler = hook === "interval.tick" ? (...a) => {
            if (!r.paused) guarded(...a);
          } : guarded;
          const d = context.subscribe(hook, handler);
          r.disposables.push(d);
          return { dispose() {
            d.dispose();
          } };
        },
        setInterval(callback, delay) {
          const guarded = r.guard("interval", callback);
          const id = context.setInterval(() => {
            if (!r.paused) guarded();
          }, delay);
          r.intervals.add(id);
          return id;
        },
        setTimeout(callback, delay) {
          const id = context.setTimeout(r.guard("timeout", () => {
            r.timeouts.delete(id);
            callback();
          }), delay);
          r.timeouts.add(id);
          return id;
        },
        clearInterval(id) {
          r.intervals.delete(id);
          context.clearInterval(id);
        },
        clearTimeout(id) {
          r.timeouts.delete(id);
          context.clearTimeout(id);
        },
        getParkStorage(pluginName) {
          const storage = context.getParkStorage(pluginName ?? config.name);
          const patches = r.park.patches;
          if (!patches?.length || (pluginName ?? config.name) !== config.name) return storage;
          return proxy(storage, {
            get: (key, fallback) => patched(storage.get(key, fallback), patches),
            getAll: (namespace) => patched(storage.getAll(namespace), patches)
          });
        },
        registerAction(action, query, execute) {
          r.actions.set(action, { query: r.guard(`${action} query`, query), execute: r.guard(action, execute) });
          if (registeredActions.has(action)) return;
          registeredActions.add(action);
          const route = (which) => (args) => {
            const handler = run && !run.stopped ? run.actions.get(action) : void 0;
            return (handler ? handler[which](args) : void 0) ?? {};
          };
          context.registerAction(action, route("query"), route("execute"));
        }
      };
      return proxy(context, overrides);
    }
    function shimUi(r) {
      const viewport = proxy(ui.mainViewport, {
        moveTo: (pos) => camera("moveTo", () => ui.mainViewport.moveTo(pos)),
        scrollTo: (pos) => camera("scrollTo", () => ui.mainViewport.scrollTo(pos))
      }, (prop, value) => camera(`set ${String(prop)}`, () => {
        ui.mainViewport[prop] = value;
      }));
      const overrides = {
        mainViewport: viewport,
        openWindow: (desc) => standInWindow(desc, r),
        // The companion's own windows are its stand-ins: found by classification or index.
        getWindow: (id) => typeof id === "number" ? r.windows[id] : [...r.windows].reverse().find((w) => w.classId === id),
        closeWindows: (id) => {
          for (const w of r.windows.filter((x) => x.classId === id)) w.close();
        },
        closeAllWindows: () => {
          for (const w of [...r.windows]) w.close();
        },
        registerMenuItem: (text) => debug(`ignored menu item "${text}"`),
        registerToolboxMenuItem: (text) => debug(`ignored toolbox item "${text}"`),
        registerShortcut: (s) => debug(`ignored shortcut ${s.id}`),
        activateTool: () => debug("ignored activateTool"),
        showError: (title, message) => debug(`error box: ${title} ${message}`),
        showTextInput: () => {
        },
        showFileBrowse: () => {
        },
        showScenarioSelect: () => {
        }
      };
      return proxy(ui, overrides);
    }
    function shimPark() {
      return proxy(park, {
        postMessage: (m) => debug(`message: ${typeof m === "string" ? m : JSON.stringify(m)}`)
      });
    }
    function shimMap() {
      return proxy(map, {
        getRide: (id) => {
          const ride = map.getRide(id);
          if (!ride) return ride;
          return new Proxy(ride, {
            get(t, prop) {
              if (prop === "vehicles") return t.vehicles.filter((v) => map.getEntity(v) !== null);
              const value = Reflect.get(t, prop);
              return typeof value === "function" ? value.bind(t) : value;
            },
            set(t, prop, value) {
              return Reflect.set(t, prop, value);
            }
          });
        }
      });
    }
    function shimConsole() {
      const seen = /* @__PURE__ */ new Map();
      const quiet = (print) => (...args) => {
        const text = args.map((a) => String(a)).join(" ");
        const n = (seen.get(text) ?? 0) + 1;
        if (seen.size < 1e3 || seen.has(text)) seen.set(text, n);
        if (n < REPEAT_LINES) print(...args);
        else if (n === REPEAT_LINES) print(...args, `(repeated; muted until the next park)`);
      };
      return proxy(console, { log: quiet(console.log.bind(console)), info: quiet(console.log.bind(console)) });
    }
    function camera(what, apply) {
      if (config.camera) {
        debug(`camera: ${what}`);
        apply();
      } else {
        debug(`camera kept: ignored ${what}`);
      }
    }
    function standInWindow(desc, r) {
      debug(`window "${desc.title}" kept hidden`);
      const widgets = (desc.widgets ?? []).map((w2) => ({ ...w2 }));
      let open = true;
      const w = {
        classification: 0,
        number: 0,
        classId: desc.classification,
        x: desc.x ?? 0,
        y: desc.y ?? 0,
        width: desc.width,
        height: desc.height,
        minWidth: desc.minWidth ?? desc.width,
        maxWidth: desc.maxWidth ?? desc.width,
        minHeight: desc.minHeight ?? desc.height,
        maxHeight: desc.maxHeight ?? desc.height,
        isSticky: false,
        colours: desc.colours ?? [],
        title: desc.title,
        widgets,
        tabIndex: desc.tabIndex ?? 0,
        close() {
          if (!open) return;
          open = false;
          r.windows = r.windows.filter((x) => x !== w);
          if (desc.onClose) r.guard("window onClose", desc.onClose)();
        },
        bringToFront() {
        },
        findWidget(name) {
          return widgets.find((x) => x.name === name);
        },
        getColour(i) {
          return (desc.colours ?? [])[i];
        },
        setColour() {
        }
      };
      r.windows.push(w);
      return w;
    }
    function widget(r, name) {
      for (let i = r.windows.length - 1; i >= 0; i--) {
        const found = r.windows[i].findWidget(name);
        if (found) return found;
      }
      return void 0;
    }
    const ready = (w) => w !== void 0 && w.isVisible !== false && w.isDisabled !== true;
    function startShow(name) {
      const r = run;
      const steps = config.shows?.[name];
      if (!r || r.stopped || !steps) {
        log(`show "${name}" not started: ${!steps ? "unknown show" : "companion not running"}`);
        return;
      }
      if (r.show) {
        debug(`show "${r.show}" already running`);
        return;
      }
      r.show = name;
      log(`show "${name}" started`);
      let i = 0;
      let stepStarted = Date.now();
      let stepTick = r.ticks;
      let reported = -1;
      const id = context.setInterval(r.guard(`show ${name}`, () => {
        while (i < steps.length) {
          if (reported < i) {
            reported = i;
            context.executeAction(SHOW_STEP_ACTION, { show: name, step: i });
          }
          const step = steps[i];
          if (step.wait !== void 0 && Date.now() - stepStarted < step.wait * 1e3) return;
          if (step.ticks !== void 0 && r.ticks < step.ticks) return;
          if (step.waitTicks !== void 0 && r.ticks - stepTick < step.waitTicks) return;
          if (step.until !== void 0 && !ready(widget(r, step.until))) return;
          if (step.press !== void 0) {
            const button = widget(r, step.press);
            if (!ready(button)) return;
            debug(`show "${name}": pressing ${step.press}`);
            if (typeof button.onClick === "function") button.onClick();
          }
          i++;
          stepStarted = Date.now();
          stepTick = r.ticks;
        }
        context.clearInterval(id);
        r.intervals.delete(id);
        r.show = null;
        log(`show "${name}" finished`);
        context.executeAction(SHOW_DONE_ACTION, { show: name });
      }), SHOW_POLL_MS);
      r.intervals.add(id);
    }
    function currentPark() {
      return config.parks.find((p) => p.name === park.name && p.size.x === map.size.x && p.size.y === map.size.y);
    }
    function cameraKey() {
      const v = ui.mainViewport;
      const c = v.getCentrePosition();
      return `${c.x},${c.y},${v.zoom},${v.rotation}`;
    }
    function start() {
      stop();
      const own = context.mode === "title" ? currentPark() : void 0;
      if (!own) return;
      const r = new Run(own);
      run = r;
      let last = "", still = 0, credit = 0;
      r.disposables.push(context.subscribe("interval.tick", () => {
        r.ticks++;
        if (!own.pause && own.pauseAboveZoom === void 0 && !own.zoomRates) return;
        const key = cameraKey();
        still = key === last ? still + 1 : 0;
        last = key;
        const moving = !!own.pause && still < PAUSE_SETTLE_TICKS;
        const wide = own.pauseAboveZoom !== void 0 && ui.mainViewport.zoom > own.pauseAboveZoom;
        const rate = own.zoomRates?.[String(ui.mainViewport.zoom)] ?? 1;
        credit = rate >= 1 ? 0 : credit + rate;
        const skipped = rate < 1 && credit < 1;
        if (!skipped && rate < 1) credit -= 1;
        const paused = r.ticks > WARMUP_TICKS && (moving || wide || skipped);
        if (paused !== r.paused && !skipped) debug(paused ? `paused (${moving ? "camera moving" : "zoomed out"})` : "resumed");
        r.paused = paused;
      }));
      let main;
      const registerPlugin2 = (m) => {
        main = m.main;
      };
      const t0 = Date.now();
      r.guard("load", () => factory.call(globalThis, registerPlugin2, shimContext(r), shimUi(r), shimPark(), shimConsole(), shimMap()))();
      const t1 = Date.now();
      if (main) r.guard("main", main)();
      const t2 = Date.now();
      log(`started on "${park.name}" (load ${t1 - t0} ms, main ${t2 - t1} ms)`);
    }
    function stop() {
      if (!run) return;
      run.stop();
      run = null;
      debug("stopped");
    }
    registerPlugin({
      name: `${config.name} (RCT Screensaver)`,
      version: config.version,
      authors: ["RCT Screensaver (companion host)"],
      type: "intransient",
      licence: "UNLICENSED",
      targetApiVersion: config.targetApiVersion ?? 124,
      main() {
        if (config.showAction) {
          context.registerAction(config.showAction, () => ({}), (e) => {
            startShow(e.args.show);
            return {};
          });
        }
        context.subscribe("map.change", stop);
        context.subscribe("map.changed", start);
        start();
      }
    });
  }
  function patched(value, patches) {
    if (value === void 0 || value === null || typeof value !== "object") return value;
    const copy = JSON.parse(JSON.stringify(value));
    const walk = (v) => {
      if (Array.isArray(v)) {
        v.forEach(walk);
        return;
      }
      if (v === null || typeof v !== "object") return;
      const o = v;
      for (const p of patches) {
        if (o.id !== p.id) continue;
        for (const [path, field] of Object.entries(p.set)) {
          const keys = path.split(".");
          let at = o;
          for (const k of keys.slice(0, -1)) {
            if (at[k] === null || typeof at[k] !== "object") at[k] = {};
            at = at[k];
          }
          at[keys[keys.length - 1]] = field;
        }
      }
      Object.values(o).forEach(walk);
    };
    walk(copy);
    return copy;
  }
  function proxy(target, overrides, set) {
    return new Proxy(target, {
      get(t, prop) {
        if (typeof prop === "string" && prop in overrides) return overrides[prop];
        const value = Reflect.get(t, prop);
        return typeof value === "function" ? value.bind(t) : value;
      },
      set(t, prop, value) {
        if (set) set(prop, value);
        else Reflect.set(t, prop, value);
        return true;
      }
    });
  }
  globalThis.RCTScreensaverCompanionHost = host;
})();
