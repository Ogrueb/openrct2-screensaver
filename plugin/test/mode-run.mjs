// Runs the built plugin with a mock of the patched engine's `screensaver` global (engine patches
// 0011-0013): playback starts only when the mode comes on and stops (handing the title screen back
// to the user's own sequence) when it goes off; keys act only in the mode; the mode gets the
// plugin's settings; nothing is added to the toolbox.
//
// Usage: node test/mode-run.mjs <playlist.json>
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
// SCENE_DIR=<folder>: the overlay's scene at a few points, as JSON, for drawing it outside the game.
const dump = name => { if (process.env.SCENE_DIR) fs.writeFileSync(path.join(process.env.SCENE_DIR, `${name}.json`), JSON.stringify([...scene])); };

const playlist = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let now = 0;
const store = { RCTScreensaver: { playlist, settings: { fadeMs: 0, titleMusic: "ride", window: "windowed" } } };
const lookup = key => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), store);
const commands = [];
playlist.parks.forEach((p, i) => { commands[p.load] = { type: "load", index: i }; commands[p.load + 1] = { type: "wait" }; });
const sequence = {
    name: playlist.sequence, parks: playlist.parks.map(p => ({ fileName: p.fileName })), commands,
    isPlaying: false, position: null, stops: 0,
    play() { this.isPlaying = true; this.position = 1; },
    seek(i) {
        if (!this.backgroundLoading) { this.position = i + 1; return; }
        // Patch 0014: the park is read in the background, ready a second later, and switched to
        // only once the plugin lets go of the switch.
        this.position = i; this.readyAt = now + 1000; this.nextParkReady = false;
    },
    advance() {
        if (!this.backgroundLoading || this.readyAt === undefined || now < this.readyAt) return;
        this.nextParkReady = true;
        if (!this.holdSwitch) { this.position++; this.readyAt = undefined; this.nextParkReady = false; this.switchedAt = now; }
    },
    stop() { this.isPlaying = false; this.stops++; },
};
// The overlay (patch 0013): the scene as the engine holds it.
const scene = new Map();
const overlay = {
    scale: 2,
    set(id, e) { scene.set(id, { ...e }); },
    remove(id) { scene.delete(id); },
    clear() { scene.clear(); },
    fade(id, opacity) { const e = scene.get(id); if (e) e.opacity = opacity; },
    measureText(text, style) { return { width: text.length * (style.size ?? 12) * 0.55, height: (style.size ?? 12) * 1.25 }; },
    setDefaultFonts() {},
};
const mode = {
    active: false, launchedByFlag: false, configured: [], listeners: [], mouse: [], cursorVisible: true, overlay,
    configure(s) { this.configured.push(s); },
    onChange(cb) { this.listeners.push(cb); },
    onMouse(cb) { this.mouse.push(cb); },
    set(active) { this.active = active; this.listeners.forEach(cb => cb(active)); },
    exits: 0,
    exit() { this.exits++; },
};
const shortcuts = {};
const toolbox = [];
const intervals = [];
const logs = [];
let plugin;
const saved = {}; // what the plugin wrote to shared storage, by key
const viewport = { rotation: 0, zoom: 0, centre: { x: 0, y: 0 },
    moveTo(c) { this.centre = c; }, getCentrePosition() { return this.centre; } };
const gameConfig = { "general.drawing_engine": 1, "sound.master_volume": 80, "sound.sound_volume": 100, "sound.ride_music_volume": 60, "general.multithreading": true };
const context = {
    mode: "title", gameSpeed: 1, configuration: { get: k => gameConfig[k] },
    sharedStorage: { get: (k, d) => lookup(k) ?? d, set(k, v) { saved[k] = v; } },
    getRandom: (min, max) => min,
    executeAction(name, args, cb) { this.gameSpeed = args.speed; cb?.({}); },
    registerAction() {},
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    subscribe() { return { dispose() {} }; },
};
const sandbox = {
    context, screensaver: mode,
    map: { getTile: () => ({ elements: [{ type: "surface", baseZ: 48 }] }), getRide: () => null, getEntity: () => null },
    titleSequenceManager: { titleSequences: [sequence] },
    ui: { width: 1920, height: 1080, registerShortcut: d => { shortcuts[d.id] = d.callback; },
          registerToolboxMenuItem: name => toolbox.push(name), openWindow: () => ({ close() {}, findWidget: () => ({}) }),
          mainViewport: viewport },
    registerPlugin: p => { plugin = p; },
    console: { log: m => { logs.push(m); if (process.env.VERBOSE) process.stdout.write(m + "\n"); } },
    Date: { now: () => now },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL("../dist/rct-screensaver.js", import.meta.url), "utf8"), sandbox);
