// The screensaver mode of the patched engine (engine patches 0011-0013, docs/wallpaper-wrapper.md):
// the global `screensaver`, absent on the stock engine.

import type { Settings } from "./storage";

export type WindowStyle = "keep" | "windowed" | "borderless" | "fullscreen";

export interface ModeSettings {
    window?: WindowStyle;
    titleMusic?: number | null; // OpenRCT2's TitleMusicKind; null leaves the game's own
    gameSpeed?: number | null;
    lightEffects?: boolean;
    weatherGloom?: boolean; // weather effects and gloom (patch 0014: both)
    weather?: boolean; // the climate runs on the title screen: weather changes as in play (patch 0014)
    timeOfDay?: "day" | "night" | "cycle"; // daylight (stock), full night, or the day/night cycle (patch 0014)
    masterVolume?: number | null; // 0-100 (patch 0014); null: the game's own
    soundVolume?: number | null;
    musicVolume?: number | null;
    drawingEngine?: "software" | "opengl" | null; // patch 0014; null: the game's own
    multiThreading?: boolean | null; // patch 0014; null: the game's own
}

export interface MouseEvent {
    type: "move" | "down" | "up" | "wheel";
    x: number;
    y: number;
    button: number;
    delta: number;
}

export interface ScreensaverApi {
    readonly active: boolean;
    readonly launchedByFlag: boolean;
    readonly settings: ModeSettings;
    cursorVisible: boolean;
    enter(settings?: ModeSettings): boolean;
    exit(): void;
    configure(settings: ModeSettings): void;
    onChange(callback: (active: boolean) => void): void;
    onMouse(callback: (e: MouseEvent) => void): void;
    readonly overlay: Overlay;
    readonly perfLog?: boolean; // the engine writes a perf log (--perf-log; perf patch)
    perfMark?(text: string): void; // a line in the perf log, on the engine's clock
}

/** An element of the overlay (engine patch 0013): positions and sizes in game pixels, colours
 *  "#rgb" or "#rrggbb(aa)". The engine draws it at the window's resolution. */
export interface OverlayElement {
    type: "rect" | "text" | "image";
    x: number;
    y: number;
    width?: number; // rect, image (image: 0 or absent draws it at its own size in output pixels)
    height?: number;
    opacity?: number; // 0-1 (default 1)
    z?: number; // higher draws on top
    fill?: string; // rect
    border?: string;
    borderWidth?: number;
    text?: string; // text
    font?: string;
    size?: number;
    bold?: boolean;
    colour?: string;
    align?: "left" | "center" | "right";
    wrap?: number;
    lineHeight?: number;
    shadow?: string;
    cropX?: number; // image: the part shown, in the image's own pixels (patch 0015); cropWidth 0 or absent: all
    cropY?: number;
    cropWidth?: number;
    cropHeight?: number;
    src?: string; // image: a PNG, absolute or under the user plugin folder, or "sprite:<image index>" (a game sprite, patch 0015)
}

export interface TextStyle {
    font?: string;
    size?: number;
    bold?: boolean;
    wrap?: number;
    lineHeight?: number;
}

export interface Overlay {
    set(id: string, element: OverlayElement): void;
    remove(id: string): void;
    clear(): void;
    fade(id: string, opacity: number, ms: number): void;
    measureText(text: string, style: TextStyle): { width: number; height: number };
    setDefaultFonts(regular: string, bold?: string): void;
    readonly scale: number; // output pixels per game pixel (OpenRCT2's scale factor)
}

declare const screensaver: ScreensaverApi | undefined;

/** The mode's API on the patched engine, else undefined. */
export function screensaverApi(): ScreensaverApi | undefined {
    return typeof screensaver === "undefined" ? undefined : screensaver;
}

/** Whether the engine writes a perf log (started with --perf-log; tools/perfrun.py). */
export function perfLogging(): boolean {
    const api = screensaverApi();
    return api?.perfLog === true && typeof api.perfMark === "function";
}

/** A mark in the engine's perf log (tools/perfreport.py splits frames by them); nothing without one. */
export function perfMark(text: string): void {
    if (perfLogging()) {
        screensaverApi()!.perfMark!(text);
    }
}

// TitleMusicKind (openrct2/config/ConfigTypes.h, patch 0002 adds parkMusic).
const TITLE_MUSIC_NONE = 0;
const TITLE_MUSIC_OPENRCT2 = 2;
const TITLE_MUSIC_RIDE = 5;

/** What the engine applies on entering the mode, from the plugin's settings. Speed stays the
 *  plugin's own (it re-applies it after every park load). */
export function modeSettings(settings: Settings): ModeSettings {
    let titleMusic: number | null = null;
    if (settings.titleMusic === "ride") {
        titleMusic = TITLE_MUSIC_RIDE;
    } else if (settings.titleMusic === "theme") {
        titleMusic = TITLE_MUSIC_OPENRCT2;
    } else if (settings.titleMusic === "off") {
        titleMusic = TITLE_MUSIC_NONE;
    }
    return {
        window: settings.window,
        titleMusic,
        gameSpeed: null,
        lightEffects: settings.lightEffects,
        weatherGloom: settings.weatherGloom,
        weather: settings.weather,
        timeOfDay: settings.timeOfDay,
        masterVolume: settings.masterVolume,
        soundVolume: settings.soundVolume,
        musicVolume: settings.musicVolume,
        drawingEngine: settings.drawingEngine,
        multiThreading: settings.multiThreading,
    };
}
