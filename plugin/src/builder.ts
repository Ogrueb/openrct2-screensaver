// Builds started from the game (patched engine, patch "build a title sequence in the background"):
// screensaver.build(sequence) runs tools/mksequence.py --live-build in the background, which writes
// the new sequence to <user dir>/screensaver/build/live and its result, with the new playlist, to
// build-<sequence>.json in the live folder. Once it is done the plugin has the engine copy the
// sequence in (screensaver.applyBuild) and swaps the new playlist in: the build is installed with
// the game open.
//
// Playlist bundles (engine patch "export and import playlist bundles through the system's file
// dialog"): screensaver.exportPlaylist(sequence) and importPlaylist() show the system's Save or Open
// dialog and run the same generator on the picked file (--live-export, --live-import), reporting to
// task-export.json / task-import.json in the live folder. An import builds the bundle's playlist as a
// live build, and the plugin then has the engine install and play it (applyBuild of another sequence).
//
// Parks and new playlists (engine patch "add parks and make playlists through the system's dialogs"):
// screensaver.addPark(sequence) shows the Open dialog for a park, which the generator adds to the
// playlist and builds (--live-add); newPlaylist() shows the folder dialog and makes a playlist of the
// parks in the picked folder (--live-new); copyPlaylist(sequence) shows the Save dialog and copies the
// playlist under the name given (--live-copy). Each reports to task-<task>.json and then builds; a new
// playlist plays as an import does. Another registered playlist (live/playlists.json) is switched to by
// building it (a build of another sequence: "open"), which the parks' cache makes quick.

import { Edits, editsChanged, filesApi, lastLiveSave, liveSaveCount, liveFileName, loadBuiltEdits, loadEdits, Playlist, saveBuiltEdits, Settings } from "./storage";

export type BuildState = "idle" | "running" | "done" | "failed" | "cancelled";

/** What the generator runs for: a build of the playing playlist, an export, an import, a park added, a new
 *  playlist from a folder, a copy of the playlist, a build of another playlist to switch to it. */
export type BuildTask = "build" | "export" | "import" | "add" | "new" | "copy" | "open";

/** The tasks that report to task-<task>.json before their build. */
type FileTask = "export" | "import" | "add" | "new" | "copy";

/** The tasks whose build replaces the playing playlist with another one. */
const NEW_PLAYLIST: BuildTask[] = ["import", "open"];
// Tasks that only make a playlist file: no build follows (owner, 2026-11-12: New keeps the list open, a copy needs
// no rebuild); the playlist plays on and the new one waits in the PLAYLIST list until it is picked.
const FILE_ONLY: BuildTask[] = ["new", "copy"];

/** How the build pane names each task. */
const NOUN: Record<BuildTask, string> = {
    build: "build", export: "export", import: "import", add: "park", new: "new playlist", copy: "copy", open: "switch",
};
const DOING: Record<BuildTask, string> = {
    build: "Building", export: "Exporting", import: "Importing", add: "Adding the park", new: "Making the playlist",
    copy: "Copying the playlist", open: "Switching",
};

export interface BuildStatus {
    state: BuildState;
    task?: string; // "build", "export", "import", "add", "new" or "copy" (an engine with bundles)
    sequence: string;
    exitCode: number;
    started: number; // ms since 1970
    finished: number;
    error: string;
}

/** The engine's build API. */
export interface BuildApi {
    build(sequence: string): void; // throws with the reason when it cannot start
    readonly buildStatus: BuildStatus;
    cancelBuild(): boolean;
    applyBuild(sequence: string): void; // throws with the reason
    // The system's Save / Open dialog, then the generator on the picked bundle; false when the dialog
    // was closed, throws with the reason when it cannot start (absent: an engine without bundles).
    exportPlaylist?(sequence: string): boolean;
    importPlaylist?(): boolean;
    // The system's Open, folder or Save dialog, then the generator; as above (absent: an engine without them).
    addPark?(sequence: string): boolean;
    newPlaylist?(): boolean;
    copyPlaylist?(sequence: string): boolean;
}

