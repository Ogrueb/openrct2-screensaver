// RCT Screensaver: park name captions in the screensaver mode (wrapper step 2, docs/screensaver-ui.md).
// A portrait frame (a gold, silver or wood moulding, settings.captionFrame; soft marble mat) with the park's
// name, a dark wood divider and its builders as a byline on velvet (settings.captionBand), or one of the further
// styles (Minimal dark and light, Aero, Canvas; the accent colours them; captionLook), in a corner or at the
// middle of the window's top or bottom edge (settings.captionPlace). "Show titles" (settings.titles):
// on the park's first view (its overview) and the pan back to it, on every view, or never. The frame
// fades in as the park does (settings.fadeMs, the load cover's fade) and out when the view moves on;
// it sits under the load cover, so a dip to black covers it, keeps clear of the controls bar, and
// steps aside while the view editor is open. At the bottom it keeps the window's margin while the bar is
// hidden and moves up above the bar while it shows (owner, 2026-11-03).

import type { Overlay, OverlayElement, ScreensaverApi } from "../mode";
import type { Player } from "../player";
import { Settings, titlesOf } from "../storage";
import { barArea } from "./controls";
import { ICON_FOLDER, Layer, Rect, Scene } from "./kit";
import { ACCENT, CAPTION, CAPTION_STYLES, THEME, VELVET } from "./theme";

declare const ui: { width: number; height: number };

export class Captions {
    private readonly layer: Layer;
    private shownKey = ""; // the park, place, look, bar and window the scene was laid out for
    private shownPark = "";

    constructor(
        private readonly mode: ScreensaverApi,
        private readonly player: () => Player | undefined,
        private readonly settings: Settings,
        private readonly editorOpen: () => boolean,
        private readonly barShown: () => boolean = () => false,
    ) {
        this.layer = new Layer(mode.overlay, "rcts.cap.");
    }

    close(): void {
        this.layer.clear();
        this.shownKey = "";
        this.shownPark = "";
    }

    /** Every ~100 ms: shows the caption when the setting and the view on screen call for it. */
    update(): void {
        const c = this.player()?.caption;
        const wanted = c !== undefined && !this.editorOpen() && (
            titlesOf(this.settings) === "on" || (titlesOf(this.settings) === "overview" && c.firstView));
        if (!c || !wanted) {
            this.layer.show(false, CAPTION.fadeOut);
            return;
        }
        const bar = this.barShown();
        const layoutKey = `${c.key}|${this.settings.captionPlace}|${this.settings.captionFrame}|${this.settings.captionBand}|${bar}|${ui.width}x${ui.height}|${this.mode.overlay.scale}`;
        if (layoutKey !== this.shownKey) {
            if (this.layer.visible && c.key !== this.shownPark) {
                this.layer.show(false, 0); // a different park's caption never fades from the last one's
            }
            // The same park's caption moves or changes in place (the bar showing or hiding, a setting).
            this.layer.render(this.scene(c.name, c.author, bar));
            this.shownKey = layoutKey;
            this.shownPark = c.key;
        }
        // In step with the park: its cover fades out over fadeMs as the caption becomes due.
        this.layer.show(true, Math.max(0, this.settings.fadeMs));
    }

    private scene(name: string, author: string | undefined, barShown: boolean): Scene {
        const s = CAPTION;
        const place = this.settings.captionPlace;
        const bar = barArea();
        // Bottom left keeps beside the bar while it fits there (else it goes above it, as bottom centre does).
        const besideBar = bar.x - s.margin - s.barGap;
        const beside = place === "bottomLeft" && besideBar >= s.minBeside;
        const room = Math.min(s.maxWidth, beside ? besideBar : ui.width - 2 * s.margin);
        const look = captionLook(this.mode.overlay, name, author, this.settings.captionFrame, this.settings.captionBand, room, 1);
        const box = placeBox(place, look.width, look.height, bar, beside || !barShown);
        const scene: Scene = new Map();
        look.draw(scene, "", box.x, box.y, s.z);
        return scene;
    }
}

const PORTRAIT = ["gold", "silver", "wood"];
/** Every caption style, in the settings flyout's order. */
export const STYLES: Settings["captionFrame"][] = ["gold", "silver", "wood", "minimalDark", "minimalLight", "aero", "canvas"];

