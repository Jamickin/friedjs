// fried-loop.js -- optional addon: a frame loop with a fixed-step simulation.
//
// FriedJS renders when state changes, in a microtask. A game also has to move
// when nothing "changed": flames flicker, a pendulum swings. This is the loop
// for that side of an app:
//
//   const loop = createLoop({
//     update(dt, time) { ... },      // the simulation, always called with the
//                                    // same dt (1/60 s by default), 0..n times
//                                    // per frame, so it behaves the same at
//                                    // 30, 60 or 144 Hz
//     render(alpha, frameDt) { ... } // once per animation frame; alpha (0..1)
//                                    // is how far into the next step we are
//   });
//   loop.start();
//
// How it sits with FriedJS's batching: everything update() and render() do
// happens inside one animation-frame callback, and FriedJS flushes its
// render in the microtask right after that callback. So any state() cells
// they set are batched into at most ONE virtual-DOM render per frame, and
// that render lands before the browser paints the frame. Two rules keep it
// that way:
//   - drive the loop with plain functions, not action(): an action schedules
//     a render every time it is called, changed or not;
//   - set a state() cell only when its value really differs (state() already
//     ignores an identical value, so `hud.value = text` every frame is free
//     while the text is the same).
//
// The loop pauses while the page is hidden, and never tries to catch up more
// than `maxSteps` steps after a stall (it drops the time instead).

export function createLoop({ update = null, render = null, step = 1 / 60, maxSteps = 5, raf = null, caf = null, now = null, doc = null } = {}) {
  const requestFrame = raf || ((fn) => requestAnimationFrame(fn));
  const cancelFrame = caf || ((id) => cancelAnimationFrame(id));
  const clock = now || (() => performance.now());
  const page = doc || (typeof document !== "undefined" ? document : null);

  let running = false, handle = 0, last = 0, acc = 0;
  const stats = { fps: 0, frameMs: 0, updateMs: 0, renderMs: 0, steps: 0, dropped: 0 };
  const loop = { time: 0, frame: 0, step, stats, start, stop, tick, get running() { return running; } };

  // One animation frame, given the clock's reading in milliseconds. Exposed so
  // a test (or a paused game stepping frame by frame) can drive it by hand.
  function tick(ms) {
    let dt = (ms - last) / 1000;
    last = ms;
    if (dt < 0) dt = 0;
    const most = step * maxSteps;
    if (dt > most) { stats.dropped += dt - most; dt = most; }
    acc += dt;
    const t0 = clock();
    let steps = 0;
    while (acc >= step - 1e-9) {
      if (update) update(step, loop.time);
      loop.time += step;
      acc -= step;
      steps++;
    }
    if (acc < 0) acc = 0;
    const t1 = clock();
    if (render) render(acc / step, dt);
    const t2 = clock();
    loop.frame++;
    stats.steps = steps;
    stats.updateMs += ((t1 - t0) - stats.updateMs) * 0.1;
    stats.renderMs += ((t2 - t1) - stats.renderMs) * 0.1;
    if (dt > 0) { stats.frameMs += (dt * 1000 - stats.frameMs) * 0.1; stats.fps = 1000 / stats.frameMs; }
    return steps;
  }

  function frame(ms) {
    if (!running) return;
    tick(ms === undefined ? clock() : ms);
    handle = requestFrame(frame);
  }

  function onVisibility() {
    if (!running) return;
    if (page.hidden) { cancelFrame(handle); handle = 0; }
    else if (!handle) { last = clock(); handle = requestFrame(frame); }
  }

  function start() {
    if (running) return loop;
    running = true;
    last = clock(); acc = 0;
    if (page && page.addEventListener) page.addEventListener("visibilitychange", onVisibility);
    handle = requestFrame(frame);
    return loop;
  }

  function stop() {
    running = false;
    if (handle) cancelFrame(handle);
    handle = 0;
    if (page && page.removeEventListener) page.removeEventListener("visibilitychange", onVisibility);
    return loop;
  }

  return loop;
}
