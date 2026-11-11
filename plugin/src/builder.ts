// Builds started from the game (patched engine, patch "build a title sequence in the background"):
// screensaver.build(sequence) runs tools/mksequence.py --live-build in the background, which writes
// the new sequence to <user dir>/screensaver/build/live and its result, with the new playlist, to
// build-<sequence>.json in the live folder. Once it is done the plugin has the engine copy the
// sequence in (screensaver.applyBuild) and swaps the new playlist in: the build is installed with
// the game open.

import { filesApi, lastLiveSave, liveFileName, Playlist, Settings } from "./storage";

export type BuildState = "idle" | "running" | "done" | "failed" | "cancelled";

export interface BuildStatus {
    state: BuildState;
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
    private sequence: string | undefined; // the build this plugin started
    private started = 0;
    private lastPoll = 0;
    private progress: BuildResult | undefined; // the running build's last progress
    private last: BuildResult | undefined; // the last build's result (its squares and messages stay shown)
    private notes: BuildMessage[] = []; // the plugin's own lines about the last build, after the generator's
    private outcome: BuildLine | undefined;
    private builtFrom = 0; // when the build that plays started: edits saved since are not built

    /** A park's name in the playing playlist (the generator knows only the playlist's own names until
     *  it has read the park), and the playlist's park keys in play order (the squares follow it). */
    nameOf: ((key: string) => string | undefined) | undefined;
    orderOf: (() => string[]) | undefined;

    /** Takes a finished build in; returns an error message, or undefined once it plays. */
    onReady: ((result: BuildResult) => string | undefined) | undefined;

    constructor(private readonly api: BuildApi | undefined = buildApi()) {}

    get available(): boolean {
        return this.api !== undefined && filesApi() !== undefined;
    }

    get running(): boolean {
        return this.sequence !== undefined;
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
            log(`build of "${sequence}" did not start: ${message(e)}`);
            return;
        }
        // The squares of the build before (also from an earlier run): parks not reached yet show them dimmed
        this.last = this.last ?? readBuildResult(sequence);
        this.sequence = sequence;
        this.started = Date.now();
        this.progress = undefined;
        this.outcome = undefined;
        this.notes = [];
        log(`building "${sequence}"`);
    }

    cancel(): void {
        if (this.api && this.running && this.api.cancelBuild()) {
            log("build cancelled");
        }
    }

    /** Called on the plugin's update: follows a running build and takes it in when it is done. */
    update(): void {
        if (!this.api || !this.sequence || Date.now() - this.lastPoll < POLL_MS) {
            return;
        }
        this.lastPoll = Date.now();
        const sequence = this.sequence;
        const status = this.api.buildStatus;
        const result = readBuildResult(sequence);
        const current = result && result.started >= this.started - STALE_MS ? result : undefined;
        if (status.state === "running") {
            this.progress = current ?? this.progress;
            return;
        }
        this.sequence = undefined;
        this.progress = undefined;
        this.last = current;
        const took = Date.now() - this.started;
        if (status.state === "cancelled") {
            this.outcome = { phase: "idle", text: "Build cancelled" };
            this.notes = [{ level: "info", text: "Build cancelled; the playlist plays on as it was" }];
            return;
        }
        if (status.state !== "done" || !current?.ok || !current.playlist) {
            const why = current?.ok === false && current.error ? current.error : status.error || "the generator failed";
            this.outcome = { phase: "failed", text: `Build failed: ${why}`, warning: true };
            // The generator names the failure among its messages; else the engine's reason
            this.notes = current?.messages?.some(m => m.level === "error") ? []
                : [{ level: "error", text: `Build failed: ${why} (log: screensaver/build.log in the user folder)` }];
            log(`build of "${sequence}" failed: ${why} (log: screensaver/build.log in the user folder)`);
            return;
        }
        const error = this.onReady ? this.onReady(current) : "nothing to play it";
        if (error) {
            this.outcome = { phase: "failed", text: `Built, but not taken in: ${error}`, warning: true };
            this.notes = [{ level: "error", text: `Built, but not taken in: ${error}` }];
            log(`build of "${sequence}" not taken in: ${error}`);
            return;
        }
        this.builtFrom = current.started;
        const warnings = current.warnings?.length ?? 0;
        const at = timeOfDay(current.finished ?? Date.now());
        this.outcome = {
            phase: "done", text: `Built at ${at}, now playing${warnings ? `; ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}`,
        };
        this.notes = [{ level: "ok", text: `Built ${at} in ${clock(took)}, now playing` }];
        for (const w of current.warnings ?? []) {
            log(`build warning: ${w}`);
        }
        log(`build of "${sequence}" now playing`);
    }

    /** The line the editor shows (the controls bar's chip and the pane's header take theirs from it). */
    get line(): BuildLine {
        if (!this.available) {
            return { phase: "unavailable", text: "Building from the game needs the patched engine" };
        }
        if (this.running) {
            const p = this.progress;
            const name = (p?.parkKey && this.nameOf?.(p.parkKey)) || p?.parkName;
            const where = p?.parks ? `Park ${p.park} of ${p.parks}${name ? " · " + name : ""}` : "Starting";
            return { phase: "running", text: where };
        }
        return this.outcome ?? { phase: "idle", text: "Builds the playlist with your edits and plays it" };
    }

    /** The running build's time so far, ms. */
    get elapsed(): number {
        return this.running ? Date.now() - this.started : 0;
    }

    /** The running build's park and count, for the controls bar's chip. */
    get count(): { park: number; parks: number } | undefined {
        const p = this.progress;
        return this.running && p?.parks ? { park: p.park ?? 0, parks: p.parks } : undefined;
    }

    /** The parks of the running build, else of the last one, in play order: while one runs, a park not
     *  reached yet carries its state from the build before (`previous`, drawn dimmed); otherwise the
     *  squares follow the playing order at once, a reorder included. */
    get parks(): (ParkState & { previous?: boolean })[] {
        if (this.running) {
            const before = new Map((this.last?.parkStates ?? []).filter(p => p.key).map(p => [p.key!, p]));
            return (this.progress?.parkStates ?? []).map(p => {
                const old = p.state === "pending" && p.key ? before.get(p.key) : undefined;
                return old && old.state !== "pending" && old.state !== "building" ? { ...old, previous: true } : p;
            });
        }
        const states = this.last?.parkStates ?? [];
        const order = this.orderOf?.();
        if (!order?.length) {
            return states;
        }
        const rank = new Map(order.map((k, i) => [k, i]));
        return states.map((p, i) => ({ p, i })).sort((a, b) =>
            (rank.get(a.p.key ?? "") ?? order.length + a.i) - (rank.get(b.p.key ?? "") ?? order.length + b.i)).map(x => x.p);
    }

    /** The messages of the running build, else of the last one, newest first. */
    get messages(): BuildMessage[] {
        const r = this.running ? this.progress : this.last;
        return [...this.notes, ...[...(r?.messages ?? [])].reverse()];
    }

    /** Edits saved in the game since the playing build started (or since the install). */
    pendingEdits(installed: number | undefined): boolean {
        const saved = lastLiveSave();
        return saved !== undefined && saved > Math.max(this.builtFrom, installed ?? 0);
    }
}
/** An error's message (also one thrown from the engine's own realm). */
export function message(e: unknown): string {
    const m = (e as { message?: unknown } | null)?.message;
    return typeof m === "string" ? m : String(e);
}

/** The one builder (the editor's Build button and the plugin's update share it). */
export const builder = new Builder();
