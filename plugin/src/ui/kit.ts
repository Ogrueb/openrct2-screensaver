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

    private base = new Map<string, number>(); // each element's own opacity (an inactive button's icon)

    render(scene: Scene): void {
        for (const [id, element] of scene) {
            const own = element.opacity ?? 1;
            this.base.set(id, own);
            const full = { ...element, opacity: this.shown ? own : 0 };
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
                this.base.delete(id);
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
            const to = on ? this.base.get(id) ?? 1 : 0;
            this.overlay.fade(this.prefix + id, to, ms);
            // The engine runs the fade; what was sent now ends at the new opacity.
            const element = JSON.parse(this.sent.get(id)!) as OverlayElement;
            this.sent.set(id, JSON.stringify({ ...element, opacity: to }));
        }
    }

    clear(): void {
        for (const id of this.sent.keys()) {
            this.overlay.remove(this.prefix + id);
        }
        this.sent.clear();
        this.base.clear();
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
    disabled?: boolean; // does nothing now: flat and gray (owner, 2026-11-10)
}

export interface ButtonContent {
    icon?: string; // an icon's name (plugin/icons, tools/mkicons.py)
    iconSize?: number; // game pixels
    text?: string;
    textSize?: number;
    hint?: string; // with icon and text: a key after the text, smaller and dimmer ("M")
    left?: boolean; // with icon and text: from the left edge (else the group is centred)
}

/** A square button in the stock menu's style: a translucent face, raised, sunk while pressed or on. */
export function button(scene: Scene, id: string, r: Rect, state: ButtonState, content: ButtonContent, overlay: Overlay): void {
    const off = state.disabled === true;
    const sunk = !off && (state.down || state.on);
    const onFace = state.alt ? THEME.faceAlt : THEME.faceOn;
    const face = off ? THEME.faceOff : state.face && !state.down ? state.face : state.down ? THEME.faceDown
        : state.hover ? (state.on && state.alt ? THEME.faceAltHover : THEME.faceHover) : state.on ? onFace : THEME.face;
    scene.set(id, { type: "rect", x: r.x, y: r.y, width: r.width, height: r.height, fill: face, z: Z.face });
    // Inactive: flat and pressed in, its content gray.
    bevel(scene, id, r, sunk || off ? THEME.bevelDark : THEME.bevelLight, sunk ? THEME.bevelLight : off ? THEME.backingLight : THEME.bevelDark,
        THEME.bevel, Z.bevel);
    const nudge = sunk ? 1 : 0; // the content moves with a sunk button, as the game's do
    const colour = off ? THEME.textOff : THEME.text;
    const opacity = off ? THEME.iconOff : undefined;
    if (content.icon && content.text !== undefined) {
        // Icon, text and maybe a key hint in a row: centred as a group, or from the left.
        const size = content.iconSize ?? 16;
        const px = iconPixels(size, overlay.scale);
        const side = px / overlay.scale;
        const textSize = content.textSize ?? 12;
        const hintSize = Math.max(9, textSize - 4);
        const tm = measure(overlay, content.text, textSize, true);
        const hm = content.hint ? measure(overlay, content.hint, hintSize) : { width: 0, height: 0 };
        const gap = Math.round(side * 0.4);
        const total = side + gap + tm.width + (content.hint ? gap + hm.width : 0);
        const x0 = (content.left ? r.x + Math.round(side * 0.5) : r.x + Math.round((r.width - total) / 2)) + nudge;
        scene.set(`${id}.icon`, {
            type: "image", src: iconPath(content.icon, px), z: Z.icon, x: x0, y: r.y + (r.height - side) / 2 + nudge,
            ...(opacity !== undefined ? { opacity } : {}),
        });
        scene.set(`${id}.text`, {
            type: "text", text: content.text, size: textSize, bold: true, colour, shadow: THEME.textShadow,
            x: x0 + side + gap, y: r.y + (r.height - tm.height) / 2 + nudge, z: Z.icon,
        });
        if (content.hint) {
            scene.set(`${id}.hint`, {
                type: "text", text: content.hint, size: hintSize, colour: THEME.textDim,
                x: x0 + side + gap + tm.width + gap, y: r.y + (r.height - hm.height) / 2 + nudge + 1, z: Z.icon,
            });
        }
    } else if (content.icon) {
        const size = content.iconSize ?? 16;
        const px = iconPixels(size, overlay.scale);
        const side = px / overlay.scale; // the image's side in game pixels
        scene.set(`${id}.icon`, {
            type: "image", src: iconPath(content.icon, px), z: Z.icon,
            x: r.x + (r.width - side) / 2 + nudge, y: r.y + (r.height - side) / 2 + nudge,
            ...(opacity !== undefined ? { opacity } : {}),
        });
    } else if (content.text !== undefined) {
        const size = content.textSize ?? 12;
        const h = measure(overlay, content.text, size, true).height;
        scene.set(`${id}.text`, {
            type: "text", text: content.text, size, bold: true, colour, shadow: THEME.textShadow, align: "center",
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
export const ICON_PIXELS = [20, 24, 25, 30, 34, 35, 36, 40, 42, 48, 50, 51, 60, 68, 72, 80, 85, 96, 102, 136];
export const ICON_FOLDER = "rct-screensaver/icons"; // under the user plugin folder (mksequence.py --install)

/** The drawn size nearest an icon of `size` game pixels at the window's scale factor. */
export function iconPixels(size: number, scale: number): number {
    const want = size * scale;
    return ICON_PIXELS.reduce((best, px) => Math.abs(px - want) < Math.abs(best - want) ? px : best);
}

export function iconPath(name: string, px: number): string {
    return `${ICON_FOLDER}/${name}-${px}.png`;
}
