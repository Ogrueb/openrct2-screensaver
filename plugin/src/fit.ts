// Keeps views on a park's content: a view whose screen would reach past the content is moved
// back inwards, and a park whose content fits on one screen gets a single centred view.
// Works in screen space (zoom 0 pixels), so it follows the window size, zoom and rotation,
// and counts the content's height: tall builds reach further up the screen.

import { Bounds, View } from "./storage";

const TILE = 32; // world units per tile
const MIN_SEPARATION = 0.25; // views closer than this fraction of a screen are merged
const MIN_ZOOM = -2; // OpenRCT2's ZoomLevel::min
const MAX_ZOOM = 3;
const OVERVIEW_FILL = 0.95; // an overview leaves a small margin around the content

interface Point {
    x: number;
    y: number;
}

/** World coordinates to screen coordinates, as OpenRCT2 projects them. */
export function toScreen(x: number, y: number, z: number, rotation: number): Point {
    // Rotate into the rotation-0 frame, then project: screen x = b - a, screen y = (a + b) / 2 - z.
    const [a, b] = [[x, y], [y, -x], [-x, -y], [-y, x]][rotation & 3];
    return { x: b - a, y: (a + b) / 2 - z };
}

/** Screen coordinates back to world (x, y) on the plane at height z. */
export function toWorld(p: Point, z: number, rotation: number): Point {
    const a = p.y + z - p.x / 2;
    const b = p.y + z + p.x / 2;
    const [x, y] = [[a, b], [-b, a], [-a, -b], [b, -a]][rotation & 3];
    return { x, y };
}

/** Moves `centre` along one axis as little as needed for a screen of `size` to show all of
 * [lo, hi] if it can, or else to show only that range. */
function frameAxis(centre: number, size: number, lo: number, hi: number): number {
    return hi - lo <= size
        ? Math.min(lo + size / 2, Math.max(hi - size / 2, centre))
        : Math.min(hi - size / 2, Math.max(lo + size / 2, centre));
}

/** Moves `centre` along one axis so a screen of `size` stays within [lo, hi], or centres it. */
function clampAxis(centre: number, size: number, lo: number, hi: number): number {
    if (hi - lo <= size) {
        return (lo + hi) / 2;
    }
    return Math.min(hi - size / 2, Math.max(lo + size / 2, centre));
}

export interface Extent {
    xlo: number;
    xhi: number;
    ylo: number;
    yhi: number;
    z?: number; // a typical world height of the content, to anchor views at
    cx?: number; // screen point where the content is on average (absent: the extent's middle)
    cy?: number;
}

/** Measures the content's screen-space extent at a rotation, or undefined if it can't. */
export type Measure = (rotation: number) => Extent | undefined;

/** Screen-space extent of the content box at `rotation`; heights default to `z` if unknown. */
function extentOf(bounds: Bounds, rotation: number, z: number): Extent {
    const corners: Point[] = [];
    for (const h of [bounds.z0 ?? z, bounds.z1 ?? z]) {
        for (const [x, y] of [[bounds.x0, bounds.y0], [bounds.x1 + 1, bounds.y0],
            [bounds.x0, bounds.y1 + 1], [bounds.x1 + 1, bounds.y1 + 1]]) {
            corners.push(toScreen(x * TILE, y * TILE, h, rotation));
        }
    }
    const xs = corners.map(c => c.x);
    const ys = corners.map(c => c.y);
    return { xlo: Math.min(...xs), xhi: Math.max(...xs), ylo: Math.min(...ys), yhi: Math.max(...ys) };
}

/** The view looking at screen point `p`, on the plane at the view's height. */
function viewAt(view: View, p: Point): View {
    const world = toWorld(p, view.z, view.rotation);
    return { ...view, x: (world.x - TILE / 2) / TILE, y: (world.y - TILE / 2) / TILE };
}

