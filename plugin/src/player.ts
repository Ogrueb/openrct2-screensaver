// Plays a playlist on the title screen. The built-in title sequence player is only used to
// load parks (by seeking to a park's LOAD command); views, holds and timing are driven here.

import { Cover } from "./cover";
import { perfMark, type Overlay } from "./mode";
import { fitViews, toScreen } from "./fit";
import { measureLoaded } from "./measure";
import { Pan, PanChanges, Pose, panTolerance } from "./pan";
import { DESIGN_SCREEN, NO_SCALING, Scaling, Screen, scaleTolerance, scaleViews, scalingFor, screenOf } from "./scale";
import {
    Cue, Edits, ParkEntry, Playlist, PlaylistProps, Settings, View, Visits, isPinned, placeCuts, loadEdits, loadPlaylistProps, loadVisits,
    saveEdits, savePlaylistProps, saveSettings, saveVisits,
} from "./storage";

const MIN_SPEED = 1;
const MAX_SPEED = 4; // 8 is only accepted with OpenRCT2's debugging tools enabled
const UPDATE_SETTLE_MS = 150; // longer than a frame and an update interval
const LOAD_TIMEOUT_MS = 3000; // after seek() returns, which is after the park has loaded
// With the patched engine's background loading, seek() returns at once and the park is read while
// the current one plays on; a large park read cold from disk takes several seconds.
const BACKGROUND_LOAD_TIMEOUT_MS = 60000;
const SHOW_TAIL_MS = 3000; // a show view stays this long after its show has finished
// With the patched engine, sound effects and positional ride music fade out before a scheduled
// view change (the last view of a park included) and fade in after every view change.
const SOUND_FADE_MS = 750;
const PREVIEW_DELAY_MS = 1000; // editor preview: plays on this long after the last edit
const TICKS_PER_SECOND = 40; // OpenRCT2 game ticks, each running the camera interval once
const CUE_WAIT_S = 20; // an event-timed view waits this long past its hold for its cue, unless it says
const CUE_TAIL_TICKS = 80; // and stays this long after the effect is over
const CAR_CHECK_TICKS = 4; // cars are looked for on a cue's tiles every this many ticks
const FOLLOW_EASE = 0.08; // share of the way to the followed train the camera moves each tick
const DIVERT_MIN_MS = 1500; // a cut-in with at least this lead pans to its view instead of cutting
const MIN_DIVERT_MOVE_MS = 1000;
const CUT_STAY_S = 4; // a cut-in view stays at least this long (or until its effect ends) before another cuts in
const LATE_MIN_TICKS = 160; // a repeating cut-in held up past its start still plays with this much effect left
const CHAIN_S = 4; // a cut-in view ending this close before the next timeline cut-in's lead pans on to it

function log(message: string): void {
    console.log(`[RCT Screensaver] ${message}`);
}

function range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
}

export class Player {
    private parkOrder: number[] = [];
    private parkPos = 0;
    private upNext?: number; // shuffle: the park after this one, picked on S and on each park load
    private unplayed = new Set<number>(); // shuffle: parks not played yet this round
    private history: number[] = []; // shuffle: the parks played before this one, for previous park
    private views: View[] = []; // current park's views, fitted to the window
    private viewOrder: number[] = [];
    private viewPos = 0;
    private viewStarted = 0; // Date.now() when the current view was shown
    private camEpoch = Date.now(); // camera log times count from here
    private panReturning = false; // the current pan goes back to the park's first view
    private panMoving = false; // camera log: the current pan has started / finished moving
    private panArrived = false;
    private panLast?: { x: number; y: number }; // camera log: the last tick's screen point
    private panPeak = 0; // camera log: fastest tick of the current pan, screen px/s
    private panTicks = 0; // camera log: ticks the current pan has moved on
    private soundsFaded = false; // the current view's sounds have faded out ahead of its end
    private loadingPark = false; // waiting for the built-in player to finish a LOAD
    private seeked = 0; // Date.now() of the last seek
    private readonly cover: Cover;
    private readonly dip: boolean; // park changes dip through black on the overlay (screensaver mode)
    private dipping = false; // the cover is fading in over a ready park, which waits for it
    private holding = false;
    private editing = false; // the view editor is open: no automatic advance, unless previewing
    private previewing = false; // the editor plays the park's views (with pans), looping in the park
    private running = false;
    private readonly edits: Edits = loadEdits();
    private props: PlaylistProps; // the view editor's Playlist properties in force (maybe unsaved)
    private savedProps: PlaylistProps; // and as saved in the game's storage
    private scalingLogged = ""; // camera log: the window and scaling last logged
    // The pan from the current view to the next, once it has been planned
    private pan: Pan | undefined;
    private panPlanned = false; // planned for the current view (pan undefined: it cuts instead)
    private panStarted = 0; // Date.now() when the pan sets off
    private heldAt = 0; // Date.now() when the view was held
    private bonusMs = 0; // added to the current view's hold, so an angle or zoom change stays a moment
    private pathTicks = 0; // game ticks the current view's camera path has run
    private showOver = false; // the show has finished, but the camera is still on its path
    private pathStarted = false; // the show has reached the step the camera path waits for
    private parkTicks = 0; // game ticks since the current park loaded: the companions' clock
    private cueAt: number | undefined; // park tick the current view's effect starts (cued)
    private cueTrain: number | undefined; // head car of the train that set the cue off
    private followAt: Pose | undefined; // where a camera following a train is
    private cutsDone = new Set<number>(); // cut-in views (by index) played on this visit
    private pendingCue: { index: number; at: number; train?: number } | undefined; // a cut-in the camera pans to
    private divertTo = -1; // in the editor's preview: the listed position of the cut-in the camera pans to
    private triggersIn = new Set<number>(); // camera log: car cues (by view) with a car on their tiles
    private arrivedChanged = false; // the current view's angle or zoom changed as a pan arrived on it
    /** Called whenever a view is shown, including after a park load. */
    /** Called whenever a view is shown; `byPlayback` when playback moved on by itself. */
    onViewShown: ((view: View | undefined, byPlayback: boolean) => void) | undefined;

    constructor(
        private readonly playlist: Playlist,
        private readonly sequence: TitleSequence,
        private readonly settings: Settings,
        overlay?: Overlay,
    ) {
        // A patched engine loads the next park in the background and keeps the current park
        // playing meanwhile. In the screensaver mode the switch dips through black (owner,
        // 2026-11-02): the player holds the switch until the overlay's cover is black (engine
        // patch 0010), then fades back in. Elsewhere (the stock engine's title screen, or no
        // fade) a park change cuts.
        this.dip = !!overlay && settings.fadeMs > 0 && backgroundLoading(sequence) && canHoldSwitch(sequence);
        this.cover = new Cover(settings.fadeMs, this.dip ? overlay : undefined);
        this.savedProps = loadPlaylistProps(playlist.sequence);
        this.props = { ...this.savedProps };
        this.noteInstalledMusic(settings.titleMusic);
        this.applyPresentation();
    }

    /** The editor's Title music and Show titles, where set, over the viewer's settings (the mode's
     *  title music takes effect when the caller configures the mode). */
    private applyPresentation(): void {
        if (this.props.titleMusic !== undefined) {
            this.settings.titleMusic = this.props.titleMusic;
        }
        if (this.props.titles !== undefined) {
            this.settings.titlesOverride = this.props.titles ?? undefined;
        }
    }

    /** The settings playback runs with (shared with the controls bar). */
    get liveSettings(): Settings {
        return this.settings;
    }

    /** True while the view is held (Space, or the controls bar's hold button). */
    get isHeld(): boolean {
        return this.holding;
    }

    get isRunning(): boolean {
        return this.running;
    }

    get debug(): boolean {
        return this.settings.debug;
    }

    setDebug(on: boolean): void {
        this.settings.debug = on;
    }

