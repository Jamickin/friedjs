// fried-virtual.js — optional windowed-list helper for fried.js.
//
// The reconciler diff itself is O(n) in list size (fixed in fried.js — it
// used to be O(n^2) due to live-NodeList indexing under mutation). But
// fried.js has no component boundaries: renderApp() reruns in full on
// EVERY state change, rebuilding every ui() node in the tree before the
// diff even starts. A scrollable list with a small, frequently-changing
// bit of state next to it (a clock, an input, a hover flag) pays full
// list-size cost on every one of those unrelated changes. That's the
// remaining "browser scale" ceiling: not a bug, just what a whole-tree
// rebuild model costs once the tree is thousands of real DOM nodes.
//
// The fix isn't in the reconciler — it's not creating that many real DOM
// nodes in the first place. This renders only the rows inside (plus a
// small overscan around) the current scroll viewport, so the "whole tree"
// renderApp() rebuilds each time stays viewport-sized (tens of nodes)
// regardless of how many items are in the underlying array.
//
// Not part of the core API (CLAUDE.md's "don't invent new framework
// functions" convention governs fried.js's own frozen surface); this is a
// separate opt-in module, same precedent as fried-db.js. Only reach for it
// when a single list in an app is large enough (a few hundred rows+) that
// its rebuild cost is the thing making the app feel slow.

import { state } from "../fried.js";

/**
 * createVirtualList(opts) -> a reactive scroll window over an array you
 * pass in fresh on every render (this holds no copy of the data itself).
 *
 * opts.itemHeight: fixed px height of one row (required). This is a
 *   fixed-row-height virtualizer, not a measuring one — that covers the
 *   large majority of list UIs and keeps this small; a variable-height
 *   list needs a different approach and isn't what this is for.
 * opts.overscan: extra rows kept rendered above/below the viewport, so
 *   fast scrolling doesn't flash empty space before the next render
 *   catches up (default 6).
 * opts.viewportHeight: px height of the scrolling container, if known
 *   up front. Omit it and it's read from the container's own
 *   `clientHeight` the first time `attach()` sees it.
 *
 * Returns { attach(scrollEl), slice(items) }.
 */
export function createVirtualList(opts) {
  const itemHeight = opts.itemHeight;
  if (!itemHeight) throw new Error("createVirtualList: opts.itemHeight is required");
  const overscan = opts.overscan ?? 6;

  const scrollTop = state(0);
  const viewportH = state(opts.viewportHeight || 0);
  let el = null;
  let ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (el) scrollTop.value = el.scrollTop;
    });
  }

  /**
   * Call every render (e.g. right after building the scroll container's
   * ui() node, or from an onRender hook) with the actual scrolling
   * element — the one you gave a fixed height and `overflow: auto` to in
   * your own markup. No-ops if it's the same element as last time, so
   * calling it every render is cheap and is the intended usage (fried.js
   * keyed reconciliation reuses the same real DOM node across renders as
   * long as the key doesn't change, but this doesn't assume that; it just
   * re-attaches if the element identity ever does change).
   */
  function attach(scrollEl) {
    if (el === scrollEl) return;
    if (el) el.removeEventListener("scroll", onScroll);
    el = scrollEl || null;
    if (!el) return;
    el.addEventListener("scroll", onScroll, { passive: true });
    if (!opts.viewportHeight) viewportH.value = el.clientHeight;
  }

  /**
   * slice(items) -> { start, end, top, bottom, rows }.
   * `rows` is the slice of `items` to actually build ui() nodes for.
   * `top`/`bottom` are px heights for two spacer elements (or a single
   * wrapper's padding-top/padding-bottom) around `rows`, so the container
   * still scrolls as if all of `items` were really there.
   */
  function slice(items) {
    const total = items.length;
    const vh = viewportH.value || opts.viewportHeight || 0;
    const visibleCount = vh ? Math.ceil(vh / itemHeight) : total;
    let start = Math.floor(scrollTop.value / itemHeight) - overscan;
    let end = start + visibleCount + overscan * 2;
    start = Math.max(0, start);
    end = Math.min(total, end);
    return {
      start,
      end,
      top: start * itemHeight,
      bottom: Math.max(0, (total - end) * itemHeight),
      rows: items.slice(start, end),
    };
  }

  return { attach, slice };
}
