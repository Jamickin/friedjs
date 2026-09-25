# Known limitations

This file records real limitations found by actually testing fried.js and
patcher.js, not assumed ones. Keep it updated as new ones are found -- the
point of an empirical project is to write down what actually happened
rather than what should happen in theory.

`src/fried.js` in this project is a merge of two independently-evolved
iterations -- see `docs/MERGE.md` for exactly what came from where. Every
entry below still applies to the merged runtime/patcher unless its own
text says otherwise.

## Late-added event handler never actually attached -- fixed by the merge

Found while comparing this project's runtime against the other,
independently-evolved iteration (the one `docs/MERGE.md` merges in the
vnode architecture from): if an element is created with no handler for a
given event, and a *later* render adds one to that same reused element
(same key, same tag), the click (or whatever event) silently did nothing,
forever. Root cause: `ui()` only called `addEventListener` once, at
element creation, for whichever `on*` props existed *at that moment* --
`hydrateAttrs` updated the internal `_friedHandlers` map on a later
render but never called `addEventListener` for a handler type that
wasn't part of the map yet. Confirmed with a real Playwright test (mount
a button with no `onclick`, click it -- nothing happens, correctly --
then trigger a re-render that adds an `onclick`, click again -- still
nothing, incorrectly) against the pre-merge runtime; not present in the
other iteration, which guards this case (`if (!o._friedHandlers?.[evt])
o.addEventListener(...)` inside `hydrateAttrs`'s own `on*` branch, re-
checked every render). This merge inherits that guard as part of taking
the other iteration's runtime as the base, so the bug doesn't reproduce
here -- re-verified with the same test in `tests/browser-verify.mjs`.

## `addChild` on by-reference children -- fixed

Originally, `addChild(source, key, newChildCode)` only recognized a
`ui(tag, { key: "..." }, [...])` call whose third argument was an array
literal written directly at that call site; children built as a separate
variable and passed in by reference (`const rows = items.map(...); ui(tag,
{key}, rows)`) failed with "has no children array to add to", even though
that code is completely ordinary and runs correctly.

This is fixed: `addChild` now handles both shapes. An inline array literal
is still inserted into directly (keeps existing formatting). Anything else
-- an identifier, a direct `.map()`/`.filter()` call, a ternary -- is
rewritten at the call site as `[...(<original expression>), newChild]`,
without needing to trace the expression back to wherever it was built.

## `setProp` on hyphenated attribute names -- fixed

Originally, `setProp(source, key, "data-testid", ...)` produced invalid
JS: it inserted the prop as a bare identifier (`data-testid: "..."`), which
doesn't parse (`-` isn't valid inside an unquoted object key). It also
couldn't find or overwrite an *existing* hyphenated prop, since the lookup
only matched plain `Identifier` keys.

This is fixed: `setProp` quotes the key (`"data-testid": "..."`) whenever
it isn't a valid bare identifier, and matches existing props by either
`Identifier` or string-`Literal` key.

## `hydrateChildren`'s live-NodeList reconciliation bug -- fixed

