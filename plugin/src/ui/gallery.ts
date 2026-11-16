// The park gallery in the screensaver mode (owner's design, 2026-11-16; mockups in the project files'
// editor-ui/gallery/, docs/park-gallery.md stage 4): one pane over the editor that adds parks to the playing
// playlist or picks the parks of a new one. It shows the engine's gallery (the folders the user added and the
// engine's own preview renders, `screensaver.gallery`), filtered and sorted on the left, as tiles in the
// middle (1 to 7 per row), with the picked parks in play order on the right and, for a new playlist, the
// generation options under them. The park behind holds still while the pane is open (`screensaver.paused`),
// which leaves the machine to the preview renders. Builders, scripts and event views come from the generator
// (`live/gallery-details.json`, mksequence.py --gallery-details), read in the background.

import type { MouseEvent, OverlayElement, ScreensaverApi } from "../mode";
import { Layer, Rect, Scene, backing, bevel, button, contains, measure, slider, sliderValue, tooltip } from "./kit";
import type { ButtonState } from "./kit";
import { THEME, Z } from "./theme";
import { generationClick, generationRows } from "./generation";
import { filesApi, loadSettings, saveSettings } from "../storage";
import type { Generation } from "../storage";

export interface GalleryFolder {
    path: string;
    name: string;
    count: number;
    own: boolean; // the user directory's gallery folder
}

export interface GalleryEntry {
    path: string;
    folder: string;
    name: string;
    file: string;
    kind: string; // park, sv6, sc6, sv4, sc4, zip
    mapSize?: { x: number; y: number };
    date?: { year: number; month: number; day: number };
    modified: number; // s since 1970
    size: number;
    read?: boolean;
    picture: string; // the render's absolute path once ready
    pictureState: "ready" | "pending" | "none";
}

/** The engine's gallery (engine patch "the park gallery in the plugin API"). */
export interface GalleryApi {
    readonly version: number; // bumps when folders, entries or a picture change
    readonly folders: GalleryFolder[];
    readonly entries: GalleryEntry[];
    addFolder(): boolean; // the system's folder dialog
    removeFolder(path: string): void;
    requestPictures(paths: string[]): void; // rendered one at a time; each call replaces the waiting ones
    refresh(): void;
    scanDetails?(): boolean; // starts the generator's details scan in the background
}

/** What the generator knows of a park (live/gallery-details.json). */
export interface ParkDetails {
    name?: string;
    builders?: string[];
    scripts?: string[];
    events?: number;
    released?: string; // YYYY-MM-DD (the NE catalog)
    built?: [number, number]; // the built area in tiles: the content box the preview render is framed on
    error?: string;
}

declare const screensaver: { gallery?: GalleryApi; paused?: boolean } | undefined;

export function galleryApi(): GalleryApi | undefined {
    const api = typeof screensaver === "undefined" ? undefined : screensaver.gallery;
    return api && typeof api.requestPictures === "function" ? api : undefined;
}

/** The job the pane is open for. */
export type GalleryJob =
    | { kind: "add"; sequence: string; playlist: string; has: Set<string>; count: number } // has: file names in use, lower case
    | { kind: "new"; generation: Generation };

/** What the pane's buttons do (the editor's or the no-playlist panel's side). Each returns true when the
 *  task started, which closes the pane. */
export interface GalleryHost {
    add(paths: string[]): boolean;
    create(paths: string[], generation: Generation): boolean;
    browse(generation?: Generation): boolean; // the system's dialog instead (a file to add, a folder for a new playlist)
    importBundle?(): boolean;
    busy(): string; // why nothing can start now ("": it can)
}

export const GALLERY_COLUMNS = { min: 1, max: 7, default: 4 };
export const PREVIEW = { width: 250, height: 200 }; // the engine's renders
const DETAILS_FILE = "gallery-details.json";
const DETAILS_MS = 2000;
const REDRAW_MS = 1000; // with nothing changed (the header's counts, a task ending)
const LIFT = 300; // over the editor's panes and tooltips
const PICK_ROW = 34;
const NEW_PICK_ROWS = 6; // a new playlist's picks shown; a scroll bar past that (owner, 2026-11-16)
const ORANGE = THEME.dragLine;

type SizeClass = "any" | "s" | "m" | "l";
type SortKey = "name" | "date" | "size";

interface Hit {
    id: string;
    rect: Rect;
    tip: string;
    off: boolean;
}

/** A park's size in tiles: its built area (the generator's content box, which the preview renders are framed
 *  on; owner, 2026-11-16: not the raw map, which is often far larger than what is built), the map until the
 *  generator has read the park and for RCT saves. */
export function builtSize(entry: GalleryEntry, details?: ParkDetails): { x: number; y: number } {
    return details?.built ? { x: details.built[0], y: details.built[1] } : { x: entry.mapSize?.x ?? 0, y: entry.mapSize?.y ?? 0 };
}

/** S under 64 built tiles on the longer side, M under 128, L from there. */
export function sizeClass(entry: GalleryEntry, details?: ParkDetails): SizeClass {
    const size = builtSize(entry, details);
    const side = Math.max(size.x, size.y);
    return side <= 0 ? "any" : side < 64 ? "s" : side < 128 ? "m" : "l";
}

export interface GalleryFilter {
    folder: string; // "": every folder
    hideUsed: boolean;
    size: SizeClass;
    scripts: boolean;
    events: boolean;
    sort: SortKey;
}

/** The entries a filter shows, in its order. */
export function filterEntries(entries: GalleryEntry[], f: GalleryFilter, details: Record<string, ParkDetails>,
    used: (e: GalleryEntry) => boolean, nameOf: (e: GalleryEntry) => string): GalleryEntry[] {
    const shown = entries.filter(e => (!f.folder || e.folder === f.folder)
        && (!f.hideUsed || !used(e))
        && (f.size === "any" || sizeClass(e, details[e.path]) === f.size)
        && (!f.scripts || (details[e.path]?.scripts?.length ?? 0) > 0)
        && (!f.events || (details[e.path]?.events ?? 0) > 0));
    const when = (e: GalleryEntry) => {
        const released = details[e.path]?.released;
        return released ? Date.parse(released) / 1000 : e.modified;
    };
    const area = (e: GalleryEntry) => { const size = builtSize(e, details[e.path]); return size.x * size.y; };
    const byName = (a: GalleryEntry, b: GalleryEntry) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" });
    return shown.sort(f.sort === "date" ? (a, b) => when(b) - when(a) || byName(a, b)
        : f.sort === "size" ? (a, b) => area(b) - area(a) || byName(a, b) : byName);
}

