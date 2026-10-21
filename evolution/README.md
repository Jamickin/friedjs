# evolution/

Why FriedJS changes, and the evidence behind each change.

- `EVOLUTION.md` -- the loop and one entry per change.
- `baseline.md` -- the stress and benchmark numbers every change is
  compared against (25% tolerance).
- `friction.jsonl` -- raw friction: one JSON object per line, appended
  whenever an AI session (or a person) using FriedJS hits something that
  got in the way. It starts empty. Never rewrite or reorder old lines;
  only append.

## `friction.jsonl` line format

One object per line, no trailing commas, UTF-8. Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `at` | string | ISO 8601 time it happened, e.g. `"2026-10-21T19:30:00Z"` |
| `consumer` | string | Which project hit it, e.g. `"friedjs"`, `"brain-ui"`, `"orchestra-dashboard"` |
| `agent` | string | Who hit it, e.g. `"claude-b"`, `"codex"`, `"james"` |
| `want` | string | What they were trying to do, in one sentence |
| `tried` | string | What they actually ran or wrote |
| `error` | string or null | The exact error or wrong result, or `null` if it just felt awkward |
| `workaround` | string or null | What they did instead, or `null` if none |
| `file` | string or null | The file they were working on (repo-relative) |
| `op` | string or null | The FriedJS API or patcher op involved, e.g. `"setProp"`, `"mount"` |

Example (one line in the file):

```json
{"at":"2026-10-21T19:30:00Z","consumer":"brain-ui","agent":"claude-b","want":"add a class to every row","tried":"setProp(src, \"row\", \"class\", \"bold\")","error":"output had an unquoted identifier","workaround":"passed JSON.stringify(\"bold\")","file":"ui/app.js","op":"setProp"}
```

Two optional fields (added in phase F2):

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | `"agent"` or `"patcher"` | `"agent"`: reported by a person or AI (the composer's `fried_friction` tool, or the CLI below). `"patcher"`: logged by the patcher instrumentation. A line without it counts as `"agent"`. |
| `outcome` | `"ok"`, `"failed"` or `"nearest-used"` | Patcher lines only: see below. |

### Rules

- Caps: `want`, `tried`, `workaround` 300 chars; `error` 500; `file` 200
  (the *last* 200, so the file name survives); `op` 80; `consumer`,
  `agent` 60. Longer text is cut, not rejected.
- Control characters become spaces (one line stays one line). Obvious
  credentials (`sk-...`, `ghp_...`, `Bearer ...`) are replaced with
  `[redacted]`, as a backstop: never log source text, file contents,
  tokens or secrets in the first place.
- `file` must be a path (path characters only), never contents.
  `want` and `tried` are required; `at` defaults to now; a missing
  `consumer` / `agent` becomes `"unknown"`. Unknown fields are dropped.
- Append-only. When the file is already over 2 MB, the writer renames
  it to `friction.<YYYY-MM-DD>.jsonl` (then `-1`, `-2`, ... if that's
  taken) next to it and starts a fresh `friction.jsonl`. Old lines are
  never rewritten. Readers (the digest) read the rotated files too.

## Writing a line

Always through `tooling/friction-log.mjs`, which validates, caps and
appends, and never throws:

```
node tooling/friction-log.mjs --want "match /plans/:id" --tried "router() table" \
  --error "fried-router matches exact paths only" --workaround "own matcher" \
  --file dashboard/lib/routes.js --op router --consumer orchestra-dashboard --agent codex
```

(`npm run friction -- ...` is the same.) Optional `--source agent|patcher`
(default `agent`). It appends to `$FRIED_FRICTION_LOG` if set, else to
this folder's `friction.jsonl`. From code: `appendFriction(obj, { file })`,
`validateLine(obj)`, `readFriction(dir)`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `FRIED_FRICTION_LOG` | Path of the friction file. When set, every exported `tooling/patcher.js` op appends one line per call (below). Unset: the patcher writes nothing and behaves exactly as before. |
| `FRIED_CONSUMER` | `consumer` on patcher lines (default `"unknown"`). |
| `FRIED_AGENT` | `agent` on patcher lines (default `"unknown"`). |

### Patcher lines

One line per public call (`patch` is one line, not one per step):
`{"source":"patcher","op":"setProp","outcome":"failed","want":"patcher op",
"tried":"setProp(key,prop,value)","error":"no ui(...) call found with key
\"saveBt\" -- nearest: \"saveBtn\"","file":null,...}`. `tried` is the op name plus the
parameter names of the arguments passed, never their values or the
source. `outcome`:

- `ok`: returned normally.
- `failed`: threw (the `PatchError` message, first 500 chars, is `error`),
  or `validate` returned `ok: false`.
- `nearest-used`: best effort. Succeeded, and its 2nd or 3rd argument is
  one of the `nearest:` suggestions from the last failed call of the same
  op in the same process, within 60 s: the suggestion was taken. Only the
  last failure per op is remembered, in memory.

## The digest

```
node tooling/friction-digest.mjs [--dir evolution] [--since 7d|YYYY-MM-DD] [--top 10] [--write]
```

Deterministic, no AI. Groups agent lines by (`op`, normalised `error`:
lower-cased, quoted strings, paths and digits stripped) and patcher lines
by (`op`, `outcome`; `ok` lines only feed the health table). Score: 10 per
line + 5 per distinct agent + up to 7 for recency (7 minus days since last
seen) + 20 x the op's patcher failure rate (failed / all calls). Ties
break on count, then last seen, then the group key. Prints a markdown
ranked table and a "patcher op health" table; `--write` saves it to
`digests/<YYYY-MM-DD>.md` in the folder. Its top groups are the "friction
evidence" of the next `EVOLUTION.md` entry.
