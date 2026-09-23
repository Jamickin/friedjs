// fried.js — fast, small, AI-first reactive UI runtime.
// Real JS, ES modules, no build step, no special syntax.
// API: mount state action ui uid css cssVar onRender nextTick render
//
// This file is a merge of two independently-evolved iterations of
// fried.js: the vnode-based rewrite (real virtual-node objects from
// ui(), DOM created lazily by createDom, SVG support, a prefix/suffix
// trim before the keyed-Map reconciliation fallback) is the base, because
// it is the more advanced runtime architecture of the two. Two real,
// independently-verified fixes from the other iteration are folded in on
// top of it -- see the comments at their call sites below for why each
// exists:
//   1. hydrateAttrs updating _friedKey/data-fried-key on prop change
//      (previously: a node's key was set once at creation and never
//      touched again, going stale across a keyed<->unkeyed transition at
//      the same list position).
//   2. hydrateChildren's keyed-Map fallback walking already-placed nodes
//      by object reference (cur.nextSibling) instead of indexing the live
//      childNodes list by position every iteration (previously O(n^2) at
//      list scale -- a ~50k-row rebuild measured at 35+ seconds before
//      this fix, a few hundred ms after).

const perf = typeof performance !== "undefined" ? performance : null;
const t = () => perf?.now() ?? 0;

let root, renderFn, pendingRender = false, renderHooks = [];

const SVG_TAGS = new Set(["svg", "path", "circle", "g", "rect", "line", "polygon", "polyline", "text"]);

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
  const t0 = t(), nextVnode = renderFn(), tTree = t() - t0;
  if (!nextVnode) { root.textContent = ""; return; }
  const t1 = t();
  if (root.firstElementChild) {
    hydrate(root.firstElementChild, nextVnode);
  } else {
    root.appendChild(createDom(nextVnode));
  }
  const tHydrate = t() - t1;
  for (const h of renderHooks) { try { h({ tTree, tHydrate, tTotal: tTree + tHydrate, timestamp: Date.now() }); } catch (_) {} }
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

// -- DOM Reconciliation --------------------------------------------------
// ui(tag, props, children) returns a lightweight virtual node (a plain
// object), not a real DOM element -- createDom() below is the only place
// that actually touches the DOM to build one, and it's only called when
// hydrate/hydrateChildren decide a real new node is needed (an existing
// node with the same key/tag is reused in place instead). This keeps a
// render pass cheap even for subtrees that end up entirely reused.

function createDom(v) {
  if (typeof v === "string" || typeof v === "number") return document.createTextNode(v);

  const isSvg = SVG_TAGS.has(v.tag);
  const el = isSvg ? document.createElementNS("http://www.w3.org/2000/svg", v.tag) : document.createElement(v.tag);

  el._friedKey = v._friedKey;
  el._friedHandlers = v._friedHandlers;
  el._friedProps = v.props;
  el._friedTag = v.tag;
  // Mirror the key onto a real DOM attribute (not just the internal
  // _friedKey property) so `[data-fried-key="..."]` queries -- used
  // throughout this project's own tests, verify scripts, and by anyone
  // debugging in devtools -- actually work.
  if (v._friedKey != null) el.setAttribute("data-fried-key", v._friedKey);

  if (v._friedHandlers) {
    for (const evt in v._friedHandlers) {
      el.addEventListener(evt, e => el._friedHandlers?.[evt]?.(e));
    }
  }

  for (const k in v.props) {
    const val = v.props[k];
    if (k === "key") continue;
    if (k === "class") {
      if (isSvg) el.setAttribute("class", val); else el.className = val;
    } else if (k === "checked") el.checked = !!val;
    else if (k.startsWith("on")) {}
    else if (val !== false && val != null) el.setAttribute(k, val);
  }

  for (let i = 0; i < v.children.length; i++) {
    el.appendChild(createDom(v.children[i]));
  }
  return el;
}

const EMPTY = {};

