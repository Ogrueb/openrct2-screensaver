// View editor on the title screen: pick a park, move the camera, and add, change, reorder or
// delete its views. The logic is here; what shows it is an EditorView: a stock window on the stock
// engine (WindowView, below), the overlay panel in the screensaver mode (ui/editor-panel.ts), as
// windows do not show in the mode and the overlay keeps clear of the park's palette. Playback pauses while the editor is open, unless Play is on: then the park's
// views play with their pans, looping in the park, the list highlighting the view on screen, and
// every edit plays on again from the selected view a second later. Moving the camera by hand stops it. Edited views are saved to
// shared storage as they change (see Player.setViews) and replace the park's playlist views.
// Live editing (docs/screensaver-ui.md, "Live editing"): in the mode, dragging the park moves the camera and
// the selected view goes where it ends, the wheel zooms the selected view, Fit sets its height to what is
// under the screen's centre, and every change can be undone (per park, while the plugin runs).

import { toScreen, toWorld } from "./fit";
import { Player } from "./player";
import { View } from "./storage";

const CLASSIFICATION = "rctscreensaver.editor";
const WIDTH = 300;
const HEIGHT = 268;
const TILE = 32;
const PAN_STEP = 64; // screen pixels at zoom 0 per arrow press
const PAN_FAST = 4; // multiplier with Shift
const MIN_ZOOM = -2; // closer than the game's usual limit (OpenRCT2's ZoomLevel::min)
const MAX_ZOOM = 3;
const MIN_HOLD = 1;
const MAX_HOLD = 600;
const DEFAULT_HOLD = 10;
const PAN_SHARE_STEP = 0.1;
const UNDO_DEPTH = 100; // changes kept per park
const MAX_Z = 2040; // the highest world height (255 height steps of 8)
const Z_STEP = 8; // one height step

/** What shows the editor: opened and closed by it, refreshed after every change. */
export interface EditorView {
    open(editor: Editor): void;
    close(): void;
    refresh(): void;
}

/** One view's row in the list. */
export type EditorRow = [index: string, tile: string, angle: string, zoom: string, hold: string, pan: string, setBy: string];
export const EDITOR_COLUMNS = ["#", "Tile", "Angle", "Zoom", "Hold", "Pan", "Set by"];

/** Camera position: world coordinates of the screen centre, as the plugin moves it. */
interface Camera {
    x: number;
    y: number;
    z: number;
    rotation: number;
    zoom: number;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** A park's views before a change, to go back to. */
interface Snapshot {
    views: View[];
    selected: number;
    edited: boolean; // the views were hand-set; false: undoing goes back to the playlist's views
}

/** Top of what stands on a tile (world units): the highest visible element, or the ground or
 * water; undefined off the map. */
function topZ(tx: number, ty: number): number | undefined {
    const size = map.size;
    if (tx < 0 || ty < 0 || (size && (tx >= size.x || ty >= size.y))) {
        return undefined;
    }
    try {
        let top: number | undefined;
        for (const e of map.getTile(tx, ty).elements) {
            if (e.isHidden) {
                continue;
            }
            const h = e.type === "surface" ? Math.max(e.baseZ, e.waterHeight ?? 0) : e.clearanceZ ?? e.baseZ;
            top = top === undefined ? h : Math.max(top, h);
        }
        return top;
    } catch {
        return undefined;
    }
}

/** The height of what is seen at a screen point (zoom 0 screen coordinates at `rotation`): walks
 * down the heights the point could show, nearest the camera first, to the first tile whose top
 * reaches the height; undefined when the point shows only the void. */
export function surfaceZ(p: { x: number; y: number }, rotation: number, top = topZ): number | undefined {
    for (let z = MAX_Z; z >= 0; z -= Z_STEP) {
        const w = toWorld(p, z, rotation);
        const h = top(Math.floor(w.x / TILE), Math.floor(w.y / TILE));
        if (h !== undefined && h >= z) {
            return z;
        }
    }
    return undefined;
}

/** Ground height (world units) at a tile, or 0 off the map. */
function groundZ(x: number, y: number): number {
    try {
        const surface = map.getTile(Math.floor(x / TILE), Math.floor(y / TILE)).elements
            .find(e => e.type === "surface");
        return surface ? surface.baseZ : 0;
    } catch {
        return 0;
    }
}

export class Editor {
    private shown = false;
    private camera: Camera = { x: 0, y: 0, z: 0, rotation: 0, zoom: 0 };
    private selected = -1;
    private undoStacks = new Map<number, { undo: Snapshot[]; redo: Snapshot[] }>(); // by park index
    private gesture: { commit: boolean; moved: boolean } | undefined; // a drag on the park

