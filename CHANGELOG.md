# Changelog

All notable changes to FriedJS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). The top version must
equal `package.json`'s `version` and `fried.js`'s `VERSION` export
(`tests/version.test.js` checks it). Why each change was made is in
`evolution/EVOLUTION.md`.

## [0.12.0] - 2026-11-25

A pass spent making the game hold up found the same three helpers written
by hand again and again in its tests (`evolution/EVOLUTION.md` entry 29).
Additive.

### Added
- `addons/fried-probe.js`: `createRandom(seed)` (chance from a seed, with
  `install()` to stand in for `Math.random`), `series(values)` (how a
  number moved over time: its span, its largest step, how often it
  turned), `watchErrors()` (what an app reports to the console and the
  window while a script drives it).

## [0.11.0] - 2026-11-25

The same day's second pass over the game's frame (`evolution/EVOLUTION.md`
entry 28). No new API.

### Changed
- `addons/fried-light.js`: `relight()` finds what changed in the heights row
  by row (the span of changed cells in each row), not as one box, and picks
  the rays to sweep again by the wedge of directions those spans lie in as
  each lamp sees them. An arm lying across a desk is a wide box and a
  narrow wedge: the game's hand costs a fifth fewer rays (803 to 632 a
  frame of 2,688), and a lamp is swept whole a fifth as often. The result
  is unchanged: still the light of a room lit from nothing, bit for bit.

## [0.10.0] - 2026-11-25

The game's player asked for "high performance high impact" at fine grids
(324 x 124 characters and finer). Measured first, in Node and then in the
browser, the two largest costs were both in FriedJS: a moving hand relit
the whole room, and the canvas paid two calls for every changed cell
(`evolution/EVOLUTION.md` entries 25-27). Additive.

### Added
- `addons/fried-light.js`: `relight({ ambient, fields, lights, refresh })`,
  the KEPT light. Each lamp's share is remembered; when heights change,
  only the rays that pass through the changed box are swept again, from
  where they enter it; a lamp that moved is worked out again by itself; a
  colour change is only added up again. The result is the light the same
  room would get lit from nothing, to the last bit (a property test moves
  random things under random lamps and compares). `restore()` puts the
  kept light (`kept`) in `r`, `g`, `b` for a frame's quick lights.
- `addons/fried-grid.js`: `createGridRenderer({ pixels: true })`. Glyphs
  are kept as masks, changed cells are written into one `ImageData`, and
  each band of changed rows is one `putImageData`. A frame costs the
  pixels that changed. Measured at 313 x 101 (3 x 6 pixel cells): 1,300
  changed cells 5.5 ms -> 0.5 ms; a full repaint 149 ms -> 5 ms.

### Changed
- `addons/fried-light.js`: `normals()` and the sweep inside `point()` are
  the same code `relight()` uses (no change in what they compute).

## [0.9.0] - 2026-11-24

The game's owner, on seeing 120,000 random actions tested in a minute:
"that can be a cool thing about fried, how fast tests can happen, because
they don't need screens". It can: the pieces the game's test harness had
grown are now an addon (`evolution/EVOLUTION.md` entry 24). Additive, with
one change of behaviour in `fried-grid-ui`.

### Added
- `addons/fried-probe.js`: `createMouse(props)` (a mouse that sends what a
  browser sends: a move names no button; only the first button down and
  the last up are down and up events, a chord in between arrives as moves),
  `createTimers()` (timers and a clock turned by hand, `forPointer` for
  `createPointer`), `gridText(grid)` and `findText(grid, text)`.

### Changed
- `addons/fried-grid-ui.js`: `button`, `row`, `slider` and `input` answer
  to the left button only (a right click used to press them). `region()`
  still reports every button's tap, with `tap.button`.

## [0.8.0] - 2026-11-24

