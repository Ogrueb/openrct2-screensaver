// The visit's cut-in record (Player.remapCues) follows event views when an edit shifts their indices,
// so a cut-in already played is not played again and a pending one still lands on its view.
// Usage: node test/remap-unit.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({ stdin: { contents: 'export { Player } from "./player";',
    resolveDir: new URL("../src", import.meta.url).pathname, loader: "ts" }, bundle: true, format: "esm", write: false, logLevel: "error" });
const { Player } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
const remap = (state, views) => Player.prototype.remapCues.call(state, views);

const v = (x, extra = {}) => ({ x, y: 0, z: 0, rotation: 0, zoom: 0, hold: 5, ...extra });
const cutA = v(10, { animation: "ufo 1", cue: { tick: 400, lead: 2, ticks: 200, cut: true } });
const cutB = v(20, { animation: "ufo 2", cue: { tick: 900, lead: 2, ticks: 200, cut: true } });
const old = [v(1), v(2), cutA, v(3), cutB];

// A view inserted before both and one deleted between them: played and pending follow their views.
{
    const s = { views: old, cutsDone: new Set([2]), pendingCue: { index: 4, at: 880 } };
    remap(s, [v(0), v(1), v(2), { ...cutA }, { ...cutB }]);
    assert.deepEqual([...s.cutsDone], [3], "the played cut-in keeps its record at its new index");
    assert.equal(s.pendingCue.index, 4, "the pending one follows its view");
    assert.equal(s.pendingCue.at, 880, "with its timing");
}
// Reordered: the record goes with the view, not the index.
{
    const s = { views: old, cutsDone: new Set([2]), pendingCue: undefined };
    remap(s, [{ ...cutB }, v(1), { ...cutA }, v(2)]);
    assert.deepEqual([...s.cutsDone], [2]);
    const t = { views: old, cutsDone: new Set([4]), pendingCue: undefined };
    remap(t, [{ ...cutB }, v(1), { ...cutA }, v(2)]);
    assert.deepEqual([...t.cutsDone], [0], "cut-in B moved to the top");
}
// Deleted: the record and a pending cut-in to it go.
{
    const s = { views: old, cutsDone: new Set([2]), pendingCue: { index: 2, at: 380 } };
    remap(s, [v(1), v(2), v(3), { ...cutB }]);
    assert.equal(s.cutsDone.size, 0);
    assert.equal(s.pendingCue, undefined, "no pan to a view that is gone");
}
// Ordinary views carry no record: an index on one is dropped.
{
    const s = { views: old, cutsDone: new Set([1]), pendingCue: undefined };
    remap(s, old.map(x => ({ ...x })));
    assert.equal(s.cutsDone.size, 0);
}
console.log("ok: the cut-in record follows edits");
