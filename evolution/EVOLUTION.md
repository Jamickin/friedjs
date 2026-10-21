# How FriedJS evolves

Every change to FriedJS goes around one loop, and leaves an entry here.

1. **Friction.** An AI session or person using FriedJS hits something in the way. They append a line to `evolution/friction.jsonl` (format in `evolution/README.md`).
2. **Digest.** Repeated or serious friction is grouped by op and goal into one concrete problem, with the lines that prove it.
3. **Plan.** A change is proposed against that evidence: additive by default. Changing or removing behaviour needs a deprecation entry in `docs/known-limitations.md` and a migration patch for every consumer.
4. **Gates.** It ships only when all pass: `npm test` (including `tests/docs-truth.test.js`), `node stress.js` and `node benchmark.js` within 25% of `evolution/baseline.md`, every consumer's tests, this entry, and a verification note in `docs/MERGE.md`.
5. **Sync.** The pinned FriedJS is copied into each consumer (`fried sync <consumer>`), its version recorded, its tests run, and rolled back on failure.
6. Evidence over taste: an entry without friction evidence is not a reason to change anything.

## Entry format

```
## <id>. <title>
- id: <number, never reused>
- date: <YYYY-MM-DD>
- friction evidence: <friction.jsonl lines, or the defect found, with exact paths/errors>
- change: <what changed, files touched>
- tests: <tests added or changed>
- gates run: <each gate and its result, numbers vs baseline.md>
- consumers migrated: <each consumer and how, or "none needed: no behaviour change">
```

## 1. Docs match the repo (phase F0)
- id: 1
- date: 2026-10-21
- friction evidence: a fresh AI session following `CLAUDE.md` hit dead ends. Found by `tests/docs-truth.test.js` run against the untouched docs:
  - `CLAUDE.md` named `tooling/patcher.js` (it was `patcher.js` at the root), `tests/` with `merge-regressions.test.js` and `browser-verify.mjs` (neither exists), `npm run map` and `npm run check-keys` (no such scripts), and `npm run serve` on port 8080 (no such script; the server is `npm start` on 3000). It also said the repo has no app in it (`app.js` is the dashboard).
  - `docs/framework-api.md` named `src/patcher.js`, `scripts/fried-map.mjs` (3 times), and `tests/patcher.test.js`, `tests/realistic.test.js`, `tests/fried-map.test.js`, `tests/diagnostics.test.js` (none exist), and never mentioned the exports `store`, `derived`, `render` or the `ref` prop.
  - `docs/known-limitations.md` named `src/fried.js`, `src/fried-virtual.js`, `scripts/check-keys.mjs` (2) and `scripts/fried-map.mjs` (4).
  - `test.js` sat at the root, and `npm test` ran only that one file.
- change: moved `patcher.js` -> `tooling/patcher.js` (root `patcher.js` is now a re-export stub) and `test.js` -> `tests/test.js`; `npm test` runs `tests/run.mjs` (`tests/test.js` plus every `tests/*.test.js`); added npm scripts `map` and `check-keys`; fixed every dead path and script in the docs, documented `store`/`derived`/`render`/`ref`/`VERSION`/`addons/fried-router.js`, and marked the pre-merge verification scripts in `docs/known-limitations.md` as historical; `create-fried-app.sh` downloads `tooling/patcher.js`; added `VERSION` to `fried.js`, `CHANGELOG.md`, version 0.2.0; created this folder and `evolution/baseline.md`.
- tests: `tests/docs-truth.test.js` (paths, npm scripts, patcher ops, API exports, undocumented exports), `tests/version.test.js`.
- gates run: `npm test` passes; `node stress.js` 43/43 and `node benchmark.js` within 25% of `evolution/baseline.md` (baseline recorded before any change; numbers in the F0 note in `docs/MERGE.md`). No consumer tests run: no behaviour changed.
- consumers migrated: none needed: no behaviour change. The root `patcher.js` stub keeps `./patcher.js` imports (e.g. `benchmark.js`) working.
