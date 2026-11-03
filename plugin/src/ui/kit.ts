// A small widget kit on the patched engine's overlay (engine patch 0013): a scene of elements the
// plugin describes, sent to the engine only where it changed, shown and hidden as one with the
// engine's own fades. Widgets are functions that add elements to a scene; hit tests are rectangles.

import type { Overlay, OverlayElement } from "../mode";
import { THEME, Z } from "./theme";

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function contains(r: Rect, x: number, y: number, margin = 0): boolean {
    return x >= r.x - margin && x < r.x + r.width + margin && y >= r.y - margin && y < r.y + r.height + margin;
}

export type Scene = Map<string, OverlayElement>;

const measured = new Map<string, { width: number; height: number }>();

/** overlay.measureText, remembered: the engine lays the text out on every call. */
export function measure(overlay: Overlay, text: string, size: number, bold = false): { width: number; height: number } {
    const key = `${overlay.scale}|${size}|${bold}|${text}`;
    let m = measured.get(key);
    if (!m) {
        if (measured.size > 200) {
            measured.clear();
        }
        m = overlay.measureText(text, { size, bold });
        measured.set(key, m);
    }
    return m;
}

/**
 * A group of overlay elements under one id prefix, kept in step with the scene it is given: new or
 * changed elements are set, missing ones removed. Every element is fully opaque while the layer is
 * shown and transparent while hidden (the colours carry the transparency), so showing and hiding
 * are engine fades.
 */
export class Layer {
    private sent = new Map<string, string>();
    private shown = false;

    constructor(private readonly overlay: Overlay, private readonly prefix: string) {}

    get visible(): boolean {
        return this.shown;
    }

    render(scene: Scene): void {
        const opacity = this.shown ? 1 : 0;
        for (const [id, element] of scene) {
            const full = { ...element, opacity };
            const key = JSON.stringify(full);
            if (this.sent.get(id) !== key) {
                this.overlay.set(this.prefix + id, full);
                this.sent.set(id, key);
            }
        }
        for (const id of [...this.sent.keys()]) {
            if (!scene.has(id)) {
                this.overlay.remove(this.prefix + id);
                this.sent.delete(id);
            }
        }
    }

    /** Fades every element in or out; elements set later take the new state. */
    show(on: boolean, ms: number): void {
        if (on === this.shown) {
            return;
        }
        this.shown = on;
        for (const id of this.sent.keys()) {
            this.overlay.fade(this.prefix + id, on ? 1 : 0, ms);
            // The engine runs the fade; what was sent now ends at the new opacity.
            const element = JSON.parse(this.sent.get(id)!) as OverlayElement;
            this.sent.set(id, JSON.stringify({ ...element, opacity: on ? 1 : 0 }));
        }
    }

    clear(): void {
        for (const id of this.sent.keys()) {
            this.overlay.remove(this.prefix + id);
        }
        this.sent.clear();
        this.shown = false;
    }
}

/** The four edges of a bevelled box: light top and left, dark bottom and right (swapped when sunk). */
export function bevel(scene: Scene, id: string, r: Rect, light: string, dark: string, width: number, z: number): void {
    const w = width;
    scene.set(`${id}.t`, { type: "rect", x: r.x, y: r.y, width: r.width, height: w, fill: light, z });
    scene.set(`${id}.l`, { type: "rect", x: r.x, y: r.y + w, width: w, height: r.height - w, fill: light, z });
    scene.set(`${id}.b`, { type: "rect", x: r.x + w, y: r.y + r.height - w, width: r.width - w, height: w, fill: dark, z });
    scene.set(`${id}.r`, { type: "rect", x: r.x + r.width - w, y: r.y + w, width: w, height: r.height - 2 * w, fill: dark, z });
}

export function backing(scene: Scene, id: string, r: Rect, fill: string = THEME.backing): void {
    scene.set(id, { type: "rect", x: r.x, y: r.y, width: r.width, height: r.height, fill, z: Z.backing });
    bevel(scene, id, r, THEME.backingLight, THEME.backingDark, THEME.bevel, Z.backing);
}

export interface ButtonState {
    hover: boolean;
    down: boolean; // the mouse button is held on it
    on: boolean; // a toggle that is on
    face?: string; // a face colour of its own (the speed button's scale), replacing the state's
    alt?: boolean; // with on: the other active state of a button with more than two (titles on every view, the time of day's cycle)
}

export interface ButtonContent {
    icon?: string; // an icon's name (plugin/icons, tools/mkicons.py)
    iconSize?: number; // game pixels
    text?: string;
    textSize?: number;
}