    constructor(private readonly player: Player, private readonly view: EditorView = new WindowView()) {}

    get isOpen(): boolean {
        return this.shown;
    }

    open(): void {
        if (this.shown) {
            return;
        }
        this.shown = true;
        this.player.setEditing(true);
        this.player.onViewShown = view => this.viewShown(view);
        this.selected = this.player.viewIndex;
        const view = this.player.currentViews[this.selected];
        if (view) {
            this.cameraFromView(view);
        } else {
            this.cameraFromViewport();
        }
        this.view.open(this);
        this.refresh();
    }

    close(): void {
        if (this.shown) {
            this.view.close(); // a window calls closed() as it closes; closed() runs once
            this.closed();
        }
    }

    /** Moves the camera by a number of steps on screen (right and down are positive). */
    pan(dx: number, dy: number, fast = false): void {
        this.stopPreview();
        const step = PAN_STEP * (fast ? PAN_FAST : 1);
        this.moveCamera(dx * step, dy * step);
    }

    /** Moves the camera by window pixels (right and down are positive), on the plane at its height. */
    private moveCamera(dx: number, dy: number): void {
        const c = this.camera;
        const scale = Math.pow(2, c.zoom);
        const p = toScreen(c.x, c.y, c.z, c.rotation);
        const world = toWorld({ x: p.x + dx * scale, y: p.y + dy * scale }, c.z, c.rotation);
        c.x = world.x;
        c.y = world.y;
        this.applyCamera();
    }

    // Live editing: the mouse on the park.

    /** A press on the park: a drag starts. It edits the selected view only if Play was off (a
     * drag during Play just stops it where it is). */
    dragStart(): void {
        this.gesture = { commit: !this.player.isPreviewing && this.selectedIndex >= 0, moved: false };
        this.stopPreview();
    }

    /** The mouse moved by window pixels during a drag: the park follows it. */
    dragBy(dx: number, dy: number): void {
        if (!this.gesture || (dx === 0 && dy === 0)) {
            return;
        }
        this.gesture.moved = true;
        this.moveCamera(-dx, -dy);
    }

    /** The drag ended: the selected view goes where the camera is, as one change. */
    dragEnd(): void {
        const g = this.gesture;
        this.gesture = undefined;
        if (g?.commit && g.moved) {
            this.update();
        }
    }

    get dragging(): boolean {
        return this.gesture !== undefined;
    }

    /** The wheel over the park: zooms the camera a level (delta > 0 in) and the selected view with
     * it; during Play it only stops Play. */
    wheel(delta: number): void {
        const commit = !this.player.isPreviewing && this.selectedIndex >= 0;
        this.zoom(delta > 0 ? -1 : 1);
        if (commit) {
            this.update();
        }
    }

    /** Sets the camera's height to what is under the screen's centre, without moving the picture,
     * and the selected view's with it. */
    fit(): void {
        this.stopPreview();
        const c = this.camera;
        const p = toScreen(c.x, c.y, c.z, c.rotation);
        const z = surfaceZ(p, c.rotation);
        if (z === undefined) {
            return;
        }
        const world = toWorld(p, z, c.rotation);
        this.camera = { ...c, x: world.x, y: world.y, z };
        this.applyCamera();
        if (this.selectedIndex >= 0) {
            this.update();
        }
    }

    // Undo and redo, per park.

