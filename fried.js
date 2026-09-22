// fried.js — fast, small, AI-first reactive UI runtime.
// Real JS, ES modules, no build step, no special syntax.
// API: mount state action ui uid css cssVar onRender nextTick sliceRender render

const perf = typeof performance !== "undefined" ? performance : null;
const t = () => perf?.now() ?? 0;

let root, renderFn, pendingRender = false, renderHooks = [];

export function mount(fn, el)  { renderFn = fn; root = el; render(); }
export function onRender(fn)   { renderHooks.push(fn); return () => { renderHooks = renderHooks.filter(h => h !== fn); }; }
export function nextTick(fn)   { return fn ? queueMicrotask(fn) : new Promise(r => queueMicrotask(r)); }
export function uid()          { return Math.random().toString(36).slice(2, 10); }

function scheduleRender() {
  if (pendingRender) return;
  pendingRender = true;
  queueMicrotask(() => { pendingRender = false; render(); });
}

export function render() {
  if (!root || !renderFn) return;
  const t0 = t(), next = renderFn(), tTree = t() - t0;
  if (!next) { root.innerHTML = ""; return; }
  const t1 = t();
  root.firstElementChild ? hydrate(root.firstElementChild, next) : root.appendChild(next);
  const tHydrate = t() - t1;
  for (const h of renderHooks) { try { h({ tTree, tHydrate, tTotal: tTree + tHydrate, timestamp: Date.now() }); } catch(_) {} }
}

// -- CSS Engine ----------------------------------------------------------
// css(rules) injects a <style> tag once, dedupes by content, returns class map.
// cssVar(name, val?) gets/sets CSS custom properties — zero re-render cost.

let _sheet = null;
const _cssCache = new Map(); // decl string → generated class name

function ensureSheet() {
  if (_sheet) return;
  const el = document.createElement("style");
  el.id = "fried-css";
  document.head.appendChild(el);
  _sheet = el.sheet;
}

export function css(rules) {
  ensureSheet();
  const out = {};
  for (const name in rules) {
    const decl = rules[name];
    let cls = _cssCache.get(decl);
    if (!cls) {
      cls = "f" + _cssCache.size.toString(36);
      _cssCache.set(decl, cls);
      _sheet.insertRule(`.${cls}{${decl}}`, _sheet.cssRules.length);
    }
    out[name] = cls;
  }
  return out;
}

export function cssVar(name, value) {
  if (value === undefined) return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  document.documentElement.style.setProperty(name, String(value));
}

// -- Time-sliced rendering -----------------------------------------------
// sliceRender(items, chunkSize, onChunk, onDone)
// Shows first chunk synchronously, fills rest in idle callbacks.

const ric = typeof requestIdleCallback !== "undefined"
  ? fn => requestIdleCallback(fn, { timeout: 100 })
  : fn => requestAnimationFrame(() => fn({ timeRemaining: () => 16 }));

export function sliceRender(items, chunkSize = 200, onChunk, onDone) {
  let committed = Math.min(chunkSize, items.length);
  onChunk(items.slice(0, committed));
  if (committed >= items.length) { onDone?.(); return; }

  (function next() {
    ric(deadline => {
      while (committed < items.length && deadline.timeRemaining() > 1) {
        committed = Math.min(committed + chunkSize, items.length);
        onChunk(items.slice(0, committed));
      }
      committed < items.length ? next() : onDone?.();
    });
  })();
}

// -- DOM Reconciliation --------------------------------------------------

function hydrate(o, n) {
  if (o.nodeType === 3 && n.nodeType === 3) {
    if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
    return o;
  }
  if (o.nodeType !== n.nodeType || o.tagName !== n.tagName) {
    o.replaceWith(n); return n;
  }
  hydrateAttrs(o, n);
  hydrateChildren(o, n);
  return o;
}

const EMPTY = {};

