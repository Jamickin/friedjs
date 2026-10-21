# Fried.js 🍟

**Fried.js** is a blazingly fast, zero-build-step, AI-native Virtual DOM framework.

It operates at the physical speed limits of the browser's JavaScript engine by combining lightweight Virtual DOM trees with an `O(n)` reconciler, a two-ended prefix/suffix trimming algorithm, and single-pass Garbage Collection. 

There is no Vite, no Webpack, and no build step required. You write standard JavaScript, and it renders instantly.

## Features
* **Zero Build Step:** Import `fried.js` directly in the browser via `<script type="module">`.
* **Microtask Batching:** Multiple synchronous state updates are automatically coalesced into a single render pass.
* **Inline CSS-in-JS:** Co-locate your styles effortlessly. `css({ btn: "color: red;" })` generates and dedupes classes automatically.
* **AI-Native Patcher:** Includes `tooling/patcher.js`, an AST-based surgical editor that allows AI agents (Claude, Cursor, Antigravity) to modify your components reliably without relying on fragile regex text diffs.

## The Modules
The core framework (`fried.js`) is fiercely protected from bloat. Advanced features are shipped as optional add-on modules:
* `fried-db.js`: A synchronous, memory-first reactive database backed by IndexedDB.
* `fried-virtual.js`: A windowed Virtual Scroller for rendering 100,000+ items without freezing the DOM.
* `fried-router.js`: A lightweight Hash Router for building SPAs on zero-config static servers.

## Development & Benchmarks
This repository contains the core framework source, the test suite, and the telemetry dashboard.

```bash
# Run the unit, docs-truth and version tests (tests/)
npm test

# Run the high-scale correctness stress tests, and the timing benchmark
node stress.js
node benchmark.js

# Print what an app file exposes to the patcher
npm run map -- app.js
npm run check-keys -- app.js

# Run the Telemetry Dashboard server (http://localhost:3000)
npm start
```

The add-ons live in `addons/`, the AI tooling in `tooling/`. See
`CLAUDE.md` for how an AI session should work here, `docs/framework-api.md`
for the API, `CHANGELOG.md` for versions and `evolution/EVOLUTION.md` for
why things changed.