    private stacks(): { undo: Snapshot[]; redo: Snapshot[] } {
        const park = this.player.parkIndex;
        let s = this.undoStacks.get(park);
        if (!s) {
            s = { undo: [], redo: [] };
            this.undoStacks.set(park, s);
        }
        return s;
    }

    private snapshot(): Snapshot {
        return { views: this.views(), selected: this.selected, edited: this.player.isEdited };
    }

    private sameAs(s: Snapshot): boolean {
        return s.edited === this.player.isEdited && JSON.stringify(s.views) === JSON.stringify(this.player.currentViews);
    }

    /** Runs a change, remembering the views before it if it changed them. */
    private change(apply: () => void): void {
        if (this.player.isLoading) {
            return;
        }
        const before = this.snapshot();
        apply();
        if (!this.sameAs(before)) {
            const s = this.stacks();
            s.undo.push(before);
            if (s.undo.length > UNDO_DEPTH) {
                s.undo.shift();
            }
            s.redo = [];
            this.refresh();
        }
    }

    undo(): void {
        this.step(true);
    }

    redo(): void {
        this.step(false);
    }

    get canUndo(): boolean {
        return !this.player.isLoading && (this.undoStacks.get(this.player.parkIndex)?.undo.length ?? 0) > 0;
    }

    get canRedo(): boolean {
        return !this.player.isLoading && (this.undoStacks.get(this.player.parkIndex)?.redo.length ?? 0) > 0;
    }

    private step(back: boolean): void {
        if (this.player.isLoading) {
            return;
        }
        const s = this.stacks();
        const target = (back ? s.undo : s.redo).pop();
        if (!target) {
            return;
        }
        (back ? s.redo : s.undo).push(this.snapshot());
        this.restore(target);
    }

    private restore(to: Snapshot): void {
        if (!to.edited) {
            this.player.revertViews(); // the playlist's own views, as before the first edit
            this.selected = this.player.viewIndex;
            this.refresh();
            return;
        }
        const show = Math.min(to.selected, to.views.length - 1);
        this.selected = show;
        this.player.setViews(to.views.map(v => ({ ...v })), show, true);
        if (show < 0) {
            this.refresh();
        }
        this.replay();
    }

    rotate(delta: number): void {
        this.stopPreview();
        this.camera.rotation = (this.camera.rotation + delta + 4) % 4;
        this.applyCamera();
    }

