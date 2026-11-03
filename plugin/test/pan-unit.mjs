// Checks plugin/src/pan.ts directly: where a pan's angle and zoom changes go, its lead, its speed
// limit and its ease. Usage: node test/pan-unit.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({ entryPoints: [new URL("../src/pan.ts", import.meta.url).pathname], bundle: true,
    format: "esm", write: false, logLevel: "error" });
const { Pan } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));

const pose = (x, rotation, zoom) => ({ x: x * 32, y: 0, z: 0, rotation, zoom });
const pan = (from, to, changes = "end", inertia = false) => new Pan(from, to, 4000, () => 100, changes, inertia, 2000, 1000);
const travel = p => p.at(p.lead + 1); // just after it starts moving

// One step at the chosen end.
let p = pan(pose(0, 0, 0), pose(3, 1, -1));
assert.deepEqual([travel(p).rotation, travel(p).zoom, p.lead], [0, 0, 0], "end: travels as the view it leaves");
p = pan(pose(0, 0, 0), pose(3, 1, -1), "start");
assert.deepEqual([travel(p).rotation, travel(p).zoom, p.lead], [1, -1, 2000], "start: changes, then waits");
p = pan(pose(0, 0, 0), pose(3, 3, 0), "start");
assert.equal(travel(p).rotation, 3, "turns the short way");
// A change on arrival waits until the camera has rested 1 s at the next spot.
p = pan(pose(0, 0, 0), pose(3, 1, -1));
assert.deepEqual([p.rest, p.duration], [1000, 5000], "end: a rest before the change");
assert.deepEqual([p.at(4000).x, p.at(4900).x, p.at(4900).rotation, p.at(4900).zoom], [96, 96, 0, 0], "rests at the spot, unchanged");
assert.deepEqual(p.at(5000), pose(3, 1, -1), "then changes");
assert.equal(pan(pose(0, 0, 0), pose(3, 1, -1), "start").rest, 0, "no rest without a change on arrival");
// Two steps: one at each end.
p = pan(pose(0, 0, 0), pose(3, 2, 0));
assert.deepEqual([travel(p).rotation, p.changesAtStart, p.changesAtEnd], [1, true, true], "opposite angles: a step at each end");
p = pan(pose(0, 1, -1), pose(3, 1, 1));
assert.equal(travel(p).zoom, 0, "two zoom levels: one at each end");
p = pan(pose(0, 1, -2), pose(3, 1, 1));
assert.equal(travel(p).zoom, -1, "three: the larger half at the chosen end");
p = pan(pose(0, 1, -2), pose(3, 1, 1), "start");
assert.equal(travel(p).zoom, 0, "with start, the larger half first");
// Speed limit: one level out between views at one zoom; between zooms, the wider zoom at most.
p = pan(pose(0, 0, -1), pose(40, 0, -1));
assert.ok(travel(p).zoom === 0 && p.changesAtStart && p.changesAtEnd, "far at one zoom: one level out and back in");
p = pan(pose(0, 0, -1), pose(40, 0, 0));
assert.ok(travel(p).zoom === 0 && p.changesAtStart && !p.changesAtEnd, "far between zooms: travels at the wider zoom");
p = pan(pose(0, 0, -2), pose(80, 0, -1));
assert.equal(travel(p).zoom, -1, "far between zooms: never past the wider zoom");
p = pan(pose(0, 0, -1), pose(3, 0, 0));
assert.ok(travel(p).zoom === -1 && !p.changesAtStart, "near between zooms: changes at the chosen end");
// Tolerance by the zoom the pan runs at (500 px/s at -2, 100 less per level out): along x a tile is
// 35.8 zoom-0 px, so 10 tiles in 4 s at zoom -1 is 179 px/s (fine) and 30 tiles 537 (over 400; at
// zoom 0, 268 is under 300).
const tol = z => Math.max(100, 500 - 100 * (z + 2));
const tpan = (from, to, changes = "end") => new Pan(from, to, 4000, tol, changes, false, 2000, 1000);
assert.equal(travel(tpan(pose(0, 0, -1), pose(10, 0, -1))).zoom, -1, "within the tolerance at its zoom: no zoom-out");
assert.equal(travel(tpan(pose(0, 0, -1), pose(30, 0, -1))).zoom, 0, "over it: one level out");
assert.equal(travel(tpan(pose(0, 0, -1), pose(10, 0, 0), "start")).zoom, 0, "runs at the zoom set at the start");
assert.equal(travel(tpan(pose(0, 0, 1), pose(40, 0, -1))).zoom, 1, "runs at the wider zoom it leaves");
// Ease: linear is halfway at half time; inertia lags behind, then catches up.
p = pan(pose(0, 0, 0), pose(10, 0, 0));
assert.equal(p.at(2000).x, 160, "linear: halfway");
const q = pan(pose(0, 0, 0), pose(10, 0, 0), "end", true);
assert.ok(q.at(1000).x < p.at(1000).x / 2 && q.at(2000).x === 160, "inertia: slow start, halfway at half time");
assert.deepEqual(q.at(4000), pose(10, 0, 0), "arrives exactly");
// Return pan to a wider view: one level out at the start, moving at once, the rest mid-pan, equal
// time per level at one screen speed (so the distance doubles each level), the turn on arrival
// after the rest.
const r = new Pan(pose(0, 0, -2), pose(70, 2, 1), 4000, () => 100, "end", false, 2000, 1000, true);
assert.deepEqual([r.levels, r.lead, r.rest, r.changesAtEnd], [[-1, 0, 1], 0, 1000, true], "return: levels -1..1, no lead, rest before the turn");
assert.deepEqual([r.at(1).rotation, r.at(1).zoom], [0, -1], "steps out as it sets off, keeping its angle");
assert.ok(r.at(100).x > 0, "and moves at once");
const third = 4000 / 3;
assert.equal(r.at(third + 10).zoom, 0, "second level a third of the way in time");
assert.ok(Math.abs(r.at(third).x - 70 * 32 / 7) < 1, "having covered 1/7 of the way");
assert.ok(Math.abs(r.at(2 * third).x - 70 * 32 * 3 / 7) < 1, "then 3/7 at the third level");
assert.equal(r.at(3999).zoom, 1, "the widest level last");
assert.deepEqual([r.at(4500).rotation, r.at(4500).zoom, r.at(4500).x], [0, 1, 70 * 32], "rests at the spot");
assert.deepEqual(r.at(5000), pose(70, 2, 1), "then turns to the first view");
assert.equal(Math.round(r.speed), Math.round(70 * 35.78 / (3.5 * 4 / 3)), "one screen speed");
assert.equal(new Pan(pose(0, 0, 0), pose(5, 1, 0), 4000, () => 100, "end", false, 2000, 1000, true).levels.length, 1,
    "return to a view no wider: an ordinary pan");
