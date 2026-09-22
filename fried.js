// fried.js -- a minimal runtime for apps meant to be written and edited by
// an AI agent. There is no new syntax here: this is real, ordinary
// JavaScript, loaded as an ES module with no build step.
//
// Hydration & Fast-Path In-Place Reconciliation (Vue/Svelte-inspired):
// Uses fast-path 1-to-1 diffing and pure-JS prop tracking to avoid
// slow DOM reflection overhead. Retains existing DOM nodes, batches
// renders via microtasks, and stays tiny (<150 lines).

let root = null;
let renderFn = null;
let pendingRender = false;
let renderHooks = [];

export function mount(rootRenderFn, el) {
  renderFn = rootRenderFn;
  root = el;
  render();
}

/** Registers a callback hook invoked after every render cycle with timing metrics */
export function onRender(fn) {
  renderHooks.push(fn);
  return () => {
    renderHooks = renderHooks.filter((h) => h !== fn);
  };
}

/** Schedules a microtask render to batch synchronous state mutations (Vue-style) */
function scheduleRender() {
  if (pendingRender) return;
  pendingRender = true;
  queueMicrotask(() => {
    pendingRender = false;
    render();
  });
}

/** Synchronous flush / render */
export function render() {
  if (!root || !renderFn) return;
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const nextNode = renderFn();
  const tTree = (typeof performance !== "undefined" ? performance.now() : 0) - t0;

  if (!nextNode) {
    root.innerHTML = "";
    return;
  }

  const tHydrate0 = typeof performance !== "undefined" ? performance.now() : 0;
  if (!root.firstElementChild) {
    root.appendChild(nextNode);
  } else {
    hydrate(root.firstElementChild, nextNode);
  }
  const tHydrate = (typeof performance !== "undefined" ? performance.now() : 0) - tHydrate0;
  const tTotal = (typeof performance !== "undefined" ? performance.now() : 0) - t0;

  for (const hook of renderHooks) {
    try {
      hook({ tTree, tHydrate, tTotal, timestamp: Date.now() });
    } catch (_) {}
  }
}

/** Vue-style nextTick for awaiting DOM updates */
export function nextTick(fn) {
  return fn ? queueMicrotask(fn) : new Promise((res) => queueMicrotask(res));
}

/** In-place DOM reconciliation / hydration */
function hydrate(oldNode, newNode) {
  // 1. Text node reconciliation
  if (oldNode.nodeType === 3 && newNode.nodeType === 3) {
    if (oldNode.nodeValue !== newNode.nodeValue) {
      oldNode.nodeValue = newNode.nodeValue;
    }
    return oldNode;
  }

  // 2. Tag name or node type mismatch -> replace node
  if (oldNode.nodeType !== newNode.nodeType || oldNode.tagName !== newNode.tagName) {
    oldNode.replaceWith(newNode);
    return newNode;
  }

  // 3. Fast-path attribute & property reconciliation via cached JS props
  hydrateAttributes(oldNode, newNode);

  // 4. Hydrate child nodes
  hydrateChildren(oldNode, newNode);

  return oldNode;
}

function hydrateAttributes(oldEl, newEl) {
  const oldProps = oldEl._friedProps || {};
  const newProps = newEl._friedProps || {};

  // Remove deleted attributes / properties
  for (const k in oldProps) {
    if (!(k in newProps)) {
      if (k === "class") oldEl.className = "";
      else if (k === "checked") oldEl.checked = false;
      else if (!k.startsWith("on") && k !== "key") oldEl.removeAttribute(k);
    }
  }

  // Set updated or added attributes / properties
  for (const k in newProps) {
    const nextVal = newProps[k];
    if (oldProps[k] === nextVal) continue;

    if (k === "class") {
      oldEl.className = nextVal || "";
    } else if (k === "checked") {
      oldEl.checked = !!nextVal;
    } else if (k === "value") {
      if (oldEl !== (typeof document !== "undefined" && document.activeElement)) {
        oldEl.value = nextVal;
      }
    } else if (k.startsWith("on")) {
      // Event handler closure updated below
    } else if (k === "key") {
      // Never set key as a DOM attribute
    } else if (nextVal === false || nextVal == null) {
      // Boolean prop became false/null → remove the attribute (fixes disabled, hidden, etc.)
      oldEl.removeAttribute(k);
    } else {
      oldEl.setAttribute(k, nextVal);
    }
  }

  // Forward event handlers to latest closure
  if (newEl._friedHandlers) {
    oldEl._friedHandlers = Object.assign(oldEl._friedHandlers || {}, newEl._friedHandlers);
  }
  oldEl._friedProps = newProps;
}

