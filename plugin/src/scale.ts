// Scales views to the window. Generated views and pan speeds were judged in one game window
// (mksequence.py `[views] window`: 1920x1080 game pixels, the owner's 4K monitor at OpenRCT2's
// scale factor 2.0): a zoom level is a fixed number of world pixels per game pixel, so the same
// zoom in a 960x540 window shows a quarter of the area. Views are
// moved out by whole zoom levels (the only steps OpenRCT2 has) until the window shows at least
// the frame they were set for, both its width and its height ("contain", so a window of another
// shape crops nothing of it), allowing it to come out up to ZOOM_SLACK of a level tighter before
// stepping out. Pan speeds are a share of the window's size (owner, 2026-10-28: the tolerance
// scales with the window), measured against the zoom the frame was set at.

import { View } from "./storage";

export interface Screen {
    width: number;
    height: number;
}

export const DESIGN_SCREEN: Screen = { width: 1920, height: 1080 }; // mksequence.py [views] window
const ZOOM_SLACK = 0.25; // levels: a window up to 2^0.25 (19%) too small keeps the zoom
const MIN_ZOOM = -2; // OpenRCT2's ZoomLevel::min
const MAX_ZOOM = 3;

export interface Scaling {
    offset: number; // zoom levels added to each view (1: one level out)
    scale: number; // the window's size against the frame's (both sides at least this share)
}

export const NO_SCALING: Scaling = { offset: 0, scale: 1 };

/** How views framed for `design` play in a window of size `window`. */
export function scalingFor(design: Screen | undefined, window: Screen): Scaling {
    if (!design || design.width <= 0 || design.height <= 0 || window.width <= 0 || window.height <= 0) {
        return NO_SCALING;
    }
    const scale = Math.min(window.width / design.width, window.height / design.height);
    const offset = Math.ceil(Math.log2(1 / scale) - ZOOM_SLACK);
    return { offset: Object.is(offset, -0) ? 0 : offset, scale };
}

/** The views at the window's zoom levels. */
export function scaleViews(views: View[], scaling: Scaling): View[] {
    if (scaling.offset === 0) {
        return views;
    }
    return views.map(v => ({ ...v, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom + scaling.offset)) }));
}

/** A speed tolerance (screen px/s by the frame's zoom) for the window: at the window's zoom,
 * as a share of the window, never above the pixel speed it was measured at (the per-tick step
 * judders above it whatever the window's size). */
export function scaleTolerance(tolerance: (zoom: number) => number, scaling: Scaling): (zoom: number) => number {
    const factor = Math.min(1, scaling.scale);
    return zoom => tolerance(zoom - scaling.offset) * factor;
}

/** A [width, height] pair from storage as a Screen. */
export function screenOf(pair: [number, number] | undefined): Screen | undefined {
    return pair && pair.length === 2 ? { width: pair[0], height: pair[1] } : undefined;
}
