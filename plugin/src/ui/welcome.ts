// The screensaver mode with no playlist to play (a fresh install: only the game's own title sequences):
// a panel in the middle of the window that says so and offers the ways to get one in the game, New
// playlist from a folder of parks, Import playlist (a bundle), and the playlists the generator knows
// (live/playlists.json), each built and played on a click. Where no generator can run (builder.ts) the
// buttons are gray and the panel says why. The game's own title sequence plays behind it.

import { builder, readPlaylists, PlaylistInfo, clock } from "../builder";
import type { MouseEvent, ScreensaverApi } from "../mode";
import { Layer, Rect, Scene, backing, button, contains, label, measure, tooltip } from "./kit";
import { THEME } from "./theme";

const WIDTH = 520;
const PAD = 16;
const ROW = 34;
const GAP = 6;
const LIST_MAX = 6; // playlists listed (the rest: "and N more")
const LIST_MS = 3000; // how often the playlists file is read again

type HitId = "new" | "import" | `pl.${number}`;

/** Text cut to a width with an ellipsis. */
function fitText(api: ScreensaverApi, text: string, size: number, width: number): string {
    if (measure(api.overlay, text, size).width <= width) {
        return text;
    }
    let t = text;
    while (t.length > 1 && measure(api.overlay, t + "…", size).width > width) {
        t = t.slice(0, -1);
    }
    return t + "…";
}

/** Words wrapped into lines of a width. */
function wrap(api: ScreensaverApi, text: string, size: number, width: number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (line && measure(api.overlay, next, size).width > width) {
            lines.push(line);
            line = word;
        } else {
            line = next;
        }
    }
    if (line) {
        lines.push(line);
    }
    return lines;
}

export class Welcome {
    private readonly layer: Layer;
    private hits: { id: HitId; rect: Rect; tip: string; off: boolean }[] = [];
    private hover: HitId | undefined;
    private down: HitId | undefined;
    private mouse = { x: 0, y: 0 };
    private playlists: PlaylistInfo[] = [];
    private listRead = 0;
    private shown = "";
    private newSince = 0; // when this panel's New started: the playlist it makes is built and played at once

    /** `problem`: why the installed playlist cannot play (empty: none is installed). */
    constructor(private readonly api: ScreensaverApi, private readonly problem = "") {
        this.layer = new Layer(api.overlay, "rcts.welcome.");
    }

    open(): void {
        this.layer.show(true, 0);
        this.api.cursorVisible = true;
        this.update();
    }

    close(): void {
        this.layer.clear();
    }

    update(): void {
        if (Date.now() - this.listRead >= LIST_MS) {
            this.listRead = Date.now();
            this.playlists = readPlaylists().filter(p => !p.missing);
        }
        // New playlist makes the file only: build and play it at once (there is nothing to keep playing).
        const made = builder.made;
        if (this.newSince && made && made.task === "new" && made.at >= this.newSince && !builder.running) {
            this.newSince = 0;
            builder.openPlaylist(made.sequence);
        } else if (this.newSince && !builder.running && builder.runningTask === undefined && builder.line.phase === "failed") {
            this.newSince = 0; // (New failed: its line shows)
        }
        const scene = this.draw();
        const signature = JSON.stringify([...scene.entries()]);
        if (signature !== this.shown) {
            this.shown = signature;
            this.layer.render(scene);
        }
    }

    /** True when the mouse is taken (over the panel). */
    onMouse(e: MouseEvent): boolean {
        this.mouse = { x: e.x, y: e.y };
        const hit = this.hits.find(h => contains(h.rect, e.x, e.y));
        this.hover = hit?.id;
        if (e.type === "down" && e.button === 0) {
            this.down = hit && !hit.off ? hit.id : undefined;
        } else if (e.type === "up" && e.button === 0) {
            if (hit && !hit.off && this.down === hit.id) {
                this.click(hit.id);
            }
            this.down = undefined;
        }
        this.update();
        return hit !== undefined;
    }

    private click(id: HitId): void {
        if (id === "new") {
            this.newSince = Date.now();
            builder.newPlaylist();
            if (!builder.running) {
                this.newSince = 0; // (the dialog was closed, or New did not start)
            }
        } else if (id === "import") {
            builder.importPlaylist();
        } else {
            const pl = this.playlists[Number(id.slice(3))];
            if (pl) {
                builder.openPlaylist(pl.name);
            }
        }
    }

