# This runtime is a merge of two independently-evolved iterations

Two separate sessions took fried.js in different directions on the same
day. This project (`fried.js new`) combines the stronger parts of both,
verified against the full existing test suite, new regression tests
written specifically for this merge, and real-browser checks (Playwright)
including re-running all three of the token-efficiency benchmark's actual
apps (small/medium/large) end to end against the merged runtime with zero
changes to those apps.

> **Paths in this file are historical.** The merge was done in a layout
> with `src/`, `scripts/` and a larger `tests/` folder. In this repo,
> `src/fried.js` is `fried.js`, `src/patcher.js` is `tooling/patcher.js`,
> `src/fried-db.js` and `src/fried-virtual.js` are in `addons/`, and
> `scripts/*.mjs` are in `tooling/`. The test files named in "How this was
> verified" (`tests/patcher.test.js`, `tests/merge-regressions.test.js`,
> `tests/browser-verify.mjs` and the rest) were not brought into this
> repo. The tests that exist here are listed in `docs/framework-api.md`'s
> "Tests and checks" section.

## Where each half came from

**`src/fried.js`** (the runtime) is based on the **vnode-based rewrite**
(internally referred to during comparison as "friedjs-lib"). `ui(...)`
returns a lightweight virtual-node object instead of a real DOM element
immediately, so a render pass only pays real DOM-creation cost for the
parts of the tree that are genuinely new, not for subtrees that end up
reused. That iteration also brought:

- SVG support (`svg`/`path`/`circle`/`g`/`rect`/`line`/`polygon`/
  `polyline`/`text` created via `createElementNS`).
- Two small auto-accessibility/UX defaults: `loading: "lazy", decoding:
  "async"` on `<img>`, and `role: "button", tabIndex: 0` on a non-button
  element with an `onclick`.
- A two-ended prefix/suffix trim in the list reconciler, resolving a pure
  append/prepend/truncate with zero `Map` allocation before ever falling
  back to the keyed-Map algorithm.
