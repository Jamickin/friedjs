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
  `props.ref`, if given, is a function called with the real element once
  it's created; if a later render passes a different `ref` function, the
  old one is called with `null` and the new one with the element, and
  removing the prop calls the old one with `null`.
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
  with the same rules twice never grows the stylesheet. Two more kinds of
  key (0.6.0), neither of which adds a name to the returned map:
  `"btn:hover"`, `"row::after"`, `"item:not(:last-child)"` are a state or
  pseudo-element of the class named before the first colon (which must be
  a plain key of the same call, and then gets a class of its own instead
  of a shared, deduped one, so the state cannot leak onto another name
  with the same declarations); `"@keyframes blink"` or `"@media (...)"` is
  an at-rule, inserted once, verbatim, its value being the rule's body.
- `cssVar(name, value?)` -> gets (no `value`) or sets a CSS custom property
  on `documentElement` directly. Setting one costs **zero re-renders** --
  it's a plain style write, not framework state.

That's the whole API you need to write an app. Everything else in an app --
arithmetic, `.filter()`, `.map()`, `.sort()`, ternaries, template literals --
is just JavaScript the model already knows fluently, not something this
framework has to define.

## More fried.js exports -- conveniences, not required

`fried.js` also exports these. An app never needs them; they exist for
convenience and tooling.

- `store(initial)` -> an object with one reactive property per key of
  `initial` (`s.count` reads, `s.count = 2` writes and re-renders), built
  from one `state(...)` per key. Keys added later are not reactive.
- `derived(deps, fn)` -> a read-only `{ value }` that calls `fn()` lazily
  and caches the result until one of the `deps` (an array of `state`s)
  has a different `.value` than at the last read.
- `render()` -> runs one render of the mounted tree synchronously, right
  now, instead of waiting for the batched re-render that `state`/`action`
  schedule. Does nothing before `mount()`. Mostly for tests and
  benchmarks.
- `VERSION` -> the fried.js version string (e.g. `"0.2.0"`), kept equal to
  `package.json`'s `version` and the top `CHANGELOG.md` entry.

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

## fried-router.js — optional hash router

```js
import { currentRoute, navigate, router, matchRoute, parseRoute } from "./addons/fried-router.js";
```

Browser only: it reads `window.location` and listens for `hashchange` as
soon as it's imported. Uses `#/path` hash routes, so it works on any
static file server. (In Node, e.g. a test, define a small
`globalThis.window = { location: { hash: "" }, addEventListener() {} }`
before importing it; `tests/router-params.test.js` does.)

- `currentRoute` -> a `state` holding the current path (the hash without
  `#`, `"/"` when empty), query string included. Updated on back/forward.
- `navigate(path)` -> an `action` that sets the hash and `currentRoute`.
  `path` may carry a query string: `navigate("/done?agent=codex")`.
- `router(routes)` -> finds the view for `currentRoute.value` with
  `matchRoute`, calls it with one argument `{ params, query, path }` and
  returns its result, or `null` when nothing matches and there is no
  `"*"`. Call it inside your render function. A view that takes no
  argument works the same as before 0.3.0.
- `matchRoute(routes, path)` -> `{ view, params, query, path, pattern }`
  or `null`. Pure: no DOM, no state; use it in tests, or to pick a title
  or a tab for the current route. Resolution order:
  1. a key equal to the whole `path` (query included), exactly as before 0.3.0;
  2. a key equal to the path without its query;
  3. keys with `:name` segments, compared segment by segment (the pattern
     text is never turned into a regex). A `:name` segment matches one
     non-empty segment, URL-decoded (`%2F` becomes `/`; a bad escape is
     kept as written). The pattern with the most literal segments wins;
     ties go to the route declared first. A trailing slash on the path or
     the key is ignored;
  4. `"*"`.
- `parseRoute(path)` -> `{ path, query }`. `query` is a plain object of
  the part after `?`: keys and values URL-decoded (`+` is a space), the
  first value of a repeated key wins, a bare `flag` is `""`.

