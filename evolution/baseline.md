# Performance baseline

Recorded on 2026-10-21, on the untouched tree (commit `0864320`), before
any F0 change. Machine: James's Windows 10 box, Node v24.11.0. Each script
was run 4 times; the table shows the median of those runs.

**Tolerance: 25%.** This machine is noisy (the state-churn number moved
23-33 ms between back-to-back runs). A later run counts as a regression
only if a timing is more than 25% slower than the median below, or any
stress assertion fails. Re-record this file (with a note in
`EVOLUTION.md`) when the machine or Node version changes.

## `node stress.js`

| Measure | Baseline |
| --- | --- |
| Assertions | 43 passed, 0 failed |
| Create 10,000 keyed rows from scratch (median of 7) | 4.3 ms (runs: 3.98, 4.42, 5.37, 4.19) |
| Append 1,000 onto 10,000 (median of 7) | 2.2 ms (runs: 2.29, 1.96, 3.03, 2.01) |
| Append as % of create | 44-57% |

## `node benchmark.js`

| Measure | Baseline (ms) | Runs |
| --- | --- | --- |
| 1,000 compound cards (4,000 elements) | 2.27 | 2.33, 2.27, 2.25, 2.27 |
| 5,000 compound cards (20,000 elements) | 8.24 | 8.49, 8.35, 8.06, 8.12 |
| 20,000 compound cards (80,000 elements) | 24.7 | 24.24, 24.62, 24.72, 25.90 |
| 50,000 compound cards (200,000 elements) | 61.6 | 62.10, 62.85, 61.17, 59.85 |
| 100,000 state updates + action dispatches | 25.2 | 32.80, 26.32, 23.19, 24.05 |
| 600 patcher AST cycles (parse + walk + rewrite) | 309.5 | 308.93, 328.73, 309.99, 305.42 |
| Patched source length | 8,933 chars | constant |
| Final AST validity | VALID | constant |

Memory (one run, informational only, not gated): heap used 106.55 MB,
heap total 182.64 MB, RSS 224.00 MB.
