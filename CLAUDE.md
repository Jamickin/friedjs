# Project instructions: fried.js

This project uses **fried.js**, a tiny plain-JavaScript UI framework, plus
`patcher.js` for making small, targeted edits to it via AST rewrites
instead of full-file regeneration. There is no custom syntax and no build
step: everything is ordinary JS running in the browser via native
`<script type="module">`. Read `docs/framework-api.md` before writing or
changing any UI code.

`fried.js` here is a **merge** of two independently-evolved
iterations of fried.js -- read `docs/MERGE.md` once, it explains exactly
what came from where and why, and it's short.

## What's in this repo

- `fried.js` -- the framework itself (`mount`, `state`, `action`, `ui`,
  `uid`, `css`, `cssVar`, `onRender`, `nextTick`). Real keyed DOM
  reconciliation via a virtual-node diff (not full-rebuild-on-every-
  render), so lists diff in-place; `ui(...)` returns a lightweight virtual
  node, DOM is only created for parts of the tree that are genuinely new.
  SVG-aware, with a couple of small auto-accessibility defaults (see
  `docs/framework-api.md`).
- `addons/fried-db.js` -- optional: synchronous, memory-first reactive
  collections backed by IndexedDB, for apps that need data to survive a
  reload.
- `addons/fried-virtual.js` -- optional: windowed rendering for a large list
  (renders only the rows in the scroll viewport, not the whole array).
  Reach for it once a single list is large enough (a few hundred rows+)
  that rebuilding it on every render is what's making the app feel slow --
  see `docs/known-limitations.md`'s "whole-tree re-render" entry for why
  that happens and what this fixes.
- `tooling/patcher.js` -- AST-based patch functions (`setProp`, `setPropValue`,
  `setChildText`, `addChild`, `removeChild`, `replaceChild`,
  `addStatementAfter`, `removeStatement`, `replaceFunction`,
  `renameSymbol`, `addTemplateChild`, `setTemplateProp`,
  `setTemplatePropValue`, `setCssRule`, `removeCssRule`, `patch`,
  `validate`) for making small, targeted edits to an existing app file
  without rewriting the whole thing. `addTemplateChild`/`setTemplateProp`/
  `setTemplatePropValue` address a `.map()` render template's own wrapper
  (see the "Named render templates" convention below) -- everything else
  addresses a `ui(...)` call by its static `key`, and now optionally
  accepts a trailing `within: "<templateFnName>"` to disambiguate when the
  same key string is used inside more than one template. `setPropValue`/
  `setTemplatePropValue` take a plain data value instead of raw source
  text -- prefer them over `setProp`/`setTemplateProp` unless the value
  genuinely needs to be an expression (see the raw-source note below).
  `setCssRule`/`removeCssRule` address a rule inside a top-level `const x =
  css({...})` call by rule name.
- `docs/framework-api.md` -- full API reference. Read this first.
- `docs/known-limitations.md` -- real limitations (and fixes) found by
  actually testing this, not assumed ones.
- `docs/MERGE.md` -- what this runtime and patcher are merged from, and
  how the merge was verified before anything shipped.
- `tooling/check-keys.mjs` -- reports which `ui(...)` call sites in a given
  file are currently addressable by the patcher (`npm run check-keys --
  path/to/app.js`).
- `tooling/fried-map.mjs` -- prints a compact index of a file's state,
  actions, addressable keys, and other top-level consts/functions
  (`npm run map -- path/to/app.js`), so you know what's there to target
  before reaching for the patcher instead of reading the whole file.
- `tests/` -- real assertions against real patched/parsed output for
  `patcher.js` and `fried-map.mjs`, plus `merge-regressions.test.js` (the
  merge's own structural + behavioral tests) and `browser-verify.mjs` (a
  real-Chromium Playwright check of the runtime -- run with `node
  tests/browser-verify.mjs`, needs `playwright` installed separately,
  it's not a `dependencies` entry since nothing else in this repo needs a
  browser automation library). Run `npm test` for everything else; keep
  it passing.

This template intentionally has **no app in it**. Build one inside it (an
`app.js` + `index.html`, or however you want to structure it) rather than
starting from scratch elsewhere -- the framework, patcher, and conventions
below are already wired up.

## Conventions to follow

**Give a static `key` prop to any `ui(...)` call you might want to patch
later.** The patcher addresses elements by `key`, not by position or CSS
selector. Use a fixed string key (`"resetBtn"`, `"statsPanel"`), never one
built from per-item data (an id, an index) for anything except actual list
items -- keys used for patch-addressing must be static literals.