```js
const routes = {
  "/": () => ui("h1", { key: "home" }, ["Home"]),
  "/plans/new": () => ui("h1", { key: "newPlan" }, ["New plan"]), // beats /plans/:id
  "/plans/:id": ({ params, query }) => ui("h1", { key: "plan" }, ["Plan " + params.id + " tab " + (query.tab || "log")]),
  "*": ({ path }) => ui("p", { key: "notFound" }, ["No page at " + path]),
};
mount(() => router(routes), document.getElementById("app"));

matchRoute(routes, "/plans/p%201?tab=diff");
// -> { view, params: { id: "p 1" }, query: { tab: "diff" }, path: "/plans/p%201", pattern: "/plans/:id" }
parseRoute("/done?agent=codex&day=today");
// -> { path: "/done", query: { agent: "codex", day: "today" } }
```

## fried-grid.js — optional character grid for real-time drawing

```js
import { createGrid, createLight, shade, createDots, createGridRenderer } from "./fried-grid.js";
```

The virtual DOM is the wrong tool for a full-screen grid of cells that all
change sixty times a second: thousands of vnodes built and diffed per frame
just to recolour text. This addon is the other half. You paint glyphs and
colours into typed arrays, and a canvas renderer redraws only the cells
whose (glyph, ink, paper) changed since the last frame: a keyed diff with
one key per cell. The canvas itself is an ordinary `ui("canvas", { ref })`
node; the VDOM owns the element, this owns its pixels. Everything except
the renderer is plain data and runs in Node. Colours are `0xRRGGBB`
integers.

- `createGrid(cols, rows)` -> a cell buffer: typed arrays `ch` (code
  points), `fg`, `bg`, and the methods `set(x, y, ch, fg, bg?)` (leaving
  `bg` out keeps the cell's paper), `put(x, y, text, fg, bg?)` (a string
  along a row; its spaces are skipped), `fill`, `clear`, `copyFrom`,
  `inside`, `index`. Writes off the grid are ignored.
- `countDirty(a, b)` -> how many cells differ between two grids.
- `createLight(cols, rows, aspect = 2)` -> one RGB float triple per cell
  (`r`, `g`, `b`), with `clear`, `add`, `point(x, y, radius, [r, g, b],
  power)` (a smooth falloff to nothing at `radius` rows, round on screen
  because `aspect` is cell height over width), `quad(points, color,
  power)` (a convex patch) and `blur(passes)`.
- `shade(src, light, out, { bits, emissive, paper })` -> lights a painted
  grid into `out`: ink and paper times the light of their cell, an
  optional per-cell `emissive` colour added to the ink, then quantized to
  `bits` per channel so a flicker smaller than one step leaves the cell's
  key unchanged.
- `createDots(cols, rows)` -> a sub-cell layer, 2 x 4 dots per cell, each
  dot a weight 0..1: `set`, `get`, `line`, `clear`, and `blit(grid,
  colorOf)`, which writes one Braille glyph per cell inked by the mean
  weight of its dots (`grid` is anything with `set(x, y, glyph, color)`,
  or that function itself). The layer remembers the bounds of what was
  set, so `clear` and `blit` cost only the marks, not the whole grid;
  after writing `v` directly, call `touch(x0, y0, x1, y1)`.
- `createGridRenderer({ canvas, overlay?, font?, weight?, alpha? })` -> draws
  grids on a canvas. `resize(cols, rows, cssWidth, cssHeight, dpr)` fits
  whole device pixels per cell; `draw(grid)` redraws changed cells and
  returns how many; `sprites(list)` draws loose glyphs at fractional cell
  positions on the `overlay` canvas (`{ x, y, ch, color, alpha?, scale?,
  add?, glow? }`), so smooth motion never dirties the cell layer;
  `cellAt(clientX, clientY)`, `invalidate()` (pass `{ atlas: true }` to
  draw every glyph afresh too, once a web font has loaded), `stats`. Each glyph in each
  colour is drawn once into an atlas and blitted from then on; Braille and
  block characters are drawn as rectangles, so they tile whatever the font.
