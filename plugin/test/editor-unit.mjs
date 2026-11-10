// Checks the live editor's geometry in plugin/src/editor.ts and fit.ts directly: a drag moves the camera
// by the dragged distance on screen at every angle and zoom, and finds the height seen at a screen point
// (where a view set from the camera sits). Usage: node test/editor-unit.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({ stdin: { contents: 'export { surfaceZ } from "./editor"; export { toScreen, toWorld } from "./fit"; export { clip } from "./ui/view-map";',
    resolveDir: new URL("../src", import.meta.url).pathname, loader: "ts" }, bundle: true, format: "esm", write: false, logLevel: "error" });
const { surfaceZ, toScreen, toWorld, clip } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));

// toWorld undoes toScreen on the view's plane, at every angle.
for (let r = 0; r < 4; r++) {
    const p = toScreen(1000, 2000, 96, r);
    const w = toWorld(p, 96, r);
    assert.deepEqual([Math.round(w.x), Math.round(w.y)], [1000, 2000], `round trip at angle ${r}`);
    // A drag moves the picture by exactly the dragged pixels times 2^zoom, height unchanged.
    for (const zoom of [-2, 0, 3]) {
        const q = toWorld({ x: p.x + 100 * 2 ** zoom, y: p.y - 40 * 2 ** zoom }, 96, r);
        const back = toScreen(q.x, q.y, 96, r);
        assert.deepEqual([Math.round((back.x - p.x) / 2 ** zoom), Math.round((back.y - p.y) / 2 ** zoom)], [100, -40],
            `drag at angle ${r} zoom ${zoom}`);
    }
}

// The height seen: flat ground at 48 everywhere is found from any angle.
const flat = () => 48;
for (let r = 0; r < 4; r++) {
    assert.equal(surfaceZ(toScreen(3200, 3200, 48, r), r, flat), 48, `flat ground at angle ${r}`);
}
// A tower (top 400) on tile (100, 100) in front of the ground: the screen point on its top finds 400;
// a point beside it finds the ground.
const tower = (tx, ty) => (tx === 100 && ty === 100 ? 400 : 48);
for (let r = 0; r < 4; r++) {
    const top = toScreen(100 * 32 + 16, 100 * 32 + 16, 400, r);
    assert.equal(surfaceZ(top, r, tower), 400, `tower top at angle ${r}`);
    const beside = toScreen(140 * 32, 60 * 32, 48, r);
    assert.equal(surfaceZ(beside, r, tower), 48, `ground beside the tower at angle ${r}`);
}
// Off the map: nothing.
assert.equal(surfaceZ({ x: 0, y: -5000 }, 0, () => undefined), undefined, "the void");
// The map's pan lines are clipped to the window.
assert.deepEqual(clip(-100, 50, 100, 50, 1920, 1080), [0, 50, 100, 50], "clipped at the left edge");
assert.equal(clip(-100, -50, -10, -5, 1920, 1080), undefined, "a line off the window is dropped");
assert.deepEqual(clip(10, 10, 20, 20, 1920, 1080), [10, 10, 20, 20], "a line inside is kept");
console.log("ok: live editor geometry (drag, height under the centre)");