/** A caption laid out for one style (settings.captionFrame) and accent (settings.captionBand), its box no wider
 *  than `room` (game px), at `zoom` (1 on screen; the settings flyout's previews are smaller). */
export interface CaptionLook {
    width: number;
    height: number;
    /** Adds its elements to a scene, ids under `prefix`, with the box's top left at (x, y) and layers from z. */
    draw(scene: Scene, prefix: string, x: number, y: number, z: number): void;
}

export function captionLook(overlay: Overlay, name: string, author: string | undefined, frame: Settings["captionFrame"] | undefined,
    accent: Settings["captionBand"] | undefined, room: number, zoom: number): CaptionLook {
    const s = CAPTION;
    const st = CAPTION_STYLES;
    const style = frame && STYLES.includes(frame) ? frame : "gold";
    const band = accent && VELVET[accent] ? accent : "green";
    const portrait = PORTRAIT.includes(style);
    const sans = !portrait && style !== "canvas";
    // Each style's thickness round the mat, extra room on the left, divider height and fonts.
    const t = portrait ? s.frame : ({ minimalDark: st.minimalDark.frame, minimalLight: st.minimalLight.frame, aero: st.aero.frame,
        canvas: st.canvas.frame } as Record<string, number>)[style];
    const left = style === "minimalLight" ? st.minimalLight.strip : 0;
    const ruleH = portrait ? s.ruleHeight : style === "aero" ? 2 : 1;
    const k = zoom;
    const maxText = Math.max(120, room / k - 2 * (t + s.padX) - left);
    const titleStyle = sans
        ? { font: style === "aero" ? st.sans : st.sansBold, size: st.titleSize, bold: style !== "aero" }
        : { font: s.titleFont, size: s.titleSize, bold: true };
    const bylineStyle = sans
        ? { font: style === "aero" ? st.sansItalic : st.sans, size: st.bylineSize }
        : { font: s.bylineFont, size: s.bylineSize };
    const measure = (text: string, ts: { font: string; size: number; bold?: boolean }) => {
        const m = overlay.measureText(text, { ...ts, size: ts.size * k, wrap: maxText * k });
        return { width: m.width / k, height: m.height / k };
    };
    const title = measure(name, titleStyle);
    const byline = author ? `by ${author}` : "";
    const by = byline ? measure(byline, bylineStyle) : { width: 0, height: 0 };
    // The mat comes in whole edge tiles, so the moulding's tiles meet its corners exactly.
    const tile = s.frameTile;
    const matW = Math.ceil((Math.min(maxText, Math.max(title.width, by.width)) + 2 * s.padX + left) / tile) * tile;
    // The title's section (owner, 2026-11-03: a larger share of the frame) above the divider, the byline's below.
    const lowerH = byline ? ruleH + 2 * s.padY + by.height : 0;
    const needH = 2 * s.titlePadY + title.height + lowerH;
    const matH = Math.min(s.marbleHeight, Math.ceil(needH / tile) * tile);
    const upperH = matH - lowerH; // the tiles' slack goes to the title
    const W = matW + 2 * t;
    const H = matH + 2 * t;
    const scale = overlay.scale * k; // output pixels per local game pixel, for picking the pieces' size
    return {
        width: W * k,
        height: H * k,
        draw(scene: Scene, prefix: string, bx: number, by0: number, z: number) {
            // Everything below is in the box's own game pixels, placed at (bx, by0) and scaled by the zoom.
            const put = (id: string, e: OverlayElement) => {
                const out: OverlayElement = { ...e, x: bx + e.x * k, y: by0 + e.y * k, z: z + (e.z ?? 0) };
                if (e.width !== undefined) out.width = e.width * k;
                if (e.height !== undefined) out.height = e.height * k;
                if (e.size !== undefined) out.size = e.size * k;
                if (e.wrap !== undefined) out.wrap = e.wrap * k;
                scene.set(prefix + id, out);
            };
            const rect = (id: string, x: number, y: number, width: number, height: number, fill: string, dz = 0) =>
                put(id, { type: "rect", x, y, width, height, fill, z: dz });
            const image = (id: string, src: string, x: number, y: number, width: number, height: number, dz: number, crop?: number[]) =>
                put(id, {
                    type: "image", src: `${ICON_FOLDER}/${src}`, x, y, width, height, z: dz,
                    ...(crop ? { cropX: crop[0], cropY: crop[1], cropWidth: crop[2], cropHeight: crop[3] } : {}),
                });
            /** Tiles a w x h texture over an area, the last column and row cropped to what fits. */
            const tiles = (id: string, src: (pct: number) => string, pct: number, tw: number, th: number,
                x: number, y: number, w: number, h: number, dz: number) => {
                const f = pct / 100;
                for (let row = 0; row * th < h; row++) {
                    for (let col = 0; col * tw < w; col++) {
                        // Scaled down (the flyout's previews), each tile reaches a game pixel into the next, so
                        // rounding leaves no seam between them.
                        const cw = Math.min(tw, w - col * tw) + (k < 1 && (col + 1) * tw < w ? 1 / k : 0);
                        const ch = Math.min(th, h - row * th) + (k < 1 && (row + 1) * th < h ? 1 / k : 0);
                        image(`${id}.${row}.${col}`, src(pct), x + col * tw, y + row * th, cw, ch, dz, [0, 0, cw * f, ch * f]);
                    }
                }
            };
            const text = (id: string, value: string, ts: object, x: number, y: number, colour: string, dz: number, shadow?: string) =>
                put(id, { type: "text", text: value, ...ts, wrap: maxText, x, y, colour, z: dz, ...(shadow ? { shadow } : {}) });
            const tx = t + s.padX + left;
            const ty = t + Math.round((upperH - title.height) / 2);
            const ruleY = t + upperH;
            const byY = ruleY + ruleH + s.padY;
            const ms = marbleScale(scale);
            if (portrait) {
                drawPortrait();
            } else if (style === "minimalDark" || style === "minimalLight") {
                const m = style === "minimalDark" ? st.minimalDark : st.minimalLight;
                put("box", {
                    type: "rect", x: 0, y: 0, width: W, height: H, fill: m.backing, z: 0,
                    ...(style === "minimalDark" ? { border: st.minimalDark.border, borderWidth: 1 } : {}),
                });
                if (style === "minimalLight") {
                    rect("strip", 0, 0, st.minimalLight.strip, H, ACCENT[band].strip, 1);
                }
                const shadow = style === "minimalDark" ? st.minimalDark.shadow : undefined;
                text("title", name, titleStyle, tx, ty, m.title, 2, shadow);
                if (byline) {
                    rect("rule", t + s.padX + left, ruleY, matW - 2 * s.padX - left, 1, m.rule, 1);
                    text("byline", byline, bylineStyle, tx, byY, m.byline, 2, shadow);
                }
            } else if (style === "aero") {
                const a = st.aero;
                const g = ACCENT[band].aero;
                const r = a.radius;
                const pct = framePct(scale);
                // Rounded corners, then the straight rim as rects: outline, bright line, rim, and the inner panel's bevel.
                image("corner.tl", `aero-${band}-tl-${pct}.png`, 0, 0, r, r, 1);
                image("corner.tr", `aero-${band}-tr-${pct}.png`, W - r, 0, r, r, 1);
                image("corner.bl", `aero-${band}-bl-${pct}.png`, 0, H - r, r, r, 1);
                image("corner.br", `aero-${band}-br-${pct}.png`, W - r, H - r, r, r, 1);
                const layers: [string, number, number, string][] = [["outline", 0, 1, a.outline], ["bright", 1, 1, g.bright],
                    ["rim", 2, t - 2, g.rim], ["bevel", t, 1, g.bevel]];
                for (const [id, d, w, fill] of layers) {
                    rect(`rim.t.${id}`, r, d, W - 2 * r, w, fill, 1);
                    rect(`rim.b.${id}`, r, H - d - w, W - 2 * r, w, fill, 1);
                    rect(`rim.l.${id}`, d, r, w, H - 2 * r, fill, 1);
                    rect(`rim.r.${id}`, W - d - w, r, w, H - 2 * r, fill, 1);
                }
                put("box", { type: "rect", x: r, y: r, width: W - 2 * r, height: H - 2 * r, fill: "#00000000", z: 0 });
                tiles("frost", (p) => `aero-frost-${band}-${p}.png`, ms * 100, a.frostWidth, a.frostHeight, r, r, W - 2 * r, H - 2 * r, 0);
                image("gloss", `aero-gloss-${ms * 100}.png`, r, 2, W - 2 * r, H - 4, 2);
                // The text with a soft white glow: itself again round its edges (the overlay has no blur).
                const glow = (id: string, value: string, ts: object, x: number, y: number, colour: string) => {
                    const near = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
                    const far = [[-2, 0], [2, 0], [0, -2], [0, 2]];
                    near.forEach(([dx, dy], i) => text(`${id}.glow${i}`, value, ts, x + dx, y + dy, a.glow, 3));
                    far.forEach(([dx, dy], i) => text(`${id}.far${i}`, value, ts, x + dx, y + dy, a.glowFar, 3));
                    text(id, value, ts, x, y, colour, 4);
                };
                glow("title", name, titleStyle, tx, ty, a.title);
                if (byline) {
                    rect("rule.dark", t + s.padX, ruleY, matW - 2 * s.padX, 1, a.ruleDark, 3);
                    rect("rule.light", t + s.padX, ruleY + 1, matW - 2 * s.padX, 1, a.ruleLight, 3);
                    glow("byline", byline, bylineStyle, tx, byY, a.byline);
                }
            } else {
                const c = st.canvas;
                const f = c.gallery;
                const pct = framePct(scale);
                // A soft drop shadow (three steps), the black gallery frame, the accent mat, its bevel, the linen.
                [[2, 3], [3, 4], [4, 6]].forEach(([dx, dy], i) => rect(`shadow.${i}`, dx, dy, W, H, c.dropShadow, -1));
                const piece = (id: string, part: string, x: number, y: number, w: number, h: number) =>
                    image(`frame.${id}`, `gallery-${part}-${pct}.png`, x, y, w, h, 3);
                piece("tl", "tl", 0, 0, f, f);
                piece("tr", "tr", W - f, 0, f, f);
                piece("bl", "bl", 0, H - f, f, f);
                piece("br", "br", W - f, H - f, f, f);
                // The edges are the same all along, so one tile stretches across each side.
                piece("t", "t", f, 0, W - 2 * f, f);
                piece("b", "b", f, H - f, W - 2 * f, f);
                piece("l", "l", 0, f, f, H - 2 * f);
                piece("r", "r", W - f, f, f, H - 2 * f);
                put("box", { type: "rect", x: f, y: f, width: W - 2 * f, height: H - 2 * f, fill: ACCENT[band].mat, z: 0 });
                rect("mat.shadow.t", f, f, W - 2 * f, 2, c.frameShadow, 1);
                rect("mat.shadow.l", f, f + 2, 2, H - 2 * f - 2, c.frameShadow, 1);
                const b = c.bevel;
                rect("bevel.t", t - b, t - b, matW + 2 * b, b, c.bevelShade, 1);
                rect("bevel.l", t - b, t, b, matH + b, c.bevelShade, 1);
                rect("bevel.b", t, t + matH, matW + b, b, c.bevelLit, 1);
                rect("bevel.r", t + matW, t, b, matH, c.bevelLit, 1);
                tiles("linen", (p) => `canvas-${p}.png`, ms * 100, c.linenWidth, c.linenHeight, t, t, matW, matH, 1);
                text("title.glint", name, titleStyle, tx + 1, ty + 1, c.titleGlint, 2);
                text("title", name, titleStyle, tx, ty, c.title, 3);
                if (byline) {
                    rect("rule", t + s.padX, ruleY, matW - 2 * s.padX, 1, c.rule, 2);
                    text("byline", byline, bylineStyle, tx, byY, c.byline, 3);
                }
            }

            function drawPortrait(): void {
                // A portrait frame (owner, 2026-11-02): a carved gold moulding with an amber bead band round a
                // soft marble mat (tools/mkframe.py), the name engraved in the marble (a dark edge above and
                // left, a light one below and right), a dark wood divider, and the builders in italics.
                const pct = framePct(scale);
                put("box", { type: "rect", x: t, y: t, width: matW, height: matH, fill: THEME.captionMat, z: 0 });
                // The marble: the part of one large texture (tools/mkframe.py --marble) the mat needs, from its top
                // centre, shown with the overlay's crop (patch 0015).
                image("marble", `marble-${ms * 100}.png`, t, t, matW, matH, 0,
                    [Math.max(0, (s.marbleWidth - matW) / 2) * ms, 0, Math.min(matW, s.marbleWidth) * ms, matH * ms]);
                // The moulding: four corners, then edge tiles along each side.
                const piece = (id: string, part: string, x: number, y: number, w: number, h: number) =>
                    image(id, `frame-${style}-${part}-${pct}.png`, x, y, w, h, 3);
                const right = W - t;
                const bottom = H - t;
                piece("frame.tl", "tl", 0, 0, t, t);
                piece("frame.tr", "tr", right, 0, t, t);
                piece("frame.bl", "bl", 0, bottom, t, t);
                piece("frame.br", "br", right, bottom, t, t);
                for (let i = 0; i < matW / tile; i++) {
                    piece(`frame.t${i}`, "t", t + i * tile, 0, tile, t);
                    piece(`frame.b${i}`, "b", t + i * tile, bottom, tile, t);
                }
                for (let i = 0; i < matH / tile; i++) {
                    piece(`frame.l${i}`, "l", 0, t + i * tile, t, tile);
                    piece(`frame.r${i}`, "r", right, t + i * tile, t, tile);
                }
                text("title.glint", name, titleStyle, tx + 1, ty + 1, THEME.captionGlint, 1);
                text("title.shade", name, titleStyle, tx - 1, ty - 1, THEME.captionShade, 1);
                text("title", name, titleStyle, tx, ty, THEME.captionTitle, 2);
                if (byline) {
                    // The divider: dark wood across the mat from frame to frame, with the velvet band below it.
                    const wp = s.woodPiece;
                    for (let i = 0; i * wp < matW; i++) {
                        const w = Math.min(wp, matW - i * wp); // the last piece shows only what fits
                        image(`rule.${i}`, `wood-${i % s.woodPieces}-${pct}.png`, t + i * wp, ruleY, w, s.ruleHeight, 2,
                            w < wp ? [0, 0, w * pct / 100, s.ruleHeight * pct / 100] : undefined);
                    }
                    // The velvet: tiles across the band, the last column and row cropped to what fits.
                    const bandTop = ruleY + s.ruleHeight;
                    tiles("velvet", (p) => `velvet-${band}-${p}.png`, ms * 100, s.velvetWidth, s.velvetHeight,
                        t, bandTop, matW, t + matH - bandTop, 1);
                    text("byline", byline, bylineStyle, tx, byY, VELVET[band].text, 2, VELVET[band].shadow);
                }
            }
        },
    };
}

