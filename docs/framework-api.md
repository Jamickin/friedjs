# fried.js — API reference for an AI writing or patching an app

This is the entire framework. It is plain JavaScript; nothing here is new
syntax. An AI writing an app with it needs only this page (plus
`fried-db.js` below if the app persists data), not a grammar.

> This runtime is a merge of two independently-evolved iterations of
> fried.js -- see `docs/MERGE.md` for exactly what came from where and
> why. The public API below (`mount`, `state`, `action`, `ui`, `uid`,
> `css`, `cssVar`, `onRender`, `nextTick`) is unchanged either way; what
> changed is what's happening *underneath* it (`ui()` now returns a
> lightweight virtual node rather than a real DOM element right away),
> plus new capabilities (SVG, a couple of small auto-accessibility
> defaults) folded in below.

```js
import { mount, state, action, ui, uid, css, cssVar, onRender } from "./fried.js";
```

- `state(initial)` -> a reactive box. Read the current value with `.value`.
  Reassigning `.value` (not mutating it in place) triggers a re-render.
  Setting the same value is a no-op (no re-render).
- `action(name, fn)` -> wraps `fn` so the app re-renders after it runs.
  `name` is never used at runtime; it exists purely so a later patch can
  find this exact action by searching for `action("name", ...)`. Always
  name actions descriptively and uniquely within a file.
- `ui(tag, props, children)` -> builds a lightweight **virtual node**
  (a plain object), not a real DOM element -- the actual `document.
  createElement`/`createElementNS` call only happens later, and only for
  the parts of the tree that `mount()`'s diff decides are genuinely new,
  not for anything being reused from the previous render. `svg`, `path`,
  `circle`, `g`, `rect`, `line`, `polygon`, `polyline`, and `text` tags are
  created in the SVG namespace automatically -- an ordinary `ui("svg",
  ...)`/`ui("circle", ...)` tree just works. An `<img>` gets
  `loading: "lazy", decoding: "async"` merged in by default (override by
  passing your own). A non-`button`/`a` element with an `onclick` prop gets
  `role: "button", tabIndex: 0` merged in by default, so a clickable `div`
  is keyboard-reachable and announced correctly without having to remember
  to add those yourself -- pass your own `role`/`tabIndex` to override.
  `props` is a plain object: `onclick`/`onchange`/`oninput`/etc. (lowercase,
  matching the native DOM event name) take a function, `class` sets the
  class name, `checked` sets checked, `value` sets the input value,
  anything else becomes an HTML attribute. `props.key`, if given, is both
  how the reconciler tracks this element across re-renders in a list AND
  how a later patch addresses this exact call site -- give a **static**
  string key (not one built from per-item data) to anything you might want
  patched later; use a per-item value (an id, an index) only for actual
  list items, where patch-addressability isn't the point. The key is also
  mirrored onto the real element as a `data-fried-key` attribute once it's
  created, kept in sync across renders, handy for a test/devtools selector
  (`[data-fried-key="resetBtn"]`).
  `children` is an array of strings, numbers, or other `ui(...)` results.
- `uid()` -> a random id string, handy for giving list items a stable key.
- `mount(rootFn, element)` -> calls `rootFn()` to build the (virtual) tree,
  materializes and appends it into `element` on the first call, and on
  every later re-render **diffs** the new virtual tree against the live
  DOM (via keyed reconciliation, with a fast path for a same-length
  identical-key sequence and a prefix/suffix trim before falling back to a
  full keyed-Map pass for a genuine reorder) instead of rebuilding from
  scratch -- only the parts that actually changed get a real DOM
  operation.
- `onRender(fn)` -> registers a hook called after every render with timing
  info: `{ tTree, tHydrate, tTotal, timestamp }` (`tTree` = time to build
  the new element tree, `tHydrate` = time to diff it into the live DOM).
  Returns an unsubscribe function. Useful for perf instrumentation, not
  needed for a typical app.
- `nextTick(fn?)` -> runs `fn` (or resolves a promise, if no `fn`) after
  the current render batch flushes.
- `css(rules)` -> a tiny CSS-in-JS engine. `rules` is `{ name: "decl;" }`;
  returns `{ name: "generatedClassName" }`. Injects one `<style>` tag,
  dedupes identical declaration strings by content, so calling `css(...)`
  with the same rules twice never grows the stylesheet.
- `cssVar(name, value?)` -> gets (no `value`) or sets a CSS custom property
  on `documentElement` directly. Setting one costs **zero re-renders** --
  it's a plain style write, not framework state.