- Correct handling of an event handler added to an *already-existing,
  reused* element on a later render (a handler type that wasn't present
  when the element was first created). The other iteration's `ui()`
  attached DOM listeners only once, at element creation, for whichever
  handler props existed *then* -- a handler type added later updated the
  internal handler map but never actually called `addEventListener`, so
  the click (or whatever event) silently did nothing forever. Confirmed
  with a real Playwright test against both versions before merging: the
  other iteration reproduces this bug, this merge (via the vnode
  iteration's re-attach guard) does not.

Two real, independently-verified fixes from the **other iteration**
(referred to during comparison as "fried-app-copy" -- this project's own
prior state) were folded into that base, because the vnode iteration
never received either fix on its own branch:

1. **`hydrateAttrs` updating `_friedKey`/`data-fried-key` on prop
   change.** The vnode iteration still explicitly skipped the `key` prop
   in both the set and remove loops (`k === "key"` always `continue`s),
   so a node's key went stale forever once reused across a render where
   the key itself changed (most visibly: a slot flipping between a keyed
   and an unkeyed `ui(...)` call at the same list position). See
   `known-limitations.md`'s entry on this for the original writeup.
2. **The keyed-reconciliation fallback walking by object reference
   (`cur`, advanced via `cur.nextSibling`) instead of indexing the live
   `childNodes` list by position every iteration.** The vnode iteration's
   fallback still read `op.childNodes[i]` inside the same loop that calls
   `insertBefore` on that same list every iteration -- degrading toward
   O(n²) at list scale (measured elsewhere at 36s for a 50,000-row
   rebuild before this class of fix, well under a second after). Ported
   in as a straight adaptation of the already-proven fix, not a redesign
   -- see the comment at its call site in `src/fried.js` for one
   deliberate departure from a naive scoped port (the keyed fallback
   reconciles the *full* list, not just the untrimmed middle span the
   trim optimization above found, because scoping it to just the middle
   would leave the trimmed suffix sitting untouched at the tail while
   stale leftover nodes end up positioned *before* it -- breaking the
   "extra nodes end up at the very end" invariant the final truncate step
   relies on).

**`src/patcher.js`** is the other iteration's version essentially as-is
(`setProp`, `setChildText`, `addChild`, `addStatementAfter`, `removeChild`,
`replaceChild`, `removeStatement`, `renameSymbol`, `patch`, `validate`) --
it's the fuller of the two patchers: the vnode iteration's patcher never
had `replaceChild`, a general `renameSymbol` (only a narrower
`renameAction`), or `patch()` (batch-apply several ops in one call, with
one shared validation at the end) at all. One op was ported the other
direction: **`replaceFunction`** (whole top-level function replacement),
which the vnode iteration's patcher had and this one didn't, filling a
real gap none of the finer-grained ops cover cleanly (a function whose
internals change substantially). Registered in `patch()`'s op table like
every other function here.

`src/fried-db.js` and `src/fried-virtual.js`, `scripts/check-keys.mjs` and
`scripts/fried-map.mjs`, and the whole `tests/` and `docs/` structure
carried over unchanged from the fried-app-copy iteration, since that's
where all of it already lived -- the vnode iteration had none of this
tooling.

## What's still an open gap either way

Neither iteration had fixed these before the merge, and neither is fixed
here -- see `known-limitations.md` for the full writeup of each:

- `setChildText` requires an inline array-literal children argument; a
  bare string child throws.
- `setProp`'s value argument is raw JS source text, not a data value, and
  a wrong (unquoted) value can produce output that's syntactically valid
  JS and passes `validate()` silently, only failing at runtime.
- `renameSymbol` refuses a shorthand destructured property with a default
  value (`{ oldName = 0 }`) rather than guessing which of two different
  edits was meant.

## How this was verified before shipping

- All 53 pre-existing tests (`tests/patcher.test.js`,
  `tests/realistic.test.js`, `tests/fried-map.test.js`,
  `tests/diagnostics.test.js`) pass unchanged against the merged
  `patcher.js`.
- `tests/merge-regressions.test.js` (new): structural checks that both
  ported-in fixes and both kept capabilities are actually present in
  `src/fried.js`'s source, plus behavioral tests for the new
  `replaceFunction` op (bare and exported function, unknown-name error
  with a nearest-match suggestion, registered in `patch()`).
- `tests/browser-verify.mjs` (new, real headless Chromium via
  Playwright): the late-added-handler fix, the hydrateAttrs key fix
  (including that the stale `data-fried-key` is actually gone from the
  DOM, not just overwritten), an 8,000-item full-shuffle reconciliation
  (all items present afterward, correct final order, completed in
  ~60ms -- an O(n²) implementation would take many seconds at this
  scale), and SVG element creation in the correct namespace.
- All three of the token-efficiency benchmark's actual apps
  (`small`/`medium`/`large` -- real task-manager and Kanban-board apps,
  283 to 1,139 lines, with live search, IndexedDB persistence, undo/redo,
  virtualized dense rendering) were re-run through their own existing
  Playwright verification scripts with **only** `src/fried.js` swapped
  for this merged version, no changes to the apps themselves: 8/8, 10/10,
  and 16/16 checks passing, including focus preservation during live
  typing and IndexedDB persistence for the small/medium apps and
  undo/redo + virtualization for the large one.

## 0.2.0 (phase F0): docs match the repo -- what changed, how verified

No runtime behaviour changed. Why: `evolution/EVOLUTION.md` entry 1.

**What changed.** `patcher.js` moved to `tooling/patcher.js` (the root
`patcher.js` is now `export * from "./tooling/patcher.js"`, so existing
`./patcher.js` imports such as `benchmark.js` keep working) and `test.js`
to `tests/test.js`. `npm test` runs `tests/run.mjs`, which runs
`tests/test.js` plus every `tests/*.test.js`. New npm scripts `map` and
`check-keys`. `fried.js` gained only `export const VERSION = "0.2.0"`.
New tests: `tests/docs-truth.test.js` and `tests/version.test.js`. Every
dead path and npm script in `CLAUDE.md`, `README.md`,
`docs/framework-api.md` and `docs/known-limitations.md` was fixed, and the
exports `store`, `derived`, `render`, the `ref` prop and
`addons/fried-router.js` were documented.

**How it was verified.**

- `tests/docs-truth.test.js` run against the untouched docs (from `git
  archive` of commit `0864320`) reported 25 dead references: 15 paths
  (`src/fried.js`, `src/fried-virtual.js`, `scripts/check-keys.mjs` x2,
  `scripts/fried-map.mjs` x5, `tests/fried-map.test.js` x2,
  `tests/realistic.test.js`, `tests/diagnostics.test.js`,
  `merge-regressions.test.js`, `browser-verify.mjs`) and 10 npm scripts
  (`map` x6, `check-keys` x3, `serve`). On the final tree it passes, along
  with the rest of `npm test` (17 tests, 0 failures).
- `node stress.js`: 43 passed, 0 failed, before and after.
- `node benchmark.js` and the stress timing, 3 runs after vs. the
  `evolution/baseline.md` medians (25% tolerance), all within 3%: 1,000
  cards 2.23-2.29 ms (baseline 2.27); 5,000 cards 8.41-8.53 (8.24);
  20,000 cards 24.3-24.5 (24.7); 50,000 cards 61.0-63.2 (61.6); 100,000
  state updates 23.2-23.7 (25.2); 600 patcher cycles 300.8-303.8 (309.5);
  stress create 10,000 rows 4.00-4.15 (4.3); append 1,000 2.10-2.18 (2.2).
- `npm run map -- app.js` and `npm run check-keys -- app.js` print the
  index and addressability report for the dashboard app.
