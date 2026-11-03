// The screensaver mode's controls bar (docs/screensaver-ui.md): square buttons at the bottom of the
// window, shown when the mouse moves and hidden (with the cursor) after a few still seconds, like a
// video player's. Primary row: previous park, previous view, hold, next view, next park. Secondary
// row below, smaller: speed, shuffle, titles, music, time of day, edit views, settings. The settings button opens a panel
// above the bar with the stock options that apply to the mode, and its Title frame button a flyout of caption styles. The keys stay as they are; the bar
// shows what they change.

import type { MouseEvent, ScreensaverApi } from "../mode";
import { modeSettings } from "../mode";
import type { Player } from "../player";
import { Settings, saveSettings, titlesOf } from "../storage";
import { CaptionLook, STYLES, captionLook } from "./captions";
import { ICON_FOLDER, Layer, Rect, Scene, backing, button, contains, label, measure, slider, sliderValue, tooltip } from "./kit";
import { BAR, FLYOUT, PANEL, THEME, TIMING, Z } from "./theme";

type ButtonId = "prevPark" | "prevView" | "hold" | "nextView" | "nextPark" |
    "speed" | "shuffle" | "titles" | "music" | "time" | "edit" | "settings";
type OptionId = "window" | "captionPlace" | "captionFrame" | "renderer" | "multiThreading" | "weather" | "weatherGloom" | "lightEffects" | "masterVolume" | "soundVolume" | "musicVolume";
type HitId = ButtonId | `option.${OptionId}` | `frame.${Settings["captionFrame"]}` | `accent.${Settings["captionBand"]}` |
    "panel" | "flyout" | "quit";
type VolumeId = "masterVolume" | "soundVolume" | "musicVolume";

// The stock title screen's exit button (SPR_MENU_EXIT, 40x64 in the bottom right corner), drawn by the
// engine in the standard palette (patch 0015); it shows with the bar and does what Esc does.
const QUIT_SPRITE = "sprite:23210";
const QUIT_SIZE = { width: 40, height: 64 };

const PRIMARY: ButtonId[] = ["prevPark", "prevView", "hold", "nextView", "nextPark"];
const SECONDARY: ButtonId[] = ["speed", "shuffle", "titles", "music", "time", "edit", "settings"];

/** What the bar needs from the view editor (main.ts). */
export interface EditorHooks {
    toggleEditor(): void;
    editorOpen(): boolean;
}