    start(): void {
        if (this.playlist.parks.length === 0) {
            log("playlist has no parks");
            return;
        }
        this.running = true;
        this.holding = false;
        this.settings.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, this.settings.speed));
        this.parkOrder = this.orderFromProps();
        this.unplayed.clear();
        this.history = [];
        if (!this.sequence.isPlaying) {
            this.sequence.play();
        }
        log(`playing "${this.playlist.sequence}" (${this.playlist.parks.length} parks)`);
        this.enterPark(this.settings.shuffle ? context.getRandom(0, this.parkOrder.length) : 0, false);
    }

    stop(): void {
        this.running = false;
        this.soundsFaded = false;
        fadeSounds(this.sequence, 1, SOUND_FADE_MS);
        this.cover.close();
        this.releaseSwitch();
        this.clearPan();
    }

    /** Stops, and hands the title screen back to the user's own title sequence. */
    release(): void {
        this.stop();
        if (this.sequence.isPlaying) {
            this.sequence.stop();
        }
    }

    /** Moves a panning camera on; called every game tick (40 times a second). */
    stepCamera(): void {
        const now = Date.now();
        if (this.pan && !this.holding && this.playing() && now >= this.panStarted) {
            const ms = now - this.panStarted;
            if (!this.panMoving && ms >= this.pan.lead) {
                this.panMoving = true;
                this.camLog("move", `ms=${Math.round(this.pan.duration - this.pan.lead - this.pan.rest)}`);
            }
            const pose = this.pan.at(ms);
            if (this.settings.cameraLog && this.panMoving && !this.panArrived) {
                // How far the picture moves this tick, as screen px/s at 40 ticks a second: uneven
                // ticks or clock steps show as a peak over the average.
                const p = toScreen(pose.x, pose.y, pose.z, pose.rotation);
                if (this.panLast) {
                    const px = Math.hypot(p.x - this.panLast.x, p.y - this.panLast.y) / 2 ** pose.zoom;
                    this.panPeak = Math.max(this.panPeak, px * TICKS_PER_SECOND);
                }
                this.panLast = { x: p.x, y: p.y };
                this.panTicks++;
            }
            if (!this.panArrived && ms >= this.pan.duration - this.pan.rest) {
                this.logPanStop();
            }
            this.applyPose(pose);
        }
    }

    /** Called every game tick: the park's clock, event cues and show paths keep game time with
     * the companions, which count their frames in game ticks too. */
    tick(): void {
        if (this.loadingPark) {
            return;
        }
        this.parkTicks++;
        this.stepCue();
        this.stepPath();
    }

    /** Moves the camera along a show view's path. */
    private stepPath(): void {
        const view = this.views[this.viewOrder[this.viewPos]];
        if (!view?.path || !this.pathStarted || this.holding || this.loadingPark || !this.playing()) {
            return;
        }
        this.pathTicks++;
        this.applyPose(pathPose(view, this.pathTicks));
        if (this.pathTicks === pathArrival(view)) {
            const c = ui.mainViewport.getCentrePosition();
            this.camLog("path", `end ticks=${this.pathTicks} center=${Math.floor(c.x / 32)},${Math.floor(c.y / 32)}`);
        }
        if (this.showOver && this.pathTicks >= pathArrival(view)) {
            this.leaveShow();
        }
    }

    /** Called every ~100 ms of real time. */
    update(): void {
        if (!this.running) {
            return;
        }
        this.cover.update();
        if (!this.sequence.isPlaying) {
            log("title sequence stopped playing; restarting");
            this.sequence.play();
            this.enterPark(this.parkPos, false);
            return;
        }
        if (this.loadingPark) {
            const timeout = backgroundLoading(this.sequence) ? BACKGROUND_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS;
            if (!this.parkIsLoaded() && (Date.now() - this.seeked > timeout || this.loadSkipped())) {
                // The built-in player skips a park it fails to load, on to the next LOAD.
                log(`"${this.currentPark().name}" did not load; skipping it`);
                this.skipFailedPark();
                return;
            }
            if (this.dip && !this.parkIsLoaded()) {
                const sequence = this.sequence as unknown as HoldableSequence;
                if (!this.dipping && sequence.nextParkReady) {
                    this.dipping = true;
                    this.cover.fadeTo(1);
                } else if (this.dipping && sequence.holdSwitch && this.cover.settled(UPDATE_SETTLE_MS)) {
                    sequence.holdSwitch = false; // black: the park switches on the next tick
                }
            }
            if (this.parkIsLoaded()) {
                this.loadingPark = false;
                this.releaseSwitch();
                this.parkTicks = 0;
                this.refitLoaded();
                this.applySpeed(); // loading a park resets the game speed to 1
                this.showView(false, "load");
                this.cover.fadeTo(0);
            }
            return;
        }
        const advancing = !this.holding && this.playing();
        const elapsed = Date.now() - this.viewStarted;
        if (advancing && !this.panPlanned) {
            this.planPan();
        }
        // A view the camera is panning away from to a cut-in ends as the pan arrives, effect or not.
        if (advancing && elapsed >= this.currentHold() * 1000 && !this.onPath() && (!!this.pendingCue || !this.onCue())) {
            if (!this.pendingCue && this.chainCut()) {
                return;
            }
            this.next(true);
        } else if (advancing && !this.soundsFaded && !this.pan && this.msLeft(elapsed) <= SOUND_FADE_MS) {
            this.soundsFaded = true;
            fadeSounds(this.sequence, 0, SOUND_FADE_MS);
        } else if (!advancing && this.soundsFaded) {
            // Held or opened in the editor during the fade-out: bring the sounds back
            this.soundsFaded = false;
            fadeSounds(this.sequence, 1, SOUND_FADE_MS);
        }
    }

    /** `byPlayback`: playback moved on by itself (not a key). */
    next(byPlayback = false): void {
        if (this.pendingCue && this.divertTo >= 0) {
            this.viewPos = this.divertTo; // the editor's preview arrives at a cut-in it lists in place
            this.divertTo = -1;
            this.showView(byPlayback, "cutin");
            return;
        }
        this.dropCut();
        if (this.editing || (byPlayback && this.loopsAlone())) {
            // Previewing in the editor, or a park playing alone: its views loop, panning from the
            // last back to the first, and the park never changes. The editor lists cut-in views
            // in place; its preview plays them when cued, as playback does, and passes them by.
            this.viewPos = this.nextInLoop(this.viewPos);
            this.showView(byPlayback, "loop");
        } else if (this.viewPos + 1 < this.viewOrder.length) {
            this.viewPos++;
            this.showView(byPlayback, "next");
        } else {
            this.nextPark();
        }
    }

    /** The position after `pos` in a looping park, past any cut-in view the editor lists in place. */
    private nextInLoop(pos: number): number {
        const n = this.viewOrder.length;
        for (let k = 1; k <= n; k++) {
            const next = (pos + k) % n;
            if (!(this.editing && this.previewing && this.views[this.viewOrder[next]]?.cue?.cut)) {
                return next;
            }
        }
        return n > 0 ? (pos + 1) % n : 0;
    }

    previous(): void {
        if (this.dropCut()) {
            this.showView(false, "uncut"); // back to the view the cut interrupted
        } else if (this.viewPos > 0) {
            this.viewPos--;
            this.showView(false, "previous");
        } else {
            this.previousPark(true);
        }
    }

    nextPark(): void {
        const pos = this.upNext ?? (this.parkPos + 1) % this.parkOrder.length;
        if (this.settings.shuffle) {
            this.history.push(this.parkPos);
        }
        this.enterPark(pos, false);
    }

    previousPark(atLastView = false): void {
        const pos = (this.settings.shuffle ? this.history.pop() : undefined) ??
            (this.parkPos - 1 + this.parkOrder.length) % this.parkOrder.length;
        this.enterPark(pos, atLastView);
    }

    /** Shuffle picks the next park at random from those not played yet this round (every park
     * plays once per round); it only changes the order of parks, never of a park's views. */
    private pickNext(): void {
        this.upNext = undefined;
        if (!this.settings.shuffle || this.parkOrder.length < 2) {
            return;
        }
        this.unplayed.delete(this.parkPos);
        if (this.unplayed.size === 0) {
            this.unplayed = new Set(range(this.parkOrder.length).filter(p => p !== this.parkPos));
        }
        const pool = [...this.unplayed];
        this.upNext = pool[context.getRandom(0, pool.length)];
    }

    toggleHold(): void {
        this.holding = !this.holding;
        if (this.holding) {
            this.heldAt = Date.now();
        } else if (this.pan) {
            // A panning view carries on where it was held
            const held = Date.now() - this.heldAt;
            this.viewStarted += held;
            this.panStarted += held;
        } else {
            this.viewStarted = Date.now(); // a released view gets its full hold time again
        }
        log(this.holding ? "holding view" : "released view");
    }

    toggleShuffle(): void {
        this.settings.shuffle = !this.settings.shuffle;
        saveSettings(this.settings);
        // The current park plays on; a new round starts from it.
        this.unplayed.clear();
        this.history = [];
        this.pickNext();
        log(`shuffle ${this.settings.shuffle ? "on" : "off"}`);
    }

    changeSpeed(delta: number): void {
        const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, this.settings.speed + delta));
        if (speed !== this.settings.speed) {
            this.settings.speed = speed;
            saveSettings(this.settings);
        }
        this.applySpeed();
        log(`speed ${speed}`);
    }

    setEditing(on: boolean): void {
        this.editing = on;
        this.previewing = false;
        // The editor lists every view, cut-in views in place (so selecting one shows it);
        // playback leaves them out of the order again.
        const current = this.viewOrder[this.viewPos];
        this.pendingCue = undefined; // a cut-in under way ends
        this.divertTo = -1;
        this.viewOrder = this.makeViewOrder();
        const pos = this.viewOrder.indexOf(current);
        this.viewPos = pos >= 0 ? pos : Math.min(this.viewPos, Math.max(0, this.viewOrder.length - 1));
        this.clearPan(); // the editor moves the camera; a pan is planned again once it closes
        if (!on) {
            this.viewStarted = Date.now();
        }
    }

    /** Playback runs: always outside the editor; inside it while previewing, once the wait after
     * the last edit is over (the view's hold starts then, see restartPreview). */
    private playing(): boolean {
        return !this.editing || (this.previewing && Date.now() >= this.viewStarted);
    }

    /** The current park's views loop on their own: in the editor's preview, or when the playlist
     * has one park. */
    private loopsAlone(): boolean {
        return this.editing || this.parkOrder.length === 1 || this.timelineAhead();
    }

    /** A cut-in view on the park's clock (a timeline cue) is still to come this visit: the park's
     * views loop on until it has played, rather than the park changing before its moment. */
    private timelineAhead(): boolean {
        return this.views.some((v, i) => v.cue?.cut && v.cue.tick !== undefined && !v.cue.every && !this.cutsDone.has(i) &&
            this.parkTicks < v.cue.tick + v.cue.ticks);
    }

    get isPreviewing(): boolean {
        return this.previewing;
    }

    /** Editor: plays the park's views with their pans (looping in the park), or stops. */
    setPreview(on: boolean, from = this.viewOrder[this.viewPos] ?? 0): void {
        this.previewing = on && this.editing;
        if (this.previewing) {
            this.restartPreview(from);
        } else {
            this.clearPan();
        }
    }

    /** Editor: shows view `from` and plays on from it `delayMs` from now (an edit restarts it). */
    restartPreview(from: number, delayMs = PREVIEW_DELAY_MS): void {
        if (!this.previewing) {
            return;
        }
        const pos = this.viewOrder.indexOf(from);
        this.viewPos = pos >= 0 ? pos : 0;
        this.showView(false, "preview");
        this.viewStarted = Date.now() + delayMs; // the hold starts after the wait
    }

    get parkNames(): string[] {
        return this.playlist.parks.map(p => p.name);
    }

    /** Playlist indices of the parks in play order (the view editor's Playlist order). */
    get playOrder(): number[] {
        return [...this.parkOrder];
    }

    /** How many views each park has (by playlist index): its edits', else the playlist's. */
    viewCountOf(index: number): number {
        if (index === this.parkIndex && !this.loadingPark) {
            return this.views.length;
        }
        const park = this.playlist.parks[index];
        const edit = park?.key !== undefined ? this.edits[park.key] : undefined;
        return edit?.views?.length ?? (edit?.reset ? park.defaultViews?.length : undefined) ?? park?.views.length ?? 0;
    }

    /** The play order from the editor's saved order (parks it does not name keep theirs, after it). */
    private orderFromProps(): number[] {
        const parks = this.playlist.parks;
        const order = this.props.order ?? [];
        const rank = (i: number) => {
            const r = order.indexOf(parks[i].key ?? parks[i].fileName);
            return r < 0 ? order.length + i : r;
        };
        return range(parks.length).sort((a, b) => rank(a) - rank(b));
    }

    /** Moves a park in the play order (positions), keeping the park on screen; saved at once. */
    moveParkInOrder(from: number, to: number): void {
        const n = this.parkOrder.length;
        if (from === to || from < 0 || to < 0 || from >= n || to >= n) {
            return;
        }
        const current = this.parkOrder[this.parkPos];
        const [moved] = this.parkOrder.splice(from, 1);
        this.parkOrder.splice(to, 0, moved);
        this.parkPos = this.parkOrder.indexOf(current);
        this.unplayed.clear(); // shuffle's round starts again from here
        this.history = [];
        this.pickNext();
        const order = this.parkOrder.map(i => this.playlist.parks[i].key ?? this.playlist.parks[i].fileName);
        this.props.order = order;
        this.savedProps.order = order;
        savePlaylistProps(this.playlist.sequence, this.savedProps);
    }

    get sequenceName(): string {
        return this.playlist.sequence;
    }

    /** The playlist's own values for the editor's Playlist properties, as built. */
    get playlistDefaults(): Required<Omit<PlaylistProps, "order">> {
        const p = this.playlist;
        return {
            inertia: p.inertia ?? this.settings.inertia,
            panChanges: p.panChanges ?? this.settings.panChanges,
            changeHold: p.changeHold ?? this.settings.changeHold,
            arriveHold: p.arriveHold ?? this.settings.arriveHold,
            returnHold: p.returnHold ?? this.settings.returnHold,
            titleMusic: this.installedMusic,
            titles: p.titles ?? null,
        };
    }

    private installedMusic: "ride" | "theme" | "keep" = "keep";

    /** The title music the install set (settings.titleMusic as playback started), for the editor. */
    noteInstalledMusic(music: Settings["titleMusic"]): void {
        this.installedMusic = music === "ride" || music === "theme" ? music : "keep";
    }

    /** The Playlist properties in force: the editor's over the playlist's own. */
    get playlistProps(): Required<Omit<PlaylistProps, "order">> {
        const d = this.playlistDefaults;
        const p = this.props;
        return {
            inertia: p.inertia ?? d.inertia, panChanges: p.panChanges ?? d.panChanges,
            changeHold: p.changeHold ?? d.changeHold, arriveHold: p.arriveHold ?? d.arriveHold,
            returnHold: p.returnHold ?? d.returnHold, titleMusic: p.titleMusic ?? d.titleMusic,
            titles: p.titles !== undefined ? p.titles : d.titles,
        };
    }

    /** Changes a Playlist property: in force at once (from the next pan), saved with savePlaylistProps. */
    setPlaylistProp<K extends keyof PlaylistProps>(key: K, value: PlaylistProps[K]): void {
        this.props[key] = value;
        if (key === "titleMusic" || key === "titles") {
            if (key === "titleMusic") {
                this.settings.titleMusic = (value ?? this.installedMusic) as Settings["titleMusic"];
            } else {
                this.settings.titlesOverride = (value === undefined ? this.playlist.titles : value ?? undefined) as Settings["titlesOverride"];
            }
            return;
        }
        this.clearPan(); // planned again with the new motion
    }

    /** The Playlist properties differ from what is saved in the game's storage. */
    get playlistPropsUnsaved(): boolean {
        return JSON.stringify(this.props) !== JSON.stringify(this.savedProps);
    }

    savePlaylistProps(): void {
        this.savedProps = { ...this.props };
        savePlaylistProps(this.playlist.sequence, this.savedProps);
        saveSettings(this.settings); // the title music applies on entering the mode from the settings
    }

    /** When the playlist was built and installed (ms since 1970), if known. */
    get builtAt(): number | undefined {
        return this.playlist.built;
    }

    get installedAt(): number | undefined {
        return this.playlist.installed;
    }

    /** The current park's key (its edits, checkpoints), or undefined if it cannot be edited. */
    get parkKey(): string | undefined {
        return this.currentPark()?.key;
    }

    /** The current park's views were set by hand at install (its views file): "Last install" differs
     *  from "Generated". */
    get installedHandSet(): boolean {
        return this.currentPark()?.handSet === true;
    }

    /** The views the park would play without the editor's edits: the playlist's own ("Generated", or
     *  with `installed` the views as installed, hand-set ones included). */
    baseViews(installed = false): View[] {
        const park = this.currentPark();
        if (!park || park.key === undefined) {
            return [];
        }
        const saved = this.edits[park.key];
        delete this.edits[park.key];
        if (!installed && park.handSet) {
            this.edits[park.key] = { reset: true };
        }
        try {
            return this.viewsFor(park, !this.loadingPark);
        } finally {
            if (saved) {
                this.edits[park.key] = saved;
            } else {
                delete this.edits[park.key];
            }
        }
    }

    /** Drops the editor's edits of the current park, back to its views as installed. */
    restoreInstalled(): void {
        const park = this.currentPark();
        if (park.key === undefined || !this.edits[park.key]) {
            return;
        }
        delete this.edits[park.key];
        saveEdits(this.edits);
        this.views = this.viewsFor(park);
        this.viewOrder = this.makeViewOrder();
        this.viewPos = 0;
        this.showView(false, "revert");
    }

    /** Playlist index of the current park. */
    get parkIndex(): number {
        return this.parkOrder[this.parkPos];
    }

    get isLoading(): boolean {
        return this.loadingPark;
    }

    /** The current park's views in playlist order (as fitted, unless set in the editor). */
    get currentViews(): View[] {
        return this.views;
    }

    /** Index into currentViews of the view on screen. */
    get viewIndex(): number {
        return this.viewOrder[this.viewPos] ?? -1;
    }

    /** What the park name captions show, and whether the park's first view (its overview) is on
     * screen or being panned back to; undefined while a park loads. */
    get caption(): { key: string; name: string; author?: string; firstView: boolean } | undefined {
        if (this.loadingPark || !this.running) {
            return undefined;
        }
        const park = this.currentPark();
        if (!park) {
            return undefined;
        }
        const returning = this.panReturning && this.panMoving;
        return { key: park.key ?? park.name, name: park.name, author: park.author, firstView: this.viewPos === 0 || returning };
    }

    /** True when the current park's views were set in the editor. */
    get isEdited(): boolean {
        const park = this.currentPark();
        const edit = park.key !== undefined ? this.edits[park.key] : undefined;
        return edit ? !edit.reset : park.handSet === true;
    }

    get canEdit(): boolean {
        return this.currentPark().key !== undefined;
    }

    goToPark(index: number): void {
        const pos = this.parkOrder.indexOf(index);
        if (pos >= 0 && pos !== this.parkPos) {
            this.enterPark(pos, false);
        }
    }

    showViewAt(index: number): void {
        const pos = this.viewOrder.indexOf(index);
        if (pos >= 0) {
            this.viewPos = pos;
            this.showView(false, "select");
        }
    }

    /** Replaces the current park's views with hand-set ones and saves them; `show` is displayed. */
    setViews(views: View[], show = -1, arranged = false): void {
        const key = this.currentPark().key;
        if (key === undefined) {
            return;
        }
        // Only a real change is saved: opening the editor or reselecting a view pins nothing.
        if (JSON.stringify(views) !== JSON.stringify(this.views) || (arranged && !this.edits[key]?.arranged)) {
            // A park's views stay pinned at install if one was placed by hand or the list was
            // rearranged (reordered, deleted from, holds changed); otherwise they are regenerated.
            // Saved with the window they were set in, so another window keeps their framing.
            const screen: [number, number] = [ui.width, ui.height];
            this.edits[key] = arranged || this.edits[key]?.arranged ? { views, arranged: true, screen } : { views, screen };
            saveEdits(this.edits);
        }
        const current = show >= 0 ? show : this.viewOrder[this.viewPos] ?? 0;
        this.clearPan();
        this.views = views;
        this.viewOrder = range(views.length);
        this.viewPos = Math.max(0, Math.min(views.length - 1, current));
        if (show >= 0) {
            this.showView(false, "edit");
        }
    }

    /** Drops the current park's hand-set views, going back to the playlist's. */
    revertViews(): void {
        const park = this.currentPark();
        if (park.key === undefined || !this.isEdited) {
            return;
        }
        // Views from the views file are dropped from it on the next install.
        if (park.handSet) {
            this.edits[park.key] = { reset: true };
        } else {
            delete this.edits[park.key];
        }
        saveEdits(this.edits);
        this.views = this.viewsFor(this.currentPark());
        this.viewOrder = this.makeViewOrder();
        this.viewPos = 0;
        this.showView(false, "revert");
    }

    /** Camera log: the current pan has reached the next view's spot. */
    private logPanStop(): void {
        this.panArrived = true;
        this.camLog("stop", `peak=${Math.round(this.panPeak)} ticks=${this.panTicks}`);
    }

    /** A camera log line (setting `cameraLog`): ms since the playlist started, an event and its
     * values, read by tools/cameralog.py. */
    private camLog(event: string, values: string): void {
        if (this.settings.cameraLog) {
            log(`camera ${Date.now() - this.camEpoch} ${event} ${values}`);
        }
        perfMark(`${event} ${values}`); // the same events in the engine's perf log, when it writes one
    }

    describe(): string {
        const park = this.currentPark();
        const vp = ui.mainViewport;
        const centre = vp.getCentrePosition();
        return `park ${this.parkPos + 1}/${this.parkOrder.length} "${park?.name}" ` +
            `view ${this.viewPos + 1}/${this.viewOrder.length} ` +
            `${this.loadingPark ? "loading " : ""}${this.holding ? "held " : ""}` +
            `| viewport centre (${Math.round(centre.x / 32)}, ${Math.round(centre.y / 32)}) ` +
            `rot ${vp.rotation} zoom ${vp.zoom} | seq pos ${this.sequence.position} ` +
            `| speed ${context.gameSpeed} shuffle ${this.settings.shuffle}`;
    }

    private currentPark(): ParkEntry {
        return this.playlist.parks[this.parkOrder[this.parkPos]];
    }

    /** The speed tolerance a pan from `view` is held to at each zoom: the view's own threshold,
     * else the park's (as the generator used it), else the settings', all set for the playlist's
     * screen and scaled to the window. */
    private toleranceOf(view: View): (zoom: number) => number {
        const scaling = this.scalingFrom(screenOf(this.playlist.screen) ?? DESIGN_SCREEN);
        if (view.zoomThreshold) {
            const threshold = view.zoomThreshold;
            return scaleTolerance(() => threshold, scaling);
        }
        const [base, step] = this.currentPark().panTolerance
            ?? [this.settings.panTolerance ?? 500, this.settings.panToleranceStep ?? 100];
        return scaleTolerance(zoom => panTolerance(zoom, base, step), scaling);
    }

    /** The game window, in viewport pixels. */
    private window(): Screen {
        return { width: ui.width, height: ui.height };
    }

    /** How views set for `screen` play in the window (none when the setting is off or the
     *  screen is unknown). */
    private scalingFrom(screen: Screen | undefined): Scaling {
        return this.settings.scaleToWindow === false ? NO_SCALING : scalingFor(screen, this.window());
    }

    /** Logs the window against the playlist's screen when it changes (camera log). */
    private logScaling(): void {
        const design = screenOf(this.playlist.screen) ?? DESIGN_SCREEN;
        const scaling = this.scalingFrom(design);
        const text = `window=${ui.width}x${ui.height} design=${design.width}x${design.height} ` +
            `offset=${scaling.offset} scale=${Math.round(scaling.scale * 1000) / 1000}`;
        if (text !== this.scalingLogged) {
            this.scalingLogged = text;
            this.camLog("screen", text);
        }
    }

    /** The share of a view's hold spent panning on to the next view (0: held still, then a cut). */
    panOf(view: View): number {
        return Math.min(1, Math.max(0, view.pan ?? 0));
    }

    panChangesOf(view: View): PanChanges {
        return this.changesSetting(view) === "start" ? "start" : "end";
    }

    /** Where a view's pan changes the angle and zoom: the editor's Playlist property (not on overviews:
     *  they keep their own, owner's rule), else the view's, else the settings'. "off": such a pan cuts. */
    private changesSetting(view: View): PanChanges | "off" {
        return (!view.overview ? this.props.panChanges : undefined) ?? view.panChanges ?? this.settings.panChanges;
    }

    inertiaOf(view: View): boolean {
        return (this.props.inertia ?? view.inertia ?? this.settings.inertia) === true;
    }

    /** A pan hold in ms: the playlist's (settings UI, times its time scaling), else the plugin setting's. */
    private holdMs(key: "changeHold" | "arriveHold" | "returnHold", fallback: number): number {
        return Math.max(0, (this.props[key] ?? this.playlist[key] ?? this.settings[key] ?? fallback) * 1000);
    }

    /** Plans the current view's pan to the next view of the park, if it gets one. */
    private planPan(): void {
        this.panPlanned = true;
        this.pan = undefined;
        const view = this.views[this.viewOrder[this.viewPos]];
        // A park's last view pans back to its first (owner, 2026-10-28), zooming out as it goes
        // when the first is wider. When the park loops alone the first view plays on; otherwise
        // the camera holds there `returnHold` before the next park.
        // (The editor's preview passes by the cut-in views it lists in place.)
        const nextPos = this.editing && this.previewing ? this.nextInLoop(this.viewPos) : this.viewPos + 1;
        let next = nextPos > this.viewPos ? this.views[this.viewOrder[nextPos]] : undefined;
        const first = this.views[this.viewOrder[nextPos > this.viewPos ? 0 : nextPos]];
        const returning = !next && !!first && !first.show && this.currentPark()?.returnPan !== false;
        const toParkChange = returning && !this.loopsAlone();
        if (returning) {
            next = first;
        }
        // An event view pans on once its effect is over, when that is known (a cut-in, cued as it
        // arrives) and no other cut-in is due before the pan would end; else it cuts.
        const effectMs = view?.cue ? this.effectLeftMs() : 0;
        if (!view || !next || view === next || view.show || effectMs === undefined || this.panOf(view) === 0) {
            this.camLog("plan", "cut");
            return; // held still, then a cut
        }
        if (this.changesSetting(view) === "off" && (next.rotation !== view.rotation || next.zoom !== view.zoom)) {
            this.camLog("plan", "cut");
            return; // Angle and zoom change "Off": no pan that turns or zooms
        }
        let still = (1 - this.panOf(view)) * view.hold * 1000;
        const cueExtra = Math.max(0, Date.now() - this.viewStarted + effectMs - still); // still counts from the view's start
        still += cueExtra;
        if (view.cue && this.cutDueWithin(still + this.panOf(view) * view.hold * 1000)) {
            this.camLog("plan", "cut");
            return;
        }
        const changeHold = this.holdMs("changeHold", 2);
        const arriveHold = this.holdMs("arriveHold", 1);
        const returnHold = toParkChange ? this.holdMs("returnHold", 2) : 0;
        const tolerance = this.toleranceOf(view);
        const pan = new Pan(poseOf(view), poseOf(next), view.hold * 1000 - (still - cueExtra), tolerance,
            this.panChangesOf(view), this.inertiaOf(view), changeHold, arriveHold, returning);
        if (pan.worthwhile) {
            // A view whose angle or zoom changed as the camera arrived stays still a moment
            // before it pans on, a change as a pan sets off waits a moment before moving (the pan's
            // lead), and a change on arrival waits until the camera has rested a moment at the
            // next spot (its rest): all time added to the view, not taken from it.
            const extra = this.arrivedChanged ? Math.max(0, changeHold - still) : 0;
            still += extra;
            this.bonusMs = extra + cueExtra + pan.lead + pan.rest + returnHold;
            this.pan = pan;
            this.panReturning = returning;
            this.panStarted = this.viewStarted + still;
            const t = pan.travelling;
            this.camLog("plan", `still=${Math.round(still)} lead=${pan.lead} rest=${pan.rest} ` +
                `travel=r${t.rotation}z${t.zoom}${pan.levels.length > 1 ? ` out=${pan.widestZoom}` : ""} ` +
                `speed=${Math.round(pan.speed)} tol=${Math.round(tolerance(pan.widestZoom))} return=${returnHold} hold=${Math.round(this.currentHold() * 1000)}`);
        } else {
            this.camLog("plan", "cut");
        }
    }

    private clearPan(): void {
        if (this.pan && this.panMoving && !this.panArrived && Date.now() - this.panStarted >= this.pan.duration - 100) {
            this.logPanStop(); // the view or park changed on the tick the pan arrived
        }
        this.pan = undefined;
        this.panReturning = false;
        this.panPlanned = false;
        this.panMoving = false;
        this.panArrived = false;
        this.panLast = undefined;
        this.panPeak = 0;
        this.panTicks = 0;
        this.bonusMs = 0;
    }

    /** Event cues, every game tick: cuts in a cued cut-in view, marks the current view's effect
     * as started when its cue fires, and keeps a following camera on its train. */
    private stepCue(): void {
        if (this.settings.cameraLog && this.parkTicks % CAR_CHECK_TICKS === 0) {
            this.logTriggers();
        }
        if (this.holding || (this.editing && !this.previewing) || !this.playing()) {
            return;
        }
        const index = this.viewOrder[this.viewPos];
        const view = this.views[index];
        // A cut-in view interrupts any view but a show or an event view of its own; a timeline
        // cut-in also interrupts another cut-in whose effect has started, so a timeline's events
        // follow one another by pans, without a return to the ordinary views between them.
        // It gets CUT_STAY_S on screen first (or its whole effect, if shorter): overlapping effects
        // (Base X's Break Ice 1 and 2, Void's repaints) left one after 26 ms, seen only on the way in.
        const effectEnd = view?.cue && this.cueAt !== undefined ? this.cueAt + view.cue.ticks : 0;
        const afterCut = !!view?.cue?.cut && this.cueAt !== undefined && this.parkTicks >= this.cueAt &&
            (Date.now() - this.viewStarted >= CUT_STAY_S * 1000 || this.parkTicks >= effectEnd);
        if (view && !view.show && (!view.cue || afterCut) && !this.pendingCue) {
            for (const [i, v] of this.views.entries()) {
                if (v.cue?.cut && !this.cutsDone.has(i) && (!view.cue || v.cue.tick !== undefined)) {
                    const fired = this.cueFires(v.cue);
                    // A repeating timeline cut-in whose effect has mostly run (another event view
                    // held it up: Void's cues 0.6 s apart) waits for its next lap instead.
                    if (fired && v.cue.tick !== undefined && v.cue.every &&
                        fired.at + v.cue.ticks - this.parkTicks < LATE_MIN_TICKS && fired.at < this.parkTicks) {
                        continue;
                    }
                    if (fired) {
                        this.cutsDone.add(i);
                        this.cutIn(i, fired);
                        return;
                    }
                }
            }
        }
        const cue = view?.cue;
        if (!cue) {
            return;
        }
        if (this.cueAt === undefined) {
            const fired = this.cueFires(cue);
            if (fired) {
                this.cueAt = fired.at;
                this.cueTrain = fired.train;
                if (this.soundsFaded) {
                    // Cued just as the view was giving up: it plays on, so do its sounds
                    this.soundsFaded = false;
                    fadeSounds(this.sequence, 1, SOUND_FADE_MS);
                }
                this.camLog("cue", `fired tick=${this.parkTicks} start=${fired.at} ticks=${cue.ticks}${fired.train !== undefined ? ` train=${fired.train}` : ""}`);
                if (!this.pendingCue) {
                    this.clearPan();
                    this.panPlanned = false; // its end is known now: it can pan on after the effect
                }
            }
        } else if (cue.follow !== undefined && !this.pendingCue && this.parkTicks >= this.cueAt && this.parkTicks < this.cueAt + cue.ticks) {
            // (Not while the camera pans away to a cut-in: the pan moves it. Base X's ice views
            // flipped between the two every tick, 2026-10-30.)
            this.followTrain(view, cue);
        }
    }

    /** Camera log: each time a car arrives on a car cue's tiles, whichever view is on screen, so a
     * measuring run gives each trigger's first tick and lap (tools/cameralog.py --triggers). */
    private logTriggers(): void {
        for (const [i, v] of this.views.entries()) {
            if (!v.cue || v.cue.tick !== undefined || (v.cue.ride === undefined && !v.cue.cars)) {
                continue;
            }
            let on = false;
            try {
                on = carOnTiles(v.cue) !== undefined;
            } catch (e) {
                on = false;
            }
            if (on && !this.triggersIn.has(i)) {
                this.camLog("trigger", `view=${i + 1} tick=${this.parkTicks} | ${v.animation ?? ""} | ${this.currentPark()?.name ?? ""}`);
            }
            if (on) {
                this.triggersIn.add(i);
            } else {
                this.triggersIn.delete(i);
            }
        }
    }

    /** Milliseconds until the current event view's effect and its tail are over, once its cue
     * has fired; undefined while it waits. */
    private effectLeftMs(): number | undefined {
        const cue = this.views[this.viewOrder[this.viewPos]]?.cue;
        if (!cue || this.cueAt === undefined) {
            return undefined;
        }
        return Math.max(0, (this.cueAt + cue.ticks + CUE_TAIL_TICKS - this.parkTicks) * 1000 / TICKS_PER_SECOND);
    }

    /** Another timeline cut-in's lead begins within `ms` (and CHAIN_S): better to wait for it here. */
    private cutDueWithin(ms: number): boolean {
        const current = this.viewOrder[this.viewPos];
        return this.views.some((v, i) => {
            if (i === current || !v.cue?.cut || v.cue.tick === undefined || this.cutsDone.has(i)) {
                return false;
            }
            const start = nextOccurrence(v.cue, this.parkTicks);
            const from = start - (v.cue.lead ?? 0) * TICKS_PER_SECOND;
            return from - this.parkTicks <= (ms / 1000 + CHAIN_S) * TICKS_PER_SECOND;
        });
    }

    /** A cut-in view ending shortly before another timeline cut-in's lead begins: pans on to that
     * one now, with the longer lead, rather than cutting to an ordinary view for a moment (Void,
     * 2026-10-30: one flashed between two cut-ins). True if it did. */
    private chainCut(): boolean {
        const view = this.views[this.viewOrder[this.viewPos]];
        if (!view?.cue?.cut || this.editing) {
            return false;
        }
        for (const [i, v] of this.views.entries()) {
            if (v !== view && v.cue?.cut && v.cue.tick !== undefined && !this.cutsDone.has(i)) {
                const fired = this.cueFires(v.cue, CHAIN_S);
                if (fired && fired.at >= this.parkTicks) {
                    this.cutsDone.add(i);
                    this.cutIn(i, fired);
                    return true;
                }
            }
        }
        return false;
    }

    /** The cue's effect starts at park tick `at` (now, for a car), or it has not fired yet. A
     * timeline cue can fire up to `earlyS` seconds before its lead. */
    private cueFires(cue: Cue, earlyS = 0): { at: number; train?: number } | undefined {
        if (cue.tick !== undefined) {
            const start = nextOccurrence(cue, this.parkTicks);
            const from = start - ((cue.lead ?? 0) + earlyS) * TICKS_PER_SECOND;
            return this.parkTicks >= from && this.parkTicks < start + cue.ticks ? { at: start } : undefined;
        }
        if ((cue.ride === undefined && !cue.cars) || this.parkTicks % CAR_CHECK_TICKS !== 0) {
            return undefined;
        }
        let train: number | undefined;
        try {
            train = carOnTiles(cue);
        } catch (e) {
            return undefined; // a ride or car the park no longer has
        }
        return train === undefined ? undefined : { at: this.parkTicks, train };
    }

    /** Plays cut-in view `index` after the view on screen, which is cut short: at once, or with
     * a timeline cue's `lead`, by a pan that arrives as the effect starts. */
    private cutIn(index: number, fired: { at: number; train?: number }): void {
        const view = this.views[index];
        const leadMs = (fired.at - this.parkTicks) * 1000 / TICKS_PER_SECOND;
        // The editor's preview lists cut-in views in place: it goes to the view's own position
        // (and plays on from there) rather than inserting it.
        const inPlace = this.editing ? this.viewOrder.indexOf(index) : -1;
        if (inPlace < 0) {
            this.viewOrder.splice(this.viewPos + 1, 0, index);
        }
        // A timeline cut-in pans there, a late one (held up by another event view) briefly; a
        // car's cue, cued as it happens, cuts.
        const panMs = view.cue?.tick !== undefined ? Math.max(leadMs, DIVERT_MIN_MS) : leadMs;
        if (panMs >= DIVERT_MIN_MS && this.divert(view, panMs)) {
            this.pendingCue = { index, ...fired };
            this.divertTo = inPlace;
            this.camLog("cue", `divert view=${index + 1} tick=${this.parkTicks} start=${fired.at}`);
            return;
        }
        this.viewPos = inPlace >= 0 ? inPlace : this.viewPos + 1;
        this.showView(true, "cutin");
        this.cueAt = fired.at;
        this.cueTrain = fired.train;
        this.camLog("cue", `cut view=${index + 1} tick=${this.parkTicks} start=${fired.at}`);
    }

    /** Pans from where the camera is now to `view`, ending the current view as it arrives; false
     * when the pan is not worth it (then the caller cuts). */
    private divert(view: View, ms: number): boolean {
        const current = this.views[this.viewOrder[this.viewPos]];
        if (!current) {
            return false;
        }
        const now = Date.now();
        const from = this.pan ? this.pan.at(now - this.panStarted) : this.followAt ?? poseOf(current);
        const changeHold = this.holdMs("changeHold", 2);
        const arriveHold = this.holdMs("arriveHold", 1);
        const pan = new Pan(from, poseOf(view), Math.max(MIN_DIVERT_MOVE_MS, ms - arriveHold), this.toleranceOf(current),
            this.panChangesOf(current), this.inertiaOf(current), changeHold, arriveHold);
        if (!pan.worthwhile) {
            return false;
        }
        this.clearPan();
        this.pan = pan;
        this.panPlanned = true;
        this.panStarted = now;
        // The current view ends as the pan arrives (its hold counted from viewStarted).
        this.viewStarted = now + pan.duration - current.hold * 1000;
        return true;
    }

    /** Leaving a cut-in view: it comes out of the view order again, so playback goes on from the
     * view it interrupted. True if the current view was one. */
    private dropCut(): boolean {
        const view = this.views[this.viewOrder[this.viewPos]];
        if (!view?.cue?.cut || this.editing) {
            return false;
        }
        this.viewOrder.splice(this.viewPos, 1);
        this.viewPos--;
        return true;
    }

    /** Eases the camera toward the train an event view follows. */
    private followTrain(view: View, cue: Cue): void {
        const car = trainHead(cue.follow!, cue.follow === cue.ride ? this.cueTrain : undefined, cue.train);
        if (!car) {
            return;
        }
        const at = this.followAt ?? poseOf(view);
        this.followAt = {
            ...at,
            x: at.x + (car.x - at.x) * FOLLOW_EASE,
            y: at.y + (car.y - at.y) * FOLLOW_EASE,
            z: at.z + (car.z - at.z) * FOLLOW_EASE,
        };
        this.applyPose(this.followAt);
    }

    /** True while an event view waits for its cue (at most `wait` past its hold) or its effect
     * runs (at most twice the time it should take, in case ticks stop). */
    private onCue(): boolean {
        const view = this.views[this.viewOrder[this.viewPos]];
        const cue = view?.cue;
        if (!cue) {
            return false;
        }
        const elapsed = Date.now() - this.viewStarted;
        const wait = (cue.wait ?? CUE_WAIT_S) * 1000;
        if (this.cueAt === undefined) {
            // A timeline cue already past for this visit never fires: the view plays its hold.
            const missed = cue.tick !== undefined && !cue.every && this.parkTicks >= cue.tick + cue.ticks;
            return !missed && elapsed < view.hold * 1000 + wait;
        }
        const left = this.cueAt + cue.ticks + CUE_TAIL_TICKS - this.parkTicks;
        return left > 0 && elapsed < (view.hold + wait / 1000 + (cue.ticks + CUE_TAIL_TICKS) / TICKS_PER_SECOND) * 2000;
    }

    /** Milliseconds the current view has left as far as is known now (an event view's effect
     * not yet cued counts as its wait running out). */
    private msLeft(elapsed: number): number {
        const view = this.views[this.viewOrder[this.viewPos]];
        const left = this.currentHold() * 1000 - elapsed;
        const cue = view?.cue;
        if (!cue || !this.onCue()) {
            return left;
        }
        if (this.cueAt === undefined) {
            return view.hold * 1000 + (cue.wait ?? CUE_WAIT_S) * 1000 - elapsed;
        }
        return Math.max(left, (this.cueAt + cue.ticks + CUE_TAIL_TICKS - this.parkTicks) * 1000 / TICKS_PER_SECOND);
    }

    /** True while a show view's camera has yet to reach the end of its path: game ticks can run
     * slower than the hold's clock, and the view stays until the camera arrives (at most twice
     * its hold, in case ticks stop). */
    private onPath(): boolean {
        const view = this.views[this.viewOrder[this.viewPos]];
        return !!view?.path && this.pathTicks < pathArrival(view) && Date.now() - this.viewStarted < view.hold * 2000;
    }

    private currentHold(): number {
        const view = this.views[this.viewOrder[this.viewPos]];
        return view ? view.hold + this.bonusMs / 1000 : 10;
    }

    private applySpeed(): void {
        const speed = this.settings.speed;
        if (speed === context.gameSpeed) {
            return;
        }
        context.executeAction("gamesetspeed", { speed }, result => {
            if (result.error) {
                log(`could not set speed ${speed}: ${result.errorMessage ?? result.error}`);
            }
        });
    }

    private makeViewOrder(): number[] {
        const order = this.buildViewOrder();
        this.camLog("order", `views=${this.views.length} order=${order.join(",")} cuts=${this.views.filter(v => v.cue?.cut).length}` +
            `${this.editing ? " editing" : ""} | ${this.currentPark()?.name ?? ""}`);
        return order;
    }

    private buildViewOrder(): number[] {
        // Animation views follow the others and a show comes last, in the playlist's order,
        // unless it says where it goes (showAt: an index into the park's views, -1 the last).
        // Cut-in views (cue.cut) play out of turn, when cued; the editor lists them in place,
        // where they are expected to play (placeCuts).
        const order = range(this.views.length).filter(i => this.editing || !this.views[i].cue?.cut);
        const inPlace = (v: View) => !isPinned(v) || (this.editing && !!v.cue?.cut);
        const free = order.filter(i => inPlace(this.views[i]));
        const pinned = order.filter(i => !inPlace(this.views[i]) && !this.views[i].show);
        const shows = order.filter(i => this.views[i].show);
        const out = [...free, ...pinned];
        for (const i of shows) {
            const at = this.views[i].showAt ?? -1;
            out.splice(Math.max(0, Math.min(out.length, at < 0 ? out.length + 1 + at : at)), 0, i);
        }
        return out;
    }

    /** A companion reports that the show started by the current view has reached a step: a
     * camera path waiting for that step (pathStep) sets off. */
    showStep(name: string, step: number): void {
        const view = this.views[this.viewOrder[this.viewPos]];
        if (view?.show?.name === name && view.pathStep !== undefined && step >= view.pathStep) {
            this.pathStarted = true;
        }
    }

    /** A companion reports that the show started by the current view is over. */
    showDone(name: string): void {
        const view = this.views[this.viewOrder[this.viewPos]];
        if (view?.show?.name !== name) {
            return;
        }
        log(`show "${name}" finished`);
        if (view.path && this.pathStarted && this.pathTicks < pathArrival(view)) {
            this.showOver = true; // the camera is still on its way: leave once it arrives (stepPath)
            return;
        }
        this.leaveShow();
    }

    /** Leaves the show view shortly, unless its hold runs out first. */
    private leaveShow(): void {
        const view = this.views[this.viewOrder[this.viewPos]];
        this.showOver = false;
        this.viewStarted = Math.min(this.viewStarted, Date.now() - (view.hold * 1000 - SHOW_TAIL_MS));
    }

    /** Which of a park's orders (its views, or one of `variants`) plays on the current visit:
     *  the first visit ever plays the cheapest order and each later visit the next
     *  (circuit_variants); the visit count persists in storage across runs. */
    private visits: Visits = loadVisits();
    private variantOf(park: ParkEntry, advance: boolean): { views: View[]; parkTime?: number } {
        const count = 1 + (park.variants?.length ?? 0);
        if (count < 2 || park.handSet || this.settings.bench) {
            return park;
        }
        const key = park.key ?? park.fileName;
        let visit = this.visits[key];
        if (visit === undefined) {
            visit = 0;
            this.visits[key] = visit;
            saveVisits(this.visits);
        } else if (advance) {
            visit += 1;
            this.visits[key] = visit;
            saveVisits(this.visits);
        }
        const pick = visit % count;
        return pick === 0 ? park : park.variants![pick - 1];
    }

    /** The park's views; `loaded` once the park is on the map, so it can be measured; `advance`
     *  on entering the park, which moves it to its next order. */
    private viewsFor(park: ParkEntry, loaded = false, advance = false): View[] {
        this.logScaling();
        const edited = park.key !== undefined ? this.edits[park.key] : undefined;
        // Hand-set views keep their framing in a window of another size: whole zoom levels out
        // (or in) for the window they were set in, if it is known.
        if (edited?.views) {
            return scaleViews(edited.views, this.scalingFrom(screenOf(edited.screen)));
        }
        if (park.handSet && !edited?.reset) {
            return scaleViews(park.views, this.scalingFrom(screenOf(park.viewScreen)));
        }
        const variant = this.variantOf(park, advance);
        if (advance && variant !== park) {
            this.camLog("variant", `${(this.visits[park.key ?? park.fileName] ?? 0) % (1 + (park.variants?.length ?? 0)) + 1}/${1 + (park.variants?.length ?? 0)}`);
        }
        const scaling = this.scalingFrom(screenOf(this.playlist.screen) ?? DESIGN_SCREEN);
        // A cue without an effect length (Base X's fountains: an endless animation) has none:
        // left undefined, its timeline window was NaN and it never fired (2026-10-30).
        const all = scaleViews(park.handSet ? park.defaultViews ?? [] : variant.views, scaling)
            .map(v => v.cue && typeof v.cue.ticks !== "number" ? { ...v, cue: { ...v.cue, ticks: 0 } } : v);
        if (!park.bounds) {
            return placeCuts(all);
        }
        // Views on a companion's animations or shows are placed exactly and add their own time.
        const views = all.filter(v => !isPinned(v));
        const pinned = all.filter(isPinned);
        const measure = loaded ? measureLoaded(park.bounds) : undefined;
        const fitted = fitViews(views, park.bounds, this.window(), park.viewCount, measure, scaling.offset);
        // Fitting can merge or add views: keep the park's total time, shared as the holds were.
        const total = fitted.reduce((s, v) => s + v.hold, 0);
        const parkTime = variant.parkTime ?? park.parkTime;
        if (parkTime && total > 0 && Math.abs(total - parkTime) > 0.5) {
            return placeCuts([...fitted.map(v => ({ ...v, hold: Math.round(v.hold * parkTime / total * 10) / 10 })), ...pinned]);
        }
        return placeCuts([...fitted, ...pinned]);
    }

    /** Fits the current park's views again now that its elements can be measured. */
    private refitLoaded(): void {
        const views = this.viewsFor(this.currentPark(), true);
        const resized = views.length !== this.views.length;
        this.views = views;
        if (resized) {
            this.viewOrder = this.makeViewOrder();
            this.viewPos = Math.min(this.viewPos, Math.max(0, views.length - 1));
        }
    }

    private enterPark(pos: number, atLastView: boolean): void {
        // Re-entering the loaded park (only one park, or back again before the switch happened).
        const sameAsLoaded = !this.loadingPark && this.parkIsLoaded(pos);
        this.clearPan();
        this.cutsDone.clear();
        this.triggersIn.clear();
        this.pendingCue = undefined;
        this.parkPos = pos;
        this.pickNext();
        const park = this.currentPark();
        this.views = this.viewsFor(park, false, !sameAsLoaded);
        this.viewOrder = this.makeViewOrder();
        this.viewPos = atLastView ? Math.max(0, this.viewOrder.length - 1) : 0;
        if (sameAsLoaded) {
            this.loadingPark = false;
            this.refitLoaded();
            this.cover.fadeTo(0);
            this.applySpeed();
            this.showView(false, "reenter");
            return;
        }
        log(`park ${pos + 1}/${this.parkOrder.length}: ${park.name}`);
        perfMark(`park ${pos + 1}/${this.parkOrder.length} ${park.name}`);
        this.loadingPark = true;
        // A park change always waits for a load, so the old park's sounds can fade out meanwhile,
        // also when a key started it (a scheduled change has faded them already)
        if (!this.soundsFaded) {
            this.soundsFaded = true;
            fadeSounds(this.sequence, 0, SOUND_FADE_MS);
        }
        if (this.dip) {
            // The next park is read while this one plays; the cover comes once it is ready.
            this.dipping = false;
            (this.sequence as unknown as HoldableSequence).holdSwitch = true;
        }
        this.seekToPark();
    }

    private seekToPark(): void {
        const park = this.currentPark();
        this.seeked = Date.now();
        try {
            this.sequence.seek(park.load);
        } catch (e) {
            log(`failed to load "${park.name}": ${e}`);
            this.skipFailedPark();
        }
    }

    /** Lets a held park switch go (the dip's cover, if any, fades out with the load). */
    private releaseSwitch(): void {
        this.dipping = false;
        if (this.dip && this.sequence.isPlaying) {
            (this.sequence as unknown as HoldableSequence).holdSwitch = false;
        }
    }

    /** Shows the next park after a failed load, rather than waiting on a black screen. */
    private skipFailedPark(): void {
        this.loadingPark = false;
        this.releaseSwitch();
        this.cover.fadeTo(0);
        if (this.parkOrder.length > 1) {
            this.nextPark();
        } else {
            // Nothing else to show: the current park plays on, so its sounds come back
            this.soundsFaded = false;
            fadeSounds(this.sequence, 1, SOUND_FADE_MS);
        }
    }

    /** True once the built-in player has executed this park's LOAD and is idling after it. */
    /** The built-in player has moved past the park's commands without loading it. */
    private loadSkipped(): boolean {
        const position = this.sequence.position;
        const load = this.currentPark().load;
        return position !== null && Date.now() - this.seeked > 500 && (position < load || position >= this.nextLoad(load));
    }

    private nextLoad(load: number): number {
        return Math.min(...this.playlist.parks.map(p => p.load).filter(l => l > load), Infinity);
    }

    private parkIsLoaded(pos = this.parkPos): boolean {
        const position = this.sequence.position;
        if (position === null) {
            return false;
        }
        const load = this.playlist.parks[this.parkOrder[pos]].load;
        return position > load && position < this.nextLoad(load);
    }

    /** `by`: what showed it, for the camera log (diagnosing the order on a park's second visit). */
    private showView(byPlayback = false, by = ""): void {
        const view = this.views[this.viewOrder[this.viewPos]];
        // A pan that has arrived ends on this view, so the camera is already there.
        const panned = this.pan !== undefined && Date.now() - this.panStarted >= this.pan.duration - 100;
        this.arrivedChanged = panned && this.pan!.changesAtEnd;
        this.clearPan();
        this.viewStarted = Date.now();
        this.pathTicks = 0;
        this.showOver = false;
        this.pathStarted = view?.pathStep === undefined;
        this.cueAt = this.cueTrain = this.followAt = undefined;
        if (this.pendingCue && this.pendingCue.index === this.viewOrder[this.viewPos]) {
            this.cueAt = this.pendingCue.at; // a cut-in the camera panned to
            this.cueTrain = this.pendingCue.train;
        }
        this.pendingCue = undefined;
        this.divertTo = -1;
        // A view change the player did not schedule (a key press) cuts the sounds, a pan keeps
        // them (they follow the camera); either way they fade in on the new view.
        this.soundsFaded = false;
        if (!panned) {
            fadeSounds(this.sequence, 0, 0);
        }
        fadeSounds(this.sequence, 1, SOUND_FADE_MS);
        this.onViewShown?.(view, byPlayback);
        this.camLog("view", `park=${this.parkPos + 1} view=${this.viewPos + 1}/${this.viewOrder.length} ` +
            `${panned ? "panned" : "cut"}${view?.overview ? " overview" : ""} hold=${Math.round((view?.hold ?? 0) * 1000)}` +
            `${by ? ` by=${by}` : ""} index=${this.viewOrder[this.viewPos] ?? -1}${view?.cue ? " cue" : ""} | ${this.currentPark()?.name ?? ""}`);
        if (!view) {
            return; // park without views: keep the sequence's own camera
        }
        this.applyPose(poseOf(view));
        if (view.show) {
            const name = view.show.name;
            context.executeAction(view.show.action, { show: name }, result => {
                if (result.error) {
                    log(`show "${name}" not started: ${result.errorMessage ?? result.error}`);
                }
            });
        }
    }

    private applyPose(pose: Pose): void {
        const vp = ui.mainViewport;
        if (vp.rotation !== pose.rotation || vp.zoom !== pose.zoom) {
            this.camLog("change", `r${vp.rotation}z${vp.zoom}>r${pose.rotation}z${pose.zoom}`);
        }
        if (vp.rotation !== pose.rotation) {
            vp.rotation = pose.rotation;
        }
        if (vp.zoom !== pose.zoom) {
            vp.zoom = pose.zoom;
        }
        vp.moveTo({ x: Math.round(pose.x), y: Math.round(pose.y), z: Math.round(pose.z) });
    }
}

