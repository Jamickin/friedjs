import test from "node:test";
import assert from "node:assert/strict";
import { createPointer } from "../addons/fried-pointer.js";

// Timers we fire by hand.
function timers() {
  const pending = new Map(); let id = 0;
  return { setTimer: (fn) => { pending.set(++id, fn); return id; }, clearTimer: (i) => pending.delete(i), fire() { for (const [i, fn] of [...pending]) { pending.delete(i); fn(); } }, get size() { return pending.size; } };
}
const ev = (x, y, button = 0) => ({ clientX: x, clientY: y, button, pointerId: 1, currentTarget: { setPointerCapture() {} }, preventDefault() {} });

function rig(extra = {}) {
  const log = [], t = timers();
  const names = ["onDown", "onUp", "onTap", "onHold", "onDragStart", "onDrag", "onDragEnd"];
  const handlers = Object.fromEntries(names.map((n) => [n, (p, press) => log.push(`${n.slice(2).toLowerCase()}:${press.button}@${p.x},${p.y}`)]));
  const ptr = createPointer({ ...handlers, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => 0, ...extra });
  return { ptr, log, t };
}

test("fried-pointer: down and up without moving is a tap", () => {
  const { ptr, log, t } = rig();
  ptr.props.onpointerdown(ev(10, 10));
  ptr.props.onpointerup(ev(11, 10));
  assert.deepEqual(log, ["down:0@10,10", "tap:0@11,10", "up:0@11,10"]);
  assert.equal(t.size, 0, "the hold timer is cleared");
});

test("fried-pointer: kept still past holdMs is a hold, and then not a tap", () => {
  const { ptr, log, t } = rig();
  ptr.props.onpointerdown(ev(10, 10, 2));
  t.fire();
  ptr.props.onpointerup(ev(10, 10, 2));
  assert.deepEqual(log, ["down:2@10,10", "hold:2@10,10", "up:2@10,10"]);
});

test("fried-pointer: moving past dragPx is a drag, from where it began", () => {
  const { ptr, log, t } = rig();
  ptr.props.onpointerdown(ev(10, 10));
  ptr.props.onpointermove(ev(12, 10));    // within dragPx: nothing yet
  ptr.props.onpointermove(ev(20, 10));
  ptr.props.onpointermove(ev(30, 12));
  t.fire();                               // the hold timer was cleared by the drag
  ptr.props.onpointerup(ev(30, 12));
  assert.deepEqual(log, ["down:0@10,10", "dragstart:0@10,10", "drag:0@20,10", "drag:0@30,12", "dragend:0@30,12", "up:0@30,12"]);
});

test("fried-pointer: each button is its own press", () => {
  const { ptr, log } = rig();
  ptr.props.onpointerdown(ev(5, 5, 0));
  ptr.props.onpointerdown(ev(5, 5, 2));
  assert.equal(ptr.presses.size, 2);
  ptr.props.onpointerup(ev(5, 5, 2));
  ptr.props.onpointerup(ev(5, 5, 0));
  assert.deepEqual(log.filter((l) => l.startsWith("tap")), ["tap:2@5,5", "tap:0@5,5"]);
});

test("fried-pointer: toLocal converts once for every callback; data rides the press", () => {
  const seen = [];
  const ptr = createPointer({
    toLocal: (x, y) => ({ x: x / 10, y: y / 20 }),
    onDown: (p, press) => { press.data = "mine"; },
    onDrag: (p, press) => seen.push([p.x, p.y, press.data]),
    onMove: (p) => seen.push(["move", p.x]),
    setTimer: () => 1, clearTimer() {},
  });
  ptr.props.onpointerdown(ev(100, 100));
  ptr.props.onpointermove(ev(200, 100));
  assert.deepEqual(seen, [[20, 5, "mine"], ["move", 20]]);
  assert.deepEqual(ptr.at, { x: 20, y: 5 });
});

test("fried-pointer: a press that starts on a button inside the element is left to the button", () => {
  const { ptr, log } = rig();
  const stage = { setPointerCapture() { throw new Error("must not capture"); } };
  const button = { closest: (sel) => (sel.includes("button") ? button : null) };
  ptr.props.onpointerdown({ clientX: 5, clientY: 5, button: 0, pointerId: 1, currentTarget: stage, target: button });
  assert.deepEqual(log, []);
  assert.equal(ptr.presses.size, 0);
  const plain = { closest: () => null };
  ptr.props.onpointerdown({ clientX: 5, clientY: 5, button: 0, pointerId: 1, currentTarget: { setPointerCapture() {} }, target: plain });
  assert.deepEqual(log, ["down:0@5,5"]);
});