/** The grid's measures for a width: tiles per row fit with their gaps, pictures 5:4. */
export function gridLayout(width: number, columns: number): { gap: number; tile: number; picture: number; caption: number; row: number } {
    const gap = columns > 5 ? 6 : 12;
    const tile = Math.max(40, Math.floor((width - (columns - 1) * gap) / columns));
    const picture = Math.round((tile - 2) * PREVIEW.height / PREVIEW.width);
    const caption = tile < 170 ? 24 : 44; // the name; with room, the builders line too
    return { gap, tile, picture, caption, row: picture + 2 + caption + gap };
}

export class Gallery {
    private readonly layer: Layer;
    private job: GalleryJob | undefined;
    private host: GalleryHost | undefined;
    private hits: Hit[] = [];
    private mouse = { x: 0, y: 0 };
    private down: string | undefined;
    private filter: GalleryFilter = { folder: "", hideUsed: false, size: "any", scripts: false, events: false, sort: "name" };
    private columns = GALLERY_COLUMNS.default;
    private picks: string[] = [];
    private scroll = 0; // the grid's first row
    private pickScroll = 0;
    private generation: Generation | undefined;
    private details: Record<string, ParkDetails> = {};
    private detailsDone = false;
    private rank = new Map<string, number>(); // the tiles' places while names are still being read
    private rankKey = "";
    private detailsRead = 0;
    private scanned = -1; // the entry count the details scan was started for
    private shownEntries: GalleryEntry[] = [];
    private listKey = "";
    private asked = "";
    private drawn = "";
    private dirty = true;
    private drawnVersion = -1;
    private drawnAt = 0;
    private gridRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
    private picksRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
    private fullRows = 1;
    private totalRows = 0;
    private note = ""; // the last thing that did not work, in the header
    private fits = new Map<string, string>();

    constructor(private readonly mode: ScreensaverApi) {
        this.layer = new Layer(mode.overlay, "rcts.gallery.");
    }

    get isOpen(): boolean {
        return this.job !== undefined;
    }

    open(job: GalleryJob, host: GalleryHost): void {
        if (!galleryApi()) {
            return;
        }
        this.job = job;
        this.host = host;
        this.picks = [];
        this.scroll = 0;
        this.pickScroll = 0;
        this.note = "";
        this.generation = job.kind === "new" ? { ...job.generation } : undefined;
        this.filter = { ...this.filter, folder: "", hideUsed: false };
        const stored = loadSettings().galleryColumns;
        this.columns = Math.max(GALLERY_COLUMNS.min, Math.min(GALLERY_COLUMNS.max, Math.round(stored ?? GALLERY_COLUMNS.default)));
        this.listKey = "";
        this.asked = "";
        this.scanned = -1;
        this.detailsRead = 0;
        this.setPaused(true);
        this.mode.cursorVisible = true;
        this.layer.show(true, 0);
        this.dirty = true;
        this.update();
    }

    close(): void {
        if (!this.job) {
            return;
        }
        this.job = undefined;
        this.host = undefined;
        this.down = undefined;
        this.setPaused(false);
        this.layer.clear();
        this.drawn = "";
    }

    /** The park behind holds still while the pane is open (owner, 2026-11-16: headroom for the renders). */
    private setPaused(on: boolean): void {
        if (typeof screensaver !== "undefined" && "paused" in screensaver) {
            try {
                screensaver.paused = on;
            } catch {
                // (an engine that refuses it outside the mode: the pane works without)
            }
        }
    }

    update(): void {
        const api = galleryApi();
        if (!this.job || !api) {
            return;
        }
        this.readDetails(api);
        // (asking for the version keeps the engine's background work going)
        const version = api.version;
        if (!this.dirty && version === this.drawnVersion && Date.now() - this.drawnAt < REDRAW_MS) {
            return;
        }
        this.drawnVersion = version;
        this.drawnAt = Date.now();
        const scene = this.draw(api);
        const signature = JSON.stringify([...scene.entries()]);
        if (signature !== this.drawn) {
            this.drawn = signature;
            this.layer.render(scene);
        }
        this.dirty = false;
    }

    /** The generator's details, read again every couple of seconds while its scan runs; the scan is started
     *  when the pane opens and when parks appear. */
    private readDetails(api: GalleryApi): void {
        const count = api.entries.length;
        if (count !== this.scanned && typeof api.scanDetails === "function" && count > 0) {
            try {
                if (api.scanDetails() !== false) {
                    this.scanned = count;
                    this.detailsDone = false;
                }
            } catch {
                this.scanned = count; // (no generator: the pane shows what the engine knows)
                this.detailsDone = true;
            }
        }
        if (Date.now() - this.detailsRead < DETAILS_MS || (this.detailsDone && this.scanned === count && this.detailsRead > 0)) {
            return;
        }
        this.detailsRead = Date.now();
        const text = filesApi()?.readFile(DETAILS_FILE);
        if (!text) {
            return;
        }
        try {
            const file = JSON.parse(text) as { detailsVersion?: number; done?: boolean; parks?: Record<string, ParkDetails> };
            if (file.detailsVersion === 2 && file.parks) {
                this.dirty = true;
                this.details = file.parks;
                this.detailsDone = file.done === true;
                this.listKey = "";
            }
        } catch {
            // (half a file: read again next time)
        }
    }

    private get hasDetails(): boolean {
        return Object.keys(this.details).length > 0;
    }

    private used(e: GalleryEntry): boolean {
        return this.job?.kind === "add" && this.job.has.has(e.file.toLowerCase());
    }

    private nameOf(e: GalleryEntry): string {
        return this.details[e.path]?.name || e.name || e.file.replace(/\.[^.]+$/, "");
    }