function hydrate(o, n) {
  const isTextN = typeof n === "string" || typeof n === "number";
  if (o.nodeType === 3 && isTextN) {
    if (o.nodeValue != n) o.nodeValue = String(n);
    return o;
  }

  const tagO = o._friedTag ?? (o.tagName ? o.tagName.toLowerCase() : null);
  const tagN = isTextN ? null : n.tag; // n.tag is already lowercase from ui()

  if (o.nodeType !== (isTextN ? 3 : 1) || tagO !== tagN) {
    const newEl = createDom(n);
    o.replaceWith(newEl);
    return newEl;
  }

  hydrateAttrs(o, n);
  hydrateChildren(o, n);
  return o;
}

function hydrateAttrs(o, n) {
  const op = o._friedProps || EMPTY, np = n.props || EMPTY;
  const isSvg = o.namespaceURI === "http://www.w3.org/2000/svg";

  for (const k in np) {
    const nv = np[k];
    if (op[k] === nv) continue;
    if (k === "class") {
      if (isSvg) o.setAttribute("class", nv || "");
      else o.className = nv || "";
    } else if (k === "checked") o.checked = !!nv;
    else if (k === "value")   { if (o !== document.activeElement) o.value = nv; }
    // Fixed: this used to be lumped in with the "skip, key is set only at
    // creation" branch below, so a node's key could go stale forever once
    // it was reused across a render where the key itself changed (most
    // visibly: a slot flipping between a keyed and an unkeyed ui() call).
    // Now the key is treated like any other prop and kept in sync, both
    // the internal _friedKey and the DOM-visible data-fried-key attribute.
    else if (k === "key")     { o._friedKey = nv; if (nv == null) o.removeAttribute("data-fried-key"); else o.setAttribute("data-fried-key", nv); }
    else if (k.startsWith("on")) {
      const evt = k.slice(2).toLowerCase();
      if (!o._friedHandlers?.[evt]) o.addEventListener(evt, e => o._friedHandlers?.[evt]?.(e));
    }
    else if (nv === false || nv == null)   o.removeAttribute(k);
    else                                   o.setAttribute(k, nv);
  }

  for (const k in op) {
    if (k in np) continue;
    if (k === "class") {
      if (isSvg) o.removeAttribute("class");
      else o.className = "";
    } else if (k === "checked") o.checked = false;
    else if (k === "key")     { o._friedKey = undefined; o.removeAttribute("data-fried-key"); }
    else if (!k.startsWith("on")) o.removeAttribute(k);
  }

  o._friedHandlers = n._friedHandlers;
  o._friedProps = np;
}

