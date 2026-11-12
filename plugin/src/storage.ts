// Playlist and settings kept in OpenRCT2's shared plugin storage (plugin.store.json).
// The playlist is written by `tools/mksequence.py --install`; settings belong to the plugin.

import type { PanChanges } from "./pan";

export const NAMESPACE = "RCTScreensaver";

export interface View {
    x: number; // tile coordinates
    y: number;
    z: number; // world height (8 units per height step)
    rotation: number;
    zoom: number;
    hold: number; // seconds
    overview?: boolean; // zoomed by the plugin to show the whole park
    manual?: boolean; // placed by hand in the view editor (absent: generated or from the playlist)
    animation?: string; // aimed at a companion plugin's animation: shown as placed, after the others
                        // (with `fixed`, a stop in the route: in its place)
    show?: { action: string; name: string }; // runs a companion's show; played last, as placed
    pathStep?: number; // the camera path waits until the show reaches this step (0-based)
    showAt?: number; // where a show view plays among the park's views: an index, -1 the last (default)
    path?: PathPoint[]; // a show view's camera path: the camera glides on from the view through these
    cue?: Cue; // an event-timed view: stays for an effect that starts on a cue (a car arriving, a tick)
    fixed?: boolean; // shown as placed: fitting neither moves nor merges it (a tower view)
    pan?: number; // share of the hold spent panning on to the next view (absent: 0, held still); a show
                  // view with a path never pans on: its path moves for this share of the path's time
    panChanges?: PanChanges | "off"; // angle and zoom change as the pan sets off or arrives (absent: settings);
                                     // off: a pan that changes them cuts instead (the playlist's pan_changes)
    inertia?: boolean; // the pan starts and stops slowly instead of at one speed (absent: settings)
    zoomThreshold?: number; // screen px/s above which the pan travels zoomed out, any zoom (absent: the tolerance)
    origin?: number; // the view editor: which of the park's playlist views this one started as (its Reset view);
                     // absent on views added by hand (install drops it)
}

/** A point on a show view's camera path, reached `ticks` game ticks after the one before. */
export interface PathPoint {
    x: number; // tile coordinates
    y: number;
    z: number; // world height
    ticks: number;
}

/** When an event-timed view's effect starts, and how long it runs. The view waits past its hold
 *  for the cue (at most `wait`), then stays until the effect is over; it never pans on. */
export interface Cue {
    ride?: number; // a car of this ride ...
    cars?: number[]; // or: one of these cars (entity ids as saved in the park) ...
    tiles?: [number, number, number, number]; // ... on these tiles (x0, y0, x1, y1, inclusive; absent: anywhere)
    tick?: number; // or: the park's game tick since it loaded (a companion's timeline)
    lead?: number; // with tick: seconds of the view before the effect starts (a cut view cuts in then)
    every?: number; // with tick: the effect comes again every this many ticks (a ride's lap, measured)
    ticks: number; // game ticks the effect runs once cued
    wait?: number; // seconds the view waits past its hold for the cue (absent: 20)
    follow?: number; // while the effect runs, the camera follows this ride's train: the cued one on
                     // the cued ride, else train `train` (absent: the first)
    train?: number;
    cut?: boolean; // plays out of turn: cuts in when cued (once a visit) instead of waiting in its place
}

/** Views placed for a companion's animations, shows or cues, which fitting leaves alone and
 * which play after the others. A `fixed` view on a continuous animation (no cue) is a stop of
 * the park's route instead: it plays in its place and fitting keeps it as placed. */
export function isPinned(view: View): boolean {
    return (view.animation !== undefined && !view.fixed) || view.show !== undefined || view.cue !== undefined;
}

/** Whether a view cuts in on the park's clock (cue.cut with a tick). */
export function isCut(view: View): boolean {
    return !!view.cue?.cut && typeof view.cue.tick === "number";
}

/** Lists each cut-in view where it is expected to play (owner, 2026-10-31): after the route view
 * on screen when its cue first comes due (tick / 40 - lead seconds into the park, against the
 * route's holds; past the route's end, after its last view), in time order. Only the listing
 * changes: playback leaves cut views out of the order and cuts them in when cued. */
