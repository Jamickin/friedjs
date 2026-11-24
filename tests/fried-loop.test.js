import test from "node:test";
import assert from "node:assert/strict";
import { createLoop } from "../addons/fried-loop.js";
import { state, mount, ui, onRender, nextTick } from "../fried.js";

// A hand-cranked animation frame source and clock.
function crank() {
  let t = 0, queued = null, id = 0;
  return {
    raf: (fn) => { queued = fn; return ++id; },
    caf: () => { queued = null; },
    now: () => t,
    frame(ms) { t += ms; const fn = queued; queued = null; if (fn) fn(t); },
    get pending() { return queued !== null; },
  };
}

test("fried-loop: a fixed step, however long the frames are", () => {
  const c = crank(), dts = [];
  let renders = 0, lastAlpha = -1;
  const loop = createLoop({ update: (dt) => dts.push(dt), render: (a) => { renders++; lastAlpha = a; }, step: 1 / 60, raf: c.raf, caf: c.caf, now: c.now, doc: null });
  loop.start();
  c.frame(1000 / 60);
  assert.equal(dts.length, 1);
  c.frame(1000 / 30);                    // a slow frame: two steps
  assert.equal(dts.length, 3);
  c.frame(1000 / 120);                   // a fast frame: no step yet, but still a render
  assert.equal(dts.length, 3);
  assert.equal(renders, 3);
  assert.ok(lastAlpha > 0.4 && lastAlpha < 0.6, "alpha says we are halfway to the next step");
  c.frame(1000 / 120);
  assert.equal(dts.length, 4);
  assert.ok(dts.every((d) => d === 1 / 60));
  assert.ok(Math.abs(loop.time - 4 / 60) < 1e-9);
  assert.equal(loop.frame, 4);
});

test("fried-loop: after a stall it drops time instead of spiralling", () => {
  const c = crank();
  let steps = 0;
  const loop = createLoop({ update: () => steps++, maxSteps: 5, raf: c.raf, caf: c.caf, now: c.now, doc: null }).start();
  c.frame(3000);
  assert.equal(steps, 5);
  assert.ok(loop.stats.dropped > 2.9);
  c.frame(1000 / 60);
  assert.equal(steps, 6);
});

test("fried-loop: stop() stops, start() resumes without a jump", () => {
  const c = crank();
  let steps = 0;
  const loop = createLoop({ update: () => steps++, raf: c.raf, caf: c.caf, now: c.now, doc: null }).start();
  c.frame(1000 / 60);
  loop.stop();
  assert.equal(loop.running, false);
  assert.equal(c.pending, false);
  c.frame(5000);
  assert.equal(steps, 1);
  loop.start();
  c.frame(1000 / 60);
  assert.equal(steps, 2, "the five seconds it was stopped are not simulated");
});

test("fried-loop: it pauses while the page is hidden", () => {
  const c = crank(), listeners = {};
  const doc = { hidden: false, addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: (k) => { delete listeners[k]; } };
  let steps = 0;
  const loop = createLoop({ update: () => steps++, raf: c.raf, caf: c.caf, now: c.now, doc }).start();
  c.frame(1000 / 60);
  doc.hidden = true; listeners.visibilitychange();
  assert.equal(c.pending, false, "no frame is waiting while hidden");
  c.frame(60000);
  doc.hidden = false; listeners.visibilitychange();
  c.frame(1000 / 60);
  assert.equal(steps, 2, "the minute it was hidden is not simulated");
  loop.stop();
  assert.equal(listeners.visibilitychange, undefined);
});

test("fried-loop: tick() can be driven by hand", () => {
  const seen = [];
  const loop = createLoop({ update: (dt, time) => seen.push(time), now: () => 0, doc: null });
  assert.equal(loop.tick(50), 3);
  assert.deepEqual(seen.map((t) => Math.round(t * 60)), [0, 1, 2]);
});

test("fried-loop: many state changes in one frame make one FriedJS render", async () => {
  // A stand-in root: render() only needs firstElementChild / appendChild on it,
  // and createDom needs a document. Keep it honest but tiny.
  const made = [];
  globalThis.document = globalThis.document || {
    createElement: (tag) => ({ tagName: tag.toUpperCase(), nodeType: 1, childNodes: [], _attrs: {}, setAttribute(k, v) { this._attrs[k] = v; }, removeAttribute(k) { delete this._attrs[k]; }, appendChild(c) { this.childNodes.push(c); made.push(c); return c; }, addEventListener() {}, get firstElementChild() { return this.childNodes[0] || null; } }),
    createTextNode: (s) => ({ nodeType: 3, nodeValue: s }),
  };
  const root = document.createElement("div");
  const a = state(0), b = state(0);
  mount(() => ui("div", { key: "r" }, []), root);
  let renders = 0;
  const off = onRender(() => renders++);
  const c = crank();
  const loop = createLoop({ update: () => { a.value++; b.value++; }, render: () => { a.value++; }, raf: c.raf, caf: c.caf, now: c.now, doc: null }).start();
  c.frame(1000 / 20);                    // three steps and a render: seven state writes
  await nextTick();
  assert.equal(renders, 1);
  loop.stop(); off();
});