- `rgb(r, g, b)`, `hex("#rrggbb")`, `cssColor(c)` -> colour conversion.
- `litColor(c, r, g, b)`, `scaleColor(c, k)`, `addColor(a, b)`,
  `mixColor(a, b, t)`, `luma(c)`, `quantize(c, bits)` -> colour arithmetic,
  clamped.
- `ramp(chars, t)` -> a glyph from a density ramp (`" .:-=+*#%@"`) by `t`
  in 0..1.

- `TRANSPARENT` -- a background value for a cell that should show what is
  under the canvas (create the renderer with `alpha: true`): one grid of
  words laid over another grid.

## fried-loop.js — optional frame loop with a fixed simulation step

```js
import { createLoop } from "./fried-loop.js";
```

- `createLoop({ update, render, step = 1/60, maxSteps = 5 })` -> `{ start,
  stop, tick, time, frame, stats, running }`. `update(dt, time)` is the
  simulation: it is always called with the same `dt`, zero or more times
  per animation frame, so it behaves the same at 30, 60 or 144 Hz.
  `render(alpha, frameDt)` runs once per animation frame. The loop pauses
  while the page is hidden and, after a stall, drops time rather than
  running more than `maxSteps` steps. `tick(ms)` runs one frame by hand
  (tests, stepping while paused). `stats` has smoothed `fps`, `updateMs`,
  `renderMs`. A frame that throws does not stop the loop: the next frame
  is asked for all the same.

Everything `update` and `render` do happens inside one animation-frame
callback, and FriedJS flushes its render in the microtask right after it,
so any number of `state()` writes in a frame make at most one virtual-DOM
render, before the browser paints. Drive the loop with plain functions,
not `action()` (an action schedules a render on every call), and set a
`state()` cell only when its value differs.

## fried-pointer.js — optional pointer and drag helpers

```js
import { createPointer } from "./fried-pointer.js";
```

- `createPointer(options)` -> `{ props, at, inside, presses, cancel }`.
  Spread `props` onto the element: `ui("canvas", { key: "view",
  ...ptr.props })`. Per mouse button, a press becomes a tap (`onTap`), a
  hold (`onHold`, after `holdMs`, 450 by default, without moving) or a
  drag (`onDragStart`, `onDrag`, `onDragEnd`, past `dragPx`, a number of
  pixels or a function of the button: return `Infinity` for a button that
  never drags, and no wobble of the mouse costs it its tap or hold); `onDown`,
  `onMove`, `onUp`, `onWheel` and `onLeave` are also called. `toLocal(
  clientX, clientY, element)` converts positions once for every callback
  (to grid cells, say). Each callback gets the position and the press
  (`{ button, start, at, moved, held, dragging, data }`; `data` is yours).
  The pointer is captured for the length of a press. A press that starts
  on a `button`, `a`, `input`, `textarea`, `select` or `[data-pointer-free]`
  inside the element is left to that control. The callbacks are plain
  functions, so a pointermove never schedules a render. Two buttons at
  once are two presses: a mouse reports only its first button down and its
  last button up as down and up events (the ones between arrive as moves
  that name the button), and those are turned back into a down and an up
  here, so no press is left open. Losing the pointer capture ends every
  press, as `cancel()` does.

## fried-raster.js — optional shapes in character cells

```js
import { strokeLine, strokePath, strokeEllipse, strokePoly, fillEllipse, fillPoly, fillRect, fillCapsule, edgeGlyph } from "./fried-raster.js";
```

A figure drawn as a fixed block of characters is a fixed number of cells
big, so the grid can never be made finer or coarser. These turn a SHAPE
(in fractional cells) into cells at whatever size it comes out. Each takes
a `put` callback, so they write into anything: a `fried-grid` buffer, a
height field, a mask. `aspect` is cell height / cell width (2 by default).