export function placeCuts(views: View[]): View[] {
    const due = (v: View) => v.cue!.tick! / 40 - (v.cue!.lead ?? 0);
    const cuts = views.filter(isCut).sort((a, b) => due(a) - due(b));
    if (cuts.length === 0) {
        return views;
    }
    const rest = views.filter(v => !isCut(v));
    const starts: [number, number][] = [];
    let t = 0;
    rest.forEach((v, i) => {
        if (!isPinned(v)) {
            starts.push([i, t]);
            t += v.hold;
        }
    });
    const after = new Map<number, View[]>();
    for (const c of cuts) {
        let k = starts.length > 0 ? starts[0][0] : rest.length - 1;
        for (const [i, start] of starts) {
            if (start <= due(c)) {
                k = i;
            }
        }
        after.set(k, [...(after.get(k) ?? []), c]);
    }
    return [...rest.flatMap((v, i) => [v, ...(after.get(i) ?? [])]), ...(after.get(-1) ?? [])];
}

/** Box holding the park's content, used to keep views on it: tiles (inclusive) and heights. */
export interface Bounds {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    z0?: number; // world height of the lowest ground; absent: treat the content as flat
    z1?: number; // world height of the highest tops
    cx?: number; // where the elements are on average: tile units (a tile's middle is +0.5)
    cy?: number;
    zm?: number; // and world height
}

export interface ParkEntry {
    key?: string; // stable id of the park in the playlist (file, plus member), for edits
    name: string;
    author?: string; // credit, from the playlist (not shown yet)
    fileName: string;
    load: number; // index of this park's LOAD command in the title sequence
    views: View[];
    handSet?: boolean; // views come from the editor (via the views file): shown exactly as set
    defaultViews?: View[]; // with handSet: the playlist's own views, for "Use playlist views"
    panTolerance?: [number, number]; // [px/s at zoom -2, less per level out]: the generator's (absent: settings)
    bounds?: Bounds; // absent: show views exactly as listed
    viewCount?: number; // views the park should get when fitting merges some; default views.length
    parkTime?: number; // seconds the park's generated views should last in all, however many are left
    variants?: { views: View[]; parkTime?: number }[]; // alternative orders of the generated views, played in turn
    viewScreen?: [number, number]; // with handSet: the window the views were set in (absent: played as set)
    returnPan?: boolean; // false: the park's last view cuts to the next park instead of panning back to its first
}

export interface Playlist {
    version: number;
    sequence: string; // title sequence name
    screen?: [number, number]; // game window the generated views were judged in (absent: 1920x1080)
    changeHold?: number; // the playlist's change, arrival and return holds, seconds (absent: settings)
    arriveHold?: number;
    returnHold?: number;
    titles?: Titles; // the playlist's Show titles: overrides the viewer's setting each time playback starts
    inertia?: boolean; // the playlist's [views] inertia and pan_changes, as built (the view editor shows them)
    panChanges?: PanChanges | "off";
    built?: number; // when the playlist was built and installed (ms since 1970): the editor's restore points
    installed?: number;
    source?: string; // the playlist file it was installed from (mksequence.py --install), for the live file
    parks: ParkEntry[];
}

/** The view editor's Playlist properties (owner, 2026-11-10), by sequence name: they apply over the
 *  installed playlist until the next install moves them into the playlist file (mksequence.py
 *  pull_props). `order` lists park keys in play order; `titles` null is Unset (the viewer's own). */
export interface PlaylistProps {
    order?: string[];
    inertia?: boolean;
    panChanges?: PanChanges | "off"; // off: a pan that would change the angle or zoom cuts instead (not overviews)
    changeHold?: number;
    arriveHold?: number;
    returnHold?: number;
    titleMusic?: "ride" | "theme" | "keep";
    titles?: Titles | null;
}

export function loadPlaylistProps(sequence: string): PlaylistProps {
    const all = context.sharedStorage.get<Record<string, PlaylistProps>>(NAMESPACE + ".playlistProps", {});
    return { ...(all[sequence] ?? {}) };
}

export function savePlaylistProps(sequence: string, props: PlaylistProps): void {
    const all = context.sharedStorage.get<Record<string, PlaylistProps>>(NAMESPACE + ".playlistProps", {});
    all[sequence] = props;
    context.sharedStorage.set(NAMESPACE + ".playlistProps", all);
    liveProps[sequence] = props;
    writeLive();
}