    private entries(api: GalleryApi): GalleryEntry[] {
        const key = `${api.version}|${JSON.stringify(this.filter)}`;
        if (key !== this.listKey) {
            this.listKey = key;
            const shown = filterEntries(api.entries.slice(), this.filter, this.details, e => this.used(e), e => this.nameOf(e));
            // Names arrive as the engine and the generator read the parks: the tiles keep their places while
            // they do and are sorted once when everything is read (owner's test, 2026-11-16: the order jumped)
            const settled = this.detailsDone && api.entries.every(e => e.read !== false);
            const rankKey = `${JSON.stringify(this.filter)}|${settled}|${api.entries.length}`;
            if (rankKey !== this.rankKey || !this.rank.size) {
                this.rankKey = rankKey;
                this.rank = new Map(shown.map((e, i) => [e.path, i]));
            } else {
                const rank = (e: GalleryEntry) => this.rank.get(e.path) ?? Number.MAX_SAFE_INTEGER;
                shown.sort((x, y) => rank(x) - rank(y));
            }
            this.shownEntries = shown;
            // Picks whose file left the gallery go
            const known = new Set(api.entries.map(e => e.path));
            this.picks = this.picks.filter(p => known.has(p));
        }
        return this.shownEntries;
    }

    /** Every mouse event is the pane's while it is open. */
    onMouse(e: MouseEvent): boolean {
        if (!this.job) {
            return false;
        }
        if (e.type !== "wheel") {
            this.mouse = { x: e.x, y: e.y };
        }
        const hit = this.hitAt(this.mouse.x, this.mouse.y);
        if (e.type === "wheel") {
            const step = e.delta > 0 ? -1 : 1;
            if (contains(this.picksRect, this.mouse.x, this.mouse.y)) {
                this.pickScroll += step;
            } else if (contains(this.gridRect, this.mouse.x, this.mouse.y)) {
                this.scroll += step;
            }
        } else if (e.type === "down" && e.button === 0) {
            this.down = hit && !hit.off ? hit.id : undefined;
            if (this.down === "slider" || this.down === "sb") {
                this.dragTo(hit!);
            }
        } else if (e.type === "move" && this.down) {
            const held = this.hits.find(h => h.id === this.down);
            if (held && (this.down === "slider" || this.down === "sb")) {
                this.dragTo(held);
            } else if (this.down.startsWith("pick.") && hit?.id.startsWith("pick.") && hit.id !== this.down) {
                // A picked park dragged over another takes its place
                const from = Number(this.down.slice(5));
                const to = Number(hit.id.slice(5));
                const [moved] = this.picks.splice(from, 1);
                this.picks.splice(to, 0, moved);
                this.down = `pick.${to}`;
            }
        } else if (e.type === "up" && e.button === 0) {
            if (hit && !hit.off && this.down === hit.id) {
                this.click(hit.id);
            }
            this.down = undefined;
        }
        this.dirty = true;
        if (this.job) {
            this.update();
        }
        return true;
    }

    private hitAt(x: number, y: number): Hit | undefined {
        // (later hits lie on top: a tile's tick, a row's remove button)
        for (let i = this.hits.length - 1; i >= 0; i--) {
            if (contains(this.hits[i].rect, x, y)) {
                return this.hits[i];
            }
        }
        return undefined;
    }

    private dragTo(hit: Hit): void {
        if (hit.id === "slider") {
            const span = GALLERY_COLUMNS.max - GALLERY_COLUMNS.min;
            const columns = GALLERY_COLUMNS.min + Math.round(sliderValue(hit.rect, this.mouse.x) * span);
            if (columns !== this.columns) {
                // The row at the top stays at the top
                const first = this.scroll * this.columns;
                this.columns = columns;
                this.scroll = Math.floor(first / columns);
                saveSettings({ ...loadSettings(), galleryColumns: columns });
            }
        } else {
            const share = Math.max(0, Math.min(1, (this.mouse.y - hit.rect.y) / Math.max(1, hit.rect.height)));
            this.scroll = Math.round(share * Math.max(0, this.totalRows - this.fullRows));
        }
    }

    private click(id: string): void {
        const api = galleryApi();
        const host = this.host;
        const job = this.job;
        if (!api || !host || !job) {
            return;
        }
        this.note = "";
        const [kind, arg] = id.split(/\.(.*)/s);
        const n = Number(arg);
        if (id === "close" || id === "cancel") {
            this.close();
        } else if (id === "go") {
            const started = job.kind === "add" ? host.add(this.picks.slice()) : host.create(this.picks.slice(), this.generation!);
            if (started) {
                this.close();
            }
        } else if (id === "browse") {
            if (host.browse(this.generation)) {
                this.close();
            }
        } else if (id === "emptyImport") {
            if (host.importBundle?.()) {
                this.close();
            }
        } else if (id === "addFolder" || id === "emptyAdd") {
            try {
                if (api.addFolder()) {
                    this.filter.folder = "";
                    this.listKey = "";
                }
            } catch (e) {
                this.note = `The folder was not added: ${e instanceof Error ? e.message : String(e)}`;
            }
        } else if (kind === "folder") {
            this.filter.folder = n < 0 ? "" : api.folders[n]?.path ?? "";
            this.scroll = 0;
        } else if (kind === "folderx") {
            const folder = api.folders[n];
            if (folder && !folder.own) {
                api.removeFolder(folder.path);
                if (this.filter.folder === folder.path) {
                    this.filter.folder = "";
                }
                this.listKey = "";
            }
        } else if (kind === "show") {
            this.filter.hideUsed = n === 1;
            this.scroll = 0;
        } else if (kind === "size") {
            this.filter.size = (["any", "s", "m", "l"] as SizeClass[])[n];
            this.scroll = 0;
        } else if (id === "has.scripts") {
            this.filter.scripts = !this.filter.scripts;
            this.scroll = 0;
        } else if (id === "has.events") {
            this.filter.events = !this.filter.events;
            this.scroll = 0;
        } else if (kind === "sort") {
            this.filter.sort = (["name", "date", "size"] as SortKey[])[n];
            this.scroll = 0;
        } else if (kind === "tile") {
            const entry = this.shownEntries[n];
            if (entry && !this.used(entry)) {
                const at = this.picks.indexOf(entry.path);
                if (at >= 0) {
                    this.picks.splice(at, 1);
                } else {
                    this.picks.push(entry.path);
                    this.pickScroll = this.picks.length; // (clamped when drawn: the new pick shows)
                }
            }
        } else if (kind === "pickx") {
            this.picks.splice(n, 1);
        } else if (id === "clear") {
            this.picks = [];
        } else if (this.generation && id.startsWith("g")) {
            this.generation = generationClick(this.generation, id, "g") ?? this.generation;
        }
    }