The game's player came back from his first hour with it: a right-button
hold "doesn't work yet", turning a stone showed nothing, and "check the
fried tools if they can't be better". An independent review of the six
game addons followed (`evolution/EVOLUTION.md` entries 21-23). Additive,
with two defaults changed: cast shadows are now a sweep (`shadows: "walk"`
keeps the old ones), and `createGrid`'s `set` floors its coordinates
(`set(-0.5, 0)` used to land in column 0; it is off the grid now).

### Added
- `addons/fried-pointer.js`: `dragPx` may be a function of the button
  (`Infinity`: that button never drags, so a wobbling mouse keeps its tap
  and its hold); `onlostpointercapture` in `props`.
- `addons/fried-raster.js`: `strokePoly`, the rounded one-glyph-a-side
  outline of any closed shape, on the rim of what `fillPoly` covers.
- `addons/fried-light.js`: `spill(emissive, k, radius)`; `point({ shadows:
  "walk" })`.
- `addons/fried-grid.js`: `createDots().touch`; `blit` takes a plain
  function; `renderer.invalidate({ atlas: true })`.
- `addons/fried-grid-ui.js`: `tap(x, y, button)`; `region()` also returns
  the `tap` that clicked it.

### Changed
- `addons/fried-light.js`: `point()` casts shadows with a horizon sweep
  from the light instead of a walk from every cell: about a third of the
  cost (5.9 ms to 2.2 ms for three candles at 313 x 101), and a thing one
  cell wide now throws a whole shadow instead of a striped one.
- `addons/fried-grid.js`: `createDots` clears and blits only the bounds of
  what was set; `fill` clips once and fills by row; `set` floors.
- `addons/fried-raster.js`: `fillCapsule` compares squared distances.

### Fixed
- `addons/fried-pointer.js`: a second mouse button pressed or released
  while another is held (which a browser reports as a pointermove) is its
  own press with its own end; before, it was never seen and could leave
  the first press open for good. A new press on a button ends the one it
  replaces. When the last button comes up, any press still open is ended.
- `addons/fried-grid-ui.js`: a focused text field that stops being drawn
  no longer keeps every key; `input` with an undefined value and a
  `slider` narrower than two cells no longer throw; the caret follows a
  typed space; a `row`'s left half is where its value is drawn (it was
  one cell to the left).
- `addons/fried-grid.js`: a light of radius 0 no longer writes NaN; the
  renderer's `resize` no longer loses a pixel to rounding; sprites with
  no alpha are skipped; `cssColor`'s cache is bounded.
- `addons/fried-raster.js`: a shape with a coordinate that is not finite
  draws nothing instead of looping for ever.
- `addons/fried-loop.js`: a frame that throws no longer leaves a loop
  that says it is running and is not.

## [0.7.0] - 2026-11-24

The game's second pass: its player asked for a screen that is ONLY
characters (no styled HTML panels, no coloured cell backgrounds), a
resolution he can turn up, and "a system" for the lighting. Each needed
something FriedJS did not have (`evolution/friction.jsonl`, consumer
`whmah-ascii`; `evolution/EVOLUTION.md` entries 17-20). All additive.

### Added
- `addons/fried-raster.js`: shapes into cells at any resolution
  (`strokeLine`, `strokePath`, `strokeEllipse`, `fillEllipse`, `fillPoly`,
  `fillRect`, `fillCapsule`, `edgeGlyph`).
- `addons/fried-light.js`: `createLighting` (a height per cell, normals,
  ambient, point lights with cast shadows, added fields) and `toneGlyph`
  (a glyph for a brightness).
- `addons/fried-grid-ui.js`: `createGridUi`, an immediate-mode UI drawn
  in a cell buffer (box, button, row, slider, scrolling list, text field,
  `mute` for what a modal covers), and `wrapText`.
- `addons/fried-grid.js`: `TRANSPARENT` and `createGridRenderer({ alpha })`,
  so one grid can be laid over another.

## [0.6.0] - 2026-11-24