- `strokeLine(put, x0, y0, x1, y1, { aspect?, glyph?, glyphs? })` -- a
  line; `put(x, y, glyph)` gets the glyph for the line's direction
  (`-`, `|`, `/` or `\`), or `glyph` if you fix one.
- `strokePath(put, points, opts, closed?)` -- joined lines.
- `strokeEllipse(put, cx, cy, rx, ry, { aspect?, glyphs? })` -- an
  outline, one glyph per side per row: a 9 x 3 ellipse comes out as
  `.-----.` over `(       )` over a matching bottom row.
- `strokePoly(put, points, { aspect?, glyphs?, smallBelow? })` -- the same
  kind of outline for any closed shape (a lumpy stone, a crumpled rag,
  an ellipse you have turned): one glyph per side per row, soft corners
  when the shape is small, and every outline cell is a cell `fillPoly`
  covers, so a fill and its outline line up.
- `fillEllipse(put, cx, cy, rx, ry)` -- `put(x, y, u, v)`, with (u, v) the
  cell's place in the ellipse, -1..1 (for a height that rises to the middle).
- `fillPoly(put, points)` and `fillRect(put, x0, y0, x1, y1)` -- `put(x, y)`.
- `fillCapsule(put, x0, y0, x1, y1, half, aspect?)` -- a fat line with
  round ends; `put(x, y, t, d)`: t along it (0..1), d across it (0..1).
- `edgeGlyph(dx, dy, aspect?, glyphs?)` -- the glyph for a direction.
- `EDGE` and `ROUND` -- the default glyph sets, to copy and change.

A shape with a coordinate that is not finite, or with no size, draws
nothing.

## fried-light.js — optional lighting for a character grid

```js
import { createLighting, toneGlyph } from "./fried-light.js";
```

`fried-grid`'s `createLight` is a flat field: it knows where light falls,
not what it falls on. This is a lighting system: every cell has a HEIGHT,
so surfaces have normals (a lit side and a dark side) and things throw
shadows; and brightness can be carried by which GLYPH a cell gets, with no
cell background colour at all.

- `createLighting(cols, rows, { aspect? })` -> `{ height, nx, ny, nz, r, g,
  b, lum, shade, maxHeight, clearHeights, normals, ambient, addField, point,
  spill, finish }`. Each frame: write `height` (in rows), call `normals()`, then
  `ambient(r, g, b)`, any `addField(lightField, k)` (a `createLight`
  field worked out some other way: moonlight), one `point({ x, y, h,
  radius, color, power, shadows })` per lamp (x, y in cells; h and radius
  in rows), `spill(emissive, k, radius)` for whatever shines by itself,
  and `finish()`, which fills `lum`. `shade` (0.22) is how much
  of a lamp still reaches a shadowed cell. Shadows are a sweep: outward
  from the lamp along a ray to every cell on the edge of its reach,
  keeping the horizon, so every cell on a ray is visited and a thing one
  cell wide throws a whole shadow. `shadows: false` casts none;
  `shadows: "walk"` is the older way (from each cell a walk toward the
  lamp of at most 24 steps: about three times dearer, and it can step
  over a thing narrower than its stride). For `spill(emissive, k = 1,
  radius = 2)`, `emissive` is a colour per cell (0 for none); each
  shining cell gives `k` of its colour to the cells within `radius` rows,
  most to the nearest. It costs only the cells that shine (a blur of a
  whole field costs every cell, every pass).
- `toneGlyph(chars, t, jitter?, bands?)` -- the glyph for a brightness
  from a ramp of characters (nothing to dense); `jitter` (-0.5..0.5, a
  stable hash of the cell) roughens the band edges, `bands` snaps to hard
  steps first.

## fried-grid-ui.js — optional user interface drawn in character cells

```js
import { createGridUi, wrapText } from "./fried-grid-ui.js";
```

When the whole screen is characters, the words, panels, menus and buttons
belong in the grid too, and the virtual DOM cannot draw into a cell buffer.
This is an immediate-mode UI: every frame you say what is on screen; each
call both draws into a `fried-grid` buffer and answers what happened to it.
Widgets are known by the id you pass.

- `createGridUi(theme?)` -> `{ begin, end, tap, wheel, key, over, mute,
  region, text, wrap, fill, box, button, row, slider, scroll, scrollTo,
  input, theme, focus, hot }`. Per frame: `begin(grid, { x, y, down })`
  (the pointer, in this grid's cells), the widgets, `end()`. From your
  handlers: `tap(x, y, button)`, `wheel(x, y, dy)`, `key(event)` (true when a text
  field took it), and `over(x, y)` to ask whether the UI is under a press
  before the game behind it uses it. `button(id, x, y, label)` returns
  true when clicked; `row(id, x, y, w, label, value)` returns -1 / +1 for
  a click on the left / right of its value; `slider` returns the new
  value; `scroll(id, x, y, w, h, total, { end, stick })` returns the first
  line to show; `input(id, x, y, w, value, { h, placeholder, max })`
  returns the edited text. `mute(true)` makes the widgets that follow
  feel nothing (drawn, but no hover, click or wheel): mute what a modal
  covers, un-mute, then draw the modal, and the click reaches the modal.
  `region(id, x, y, w, h)` is what the widgets are made of: it answers
  `{ hot, clicked, wheel, tap }`, `tap` being the tap that clicked it
  (`{ x, y, button }`) or null. A text field that was being typed in and
  is no longer drawn lets go of the keyboard at `end()`.
  `theme` holds the colours; `ground` may be `fried-grid`'s `TRANSPARENT`.
- `wrapText(text, width)` -> lines no wider than `width` cells.
- `BOX` and `BOX_PLAIN` -- border glyph sets for `box`.

## Server addons (addons/server/) -- Node only

Four optional modules for a small local Node server, the half of an app
that isn't in the browser: state on disk, an HTTP server, a tool registry
an AI can call, and child processes. Node built-ins only, no npm
dependencies, ES modules. They were extracted from Orchestra's composer
with its behaviour unchanged (see `docs/MERGE.md`). `npm run build`
doesn't type-check them (`jsconfig.json` has no Node types; they're in its
`exclude`), and none of them imports `fried.js`. A consumer copies them
with `tooling/fried-sync.mjs`: a `targets` entry with `"flat": true` in
the consumer's fried.json puts `addons/server/fried-score.js` at
`<dest>/fried-score.js`.

## fried-score.js — one JSON file of state plus an event log

```js
import { createScore, id, token } from "./addons/server/fried-score.js";
```

- `createScore(dirOrOptions)` -> `{ state, save, flush, emit, taskLog,
  readTaskLog, since, subscribe }`. Pass a state folder, or `{ dir,
  scoreFile = "score.json", eventsFile = "events.jsonl", logsDir = "logs",
  ringSize = 3000, debounceMs = 150, skipLogTypes = ["log"], initialState }`.
  Reads score.json back on start (or calls `initialState()`) and reloads
  the newest `ringSize` events, skipping a corrupt line.
  - `state`: the live object; mutate it, then call `save()`.
  - `save()` writes it after `debounceMs` (one write for many changes);
    `flush()` writes it now. Both write a `.tmp` file and rename it, so a
    crash never leaves half a file.
  - `emit(type, text, extra?)` -> the event `{ seq, at, type, text,
    ...extra }`: appended to the events file (unless its type is in
    `skipLogTypes`), kept in the ring, passed to every subscriber.
  - `since(seq)` -> the ring's events after `seq`; `subscribe(fn)` -> an
    unsubscribe function.
  - `taskLog(id, line)` / `readTaskLog(id, tail = 200)`: one text log per id
    under `logsDir`.
- `id(prefix)` -> `"<prefix>-<base-36 time><4 hex>"`.
- `token(bytes = 24)` -> a random hex string (48 characters by default).

## fried-serve.js — a localhost HTTP server with routes, auth and SSE

```js
import { createAppServer, serveStaticDir, createSseHandler, readJsonBody } from "./addons/server/fried-serve.js";
```

- `createAppServer({ host = "127.0.0.1", port = 7777, allowedHosts, routes,
  staticFiles, staticDirs, auth, unauthError, maxBodyBytes, notFound })` -> `{ server,
  listen, close, send, readJsonBody }`. A request whose `Host` header isn't
  allowed gets 403 (a DNS-rebinding guard). The token comes from
  `Authorization: Bearer ...` or `?token=`; `auth(token, req, url)` returns
  the caller (`who`) or nothing. `routes` keys are `"GET /api/state"` or a
  bare `"/api/health"`; a value is a handler or `{ handler, auth, role,
  unauthError }`. Paths starting with "/api/" need a caller unless `auth: false`
  (401), and `role` limits a route to those roles (403). A handler gets
  `{ req, res, url, path, query, who, body, send }` (`await body()` parses
  the JSON body) and may return a value to send as JSON with 200. A thrown
  error is a 400 with its message. `listen()` resolves `{ port, url }`
  (port 0 picks a free port).
  - `ctx.send` is bound to the request's response (0.5.0):
    `send(code, data, type?, headers?)`, which is the `ctx.send(code,
    data)` that `createToolHttpHandlers` calls, so its handlers plug
    straight into `routes`. The older `send(res, code, data, type?,
    headers?)` form still works: a first argument that is a response is
    used as the target.
  - `notFound` (0.5.0) is a route spec, a handler or `{ handler, auth,
    role, unauthError }`, used when no route matches, after static files
    and folders. It goes through the same auth and role checks as a
    route, so `{ auth: true, handler: () => ... }` answers 401 to an
    unknown path without a token and runs the handler with one. Without
    it an unknown path is a 404 `{ error: "not found" }`, as before.
- `serveStaticDir({ prefix, dir, types, cacheControl })` -> `(req, res,
  pathname) => boolean`: serves files under `dir` for GET/HEAD, only with
  an extension listed in `types`, and answers 404 for anything that
  escapes `dir` (`..`, encoded slashes, symlinks out). A raw URL that
  starts with `prefix` but whose dot segments normalise out of it (a
  request for `/ui/../api/health` under the prefix "/ui/") is an escape too and
  gets the 404 (0.5.0); before, it returned `false` and the normalised
  path reached the routes.
- `createSseHandler({ since, subscribe, pingMs = 20000 })` -> a route
  handler streaming server-sent events: first every event after `?since=`,
  then live ones. Plugs straight into a `createScore` store.
- `readJsonBody(req, maxBytes)` -> the parsed body (`{}` when empty);
  throws past `maxBytes`.

## fried-tools.js — one tool declaration for HTTP, MCP and docs

```js
import { createToolRegistry, createToolHttpHandlers, createMcpStdioServer, str, num, bool, arr, obj } from "./addons/server/fried-tools.js";
```

A tool is `{ description, input, run }` (`input` is a JSON schema, `run(args,
caller)` may be async). Declare tools grouped by role, as plain object
literals (`const master = { roll_call: { ... } }`), so `npm run map` lists
them and `addTool`/`setToolDescription`/`setToolInput` (Patch API below)
can edit them by name.

- `createToolRegistry(name, tools, { wrapForCaller, fallbackRole }?)` -> `{ name,
  forRole, listForRole, call, register, unregister, replace, roles,
  toMarkdown }`. `tools` is a role map (`{ master: {...}, musician: {...}
  }`), a flat map whose tools may list `roles`, or an array of `{ name,
  ... }`. A tool without a string `description` and a `run` function is
  refused when declared; a missing `input` becomes `obj({})`.
  - `forRole(role, callerOrTask)`: the role's tools with `run` bound to
    that caller; `listForRole` gives `{ name, description, inputSchema }`.
  - `call(role, tool, args, caller)`: runs one; an unknown tool throws an
    error with `status` 404 and `code` `"ENOTOOL"`.
  - `register`/`unregister`/`replace` change tools at runtime, without new
    HTTP handlers or a restart; `toMarkdown()` renders the reference.
  - `fallbackRole` (0.5.0): a role with no tools of its own gets this
    role's tools in `forRole`, `listForRole` and `call`, instead of only
    the shared ones (e.g. `fallbackRole: "musician"` gives every
    non-master caller the musician tools). The caller keeps its own role;
    `wrapForCaller` is given the fallback role. It must name a role that
    has tools, or `createToolRegistry` and `replace` throw a `TypeError`.
    Roles that have tools are unaffected, and without the option nothing
    changes.
- `createToolHttpHandlers(registry)` -> `{ handleList, handleCall }`,
  route handlers for `GET /api/tools` and `POST /api/call` (`{ tool, args
  }`): 200, 404 for an unknown tool, 400 when it throws, 401 without a
  caller.
- `createMcpStdioServer({ url, token, serverInfo, instructions, ... })`
  -> `{ handleMessage, close }`: an MCP server over stdio (newline JSON-RPC)
  that answers `tools/list` and `tools/call` by asking that HTTP server,
  so it holds no tool logic and always shows the current tools.
- `str(description)`, `num(description)`, `bool(description)`,
  `arr(description, items?)`, `obj(properties, required?)`: JSON-schema
  shorthands for `input`.

## fried-proc.js — child processes for AI CLIs and checks

```js
import { spawnLineProcess, killTree, lineReader, limitHit, resetTime, sanitizeOutput, tailOutput, RATE_LIMIT, RESUME_FAILED, sessionIdOk } from "./addons/server/fried-proc.js";
```

- `spawnLineProcess({ command, args, cwd, env, adapter, resumeId,
  onRawLine, onParsedLine, onSession, onSpoke, onLimit, onResumeFailed,
  onClose })` -> `{ child, kill, state }`: spawns a CLI and reads stdout and
  stderr line by line (`{`-lines parsed as JSON). A usage-limit line, or a
  failed resume when `resumeId` is set, calls its callback and kills the
  process tree. `onClose` gets `{ code, limit, resumeFailed, badResume,
  startError, spoke, sessionId, finalText }`. A callback that throws never
  breaks the run.
  - `onParsedLine(line, stream, { flushed })`: the adapter parser's
    non-blank lines as they stream, with `{ flushed: false }`, then on
    close whatever `parser.flush()` returns, unfiltered, with `{ flushed:
    true }` (the third argument is new in 0.5.0, so a caller can cap
    streamed lines without also capping the flushed ones; two-argument
    callbacks keep working).
- `killTree(child, { sync, signal }?)`: ends a child and everything it
  started (`taskkill /T /F` on Windows). `sync: true` blocks until it's
  done, for a timeout.
- `lineReader(stream, onLine)`: UTF-8 lines, keeping a partial line until
  its newline arrives.
- `limitHit(adapter, line, obj, stream)` -> `true` when an output line
  reports a usage limit (an adapter may supply its own test); `RATE_LIMIT`
  is the default pattern.
- `resetTime(line, now?, defaultMinutes = 30)` -> a `Date`: when that
  limit resets, read from the error text ("try again in 3h 20m", "resets
  at 14:30"), else `defaultMinutes` from now.
- `sanitizeOutput(text)` strips ANSI/OSC sequences, `\r` redraws and
  control characters; `tailOutput(text, { maxLines = 60, maxBytes = 4096
  }?)` -> the sanitized last lines.
- `RESUME_FAILED`: the pattern for "that conversation doesn't exist";
  `sessionIdOk(id)` -> `id` when it's a safe session id, else `null`.

## Patch API (tooling/patcher.js), for making a small change afterward

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
  the addressing scheme is flat, not tree-shaped. `tooling/fried-map.mjs`'s
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
- `addTool(source, group, toolName, toolDefSource)` -- add a tool to a
  tool group in a server file (see fried-tools.js above): `group` is the
  name the group object is known by (`const musician = {...}`, a
  `musician: {...}` property, or the name given to
  `createToolRegistry("name", {...})`). `toolDefSource` is raw source text
  for an object literal with `description`, `input` (or `inputSchema`) and
  `run` -- checked before anything is written. Refuses a name already in
  that group, and a group that doesn't exist (with a `-- nearest:`
  suggestion).
- `setToolDescription(source, toolName, newDescription, withinGroup?)` --
  replace a tool's description. `newDescription` is a plain **string**,
  quoted for you (like `setCssRule`'s `declText`).
- `setToolInput(source, toolName, newInputSource, withinGroup?)` --
  replace a tool's `input` (or `inputSchema`) with raw source text for one
  expression (`'obj({ id: str("Task id") }, ["id"])'`); refuses text that
  doesn't parse as exactly one expression.

  **`withinGroup` (both ops above):** a tool is found by name across every
  group in the file. When the name is in more than one group (Orchestra's
  `fried_friction` is in both `master` and `musician`) the op refuses and
  names the groups, instead of editing whichever comes last -- pass the
  group to say which one you mean. A tool name in one group needs none.
- `addRosterAgent(source, agent)` -- append an agent to a roster's
  `agents` array: a JSON roster (`{ "agents": [...] }`, kept valid JSON
  and indented like its items) or a JS module (`agents: [...]` or `const
  agents = [...]`). `agent` is a plain object or object-literal source
  text; it needs string `id`, `name` and `kind`. Refuses a duplicate `id`
  (listing the existing ones) and a `handoff` entry naming an agent that
  isn't in the roster (with a `-- nearest:` suggestion). In a JS roster,
  source text is inserted as written; a JSON roster only takes literal
  values.
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

## fried.map (tooling/fried-map.mjs) -- what to target before you patch

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
still plain consts), and `F` is top-level function declarations. Since
0.5.0 `F` also lists exported ones, marked `(exported)`: `export function
createTools` and an exported arrow or function expression (`export const
run = () => ...`) both appear as `F: createTools(exported) run(exported)`;
the exported const is still on `C` as well. `buildFriedMap` returns them
in `funcs` and, the exported subset, in `exportedFuncs`. Files without
exports print the same `F` line as before. `T` is
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

A server file (see the server addons above) gets up to three more lines:

```
REG: orchestra(master musician)
TOOLS: master(fried_friction roll_call status) musician(fried_friction my_task)
ROUTES: GET / GET /ui/* GET /api/health GET /api/state POST /api/call
```

`TOOLS:` lists every tool definition (an object literal with at least two
of `description`, `input`/`inputSchema` and `run`) by the group it's in,
in source order -- the names `addTool`/`setToolDescription`/`setToolInput`
take; a name shown in two groups needs `withinGroup`. Tools in an
unnamed object are listed last, without a group. `REG:` is each
`createToolRegistry("name", ...)` call with its groups, or, when a file
has two or more groups and no such call, one entry named after the
function holding them (`createTools(master musician)`). `ROUTES:` is
every route-table key (`routes: { "GET /api/state": ... }` or `const
routes = {...}`) and every inline `path === "/x"` test or
`path.startsWith("/ui/")` (shown as `/ui/*`) in source order, without
repeats; the method comes from a `req.method === "POST"` in the same `&&`
chain, and a test without one reads as `GET`. The three lines are
`registries`, `tools` and `routes` on `buildFriedMap`'s result; files
without any print nothing new.

`buildFriedMap(source)` and `formatFriedMap(map)` are also exported from
`tooling/fried-map.mjs` for programmatic use -- the CLI above is a thin
wrapper over them.

## Tests and checks

`npm test` runs `tests/test.js` and every `tests/*.test.js` file through
`node --test` (via `tests/run.mjs`), including the runtime and patcher
unit tests in `tests/test.js`, `tests/docs-truth.test.js` (every path,
npm script, patcher op and API name these docs mention really exists)
and `tests/version.test.js`. `node stress.js` is the runtime's
correctness-at-scale suite and `node benchmark.js` the timing benchmark;
compare their numbers against `evolution/baseline.md`. Keep all of them
passing when touching `fried.js`, `tooling/patcher.js` or
`tooling/fried-map.mjs`, and add a case before trusting a new edge case.
`tests/fried-map.test.js` covers the map's server lines,
`tests/patcher-server.test.js` the tool and roster ops, and
`tests/fried-score.test.js`, `tests/fried-serve.test.js`,
`tests/fried-tools.test.js` and `tests/fried-proc.test.js` the server
addons. The map's browser lines (`T:`, `CSS:`, the `!` lines) and most
`-- nearest:` messages still have no dedicated tests.
