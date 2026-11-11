// RCT Screensaver: plays an installed playlist on OpenRCT2's title screen.

import { builder, buildApi, BuildResult, message } from "./builder";
import { Editor } from "./editor";
import { modeSettings, perfLogging, perfMark, screensaverApi } from "./mode";
import { Player } from "./player";
import { loadPlaylist, loadSettings, Playlist, resolveSequence, savePlaylist, saveSettings, TITLES } from "./storage";
import { Captions } from "./ui/captions";
import { ControlsBar } from "./ui/controls";
import { EditorPanel } from "./ui/editor-panel";

const UPDATE_INTERVAL_MS = 100;
const DEBUG_INTERVAL_MS = 1000;
const CAMERA_INTERVAL_MS = 1; // every game tick

let player: Player | undefined;
let editor: Editor | undefined;
let bar: ControlsBar | undefined; // the screensaver mode's controls (patched engine)
let captions: Captions | undefined; // and its park name captions
let editorPanel: EditorPanel | undefined; // the editor's overlay view in the mode
let onTitleScreen = false;
let lastDebug = 0;
// The patched engine's screensaver mode: playback runs only while it is on (the stock title
// screen keeps the user's own title sequence). Absent on the stock engine, which autostarts.
const mode = screensaverApi();
let modeStarted = false;
let lastInputMark = 0; // bench mode: mouse input is marked in the perf log at most once a second
let profilerTimer: number | undefined;
const PROFILER_EXPORT_MS = 60000;

function log(message: string): void {
    console.log(`[RCT Screensaver] ${message}`);
}

function startPlayer(): void {
    const settings = loadSettings();
    const playlist = loadPlaylist();
    if (!playlist) {
        log("no playlist installed; run tools/mksequence.py --install");
        return;
    }
    // The playlist's Show titles (owner, 2026-11-03) holds until the viewer picks on the bar.
    if (playlist.titles && TITLES.includes(playlist.titles)) {
        settings.titlesOverride = playlist.titles;
    }
    const sequence = resolveSequence(playlist);
    if (typeof sequence === "string") {
        log(sequence);
        return;
    }
    player = new Player(playlist, sequence, settings, mode?.active ? mode.overlay : undefined);
    startProfiler(settings.profilerExport);
    const inMode = mode?.active && mode.overlay;
    // In the mode the editor is drawn on the overlay: windows do not show there.
    editorPanel = inMode ? new EditorPanel(mode!) : undefined;
    editor = new Editor(player, editorPanel);
    player.start();
    if (inMode) {
        // The bar and the player share one settings object: either may save it.
        bar = new ControlsBar(mode!, () => player, settings, {
            toggleEditor: () => toggleEditor(),
            editorOpen: () => editor?.isOpen ?? false,
            editorPinned: () => editor?.pinned ?? true,
        });
        bar.open();
        captions = new Captions(mode!, () => player, settings, () => editor?.isOpen ?? false, () => bar?.shown ?? false);
    }
}

function stopPlayer(release = false): void {
    bar?.close();
    bar = undefined;
    captions?.close();
    captions = undefined;
    editor?.close();
    editor = undefined;
    editorPanel = undefined;
    if (release) {
        player?.release();
    } else {
        player?.stop();
    }
    player = undefined;
}

/** Takes a build the game started in (builder.ts): the engine copies the new sequence into place and
 *  reloads its script, the new playlist is installed in the storage and the player swaps to it. */
function takeBuild(result: BuildResult): string | undefined {
    const api = buildApi();
    if (!api || !player?.isRunning || !result.playlist) {
        return "the screensaver is not playing";
    }
    if (result.playlist.sequence !== player.sequenceName) {
        return `another playlist is playing ("${player.sequenceName}")`;
    }
    try {
        api.applyBuild(result.sequence);
    } catch (e) {
        return message(e);
    }
    const old = loadPlaylist();
    const playlist: Playlist = { ...result.playlist, installed: Date.now(), source: result.playlist.source ?? old?.source };
    const check = resolveSequence(playlist);
    if (typeof check === "string") {
        return check;
    }
    savePlaylist(playlist);
    // The playlist's title music, as an install sets it (applied by the mode on its next entry).
    if (result.titleMusic) {
        const settings = player.liveSettings;
        settings.titleMusic = result.titleMusic;
        saveSettings(settings);
        player.noteInstalledMusic(result.titleMusic);
    }
    player.swapPlaylist(playlist);
    return undefined;
}
builder.onReady = takeBuild;

