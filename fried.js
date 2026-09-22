// fried.js -- a minimal runtime for apps meant to be written and edited by
// an AI agent. There is no new syntax here: this is real, ordinary
// JavaScript, loaded as an ES module with no build step.
//
// Hydration & In-Place Reconciliation (Vue/Svelte-inspired):
// Instead of destructive full re-renders (root.innerHTML = ""), this uses
// lightweight in-place DOM hydration. It preserves existing DOM nodes,
// synchronizes attributes/text, and uses `data-fried-key` for keyed
// child reconciliation. State changes are batched into microtasks to prevent
// layout thrashing and lag spikes, all while keeping the runtime tiny (~130 lines).

let root = null;
let renderFn = null;
let pendingRender = false;

export function mount(rootRenderFn, el) {
  renderFn = rootRenderFn;
  root = el;
  render();
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
  const nextNode = renderFn();
  if (!nextNode) {
    root.innerHTML = "";
    return;
  }
  if (!root.firstElementChild) {
    root.appendChild(nextNode);
  } else {
    hydrate(root.firstElementChild, nextNode);
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

  // 3. Hydrate attributes, properties & event handlers
  hydrateAttributes(oldNode, newNode);

  // 4. Hydrate child nodes (keyed via data-fried-key)
  hydrateChildren(oldNode, newNode);

  return oldNode;
}

function hydrateAttributes(oldEl, newEl) {
  // Remove attributes no longer present
  for (const attr of Array.from(oldEl.attributes || [])) {
    if (!newEl.hasAttribute(attr.name)) {
      oldEl.removeAttribute(attr.name);
    }
  }

  // Set new or changed attributes
  for (const attr of Array.from(newEl.attributes || [])) {
    if (oldEl.getAttribute(attr.name) !== attr.value) {
      oldEl.setAttribute(attr.name, attr.value);
    }
  }

  // Synchronize dynamic properties
  if (oldEl.className !== newEl.className) {
    oldEl.className = newEl.className;
  }
  if ("checked" in newEl && oldEl.checked !== newEl.checked) {
    oldEl.checked = newEl.checked;
  }
  if ("value" in newEl && oldEl.value !== newEl.value && oldEl !== (typeof document !== "undefined" && document.activeElement)) {
    oldEl.value = newEl.value;
  }

  // Forward event handlers to latest closure
  if (newEl._friedHandlers) {
    oldEl._friedHandlers = oldEl._friedHandlers || {};
    Object.assign(oldEl._friedHandlers, newEl._friedHandlers);
  }
}

function hydrateChildren(oldParent, newParent) {
  const oldCh = Array.from(oldParent.childNodes);
  const newCh = Array.from(newParent.childNodes);

  // Build index of existing keyed children
  const keyMap = new Map();
  for (let i = 0; i < oldCh.length; i++) {
    const key = oldCh[i].dataset?.friedKey;
    if (key) keyMap.set(key, oldCh[i]);
  }

  for (let i = 0; i < newCh.length; i++) {
    const newChild = newCh[i];
    const key = newChild.dataset?.friedKey;
    const oldChild = key ? keyMap.get(key) : oldCh[i];

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
  while (oldParent.childNodes.length > newCh.length) {
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

/**
 * Wraps a function as a named action: after it runs, the app re-renders.
 * The name is never used at runtime -- it exists so a later AST patch can
 * find `action("toggle", ...)` by searching for that string literal.
 */
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