    zoom(delta: number): void {
        this.stopPreview();
        this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.zoom + delta));
        this.applyCamera();
    }

    /** Play on or off: the park's views play with their pans while the editor stays open. */
    togglePreview(): void {
        const on = !this.player.isPreviewing;
        if (!on) {
            this.cameraFromViewport(); // stay where playback left the camera
        }
        this.player.setPreview(on, Math.max(0, this.selected));
        this.refresh();
    }

    /** Moving the camera by hand stops the preview where it is. */
    private stopPreview(): void {
        if (this.player.isPreviewing) {
            this.player.setPreview(false);
            this.cameraFromViewport();
        }
    }

    /** After an edit or a selection: play on from the selected view a second later. */
    private replay(): void {
        if (this.player.isPreviewing && this.selected >= 0) {
            this.player.restartPreview(this.selected);
        }
    }

    /** The view was closed (or its window). */
    closed(): void {
        if (!this.shown) {
            return;
        }
        this.shown = false;
        this.player.onViewShown = undefined;
        this.player.setEditing(false);
    }

    select(index: number): void {
        this.selected = index;
        this.player.showViewAt(index); // calls viewShown
        this.replay();
    }

    /** The views to change: the park's current views, copied (generated ones are fitted).
     * Empty while a park is loading, so nothing is changed until its views are on screen. */
    private views(): View[] {
        return this.player.isLoading ? [] : this.player.currentViews.map(v => ({ ...v }));
    }

    private cameraView(hold: number): View {
        const c = this.camera;
        return {
            x: round2((c.x - TILE / 2) / TILE), y: round2((c.y - TILE / 2) / TILE),
            z: Math.round(c.z), rotation: c.rotation, zoom: c.zoom, hold, manual: true,
        };
    }

    add(): void {
        this.change(() => {
            const views = this.views();
            const at = this.selected >= 0 ? this.selected + 1 : views.length;
            views.splice(at, 0, this.cameraView(views[this.selected]?.hold ?? DEFAULT_HOLD));
            this.save(views, at);
        });
    }

    update(): void {
        this.change(() => {
            const views = this.views();
            if (!views[this.selected]) {
                return;
            }
            // Keeps how the view pans on and its flags; only where it looks changes.
            views[this.selected] = { ...views[this.selected], ...this.cameraView(views[this.selected].hold) };
            delete views[this.selected].overview; // a framed overview plays as framed
            this.save(views, this.selected);
        });
    }

    remove(): void {
        this.change(() => {
            const views = this.views();
            if (!views[this.selected]) {
                return;
            }
            views.splice(this.selected, 1);
            this.save(views, Math.min(this.selected, views.length - 1), true);
        });
    }

    move(delta: number): void {
        this.change(() => {
            const views = this.views();
            const to = this.selected + delta;
            if (!views[this.selected] || to < 0 || to >= views.length) {
                return;
            }
            [views[this.selected], views[to]] = [views[to], views[this.selected]];
            this.save(views, to, true);
        });
    }

    changeHold(delta: number): void {
        this.change(() => {
            const views = this.views();
            const view = views[this.selected];
            if (!view) {
                return;
            }
            view.hold = Math.min(MAX_HOLD, Math.max(MIN_HOLD, Math.round(view.hold) + delta));
            this.player.setViews(views, -1, true); // no camera move: the view itself is unchanged
            this.replay();
            this.refresh();
        });
    }

    /** Changes the share of the selected view's hold spent panning to the next view. */
    changePan(delta: number): void {
        this.togglePan(v => ({ pan: Math.round(Math.min(1, Math.max(0, this.player.panOf(v) + delta)) * 10) / 10 }));
    }

    toggleTurn(): void {
        this.togglePan(v => ({ panChanges: this.player.panChangesOf(v) === "start" ? "end" : "start" }));
    }

    toggleInertia(): void {
        this.togglePan(v => ({ inertia: !this.player.inertiaOf(v) }));
    }

    goToPark(index: number): void {
        const n = this.player.parkNames.length;
        if (n > 0) {
            this.player.goToPark(((index % n) + n) % n);
            this.refresh();
        }
    }

    revert(): void {
        this.change(() => this.player.revertViews());
    }

    /** Changes how the selected view pans on; like a hold, a change to how the list plays. */
    private togglePan(edit: (view: View) => Partial<View>): void {
        this.change(() => {
            const views = this.views();
            const view = views[this.selected];
            if (!view) {
                return;
            }
            Object.assign(view, edit(view));
            if (view.pan === 0) {
                delete view.pan;
            }
            this.player.setViews(views, -1, true);
            this.replay();
            this.refresh();
        });
    }

    /** Saves the views; `arranged` when the list itself was changed by hand (not just a view). */
    private save(views: View[], show: number, arranged = false): void {
        this.selected = show;
        if (show < 0) {
            this.player.setViews(views, -1, arranged);
            this.refresh();
            return;
        }
        // Showing the saved view moves the camera to it; for add/update it already is there.
        this.player.setViews(views, show, arranged);
        this.replay();
    }

    /** A view was shown (selected, the park finished loading, or Play moved on): follow it, so
     * the list highlights the view on screen and edits apply to it. */
    private viewShown(view: View | undefined): void {
        if (view) {
            this.cameraFromView(view);
        } else {
            this.cameraFromViewport();
        }
        this.selected = this.player.viewIndex;
        this.refresh();
    }

    private cameraFromView(view: View): void {
        this.camera = {
            x: view.x * TILE + TILE / 2, y: view.y * TILE + TILE / 2, z: view.z,
            rotation: view.rotation, zoom: view.zoom,
        };
    }

    private cameraFromViewport(): void {
        const vp = ui.mainViewport;
        const centre = vp.getCentrePosition();
        this.camera = { x: centre.x, y: centre.y, z: groundZ(centre.x, centre.y), rotation: vp.rotation, zoom: vp.zoom };
    }

    private applyCamera(): void {
        const c = this.camera;
        const vp = ui.mainViewport;
        vp.rotation = c.rotation;
        vp.zoom = c.zoom;
        c.zoom = vp.zoom; // the engine may clamp it
        vp.moveTo({ x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) });
        this.refresh();
    }

    // What the views show.

    get parkNames(): string[] {
        return this.player.parkNames;
    }

    get parkIndex(): number {
        return this.player.parkIndex;
    }

    get selectedIndex(): number {
        return this.player.currentViews[this.selected] ? this.selected : -1;
    }

    get isPlaying(): boolean {
        return this.player.isPreviewing;
    }

    rows(): EditorRow[] {
        return this.player.currentViews.map((v, i) => [String(i + 1), `${Math.round(v.x)}, ${Math.round(v.y)}`,
            String(v.rotation), String(v.zoom), `${v.hold} s`,
            `${Math.round(this.player.panOf(v) * 100)}%`,
            v.manual ? "you" : v.cue || v.animation !== undefined || v.show ? "event" : "auto"]);
    }

    holdText(): string {
        const view = this.player.currentViews[this.selected];
        return view ? `Hold view ${this.selected + 1}: ${view.hold} s` : "Hold: select a view";
    }

    panText(): string {
        const view = this.player.currentViews[this.selected];
        return view ? `Pan: ${Math.round(this.player.panOf(view) * 100)}%` : "Pan: -";
    }

    turnText(): string {
        const view = this.player.currentViews[this.selected];
        return !view ? "-" : this.player.panChangesOf(view) === "start" ? "Turn: start" : "Turn: end";
    }

    inertiaText(): string {
        const view = this.player.currentViews[this.selected];
        return !view ? "-" : this.player.inertiaOf(view) ? "Inertia: on" : "Inertia: off";
    }

    /** The camera and where the views come from; `warning` when they cannot be edited. */
    status(): { text: string; warning: boolean } {
        const c = this.camera;
        const warning = !this.player.isLoading && !this.player.canEdit;
        const source = this.player.isLoading ? "loading park..."
            : warning ? "re-run mksequence.py --install to edit"
                : this.player.isEdited ? "hand-set views" : "playlist views (edit to set your own)";
        return {
            text: `Camera ${Math.round((c.x - TILE / 2) / TILE)}, ${Math.round((c.y - TILE / 2) / TILE)}` +
                ` angle ${c.rotation} zoom ${c.zoom} | ${source}`,
            warning,
        };
    }

    private refresh(): void {
        if (this.shown) {
            this.view.refresh();
        }
    }
}