`fried.js`'s keyed-list reconciler used to read both the old and new
child lists directly off `.childNodes` (a **live** `NodeList`). Because
reconciliation moves nodes between the old and new trees mid-loop
(`insertBefore` reparents a node out of the new tree's `childNodes`), the
new-tree list would shrink out from under the loop, desyncing indices and
eventually crashing with `Cannot read properties of undefined (reading
'_friedKey')` under real add/remove/reorder churn.

Fixed by snapshotting the new tree's children into a plain array before
the loop starts. The old tree's children are deliberately left as a live
`NodeList` -- they're only ever reordered in place here, never removed
out from under the iteration, and this function runs recursively for
every element in the tree, so snapshotting unconditionally cost a real,
measured performance regression (~10,000-item list mutation benchmark)
for no correctness benefit on that side.

## `hydrateChildren`'s O(n²) live-NodeList indexing -- fixed

Separately from the desync bug above, the keyed-reconciliation loop itself
had a real quadratic-time bug: it read `op.childNodes[i]` (indexed access
on the **old** tree's live `NodeList`) inside the same loop that calls
`op.insertBefore(...)` on that same list every iteration. Indexing a live
`NodeList` is cheap only for sequential access on an *unmutated* list --
real browser engines cache a cursor for fast forward iteration, and that
cache gets invalidated by the very `insertBefore` calls happening between
reads, so each indexed read degraded toward an O(distance-from-cursor)
scan. Across a full list rebuild that's O(n²) overall, not O(n).

Measured on a real Chromium instance (Playwright), rebuilding a
50,000-row list end to end: **36.2 seconds before the fix, 0.68 seconds
after** (53x). A same-scale single-item removal from the middle of the
list: 6.4s -> 0.77s (8x). Smaller lists were affected too, just less
dramatically -- the blowup only becomes visually obvious past a few
thousand rows.

Fixed by walking the old tree with a plain JS pointer (`cur`, advanced via
`cur.nextSibling`) instead of ever indexing `childNodes` inside the loop.
This is compatible with the previous fix above: the old tree's children
are still never snapshotted into an array (no extra allocation), they're
just never index-read either -- only ever walked forward one link at a
time, which is O(1) per step regardless of mutation happening around it.

Re-verified against the full add/churn/shuffle/drain correctness stress
test (`verify.mjs`, 31 checkpoints, 0-20,000 items) after this change:
still 100% passing, no correctness regression.

## Known architectural tradeoff: whole-tree re-render, not component-scoped

This isn't a bug, and isn't something this fix (or any reconciler-level
fix) can remove: fried.js has no component boundaries or memoization.
Every state change reruns the **entire** `renderFn()` passed to `mount()`
from scratch, rebuilding every single `ui(...)` node in the tree, before
the (now-linear) diff even starts. A small, frequently-changing bit of
state (a clock tick, a text input, a hover flag) sitting in the same tree
as a large list pays full list-size cost on *every* one of those
unrelated changes, not just on changes to the list itself.

Measured (same 50,000-item scale, after the O(n²) fix above): an
unrelated one-line state change costs ~580-800ms and holds the frame rate
to ~1.5fps, purely from rebuilding+diffing 50,000 real DOM nodes that
didn't actually change. That's a real, felt "browser-scale" ceiling for
any app with a genuinely large list rendered as real DOM nodes -- diffing
faster only moves the ceiling, it doesn't remove it, because the cost is
in *building* 50,000 new elements every render, not just comparing them.

The fix isn't a reconciler change -- it's not creating that many real DOM
nodes per render in the first place. `src/fried-virtual.js` (optional
module, same precedent as `fried-db.js`) renders only the rows inside the
current scroll viewport. Same 50,000-item scale, same unrelated-tick
scenario, virtualized: **0.4ms per render, steady 60fps** -- because the
tree being rebuilt each time is viewport-sized (~20-30 real nodes), not
list-sized. Reach for it once a single list in an app is large enough (a
few hundred rows or more) that its rebuild cost is what's actually making
the app feel slow; a small app with a few dozen rows doesn't need it.

## `hydrateAttrs` never updating `data-fried-key` on reuse -- fixed

`ui(tag, { key }, ...)` sets the `data-fried-key` DOM attribute (and the
internal `_friedKey` property used for reconciliation) only at element
creation. `hydrateAttrs` explicitly skipped the `key` prop on every
subsequent update, on both the set side and the remove side, so a DOM
node whose logical key changed while it was being reused kept showing its
*original* creation-time key in the DOM (and, more importantly, in
`_friedKey`) forever after.

In ordinary keyed-list usage this never surfaces: a node is only ever
matched to a new node in the first place *because* their keys are equal
(`hydrateChildren`'s fast-path check and its keyed-Map lookup both require
key equality to produce a match), so the "stale" value and the current
value are identical by construction. It shows up specifically when a
child transitions between keyed and unkeyed across renders at the same
list position (e.g. conditionally rendering `ui(tag, { key: "foo" }, ...)`
vs. plain `ui(tag, ...)` for the same slot) -- the unkeyed-fallback match
in `hydrateChildren` reuses whatever node currently occupies that
position without checking key equality at all, so the reused node can
carry a real, now-wrong key forward indefinitely, both in the DOM
attribute (breaks anything reading it, like the `document.querySelectorAll
('[data-fried-key="..."]')` pattern this project's own test harnesses
use) and in `_friedKey` itself (a real, if narrow, reconciliation-hygiene
issue, not purely cosmetic).

Fixed: `hydrateAttrs` now updates both `_friedKey` and the `data-fried-key`
attribute whenever the `key` prop actually changes (set, changed, or
removed), same as every other prop. Verified with a dedicated Playwright
test (keyed -> unkeyed -> keyed transition on the same reused DOM node)
and against the full add/churn/shuffle/drain correctness stress test --
both pass, no regressions.

## `renameSymbol` and shorthand destructured properties with a default

`renameSymbol(source, oldName, newName)` refuses to touch a shorthand
destructured property that also has a default value (`const { oldName = 0
} = obj`), rather than guessing. In that specific shape, the identifier
sits inside an `AssignmentPattern` wrapping the binding, and "rename the
local variable" and "rename the property being extracted" are two
different edits with no way to tell which one is meant from the call
alone. Every other shape (`{ oldName }`, `{ oldName: local }`, a plain
variable, a function parameter, `obj.oldName`, `obj[oldName]`) is handled
correctly -- this is the one deliberately refused rather than force-fit.
Work around it by rewriting to the explicit form (`{ oldName: local = 0
}`) by hand first, then renaming `local`.

## Addressability requires a static literal `key` -- partially closed

Not a bug, but easy to trip on: the patcher only recognizes a `ui(...)`
call as addressable *by key* when that `key` prop is a **string literal**
written directly in the source (`key: "resetBtn"`). A dynamic key
(`key: item.id`, `key: "row" + i`) is correct and necessary for list items
-- fried.js's reconciler needs it to track identity across renders -- but
`setProp`/`setChildText`/`addChild`/`removeChild`/`replaceChild` can't
find a `ui(...)` call by key when its key isn't a fixed string.

What's still true: an individual *rendered instance* of a list item (item
#47, specifically) is not and cannot be addressable this way -- there's no
static string "item 47" to search for, only a runtime value. Give a static
key to anything that isn't a per-item template wrapper if you want to
patch it later; use `scripts/check-keys.mjs` to see which `ui(...)` call
sites in a file currently qualify.

What's no longer true: the *template itself* -- the one place in source
that all instances of a repeated element are stamped from -- used to be
completely unreachable by the patcher, meaning any change to it (add a
button to every row, add a class to every card) required a full-file
`replaceFunction` or a full rewrite, even though logically only one
function's worth of source needed to change. Fixed: a `.map()` render
template written as a named top-level function (`items.value.map(renderItem)`,
not an inline arrow) is addressable by that function's name, via two new
ops -- `addTemplateChild(source, fnName, newChild)` and
`setTemplateProp(source, fnName, propName, value)` -- that find the
function, then the single `ui(...)` call it `return`s, and patch that,
the same targeted single-location edit as every other op here, just
addressed by function name instead of `key`. `scripts/check-keys.mjs` and
`scripts/fried-map.mjs` (the `T:` line) both report which named functions
in a file currently qualify. See CLAUDE.md's "Named render templates"
convention.

Two real limits on this fix, found while building and testing it rather
than assumed: `addTemplateChild`/`setTemplateProp` only recognize the
common, directly-supported shape -- a top-level `function name(item) {
... return ui(...); }` whose last top-level `return` is a bare `ui(...)`
call. A template that assembles its vnode across several variables before
returning it (`const el = ui(...); return el;`) throws a specific error
rather than guessing; use `replaceFunction` or edit it directly instead.
And an *inline* arrow passed to `.map()` (`items.value.map((it) => ...)`)
still isn't addressable at all, by either mechanism -- it has no name for
`addTemplateChild`/`setTemplateProp` to find it by, the same reason
`replaceFunction` only ever matched a named top-level `function`. Pull it
out to a named function first.

## Same key reused across two different templates silently picks the wrong one

Found while testing the template-addressing fix above, not before it,
since it's specifically a multi-template problem: `findUiCallsByKey`
(the lookup behind `setProp`/`setChildText`/`addChild`/`removeChild`/
`replaceChild`) is a single file-wide `Map`, last-write-wins on a
duplicate key -- already documented as a hazard (see `fried-map.mjs`'s
duplicate-key warning) for any repeated key in a file. It gets
meaningfully worse once an app has more than one `.map()` template,
because natural, readable per-slot key names (`"label"`, `"value"`,
`"tag"`) are likely to be reused *by design* across different templates
that each have their own label/value/tag slot -- and unlike an accidental
duplicate elsewhere in a file, this isn't a typo to fix, it's two
correct, independent pieces of markup that happen to want the same
sensible name.

Confirmed with a real test: two templates (`renderCategory`, `renderItem`)
each with their own `key: "label"` child; `setProp(source, "label",
"class", '"bold"')` with no further disambiguation silently applied the
change to `renderItem`'s span (whichever template's `"label"` occurs last
in the file), never `renderCategory`'s `h2`, no error, no warning --
exactly the kind of silent-wrong-target failure this project treats as
worth fixing rather than documenting and moving past.

Fixed: `setProp`/`setChildText`/`addChild`/`removeChild`/`replaceChild`
now accept an optional trailing `within` argument -- a template function's
name -- that scopes the key lookup to just that function's body. `npm run
map` flags exactly this situation with a `! same key used by different
templates, disambiguate with within: "<fn>"` line (distinct from an
ordinary same-scope duplicate, which `within` can't fix -- that still
needs a rename). Unscoped behavior is unchanged (still last-match-wins,
now documented rather than silently surprising) for backward
compatibility with every call site written before this fix existed.

## `setChildText` requires an inline array-literal children argument -- fixed

`setChildText(source, key, oldText, newText)` used to throw "has no
literal children array to edit" when the target `ui(tag, props, children)`
call's `children` argument was a bare string (`ui("button", {...}, "Add
Task")`) instead of an array (`ui("button", {...}, ["Add Task"])`) --
even though the two are functionally identical to fried.js at runtime.
`addChild` had this same restriction and was fixed to accept either
shape; `setChildText` didn't get the equivalent fix at the time, so a
bare-string child (a common, natural way to write a single static text
child) was invisible to it. Found while building the token-efficiency
benchmark (`fried.js benchmark/results/results.md`) -- worked around
there by wrapping the specific target elements' children in `[...]` (a
no-op behavioral change) in the app source, rather than fixing the
patcher.

Fixed: `setChildText` now also matches a bare-string children argument
directly (`ui(tag, props, "Add Task")` with `oldText: "Add Task"`) in
addition to a string inside an array literal, mirroring `addChild`'s
earlier fix. CLAUDE.md's own convention (prefer an array over a bare
string) is still worth following for new code -- it keeps the patch diff
smaller -- but existing bare-string children no longer need to be
rewritten first just to become addressable.