function poseOf(view: View): Pose {
    return { x: view.x * 32 + 16, y: view.y * 32 + 16, z: view.z, rotation: view.rotation, zoom: view.zoom };
}

/** Where a show view's camera path is `ticks` game ticks in: on a straight line between the
 * path's points, staying at the last; angle and zoom are the view's own. Without a pan share each
 * point is reached `ticks` after the last, as scheduled. With one, the camera glides through the
 * points at one speed for that share of the path's time, then holds at the end (owner,
 * 2026-10-30: the show view respects its `pan`, and its hold comes at the end). */
export function pathPose(view: View, ticks: number): Pose {
    const path = view.path ?? [];
    const glide = pathGlide(view);
    let x = view.x, y = view.y, z = view.z, left = ticks;
    for (const p of path) {
        const legTicks = glide ? glide.ticks * legLength({ x, y, z }, p) / glide.length : p.ticks;
        if (left < legTicks) {
            const k = left / Math.max(1, legTicks);
            x += (p.x - x) * k;
            y += (p.y - y) * k;
            z += (p.z - z) * k;
            break;
        }
        left -= legTicks;
        x = p.x;
        y = p.y;
        z = p.z;
    }
    return { ...poseOf(view), x: x * 32 + 16, y: y * 32 + 16, z };
}

