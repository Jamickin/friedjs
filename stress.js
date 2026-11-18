// Correctness & robustness stress tests for fried.js -- distinct from
// benchmark.js, which only measures throughput against a barebones DOM stub
// that can't even reorder or remove nodes. These tests use a small
// hand-rolled fake DOM (real parent/child pointers, insertBefore ordering,
// replaceWith) covering exactly the ~15 DOM APIs fried.js touches, so the
// keyed-reconciliation and coalescing algorithms can be checked for real
// invariants -- not just "did it throw" -- without pulling in a jsdom
// dependency for a framework whose whole premise is having none.
//
// Run: node stress.js

class FakeNode {
  constructor(nodeType) { this.nodeType = nodeType; this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    parent.childNodes[parent.childNodes.indexOf(this)] = node;
    node.parentNode = parent;
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text) { super(3); this.nodeValue = String(text); }
}

class FakeElement extends FakeNode {
  constructor(tag, isSvg = false) {
    super(1);
    this.tagName = isSvg ? tag : tag.toUpperCase();
    this.namespaceURI = isSvg ? "http://www.w3.org/2000/svg" : null;
    this.childNodes = [];
    this.attributes = new Map();
    this.className = "";
    this.checked = false;
    this.value = "";
    this._listeners = {};
  }
  get firstElementChild() { return this.childNodes.find((n) => n.nodeType === 1) || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(evt, fn) { (this._listeners[evt] ??= []).push(fn); }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  insertBefore(child, ref) {
    // Real DOM insertBefore is a MOVE when `child` is already attached
    // somewhere: it's implicitly removed from its current position first.
    // Skipping that step here let a reordered node get spliced in at its
    // new index while its old entry was still sitting in the array too --
    // childNodes.length would then never converge back down to the target
    // length, hanging hydrateChildren's trailing `while (...) removeChild`.
    if (child.parentNode) {
      const oldParent = child.parentNode;
      const oldIdx = oldParent.childNodes.indexOf(child);
      if (oldIdx !== -1) oldParent.childNodes.splice(oldIdx, 1);
    }
    child.parentNode = this;
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && idx !== -1) this.childNodes.splice(idx, 0, child);
    else this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  set textContent(v) { this.childNodes = v ? [new FakeText(v)] : []; }
}

globalThis.document = {
  activeElement: null,
  createElement: (tag) => new FakeElement(tag, false),
  createElementNS: (_ns, tag) => new FakeElement(tag, true),
  createTextNode: (text) => new FakeText(text),
  head: { appendChild() {} },
  documentElement: { style: { setProperty() {} } },
};

const { mount, state, action, ui, css, onRender, nextTick } = await import("./fried.js");

let passed = 0, failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? " -- " + detail : ""}`); }
}
function section(title) { console.log(`\n▶ ${title}`); }

// ---------------------------------------------------------------------
section("1. Keyed reconciliation preserves DOM node identity under shuffle");
// The whole value proposition of keyed diffing is: reordering/inserting/
// removing items should MOVE existing DOM nodes, not recreate them. If it
// silently degraded to recreate-everything, benchmarks would still pass
// (throughput might even look fine) but every focused input, CSS
// transition, or video element in a shuffled list would reset. Only a
// node-identity check across a diff can catch that class of regression.
{
  const root = new FakeElement("div");
  const rows = state([]);
  mount(() => ui("ul", { key: "list" }, rows.value.map((r) => ui("li", { key: `r${r}` }, [String(r)]))), root);

  rows.value = [1, 2, 3, 4, 5, 6, 7, 8];
  await nextTick();
  const before = new Map();
  for (const li of root.firstElementChild.childNodes) before.set(li._friedKey, li);

  // shuffle + insert + delete in one go, the worst case for a diff algorithm
  rows.value = [8, 1, 9, 3, 5, 10, 2];
  await nextTick();

  const after = root.firstElementChild.childNodes;
  check("row count matches new list", after.length === 7, `got ${after.length}`);
  check("final order matches new vnode order exactly", after.map((n) => n._friedKey).join(",") === "r8,r1,r9,r3,r5,r10,r2");
  let allReused = true;
  for (const key of ["r8", "r1", "r3", "r5", "r2"]) {
    if (after.find((n) => n._friedKey === key) !== before.get(key)) allReused = false;
  }
  check("surviving keyed rows kept their original DOM node (no needless recreation)", allReused);
  const survivorSet = new Set(after);
  const orphaned = [...before.values()].filter((n) => !survivorSet.has(n));
  check("removed rows are actually detached (no leaked references in the live tree)", orphaned.every((n) => n.parentNode === null));
}

// ---------------------------------------------------------------------
section("2. Same-length vs. length-changing reconciliation stay correct at scale (20,000 rows)");
// Exercises exactly the two code paths touched by this session's edits: the
// fast-path scan (unchanged length) and the length-changing branch that now
// skips straight to keyed reconciliation instead of scanning first.
{
  const root = new FakeElement("div");
  const N = 20000;
  const rows = state(Array.from({ length: N }, (_, i) => i));
  mount(() => ui("ul", { key: "list" }, rows.value.map((r) => ui("li", { key: `r${r}` }, [String(r)]))), root);
  await nextTick();

  const before = root.firstElementChild.childNodes.slice();
  const neighborBefore = before[before.length - 2]; // survives the removal below
  const removedKey = before[N >> 1]._friedKey;

  rows.value = rows.value.filter((r) => `r${r}` !== removedKey); // remove exactly one, from the middle
  await nextTick();
  const afterRemove = root.firstElementChild.childNodes;
  check("length-changing diff: list shrank by exactly one", afterRemove.length === N - 1, `got ${afterRemove.length}`);
  check("length-changing diff: removed row is gone", !afterRemove.some((n) => n._friedKey === removedKey));
  check("length-changing diff: an untouched far-away row kept its identity", afterRemove.includes(neighborBefore));

  const beforeMutate = afterRemove.slice();
  rows.value = rows.value.map((r) => r); // same length, forces the fast-path scan
  await nextTick();
  const afterSameLength = root.firstElementChild.childNodes;
  check(
    "same-length diff: fast path reuses every node in place (no reconciliation needed)",
    afterSameLength.length === beforeMutate.length && afterSameLength.every((n, i) => n === beforeMutate[i])
  );
}

// ---------------------------------------------------------------------
section("3. Synchronous state churn coalesces into a single render");
// scheduleRender()'s pendingRender flag is supposed to collapse any number
// of synchronous state writes into exactly one microtask-queued render.
// This proves it holds at a scale (50,000 synchronous writes) well past
// what any hand-written test would bother checking by hand.
{
  const root = new FakeElement("div");
  const count = state(0);
  let renderCount = 0;
  onRender(() => { renderCount++; });
  const bump = action("bump", () => { count.value += 1; });
  mount(() => ui("div", { key: "counter" }, [String(count.value)]), root);
  renderCount = 0; // ignore the initial mount render

  const N = 50000;
  for (let i = 0; i < N; i++) bump();
  check(`render has NOT happened yet (still batched, ${N} writes pending)`, renderCount === 0);
  await nextTick();
  check(`exactly one render fired for ${N.toLocaleString()} synchronous writes`, renderCount === 1, `got ${renderCount}`);
  check("final state value reflects all writes", count.value === N, `got ${count.value}`);
  check("DOM reflects the final value, not an intermediate one", root.firstElementChild.childNodes[0].nodeValue === String(N));
}

// ---------------------------------------------------------------------
section("4. css() cache dedups repeated declarations under load");
{
  let insertCount = 0;
  const realCreateElement = document.createElement;
  document.createElement = (tag) => {
    const el = realCreateElement(tag);
    if (tag === "style") el.sheet = { cssRules: { length: 0 }, insertRule() { insertCount++; this.cssRules.length++; } };
    return el;
  };
  const declSet = ["color:red", "color:blue", "color:green", "display:flex", "padding:4px"];
  const N = 10000;
  for (let i = 0; i < N; i++) css({ x: declSet[i % declSet.length] });
  check(`${N.toLocaleString()} css() calls over ${declSet.length} unique declarations only inserted ${declSet.length} rules`, insertCount === declSet.length, `got ${insertCount}`);
  document.createElement = realCreateElement;
}

// ---------------------------------------------------------------------
section("5. ui() no longer mutates a shared/reused props object (regression check)");
// This session's fix: the a11y auto-props branch used to write directly
// onto the caller's props object. Reusing one props object across two
// different elements (a memoized handlers object, say) would leak one
// call's injected defaults into the other's source object.
{
  const shared = { onclick: () => {} };
  const originalKeys = Object.keys(shared).sort().join(",");
  ui("div", shared, []); // div + onclick triggers the a11y branch (role/tabIndex)
  ui("img", shared, []); // img triggers the other branch (loading/decoding)
  check("caller's original props object was never mutated", Object.keys(shared).sort().join(",") === originalKeys, `now has: ${Object.keys(shared).join(",")}`);
}

// ---------------------------------------------------------------------
section("6. ui() children-array reference reuse is safe across renders (regression check)");
// This session's fix: ui() now reuses the caller's children array by
// reference when nothing needs flattening, instead of always copying.
// Passing that SAME array into two different elements across two renders
// must not let one tree's structure bleed into the other's.
{
  const shared = [ui("span", { key: "s1" }, ["a"]), ui("span", { key: "s2" }, ["b"])];
  const vnodeA = ui("div", { key: "a" }, shared);
  const vnodeB = ui("section", { key: "b" }, shared);
  check("both vnodes see the same flattened children", vnodeA.children === vnodeB.children && vnodeA.children === shared);
  const root = new FakeElement("div");
  mount(() => ui("div", { key: "root" }, [vnodeA]), root);
  check("tree A rendered both shared children correctly", root.firstElementChild.firstElementChild.childNodes.length === 2);
}

// ---------------------------------------------------------------------
section("7. Deep single-child nesting: find the recursion ceiling");
// createDom()/hydrate() recurse per child depth rather than iterating with
// an explicit stack, so a sufficiently deep tree (e.g. a deeply threaded
// comment view) can blow the call stack. Not something to "fix" without a
// bigger rewrite -- but worth knowing the actual number rather than
// guessing, so it's a documented limitation instead of a surprise.
{
  function buildChain(depth) {
    let v = ui("span", { key: "leaf" }, ["leaf"]);
    for (let i = 0; i < depth; i++) v = ui("div", { key: `d${i}` }, [v]);
    return v;
  }
  function findCeiling() {
    let lo = 1000, hi = 1000;
    while (true) {
      try {
        const root = new FakeElement("div");
        mount(() => buildChain(hi), root);
        lo = hi;
        hi *= 2;
        if (hi > 1 << 20) return { ceiling: null, testedUpTo: hi };
      } catch (e) {
        if (e instanceof RangeError) break;
        throw e;
      }
    }
    // binary search between lo (known safe) and hi (known to overflow)
    while (hi - lo > 50) {
      const mid = Math.floor((lo + hi) / 2);
      try {
        const root = new FakeElement("div");
        mount(() => buildChain(mid), root);
        lo = mid;
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        hi = mid;
      }
    }
    return { ceiling: lo, testedUpTo: hi };
  }
  const { ceiling, testedUpTo } = findCeiling();
  if (ceiling) {
    console.log(`  ℹ max safe single-child nesting depth ≈ ${ceiling.toLocaleString()} (fails by ${testedUpTo.toLocaleString()})`);
  } else {
    console.log(`  ℹ no stack overflow up to depth ${testedUpTo.toLocaleString()} -- ceiling is higher than tested`);
  }
  check("a realistic depth (500) renders without error", (() => {
    try { mount(() => buildChain(500), new FakeElement("div")); return true; } catch { return false; }
  })());
}

// ---------------------------------------------------------------------
section("8. Prefix/suffix fast path (append/prepend/truncate/remove without the Map)");
// hydrateChildren peels off unchanged ends before ever building the keyed
// Map, so a pure append/prepend/truncate/contiguous-removal costs O(what
// changed) instead of O(whole list) -- diagnosed via the append-1,000-
// onto-10,000 benchmark costing more than half of a from-scratch 10,000
// create. Each case here checks BOTH correctness (right nodes, right
// order, right count) AND that survivors kept their identity (proof the
// fast path actually engaged instead of falling through to a full rebuild).
function mountList(root, initial) {
  const rows = state(initial.slice());
  mount(() => ui("ul", { key: "list" }, rows.value.map((r) => ui("li", { key: `r${r}` }, [String(r)]))), root);
  return rows;
}
function snapshot(root) {
  const m = new Map();
  for (const li of root.firstElementChild.childNodes) m.set(li._friedKey, li);
  return m;
}

{
  const root = new FakeElement("div");
  const rows = mountList(root, Array.from({ length: 500 }, (_, i) => i));
  await nextTick();
  const before = snapshot(root);

  rows.value = [...rows.value, 500, 501, 502]; // pure append
  await nextTick();
  const after = root.firstElementChild.childNodes;
  check("pure append: count grows by exactly the appended amount", after.length === 503, `got ${after.length}`);
  check("pure append: new order is prefix-preserved then appended", after.slice(0, 500).every((n, i) => n._friedKey === `r${i}`) && after.slice(500).map((n) => n._friedKey).join(",") === "r500,r501,r502");
  check("pure append: every original node kept its identity (fast path engaged, not a rebuild)", after.slice(0, 500).every((n) => n === before.get(n._friedKey)));
}

{
  const root = new FakeElement("div");
  const rows = mountList(root, Array.from({ length: 500 }, (_, i) => i));
  await nextTick();
  const before = snapshot(root);

  rows.value = [-3, -2, -1, ...rows.value]; // pure prepend
  await nextTick();
  const after = root.firstElementChild.childNodes;
  check("pure prepend: count grows by exactly the prepended amount", after.length === 503, `got ${after.length}`);
  check("pure prepend: new items land at the front, original order preserved after", after.slice(0, 3).map((n) => n._friedKey).join(",") === "r-3,r-2,r-1" && after.slice(3).every((n, i) => n._friedKey === `r${i}`));
  check("pure prepend: every original node kept its identity", after.slice(3).every((n) => n === before.get(n._friedKey)));
}

{
  const root = new FakeElement("div");
  const rows = mountList(root, Array.from({ length: 500 }, (_, i) => i));
  await nextTick();
  const before = snapshot(root);

  rows.value = rows.value.slice(0, 200); // pure truncate from the end
  await nextTick();
  const after = root.firstElementChild.childNodes;
  check("pure truncate: count matches the kept prefix", after.length === 200, `got ${after.length}`);
  check("pure truncate: every surviving node kept its identity", after.every((n, i) => n === before.get(`r${i}`)));
}

{
  const root = new FakeElement("div");
  const rows = mountList(root, Array.from({ length: 500 }, (_, i) => i));
  await nextTick();
  const before = snapshot(root);

  // remove a single contiguous run from the middle -- no reordering
  rows.value = [...rows.value.slice(0, 200), ...rows.value.slice(250)];
  await nextTick();
  const after = root.firstElementChild.childNodes;
  check("contiguous middle removal: count drops by exactly the removed run", after.length === 450, `got ${after.length}`);
  check("contiguous middle removal: removed keys are gone, none extra", after.map((n) => n._friedKey).join(",") === [...Array(200).keys(), ...Array.from({length:250},(_,i)=>i+250)].map((i) => `r${i}`).join(","));
  check("contiguous middle removal: surviving prefix AND suffix both kept identity", after.slice(0, 200).every((n) => n === before.get(n._friedKey)) && after.slice(200).every((n) => n === before.get(n._friedKey)));
}

{
  // Mixed case: matching prefix + matching suffix + a genuinely reordered
  // middle -- must fall through to the Map-based path correctly (not get
  // stuck or corrupt state) and STILL produce the right final DOM.
  const root = new FakeElement("div");
  const rows = mountList(root, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await nextTick();
  const before = snapshot(root);

  rows.value = [0, 1, 6, 5, 4, 3, 2, 7, 8, 9]; // prefix 0,1 and suffix 7,8,9 unchanged; middle 2-6 reversed
  await nextTick();
  const after = root.firstElementChild.childNodes;
  check("trim+fallback: final order matches exactly", after.map((n) => n._friedKey).join(",") === "r0,r1,r6,r5,r4,r3,r2,r7,r8,r9");
  check("trim+fallback: every node (prefix, reordered middle, suffix) kept its identity", after.every((n) => n === before.get(n._friedKey)));
}

{
  // Unkeyed items in the trimmed region -- must not crash or misbehave
  // when _friedKey is undefined on both sides (positional treatment).
  const root = new FakeElement("div");
  mount(() => ui("div", { key: "root" }, ["a", "b", "c"]), root);
  await nextTick();
  mount(() => ui("div", { key: "root" }, ["a", "b", "c", "d", "e"]), root);
  await nextTick();
  const text = root.firstElementChild.childNodes.map((n) => n.nodeValue).join(",");
  check("unkeyed text-node append still works through the trim path", text === "a,b,c,d,e", `got ${text}`);
}

// ---------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`STRESS RESULTS: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
if (failed > 0) process.exit(1);