const TITLES_NEXT: Record<Settings["titles"], Settings["titles"]> = { overview: "on", on: "off", off: "overview" };
// Time of day (owner, 2026-11-02): day raised (the stock title screen), night sunk, cycle in the
// alternate colour.
const TIME_NEXT: Record<Settings["timeOfDay"], Settings["timeOfDay"]> = { day: "night", night: "cycle", cycle: "day" };
const TIME_TEXT: Record<Settings["timeOfDay"], string> = { day: "day", night: "night", cycle: "day and night cycle" };
const TIME_ICON: Record<Settings["timeOfDay"], string> = { day: "day", night: "night", cycle: "day-night" };
const TITLES_TEXT: Record<Settings["titles"], string> = { overview: "each park's first view", on: "every view", off: "off" };
// No exclusive fullscreen: it switches the monitor to the fullscreen resolution in the game's own
// settings, which broke display scaling (owner, 2026-11-02); borderless fills the screen anyway.
const WINDOW_NEXT: Record<Settings["window"], Settings["window"]> = {
    borderless: "windowed", windowed: "keep", keep: "borderless", fullscreen: "borderless",
};
const WINDOW_TEXT: Record<Settings["window"], string> = {
    borderless: "Borderless", windowed: "Windowed", keep: "As in Options", fullscreen: "Fullscreen",
};
// The stock options that apply to the mode, applied in memory (never config.ini).
const OPTIONS: { id: OptionId; label: string; kind: "cycle" | "toggle" | "slider" }[] = [
    { id: "window", label: "Window", kind: "cycle" },
    { id: "captionPlace", label: "Park titles", kind: "cycle" },
    { id: "captionFrame", label: "Title frame", kind: "cycle" },
    { id: "renderer", label: "Renderer", kind: "cycle" },
    { id: "multiThreading", label: "Multithreading", kind: "toggle" },
    { id: "weather", label: "Changing weather", kind: "toggle" },
    { id: "weatherGloom", label: "Weather effects", kind: "toggle" },
    { id: "lightEffects", label: "Light effects", kind: "toggle" },
    { id: "masterVolume", label: "Master volume", kind: "slider" },
    { id: "soundVolume", label: "Sound effects", kind: "slider" },
    { id: "musicVolume", label: "Music", kind: "slider" },
];
// The game's own volume settings, shown until the mode has its own.
const VOLUME_KEYS: Record<VolumeId, string> = {
    masterVolume: "sound.master_volume", soundVolume: "sound.sound_volume", musicVolume: "sound.ride_music_volume",
};
const PLACE_NEXT: Record<Settings["captionPlace"], Settings["captionPlace"]> = {
    topLeft: "bottomLeft", bottomLeft: "topCenter", topCenter: "bottomCenter", bottomCenter: "topLeft",
};
const PLACE_TEXT: Record<Settings["captionPlace"], string> = {
    topLeft: "Top left", bottomLeft: "Bottom left", topCenter: "Top center", bottomCenter: "Bottom center",
};
// The Title frame flyout (owner, 2026-11-03): a tile per style with a preview of it, and the accent colours.
const FRAME_TEXT: Record<Settings["captionFrame"], string> = {
    gold: "Gold", silver: "Silver", wood: "Wood", minimalDark: "Minimal dark", minimalLight: "Minimal light", aero: "Aero", canvas: "Canvas",
};
// Rows of the flyout's grid: the portrait frames, the plain ones, then canvas.
const FRAME_ROWS: Settings["captionFrame"][][] = [["gold", "silver", "wood"], ["minimalDark", "minimalLight", "aero"], ["canvas"]];
const BANDS: Settings["captionBand"][] = ["green", "burgundy", "navy", "slate", "ivory"];
const RENDERER_NEXT: Record<string, Settings["drawingEngine"]> = { null: "software", software: "opengl", opengl: null };
const RENDERER_TEXT: Record<string, string> = { null: "As in Options", software: "Software", opengl: "OpenGL" };

/** The drawing engine the mode runs: its own setting, else the game's (DrawingEngine 0 is software). */
function rendererInUse(settings: Settings): "software" | "opengl" {
    if (settings.drawingEngine) {
        return settings.drawingEngine;
    }
    try {
        const engine = context.configuration.get<number | string>("general.drawing_engine");
        return engine === 1 || String(engine).toLowerCase().includes("opengl") ? "opengl" : "software";
    } catch {
        return "software";
    }
}

/** Options shown: all of them (light effects greyed out where the engine lacks them). */
function shownOptions(_settings: Settings) {
    return OPTIONS;
}

/** The secondary row is never wider than the primary one (owner, 2026-11-02): its buttons shrink to fit. */
function secondaryButtonSide(): number {
    const primaryWidth = PRIMARY.length * BAR.primary + (PRIMARY.length - 1) * BAR.gap;
    return Math.min(BAR.secondary, Math.floor((primaryWidth - (SECONDARY.length - 1) * BAR.gap) / SECONDARY.length));
}

/** Where the bar's backing sits in the window (game pixels), shown or not: the captions keep clear of it. */
export function barArea(): Rect {
    const b = BAR;
    const width = 2 * b.pad + PRIMARY.length * b.primary + (PRIMARY.length - 1) * b.gap;
    const height = 2 * b.pad + b.primary + b.rowGap + secondaryButtonSide();
    return { x: Math.round((ui.width - width) / 2), y: ui.height - b.bottom - height, width, height };
}

/** The game speed's multiplier: OpenRCT2's speeds 1-4 run 1, 2, 4 and 8 ticks per frame. */
function speedFactor(speed: number): number {
    return 2 ** (Math.max(1, Math.min(4, speed)) - 1);
}

