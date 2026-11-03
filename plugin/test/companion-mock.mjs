// Runs a generated companion plugin (tools/mksequence.py writes them to
// <sequence>.companions/) against a minimal mock of the title screen API. Checks the host's
// lifecycle, not the companion's effects: it starts only on its own park, its errors are
// caught and logged, windows and the camera stay the screensaver's, and everything it
// subscribed to is gone after a park change.
//
// With --show <name>, also runs that show through the host's custom action, on a simulated
// clock (25 ms per tick), and checks that it finishes and reports back to the screensaver.
//
// Usage: node test/companion-mock.mjs <companion.js> <park name> <width> <height> [storage.json]
//            [--show <name>]
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const argv = process.argv.slice(2);
const showAt = argv.indexOf("--show");
const showName = showAt >= 0 ? argv.splice(showAt, 2)[1] : undefined;
const [file, parkName, width, height, storagePath] = argv;
let clock = 0; // simulated milliseconds
const actions = new Map(); // custom actions: name -> execute
const executed = [];
const storage = storagePath ? JSON.parse(fs.readFileSync(storagePath, "utf8")) : {};
const lookup = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const hooks = new Map(); // hook -> Set of callbacks
const timers = new Map();
let nextTimer = 1;
const logs = [];
const windowsOpened = [];
const camera = { moves: 0 };
const viewport = {
    rotation: 0, zoom: 0,
    moveTo() { camera.moves++; }, scrollTo() { camera.moves++; },
    getCentrePosition() { return { x: 0, y: 0 }; },
};
let plugins = [];

const context = {
    mode: "title",
    subscribe(hook, cb) {
        if (!hooks.has(hook)) hooks.set(hook, new Set());
        hooks.get(hook).add(cb);
        return { dispose() { hooks.get(hook).delete(cb); } };
    },
    setInterval(cb, ms) { const id = nextTimer++; timers.set(id, { cb, ms, repeat: true }); return id; },
    setTimeout(cb, ms) { const id = nextTimer++; timers.set(id, { cb, ms, repeat: false }); return id; },
    clearInterval(id) { timers.delete(id); },
    clearTimeout(id) { timers.delete(id); },
    getParkStorage(name) {
        assert.ok(name, "the host should pass the companion's name");
        const own = storage[name] ?? {};
        return { get: (key, def) => lookup(own, key) ?? def, set() {}, has: key => lookup(own, key) !== undefined, getAll: () => own };
    },
    getRandom: (min, max) => min + Math.floor(Math.random() * (max - min)),
    executeAction(name, args, cb) {
        executed.push({ name, args });
        if (actions.has(name)) actions.get(name)({ args });
        cb?.({});
    },
    registerAction(name, query, execute) {
        assert.ok(!actions.has(name), `custom action ${name} registered twice (OpenRCT2 refuses that)`);
        actions.set(name, execute);
    },
};
const ui = {
    width: 1920, height: 1080, mainViewport: viewport,
    openWindow(desc) { windowsOpened.push(desc.title); return { findWidget() {} }; },
    registerMenuItem() { throw new Error("menu item reached the real API"); },
    registerShortcut() {}, imageManager: {},
};
const park = { name: parkName, postMessage() { throw new Error("message reached the real API"); } };
const map = {
    size: { x: Number(width), y: Number(height) },
    getTile: (x, y) => ({ x, y, elements: [], numElements: 0 }),
    getRide: id => ({ id, vehicles: [], status: "open", object: { carsPerFlatRide: 255, vehicles: [] } }),
    // Companions take their own entity ids on trust (they were saved with the park).
    getEntity: id => ({ id, type: "car", x: 0, y: 0, z: 0, nextCarOnTrain: null, colours: {} }),
    getAllEntitiesOnTile: () => [], getAllEntities: () => [],
};
class FakeDate extends Date {
    static now() { return clock; }
}
const sandbox = {
    Date: FakeDate,
    context, ui, park, map, network: { mode: "none" }, date: { day: 1, month: 0, year: 1 },
    objectManager: { getAllObjects: () => [], getObject: () => null, load() {} },
    console: { log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) },
    registerPlugin: meta => plugins.push(meta),
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });

const fire = hook => [...(hooks.get(hook) ?? [])].forEach(cb => cb());
const tick = n => {
    for (let i = 0; i < n; i++) {
        clock += 25;
        fire("interval.tick");
        for (const [id, t] of [...timers]) { t.cb(); if (!t.repeat) timers.delete(id); }
    }
};
const listeners = () => [...hooks].filter(([h]) => h !== "map.change" && h !== "map.changed")
    .reduce((n, [, s]) => n + s.size, 0);

assert.equal(plugins.length, 1, "one plugin registered");
assert.equal(plugins[0].type, "intransient");
plugins[0].main();
assert.ok(logs.some(l => l.includes("started on")), "starts on its own park:\n" + logs.join("\n"));
tick(500);
const errors = logs.filter(l => l.includes("error in"));
console.log(logs.join("\n"));
assert.equal(errors.length, 0, "no errors");
assert.equal(windowsOpened.length, 0, "no real windows");
assert.equal(camera.moves, 0, "camera untouched");
const running = listeners() + timers.size;

fire("map.change");
assert.equal(listeners() + timers.size, 0, "everything disposed after a park change");
park.name = "Some other park";
fire("map.changed");
assert.equal(listeners(), 0, "not started on another park");

park.name = parkName;
fire("map.change");
fire("map.changed");
assert.equal(listeners() + timers.size, running, "starts again on a revisit");
console.log(`ok: ${running} subscriptions/timers while running, none after the switch`);

if (showName) {
    const action = [...actions.keys()].find(a => a.startsWith("rctscreensaver-show-"));
    assert.ok(action, "the host registers a show action");
    actions.get(action)({ args: { show: showName } });
    let ticks = 0;
    while (!executed.some(e => e.name === "rctscreensaver-showdone") && ticks < 40 * 600) {
        tick(1);
        ticks++;
    }
    console.log(logs.filter(l => l.includes("show")).join("\n"));
    assert.ok(executed.some(e => e.name === "rctscreensaver-showdone" && e.args.show === showName),
        "the show finishes and reports back");
    assert.equal(logs.filter(l => l.includes("error in")).length, 0, "no errors during the show");
    console.log(`ok: show "${showName}" took ${(ticks / 40).toFixed(1)} s of game time at 1x`);
}
