# Changelog

All notable changes to FriedJS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). The top version must
equal `package.json`'s `version` and `fried.js`'s `VERSION` export
(`tests/version.test.js` checks it). Why each change was made is in
`evolution/EVOLUTION.md`.

## [Unreleased]

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
- Docs: replaced dead `src/`, `scripts/` and missing-test-file paths with
  the real ones, fixed `npm run serve` (no such script) to `npm start`,
  and corrected the claim that the repo has no app in it.

## [0.1.0]

The state before versioning: the merged vnode runtime (`fried.js`), the
AST patcher, `fried-db`, `fried-virtual`, `fried-router`, the Shopify
add-on, `tooling/check-keys.mjs`, `tooling/fried-map.mjs`, `stress.js`,
`benchmark.js` and the telemetry dashboard (`app.js`).