/** The content's screen extent at a rotation: measured from the loaded park, else the box. */
function contentExtent(bounds: Bounds, rotation: number, z: number, measure?: Measure): Extent {
    const measured = measure?.(rotation);
    if (measured) {
        return measured;
    }
    const zm = bounds.zm ?? ((bounds.z0 ?? z) + (bounds.z1 ?? z)) / 2;
    const centre = bounds.cx !== undefined && bounds.cy !== undefined
        ? toScreen(bounds.cx * TILE, bounds.cy * TILE, zm, rotation) : undefined;
    return { ...extentOf(bounds, rotation, z), z: zm, cx: centre?.x, cy: centre?.y };
}

/** The view looking at screen point (x, y) on the plane at height z. */
function lookAt(base: View, x: number, y: number, z: number, rotation: number): View {
    const world = toWorld({ x, y }, z, rotation);
    return { ...base, rotation, x: (world.x - TILE / 2) / TILE, y: (world.y - TILE / 2) / TILE, z };
}

/** The closest zoom at which an extent fits the window (with a small margin), or the widest. */
function fitZoom(e: Extent, screen: { width: number; height: number }): number {
    let zoom = MIN_ZOOM;
    while (zoom < MAX_ZOOM && (e.xhi - e.xlo > screen.width * Math.pow(2, zoom) * OVERVIEW_FILL ||
        e.yhi - e.ylo > screen.height * Math.pow(2, zoom) * OVERVIEW_FILL)) {
        zoom++;
    }
    return zoom;
}

/** An overview: the closest zoom where the whole content fits the window, centred as near to
 * where the content is on average as keeps all of it on screen (so a single tall tower doesn't
 * pull the view up). A small park, whose footprint fits at zoom 0 or closer, is shown no wider
 * than zoom 0 so a tall build on it is not seen from far away; `wide` is that zoom 0 in the
 * window's levels (scale.ts: 1 in a 1080p window for views framed at 4K). */
function fitOverview(view: View, bounds: Bounds, screen: { width: number; height: number },
    measure?: Measure, wide = 0): View {
    const e = contentExtent(bounds, view.rotation, view.z, measure);
    const flat = extentOf({ ...bounds, z1: bounds.z0 }, view.rotation, view.z);
    const zoom = fitZoom(flat, screen) <= wide ? Math.min(fitZoom(e, screen), wide) : fitZoom(e, screen);
    const scale = Math.pow(2, zoom);
    const x = frameAxis(e.cx ?? (e.xlo + e.xhi) / 2, screen.width * scale * OVERVIEW_FILL, e.xlo, e.xhi);
    const y = frameAxis(e.cy ?? (e.ylo + e.yhi) / 2, screen.height * scale * OVERVIEW_FILL, e.ylo, e.yhi);
    return { ...lookAt(view, x, y, Math.round(e.z ?? view.z), view.rotation), zoom };
}

/**
 * Returns the views to show for a park. `screen` is the window size in pixels and `budget` the
 * number of views the park should get. An overview view is zoomed to show all the content.
 * Every other view keeps its zoom and height, so the moved centre is exact on the plane at that
 * height; views that end up on (nearly) the same spot are merged, keeping the first. When that
 * leaves fewer views than the budget and the content is no wider than the screen, the rest of
 * the budget is spent on the content itself instead: one centred view per angle, or for
 * content taller than the screen, views spread from bottom to top while the angle keeps turning.
 * `zoomOffset` is the levels the views were moved out for the window (scale.ts): zoom 0, the
 * widest a small park is shown at, moves with them.
 */
