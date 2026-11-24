import test from "node:test";
import assert from "node:assert/strict";
import { createGrid, createGridRenderer, TRANSPARENT } from "../addons/fried-grid.js";
import { createGridUi, wrapText } from "../addons/fried-grid-ui.js";

const row = (g, y, x0 = 0, x1 = g.cols) => String.fromCodePoint(...g.ch.slice(y * g.cols + x0, y * g.cols + x1));

test("fried-grid-ui: wrapText breaks on words, keeps newlines, splits a word too long to fit", () => {
  assert.deepEqual(wrapText("a ring of chalk on the wood", 10), ["a ring of", "chalk on", "the wood"]);
  assert.deepEqual(wrapText("one\ntwo", 10), ["one", "two"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("", 4), [""]);
});

test("fried-grid-ui: a box draws its border and title; a button reports a click once", () => {
  const g = createGrid(30, 8).clear(" ", 0, 0), ui = createGridUi();
  const frame = (ptr) => { ui.begin(g, ptr); ui.box(1, 1, 20, 5, { title: "Menu" }); const c = ui.button("ok", 3, 3, "Back to the desk"); ui.end(); return c; };
  assert.equal(frame({ x: 0, y: 0, down: false }), false);
  assert.equal(row(g, 1, 1, 21), "┌─ Menu ───────────┐");
  assert.equal(row(g, 3, 3, 19), "Back to the desk");
  assert.equal(ui.over(5, 3), true, "the box is part of the UI");
  assert.equal(ui.over(25, 7), false);
  ui.tap(5, 3);
  assert.equal(frame({ x: 5, y: 3, down: false }), true);
  assert.equal(frame({ x: 5, y: 3, down: false }), false, "the tap is used up");
  assert.equal(ui.hot, "ok");
  assert.equal(g.fg[3 * 30 + 3], ui.theme.accent, "hovered: drawn in the accent");
});

test("fried-grid-ui: a menu row tells which side of its value was clicked", () => {
  const g = createGrid(40, 3).clear(), ui = createGridUi();
  const frame = (x) => { ui.begin(g, { x, y: 1, down: false }); const r = ui.row("look", 0, 1, 40, "Look", "‹ Woodcut ›"); ui.end(); return r; };
  frame(5);
  assert.ok(row(g, 1).includes("Look") && row(g, 1).includes("‹ Woodcut ›"));
  ui.tap(5, 1); assert.equal(frame(5), 1, "anywhere on the row: forward");
  ui.tap(29, 1); assert.equal(frame(29), -1, "on the left arrow: back");
  ui.tap(38, 1); assert.equal(frame(38), 1);
});

test("fried-grid-ui: a slider follows a click and the wheel", () => {
  const g = createGrid(30, 2).clear(), ui = createGridUi();
  let v = 0.5;
  const frame = (ptr) => { ui.begin(g, ptr); v = ui.slider("vol", 2, 0, 22, v); ui.end(); };
  frame({ x: 0, y: 1, down: false });
  assert.equal(row(g, 0, 2, 24), "[==========----------]");
  ui.tap(22, 0); frame({ x: 22, y: 0, down: false });
  assert.ok(v > 0.95, String(v));
  ui.wheel(10, 0, 100); frame({ x: 10, y: 0, down: false });
  assert.ok(Math.abs(v - 0.95) < 1e-9);
});

test("fried-grid-ui: a scroll window keeps its place, follows the wheel, and can stick to the end", () => {
  const g = createGrid(20, 6).clear(), ui = createGridUi();
  const frame = (total, opts) => { ui.begin(g, { x: 3, y: 2, down: false }); const o = ui.scroll("log", 0, 0, 20, 4, total, opts); ui.end(); return o; };
  assert.equal(frame(10, { end: true, stick: true }), 6, "starts at the end");
  assert.equal(frame(12, { end: true, stick: true }), 8, "new lines arrive: it stays at the end");
  ui.wheel(3, 2, -100); assert.equal(frame(12, { end: true, stick: true }), 6, "wheel up");
  assert.equal(frame(14, { end: true, stick: true }), 6, "scrolled up: it does not jump when more arrives");
  assert.equal(frame(3), 0, "everything fits: no offset");
});

test("fried-grid-ui: a text field takes keys only while it has the focus", () => {
  const g = createGrid(30, 4).clear(), ui = createGridUi();
  let v = "";
  const frame = () => { ui.begin(g, { x: 0, y: 0, down: false }); v = ui.input("note", 2, 1, 20, v, { placeholder: "my own notes" }); ui.end(); };
  frame();
  assert.ok(row(g, 1).includes("my own notes"));
  assert.equal(ui.key({ key: "a" }), false, "not focused: the key is the game's");
  ui.tap(4, 1); frame();
  assert.equal(ui.focus, "note");
  for (const k of ["h", "i", "!", "Backspace"]) assert.equal(ui.key({ key: k }), true);
  ui.key({ key: "c", ctrlKey: true });
  frame();
  assert.equal(v, "hi");
  ui.key({ key: "Enter" }); frame();
  assert.equal(ui.focus, null);
  ui.tap(4, 1); frame(); ui.tap(25, 3); frame();
  assert.equal(ui.focus, null, "a click elsewhere leaves the field");
});

test("fried-grid: a renderer made with alpha clears TRANSPARENT cells instead of filling them", () => {
  const calls = { fillRect: 0, clearRect: 0, drawImage: 0 };
  const ctx = new Proxy({}, { get: (t, k) => (k in calls ? () => { calls[k]++; } : () => {}), set: () => true });
  const quiet = new Proxy({}, { get: () => () => {}, set: () => true });
  const fake = (c) => () => ({ width: 0, height: 0, style: {}, getContext: () => c, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) });
  const r = createGridRenderer({ canvas: fake(ctx)(), makeCanvas: fake(quiet), alpha: true });
  r.resize(10, 2, 100, 40, 1);
  const g = createGrid(10, 2).clear(" ", 0xffffff, TRANSPARENT);
  g.set(0, 0, "a", 0xffffff, 0x000000);
  assert.equal(r.draw(g), 20);
  assert.equal(calls.clearRect, 19);
  assert.equal(calls.fillRect, 1);
});

