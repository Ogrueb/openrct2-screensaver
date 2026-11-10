// The view editor in the screensaver mode (docs/screensaver-ui.md, "Editor"): the stock window's
// controls (editor.ts, WindowView) on the overlay, in the controls bar's style. It stays shown while
// open, at the window's top left. Arrow keys pan the camera as with the window (main.ts). Live editing
// (docs/screensaver-ui.md): a drag on the park moves the selected view, the wheel zooms it.

import type { Editor, EditorView } from "../editor";
import { EDITOR_COLUMNS } from "../editor";
import type { MouseEvent, Overlay, ScreensaverApi } from "../mode";
import { Layer, Rect, Scene, backing, button, contains, label, measure } from "./kit";
import { EDITOR, THEME, TIMING, Z } from "./theme";
import { ViewMap } from "./view-map";

type HitId =
    | "close" | "prevPark" | "nextPark" | `row.${number}` | "scrollUp" | "scrollDown"
    | "add" | "update" | "delete" | "up" | "down" | "revert" | "undo" | "redo"
    | "holdLess" | "holdMore" | "panLess" | "panMore" | "turn" | "inertia"
    | "rotl" | "rotr" | "zoomin" | "zoomout" | "play" | "map" | "lock";

const PAN_SHARE_STEP = 0.1;
const HELP = [
    "Drag the park: moves the selected view. Wheel: zooms it.",
    "Arrows pan the camera (Shift: faster). Ctrl+Z undoes. E closes.",
];
const MAP_HELP = [
    "Drag a box: moves it; its corner: zooms it. Drag the park: pans.",
    "Right-click: adds a view. Double-click a box: frames it. M closes.",
];

export class EditorPanel implements EditorView {
    readonly supportsMap = true;
    private readonly layer: Layer;
    private readonly map: ViewMap;
    private editor: Editor | undefined;
    private mouse = { x: -1, y: -1 };
    private downOn: HitId | undefined;
    private boxes = new Map<HitId, Rect>();
    private texts = new Map<string, { text: string; r: Rect; bold?: boolean; warning?: boolean; center?: boolean }>();
    private frame: Rect = { x: 0, y: 0, width: 0, height: 0 };
    private list: Rect = { x: 0, y: 0, width: 0, height: 0 };
    private scroll = 0; // first row shown
    private followed = -1; // the selection the list last scrolled to (a new one scrolls into view)
    private track: Rect | undefined; // the scroll bar between its arrows, when the list scrolls
    private drag: { x: number; y: number } | undefined; // a left drag on the park: where the mouse last was

    constructor(private readonly mode: ScreensaverApi) {
        this.layer = new Layer(mode.overlay, "rcts.ed.");
        this.map = new ViewMap(mode.overlay);
    }

    get isOpen(): boolean {
        return this.editor !== undefined;
    }

    open(editor: Editor): void {
        this.editor = editor;
        this.scroll = 0;
        this.render();
        this.layer.show(true, TIMING.fadeIn);
        this.render();
    }

    close(): void {
        this.editor = undefined;
        this.downOn = undefined;
        this.drag = undefined;
        this.layer.clear();
        this.map.clear();
    }

    refresh(): void {
        this.render();
    }

    /** Handles a mouse event over the panel (or a press that started on it); false lets it through. */
    onMouse(e: MouseEvent): boolean {
        if (!this.editor || this.drag || this.map.dragging) {
            return false; // a drag on the park keeps the mouse over the panel too
        }
        if (e.type !== "wheel") {
            this.mouse = { x: e.x, y: e.y }; // a wheel step is taken where the mouse last was
        }
        const inside = contains(this.frame, this.mouse.x, this.mouse.y);
        let used = inside || this.downOn !== undefined;
        if (e.type === "down" && e.button === 0 && inside) {
            this.downOn = this.hit();
        } else if (e.type === "up" && e.button === 0) {
            const hit = this.hit();
            if (this.downOn && hit === this.downOn) {
                this.activate(hit);
            }
            used = used || this.downOn !== undefined;
            this.downOn = undefined;
        } else if (e.type === "wheel" && contains(this.list, this.mouse.x, this.mouse.y)) {
            this.scrollBy(e.delta > 0 ? -1 : 1); // a step away from the user (delta > 0) scrolls up
        }
        this.render();
        return used;
    }

