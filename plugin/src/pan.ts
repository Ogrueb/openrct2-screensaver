// Panning views: a view with a `pan` share spends the end of its hold panning to the next view,
// arriving as that view's hold starts (0, the default, holds still and cuts). OpenRCT2 can only
// change angle and zoom in steps, so they never change mid-pan, only at its ends: a single step
// at the end `changes` names ("end": the camera travels as the view it leaves and changes on
// arrival; "start": it changes as it sets off), and a two-step change (opposite angles, zooms two
// or more levels apart) split between the two ends. After a change at the start the camera stays
// still for a moment (`lead`) before it moves, and before a change on arrival it rests a moment
// (`rest`) at the next view's spot, so no angle or zoom is on screen only in passing.
// A pan too fast for the speed tolerance at the zoom it runs at travels further out: between views
// at the same zoom one level out (out as it sets off, back in on arrival), between zooms at most at
// the wider one.
// A park's return pan, from its last view back to a wider first view (`stepOut`), zooms out as it
// goes (owner, 2026-10-28): one zoom level out as it sets off (moving at once, no lead), the
// further levels mid-pan, each
// level held for an equal share of the move at one screen speed (so the camera covers ground
// faster the further out it is); any turn comes on arrival, after the rest (owner).

import { toScreen } from "./fit";

const MAX_ZOOM = 3;
const MIN_PAN_MS = 500; // shorter than this: cut instead

/** Where the camera is: the world point at the screen centre, the angle and the zoom level. */
export interface Pose {
    x: number;
    y: number;
    z: number;
    rotation: number;
    zoom: number;
}

export type PanChanges = "start" | "end";

/** Fastest legible pan at a zoom level, screen px/s: `base` at zoom -2, `step` less per level out,
 * never under one step (owner, 2026-10-28; mksequence.py pan_tolerance). */
export function panTolerance(zoom: number, base = 500, step = 100): number {
    return Math.max(step, base - step * (zoom + 2));
}

export class Pan {
    private readonly travel: { rotation: number; zoom: number };
    /** The camera turns or zooms as the pan sets off, or on arrival. */
    readonly changesAtStart: boolean;
    readonly changesAtEnd: boolean;
    /** ms the camera stays still after a change at the start, before it moves */
    readonly lead: number;
    /** ms the camera rests at the next view's spot before a change on arrival */
    readonly rest: number;
    /** average screen pixels a second while moving, at the travel zoom */
    readonly speed: number;
    /** Return pan: the zoom levels it runs at, in order (one entry for any other pan). */
    readonly levels: number[];
    /** Share of the distance covered by the end of each level (levels.length entries, last 1). */
    private readonly reach: number[];

