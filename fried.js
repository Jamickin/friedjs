// fried.js — fast, small, AI-first reactive UI runtime.
// Real JS, ES modules, no build step, no special syntax.
// API: mount state action ui uid css cssVar onRender nextTick sliceRender render

const perf = typeof performance !== "undefined" ? performance : null;
const t = () => perf?.now() ?? 0;

let root, renderFn, pendingRender = false, renderHooks = [];

const SVG_TAGS = new Set(["svg", "path", "circle", "g", "rect", "line", "polygon", "polyline", "text"]);

export function mount(fn, el)  { renderFn = fn; root = el; render(); }
export function onRender(fn)   { renderHooks.push(fn); return () => { renderHooks = renderHooks.filter(h => h !== fn); }; }
export function nextTick(fn)   { return fn ? queueMicrotask(fn) : new Promise(queueMicrotask); }
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
  for (const h of renderHooks) { try { h({ tTree, tHydrate, tTotal: tTree + tHydrate, timestamp: Date.now() }); } catch(_) {} }
}

// -- CSS Engine ----------------------------------------------------------

let _sheet = null;
const _cssCache = new Map(); 

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
      _cssCache.set(decl, cls = "f" + _cssCache.size.toString(36));
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

function createDom(v) {
  if (typeof v === "string" || typeof v === "number") return document.createTextNode(v);

  const isSvg = SVG_TAGS.has(v.tag);
  const el = isSvg ? document.createElementNS("http://www.w3.org/2000/svg", v.tag) : document.createElement(v.tag);

  el._friedKey = v._friedKey;
  el._friedHandlers = v._friedHandlers;
  el._friedProps = v.props;
  el._friedTag = v.tag;

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
    if (op[k] === nv || k === "key") continue;
    if (k === "class") {
      if (isSvg) o.setAttribute("class", nv || "");
      else o.className = nv || "";
    } else if (k === "checked") o.checked = !!nv;
    else if (k === "value")   { if (o !== document.activeElement) o.value = nv; }
    else if (k.startsWith("on")) {
      const evt = k.slice(2).toLowerCase();
      if (!o._friedHandlers?.[evt]) o.addEventListener(evt, e => o._friedHandlers?.[evt]?.(e));
    }
    else if (nv === false || nv == null)   o.removeAttribute(k);
    else                                   o.setAttribute(k, nv);
  }

  for (const k in op) {
    if (k in np || k === "key") continue;
    if (k === "class") {
      if (isSvg) o.removeAttribute("class");
      else o.className = "";
    } else if (k === "checked") o.checked = false;
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

  // Two-ended prefix/suffix trim before the keyed Map below: a pure
  // append/prepend/truncate/contiguous-removal is resolved here with zero
  // Map allocation. Only a genuine reorder (items remaining on both
  // trimmed sides) falls through to the untouched original algorithm,
  // unscoped -- so that path carries no new risk, just a little
  // (bounded, idempotent) re-hydration of the already-synced ends.
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

  let km;
  for (let i = 0; i < ol; i++) {
    const k = oc[i]._friedKey;
    if (k) (km ??= new Map()).set(k, oc[i]);
  }

  const ncArr = nc;
  for (let i = 0; i < nl; i++) {
    const nc_i = ncArr[i];
    const k = typeof nc_i === "object" ? nc_i._friedKey : undefined;
    const match = k ? km?.get(k) : oc[i];

    if (match?.parentNode === op) {
      if (k) km.delete(k);
      if (op.childNodes[i] !== match) op.insertBefore(match, op.childNodes[i] || null);
      hydrate(match, nc_i);
    } else {
      op.insertBefore(createDom(nc_i), op.childNodes[i] || null);
    }
  }
  while (op.childNodes.length > nl) op.lastChild.remove();
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
