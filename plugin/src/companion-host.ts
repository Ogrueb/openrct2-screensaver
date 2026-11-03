// Runs a park's companion plugin (shipped with the park, normally a `local` or `remote` plugin)
// on the title screen. tools/mksequence.py writes one plugin file per companion: this host,
// then a call to RCTScreensaverCompanionHost with the companion's code wrapped in a function.
// The host registers an intransient plugin, starts the companion after each load of one of its
// parks and stops it, with everything it subscribed to, before the next load. The companion
// sees shims for the parts of the API that would leak out of a park: windows are stand-ins
// that never show, the camera is the screensaver's unless the playlist hands it over, and park
// storage defaults to the companion's own name. A playlist "show" view runs one of the
// companion's scripted shows: the screensaver executes the host's custom action, the host presses
// the companion's hidden buttons in the show's order, and reports back when the show is over.
// A park's profile (parks/*.toml) can patch what the companion reads from park storage, and
// pause it while the camera moves or is zoomed out. See docs/companion-plugins.md.

interface CompanionConfig {
    name: string;             // the companion's registered name
    version: string;
    file: string;             // its file name in the park's zip, for log lines
    targetApiVersion?: number;
    parks: CompanionPark[];   // parks it runs with
    camera: boolean;          // may it move the main viewport
    debug: boolean;
    showAction?: string;      // custom action that starts a show, executed by the screensaver
    shows?: Record<string, ShowStep[]>;
}

interface CompanionPark {
    name: string;
    size: { x: number; y: number };
    patches?: StoragePatch[]; // changes to the companion's park storage, as it reads it
    pause?: boolean;          // hold its tick handlers while the camera moves
    pauseAboveZoom?: number;  // and while the main viewport is zoomed out beyond this level
    zoomRates?: Record<string, number>; // at these zoom levels, run this share of its ticks
}

/** Sets fields (dotted paths) on every object in the companion's storage with this id. */
interface StoragePatch {
    id: string;
    set: Record<string, unknown>;
}

/** One step of a show, on the companion's hidden windows' widgets (by name). */
interface ShowStep {
    press?: string;   // click this button (once it is visible and enabled)
    until?: string;   // wait until this widget is visible and enabled
    wait?: number;    // wait this many seconds
    waitTicks?: number; // wait this many game ticks (follows the game speed, as a show's frames do)
    ticks?: number;   // wait until the companion has run this many game ticks since its park loaded
}

const SHOW_POLL_MS = 100;
const SHOW_DONE_ACTION = "rctscreensaver-showdone"; // registered by the screensaver
const SHOW_STEP_ACTION = "rctscreensaver-showstep"; // likewise: a show has reached a step

type Factory = (registerPlugin: (m: PluginMetadata) => void, context: Context, ui: Ui,
    park: Park, console: Console, map: GameMap) => void;

const PAUSE_SETTLE_TICKS = 8; // a paused companion resumes once the camera has kept still this long
// Never paused on its first ticks, so what it sets up on the park's first frame runs whatever the
// view (Animator makes Sambhava's mist visible on its first tick; the fade starts 15 ticks on).
const WARMUP_TICKS = 2;
const MAX_ERRORS = 20; // a companion that keeps throwing is stopped for the rest of the park
const REPEAT_LINES = 5; // a companion's identical console lines printed per park