That's the whole API. Everything else in an app -- arithmetic, `.filter()`,
`.map()`, `.sort()`, ternaries, template literals -- is just JavaScript the
model already knows fluently, not something this framework has to define.

## fried-db.js — optional persisted, reactive collections

```js
import { createDatabase } from "./fried-db.js";
```

- `createDatabase(name, collectionNames)` -> `{ init, collections }`.
  `init()` opens IndexedDB (creating one object store per collection,
  keyed by `id`, on first use) and returns a promise that resolves once
  each collection's initial data has loaded into memory.
- `collections[name]` -> a reactive array-backed store: `.value` (current
  array, synchronous, no `await`), `.insert(item)`, `.update(id, changes)`,
  `.remove(id)`, `.bulkInsert(items)`, `.clear()`. Every mutator is an
  `action` under the hood (auto-generated name like `db.notes.insert`) --
  it updates the in-memory `state` instantly (triggering a re-render) and
  flushes to IndexedDB in the background, fire-and-forget.
- IDs are generated client-side if not supplied on insert.

Only reach for this when an app needs data to survive a page reload.
Transient UI state (a form's current input, a toggle) should stay a plain
`state()`, not a collection.

## fried-virtual.js — optional windowed rendering for large lists

```js
import { createVirtualList } from "./fried-virtual.js";
```

fried.js has no component boundaries: any state change reruns the whole
`renderFn()` passed to `mount()`, rebuilding every `ui(...)` node in the
tree before diffing it. That's fine at ordinary UI sizes, but a list with
thousands of real rows makes *every* render -- including ones from
unrelated state elsewhere in the same tree -- pay that list's full
rebuild cost. `fried-virtual.js` fixes this the only way that actually
works: render fewer real DOM nodes. It's optional and not part of the
frozen core API, same precedent as `fried-db.js` -- reach for it once a
single list is large enough (a few hundred rows or more) that its rebuild
cost is the thing making the app feel slow.

- `createVirtualList(opts)` -> `{ attach, slice }`.
  `opts.itemHeight` (required) is the fixed px height of one row -- this
  is a fixed-row-height virtualizer, not a measuring one; that covers most
  list UIs and keeps this small. `opts.overscan` (default 6) is extra rows
  kept rendered above/below the viewport so fast scrolling doesn't flash
  empty space. `opts.viewportHeight` is the scroll container's px height,
  if known up front -- otherwise it's read from the container's own
  `clientHeight` the first time `attach()` sees it.
- `attach(scrollEl)` wires a scroll listener (throttled to one update per
  animation frame) onto the actual scrolling element -- the one you gave
  a fixed height and `overflow: auto` to in your own `ui(...)` markup.
  Call it every render (cheapest from an `onRender` hook, or right after
  building the scroll container's `ui(...)` node) -- it no-ops when
  passed the same element as last time. **Register this before calling
  `mount()`**, not after: `mount()` runs the first render synchronously,
  and a hook registered afterward misses that first render entirely,
  leaving the scroll listener never attached.
- `slice(items)` -> `{ start, end, top, bottom, rows }`, given the live
  array to window into (pass it fresh each render, this holds no copy).
  `rows` is the slice to actually build `ui(...)` nodes for. `top`/
  `bottom` are px heights for two spacer elements (or one wrapper's
  padding-top/padding-bottom) around `rows`, so the container still
  scrolls as if every item in `items` were really there.

```js
import { mount, state, ui, onRender } from "./fried.js";
import { createVirtualList } from "./fried-virtual.js";

const items = state(bigArray); // thousands of rows, fine
const vlist = createVirtualList({ itemHeight: 24, viewportHeight: 400 });

onRender(() => vlist.attach(document.querySelector('[data-fried-key="list"]')));

function renderApp() {
  const { top, bottom, rows } = vlist.slice(items.value);
  return ui("div", { key: "list", style: "height:400px;overflow:auto" }, [
    ui("div", { key: "top", style: `height:${top}px` }, []),
    ...rows.map((it) => ui("div", { key: it.key }, it.text)),
    ui("div", { key: "bottom", style: `height:${bottom}px` }, []),
  ]);
}

mount(renderApp, document.getElementById("app"));
```

Measured (Playwright, real Chromium, 50,000-item list): an unrelated
state change elsewhere in the tree drops from ~580-800ms per render and
~1.5fps down to ~0.4ms per render and a steady 60fps, since the tree
being rebuilt each time stays viewport-sized regardless of the array's
real length.

## Patch API (src/patcher.js), for making a small change afterward

- `setProp(source, key, propName, newValueSource, within?)` -- set or add a
  prop on the `ui(...)` call with this `key`. `propName` may be a plain
  identifier (`class`) or a hyphenated attribute name (`data-testid`,
  `aria-label`) -- both are quoted correctly in the output either way.
  `newValueSource` is raw JS **source text**, not a data value -- a string
  prop needs `JSON.stringify(value)` passed in (`'"task-toolbar"'`, not
  `"task-toolbar"`), or the plain string gets spliced in unquoted and
  produces syntactically-valid-but-wrong JS that `validate()` won't catch
  (see `docs/known-limitations.md`). Use `setProp` directly only when the
  value genuinely needs to be source (an arrow function, a `cssVar(...)`
  call, any other non-literal expression) -- for a plain data value, use
  `setPropValue` instead.
- `setPropValue(source, key, propName, dataValue, within?)` -- same
  addressing as `setProp`, but takes a plain JS **data value** (a string,
  number, boolean, `null`, `undefined`, a plain object/array) and
  serializes it correctly itself, sidestepping the raw-source-text
  landmine above entirely. Throws a `PatchError` immediately if
  `dataValue` is a function, `BigInt`, or `Symbol` -- those have no safe
  data serialization, so this refuses rather than producing something
  misleading; pass their source text to `setProp` instead.
- `setChildText(source, key, oldText, newText, within?)` -- replace a
  literal string child of the `ui(...)` call with this `key`. Matches
  either an inline array literal's string element (`ui(tag, props,
  ["Add Task"])`) or a bare string children argument (`ui(tag, props,
  "Add Task")`) -- either shape is fine as the target.
- `addChild(source, key, newChildSource, within?)` -- append a new child
  (given as JS source text) to the `ui(...)` call with this `key`. Works
  whether the children argument is an inline array literal (inserted into
  directly) or a reference to a `.map()`/variable/expression (rewritten in
  place as `[...(expr), newChild]` without touching wherever that
  expression was originally built).
- `removeChild(source, key, matcher, within?)` -- remove one child from the
  `ui(...)` call with this `key`. `matcher` is either the exact value of a
  literal child (a string/number, same idea as `setChildText`'s `oldText`)
  or the `key` of a nested `ui(...)` child. Only works when the children
  argument is an inline array literal -- same constraint as
  `setChildText`/the array-literal path of `addChild`.
- `replaceChild(source, key, matcher, newChildSource, within?)` -- same
  lookup as `removeChild`, but overwrites the matched child with new
  source text instead of deleting it. Unlike `setChildText`, the
  replacement isn't limited to a literal string -- it can be any
  expression, including a whole new nested `ui(...)` call.

  **`within` (all five ops above, optional, last argument):** a template
  function's name (see `addTemplateChild` below), scoping the `key` lookup
  to just that function's body. A key lookup is file-wide by default --
  fine for a genuinely unique key, but once an app has more than one
  `.map()` template, it's completely normal for two of them to each want
  a readable per-slot key like `"label"`; an unscoped lookup then always
  resolves to whichever one comes *last* in the file, silently. Pass
  `within` to say which one you mean:
  `setProp(source, "label", "class", '"bold"', "renderCategory")`. `npm
  run map` flags this exact situation (see below).
- `addStatementAfter(source, afterConstName, newStatementSource)` -- insert
  a new top-level statement right after an existing `const <name> = ...`.
- `removeStatement(source, name)` -- remove a top-level `const <name> =
  ...` or `function <name>(...) {}` entirely. The delete-counterpart to
  `addStatementAfter`.
- `replaceFunction(source, fnName, newFunctionSource)` -- overwrite an
  entire top-level `function <fnName>(...) {...}` declaration (bare or
  `export`ed) with new source text, signature and body both. Coarser than
  every other op here on purpose: for a function whose internals change
  substantially -- more than a couple of statements' worth -- there's no
  clean way to express that as a handful of small edits, so this fills the
  gap with "just give me the whole new function" while everything else in
  the file stays untouched. `newFunctionSource` always starts with
  `function`, never `export function`, even when replacing an exported
  one -- the `export` keyword itself sits outside the matched range and is
  left alone. Doesn't match a `const fn = () => {...}` arrow; there's no
  single AST node type that could target unambiguously the same way.
- `addTemplateChild(source, fnName, newChildSource)` -- append a new child
  to a `.map()` render template's own returned `ui(...)` call, found by
  the template *function's* name rather than a `key` -- e.g. "add a
  delete button to every row" -- since the template's own wrapper key is
  necessarily dynamic (`key: "item-" + it.id`, needed by the runtime to
  track per-item identity) and therefore never reachable by `key`, the way
  every other op above addresses its target. Requires the template to be
  written as a named top-level `function fnName(item) { return ui(...); }`
  and passed to `.map()` by reference (`items.value.map(fnName)`, not an
  inline arrow) -- see CLAUDE.md's "Named render templates" convention.
  Same array-literal-vs-by-reference handling as `addChild`. Only
  recognizes a function whose last top-level `return` is a bare `ui(...)`
  call; anything built up across several statements first throws a
  specific error rather than guessing -- use `replaceFunction` or edit it
  directly for those.
- `setTemplateProp(source, fnName, propName, newValueSource)` -- same
  addressing as `addTemplateChild`, but sets a prop on the template's own
  wrapper instead of adding a child -- e.g. "give every card a `class`".
  Refuses to touch `propName === "key"`: that expression is load-bearing
  for the runtime's identity tracking, not a cosmetic prop, so this
  refuses rather than risk silently breaking reconciliation.
  `newValueSource` is raw source text, same caveat as `setProp` above.
- `setTemplatePropValue(source, fnName, propName, dataValue)` -- the
  `setPropValue` counterpart for template wrapper props: same addressing
  as `setTemplateProp`, but takes a plain data value instead of source
  text, with the same serialization and refusal rules as `setPropValue`.
- A template nesting another named template inside its own body (a
  category template that renders `cat.items.map(renderItem)`) needs no
  special handling here -- `addTemplateChild`/`setTemplateProp` (and their
  `...Value` counterparts) address the outer and inner template
  independently by their own function names regardless of nesting, since
  the addressing scheme is flat, not tree-shaped. `scripts/fried-map.mjs`'s
  `T:` line reports nesting when it's present, purely for visibility.
- `setCssRule(source, varName, ruleName, declText)` -- set or add one
  rule's declaration on a top-level `const <varName> = css({...})` call.
  `declText` is a plain CSS declaration **string** (`"padding: 8px
  16px;"`), not source text -- a CSS declaration is always a string at
  the call site already, so there's no raw-source ambiguity to have here;
  passing a non-string throws immediately.
- `removeCssRule(source, varName, ruleName)` -- remove one named rule from
  a top-level `const <varName> = css({...})` call. Delete-counterpart to
  `setCssRule`.
- `renameSymbol(source, oldName, newName)` -- rename every real reference
  to a declared variable/action/function (its declaration and every place
  that reads it) throughout the file. Leaves identically-spelled property
  access (`obj.oldName`) and object-literal keys (`{ oldName: 1 }`) alone --
  those aren't the variable. A shorthand property or destructured binding
  (`{ oldName }`) is expanded to `{ oldName: newName }` so the property
  name it reads/writes doesn't change, only the local variable does.
  Refuses to rename any of fried.js's own API names (`state`, `action`,
  `ui`, ...), and refuses a shorthand destructured property that also has
  a default value (`{ oldName = 0 }`) rather than guessing which of two
  different edits was meant -- rewrite that one to the explicit form by
  hand first.