    private fit(text: string, size: number, width: number, bold = false): string {
        const key = `${size}|${bold ? 1 : 0}|${Math.round(width)}|${text}`;
        let out = this.fits.get(key);
        if (out === undefined) {
            const overlay = this.mode.overlay;
            out = text;
            if (overlay.measureText(text, { size, bold }).width > width) {
                // (cut by the average letter first, then letter by letter)
                let t = text.slice(0, Math.max(1, Math.floor(text.length * width / overlay.measureText(text, { size, bold }).width) + 1));
                while (t.length > 1 && overlay.measureText(t + "…", { size, bold }).width > width) {
                    t = t.slice(0, -1);
                }
                out = t.trimEnd() + "…";
            }
            if (this.fits.size > 3000) {
                this.fits.clear();
            }
            this.fits.set(key, out);
        }
        return out;
    }

    private draw(api: GalleryApi): Scene {
        const scene: Scene = new Map();
        const overlay = this.mode.overlay;
        const job = this.job!;
        const host = this.host!;
        const W = ui.width;
        const H = ui.height;
        const narrow = W < 1300;
        const hover = this.hitAt(this.mouse.x, this.mouse.y)?.id; // (from the last layout)
        this.hits = [];
        const rect = (id: string, r: Rect, fill: string, z = Z.face) => scene.set(id, { type: "rect", ...r, fill, z });
        const text = (id: string, t: string, x: number, y: number, size: number, more: Partial<OverlayElement> = {}) =>
            scene.set(id, { type: "text", text: t, x, y, size, colour: THEME.text, shadow: THEME.textShadow, z: Z.icon, ...more });
        const place = (id: string, r: Rect, tip = "", off = false): Rect => {
            this.hits.push({ id, rect: r, tip, off });
            return r;
        };
        const state = (id: string, on = false, off = false): ButtonState =>
            ({ hover: hover === id && !off, down: this.down === id && hover === id, on, disabled: off });
        const heading = (id: string, t: string, x: number, y: number) => text(id, t.toUpperCase(), x, y, 11, { colour: THEME.textDim, shadow: undefined });

        // The park behind, dimmed, and the pane
        rect("dim", { x: 0, y: 0, width: W, height: H }, "#000000a0", Z.cover);
        const mx = Math.max(8, Math.min(112, Math.round(W * 0.058)));
        const my = Math.max(8, Math.min(56, Math.round(H * 0.052)));
        const pane = { x: mx, y: my, width: W - 2 * mx, height: H - 2 * my };
        backing(scene, "pane", pane, "#0a140ef0");
        const pad = 12;
        const entries = this.entries(api);
        const all = api.entries;
        const empty = all.length === 0;

        // Header
        const hy = pane.y + pad;
        text("title", "Park gallery", pane.x + pad, hy + 4, 20, { bold: true });
        const tw = measure(overlay, "Park gallery", 20, true).width;
        const sub = job.kind === "new" ? (empty ? "add parks to make a playlist" : "pick the parks of a new playlist") : `add parks to the playlist ${job.playlist}`;
        text("sub", this.fit(sub, 14, pane.width * 0.3), pane.x + pad + tw + 14, hy + 9, 14, { colour: THEME.textDim });
        const close = place("close", { x: pane.x + pane.width - pad - 30, y: hy, width: 30, height: 30 }, "Close the gallery");
        button(scene, "close", close, state("close"), { icon: "close", iconSize: 16 }, overlay);
        const paused = typeof screensaver !== "undefined" && screensaver.paused === true;
        const rendering = all.filter(e => e.pictureState === "pending").length;
        const facts = empty ? "" : `${all.length} park${all.length === 1 ? "" : "s"} in ${api.folders.length} folder${api.folders.length === 1 ? "" : "s"}`
            + (rendering ? ` · ${rendering} picture${rendering === 1 ? "" : "s"} still rendering` : "");
        let hx = close.x - 14;
        if (this.note) {
            const t = this.fit(this.note, 13, pane.width * 0.45);
            hx -= measure(overlay, t, 13).width;
            text("note", t, hx, hy + 9, 13, { colour: THEME.warning });
        } else {
            if (facts) {
                hx -= measure(overlay, facts, 13).width;
                text("facts", facts, hx, hy + 9, 13, { colour: THEME.textDim });
                hx -= 18;
            }
            if (paused && !narrow) {
                const t = "Park paused while the gallery is open";
                hx -= measure(overlay, t, 13).width;
                text("paused", t, hx, hy + 9, 13, { colour: THEME.pending });
            }
        }

        const top = hy + 34 + pad;
        const bottom = pane.y + pane.height - pad;
        const sideW = narrow ? 170 : 216;
        const rightW = narrow ? 230 : 316;
        const sx = pane.x + pad;
        const rx = pane.x + pane.width - pad - rightW;
        const grid = { x: sx + sideW + pad, y: top, width: rx - pad - (sx + sideW + pad), height: bottom - top };
        this.gridRect = grid;

        // --- Left: folders and filters
        let y = top;
        heading("h.folders", "Folders", sx + 1, y);
        y += 17;
        const folderRow = (id: string, name: string, count: number, on: boolean, removable: boolean, tip: string) => {
            const r = place(id, { x: sx, y, width: sideW, height: 26 }, tip);
            if (on || hover === id || hover === `${id.replace("folder", "folderx")}`) {
                rect(`${id}.bg`, r, on ? THEME.faceOn : THEME.face);
            }
            const showX = removable && (hover === id || hover === id.replace("folder", "folderx"));
            const countText = `${count}`;
            const cw = measure(overlay, countText, 13).width;
            text(`${id}.t`, this.fit(name, 14, sideW - 20 - cw - (showX ? 26 : 0)), sx + 8, y + 5, 14);
            text(`${id}.n`, countText, sx + sideW - 8 - cw - (showX ? 24 : 0), y + 6, 13, { colour: THEME.textDim, shadow: undefined });
            if (showX) {
                const xid = id.replace("folder", "folderx");
                const xr = place(xid, { x: sx + sideW - 24, y: y + 2, width: 22, height: 22 }, "Take this folder out of the gallery (its files stay)");
                button(scene, xid, xr, state(xid), { icon: "close", iconSize: 12 }, overlay);
            }
            y += 26;
        };
        folderRow("folder.-1", "All parks", all.length, this.filter.folder === "", false, "Parks from every gallery folder");
        const folderRoom = Math.max(1, Math.floor((bottom - top - (job.kind === "add" ? 420 : 370)) / 26));
        api.folders.slice(0, folderRoom).forEach((f, i) =>
            folderRow(`folder.${i}`, f.name, f.count, this.filter.folder === f.path, !f.own, f.path));
        y += 6;
        const addFolder = place("addFolder", { x: sx, y, width: sideW, height: 28 },
            "Add a folder of parks to the gallery, with its subfolders; nothing is copied or moved");
        button(scene, "addFolder", addFolder, state("addFolder"), { icon: "add", iconSize: 16, text: "Add folder…", textSize: 14, left: true }, overlay);
        y += 28 + 14;
        const group = (title: string, ids: string[], labels: string[], on: boolean[], tips: string[], off: boolean[] = []) => {
            heading(`h.${ids[0]}`, title, sx + 1, y);
            y += 17;
            const w = (sideW - 3 * (ids.length - 1)) / ids.length;
            ids.forEach((id, i) => {
                const r = place(id, { x: Math.round(sx + i * (w + 3)), y, width: Math.round(w), height: 26 }, tips[i], off[i] === true);
                button(scene, id, r, state(id, on[i], off[i] === true), { text: labels[i], textSize: 13 }, overlay);
            });
            y += 26 + 14;
        };
        if (job.kind === "add") {
            group("Show", ["show.0", "show.1"], ["All", narrow ? "Not in" : "Not in playlist"], [!this.filter.hideUsed, this.filter.hideUsed],
                ["Every park of the gallery", "Leave out the parks the playlist already plays"]);
        }
        const sizes: SizeClass[] = ["any", "s", "m", "l"];
        group("Park size", sizes.map((_, i) => `size.${i}`), ["Any", "S", "M", "L"], sizes.map(s => this.filter.size === s),
            ["Every size", "Built area under 64 tiles on its longer side", "Built area of 64 to 127 tiles", "Built area of 128 tiles and more"]);
        const noDetails = !this.hasDetails;
        const waitTip = typeof api.scanDetails === "function" ? "The parks are still being read" : "Needs the generator's park details, which this game build does not read";
        group("Has", ["has.scripts", "has.events"], ["Scripts", narrow ? "Events" : "Event views"], [this.filter.scripts, this.filter.events],
            [noDetails ? waitTip : "Only parks that ship scripts of their own", noDetails ? waitTip : "Only parks whose scripts offer animation or show views"],
            [noDetails, noDetails]);
        group("Sort by", ["sort.0", "sort.1", "sort.2"], ["Name", "Date", "Size"], (["name", "date", "size"] as SortKey[]).map(s => this.filter.sort === s),
            ["By name", "Newest first: the release date where the park is in the NE catalog, else the file's", "Largest map first"]);
        heading("h.cols", "Tiles per row", sx + 1, y);
        text("cols.n", `${this.columns}`, sx + sideW - 1 - measure(overlay, `${this.columns}`, 11).width, y, 11, { shadow: undefined });
        y += 17;
        const span = GALLERY_COLUMNS.max - GALLERY_COLUMNS.min;
        const sl = place("slider", { x: sx + 2, y, width: sideW - 4, height: 22 }, "How many parks a row shows, 1 to 7");
        slider(scene, "slider", sl, (this.columns - GALLERY_COLUMNS.min) / span, hover === "slider" || this.down === "slider");
        y += 26;
        text("cols.min", `${GALLERY_COLUMNS.min}`, sx + 5, y, 11, { colour: THEME.textDim, shadow: undefined });
        text("cols.max", `${GALLERY_COLUMNS.max}`, sx + sideW - 12, y, 11, { colour: THEME.textDim, shadow: undefined });
        const busy = host.busy();
        const browse = place("browse", { x: sx, y: bottom - 28 - 20, width: sideW, height: 28 },
            busy || (job.kind === "add" ? "Pick one park file or download in the system's dialog instead" : "Make the playlist of every park in one folder instead"), busy !== "");
        button(scene, "browse", browse, state("browse", false, busy !== ""),
            { icon: "import", iconSize: 16, text: job.kind === "add" ? "Browse for a file…" : "From a folder…", textSize: 14, left: true }, overlay);
        text("browse.sub", job.kind === "add" ? "The system dialog" : "Every park in one folder", sx + 1, bottom - 15, 12, { colour: THEME.textDim, shadow: undefined });

        // --- Middle: the tiles
        rect("grid", grid, THEME.editorList);
        if (empty) {
            this.emptyGrid(scene, grid, host, place, state, text);
            this.totalRows = 0;
        } else if (!entries.length) {
            text("none", "No park matches these filters", grid.x + grid.width / 2, grid.y + grid.height / 2 - 10, 16, { align: "center", colour: THEME.textDim });
            this.totalRows = 0;
        } else {
            this.tiles(scene, api, entries, grid, hover, place, rect, text);
        }

        // --- Right: the park under the mouse, the picks, the action
        const hovered = hover?.startsWith("tile.") ? entries[Number(hover.slice(5))] : undefined;
        y = top;
        if (hovered) {
            this.detailRows(scene, hovered, rx, y, rightW, text, heading);
        }
        y += narrow ? 132 : 150;
        const n = this.picks.length;
        heading("h.picks", `${job.kind === "new" ? "New playlist" : `Adding to ${this.fit(job.playlist, 11, rightW * 0.4)}`} · ${n} park${n === 1 ? "" : "s"}`, rx + 1, y);
        if (n) {
            const cw = measure(overlay, "CLEAR", 11).width;
            const clear = place("clear", { x: rx + rightW - cw - 6, y: y - 3, width: cw + 6, height: 17 }, "Untick every picked park");
            text("clear", "CLEAR", clear.x + 3, y, 11, { colour: hover === "clear" ? THEME.text : THEME.textDim, shadow: undefined });
        }
        y += 17;
        const actionH = 40 + 6 + 40;
        let genH = 0;
        if (job.kind === "new" && this.generation) {
            const g = this.generation;
            genH = 14 + 17 + (5 + (g.route === "circuit" ? 2 : 0) + (g.motion === "pans" ? 1 : 0)) * 26 + 8;
        }
        const room = bottom - actionH - 12 - genH - y - (job.kind === "add" ? 62 : 0);
        const rows = Math.max(2, Math.min(job.kind === "new" ? NEW_PICK_ROWS : 99, Math.floor(room / PICK_ROW)));
        const list = { x: rx, y, width: rightW, height: rows * PICK_ROW };
        this.picksRect = list;
        this.pickRows(scene, api, list, rows, hover, place, rect, text, state);
        y += list.height;
        if (job.kind === "new" && this.generation) {
            y += 14;
            heading("h.gen", "Generation · how its views are made", rx + 1, y);
            y += 17;
            generationRows(scene, overlay, this.generation, "g", rx, y, rightW, (id, r, tip, off) => place(id, r, tip, !!off),
                (id, on) => state(id, on, !!this.hits.find(h => h.id === id)?.off));
        } else if (job.kind === "add") {
            const lines = this.wrap(`Added after the playlist's ${job.count} park${job.count === 1 ? "" : "s"}, in this order. `
                + "The playlist is built again with them; parks it has already built are not redone.", 12, rightW);
            lines.slice(0, 3).forEach((t, i) => text(`addnote.${i}`, t, rx, y + 8 + i * 17, 12, { colour: THEME.textDim, shadow: undefined }));
        }
        const goOff = n === 0 || busy !== "";
        const go = place("go", { x: rx, y: bottom - actionH, width: rightW, height: 40 },
            busy || (n === 0 ? "Tick parks first" : job.kind === "add" ? "Add the picked parks to the playlist and build it" : "Name the playlist in the system's dialog; it is made of the picked parks"), goOff);
        button(scene, "go", go, { ...state("go", false, goOff), ...(goOff ? {} : { face: hover === "go" ? THEME.faceHover : THEME.buildFace }) },
            { icon: job.kind === "add" ? "build" : "add", iconSize: 18, textSize: 16,
                text: job.kind === "add" ? `Add ${n} park${n === 1 ? "" : "s"} and build` : `Create playlist with ${n} park${n === 1 ? "" : "s"}…` }, overlay);
        const cancel = place("cancel", { x: rx, y: bottom - 40, width: rightW, height: 40 }, "Close the gallery; nothing is added");
        button(scene, "cancel", cancel, state("cancel"), { icon: "close", iconSize: 16, text: "Cancel", textSize: 16 }, overlay);

        // The tooltip of what the mouse is over (from this layout)
        const now = this.hitAt(this.mouse.x, this.mouse.y);
        if (now?.tip && this.down === undefined) {
            const below = now.rect.y < 80;
            tooltip(scene, "tip", now.tip, this.mouse.x, below ? now.rect.y + now.rect.height + 36 : Math.min(now.rect.y, this.mouse.y) - 4, overlay, W);
        }
        for (const element of scene.values()) {
            element.z = (element.z ?? 0) + LIFT;
        }
        return scene;
    }

