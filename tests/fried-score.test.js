// addons/server/fried-score.js: fresh state, emit and persistence, 'log'
// events, the ring buffer and reload, since/subscribe, debounced atomic
// save, task logs, id and token.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScore, id, token } from "../addons/server/fried-score.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fried-score-"));
const lines = (f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("fried-score: a fresh directory gets logs/, the default state, and emit persists", () => {
  const dir = tmp();
  const s = createScore(dir);
  assert.ok(fs.statSync(path.join(dir, "logs")).isDirectory());
  assert.deepEqual(s.state, { agents: {}, plans: {}, tasks: {}, asks: {}, notes: [], orders: [], seq: 0 });
  assert.equal(fs.existsSync(path.join(dir, "score.json")), false);

  const a = s.emit("plan", "first", { planId: "p1" });
  const b = s.emit("task", "second");
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(a.type, "plan");
  assert.equal(a.text, "first");
  assert.equal(a.planId, "p1");
  assert.ok(!Number.isNaN(Date.parse(a.at)));
  assert.equal(s.state.seq, 2);

  const ev = lines(path.join(dir, "events.jsonl")).map((l) => JSON.parse(l));
  assert.deepEqual(ev, [a, b]);

  s.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "score.json"), "utf8")).seq, 2);
  assert.equal(fs.existsSync(path.join(dir, "score.json.tmp")), false);
});

test("fried-score: extra spreads last, so it can override fields", () => {
  const s = createScore(tmp());
  const ev = s.emit("task", "text", { type: "custom", text: "other" });
  assert.equal(ev.type, "custom");
  assert.equal(ev.text, "other");
  s.flush();
});

test("fried-score: 'log' events reach the ring and subscribers but not events.jsonl", () => {
  const dir = tmp();
  const s = createScore(dir);
  const seen = [];
  s.subscribe((e) => seen.push(e.type));
  s.emit("log", "lane line");
  s.emit("task", "real");
  assert.deepEqual(seen, ["log", "task"]);
  assert.deepEqual(s.since(0).map((e) => e.type), ["log", "task"]);
  const ev = lines(path.join(dir, "events.jsonl")).map((l) => JSON.parse(l));
  assert.deepEqual(ev.map((e) => e.type), ["task"]);
  s.flush();
});

test("fried-score: skipLogTypes is configurable", () => {
  const dir = tmp();
  const s = createScore({ dir, skipLogTypes: ["noise"] });
  s.emit("noise", "x");
  s.emit("log", "y");
  assert.deepEqual(lines(path.join(dir, "events.jsonl")).map((l) => JSON.parse(l).type), ["log"]);
  s.flush();
});

test("fried-score: the ring caps at ringSize and reloads on restart, skipping corrupt lines", () => {
  const dir = tmp();
  const s = createScore({ dir, ringSize: 5 });
  for (let i = 0; i < 8; i++) s.emit("task", "t" + i);
  assert.deepEqual(s.since(0).map((e) => e.seq), [4, 5, 6, 7, 8]);
  s.flush();

  // A truncated tail line and a junk line in the middle.
  const f = path.join(dir, "events.jsonl");
  const all = lines(f);
  all.splice(6, 0, "not json");
  fs.writeFileSync(f, all.join("\n") + "\n" + '{"seq":99,"at"');

  const r = createScore({ dir, ringSize: 5 });
  // The last 5 lines are seq 6, junk, seq 7, seq 8, the truncated line.
  assert.deepEqual(r.since(0).map((e) => e.seq), [6, 7, 8]);
  assert.equal(r.state.seq, 8);
  assert.equal(r.emit("task", "after").seq, 9);
  r.flush();
});

