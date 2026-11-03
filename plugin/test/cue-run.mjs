// Event-timed views (View.cue) against a minimal mock of the title screen with moving trains:
// a view waits for a car on its tiles and stays while the effect runs, the camera follows the
// cued train, a missed cue gives up after its wait, and a cut-in view on the park's clock
// interrupts playback once (panning there, as it has a lead) and hands back to the view after
// the one it cut; the park stays until its timeline view has played.
//
// Usage: node test/cue-run.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const view = (x, y, hold, extra = {}) => ({ x, y, z: 64, rotation: 0, zoom: 0, hold, ...extra });
const playlist = {
    version: 1, sequence: "Cues", screen: [1920, 1080],
    parks: [
        { key: "a.park", name: "A", fileName: "a.park", load: 0, views: [
            view(10, 10, 5),
            // A continuous animation's view placed as a stop of the route (fixed): plays in its place
            view(30, 30, 5, { animation: "loop", fixed: true }),
            view(50, 50, 5),
            // Event views play after the others. This one waits for a car of ride 3 on tiles
            // 20-21 x 30, then 200 ticks of effect, the camera following ride 7's train
            view(20, 30, 2, { animation: "lift", cue: { ride: 3, tiles: [20, 30, 21, 30], ticks: 200, wait: 30, follow: 7 } }),
            // A car of ride 9 never comes: gives up 4 s past its hold
            view(40, 40, 2, { animation: "never", cue: { ride: 9, tiles: [0, 0, 0, 0], ticks: 100, wait: 4 } }),
        ] },
        { key: "b.park", name: "B", fileName: "b.park", load: 2, views: [
            view(5, 5, 20), // shorter than the wait for its timeline view: the park loops
            // Cuts in on the park's clock: 2 s before tick 1600, effect 400 ticks
            view(60, 60, 1, { animation: "timeline", cue: { tick: 1600, lead: 2, ticks: 400, cut: true } }),
            // The next event, due while the first is still on screen (its tail): the camera pans
            // from one to the other, without the ordinary view between them
            view(80, 70, 1, { animation: "timeline 2", cue: { tick: 2150, lead: 2, ticks: 200, cut: true } }),
            // Due 2.25 s after the second one ends: the camera pans on to it at once (a longer
            // lead) instead of cutting to the ordinary view for a moment
            // ...and pans on (back to the park's first view, the park's last pan) once its effect is over
            view(100, 90, 4, { animation: "timeline 3", pan: 0.5, cue: { tick: 2600, lead: 2, ticks: 200, cut: true } }),
        ] },
    ],
};
const commands = [{ type: "load", index: 0 }, { type: "wait" }, { type: "load", index: 1 }, { type: "wait" }];

const loads = [];
const sequence = {
    name: "Cues", parks: [{ fileName: "a.park" }, { fileName: "b.park" }], commands, isPlaying: false, position: null,
    play() { this.isPlaying = true; this.position = 1; loads.push(0); },
    seek(i) { this.position = i + 1; loads.push(commands[i].index); },
};

// Trains: ride 3 has one train of two cars; ride 7 one train whose head is car 70.
const entities = {
    30: { id: 30, type: "car", ride: 3, x: 0, y: 0, z: 0, nextCarOnTrain: 31 },
    31: { id: 31, type: "car", ride: 3, x: 0, y: 0, z: 0, nextCarOnTrain: null },
    70: { id: 70, type: "car", ride: 7, x: 32 * 25, y: 32 * 30, z: 200, nextCarOnTrain: null },
};
const rides = { 3: { vehicles: [30] }, 7: { vehicles: [70] }, 9: { vehicles: [99] } }; // 99: stale id

let now = 0;
const store = { RCTScreensaver: { playlist, settings: { debug: false, fadeMs: 0, cameraLog: true } } };
const lookup = key => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), store);
const viewport = { rotation: 0, zoom: 0, centre: { x: 0, y: 0 },
    moveTo(c) { this.centre = c; }, getCentrePosition() { return this.centre; } };
const intervals = [];
const tickHooks = [];
const logs = [];
let plugin;
const context = {
    mode: "title", gameSpeed: 1,
    sharedStorage: {
        get: (k, d) => lookup(k) ?? d,
        set: (k, v) => { const parts = k.split("."); const last = parts.pop();
            parts.reduce((o, p) => (o[p] ??= {}), store)[last] = v; },
    },
    getRandom: (min, max) => min + Math.floor(Math.random() * (max - min)),
    executeAction(name, args, cb) { this.gameSpeed = args.speed; cb?.({}); },
    registerAction() {},
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    subscribe(hook, fn) { if (hook === "interval.tick") tickHooks.push(fn); return { dispose() {} }; },
};
const sandbox = {
    context,
    map: { getTile: () => ({ elements: [] }), getRide: id => rides[id] ?? null, getEntity: id => entities[id] ?? null },
    titleSequenceManager: { titleSequences: [sequence] },
    ui: { width: 1920, height: 1080, registerShortcut() {}, registerToolboxMenuItem() {}, openWindow() { return {}; },
          mainViewport: viewport },
    registerPlugin: p => { plugin = p; },
    console: { log: m => { logs.push(m); if (process.env.VERBOSE) process.stdout.write(m + "\n"); } },
    Date: { now: () => now },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL("../dist/rct-screensaver.js", import.meta.url), "utf8"), sandbox);