/** A square button in the stock menu's style: a translucent face, raised, sunk while pressed or on. */
export function button(scene: Scene, id: string, r: Rect, state: ButtonState, content: ButtonContent, overlay: Overlay): void {
    const sunk = state.down || state.on;
    const onFace = state.alt ? THEME.faceAlt : THEME.faceOn;
    const face = state.face && !state.down ? state.face : state.down ? THEME.faceDown : state.hover ? (state.on && state.alt ? THEME.faceAltHover : THEME.faceHover)
        : state.on ? onFace : THEME.face;
    scene.set(id, { type: "rect", x: r.x, y: r.y, width: r.width, height: r.height, fill: face, z: Z.face });
    bevel(scene, id, r, sunk ? THEME.bevelDark : THEME.bevelLight, sunk ? THEME.bevelLight : THEME.bevelDark, THEME.bevel, Z.bevel);
    const nudge = sunk ? 1 : 0; // the content moves with a sunk button, as the game's do
    if (content.icon) {
        const size = content.iconSize ?? 16;
        const px = iconPixels(size, overlay.scale);
        const side = px / overlay.scale; // the image's side in game pixels
        scene.set(`${id}.icon`, {
            type: "image", src: iconPath(content.icon, px), z: Z.icon,
            x: r.x + (r.width - side) / 2 + nudge, y: r.y + (r.height - side) / 2 + nudge,
        });
    } else if (content.text !== undefined) {
        const size = content.textSize ?? 12;
        const h = measure(overlay, content.text, size, true).height;
        scene.set(`${id}.text`, {
            type: "text", text: content.text, size, bold: true, colour: THEME.text, shadow: THEME.textShadow, align: "center",
            x: r.x + r.width / 2 + nudge, y: r.y + (r.height - h) / 2 + nudge, z: Z.icon,
        });
    }
}

/** A horizontal slider: a sunk track, filled up to `value` (0-1), with a raised knob. */
export function slider(scene: Scene, id: string, r: Rect, value: number, hover: boolean): void {
    const v = Math.max(0, Math.min(1, value));
    const trackH = Math.max(4, Math.round(r.height / 4));
    const track = { x: r.x, y: r.y + Math.round((r.height - trackH) / 2), width: r.width, height: trackH };
    scene.set(id, { type: "rect", ...track, fill: THEME.faceDown, z: Z.face });
    bevel(scene, id, track, THEME.bevelDark, THEME.bevelLight, THEME.bevel, Z.bevel);
    scene.set(`${id}.fill`, { type: "rect", x: track.x, y: track.y, width: Math.round(track.width * v), height: track.height, fill: THEME.faceOn, z: Z.face });
    const knobW = Math.round(r.height * 0.6);
    const knob = { x: Math.round(r.x + v * (r.width - knobW)), y: r.y, width: knobW, height: r.height };
    scene.set(`${id}.knob`, { type: "rect", ...knob, fill: hover ? THEME.faceHover : THEME.face, z: Z.icon });
    bevel(scene, `${id}.knob`, knob, THEME.bevelLight, THEME.bevelDark, THEME.bevel, Z.icon + 1);
}

/** The slider value (0-1) under a mouse x. */
export function sliderValue(r: Rect, x: number): number {
    const knobW = Math.round(r.height * 0.6);
    return Math.max(0, Math.min(1, (x - r.x - knobW / 2) / (r.width - knobW)));
}

/** A line of text, vertically centred in `r` (left-aligned). */
export function label(scene: Scene, id: string, text: string, r: Rect, size: number, overlay: Overlay, bold = false): void {
    const h = measure(overlay, text, size, bold).height;
    scene.set(id, {
        type: "text", text, size, bold, colour: THEME.text, shadow: THEME.textShadow,
        x: r.x, y: r.y + (r.height - h) / 2, z: Z.icon,
    });
}

/** A line of text on a dark backing, centred over `anchorX` and ending above `bottom`, kept on screen. */
export function tooltip(scene: Scene, id: string, text: string, anchorX: number, bottom: number, overlay: Overlay, screenWidth: number): void {
    const size = THEME.tipSize;
    const pad = THEME.tipPad;
    const m = measure(overlay, text, size);
    const width = Math.ceil(m.width) + 2 * pad;
    const height = Math.ceil(m.height) + 2 * pad;
    const x = Math.max(2, Math.min(screenWidth - width - 2, Math.round(anchorX - width / 2)));
    const y = bottom - height;
    scene.set(id, { type: "rect", x, y, width, height, fill: THEME.tipBacking, z: Z.tip });
    scene.set(`${id}.text`, { type: "text", text, size, colour: THEME.tipText, x: x + pad, y: y + pad, z: Z.tip + 1 });
}

// The output sizes tools/mkicons.py draws each icon at (its GAME_SIZES times SCALES).
export const ICON_PIXELS = [24, 30, 34, 36, 42, 48, 51, 60, 68, 72, 85, 96, 102, 136];
export const ICON_FOLDER = "rct-screensaver/icons"; // under the user plugin folder (mksequence.py --install)

/** The drawn size nearest an icon of `size` game pixels at the window's scale factor. */
export function iconPixels(size: number, scale: number): number {
    const want = size * scale;
    return ICON_PIXELS.reduce((best, px) => Math.abs(px - want) < Math.abs(best - want) ? px : best);
}

export function iconPath(name: string, px: number): string {
    return `${ICON_FOLDER}/${name}-${px}.png`;
}
