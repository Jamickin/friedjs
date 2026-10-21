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

A later phase reads this file, groups the lines by `op` and `want`, and
turns repeated friction into the "friction evidence" of an
`EVOLUTION.md` entry.