export function fitViews(views: View[], bounds: Bounds, screen: { width: number; height: number },
    budget = views.length, measure?: Measure, zoomOffset = 0): View[] {
    const overview = views.find(v => v.overview);
    const others = views.filter(v => !v.overview);
    const head = overview ? [fitOverview(overview, bounds, screen, measure, zoomOffset)] : [];
    const fitted = [...head, ...clampViews(others, bounds, screen, head[0]?.rotation)];
    if (fitted.length >= budget || views.length === 0) {
        return fitted;
    }
    // The park's own first close-up: a route stop on an animation (Sambhava's mist at zoom 2)
    // turned the whole park into turns of one zoom-2 view (2026-10-30).
    const first = others.find(v => v.animation === undefined && !v.fixed) ?? others[0] ?? head[0];
    const count = budget - head.length;
    const result: View[] = [];
    for (let k = 0; k < count; k++) {
        // After an overview, start at the next angle so the first view differs from it.
        const rotation = ((overview ?? first).rotation + k + head.length) % 4;
        const e = contentExtent(bounds, rotation, first.z, measure);
        // Zoomed out from the first view's zoom as far as the content's width needs.
        let zoom = first.zoom;
        while (zoom < MAX_ZOOM && e.xhi - e.xlo > screen.width * Math.pow(2, zoom)) {
            zoom++;
        }
        if (e.xhi - e.xlo > screen.width * Math.pow(2, zoom) || zoom > Math.max(zoomOffset, first.zoom)) {
            return fitted; // a large park: keep the views as fitted
        }
        const base = { ...first, zoom };
        const width = screen.width * Math.pow(2, zoom);
        const height = screen.height * Math.pow(2, zoom);
        // Screens needed to cover the height, at most one per view; spread views over them.
        const rows = Math.min(count, Math.max(1, Math.ceil((e.yhi - e.ylo) / height)));
        const row = k % rows;
        const y = rows === 1 ? (e.ylo + e.yhi) / 2
            : e.yhi - height / 2 - row * (e.yhi - e.ylo - height) / (rows - 1);
        // Look at the middle of the extent, on the plane at the content's typical height.
        result.push(lookAt(base, (e.xlo + e.xhi) / 2, y, Math.round(e.z ?? base.z), rotation));
    }
    return [...head, ...result, ...fitted.filter(v => v.animation !== undefined)]; // route stops stay
}

/**
 * Moves views back onto the content and merges near-duplicates: views at the same angle whose
 * centres are within MIN_SEPARATION of the smaller one's screen, whatever their zoom (a `fixed`
 * view stays as placed and is never the one merged away). With
 * `overviewRotation`, a view from that angle whose screen would show the whole content is
 * dropped as well, since the overview already shows it.
 */
function clampViews(views: View[], bounds: Bounds, screen: { width: number; height: number },
    overviewRotation?: number): View[] {
    const result: View[] = [];
    const centres: (Point & { width: number; height: number })[] = [];
    for (const view of views) {
        const scale = Math.pow(2, view.zoom);
        const width = screen.width * scale;
        const height = screen.height * scale;
        const e = extentOf(bounds, view.rotation, view.z);
        const centre = toScreen(view.x * TILE + TILE / 2, view.y * TILE + TILE / 2, view.z, view.rotation);
        if (view.fixed) {
            // Placed by generation (a tower at mid-height, a window wider than the content's
            // extent at this height): neither moved nor merged.
            centres.push({ ...centre, width, height });
            result.push(view);
            continue;
        }
        const fitted = {
            x: clampAxis(centre.x, width, e.xlo, e.xhi),
            y: clampAxis(centre.y, height, e.ylo, e.yhi),
        };
        if (view.rotation === overviewRotation && e.xhi - e.xlo <= width && e.yhi - e.ylo <= height) {
            continue;
        }
        const duplicate = result.some((other, i) =>
            other.rotation === view.rotation &&
            Math.abs(centres[i].x - fitted.x) < Math.min(width, centres[i].width) * MIN_SEPARATION &&
            Math.abs(centres[i].y - fitted.y) < Math.min(height, centres[i].height) * MIN_SEPARATION);
        if (duplicate) {
            continue;
        }
        centres.push({ ...fitted, width, height });
        result.push(viewAt(view, fitted));
    }
    return result;
}