/** "#rrggbbaa" between two colours, t 0-1. */
function mix(a: string, b: string, t: number): string {
    const ch = (s: string, i: number) => parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16);
    let out = "#";
    for (let i = 0; i < 4; i++) {
        out += Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0");
    }
    return out;
}

/** The speed button's face: green at 1× to orange at 8×, in even steps (owner, 2026-11-02). */
function speedFace(speed: number, hover: boolean): string {
    const t = (Math.max(1, Math.min(4, speed)) - 1) / 3;
    const face = mix(THEME.speedSlow, THEME.speedFast, t);
    return hover ? mix(face, "#ffffffc0", 0.2) : face;
}

const MIN_SPEED = 1;
const MAX_SPEED = 4;

export class ControlsBar {
    private readonly layer: Layer;
    private mouse = { x: -1, y: -1 };
    private lastMove = 0;
    private downOn: HitId | undefined;
    private boxes = new Map<HitId, Rect>();
    private strip: Rect = { x: 0, y: 0, width: 0, height: 0 };
    private panel: Rect | undefined; // the settings panel, while open
    private flyout: Rect | undefined; // the Title frame flyout beside it, while open
    private previews = new Map<string, CaptionLook>(); // the flyout's caption previews, by style, accent and scale

    constructor(
        private readonly mode: ScreensaverApi,
        private readonly player: () => Player | undefined,
        private readonly settings: Settings,
        private readonly editorHooks?: EditorHooks,
    ) {
        this.layer = new Layer(mode.overlay, "rcts.bar.");
    }

    /** Starts hidden, with the cursor hidden; the first mouse move shows both. */
    open(): void {
        this.mode.cursorVisible = false;
        this.render();
    }

    close(): void {
        this.layer.clear();
        this.downOn = undefined;
        this.panel = undefined;
        this.flyout = undefined;
        this.mode.cursorVisible = true;
    }

    onMouse(e: MouseEvent): void {
        this.mouse = { x: e.x, y: e.y };
        if (e.type === "move") {
            this.lastMove = Date.now();
            this.setShown(true);
            if (this.downOn) {
                this.slide(this.downOn, false); // dragging a slider
            }
        } else if (e.type === "down") {
            this.lastMove = Date.now();
            const hit = this.hit();
            if (!this.layer.visible) {
                this.setShown(true); // a click on a hidden bar only shows it
            } else if (hit && hit !== "panel" && hit !== "flyout" && e.button === 0) {
                this.downOn = hit;
                this.slide(hit, false);
            } else if (hit === "speed" && e.button === 1) {
                this.speed(-1, true);
            } else if (hit === "panel") {
                this.flyout = undefined; // a click on the panel's backing closes the flyout
            } else if (!hit && this.panel) {
                this.panel = undefined; // a click elsewhere closes the settings
                this.flyout = undefined;
            }
        } else if (e.type === "up" && e.button === 0) {
            const hit = this.hit();
            if (this.downOn && this.isSlider(this.downOn)) {
                this.slide(this.downOn, true); // a slider takes its value wherever the button is let go
            } else if (this.downOn && hit === this.downOn) {
                this.activate(hit);
            }
            this.downOn = undefined;
        } else if (e.type === "wheel" && this.layer.visible && this.hit() === "speed") {
            this.lastMove = Date.now();
            this.speed(e.delta > 0 ? 1 : -1, false);
        }
        this.render();
    }

    /** The mouse moved over something else (the editor panel): the bar stays as it is, awake. */
    mouseSeen(): void {
        this.lastMove = Date.now();
        this.setShown(true);
    }

    /** Every ~100 ms: hides the bar after the mouse has been still, and follows key changes. */
    update(): void {
        if (this.editorHooks?.editorOpen()) {
            this.lastMove = Date.now(); // the editor keeps the bar and the cursor up
            this.setShown(true);
        }
        const quit = this.boxes.get("quit");
        const over = contains(this.strip, this.mouse.x, this.mouse.y, 8) ||
            (quit !== undefined && contains(quit, this.mouse.x, this.mouse.y)) ||
            (this.panel !== undefined && contains(this.panel, this.mouse.x, this.mouse.y, 8)) ||
            (this.flyout !== undefined && contains(this.flyout, this.mouse.x, this.mouse.y, 8));
        if (this.layer.visible && !this.downOn && !over && Date.now() - this.lastMove > TIMING.hideAfter) {
            this.panel = undefined;
            this.flyout = undefined;
            this.setShown(false);
        }
        this.render();
    }

