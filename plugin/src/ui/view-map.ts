// The view editor's map (docs/screensaver-ui.md, "The map"): with the camera stepped out, every view of
// the park is drawn on the overlay as the box its window covers at its zoom, projected through the
// camera; views at another angle are numbered markers at their spot. Pan lines run from each view to the
// next (dense dots for a pan, sparse ones for a cut, as on the renders). The mouse on the park: drag a box
// to move its view (on the plane at its height), drag the selected box's corner to change its zoom by
// whole levels, drag empty park to pan, the wheel zooms the camera, a right click on empty park adds a
// view there, a double click on a box frames it. Event views are locked unless the panel unlocks them.

import type { Camera, Editor } from "../editor";
import { surfaceZ } from "../editor";
import { toScreen, toWorld } from "../fit";
import type { MouseEvent, Overlay } from "../mode";
import { View, isPinned } from "../storage";
import { Layer, Rect, Scene, contains, measure } from "./kit";

const TILE = 32;
const MIN_ZOOM = -2;
const MAX_ZOOM = 3;
const HANDLE = 14; // the zoom handle's side, game pixels
const MARKER = 26; // an other-angle marker's side
const DOUBLE_CLICK_MS = 400;
const CLICK_SLOP = 4; // pixels a press may move and still count as a click
const DOT = 3; // a pan line's dot
const PAN_GAP = 8; // pixels between dots: a pan
const CUT_GAP = 20; // and a cut
const MAX_DOTS = 80; // per line; a longer line spaces them out
const TEXT_SIZE = 14;
const EDGE = 24; // the band along a large box's edge that holds it

// Colours (the drawing page's: generated views neutral, hand-set in blue, events in amber, the
// selected one orange; pans yellow, cuts cyan as on the renders).
export const MAP_COLOURS = {
    generated: "#ce93d8",
    manual: "#4fc3f7",
    event: "#ffb000",
    selected: "#ff6a1a",
    pan: "#ffd54fe0",
    cut: "#4dd0e1c0",
    labelBacking: "#000000b0",
    text: "#ffffff",
};

const Z_LINE = 40; // under the panel and bar (100+), over nothing else while the editor is open
const Z_BOX = 42;
const Z_LABEL = 44;

/** Where a view shows on the map: its centre and its box, in window pixels. */
interface Placed {
    index: number;
    view: View;
    cx: number;
    cy: number;
    box?: Rect; // at the camera's angle
    marker?: Rect; // at another angle
}

type Drag =
    | { kind: "box"; index: number; x0: number; y0: number; x: number; y: number; moved: boolean }
    | { kind: "handle"; index: number; zoom: number }
    | { kind: "pan"; x: number; y: number }
    | { kind: "right"; x0: number; y0: number; moved: boolean };

export function isEvent(view: View): boolean {
    return view.cue !== undefined || view.animation !== undefined || view.show !== undefined;
}

/** A view's centre on the screen (zoom 0 screen units) at the camera's angle. */
function screenOf(view: View, rotation: number): { x: number; y: number } {
    return toScreen(view.x * TILE + TILE / 2, view.y * TILE + TILE / 2, view.z, rotation);
}

export class ViewMap {
    private readonly layer: Layer;
    private placed: Placed[] = [];
    private drag: Drag | undefined;
    private lastDown = { time: -Infinity, x: 0, y: 0, index: -1 };

    constructor(private readonly overlay: Overlay, private readonly now: () => number = () => Date.now()) {
        this.layer = new Layer(overlay, "rcts.map.");
    }

    get dragging(): boolean {
        return this.drag !== undefined;
    }

    clear(): void {
        this.drag = undefined;
        this.placed = [];
        this.layer.clear();
    }

    /** Window pixels of a screen point (zoom 0 units) through the camera. */
    private toWindow(p: { x: number; y: number }, cam: Camera): { x: number; y: number } {
        const c = toScreen(cam.x, cam.y, cam.z, cam.rotation);
        const k = Math.pow(2, -cam.zoom);
        return { x: ui.width / 2 + (p.x - c.x) * k, y: ui.height / 2 + (p.y - c.y) * k };
    }

