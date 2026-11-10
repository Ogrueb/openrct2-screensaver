// View editor on the title screen: pick a park, move the camera, and add, change, reorder or
// delete its views. The logic is here; what shows it is an EditorView: a stock window on the stock
// engine (WindowView, below), the overlay panel in the screensaver mode (ui/editor-panel.ts), as
// windows do not show in the mode and the overlay keeps clear of the park's palette. Playback pauses while the editor is open, unless Play is on: then the park's
// views play with their pans, looping in the park, the list highlighting the view on screen, and
// every edit plays on again from the selected view a second later. Moving the camera by hand stops it. Edited views are saved to
// shared storage as they change (see Player.setViews) and replace the park's playlist views.
// Live editing (docs/screensaver-ui.md, "Live editing"): in the mode, dragging the park moves the camera and
// the selected view goes where it ends, the wheel zooms the selected view, and every change can be undone
// (per park, while the plugin runs). A view set from the camera sits at the height of what is at the
// screen's centre, so a turn pivots on it (the Rotate buttons too). The map (M, or the panel's Map button)
// steps the camera out and shows every view as a box to drag (ui/view-map.ts); its edits are below.

import { toScreen, toWorld } from "./fit";
import { Player } from "./player";
import { CHECKPOINTS_PER_PARK, View, isCut, isPinned, loadCheckpoints, saveCheckpoints, saveSettings } from "./storage";

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
const MAP_OUT = 2; // zoom levels the map steps out from the selected view

/** What shows the editor: opened and closed by it, refreshed after every change. */
export interface EditorView {
    readonly supportsMap?: boolean; // draws the map (the overlay panel; the stock window does not)
    open(editor: Editor): void;
    close(): void;
    refresh(): void;
}

/** One view's row in the list. */
export type EditorRow = [index: string, tile: string, angle: string, zoom: string, hold: string, pan: string, setBy: string];
export const EDITOR_COLUMNS = ["#", "Tile", "Angle", "Zoom", "Hold", "Pan", "Set by"];
export const EVENT_COLUMNS = ["#", "Kind", "Name", "Trigger", "Hold", "Plays"];
const TICKS_PER_SECOND = 40;

