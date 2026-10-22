// tooling/patcher.js server ops: addTool, setToolDescription, setToolInput
// (tools addressed by name and group) and addRosterAgent (JSON and JS rosters).
import test from "node:test";
import assert from "node:assert/strict";
import { addTool, setToolDescription, setToolInput, addRosterAgent, patch, validate, PatchError } from "../tooling/patcher.js";

// Shaped like Orchestra's composer/tools.mjs: two role groups inside a
// factory, one tool name (fried_friction) in both.
const TOOLS = `import { createToolRegistry, str, obj } from "./vendor/fried-tools.js";

export function createTools({ store }) {
  const frictionArgs = obj({ want: str("What you wanted") }, ["want"]);
  const master = {
    fried_friction: {
      description: "Report FriedJS friction (master).",
      input: frictionArgs,
      run: async (a) => ({ ok: true, a }),
    },
    roll_call: {
      description: "Check every musician.",
      input: obj({}),
      run: async () => store.state.agents,
    },
  };
  const musician = {
    fried_friction: {
      description: "Report FriedJS friction (musician).",
      input: frictionArgs,
      run: async (a) => ({ ok: true, a }),
    },
    my_task: {
      description: "Your instructions.",
      input: obj({}),
      run: async (_, { task }) => task,
    },
  };
  return createToolRegistry("orchestra", { master, musician });
}
`;

const DEF = `{ description: "Reply pong.", input: obj({}), run: async () => "pong" }`;

function load(source) {
  assert.deepEqual(validate(source), { ok: true });
  return source;
}

test("addTool: appends to the named group, one per line, before the closing brace", () => {
  const out = load(addTool(TOOLS, "musician", "ping", DEF));
  assert.ok(out.includes(`    },\n    ping: ${DEF},\n  };\n  return createToolRegistry`));
  assert.equal(out.split("ping:").length, 2, "added once, to musician only");
  const master = load(addTool(TOOLS, "master", "status", DEF));
  assert.ok(master.indexOf("status:") < master.indexOf("const musician"));
});

test("addTool: a non-identifier name is quoted, an inline flat registry works, an empty registered group works", () => {
  const flat = `const r = createToolRegistry("mini", { a: { description: "A", input: {}, run: () => 1 } });`;
  const out = load(addTool(flat, "mini", "b-tool", DEF));
  assert.ok(out.includes(`run: () => 1 }, "b-tool": ${DEF} }`));
  const empty = `const master = {};\nconst r = createToolRegistry("x", { master });`;
  assert.ok(load(addTool(empty, "master", "ping", DEF)).includes(`const master = {ping: ${DEF}};`));
});

test("addTool: refuses a duplicate, a bad definition and a typo'd group", () => {
  assert.throws(() => addTool(TOOLS, "master", "roll_call", DEF), /tool "roll_call" already exists in "master" -- use setToolDescription/);
  assert.throws(() => addTool(TOOLS, "master", "x", `{ description: "d", run: () => 1 }`), /must be an object literal with description, input, and run properties/);
  assert.throws(() => addTool(TOOLS, "master", "x", `{ description: "d", input: {}, run: `), /must be an object literal/);
  assert.throws(() => addTool(TOOLS, "master", "x", `foo()`), /must be an object literal/);
  assert.throws(() => addTool(TOOLS, "mastr", "x", DEF), /no tool registry or group "mastr" found -- nearest: "master"/);
  assert.throws(() => addTool(TOOLS, "mastr", "x", DEF), PatchError);
});

test("setToolDescription: a unique tool needs no group; the string is quoted for you", () => {
  const out = load(setToolDescription(TOOLS, "roll_call", 'Check "everyone".'));
  assert.ok(out.includes(`description: "Check \\"everyone\\".",`));
  assert.ok(out.includes('"Your instructions."'));
});

test("setToolDescription: a tool in two groups is refused without withinGroup, edited with it", () => {
  assert.throws(
    () => setToolDescription(TOOLS, "fried_friction", "New."),
    /tool "fried_friction" exists in multiple groups \(master, musician\) -- pass withinGroup as the 4th argument/,
  );
  const out = load(setToolDescription(TOOLS, "fried_friction", "Musician only.", "musician"));
  assert.ok(out.includes('"Report FriedJS friction (master)."'));
  assert.ok(out.includes('description: "Musician only."'));
  assert.ok(!out.includes("(musician)."));
});

test("setToolDescription: nearest suggestions and bad arguments", () => {
  assert.throws(() => setToolDescription(TOOLS, "roll_cal", "x"), /no tool named "roll_cal" found -- nearest: "roll_call"/);
  assert.throws(() => setToolDescription(TOOLS, "roll_call", "x", "musician"), /no tool named "roll_call" found in "musician"/);
  assert.throws(() => setToolDescription(TOOLS, "my_task", "x", "musican"), /no tool registry or group "musican" found -- nearest: "musician"/);
  assert.throws(() => setToolDescription(TOOLS, "roll_call", ""), /must be a non-empty string, got string/);
  assert.throws(() => setToolDescription(TOOLS, "roll_call", 3), /must be a non-empty string, got number/);
});