function update(): void {
    builder.update();
    if (context.mode !== "title") {
        if (onTitleScreen) {
            onTitleScreen = false;
            stopPlayer();
        }
        return;
    }
    if (!onTitleScreen) {
        // Autostart once per visit to the title screen (stock engine).
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
    editorPanel?.update();
    if (player.debug && Date.now() - lastDebug >= DEBUG_INTERVAL_MS) {
        lastDebug = Date.now();
        log(player.describe());
    }
}

function onTitle(action: (p: Player) => void): () => void {
    return () => {
        if (context.mode === "title" && player?.isRunning && (!mode || mode.active)) {
            action(player);
        }
    };
}

/** Runs `edit` instead of `play` while the view editor is open (arrows pan the camera then). */
function either(play: (p: Player) => void, edit?: (e: Editor) => void): (p: Player) => void {
    return p => {
        if (editor?.isOpen) {
            edit?.(editor);
        } else {
            play(p);
        }
    };
}

function toggleEditor(): void {
    if (editor?.isOpen) {
        editor.close();
    } else {
        editor?.open();
    }
}

/** Build and play, or cancel the build: the editor's pane does it while open (and redraws). */
function toggleBuild(p: Player): void {
    if (editor?.isOpen && editorPanel?.isOpen) {
        editorPanel.toggleBuild();
    } else if (builder.running) {
        builder.cancel();
    } else if (builder.available) {
        builder.start(p.sequenceName);
    }
}

function registerShortcuts(): void {
    const shortcuts: [string, string, string[], (p: Player) => void][] = [
        ["next", "Next view", ["RIGHT"], either(p => p.next(), e => e.pan(1, 0))],
        ["previous", "Previous view", ["LEFT"], either(p => p.previous(), e => e.pan(-1, 0))],
        ["nextpark", "Next park", ["SHIFT+RIGHT"], either(p => p.nextPark(), e => e.pan(1, 0, true))],
        ["previouspark", "Previous park", ["SHIFT+LEFT"], either(p => p.previousPark(), e => e.pan(-1, 0, true))],
        ["faster", "Speed up", ["UP"], either(p => p.changeSpeed(1), e => e.pan(0, -1))],
        ["slower", "Slow down", ["DOWN"], either(p => p.changeSpeed(-1), e => e.pan(0, 1))],
        ["panupfast", "Pan up fast (view editor)", ["SHIFT+UP"], either(() => {}, e => e.pan(0, -1, true))],
        ["pandownfast", "Pan down fast (view editor)", ["SHIFT+DOWN"], either(() => {}, e => e.pan(0, 1, true))],
        // In the editor, Space starts and stops Play (playback is paused there otherwise).
        ["hold", "Hold / release view", ["SPACE"], either(p => p.toggleHold(), e => e.togglePreview())],
        ["shuffle", "Shuffle on / off", ["S"], p => p.toggleShuffle()],
        ["edit", "Open / close view editor", ["E"], () => toggleEditor()],
        ["undo", "Undo (view editor)", ["CTRL+Z"], either(() => {}, e => e.undo())],
        ["map", "Map of the views on / off (view editor)", ["M"], either(() => {}, e => e.toggleMap())],
        ["redo", "Redo (view editor)", ["CTRL+Y", "CTRL+SHIFT+Z"], either(() => {}, e => e.redo())],
        // The view editor's tools (owner, 2026-11-10; the toolbox's tooltips name them).
        ["addview", "Add a view (view editor)", ["INSERT"], either(() => {}, e => e.add())],
        ["setview", "Set the view to the camera (view editor)", ["C"], either(() => {}, e => { if (e.mapMode || !editorPanel) e.update(); })],
        ["deleteview", "Delete the view (view editor)", ["DELETE"], either(() => {}, e => e.remove())],
        ["viewup", "Move the view up (view editor)", ["CTRL+UP"], either(() => {}, e => { if (e.movable(e.selectedIndex)) e.moveOnRoute(-1); })],
        ["viewdown", "Move the view down (view editor)", ["CTRL+DOWN"], either(() => {}, e => { if (e.movable(e.selectedIndex)) e.moveOnRoute(1); })],
        ["rotateright", "Rotate right (view editor)", ["RETURN"], either(() => {}, e => e.rotate(1))],
        ["rotateleft", "Rotate left (view editor)", ["SHIFT+RETURN"], either(() => {}, e => e.rotate(-1))],
        ["zoomin", "Zoom in (view editor)", ["PAGEUP"], either(() => {}, e => e.zoom(-1))],
        ["zoomout", "Zoom out (view editor)", ["PAGEDOWN"], either(() => {}, e => e.zoom(1))],
        ["eventlock", "Lock / unlock event views on the map (view editor)", ["L"], either(() => {}, e => { if (e.mapMode) e.toggleEventLock(); })],
        ["play", "Play / stop the park's views (view editor)", ["P"], either(() => {}, e => e.togglePreview())],
        ["holdless", "Shorter hold (view editor)", ["["], either(() => {}, e => e.changeHold(-1))],
        ["holdmore", "Longer hold (view editor)", ["]"], either(() => {}, e => e.changeHold(1))],
        ["panless", "Less of the hold panning (view editor)", ["SHIFT+["], either(() => {}, e => e.changePan(-0.1))],
        ["panmore", "More of the hold panning (view editor)", ["SHIFT+]"], either(() => {}, e => e.changePan(0.1))],
        // The build pane's button (patched engine), also with the editor closed (owner, 2026-11-11).
        ["build", "Build and play / cancel the build", ["CTRL+B"], p => toggleBuild(p)],
    ];
    for (const [id, text, bindings, action] of shortcuts) {
        ui.registerShortcut({
            id: `rctscreensaver.${id}`,
            text: `[RCT Screensaver] ${text}`,
            bindings,
            callback: onTitle(action),
        });
    }
}

function registerToolboxItems(): void {
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
        log(`debug log ${settings.debug ? "on" : "off"}`);
    });
}