FriedJS carries a real-time game for the first time ("We Have Magic at
Home", an ASCII magic sandbox: a 136 x 42 character grid lit per cell,
redrawn every frame, with a FriedJS HUD round it). Everything here came
from friction building it (`evolution/friction.jsonl`, consumer
`whmah-ascii`); see `evolution/EVOLUTION.md` entries 13-16. All additive.

### Added
- `addons/fried-grid.js`: a typed-array cell buffer (`createGrid`), a
  per-cell RGB light field (`createLight`, `shade`), a 2 x 4 sub-cell dot
  layer written out as Braille (`createDots`), colour helpers, and
  `createGridRenderer`, a canvas renderer with a per-cell keyed diff, a
  tinted-glyph atlas and a sprite overlay for sub-cell motion.
- `addons/fried-loop.js`: `createLoop`, a fixed-step simulation tick with
  one render per animation frame, paused while the page is hidden.
- `addons/fried-pointer.js`: `createPointer`, tap / hold / drag per mouse
  button with pointer capture, leaving presses on controls inside the
  element to those controls.
- `fried.js` `css()`: keys of the form `"name:hover"` / `"name::after"`
  (a state or pseudo-element of a class in the same call) and
  `"@keyframes x"` / `"@media (...)"` (an at-rule, inserted once).

## [0.5.0] - 2026-10-22

Friction batch: four additive changes to the server addons and the map,
each from lines in `evolution/friction.jsonl` written while Orchestra
moved onto them (phase F4b). No existing call changes behaviour except
the static-folder escape below, which now answers 404 instead of
reaching a route. `fried.js` gained only `VERSION = "0.5.0"`. See
`evolution/EVOLUTION.md` entries 9-12.

### Added
- `addons/server/fried-serve.js`: a handler's `ctx.send` is bound to its
  response, `send(code, data, type?, headers?)`, so
  `createToolHttpHandlers` handlers work directly as routes; the older
  `send(res, code, data, ...)` form still works.
- `addons/server/fried-serve.js`: `createAppServer({ notFound })`, a route
  spec (with the usual `auth`/`role` checks) for paths no route matches.
- `addons/server/fried-tools.js`: `createToolRegistry(name, tools, {
  fallbackRole })`, so a role without tools of its own gets that role's
  tools; an unknown `fallbackRole` throws when declared or replaced.
- `addons/server/fried-proc.js`: `onParsedLine` gets a third argument `{
  flushed }`, `true` for the lines `parser.flush()` returned on close.
- `npm run map`: exported top-level functions and exported function-valued
  consts appear on `F:`, marked `(exported)`; `buildFriedMap` returns
  `exportedFuncs`.
- Tests: 4 in `tests/fried-serve.test.js`, 2 in `tests/fried-tools.test.js`,
  1 in `tests/fried-map.test.js`, and `tests/fried-proc.test.js` checks the
  `{ flushed }` argument.

### Fixed
- `serveStaticDir`: a raw URL under the prefix whose dot segments
  normalise out of it (`/ui/../api/health`) now gets the static folder's
  404 instead of falling through to the routes by its normalised path.

## [0.4.0] - 2026-10-22

Phase F4, friedjs half: four Node-only server addons extracted from
Orchestra's composer with its behaviour unchanged, plus the AI tooling to
read and patch server files, and multi-target sync. Additive: no browser
module changed (`fried.js` gained only `VERSION = "0.4.0"`), and every
existing export, patch op, map line and fried.json keeps working. See
`evolution/EVOLUTION.md` entries 4-8.

### Added
- `addons/server/fried-score.js`: `createScore`, `id`, `token`. One JSON
  state file written atomically (debounced), an append-only events file,
  an in-memory ring buffer, subscribers and per-id text logs.
- `addons/server/fried-serve.js`: `createAppServer`, `serveStaticDir`,
  `createSseHandler`, `readJsonBody`. Localhost HTTP server with a Host
  guard, bearer/query token auth, route tables with per-route auth and
  roles, hardened static folders and server-sent events with replay.
