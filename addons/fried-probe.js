// fried-probe.js -- optional addon: drive and read an app with no screen.
//
// An app whose logic is plain functions and plain data (which is what FriedJS
// asks for) does not need a browser to be tested: give it a mouse that is not
// there, a clock you turn by hand, and read what it drew back as text. A
// whole session of play then runs in a few milliseconds, in Node, in CI, and
// thousands of them in the time a browser takes to open.
//
//   const timers = createTimers();
//   const ptr = createPointer({ ...handlers, ...timers.forPointer });
//   const mouse = createMouse(ptr.props);
//   mouse.down(2, [40, 60]); timers.advance(500); mouse.up(2);   a right-button hold
//   mouse.drag([[10, 10], [80, 40]]);                            a left drag
//   assert.match(gridText(grid), /what I said/);                 what is on screen
//   const at = findText(grid, "[ Start again ]");                where to click it
//
// The mouse sends what a browser sends, which is not what one would guess: a
// move names no button (-1) and carries the mask of the buttons held; only
// the FIRST button down is a pointerdown and only the LAST up is a pointerup;
// a second button pressed or released while one is held arrives as a
// pointermove naming that button. Tests written against tidier events pass
// while the real hand fails.
//
// Plain data, runs in Node. Nothing here needs fried.js.

const BIT = [1, 4, 2, 8, 16];              // e.button -> its bit in e.buttons

// Timers and a clock turned by hand. `forPointer` is the three options
// createPointer takes ({ setTimer, clearTimer, now }).
export function createTimers() {
  const pending = new Map();
  let id = 0, t = 0;
  const T = {
    setTimer(fn, ms = 0) { pending.set(++id, { fn, at: t + Math.max(0, ms) }); return id; },
    clearTimer(i) { pending.delete(i); },
    now: () => t,
    get size() { return pending.size; },
    // Let `ms` go by: every timer due by then fires, the earliest first, each
    // at its own moment (a timer set by a timer fires too, if it falls due).
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let key = 0, next = null;
        for (const [k, v] of pending) if (v.at <= end && (next === null || v.at < next.at)) { next = v; key = k; }
        if (next === null) break;
        pending.delete(key);
        t = next.at;
        next.fn();
      }
      t = end;
      return T;
    },
    // Fire everything now, whenever it was due.
    flush() { for (const [k, v] of [...pending]) { if (pending.delete(k)) v.fn(); } return T; },
  };
  T.forPointer = { setTimer: T.setTimer, clearTimer: T.clearTimer, now: T.now };
  return T;
}

// A mouse over an element's handlers (createPointer().props, or any object of
// on... functions). Positions are client pixels. Every method returns the
// mouse, so a gesture reads as a line.
export function createMouse(props, { target = null } = {}) {
  const el = { setPointerCapture() {}, releasePointerCapture() {}, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }), ...(target || {}) };
  let x = 0, y = 0, buttons = 0;
  const log = [];
  const send = (name, button, more) => {
    const e = { type: name.slice(2), clientX: x, clientY: y, button, buttons, pointerId: 1, pointerType: "mouse", target: el, currentTarget: el, preventDefault() { e.defaultPrevented = true; }, defaultPrevented: false, ...more };
    log.push(e.type + (button >= 0 ? ":" + button : "") + "/" + buttons);
    if (typeof props[name] === "function") props[name](e);
    return e;
  };
  const at = (p) => { if (p) { x = p[0]; y = p[1]; } };
  const M = {
    get x() { return x; }, get y() { return y; }, get buttons() { return buttons; },
    log,                                    // every event sent, as "pointermove/1", "pointerdown:0/1" (type : button / buttons held)
    held: (button = 0) => (buttons & BIT[button]) !== 0,
    move(p) { at(p); send("onpointermove", -1); return M; },
    // Press a button (first moving to `p`, if given). The first button down is a
    // pointerdown; another while it is held is a pointermove that names it.
    down(button = 0, p = null) {
      if (p) M.move(p);
      if (buttons & BIT[button]) return M;
      const first = buttons === 0;
      buttons |= BIT[button];
      send(first ? "onpointerdown" : "onpointermove", button);
      return M;
    },
    // Let a button go. The last one up is a pointerup; any other is a pointermove.
    up(button = 0, p = null) {
      if (p) M.move(p);
      if (!(buttons & BIT[button])) return M;
      buttons &= ~BIT[button];
      send(buttons === 0 ? "onpointerup" : "onpointermove", button);
      return M;
    },
    click(p = null, button = 0) { M.down(button, p); M.up(button); return M; },
    // Press at the first point, move through the rest, let go at the last
    // (unless hang: the button stays down). between() runs after every move.
    drag(points, button = 0, { hang = false, between = null } = {}) {
      M.down(button, points[0]);
      for (let i = 1; i < points.length; i++) { M.move(points[i]); if (between) between(i); }
      if (!hang) M.up(button);
      return M;
    },
    wheel(deltaY, p = null, more = {}) { if (p) M.move(p); send("onwheel", -1, { deltaY, ...more }); return M; },
    context(p = null) { if (p) M.move(p); return send("oncontextmenu", 2); },
    leave() { send("onpointerleave", -1); return M; },
    // The pointer is taken away (the window lost focus): no ups are sent.
    cancel() { buttons = 0; send("onpointercancel", -1); return M; },
  };
  return M;
}