/** A park's saved views to go back to (the view editor's restore points), newest last. */
export interface Checkpoint {
    n: number; // its number: "Checkpoint n"
    time: number; // ms since 1970
    views: View[];
    screen?: [number, number]; // the window they were saved in
    camera?: { x: number; y: number; z: number; rotation: number; zoom: number }; // where the camera was
    selected?: number; // the view selected then
    onMap?: boolean; // the camera was the map's (Frame mode: the selected view's)
}

export const CHECKPOINTS_PER_PARK = 10; // the 10 most recent are kept (owner, 2026-11-10)

export function loadCheckpoints(): Record<string, Checkpoint[]> {
    return context.sharedStorage.get<Record<string, Checkpoint[]>>(NAMESPACE + ".checkpoints", {});
}

export function saveCheckpoints(all: Record<string, Checkpoint[]>): void {
    context.sharedStorage.set(NAMESPACE + ".checkpoints", all);
}

export type Titles = "overview" | "on" | "off";
export const TITLES: Titles[] = ["overview", "on", "off"];

/** The titles in force: the playlist's for this run until the viewer picks on the bar, else the viewer's own. */
export function titlesOf(settings: Settings): Titles {
    return settings.titlesOverride ?? settings.titles;
}

export interface Settings {
    autostart: boolean; // start the playlist whenever the title screen is shown (stock engine; the patched
                        // engine plays only in the screensaver mode)
    shuffle: boolean;
    debug: boolean; // log state to the console every second
    speed: number; // game speed level, re-applied after every park load
    fadeMs: number; // the screensaver mode's dip through black around park changes; 0 cuts straight to the next park
    panTolerance: number; // fastest legible pan at zoom -2, screen px/s, for playlists that don't set it
    panToleranceStep: number; // and the tolerance lost per zoom level out; a pan over it travels zoomed out
    panChanges: PanChanges; // for views that don't set it: angle and zoom change as a pan sets off or arrives
    inertia: boolean; // for views that don't set it: pans start and stop slowly
    changeHold: number; // seconds the camera stays still after an angle or zoom change, at least
    arriveHold: number; // seconds a pan rests at the next view's spot before its angle or zoom changes
    returnHold: number; // seconds the camera holds at the first view after a park's return pan, before the next park
    cameraLog: boolean; // log every view, pan and angle/zoom change with its time (tools/cameralog.py)
    scaleToWindow: boolean; // views and pan speeds follow the window's size against the one they were set for
    // The screensaver mode (patched engine), applied in memory on entering it, never in config.ini:
    window: "keep" | "windowed" | "borderless" | "fullscreen"; // the game window's style in the mode
    titleMusic: "keep" | "ride" | "theme" | "off"; // the parks' ride music (patch 0002), the OpenRCT2 theme, none, or the game's own choice
    titles: Titles; // park name captions: on each park's first view, on every view, or never
    titlesOverride?: Titles; // the playlist's titles for this run (never saved): the bar's Titles button replaces it
    captionPlace: "topLeft" | "bottomLeft" | "topCenter" | "bottomCenter"; // where the caption's frame sits (owner, 2026-11-02)
    captionFrame: "gold" | "silver" | "wood" | "minimalDark" | "minimalLight" | "aero" | "canvas"; // the caption's style (owner, 2026-11-03)
    captionBand: "green" | "burgundy" | "navy" | "slate" | "ivory"; // the accent: the portrait frames' velvet, Minimal light's strip, Aero's tint, Canvas's mat
    lightEffects: boolean; // OpenRCT2's light effects (software engine only)
    weatherGloom: boolean; // weather effects: rain and snow drawn, and the darker palette in bad weather
    weather: boolean; // parks' weather changes as in play (the stock title screen keeps the saved weather)
    timeOfDay: "day" | "night" | "cycle"; // daylight (stock), full night, or the day/night cycle from each park's date (owner, 2026-11-02)
    masterVolume: number | null; // 0-100 in the mode; null: the game's own (Options)
    soundVolume: number | null;
    musicVolume: number | null;
    drawingEngine: "software" | "opengl" | null; // the renderer in the mode; null: the game's own (Options)
    multiThreading: boolean | null; // multithreaded rendering in the mode; null: the game's own (Options)
    // Performance tests (tools/perfrun.py writes these into a sandbox's plugin.store.json):
    editorPinned: boolean; // the view editor's panes stay shown; off, they hide with the cursor like the bar
    bench: boolean; // same camera path every run: first order of every park (visit counter left alone), no shuffle,
                    // mouse input ignored (marked in the perf log instead of showing the controls bar)
    profilerExport: string; // when set: start OpenRCT2's function profiler and export it to this file every minute
}