/** A playlist the game can build and play (live/playlists.json, which the generator writes). */
export interface PlaylistInfo {
    name: string;
    file: string;
    parks?: number;
    missing?: boolean;
}

export function readPlaylists(): PlaylistInfo[] {
    const text = filesApi()?.readFile("playlists.json");
    if (!text) {
        return [];
    }
    try {
        const list = JSON.parse(text) as { playlistsVersion?: number; playlists?: PlaylistInfo[] };
        return list && list.playlistsVersion === 1 && Array.isArray(list.playlists) ? list.playlists : [];
    } catch {
        return [];
    }
}

/** A park of the build, in play order (the build pane's squares). */
export interface ParkState {
    key?: string;
    name?: string;
    state: "pending" | "building" | "cached" | "built" | "failed" | "missing";
    warnings?: number;
}

/** A line of the build pane's messages; `park` (a park key) when it is about one park. */
export interface BuildMessage {
    level: "info" | "ok" | "warn" | "error";
    text: string;
    park?: string;
}

/** What mksequence.py --live-build writes for the plugin (build-<sequence>.json in the live folder). */
export interface BuildResult {
    buildVersion: 1;
    sequence: string;
    started: number;
    ok: boolean | null; // null: still building
    park?: number; // while building: the park being resolved (1-based), of `parks`
    parks?: number;
    parkName?: string;
    parkKey?: string;
    finished?: number;
    error?: string;
    playlist?: Playlist;
    titleMusic?: Settings["titleMusic"];
    warnings?: string[];
    parkStates?: ParkState[]; // every park in play order (the playlist file's, with the game's edits baked in)
    messages?: BuildMessage[];
}

declare const screensaver: Partial<BuildApi> | undefined;

export function buildApi(): BuildApi | undefined {
    return typeof screensaver !== "undefined" && screensaver !== null && typeof screensaver.build === "function"
        && typeof screensaver.applyBuild === "function" ? screensaver as BuildApi : undefined;
}

/** What mksequence.py --live-export / --live-import / --live-add / --live-new / --live-copy writes for the plugin
 *  (task-<task>.json in the live folder). */
export interface TaskResult {
    taskVersion: 1;
    task: FileTask;
    started: number;
    ok: boolean | null; // null: still running
    finished?: number;
    error?: string;
    path?: string; // the bundle
    sequence?: string; // export, add: the playlist's; import, new, copy: the new playlist's, once written
    playlist?: string; // import, new, copy: the playlist file it wrote; add: the playlist's file
    missing?: string[]; // import: parks neither in the bundle nor the park folder
    parks?: { key: string; name: string }[]; // new: the new playlist's parks, before its first build
    built?: boolean; // copy: the playing build was copied along (applyBuild plays the copy without a rebuild)
    messages?: BuildMessage[];
}

export function readTaskResult(task: FileTask): TaskResult | undefined {
    const text = filesApi()?.readFile(`task-${task}.json`);
    if (!text) {
        return undefined;
    }
    try {
        const result = JSON.parse(text) as TaskResult;
        return result && result.taskVersion === 1 && result.task === task ? result : undefined;
    } catch {
        return undefined;
    }
}

export function buildFileName(sequence: string): string {
    return "build-" + liveFileName(sequence);
}

export function readBuildResult(sequence: string): BuildResult | undefined {
    const text = filesApi()?.readFile(buildFileName(sequence));
    if (!text) {
        return undefined;
    }
    try {
        const result = JSON.parse(text) as BuildResult;
        return result && result.buildVersion === 1 && result.sequence === sequence ? result : undefined;
    } catch {
        return undefined;
    }
}

/** Where the build is, for the editor: the phase and a line to show. */
export interface BuildLine {
    phase: "unavailable" | "idle" | "running" | "done" | "failed";
    text: string;
    warning?: boolean;
}

const POLL_MS = 500;
const STALE_MS = 5000; // a result file older than the build it should belong to (clocks agree: same PC)