console.log("ok: pan");

// Window scaling (src/scale.ts): whole zoom levels out until the window shows at least the frame
// the views were set for on both sides, up to a quarter level tighter before stepping out.
{
    const out = await build({ entryPoints: [new URL("../src/scale.ts", import.meta.url).pathname], bundle: true,
        format: "esm", write: false, logLevel: "error" });
    const { scalingFor, scaleTolerance, scaleViews } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
    const design = { width: 3840, height: 2160 };
    const offset = (width, height) => scalingFor(design, { width, height }).offset;
    assert.equal(offset(3840, 2160), 0, "the design window plays as framed");
    assert.equal(offset(1920, 1080), 1, "1080p: one level out");
    assert.equal(offset(2560, 1440), 1, "1440p: one level out rather than half again too close");
    assert.equal(offset(3440, 1440), 1, "21:9 ultrawide: by its height");
    assert.equal(offset(1920, 1200), 1, "16:10: by its width");
    assert.equal(offset(1366, 768), 2, "1366x768: two levels");
    assert.equal(offset(1280, 1024), 2, "5:4: by its width");
    assert.equal(offset(3600, 2025), 0, "a little smaller keeps the zoom");
    assert.equal(offset(7680, 4320), -1, "8K: one level in");
    assert.equal(offset(5120, 2880), 0, "5K keeps the zoom");
    assert.equal(scalingFor(undefined, { width: 1920, height: 1080 }).offset, 0, "unknown frame: as set");
    const views = scaleViews([{ zoom: -2 }, { zoom: 3 }], scalingFor(design, { width: 1920, height: 1080 }));
    assert.deepEqual(views.map(v => v.zoom), [-1, 3], "zooms move and stay in range");
    // 500 px/s at -2 on the 4K window is 250 at 1080p, at the zoom the same frame plays at.
    const tol = scaleTolerance(z => Math.max(100, 500 - 100 * (z + 2)), scalingFor(design, { width: 1920, height: 1080 }));
    assert.deepEqual([tol(-1), tol(0), tol(3)], [250, 200, 50], "the tolerance follows the frame's zoom and the window's size");
    const big = scaleTolerance(() => 500, scalingFor(design, { width: 7680, height: 4320 }));
    assert.equal(big(-2), 500, "never above the measured pixel speed");
    console.log("ok: scale");
}

// Fitting (src/fit.ts): a route stop on an animation, wide and first after the overview, neither
// stands in for the park's close-ups nor turns a short park into turns of one wide view.
{
    const out = await build({ entryPoints: [new URL("../src/fit.ts", import.meta.url).pathname], bundle: true,
        format: "esm", write: false, logLevel: "error" });
    const { fitViews } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
    const bounds = { x0: 20, y0: 20, x1: 120, y1: 120, z0: 0, z1: 200 };
    const v = (x, y, zoom, extra = {}) => ({ x, y, z: 64, rotation: 3, zoom, hold: 10, ...extra });
    const views = [v(70, 70, 2, { overview: true }), v(80, 60, 2, { animation: "mist", fixed: true }),
        v(40, 40, -2), v(100, 50, -1), v(60, 100, -2)];
    const fitted = fitViews(views, bounds, { width: 1920, height: 1080 }, views.length + 1);
    assert.equal(fitted.length, 5, `a budget it cannot reach keeps the views: ${fitted.map(f => f.zoom)}`);
    assert.ok(fitted.some(f => f.animation === "mist") && fitted.filter(f => f.zoom < 0).length === 3, "close-ups and the stop kept");
    console.log("ok: fit");
}

// Listing (src/storage.ts): cut-in views sit after the route view on screen when they first come
// due, in time order; past the route's end, after its last view; waiting views do not count.
{
    const out = await build({ entryPoints: [new URL("../src/storage.ts", import.meta.url).pathname], bundle: true,
        format: "esm", write: false, logLevel: "error" });
    const { placeCuts } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
    const v = (name, hold, extra = {}) => ({ name, x: 0, y: 0, z: 0, rotation: 0, zoom: 0, hold, ...extra });
    const cut = (name, tick, lead) => v(name, 6, { animation: name, cue: { tick, lead, cut: true, ticks: 100 } });
    const views = [v("a", 10), v("b", 10), v("c", 10), v("wait", 20, { animation: "w", cue: { ticks: 10 } }),
        cut("late", 4000, 0), cut("second", 1000, 3), cut("first", 900, 3), cut("early", 0, 3)];
    assert.deepEqual(placeCuts(views).map(x => x.name), 
        ["a", "early", "b", "first", "c", "second", "late", "wait"], "cut-ins listed by time");
    console.log("ok: cut-in listing");
}
