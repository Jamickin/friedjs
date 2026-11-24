import test from "node:test";
import assert from "node:assert/strict";
import { createTimers, createMouse, gridText, findText } from "../addons/fried-probe.js";
import { createPointer } from "../addons/fried-pointer.js";
import { createGrid } from "../addons/fried-grid.js";
import { createGridUi } from "../addons/fried-grid-ui.js";

test("fried-probe: timers fire in order as the clock is turned, each at its own moment", () => {
  const t = createTimers(), fired = [];
  t.setTimer(() => fired.push("b@" + t.now()), 300);
  t.setTimer(() => { fired.push("a@" + t.now()); t.setTimer(() => fired.push("c@" + t.now()), 100); }, 100);
  const gone = t.setTimer(() => fired.push("never"), 50);
  t.clearTimer(gone);
  t.advance(99);
  assert.deepEqual(fired, []);
  t.advance(151);                                  // to 250: a at 100, and the timer it set at 200
  assert.deepEqual(fired, ["a@100", "c@200"]);
  assert.equal(t.now(), 250); assert.equal(t.size, 1);
  t.flush();
  assert.deepEqual(fired, ["a@100", "c@200", "b@250"]);
  assert.equal(t.size, 0);
});

test("fried-probe: the mouse sends what a browser sends: one down, one up, and a chord in between as moves", () => {
  const seen = [];
  const rec = (name) => (e) => seen.push(name + " b" + e.button + " m" + e.buttons + " @" + e.clientX + "," + e.clientY);
  const m = createMouse({ onpointerdown: rec("down"), onpointermove: rec("move"), onpointerup: rec("up") });
  m.down(0, [10, 20]).down(2).up(0).move([30, 20]).up(2);
  assert.deepEqual(seen, [
    "move b-1 m0 @10,20",       // getting there: no button named, none held
    "down b0 m1 @10,20",        // the first button: a real pointerdown
    "move b2 m3 @10,20",        // the second: a move that names it
    "move b0 m2 @10,20",        // the first comes up while the second is held: a move too
    "move b-1 m2 @30,20",
    "up b2 m0 @30,20",          // the last one up: a real pointerup
  ]);
  assert.equal(m.buttons, 0);
  m.down(0).down(0); m.up(2);                      // pressing what is down, or letting go what is not, sends nothing
  assert.equal(seen.length, 7);
  assert.equal(m.held(0), true);
  assert.deepEqual(m.log.slice(-1), ["pointerdown:0/1"]);
});

test("fried-probe: with fried-pointer: a hold, a tap, a drag, and two buttons at once, all as a hand would do them", () => {
  const t = createTimers(), got = [];
  const names = ["onDown", "onUp", "onTap", "onHold", "onDragStart", "onDragEnd"];
  const ptr = createPointer({ ...Object.fromEntries(names.map((n) => [n, (p, press) => got.push(n.slice(2).toLowerCase() + press.button)])), ...t.forPointer, holdMs: 450 });
  const m = createMouse(ptr.props);
  m.down(2, [5, 5]); t.advance(449); assert.deepEqual(got, ["down2"]);
  t.advance(1); m.up(2);
  assert.deepEqual(got, ["down2", "hold2", "up2"]);
  got.length = 0;
  m.click([5, 5]);
  assert.deepEqual(got, ["down0", "tap0", "up0"]);
  got.length = 0;
  m.drag([[5, 5], [40, 5], [80, 5]]);
  assert.deepEqual(got, ["down0", "dragstart0", "dragend0", "up0"]);
  got.length = 0;
  m.down(0, [5, 5]).down(2).up(2).up(0);           // a right click in the middle of a left press
  assert.deepEqual(got, ["down0", "down2", "tap2", "up2", "tap0", "up0"]);
  assert.equal(ptr.presses.size, 0);
  got.length = 0;
  m.down(0, [5, 5]).cancel();
  assert.deepEqual(got, ["down0", "up0"]); assert.equal(m.buttons, 0);
});

test("fried-probe: wheel, context menu and leave reach their handlers", () => {
  const seen = [];
  const m = createMouse({ onwheel: (e) => seen.push("wheel " + e.deltaY + (e.altKey ? " alt" : "")), oncontextmenu: (e) => { e.preventDefault(); seen.push("menu"); }, onpointerleave: () => seen.push("leave") });
  m.wheel(120, [3, 3], { altKey: true });
  const e = m.context();
  m.leave();
  assert.deepEqual(seen, ["wheel 120 alt", "menu", "leave"]);
  assert.equal(e.defaultPrevented, true);
});

test("fried-probe: a grid read back as text, and text found on it", () => {
  const g = createGrid(24, 4).clear(" ", 0, 0), ui = createGridUi();
  ui.begin(g); ui.box(0, 0, 24, 4, { title: "Menu" }); ui.button("go", 2, 1, "[ Begin ]"); ui.text(2, 2, "△ her triangle 𝄞"); ui.end();
  const text = gridText(g);
  assert.equal(text.split("\n")[0], "┌─ Menu ───────────────┐");
  assert.match(text, /\[ Begin \]/);
  assert.equal(gridText(g, 2, 1, 11, 2), "[ Begin ]");
  assert.deepEqual(findText(g, "[ Begin ]"), { x: 2, y: 1 });
  assert.deepEqual(findText(g, "her triangle"), { x: 4, y: 2 });
  assert.deepEqual(findText(g, "𝄞"), { x: 17, y: 2 }, "a character outside the basic plane is one cell");
  assert.equal(findText(g, "not there"), null);
  assert.deepEqual(findText(g, "─", 1), { x: 8, y: 0 }, "the second match");
  assert.equal(gridText(g, 0, 3, 24, 9), "└──────────────────────┘", "rows past the end are not there");
});

test("fried-probe: find a button on the grid, click it with the mouse, and the UI says it was clicked", () => {
  const CW = 8, CH = 16, g = createGrid(30, 5), ui = createGridUi(), ptrAt = { x: -1, y: -1, down: false };
  let clicks = 0;
  const frame = () => { g.clear(" ", 0, 0); ui.begin(g, ptrAt); if (ui.button("again", 3, 2, "[ Start again ]")) clicks++; ui.end(); };
  const cell = (e) => ({ x: e.clientX / CW, y: e.clientY / CH });
  const m = createMouse({ onpointermove: (e) => Object.assign(ptrAt, cell(e)), onpointerup: (e) => { const c = cell(e); ui.tap(c.x, c.y, e.button); } });
  frame();
  const at = findText(g, "[ Start again ]");
  m.click([(at.x + 2) * CW, (at.y + 0.5) * CH]);
  frame();
  assert.equal(clicks, 1);
  frame();
  assert.equal(clicks, 1, "once");
});