plugin.main();

let ticks = 0; // game ticks since the start
const tick = (ms = 100) => {
    for (let t = 0; t < ms; t += 100) {
        for (let i = 0; i < 4; i++) { now += 25; ticks++; tickHooks.forEach(fn => fn()); intervals.filter(v => v.ms < 100).forEach(v => v.fn()); }
        intervals.filter(v => v.ms >= 100).forEach(v => v.fn());
    }
};
const tileOf = () => [Math.round((viewport.centre.x - 16) / 32), Math.round((viewport.centre.y - 16) / 32)];
const at = v => tileOf()[0] === v.x && tileOf()[1] === v.y;
const views = playlist.parks[0].views;

tick(); tick();
assert.ok(at(views[0]), "first view");
tick(5000);
assert.ok(at(views[1]), "a route stop on an animation plays in its place");
tick(5000);
assert.ok(at(views[2]), "second view");
tick(5000);
assert.ok(at(views[3]), "the event view comes in its turn");
tick(10000);
assert.ok(at(views[3]), "it waits past its hold for its cue");
// Ride 3's second car reaches the tiles: the cue fires, the view stays the effect's 200 ticks
entities[31].x = 32 * 21 + 5; entities[31].y = 32 * 30 + 5;
tick(200);
assert.ok(logs.some(l => l.includes("camera") && l.includes(" cue fired")), "the cue fires on any car of the train");
// The camera log notes every arrival on a car cue's tiles, for measuring a trigger's timing
assert.ok(logs.some(l => / trigger view=4 tick=\d+ \| lift \| A$/.test(l)), "the camera log notes the trigger");
entities[31].x = 0;
tick(3000);
const [fx, fy] = tileOf();
assert.ok(fx > 20 && fx <= 25 && fy === 30, `the camera follows ride 7's train: ${tileOf()}`);
tick(4000);
assert.ok(tileOf()[0] === 40, `the view ends after the effect and its tail: ${tileOf()}`);
const waitStart = now;
while (tileOf()[0] === 40 && now - waitStart < 20000) tick();
assert.ok(now - waitStart >= 5900 && now - waitStart <= 6300, `a missed cue gives up after hold + wait: ${now - waitStart} ms`);
tick(); tick();
assert.equal(loads.at(-1), 1, "then the next park");
const parkB = playlist.parks[1].views;
assert.ok(at(parkB[0]), "park B's view; its cut-in view is not in the order");
const loadTick = ticks;
// The park's clock reaches tick 1600 - 2 s: the timeline view cuts in
while (!at(parkB[1]) && ticks - loadTick < 2400) tick();
assert.ok(at(parkB[1]), "the cut-in view interrupts playback");
// With a lead, the camera pans there from the view it interrupts, setting off at tick 1520
assert.ok(logs.some(l => l.includes(" cue divert ")), "a cut-in with a lead pans to its view");
assert.ok(ticks - loadTick > 1520 && ticks - loadTick <= 1680, `on the park's clock: tick ${ticks - loadTick}`);
// It stays through its effect, until the next timeline event's lead (tick 2150 - 2 s) pans on
while (at(parkB[1]) && ticks - loadTick < 3000) tick();
assert.ok(ticks - loadTick >= 2000 && ticks - loadTick <= 2160, `the cut-in view stays for its effect: tick ${ticks - loadTick}`);
let sawOrdinary = false;
while (!at(parkB[2]) && ticks - loadTick < 3000) { tick(); sawOrdinary ||= at(parkB[0]); }
assert.equal(logs.filter(l => l.includes(" cue divert ")).length, 2, "the camera pans from one timeline view to the next");
assert.ok(at(parkB[2]) && !sawOrdinary, `straight to the next timeline view, not back to the ordinary one: ${tileOf()}`);
// It stays until tick 2150 + 200 + the tail, then pans straight on to the third
while (at(parkB[2]) && ticks - loadTick < 3000) tick();
assert.ok(Math.abs(ticks - loadTick - 2430) <= 8, `the second timeline view stays for its effect: tick ${ticks - loadTick}`);
sawOrdinary = false;
while (!at(parkB[3]) && ticks - loadTick < 3200) { tick(); sawOrdinary ||= at(parkB[0]); }
assert.equal(logs.filter(l => l.includes(" cue divert ")).length, 3, "a cut-in ending just before the next one's lead pans on to it");
assert.ok(at(parkB[3]) && !sawOrdinary, `no ordinary view between them: ${tileOf()}`);
// The last stays until tick 2600 + 200 + the tail, then pans back to the park's first view
while (at(parkB[3]) && ticks - loadTick < 3200) tick();
assert.ok(ticks - loadTick >= 2880 && ticks - loadTick <= 2980, `the last timeline view stays for its effect, then pans: tick ${ticks - loadTick}`);
while (!at(parkB[0]) && loads.at(-1) === 1 && ticks - loadTick < 3400) tick();
assert.ok(at(parkB[0]) && loads.at(-1) === 1, `an event view whose end is known pans on: ${tileOf()}`);
while (loads.at(-1) === 1 && ticks - loadTick < 3600) tick();
tick(); tick();
assert.equal(loads.at(-1), 0, "the view it cut was the park's last: the next park follows");
console.log(`ok: event cues (route stop, car cue, follow, missed cue, cut-in), ${logs.filter(l => l.includes(" cue ")).length} cue log lines`);
