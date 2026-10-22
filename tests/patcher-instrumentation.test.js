// Patcher friction instrumentation: with FRIED_FRICTION_LOG unset the ops
// behave exactly as before and write nothing; with it set each public call
// appends one compact line with no source text or argument values.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as patcher from "../tooling/patcher.js";
import * as rootPatcher from "../patcher.js";

const { setProp, setPropValue, setChildText, addChild, renameSymbol, patch, validate, PatchError } = patcher;

const MARK = "ZQXSOURCEMARK";
const SRC = `const ${MARK}Count = 0;
const app = ui("div", { key: "saveBtn" }, [ui("h1", { key: "title" }, ["Hello ${MARK}"])]);`;
const VALUE = '"VALUEMARK123"';

const OPS = ["setProp", "setPropValue", "setChildText", "addChild", "addStatementAfter", "removeChild",
  "replaceChild", "removeStatement", "replaceFunction", "addTemplateChild", "setTemplateProp",
  "setTemplatePropValue", "setCssRule", "removeCssRule", "renameSymbol", "addTool", "setToolDescription",
  "setToolInput", "addRosterAgent", "patch", "validate"];

function withLog(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patcher-friction-"));
  const file = path.join(dir, "friction.jsonl");
  const saved = { log: process.env.FRIED_FRICTION_LOG, c: process.env.FRIED_CONSUMER, a: process.env.FRIED_AGENT };
  process.env.FRIED_FRICTION_LOG = file;
  process.env.FRIED_CONSUMER = "friedjs-tests";
  process.env.FRIED_AGENT = "claude-a";
  try {
    fn();
  } finally {
    for (const [k, v] of [["FRIED_FRICTION_LOG", saved.log], ["FRIED_CONSUMER", saved.c], ["FRIED_AGENT", saved.a]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { text, lines: text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : [] };
}

function attempt(fn) {
  try { return { value: fn() }; } catch (err) { return { error: err, message: err.message, isPatchError: err instanceof PatchError }; }
}

// A handful of real calls, ok and failing, run the same way twice.
const CALLS = [
  () => setProp(SRC, "saveBtn", "class", VALUE),
  () => setPropValue(SRC, "saveBtn", "data-x", { a: 1 }),
  () => setChildText(SRC, "title", `Hello ${MARK}`, "Bye"),
  () => addChild(SRC, "saveBtn", `ui("p", { key: "p1" }, ["x"])`),
  () => renameSymbol(SRC, `${MARK}Count`, "total"),
  () => patch(SRC, [{ op: "setProp", args: ["saveBtn", "id", VALUE] }, { op: "setChildText", args: ["title", `Hello ${MARK}`, "Hi"] }]),
  () => validate(SRC),
  () => validate("const x = ;"),
  () => setProp(SRC, "saveBt", "class", VALUE),
  () => patch(SRC, [{ op: "setPorp", args: [] }]),
  // Clears the remembered setProp failure above (not a nearest: suggestion),
  // so later tests start from "ok".
  () => setProp(SRC, "title", "class", VALUE),
];

test("patcher instrumentation: exports keep their names, arity and the root stub re-exports them", () => {
  for (const op of OPS) {
    assert.equal(typeof patcher[op], "function", op);
    assert.equal(patcher[op].name, op);
    assert.equal(rootPatcher[op], patcher[op], `root patcher.js re-exports ${op}`);
  }
  assert.equal(setProp.length, 5);
  assert.equal(validate.length, 1);
  assert.equal(rootPatcher.PatchError, PatchError);
});

test("patcher instrumentation: env unset writes nothing; results and errors are identical with it set", () => {
  delete process.env.FRIED_FRICTION_LOG;
  const plain = CALLS.map(attempt);
  const logged = withLog(() => {
    const again = CALLS.map(attempt);
    assert.deepEqual(again.map((r) => r.value), plain.map((r) => r.value));
    assert.deepEqual(again.map((r) => r.message), plain.map((r) => r.message));
    assert.deepEqual(again.map((r) => r.isPatchError), plain.map((r) => r.isPatchError));
  });
  assert.equal(logged.lines.length, CALLS.length, "one line per public call");
  // Spot-check real outputs, so "identical" isn't identical-but-broken.
  assert.ok(plain[0].value.includes('class: "VALUEMARK123"'));
  assert.ok(plain[2].value.includes('"Bye"'));
  assert.deepEqual(plain[6].value, { ok: true });
  assert.equal(plain[7].value.ok, false);
  assert.match(plain[8].message, /nearest: "saveBtn"/);
});

test("patcher instrumentation: ok and failed lines carry the contract fields and no source text", () => {
  const { text, lines } = withLog(() => {
    setProp(SRC, "saveBtn", "class", VALUE);
    assert.throws(() => setChildText(SRC, "nope", "a", "b"), PatchError);
    validate("const x = ;");
    patch(SRC, [{ op: "setProp", args: ["saveBtn", "id", VALUE] }]);
  });
  assert.equal(lines.length, 4);
  const [ok, failed, invalid, batch] = lines;
  assert.deepEqual(Object.keys(ok), ["at", "consumer", "agent", "want", "tried", "error", "workaround", "file", "op", "source", "outcome"]);
  assert.equal(ok.source, "patcher");
  assert.equal(ok.outcome, "ok");
  assert.equal(ok.op, "setProp");
  assert.equal(ok.tried, "setProp(key,prop,value)");
  assert.equal(ok.error, null);
  assert.equal(ok.file, null);
  assert.equal(ok.consumer, "friedjs-tests");
  assert.equal(ok.agent, "claude-a");
  assert.equal(ok.want, "patcher op");
  assert.ok(!Number.isNaN(Date.parse(ok.at)));
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.op, "setChildText");
  assert.match(failed.error, /nope/);
  assert.equal(invalid.op, "validate");
  assert.equal(invalid.outcome, "failed");
  assert.equal(invalid.tried, "validate()");
  assert.equal(batch.op, "patch");
  assert.equal(batch.tried, "patch(ops:setProp)");
  assert.ok(!text.includes(MARK), "no source text in the log");
  assert.ok(!text.includes("VALUEMARK123"), "no argument values in the log");
  assert.ok(!text.includes("ui(\""), "no source text in the log");
});

test("patcher instrumentation: taking a nearest: suggestion logs nearest-used", () => {
  const { lines } = withLog(() => {
    assert.throws(() => setProp(SRC, "saveBt", "class", VALUE), /nearest: "saveBtn"/);
    setProp(SRC, "saveBtn", "class", VALUE);
    setProp(SRC, "saveBtn", "class", VALUE);
  });
  assert.deepEqual(lines.map((l) => l.outcome), ["failed", "nearest-used", "ok"]);
  assert.match(lines[0].error, /nearest: "saveBtn"/);
});

test("patcher instrumentation: a broken log path never breaks an op", () => {
  const saved = process.env.FRIED_FRICTION_LOG;
  // A path under an existing file can't be created; logging must fail quietly.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patcher-friction-"));
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  process.env.FRIED_FRICTION_LOG = path.join(blocker, "sub", "friction.jsonl");
  try {
    assert.ok(setProp(SRC, "saveBtn", "class", VALUE).includes("VALUEMARK123"));
    assert.throws(() => setProp(SRC, "nope", "class", VALUE), PatchError);
  } finally {
    if (saved === undefined) delete process.env.FRIED_FRICTION_LOG;
    else process.env.FRIED_FRICTION_LOG = saved;
  }
});

test("patcher instrumentation: the server ops log their shape, never tool or agent text", () => {
  const { addTool, setToolDescription, setToolInput, addRosterAgent } = patcher;
  const tools = `const master = { ${MARK}: { description: "d", input: {}, run: () => 1 } };`;
  const { text, lines } = withLog(() => {
    addTool(tools, "master", "ping", `{ description: "VALUEMARK123", input: {}, run: () => 2 }`);
    setToolDescription(tools, MARK, "VALUEMARK123");
    assert.throws(() => setToolInput(tools, MARK, "obj({"), PatchError);
    addRosterAgent(`const agents = [];`, { id: "a", name: "VALUEMARK123", kind: "k" });
  });
  assert.deepEqual(lines.map((l) => l.tried), [
    "addTool(group,toolName,toolDef)",
    "setToolDescription(toolName,description)",
    "setToolInput(toolName,input)",
    "addRosterAgent(agent)",
  ]);
  assert.deepEqual(lines.map((l) => l.outcome), ["ok", "ok", "failed", "ok"]);
  assert.ok(!text.includes(MARK) && !text.includes("VALUEMARK123"));
});