test("fried-score: the default ring size is 3000", () => {
  const dir = tmp();
  const s = createScore(dir);
  for (let i = 0; i < 3005; i++) s.emit("log", "l");
  const ring = s.since(0);
  assert.equal(ring.length, 3000);
  assert.equal(ring[0].seq, 6);
  s.flush();

  const f = path.join(dir, "events.jsonl");
  fs.writeFileSync(f, Array.from({ length: 3010 }, (_, i) => JSON.stringify({ seq: i + 1 })).join("\n") + "\n");
  const r = createScore(dir);
  assert.equal(r.since(0).length, 3000);
  assert.equal(r.since(0)[0].seq, 11);
});

test("fried-score: since(seq) returns only later events; unsubscribe stops delivery", () => {
  const s = createScore(tmp());
  const got = [];
  const off = s.subscribe((e) => got.push(e.seq));
  s.emit("task", "a");
  s.emit("task", "b");
  s.emit("task", "c");
  assert.deepEqual(s.since(1).map((e) => e.seq), [2, 3]);
  assert.deepEqual(s.since(3), []);
  assert.equal(off(), true);
  s.emit("task", "d");
  assert.deepEqual(got, [1, 2, 3]);
  s.flush();
});

test("fried-score: save() debounces into one atomic write", async () => {
  const dir = tmp();
  const s = createScore({ dir, debounceMs: 30 });
  const file = path.join(dir, "score.json");
  s.state.plans.p1 = { title: "one" };
  s.save();
  s.state.plans.p1.title = "two";
  s.save();
  assert.equal(fs.existsSync(file), false);
  await wait(80);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).plans.p1.title, "two");
  assert.equal(fs.existsSync(file + ".tmp"), false);
  assert.match(fs.readFileSync(file, "utf8"), /\n  "agents"/);

  // A restart reads the saved state back.
  const r = createScore(dir);
  assert.equal(r.state.plans.p1.title, "two");
});

test("fried-score: flush() cancels a pending save", async () => {
  const dir = tmp();
  const s = createScore({ dir, debounceMs: 30 });
  const file = path.join(dir, "score.json");
  s.save();
  s.flush();
  fs.unlinkSync(file);
  await wait(60);
  assert.equal(fs.existsSync(file), false);
});

test("fried-score: taskLog appends and readTaskLog tails", () => {
  const dir = tmp();
  const s = createScore(dir);
  assert.equal(s.readTaskLog("t1"), "");
  for (let i = 1; i <= 5; i++) s.taskLog("t1", "line " + i);
  assert.equal(fs.readFileSync(path.join(dir, "logs", "t1.log"), "utf8"), "line 1\nline 2\nline 3\nline 4\nline 5\n");
  // The trailing newline leaves an empty last element, as in the composer.
  assert.equal(s.readTaskLog("t1", 3), "line 4\nline 5\n");
  assert.equal(s.readTaskLog("t1").split("\n").length, 6);
});

test("fried-score: options rename files and supply the initial state", () => {
  const dir = tmp();
  const s = createScore({
    dir,
    scoreFile: "state.json",
    eventsFile: "ev.jsonl",
    logsDir: "lanes",
    initialState: () => ({ items: [] }),
  });
  assert.deepEqual(s.state, { items: [], seq: 0 });
  s.emit("item", "x");
  s.taskLog("a", "hi");
  s.flush();
  assert.ok(fs.existsSync(path.join(dir, "state.json")));
  assert.ok(fs.existsSync(path.join(dir, "ev.jsonl")));
  assert.ok(fs.existsSync(path.join(dir, "lanes", "a.log")));
  assert.equal(s.readTaskLog("a"), "hi\n");
});

test("fried-score: id(prefix) and token() formats", () => {
  const a = id("plan");
  assert.match(a, /^plan-[0-9a-z]+[0-9a-f]{4}$/);
  const stamp = Date.now().toString(36);
  assert.equal(a.length, "plan-".length + stamp.length + 4);

  const t = token();
  assert.match(t, /^[0-9a-f]{48}$/);
  assert.notEqual(token(), t);
  assert.match(token(8), /^[0-9a-f]{16}$/);
});
