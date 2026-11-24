// fried-grid-ui.js -- optional addon: a user interface drawn in character cells.
//
// When the whole screen is a character grid, the words, panels, menus and
// buttons belong in the grid too. The virtual DOM cannot help there, and a
// frame loop redraws everything anyway, so this is an immediate-mode UI:
// every frame you say what is on screen, and each call both draws it into a
// fried-grid cell buffer and tells you what happened to it.
//
//   const ui = createGridUi();
//   // each frame:
//   ui.begin(grid, { x, y, down });         // the pointer, in this grid's cells
//   ui.box(2, 2, 40, 8, { title: "Menu" });
//   if (ui.button("resume", 4, 4, "Back to the desk")) close();
//   volume = ui.slider("vol", 4, 6, 20, volume);
//   name = ui.input("name", 4, 8, 20, name);
//   ui.end();
//
//   // from the pointer and keyboard handlers:
//   ui.tap(x, y);            // a click happened at these cells
//   ui.wheel(x, y, dy);
//   ui.key(event);           // returns true if a text field took it
//   ui.over(x, y);           // is anything of the UI under here? (so the game
//                            // behind it can ignore the press)
//
// A modal (a menu over everything else) is drawn last so it is on top, which
// would let what is under it take the click first. So mute what it covers:
//   ui.mute(menuOpen);  drawTheScreen();  ui.mute(false);  if (menuOpen) drawMenu();
// Muted widgets are drawn as usual but feel nothing: no hover, click or wheel.
//
// Widgets are identified by the id you pass, so a button keeps its hover
// state and a list keeps its scroll position from frame to frame. Colours
// come from ui.theme (0xRRGGBB); `ground` may be fried-grid's TRANSPARENT.
// Plain data, runs in Node.

export const BOX = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
export const BOX_PLAIN = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };

// Break text into lines no wider than `width` cells. Newlines are kept.
export function wrapText(text, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (line && [...line].length + 1 + [...word].length > width) { out.push(line); line = word; }
      else line = line ? line + " " + word : word;
      while ([...line].length > width) { const cs = [...line]; out.push(cs.slice(0, width).join("")); line = cs.slice(width).join(""); }
    }
    out.push(line);
  }
  return out;
}

