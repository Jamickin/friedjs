// tooling/friction-log.mjs: line validation and caps, append, rotation,
// never-throws, readFriction and the CLI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateLine, appendFriction, readFriction, CAPS } from "../tooling/friction-log.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "tooling", "friction-log.mjs");
const NOW = new Date("2026-10-21T12:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "friction-log-"));
const base = { want: "add a class to every row", tried: "setProp(key,prop,value)" };

test("friction-log: a minimal line gets defaults, a fixed key order and the given time", () => {
  const r = validateLine(base, { now: NOW });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(Object.keys(r.value), ["at", "consumer", "agent", "want", "tried", "error", "workaround", "file", "op"]);
  assert.equal(r.value.at, "2026-10-21T12:00:00.000Z");
  assert.equal(r.value.consumer, "unknown");
  assert.equal(r.value.agent, "unknown");
  assert.equal(r.value.error, null);
  assert.equal(r.line, JSON.stringify(r.value));
});

test("friction-log: want and tried are required, wrong types and bad times are rejected", () => {
  assert.equal(validateLine({ want: "x" }).ok, false);
  assert.match(validateLine({ tried: "x" }).errors.join(), /want: required/);
  assert.match(validateLine({ ...base, error: 42 }).errors.join(), /error: must be a string or null/);
  assert.match(validateLine({ ...base, at: "yesterday-ish" }).errors.join(), /at:/);
  assert.equal(validateLine(null).ok, false);
  assert.equal(validateLine([1, 2]).ok, false);
  assert.equal(validateLine({ ...base, at: "2026-10-21T19:30:00Z" }).value.at, "2026-10-21T19:30:00.000Z");
});

test("friction-log: caps cut every text field to its length", () => {
  const long = (n) => "a".repeat(n + 50);
  const r = validateLine({
    want: long(CAPS.want), tried: long(CAPS.tried), workaround: long(CAPS.workaround),
    error: long(CAPS.error), op: long(CAPS.op), consumer: long(CAPS.consumer), agent: long(CAPS.agent),
  });
  assert.equal(r.ok, true);
  for (const f of ["want", "tried", "workaround", "error", "op", "consumer", "agent"]) {
    assert.equal(r.value[f].length, CAPS[f], f);
  }
  assert.deepEqual(CAPS, { want: 300, tried: 300, workaround: 300, error: 500, file: 200, op: 80, consumer: 60, agent: 60 });
});

test("friction-log: control characters become spaces, obvious secrets are redacted", () => {
  const r = validateLine({ ...base, error: "line one\nline two\u0007\u001b[31m", workaround: "used sk-abcdefghijklmnopqrstu0123 then" });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.line, /\\n|\\u0007|\\u001b/);
  assert.equal(r.value.error, "line one line two [31m");
  assert.equal(r.value.workaround, "used [redacted] then");
});

test("friction-log: file must be a path and keeps its last 200 chars", () => {
  assert.equal(validateLine({ ...base, file: "ui/app.js" }).value.file, "ui/app.js");
  assert.equal(validateLine({ ...base, file: "C:\\repo\\ui\\app.js" }).ok, true);
  const bad = validateLine({ ...base, file: 'const app = ui("div", { key: "x" }, []);' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /file: must be a path/);
  const longPath = "deep/".repeat(60) + "app.js";
  const cut = validateLine({ ...base, file: longPath }).value.file;
  assert.equal(cut.length, 200);
  assert.ok(cut.endsWith("/app.js"));
});

test("friction-log: source and outcome enums", () => {
  assert.equal(validateLine({ ...base, source: "agent" }).value.source, "agent");
  assert.equal(validateLine({ ...base, source: "patcher", outcome: "nearest-used" }).value.outcome, "nearest-used");
  assert.equal(validateLine({ ...base, source: "robot" }).ok, false);
  assert.equal(validateLine({ ...base, source: "patcher", outcome: "meh" }).ok, false);
  assert.match(validateLine({ ...base, source: "agent", outcome: "ok" }).errors.join(), /only patcher lines/);
  // Unknown fields are dropped, never copied through.
  assert.equal("contents" in validateLine({ ...base, contents: "whole file" }).value, false);
});

test("friction-log: appendFriction does nothing when no file is configured", () => {
  const saved = process.env.FRIED_FRICTION_LOG;
  delete process.env.FRIED_FRICTION_LOG;
  try {
    assert.deepEqual(appendFriction(base), { ok: true, skipped: true });
  } finally {
    if (saved !== undefined) process.env.FRIED_FRICTION_LOG = saved;
  }
});

test("friction-log: appendFriction writes one line per call, creating the folder", () => {
  const dir = tmp();
  const file = path.join(dir, "nested", "friction.jsonl");
  assert.equal(appendFriction(base, { file, now: NOW }).ok, true);
  assert.equal(appendFriction({ ...base, op: "setProp" }, { file, now: NOW }).ok, true);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"));
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].op, "setProp");
});

