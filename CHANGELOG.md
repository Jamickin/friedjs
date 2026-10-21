# Changelog

All notable changes to FriedJS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). The top version must
equal `package.json`'s `version` and `fried.js`'s `VERSION` export
(`tests/version.test.js` checks it). Why each change was made is in
`evolution/EVOLUTION.md`.

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
