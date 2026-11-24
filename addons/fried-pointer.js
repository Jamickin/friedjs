// fried-pointer.js -- optional addon: pointer and drag helpers.
//
// One press is one of three things: a tap (down and up without moving), a
// hold (down, kept still past holdMs) or a drag (moved past dragPx). Working
// that out from raw pointer events, per mouse button, with capture, is the
// same forty lines in every canvas app; this is those lines.
//
//   const ptr = createPointer({
//     toLocal: (clientX, clientY, el) => grid.cellAt(clientX, clientY),
//     onDown(p, press) {}, onMove(p) {}, onUp(p, press) {},
//     onTap(p, press) {}, onHold(p, press) {},
//     onDragStart(p, press) {}, onDrag(p, press) {}, onDragEnd(p, press) {},
//     onWheel(p, deltaY, event) {},
//   });
//   ui("canvas", { key: "view", ...ptr.props })
//
// p is whatever toLocal returned (default: { x, y } in client pixels).
// press is { button, start, at, t0, moved, held, dragging, data } -- `data` is
// yours: set it in onDown and read it in the later callbacks of that press.
//
// The callbacks are plain functions, not actions: a pointermove fires far
// more often than the screen refreshes, and nothing here should schedule a
// FriedJS render. Set state() cells inside them when the UI must change.
// ptr.at is the latest position, ptr.inside whether the pointer is over the
// element, ptr.presses the presses in progress by button.

export function createPointer(opts = {}) {
  const {
    toLocal = (x, y) => ({ x, y }),
    holdMs = 450, dragPx = 4,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
    now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    preventContextMenu = true,
  } = opts;
  const call = (name, ...args) => { const fn = opts[name]; if (fn) fn(...args); };
  const presses = new Map();
  const ptr = { at: null, inside: false, presses, props: {}, cancel };

  function local(e) { return toLocal(e.clientX, e.clientY, e.currentTarget || e.target); }

  // A press that starts on a control inside the element (a button laid over a
  // canvas, say) is the control's: capturing the pointer here would swallow
  // its click.
  const CONTROLS = "button, a, input, textarea, select, [data-pointer-free]";
  function onControl(e) {
    const t = e.target, el = e.currentTarget;
    return !!(t && el && t !== el && t.closest && t.closest(CONTROLS));
  }

  function down(e) {
    if (onControl(e)) return;
    const p = local(e);
    ptr.at = p; ptr.inside = true;
    const old = presses.get(e.button);
    if (old) clearTimer(old.timer);
    const press = { button: e.button, start: p, at: p, px: e.clientX, py: e.clientY, t0: now(), moved: false, held: false, dragging: false, data: null, timer: 0 };
    presses.set(e.button, press);
    const el = e.currentTarget || e.target;
    if (el && el.setPointerCapture && e.pointerId !== undefined) { try { el.setPointerCapture(e.pointerId); } catch (_) {} }
    call("onDown", p, press, e);
    press.timer = setTimer(() => {
      if (presses.get(press.button) !== press || press.moved) return;
      press.held = true;
      call("onHold", press.at, press);
    }, holdMs);
  }

  function move(e) {
    const p = local(e);
    ptr.at = p; ptr.inside = true;
    for (const press of presses.values()) {
      press.at = p;
      if (!press.moved && Math.hypot(e.clientX - press.px, e.clientY - press.py) > dragPx) {
        press.moved = true;
        clearTimer(press.timer);
        if (!press.held) { press.dragging = true; call("onDragStart", press.start, press, e); }
      }
      if (press.dragging) call("onDrag", p, press, e);
    }
    call("onMove", p, e);
  }

  function up(e) {
    const p = local(e);
    ptr.at = p;
    const press = presses.get(e.button);
    if (!press) return;
    presses.delete(e.button);
    clearTimer(press.timer);
    press.at = p;
    if (press.dragging) call("onDragEnd", p, press, e);
    else if (!press.held && !press.moved) call("onTap", p, press, e);
    call("onUp", p, press, e);
  }

  // Every press ends without a tap (the pointer was taken away from us).
  function cancel() {
    for (const press of presses.values()) {
      clearTimer(press.timer);
      if (press.dragging) call("onDragEnd", press.at, press, null);
      call("onUp", press.at, press, null);
    }
    presses.clear();
  }

  ptr.props = {
    onpointerdown: down,
    onpointermove: move,
    onpointerup: up,
    onpointercancel: cancel,
    onpointerleave: () => { ptr.inside = false; call("onLeave"); },
    oncontextmenu: (e) => { if (preventContextMenu && e.preventDefault) e.preventDefault(); },
    onwheel: (e) => { call("onWheel", local(e), e.deltaY, e); },
  };
  return ptr;
}