test("setToolInput: replaces the input expression; refuses bad syntax and typo'd names", () => {
  const input = `obj({ id: str("Task id") }, ["id"])`;
  const out = load(setToolInput(TOOLS, "my_task", input));
  assert.ok(out.includes(`description: "Your instructions.",\n      input: ${input},`));
  const both = load(setToolInput(TOOLS, "fried_friction", "{ type: 'object', properties: {} }", "master"));
  assert.equal(both.split("input: frictionArgs").length, 2, "only master's changed");
  assert.throws(() => setToolInput(TOOLS, "my_task", "obj({"), /setToolInput's newInputSource must be a valid JS expression \(/);
  assert.throws(() => setToolInput(TOOLS, "my_task", "a; b"), /must be a valid JS expression/);
  assert.throws(() => setToolInput(TOOLS, "my_task", null), /must be a valid JS expression \(got object, not a string\)/);
  assert.throws(() => setToolInput(TOOLS, "my_tsk", "obj({})"), /no tool named "my_tsk" found -- nearest: "my_task"/);
  assert.throws(() => setToolInput(TOOLS, "fried_friction", "obj({})"), /multiple groups \(master, musician\)/);
});

test("setToolInput / setToolDescription: inputSchema and a missing description are handled", () => {
  const src = `const tools = { a: { inputSchema: { type: "object" }, run: () => 1 } };`;
  assert.ok(load(setToolInput(src, "a", "{}")).includes("inputSchema: {}"));
  assert.ok(load(setToolDescription(src, "a", "Now described.")).includes(`run: () => 1, description: "Now described." }`));
});

const ROSTER_JSON = `{
  "_comment": "The roster.",
  "agents": [
    {
      "id": "master",
      "name": "Claude A (master)",
      "kind": "master"
    },
    {
      "id": "claude-b",
      "name": "Claude B",
      "kind": "claude",
      "handoff": ["master"]
    }
  ],
  "checks": { "timeoutSec": 600 }
}
`;

test("addRosterAgent: a JSON roster stays valid JSON, indented like its items", () => {
  const out = addRosterAgent(ROSTER_JSON, { id: "claude-c", name: "Claude C", kind: "claude", handoff: ["claude-b"], strengths: ["tests"] });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.agents.map((a) => a.id), ["master", "claude-b", "claude-c"]);
  assert.deepEqual(parsed.agents[2].handoff, ["claude-b"]);
  assert.deepEqual(parsed.checks, { timeoutSec: 600 });
  assert.ok(out.includes(`    },\n    {\n      "id": "claude-c",\n      "name": "Claude C",`));
  // Object-literal source text works for JSON too, as long as it's literal.
  const fromText = JSON.parse(addRosterAgent(ROSTER_JSON, `{ id: 'gpt', name: 'GPT', kind: 'codex', maxParallel: 2 }`));
  assert.equal(fromText.agents[2].maxParallel, 2);
  assert.throws(() => addRosterAgent(ROSTER_JSON, `{ id: 'x', name: 'X', kind: 'k', at: Date.now() }`), /only add literal values/);
});

test("addRosterAgent: a JS module roster keeps the given source text", () => {
  const src = `export const roster = {\n  agents: [\n    { id: "claude-b", name: "Claude B", kind: "claude" },\n  ],\n};\n`;
  const out = load(addRosterAgent(src, `{ id: "codex", name: "Codex", kind: "codex", probe: () => true }`));
  assert.ok(out.includes(`    { id: "claude-b", name: "Claude B", kind: "claude" },\n    { id: "codex", name: "Codex", kind: "codex", probe: () => true },\n  ],`));
  const flat = `const agents = [];`;
  assert.ok(load(addRosterAgent(flat, { id: "a", name: "A", kind: "k" })).startsWith(`const agents = [{`));
});

test("addRosterAgent: refuses duplicates, missing fields, unknown hand-offs and a file without agents", () => {
  assert.throws(() => addRosterAgent(ROSTER_JSON, { id: "claude-b", name: "B2", kind: "claude" }),
    /agent with id "claude-b" already exists in roster \(existing: "master", "claude-b"\)/);
  assert.throws(() => addRosterAgent(ROSTER_JSON, { id: "x", name: "X" }), /requires an agent object with string "id", "name", and "kind" fields/);
  assert.throws(() => addRosterAgent(ROSTER_JSON, "not an object"), /requires an agent object/);
  assert.throws(() => addRosterAgent(ROSTER_JSON, { id: "claude-c", name: "C", kind: "claude", handoff: ["claude-x"] }),
    /agent "claude-c" hands off to unknown agent "claude-x" -- nearest: "claude-b"/);
  assert.ok(JSON.parse(addRosterAgent(ROSTER_JSON, { id: "self", name: "S", kind: "k", handoff: ["self", "master"] })));
  assert.throws(() => addRosterAgent(`{ "people": [] }`, { id: "a", name: "A", kind: "k" }), /no "agents" array found in source/);
  assert.throws(() => addRosterAgent(`const x = 1;`, { id: "a", name: "A", kind: "k" }), PatchError);
});

test("patch(): the four server ops run as batched steps", () => {
  const out = patch(TOOLS, [
    { op: "addTool", args: ["musician", "ping", DEF] },
    { op: "setToolDescription", args: ["ping", "Pong back."] },
    { op: "setToolInput", args: ["ping", `obj({ n: str("n") })`, "musician"] },
  ]);
  assert.ok(out.includes(`ping: { description: "Pong back.", input: obj({ n: str("n") }), run: async () => "pong" }`));
  assert.throws(() => patch(TOOLS, [{ op: "setToolDescription", args: ["fried_friction", "x"] }]), /step 0 \("setToolDescription"\) failed: tool "fried_friction" exists in multiple groups/);
  const roster = patch(`const agents = [];`, [{ op: "addRosterAgent", args: [{ id: "a", name: "A", kind: "k" }] }]);
  assert.ok(roster.includes(`"id": "a"`));
});