export function createGridUi(theme = {}) {
  const ui = {
    theme: { ink: 0xcdbfa0, dim: 0x8a8069, faint: 0x4a4335, accent: 0xe0a458, ground: 0x0b0908, select: 0x1e1811, ...theme },
    focus: null,               // id of the text field being typed in
    hot: null,                 // id under the pointer this frame
  };
  let grid = null, ptr = { x: -1, y: -1, down: false }, muted = false;
  let taps = [], wheels = [], keys = [];
  let regions = [], lastRegions = [];
  const scroll = new Map(), carets = new Map();
  const len = (s) => [...s].length;
  const inside = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

  ui.begin = (g, pointer = ptr) => { grid = g; ptr = pointer; regions = []; ui.hot = null; muted = false; };
  ui.mute = (on = true) => { muted = !!on; };
  ui.end = () => { lastRegions = regions; taps = []; wheels = []; keys = []; };
  ui.tap = (x, y) => { taps.push({ x, y }); };
  ui.wheel = (x, y, dy) => { wheels.push({ x, y, dy }); };
  // Is any part of the UI under these cells? (As of the last frame drawn.)
  ui.over = (x, y) => lastRegions.some((r) => inside(r, x, y));
  // A key press. Returns true when a focused text field used it.
  ui.key = (e) => {
    if (ui.focus === null) return false;
    keys.push({ key: e.key, ctrl: !!(e.ctrlKey || e.metaKey) });
    return true;
  };

  // Mark a rectangle as belonging to the UI and report what the pointer is
  // doing to it: { hot, clicked, wheel }.
  ui.region = (id, x, y, w, h) => {
    const r = { id, x, y, w, h };
    regions.push(r);
    if (muted) return { hot: false, clicked: false, wheel: 0 };
    const hot = inside(r, ptr.x, ptr.y);
    if (hot && id !== null) ui.hot = id;
    let clicked = false, wheel = 0;
    for (const t of taps) if (!t.used && inside(r, t.x, t.y) && id !== null) { clicked = true; t.used = true; }
    for (const wv of wheels) if (!wv.used && inside(r, wv.x, wv.y) && id !== null) { wheel += wv.dy; wv.used = true; }
    return { hot, clicked, wheel };
  };

  ui.text = (x, y, text, fg = ui.theme.ink, bg) => { grid.put(x, y, String(text), fg, bg, bg !== undefined); return len(String(text)); };
  // Wrapped text; returns how many rows it used. opts: { fg, bg, max, from }.
  ui.wrap = (x, y, w, text, opts = {}) => {
    const lines = wrapText(text, w), from = opts.from || 0, max = opts.max === undefined ? lines.length : opts.max;
    let row = 0;
    for (let i = from; i < lines.length && row < max; i++, row++) grid.put(x, y + row, lines[i], opts.fg === undefined ? ui.theme.ink : opts.fg, opts.bg, false);
    return row;
  };
  ui.fill = (x, y, w, h, bg = ui.theme.ground, ch = " ", fg = ui.theme.ink) => { grid.fill(x, y, w, h, ch, fg, bg); };

  // A filled panel with a border, and a title set into its top edge.
  ui.box = (x, y, w, h, opts = {}) => {
    const t = ui.theme, b = opts.border === undefined ? BOX : opts.border, bg = opts.bg === undefined ? t.ground : opts.bg, fg = opts.fg === undefined ? t.faint : opts.fg;
    ui.region(opts.id === undefined ? null : opts.id, x, y, w, h);
    grid.fill(x, y, w, h, " ", t.ink, bg);
    if (b) {
      for (let i = 1; i < w - 1; i++) { grid.set(x + i, y, b.h, fg, bg); grid.set(x + i, y + h - 1, b.h, fg, bg); }
      for (let j = 1; j < h - 1; j++) { grid.set(x, y + j, b.v, fg, bg); grid.set(x + w - 1, y + j, b.v, fg, bg); }
      grid.set(x, y, b.tl, fg, bg); grid.set(x + w - 1, y, b.tr, fg, bg); grid.set(x, y + h - 1, b.bl, fg, bg); grid.set(x + w - 1, y + h - 1, b.br, fg, bg);
    }
    if (opts.title) grid.put(x + 2, y, " " + opts.title + " ", opts.titleFg === undefined ? t.accent : opts.titleFg, bg, true);
  };

  // A line of text you can click. opts: { w (pad to this width), fg, on (drawn as selected) }.
  ui.button = (id, x, y, label, opts = {}) => {
    const t = ui.theme, w = opts.w || len(label), r = ui.region(id, x, y, w, 1), on = opts.on || r.hot;
    const bg = on ? t.select : opts.bg;
    if (bg !== undefined) grid.fill(x, y, w, 1, " ", t.ink, bg);
    grid.put(x, y, label, on ? t.accent : (opts.fg === undefined ? t.ink : opts.fg), bg, bg !== undefined);
    return r.clicked;
  };

  // A row in a menu: a label on the left, a value on the right. Returns
  // -1 or +1 when it is clicked on its left or right half, 0 otherwise.
  ui.row = (id, x, y, w, label, value = "", opts = {}) => {
    const t = ui.theme, r = ui.region(id, x, y, w, 1), on = opts.on || r.hot, bg = on ? t.select : opts.bg === undefined ? t.ground : opts.bg;
    grid.fill(x, y, w, 1, " ", t.ink, bg);
    grid.put(x + 1, y, (on ? "▸ " : "  ") + label, on ? t.accent : t.ink, bg, true);
    if (value) grid.put(x + w - 1 - len(value), y, value, on ? t.accent : t.dim, bg, true);
    if (!r.clicked) return 0;
    return value && ptr.x < x + w - 2 - len(value) / 2 && ptr.x >= x + w - 2 - len(value) ? -1 : 1;
  };

  // A slider: [====----]. Returns the new value (0..1).
  ui.slider = (id, x, y, w, value, opts = {}) => {
    const t = ui.theme, r = ui.region(id, x, y, w, 1), inner = w - 2;
    let v = Math.max(0, Math.min(1, value));
    if (r.clicked || (r.hot && ptr.down)) v = Math.max(0, Math.min(1, (ptr.x - x - 1) / Math.max(1, inner - 1)));
    v = Math.max(0, Math.min(1, v + (r.wheel ? -Math.sign(r.wheel) * 0.05 : 0)));
    const k = Math.round(v * inner);
    grid.put(x, y, "[" + "=".repeat(k) + "-".repeat(inner - k) + "]", r.hot ? t.accent : (opts.fg === undefined ? t.dim : opts.fg), opts.bg, opts.bg !== undefined);
    return v;
  };

  // A window onto a list of lines taller than it. Returns the index of the
  // first line shown (it keeps its own scroll position, moved by the wheel);
  // draws a scroll bar in the last column when the list does not fit.
  ui.scroll = (id, x, y, w, h, total, opts = {}) => {
    const r = ui.region(id, x, y, w, h), most = Math.max(0, total - h);
    let off = scroll.has(id) ? scroll.get(id) : (opts.end ? most : 0);
    if (opts.stick && scroll.get(id + ":total") !== total && off >= (scroll.get(id + ":most") || 0)) off = most;   // was at the end: stay there
    off = Math.max(0, Math.min(most, off + Math.sign(r.wheel) * 2));
    scroll.set(id, off); scroll.set(id + ":total", total); scroll.set(id + ":most", most);
    if (most > 0) {
      const t = ui.theme, bar = Math.max(1, Math.round(h * h / total)), at = Math.round((h - bar) * off / most);
      for (let j = 0; j < h; j++) grid.set(x + w - 1, y + j, j >= at && j < at + bar ? "┃" : "┆", j >= at && j < at + bar ? t.dim : t.faint);
    }
    return off;
  };
  ui.scrollTo = (id, off) => { scroll.set(id, off); };

  // A text field. Click to type in it; Enter or Escape leaves it. Returns the
  // (possibly edited) value. opts: { h (rows; wraps), placeholder, max }.
  ui.input = (id, x, y, w, value, opts = {}) => {
    const t = ui.theme, h = opts.h || 1, r = ui.region(id, x, y, w, h);
    if (r.clicked) { ui.focus = id; carets.set(id, len(value)); }
    else if (ui.focus === id && taps.some((p) => !inside({ x, y, w, h }, p.x, p.y))) ui.focus = null;
    let v = String(value || "");
    if (ui.focus === id) {
      for (const k of keys) {
        if (k.key === "Enter" && h === 1) ui.focus = null;
        else if (k.key === "Enter") v += "\n";
        else if (k.key === "Escape") ui.focus = null;
        else if (k.key === "Backspace") v = [...v].slice(0, -1).join("");
        else if ([...k.key].length === 1 && !k.ctrl && (opts.max === undefined || len(v) < opts.max)) v += k.key;
      }
    }
    const bg = opts.bg === undefined ? t.select : opts.bg;
    grid.fill(x, y, w, h, " ", t.ink, bg);
    const lines = wrapText(v, w - 1), from = Math.max(0, lines.length - h);
    if (!v && ui.focus !== id && opts.placeholder) grid.put(x, y, opts.placeholder, t.faint, bg, false);
    for (let i = from; i < lines.length; i++) grid.put(x, y + i - from, lines[i], t.ink, bg, false);
    if (ui.focus === id) { const last = lines[lines.length - 1] || ""; grid.set(Math.min(x + w - 1, x + len(last)), y + Math.min(h - 1, lines.length - 1 - from), "▏", t.accent, bg); }
    return v;
  };

  return ui;
}