    /** Whether the bar shows (fading in or shown); the captions move above it while it does. */
    get shown(): boolean {
        return this.layer.visible;
    }

    private setShown(on: boolean): void {
        if (on !== this.layer.visible) {
            this.layer.show(on, on ? TIMING.fadeIn : TIMING.fadeOut);
            this.mode.cursorVisible = on;
        }
    }

    private hit(): HitId | undefined {
        for (const [id, r] of this.boxes) {
            if (contains(r, this.mouse.x, this.mouse.y)) {
                return id;
            }
        }
        if (this.flyout && contains(this.flyout, this.mouse.x, this.mouse.y)) {
            return "flyout";
        }
        return this.panel && contains(this.panel, this.mouse.x, this.mouse.y) ? "panel" : undefined;
    }

    private activate(id: HitId): void {
        const p = this.player();
        switch (id) {
            case "prevPark": p?.previousPark(); break;
            case "prevView": p?.previous(); break;
            case "hold": p?.toggleHold(); break;
            case "nextView": p?.next(); break;
            case "nextPark": p?.nextPark(); break;
            case "speed": this.speed(1, true); break;
            case "shuffle": p?.toggleShuffle(); break;
            case "titles":
                // The viewer's pick replaces the playlist's for the rest of the run and is kept.
                this.settings.titles = TITLES_NEXT[titlesOf(this.settings)] ?? "overview";
                this.settings.titlesOverride = undefined;
                saveSettings(this.settings);
                break;
            case "time":
                this.settings.timeOfDay = TIME_NEXT[this.settings.timeOfDay] ?? "day";
                this.applyMode();
                break;
            case "music":
                // Off or the parks' ride music (owner, 2026-11-02); a playlist's "theme" stays a
                // playlist setting, played until the music is switched off here.
                this.settings.titleMusic = this.settings.titleMusic === "off" ? "ride" : "off";
                this.applyMode();
                break;
            case "quit":
                this.mode.exit();
                break;
            case "edit":
                this.panel = undefined;
                this.flyout = undefined;
                this.editorHooks?.toggleEditor();
                break;
            case "settings":
                this.panel = this.panel ? undefined : { x: 0, y: 0, width: 0, height: 0 };
                this.flyout = undefined;
                break;
            case "option.window":
                this.settings.window = WINDOW_NEXT[this.settings.window] ?? "borderless";
                this.applyMode();
                break;
            case "option.captionPlace":
                this.settings.captionPlace = PLACE_NEXT[this.settings.captionPlace] ?? "topLeft";
                saveSettings(this.settings);
                break;
            case "option.captionFrame":
                this.flyout = this.flyout ? undefined : { x: 0, y: 0, width: 0, height: 0 };
                break;
            case "option.renderer":
                this.settings.drawingEngine = RENDERER_NEXT[String(this.settings.drawingEngine)] ?? null;
                this.applyMode(); // the window is recreated with the other engine (as in Options)
                break;
            case "option.multiThreading":
                this.settings.multiThreading = !this.multiThreading();
                this.applyMode();
                break;
            case "option.lightEffects":
                this.settings.lightEffects = !this.settings.lightEffects;
                this.applyMode();
                break;
            case "option.weatherGloom":
                this.settings.weatherGloom = !this.settings.weatherGloom;
                this.applyMode();
                break;
            case "option.weather":
                this.settings.weather = !this.settings.weather;
                this.applyMode();
                break;
            default:
                if (id.startsWith("frame.")) {
                    this.settings.captionFrame = id.slice("frame.".length) as Settings["captionFrame"];
                    saveSettings(this.settings);
                } else if (id.startsWith("accent.")) {
                    this.settings.captionBand = id.slice("accent.".length) as Settings["captionBand"];
                    saveSettings(this.settings);
                }
        }
    }