/** Where a w x h caption frame sits for each placement (game pixels). With `low`, the bottom placements
 *  keep the window's margin (beside the bar, or the bar hidden); else they sit above the bar. */
function placeBox(place: Settings["captionPlace"], w: number, h: number, bar: Rect, low: boolean): Rect {
    const s = CAPTION;
    const centreX = Math.round((ui.width - w) / 2);
    const top = s.margin;
    const bottom = low ? ui.height - s.margin - h : bar.y - s.barGap - h;
    switch (place) {
        case "bottomLeft": return { x: s.margin, y: bottom, width: w, height: h };
        case "topCenter": return { x: centreX, y: top, width: w, height: h };
        case "bottomCenter": return { x: centreX, y: bottom, width: w, height: h };
        default: return { x: s.margin, y: top, width: w, height: h };
    }
}

/** The frame pieces' scale (tools/mkframe.py SCALES, in percent) nearest the overlay's. */
function framePct(scale: number): number {
    return FRAME_SCALES.reduce((best, pct) => Math.abs(pct / 100 - scale) < Math.abs(best / 100 - scale) ? pct : best);
}

const FRAME_SCALES = [100, 125, 150, 175, 200, 250, 300, 400];

/** The marble texture's scale (tools/mkframe.py MARBLE_SCALES) for the overlay's: the nearest at or above it. */
function marbleScale(scale: number): number {
    return scale <= 1 ? 1 : scale <= 2 ? 2 : 3;
}