    private wrap(t: string, size: number, width: number): string[] {
        const lines: string[] = [];
        let line = "";
        for (const word of t.split(" ")) {
            const next = line ? `${line} ${word}` : word;
            if (line && measure(this.mode.overlay, next, size).width > width) {
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

    private emptyGrid(scene: Scene, grid: Rect, host: GalleryHost, place: (id: string, r: Rect, tip?: string, off?: boolean) => Rect,
        state: (id: string, on?: boolean, off?: boolean) => ButtonState, text: (id: string, t: string, x: number, y: number, size: number, more?: Partial<OverlayElement>) => unknown): void {
        const overlay = this.mode.overlay;
        const cx = grid.x + grid.width / 2;
        const lines = this.wrap("The gallery shows the parks in the folders you add, with their subfolders. Nothing is copied or moved. "
            + "Parks you put into the gallery folder of your OpenRCT2 folder show up as well.", 14, Math.min(560, grid.width - 40));
        const buttons = host.importBundle ? 2 : 1;
        let y = grid.y + Math.round((grid.height - (30 + 12 + lines.length * 20 + 16 + buttons * 46)) / 2);
        text("empty.title", "No parks in the gallery yet", cx, y, 20, { bold: true, align: "center" });
        y += 30 + 12;
        lines.forEach((t, i) => text(`empty.${i}`, t, cx, y + i * 20, 14, { align: "center", colour: THEME.textDim }));
        y += lines.length * 20 + 16;
        const w = Math.min(300, grid.width - 40);
        const add = place("emptyAdd", { x: Math.round(cx - w / 2), y, width: w, height: 40 }, "Pick a folder of parks: .park files, RCT saves and park downloads");
        button(scene, "emptyAdd", add, { ...state("emptyAdd"), face: this.hitAt(this.mouse.x, this.mouse.y)?.id === "emptyAdd" ? THEME.faceHover : THEME.buildFace },
            { icon: "add", iconSize: 18, text: "Add a folder of parks…", textSize: 16 }, overlay);
        if (host.importBundle) {
            const busy = host.busy();
            const imp = place("emptyImport", { x: add.x, y: y + 46, width: w, height: 40 },
                busy || "Pick a playlist bundle (.zip) someone exported: it is imported, built and played", busy !== "");
            button(scene, "emptyImport", imp, state("emptyImport", false, busy !== ""), { icon: "import", iconSize: 18, text: "Import a playlist bundle…", textSize: 16 }, overlay);
        }
    }

    /** The grid's tiles from the scroll row on; the last row shown may be cut by the grid's lower edge. */
    private tiles(scene: Scene, api: GalleryApi, entries: GalleryEntry[], grid: Rect, hover: string | undefined,
        place: (id: string, r: Rect, tip?: string, off?: boolean) => Rect, rect: (id: string, r: Rect, fill: string, z?: number) => unknown,
        text: (id: string, t: string, x: number, y: number, size: number, more?: Partial<OverlayElement>) => unknown): void {
        const overlay = this.mode.overlay;
        const sb = 14;
        const inset = 10;
        const m = gridLayout(grid.width - sb - 2 * inset, this.columns);
        const columns = this.columns;
        const room = grid.height - inset;
        this.totalRows = Math.ceil(entries.length / columns);
        this.fullRows = Math.max(1, Math.floor((room + m.gap) / m.row));
        this.scroll = Math.max(0, Math.min(this.totalRows - this.fullRows, this.scroll));
        const lower = grid.y + grid.height;
        const visible: string[] = [];
        const twoLines = m.caption > 30;
        for (let i = this.scroll * columns; i < entries.length; i++) {
            const row = Math.floor(i / columns) - this.scroll;
            const ty = grid.y + inset + row * m.row;
            if (ty >= lower - 8) {
                break;
            }
            const e = entries[i];
            const id = `tile.${i}`;
            const tx = grid.x + inset + (i % columns) * (m.tile + m.gap);
            const full = { x: tx, y: ty, width: m.tile, height: m.picture + 2 + m.caption };
            const shown = { ...full, height: Math.min(full.height, lower - ty) };
            const pick = this.picks.indexOf(e.path);
            const used = this.used(e);
            const over = hover === id;
            const d = this.details[e.path];
            place(id, shown, used ? `${this.nameOf(e)} is in the playlist already` : pick >= 0 ? `${this.nameOf(e)}: click to take it out again` : `${this.nameOf(e)}: click to pick it`, used);
            rect(`${id}.bg`, shown, over && !used ? "#24402e" : "#16241b", Z.face);
            // The picture: the engine's render, cut where the grid ends
            const ph = Math.min(m.picture, lower - (ty + 1));
            const px = { x: tx + 1, y: ty + 1, width: m.tile - 2, height: ph };
            if (ph > 0) {
                if (e.pictureState === "ready" && e.picture) {
                    scene.set(`${id}.pic`, {
                        type: "image", src: e.picture, ...px, z: Z.bevel, ...(used ? { opacity: 0.35 } : {}),
                        ...(ph < m.picture ? { cropX: 0, cropY: 0, cropWidth: PREVIEW.width, cropHeight: Math.max(1, Math.round(PREVIEW.height * ph / m.picture)) } : {}),
                    });
                } else {
                    rect(`${id}.pic`, px, "#1a2620", Z.bevel);
                    if (ph >= m.picture) {
                        text(`${id}.wait`, e.pictureState === "none" ? (e.kind === "zip" ? "download" : "no picture") : m.tile < 130 ? "…" : "rendering picture…",
                            tx + m.tile / 2, ty + m.picture / 2 - 8, 13, { align: "center", colour: "#ffffff70", shadow: undefined });
                    }
                }
                if (e.pictureState !== "ready" && e.pictureState !== "none") {
                    visible.push(e.path);
                }
            }
            // Its outline: orange when picked, light under the mouse
            const edge = pick >= 0 ? ORANGE : over && !used ? "#ffffff90" : "#ffffff14";
            const lw = pick >= 0 ? 3 : 1;
            rect(`${id}.et`, { x: tx, y: ty, width: m.tile, height: lw }, edge, Z.icon);
            rect(`${id}.el`, { x: tx, y: ty, width: lw, height: shown.height }, edge, Z.icon);
            rect(`${id}.er`, { x: tx + m.tile - lw, y: ty, width: lw, height: shown.height }, edge, Z.icon);
            if (shown.height === full.height) {
                rect(`${id}.eb`, { x: tx, y: ty + full.height - lw, width: m.tile, height: lw }, edge, Z.icon);
            }
            if (lower - ty < 30) {
                continue; // (a sliver: no marks or text)
            }
            // Top left: the tick with its place in the order, or "in playlist"
            if (used) {
                const t = m.tile < 150 ? "in" : "in playlist";
                const w = Math.ceil(measure(overlay, t, 11).width) + 12;
                rect(`${id}.in`, { x: tx + 6, y: ty + 6, width: w, height: 18 }, "#0a140ee0", Z.icon);
                text(`${id}.int`, t, tx + 12, ty + 8, 11, { colour: "#d8e8dc", shadow: undefined, z: Z.icon + 1 });
            } else {
                const box = { x: tx + 6, y: ty + 6, width: 22, height: 22 };
                rect(`${id}.tick`, box, pick >= 0 ? ORANGE : "#0a140ee0", Z.icon);
                bevel(scene, `${id}.tick`, box, pick >= 0 ? "#000000" : "#ffffff70", pick >= 0 ? "#000000" : "#ffffff70", 1, Z.icon + 1);
                if (pick >= 0) {
                    text(`${id}.num`, `${pick + 1}`, box.x + 11, box.y + 3, 13, { bold: true, align: "center", colour: "#000000", shadow: undefined, z: Z.icon + 2 });
                }
            }
            // Bottom right of the picture: what its scripts bring, or that an RCT save is converted
            if (twoLines && ph >= m.picture) {
                const marks: [string, string][] = [];
                if (e.kind !== "park" && e.kind !== "zip") {
                    marks.push(["RCT save · converts", "#9fd0ff"]);
                }
                if (d?.scripts?.length) {
                    marks.push(["scripts", "#ffd54f"]);
                }
                if (d?.events) {
                    marks.push(["events", "#ffd54f"]);
                }
                let bx = tx + m.tile - 6;
                marks.reverse().forEach(([t, colour], k) => {
                    const w = Math.ceil(measure(overlay, t, 11).width) + 10;
                    bx -= w;
                    rect(`${id}.m${k}`, { x: bx, y: ty + m.picture - 22, width: w, height: 17 }, "#0a140ee0", Z.icon);
                    text(`${id}.m${k}t`, t, bx + 5, ty + m.picture - 20, 11, { colour, shadow: undefined, z: Z.icon + 1 });
                    bx -= 3;
                });
            }
            // Its name, and with room its builders, year and map size
            const ny = ty + m.picture + 2 + 5;
            const dim = used ? { opacity: 0.55 } : {};
            if (ny + 16 <= lower) {
                text(`${id}.name`, this.fit(this.nameOf(e), 13, m.tile - 14, true), tx + 7, ny, 13, { bold: true, ...dim });
            }
            if (twoLines && ny + 34 <= lower) {
                const by = [d?.builders?.length ? d.builders.slice(0, 2).join(", ") + (d.builders.length > 2 ? ` +${d.builders.length - 2}` : "") : "",
                    d?.released ? d.released.slice(0, 4) : "", d?.built ? `${d.built[0]}×${d.built[1]}` : e.mapSize && e.mapSize.x > 0 ? `${e.mapSize.x}×${e.mapSize.y}` : e.kind !== "park" ? e.kind.toUpperCase() : ""]
                    .filter(Boolean).join(" · ");
                text(`${id}.by`, this.fit(by, 12, m.tile - 14), tx + 7, ny + 17, 12, { colour: THEME.textDim, shadow: undefined, ...dim });
            }
        }
        // The pictures still to render: the ones in view
        const want = visible.join("\n");
        if (want !== this.asked) {
            this.asked = want;
            if (visible.length) {
                try {
                    api.requestPictures(visible);
                } catch {
                    // (the tiles keep their placeholders)
                }
            }
        }
        // The scroll bar
        const track = place("sb", { x: grid.x + grid.width - sb, y: grid.y, width: sb, height: grid.height });
        rect("sb", track, "#00000060");
        const over = this.totalRows - this.fullRows;
        if (over > 0) {
            const th = Math.max(24, Math.round(track.height * this.fullRows / this.totalRows));
            const tyy = track.y + Math.round((track.height - th) * this.scroll / over);
            rect("sb.thumb", { x: track.x + 2, y: tyy + 2, width: sb - 4, height: th - 4 }, hover === "sb" || this.down === "sb" ? "#6fae82" : "#4a8a5c", Z.bevel);
        }
    }

    private detailRows(scene: Scene, e: GalleryEntry, x: number, y: number, width: number,
        text: (id: string, t: string, x: number, y: number, size: number, more?: Partial<OverlayElement>) => unknown,
        heading: (id: string, t: string, x: number, y: number) => unknown): void {
        const overlay = this.mode.overlay;
        const d = this.details[e.path];
        heading("d.name", this.fit(this.nameOf(e), 11, width - 10), x + 1, y);
        const folder = e.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
        const rows: [string, string][] = [
            ["Builders", d?.builders?.length ? d.builders.join(", ") : d ? "unknown" : "…"],
            ["Released", d?.released ? d.released.slice(0, 4) : d ? "unknown" : "…"],
            ["Built area", d?.built ? `${d.built[0]}×${d.built[1]} tiles` : d ? "unknown" : "…"],
            ["Map", e.mapSize && e.mapSize.x > 0 ? `${e.mapSize.x}×${e.mapSize.y}` : e.kind === "park" ? "…" : `${e.kind.toUpperCase()} (read once added)`],
            ["Scripts", d ? (d.scripts?.length ? d.scripts.join(", ") : "none") : "…"],
            ["Event views", d ? (d.events ? `${d.events}` : "none") : "…"],
            ["Folder", folder],
        ];
        rows.forEach(([k, v], i) => {
            const ry = y + 19 + i * 21;
            text(`d.k${i}`, k, x, ry, 13, { colour: THEME.textDim, shadow: undefined });
            const kw = measure(overlay, k, 13).width;
            const value = this.fit(v, 13, width - kw - 14);
            text(`d.v${i}`, value, x + width - measure(overlay, value, 13).width, ry, 13, { shadow: undefined });
        });
    }

    /** The picked parks in their order: drag to reorder, the cross takes one out; a scroll bar past `rows`. */
    private pickRows(scene: Scene, api: GalleryApi, list: Rect, rows: number, hover: string | undefined,
        place: (id: string, r: Rect, tip?: string, off?: boolean) => Rect, rect: (id: string, r: Rect, fill: string, z?: number) => unknown,
        text: (id: string, t: string, x: number, y: number, size: number, more?: Partial<OverlayElement>) => unknown,
        state: (id: string, on?: boolean, off?: boolean) => ButtonState): void {
        const overlay = this.mode.overlay;
        rect("picks", list, THEME.editorList);
        const n = this.picks.length;
        if (!n) {
            this.wrap("Tick parks to pick them. They play in the order picked; drag them here to reorder.", 13, list.width - 20)
                .forEach((t, i) => text(`picks.hint${i}`, t, list.x + 10, list.y + 10 + i * 18, 13, { colour: THEME.textDim, shadow: undefined }));
            return;
        }
        this.pickScroll = Math.max(0, Math.min(n - rows, this.pickScroll));
        const scrolls = n > rows;
        const width = list.width - (scrolls ? 14 : 0);
        const byPath = new Map(api.entries.map(e => [e.path, e]));
        for (let k = this.pickScroll; k < Math.min(n, this.pickScroll + rows); k++) {
            const e = byPath.get(this.picks[k]);
            const id = `pick.${k}`;
            const r = place(id, { x: list.x, y: list.y + (k - this.pickScroll) * PICK_ROW, width, height: PICK_ROW }, "Drag to change its place in the order");
            if (this.down === id) {
                rect(`${id}.bg`, r, THEME.dragGhost);
            } else if (k % 2 === 0 || hover === id) {
                rect(`${id}.bg`, r, hover === id ? THEME.face : "#2c5a3a40");
            }
            for (let dot = 0; dot < 6; dot++) { // the grip, drawn (the game's font has no such glyph)
                rect(`${id}.grip.${dot}`, { x: r.x + 8 + (dot % 2) * 4, y: r.y + Math.round(PICK_ROW / 2) - 5 + Math.floor(dot / 2) * 4, width: 2, height: 2 }, THEME.textDim, Z.icon);
            }
            text(`${id}.n`, `${k + 1}`, r.x + 28, r.y + 9, 13, { colour: THEME.textDim, shadow: undefined });
            if (e?.pictureState === "ready" && e.picture) {
                scene.set(`${id}.pic`, { type: "image", src: e.picture, x: r.x + 52, y: r.y + 1, width: 40, height: 32, z: Z.bevel });
            } else {
                rect(`${id}.pic`, { x: r.x + 52, y: r.y + 1, width: 40, height: 32 }, "#1a2620", Z.bevel);
            }
            text(`${id}.name`, this.fit(e ? this.nameOf(e) : this.picks[k], 13, width - 100 - 30), r.x + 100, r.y + 9, 13);
            const xid = `pickx.${k}`;
            const xr = place(xid, { x: r.x + width - 28, y: r.y + 6, width: 22, height: 22 }, "Take it out of the picks");
            if (hover === xid) {
                button(scene, xid, xr, state(xid), { icon: "close", iconSize: 12 }, overlay);
            } else {
                scene.set(`${xid}.icon`, { type: "text", text: "×", x: xr.x + 7, y: xr.y + 1, size: 15, colour: "#ffffff90", z: Z.icon });
            }
        }
        if (scrolls) {
            const track = { x: list.x + list.width - 14, y: list.y, width: 14, height: list.height };
            rect("picks.sb", track, "#00000060");
            const th = Math.max(20, Math.round(track.height * rows / n));
            rect("picks.thumb", { x: track.x + 2, y: track.y + 2 + Math.round((track.height - th) * this.pickScroll / (n - rows)), width: 10, height: th - 4 }, "#4a8a5c", Z.bevel);
        }
    }
}