    private isSlider(id: HitId): id is `option.${VolumeId}` {
        return id === "option.masterVolume" || id === "option.soundVolume" || id === "option.musicVolume";
    }

    /** Sets a volume slider from the mouse; applied as it moves, saved on release. */
    private slide(id: HitId, save: boolean): void {
        if (!this.isSlider(id)) {
            return;
        }
        const r = this.boxes.get(id);
        if (!r) {
            return;
        }
        const key = id.slice("option.".length) as VolumeId;
        const value = Math.round(sliderValue(r, this.mouse.x) * 20) * 5; // steps of 5
        if (value !== this.settings[key] || save) {
            this.settings[key] = value;
            if (save) {
                this.applyMode();
            } else {
                this.mode.configure(modeSettings(this.settings));
            }
        }
    }

    /** A volume as shown: the mode's own, else the game's. */
    /** Multithreaded rendering in the mode: its own setting, else the game's (Options). */
    private multiThreading(): boolean {
        if (typeof this.settings.multiThreading === "boolean") {
            return this.settings.multiThreading;
        }
        try {
            return Boolean(context.configuration.get<boolean | number>("general.multithreading") ?? true);
        } catch {
            return true;
        }
    }

    private volume(id: VolumeId): number {
        const own = this.settings[id];
        if (typeof own === "number") {
            return own;
        }
        try {
            return context.configuration.get<number>(VOLUME_KEYS[id]) ?? 100;
        } catch {
            return 100;
        }
    }

    /** Saves the settings and applies the mode's part of them at once (patch 0011). */
    private applyMode(): void {
        saveSettings(this.settings);
        this.mode.configure(modeSettings(this.settings));
    }

    /** One step faster or slower; a click wraps round (4× then 1×), the wheel stops at the ends. */
    private speed(delta: number, wrap: boolean): void {
        const p = this.player();
        if (!p) {
            return;
        }
        let target = this.settings.speed + delta;
        if (wrap) {
            target = target > MAX_SPEED ? MIN_SPEED : target < MIN_SPEED ? MAX_SPEED : target;
        }
        p.changeSpeed(target - this.settings.speed);
    }

    private layout(): void {
        const b = BAR;
        const rowWidth = (n: number, side: number) => n * side + (n - 1) * b.gap;
        const primaryWidth = rowWidth(PRIMARY.length, b.primary);
        const secondary = secondaryButtonSide();
        const width = 2 * b.pad + primaryWidth;
        this.strip = barArea();
        this.boxes.clear();
        const row = (ids: ButtonId[], side: number, y: number) => {
            let x = this.strip.x + Math.round((width - rowWidth(ids.length, side)) / 2);
            for (const id of ids) {
                this.boxes.set(id, { x, y, width: side, height: side });
                x += side + b.gap;
            }
        };
        this.boxes.set("quit", { x: ui.width - QUIT_SIZE.width, y: ui.height - QUIT_SIZE.height, ...QUIT_SIZE });
        row(PRIMARY, b.primary, this.strip.y + b.pad);
        row(SECONDARY, secondary, this.strip.y + b.pad + b.primary + b.rowGap);
        if (this.panel) {
            const p = PANEL;
            const titleHeight = Math.round(p.titleSize * 1.6);
            const options = shownOptions(this.settings);
            const ph = 2 * p.pad + titleHeight + options.length * p.rowHeight + (options.length - 1) * p.rowGap;
            this.panel = {
                x: Math.round((ui.width - p.width) / 2), y: this.strip.y - p.above - ph, width: p.width, height: ph,
            };
            let y = this.panel.y + p.pad + titleHeight;
            for (const o of options) {
                this.boxes.set(`option.${o.id}`, {
                    x: this.panel.x + p.width - p.pad - p.valueWidth, y, width: p.valueWidth, height: p.rowHeight,
                });
                y += p.rowHeight + p.rowGap;
            }
            if (this.flyout) {
                this.layoutFlyout();
            }
        }
    }