    /** The screen point (zoom 0 units) under a window pixel. */
    private fromWindow(x: number, y: number, cam: Camera): { x: number; y: number } {
        const c = toScreen(cam.x, cam.y, cam.z, cam.rotation);
        const k = Math.pow(2, cam.zoom);
        return { x: c.x + (x - ui.width / 2) * k, y: c.y + (y - ui.height / 2) * k };
    }

    /** The view as the drag in progress shows it (moved or zoomed, not saved yet). */
    private shownView(index: number, view: View, cam: Camera): View {
        const d = this.drag;
        if (d?.kind === "box" && d.index === index && d.moved) {
            const s = screenOf(view, cam.rotation);
            const k = Math.pow(2, cam.zoom);
            const w = toWorld({ x: s.x + (d.x - d.x0) * k, y: s.y + (d.y - d.y0) * k }, view.z, cam.rotation);
            return { ...view, x: (w.x - TILE / 2) / TILE, y: (w.y - TILE / 2) / TILE };
        }
        if (d?.kind === "handle" && d.index === index) {
            return { ...view, zoom: d.zoom };
        }
        return view;
    }

    private place(editor: Editor): void {
        const cam = editor.cameraPose;
        this.placed = editor.currentViews.map((original, index) => {
            const view = this.shownView(index, original, cam);
            const c = this.toWindow(screenOf(view, cam.rotation), cam);
            if (view.rotation === cam.rotation) {
                const k = Math.pow(2, view.zoom - cam.zoom);
                const w = ui.width * k;
                const h = ui.height * k;
                return { index, view, cx: c.x, cy: c.y, box: { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h } };
            }
            const mw = isPinned(view) ? MARKER + 12 : MARKER; // wider for an event's "E1"
            return { index, view, cx: c.x, cy: c.y, marker: { x: c.x - mw / 2, y: c.y - MARKER / 2, width: mw, height: MARKER } };
        });
    }

    /** The selected box's zoom handle (bottom right corner), if it can be dragged. */
    private handleOf(editor: Editor): Rect | undefined {
        const p = this.placed[editor.selectedIndex];
        if (!p?.box || (isEvent(p.view) && editor.eventsLocked)) {
            return undefined;
        }
        const b = p.box;
        return { x: b.x + b.width - HANDLE / 2, y: b.y + b.height - HANDLE / 2, width: HANDLE, height: HANDLE };
    }

    /** The view under a window pixel: markers first, then the selected box, then the others (the
     * later ones on top). A large box counts only near its edge, so a press inside it still pans. */
    private hit(editor: Editor, x: number, y: number): number | undefined {
        for (const p of this.placed) {
            if (p.marker && contains(p.marker, x, y)) {
                return p.index;
            }
        }
        const order = [...this.placed].reverse();
        const sel = this.placed[editor.selectedIndex];
        if (sel) {
            order.unshift(sel);
        }
        for (const p of order) {
            if (p.box && contains(p.box, x, y)) {
                // A box wider than half the window (an overview) is held by its edge only.
                const big = p.box.width > ui.width / 2 || p.box.height > ui.height / 2;
                const inner = { x: p.box.x + EDGE, y: p.box.y + EDGE, width: p.box.width - 2 * EDGE, height: p.box.height - 2 * EDGE };
                if (!big || !contains(inner, x, y)) {
                    return p.index;
                }
            }
        }
        return undefined;
    }

