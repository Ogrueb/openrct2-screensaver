// Builds started from the game (patched engine, patch "build a title sequence in the background"):
// screensaver.build(sequence) runs tools/mksequence.py --live-build in the background, which writes
// the new sequence to <user dir>/screensaver/build/live and its result, with the new playlist, to
// build-<sequence>.json in the live folder. Once it is done the plugin has the engine copy the
// sequence in (screensaver.applyBuild) and swaps the new playlist in: the build is installed with
// the game open. Only the plugin's own code and the parks' scripts wait for a restart.

import { filesApi, liveFileName, Playlist, Settings } from "./storage";

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

/** What mksequence.py --live-build writes for the plugin (build-<sequence>.json in the live folder). */
export interface BuildResult {
    buildVersion: 1;
    sequence: string;
    started: number;
    ok: boolean | null; // null: still building
    park?: number; // while building: the park being resolved (1-based), of `parks`
    parks?: number;
    parkName?: string;
    finished?: number;
    error?: string;
    playlist?: Playlist;
    titleMusic?: Settings["titleMusic"];
    warnings?: string[];
    restart?: string[]; // what takes a restart of the game: "plugin", "park scripts"
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

function clock(ms: number): string {
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
    private progress: BuildResult | undefined;
    private outcome: BuildLine | undefined;

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
            log(`build of "${sequence}" did not start: ${message(e)}`);
            return;
        }
        this.sequence = sequence;
        this.started = Date.now();
        this.progress = undefined;
        this.outcome = undefined;
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
            this.progress = current;
            return;
        }
        this.sequence = undefined;
        this.progress = undefined;
        if (status.state === "cancelled") {
            this.outcome = { phase: "idle", text: "Build cancelled" };
            return;
        }
        if (status.state !== "done" || !current?.ok || !current.playlist) {
            const why = current?.ok === false && current.error ? current.error : status.error || "the generator failed";
            this.outcome = { phase: "failed", text: `Build failed: ${why}`, warning: true };
            log(`build of "${sequence}" failed: ${why} (log: screensaver/build.log in the user folder)`);
            return;
        }
        const error = this.onReady ? this.onReady(current) : "nothing to play it";
        if (error) {
            this.outcome = { phase: "failed", text: `Built, but not taken in: ${error}`, warning: true };
            log(`build of "${sequence}" not taken in: ${error}`);
            return;
        }
        const notes = [
            current.warnings?.length ? `${current.warnings.length} warning${current.warnings.length > 1 ? "s" : ""}` : "",
            current.restart?.length ? `restart to load the new ${current.restart.join(" and ")}` : "",
        ].filter(s => s);
        this.outcome = {
            phase: "done", text: `Built at ${timeOfDay(current.finished ?? Date.now())}, now playing${notes.length ? "; " + notes.join("; ") : ""}`,
            warning: !!current.restart?.length,
        };
        for (const w of current.warnings ?? []) {
            log(`build warning: ${w}`);
        }
        log(`build of "${sequence}" now playing`);
    }

    /** The line the editor shows. */
    get line(): BuildLine {
        if (!this.available) {
            return { phase: "unavailable", text: "Building from the game needs the patched engine" };
        }
        if (this.running) {
            const p = this.progress;
            const where = p?.parks ? `park ${p.park} of ${p.parks}` : "starting";
            return { phase: "running", text: `Building: ${where} (${clock(Date.now() - this.started)})` };
        }
        return this.outcome ?? { phase: "idle", text: "Builds the playlist with your edits and plays it" };
    }
}

/** An error's message (also one thrown from the engine's own realm). */
export function message(e: unknown): string {
    const m = (e as { message?: unknown } | null)?.message;
    return typeof m === "string" ? m : String(e);
}

/** The one builder (the editor's Build button and the plugin's update share it). */
export const builder = new Builder();