- `patch(source, ops)` -- applies a list of `{ op, args }` steps in
  sequence (e.g. `patch(source, [{ op: "setProp", args: [...] }, { op:
  "removeChild", args: [...] }])`), useful when several edits are being
  made in one pass. Each step is one of the functions above, called by
  name; fails on the first step that throws (the error names the step
  number and op), and always validates the final result before returning
  it.
- `validate(source)` -- re-parses the result; never trust a patch without
  calling this first (`patch(...)` already does this for you). Returns
  `{ ok: true }` on success, or `{ ok: false, error, line, column, pos }`
  on a parse failure -- `error` is the compact one-line message (acorn
  already bakes the position into it, e.g. `"Unexpected token (4:2)"`),
  `line`/`column`/`pos` are that same position as plain numbers, for
  anything that wants to act on where the problem is without parsing it
  back out of an English sentence.

### Diagnostics -- every lookup failure suggests what you probably meant

Every "not found" error above (a missing key, a missing child, a missing
top-level name, a rename target with no references) is enriched with a
`-- nearest: "..."` suggestion, computed by edit distance against the
*actual* names that exist at that lookup's scope -- not the whole file
indiscriminately: `removeChild`/`replaceChild`'s suggestion only considers
that one `ui(...)` call's own children, `addStatementAfter`/
`removeStatement`'s only considers other top-level names, `renameSymbol`'s
considers every identifier actually declared or referenced in the file
(locals and parameters included, not just top-level ones). The suggestion
is left off entirely when nothing is close enough to be a plausible typo,
rather than always naming *something* and creating false confidence --
e.g. `setProp(src, "zzz", ...)` against a file with a `"saveBtn"` key
throws plain `no ui(...) call found with key "zzz"`, no guess attached.

