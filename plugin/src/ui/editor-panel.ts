// The view editor in the screensaver mode (docs/screensaver-ui.md, "Editor"): three panes on the overlay,
// in the controls bar's style (owner's design, 2026-11-10):
// - the views pane, top left: the park (previous, a dropdown field, next; held, the field's list jumps on
//   release; clicked, it stays open as the playlist's order, its rows dragged to reorder the parks) over
//   the park's route views, each row dragged by its grip to reorder them, and under them the event
//   views (cut-ins, car cues, shows) in a list of their own, by when they play (owner, 2026-11-10);
// - the toolbox, bottom left: Frame | Map, a hint, the view, camera and event tools, hold and pan, then
//   undo, redo, Reset view, the pin (the panes stay shown) and Play; tooltips name each tool and its key;
// - the top-right box: the park's restore points and the Playlist properties (motion, timing,
//   presentation), folded to its header when the window is too narrow for it beside the views pane.
// Live editing (docs/screensaver-ui.md): a drag on the park moves the selected view, the wheel zooms it.

import { builder, clock, ParkState } from "../builder";
import type { Editor, EditorView, RestorePoint } from "../editor";
import { EDITOR_COLUMNS, EVENT_COLUMNS } from "../editor";
import { modeSettings } from "../mode";
import type { MouseEvent, Overlay, ScreensaverApi } from "../mode";
import type { PlaylistProps } from "../storage";
import { Layer, Rect, Scene, backing, bevel, button, contains, iconPath, iconPixels, label, measure, tooltip } from "./kit";
import { CRAWL, EDITOR, THEME, TIMING, Z } from "./theme";
import { ViewMap } from "./view-map";

const PAN_SHARE_STEP = 0.1;
const HINT_FRAME = "Drag the park: moves the view. Wheel: zooms it.";
const HINT_LOCKED = "An event view, locked: dragging the park moves the camera.";
const HINT_MAP = "Drag a box or its corner. Right-click: adds a view.";
const DRAG_Z = Z.tip - 2; // a dragged row over the rest of the pane

/** A Playlist property's choices, as the segmented buttons show them. */
type Choice = [label: string, value: unknown, tip: string];
const CHOICES: Partial<Record<keyof PlaylistProps, Choice[]>> = {
    inertia: [["Off", false, "Even pan speed"], ["On", true, "Eased pans"]],
    panChanges: [["Off", "off", "Cut on angle or zoom change"],
        ["Start", "start", "Turn and zoom at pan start"], ["End", "end", "Turn and zoom at pan end"]],
    titleMusic: [["Ride", "ride", "Ride music"], ["Theme", "theme", "Title theme"],
        ["Unset", "keep", "Viewer's setting"]],
    titles: [["Overview", "overview", "First view"], ["On", "on", "Every view"],
        ["Off", "off", "No names"], ["Unset", null, "Viewer's setting"]],
};

/** A list that scrolls: its first row shown, and the thumb's drag. */
class Scroll {
    first = 0;
    track: Rect | undefined;
    thumb: Rect | undefined;

    clamp(count: number, visible: number): void {
        this.first = Math.max(0, Math.min(this.first, Math.max(0, Math.ceil(count - visible))));
    }

    by(rows: number, count: number, visible: number): void {
        this.first += rows;
        this.clamp(count, visible);
    }

    /** Lays the bar out in `track` (none when everything shows). */
    layout(track: Rect, count: number, visible: number): void {
        this.clamp(count, visible);
        if (count <= visible) {
            this.track = this.thumb = undefined;
            return;
        }
        const h = Math.max(12, Math.round(track.height * visible / count));
        const span = Math.max(1, Math.ceil(count - visible));
        this.track = track;
        this.thumb = { x: track.x, y: track.y + Math.round((track.height - h) * this.first / span), width: track.width, height: h };
    }

    draw(scene: Scene, id: string): void {
        if (this.track && this.thumb) {
            scene.set(`${id}.track`, { type: "rect", ...this.track, fill: THEME.editorList, z: Z.face });
            scene.set(`${id}.thumb`, { type: "rect", ...this.thumb, fill: THEME.faceOn, z: Z.icon });
        }
    }

    /** The first row for the thumb dragged to `y` (from a press at y0 when the first row was first0). */
    dragTo(y: number, y0: number, first0: number, count: number, visible: number): void {
        if (!this.track || !this.thumb) {
            return;
        }
        const span = Math.max(1, this.track.height - this.thumb.height);
        this.first = first0 + Math.round((y - y0) / span * Math.max(0, count - visible));
        this.clamp(count, visible);
    }
}

/** A row press that becomes a drag once the mouse moves (views or parks). */
interface RowDrag {
    list: "views" | "parks";
    from: number;
    x0: number;
    y0: number;
    moving: boolean;
}

export class EditorPanel implements EditorView {
    readonly supportsMap = true;
    private readonly layer: Layer;
    private readonly map: ViewMap;
    private editor: Editor | undefined;
    private mouse = { x: -1, y: -1 };
    private downOn: string | undefined;
    private boxes = new Map<string, Rect>();
    private tips = new Map<string, string>();
    private off = new Set<string>(); // inactive buttons
    private frames: Rect[] = []; // the panes shown, for what the mouse is over
    private paneViews: Rect = { x: 0, y: 0, width: 0, height: 0 };
    private listRect: Rect = { x: 0, y: 0, width: 0, height: 0 }; // the route views' rows
    private eventsRect: Rect | undefined; // the event views' rows, when the park has any
    private clockShown = -1; // the park clock's second the event list last showed
    private loadingShown = false; // a park change under way when the panes were last drawn
    private hovered: string | undefined; // the element under the mouse, from the last layout
    private parksRect: Rect | undefined; // the park list, while open
    private pointsRect: Rect | undefined; // the restore points' rows
    private messagesRect: Rect | undefined; // the build's messages
    private readonly views = new Scroll();
    private readonly parks = new Scroll();
    private readonly events = new Scroll();
    private readonly points = new Scroll();
    private followed = -1; // the selection the views list last scrolled to
    private drag: { x: number; y: number } | undefined; // a left drag on the park: where the mouse last was
    private rowDrag: RowDrag | undefined;
    private thumbDrag: { scroll: Scroll; y0: number; first0: number; count: () => number; visible: number } | undefined;
    private dropdown: { persistent: boolean; downAt: number } | undefined; // the park list
    private picked: string | undefined; // the restore point highlighted
    private propsOpen = true; // the Playlist properties unfolded
    private clipShown = false; // a Copy/Paste note is on its button (it goes after a moment)
    private buildShown = ""; // the build pane's state as last drawn (buildSignature)
    private buildOpen: boolean | undefined; // the build pane unfolded by hand (undefined: when there is room)
    private boxBottom = 0; // where the top-right box ends, for the build pane under it
    private readonly messages = new Scroll();
    private boxOpen: boolean | undefined; // the top-right box unfolded by hand (undefined: by the window's width)
    private lastMove = 0; // the pin off: the panes hide this long after the mouse last moved
    private hidden = false;

    constructor(private readonly mode: ScreensaverApi, private readonly now: () => number = () => Date.now()) {
        this.layer = new Layer(mode.overlay, "rcts.ed.");
        this.map = new ViewMap(mode.overlay);
    }

    get isOpen(): boolean {
        return this.editor !== undefined;
    }

    open(editor: Editor): void {
        this.editor = editor;
        this.views.first = 0;
        this.dropdown = undefined;
        this.picked = undefined;
        this.hidden = false;
        this.lastMove = this.now();
        this.render();
        this.layer.show(true, TIMING.fadeIn);
        this.render();
    }

    close(): void {
        this.editor = undefined;
        this.downOn = undefined;
        this.drag = undefined;
        this.rowDrag = undefined;
        this.thumbDrag = undefined;
        this.dropdown = undefined;
        this.layer.clear();
        this.map.clear();
    }

    refresh(): void {
        this.render();
    }

    /** Called every update: with the pin off the panes hide once the mouse has rested a while. */
    update(): void {
        const e = this.editor;
        e?.syncMap();
        // The event list's "in m:ss" counts down with the park's clock.
        const second = e && this.eventsRect && !this.hidden ? Math.floor(e.playback.parkClock / 40) : -1;
        // A build's progress and outcome (the build pane).
        const build = e && !this.hidden ? this.buildSignature(e) : this.buildShown;
        if ((second >= 0 && second !== this.clockShown && !this.busy) || (e && e.playback.isLoading !== this.loadingShown)
            || (build !== this.buildShown && !this.busy) || (!!e?.clipNote !== this.clipShown && !this.busy)) {
            this.render();
        }
        if (!e || e.pinned || this.hidden || this.busy || this.over(this.mouse.x, this.mouse.y)) {
            return;
        }
        if (this.now() - this.lastMove >= TIMING.hideAfter) {
            this.hidden = true;
            this.layer.show(false, TIMING.fadeOut);
        }
    }

    private get busy(): boolean {
        return this.downOn !== undefined || this.rowDrag !== undefined || this.thumbDrag !== undefined || this.dropdown !== undefined;
    }

    private over(x: number, y: number): boolean {
        return this.frames.some(f => contains(f, x, y));
    }

    private wake(): void {
        this.lastMove = this.now();
        if (this.hidden) {
            this.hidden = false;
            this.layer.show(true, TIMING.fadeIn);
        }
    }