function log(message: string): void {
    console.log(`[RCT Screensaver] ${message}`);
}

export function clock(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function timeOfDay(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class Builder {
    private task: BuildTask | undefined; // what this plugin started and still follows
    private sequence: string | undefined; // the build being followed (an import's, once it is known)
    private started = 0;
    private lastPoll = 0;
    private progress: BuildResult | undefined; // the running build's last progress
    private last: BuildResult | undefined; // the last build's result (its squares and messages stay shown)
    private notes: BuildMessage[] = []; // the plugin's own lines about the last task, before the generator's
    private earlier: BuildMessage[] = []; // an import's own lines (unpacking), older than its build's: after them
    private outcome: BuildLine | undefined;
    private builtFrom = 0; // when the build that plays started: edits saved since are not built
    private startEdits: Edits = {}; // the edits as the running build started

    /** A park's name in the playing playlist (the generator knows only the playlist's own names until
     *  it has read the park), and the playlist's park keys in play order (the squares follow it). */
    nameOf: ((key: string) => string | undefined) | undefined;
    orderOf: (() => string[]) | undefined;

    /** Takes a finished build in; returns an error message, or undefined once it plays. `imported`: the
     *  build of a playlist just imported, which replaces the playing one. */
    onReady: ((result: BuildResult, imported: boolean) => string | undefined) | undefined;

    /** The playlist New or Duplicate made last (not built yet): the editor opens the PLAYLIST list on it. */
    made: { sequence: string; at: number; task: "new" | "copy"; playlist?: string; parks?: { key: string; name: string }[] } | undefined;

    /** Plays a copy of the playing playlist from the copied build (no rebuild); an error message, or
     *  undefined once it plays. */
    onCopied: ((sequence: string, source: string | undefined) => string | undefined) | undefined;

    constructor(private readonly api: BuildApi | undefined = buildApi()) {}

    get available(): boolean {
        return this.api !== undefined && filesApi() !== undefined;
    }

    /** Export and Import: an engine with the file dialogs. */
    get bundlesAvailable(): boolean {
        return this.available && typeof this.api!.exportPlaylist === "function" && typeof this.api!.importPlaylist === "function";
    }

    /** Add park, New playlist and Duplicate: an engine with those dialogs. */
    get parksAvailable(): boolean {
        return this.available && typeof this.api!.addPark === "function" && typeof this.api!.newPlaylist === "function"
            && typeof this.api!.copyPlaylist === "function";
    }

    get running(): boolean {
        return this.task !== undefined;
    }

    /** What runs: a build, an export, an import (undefined: nothing). */
    get runningTask(): BuildTask | undefined {
        return this.task;
    }

    /** A build is under way: Build and play's or a switch's, or another task's once its build starts. */
    private get building(): boolean {
        return this.task === "build" || this.task === "open" || (this.task !== undefined && this.task !== "export" && this.sequence !== undefined);
    }

    start(sequence: string): void {
        if (!this.api || this.running) {
            return;
        }
        try {
            this.api.build(sequence);
        } catch (e) {
            this.outcome = { phase: "failed", text: `Build failed: ${message(e)}`, warning: true };
            this.last = undefined;
            this.notes = [{ level: "error", text: `The build did not start: ${message(e)}` }];
            this.earlier = [];
            log(`build of "${sequence}" did not start: ${message(e)}`);
            return;
        }
        // The squares of the build before (also from an earlier run): parks not reached yet show them dimmed
        this.last = this.last ?? readBuildResult(sequence);
        this.begin("build", sequence);
        this.startEdits = JSON.parse(JSON.stringify(loadEdits())) as Edits; // (a copy: the editor changes its edits in place)
        log(`building "${sequence}"`);
    }

    /** Export playlist: the system's Save dialog (the game waits while it is open), then the export in
     *  the background. */
    exportPlaylist(sequence: string): void {
        this.startBundle("export", () => this.api!.exportPlaylist!(sequence), sequence);
    }

    /** Import playlist: the system's Open dialog, then the import and its build in the background. */
    importPlaylist(): void {
        this.startBundle("import", () => this.api!.importPlaylist!());
    }

    /** Add park: the system's Open dialog, then the park added to the playlist and the playlist built. */
    addPark(sequence: string): void {
        if (this.parksAvailable) {
            this.startEdits = JSON.parse(JSON.stringify(loadEdits())) as Edits; // (baked in as a build does)
            this.last = this.last ?? readBuildResult(sequence);
            this.startBundle("add", () => this.api!.addPark!(sequence), sequence);
        }
    }

    /** New playlist from a folder: the system's folder dialog, then the playlist made, built and played. */
    newPlaylist(): void {
        if (this.parksAvailable) {
            this.startBundle("new", () => this.api!.newPlaylist!());
        }
    }

    /** Duplicate: the system's Save dialog names the copy, which is made, built and played. */
    copyPlaylist(sequence: string): void {
        if (this.parksAvailable) {
            this.startBundle("copy", () => this.api!.copyPlaylist!(sequence), sequence);
        }
    }

    /** Switches to another playlist the game knows: it is built (only changed parks) and played. */
    openPlaylist(sequence: string): void {
        if (!this.api || this.running) {
            return;
        }
        try {
            this.api.build(sequence);
        } catch (e) {
            this.outcome = { phase: "failed", text: `Switch failed: ${message(e)}`, warning: true };
            this.notes = [{ level: "error", text: `Could not switch to "${sequence}": ${message(e)}` }];
            log(`switch to "${sequence}" did not start: ${message(e)}`);
            return;
        }
        this.begin("open", sequence);
        this.last = undefined; // (the squares are the other playlist's from here)
        log(`switching to "${sequence}"`);
    }

    private startBundle(task: FileTask, run: () => boolean, sequence?: string): void {
        if (!(task === "export" || task === "import" ? this.bundlesAvailable : this.parksAvailable) || this.running) {
            return;
        }
        const name = { export: "Export", import: "Import", add: "Adding a park", new: "New playlist", copy: "Duplicate" }[task];
        let picked: boolean;
        try {
            picked = run();
        } catch (e) {
            this.outcome = { phase: "failed", text: `${name} failed: ${message(e)}`, warning: true };
            this.notes = [{ level: "error", text: `${name} did not start: ${message(e)}` }];
            this.earlier = [];
            log(`${task} did not start: ${message(e)}`);
            return;
        }
        if (!picked) {
            return; // the dialog was closed
        }
        this.begin(task, undefined);
        log(task === "export" ? `exporting "${sequence}"` : task === "import" ? "importing a playlist"
            : task === "add" ? `adding a park to "${sequence}"` : task === "new" ? "making a playlist from a folder" : `copying "${sequence}"`);
    }

    private begin(task: BuildTask, sequence: string | undefined): void {
        this.task = task;
        this.sequence = sequence;
        this.started = Date.now();
        this.lastPoll = 0;
        this.progress = undefined;
        this.outcome = undefined;
        this.notes = [];
        this.earlier = [];
    }

    cancel(): void {
        if (this.api && this.running && this.api.cancelBuild()) {
            log(`${this.task} cancelled`);
        }
    }

    /** Called on the plugin's update: follows a running task and takes a build in when it is done. */
    update(): void {
        if (!this.api || !this.task || Date.now() - this.lastPoll < POLL_MS) {
            return;
        }
        this.lastPoll = Date.now();
        const status = this.api.buildStatus;
        const running = status.state === "running";
        const fresh = <T extends { started: number }>(r: T | undefined) => r && r.started >= this.started - STALE_MS ? r : undefined;
        if (this.task === "export") {
            if (!running) {
                this.finishExport(status, fresh(readTaskResult("export")));
            }
            return;
        }
        let imported: TaskResult | undefined;
        if (this.task !== "build" && this.task !== "open") {
            imported = fresh(readTaskResult(this.task));
            if (imported?.ok && imported.sequence && !this.sequence) {
                this.sequence = imported.sequence;
                if (!FILE_ONLY.includes(this.task)) {
                    this.last = undefined; // (the squares are the imported playlist's from here)
                }
            }
        }
        const sequence = this.sequence;
        const current = sequence ? fresh(readBuildResult(sequence)) : undefined;
        if (running) {
            this.progress = current ?? this.progress;
            return;
        }
        const task = this.task;
        this.task = undefined;
        this.sequence = undefined;
        this.progress = undefined;
        const took = Date.now() - this.started;
        const from = (r: { messages?: BuildMessage[] } | undefined) => [...(r?.messages ?? [])].reverse();
        const what = { build: "Build", open: "Switch", import: "Import", add: "Adding the park", new: "New playlist", copy: "Duplicate", export: "Export" }[task];
        if (task !== "build" && task !== "open" && !(imported?.ok && sequence)) {
            const why = status.state === "cancelled" ? "cancelled" : imported?.error || status.error || "the generator failed";
            this.outcome = { phase: status.state === "cancelled" ? "idle" : "failed", text: `${what} ${status.state === "cancelled" ? "cancelled" : "failed: " + why}`, warning: status.state !== "cancelled" };
            this.notes = imported?.messages?.some(m => m.level === "error") ? from(imported)
                : [{ level: status.state === "cancelled" ? "info" : "error", text: `${what} ${status.state === "cancelled" ? "cancelled; the playlist plays on as it was" : `failed: ${why} (log: screensaver/build.log in the user folder)`}` }, ...from(imported)];
            log(`${NOUN[task]} ${status.state === "cancelled" ? "cancelled" : "failed: " + why}`);
            return;
        }
        if (task === "copy" && imported!.built && this.onCopied) {
            // The copy plays at once from the playing build (owner, 2026-11-13: a copy needs no rebuild)
            const made = imported!.sequence!;
            const error = this.onCopied(made, imported!.playlist);
            if (!error) {
                this.outcome = { phase: "done", text: `Copied to "${made}", now playing` };
                this.notes = [{ level: "ok", text: `Copied to "${made}", now playing; the original keeps its own file` }];
                this.earlier = [];
                log(`copy "${made}" now playing`);
                return;
            }
            log(`copy "${made}" not taken in: ${error}`); // (listed to pick instead)
        }
        if (FILE_ONLY.includes(task)) {
            const made = imported!.sequence!;
            const verb = task === "new" ? "Made" : "Copied";
            this.outcome = { phase: "idle", text: `${verb} "${made}"` };
            this.notes = [{ level: "ok", text: task === "new" && imported!.parks?.length ? `${verb} "${made}"; tick and order its parks, then build it`
                : `${verb} "${made}"; pick it above to play it` }];
            this.earlier = from(imported).filter(m => m.level !== "ok"); // (the generator's own line says the same)
            this.made = { sequence: made, at: Date.now(), task: task as "new" | "copy", playlist: imported!.playlist, parks: imported!.parks };
            log(`${NOUN[task]} "${made}" made`);
            return;
        }
        // (the task's own lines come before its build's, so they are listed under them: newest first)
        this.earlier = task !== "build" && task !== "open" ? from(imported) : [];
        this.last = current;
        if (status.state === "cancelled") {
            this.outcome = { phase: "idle", text: "Build cancelled" };
            this.notes = [{ level: "info", text: task === "import" ? "Build cancelled; the imported playlist is in your playlists folder, the old one plays on"
                : task === "new" || task === "copy" ? "Build cancelled; the new playlist is in your playlists folder, the old one plays on"
                : task === "add" ? "Build cancelled; the park is in the playlist file and plays after the next build"
                : task === "open" ? "Switch cancelled; the playlist plays on as it was"
                : "Build cancelled; the playlist plays on as it was" }];
            return;
        }
        if (status.state !== "done" || !current?.ok || !current.playlist) {
            const why = current?.ok === false && current.error ? current.error : status.error || "the generator failed";
            this.outcome = { phase: "failed", text: `Build failed: ${why}`, warning: true };
            // The generator names the failure among its messages; else the engine's reason
            this.notes = [...(current?.messages?.some(m => m.level === "error") ? []
                : [{ level: "error" as const, text: `Build failed: ${why} (log: screensaver/build.log in the user folder)` }])];
            log(`build of "${sequence}" failed: ${why} (log: screensaver/build.log in the user folder)`);
            return;
        }
        const replaces = NEW_PLAYLIST.includes(task);
        const error = this.onReady ? this.onReady(current, replaces) : "nothing to play it";
        if (error) {
            this.outcome = { phase: "failed", text: `Built, but not taken in: ${error}`, warning: true };
            this.notes = [{ level: "error", text: `Built, but not taken in: ${error}` }];
            log(`build of "${sequence}" not taken in: ${error}`);
            return;
        }
        this.builtFrom = current.started;
        if (task === "build" || task === "add") {
            saveBuiltEdits(this.startEdits); // edits made while it ran still need a build
        }
        const warnings = current.warnings?.length ?? 0;
        const at = timeOfDay(current.finished ?? Date.now());
        const done = { build: "Built", add: "Built", import: "Imported", new: "Made", copy: "Copied", open: "Switched", export: "Exported" }[task];
        this.outcome = {
            phase: "done", text: `${done} at ${at}, now playing${warnings ? `; ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}`,
        };
        this.notes = [{ level: "ok", text: task === "build" || task === "add" ? `Built ${at} in ${clock(took)}, now playing`
            : `${done} "${sequence}" ${at} in ${clock(took)}, now playing` }];
        for (const w of current.warnings ?? []) {
            log(`build warning: ${w}`);
        }
        log(`${NOUN[task]} "${sequence}" now playing`);
    }

    private finishExport(status: BuildStatus, result: TaskResult | undefined): void {
        this.task = undefined;
        const lines = [...(result?.messages ?? [])].reverse();
        if (status.state === "cancelled") {
            this.outcome = { phase: "idle", text: "Export cancelled" };
            this.notes = [{ level: "info", text: "Export cancelled" }];
        } else if (status.state === "done" && result?.ok) {
            this.outcome = { phase: "idle", text: `Exported to ${result.path ?? "the bundle"}` };
            // (the generator's own line names the file)
            this.notes = lines;
        } else {
            const why = result?.ok === false && result.error ? result.error : status.error || "the generator failed";
            this.outcome = { phase: "failed", text: `Export failed: ${why}`, warning: true };
            this.notes = lines.some(m => m.level === "error") ? lines
                : [{ level: "error", text: `Export failed: ${why} (log: screensaver/build.log in the user folder)` }, ...lines];
        }
        log(`export: ${this.outcome.text}`);
    }

    /** The line the editor shows (the controls bar's chip and the pane's header take theirs from it). */
    get line(): BuildLine {
        if (!this.available) {
            return { phase: "unavailable", text: "Building from the game needs the patched engine" };
        }
        if (this.task === "export") {
            return { phase: "running", text: "Exporting the playlist" };
        }
        if (this.task && this.task !== "build" && this.task !== "open" && !this.sequence) {
            return { phase: "running", text: this.task === "import" ? "Importing the playlist" : DOING[this.task] };
        }
        if (this.running) {
            const p = this.progress;
            const name = (p?.parkKey && this.nameOf?.(p.parkKey)) || p?.parkName;
            const where = p?.parks ? `Park ${p.park} of ${p.parks}${name ? " · " + name : ""}` : "Starting";
            return { phase: "running", text: this.task === "import" ? `Building the import · ${where}`
                : this.task === "new" || this.task === "copy" ? `Building the new playlist · ${where}`
                : this.task === "open" ? `Building "${this.sequence}" · ${where}` : where };
        }
        return this.outcome ?? { phase: "idle", text: "" };
    }

    /** The running task's time so far, ms. */
    get elapsed(): number {
        return this.running ? Date.now() - this.started : 0;
    }

    /** The running build's park and count, for the controls bar's chip. */
    get count(): { park: number; parks: number } | undefined {
        const p = this.progress;
        return this.building && p?.parks ? { park: p.park ?? 0, parks: p.parks } : undefined;
    }

    /** The controls bar's chip while a task runs (the header's state is the same, lower case). */
    get chip(): string | undefined {
        if (!this.running) {
            return undefined;
        }
        const count = this.count;
        return this.task === "export" ? "Exporting" : this.task === "import" && !count ? "Importing"
            : this.task && this.task !== "build" && this.task !== "open" && !count ? DOING[this.task]
            : count ? `Building ${count.park}/${count.parks}` : "Building";
    }

    /** The parks whose edits changed since the game's last build took them in (or since the install). */
    dirty(): Set<string> {
        // (worked out again only after an edit is saved, or a build is taken in)
        const stamp = `${liveSaveCount()}|${this.builtFrom}`;
        if (stamp !== this.dirtyStamp) {
            this.dirtySet = editsChanged(loadEdits(), loadBuiltEdits());
            this.dirtyStamp = stamp;
        }
        return this.dirtySet;
    }

    private dirtyStamp = "";
    private dirtySet = new Set<string>();

    /** A square per park in play order. Between builds: the last build's states (each park "built" when
     *  there is none yet), in the playing order (a reorder moves them at once), a park with edits since
     *  marked `stale` (drawn dimmed: it needs a build). While a build runs: the generator's states, a park
     *  not reached yet keeping its state from before, dimmed only when it needs a build (owner,
     *  2026-11-11). */
    get parks(): (ParkState & { stale?: boolean })[] {
        const dirty = this.dirty();
        const before = new Map((this.last?.parkStates ?? []).filter(p => p.key).map(p => [p.key!, p]));
        const carried = (key: string, p?: ParkState): ParkState & { stale?: boolean } => {
            const old = before.get(key);
            const base = old && old.state !== "pending" && old.state !== "building" ? old : { key, name: p?.name, state: "built" as const };
            return { ...base, stale: dirty.has(key) };
        };
        if (this.building) {
            return (this.progress?.parkStates ?? []).map(p => p.state === "pending" && p.key ? carried(p.key, p) : p);
        }
        const order = this.orderOf?.() ?? [];
        if (!order.length) {
            return this.last?.parkStates ?? [];
        }
        // (a park the last build left out, as its file was missing, stays at the end)
        const shown = new Set(order);
        return [...order.map(key => carried(key)), ...(this.last?.parkStates ?? []).filter(p => p.key && !shown.has(p.key))];
    }

    /** The messages of the running build, else of the last one, newest first (the plugin's own lines
     *  about the last task on top, an import's unpacking lines last). */
    get messages(): BuildMessage[] {
        const r = this.building ? this.progress : this.last;
        return [...this.notes, ...[...(r?.messages ?? [])].reverse(), ...this.earlier];
    }

    /** Edits saved in the game since the playing build started (or since the install). */
    pendingEdits(installed: number | undefined): boolean {
        const saved = lastLiveSave();
        return saved !== undefined && saved > Math.max(this.builtFrom, installed ?? 0);
    }

    /** What the running task is called on the Cancel button ("Cancel <noun>"). */
    get noun(): string | undefined {
        return this.task ? NOUN[this.task] : undefined;
    }

    /** Another playlist plays now (an import, a new playlist, a switch): what was kept about the old one goes. */
    forgetPlaylist(): void {
        this.dirtyStamp = "";
        this.startEdits = {};
    }
}
/** An error's message (also one thrown from the engine's own realm). */
export function message(e: unknown): string {
    const m = (e as { message?: unknown } | null)?.message;
    return typeof m === "string" ? m : String(e);
}

/** The one builder (the editor's Build button and the plugin's update share it). */
export const builder = new Builder();