    private draw(): Scene {
        const scene: Scene = new Map();
        const overlay = this.api.overlay;
        const inner = WIDTH - 2 * PAD;
        const available = builder.available;
        const busy = builder.running;
        const line = builder.line;
        const intro = this.problem
            ? `The installed playlist cannot play: ${this.problem}.`
            : "The screensaver plays a playlist of parks, with views it makes for each park. There is none yet.";
        const introLines = wrap(this.api, intro, 15, inner);
        const reason = available ? "" : builder.unavailableReason;
        const reasonLines = reason ? wrap(this.api, reason, 14, inner) : [];
        const listed = this.playlists.slice(0, LIST_MAX);
        const status = busy ? `${line.text}${builder.elapsed ? ` · ${clock(builder.elapsed)}` : ""}` : line.phase === "failed" ? line.text : "";
        const statusLines = status ? wrap(this.api, status, 14, inner) : [];
        const height = PAD + 28 + 6 + introLines.length * 20 + 10 + reasonLines.length * 19 + (reasonLines.length ? 10 : 0)
            + ROW + GAP + ROW
            + (listed.length ? 14 + 20 + listed.length * (ROW + GAP) + (this.playlists.length > LIST_MAX ? 20 : 0) : 0)
            + (statusLines.length ? 10 + statusLines.length * 19 : 0) + 10 + 18 + PAD;
        const frame = { x: Math.round((ui.width - WIDTH) / 2), y: Math.max(8, Math.round((ui.height - height) / 2)), width: WIDTH, height };
        backing(scene, "frame", frame, THEME.editorBacking);
        let y = frame.y + PAD;
        const x0 = frame.x + PAD;
        label(scene, "title", this.problem ? "Playlist not found" : "No playlist yet", { x: x0, y, width: inner, height: 28 }, 22, overlay, true);
        y += 28 + 6;
        introLines.forEach((t, i) => {
            label(scene, `intro.${i}`, t, { x: x0, y: y + i * 20, width: inner, height: 20 }, 15, overlay);
        });
        y += introLines.length * 20 + 10;
        reasonLines.forEach((t, i) => {
            label(scene, `why.${i}`, t, { x: x0, y: y + i * 19, width: inner, height: 19 }, 14, overlay);
            scene.set(`why.${i}`, { ...scene.get(`why.${i}`)!, colour: THEME.warning });
        });
        y += reasonLines.length * 19 + (reasonLines.length ? 10 : 0);
        this.hits = [];
        const why = !available ? reason : busy ? `Wait for the ${builder.noun} to finish` : "";
        const action = (id: HitId, icon: string, text: string, tip: string, r: Rect, off: boolean) => {
            this.hits.push({ id, rect: r, tip: off && why ? why : tip, off });
            button(scene, id, r, { hover: this.hover === id, down: this.down === id && this.hover === id, on: false, disabled: off },
                { icon, iconSize: 18, text, textSize: 15, left: true }, overlay);
        };
        const parksOff = !builder.parksAvailable || busy;
        action("new", "add", "New playlist from a folder of parks…",
            "Pick a folder of parks (.park files or park downloads): a playlist of them is made, built and played", { x: x0, y, width: inner, height: ROW }, parksOff);
        y += ROW + GAP;
        action("import", "import", "Import playlist…",
            "Pick a playlist bundle (.zip) someone exported: it is imported, built and played", { x: x0, y, width: inner, height: ROW }, !builder.bundlesAvailable || busy);
        y += ROW;
        if (listed.length) {
            y += 14;
            label(scene, "plhead", "YOUR PLAYLISTS", { x: x0, y, width: inner, height: 20 }, 13, overlay, true);
            scene.set("plhead", { ...scene.get("plhead")!, colour: THEME.textDim });
            y += 20;
            listed.forEach((pl, i) => {
                const count = pl.parks !== undefined ? ` (${pl.parks} park${pl.parks === 1 ? "" : "s"})` : "";
                action(`pl.${i}`, "build", fitText(this.api, pl.name + count, 15, inner - 50), `Build "${pl.name}" and play it`,
                    { x: x0, y, width: inner, height: ROW }, !available || busy);
                y += ROW + GAP;
            });
            if (this.playlists.length > LIST_MAX) {
                label(scene, "plmore", `and ${this.playlists.length - LIST_MAX} more`, { x: x0, y, width: inner, height: 20 }, 13, overlay);
                scene.set("plmore", { ...scene.get("plmore")!, colour: THEME.textDim });
                y += 20;
            }
            y -= GAP;
        }
        if (statusLines.length) {
            y += 10;
            statusLines.forEach((t, i) => {
                label(scene, `status.${i}`, t, { x: x0, y: y + i * 19, width: inner, height: 19 }, 14, overlay);
                scene.set(`status.${i}`, { ...scene.get(`status.${i}`)!, colour: line.warning ? THEME.warning : THEME.textGood });
            });
            y += statusLines.length * 19;
        }
        y += 10;
        label(scene, "esc", "Esc leaves the screensaver", { x: x0, y, width: inner, height: 18 }, 13, overlay);
        scene.set("esc", { ...scene.get("esc")!, colour: THEME.textDim });
        const tipped = this.hits.find(h => h.id === this.hover);
        if (tipped && contains(tipped.rect, this.mouse.x, this.mouse.y)) {
            tooltip(scene, "tip", tipped.tip, this.mouse.x, tipped.rect.y - 4, overlay, ui.width);
        }
        return scene;
    }
}