- `addons/server/fried-tools.js`: `createToolRegistry`,
  `createToolHttpHandlers`, `createMcpStdioServer` and the schema
  shorthands `str`, `num`, `bool`, `arr`, `obj`. One tool declaration
  serves HTTP, an MCP stdio shim and generated docs; tools can be
  replaced at runtime.
- `addons/server/fried-proc.js`: `spawnLineProcess`, `killTree`,
  `lineReader`, `limitHit`, `resetTime`, `sanitizeOutput`, `tailOutput`,
  `RATE_LIMIT`, `RESUME_FAILED`, `sessionIdOk`. Line-by-line child
  processes, Windows process-tree kill, usage-limit and reset-time
  parsing.
- Patch ops `addTool`, `setToolDescription`, `setToolInput` (a tool by
  name, refused when the name is in more than one group and no group is
  given) and `addRosterAgent` (JSON or JS rosters; refuses duplicate ids
  and unknown hand-offs). All four are instrumented like the others and
  work as `patch()` steps.
- `npm run map` prints `REG:` (tool registries), `TOOLS:` (tools by group)
  and `ROUTES:` (route tables and inline `path === "/x"` tests) for server
  files; `buildFriedMap` returns `registries`, `tools` and `routes`.
- `tooling/fried-sync.mjs`: fried.json may have `targets: [{ dest, files,
  flat? }]` next to (or instead of) the top-level `dest`/`files`; `flat:
  true` copies to `<dest>/<file name>`. All targets share one lock and are
  restored together when a copy or the consumer's test fails.
- Tests: `tests/fried-score.test.js`, `tests/fried-serve.test.js`,
  `tests/fried-tools.test.js`, `tests/fried-proc.test.js`,
  `tests/patcher-server.test.js`, `tests/fried-map.test.js`, 7 new cases in
  `tests/fried-sync.test.js`, one in `tests/patcher-instrumentation.test.js`.

### Changed
- `jsconfig.json` excludes `addons/server` (no Node types in the browser
  type check), so `npm run build` passes with the new addons in place.
- `tests/docs-truth.test.js` checks the four server addon sections of
  `docs/framework-api.md`, and that every export of the addons is
  documented.
- `tooling/fried-sync.mjs` now refuses a fried.json whose `flat` is not
  `true`/`false`, and two files that would land on the same path.

## [0.3.0] - 2026-10-22

Phase F3a: `addons/fried-router.js` matches `:param` routes and a query
string, from the first real friction line (`evolution/friction.jsonl`
line 1). Additive: every exact-path route and the `"*"` fallback resolve
as before. See `evolution/EVOLUTION.md` entry 3. This release also ships
the phase F2 tooling listed below it, which was waiting under Unreleased
for a version bump.

### Added
- `router(routes)` route keys may contain `:name` segments
  (`"/musicians/:id"`, `"/plans/:id/tasks/:taskId"`), matched segment by
  segment (no regex built from pattern text). More literal segments win;
  ties go to the route declared first. Trailing slashes are tolerated.
- The view is called with one argument, `{ params, query, path }`: params
  and query values are URL-decoded (a bad escape is kept as written), the
  query's first value wins, `path` has no query. Views that take no
  argument keep working.
- `matchRoute(routes, path)` -> `{ view, params, query, path, pattern }`
  or `null`: the matcher on its own, usable outside rendering.
- `parseRoute(path)` -> `{ path, query }`.
- `tests/router-params.test.js` (11 tests).

### Changed
- A path with a query string (`"/done?x=1"`) or a trailing slash
  (`"/about/"`) now resolves to its route (`"/done"`, `"/about"`) instead of
  `"*"`. A route key equal to the whole path, query included, still wins
  first, so existing tables resolve exactly as before.
- The `"*"` view now also receives `{ params: {}, query, path }`.

## [Unreleased, shipped in 0.3.0]