/** Performance runs: OpenRCT2's function profiler (console commands), exported every minute so a
 *  run that ends by quitting or crashing still leaves one. */
function startProfiler(path: string): void {
    if (!path || profilerTimer !== undefined) {
        return;
    }
    console.executeLegacy("profiler_start");
    log(`profiler on, exporting to ${path}`);
    profilerTimer = context.setInterval(() => console.executeLegacy(`profiler_export "${path}"`), PROFILER_EXPORT_MS);
}

function main(): void {
    if (typeof ui === "undefined") {
        return; // headless
    }
    registerShortcuts();
    if (mode) {
        // Nothing is added to the stock title screen: the mode is entered from the menu's button
        // or with --screensaver, and takes the settings the plugin keeps.
        mode.configure(modeSettings(loadSettings()));
        if (perfLogging()) {
            log("the engine writes a perf log");
            perfMark("plugin started");
        }
        mode.onChange(active => {
            log(`screensaver mode ${active ? "on" : "off"}`);
            if (!active) {
                modeStarted = false;
                stopPlayer(true);
            }
        });
        mode.onMouse(e => {
            if (loadSettings().bench) {
                // Performance runs: the controls bar would cost frames; the report drops marked seconds.
                if (Date.now() - lastInputMark >= 1000) {
                    lastInputMark = Date.now();
                    perfMark(`input ${e.type}`);
                }
                return;
            }
            // The editor panel takes the mouse over it, and the park around it while the editor is open
            // (a drag that started there keeps it to the end); the bar gets the rest.
            const onPark = editorPanel?.isOpen === true && (editorPanel.dragging ||
                (!bar?.covers(e.x, e.y) && !bar?.panelOpen));
            if (editorPanel?.onMouse(e) || (onPark && editorPanel!.onPark(e))) {
                bar?.mouseSeen();
            } else {
                bar?.onMouse(e);
            }
        });
    } else {
        registerToolboxItems();
    }
    // Companion plugins (tools/companions.py) report the end of a show started by a show view.
    context.registerAction<{ show: string }>("rctscreensaver-showdone", () => ({}), e => {
        player?.showDone(e.args.show);
        return {};
    });
    // ... and each step of it as the show reaches it (a camera path can wait for one).
    context.registerAction<{ show: string; step: number }>("rctscreensaver-showstep", () => ({}), e => {
        player?.showStep(e.args.show, e.args.step);
        return {};
    });
    context.setInterval(update, UPDATE_INTERVAL_MS);
    // The park's own clock: show paths and event cues keep game time with the companions.
    context.subscribe("interval.tick", () => {
        if (context.mode === "title" && player?.isRunning) {
            player.tick();
        }
    });
    // Pans move the camera every game tick (intervals run once per tick at most).
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
    main,
});