function host(config: CompanionConfig, factory: Factory): void {
    const tag = `[RCT Screensaver companion: ${config.name}]`;
    const log = (text: string) => console.log(`${tag} ${text}`);
    const debug = (text: string) => { if (config.debug) log(text); };

    let run: Run | null = null;
    // Custom game actions the companion registers. An action can be registered only once per
    // plugin, so the host registers each name for real the first time and routes it to the
    // handlers of the run that is current; between runs it does nothing.
    const registeredActions = new Set<string>();

    class Run {
        disposables: IDisposable[] = [];
        intervals = new Set<number>();
        timeouts = new Set<number>();
        errors = 0;
        stopped = false;
        windows: Window[] = []; // stand-ins, newest last
        show: string | null = null; // the show running, if any
        ticks = 0; // game ticks since the companion started
        paused = false; // the camera is moving or zoomed out, and the park's profile asks for a pause
        constructor(public park: CompanionPark) {}
        actions = new Map<string, { query: (a: object) => unknown; execute: (a: object) => unknown }>();

        /** Calls into the companion, logging what it throws instead of passing it on. */
        guard<A extends unknown[], R>(where: string, fn: (...args: A) => R): (...args: A) => R | undefined {
            return (...args: A) => {
                if (this.stopped) return undefined;
                try {
                    return fn(...args);
                } catch (e) {
                    this.errors++;
                    log(`error in ${where}: ${e}${e instanceof Error && e.stack ? "\n" + e.stack : ""}`);
                    if (this.errors >= MAX_ERRORS) {
                        log(`${MAX_ERRORS} errors; stopped until the next park`);
                        this.stop();
                    }
                    return undefined;
                }
            };
        }

        stop(): void {
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

    function shimContext(r: Run): Context {
        const overrides: Partial<Context> = {
            subscribe(hook: string, callback: (...a: unknown[]) => void): IDisposable {
                // Transient plugins never receive map.changed; the host handles park changes.
                if (hook === "map.changed" || hook === "map.change") {
                    debug(`ignored subscription to ${hook}`);
                    return { dispose() {} };
                }
                const guarded = r.guard(hook, callback);
                const handler = hook === "interval.tick" ? (...a: unknown[]) => { if (!r.paused) guarded(...a); } : guarded;
                const d = context.subscribe(hook as "interval.tick", handler as () => void);
                r.disposables.push(d);
                return { dispose() { d.dispose(); } };
            },
            setInterval(callback: Function, delay: number): number {
                const guarded = r.guard("interval", callback as () => void);
                const id = context.setInterval(() => { if (!r.paused) guarded(); }, delay);
                r.intervals.add(id);
                return id;
            },
            setTimeout(callback: Function, delay: number): number {
                const id = context.setTimeout(r.guard("timeout", () => {
                    r.timeouts.delete(id);
                    (callback as () => void)();
                }), delay);
                r.timeouts.add(id);
                return id;
            },
            clearInterval(id: number): void { r.intervals.delete(id); context.clearInterval(id); },
            clearTimeout(id: number): void { r.timeouts.delete(id); context.clearTimeout(id); },
            getParkStorage(pluginName?: string) {
                const storage = context.getParkStorage(pluginName ?? config.name);
                const patches = r.park.patches;
                if (!patches?.length || (pluginName ?? config.name) !== config.name) return storage;
                return proxy(storage, {
                    get: (key: string, fallback?: unknown) => patched(storage.get(key, fallback), patches),
                    getAll: (namespace?: string) => patched(storage.getAll(namespace), patches),
                });
            },
            registerAction(action: string, query: (a: object) => unknown, execute: (a: object) => unknown): void {
                r.actions.set(action, { query: r.guard(`${action} query`, query), execute: r.guard(action, execute) });
                if (registeredActions.has(action)) return;
                registeredActions.add(action);
                const route = (which: "query" | "execute") => (args: object) => {
                    const handler = run && !run.stopped ? run.actions.get(action) : undefined;
                    return (handler ? handler[which](args) : undefined) ?? {};
                };
                context.registerAction(action, route("query") as never, route("execute") as never);
            },
        } as Partial<Context>;
        return proxy(context, overrides as Record<string, unknown>);
    }

    function shimUi(r: Run): Ui {
        const viewport = proxy(ui.mainViewport, {
            moveTo: (pos: CoordsXY | CoordsXYZ) => camera("moveTo", () => ui.mainViewport.moveTo(pos)),
            scrollTo: (pos: CoordsXY | CoordsXYZ) => camera("scrollTo", () => ui.mainViewport.scrollTo(pos)),
        }, (prop, value) => camera(`set ${String(prop)}`, () => {
            (ui.mainViewport as unknown as Record<string | symbol, unknown>)[prop] = value;
        }));
        const overrides: Record<string, unknown> = {
            mainViewport: viewport,
            openWindow: (desc: WindowDesc) => standInWindow(desc, r),
            // The companion's own windows are its stand-ins: found by classification or index.
            getWindow: (id: number | string) => typeof id === "number" ? r.windows[id]
                : [...r.windows].reverse().find(w => (w as unknown as { classId: string }).classId === id),
            closeWindows: (id: string) => {
                for (const w of r.windows.filter(x => (x as unknown as { classId: string }).classId === id)) w.close();
            },
            closeAllWindows: () => { for (const w of [...r.windows]) w.close(); },
            registerMenuItem: (text: string) => debug(`ignored menu item "${text}"`),
            registerToolboxMenuItem: (text: string) => debug(`ignored toolbox item "${text}"`),
            registerShortcut: (s: ShortcutDesc) => debug(`ignored shortcut ${s.id}`),
            activateTool: () => debug("ignored activateTool"),
            showError: (title: string, message: string) => debug(`error box: ${title} ${message}`),
            showTextInput: () => {},
            showFileBrowse: () => {},
            showScenarioSelect: () => {},
        };
        return proxy(ui, overrides);
    }

    function shimPark(): Park {
        return proxy(park, {
            postMessage: (m: unknown) => debug(`message: ${typeof m === "string" ? m : JSON.stringify(m)}`),
        });
    }

    /** The map, with each ride's `vehicles` limited to trains that exist: a ride's list can
     * name a vehicle whose entity is gone, and companions that look each one up (Object
     * Animator's and Animator's car triggers) threw on it every tick ("cannot read property
     * 'trackLocation' of null", 2026-10-27 and 2026-10-30). */
    function shimMap(): GameMap {
        return proxy(map, {
            getRide: (id: number) => {
                const ride = map.getRide(id);
                if (!ride) return ride;
                return new Proxy(ride, {
                    get(t, prop) {
                        if (prop === "vehicles") return t.vehicles.filter(v => map.getEntity(v) !== null);
                        const value = Reflect.get(t, prop);
                        return typeof value === "function" ? value.bind(t) : value;
                    },
                    set(t, prop, value) { return Reflect.set(t, prop, value); },
                });
            },
        });
    }

    /** The console, without debug lines a companion repeats every tick (AdvancedTrack's
     * "Got tile"): each distinct line is printed at most REPEAT_LINES times per park. */
    function shimConsole(): Console {
        const seen = new Map<string, number>();
        const quiet = (print: (...a: unknown[]) => void) => (...args: unknown[]) => {
            const text = args.map(a => String(a)).join(" ");
            const n = (seen.get(text) ?? 0) + 1;
            if (seen.size < 1000 || seen.has(text)) seen.set(text, n);
            if (n < REPEAT_LINES) print(...args);
            else if (n === REPEAT_LINES) print(...args, `(repeated; muted until the next park)`);
        };
        return proxy(console, { log: quiet(console.log.bind(console)), info: quiet(console.log.bind(console)) });
    }

    function camera(what: string, apply: () => void): void {
        if (config.camera) {
            debug(`camera: ${what}`);
            apply();
        } else {
            debug(`camera kept: ignored ${what}`);
        }
    }

    /** A window that is never shown: its widgets are the descriptions it was given, so the
     * companion can keep reading and changing them. Closing it runs its onClose once. */
    function standInWindow(desc: WindowDesc, r: Run): Window {
        debug(`window "${desc.title}" kept hidden`);
        const widgets = (desc.widgets ?? []).map(w => ({ ...w })) as unknown as Widget[];
        let open = true;
        const w = {
            classification: 0, number: 0, classId: desc.classification,
            x: desc.x ?? 0, y: desc.y ?? 0, width: desc.width, height: desc.height,
            minWidth: desc.minWidth ?? desc.width, maxWidth: desc.maxWidth ?? desc.width,
            minHeight: desc.minHeight ?? desc.height, maxHeight: desc.maxHeight ?? desc.height,
            isSticky: false, colours: desc.colours ?? [], title: desc.title,
            widgets, tabIndex: desc.tabIndex ?? 0,
            close() {
                if (!open) return;
                open = false;
                r.windows = r.windows.filter(x => x !== (w as unknown as Window));
                // A companion that reopens its window on close would loop here; the stand-in
                // stays closed and the reopen opens another stand-in, once.
                if (desc.onClose) r.guard("window onClose", desc.onClose)();
            },
            bringToFront() {},
            findWidget(name: string) { return widgets.find(x => (x as { name?: string }).name === name); },
            getColour(i: number) { return (desc.colours ?? [])[i]; },
            setColour() {},
        };
        r.windows.push(w as unknown as Window);
        return w as unknown as Window;
    }

    /** The visible widget of that name in the companion's open stand-in windows, newest first. */
    function widget(r: Run, name: string): Record<string, unknown> | undefined {
        for (let i = r.windows.length - 1; i >= 0; i--) {
            const found = r.windows[i].findWidget(name) as unknown as Record<string, unknown> | undefined;
            if (found) return found;
        }
        return undefined;
    }

    const ready = (w: Record<string, unknown> | undefined) =>
        w !== undefined && w.isVisible !== false && w.isDisabled !== true;

    /** Runs a show's steps on the current park, then tells the screensaver it is over. */
    function startShow(name: string): void {
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
                    // The screensaver can start a show view's camera path at a step (pathStep).
                    reported = i;
                    context.executeAction(SHOW_STEP_ACTION, { show: name, step: i });
                }
                const step = steps[i];
                if (step.wait !== undefined && Date.now() - stepStarted < step.wait * 1000) return;
                if (step.ticks !== undefined && r.ticks < step.ticks) return;
                if (step.waitTicks !== undefined && r.ticks - stepTick < step.waitTicks) return;
                if (step.until !== undefined && !ready(widget(r, step.until))) return;
                if (step.press !== undefined) {
                    const button = widget(r, step.press);
                    if (!ready(button)) return;
                    debug(`show "${name}": pressing ${step.press}`);
                    if (typeof button!.onClick === "function") (button!.onClick as () => void)();
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

    function currentPark(): CompanionPark | undefined {
        return config.parks.find(p => p.name === park.name && p.size.x === map.size.x && p.size.y === map.size.y);
    }

    /** Where the camera is, to tell when it moves. */
    function cameraKey(): string {
        const v = ui.mainViewport;
        const c = v.getCentrePosition();
        return `${c.x},${c.y},${v.zoom},${v.rotation}`;
    }

    function start(): void {
        stop();
        const own = context.mode === "title" ? currentPark() : undefined;
        if (!own) return;
        const r = new Run(own);
        run = r;
        let last = "", still = 0, credit = 0;
        r.disposables.push(context.subscribe("interval.tick", () => {
            r.ticks++;
            if (!own.pause && own.pauseAboveZoom === undefined && !own.zoomRates) return;
            const key = cameraKey();
            still = key === last ? still + 1 : 0;
            last = key;
            const moving = !!own.pause && still < PAUSE_SETTLE_TICKS;
            const wide = own.pauseAboveZoom !== undefined && ui.mainViewport.zoom > own.pauseAboveZoom;
            // A slowed zoom level runs one tick in so many, by credit (a share of 0.1: every tenth).
            const rate = own.zoomRates?.[String(ui.mainViewport.zoom)] ?? 1;
            credit = rate >= 1 ? 0 : credit + rate;
            const skipped = rate < 1 && credit < 1;
            if (!skipped && rate < 1) credit -= 1;
            const paused = r.ticks > WARMUP_TICKS && (moving || wide || skipped);
            if (paused !== r.paused && !skipped) debug(paused ? `paused (${moving ? "camera moving" : "zoomed out"})` : "resumed");
            r.paused = paused;
        }));
        let main: (() => void) | undefined;
        const registerPlugin = (m: PluginMetadata) => { main = m.main; };
        const t0 = Date.now();
        r.guard("load", () => factory.call(globalThis, registerPlugin, shimContext(r), shimUi(r), shimPark(), shimConsole(), shimMap()))();
        const t1 = Date.now();
        if (main) r.guard("main", main)();
        const t2 = Date.now();
        log(`started on "${park.name}" (load ${t1 - t0} ms, main ${t2 - t1} ms)`);
    }

    function stop(): void {
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
                context.registerAction<{ show: string }>(config.showAction, () => ({}), e => {
                    startShow(e.args.show);
                    return {};
                });
            }
            context.subscribe("map.change", stop);
            context.subscribe("map.changed", start);
            start(); // the first title park may have loaded before plugins started
        },
    });
}