/** Tiles between two path points (z in height units, 32 to a tile). */
function legLength(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    return Math.hypot(b.x - a.x, b.y - a.y, (b.z - a.z) / 32);
}

/** A show view's glide with a pan share: its length in tiles and its game ticks; undefined
 * when the path runs as scheduled. */
function pathGlide(view: View): { length: number; ticks: number } | undefined {
    const share = view.pan ?? 0;
    let total = 0, length = 0, at = { x: view.x, y: view.y, z: view.z };
    for (const p of view.path ?? []) {
        total += p.ticks;
        length += legLength(at, p);
        at = p;
    }
    return share > 0 && length > 0 ? { length, ticks: Math.max(1, Math.min(1, share) * total) } : undefined;
}

/** Game ticks until a show view's camera reaches the end of its path. */
export function pathArrival(view: View): number {
    const glide = pathGlide(view);
    if (glide) {
        return Math.ceil(glide.ticks);
    }
    let ticks = 0, arrival = 0, at = { x: view.x, y: view.y, z: view.z };
    for (const p of view.path ?? []) {
        ticks += p.ticks;
        if (legLength(at, p) > 0) arrival = ticks;
        at = p;
    }
    return arrival;
}

/** Start tick of a timeline cue's effect still to come or running at `ticks`: its tick, or with
 * `every`, the first repeat that has not ended yet. */