plugin.main();
const tick = (n = 1) => { for (let k = 0; k < n; k++) { now += 100; sequence.advance(); intervals.forEach(v => v.fn()); } };

assert.equal(toolbox.length, 0, "nothing is added to the toolbox on the patched engine");
assert.equal(mode.configured.length, 1, "the mode gets the plugin's settings at start");
assert.deepEqual(JSON.parse(JSON.stringify(mode.configured[0])),
    { window: "windowed", titleMusic: 5, gameSpeed: null, lightEffects: false, weatherGloom: false, weather: false, timeOfDay: "day",
      masterVolume: null, soundVolume: null, musicVolume: null, drawingEngine: null, multiThreading: null });

tick(20);
assert.equal(sequence.isPlaying, false, "no playback on the stock title screen");
shortcuts["rctscreensaver.next"]();
assert.equal(sequence.isPlaying, false, "keys do nothing outside the mode");

mode.set(true);
tick(5);
assert.equal(sequence.isPlaying, true, "playback starts with the mode");
assert.ok(logs.some(l => l.includes("playing")), "the player started");
shortcuts["rctscreensaver.hold"]();
assert.ok(logs.length > 0);

// The controls bar: hidden with the cursor on entry, shown by a mouse move, hidden again after the
// mouse has been still; its buttons act as the keys do.
const mouse = (type, x, y, button = 0, delta = 0) => mode.mouse.forEach(cb => cb({ type, x, y, button, delta }));
const shown = id => (scene.get("rcts.bar." + id)?.opacity ?? 0) > 0;
const centre = id => { const e = scene.get("rcts.bar." + id); return [e.x + e.width / 2, e.y + e.height / 2]; };
const click = (id, button = 0) => { const [x, y] = centre(id); mouse("move", x, y); mouse("down", x, y, button); mouse("up", x, y, button); };
shortcuts["rctscreensaver.hold"](); // release the view held above
assert.ok(scene.has("rcts.bar.strip"), "the bar is in the overlay");
assert.equal(shown("strip"), false, "the bar starts hidden");
assert.equal(mode.cursorVisible, false, "and so does the cursor");
mouse("move", 10, 10);
assert.equal(shown("strip"), true, "a mouse move shows the bar");
assert.equal(mode.cursorVisible, true);
tick(30);
assert.equal(shown("strip"), false, "the bar hides after the mouse is still");
assert.equal(mode.cursorVisible, false);
for (const id of ["prevPark", "prevView", "hold", "nextView", "nextPark", "speed", "shuffle", "titles", "music"]) {
    assert.ok(scene.has(`rcts.bar.${id}`), `button ${id}`);
}
for (const [id, e] of scene) {
    if (e.type === "image" && !e.src.startsWith("sprite:")) {
        assert.ok(fs.existsSync(new URL("../icons/" + e.src.split("/").pop(), import.meta.url)), `${id}: icon ${e.src} exists`);
    }
}
// The stock exit button in the bottom right corner, shown with the bar; a click does what Esc does.
{
    const q = scene.get("rcts.bar.quit");
    assert.deepEqual([q.x + q.width, q.y + q.height, q.width, q.height], [sandbox.ui.width, sandbox.ui.height, 40, 64], "the exit button sits where the stock one does");
    assert.equal(scene.get("rcts.bar.quit.icon").src, "sprite:23210", "it shows the stock exit sprite");
    click("quit");
    assert.equal(mode.exits, 1, "a click on it leaves the mode, as Esc does");
}
click("hold");
assert.equal(scene.get("rcts.bar.hold.icon").src.includes("/play-"), true, "hold shows play while held");
assert.ok(scene.has("rcts.bar.tip"), "a tooltip over the button under the mouse");
assert.ok(logs.some(l => l.includes("holding view")));
click("hold");
assert.ok(logs.some(l => l.includes("released view")));
click("nextView");
click("speed");
assert.equal(scene.get("rcts.bar.speed.text").text, "2×", "speed steps up on a click");
click("speed");
assert.equal(scene.get("rcts.bar.speed.text").text, "4×", "speed tiers are 1×, 2×, 4×, 8×");
click("speed");
assert.equal(scene.get("rcts.bar.speed.text").text, "8×");
mouse("move", 1, 1);
assert.equal(scene.get("rcts.bar.speed").fill, "#c8782ab3", "8× is orange");
click("speed");
mouse("move", 1, 1);
assert.equal(scene.get("rcts.bar.speed").fill, "#3d7a50b3", "1× is green");
click("speed");
click("speed", 1);
assert.equal(scene.get("rcts.bar.speed.text").text, "1×", "and down on a right click");
click("shuffle");
assert.ok(logs.some(l => l.includes("shuffle on")));
const configured = mode.configured.length;
click("music");
assert.equal(mode.configured.length, configured + 1, "music is applied to the mode at once");
assert.equal(mode.configured.at(-1).titleMusic, 0, "ride music -> off");
assert.ok(scene.get("rcts.bar.music.icon").src.includes("music-off"));
click("music");
assert.equal(mode.configured.at(-1).titleMusic, 5, "off -> ride music (a toggle)");
// Rows: the secondary buttons sit on a row below the primary ones.
assert.ok(scene.get("rcts.bar.speed").y > scene.get("rcts.bar.hold").y + scene.get("rcts.bar.hold").height, "secondary row below");
{
    const span = (ids) => { const es = ids.map(i => scene.get("rcts.bar." + i)); return Math.max(...es.map(e => e.x + e.width)) - Math.min(...es.map(e => e.x)); };
    assert.ok(span(["speed", "shuffle", "titles", "music", "time", "edit", "settings"]) <= span(["prevPark", "prevView", "hold", "nextView", "nextPark"]),
        "the secondary row is no wider than the primary row");
}
// The settings panel: the stock options that apply to the mode, applied at once.
assert.equal(scene.has("rcts.bar.panel"), false);
click("settings");
assert.ok(scene.has("rcts.bar.panel"), "the settings button opens the panel");
assert.equal(scene.get("rcts.bar.option.window.text").text, "Windowed");
click("option.window");
assert.equal(mode.configured.at(-1).window, "keep", "window style cycles and is applied");
// Light effects can be set whatever the renderer and time of day (owner, 2026-11-02).
click("option.lightEffects");
assert.equal(mode.configured.at(-1).lightEffects, true, "light effects set under OpenGL by day");
assert.equal(scene.get("rcts.bar.option.lightEffects.text").text, "On");
click("option.lightEffects");
assert.equal(scene.get("rcts.bar.option.renderer.text").text, "As in Options");
assert.equal(scene.get("rcts.bar.option.multiThreading.text").text, "On", "multithreading starts as the game's own");
click("option.multiThreading");
assert.equal(mode.configured.at(-1).multiThreading, false, "multithreading applied");
assert.equal(scene.get("rcts.bar.option.multiThreading.text").text, "Off");
click("option.renderer");
assert.equal(mode.configured.at(-1).drawingEngine, "software", "the renderer is applied at once");
assert.ok(scene.get("rcts.bar.time.icon").src.includes("/day-"), "time of day starts at day");
click("time");
assert.equal(mode.configured.at(-1).timeOfDay, "night", "night applied");
assert.ok(scene.get("rcts.bar.time.icon").src.includes("/night-"), "night icon");
assert.equal(scene.get("rcts.bar.time.t").fill, "#00000099", "night is sunk (on)");
click("time");
assert.equal(mode.configured.at(-1).timeOfDay, "cycle", "cycle applied");
assert.ok(scene.get("rcts.bar.time.icon").src.includes("/day-night-"), "cycle icon");
click("option.lightEffects");
assert.equal(mode.configured.at(-1).lightEffects, true);
click("option.renderer");
assert.equal(mode.configured.at(-1).drawingEngine, "opengl");
click("option.weather");
assert.equal(mode.configured.at(-1).weather, true, "changing weather applied");
click("option.weatherGloom");
assert.equal(mode.configured.at(-1).weatherGloom, true);
assert.equal(scene.get("rcts.bar.panel.masterVolume").text, "Master volume  80%", "volumes start as the game's own");
{
    const r = scene.get("rcts.bar.option.musicVolume");
    const y = r.y + r.height / 2;
    mouse("move", r.x + 1, y); mouse("down", r.x + 1, y);
    mouse("move", r.x + r.width / 2, y);
    mouse("up", r.x + r.width / 2, y);
    const v = mode.configured.at(-1).musicVolume;
    assert.ok(v >= 45 && v <= 55, `dragging a slider sets the volume (${v})`);
    assert.equal(mode.configured.at(-1).masterVolume, null, "untouched volumes stay the game's own");
}
mouse("move", 5, 5); mouse("down", 5, 5); mouse("up", 5, 5);
assert.equal(scene.has("rcts.bar.panel"), false, "a click elsewhere closes the panel");
click("titles");
assert.ok(scene.get("rcts.bar.titles.icon").src.includes("/titles-"), "titles overview -> on");
assert.equal(scene.get("rcts.bar.titles").fill, "#a8963ac0", "titles on every view take the alternate colour (hovered)");
click("titles");
assert.ok(scene.get("rcts.bar.titles.icon").src.includes("titles-off"), "on -> off");
// The view editor on the overlay: opened by the bar's edit button, it stays up with the bar.
{
    const ed = id => scene.get("rcts.ed." + id);
    const edClick = id => { const e = ed(id); const x = e.x + e.width / 2, y = e.y + e.height / 2; mouse("move", x, y); mouse("down", x, y); mouse("up", x, y); };
    click("edit");
    assert.ok(ed("frame"), "the edit button opens the editor panel");
    assert.ok(ed("frame").y + ed("frame").height < 1080 - 120, "the panel fits above the bar in a 1080 window");
    assert.ok(scene.get("rcts.bar.edit.icon").src.includes("/edit-"), "edit icon");
    const rows = [...scene.keys()].filter(k => /^rcts\.ed\.cell\.\d+\.0$/.test(k)).length;
    assert.ok(rows > 0, "the park's views are listed");
    assert.equal(ed("text.park").text.length > 0, true, "the park's name heads the panel");
    edClick("row.0");
    assert.ok(ed("text.hold").text.startsWith("Hold view 1:"), "a click on a row selects its view");
    edClick("holdMore");
    assert.ok(ed("text.hold").text.startsWith("Hold view 1:"), "the hold changes on the selected view");
    edClick("add");
    const after = [...scene.keys()].filter(k => /^rcts\.ed\.cell\.\d+\.0$/.test(k)).length;
    assert.equal(after, Math.min(rows + 1, 10), "Add view adds a row");
    assert.equal(ed("cell.1.6").text, "you", "the added view is set by hand");
    tick(40);
    assert.equal(shown("strip"), true, "the bar stays up while the editor is open");
    shortcuts["rctscreensaver.hold"]();
    assert.ok(ed("play.text").text.startsWith("Play: on"), "Space starts Play in the editor");
    shortcuts["rctscreensaver.hold"]();
    assert.equal(ed("play.text").text, "Play: off", "and stops it");
    assert.equal(ed("text.hold").y, ed("text.pan").y, "hold and pan share a line");
    // Past ten views: a scroll bar (arrows, thumb) beside the list; the arrows and the wheel scroll.
    for (let i = 0; i < 12 && !ed("scrollDown"); i++) edClick("add");
    assert.ok(ed("scrollDown") && ed("scrollUp") && ed("thumb"), "more than ten views get a scroll bar");
    edClick("row.0"); // select the first view, so the list is at the top
    assert.equal(ed("cell.0.0").text, "1");
    edClick("scrollDown");
    assert.equal(ed("cell.0.0").text, "2", "the down arrow scrolls the list");
    edClick("scrollUp");
    assert.equal(ed("cell.0.0").text, "1", "the up arrow scrolls back");
    const c = ed("cell.3.0");
    mouse("move", c.x + 2, c.y + 4);
    mouse("wheel", c.x + 2, c.y + 4, 0, -1);
    assert.equal(ed("cell.0.0").text, "2", "the wheel scrolls the list");
    assert.ok(![...scene.keys()].some(k => k.startsWith("rcts.ed.") && /wheel/.test(scene.get(k).text ?? "")),
        "no counter text over the list");
    // Live editing: a drag on the park moves the camera, and the selected view goes where it ends.
    const edits = () => Object.values(saved["RCTScreensaver.edits"] ?? {})[0]?.views ?? [];
    const editsCount = () => edits().length;
    edClick("scrollUp");
    edClick("row.0");
    const tile = () => ed("cell.0.1").text;
    const before = tile();
    const centre0 = JSON.stringify(viewport.centre);
    mouse("move", 1400, 700); mouse("down", 1400, 700);
    mouse("move", 1300, 700); mouse("move", 1200, 700);
    assert.equal(tile(), before, "the view moves only when the drag ends");
    assert.notEqual(JSON.stringify(viewport.centre), centre0, "the park follows the mouse during the drag");
    mouse("up", 1200, 700);
    assert.notEqual(tile(), before, "the selected view goes where the drag ended");
    assert.equal(ed("cell.0.6").text, "you", "set by hand");
    const moved = tile();
    assert.ok(edits()[0]?.manual, "saved to the edits");
    shortcuts["rctscreensaver.undo"]();
    assert.equal(tile(), before, "Ctrl+Z undoes the drag");
    shortcuts["rctscreensaver.redo"]();
    assert.equal(tile(), moved, "Ctrl+Y redoes it");
    edClick("undo");
    assert.equal(tile(), before, "the Undo button undoes too");
    edClick("redo");
    // A drag that runs over the panel keeps going; a click without a move changes nothing.
    const fr = ed("frame");
    mouse("move", 1400, 700); mouse("down", 1400, 700);
    mouse("move", fr.x + 20, fr.y + 20);
    mouse("up", fr.x + 20, fr.y + 20);
    assert.notEqual(tile(), moved, "a drag over the panel still moves the view");
    const dragged = tile();
    mouse("move", 1400, 700); mouse("down", 1400, 700); mouse("up", 1400, 700);
    assert.equal(tile(), dragged, "a click on the park changes nothing");
    // The wheel over the park zooms the selected view a level.
    const zoom = Number(ed("cell.0.3").text);
    mouse("move", 1400, 700); mouse("wheel", 1400, 700, 0, 1);
    assert.equal(Number(ed("cell.0.3").text), Math.max(-2, zoom - 1), "a step up zooms the view in");
    mouse("wheel", 1400, 700, 0, -1);
    assert.equal(Number(ed("cell.0.3").text), zoom, "a step down zooms it out");
    // A view set from the camera sits at the height of what is at the screen's centre (the mock's ground, 48).
    assert.equal(edits()[0].z, 48, "the view's height is the ground under the centre");
    assert.equal(ed("fit"), undefined, "no Fit height button: the height is set by itself");
    // Turning many times over uneven buildings pivots on one point: the camera comes back to it.
    {
        const flat = sandbox.map.getTile;
        sandbox.map.getTile = (tx, ty) => ({ elements: [{ type: "surface", baseZ: 48 },
            { type: "small_scenery", clearanceZ: 48 + ((tx * 7 + ty * 13) % 5) * 40 }] });
        edClick("rotr");
        const start = JSON.stringify(viewport.centre);
        for (let i = 0; i < 4 * 6; i++) edClick(i % 3 === 0 ? "rotl" : "rotr");
        // 8 left, 16 right: a whole number of turns
        assert.equal(JSON.stringify(viewport.centre), start, "many turns do not drift the camera");
        for (let i = 0; i < 4 * 6; i++) edClick(i % 3 === 0 ? "rotr" : "rotl");
        sandbox.map.getTile = flat;
    }
    // During Play a drag only stops Play: no view moves.
    shortcuts["rctscreensaver.hold"]();
    const playing = tile();
    mouse("move", 1400, 700); mouse("down", 1400, 700); mouse("move", 1000, 500); mouse("up", 1000, 500);
    assert.equal(ed("play.text").text, "Play: off", "a drag stops Play");
    assert.equal(tile(), playing, "and moves no view");
    // Undo goes back through every change to the playlist's own views.
    for (let i = 0; i < 40; i++) shortcuts["rctscreensaver.undo"]();
    assert.equal(ed("cell.0.6").text, "auto", "undoing every change brings the playlist's views back");
    // The map (M): the camera steps out two levels, every view at its angle a box, the rest markers.
    {
        const map = id => scene.get("rcts.map." + id);
        const mapKeys = prefix => [...scene.keys()].filter(k => k.startsWith("rcts.map." + prefix));
        edClick("row.0");
        const zoom0 = Number(ed("cell.0.3").text);
        shortcuts["rctscreensaver.map"]();
        assert.equal(viewport.zoom, Math.min(3, zoom0 + 2), "the map steps out two levels");
        assert.ok(ed("map.text").text.endsWith("on"), "the Map button shows it on");
        const box = map("box.0");
        assert.ok(box, "the selected view is a box");
        assert.ok(Math.abs(box.x + box.width / 2 - 960) <= 1 && Math.abs(box.y + box.height / 2 - 540) <= 1,
            "centred, as the camera is on it");
        assert.ok(Math.abs(box.width - 1920 * 2 ** (zoom0 - viewport.zoom)) <= 1, "the box is the view's window at its zoom");
        assert.ok(mapKeys("mark.").length + mapKeys("box.").length >= 2, "the other views are boxes or markers");
        assert.ok(mapKeys("line.").length > 0, "pan lines between the views");
        assert.ok(map("handle"), "the selected box has a zoom handle");
        // Drag the box: the view moves, the camera stays.
        const before = tile();
        const cam = JSON.stringify(viewport.centre);
        mouse("move", 960, 540); mouse("down", 960, 540); mouse("move", 1010, 560); mouse("move", 1060, 540);
        assert.ok(Math.abs(map("box.0").x + map("box.0").width / 2 - 1060) <= 1, "the box follows the mouse");
        assert.equal(tile(), before, "saved only on release");
        mouse("up", 1060, 540);
        assert.notEqual(tile(), before, "the view moved");
        assert.equal(JSON.stringify(viewport.centre), cam, "the camera stays on the map");
        assert.equal(ed("cell.0.6").text, "you", "placed by hand");
        // The corner handle: dragged out to twice the size, the view zooms out a level.
        const h = map("handle");
        const b = map("box.0");
        const hx = h.x + h.width / 2, hy = h.y + h.height / 2;
        mouse("move", hx, hy); mouse("down", hx, hy);
        mouse("move", b.x + b.width / 2 + b.width, b.y + b.height / 2 + b.height);
        mouse("up", b.x + b.width / 2 + b.width, b.y + b.height / 2 + b.height);
        assert.equal(Number(ed("cell.0.3").text), Math.min(3, zoom0 + 1), "the handle zooms the view out a level");
        // A drag on empty park pans the camera.
        mouse("move", 1800, 150); mouse("down", 1800, 150); mouse("move", 1700, 150); mouse("up", 1700, 150);
        assert.notEqual(JSON.stringify(viewport.centre), cam, "a drag on empty park pans");
        // A right click on empty park adds a view there.
        const count = editsCount();
        mouse("move", 1800, 150); mouse("down", 1800, 150, 1); mouse("up", 1800, 150, 1);
        assert.equal(editsCount(), count + 1, "a right click adds a view");
        assert.ok(map("box.1"), "the new view is a box at the camera's angle");
        shortcuts["rctscreensaver.undo"]();
        assert.equal(editsCount(), count, "undone on the map too");
        // Double-click a box: the map closes on that view.
        const b0 = map("box.0");
        const bx = b0.x + b0.width - 10, by = b0.y + b0.height / 2; // the right edge holds even a big box
        mouse("move", bx, by); mouse("down", bx, by); mouse("up", bx, by);
        now += 100;
        mouse("down", bx, by); mouse("up", bx, by);
        assert.equal(mapKeys("").length, 0, "a double click closes the map");
        assert.equal(viewport.zoom, Number(ed("cell.0.3").text), "the camera frames the view again");
        shortcuts["rctscreensaver.map"]();
        assert.ok(mapKeys("box.").length > 0, "M opens the map again");
        shortcuts["rctscreensaver.map"]();
        assert.equal(mapKeys("").length, 0, "and closes it");
    }
    edClick("close");
    assert.equal(ed("frame"), undefined, "the close button closes the panel");
    // The mouse on the park is the bar's again once the editor is closed.
    const c0 = JSON.stringify(viewport.centre);
    mouse("move", 1400, 700); mouse("down", 1400, 700); mouse("move", 1200, 700); mouse("up", 1200, 700);
    assert.equal(JSON.stringify(viewport.centre), c0, "no drag with the editor closed");
}
// Park name captions (titles): top left, under the load cover; "overview" on the park's first view only.
{
    const cap = id => scene.get("rcts.cap." + id);
    const capShown = () => (cap("box")?.opacity ?? 0) > 0;
    click("titles"); // off (as left above) -> overview
    shortcuts["rctscreensaver.nextpark"]();
    for (let i = 0; i < 40 && !capShown(); i++) tick();
    assert.ok(capShown(), "the caption shows on a park's first view");
    assert.ok(cap("title").text.length > 0, "with the park's name");
    assert.ok(cap("box").z < 50, "under the load cover");
    assert.ok(cap("box").x < 100 && cap("box").y < 100, "in the top left corner");
    shortcuts["rctscreensaver.next"]();
    tick(2);
    assert.equal(capShown(), false, "on the overview setting it goes on the next view");
    click("titles"); // overview -> on
    tick(10);
    assert.ok(capShown(), "titles on: every view");
    // Placement (settings panel): top left, bottom left, top centre, bottom centre.
    click("settings");
    const place = () => { const b = cap("box"); return [b.x + b.width / 2, b.y + b.height / 2]; };
    let [cx, cy] = place();
    assert.ok(cx < 960 && cy < 540, "top left by default");
    click("option.captionPlace"); tick();
    [cx, cy] = place();
    assert.ok(cx < 960 && cy > 540, "bottom left");
    assert.ok(cap("box").x + cap("box").width < scene.get("rcts.bar.strip").x, "beside the bar, clear of it");
    click("option.captionPlace"); tick();
    [cx, cy] = place();
    assert.ok(Math.abs(cx - 960) < 2 && cy < 540, "top centre");
    click("option.captionPlace"); tick();
    [cx, cy] = place();
    const b = cap("box");
    assert.ok(Math.abs(cx - 960) < 2 && b.y + b.height < scene.get("rcts.bar.strip").y, "bottom centre, above the bar");
    click("settings"); // the panel closes, so the bar can hide
    mouse("move", 960, 300); // off the bar
    tick(60);
    assert.equal(cap("box").y + cap("box").height + 14, 1080 - 28, "bottom centre drops to the window's margin while the bar hides");
    { const [x, y] = centre("nextPark"); mouse("move", x, y); }
    tick();
    assert.ok(cap("box").y + cap("box").height < scene.get("rcts.bar.strip").y, "and moves above the bar when it shows");
    click("settings");
    click("option.captionPlace"); tick();
    // Frame and accent (the settings panel's Title frame flyout): the pieces follow the choice.
    assert.ok(scene.get("rcts.cap.frame.tl").src.includes("frame-gold-"), "gold frame by default");
    assert.ok(scene.get("rcts.cap.velvet.0.0").src.includes("velvet-green-"), "green velvet by default");
    assert.ok(!scene.has("rcts.bar.frame.gold"), "the flyout starts closed");
    click("option.captionFrame"); tick();
    assert.ok(scene.has("rcts.bar.flyout") && scene.has("rcts.bar.frame.canvas") && scene.has("rcts.bar.accent.ivory"), "the flyout opens");
    assert.ok([...scene.keys()].some(k => k.startsWith("rcts.bar.frame.aero.preview.")), "a preview on each tile");
    assert.ok(scene.get("rcts.bar.flyout").x >= scene.get("rcts.bar.panel").x + scene.get("rcts.bar.panel").width, "beside the panel");
    const fly = scene.get("rcts.bar.flyout");
    assert.ok(fly.y + fly.height <= scene.get("rcts.bar.strip").y, "above the bar");
    dump("flyout-gold");
    click("frame.silver"); click("accent.burgundy"); tick();
    dump("silver");
    assert.ok(scene.get("rcts.cap.frame.tl").src.includes("frame-silver-"), "silver frame");
    assert.ok(scene.get("rcts.cap.velvet.0.0").src.includes("velvet-burgundy-"), "burgundy velvet");
    assert.ok(scene.has("rcts.bar.flyout"), "the flyout stays open while choosing");
    click("frame.minimalDark"); tick();
    dump("minimalDark");
    assert.ok(scene.has("rcts.cap.box") && !scene.has("rcts.cap.frame.tl") && !scene.has("rcts.cap.velvet.0.0"), "minimal: no frame pieces");
    click("frame.minimalLight"); tick();
    dump("minimalLight");
    assert.ok(scene.has("rcts.cap.strip"), "minimal light: the accent strip");
    click("frame.aero"); tick();
    dump("aero");
    assert.ok(scene.get("rcts.cap.corner.tl").src.includes("aero-burgundy-tl-"), "aero: corners in the accent");
    assert.ok(scene.get("rcts.cap.frost.0.0").src.includes("aero-frost-burgundy-"), "aero: frost in the accent");
    click("frame.canvas"); click("accent.navy"); tick();
    dump("canvas");
    assert.ok(scene.get("rcts.cap.frame.tl").src.includes("gallery-tl-"), "canvas: the gallery frame");
    assert.ok(scene.get("rcts.cap.linen.0.0").src.includes("canvas-"), "canvas: the linen");
    assert.equal(scene.get("rcts.cap.box").fill, "#222e5c", "canvas: the mat in the accent");
    const pngs = new Set([...scene.values()].filter(e => e.type === "image" && e.src.startsWith("rct-screensaver/icons/")).map(e => e.src));
    for (const src of pngs) assert.ok(fs.existsSync(path.join(here, "..", "icons", path.basename(src))), `piece exists: ${src}`);
    click("frame.gold"); click("accent.green"); tick();
    assert.ok(scene.get("rcts.cap.frame.tl").src.includes("frame-gold-") && scene.get("rcts.cap.velvet.0.0").src.includes("velvet-green-"), "back to gold on green");
    click("option.captionFrame"); tick();
    assert.ok(!scene.has("rcts.bar.flyout"), "the Title frame button closes the flyout");
    click("settings");
    click("titles"); // on -> off
    tick(2);
    assert.equal(capShown(), false, "titles off: none");
}
{ const [x, y] = centre("nextPark"); mouse("move", x, y); }
if (process.env.SCENE_OUT) fs.writeFileSync(process.env.SCENE_OUT, JSON.stringify([...scene]));
console.log("ok: controls bar (show/hide with the cursor, buttons, icons, tooltip)");