    /**
     * A pan from `from` to `to`, moving for `moveMs`. A pan faster on average than `tolerance` at
     * the zoom it runs at (screen px/s) travels zoomed out, a level at a time while it is still
     * too fast there, where that is allowed (one level between views at one zoom, up to the wider
     * view's zoom between zooms). It is not a speed cap: the move keeps its time (generation
     * stretches pans that are too fast). With `inertia`
     * it starts and stops slowly (cubic ease, top speed 3 times the average); without, it moves
     * at one speed. After a change at the start it waits `changeHold` ms before moving; before a
     * change on arrival it rests `arriveHold` ms. With `stepOut`, a pan to a wider view zooms out
     * as it goes (see the top of this file); `speed` is then its one screen speed.
     */
    constructor(private readonly from: Pose, private readonly to: Pose, private readonly moveMs: number,
        tolerance: (zoom: number) => number, changes: PanChanges, private readonly inertia: boolean, changeHold: number,
        arriveHold: number, stepOut = false) {
        if (stepOut && to.zoom > from.zoom) {
            const start = toScreen(from.x, from.y, from.z, from.rotation);
            const end = toScreen(to.x, to.y, to.z, from.rotation);
            const levels = range(from.zoom + 1, to.zoom);
            // Equal time at each level and one screen speed: the distance at a level is 2^zoom.
            const weights = levels.map(z => 2 ** z);
            const total = weights.reduce((s, w) => s + w, 0);
            let sum = 0;
            this.levels = levels;
            this.reach = weights.map(w => (sum += w) / total);
            this.travel = { rotation: from.rotation, zoom: levels[0] };
            const distance = Math.hypot(end.x - start.x, end.y - start.y);
            this.speed = distance / (total * moveMs / levels.length) * 1000;
            this.changesAtStart = true;
            this.changesAtEnd = from.rotation !== to.rotation;
            this.lead = 0;
            this.rest = this.changesAtEnd ? arriveHold : 0;
            return;
        }
        // Angle: one step at the chosen end; opposite angles turn one step at each end.
        const turn = (to.rotation - from.rotation + 4) % 4;
        const turnFirst = turn === 2 ? 1 : changes === "start" ? (turn === 3 ? -1 : turn) : 0;
        const rotation = (from.rotation + turnFirst + 4) % 4;
        // Zoom: one level at the chosen end; more is split, the larger half at the chosen end.
        const dz = to.zoom - from.zoom;
        const zoomFirst = Math.abs(dz) <= 1 ? (changes === "start" ? dz : 0)
            : changes === "start" ? dz - Math.trunc(dz / 2) : Math.trunc(dz / 2);
        let zoom = from.zoom + zoomFirst;
        // Screen speed at zoom z is distance / 2^z / time. Too fast for the tolerance at the zoom
        // the pan runs at: out a level at a time, one level at most between views at one zoom
        // (owner), never past the wider view between zooms. Still too fast there: it moves faster.
        const a = toScreen(from.x, from.y, from.z, rotation);
        const b = toScreen(to.x, to.y, to.z, rotation);
        const distance = Math.hypot(b.x - a.x, b.y - a.y); // zoom-0 pixels
        const speedAt = (z: number) => distance / 2 ** z * 1000 / Math.max(1, moveMs);
        const widest = dz === 0 ? Math.min(MAX_ZOOM, from.zoom + 1) : Math.max(from.zoom, to.zoom);
        while (zoom < widest && speedAt(zoom) > tolerance(zoom)) {
            zoom++;
        }
        this.travel = { rotation, zoom };
        this.levels = [zoom];
        this.reach = [1];
        this.speed = speedAt(zoom);
        this.changesAtStart = rotation !== from.rotation || zoom !== from.zoom;
        this.changesAtEnd = rotation !== to.rotation || zoom !== to.zoom;
        this.lead = this.changesAtStart ? changeHold : 0;
        this.rest = this.changesAtEnd ? arriveHold : 0;
    }

    /** ms from setting off to the next view: the lead after a change at the start, the move, and
     * the rest before a change on arrival. */
    get duration(): number {
        return this.lead + this.moveMs + this.rest;
    }

    /** False when the pan is too short to see or goes nowhere: the view change cuts. */
    get worthwhile(): boolean {
        const f = this.from;
        const t = this.to;
        return this.moveMs >= MIN_PAN_MS && Math.hypot(t.x - f.x, t.y - f.y, t.z - f.z) >= 16;
    }

    /** The widest zoom the pan runs at (its speed is checked against the tolerance there). */
    get widestZoom(): number {
        return this.levels[this.levels.length - 1];
    }

    /** The travel angle and zoom as it sets off (for tests and the debug log). */
    get travelling(): { rotation: number; zoom: number } {
        return { ...this.travel };
    }

    /** The camera `ms` after the pan set off; the next view exactly once it is over. */
    at(ms: number): Pose {
        if (ms >= this.duration) {
            return { ...this.to };
        }
        let t = Math.min(1, Math.max(0, ms - this.lead) / this.moveMs);
        t = this.inertia ? cubic(t) : t;
        // The level the camera is at, and how far along the distance that puts it.
        const n = this.levels.length;
        const level = Math.min(n - 1, Math.floor(t * n));
        const before = level > 0 ? this.reach[level - 1] : 0;
        const u = before + (this.reach[level] - before) * (t * n - level);
        const f = this.from;
        return {
            x: f.x + (this.to.x - f.x) * u,
            y: f.y + (this.to.y - f.y) * u,
            z: f.z + (this.to.z - f.z) * u,
            rotation: this.travel.rotation,
            zoom: this.levels[level],
        };
    }
}

/** a, a + 1, ..., b */
function range(a: number, b: number): number[] {
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** Inertia: cubic ease in and out, starting and stopping slowly; top speed 3 times the average. */
function cubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - 4 * (1 - t) * (1 - t) * (1 - t);
}