    /** Handles a mouse event on the park (off the panel and the bar, or during a drag that started on
     * the park): a left drag moves the camera and with it the selected view, the wheel zooms it. */
    onPark(e: MouseEvent): boolean {
        const editor = this.editor;
        if (!editor) {
            return false;
        }
        if (editor.mapMode || this.map.dragging) {
            return this.map.onMouse(e, editor);
        }
        if (e.type === "down" && e.button === 0) {
            this.drag = { x: e.x, y: e.y };
            editor.dragStart();
        } else if (e.type === "move" && this.drag) {
            const dx = e.x - this.drag.x;
            const dy = e.y - this.drag.y;
            this.drag = { x: e.x, y: e.y };
            editor.dragBy(dx, dy);
        } else if (e.type === "up" && e.button === 0 && this.drag) {
            this.drag = undefined;
            editor.dragEnd();
        } else if (e.type === "wheel") {
            editor.wheel(e.delta);
        } else {
            return false; // the rest is the bar's (a move wakes it; a release ends a press on it)
        }
        if (e.type !== "wheel") {
            this.mouse = { x: e.x, y: e.y };
        }
        return true;
    }

    /** A drag on the park is going on (every mouse event is the park's until it ends). */
    get dragging(): boolean {
        return this.drag !== undefined || this.map.dragging;
    }

    private hit(): HitId | undefined {
        for (const [id, r] of this.boxes) {
            if (contains(r, this.mouse.x, this.mouse.y)) {
                return id;
            }
        }
        return undefined;
    }

    private scrollBy(rows: number): void {
        const count = this.editor?.rows().length ?? 0;
        this.scroll = Math.max(0, Math.min(Math.max(0, count - EDITOR.visibleRows), this.scroll + rows));
    }

    private activate(id: HitId): void {
        const e = this.editor;
        if (!e) {
            return;
        }
        if (id === "scrollUp" || id === "scrollDown") {
            this.scrollBy(id === "scrollUp" ? -1 : 1);
            return;
        }
        if (id.startsWith("row.")) {
            e.select(Number(id.slice(4)));
            return;
        }
        switch (id) {
            case "close": e.close(); break;
            case "prevPark": e.goToPark(e.parkIndex - 1); break;
            case "nextPark": e.goToPark(e.parkIndex + 1); break;
            case "add": e.add(); break;
            case "update": e.update(); break;
            case "undo": e.undo(); break;
            case "redo": e.redo(); break;
            case "delete": e.remove(); break;
            case "up": e.move(-1); break;
            case "down": e.move(1); break;
            case "revert": e.revert(); break;
            case "holdLess": e.changeHold(-1); break;
            case "holdMore": e.changeHold(1); break;
            case "panLess": e.changePan(-PAN_SHARE_STEP); break;
            case "panMore": e.changePan(PAN_SHARE_STEP); break;
            case "turn": e.toggleTurn(); break;
            case "inertia": e.toggleInertia(); break;
            case "rotl": e.rotate(-1); break;
            case "rotr": e.rotate(1); break;
            case "zoomin": e.zoom(-1); break;
            case "zoomout": e.zoom(1); break;
            case "play": e.togglePreview(); break;
            case "map": e.toggleMap(); break;
            case "lock": e.toggleEventLock(); break;
        }
    }

