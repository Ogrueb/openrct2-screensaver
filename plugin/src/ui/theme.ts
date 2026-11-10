// The look of the screensaver mode's own interface (docs/screensaver-ui.md), after the stock main
// menu: square buttons with sharp, bevelled edges on partly transparent backings. Sizes are game
// pixels (the overlay draws them at the window's resolution); colours are "#rrggbbaa".

export const THEME = {
    // The backing strip behind a group of buttons (the stock menu darkens the park behind its row).
    backing: "#0a140e8c",
    // The park name caption's portrait frame: black text on veined marble (80% opaque), the byline on a
    // velvet band below the wood divider (owner, 2026-11-03; its colours in VELVET).
    captionMat: "#00000000", // under the marble cells (which carry the 80% opacity)
    captionTitle: "#000000",
    captionShade: "#00000040", // the engraving's edge in shadow (above and left)
    captionGlint: "#ffffffa0", // and its lit edge (below and right)
    backingLight: "#ffffff1a", // its bevel: top and left edges
    backingDark: "#00000073", // bottom and right edges
    // Buttons: the stock menu's translucent dark green, lighter under the mouse, darker and sunk
    // while pressed or on (a toggle that is on stays sunk, as the game shows a pressed tab).
    face: "#2c5a3a80",
    faceHover: "#4a8a5ca6",
    faceDown: "#16301fb3",
    faceOn: "#3d7a50b3",
    // The other active state of a button with more than two states (titles on every view, the time
    // of day's cycle): the game's translucent olive/yellow.
    faceAlt: "#8a7a2eb3",
    faceAltHover: "#a8963ac0",
    // The speed button's face, green at 1× to orange at 8× in even steps (owner, 2026-11-02).
    speedSlow: "#3d7a50b3",
    speedFast: "#c8782ab3",
    bevelLight: "#ffffff52",
    bevelDark: "#00000099",
    bevel: 1,
    text: "#ffffff",
    textShadow: "#000000c0",
    // The tooltip above a button under the mouse.
    tipBacking: "#000000b8",
    tipText: "#f0f0f0",
    tipSize: 15,
    // The view editor is read, not glanced at: nearly opaque (owner, 2026-11-02).
    editorBacking: "#0a140ee6",
    editorList: "#0d1d13f0",
    warning: "#ff7a6a", // a status that needs action (the editor's "re-run --install")
    // An inactive button (owner, 2026-11-10: flat, pressed in and gray), its text and its icon's opacity.
    faceOff: "#2a2e2c80",
    textOff: "#ffffff5c",
    iconOff: 0.35,
    textDim: "#ffffffa0", // key hints, section labels, times
    textGood: "#8fd6a0", // the editor's "edited · saved in the game"
    dragLine: "#ff6a1a", // where a dragged row goes (the mockups' orange)
    rowDimmed: "#00000099", // over a row being dragged
    dragGhost: "#3f7a51f5", // the dragged row itself, lifted (nearly opaque, over the rows it passes)
    tipPad: 6,
};

/** Sizes of the controls bar, game pixels. ICON_* must match tools/mkicons.py's GAME_SIZES. */
export const BAR = {
    // Halfway from the first sizes (40 and 30) to the stock menu's 82 px buttons (owner, 2026-11-02).
    primary: 61, // button side: previous/next park and view, hold
    secondary: 46, // speed, shuffle, titles, music, settings
    iconPrimary: 34,
    iconSecondary: 24,
    pad: 7, // backing around the buttons
    gap: 3, // between buttons of a row
    rowGap: 6, // between the primary row and the secondary row below it
    bottom: 28, // from the window's bottom edge
    speedText: 18,
};

/** The settings panel above the bar, game pixels. */
export const PANEL = {
    width: 380,
    pad: 12,
    titleSize: 18,
    rowHeight: 32,
    rowGap: 6,
    textSize: 15,
    valueWidth: 180, // the value button or slider at each row's right
    above: 6, // gap between the panel and the bar
};