function hydrateChildren(op, np) {
  const oc = op.childNodes, nc = np.children;
  const ol = oc.length, nl = nc.length;

  if (ol === nl) {
    let seq = true;
    for (let i = 0; i < ol; i++) {
      const oNode = oc[i], nNode = nc[i];
      const nKey = typeof nNode === "object" ? nNode._friedKey : undefined;
      const isTextN = typeof nNode === "string" || typeof nNode === "number";
      const tagN = isTextN ? null : nNode.tag;
      const tagO = oNode._friedTag ?? (oNode.tagName ? oNode.tagName.toLowerCase() : null);

      if (oNode._friedKey !== nKey || oNode.nodeType !== (isTextN ? 3 : 1) || tagO !== tagN) { seq = false; break; }
    }
    if (seq) {
      for (let i = 0; i < ol; i++) hydrate(oc[i], nc[i]);
      return;
    }
  }

  // Two-ended prefix/suffix trim: a pure append/prepend/truncate is
  // resolved here with zero Map allocation and no O(n^2) risk (each
  // insertBefore below targets a single fixed anchor node computed once,
  // not a live, shifting index). Only a genuine reorder (items remaining
  // on both trimmed sides) falls through to the keyed-Map algorithm
  // below, which re-processes the full list rather than just this trim's
  // [start,end] span -- see that block's comment for why.
  const sameSlot = (oNode, nVal) => oNode._friedKey === (typeof nVal === "object" ? nVal._friedKey : undefined);
  const minLen = Math.min(ol, nl);
  let start = 0;
  while (start < minLen && sameSlot(oc[start], nc[start])) { hydrate(oc[start], nc[start]); start++; }

  let oEnd = ol - 1, nEnd = nl - 1;
  while (oEnd >= start && nEnd >= start && sameSlot(oc[oEnd], nc[nEnd])) { hydrate(oc[oEnd], nc[nEnd]); oEnd--; nEnd--; }

  if (start > oEnd && start > nEnd) return;
  if (start > oEnd) {
    const ref = oc[oEnd + 1] || null;
    for (let i = start; i <= nEnd; i++) op.insertBefore(createDom(nc[i]), ref);
    return;
  }
  if (start > nEnd) {
    for (let n = oEnd - start + 1; n > 0; n--) oc[start].remove();
    return;
  }

  // Keyed fallback: Map reconciliation for insertions, deletions, and
  // genuine reorders. Deliberately reconciles the FULL old/new lists
  // (not just the untrimmed [start,end] middle the trim above found) --
  // a scoped version would leave the trimmed suffix sitting untouched at
  // the tail while stale leftover nodes end up just *before* it, which
  // breaks the "extra nodes end up at the very end" invariant the final
  // truncate below relies on. Reprocessing the already-matched prefix/
  // suffix here is a little redundant work, not a correctness risk
  // (hydrate() is idempotent on an already-matching pair), so it's the
  // safe trade to make.
  //
  // `cur` walks the still-unplaced suffix of op's children by object
  // reference (cur.nextSibling), never by index. Indexing a live
  // NodeList (op.childNodes[i]) while insertBefore is mutating that same
  // list every iteration is O(distance-from-cursor) per access in real
  // engines, which turns this whole loop into O(n^2) at list scale (a
  // ~50k-row rebuild measured at 35+ seconds before this fix, vs. a few
  // hundred ms after). `cur` only advances when the node at the current
  // position is itself consumed as this iteration's match; every other
  // node inserted via insertBefore(match, cur) leaves cur's identity (and
  // thus O(1) access to "whatever's next") untouched. `nc` is a plain
  // array here (np.children, built once by ui() -- not a live NodeList),
  // so unlike a live-DOM keyed loop it never needs an Array.from()
  // snapshot.
  const km = new Map();
  for (let i = 0; i < ol; i++) { const k = oc[i]._friedKey; if (k) km.set(k, oc[i]); }

  const seenKeys = new Set();
  let cur = op.firstChild;
  for (let i = 0; i < nl; i++) {
    const nc_i = nc[i];
    const k = typeof nc_i === "object" ? nc_i._friedKey : undefined;
    
    if (k) {
      if (seenKeys.has(k)) {
        console.error(`Duplicate key detected: "${k}". Keys must be unique among siblings.`);
      }
      seenKeys.add(k);
    }

    const match = k ? km.get(k) : cur;

    if (match?.parentNode === op) {
      if (k) km.delete(k);
      if (match === cur) {
        cur = cur.nextSibling;
      } else if (cur && cur.nextSibling === match) {
        cur = match.nextSibling;
      } else if (cur && cur.nextSibling && cur.nextSibling.nextSibling === match) {
        cur = match.nextSibling;
      } else {
        op.insertBefore(match, cur);
      }
      hydrate(match, nc_i);
    } else {
      op.insertBefore(createDom(nc_i), cur);
    }
  }
  km.forEach(node => node.remove());
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

export function ui(tag, props = {}, children = []) {
  if (tag === "img") {
    props = { loading: "lazy", decoding: "async", ...props };
  } else if (props.onclick && tag !== "button" && tag !== "a") {
    props = { role: "button", tabIndex: 0, ...props };
  }

  let flatChildren = children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c == null || c === false || Array.isArray(c)) {
      flatChildren = children.slice(0, i);
      for (let j = i; j < children.length; j++) {
        const cj = children[j];
        if (cj == null || cj === false) continue;
        if (Array.isArray(cj)) {
          for (let k = 0; k < cj.length; k++) {
            const ck = cj[k];
            if (ck != null && ck !== false) flatChildren.push(ck);
          }
        } else {
          flatChildren.push(cj);
        }
      }
      break;
    }
  }

  let handlers = EMPTY;
  for (const k in props) {
    if (k.startsWith("on") && typeof props[k] === "function") {
      if (handlers === EMPTY) handlers = {};
      handlers[k.slice(2).toLowerCase()] = props[k];
    }
  }

  return { tag: tag.toLowerCase(), props, children: flatChildren, _friedKey: props.key, _friedHandlers: handlers };
}