    /** Places every control; rows of equal buttons fill the panel's width. */
    private layout(e: Editor): void {
        const s = EDITOR;
        const inner = s.width - 2 * s.pad;
        const x0 = s.x + s.pad;
        let y = s.y + s.pad;
        this.boxes.clear();
        this.texts.clear();
        const buttonRow = (ids: HitId[], h = s.buttonHeight) => {
            const w = (inner - s.gap * (ids.length - 1)) / ids.length;
            ids.forEach((id, i) => this.boxes.set(id, {
                x: Math.round(x0 + i * (w + s.gap)), y, width: Math.round(w), height: h,
            }));
            y += h + s.gap;
        };
        // Title: the park, with previous/next park and close buttons.
        const t = s.titleHeight;
        this.boxes.set("prevPark", { x: x0, y, width: t, height: t });
        this.boxes.set("nextPark", { x: x0 + t + s.gap, y, width: t, height: t });
        this.boxes.set("close", { x: x0 + inner - t, y, width: t, height: t });
        const names = e.parkNames;
        this.texts.set("park", {
            text: names[e.parkIndex] ?? "No park", bold: true,
            r: { x: x0 + 2 * (t + s.gap) + 4, y, width: inner - 3 * (t + s.gap) - 4, height: t },
        });
        y += t + s.gap;
        // The views list: a header row, then up to visibleRows rows; past that a scroll bar at the
        // right (arrows, and the wheel over the list).
        const rows = e.rows();
        this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - s.visibleRows)));
        const sel = e.selectedIndex;
        if (sel !== this.followed) {
            this.followed = sel; // scroll to a newly selected view only, so the wheel can move away
            if (sel >= 0 && (sel < this.scroll || sel >= this.scroll + s.visibleRows)) {
                this.scroll = Math.max(0, Math.min(sel, rows.length - s.visibleRows));
            }
        }
        const scrolls = rows.length > s.visibleRows;
        const bar = scrolls ? s.scrollBar : 0;
        this.list = { x: x0, y, width: inner - bar, height: s.rowHeight * (s.visibleRows + 1) };
        y += s.rowHeight;
        for (let i = 0; i < s.visibleRows && this.scroll + i < rows.length; i++) {
            this.boxes.set(`row.${this.scroll + i}`, { x: x0, y: y + i * s.rowHeight, width: inner - bar, height: s.rowHeight });
        }
        this.track = undefined;
        if (scrolls) {
            const bx = x0 + inner - bar + 2;
            const rowsTop = y;
            const rowsBottom = y + s.visibleRows * s.rowHeight;
            this.boxes.set("scrollUp", { x: bx, y: rowsTop, width: bar - 2, height: bar - 2 });
            this.boxes.set("scrollDown", { x: bx, y: rowsBottom - (bar - 2), width: bar - 2, height: bar - 2 });
            this.track = { x: bx, y: rowsTop + bar, width: bar - 2, height: rowsBottom - rowsTop - 2 * bar };
        }
        y = this.list.y + this.list.height + s.gap;
        buttonRow(["add", "update", "delete"]);
        buttonRow(["up", "down", "revert"]);
        // Hold and pan on one line, each a value centred between its − and + (owner, 2026-11-02).
        const half = Math.round((inner - s.sectionGap) / 2);
        const step = (less: HitId, more: HitId, key: string, text: string, x: number, w: number) => {
            const b = s.buttonHeight;
            this.boxes.set(less, { x, y, width: b, height: b });
            this.boxes.set(more, { x: x + w - b, y, width: b, height: b });
            this.texts.set(key, { text, center: true, r: { x: x + b, y, width: w - 2 * b, height: b } });
        };
        step("holdLess", "holdMore", "hold", e.holdText(), x0, half);
        step("panLess", "panMore", "pan", e.panText(), x0 + inner - half, half);
        y += s.buttonHeight + s.gap;
        this.boxes.set("turn", { x: x0, y, width: half, height: s.buttonHeight });
        this.boxes.set("inertia", { x: x0 + inner - half, y, width: half, height: s.buttonHeight });
        y += s.buttonHeight + s.gap;
        buttonRow(["rotl", "rotr", "zoomin", "zoomout"]);
        buttonRow(["map", "lock"]);
        // Undo and redo, then Play taking the rest of the row.
        const small = Math.round((inner - 2 * s.gap) / 6);
        this.boxes.set("undo", { x: x0, y, width: small, height: s.buttonHeight });
        this.boxes.set("redo", { x: x0 + small + s.gap, y, width: small, height: s.buttonHeight });
        const px = x0 + 2 * (small + s.gap);
        this.boxes.set("play", { x: px, y, width: x0 + inner - px, height: s.buttonHeight });
        y += s.buttonHeight + s.gap;
        const status = e.status();
        this.texts.set("status", { text: status.text, warning: status.warning, r: { x: x0, y, width: inner, height: s.lineHeight } });
        y += s.lineHeight;
        for (const [i, help] of (e.mapMode ? MAP_HELP : HELP).entries()) {
            this.texts.set(`help${i}`, { text: help, r: { x: x0, y, width: inner, height: s.lineHeight } });
            y += s.lineHeight;
        }
        this.frame = { x: s.x, y: s.y, width: s.width, height: y + s.pad - s.y };
    }

    private render(): void {
        const e = this.editor;
        if (!e) {
            return;
        }
        const overlay = this.mode.overlay;
        const s = EDITOR;
        this.layout(e);
        const scene: Scene = new Map();
        backing(scene, "frame", this.frame, THEME.editorBacking);
        const hover = this.hit();
        const state = (id: HitId, on = false) => ({ hover: hover === id, down: this.downOn === id && hover === id, on });
        const textButton = (id: HitId, text: string, on = false) =>
            button(scene, id, this.boxes.get(id)!, state(id, on), { text, textSize: s.textSize }, overlay);
        textButton("prevPark", "‹");
        textButton("nextPark", "›");
        textButton("close", "×");
        // The list: column headers, striped rows, the selected one in the "on" colour.
        const rows = e.rows();
        const cols = columnStarts(this.list.width, rows, overlay);
        const header = { x: this.list.x, y: this.list.y, width: this.list.width, height: s.rowHeight };
        scene.set("list", { type: "rect", ...this.list, fill: THEME.editorList, z: Z.face });
        EDITOR_COLUMNS.forEach((h, c) => label(scene, `head.${c}`, h,
            { x: header.x + cols[c] + 4, y: header.y, width: 0, height: header.height }, s.textSize, overlay, true));
        for (let i = 0; i < s.visibleRows; i++) {
            const index = this.scroll + i;
            const row = rows[index];
            if (!row) {
                break;
            }
            const r = this.boxes.get(`row.${index}`)!;
            const fill = index === e.selectedIndex ? THEME.faceOn
                : hover === `row.${index}` ? THEME.faceHover : i % 2 ? THEME.face : undefined;
            scene.set(`row.${index}`, { type: "rect", ...r, fill: fill ?? "#00000000", z: Z.face });
            row.forEach((cell, c) => label(scene, `cell.${i}.${c}`, cell,
                { x: r.x + cols[c] + 4, y: r.y, width: 0, height: r.height }, s.textSize, overlay));
        }
        if (this.track) {
            textButton("scrollUp", "▲");
            textButton("scrollDown", "▼");
            const t = this.track;
            scene.set("track", { type: "rect", ...t, fill: THEME.editorList, z: Z.face });
            const share = s.visibleRows / rows.length;
            const h = Math.max(8, Math.round(t.height * share));
            const top = t.y + Math.round((t.height - h) * this.scroll / Math.max(1, rows.length - s.visibleRows));
            scene.set("thumb", { type: "rect", x: t.x, y: top, width: t.width, height: h, fill: THEME.face, z: Z.icon });
        }
        textButton("add", "Add view");
        textButton("update", "Set to camera");
        textButton("delete", "Delete");
        textButton("up", "Move up");
        textButton("down", "Move down");
        textButton("revert", "Use playlist views");
        textButton("holdLess", "−");
        textButton("holdMore", "+");
        textButton("panLess", "−");
        textButton("panMore", "+");
        textButton("turn", e.turnText());
        textButton("inertia", e.inertiaText());
        textButton("rotl", "Rotate left");
        textButton("rotr", "Rotate right");
        textButton("zoomin", "Zoom in");
        textButton("zoomout", "Zoom out");
        textButton("map", e.mapMode ? "Map (M): on" : "Map (M): off", e.mapMode);
        textButton("lock", e.eventsLocked ? "Event views: locked" : "Event views: unlocked", !e.eventsLocked);
        textButton("undo", "Undo");
        textButton("redo", "Redo");
        textButton("play", e.isPlaying ? "Play: on (moving the camera stops it)" : "Play: off", e.isPlaying);
        for (const [key, t] of this.texts) {
            label(scene, `text.${key}`, t.text, t.r, key === "park" ? s.titleSize : s.textSize, overlay, t.bold);
            if (t.center) {
                scene.set(`text.${key}`, { ...scene.get(`text.${key}`)!, x: t.r.x + t.r.width / 2, align: "center" });
            }
            if (t.warning) {
                scene.set(`text.${key}`, { ...scene.get(`text.${key}`)!, colour: THEME.warning });
            }
        }
        this.layer.render(scene);
        if (e.mapMode) {
            this.map.render(e);
        } else {
            this.map.clear();
        }
    }
}

/**
 * Where each list column starts: each as wide as its widest text (header or cell) plus a margin, the
 * spare width shared out evenly; squeezed in proportion if the texts are wider than the list.
 */
function columnStarts(width: number, rows: string[][], overlay: Overlay): number[] {
    const size = EDITOR.textSize;
    const natural = EDITOR_COLUMNS.map((h, c) => Math.max(
        measure(overlay, h, size, true).width,
        ...rows.map(r => measure(overlay, r[c] ?? "", size).width),
    ) + EDITOR.cellMargin);
    const total = natural.reduce((a, b) => a + b, 0);
    const widths = total <= width
        ? natural.map(w => w + (width - total) / natural.length)
        : natural.map(w => w * width / total);
    const starts = [0];
    for (const w of widths.slice(0, -1)) {
        starts.push(starts[starts.length - 1] + Math.round(w));
    }
    return starts;
}