/** The settings panel's Title frame flyout (owner, 2026-11-03), beside the panel, game pixels. */
export const FLYOUT = {
    beside: 6, // gap between the panel and the flyout
    tileWidth: 132, // a style's tile: its preview over its name
    tileHeight: 96,
    gap: 6,
    previewPad: 6,
    tileLabel: 22, // the name's line at the tile's foot
    labelSize: 13,
    accentLabel: 22, // the "Accent" line above the swatches
    swatchHeight: 28,
    previewName: "Park name",
    previewAuthor: "Builder",
};

/** The view editor's panes (docs/screensaver-ui.md, "Editor"; owner, 2026-11-10), game pixels: the views
 *  pane at the window's top left, the toolbox at its bottom left, the restore points and Playlist
 *  properties at its top right. */
export const EDITOR = {
    x: 16, // every pane's distance from the window's edges
    y: 16,
    width: 540, // the views pane
    pad: 8,
    gap: 3,
    titleHeight: 32,
    titleSize: 17,
    rowHeight: 24,
    visibleRows: 10,
    eventRows: 4, // the event list's rows shown, a scroll bar past that
    eventsGap: 8, // between the route list and the event list
    textSize: 14,
    cellMargin: 14, // added to each list column's widest text
    scrollBar: 12, // a list's scroll bar, when it overflows
    grip: 18, // the drag handle column of the views and parks
    parkRow: 26, // the park dropdown's rows
    dragStart: 5, // pixels the mouse moves before a press on a row drags it
    holdOpen: 300, // ms: a press on the park field held this long opens the list until release
    // The toolbox
    tool: 38, // a tool button's side
    toolIcon: 20, // its icon (tools/mkicons.py GAME_SIZES)
    groupGap: 10,
    labelSize: 11, // VIEW, CAMERA, EVENTS, HOLD, PAN
    labelHeight: 15,
    switchHeight: 34, // Frame | Map
    hintSize: 12,
    hintHeight: 20,
    stepValue: 58, // the hold and pan value between its - and +
    footerGap: 14, // between redo and Reset view
    playWidth: 96,
    // The top-right box
    boxWidth: 420,
    boxRow: 28, // a restore point
    boxRows: 3.5, // restore points shown (a half row says there are more; owner, 2026-11-10)
    boxHead: 12, // the RESTORE POINTS line
    boxButton: 32,
    propRow: 30,
    propHeader: 30,
    segHeight: 24,
    segPad: 10, // each side of a segment's text
    stepButton: 26,
    stepValueBox: 56,
    holdStep: 0.5, // seconds per - or + of the Playlist timing holds
    holdMax: 10,
};

/** Controls bar timings, ms. */
export const TIMING = {
    hideAfter: 2500, // without mouse movement (never while the mouse is over the bar)
    fadeIn: 150,
    fadeOut: 400,
};

/** The caption's velvet band colours (settings.captionBand; tiles from tools/mkframe.py VELVETS) and the
 *  byline's colour on each: gold on the dark ones, dark brown on ivory. */
export const VELVET: Record<string, { text: string; shadow: string }> = {
    green: { text: "#e8c878", shadow: "#00000099" },
    burgundy: { text: "#e8c878", shadow: "#00000099" },
    navy: { text: "#e8c878", shadow: "#00000099" },
    slate: { text: "#ecd9a8", shadow: "#00000099" },
    ivory: { text: "#2a1a0a", shadow: "#ffffff66" },
};

/** The Accent setting (settings.captionBand, the velvet colours by name; owner, 2026-11-03) in the other caption
 *  styles: Minimal light's strip, Aero's glass (tools/mkframe.py AERO_TINTS: its rim, bright line and inner
 *  bevel here, the frost and corners as pieces), Canvas's mat board. */
export const ACCENT: Record<string, { strip: string; mat: string; aero: { rim: string; bright: string; bevel: string } }> = {
    green: { strip: "#2c5a3a", mat: "#284e3a", aero: { rim: "#6fad8ebd", bright: "#e2efe8e6", bevel: "#d7e8e0d9" } },
    burgundy: { strip: "#6e182e", mat: "#62182a", aero: { rim: "#bd677ebd", bright: "#f2e1e5e6", bevel: "#edd5dcd9" } },
    navy: { strip: "#20326e", mat: "#222e5c", aero: { rim: "#6a9fdfbd", bright: "#e1ecf9e6", bevel: "#d6e5f6d9" } },
    slate: { strip: "#465260", mat: "#3e4650", aero: { rim: "#8e9cacbd", bright: "#e8ebeee6", bevel: "#e0e4e8d9" } },
    ivory: { strip: "#c4b48c", mat: "#ece4d0", aero: { rim: "#dfd7bebd", bright: "#f9f7f2e6", bevel: "#f6f4edd9" } },
};