```
no ui(...) call found with key "saevBtn" -- nearest: "saveBtn"
no child matching "Placeholde" found under key "row" -- nearest: "Placeholder"
no top-level const "cartItem" found -- nearest: "cartItems"
no reference to "usrname" found to rename -- nearest: "username"
unknown patch op "setPorp" (step 0) -- nearest: "setProp"
```

All of these operate on the real AST (via `acorn`) and rewrite only the
touched byte range (via `magic-string`), so everything else in the file --
comments, formatting, unrelated code -- is left exactly as it was.

Run `npm run check-keys -- path/to/app.js` to see which `ui(...)` call
sites in a file currently have a static, patcher-addressable `key`, and
which named top-level functions currently qualify as `addTemplateChild`/
`setTemplateProp`-addressable templates.

## fried.map (scripts/fried-map.mjs) -- what to target before you patch

`npm run map -- path/to/app.js` prints a compact, machine-readable index
of everything in the file that a patch could address, instead of making
an AI read the whole file to find out. One line per category:

```
S: cartItems showPromo
A: removeItem insertItem(addItem)
K: root promo cartList checkoutBtn
C: TAX_RATE styles
F: formatPrice renderApp renderCartItem
T: renderCartItem
CSS: styles(button card)
(+ 1 dynamic-keyed list item, not individually patchable -- see check-keys)
```