function hydrateAttrs(o, n) {
  const op = o._friedProps || EMPTY, np = n._friedProps || EMPTY;

  for (const k in np) {
    const nv = np[k];
    if (op[k] === nv) continue;           // unchanged — skip
    if      (k === "class")   o.className = nv || "";
    else if (k === "checked") o.checked = !!nv;
    else if (k === "value")   { if (o !== document.activeElement) o.value = nv; }
    else if (k === "key")     {} // never set as DOM attr
    else if (k.startsWith("on")) {}        // handlers forwarded below
    else if (nv === false || nv == null)   o.removeAttribute(k);
    else                                   o.setAttribute(k, nv);
  }

  // Remove props no longer in new render
  for (const k in op) {
    if (k in np) continue; // Zero-allocation check instead of a Set
    if      (k === "class")              o.className = "";
    else if (k === "checked")            o.checked = false;
    else if (!k.startsWith("on") && k !== "key") o.removeAttribute(k);
  }

  if (n._friedHandlers) o._friedHandlers = Object.assign(o._friedHandlers || {}, n._friedHandlers);
  o._friedProps = np;
}

function hydrateChildren(op, np) {
  const oc = op.childNodes, nc = np.childNodes;
  const ol = oc.length, nl = nc.length, cl = Math.min(ol, nl);

  // Fast-path: identical key sequence — 1-to-1 in-place diff
  let seq = true;
  for (let i = 0; i < cl; i++) {
    const oNode = oc[i], nNode = nc[i];
    if (oNode._friedKey !== nNode._friedKey || oNode.nodeType !== nNode.nodeType || oNode.tagName !== nNode.tagName) {
      seq = false; break;
    }
  }
  if (seq && ol === nl) {
    for (let i = 0; i < ol; i++) hydrate(oc[i], nc[i]);
    return;
  }

  // Keyed fallback: Map reconciliation for insertions, deletions, reorders
  const km = new Map();
  for (let i = 0; i < ol; i++) { const k = oc[i]._friedKey; if (k) km.set(k, oc[i]); }

  for (let i = 0; i < nl; i++) {
    const nc_i = nc[i], k = nc_i._friedKey;
    const match = k ? km.get(k) : oc[i];
    if (match?.parentNode === op) {
      if (k) km.delete(k);
      if (op.childNodes[i] !== match) op.insertBefore(match, op.childNodes[i] || null);
      hydrate(match, nc_i);
    } else {
      op.insertBefore(nc_i, op.childNodes[i] || null);
    }
  }
  while (op.childNodes.length > nl) op.removeChild(op.lastChild);
}

// -- Reactive Primitives -------------------------------------------------

export function state(initial) {
  let v = initial;
  return {
    get value() { return v; },
    set value(next) { if (v === next) return; v = next; scheduleRender(); },
  };
}

export function action(name, fn) {
  const w = (...args) => { const r = fn(...args); scheduleRender(); return r; };
  w.friedActionName = name;
  return w;
}

// -- Element Builder -----------------------------------------------------
// ui(tag, props, children) → real DOM element.
// Props are cached as _friedProps for zero-reflection diffing.
// Event handlers are stored in _friedHandlers for closure-forwarding.

export function ui(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  el._friedProps = props;
  el._friedKey = props.key;

  for (const k in props) {
    const v = props[k];
    if      (k === "key")                   el.dataset.friedKey = v;
    else if (k === "class")                 el.className = v;
    else if (k === "checked")               el.checked = !!v;
    else if (k.startsWith("on") && typeof v === "function") {
      const evt = k.slice(2).toLowerCase();
      if (!el._friedHandlers) el._friedHandlers = {};
      el._friedHandlers[evt] = v;
      el.addEventListener(evt, e => el._friedHandlers[evt]?.(e));
    } else if (v !== false && v != null)    el.setAttribute(k, v);
  }

  // Flatten children without Array.flat() allocation
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      for (let j = 0; j < c.length; j++) {
        const cc = c[j];
        if (cc == null || cc === false) continue;
        el.appendChild(typeof cc === "string" || typeof cc === "number" ? document.createTextNode(String(cc)) : cc);
      }
    } else {
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
  }
  return el;
}