/** The caption styles beyond the portrait frames (owner, 2026-11-03): thickness round the mat (game px), fonts
 *  and text colours. Minimal is rects alone; Aero and Canvas use tools/mkframe.py's pieces. */
export const CAPTION_STYLES = {
    minimalDark: {
        frame: 1, backing: "#0a140ebf", border: "#ffffff40", title: "#ffffff", byline: "#c8d4cc", shadow: "#00000096",
        rule: "#ffffff33",
    },
    minimalLight: { frame: 0, strip: 6, backing: "#f2efe8d9", title: "#161616", byline: "#4a4a4a", rule: "#00000026" },
    aero: {
        frame: 7, // AERO_RIM: outline, bright line, rim; then the inner panel's bevel row
        radius: 8, // AERO_RADIUS: the corner pieces' side
        outline: "#141e32bf",
        title: "#0b1622", byline: "#1d3048", glow: "#ffffff46", glowFar: "#ffffff28", // glow: the text again round itself
        ruleDark: "#00000030", ruleLight: "#ffffffa0",
        frostWidth: 192, frostHeight: 96, // FROST_W x FROST_H
    },
    canvas: {
        frame: 19, // GALLERY (10) + the mat (9)
        gallery: 10,
        bevel: 2, // the mat's cream bevel round the opening, lit edges (bottom, right) and shaded ones (top, left)
        bevelLit: "#f0e8d6", bevelShade: "#d4c8b0", frameShadow: "#0000004d",
        dropShadow: "#00000024", // three steps of it, offset down and right
        title: "#2a1c12", titleGlint: "#fffaeb5a", byline: "#5a4430", rule: "#5a462e50",
        linenWidth: 192, linenHeight: 96, // CANVAS_W x CANVAS_H
    },
    // Fonts (system fonts, patch 0015; the default sans where missing): Segoe UI for Minimal and Aero.
    sans: "segoeui.ttf", sansBold: "segoeuib.ttf", sansItalic: "segoeuii.ttf",
    titleSize: 30, bylineSize: 15,
};

/** The park name caption (ui/captions.ts), game pixels and ms. */
export const CAPTION = {
    margin: 28, // from the window's top and left edges (the bar keeps 28 px from the bottom)
    maxWidth: 560,
    padX: 18,
    padY: 10, // above and below the byline section
    titlePadY: 16, // above and below the title (owner, 2026-11-03: the title takes more of the frame)
    frame: 14, // the gold moulding's width (tools/mkframe.py THICK)
    frameTile: 16, // its edge tiles' length (TILE)
    marbleWidth: 576, // the marble texture's size (MARBLE_W x MARBLE_H): no mat is larger
    marbleHeight: 256,
    velvetWidth: 192, // a velvet tile (VELVET_W x VELVET_H), repeated across the byline's band
    velvetHeight: 96,
    woodPieces: 4, // pieces along the wood strip (WOOD_LEN / 32)
    woodPiece: 32, // each piece's length
    ruleHeight: 9, // the wood divider (WOOD_H), bevelled at its top and bottom
    titleFont: "georgiab.ttf", // a system font (patch 0015); the default sans where it is missing
    titleSize: 34,
    bylineFont: "georgiai.ttf",
    bylineSize: 16,
    fadeOut: 500, // (it fades in with the park: settings.fadeMs)
    barGap: 12, // from the controls bar's backing while it shows (hidden, the bottom placements keep the margin)
    minBeside: 300, // bottom left goes above the bar when less room than this is left beside it
    z: 40, // under the load cover (Z.cover), so a dip to black covers it
};

/** Layers, low to high. */
export const Z = {
    cover: 50,
    backing: 100,
    face: 101,
    bevel: 102,
    icon: 103,
    tip: 110,
};