mode.set(false);
tick(5);
assert.equal([...scene.keys()].filter(k => k.startsWith("rcts.bar.")).length, 0, "the bar goes with the mode");
assert.equal(sequence.isPlaying, false, "leaving the mode hands back the user's title sequence");
assert.equal(sequence.stops, 1);

mode.set(true);
tick(5);
assert.equal(sequence.isPlaying, true, "playback starts again on the next entry, held view released");
// The playlist's Show titles (owner, 2026-11-03) overrides the viewer's setting for the run, until the
// viewer picks on the bar; it is never saved.
{
    playlist.titles = "off";
    const titlesBefore = store.RCTScreensaver.settings.titles;
    mode.set(false);
    mode.set(true);
    tick(40);
    assert.equal([...scene].some(([k, e]) => k === "rcts.cap.box" && (e.opacity ?? 0) > 0), false, "the playlist's off hides the captions");
    const [x, y] = centre("titles");
    mouse("move", x, y); tick();
    click("titles"); // off (the playlist's) -> overview, the viewer's own from now on
    const kept = saved["RCTScreensaver.settings"];
    assert.equal(kept.titles, "overview", "the viewer's pick is saved");
    assert.equal("titlesOverride" in kept, false, "the playlist's titles are never saved");
    delete playlist.titles;
    store.RCTScreensaver.settings.titles = titlesBefore;
}
// Park changes in the mode dip through black (patch 0010): the current park plays on while the next
// is read, the cover fades in once it is ready, the switch waits for black, then the cover fades out.
store.RCTScreensaver.settings.fadeMs = 600;
sequence.backgroundLoading = true;
sequence.holdSwitch = false;
sequence.nextParkReady = false;
mode.set(false);
mode.set(true);
tick(5);
const coverOpacity = () => scene.get("rcts.cover")?.opacity;
shortcuts["rctscreensaver.nextpark"]();
assert.equal(sequence.holdSwitch, true, "the switch is held while the next park loads");
tick(5);
assert.equal(coverOpacity(), undefined, "no cover while the next park is still being read");
tick(6);
assert.equal(sequence.nextParkReady, true, "the next park is ready");
assert.equal(coverOpacity(), 1, "the cover fades in over the ready park");
assert.equal(sequence.switchedAt, undefined, "the switch waits for the cover");
tick(10);
assert.ok(sequence.switchedAt !== undefined, "the switch happens once the screen is black");
assert.equal(sequence.holdSwitch, false);
tick(2);
assert.equal(coverOpacity(), 0, "the cover fades out after the switch");
tick(10);
assert.equal(scene.has("rcts.cover"), false, "and is removed");
console.log("ok: park changes dip through black in the mode (patch 0010)");