// A character grid (fried-grid's createGrid, or anything with cols, rows and
// ch) as text: one line per row, spaces trimmed off the right.
export function gridText(grid, x0 = 0, y0 = 0, x1 = grid.cols, y1 = grid.rows) {
  const rows = [];
  for (let y = Math.max(0, y0); y < Math.min(grid.rows, y1); y++) {
    let s = "";
    for (let x = Math.max(0, x0); x < Math.min(grid.cols, x1); x++) s += String.fromCodePoint(grid.ch[y * grid.cols + x] || 32);
    rows.push(s.replace(/\s+$/, ""));
  }
  return rows.join("\n");
}

// Where a piece of text is on the grid: { x, y } of its first character (the
// nth match, reading rows top to bottom), or null. To click it, aim a few
// cells in: { x: at.x + 1, y: at.y }.
export function findText(grid, text, nth = 0) {
  const want = [...String(text)].map((c) => c.codePointAt(0));
  if (!want.length) return null;
  let seen = 0;
  for (let y = 0; y < grid.rows; y++) {
    const o = y * grid.cols;
    for (let x = 0; x + want.length <= grid.cols; x++) {
      let k = 0;
      while (k < want.length && (grid.ch[o + x + k] || 32) === want[k]) k++;
      if (k === want.length && seen++ === nth) return { x, y };
    }
  }
  return null;
}

// -- chance, time and trouble ------------------------------------------------------------
// A test that passes has to pass every time, and most apps roll dice. A
// source of chance from a seed: `rnd()` gives 0..1 like Math.random, the same
// run of numbers for the same seed. `rnd.install()` puts it in Math.random's
// place and hands back the function that puts the real one back.
export function createRandom(seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  rnd.install = () => { const real = Math.random; Math.random = rnd; return () => { Math.random = real; }; };
  return rnd;
}

// How a number moved over time. A still picture cannot tell a light that
// breathes from one that flickers, or a thing that drifts from one that
// jumps; a run of readings can. Give the readings in order: `span` is how far
// apart the least and the most are, `step` the most it changed between two
// readings next to each other (a jump shows here), `turns` how often it went
// from rising to falling or back (a flicker shows here), `drift` the last
// reading less the first.
export function series(values) {
  const n = values.length;
  if (!n) return { n: 0, min: NaN, max: NaN, mean: NaN, span: 0, step: 0, turns: 0, drift: 0 };
  let min = Infinity, max = -Infinity, sum = 0, step = 0, turns = 0, was = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (i > 0) {
      const d = v - values[i - 1];
      if (Math.abs(d) > step) step = Math.abs(d);
      if (d !== 0) { if (was !== 0 && (d > 0) !== (was > 0)) turns++; was = d; }
    }
  }
  return { n, min, max, mean: sum / n, span: max - min, step, turns, drift: values[n - 1] - values[0] };
}

// Trouble an app reports while a test drives it and nobody reads the
// console: every console.error and console.warn, and (where there is a
// window) every uncaught error and unhandled rejection, kept as lines.
// `stop()` puts the console back and returns them. `quiet: true` keeps them
// off the real console meanwhile.
export function watchErrors({ target = globalThis, quiet = false } = {}) {
  const seen = [], real = { error: console.error, warn: console.warn };
  const text = (a) => a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
  console.error = (...a) => { seen.push("error: " + text(a)); if (!quiet) real.error(...a); };
  console.warn = (...a) => { seen.push("warn: " + text(a)); if (!quiet) real.warn(...a); };
  const onError = (e) => { seen.push("uncaught: " + ((e && (e.message || (e.reason && (e.reason.message || String(e.reason))))) || String(e))); };
  const listens = target && typeof target.addEventListener === "function";
  if (listens) { target.addEventListener("error", onError); target.addEventListener("unhandledrejection", onError); }
  return {
    seen,
    stop() {
      console.error = real.error; console.warn = real.warn;
      if (listens) { target.removeEventListener("error", onError); target.removeEventListener("unhandledrejection", onError); }
      return seen;
    },
  };
}