Phase F2 (friedjs half): FriedJS records what makes AIs struggle with it.
Intended as 0.2.1; kept under Unreleased because the version stamp lives in
`fried.js`, which that phase did not touch. No runtime behaviour changed.
See `evolution/EVOLUTION.md` entry 2.

### Added
- `tooling/friction-log.mjs`: validated, capped, append-only writer for
  `evolution/friction.jsonl` (`validateLine`, `appendFriction`,
  `readFriction`), rotation past 2 MB to `friction.<date>.jsonl`, and a CLI
  (`npm run friction`).
- `tooling/friction-digest.mjs`: deterministic ranked markdown report of
  the friction files, with a patcher op health table (`npm run digest`,
  `--write` saves `evolution/digests/<date>.md`).
- Patcher instrumentation: with `FRIED_FRICTION_LOG` set, every exported
  `tooling/patcher.js` op appends one line per call (op, outcome
  ok/failed/nearest-used, error, argument shape; never source or values).
  `FRIED_CONSUMER` / `FRIED_AGENT` name the caller. Unset: unchanged.
- Optional friction line fields `source` and `outcome`.
- Tests: `tests/friction-log.test.js`, `tests/friction-digest.test.js`,
  `tests/patcher-instrumentation.test.js`.

### Changed
- `tooling/patcher.js` exports each op through a thin wrapper (same names,
  arity, return values and errors). Ops called by other ops run unwrapped.

## [0.2.0] - 2026-10-21

Phase F0: make FriedJS trustworthy for AI sessions. No runtime behaviour
changed. See `evolution/EVOLUTION.md` entry 1.

### Added
- `export const VERSION` in `fried.js`.
- `tests/docs-truth.test.js`: fails when `CLAUDE.md`, `README.md`,
  `docs/framework-api.md` or `docs/known-limitations.md` name a path, npm
  script, patcher op or API name that doesn't exist, or when `fried.js` or
  `tooling/patcher.js` export something the API reference never mentions.
- `tests/version.test.js`: `VERSION`, `package.json` and this file agree.
- `tests/run.mjs`: `npm test` now runs `tests/test.js` plus every
  `tests/*.test.js`.
- npm scripts `map` (`tooling/fried-map.mjs`) and `check-keys`
  (`tooling/check-keys.mjs`), which the docs already told readers to run.
- `evolution/`: `EVOLUTION.md` (why FriedJS changes), `baseline.md`
  (stress and benchmark numbers, 25% tolerance), `friction.jsonl` and its
  format in `README.md`.
- API docs for exports that were there but undocumented: `store`,
  `derived`, `render`, the `ref` prop, and `addons/fried-router.js`.

### Changed
- `patcher.js` moved to `tooling/patcher.js` and `test.js` to
  `tests/test.js`, matching what `CLAUDE.md` already said. The root
  `patcher.js` is now a re-export stub, so `import ... from "./patcher.js"`
  still works.
- `create-fried-app.sh` downloads the patcher from `tooling/patcher.js`.

### Fixed
- `npm run build` failed at 0.1.0: its type check (`tsc -p jsconfig.json`)
  reported 17 errors, all in the Node-only `addons/shopify` scripts.
  `jsconfig.json` now excludes `addons/shopify` and `tests`, and
  `build.js` runs the project's own `node_modules/typescript` instead of
  `npx tsc` (which, without typescript installed, fetched an unrelated
  `tsc` package), with a clear "run npm install" error when it's missing.
- Docs: replaced dead `src/`, `scripts/` and missing-test-file paths with
  the real ones, fixed `npm run serve` (no such script) to `npm start`,
  and corrected the claim that the repo has no app in it.

## [0.1.0]

The state before versioning: the merged vnode runtime (`fried.js`), the
AST patcher, `fried-db`, `fried-virtual`, `fried-router`, the Shopify
add-on, `tooling/check-keys.mjs`, `tooling/fried-map.mjs`, `stress.js`,
`benchmark.js` and the telemetry dashboard (`app.js`).