    /** Handles a mouse event over the panes (or a press that started on them); false lets it through. */
    onMouse(e: MouseEvent): boolean {
        const ed = this.editor;
        if (!ed || this.drag || this.map.dragging) {
            return false; // a drag on the park keeps the mouse over the panes too
        }
        if (e.type !== "wheel") {
            if (e.x !== this.mouse.x || e.y !== this.mouse.y) {
                this.wake();
            }
            this.mouse = { x: e.x, y: e.y }; // a wheel step is taken where the mouse last was
        }
        const inside = this.over(this.mouse.x, this.mouse.y);
        let used = inside || this.busy;
        if (e.type === "move") {
            this.moved();
        } else if (e.type === "down" && e.button === 0) {
            used = this.pressed(inside) || used;
        } else if (e.type === "down") {
            used = inside || this.dropdown !== undefined; // a right click on a pane does nothing
            if (this.dropdown && !inside) {
                this.dropdown = undefined;
            }
        } else if (e.type === "up" && e.button === 0) {
            used = this.released() || used;
        } else if (e.type === "wheel") {
            const step = e.delta > 0 ? -1 : 1; // a step away from the user (delta > 0) scrolls up
            if (this.parksRect && contains(this.parksRect, this.mouse.x, this.mouse.y)) {
                this.parks.by(step, ed.parkNames.length, this.parkRows());
            } else if (contains(this.listRect, this.mouse.x, this.mouse.y)) {
                this.views.by(step, ed.routeIndices().length, EDITOR.visibleRows);
            } else if (this.eventsRect && contains(this.eventsRect, this.mouse.x, this.mouse.y)) {
                this.events.by(step, ed.eventIndices().length, EDITOR.eventRows);
            } else if (this.pointsRect && contains(this.pointsRect, this.mouse.x, this.mouse.y)) {
                this.points.by(step, ed.restorePoints().length, EDITOR.boxRows);
            } else if (this.messagesRect && contains(this.messagesRect, this.mouse.x, this.mouse.y)) {
                this.messages.by(step, builder.messages.length, EDITOR.boxRows);
            }
        }
        this.render();
        return used;
    }

    private moved(): void {
        const t = this.thumbDrag;
        if (t) {
            t.scroll.dragTo(this.mouse.y, t.y0, t.first0, t.count(), t.visible);
            return;
        }
        const r = this.rowDrag;
        if (r && !r.moving && Math.abs(this.mouse.y - r.y0) + Math.abs(this.mouse.x - r.x0) >= EDITOR.dragStart) {
            r.moving = r.list === "parks" ? this.dropdown?.persistent === true : this.editor!.movable(r.from);
            if (!r.moving && r.list === "views") {
                this.rowDrag = undefined; // a locked event view: the press only selects it
            }
        }
        if (r?.moving) {
            this.autoScroll(r);
        }
    }

    /** A dragged row near its list's top or bottom edge scrolls the list. */
    private autoScroll(r: RowDrag): void {
        const ed = this.editor!;
        const rect = r.list === "views" ? this.listRect : this.parksRect;
        if (!rect) {
            return;
        }
        const rowsTop = rect.y + (r.list === "views" ? EDITOR.rowHeight : EDITOR.parkRow);
        const step = this.mouse.y < rowsTop ? -1 : this.mouse.y > rect.y + rect.height ? 1 : 0;
        if (step && r.list === "views") {
            this.views.by(step, ed.routeIndices().length, EDITOR.visibleRows);
        } else if (step) {
            this.parks.by(step, ed.parkNames.length, this.parkRows());
        }
    }

    private pressed(inside: boolean): boolean {
        const ed = this.editor!;
        const hit = this.hit();
        if (this.dropdown && (!hit || (!hit.startsWith("park.") && !hit.startsWith("parks.")))) {
            // Another click closes the open list (a click on the field too); it does nothing else.
            this.dropdown = undefined;
            return true;
        }
        if (!inside && !hit) {
            return false;
        }
        this.downOn = hit;
        if (hit === "field") {
            this.dropdown = { persistent: false, downAt: this.now() };
            this.parks.first = Math.max(0, ed.playback.playOrder.indexOf(ed.parkIndex) - 2);
        } else if (hit?.startsWith("row.") || hit?.startsWith("park.")) {
            const views = hit.startsWith("row.");
            this.rowDrag = { list: views ? "views" : "parks", from: Number(hit.slice(views ? 4 : 5)), x0: this.mouse.x, y0: this.mouse.y, moving: false };
        } else if (hit?.endsWith(".thumb")) {
            const which = hit.slice(0, -6);
            const scroll = this.scrollOf(which);
            const count = which === "parks" ? () => ed.parkNames.length : which === "points" ? () => ed.restorePoints().length
                : which === "messages" ? () => builder.messages.length
                : which === "events" ? () => ed.eventIndices().length : () => ed.routeIndices().length;
            const visible = which === "parks" ? this.parkRows() : which === "points" || which === "messages" ? EDITOR.boxRows
                : which === "events" ? EDITOR.eventRows : EDITOR.visibleRows;
            this.thumbDrag = { scroll, y0: this.mouse.y, first0: scroll.first, count, visible };
        } else if (hit?.endsWith(".track")) {
            const which = hit.slice(0, -6);
            const scroll = this.scrollOf(which);
            const page = which === "parks" ? this.parkRows() : which === "points" || which === "messages" ? 3
                : which === "events" ? EDITOR.eventRows : EDITOR.visibleRows;
            const count = which === "parks" ? ed.parkNames.length : which === "points" ? ed.restorePoints().length
                : which === "messages" ? builder.messages.length
                : which === "events" ? ed.eventIndices().length : ed.routeIndices().length;
            scroll.by(this.mouse.y < (scroll.thumb?.y ?? 0) ? -page : page, count, page);
        }
        return true;
    }

    private released(): boolean {
        const ed = this.editor!;
        const hit = this.hit();
        const down = this.downOn;
        this.downOn = undefined;
        this.thumbDrag = undefined;
        const r = this.rowDrag;
        this.rowDrag = undefined;
        const dd = this.dropdown;
        if (down === "field" && dd && !dd.persistent) {
            // Held: jump to the park released on. Clicked: the list stays open as the playlist's order.
            if (hit?.startsWith("park.")) {
                this.goToPark(Number(hit.slice(5)));
                this.dropdown = undefined;
            } else if (hit === "field" && this.now() - dd.downAt < EDITOR.holdOpen) {
                dd.persistent = true;
            } else {
                this.dropdown = undefined;
            }
            return true;
        }
        if (r?.moving) {
            const to = this.dropIndex(r);
            if (r.list === "views") {
                ed.moveTo(r.from, to);
            } else {
                ed.playback.moveParkInOrder(r.from, to);
            }
            return true;
        }
        if (down && hit === down && !this.off.has(hit)) {
            this.activate(hit);
        }
        return down !== undefined;
    }

    private scrollOf(which: string): Scroll {
        return which === "parks" ? this.parks : which === "points" ? this.points : which === "messages" ? this.messages
            : which === "events" ? this.events : this.views;
    }

    /** Where a dragged row lands: the gap nearest the mouse, as an index after the row leaves its place.
     *  A route view lands among the route views: the event views listed between them stay put. */
    private dropIndex(r: RowDrag): number {
        const ed = this.editor!;
        const views = r.list === "views";
        const rect = views ? this.listRect : this.parksRect!;
        const rowH = views ? EDITOR.rowHeight : EDITOR.parkRow;
        const route = ed.routeIndices();
        const count = views ? route.length : ed.parkNames.length;
        const first = views ? this.views.first : this.parks.first;
        const gap = Math.max(0, Math.min(count, Math.round((this.mouse.y - rect.y - rowH) / rowH) + first));
        if (!views) {
            return gap > r.from ? gap - 1 : gap;
        }
        const fromPos = route.indexOf(r.from);
        const rest = route.filter(i => i !== r.from);
        const p = fromPos >= 0 && gap > fromPos ? gap - 1 : gap;
        if (!rest.length) {
            return r.from;
        }
        const after = (i: number): number => (i > r.from ? i - 1 : i); // an index once the row is out
        return p < rest.length ? after(rest[p]) : after(rest[rest.length - 1]) + 1;
    }