    /** A mouse event on the park while the map is on; true when it was the map's. */
    onMouse(e: MouseEvent, editor: Editor): boolean {
        this.place(editor);
        const d = this.drag;
        if (e.type === "wheel") {
            editor.zoomCamera(e.delta);
            return true;
        }
        if (e.type === "down" && e.button === 0) {
            const handle = this.handleOf(editor);
            if (handle && contains(handle, e.x, e.y, 4)) {
                const view = editor.currentViews[editor.selectedIndex];
                this.drag = { kind: "handle", index: editor.selectedIndex, zoom: view.zoom };
                return true;
            }
            const index = this.hit(editor, e.x, e.y);
            if (index === undefined) {
                this.drag = { kind: "pan", x: e.x, y: e.y };
                return true;
            }
            const last = this.lastDown;
            const double = index === last.index && this.now() - last.time < DOUBLE_CLICK_MS &&
                Math.abs(e.x - last.x) <= CLICK_SLOP && Math.abs(e.y - last.y) <= CLICK_SLOP;
            this.lastDown = { time: this.now(), x: e.x, y: e.y, index };
            if (double) {
                this.lastDown.time = -Infinity;
                editor.frame(index);
                return true;
            }
            editor.pick(index);
            const view = editor.currentViews[index];
            if (!(isEvent(view) && editor.eventsLocked)) {
                this.drag = { kind: "box", index, x0: e.x, y0: e.y, x: e.x, y: e.y, moved: false };
            }
            return true;
        }
        if (e.type === "down" && e.button === 1) {
            this.drag = { kind: "right", x0: e.x, y0: e.y, moved: false };
            return true;
        }
        if (e.type === "move" && d) {
            if (d.kind === "pan") {
                editor.panBy(d.x - e.x, d.y - e.y);
                d.x = e.x;
                d.y = e.y;
            } else if (d.kind === "box") {
                d.x = e.x;
                d.y = e.y;
                d.moved = d.moved || Math.abs(e.x - d.x0) > CLICK_SLOP || Math.abs(e.y - d.y0) > CLICK_SLOP;
                this.render(editor);
            } else if (d.kind === "handle") {
                const p = this.placed[d.index];
                const view = editor.currentViews[d.index];
                if (p && view) {
                    // The box snaps to the zoom whose size is nearest to where the corner is dragged.
                    const half = { w: ui.width * Math.pow(2, view.zoom - editor.cameraPose.zoom) / 2,
                        h: ui.height * Math.pow(2, view.zoom - editor.cameraPose.zoom) / 2 };
                    const ratio = Math.max(Math.abs(e.x - p.cx) / half.w, Math.abs(e.y - p.cy) / half.h, 1e-3);
                    d.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom + Math.round(Math.log2(ratio))));
                    this.render(editor);
                }
            } else if (d.kind === "right") {
                d.moved = d.moved || Math.abs(e.x - d.x0) > CLICK_SLOP || Math.abs(e.y - d.y0) > CLICK_SLOP;
            }
            return true;
        }
        if (e.type === "up" && d) {
            const shown = d.kind === "box" ? this.shownView(d.index, editor.currentViews[d.index], editor.cameraPose) : undefined;
            this.drag = undefined;
            if (d.kind === "box" && d.moved && e.button === 0 && shown) {
                editor.moveView(d.index, shown.x, shown.y);
            } else if (d.kind === "handle" && e.button === 0) {
                if (d.zoom !== editor.currentViews[d.index]?.zoom) {
                    editor.zoomView(d.index, d.zoom);
                }
            } else if (d.kind === "right" && e.button === 1 && !d.moved) {
                const index = this.hit(editor, e.x, e.y);
                if (index !== undefined) {
                    editor.pick(index);
                } else {
                    const cam = editor.cameraPose;
                    const p = this.fromWindow(e.x, e.y, cam);
                    const z = surfaceZ(p, cam.rotation) ?? cam.z;
                    const w = toWorld(p, z, cam.rotation);
                    editor.addAt(w.x, w.y, z);
                }
            }
            this.render(editor);
            return true;
        }
        return false;
    }

    render(editor: Editor): void {
        if (editor.playback.isLoading) {
            this.clear(); // the views are already the next park's: nothing until it shows
            return;
        }
        this.place(editor);
        const scene: Scene = new Map();
        const views = this.placed;
        // Pan lines along the route: each view to the next, the last back to the first. Event views
        // play on the park's timing, so no line leads to them.
        const route = new Set(editor.routeIndices());
        const stops = views.filter(p => route.has(p.index));
        if (stops.length > 1) {
            stops.forEach((p, i) => {
                const q = stops[(i + 1) % stops.length];
                this.line(scene, `line.${i}`, p.cx, p.cy, q.cx, q.cy, editor.pans(editor.currentViews[p.index]));
            });
        }
        const labels = editor.rows().map(r => r[0]); // 1, 2, ... on the route, E1, E2, ... for events
        const sel = editor.selectedIndex;
        for (const p of views) {
            const event = isEvent(p.view);
            const colour = p.index === sel ? MAP_COLOURS.selected
                : event ? MAP_COLOURS.event : p.view.manual ? MAP_COLOURS.manual : MAP_COLOURS.generated;
            const text = `${labels[p.index]}${event ? (editor.eventsLocked ? " event (locked)" : " event") : ""}`;
            if (p.box) {
                const width = p.index === sel ? 3 : 2;
                scene.set(`box.${p.index}`, {
                    type: "rect", ...round(p.box), fill: "#00000000", border: colour, borderWidth: width, z: Z_BOX + (p.index === sel ? 1 : 0),
                });
                this.tag(scene, `tag.${p.index}`, text, p.box.x + width, p.box.y + width, colour);
            } else if (p.marker) {
                scene.set(`mark.${p.index}`, {
                    type: "rect", ...round(p.marker), fill: MAP_COLOURS.labelBacking, border: colour, borderWidth: 2, z: Z_BOX,
                });
                scene.set(`mark.${p.index}.text`, {
                    type: "text", text: labels[p.index], size: TEXT_SIZE, bold: true, colour: MAP_COLOURS.text,
                    x: Math.round(p.cx), y: Math.round(p.cy - TEXT_SIZE * 0.65), align: "center", z: Z_LABEL,
                });
            }
        }
        const handle = this.handleOf(editor);
        if (handle) {
            scene.set("handle", { type: "rect", ...round(handle), fill: MAP_COLOURS.selected, border: "#000000", borderWidth: 1, z: Z_LABEL });
        }
        this.layer.render(scene);
        this.layer.show(true, 0);
    }

    /** A number tag at a box's top left corner. */
    private tag(scene: Scene, id: string, text: string, x: number, y: number, colour: string): void {
        const m = measure(this.overlay, text, TEXT_SIZE, true);
        scene.set(id, { type: "rect", x: Math.round(x), y: Math.round(y), width: Math.ceil(m.width) + 10, height: Math.ceil(m.height) + 4,
            fill: MAP_COLOURS.labelBacking, z: Z_LABEL });
        scene.set(`${id}.text`, { type: "text", text, size: TEXT_SIZE, bold: true, colour, x: Math.round(x) + 5, y: Math.round(y) + 2, z: Z_LABEL + 1 });
    }

    /** A dotted line between two window points, clipped to the window: dense for a pan, sparse for a cut. */
    private line(scene: Scene, id: string, x0: number, y0: number, x1: number, y1: number, pan: boolean): void {
        const clipped = clip(x0, y0, x1, y1, ui.width, ui.height);
        if (!clipped) {
            return;
        }
        const [ax, ay, bx, by] = clipped;
        const length = Math.hypot(bx - ax, by - ay);
        const gap = Math.max(pan ? PAN_GAP : CUT_GAP, length / MAX_DOTS);
        const n = Math.floor(length / gap);
        for (let i = 0; i <= n; i++) {
            const t = n === 0 ? 0 : i / n;
            scene.set(`${id}.${i}`, {
                type: "rect", x: Math.round(ax + (bx - ax) * t - DOT / 2), y: Math.round(ay + (by - ay) * t - DOT / 2),
                width: DOT, height: DOT, fill: pan ? MAP_COLOURS.pan : MAP_COLOURS.cut, z: Z_LINE,
            });
        }
    }
}

function round(r: Rect): Rect {
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

/** A segment clipped to [0, w] x [0, h] (Liang-Barsky), or undefined if it misses. */
export function clip(x0: number, y0: number, x1: number, y1: number, w: number, h: number): [number, number, number, number] | undefined {
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const edges: [number, number][] = [[-dx, x0], [dx, w - x0], [-dy, y0], [dy, h - y0]];
    for (const [p, q] of edges) {
        if (p === 0) {
            if (q < 0) {
                return undefined;
            }
        } else {
            const r = q / p;
            if (p < 0) {
                t0 = Math.max(t0, r);
            } else {
                t1 = Math.min(t1, r);
            }
        }
    }
    return t0 <= t1 ? [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy] : undefined;
}
