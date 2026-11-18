# Pivot, rebuilt in Fried.js

An attempt to recreate the core of [Pivot](../OGats/pivot) — James's local-first
daily log app (Svelte 5 + Tailwind + Supabase) — on top of **Fried.js**, the
zero-build-step vanilla-JS runtime that lives in this repo. No npm install, no
build step: open `index.html` through any static file server and it runs.

## What's here

Pivot has four surfaces (`/`, `/circleback`, `/string`, `/settings`). This
recreates the three that don't depend on an external service (Google
Calendar sync is out of scope for a zero-dependency demo):

- **Day** (`#/day/YYYY-MM-DD`) — the note flow. Write one line at a time;
  each committed line becomes its own card. End a line with `*`, `**`, or
  `***` to mark it — the marker is stripped from the text and shows as a
  colored dot (Note / Notable / Important by default, same three levels and
  colors as Pivot's own `defaultCategories()`). A calendar sits beside the
  flow, dots mark days with entries, click a day to jump to it.
- **String** (`#/string`) — a force-directed graph built from `[[...]]`
  links in your entries. `[[2026-09-23]]` is a day-link (an edge to that
  date's node, click it to jump there); anything else, e.g. `[[coffee]]`, is
  a concept-link (its own node, click it to focus). This is a from-scratch,
  much smaller stand-in for Pivot's real windowed/Barnes-Hut graph — a plain
  O(n²) force layout, which is plenty at the scale a demo reaches.
- **Settings** (`#/settings`) — switch between Pivot's two visual "skins"
  (Flat: crisp cards, hairline borders — Soft: neumorphic, shadow-only
  depth) and light/dark, edit the three marker categories' colors and
  labels, or clear all local data. Tokens are carried over from Pivot's own
  `src/routes/layout.css`.

Everything is stored in this browser's IndexedDB via `addons/fried-db.js` —
nothing syncs anywhere, same "no backend required" spirit as Pivot's own
local-first mode.

**Not attempted**: Circleback (Google Calendar sync), Supabase sync/auth/
workspaces, the whiteboard, Jot, Shrimp, email — all of Pivot's
service-backed or SvelteKit-route-specific features. This recreates the
data model and interaction pattern of the note flow + graph + skins, not a
port of every route.

## Running it

```bash
python3 -m http.server 8080
# or: npx serve .
```

Then open `http://localhost:8080`.

## Code layout

```
app.js              entry point: mounts the app, top nav, hash router
src/
  store.js           db (fried-db/IndexedDB), route state, skin/theme state
  parsing.js          marker + [[wikilink]] parsing (ported from Pivot's
                       src/lib/editor/marker-parsing.ts and wikilink-parsing.ts)
  dates.js             YYYY-MM-DD date helpers, month grid
  graph.js             String's graph: build nodes/edges, force layout
  theme.js             design tokens (adapted from Pivot's layout.css) + styles
  components/
    calendar.js         month calendar
    entryCard.js         one entry card (marker dot, text w/ links, delete)
  views/
    day.js                composer + entry list + calendar
    string.js              graph view
    settings.js             skin/theme/category/data controls
fried.js             core runtime (unchanged — see its own header comment)
addons/fried-db.js   IndexedDB-backed reactive collections (unchanged)
addons/fried-virtual.js  windowed list helper (unused here — not enough rows)
tooling/patcher.js   AST patcher for AI-driven edits (unchanged, Node-only)
```