function hydrateChildren(oldParent, newParent) {
  const oldNodes = oldParent.childNodes;
  const newNodes = newParent.childNodes;
  const oldLen = oldNodes.length;
  const newLen = newNodes.length;

  // Fast-Path: Check if children are in the exact same sequence (covers 99% of re-renders)
  const commonLen = Math.min(oldLen, newLen);
  let isIdenticalSequence = true;

  for (let i = 0; i < commonLen; i++) {
    const o = oldNodes[i];
    const n = newNodes[i];
    if (o._friedKey !== n._friedKey || o.nodeType !== n.nodeType || o.tagName !== n.tagName) {
      isIdenticalSequence = false;
      break;
    }
  }

  if (isIdenticalSequence && oldLen === newLen) {
    // ⚡ Fast path: In-place 1-to-1 diff without Map allocation or insertBefore
    for (let i = 0; i < oldLen; i++) {
      hydrate(oldNodes[i], newNodes[i]);
    }
    return;
  }

  // Fallback: Keyed Map reconciliation for insertions, deletions, and reordering
  const keyMap = new Map();
  for (let i = 0; i < oldLen; i++) {
    const key = oldNodes[i]._friedKey;
    if (key) keyMap.set(key, oldNodes[i]);
  }

  for (let i = 0; i < newLen; i++) {
    const newChild = newNodes[i];
    const key = newChild._friedKey;
    const oldChild = key ? keyMap.get(key) : oldNodes[i];

    if (oldChild && oldChild.parentNode === oldParent) {
      if (key) keyMap.delete(key);
      const currentAtPos = oldParent.childNodes[i];
      if (currentAtPos !== oldChild) {
        oldParent.insertBefore(oldChild, currentAtPos || null);
      }
      hydrate(oldChild, newChild);
    } else {
      const currentAtPos = oldParent.childNodes[i];
      oldParent.insertBefore(newChild, currentAtPos || null);
    }
  }

  // Remove excess old children
  while (oldParent.childNodes.length > newLen) {
    oldParent.removeChild(oldParent.lastChild);
  }
}

/** A reactive box. Reassigning `.value` triggers a batched re-render. */
export function state(initial) {
  let v = initial;
  return {
    get value() {
      return v;
    },
    set value(next) {
      if (v === next) return;
      v = next;
      scheduleRender();
    },
  };
}

/** Wraps a function as a named action */
export function action(name, fn) {
  const wrapped = (...args) => {
    const result = fn(...args);
    scheduleRender();
    return result;
  };
  wrapped.friedActionName = name;
  return wrapped;
}

/**
 * Hyperscript-style element builder: ui(tag, props, children) -> a real
 * DOM element with event delegation and data-fried-key for AST & hydration.
 */
export function ui(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  el._friedProps = props;
  el._friedKey = props.key;

  for (const [k, v] of Object.entries(props)) {
    if (k === "key") {
      el.dataset.friedKey = v;
    } else if (k.startsWith("on") && typeof v === "function") {
      const eventName = k.slice(2).toLowerCase();
      el._friedHandlers = el._friedHandlers || {};
      el._friedHandlers[eventName] = v;
      el.addEventListener(eventName, (e) => el._friedHandlers?.[eventName]?.(e));
    } else if (k === "class") {
      el.className = v;
    } else if (k === "checked") {
      el.checked = !!v;
    } else if (v !== false && v != null) {
      el.setAttribute(k, v);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.appendChild(
      typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child
    );
  }
  return el;
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}