    /** The Title frame flyout beside the panel, level with its row (kept above the bar): its tiles and swatches. */
    private layoutFlyout(): void {
        const f = FLYOUT;
        const panel = this.panel!;
        const row = this.boxes.get("option.captionFrame")!;
        const titleHeight = Math.round(PANEL.titleSize * 1.6);
        const gridWidth = 3 * f.tileWidth + 2 * f.gap;
        const width = 2 * PANEL.pad + gridWidth;
        const height = 2 * PANEL.pad + titleHeight + FRAME_ROWS.length * (f.tileHeight + f.gap) + f.accentLabel + f.swatchHeight;
        const bottom = this.strip.y - PANEL.above;
        const y = Math.max(4, Math.min(row.y - PANEL.pad - titleHeight, bottom - height));
        // Right of the panel, else left of it, else (a small window) over it, kept inside the window.
        const right = panel.x + panel.width + f.beside;
        const leftX = panel.x - f.beside - width;
        const x = right + width <= ui.width ? right : leftX >= 0 ? leftX : Math.max(0, Math.min(ui.width - width, right));
        this.flyout = { x, y, width, height };
        let ty = y + PANEL.pad + titleHeight;
        for (const ids of FRAME_ROWS) {
            ids.forEach((id, i) => this.boxes.set(`frame.${id}`, {
                x: this.flyout!.x + PANEL.pad + i * (f.tileWidth + f.gap), y: ty, width: f.tileWidth, height: f.tileHeight,
            }));
            ty += f.tileHeight + f.gap;
        }
        const sw = (gridWidth - (BANDS.length - 1) * f.gap) / BANDS.length;
        BANDS.forEach((band, i) => this.boxes.set(`accent.${band}`, {
            x: this.flyout!.x + PANEL.pad + i * (sw + f.gap), y: ty + f.accentLabel, width: sw, height: f.swatchHeight,
        }));
    }

    /** A caption preview of a style in the current accent, fitted to a flyout tile (laid out once per style). */
    private preview(style: Settings["captionFrame"], w: number, h: number): CaptionLook {
        const overlay = this.mode.overlay;
        const key = `${style}|${this.settings.captionBand}|${overlay.scale}|${w}x${h}`;
        let look = this.previews.get(key);
        if (!look) {
            const full = captionLook(overlay, FLYOUT.previewName, FLYOUT.previewAuthor, style, this.settings.captionBand, 600, 1);
            const zoom = Math.min(w / full.width, h / full.height);
            look = captionLook(overlay, FLYOUT.previewName, FLYOUT.previewAuthor, style, this.settings.captionBand, 600, zoom);
            if (this.previews.size > 40) {
                this.previews.clear();
            }
            this.previews.set(key, look);
        }
        return look;
    }