/** m:ss for a count of game ticks. */
function clock(ticks: number): string {
    const s = Math.max(0, Math.round(ticks / TICKS_PER_SECOND));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Camera position: world coordinates of the screen centre, as the plugin moves it. */
export interface Camera {
    x: number;
    y: number;
    z: number;
    rotation: number;
    zoom: number;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** A row of the restore points list (the editing UI's top-right box), newest first. */
export interface RestorePoint {
    id: string; // "session", "checkpoint.<n>", "install", "generated"
    label: string;
    tag?: string; // "session", "install", "build": a chip after the label
    time?: number; // ms since 1970
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
    /** The point the last anchor() set: turns pivot on it until the camera moves elsewhere. */
    private pivot?: { x: number; y: number; z: number };
    private selected = -1;
    private undoStacks = new Map<number, { undo: Snapshot[]; redo: Snapshot[] }>(); // by park index
    private gesture: { commit: boolean; moved: boolean } | undefined; // a drag on the park
    private map = false; // the map: every view a box on a camera stepped out
    private mapPark = -1; // the park the map's camera was set on
    private eventsUnlocked = false; // the map lets event views be dragged
    private opened = new Map<string, { time: number; snapshot: Snapshot }>(); // each park's views as the editor first showed it
    private base: { park: number; views: View[] } | undefined; // the current park's playlist views (Reset view)
    private checkpoints = loadCheckpoints(); // by park key, as saved

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
        this.noteOpened();
        this.view.open(this);
        this.refresh();
    }

    /** Remembers the current park's views the first time the editor shows them ("Editor opened"). */
    private noteOpened(): void {
        const key = this.player.parkKey;
        if (this.base && this.base.park !== this.player.parkIndex) {
            this.base = undefined;
        }
        if (key !== undefined && !this.player.isLoading && !this.opened.has(key)) {
            this.opened.set(key, { time: Date.now(), snapshot: this.snapshot() });
        }
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
        this.followViewport(ui.mainViewport); // the engine clamps the view on its next frame
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
        this.gesture = { commit: !this.player.isPreviewing && this.selectedIndex >= 0 && !this.selectedLocked, moved: false };
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
        const commit = !this.map && !this.player.isPreviewing && this.selectedIndex >= 0 && !this.selectedLocked;
        this.zoom(delta > 0 ? -1 : 1);
        if (commit) {
            this.update();
        }
    }

    /** Puts the camera's point at the height of what is seen at the screen's centre (a building's
     * top, the ground or water), without moving the picture: a view set there turns about it, and the
     * camera stays where it was over the void. */
    private anchor(): void {
        const c = this.camera;
        const pv = this.pivot;
        if (pv && Math.abs(c.x - pv.x) <= 1 && Math.abs(c.y - pv.y) <= 1 && Math.abs(c.z - pv.z) <= 1) {
            return; // still on the point set last time: each angle sees another surface there, so
            // anchoring again after a turn would move the pivot a little every turn
        }
        const p = toScreen(c.x, c.y, c.z, c.rotation);
        const z = surfaceZ(p, c.rotation);
        if (z !== undefined) {
            const world = toWorld(p, z, c.rotation);
            this.camera = { ...c, x: world.x, y: world.y, z };
        }
        this.pivot = { x: this.camera.x, y: this.camera.y, z: this.camera.z };
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
        const views = this.player.isLoading ? [] : this.player.currentViews.map(v => ({ ...v }));
        return { views, selected: this.selected, edited: this.player.isEdited };
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
        this.anchor(); // turn about what is at the screen's centre, which stays there
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
        this.map = false; // Play moves the camera through the views: back to the frame
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
        this.map = false;
        this.player.onViewShown = undefined;
        this.player.setEditing(false);
    }

    select(index: number): void {
        this.selected = index;
        if (this.map) {
            this.centreOn(index); // the map keeps its zoom
            return;
        }
        this.player.showViewAt(index); // calls viewShown
        this.replay();
    }

    // The map (ui/view-map.ts): the camera stepped out, every view a box.

    get mapMode(): boolean {
        return this.map;
    }

    get eventsLocked(): boolean {
        return !this.eventsUnlocked;
    }

    toggleEventLock(): void {
        this.eventsUnlocked = !this.eventsUnlocked;
        this.refresh();
    }

    /** The map on or off: on, the camera steps out from the selected view; off, it frames it. */
    toggleMap(): void {
        if (this.player.isLoading || !this.view.supportsMap) {
            return;
        }
        this.stopPreview();
        this.map = !this.map;
        if (this.map) {
            const view = this.player.currentViews[this.selected];
            this.camera.zoom = Math.min(MAX_ZOOM, (view?.zoom ?? this.camera.zoom) + MAP_OUT);
            this.mapPark = this.player.parkIndex;
            this.applyCamera();
        } else if (this.selectedIndex >= 0) {
            this.player.showViewAt(this.selected); // calls viewShown
        } else {
            this.refresh();
        }
    }

    /** A box double-clicked on the map: back to the frame, on that view. */
    frame(index: number): void {
        this.map = false;
        this.select(index);
    }

    /** On the map, puts the camera back on the viewport when the engine turned or zoomed it (a park
     *  load sets its own angle a frame after the plugin's), so the boxes match the picture. */
    syncMap(): void {
        if (!this.map || this.player.isLoading) {
            return;
        }
        const vp = ui.mainViewport;
        if (vp.rotation !== this.camera.rotation || vp.zoom !== this.camera.zoom) {
            this.applyCamera();
        }
    }

    /** The camera as it is (the map projects the views through it). */
    get cameraPose(): Camera {
        return { ...this.camera };
    }

    /** Pans the camera by window pixels (the map's drag on empty park). */
    panBy(dx: number, dy: number): void {
        this.stopPreview();
        this.moveCamera(dx, dy);
    }

    /** Zooms the camera a level (delta > 0 in) without touching a view (the map's wheel). */
    zoomCamera(delta: number): void {
        this.zoom(delta > 0 ? -1 : 1);
    }

    /** Selects a view without moving the camera (a click on its box). */
    pick(index: number): void {
        if (this.player.currentViews[index]) {
            this.selected = index;
            this.refresh();
        }
    }

    /** Centres the camera on a view, turning to its angle so it shows as a box. */
    private centreOn(index: number): void {
        const view = this.player.currentViews[index];
        if (view) {
            this.camera = { ...this.camera, x: view.x * TILE + TILE / 2, y: view.y * TILE + TILE / 2, z: view.z, rotation: view.rotation };
            this.applyCamera();
        }
    }

    /** Moves a view to a tile position (its height and the rest unchanged): a box dragged on the map. */
    moveView(index: number, x: number, y: number): void {
        this.mapEdit(index, v => ({ x: round2(x), y: round2(y) }));
    }

    /** Changes a view's zoom: a box's corner dragged on the map. */
    zoomView(index: number, zoom: number): void {
        this.mapEdit(index, () => ({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom))) }));
    }

    private mapEdit(index: number, edit: (view: View) => Partial<View>): void {
        const target = this.player.currentViews[index];
        if (target && this.eventsLocked && this.isEvent(target)) {
            return; // a locked event view
        }
        this.change(() => {
            const views = this.views();
            const view = views[index];
            if (!view) {
                return;
            }
            views[index] = { ...view, ...edit(view), manual: true };
            delete views[index].overview; // placed by hand: plays as placed
            this.selected = index;
            this.player.setViews(views, -1); // the camera stays on the map
            this.refresh();
        });
    }

    /** Adds a view at a world point after the selected one, at the camera's angle and the selected
     * view's zoom (a right click on the map). */
    addAt(x: number, y: number, z: number): void {
        this.change(() => {
            const views = this.views();
            const at = this.selected >= 0 ? this.selected + 1 : views.length;
            const near = views[this.selected];
            views.splice(at, 0, {
                x: round2((x - TILE / 2) / TILE), y: round2((y - TILE / 2) / TILE), z: Math.round(z),
                rotation: this.camera.rotation,
                zoom: near?.zoom ?? Math.max(MIN_ZOOM, this.camera.zoom - MAP_OUT),
                hold: near?.hold ?? DEFAULT_HOLD, manual: true,
            });
            this.selected = at;
            this.player.setViews(views, -1);
            this.refresh();
        });
    }

    /** What a view's pan does next: a pan (true) or a cut, for the map's lines. */
    pans(view: View): boolean {
        return this.player.panOf(view) > 0;
    }

    /** The park's views as they play (generated ones fitted to the window). */
    get currentViews(): View[] {
        return this.player.currentViews;
    }

    /** The views to change: the park's current views, copied (generated ones are fitted).
     * Empty while a park is loading, so nothing is changed until its views are on screen. */
    private views(): View[] {
        if (this.player.isLoading) {
            return [];
        }
        // A park's first edit starts from its playlist views: each remembers which it was (Reset view).
        const first = !this.player.isEdited;
        return this.player.currentViews.map((v, i) => first ? { ...v, origin: i } : { ...v });
    }

    private cameraView(hold: number): View {
        const c = this.camera;
        return {
            x: round2((c.x - TILE / 2) / TILE), y: round2((c.y - TILE / 2) / TILE),
            z: Math.round(c.z), rotation: c.rotation, zoom: c.zoom, hold, manual: true,
        };
    }

    add(): void {
        if (this.map) {
            this.anchor(); // on the map: a new view at the screen's centre, at the selected view's zoom
            this.addAt(this.camera.x, this.camera.y, this.camera.z);
            return;
        }
        this.change(() => {
            this.anchor();
            const views = this.views();
            const at = this.selected >= 0 ? this.selected + 1 : views.length;
            views.splice(at, 0, this.cameraView(views[this.selected]?.hold ?? DEFAULT_HOLD));
            this.save(views, at);
        });
    }

    update(): void {
        if (this.selectedLocked) {
            return;
        }
        if (this.map) {
            // On the map: the selected view moves to the screen's centre (its zoom and angle kept).
            this.anchor();
            const c = this.camera;
            this.mapEdit(this.selected, () => ({
                x: round2((c.x - TILE / 2) / TILE), y: round2((c.y - TILE / 2) / TILE), z: Math.round(c.z),
                rotation: c.rotation,
            }));
            return;
        }
        this.change(() => {
            const views = this.views();
            if (!views[this.selected]) {
                return;
            }
            this.anchor();
            // Keeps how the view pans on and its flags; only where it looks changes.
            views[this.selected] = { ...views[this.selected], ...this.cameraView(views[this.selected].hold) };
            delete views[this.selected].overview; // a framed overview plays as framed
            this.save(views, this.selected);
        });
    }

    remove(): void {
        if (this.selectedLocked) {
            return;
        }
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
        if (this.selectedLocked) {
            return;
        }
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

    /** Moves a view to another place in the list (a row dragged in the editing UI). */
    moveTo(from: number, to: number): void {
        this.change(() => {
            const views = this.views();
            if (!views[from] || to < 0 || to >= views.length || from === to) {
                return;
            }
            const [moved] = views.splice(from, 1);
            views.splice(to, 0, moved);
            this.save(views, to, true);
        });
    }

    /** Whether a view can be dragged or moved: event views only with the lock off. */
    movable(index: number): boolean {
        const v = this.player.currentViews[index];
        return !!v && (!this.isEvent(v) || this.eventsUnlocked);
    }

    isEvent(v: View): boolean {
        return isPinned(v) || v.animation !== undefined;
    }

    /** The selected view is an event view under the lock: nothing changes it (owner, 2026-11-10),
     *  as its timing comes from the park (its clock, a train, a show), not from the list. */
    get selectedLocked(): boolean {
        const v = this.player.currentViews[this.selected];
        return !!v && this.eventsLocked && this.isEvent(v);
    }

    /** The current park's playlist views, as reverting would give them (kept until the park changes). */
    private baseViews(): View[] {
        if (!this.base || this.base.park !== this.player.parkIndex) {
            this.base = { park: this.player.parkIndex, views: this.player.baseViews() };
        }
        return this.base.views;
    }

    /** The selected view's playlist version, if it differs from the view (Reset view). */
    private resetTarget(): View | undefined {
        const v = this.player.currentViews[this.selected];
        if (!v || v.origin === undefined || !this.player.isEdited || this.player.isLoading) {
            return undefined;
        }
        const base = this.baseViews()[v.origin];
        if (!base) {
            return undefined;
        }
        const { origin: _, ...rest } = v;
        return JSON.stringify(rest) === JSON.stringify(base) ? undefined : base;
    }

    get canResetView(): boolean {
        return !this.selectedLocked && this.resetTarget() !== undefined;
    }

    /** Puts the selected view back as the playlist has it (the rest of the list unchanged). */
    resetView(): void {
        const base = this.resetTarget();
        if (!base || this.selectedLocked) {
            return;
        }
        this.change(() => {
            const views = this.views();
            views[this.selected] = { ...base, origin: views[this.selected].origin };
            this.save(views, this.selected);
        });
    }

    // Restore points (the editing UI's top-right box).

    restorePoints(): RestorePoint[] {
        const key = this.player.parkKey;
        if (key === undefined) {
            return [];
        }
        // Newest first, the presets among them by their times (owner, 2026-11-10); none: last.
        const points: RestorePoint[] = [];
        const opened = this.opened.get(key);
        if (opened) {
            points.push({ id: "session", label: "Editor opened", tag: "session", time: opened.time });
        }
        for (const c of [...(this.checkpoints[key] ?? [])].reverse()) {
            points.push({ id: `checkpoint.${c.n}`, label: `Checkpoint ${c.n}`, time: c.time });
        }
        if (this.player.installedHandSet) {
            points.push({ id: "install", label: "Last install", tag: "install", time: this.player.installedAt });
        }
        points.push({ id: "generated", label: "Generated", tag: "build", time: this.player.builtAt });
        return points.map((p, i) => ({ p, i }))
            .sort((a, b) => (b.p.time ?? -Infinity) - (a.p.time ?? -Infinity) || a.i - b.i)
            .map(({ p }) => p);
    }

    /** Saves the current park's views as a checkpoint (at most CHECKPOINTS_PER_PARK, the oldest goes). */
    saveCheckpoint(): void {
        const key = this.player.parkKey;
        if (key === undefined || this.player.isLoading) {
            return;
        }
        const all = this.checkpoints;
        const list = all[key] ?? [];
        const n = list.reduce((m, c) => Math.max(m, c.n), 0) + 1;
        list.push({ n, time: Date.now(), views: this.player.currentViews.map(v => ({ ...v })), screen: [ui.width, ui.height],
            camera: { ...this.camera }, selected: this.selected, onMap: this.map });
        all[key] = list.slice(-CHECKPOINTS_PER_PARK);
        saveCheckpoints(all);
        this.refresh();
    }

    /** Goes back to a restore point; one change, so Undo returns. */
    restoreTo(id: string): void {
        const key = this.player.parkKey;
        if (key === undefined) {
            return;
        }
        this.change(() => {
            if (id === "session") {
                const opened = this.opened.get(key);
                if (opened) {
                    this.restore(opened.snapshot);
                }
            } else if (id === "install") {
                this.player.restoreInstalled();
            } else if (id === "generated") {
                this.player.revertViews();
            } else if (id.startsWith("checkpoint.")) {
                const c = (this.checkpoints[key] ?? []).find(cp => `checkpoint.${cp.n}` === id);
                if (c) {
                    // The views, the selection and the camera as they were (owner, 2026-11-10).
                    const sel = Math.max(0, Math.min(c.views.length - 1, c.selected ?? 0));
                    this.selected = sel;
                    this.player.setViews(c.views.map(v => ({ ...v })), sel, true);
                    // In Frame mode the camera is the selected view, shown by setViews; the map's
                    // camera comes back only on the map.
                    if (c.camera && !!c.onMap === this.map) {
                        this.camera = { ...c.camera };
                        this.applyCamera();
                    }
                    this.selected = sel;
                    this.refresh();
                    return;
                }
            }
            this.selected = this.player.viewIndex;
            this.refresh();
        });
    }

    /** The panes stay shown (the pin); off, they hide with the cursor like the controls bar. */
    get pinned(): boolean {
        return this.player.liveSettings.editorPinned !== false;
    }

    togglePinned(): void {
        const settings = this.player.liveSettings;
        settings.editorPinned = !this.pinned;
        saveSettings(settings);
        this.refresh();
    }

    /** The playback, for the editing UI's park order and Playlist properties. */
    get playback(): Player {
        return this.player;
    }

    /** Where the park's views come from, for the restore points' header. */
    source(): { text: string; warning: boolean } {
        if (this.player.isLoading) {
            return { text: "loading park...", warning: false };
        }
        if (!this.player.canEdit) {
            return { text: "can't edit: re-run --install", warning: true };
        }
        return { text: this.player.isEdited ? "edited · saved in the game" : "playlist views", warning: false };
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
        if (this.selectedLocked) {
            return;
        }
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
        this.noteOpened();
        if (this.map && !this.player.isPreviewing) {
            this.selected = this.player.viewIndex;
            if (this.mapPark !== this.player.parkIndex && view) {
                // Another park: the old camera's spot and angle mean nothing here, so the map steps out
                // from the view shown, at its angle (boxes were drawn at the old angle, owner's test).
                this.cameraFromView(view);
                this.camera.zoom = Math.min(MAX_ZOOM, view.zoom + MAP_OUT);
                this.mapPark = this.player.parkIndex;
            }
            this.applyCamera(); // the map keeps its camera
            return;
        }
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

    /** The engine keeps the view inside the map's scroll limits (on the frame after moveTo), so the
     * view can stop short of the camera's point. The camera follows where the view really went (on the plane at its height);
     * otherwise it runs on past the limit while the picture stays put, and the map's boxes, drawn from
     * the camera, slide off their spots. */
    private followViewport(vp: Viewport): void {
        const l = vp.left, r = vp.right, t = vp.top, b = vp.bottom;
        if (![l, r, t, b].every(Number.isFinite) || r <= l || b <= t) {
            return;
        }
        const c = this.camera;
        const scale = Math.pow(2, vp.zoom);
        if (vp.rotation !== c.rotation || Math.abs((r - l) / scale - ui.width) > 0.25 * ui.width) {
            return; // not yet turned or zoomed to the camera, or not the window's view
        }
        const want = toScreen(c.x, c.y, c.z, c.rotation);
        const got = { x: (l + r) / 2, y: (t + b) / 2 };
        const slack = 4 * Math.pow(2, Math.max(0, c.zoom)); // rounding, and the view's whole pixels
        if (Math.abs(got.x - want.x) <= slack && Math.abs(got.y - want.y) <= slack) {
            return;
        }
        const world = toWorld(got, c.z, c.rotation);
        c.x = world.x;
        c.y = world.y;
    }

    private applyCamera(): void {
        const c = this.camera;
        const vp = ui.mainViewport;
        vp.rotation = c.rotation;
        vp.zoom = c.zoom;
        c.zoom = vp.zoom; // the engine may clamp it
        vp.moveTo({ x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) });
        this.followViewport(vp);
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

    /** The route's views: those that play in their place in the list (fixed animation stops too). */
    routeIndices(): number[] {
        const views = this.player.currentViews;
        return views.map((_, i) => i).filter(i => !isPinned(views[i]));
    }

    /** The event views (cut-ins on the park's clock, car cues, shows, cued animations), apart from
     *  the route as their timing comes from the park (owner, 2026-11-10), in the order they play:
     *  cut-ins at their tick, the rest after the route, as listed. */
    eventIndices(): number[] {
        const views = this.player.currentViews;
        const routeTicks = this.routeIndices().reduce((t, i) => t + views[i].hold * TICKS_PER_SECOND, 0);
        const at = (i: number): number => {
            const cue = views[i].cue;
            return isCut(views[i]) ? cue!.tick! - (cue!.lead ?? 0) * TICKS_PER_SECOND : routeTicks + i / 1000;
        };
        return views.map((_, i) => i).filter(i => isPinned(views[i])).sort((a, b) => at(a) - at(b));
    }

    /** A view's number as listed: 1, 2, ... on the route, E1, E2, ... for event views. */
    labelOf(index: number): string {
        const route = this.routeIndices().indexOf(index);
        return route >= 0 ? String(route + 1) : `E${this.eventIndices().indexOf(index) + 1}`;
    }

    /** The event list's rows: number, kind, name, trigger, hold and when it plays. */
    eventRows(): string[][] {
        const views = this.player.currentViews;
        const route = this.routeIndices();
        const after = route.length ? `after view ${route.length}` : "after the route";
        const now = this.player.parkClock;
        return this.eventIndices().map((i, k) => {
            const v = views[i];
            const cue = v.cue;
            let kind = "animation";
            let trigger = "runs on its own";
            let plays = after;
            if (cue && cue.tick !== undefined) {
                kind = "clock";
                // The effect's time; the cut comes its lead earlier, which "Plays" counts down to.
                trigger = `at ${clock(cue.tick)}` + (cue.every ? `, every ${clock(cue.every)}` : "");
                if (cue.cut) {
                    const start = cue.tick - (cue.lead ?? 0) * TICKS_PER_SECOND;
                    let next = start;
                    if (cue.every && next < now) {
                        next += Math.ceil((now - next) / cue.every) * cue.every;
                    }
                    plays = this.player.cutPlayed(i) && !cue.every ? "played" : next <= now ? "now" : `in ${clock(next - now)}`;
                }
            } else if (cue) {
                kind = "train";
                trigger = (cue.ride !== undefined ? `a car of ride ${cue.ride}` : "listed cars") + (cue.tiles ? " on its tiles" : "");
            } else if (v.show) {
                kind = "show";
                trigger = `show "${v.show.name}"`;
            }
            return [`E${k + 1}`, kind, v.animation ?? v.show?.name ?? "", trigger, `${v.hold} s`, plays];
        });
    }

    /** Moves the selected route view past its neighbor on the route (Ctrl+Up, Ctrl+Down), over any
     *  event views between them, as those play by their own timing. */
    moveOnRoute(delta: number): void {
        const route = this.routeIndices();
        const pos = route.indexOf(this.selected);
        const to = route[pos + delta];
        if (pos < 0 || to === undefined) {
            return;
        }
        this.moveTo(this.selected, to);
    }

    rows(): EditorRow[] {
        const route = this.routeIndices();
        const events = this.eventIndices();
        const label = (i: number): string => route.includes(i) ? String(route.indexOf(i) + 1) : `E${events.indexOf(i) + 1}`;
        return this.player.currentViews.map((v, i) => [label(i), `${Math.round(v.x)}, ${Math.round(v.y)}`,
            String(v.rotation), String(v.zoom), `${v.hold} s`,
            `${Math.round(this.player.panOf(v) * 100)}%`,
            v.manual ? "you" : v.cue || v.animation !== undefined || v.show ? "event" : "auto"]);
    }

    holdText(): string {
        const view = this.player.currentViews[this.selected];
        return view ? `Hold view ${this.labelOf(this.selected)}: ${view.hold} s` : "Hold: select a view";
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
