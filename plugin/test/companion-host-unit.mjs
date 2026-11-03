// Unit checks of the companion host's per-park settings from a park's profile (parks/*.toml):
// storage patches (what the companion reads) and the pause while the camera moves. Runs the
// built host (dist/companion-host.js) with a small stand-in companion on a mock title screen.
//
// Usage: node test/companion-host-unit.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const stored = { Test: { ns: { list: [{ id: "fademist", intervalTicks: 50, randomize: { viewport: { maxDistance: 13 } },
    frames: [{ actions: [{ randomize: { factor: 10 } }] }] },
                                      { id: "other", intervalTicks: 50 }] } } };
const hooks = new Map();
const centre = { x: 0, y: 0 };
const sandbox = {
    console: { log() {} },
    context: {
        mode: "title",
        subscribe(hook, cb) {
            if (!hooks.has(hook)) hooks.set(hook, new Set());
            hooks.get(hook).add(cb);
            return { dispose() { hooks.get(hook).delete(cb); } };
        },
        setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 2; }, clearTimeout() {},
        getParkStorage(name) {
            const own = stored[name] ?? {};
            return { get: (key, def) => key.split(".").reduce((o, k) => o?.[k], own) ?? def, getAll: () => own, set() {} };
        },
        registerAction() {}, executeAction() {},
    },
    ui: { mainViewport: { zoom: 0, rotation: 0, getCentrePosition: () => ({ ...centre }), moveTo() {} } },
    park: { name: "Park" },
    map: { size: { x: 10, y: 10 }, getRide: id => ({ id, name: "Ride", vehicles: [5, 6, 7] }),
           getEntity: id => (id === 6 ? null : { id, trackLocation: { x: 0, y: 0 } }) },
    registerPlugin: meta => sandbox.plugin = meta,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL("../dist/companion-host.js", import.meta.url), "utf8"), sandbox);

const seen = { read: null, ticks: 0 };
const config = { name: "Test", version: "1", file: "test.js", camera: false, debug: false,
    parks: [{ name: "Park", size: { x: 10, y: 10 }, pause: true,
              patches: [{ id: "fademist", set: { intervalTicks: 15, "randomize.viewport.maxDistance": 20, "frames.0.actions.0.randomize.factor": 50 } }] }] };
sandbox.RCTScreensaverCompanionHost(config, (registerPlugin, context, ui, park, console, map) => {
    registerPlugin({ main() {
        seen.read = context.getParkStorage().get("ns.list", []);
        seen.vehicles = map.getRide(1).vehicles;
        seen.rideName = map.getRide(1).name;
        context.subscribe("interval.tick", () => { seen.ticks++; });
    } });
});
sandbox.plugin.main();
const fire = hook => [...(hooks.get(hook) ?? [])].forEach(cb => cb());

assert.deepEqual(JSON.parse(JSON.stringify(seen.read)), [
    { id: "fademist", intervalTicks: 15, randomize: { viewport: { maxDistance: 20 } },
      frames: [{ actions: [{ randomize: { factor: 50 } }] }] },
    { id: "other", intervalTicks: 50 }], "the patch applies to its id only");
assert.equal(stored.Test.ns.list[0].intervalTicks, 50, "the park's own storage is untouched");
assert.deepEqual([...seen.vehicles], [5, 7], "a ride's vehicles leave out entities that are gone");
assert.equal(seen.rideName, "Ride", "the rest of the ride reads through");

for (let i = 0; i < 20; i++) fire("interval.tick");
const still = seen.ticks;
assert.ok(still >= 10, `runs while the camera keeps still (${still} of 20 ticks)`);
for (let i = 0; i < 20; i++) { centre.x += 4; fire("interval.tick"); }
assert.ok(seen.ticks - still <= 1, `paused while the camera moves (${seen.ticks - still} ticks ran)`);
const moved = seen.ticks;
for (let i = 0; i < 20; i++) fire("interval.tick");
assert.ok(seen.ticks - moved >= 10, "resumes once the camera has kept still");
console.log("ok: storage patch and pause during pans");

// pause_above_zoom: held while the viewport is zoomed out beyond the level, whatever the camera does.
config.parks[0].pause = false;
config.parks[0].pauseAboveZoom = 0;
sandbox.plugin.main(); // a fresh start with the new settings (map.changed)
fire("map.changed");
sandbox.ui.mainViewport.zoom = 2;
let before = seen.ticks;
for (let i = 0; i < 20; i++) fire("interval.tick");
assert.equal(seen.ticks - before, 2, "zoomed out: runs its first two ticks (set-up), then paused");
sandbox.ui.mainViewport.zoom = 0;
before = seen.ticks;
for (let i = 0; i < 20; i++) { centre.x += 4; fire("interval.tick"); }
assert.ok(seen.ticks - before >= 18, "runs at the zoom limit, moving or not, without pause_during_pans");
console.log("ok: pause above zoom");

// zoom_rates: a share of the ticks at a zoom level.
config.parks[0].pauseAboveZoom = 1;
config.parks[0].zoomRates = { "1": 0.1 };
fire("map.changed");
sandbox.ui.mainViewport.zoom = 1;
for (let i = 0; i < 2; i++) fire("interval.tick"); // its first ticks run whatever the zoom
before = seen.ticks;
for (let i = 0; i < 100; i++) fire("interval.tick");
assert.ok(Math.abs(seen.ticks - before - 10) <= 1, `a tenth of the ticks at zoom 1 (${seen.ticks - before} of 100)`);
sandbox.ui.mainViewport.zoom = 0;
before = seen.ticks;
for (let i = 0; i < 20; i++) fire("interval.tick");
assert.equal(seen.ticks - before, 20, "every tick at zoom 0");
console.log("ok: zoom rates");