    private render(): void {
        const overlay = this.mode.overlay;
        this.layout();
        const scene: Scene = new Map();
        backing(scene, "strip", this.strip);
        const p = this.player();
        const held = p?.isHeld ?? false;
        const hover = this.layer.visible ? this.hit() : undefined;
        const state = (id: HitId, on = false) => ({ hover: hover === id, down: this.downOn === id && hover === id, on });
        for (const id of [...PRIMARY, ...SECONDARY]) {
            const primary = PRIMARY.includes(id);
            const content = id === "speed"
                ? { text: `${speedFactor(this.settings.speed)}×`, textSize: BAR.speedText }
                : { icon: this.icon(id, held), iconSize: primary ? BAR.iconPrimary : BAR.iconSecondary };
            // Buttons with more than two states show the in-between one in the alternate colour.
            const alt = (id === "titles" && titlesOf(this.settings) === "on")
                || (id === "time" && this.settings.timeOfDay === "cycle");
            const face = id === "speed" ? speedFace(this.settings.speed, hover === id) : undefined;
            button(scene, id, this.boxes.get(id)!, { ...state(id, this.isOn(id, held) || alt), alt, face }, content, overlay);
        }
        const quit = this.boxes.get("quit")!;
        button(scene, "quit", quit, state("quit"), {}, overlay);
        // At the button's corner, placed by the sprite's own offsets, and not nudged when pressed: as the stock one.
        scene.set("quit.icon", { type: "image", src: QUIT_SPRITE, x: quit.x, y: quit.y, z: Z.icon });
        if (this.panel) {
            const pp = PANEL;
            backing(scene, "panel", this.panel);
            label(scene, "panel.title", "Screensaver settings",
                { x: this.panel.x + pp.pad, y: this.panel.y + pp.pad, width: 0, height: Math.round(pp.titleSize * 1.6) },
                pp.titleSize, overlay, true);
            for (const o of shownOptions(this.settings)) {
                const r = this.boxes.get(`option.${o.id}`)!;
                const id = `option.${o.id}` as const;
                if (o.kind === "slider") {
                    const v = this.volume(o.id as VolumeId);
                    label(scene, `panel.${o.id}`, `${o.label}  ${v}%`, { x: this.panel.x + pp.pad, y: r.y, width: 0, height: r.height }, pp.textSize, overlay);
                    slider(scene, id, r, v / 100, hover === id || this.downOn === id);
                } else {
                    label(scene, `panel.${o.id}`, o.label, { x: this.panel.x + pp.pad, y: r.y, width: 0, height: r.height }, pp.textSize, overlay);
                    const on = (o.kind === "toggle" && this.optionText(o.id) === "On") || (o.id === "captionFrame" && this.flyout !== undefined);
                    button(scene, id, r, state(id, on), { text: this.optionText(o.id), textSize: pp.textSize }, overlay);
                }
            }
        }
        if (this.panel && this.flyout) {
            const f = FLYOUT;
            const fly = this.flyout;
            backing(scene, "flyout", fly);
            const row = this.boxes.get("option.captionFrame")!;
            // A join from the panel to the flyout, level with the button that opened it.
            const joinX = fly.x > this.panel.x ? this.panel.x + this.panel.width : fly.x + fly.width;
            if (Math.abs(fly.x - this.panel.x - this.panel.width) === f.beside || Math.abs(this.panel.x - fly.x - fly.width) === f.beside) {
                scene.set("flyout.join", {
                    type: "rect", x: joinX, y: row.y + 4, width: f.beside, height: row.height - 8, fill: THEME.backing, z: Z.backing,
                });
            }
            label(scene, "flyout.title", "Title frame",
                { x: fly.x + PANEL.pad, y: fly.y + PANEL.pad, width: 0, height: Math.round(PANEL.titleSize * 1.6) }, PANEL.titleSize, overlay, true);
            for (const style of STYLES) {
                const id = `frame.${style}` as const;
                const r = this.boxes.get(id)!;
                const st = state(id, this.settings.captionFrame === style);
                button(scene, id, r, st, {}, overlay);
                const nudge = st.down || st.on ? 1 : 0;
                const look = this.preview(style, r.width - 2 * f.previewPad, r.height - f.previewPad - f.tileLabel);
                look.draw(scene, `${id}.preview.`, r.x + (r.width - look.width) / 2 + nudge,
                    r.y + f.previewPad + (r.height - f.previewPad - f.tileLabel - look.height) / 2 + nudge, Z.icon);
                const name = FRAME_TEXT[style];
                const m = measure(overlay, name, f.labelSize);
                label(scene, `${id}.label`, name, { x: r.x + (r.width - m.width) / 2 + nudge, y: r.y + r.height - f.tileLabel + nudge, width: 0, height: f.tileLabel - 2 },
                    f.labelSize, overlay);
            }
            const first = this.boxes.get(`accent.${BANDS[0]}`)!;
            label(scene, "flyout.accent", "Accent", { x: fly.x + PANEL.pad, y: first.y - f.accentLabel, width: 0, height: f.accentLabel }, f.labelSize, overlay);
            const ms = overlay.scale <= 1 ? 1 : overlay.scale <= 2 ? 2 : 3; // the velvet tiles' scales (tools/mkframe.py MARBLE_SCALES)
            for (const band of BANDS) {
                const id = `accent.${band}` as const;
                const r = this.boxes.get(id)!;
                const st = state(id, this.settings.captionBand === band);
                button(scene, id, r, st, {}, overlay);
                const nudge = st.down || st.on ? 1 : 0;
                const w = r.width - 6;
                const h = r.height - 6;
                scene.set(`${id}.swatch`, {
                    type: "image", src: `${ICON_FOLDER}/velvet-${band}-${ms * 100}.png`, x: r.x + 3 + nudge, y: r.y + 3 + nudge,
                    width: w, height: h, cropX: 0, cropY: 0, cropWidth: w * ms, cropHeight: h * ms, z: Z.icon,
                });
            }
        }
        // Tooltips above the bar; none while the settings panel sits there.
        if (hover === "quit" && !this.downOn) {
            tooltip(scene, "tip", "Exit (Esc)", quit.x + quit.width / 2, quit.y - 4, overlay, ui.width);
        } else if (hover && hover !== "panel" && hover !== "flyout" && !hover.startsWith("option.") && !this.downOn && !this.panel) {
            const r = this.boxes.get(hover)!;
            tooltip(scene, "tip", this.tip(hover as ButtonId, held), r.x + r.width / 2, this.strip.y - 4, overlay, ui.width);
        }
        this.layer.render(scene);
    }