/** A copy of a stored value with the patches applied to every object carrying a patch's id. */
function patched(value: unknown, patches: StoragePatch[]): unknown {
    if (value === undefined || value === null || typeof value !== "object") return value;
    const copy = JSON.parse(JSON.stringify(value)) as unknown;
    const walk = (v: unknown): void => {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v === null || typeof v !== "object") return;
        const o = v as Record<string, unknown>;
        for (const p of patches) {
            if (o.id !== p.id) continue;
            for (const [path, field] of Object.entries(p.set)) {
                const keys = path.split(".");
                let at = o;
                for (const k of keys.slice(0, -1)) {
                    if (at[k] === null || typeof at[k] !== "object") at[k] = {};
                    at = at[k] as Record<string, unknown>;
                }
                at[keys[keys.length - 1]] = field;
            }
        }
        Object.values(o).forEach(walk);
    };
    walk(copy);
    return copy;
}

/** Wraps a native API object: listed properties are replaced, the rest are read from the
 * object itself (so native getters see their own object) and functions are bound to it. */
function proxy<T extends object>(target: T, overrides: Record<string, unknown>,
    set?: (prop: string | symbol, value: unknown) => void): T {
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
        },
    });
}

(globalThis as unknown as { RCTScreensaverCompanionHost: typeof host }).RCTScreensaverCompanionHost = host;
