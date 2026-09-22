// debug-test.js
// Mock full DOM to test toggleChaosTicker and fast-path hydration in Node
class MockNode {
  constructor(type, name = "") {
    this.nodeType = type;
    this.nodeName = name.toUpperCase();
    this.tagName = type === 1 ? name.toUpperCase() : undefined;
    this.nodeValue = type === 3 ? name : null;
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this._friedHandlers = {};
    this._friedProps = null;
    this._friedKey = null;
    this.className = "";
    this.checked = false;
    this.attributes = {};
  }

  get firstElementChild() {
    return this.childNodes.find((c) => c.nodeType === 1) || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }

  hasAttribute(k) {
    return k in this.attributes;
  }

  getAttribute(k) {
    return this.attributes[k] || null;
  }

  removeAttribute(k) {
    delete this.attributes[k];
  }

  addEventListener(event, fn) {
    this._friedHandlers[event] = fn;
  }

  dispatchEvent(event) {
    const fn = this._friedHandlers[event];
    if (fn) fn({ type: event, target: this, preventDefault() {} });
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    if (newChild.parentNode) {
      const idx = newChild.parentNode.childNodes.indexOf(newChild);
      if (idx !== -1) newChild.parentNode.childNodes.splice(idx, 1);
    }
    newChild.parentNode = this;
    if (!refChild) {
      this.childNodes.push(newChild);
    } else {
      const idx = this.childNodes.indexOf(refChild);
      if (idx !== -1) {
        this.childNodes.splice(idx, 0, newChild);
      } else {
        this.childNodes.push(newChild);
      }
    }
    return newChild;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  replaceWith(newNode) {
    if (!this.parentNode) return;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx !== -1) {
      if (newNode.parentNode) {
        const nIdx = newNode.parentNode.childNodes.indexOf(newNode);
        if (nIdx !== -1) newNode.parentNode.childNodes.splice(nIdx, 1);
      }
      newNode.parentNode = this.parentNode;
      this.parentNode.childNodes.splice(idx, 1, newNode);
      this.parentNode = null;
    }
  }
}

globalThis.document = {
  createElement(tag) {
    return new MockNode(1, tag);
  },
  createTextNode(text) {
    return new MockNode(3, String(text));
  },
  getElementById() {
    return new MockNode(1, "div");
  },
};
globalThis.window = {
  location: { href: "http://localhost:8080/" },
  screen: { width: 1920, height: 1080 },
};
globalThis.navigator = {
  userAgent: "Mock",
  hardwareConcurrency: 8,
  deviceMemory: 16,
};

console.log("Loading app.js in mock DOM environment...");
try {
  await import("./app.js");
  console.log("app.js loaded successfully!");
} catch (err) {
  console.error("Error loading app.js:", err);
}