    private optionText(id: OptionId): string {
        switch (id) {
            case "window": return WINDOW_TEXT[this.settings.window] ?? this.settings.window;
            case "captionPlace": return PLACE_TEXT[this.settings.captionPlace] ?? "Top left";
            case "captionFrame": return `${FRAME_TEXT[this.settings.captionFrame] ?? "Gold"}  \u203a`;
            case "renderer": return RENDERER_TEXT[String(this.settings.drawingEngine)] ?? "As in Options";
            case "lightEffects": return this.settings.lightEffects ? "On" : "Off";
            case "multiThreading": return this.multiThreading() ? "On" : "Off";
            case "weatherGloom": return this.settings.weatherGloom ? "On" : "Off";
            case "weather": return this.settings.weather ? "On" : "Off";
            default: return `${this.volume(id)}%`;
        }
    }

    private isOn(id: ButtonId, held: boolean): boolean {
        switch (id) {
            case "hold": return held;
            case "shuffle": return this.settings.shuffle;
            case "titles": return titlesOf(this.settings) !== "off";
            case "music": return this.settings.titleMusic !== "off";
            case "time": return this.settings.timeOfDay !== "day";
            case "edit": return this.editorHooks?.editorOpen() ?? false;
            case "settings": return this.panel !== undefined;
            default: return false;
        }
    }

    private icon(id: ButtonId, held: boolean): string {
        switch (id) {
            case "prevPark": return "prev-park";
            case "prevView": return "prev-view";
            case "hold": return held ? "play" : "pause";
            case "nextView": return "next-view";
            case "nextPark": return "next-park";
            case "shuffle": return "shuffle";
            case "titles": return titlesOf(this.settings) === "off" ? "titles-off" : "titles";
            case "music": return this.settings.titleMusic === "off" ? "music-off" : "music";
            case "time": return TIME_ICON[this.settings.timeOfDay] ?? "day";
            case "edit": return "edit";
            case "settings": return "settings";
            default: return "";
        }
    }

    private tip(id: ButtonId, held: boolean): string {
        switch (id) {
            case "prevPark": return "Previous park (Shift+←)";
            case "prevView": return "Previous view (←)";
            case "hold": return held ? "Release (Space)" : "Hold this view (Space)";
            case "nextView": return "Next view (→)";
            case "nextPark": return "Next park (Shift+→)";
            case "speed": return `Speed ${speedFactor(this.settings.speed)}× (↑ ↓; right-click slower)`;
            case "shuffle": return `Shuffle parks: ${this.settings.shuffle ? "on" : "off"} (S)`;
            case "titles": return `Titles: ${TITLES_TEXT[titlesOf(this.settings)] ?? titlesOf(this.settings)}`;
            case "music": return `Ride music: ${this.settings.titleMusic === "off" ? "off" : "on"}`;
            case "time": return `Time of day: ${TIME_TEXT[this.settings.timeOfDay] ?? this.settings.timeOfDay}`;
            case "edit": return `Edit views (E)${this.editorHooks?.editorOpen() ? ": close" : ""}`;
            case "settings": return "Settings";
        }
    }
}