test("friction-log: an invalid line is refused and nothing is written", () => {
  const dir = tmp();
  const file = path.join(dir, "friction.jsonl");
  const r = appendFriction({ want: "x" }, { file });
  assert.equal(r.ok, false);
  assert.match(r.error, /tried: required/);
  assert.equal(fs.existsSync(file), false);
});

test("friction-log: appendFriction never throws", () => {
  const broken = {
    mkdirSync() {}, statSync() { throw new Error("ENOENT"); }, existsSync: () => false,
    renameSync() { throw new Error("EPERM"); }, appendFileSync() { throw new Error("disk full"); },
  };
  assert.deepEqual(appendFriction(base, { file: "x/friction.jsonl", fs: broken }), { ok: false, error: "disk full" });
  assert.equal(appendFriction(undefined, { file: "x/friction.jsonl" }).ok, false);
  assert.equal(appendFriction(base, { file: "x/friction.jsonl", now: () => { throw new Error("clock"); } }).ok, false);
});

test("friction-log: rotates past the size limit to friction.<date>[-n].jsonl and readFriction reads them all", () => {
  const dir = tmp();
  const file = path.join(dir, "friction.jsonl");
  const opts = { file, now: NOW, rotateBytes: 100 };
  for (let i = 0; i < 5; i++) appendFriction({ ...base, op: `op${i}` }, opts);
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ["friction.2026-10-21-1.jsonl", "friction.2026-10-21-2.jsonl", "friction.2026-10-21-3.jsonl", "friction.2026-10-21.jsonl", "friction.jsonl"]);
  fs.appendFileSync(file, "not json\n[1,2]\n\n");
  const ops = readFriction(dir).map((l) => l.op);
  assert.deepEqual(ops, ["op0", "op1", "op2", "op3", "op4"]);
  assert.deepEqual(readFriction(path.join(dir, "missing")), []);
});

test("friction-log: CLI appends to FRIED_FRICTION_LOG and rejects a bad line", () => {
  const dir = tmp();
  const file = path.join(dir, "friction.jsonl");
  const env = { ...process.env, FRIED_FRICTION_LOG: file };
  const ok = spawnSync(process.execPath, [CLI, "--want", "match /plans/:id", "--tried", "router() table",
    "--error", "fried-router matches exact paths only", "--file", "dashboard/lib/routes.js", "--op", "router",
    "--consumer", "orchestra-dashboard", "--agent", "codex"], { env, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(line.source, "agent");
  assert.equal(line.agent, "codex");
  assert.equal(line.file, "dashboard/lib/routes.js");

  const bad = spawnSync(process.execPath, [CLI, "--want", "only a want"], { env, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /tried: required/);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 1);

  const unknown = spawnSync(process.execPath, [CLI, "--wat", "x"], { env, encoding: "utf8" });
  assert.equal(unknown.status, 2);
});