**Prefer writing a UI node's children as an inline array literal.** Both
an inline array and a by-reference expression (`.map()` result, a
variable) work correctly at runtime and `addChild` can extend either one
now -- but an inline array keeps the patch diff smaller and the source
easier to read at the call site, so default to it unless the list is
genuinely built elsewhere for a good reason. Also prefer an array over a
bare string for a single static text child (`ui(tag, props, ["text"])`,
not `ui(tag, props, "text")`) for the same diff-size reason, even though
`setChildText` can address either shape now (see
`docs/known-limitations.md`).

**Name every `action(...)` descriptively and uniquely.** Action names show
up in patch instructions and error messages; reused or vague names (`a`,
`update`) make patches ambiguous to target.

**Write a `.map()` render template as a named top-level function, and pass
it by reference: `items.value.map(renderItem)`, not
`items.value.map((it) => ...)`.** A list item's own wrapper key has to be
dynamic (`key: "item-" + it.id`) for the runtime to track identity across
renders, which means it's never addressable by `key` the way a static
element is -- but there's still exactly one copy of the template in
*source*, however many instances it renders at *runtime*, and a named
function gives the patcher a static, unique handle for it. `addTemplateChild(source, fnName, newChild)` adds a child to every rendered
instance at once (e.g. "add a delete button to every row"); `setTemplateProp(source, fnName, propName, value)` sets a prop on every
instance's wrapper (e.g. "add a class to every card"). Anything already
inside the template with its own static per-slot key (`key: "label"`,
`key: "value"`) was already addressable by `setProp`/`setChildText`/
`addChild`/etc. even before this -- those ops walk the whole file,
template bodies included. Run `npm run check-keys -- path/to/app.js` to
see which named functions in a file currently qualify as templates.

**Give per-slot keys inside a template a name unlikely to collide with
another template's per-slot keys, or pass `within: "<templateFnName>"`
when you can't.** `label`/`value`/`tag` are natural, readable per-slot
names, and it's completely normal for two different templates to both
want one -- but a key lookup is file-wide by default, so `setProp(source,
"label", ...)` with no `within` always lands on whichever template's
`"label"` comes *last* in the file, silently, even if you meant the other
one. `npm run map -- path/to/app.js` flags this specifically (a `!  same
key used by different templates` line, distinct from an ordinary same-scope
duplicate) -- pass the template function's name as the last argument to
resolve it: `setProp(source, "label", "class", '"bold"', "renderCategory")`.

**Check `npm run map -- path/to/app.js` before patching.** It's a lot
cheaper than reading the whole file to find out what's there to target,
and it'll flag a duplicate key if one exists -- worth knowing before a
patch silently lands on the wrong `ui(...)` call.

**Prefer a patch over a full rewrite for small changes.** If you're making
a targeted change to an existing app file (rename a label, add one new
button, tweak a prop, add a hyphenated attribute, edit a CSS rule), use
the functions in `tooling/patcher.js` instead of regenerating the whole file.
`setProp`/`setTemplateProp`'s value argument is raw JS *source text*, not
a data value -- pass `JSON.stringify(value)` for a string prop, or you'll
get output that parses as valid-but-wrong JS and silently passes
`validate()` (see `docs/known-limitations.md`). For a plain data value,
prefer `setPropValue`/`setTemplatePropValue` instead -- they take the
value directly and serialize it correctly themselves, so this whole
landmine doesn't apply; reach for `setProp`/`setTemplateProp` only when
the value genuinely needs to be an expression (an arrow function, a
`cssVar(...)` call). Always call `validate()` on the result before
writing it, and actually run the app (serve it, open it in a browser,
check it renders and behaves correctly) rather than assuming a
structurally valid patch is a correct one. For edits the patcher
genuinely can't express (new module-scope state that doesn't belong right
after an existing `const`, multi-statement refactors), edit directly and
say so rather than force-fitting the patch API.

**Don't invent new framework functions.** `state`, `action`, `ui`, `uid`,
`mount`, `css`, `cssVar`, `onRender`, `nextTick`, and (if persisting data)
`createDatabase` are the entire API. Everything else -- lists,
conditionals, event handling, timers -- is just plain JavaScript, exactly
as you'd already write it.

## Setup

```
npm install        # only needed for tooling/patcher.js -- fried.js itself has
                    # zero runtime dependencies
npm run serve       # serves this folder at http://127.0.0.1:8080
```

Serve over HTTP rather than opening an HTML file directly -- ES module
imports are blocked under `file://` by browser CORS rules.
