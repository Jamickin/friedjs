// tooling/friction-digest.mjs: grouping, ranking, rendering, --since and
// --write, on a fixed fixture so the output is deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rank, render, normaliseError, parseSince } from "../tooling/friction-digest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "tooling", "friction-digest.mjs");
const NOW = new Date("2026-10-21T12:00:00Z");

const agent = (at, who, op, error, want = "match /plans/:id") =>
  ({ at, consumer: "orchestra-dashboard", agent: who, want, tried: "router()", error, workaround: "own matcher", file: null, op, source: "agent" });
const patcherLine = (at, op, outcome, error = null) =>
  ({ at, consumer: "c", agent: "codex", want: "patcher op", tried: `${op}(key)`, error, workaround: null, file: null, op, source: "patcher", outcome });

const FIXTURE = [
  agent("2026-10-20T10:00:00Z", "codex", "router", "fried-router matches exact paths only"),
  agent("2026-10-21T09:00:00Z", "claude-b", "router", "Fried-router matches exact paths only"),
  // No source field: still an agent line. Same normalised error as below.
  { ...agent("2026-10-19T10:00:00Z", "gemini", "setProp", 'no ui() call with key "saveBt" at line 12', "rename a button"), source: undefined },
  agent("2026-10-19T11:00:00Z", "gemini", "setProp", 'no ui() call with key "title" at line 40', "rename a heading"),
  agent("2026-10-01T10:00:00Z", "james", "mount", null, "mount twice"),
  patcherLine("2026-10-21T08:00:00Z", "setProp", "ok"),
  patcherLine("2026-10-21T08:01:00Z", "setProp", "failed", 'no ui() call with key "x" -- nearest: "y"'),
  patcherLine("2026-10-21T08:02:00Z", "setProp", "nearest-used"),
  patcherLine("2026-10-21T08:03:00Z", "setProp", "ok"),
  patcherLine("2026-10-21T08:04:00Z", "validate", "ok"),
];

test("friction-digest: normaliseError drops case, quotes, paths and digits", () => {
  assert.equal(normaliseError('No key "saveBt" at line 12 in ui/app.js'), normaliseError("no key 'title' at line 40 in src/other.mjs"));
  assert.equal(normaliseError(null), "(no error)");
  assert.equal(normaliseError("Fried-router matches exact paths only"), "fried-router matches exact paths only");
});

test("friction-digest: groups agent lines by (op, normalised error) and patcher lines by (op, outcome)", () => {
  const r = rank(FIXTURE, { now: NOW });
  assert.equal(r.total, FIXTURE.length);
  const byKey = Object.fromEntries(r.groups.map((g) => [g.key, g]));
  const router = byKey["agent|router|fried-router matches exact paths only"];
  assert.equal(router.count, 2);
  assert.deepEqual(router.agents, ["claude-b", "codex"]);
  assert.equal(router.lastSeen, "2026-10-21T09:00:00.000Z");
  assert.equal(router.example.error, "Fried-router matches exact paths only");
  const setProp = Object.values(byKey).find((g) => g.kind === "agent" && g.op === "setProp");
  assert.equal(setProp.count, 2);
  assert.equal(byKey["patcher|setProp|failed"].count, 1);
  assert.equal(byKey["patcher|setProp|nearest-used"].count, 1);
  assert.ok(!r.groups.some((g) => g.key.endsWith("|ok")), "ok patcher lines are not friction");
  assert.deepEqual(r.health.map((h) => [h.op, h.calls, h.ok, h.failed, h.nearestUsed, h.failureRate]),
    [["setProp", 4, 2, 1, 1, 0.25], ["validate", 1, 1, 0, 0, 0]]);
});

test("friction-digest: ranking is deterministic and ties have a stable order", () => {
  const a = rank(FIXTURE, { now: NOW });
  const b = rank([...FIXTURE].reverse(), { now: NOW });
  assert.deepEqual(a, b);
  assert.deepEqual(a.groups.map((g) => g.key), [
    "agent|router|fried-router matches exact paths only",
    "agent|setProp|no ui call with key at line",
    // Same score and count as "failed"; seen later, so it ranks first.
    "patcher|setProp|nearest-used",
    "patcher|setProp|failed",
    "agent|mount|(no error)",
  ]);
  assert.deepEqual(a.groups.map((g) => g.rank), [1, 2, 3, 4, 5]);
  // Two identical-score groups: order falls back to last seen, then key.
  const tie = rank([agent("2026-10-21T00:00:00Z", "x", "b", "e1"), agent("2026-10-21T00:00:00Z", "x", "a", "e1")], { now: NOW });
  assert.deepEqual(tie.groups.map((g) => g.op), ["a", "b"]);
  assert.equal(rank(FIXTURE, { now: NOW, top: 2 }).groups.length, 2);
});

test("friction-digest: --since filters old lines", () => {
  assert.equal(parseSince("7d", NOW).toISOString(), "2026-10-14T12:00:00.000Z");
  assert.equal(parseSince("2026-10-20", NOW).toISOString(), "2026-10-20T00:00:00.000Z");
  assert.equal(parseSince(undefined, NOW), null);
  assert.throws(() => parseSince("last week", NOW), /--since/);
  const r = rank(FIXTURE, { now: NOW, since: parseSince("7d", NOW) });
  assert.ok(!r.groups.some((g) => g.op === "mount"));
  assert.equal(r.total, FIXTURE.length - 1);
});

test("friction-digest: render prints the ranked table and the patcher health table", () => {
  const md = render(rank(FIXTURE, { now: NOW }));
  assert.equal(md, render(rank(FIXTURE, { now: NOW })));
  assert.match(md, /^# Friction digest 2026-10-21/);
  assert.match(md, /\| Rank \| What \| Op \| Count \| Agents \| Last seen \| Example want \| Example error \| Example workaround \|/);
  assert.match(md, /\| 1 \| match \/plans\/:id \| router \| 2 \| claude-b, codex \| 2026-10-21 \|/);
  assert.match(md, /## Patcher op health/);
  assert.match(md, /\| setProp \| 4 \| 2 \| 1 \| 1 \| 25\.0% \|/);
  const empty = render(rank([], { now: NOW }));
  assert.match(empty, /No friction recorded/);
  assert.match(empty, /No patcher lines/);
  // Pipes and newlines in a cell don't break the table.
  const piped = render(rank([agent("2026-10-21T00:00:00Z", "x", "op", "a | b\nc")], { now: NOW }));
  assert.match(piped, /a \\\| b c/);
});

test("friction-digest: CLI reads a folder and --write saves digests/<date>.md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friction-digest-"));
  fs.writeFileSync(path.join(dir, "friction.2026-10-01.jsonl"), JSON.stringify(FIXTURE[4]) + "\n");
  fs.writeFileSync(path.join(dir, "friction.jsonl"), FIXTURE.slice(0, 4).map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
  const r = spawnSync(process.execPath, [CLI, "--dir", dir, "--top", "3", "--write"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /5 line\(s\)/);
  const written = fs.readdirSync(path.join(dir, "digests"));
  assert.equal(written.length, 1);
  assert.match(written[0], /^\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(fs.readFileSync(path.join(dir, "digests", written[0]), "utf8"), r.stdout);
  const bad = spawnSync(process.execPath, [CLI, "--since", "soon"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});