    /** Handles a mouse event on the park (off the panes and the bar, or during a drag that started on
     * the park): a left drag moves the camera and with it the selected view, the wheel zooms it. */
    onPark(e: MouseEvent): boolean {
        const editor = this.editor;
        if (!editor) {
            return false;
        }
        this.wake();
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

    private hit(): string | undefined {
        // The open park list lies over the views list: its rows first.
        let found: string | undefined;
        for (const [id, r] of this.boxes) {
            if (contains(r, this.mouse.x, this.mouse.y)) {
                if (id.startsWith("park.") || id.startsWith("parks.")) {
                    return id;
                }
                if (this.parksRect && contains(this.parksRect, this.mouse.x, this.mouse.y)) {
                    continue; // under the park list
                }
                found = found ?? id;
            }
        }
        return found;
    }

    private goToPark(pos: number): void {
        const ed = this.editor!;
        const order = ed.playback.playOrder;
        const n = order.length;
        if (n > 0) {
            ed.goToPark(order[((pos % n) + n) % n]);
        }
    }

    private activate(id: string): void {
        const e = this.editor;
        if (!e) {
            return;
        }
        if (id.startsWith("row.") || id.startsWith("event.")) {
            e.select(Number(id.slice(id.indexOf(".") + 1)));
            return;
        }
        if (id.startsWith("park.")) {
            this.goToPark(Number(id.slice(5))); // a click in the open list: the list stays
            return;
        }
        if (id.startsWith("msg.") || id.startsWith("sq.")) {
            // A message or a square about a park opens that park
            const key = id.startsWith("msg.") ? builder.messages[Number(id.slice(4))]?.park : builder.parks[Number(id.slice(3))]?.key;
            const index = key ? e.playback.parkIndexOf(key) : -1;
            if (index >= 0 && index !== e.parkIndex) {
                e.goToPark(index);
            }
            return;
        }
        if (id.startsWith("point.")) {
            this.picked = e.restorePoints()[Number(id.slice(6))]?.id;
            return;
        }
        if (id.startsWith("seg.")) {
            const [, key, i] = id.split(".");
            const choice = CHOICES[key as keyof PlaylistProps]?.[Number(i)];
            if (choice) {
                this.setProp(key as keyof PlaylistProps, choice[1]);
            }
            return;
        }
        if (id.startsWith("step.")) {
            const [, key, sign] = id.split(".");
            const k = key as "changeHold" | "arriveHold" | "returnHold";
            const v = e.playback.playlistProps[k] + (sign === "more" ? EDITOR.holdStep : -EDITOR.holdStep);
            this.setProp(k, Math.round(Math.max(0, Math.min(EDITOR.holdMax, v)) * 100) / 100);
            return;
        }
        const pos = e.playback.playOrder.indexOf(e.parkIndex);
        switch (id) {
            case "close": e.close(); break;
            case "prevPark": this.goToPark(pos - 1); break;
            case "nextPark": this.goToPark(pos + 1); break;
            case "frameMode": if (e.mapMode) e.toggleMap(); break;
            case "mapMode": if (!e.mapMode) e.toggleMap(); break;
            case "add": e.add(); break;
            case "update": e.update(); break;
            case "delete": e.remove(); break;
            case "rotl": e.rotate(-1); break;
            case "rotr": e.rotate(1); break;
            case "zoomin": e.zoom(-1); break;
            case "zoomout": e.zoom(1); break;
            case "lock": e.toggleEventLock(); break;
            case "holdLess": e.changeHold(-1); break;
            case "holdMore": e.changeHold(1); break;
            case "panLess": e.changePan(-PAN_SHARE_STEP); break;
            case "panMore": e.changePan(PAN_SHARE_STEP); break;
            case "undo": e.undo(); break;
            case "redo": e.redo(); break;
            case "reset": e.resetView(); break;
            case "pin": e.togglePinned(); break;
            case "play": e.togglePreview(); break;
            case "checkpoint": e.saveCheckpoint(); break;
            case "restore": if (this.picked) e.restoreTo(this.picked); break;
            case "copy": e.copyViews(); break;
            case "paste": e.pasteViews(); break;
            case "boxHead": this.boxOpen = this.boxFolded(); break;
            case "propsHead": this.propsOpen = !this.propsOpen; break;
            case "buildHead": this.buildOpen = this.buildFolded(); break;
            case "build": this.toggleBuild(); break;
        }
    }

    /** Build and play, or Cancel build (also Ctrl+B). */
    toggleBuild(): void {
        const e = this.editor;
        if (builder.running) {
            builder.cancel();
        } else if (e && builder.available && builder.pendingEdits(e.playback.installedAt)) {
            e.playback.savePlaylistProps(); // saved already; the build takes the live file
            this.messages.first = 0;
            builder.start(e.playback.sequenceName);
        }
        this.render();
    }

    /** A Playlist property changed: in force at once and saved, like the views (owner, 2026-11-11). */
    private setProp<K extends keyof PlaylistProps>(key: K, value: unknown): void {
        const p = this.editor!.playback;
        p.setPlaylistProp(key, value as PlaylistProps[K]);
        p.savePlaylistProps();
        if (key === "titleMusic") {
            this.mode.configure(modeSettings(p.liveSettings)); // the music changes at once
        }
    }

    // Layout

    private parkRows(): number {
        return Math.max(1, Math.floor(((this.parksRect?.height ?? 0) - EDITOR.parkRow) / EDITOR.parkRow));
    }

    /** The top-right box shows only its header: by hand, else when the window is too narrow for it
     *  beside the views pane (owner, 2026-11-10). */
    private boxFolded(): boolean {
        if (this.boxOpen !== undefined) {
            return !this.boxOpen;
        }
        return ui.width < EDITOR.x + EDITOR.width + 2 * EDITOR.x + EDITOR.boxWidth + EDITOR.x;
    }

    private place(id: string, r: Rect, tip?: string, disabled = false): Rect {
        this.boxes.set(id, r);
        if (tip) {
            this.tips.set(id, tip);
        }
        if (disabled) {
            this.off.add(id);
        }
        return r;
    }

    private render(): void {
        const e = this.editor;
        if (!e) {
            return;
        }
        this.loadingShown = e.playback.isLoading;
        // What the mouse is over, from the last layout: a list row is placed only as its row is
        // drawn, so asking during the drawing misses the rows below.
        this.hovered = this.hit();
        this.boxes.clear();
        this.tips.clear();
        this.off.clear();
        this.frames = [];
        const scene: Scene = new Map();
        this.viewsPane(e, scene);
        this.toolbox(e, scene);
        this.topRight(e, scene);
        this.buildPane(e, scene);
        // The tooltip of the button under the mouse: above it, or below near the window's top.
        const hover = this.hit();
        const tip = hover && !this.busy ? this.tips.get(hover) : undefined;
        if (tip) {
            const r = this.boxes.get(hover!)!;
            const below = r.y < 80;
            const h = Math.ceil(measure(this.mode.overlay, tip, THEME.tipSize).height) + 2 * THEME.tipPad;
            tooltip(scene, "tip", tip, r.x + r.width / 2, below ? r.y + r.height + 4 + h : r.y - 4, this.mode.overlay, ui.width);
        }
        this.layer.render(scene);
        if (e.mapMode && !e.playback.isLoading) {
            // During a park change the views are already the next park's: no boxes until it shows.
            this.map.render(e);
        } else {
            this.map.clear();
        }
    }

    private state(id: string, on = false, alt = false): { hover: boolean; down: boolean; on: boolean; alt: boolean; disabled: boolean } {
        const hover = this.hit() === id;
        return { hover, down: this.downOn === id && hover, on, alt, disabled: this.off.has(id) };
    }

    /** The views pane: the park's title row over its views, or the park list while it is open. */
    private viewsPane(e: Editor, scene: Scene): void {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        const x0 = s.x + s.pad;
        const inner = s.width - 2 * s.pad;
        let y = s.y + s.pad;
        const t = s.titleHeight;
        const order = e.playback.playOrder;
        const pos = order.indexOf(e.parkIndex);
        const many = order.length > 1;
        this.place("prevPark", { x: x0, y, width: t, height: t }, "Previous park", !many || e.playback.isLoading);
        const closeX = x0 + inner - t;
        const nextX = closeX - s.groupGap - t;
        this.place("nextPark", { x: nextX, y, width: t, height: t }, "Next park", !many || e.playback.isLoading);
        this.place("close", { x: closeX, y, width: t, height: t }, "Close (E)");
        const field = this.place("field", { x: x0 + t + s.gap, y, width: nextX - s.gap - (x0 + t + s.gap), height: t },
            many ? "Hold: jump to a park. Click: reorder" : undefined);
        y += t + s.gap;
        // The views list: a header row, then up to visibleRows rows, a scroll bar past that.
        // The route views, a header row over up to visibleRows rows (a scroll bar past that), then the
        // event views in their own list, when the park has any.
        const rows = e.rows();
        const route = e.routeIndices();
        const events = e.eventIndices();
        const sel = e.selectedIndex;
        if (sel !== this.followed) {
            this.followed = sel; // scroll to a newly selected view only, so the wheel can move away
            const r = route.indexOf(sel);
            const k = events.indexOf(sel);
            if (r >= 0 && (r < this.views.first || r >= this.views.first + s.visibleRows)) {
                this.views.first = r;
            }
            if (k >= 0 && (k < this.events.first || k >= this.events.first + s.eventRows)) {
                this.events.first = k;
            }
        }
        const listH = s.rowHeight * (s.visibleRows + 1);
        const bar = route.length > s.visibleRows ? s.scrollBar + 2 : 0;
        this.listRect = { x: x0, y, width: inner - bar, height: listH };
        this.views.layout({ x: x0 + inner - s.scrollBar, y: y + s.rowHeight, width: s.scrollBar, height: s.visibleRows * s.rowHeight }, route.length, s.visibleRows);
        let bottom = y + listH;
        if (events.length) {
            const shown = Math.min(events.length, s.eventRows);
            const top = bottom + s.eventsGap + s.rowHeight; // under the list's title
            const ebar = events.length > s.eventRows ? s.scrollBar + 2 : 0;
            this.eventsRect = { x: x0, y: top, width: inner - ebar, height: s.rowHeight * (shown + 1) };
            this.events.layout({ x: x0 + inner - s.scrollBar, y: top + s.rowHeight, width: s.scrollBar, height: shown * s.rowHeight }, events.length, s.eventRows);
            bottom = top + this.eventsRect.height;
        } else {
            this.eventsRect = undefined;
            this.events.first = 0;
        }
        this.paneViews = { x: s.x, y: s.y, width: s.width, height: bottom + s.pad - s.y };
        this.frames.push(this.paneViews);
        backing(scene, "frame", this.paneViews, THEME.editorBacking);
        // Title row
        button(scene, "prevPark", this.boxes.get("prevPark")!, this.state("prevPark"), { icon: "prev-view", iconSize: s.toolIcon }, overlay);
        button(scene, "nextPark", this.boxes.get("nextPark")!, this.state("nextPark"), { icon: "next-view", iconSize: s.toolIcon }, overlay);
        button(scene, "close", this.boxes.get("close")!, this.state("close"), { icon: "close", iconSize: s.toolIcon }, overlay);
        const fieldOpen = this.dropdown !== undefined;
        scene.set("field", { type: "rect", ...field, fill: fieldOpen ? THEME.faceDown : this.hit() === "field" ? THEME.faceHover : THEME.editorList, z: Z.face });
        bevel(scene, "field", field, THEME.bevelDark, THEME.bevelLight, THEME.bevel, Z.bevel);
        if (fieldOpen) {
            scene.set("field.open", { type: "rect", ...field, fill: "#00000000", border: THEME.fieldOpen, borderWidth: 2, z: Z.icon });
        }
        const count = many ? `${pos + 1} / ${order.length}` : "";
        if (many) {
            foldMark(scene, "field.mark", fieldOpen, field.x + field.width - 24, field.y + field.height / 2, overlay);
        }
        const countW = count ? measure(overlay, count, s.textSize, true).width + 22 : 0;
        const name = fit(overlay, e.parkNames[e.parkIndex] ?? "No park", s.titleSize, field.width - countW - 28, true);
        label(scene, "text.park", name, { x: field.x + 8, y: field.y, width: 0, height: field.height }, s.titleSize, overlay, true);
        if (count) {
            label(scene, "text.count", count, { x: field.x + field.width - 6 - countW, y: field.y, width: 0, height: field.height }, s.textSize, overlay, true);
        }
        this.viewsList(e, scene, rows, route);
        if (this.eventsRect) {
            this.eventsList(e, scene, events);
        }
        if (this.dropdown) {
            this.parkList(e, scene);
        } else {
            this.parksRect = undefined;
        }
    }

    private viewsList(e: Editor, scene: Scene, rows: string[][], route: number[]): void {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        const list = this.listRect;
        scene.set("list", { type: "rect", ...list, fill: THEME.editorList, z: Z.face });
        const cols = columnStarts(list.width - s.grip, route.map(i => rows[i]), overlay, EDITOR_COLUMNS).map(c => c + s.grip);
        EDITOR_COLUMNS.forEach((h, c) => label(scene, `head.${c}`, h,
            { x: list.x + cols[c] + 4, y: list.y, width: 0, height: s.rowHeight }, s.textSize, overlay, true));
        const top = list.y + s.rowHeight;
        const hover = this.hovered;
        const r = this.rowDrag?.list === "views" && this.rowDrag.moving ? this.rowDrag : undefined;
        for (let i = 0; i < s.visibleRows; i++) {
            const index = route[this.views.first + i];
            const row = rows[index];
            if (index === undefined || !row) {
                break;
            }
            const box = this.place(`row.${index}`, { x: list.x, y: top + i * s.rowHeight, width: list.width, height: s.rowHeight });
            const fill = index === e.selectedIndex ? THEME.faceOn : hover === `row.${index}` && !r ? THEME.faceHover : i % 2 ? THEME.face : undefined;
            scene.set(`row.${index}`, { type: "rect", ...box, fill: fill ?? "#00000000", z: Z.face });
            const cells = this.cells(e, row);
            if (e.movable(index)) {
                grip(scene, `grip.${i}`, box.x + 5, box.y + box.height / 2);
            }
            cells.forEach((cell, c) => label(scene, `cell.${i}.${c}`, cell,
                { x: box.x + cols[c] + 4, y: box.y, width: 0, height: box.height }, s.textSize, overlay));
            if (r && r.from === index) {
                scene.set(`dim.${i}`, { type: "rect", ...box, fill: THEME.rowDimmed, z: Z.icon + 1 });
            }
        }
        this.views.draw(scene, "views");
        if (this.views.track) {
            this.place("views.track", this.views.track);
            this.place("views.thumb", this.views.thumb!);
        }
        if (r) {
            this.dragged(scene, list, s.rowHeight, this.views.first, route.length, r, ghost => {
                this.cells(e, rows[r.from]).forEach((cell, c) => label(scene, `ghost.${c}`, cell,
                    { x: ghost.x + cols[c] + 4, y: ghost.y, width: 0, height: ghost.height }, s.textSize, overlay));
            });
        }
    }

    /** The event views: when they play and on what, apart from the route, as no drag or list place
     *  changes their timing (owner, 2026-11-10); a click selects one. */
    private eventsList(e: Editor, scene: Scene, events: number[]): void {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        const list = this.eventsRect!;
        const title = { x: list.x, y: list.y - s.rowHeight, width: list.width, height: s.rowHeight };
        label(scene, "text.events", `Events  ${events.length}`, { x: title.x + 4, y: title.y, width: 0, height: title.height }, s.textSize, overlay, true);
        const note = e.eventsLocked ? "play on the park's timing (locked)" : "play on the park's timing";
        const noteX = title.x + 4 + measure(overlay, `Events  ${events.length}`, s.textSize, true).width + 12;
        scene.set("text.events.note", { type: "text", text: note, size: s.hintSize, colour: THEME.textDim,
            x: noteX, y: Math.round(title.y + (title.height - s.hintSize * 1.25) / 2), z: Z.icon });
        scene.set("events", { type: "rect", ...list, fill: THEME.editorList, z: Z.face });
        const rows = e.eventRows();
        this.clockShown = Math.floor(e.playback.parkClock / 40);
        const cols = columnStarts(list.width - s.grip, rows, overlay, EVENT_COLUMNS).map(c => c + s.grip);
        EVENT_COLUMNS.forEach((h, c) => label(scene, `ehead.${c}`, h,
            { x: list.x + cols[c] + 4, y: list.y, width: 0, height: s.rowHeight }, s.textSize, overlay, true));
        const top = list.y + s.rowHeight;
        const hover = this.hovered;
        for (let i = 0; i < s.eventRows; i++) {
            const k = this.events.first + i;
            const index = events[k];
            if (index === undefined) {
                break;
            }
            const box = this.place(`event.${index}`, { x: list.x, y: top + i * s.rowHeight, width: list.width, height: s.rowHeight });
            const fill = index === e.selectedIndex ? THEME.faceOn : hover === `event.${index}` ? THEME.faceHover : i % 2 ? THEME.face : undefined;
            scene.set(`event.${index}`, { type: "rect", ...box, fill: fill ?? "#00000000", z: Z.face });
            rows[k].forEach((cell, c) => label(scene, `ecell.${i}.${c}`, fit(overlay, cell, s.textSize, (cols[c + 1] ?? list.width) - cols[c] - 6),
                { x: box.x + cols[c] + 4, y: box.y, width: 0, height: box.height }, s.textSize, overlay));
        }
        this.events.draw(scene, "events");
        if (this.events.track) {
            this.place("events.track", this.events.track);
            this.place("events.thumb", this.events.thumb!);
        }
    }

    /** A row's cells as shown: who set each view, event views marked locked while they are. */
    private cells(e: Editor, row: string[]): string[] {
        const by = row[6] === "auto" ? "generated" : row[6] === "event" && e.eventsLocked ? "event (locked)" : row[6];
        return [...row.slice(0, 6), by];
    }

    /** A row being dragged: lifted under the mouse, with an orange line where it would go. */
    private dragged(scene: Scene, list: Rect, rowH: number, first: number, count: number, r: RowDrag, cells: (ghost: Rect) => void): void {
        const ghost = { x: list.x + 6, y: Math.round(this.mouse.y - rowH / 2), width: list.width - 6, height: rowH };
        scene.set("ghost", { type: "rect", ...ghost, fill: THEME.dragGhost, z: DRAG_Z });
        bevel(scene, "ghost", ghost, THEME.bevelLight, THEME.bevelDark, THEME.bevel, DRAG_Z);
        grip(scene, "ghost.grip", ghost.x + 5, ghost.y + rowH / 2, DRAG_Z + 1);
        const before = scene.size;
        cells(ghost);
        let k = 0;
        for (const [id, el] of scene) {
            if (k++ >= before) {
                scene.set(id, { ...el, z: DRAG_Z + 1 });
            }
        }
        const gap = Math.max(0, Math.min(count, Math.round((this.mouse.y - list.y - rowH) / rowH) + first));
        const shown = Math.max(0, Math.min(EDITOR.visibleRows + 4, gap - first));
        const lineY = list.y + rowH + shown * rowH - 1;
        if (gap >= first && lineY <= list.y + list.height + 1) {
            scene.set("dropline", { type: "rect", x: list.x, y: lineY, width: list.width, height: 3, fill: THEME.dragLine, z: DRAG_Z + 2 });
        }
    }

    /** The park list, over the views list: the playlist's order, its rows dragged to reorder it. */
    private parkList(e: Editor, scene: Scene): void {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        const order = e.playback.playOrder;
        const area = { x: this.listRect.x, y: this.listRect.y, width: this.paneViews.width - 2 * s.pad, height: this.listRect.height };
        this.parksRect = area;
        const visible = this.parkRows();
        const bar = order.length > visible ? s.scrollBar + 2 : 0;
        this.parks.layout({ x: area.x + area.width - s.scrollBar, y: area.y + s.parkRow, width: s.scrollBar, height: visible * s.parkRow },
            order.length, visible);
        const z = Z.tip - 4; // over the views list
        scene.set("parks", { type: "rect", ...area, fill: "#0b170fff", z });
        bevel(scene, "parks", area, THEME.bevelDark, THEME.bevelLight, THEME.bevel, z);
        // The open list carries the field's gold border (owner, 2026-11-10).
        scene.set("parks.open", { type: "rect", ...area, fill: "#00000000", border: THEME.fieldOpen, borderWidth: 2, z: z + 3 });
        const head = this.dropdown?.persistent ? "Playlist order" : "Release on a park to go there";
        label(scene, "parks.head", head, { x: area.x + 8, y: area.y, width: 0, height: s.parkRow }, s.textSize, overlay, true);
        scene.set("parks.head", { ...scene.get("parks.head")!, z: z + 2 });
        if (this.dropdown?.persistent) {
            const help = "drag to reorder · click to go";
            const w = measure(overlay, help, s.textSize - 2).width;
            label(scene, "parks.help", help, { x: area.x + area.width - bar - 8 - w, y: area.y, width: 0, height: s.parkRow }, s.textSize - 2, overlay);
            scene.set("parks.help", { ...scene.get("parks.help")!, colour: THEME.textDim, z: z + 2 });
        }
        const width = area.width - bar;
        const top = area.y + s.parkRow;
        const hover = this.hovered;
        const r = this.rowDrag?.list === "parks" && this.rowDrag.moving ? this.rowDrag : undefined;
        const countW = measure(overlay, "000 views", s.textSize).width;
        for (let i = 0; i < visible; i++) {
            const p = this.parks.first + i;
            const index = order[p];
            if (index === undefined) {
                break;
            }
            const box = this.place(`park.${p}`, { x: area.x, y: top + i * s.parkRow, width, height: s.parkRow });
            // Held to jump, the park under the mouse is the one a release goes to: gold (owner, 2026-11-10).
            const jump = !this.dropdown?.persistent && hover === `park.${p}`;
            const fill = jump ? THEME.faceAltHover : index === e.parkIndex ? THEME.faceOn
                : hover === `park.${p}` && !r ? THEME.faceHover : i % 2 ? THEME.face : "#00000000";
            scene.set(`park.${p}`, { type: "rect", ...box, fill, z: z + 1 });
            if (this.dropdown?.persistent) {
                grip(scene, `pgrip.${i}`, box.x + 5, box.y + box.height / 2, z + 2);
            }
            const n = e.playback.viewCountOf(index);
            const texts: [string, string, number][] = [
                [`pn.${i}`, String(p + 1), box.x + s.grip + 4],
                [`pname.${i}`, fit(overlay, e.parkNames[index] ?? "", s.textSize, width - s.grip - 40 - countW - 16), box.x + s.grip + 40],
                [`pcount.${i}`, `${n} view${n === 1 ? "" : "s"}`, box.x + width - 8 - measure(overlay, `${n} view${n === 1 ? "" : "s"}`, s.textSize).width],
            ];
            for (const [id, text, x] of texts) {
                label(scene, id, text, { x, y: box.y, width: 0, height: box.height }, s.textSize, overlay, id.startsWith("pname") && index === e.parkIndex);
                scene.set(id, { ...scene.get(id)!, z: z + 2, ...(id.startsWith("pcount") ? { colour: THEME.textDim } : {}) });
            }
            if (r && r.from === p) {
                scene.set(`pdim.${i}`, { type: "rect", ...box, fill: THEME.rowDimmed, z: z + 3 });
            }
        }
        if (this.parks.track) {
            scene.set("parks.track", { type: "rect", ...this.parks.track, fill: THEME.editorList, z: z + 1 });
            scene.set("parks.thumb", { type: "rect", ...this.parks.thumb!, fill: THEME.faceOn, z: z + 2 });
            this.place("parks.track", this.parks.track);
            this.place("parks.thumb", this.parks.thumb!);
        }
        if (r) {
            const list = { ...area, width };
            this.dragged(scene, list, s.parkRow, this.parks.first, order.length, r, ghost => {
                label(scene, "ghost.name", e.parkNames[order[r.from]] ?? "", { x: ghost.x + s.grip + 34, y: ghost.y, width: 0, height: ghost.height }, s.textSize, overlay, true);
            });
        }
    }

    /** The toolbox at the window's bottom left (owner's design, 2026-11-10). */
    private toolbox(e: Editor, scene: Scene): void {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        const b = s.tool;
        const inner = 8 * b + 5 * s.gap + 2 * s.groupGap;
        const height = s.pad + s.switchHeight + 2 + s.hintHeight + 2 * (s.labelHeight + b) + 4 + 8 + b + s.pad;
        const frame = { x: s.x, y: ui.height - s.y - height, width: inner + 2 * s.pad, height };
        this.frames.push(frame);
        backing(scene, "tools", frame, THEME.editorBacking);
        const x0 = frame.x + s.pad;
        let y = frame.y + s.pad;
        const loading = e.playback.isLoading;
        const noView = e.selectedIndex < 0 || loading;
        const fixedView = noView || e.selectedLocked; // a locked event view: only the camera moves
        // Frame | Map: the map changes the whole approach, so it stands out (olive while on).
        const half = Math.floor((inner - s.gap) / 2);
        this.place("frameMode", { x: x0, y, width: half, height: s.switchHeight }, "Frame: edit through the camera (M)", loading);
        this.place("mapMode", { x: x0 + inner - half, y, width: half, height: s.switchHeight }, "Map: all views as boxes (M)", loading);
        button(scene, "frameMode", this.boxes.get("frameMode")!, this.state("frameMode", !e.mapMode),
            { icon: "frame", iconSize: s.toolIcon, text: "Frame", textSize: 15 }, overlay);
        button(scene, "mapMode", this.boxes.get("mapMode")!, this.state("mapMode", e.mapMode, true),
            { icon: "map", iconSize: s.toolIcon, text: "Map", textSize: 15, hint: "M" }, overlay);
        y += s.switchHeight + 2;
        const hint = fit(overlay, e.mapMode ? HINT_MAP : e.selectedLocked ? HINT_LOCKED : HINT_FRAME, s.hintSize, inner);
        label(scene, "hint", hint, { x: x0, y, width: 0, height: s.hintHeight }, s.hintSize, overlay);
        scene.set("hint", { ...scene.get("hint")!, colour: THEME.textDim });
        y += s.hintHeight;
        // View, camera and event tools under their labels.
        const groups: [string, [string, string, string, boolean, boolean?][]][] = [
            ["VIEW", [
                ["add", "add", "Add view (Insert)", loading || !e.playback.canEdit],
                ["update", "set-camera", e.selectedLocked ? "Locked event (unlock on map)"
                    : e.mapMode ? "Move view to center (C)" : "Map only (C)",
                    fixedView || !e.mapMode],
                ["delete", "delete", e.selectedLocked ? "Locked event (unlock on map)" : "Delete view (Delete)", fixedView],
            ]],
            ["CAMERA", [
                ["rotl", "rotate-left", "Rotate left (Shift+Enter)", loading],
                ["rotr", "rotate-right", "Rotate right (Enter)", loading],
                ["zoomin", "zoom-in", "Zoom in (Page Up)", loading],
                ["zoomout", "zoom-out", "Zoom out (Page Down)", loading],
            ]],
            ["EVENTS", [
                ["lock", e.eventsLocked ? "events-locked" : "events-unlocked",
                    e.eventsLocked ? "Events locked (L)" : "Events unlocked (L)", !e.mapMode, !e.eventsLocked],
            ]],
        ];
        let x = x0;
        for (const [name, tools] of groups) {
            this.sectionLabel(scene, `label.${name}`, name, x, y);
            tools.forEach(([id, icon, tip, disabled, on], i) => {
                const r = this.place(id, { x: x + i * (b + s.gap), y: y + s.labelHeight, width: b, height: b }, tip, disabled);
                button(scene, id, r, this.state(id, on === true), { icon, iconSize: s.toolIcon }, overlay);
            });
            x += tools.length * (b + s.gap) - s.gap + s.groupGap;
        }
        y += s.labelHeight + b + 4;
        // Hold and pan of the selected view, each a value between its - and +.
        const stepper = (name: string, less: string, more: string, text: string, sx: number, tips: [string, string]) => {
            this.sectionLabel(scene, `label.${name}`, name, sx, y);
            const ry = y + s.labelHeight;
            const l = this.place(less, { x: sx, y: ry, width: b, height: b }, tips[0], fixedView);
            const value = { x: sx + b + s.gap, y: ry, width: s.stepValue, height: b };
            const m = this.place(more, { x: value.x + value.width + s.gap, y: ry, width: b, height: b }, tips[1], fixedView);
            button(scene, less, l, this.state(less), { icon: "less", iconSize: s.toolIcon }, overlay);
            button(scene, more, m, this.state(more), { icon: "add", iconSize: s.toolIcon }, overlay);
            scene.set(`${name}.value`, { type: "rect", ...value, fill: THEME.editorList, z: Z.face });
            bevel(scene, `${name}.value`, value, THEME.bevelDark, THEME.bevelLight, THEME.bevel, Z.bevel);
            label(scene, `text.${name.toLowerCase()}`, text, { x: value.x + value.width / 2, y: ry, width: 0, height: b }, s.textSize, overlay);
            scene.set(`text.${name.toLowerCase()}`, { ...scene.get(`text.${name.toLowerCase()}`)!, align: "center" });
            return value.x + value.width + s.gap + b;
        };
        const view = noView ? undefined : e.currentViews[e.selectedIndex];
        const holdEnd = stepper("HOLD", "holdLess", "holdMore", view ? `${view.hold} s` : "-", x0, ["Shorter hold ([)", "Longer hold (])"]);
        stepper("PAN", "panLess", "panMore", view ? `${Math.round(e.playback.panOf(view) * 100)}%` : "-", holdEnd + s.groupGap,
            ["Less panning (Shift+[)", "More panning (Shift+])"]);
        y += s.labelHeight + b + 8;
        // Undo, redo, Reset view; the pin and Play at the right.
        const foot: [string, string, string, boolean, number][] = [
            ["undo", "undo", "Undo (Ctrl+Z)", !e.canUndo, x0],
            ["redo", "redo", "Redo (Ctrl+Y)", !e.canRedo, x0 + b + s.gap],
            ["reset", "reset-view", "Reset to playlist view", !e.canResetView, x0 + 2 * b + s.gap + s.footerGap],
        ];
        for (const [id, icon, tip, disabled, fx] of foot) {
            const r = this.place(id, { x: fx, y, width: b, height: b }, tip, disabled);
            button(scene, id, r, this.state(id), { icon, iconSize: s.toolIcon }, overlay);
        }
        const play = this.place("play", { x: x0 + inner - s.playWidth, y, width: s.playWidth, height: b },
            e.isPlaying ? "Stop (P)" : "Play (P)", loading);
        const pin = this.place("pin", { x: play.x - s.gap - b, y, width: b, height: b },
            e.pinned ? "Pinned" : "Unpinned: hides when idle");
        button(scene, "pin", pin, this.state("pin", e.pinned), { icon: "pin", iconSize: s.toolIcon }, overlay);
        button(scene, "play", play, this.state("play", e.isPlaying),
            { icon: e.isPlaying ? "pause" : "play", iconSize: s.toolIcon, text: e.isPlaying ? "Stop" : "Play", textSize: 15, hint: "P" }, overlay);
    }

    private sectionLabel(scene: Scene, id: string, text: string, x: number, y: number): void {
        label(scene, id, text, { x, y, width: 0, height: EDITOR.labelHeight }, EDITOR.labelSize, this.mode.overlay);
        scene.set(id, { ...scene.get(id)!, colour: THEME.textDim });
    }

    /** The top-right box: the park's restore points, then the Playlist properties. */
    private topRight(e: Editor, scene: Scene): void {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        const width = s.boxWidth;
        const x0 = ui.width - s.x - width + s.pad;
        const inner = width - 2 * s.pad;
        const top = s.y;
        let y = top + s.pad;
        const folded = this.boxFolded();
        // Header: RESTORE POINTS · PARK, with where the views come from at the right.
        const headH = 20;
        const head = this.place("boxHead", { x: x0, y, width: inner, height: headH }, folded ? "Unfold" : "Fold");
        scene.set("boxHead", { type: "rect", ...head, fill: this.hit() === "boxHead" ? THEME.face : "#00000000", z: Z.face });
        const source = e.source();
        const sw = measure(overlay, source.text, s.boxHead).width;
        foldMark(scene, "box.mark", !folded, x0 - 2, y + headH / 2, overlay);
        const title = `RESTORE POINTS · ${(e.parkNames[e.parkIndex] ?? "").toUpperCase()}`;
        label(scene, "box.title", fit(overlay, title, s.boxHead, inner - sw - 30), { ...head, x: head.x + 18 }, s.boxHead, overlay);
        scene.set("box.title", { ...scene.get("box.title")!, colour: THEME.textDim });
        label(scene, "box.source", source.text, { x: x0 + inner - sw, y, width: 0, height: headH }, s.boxHead, overlay);
        scene.set("box.source", { ...scene.get("box.source")!, colour: source.warning ? THEME.warning : THEME.textGood });
        y += headH + 2;
        if (folded) {
            this.pointsRect = undefined;
            const frame = { x: x0 - s.pad, y: top, width, height: y - top + s.pad - 2 };
            this.frames.push(frame);
            backing(scene, "box", frame, THEME.editorBacking);
            this.boxBottom = frame.y + frame.height;
            return;
        }
        // The restore points, 3.5 rows: a half row says there are more.
        const points = e.restorePoints();
        if (this.picked && !points.some(p => p.id === this.picked)) {
            this.picked = undefined;
        }
        const listH = Math.round(s.boxRow * s.boxRows);
        const bar = points.length > s.boxRows ? s.scrollBar + 2 : 0;
        this.pointsRect = { x: x0, y, width: inner, height: listH };
        this.points.layout({ x: x0 + inner - s.scrollBar, y, width: s.scrollBar, height: listH }, points.length, s.boxRows);
        scene.set("points", { type: "rect", ...this.pointsRect, fill: THEME.editorList, z: Z.face });
        const hover = this.hovered;
        const first = Math.floor(this.points.first);
        for (let i = 0; first + i < points.length && i * s.boxRow < listH; i++) {
            const p = points[first + i];
            const h = Math.min(s.boxRow, listH - i * s.boxRow);
            const box = this.place(`point.${first + i}`, { x: x0, y: y + i * s.boxRow, width: inner - bar, height: h });
            const fill = p.id === this.picked ? THEME.faceOn : hover === `point.${first + i}` ? THEME.faceHover : i % 2 ? undefined : THEME.face;
            scene.set(`point.${i}`, { type: "rect", ...box, fill: fill ?? "#00000000", z: Z.face });
            if (h === s.boxRow) {
                this.pointRow(scene, i, p, box);
            }
        }
        this.points.draw(scene, "points");
        if (this.points.track) {
            this.place("points.track", this.points.track);
            this.place("points.thumb", this.points.thumb!);
        }
        y += listH + 4;
        const halfW = Math.floor((inner - 4) / 2);
        const btn = (id: string, icon: string, text: string, bx: number, w: number, tip: string, disabled: boolean) => {
            const r = this.place(id, { x: bx, y, width: w, height: s.boxButton }, tip, disabled);
            button(scene, id, r, this.state(id), { icon, iconSize: s.toolIcon, text, textSize: 14, left: true }, overlay);
        };
        const editable = e.playback.canEdit && !e.playback.isLoading;
        btn("checkpoint", "checkpoint", "Save checkpoint", x0, halfW, "Save views and camera (last 10 kept)", !editable);
        btn("restore", "restore", "Restore selected", x0 + inner - halfW, halfW,
            this.picked ? "Restore highlighted point" : "Highlight a point first", !editable || !this.picked);
        y += s.boxButton + 4;
        // Copy and Paste views: the clipboard, in the settings page's text format (patched engine).
        const note = e.clipNote;
        this.clipShown = !!note;
        const clipText = (id: "copy" | "paste", text: string) => note?.id === id ? note.text : text;
        const noClip = "Needs the patched engine (its clipboard)";
        btn("copy", "copy", clipText("copy", "Copy views"), x0, halfW,
            e.canClip ? "Copy this park's views as text, for another park or the settings page (Ctrl+C)" : noClip, !e.canClip || e.playback.isLoading);
        btn("paste", "paste", clipText("paste", "Paste views"), x0 + inner - halfW, halfW,
            e.canClip ? "Replace this park's views with copied ones; its event views stay (Ctrl+V)" : noClip, !e.canClip || !editable);
        if (note) {
            const t = scene.get(`${note.id}.text`);
            if (t) {
                scene.set(`${note.id}.text`, { ...t, colour: note.warning ? THEME.warning : THEME.textGood });
            }
        }
        y += s.boxButton + 10;
        // Playlist properties, folded under their header.
        const ph = this.place("propsHead", { x: x0, y, width: inner, height: s.propHeader }, this.propsOpen ? "Fold" : "Unfold");
        scene.set("propsHead", { type: "rect", ...ph, fill: this.hit() === "propsHead" ? THEME.faceHover : "#00000000", z: Z.face });
        bevel(scene, "propsHead", ph, THEME.backingLight, THEME.backingDark, THEME.bevel, Z.bevel);
        foldMark(scene, "props.mark", this.propsOpen, x0 + 4, y + s.propHeader / 2, overlay);
        label(scene, "props.title", "Playlist", { x: x0 + 24, y, width: 0, height: s.propHeader }, 16, overlay, true);
        const tw = measure(overlay, "Playlist", 16, true).width;
        label(scene, "props.sub", "properties", { x: x0 + 24 + tw + 8, y: y + 1, width: 0, height: s.propHeader }, 13, overlay);
        scene.set("props.sub", { ...scene.get("props.sub")!, colour: THEME.textDim });
        const subW = measure(overlay, "properties", 13).width;
        const seq = fit(overlay, e.playback.sequenceName, 13, inner - 24 - tw - 8 - subW - 24);
        const qw = measure(overlay, seq, 13).width;
        label(scene, "props.name", seq, { x: x0 + inner - 8 - qw, y, width: 0, height: s.propHeader }, 13, overlay);
        y += s.propHeader + 4;
        if (this.propsOpen) {
            y = this.properties(e, scene, x0, y, inner);
        }
        const frame = { x: x0 - s.pad, y: top, width, height: y - top + s.pad - 6 };
        this.frames.push(frame);
        backing(scene, "box", frame, THEME.editorBacking);
        this.boxBottom = frame.y + frame.height;
    }

    /** The build pane's state, to redraw it when it changes. */
    private buildSignature(e: Editor): string {
        const line = builder.line;
        return [line.phase, line.text, builder.running ? Math.floor(builder.elapsed / 1000) : "",
            builder.parks.map(p => p.state + (p.warnings ?? 0) + (p.stale ? "*" : "")).join(","), builder.messages.length,
            builder.pendingEdits(e.playback.installedAt), this.crawlPhase()].join("|");
    }

    /** The step of the building square's crawling stripes (redrawn at CRAWL.fps while a park builds). */
    private crawlPhase(): number {
        return builder.running && builder.parks.some(p => p.state === "building")
            ? Math.floor(this.now() * CRAWL.fps / 1000) % (CRAWL.period / CRAWL.step) : -1;
    }

    /** Diagonal stripes crawling across a rect (rows of rects, as the overlay draws no clipped shapes). */
    private crawl(scene: Scene, id: string, r: Rect): void {
        const phase = Math.max(0, this.crawlPhase()) * CRAWL.step;
        let n = 0;
        for (let row = 0; row < r.height; row += CRAWL.row) {
            const h = Math.min(CRAWL.row, r.height - row);
            // (each row shifted by its height, so the stripes lean; the phase moves them right)
            const shift = (phase - row) % CRAWL.period;
            for (let x = shift - CRAWL.period; x < r.width; x += CRAWL.period) {
                const a = Math.max(0, x), b = Math.min(r.width, x + CRAWL.stripe);
                if (b > a) {
                    scene.set(`${id}.${n++}`, { type: "rect", x: r.x + a, y: r.y + row, width: b - a, height: h, fill: THEME.buildCrawl, z: Z.face + 1 });
                }
            }
        }
    }

    /** The build pane shows only its header: by hand, else when it would run into the top-right box. */
    private buildFolded(): boolean {
        if (this.buildOpen !== undefined) {
            return !this.buildOpen;
        }
        return ui.height - EDITOR.buildBottom - this.buildHeight(false) < this.boxBottom + EDITOR.gap * 2;
    }

    private buildHeight(folded: boolean): number {
        const s = EDITOR;
        const head = s.propHeader;
        if (folded) {
            return s.pad + head + s.pad;
        }
        return s.pad + head + 6 + 18 + 4 + s.square + 8 + s.buildButton + 10 + s.labelHeight + 3
            + Math.round(s.boxRow * s.boxRows) + 8 + s.boxButton + s.pad;
    }

    /** The bottom-right pane: building the playlist from the game (builder.ts; patched engine). */
    private buildPane(e: Editor, scene: Scene): void {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        const width = s.boxWidth;
        const folded = this.buildFolded();
        const height = this.buildHeight(folded);
        // (above the mode's exit button in the bottom right corner)
        const frame = { x: ui.width - s.x - width, y: ui.height - s.buildBottom - height, width, height };
        const x0 = frame.x + s.pad;
        const inner = width - 2 * s.pad;
        let y = frame.y + s.pad;
        const line = builder.line;
        this.buildShown = this.buildSignature(e);
        this.frames.push(frame);
        backing(scene, "build.frame", frame, THEME.editorBacking);
        // Header: Build · playlist, where the build is at the right.
        const head = this.place("buildHead", { x: x0, y, width: inner, height: s.propHeader }, folded ? "Unfold" : "Fold");
        scene.set("buildHead", { type: "rect", ...head, fill: this.hit() === "buildHead" ? THEME.faceHover : "#00000000", z: Z.face });
        bevel(scene, "buildHead", head, THEME.backingLight, THEME.backingDark, THEME.bevel, Z.bevel);
        foldMark(scene, "build.mark", !folded, x0 + 4, y + s.propHeader / 2, overlay);
        label(scene, "build.title", "Build", { x: x0 + 24, y, width: 0, height: s.propHeader }, 16, overlay, true);
        const tw = measure(overlay, "Build", 16, true).width;
        label(scene, "build.sub", "saves live edits to the playlist", { x: x0 + 24 + tw + 8, y: y + 1, width: 0, height: s.propHeader }, 13, overlay);
        scene.set("build.sub", { ...scene.get("build.sub")!, colour: THEME.textDim });
        const count = builder.count;
        const [stateText, stateColour] = line.phase === "unavailable" ? ["needs the patched engine", THEME.textDim]
            : line.phase === "running" ? [count ? `building ${count.park}/${count.parks}` : "building", THEME.textGood]
            : line.phase === "failed" ? ["failed", THEME.warning]
            : builder.pendingEdits(e.playback.installedAt) ? ["edits not built", THEME.pending]
            : ["built · playing", THEME.textGood];
        const stw = measure(overlay, stateText, 13).width;
        label(scene, "build.state", stateText, { x: x0 + inner - 8 - stw, y, width: 0, height: s.propHeader }, 13, overlay);
        scene.set("build.state", { ...scene.get("build.state")!, colour: stateColour });
        y += s.propHeader + 6;
        if (folded) {
            this.messagesRect = undefined;
            return;
        }
        // Where the build is (the park and the time so far), then a square per park in play order.
        const running = line.phase === "running";
        const time = running ? clock(builder.elapsed) : "";
        const timeW = time ? measure(overlay, time, 13).width : 0;
        // Only while it runs or when it failed: the header and the messages say the rest (owner, 2026-11-11)
        const shownLine = running || line.phase === "failed" || line.phase === "unavailable" ? line.text : "";
        // (with no line the squares take its space: owner, 2026-11-12)
        let squareH = s.square + 18 + 4;
        if (shownLine) {
            label(scene, "build.line", fit(overlay, shownLine, 13, inner - timeW - 12), { x: x0, y, width: 0, height: 18 }, 13, overlay);
            scene.set("build.line", { ...scene.get("build.line")!, colour: line.warning ? THEME.warning : line.phase === "done" ? THEME.textGood : THEME.text });
            if (time) {
                label(scene, "build.time", time, { x: x0 + inner - timeW, y, width: 0, height: 18 }, 13, overlay);
                scene.set("build.time", { ...scene.get("build.time")!, colour: THEME.textDim });
            }
            y += 18 + 4;
            squareH = s.square;
        }
        this.squares(scene, builder.parks, x0, y, inner, squareH);
        y += squareH + 8;
        // Build and play, or Cancel build while one runs.
        const unavailable = line.phase === "unavailable";
        const nothing = !running && !unavailable && !builder.pendingEdits(e.playback.installedAt);
        const build = this.place("build", { x: x0, y, width: inner, height: s.buildButton },
            unavailable ? line.text : running ? "Stop the build; the playlist plays on as it was (Ctrl+B)"
                : nothing ? "Nothing to build: the playlist files hold every edit"
                : "Save your live edits to the playlist and build it in the background, then play it (Ctrl+B)", unavailable || nothing);
        const st = this.state("build");
        button(scene, "build", build, { ...st, face: running || unavailable || nothing || st.hover || st.down ? undefined : THEME.buildFace },
            { icon: running ? "close" : "build", iconSize: s.toolIcon, text: running ? "Cancel build" : "Build and play", textSize: 16, hint: "Ctrl+B" }, overlay);
        y += s.buildButton + 10;
        // The messages: what the build took in, built, warned about; one about a park opens it.
        this.sectionLabel(scene, "build.msgs", "MESSAGES", x0, y);
        y += s.labelHeight + 3;
        const shown = builder.messages;
        const messages = shown.length ? shown : [{ level: "info" as const, text: line.text || "No build from the game yet", park: undefined }];
        const listH = Math.round(s.boxRow * s.boxRows);
        const bar = messages.length > s.boxRows ? s.scrollBar + 2 : 0;
        this.messagesRect = { x: x0, y, width: inner, height: listH };
        this.messages.layout({ x: x0 + inner - s.scrollBar, y, width: s.scrollBar, height: listH }, messages.length, s.boxRows);
        scene.set("build.list", { type: "rect", ...this.messagesRect, fill: THEME.editorList, z: Z.face });
        const first = Math.floor(this.messages.first);
        const marks = { info: ["info", THEME.buildInfo], ok: ["check", THEME.buildDone], warn: ["alert", THEME.buildWarn], error: ["alert", THEME.buildFail] };
        for (let i = 0; first + i < messages.length && i * s.boxRow < listH; i++) {
            const m = messages[first + i];
            const h = Math.min(s.boxRow, listH - i * s.boxRow);
            const id = `msg.${first + i}`;
            const opens = m.park !== undefined && shown.length > 0 && e.playback.parkIndexOf(m.park) >= 0;
            const row = this.place(id, { x: x0, y: y + i * s.boxRow, width: inner - bar, height: h },
                opens ? `${m.text} (click: open the park)` : m.text);
            const fill = opens && this.hovered === id ? THEME.faceHover : i % 2 ? undefined : THEME.face;
            scene.set(`msgr.${i}`, { type: "rect", ...row, fill: fill ?? "#00000000", z: Z.face });
            if (h < s.boxRow) {
                continue;
            }
            const [icon, colour] = marks[m.level] ?? marks.info;
            const px = iconPixels(20, overlay.scale);
            const side = px / overlay.scale;
            const mark = { x: row.x + 6, y: row.y + (s.boxRow - side) / 2, width: side, height: side };
            scene.set(`msgm.${i}`, { type: "rect", ...mark, fill: colour, z: Z.face + 1 });
            scene.set(`msgi.${i}`, { type: "image", src: iconPath(icon, px), x: mark.x, y: mark.y, z: Z.icon });
            label(scene, `msgt.${i}`, fit(overlay, m.text, s.textSize - 1, row.width - 40), { x: row.x + 32, y: row.y, width: 0, height: s.boxRow }, s.textSize - 1, overlay);
        }
        this.messages.draw(scene, "messages");
        if (this.messages.track) {
            this.place("messages.track", this.messages.track);
            this.place("messages.thumb", this.messages.thumb!);
        }
        y += listH + 8;
        // Import and Export wait for a way to pick files.
        const halfW = Math.floor((inner - 4) / 2);
        for (const [id, icon, text, bx] of [["import", "import", "Import playlist", x0], ["export", "export", "Export playlist", x0 + inner - halfW]] as const) {
            const r = this.place(id, { x: bx, y, width: halfW, height: s.boxButton }, `${text} (coming later)`, true);
            button(scene, id, r, this.state(id), { icon, iconSize: s.toolIcon, text, textSize: 14, left: true }, overlay);
        }
    }

    /** A square per park of the build, in play order: built (a check), with warnings (!), failed or
     *  missing (red), the one being built (lit), still to come (empty); a bar past squaresMax parks. */
    private squares(scene: Scene, parks: (ParkState & { stale?: boolean })[], x0: number, y: number, inner: number, height: number): void {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        if (!parks.length) {
            return;
        }
        const colourOf = (p: ParkState) => p.state === "failed" || p.state === "missing" ? THEME.buildFail
            : p.state === "building" ? THEME.buildCurrent
            : p.state === "built" || p.state === "cached" ? (p.warnings ? THEME.buildWarn : THEME.buildDone) : THEME.editorList;
        if (parks.length > s.squaresMax) {
            const done = parks.filter(p => p.state !== "pending" && p.state !== "building").length;
            const bad = parks.some(p => p.state === "failed" || p.state === "missing");
            const track = { x: x0, y, width: inner, height };
            scene.set("sq.track", { type: "rect", ...track, fill: THEME.editorList, z: Z.face });
            bevel(scene, "sq.track", track, THEME.bevelDark, THEME.bevelLight, THEME.bevel, Z.bevel);
            scene.set("sq.fill", { type: "rect", x: x0, y, width: Math.round(inner * done / parks.length), height, fill: bad ? THEME.buildFail : THEME.buildDone, z: Z.face + 1 });
            if (parks.some(p => p.state === "building")) {
                // (the slot of the park being built crawls, as its square would)
                const slot = Math.max(4, Math.round(inner / parks.length));
                const at = Math.round(inner * done / parks.length);
                this.crawl(scene, "sq.crawl", { x: x0 + at, y, width: Math.min(slot, inner - at), height });
            }
            const text = `${done} / ${parks.length} parks`;
            label(scene, "sq.count", text, { x: x0 + inner / 2, y, width: 0, height }, 12, overlay, true);
            scene.set("sq.count", { ...scene.get("sq.count")!, align: "center" });
            return;
        }
        const gap = 2;
        const w = (inner - gap * (parks.length - 1)) / parks.length;
        const px = iconPixels(20, overlay.scale);
        const side = px / overlay.scale;
        parks.forEach((p, i) => {
            const r = { x: Math.round(x0 + i * (w + gap)), y, width: Math.max(1, Math.round(w)), height };
            const what = p.state === "missing" ? "file missing" : p.state === "failed" ? "failed" : p.state === "building" ? "building"
                : p.state === "pending" ? "waiting" : `${p.state === "cached" ? "unchanged" : "built"}${p.warnings ? `, ${p.warnings} warning${p.warnings > 1 ? "s" : ""}` : ""}`;
            const name = (p.key && builder.nameOf?.(p.key)) || p.name || `Park ${i + 1}`;
            this.place(`sq.${i}`, r, `${name}: ${p.stale ? "edited, needs a build" : what}`);
            // A park with edits since the last build: its colour dimmed until the build reaches it
            scene.set(`sq.${i}`, { type: "rect", ...r, fill: colourOf(p), z: Z.face, ...(p.stale ? { opacity: 0.35 } : {}) });
            bevel(scene, `sq.${i}`, r, THEME.bevelDark, THEME.bevelDark, THEME.bevel, Z.bevel);
            if (p.state === "building") {
                this.crawl(scene, `sqc.${i}`, r);
            }
            const icon = p.state === "failed" || p.state === "missing" ? "close" : p.state === "built" || p.state === "cached" ? (p.warnings ? "alert" : "check") : undefined;
            if (icon && r.width >= side && !p.stale) {
                scene.set(`sqi.${i}`, { type: "image", src: iconPath(icon, px), x: r.x + (r.width - side) / 2, y: r.y + (r.height - side) / 2, z: Z.icon });
            }
        });
    }

    private pointRow(scene: Scene, i: number, p: RestorePoint, box: Rect): void {
        const overlay = this.mode.overlay;
        const size = EDITOR.textSize;
        label(scene, `pt.${i}`, p.label, { x: box.x + 8, y: box.y, width: 0, height: box.height }, size, overlay);
        if (p.tag) {
            const tx = box.x + 8 + measure(overlay, p.label, size).width + 8;
            const tm = measure(overlay, p.tag, 10);
            const chip = { x: tx, y: Math.round(box.y + (box.height - tm.height - 4) / 2), width: Math.ceil(tm.width) + 8, height: Math.ceil(tm.height) + 4 };
            scene.set(`ptag.${i}`, { type: "rect", ...chip, fill: "#00000000", border: THEME.textDim, borderWidth: 1, z: Z.icon });
            scene.set(`ptagt.${i}`, { type: "text", text: p.tag, size: 10, colour: THEME.textDim, x: chip.x + 4, y: chip.y + 2, z: Z.icon });
        }
        const when = p.time !== undefined ? formatTime(p.time, Date.now()) : "-";
        const ww = measure(overlay, when, size).width;
        label(scene, `ptime.${i}`, when, { x: box.x + box.width - 8 - ww, y: box.y, width: 0, height: box.height }, size, overlay);
        scene.set(`ptime.${i}`, { ...scene.get(`ptime.${i}`)!, colour: THEME.textDim });
    }

    /** Motion, timing and presentation; returns the y below them. */
    private properties(e: Editor, scene: Scene, x0: number, y: number, inner: number): number {
        const s = EDITOR;
        const overlay = this.mode.overlay;
        const props = e.playback.playlistProps;
        const section = (name: string) => {
            this.sectionLabel(scene, `sec.${name}`, name, x0, y);
            y += s.labelHeight + 3;
        };
        const rowLabel = (key: string, text: string) =>
            label(scene, `prop.${key}`, text, { x: x0, y, width: 0, height: s.propRow }, s.textSize, overlay);
        const segments = (key: keyof PlaylistProps, text: string) => {
            rowLabel(key, text);
            const choices = CHOICES[key]!;
            const widths = choices.map(([t]) => Math.ceil(measure(overlay, t, 13, true).width) + 2 * s.segPad);
            let sx = x0 + inner - widths.reduce((a, w) => a + w, 0) - s.gap * (choices.length - 1);
            const sy = y + Math.round((s.propRow - s.segHeight) / 2);
            choices.forEach(([t, value, tip], i) => {
                const id = `seg.${key}.${i}`;
                const r = this.place(id, { x: sx, y: sy, width: widths[i], height: s.segHeight }, tip);
                button(scene, id, r, this.state(id, props[key as keyof typeof props] === value), { text: t, textSize: 13 }, overlay);
                sx += widths[i] + s.gap;
            });
            y += s.propRow;
        };
        const stepper = (key: "changeHold" | "arriveHold" | "returnHold", text: string, tip: string) => {
            rowLabel(key, text);
            const w = s.stepButton;
            const sy = y + Math.round((s.propRow - w) / 2);
            const right = x0 + inner;
            const more = this.place(`step.${key}.more`, { x: right - w, y: sy, width: w, height: w }, tip);
            const value = { x: more.x - s.gap - s.stepValueBox, y: sy, width: s.stepValueBox, height: w };
            const less = this.place(`step.${key}.less`, { x: value.x - s.gap - w, y: sy, width: w, height: w }, tip);
            button(scene, `step.${key}.less`, less, this.state(`step.${key}.less`), { icon: "less", iconSize: 16 }, overlay);
            button(scene, `step.${key}.more`, more, this.state(`step.${key}.more`), { icon: "add", iconSize: 16 }, overlay);
            scene.set(`stepv.${key}`, { type: "rect", ...value, fill: THEME.editorList, z: Z.face });
            const vid = `stept.${key}`;
            label(scene, vid, `${props[key].toFixed(1)} s`, { x: value.x + value.width / 2, y: sy, width: 0, height: w }, 13, overlay);
            scene.set(vid, { ...scene.get(vid)!, align: "center" });
            y += s.propRow;
        };
        section("MOTION");
        segments("inertia", "Inertia");
        segments("panChanges", "Angle and zoom change");
        section("TIMING");
        if (props.panChanges !== "off") {
            // Off: no pan turns or zooms, so these do not apply (owner, 2026-11-10).
            stepper("changeHold", "Change hold", "Pause after a turn or zoom");
            stepper("arriveHold", "Arrival hold", "Pause before a turn or zoom");
        }
        stepper("returnHold", "Return hold", "Pause at first view before next park");
        section("PRESENTATION");
        segments("titleMusic", "Title music");
        segments("titles", "Show titles");
        return y + 6;
    }
}

/** An open (pointing down) or folded (pointing right) mark, its left edge at x, centred on cy. */
function foldMark(scene: Scene, id: string, open: boolean, x: number, cy: number, overlay: Overlay): void {
    const px = iconPixels(20, overlay.scale);
    const side = px / overlay.scale;
    scene.set(id, { type: "image", src: iconPath(open ? "fold-open" : "fold-closed", px), x: Math.round(x), y: Math.round(cy - side / 2), z: Z.icon });
}

/** Six dots: the drag handle of a row. */
function grip(scene: Scene, id: string, x: number, cy: number, z: number = Z.icon): void {
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 2; c++) {
            scene.set(`${id}.${r}${c}`, { type: "rect", x: x + c * 4, y: Math.round(cy - 5 + r * 4), width: 2, height: 2, fill: THEME.textDim, z });
        }
    }
}

/** `text` cut with an ellipsis to fit `width`. */
function fit(overlay: Overlay, text: string, size: number, width: number, bold = false): string {
    if (width <= 0 || measure(overlay, text, size, bold).width <= width) {
        return text;
    }
    let t = text;
    while (t.length > 1 && measure(overlay, t + "…", size, bold).width > width) {
        t = t.slice(0, -1);
    }
    return t.trimEnd() + "…";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A restore point's time: the hour today, else with its date (local time). */
export function formatTime(ms: number, now: number): string {
    const d = new Date(ms);
    const n = new Date(now);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return today ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hm}`;
}

/**
 * Where each list column starts: each as wide as its widest text (header or cell) plus a margin, the
 * spare width shared out evenly; squeezed in proportion if the texts are wider than the list.
 */
function columnStarts(width: number, rows: string[][], overlay: Overlay, headers: string[]): number[] {
    const size = EDITOR.textSize;
    const natural = headers.map((h, c) => Math.max(
        measure(overlay, h, size, true).width,
        ...rows.map(r => measure(overlay, headers === EDITOR_COLUMNS && c === 6 ? "event (locked)" : r[c] ?? "", size).width),
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
