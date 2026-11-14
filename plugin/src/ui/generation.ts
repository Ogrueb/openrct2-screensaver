// The generation options a new playlist is made with (owner, 2026-11-14: they matter only when a playlist is
// made): the settings page's playlist-wide generator options, with its labels. Drawn by the editor's New
// playlist pane and by the no-playlist panel's New step; the choices go into the new playlist's live file
// (`props.generation`), which its first build bakes in (mksequence.py apply_generation).

import type { Generation } from "../storage";
import { Rect, Scene, button, label, measure } from "./kit";
import type { ButtonState } from "./kit";
import type { Overlay } from "../mode";
import { THEME } from "./theme";

export type Choice = [label: string, value: unknown, tip: string];

export const GEN_CHOICES: Partial<Record<keyof Generation, Choice[]>> = {
    motion: [["Pans", "pans", "Glide from view to view"], ["Static", "static", "Hold each view, then cut"]],
    route: [["Circuit", "circuit", "Loop around the park"], ["Random", "random", "The generator's pick order, varying angle and zoom"]],
    reverse: [["Off", false, "Orders as found"], ["On", true, "Each order reversed too"]],
    ridePans: [["Include", "include", "Adds a pan along a ride's track"], ["Exclude", "exclude", "No ride pans"],
        ["Only", "only", "Overview and ride pans only"]],
    parkScripts: [["Off", false, "The parks' own scripts stay off"], ["On", true, "Run the parks' own scripts (companion plugins)"]],
    parkViews: [["Off", false, "No views on scripted events"], ["On", true, "Views on the parks' scripted animations and shows"]],
};

export type GenStep = "variants" | "parkMin" | "parkCap" | "timeScale";
export const GEN_STEPS: Record<GenStep, { step: number; min: number; max: number; text: (v: number) => string }> = {
    variants: { step: 1, min: 1, max: 10, text: v => `${v}` },
    parkMin: { step: 5, min: 0, max: 300, text: v => (v ? `${v} s` : "none") },
    parkCap: { step: 5, min: 10, max: 300, text: v => `${v} s` },
    timeScale: { step: 0.25, min: 0.5, max: 3, text: v => `× ${v.toFixed(2)}` },
};

/** `g` after a click on `id` (`<prefix>seg.<key>.<i>` or `<prefix>step.<key>.less|more`), or undefined
 *  when the id is not one of these. */
export function generationClick(g: Generation, id: string, prefix: string): Generation | undefined {
    if (id.startsWith(`${prefix}seg.`)) {
        const [, key, i] = id.slice(prefix.length).split(".");
        const choice = GEN_CHOICES[key as keyof Generation]?.[Number(i)];
        return choice ? { ...g, [key]: choice[1] } : g;
    }
    if (id.startsWith(`${prefix}step.`)) {
        const [, key, sign] = id.slice(prefix.length).split(".");
        const k = key as GenStep;
        const st = GEN_STEPS[k];
        if (!st) {
            return g;
        }
        let v = Math.round((g[k] + (sign === "more" ? st.step : -st.step)) * 100) / 100;
        v = Math.max(st.min, Math.min(st.max, v));
        // (the shortest park time stays under the longest, as on the settings page)
        v = k === "parkMin" ? Math.min(v, g.parkCap - 5) : k === "parkCap" ? Math.max(v, g.parkMin + 5) : v;
        return { ...g, [k]: v };
    }
    return undefined;
}

/** The options as rows from `y` across `width` at `x`: ids `<prefix>seg.<key>.<i>` and
 *  `<prefix>step.<key>.less|more` (values `<prefix>stept.<key>`); `place` registers a button's rect and
 *  tooltip (off: inactive), `state` gives its look. Returns the y below the rows. */
export function generationRows(scene: Scene, overlay: Overlay, g: Generation, prefix: string, x: number, y: number, width: number,
    place: (id: string, r: Rect, tip: string, off?: boolean) => Rect, state: (id: string, on: boolean) => ButtonState, rowH = 26): number {
    const rowLabel = (id: string, text: string) => label(scene, id, text, { x, y, width: 0, height: rowH }, 13, overlay);
    const segments = (key: keyof Generation, text: string) => {
        rowLabel(`${prefix}seg.${key}.label`, text);
        const choices = GEN_CHOICES[key]!;
        const widths = choices.map(([t]) => Math.ceil(measure(overlay, t, 12, true).width) + 16);
        let sx = x + width - widths.reduce((a, w) => a + w, 0) - 4 * (choices.length - 1);
        const sy = y + Math.round((rowH - 22) / 2);
        choices.forEach(([t, value, tip], i) => {
            const id = `${prefix}seg.${key}.${i}`;
            const r = place(id, { x: sx, y: sy, width: widths[i], height: 22 }, tip);
            button(scene, id, r, state(id, g[key] === value), { text: t, textSize: 12 }, overlay);
            sx += widths[i] + 4;
        });
        y += rowH;
    };
    const stepper = (key: GenStep, text: string, tip: string) => {
        rowLabel(`${prefix}step.${key}.label`, text);
        const st = GEN_STEPS[key];
        const w = 22;
        const sy = y + Math.round((rowH - w) / 2);
        const more = place(`${prefix}step.${key}.more`, { x: x + width - w, y: sy, width: w, height: w }, tip, g[key] >= st.max);
        const box = { x: more.x - 4 - 52, y: sy, width: 52, height: w };
        const less = place(`${prefix}step.${key}.less`, { x: box.x - 4 - w, y: sy, width: w, height: w }, tip, g[key] <= st.min);
        button(scene, `${prefix}step.${key}.less`, less, state(`${prefix}step.${key}.less`, false), { icon: "less", iconSize: 16 }, overlay);
        button(scene, `${prefix}step.${key}.more`, more, state(`${prefix}step.${key}.more`, false), { icon: "add", iconSize: 16 }, overlay);
        scene.set(`${prefix}stepv.${key}`, { type: "rect", ...box, fill: THEME.editorList, z: 1 });
        const vid = `${prefix}stept.${key}`;
        label(scene, vid, st.text(g[key]), { x: box.x + box.width / 2, y: sy, width: 0, height: w }, 13, overlay);
        scene.set(vid, { ...scene.get(vid)!, align: "center" });
        y += rowH;
    };
    segments("motion", "Motion");
    segments("route", "View order");
    if (g.route === "circuit") {
        stepper("variants", "Variants", "Circuit orders per park, a different one on each visit (small parks may have fewer)");
        segments("reverse", "Include reverse");
    }
    if (g.motion === "pans") {
        segments("ridePans", "Ride pans");
    }
    stepper("parkMin", "Shortest park", "Shortest time per park");
    stepper("parkCap", "Longest park", "Longest time per park: the lowest-scoring views drop to fit");
    stepper("timeScale", "Time scale", "Multiplies every generated hold and pan: above 1 is slower");
    return y;
}