`S` is top-level `state(...)` declarations, `A` is `action(...)`
declarations (variable name, with `(label)` appended only when the
action's string label differs from its variable name -- worth noticing,
since CLAUDE.md's own convention is to keep them the same), `K` is every
static, patcher-addressable `ui(...)` key in the file in source order, `C`
is any other top-level `const` (including `css({...})` variables -- they're
still plain consts), and `F` is top-level function declarations. `T` is
the subset of `F` that's a named function passed by reference to `.map()`
-- addressable by `addTemplateChild`/`setTemplateProp`/`setTemplatePropValue`
even though its own wrapper's key is dynamic (see the Patch API section
above); an inline arrow passed to `.map()` isn't listed here, since it has
no name to address it by. When one listed template's own body contains
another listed template's `.map()` call, that's shown inline as
`outer(> inner)` (e.g. `T: renderItem renderCategory(> renderItem)`) --
purely informational, both are still addressed independently by name
either way (see the Patch API section above). `CSS:` lists each top-level
`css({...})` call by variable name with the rule names it currently
defines, addressable by `setCssRule`/`removeCssRule`. A trailing `(+ N
dynamic-keyed ...)` line notes list-item keys that exist but aren't
individually addressable (see `check-keys.mjs` for exactly where). A `!
duplicate keys` line appears if the same static key is used twice -- a
real hazard, not a style nit: `patcher.js`'s key lookup is a Map, so a
duplicate key means only the *last* matching `ui(...)` call is actually
reachable by the patcher, and this is the tool that would catch that
before it causes a confusing patch-landed-on-the-wrong-element bug. A
further `! same key used by different templates` line calls out the
specific, fixable subset of that: a duplicate whose occurrences span more
than one `.map()` template -- pass `within: "<fn>"` to the op to resolve
it (see the Patch API section above); a duplicate confined to one scope
isn't listed here, since `within` can't fix that one, a rename is the
only real fix.

`buildFriedMap(source)` and `formatFriedMap(map)` are also exported from
`scripts/fried-map.mjs` for programmatic use (what `tests/fried-map.test.js`
exercises directly) -- the CLI above is a thin wrapper over them.

Run `npm test` to run `tests/patcher.test.js`, `tests/realistic.test.js`,
`tests/fried-map.test.js`, and `tests/diagnostics.test.js` -- real
assertions against real output (re-parsed where relevant, not just
diffed). Keep these passing when touching `patcher.js` or
`fried-map.mjs`; add a case to them before trusting a new edge case.