test("fried-grid-ui: muted widgets are drawn but feel nothing, so a modal drawn after them gets the click", () => {
  const g = createGrid(30, 8).clear(" ", 0, 0), ui = createGridUi();
  const frame = () => {
    ui.begin(g, { x: 3, y: 1, down: false });
    ui.mute(true);
    const under = ui.button("under", 2, 1, "underneath");
    ui.mute(false);
    const top = ui.button("top", 2, 1, "on top    ");
    ui.end();
    return { under, top, hot: ui.hot };
  };
  frame();
  ui.tap(3, 1);
  const r = frame();
  assert.equal(r.under, false);
  assert.equal(r.top, true);
  assert.equal(r.hot, "top");
  assert.equal(ui.over(3, 1), true);
  // begin() un-mutes: a forgotten mute(false) does not deaden the next frame
  ui.begin(g, { x: 3, y: 1, down: false }); ui.mute(true); ui.end();
  ui.tap(3, 1);
  ui.begin(g, { x: 3, y: 1, down: false });
  assert.equal(ui.button("again", 2, 1, "again"), true);
  ui.end();
});

test("fried-grid-ui: a text field with no value, a slider too narrow to draw, a field that goes away", () => {
  const g = createGrid(30, 6).clear(" ", 0, 0), ui = createGridUi();
  ui.begin(g, { x: 3, y: 1, down: false }); ui.tap(3, 1);
  assert.equal(ui.input("note", 1, 1, 12, undefined), "", "undefined is an empty field, not a crash");
  ui.end();
  assert.equal(ui.focus, "note");
  ui.begin(g, { x: 0, y: 0, down: false });
  assert.equal(ui.slider("s", 1, 3, 1, 0.5), 0.5);                            // one cell wide: nothing to drag, nothing thrown
  ui.end();                                                                   // "note" was not drawn this frame
  assert.equal(ui.focus, null, "a field no longer drawn lets go of the keyboard");
  assert.equal(ui.key({ key: "j" }), false);
});

test("fried-grid-ui: the caret follows a typed space; a region hands back its tap", () => {
  const g = createGrid(30, 4).clear(" ", 0, 0), ui = createGridUi();
  ui.begin(g, { x: 3, y: 1, down: false }); ui.tap(3, 1, 2);
  const r = ui.region("probe", 0, 0, 30, 4);
  assert.deepEqual([r.clicked, r.tap.x, r.tap.y, r.tap.button], [true, 3, 1, 2]);
  ui.end();
  ui.begin(g); ui.tap(3, 1); ui.input("f", 1, 1, 12, "hi"); ui.end();
  ui.key({ key: " " });
  ui.begin(g); const v = ui.input("f", 1, 1, 12, "hi"); ui.end();
  assert.equal(v, "hi ");
  ui.begin(g); ui.input("f", 1, 1, 12, v); ui.end();
  assert.equal(row(g, 1, 1, 5), "hi ▏", "the caret is after the space");
});

test("fried-grid-ui: a menu row's left half of its value is exactly where the value is drawn", () => {
  const g = createGrid(30, 3).clear(" ", 0, 0), ui = createGridUi();
  const click = (x) => { ui.begin(g, { x: 0, y: 0, down: false }); ui.tap(x, 1); const d = ui.row("look", 0, 1, 30, "Look", "‹ abcd ›"); ui.end(); return d; };
  click(0);
  assert.equal(row(g, 1, 21, 29), "‹ abcd ›");                                // the value is 8 cells, in columns 21..28
  assert.deepEqual([click(20), click(21), click(24), click(25), click(28)], [1, -1, -1, 1, 1]);
});

test("fried-grid-ui: buttons, rows and fields answer to the left button; a region still says which button it was", () => {
  const g = createGrid(30, 6).clear(" ", 0, 0), ui = createGridUi();
  const frame = (button) => { ui.begin(g, { x: 0, y: 0, down: false }); if (button !== undefined) ui.tap(3, 1, button); const out = { b: ui.button("b", 1, 1, "Start again"), r: ui.region("r", 0, 0, 30, 6) }; ui.end(); return out; };
  assert.equal(frame(2).b, false, "a right click does not press a button");
  assert.equal(frame(0).b, true);
  ui.begin(g); ui.tap(3, 3, 2); const reg = ui.region("pack", 0, 3, 30, 1); ui.end();
  assert.equal(reg.clicked, true); assert.equal(reg.tap.button, 2, "but a region of your own hears it, and which button");
  ui.begin(g); ui.tap(3, 2, 2); assert.equal(ui.row("row", 0, 2, 30, "Look", "‹ a ›"), 0); ui.input("f", 0, 4, 10, ""); ui.end();
  ui.begin(g); ui.tap(3, 4, 2); ui.input("f", 0, 4, 10, ""); ui.end();
  assert.equal(ui.focus, null, "nor does it put the caret in a field");
});