function nextOccurrence(cue: Cue, ticks: number): number {
    const tick = cue.tick!;
    if (!cue.every || ticks < tick + cue.ticks) {
        return tick;
    }
    return tick + Math.ceil((ticks - tick - cue.ticks + 1) / cue.every) * cue.every;
}

/** Head car of a train of `ride` with a car on the cue's tiles (or one of its `cars`, anywhere
 * on its tiles if it has them); undefined when there is none. */
function carOnTiles(cue: Cue): number | undefined {
    const on = (car: Car): boolean => {
        const t = cue.tiles;
        const x = Math.floor(car.x / 32), y = Math.floor(car.y / 32);
        return !t || (x >= Math.min(t[0], t[2]) && x <= Math.max(t[0], t[2]) && y >= Math.min(t[1], t[3]) && y <= Math.max(t[1], t[3]));
    };
    if (cue.cars) {
        for (const id of cue.cars) {
            const car = map.getEntity(id) as Car | null;
            if (car && car.type === "car" && on(car)) {
                return id;
            }
        }
        return undefined;
    }
    const ride = map.getRide(cue.ride!);
    for (const head of ride?.vehicles ?? []) {
        let id: number | null = head;
        // Every car of the train: a long train covers the tiles before its head reaches them.
        for (let n = 0; id !== null && n < 64; n++) {
            const car = map.getEntity(id) as Car | null;
            if (!car) {
                break; // vehicle ids can be stale just after a load
            }
            if (on(car)) {
                return head;
            }
            id = car.nextCarOnTrain;
        }
    }
    return undefined;
}

