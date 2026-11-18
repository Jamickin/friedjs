# Fried.js AI Instructions

You are working in **Fried.js v1.0**, a zero-build-step, Virtual-DOM UI framework. 

## 1. Core Architecture
- **No React/Svelte/JSX**: Use raw JS.
- **UI**: Return plain objects via `ui(tag, props, children)`.
- **State**: `const val = state(initial);` (Read/write via `val.value`).
- **Actions**: Wrap state mutations in `action("name", () => { ... })` to trigger batched microtask renders.
- **CSS**: Co-locate using `const styles = css({ title: "color: red;" })`.

## 2. Modifying Code (CRITICAL)
- **Do NOT overwrite entire files** for UI changes.
- You MUST use `tooling/patcher.js` to modify AST safely.
- **Patcher Ops**: 
  - `patch(source, [{ op: "setProp", args: ["key", "prop", "val"] }])`
  - Available ops: `setProp`, `setChildText`, `addChild`, `addStatementAfter`, `removeChild`, `replaceChild`, `removeStatement`, `renameSymbol`.
- Keys must be absolutely unique among siblings. The patcher relies on `key` strings to find elements.

## 3. Optional Modules
- **Database**: Import `addons/fried-db.js` for IndexedDB reactive collections.
- **Virtual Lists**: Import `addons/fried-virtual.js` for 100k+ row windowed rendering.

Read `fried.js` and `patcher.js` directly if you need to inspect the exact API signatures.