test("fried-pointer: cancel ends every press without a tap; the context menu is suppressed; wheel reports", () => {
  const { ptr, log } = rig();
  ptr.props.onpointerdown(ev(1, 1));
  ptr.props.onpointercancel();
  assert.deepEqual(log, ["down:0@1,1", "up:0@1,1"]);
  let prevented = false;
  ptr.props.oncontextmenu({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  let wheel = null;
  const p2 = createPointer({ onWheel: (p, dy) => { wheel = [p.x, dy]; } });
  p2.props.onwheel({ clientX: 7, clientY: 8, deltaY: -120 });
  assert.deepEqual(wheel, [7, -120]);
});

// A mouse sends pointerdown for its first button and pointerup for its last;
// the ones in between come as pointermove events naming the button.
const chord = (x, y, button, buttons) => ({ ...ev(x, y, button), buttons });

test("fried-pointer: a second button pressed and let go during a press is its own press", () => {
  const { ptr, log } = rig();
  ptr.props.onpointerdown(chord(5, 5, 0, 1));
  ptr.props.onpointermove(chord(5, 5, 2, 3));        // right goes down while left is held
  assert.equal(ptr.presses.size, 2);
  ptr.props.onpointermove(chord(5, 5, 0, 2));        // left comes up, right still down
  assert.equal(ptr.presses.size, 1);
  ptr.props.onpointerup(chord(5, 5, 2, 0));
  assert.equal(ptr.presses.size, 0);
  assert.deepEqual(log, ["down:0@5,5", "down:2@5,5", "tap:0@5,5", "up:0@5,5", "tap:2@5,5", "up:2@5,5"]);
});

test("fried-pointer: when the last button comes up, a press that missed its release is ended", () => {
  const { ptr, log } = rig();
  ptr.props.onpointerdown(chord(5, 5, 0, 1));
  ptr.props.onpointermove(chord(30, 5, -1, 1));      // a drag with the left button
  ptr.props.onpointerdown(chord(30, 5, 2, 3));       // (some other way a second press gets in)
  ptr.props.onpointerup(chord(30, 5, 2, 0));         // and both are gone at once
  assert.equal(ptr.presses.size, 0);
  assert.ok(log.includes("dragend:0@30,5") && log.includes("up:0@30,5"), "the drag was ended: " + log.join(" "));
});

test("fried-pointer: a new press on a button ends the one it replaces", () => {
  const { ptr, log } = rig();
  ptr.props.onpointerdown(ev(5, 5));
  ptr.props.onpointermove(ev(40, 5));
  ptr.props.onpointerdown(ev(50, 5));
  assert.deepEqual(log.slice(-3), ["dragend:0@40,5", "up:0@40,5", "down:0@50,5"]);
});

test("fried-pointer: dragPx by button: a button that never drags keeps its hold and its tap through any wobble", () => {
  const { ptr, log, t } = rig({ dragPx: (button) => (button === 2 ? Infinity : 4) });
  ptr.props.onpointerdown(ev(10, 10, 2));
  ptr.props.onpointermove(ev(19, 14, 2));            // well past four pixels
  t.fire();
  ptr.props.onpointerup(ev(19, 14, 2));
  assert.deepEqual(log, ["down:2@10,10", "hold:2@19,14", "up:2@19,14"]);
  log.length = 0;
  ptr.props.onpointerdown(ev(10, 10, 2));
  ptr.props.onpointermove(ev(22, 10, 2));
  ptr.props.onpointerup(ev(22, 10, 2));
  assert.deepEqual(log, ["down:2@10,10", "tap:2@22,10", "up:2@22,10"]);
  log.length = 0;
  ptr.props.onpointerdown(ev(10, 10, 0));            // the other button still drags
  ptr.props.onpointermove(ev(22, 10, 0));
  ptr.props.onpointerup(ev(22, 10, 0));
  assert.deepEqual(log, ["down:0@10,10", "dragstart:0@10,10", "drag:0@22,10", "dragend:0@22,10", "up:0@22,10"]);
});

test("fried-pointer: losing the pointer capture ends every press without a tap", () => {
  const { ptr, log } = rig();
  ptr.props.onpointerdown(ev(5, 5));
  ptr.props.onlostpointercapture();
  assert.deepEqual(log, ["down:0@5,5", "up:0@5,5"]);
  assert.equal(ptr.presses.size, 0);
});