/** The editor as a stock window (the stock engine; windows do not show in the screensaver mode). */
class WindowView implements EditorView {
    private window: Window | undefined;
    private editor!: Editor;

    open(editor: Editor): void {
        this.editor = editor;
        this.window = ui.openWindow({
            classification: CLASSIFICATION,
            x: 8,
            y: Math.max(30, ui.height - HEIGHT - 8),
            width: WIDTH,
            height: HEIGHT,
            title: "RCT Screensaver: views",
            widgets: this.widgets(),
            onClose: () => {
                this.window = undefined;
                editor.closed();
            },
        });
    }

    close(): void {
        const w = this.window;
        this.window = undefined;
        w?.close();
    }

    private widgets(): WidgetDesc[] {
        const row = (y: number, items: [string, string, () => void][]): WidgetDesc[] => {
            const w = Math.floor((WIDTH - 10 - 2 * (items.length - 1)) / items.length);
            return items.map(([name, text, onClick], i) => ({
                type: "button", name, text, onClick, x: 5 + i * (w + 2), y, width: w, height: 14,
            }));
        };
        return [
            {
                type: "dropdown", name: "park", x: 5, y: 18, width: WIDTH - 10, height: 14,
                items: this.editor.parkNames, selectedIndex: this.editor.parkIndex,
                onChange: i => this.editor.goToPark(i),
            },
            {
                type: "listview", name: "views", x: 5, y: 36, width: WIDTH - 10, height: 104,
                scrollbars: "vertical", isStriped: true, showColumnHeaders: true, canSelect: true,
                columns: [
                    { header: "#", width: 22 },
                    { header: "Tile", width: 62 },
                    { header: "Angle", width: 36 },
                    { header: "Zoom", width: 36 },
                    { header: "Hold", width: 44 },
                    { header: "Pan", width: 44 },
                    { header: "Set by" },
                ],
                onClick: item => this.editor.select(item),
            },
            ...row(144, [
                ["add", "Add view", () => this.editor.add()],
                ["update", "Set to camera", () => this.editor.update()],
                ["delete", "Delete", () => this.editor.remove()],
            ]),
            ...row(160, [
                ["up", "Move up", () => this.editor.move(-1)],
                ["down", "Move down", () => this.editor.move(1)],
                ["revert", "Use playlist views", () => this.editor.revert()],
            ]),
            {
                type: "spinner", name: "hold", x: 5, y: 176, width: WIDTH - 10, height: 14,
                onDecrement: () => this.editor.changeHold(-1), onIncrement: () => this.editor.changeHold(1),
            },
            {
                type: "spinner", name: "pan", x: 5, y: 192, width: 130, height: 14,
                tooltip: "Share of the hold spent panning to the next view (0%: held still, then a cut)",
                onDecrement: () => this.editor.changePan(-PAN_SHARE_STEP), onIncrement: () => this.editor.changePan(PAN_SHARE_STEP),
            },
            {
                type: "button", name: "panChanges", x: 137, y: 192, width: 78, height: 14, text: "",
                tooltip: "Angle and zoom change as the pan sets off, or as it arrives",
                onClick: () => this.editor.toggleTurn(),
            },
            {
                type: "button", name: "inertia", x: 217, y: 192, width: WIDTH - 222, height: 14, text: "",
                tooltip: "Inertia: the pan starts and stops slowly; off, it moves at one speed",
                onClick: () => this.editor.toggleInertia(),
            },
            ...row(208, [
                ["rotl", "Rotate left", () => this.editor.rotate(-1)],
                ["rotr", "Rotate right", () => this.editor.rotate(1)],
                ["zoomin", "Zoom in", () => this.editor.zoom(-1)],
                ["zoomout", "Zoom out", () => this.editor.zoom(1)],
            ]),
            {
                type: "button", name: "play", x: 5, y: 224, width: WIDTH - 10, height: 14, text: "",
                tooltip: "Play this park's views with their pans (looping here); edits play on from the selected view a second later",
                onClick: () => this.editor.togglePreview(),
            },
            { type: "label", name: "status", x: 5, y: 242, width: WIDTH - 10, height: 12, text: "" },
            {
                type: "label", name: "help", x: 5, y: 254, width: WIDTH - 10, height: 12,
                text: "Arrows pan the camera (Shift: faster). E closes.",
            },
        ];
    }

    refresh(): void {
        const w = this.window;
        if (!w) {
            return;
        }
        const e = this.editor;
        w.findWidget<DropdownWidget>("park").selectedIndex = e.parkIndex;
        const list = w.findWidget<ListViewWidget>("views");
        list.items = e.rows();
        list.selectedCell = e.selectedIndex >= 0 ? { row: e.selectedIndex, column: 0 } : null;
        w.findWidget<SpinnerWidget>("hold").text = e.holdText();
        w.findWidget<SpinnerWidget>("pan").text = e.panText();
        w.findWidget<ButtonWidget>("panChanges").text = e.turnText();
        w.findWidget<ButtonWidget>("inertia").text = e.inertiaText();
        w.findWidget<ButtonWidget>("play").text = e.isPlaying ? "Play: on (stops when you move the camera)" : "Play: off";
        w.findWidget<ButtonWidget>("play").isPressed = e.isPlaying;
        const status = e.status();
        w.findWidget<LabelWidget>("status").text = (status.warning ? "{RED}" : "") + status.text;
    }
}