const DEFAULT_SETTINGS: Settings = {
    autostart: true, shuffle: false, debug: false, speed: 1, fadeMs: 600,
    panTolerance: 500, panToleranceStep: 100, panChanges: "end", inertia: false, changeHold: 2, arriveHold: 1, returnHold: 2, cameraLog: false, scaleToWindow: true,
    window: "borderless", titleMusic: "keep", titles: "overview", captionPlace: "topLeft", captionFrame: "gold", captionBand: "green", lightEffects: false, weatherGloom: false, weather: false, timeOfDay: "day",
    masterVolume: null, soundVolume: null, musicVolume: null, drawingEngine: null, multiThreading: null,
    editorPinned: true, bench: false, profilerExport: "",
};

export function loadSettings(): Settings {
    const stored = context.sharedStorage.get<Partial<Settings>>(NAMESPACE + ".settings", {});
    return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(settings: Settings): void {
    const { titlesOverride: _, ...saved } = settings; // the playlist's titles last only for the run
    context.sharedStorage.set(NAMESPACE + ".settings", saved);
}

/** Views set in the editor, by park key. They replace the playlist's views and are not fitted;
 *  `screen` is the window they were set in (absent: played as set). */
export type Edits = Record<string, { views: View[]; arranged?: true; screen?: [number, number]; reset?: undefined } |
    { reset: true; views?: undefined; arranged?: undefined }>;

/** Each park's edits as the game's last build (or the install) took them in, by park key; the build pane
 *  marks the parks whose edits differ since as needing a build. */
export function loadBuiltEdits(): Edits {
    return context.sharedStorage.get<Edits>(NAMESPACE + ".builtEdits", {});
}

export function saveBuiltEdits(edits: Edits): void {
    context.sharedStorage.set(NAMESPACE + ".builtEdits", edits);
}

/** The parks whose edits differ between two sets of edits. */
export function editsChanged(a: Edits, b: Edits): Set<string> {
    return new Set([...Object.keys(a), ...Object.keys(b)].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])));
}

export function loadEdits(): Edits {
    return context.sharedStorage.get<Edits>(NAMESPACE + ".edits", {});
}

export function saveEdits(edits: Edits): void {
    context.sharedStorage.set(NAMESPACE + ".edits", edits);
    liveEdits = edits;
    writeLive();
}

// The live file (engine files API, patched engine): every save of the editor's edits or Playlist
// properties also writes them, for the installed playlist, to <user dir>/screensaver/live/<name>.json,
// where the tools pick them up without the game's storage: every build applies them, and
// `tools/bakelive.py` writes them into the playlist's files. The game is the file's only writer.

/** The files API of the patched engine (patch "plugin files in the user folder and the clipboard"). */
export interface FilesApi {
    readonly filesFolder: string;
    readFile(name: string): string | null;
    writeFile(name: string, text: string): boolean;
    listFiles(): string[];
    clipboard: string;
}

declare const screensaver: Partial<FilesApi> | undefined;

/** The engine's files API, or undefined (stock engine, or a patched one without it). */
export function filesApi(): FilesApi | undefined {
    return typeof screensaver !== "undefined" && screensaver !== null && typeof screensaver.writeFile === "function"
        ? screensaver as FilesApi : undefined;
}

/** The live file's name for a title sequence: characters outside letters, digits, '.', '_' and '-'
 *  become '_' (tools/mksequence.py live_file_name does the same). */
export function liveFileName(sequence: string): string {
    const base = sequence.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100) || "playlist";
    return base + ".json";
}

/** What the live file holds (version 1). */
export interface LiveFile {
    version: 1;
    sequence: string;
    source?: string; // the playlist file, as installed
    installed?: number; // the install this was edited on (ms since 1970)
    saved: number; // when the game wrote it (ms since 1970)
    edits: Edits; // the editor's edits of the playlist's parks, by park key
    props: PlaylistProps; // the editor's saved Playlist properties and park order
}

let liveEdits: Edits | undefined;
let liveSaved: number | undefined; // when the live file was last written (read from it once)
let liveSaves = 0; // live file writes this run

