// Measures a loaded park's content on screen from its tile elements, so parks that fit on one
// screen are centred on what is built rather than on the stored content box. Mirrors
// mksequence.py's content_bounds: tiles with 2+ visible non-surface elements (or any, if none
// have 2), weighted by count squared, with the outer TRIM of the weight ignored on each side.

import { Extent, Measure, toScreen } from "./fit";
import { Bounds } from "./storage";

const TILE = 32;
const TRIM = 0.01;
const MAX_TILES = 128 * 128; // larger parks never fit on one screen; skip the scan

interface TileInfo {
    x: number;
    y: number;
    zlo: number;
    zhi: number;
    weight: number;
    count: number;
    zsum: number; // sum of the elements' base heights
}

function scan(bounds: Bounds): TileInfo[] {
    const all: TileInfo[] = [];
    for (let y = bounds.y0; y <= bounds.y1; y++) {
        for (let x = bounds.x0; x <= bounds.x1; x++) {
            let count = 0;
            let zlo = Infinity;
            let zhi = -Infinity;
            let zsum = 0;
            for (const e of map.getTile(x, y).elements) {
                if (e.type === "surface") {
                    zlo = Math.min(zlo, e.baseZ);
                } else if (!e.isHidden && !e.isGhost) {
                    count++;
                    zsum += e.baseZ;
                    zlo = Math.min(zlo, e.baseZ);
                    zhi = Math.max(zhi, e.clearanceZ);
                }
            }
            if (count > 0) {
                all.push({ x, y, zlo, zhi, weight: count * count, count, zsum });
            }
        }
    }
    const detailed = all.filter(t => t.count >= 2);
    return detailed.length > 0 ? detailed : all;
}

/** [lo, hi] of weighted values, ignoring TRIM of the total weight at each end. */
function trimmed(values: [number, number][]): [number, number] {
    values.sort((a, b) => a[0] - b[0]);
    const total = values.reduce((s, v) => s + v[1], 0);
    let seen = 0;
    let lo = values[0][0];
    let hi = values[values.length - 1][0];
    let loFound = false;
    for (const [v, w] of values) {
        seen += w;
        if (!loFound && seen > total * TRIM) {
            lo = v;
            loFound = true;
        }
        if (seen >= total * (1 - TRIM)) {
            hi = v;
            break;
        }
    }
    return [lo, hi];
}

/** A Measure for the park now loaded, or undefined if it is too large or has no content. */
export function measureLoaded(bounds: Bounds): Measure | undefined {
    if ((bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1) > MAX_TILES) {
        return undefined;
    }
    let tiles: TileInfo[];
    try {
        tiles = scan(bounds);
    } catch {
        return undefined;
    }
    if (tiles.length === 0) {
        return undefined;
    }
    // Where the content is on average, each element counted once (as mksequence.py's bounds).
    const elements = tiles.reduce((s, t) => s + t.count, 0);
    const z = tiles.reduce((s, t) => s + t.zsum, 0) / elements;
    const cx = tiles.reduce((s, t) => s + (t.x + 0.5) * t.count, 0) / elements;
    const cy = tiles.reduce((s, t) => s + (t.y + 0.5) * t.count, 0) / elements;
    const cache: (Extent | undefined)[] = [];
    return rotation => {
        if (cache[rotation] === undefined) {
            const xs: [number, number][] = [];
            const ys: [number, number][] = [];
            for (const t of tiles) {
                for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                    for (const h of [t.zlo, t.zhi]) {
                        const p = toScreen((t.x + dx) * TILE, (t.y + dy) * TILE, h, rotation);
                        xs.push([p.x, t.weight]);
                        ys.push([p.y, t.weight]);
                    }
                }
            }
            const [xlo, xhi] = trimmed(xs);
            const [ylo, yhi] = trimmed(ys);
            const centre = toScreen(cx * TILE, cy * TILE, z, rotation);
            cache[rotation] = { xlo, xhi, ylo, yhi, z, cx: centre.x, cy: centre.y };
        }
        return cache[rotation];
    };
}