## `setProp`'s value argument is raw source, and a wrong value can pass `validate()` silently -- closed for data values

`setProp(source, key, propName, newValueSource)`'s last argument is
spliced into the output as literal JavaScript **source text**, not a data
value -- so setting a string prop requires passing the already-quoted
source (`JSON.stringify("task-toolbar")`, i.e. `'"task-toolbar"'`), not
the plain string (`"task-toolbar"`). Passing the plain string produces
`data-testid: task-toolbar` in the output, which is syntactically valid
JavaScript (a subtraction expression, `task - toolbar`) -- so `validate()`,
which only checks that the result parses, does not catch the mistake. It
only surfaces at runtime, as `Uncaught ReferenceError: task is not
defined`. This happened twice while building the token-efficiency
benchmark and was only caught by real-browser smoke tests, not by
`validate()`.

Closed for the common case: `setPropValue(source, key, propName,
dataValue, within?)` takes a plain JS **data value** -- a string, number,
boolean, `null`, `undefined`, a plain object/array -- and serializes it
correctly itself (`JSON.stringify` for the JSON-safe cases, with
`NaN`/`Infinity`/`-Infinity`/`undefined` handled explicitly since
`JSON.stringify` turns those into `null` or drops them, which would be a
silent semantic change). Passing a function, a `BigInt`, or a `Symbol`
throws a `PatchError` immediately, with a message pointing back at
`setProp`/`setTemplateProp` and raw source text, rather than serializing
something misleading. `setTemplatePropValue(source, fnName, propName,
dataValue)` is the same fix for template wrapper props. `setProp` and
`setTemplateProp` themselves are unchanged -- still raw source text, for
the real cases that need it (an arrow function handler, a `cssVar(...)`
call, any other non-literal expression) -- `setPropValue`/
`setTemplatePropValue` are additive, not a replacement. Prefer them by
default for a plain data value; reach for `setProp`/`setTemplateProp`
directly when the value has to be source, not data.