// Performance runs (engine patch 0016, tools/perfrun.py): the plugin's events go into the engine's
// perf log as marks; bench mode keeps the mouse from showing the bar (marked instead) and starts
// OpenRCT2's function profiler, exported on an interval.
const marks = [];
const legacy = [];
mode.perfLog = true;
mode.perfMark = text => marks.push(text);
sandbox.console.executeLegacy = cmd => legacy.push(cmd);
Object.assign(store.RCTScreensaver.settings, { bench: true, profilerExport: "C:/perf run/profiler.csv" });
mode.set(false);
mode.set(true);
tick(5);
shortcuts["rctscreensaver.nextpark"]();
tick(30);
assert.ok(marks.some(m => m.startsWith("park ")), "park loads are marked");
assert.ok(marks.some(m => m.startsWith("view park=")), "views are marked like the camera log");
mouse("move", 10, 10);
assert.equal(shown("strip"), false, "bench mode: the mouse does not show the bar");
assert.ok(marks.includes("input move"), "and the input is marked for the report to leave out");
assert.ok(legacy.includes("profiler_start"), "the function profiler starts");
assert.ok(intervals.some(v => v.ms === 60000), "and is exported every minute");
assert.ok(legacy.includes('profiler_export "C:/perf run/profiler.csv"'), "to the quoted path");
console.log("ok: perf marks, bench mode and the profiler (patch 0016)");

console.log("ok: screensaver mode (start, stop, keys, settings, no toolbox items)");
