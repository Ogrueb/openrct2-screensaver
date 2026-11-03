// Dips the screen through black around a park change in the screensaver mode (patched engine):
// a black rectangle on the overlay with real alpha, faded by the engine; the player holds the
// background switch until it is black (engine patch 0010). Without an overlay (the stock engine's
// title screen) park changes cut.

import type { Overlay } from "./mode";
import { Z } from "./ui/theme";

const OVERLAY_ID = "rcts.cover";

export class Cover {
    private from = 0;
    private to = 0;
    private started = 0;
    private duration = 0;

    private shown = false;

    constructor(private readonly fadeMs: number, private readonly overlay?: Overlay) {}

    /** Current opacity, 0 (clear) to 1 (black). */
    opacity(): number {
        if (this.duration <= 0) {
            return this.to;
        }
        const t = Math.min(1, (Date.now() - this.started) / this.duration);
        return this.from + (this.to - this.from) * t;
    }

    /** True once the fade has reached its target and has been drawn at least once there. */
    settled(settleMs = 0): boolean {
        return Date.now() - this.started >= this.duration + settleMs;
    }

    fadeTo(target: number): void {
        if (!this.overlay) {
            return;
        }
        const from = this.opacity();
        this.from = from;
        this.to = target;
        this.started = Date.now();
        this.duration = this.fadeMs * Math.abs(target - from);
        if (target > 0 || this.shown) {
            this.overlay.set(OVERLAY_ID, {
                type: "rect", x: 0, y: 0, width: ui.width, height: ui.height, fill: "#000000", opacity: from, z: Z.cover,
            });
            this.overlay.fade(OVERLAY_ID, target, this.duration);
            this.shown = true;
        }
    }

    /** Removes the rectangle once a fade to clear has finished. */
    update(): void {
        if (this.shown && this.to === 0 && this.settled()) {
            this.close();
        }
    }

    close(): void {
        if (this.shown) {
            this.overlay?.remove(OVERLAY_ID);
            this.shown = false;
        }
        this.from = this.to = 0;
        this.duration = 0;
    }
}