/** World position of a train's head car: `head` if it still exists, else train `index` of the ride. */
function trainHead(ride: number, head: number | undefined, index = 0): { x: number; y: number; z: number } | undefined {
    const car = head !== undefined ? map.getEntity(head) as Car | null : null;
    if (car) {
        return car;
    }
    const id = map.getRide(ride)?.vehicles[index];
    return id !== undefined ? (map.getEntity(id) as Car | null) ?? undefined : undefined;
}

/** Fades the title screen's sound effects to `level` (0 to 1); only with the patched engine. */
function fadeSounds(sequence: TitleSequence, level: number, ms: number): void {
    const fade = (sequence as unknown as { fadeSounds?: (level: number, ms: number) => void }).fadeSounds;
    if (typeof fade === "function") {
        fade.call(sequence, level, ms);
    }
}

/** True when the engine carries the RCT Screensaver background-loading patch. */
/** A title sequence on an engine with patch 0010: a park read in the background can wait, ready. */
interface HoldableSequence {
    nextParkReady: boolean;
    holdSwitch: boolean;
}

function canHoldSwitch(sequence: TitleSequence): boolean {
    return typeof (sequence as unknown as Partial<HoldableSequence>).nextParkReady === "boolean";
}

function backgroundLoading(sequence: TitleSequence): boolean {
    return (sequence as unknown as { backgroundLoading?: boolean }).backgroundLoading === true;
}