## `.map()` templates nesting other templates -- confirmed to already work

Checked directly, since it wasn't obvious from reading `addTemplateChild`/
`setTemplateProp`'s implementation alone: a template whose own body
contains *another* named template's `.map()` call (a category template
rendering `cat.items.map(renderItem)` inside itself) needed no new
patcher logic. Both `addTemplateChild(source, "renderCategory", ...)` and
`addTemplateChild(source, "renderItem", ...)` already address their own
function independently and correctly, regardless of nesting -- the
addressing scheme is flat (by function name), not tree-shaped, so nesting
was never actually a problem for it. Verified with a dedicated test
(`tests/patcher.test.js`) patching both the outer and inner template of a
nested pair and confirming each patch lands only in its own function.
`scripts/fried-map.mjs`'s `T:` line now also reports nesting inline
(`renderCategory(> renderItem)`) when it's present, purely so an AI
doesn't have to read the source to find out the shape -- it doesn't change
what's addressable.

## CSS rule edits -- previously unaddressable, now a dedicated op pair

Before this, a `css({...})` call's declarations had no patcher op at all
-- changing one meant a full-file edit even for a one-line style tweak,
explicitly called out as a patcher gap in CLAUDE.md's conventions section
("CSS rule additions" was listed as something to "edit directly and say
so"). `setCssRule(source, varName, ruleName, declText)` and
`removeCssRule(source, varName, ruleName)` close that: they find a
top-level `const <varName> = css({...})` call and set/remove one named
rule's declaration string. Deliberately designed to take a plain CSS
declaration **string** directly (`"padding: 8px 16px;"`), not raw source
text -- a CSS declaration is always a string at the `css()` call site to
begin with, so there's no raw-source landmine to close here the way there
was for `setProp`; `setCssRule` throws a `PatchError` immediately if
`declText` isn't a string, rather than accepting something that would
silently splice wrong. `scripts/fried-map.mjs`'s new `CSS:` line reports
which top-level `const`s are `css({...})` calls and which rule names each
one currently defines.
