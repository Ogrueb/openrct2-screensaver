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

import { Edits, editsChanged, filesApi, lastLiveSave, liveSaveCount, liveFileName, loadBuiltEdits, loadEdits, Playlist, saveBuiltEdits, Settings } from "./storage";

export type BuildState = "idle" | "running" | "done" | "failed" | "cancelled";

/** What the generator runs for: a build of the playing playlist, an export, an import. */
export type BuildTask = "build" | "export" | "import";

export interface BuildStatus {
    state: BuildState;
    task?: string; // "build", "export" or "import" (an engine with bundles)
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

/** What mksequence.py --live-export / --live-import writes for the plugin (task-<task>.json in the live folder). */
export interface TaskResult {
    taskVersion: 1;
    task: "export" | "import";
    started: number;
    ok: boolean | null; // null: still running
    finished?: number;
    error?: string;
    path?: string; // the bundle
    sequence?: string; // export: the playlist's; import: the imported playlist's, once unpacked
    playlist?: string; // import: the playlist file it wrote
    missing?: string[]; // import: parks neither in the bundle nor the park folder
    messages?: BuildMessage[];
}

export function readTaskResult(task: "export" | "import"): TaskResult | undefined {
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

    constructor(private readonly api: BuildApi | undefined = buildApi()) {}

    get available(): boolean {
        return this.api !== undefined && filesApi() !== undefined;
    }

    /** Export and Import: an engine with the file dialogs. */
    get bundlesAvailable(): boolean {
        return this.available && typeof this.api!.exportPlaylist === "function" && typeof this.api!.importPlaylist === "function";
    }

    get running(): boolean {
        return this.task !== undefined;
    }

    /** What runs: a build, an export, an import (undefined: nothing). */
    get runningTask(): BuildTask | undefined {
        return this.task;
    }

    /** A build is under way: Build and play's, or an import's once the bundle is unpacked. */
    private get building(): boolean {
        return this.task === "build" || (this.task === "import" && this.sequence !== undefined);
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

    private startBundle(task: "export" | "import", run: () => boolean, sequence?: string): void {
        if (!this.bundlesAvailable || this.running) {
            return;
        }
        const name = task === "export" ? "Export" : "Import";
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
        log(task === "export" ? `exporting "${sequence}"` : "importing a playlist");
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
        if (this.task === "import") {
            imported = fresh(readTaskResult("import"));
            if (imported?.ok && imported.sequence && !this.sequence) {
                this.sequence = imported.sequence;
                this.last = undefined; // (the squares are the imported playlist's from here)
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
        if (task === "import" && !(imported?.ok && sequence)) {
            const why = status.state === "cancelled" ? "cancelled" : imported?.error || status.error || "the generator failed";
            this.outcome = { phase: status.state === "cancelled" ? "idle" : "failed", text: `Import ${status.state === "cancelled" ? "cancelled" : "failed: " + why}`, warning: status.state !== "cancelled" };
            this.notes = imported?.messages?.some(m => m.level === "error") ? from(imported)
                : [{ level: status.state === "cancelled" ? "info" : "error", text: `Import ${status.state === "cancelled" ? "cancelled; the playlist plays on as it was" : `failed: ${why} (log: screensaver/build.log in the user folder)`}` }, ...from(imported)];
            log(`import ${status.state === "cancelled" ? "cancelled" : "failed: " + why}`);
            return;
        }
        // (the import's own lines come before its build's, so they are listed under them: newest first)
        this.earlier = task === "import" ? from(imported) : [];
        this.last = current;
        if (status.state === "cancelled") {
            this.outcome = { phase: "idle", text: "Build cancelled" };
            this.notes = [{ level: "info", text: task === "import" ? "Build cancelled; the imported playlist is in your playlists folder, the old one plays on"
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
        const error = this.onReady ? this.onReady(current, task === "import") : "nothing to play it";
        if (error) {
            this.outcome = { phase: "failed", text: `Built, but not taken in: ${error}`, warning: true };
            this.notes = [{ level: "error", text: `Built, but not taken in: ${error}` }];
            log(`build of "${sequence}" not taken in: ${error}`);
            return;
        }
        this.builtFrom = current.started;
        if (task === "build") {
            saveBuiltEdits(this.startEdits); // edits made while it ran still need a build
        }
        const warnings = current.warnings?.length ?? 0;
        const at = timeOfDay(current.finished ?? Date.now());
        this.outcome = {
            phase: "done", text: `${task === "import" ? "Imported" : "Built"} at ${at}, now playing${warnings ? `; ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}`,
        };
        this.notes = [{ level: "ok", text: task === "import" ? `Imported "${sequence}" ${at} in ${clock(took)}, now playing`
            : `Built ${at} in ${clock(took)}, now playing` }];
        for (const w of current.warnings ?? []) {
            log(`build warning: ${w}`);
        }
        log(`${task === "import" ? "imported" : "build of"} "${sequence}" now playing`);
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
        if (this.task === "import" && !this.sequence) {
            return { phase: "running", text: "Importing the playlist" };
        }
        if (this.running) {
            const p = this.progress;
            const name = (p?.parkKey && this.nameOf?.(p.parkKey)) || p?.parkName;
            const where = p?.parks ? `Park ${p.park} of ${p.parks}${name ? " · " + name : ""}` : "Starting";
            return { phase: "running", text: this.task === "import" ? `Building the import · ${where}` : where };
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

    /** Another playlist plays now (an import): what was kept about the old one goes. */
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
