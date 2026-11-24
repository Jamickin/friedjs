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
* `fried-router.js`: A lightweight Hash Router for building SPAs on zero-config static servers, with `:param` routes (`/plans/:id`) and query strings.
* `fried-grid.js`: A character grid for real-time drawing: typed-array cells, per-cell light, Braille sub-cell dots, and a canvas renderer that redraws only the cells that changed.
* `fried-loop.js`: A frame loop with a fixed-step simulation tick that sits inside FriedJS's microtask batching (one virtual-DOM render per frame, at most).
* `fried-pointer.js`: Tap, hold and drag per mouse button, with pointer capture, for a canvas or any element.

For the Node side of a small local app, `addons/server/` has four more, with no npm dependencies:
* `fried-score.js`: state in one atomically written JSON file, plus an event log, a ring buffer and subscribers.
* `fried-serve.js`: a localhost HTTP server with a Host guard, token auth, route tables, safe static folders and server-sent events.
* `fried-tools.js`: declare a tool once and serve it over HTTP, as an MCP server over stdio, and as docs.
* `fried-proc.js`: run an AI CLI or a check line by line, kill its whole process tree, spot usage limits.

## Development & Benchmarks
This repository contains the core framework source, the test suite, and the telemetry dashboard.

```bash
# Run the unit, docs-truth and version tests (tests/)
npm test

# Run the high-scale correctness stress tests, and the timing benchmark
node stress.js
node benchmark.js

# Print what an app file exposes to the patcher (server files also get
# REG:/TOOLS:/ROUTES: lines)
npm run map -- app.js
npm run check-keys -- app.js

# Record friction (evolution/README.md), and rank what's been recorded
npm run friction -- --want "..." --tried "..." --error "..."
npm run digest -- --since 7d

# Run the Telemetry Dashboard server (http://localhost:3000)
npm start
```

The add-ons live in `addons/`, the AI tooling in `tooling/`. See
`CLAUDE.md` for how an AI session should work here, `docs/framework-api.md`
for the API, `CHANGELOG.md` for versions and `evolution/EVOLUTION.md` for
why things changed.