/** How many times this run wrote the live file (something to tell an edit by, as two can share a ms). */
export function liveSaveCount(): number {
    return liveSaves;
}

/** When the game last saved edits to the playing playlist's live file (ms since 1970), if ever. */
export function lastLiveSave(): number | undefined {
    if (liveSaved === undefined) {
        const api = filesApi();
        const playlist = api ? loadPlaylist() : undefined;
        if (!api || !playlist) {
            return undefined;
        }
        try {
            const file = JSON.parse(api.readFile(liveFileName(playlist.sequence)) || "null") as LiveFile | null;
            liveSaved = file && file.sequence === playlist.sequence && typeof file.saved === "number" ? file.saved : 0;
        } catch {
            liveSaved = 0;
        }
    }
    return liveSaved || undefined;
}
const liveProps: Record<string, PlaylistProps> = {};

/** Another playlist was installed while the game runs (an import from the editor): the old one's edits
 *  leave the storage, as an install takes them (they stay in its live file, which its next build or
 *  install takes in), and the new one starts with none. */
export function startPlaylistEdits(sequence: string): void {
    context.sharedStorage.set(NAMESPACE + ".edits", {});
    context.sharedStorage.set(NAMESPACE + ".builtEdits", {});
    const all = context.sharedStorage.get<Record<string, PlaylistProps>>(NAMESPACE + ".playlistProps", {});
    delete all[sequence];
    context.sharedStorage.set(NAMESPACE + ".playlistProps", all);
    delete liveProps[sequence];
    liveEdits = undefined;
    liveSaved = undefined;
}

export function writeLive(): boolean {
    const api = filesApi();
    const playlist = api ? loadPlaylist() : undefined;
    if (!api || !playlist) {
        return false;
    }
    const all = liveEdits ?? loadEdits();
    const keys = new Set(playlist.parks.map(p => p.key ?? p.fileName));
    const edits: Edits = {};
    for (const key of Object.keys(all)) {
        if (keys.has(key)) {
            edits[key] = all[key];
        }
    }
    const props = liveProps[playlist.sequence] ?? loadPlaylistProps(playlist.sequence);
    const file: LiveFile = {
        version: 1, sequence: playlist.sequence, source: playlist.source, installed: playlist.installed,
        saved: Date.now(), edits, props,
    };
    const ok = api.writeFile(liveFileName(playlist.sequence), JSON.stringify(file, null, 1));
    if (ok) {
        liveSaved = file.saved;
        liveSaves++;
    }
    if (!ok) {
        console.log(`[rct-screensaver] could not write ${liveFileName(playlist.sequence)} in ${api.filesFolder}`);
    }
    return ok;
}

/** How often each park (by key) has been entered, for the order it plays next (circuit_variants);
 *  kept across runs so the orders keep alternating. */
export type Visits = Record<string, number>;

export function loadVisits(): Visits {
    return context.sharedStorage.get<Visits>(NAMESPACE + ".visits", {});
}

export function saveVisits(visits: Visits): void {
    context.sharedStorage.set(NAMESPACE + ".visits", visits);
}

export function loadPlaylist(): Playlist | undefined {
    return context.sharedStorage.get<Playlist>(NAMESPACE + ".playlist");
}

/** Installs a playlist built while the game runs (mksequence.py --install does it otherwise). */
export function savePlaylist(playlist: Playlist): void {
    context.sharedStorage.set(NAMESPACE + ".playlist", playlist);
}

/**
 * Find the playlist's title sequence and check that each park's LOAD command still points
 * at the expected park file. Returns an error message instead if they no longer match
 * (for example after the sequence was edited or replaced without re-running the installer).
 */
export function resolveSequence(playlist: Playlist): TitleSequence | string {
    if (playlist.version !== 1) {
        return `unsupported playlist version ${playlist.version}`;
    }
    const sequence = titleSequenceManager.titleSequences.find(s => s.name === playlist.sequence);
    if (!sequence) {
        return `title sequence "${playlist.sequence}" not found`;
    }
    const commands = sequence.commands;
    const parks = sequence.parks;
    for (const park of playlist.parks) {
        const command = commands[park.load];
        if (!command || command.type !== "load" || parks[command.index]?.fileName !== park.fileName) {
            return `title sequence "${playlist.sequence}" does not match the installed playlist ` +
                `(${park.fileName}); re-run tools/mksequence.py --install`;
        }
    }
    return sequence;
}
