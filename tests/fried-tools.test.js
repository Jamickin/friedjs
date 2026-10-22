// addons/server/fried-tools.js: role-scoped registries, hot reload, HTTP
// handlers and the stdio MCP shim. No network: the MCP tests use a fake
// fetch and PassThrough streams; the HTTP test binds 127.0.0.1 on port 0.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import {
  createToolRegistry, createToolHttpHandlers, createMcpStdioServer,
  str, num, bool, arr, obj,
} from "../addons/server/fried-tools.js";

const roleMap = () => ({
  master: {
    roll_call: { description: "Check every musician.", input: obj({}), run: async () => ({ roster: ["a"] }) },
    add: { description: "Add two numbers.", input: obj({ a: num("first"), b: num("second") }, ["a", "b"]), run: ({ a, b }) => a + b },
  },
  musician: {
    my_task: { description: "Your instructions.", input: obj({}), run: async (_, { task }) => ({ id: task?.id ?? null }) },
    echo: { description: "Echo.", input: obj({ text: str("text") }), run: (args, caller) => ({ args, caller }) },
    boom: { description: "Throws.", input: obj({}), run: () => { throw new Error("kaboom"); } },
  },
});

test("schema helpers build JSON-schema fragments", () => {
  assert.deepEqual(str("s"), { type: "string", description: "s" });
  assert.deepEqual(num("n"), { type: "number", description: "n" });
  assert.deepEqual(bool("b"), { type: "boolean", description: "b" });
  assert.deepEqual(arr("a"), { type: "array", items: { type: "string" }, description: "a" });
  assert.deepEqual(arr("a", num("x")).items, { type: "number", description: "x" });
  assert.deepEqual(obj({ x: str("x") }, ["x"]), { type: "object", properties: { x: { type: "string", description: "x" } }, required: ["x"] });
  assert.deepEqual(obj({}), { type: "object", properties: {}, required: [] });
});

test("role-map registry filters forRole and listForRole", async () => {
  const reg = createToolRegistry("orchestra", roleMap());
  assert.equal(reg.name, "orchestra");
  assert.deepEqual(reg.roles(), ["master", "musician"]);
  assert.deepEqual(Object.keys(reg.forRole("master")), ["roll_call", "add"]);
  assert.deepEqual(Object.keys(reg.forRole("musician")), ["my_task", "echo", "boom"]);
  assert.deepEqual(reg.forRole("nobody"), {});
  const list = reg.listForRole("master");
  assert.deepEqual(list[1], { name: "add", description: "Add two numbers.", inputSchema: obj({ a: num("first"), b: num("second") }, ["a", "b"]) });
  assert.equal(await reg.forRole("master").add.run({ a: 2, b: 3 }), 5);
});

test("forRole accepts a task, a caller, or nothing; run's explicit caller wins", async () => {
  const reg = createToolRegistry("t", roleMap());
  const task = { id: "p1.api", agent: "codex" };
  // forRole(role, task): task becomes { role, task } and is the default caller.
  assert.deepEqual(await reg.forRole("musician", task).my_task.run({}), { id: "p1.api" });
  assert.deepEqual(reg.forRole("musician", task).echo.run({ x: 1 }).caller, { role: "musician", task });
  // forRole(role) then run(args, { task }) (the Orchestra test style).
  assert.deepEqual(await reg.forRole("musician").my_task.run({}, { task }), { id: "p1.api" });
  // forRole(role, who) where who already has a role: used as-is.
  const who = { role: "musician", task, extra: 1 };
  assert.equal(reg.forRole("musician", who).echo.run({}).caller, who);
  // No caller at all: { role }.
  assert.deepEqual(reg.forRole("musician").echo.run({}).caller, { role: "musician" });
});

test("wrapForCaller wraps tools per caller without touching the declarations", async () => {
  const seen = [];
  const reg = createToolRegistry("t", roleMap(), {
    wrapForCaller(tools, role, caller) {
      seen.push([role, caller.task?.id ?? null]);
      if (role !== "musician" || !caller.task) return tools;
      const t = tools.echo;
      return { ...tools, echo: { ...t, run: (a) => ({ wrapped: caller.task.id, a }) } };
    },
  });
  assert.deepEqual(reg.forRole("musician", { id: "x" }).echo.run({ q: 1 }), { wrapped: "x", a: { q: 1 } });
  assert.equal(reg.forRole("musician").echo.run({ q: 1 }).args.q, 1);
  assert.deepEqual(await reg.call("musician", "echo", { q: 2 }, { role: "musician", task: { id: "y" } }), { wrapped: "y", a: { q: 2 } });
  assert.deepEqual(seen, [["musician", "x"], ["musician", null], ["musician", "y"]]);
});

test("call() runs a tool, 404s on a missing or cross-role tool", async () => {
  const reg = createToolRegistry("t", roleMap());
  assert.equal(await reg.call("master", "add", { a: 1, b: 1 }), 2);
  assert.deepEqual((await reg.call("musician", "echo", undefined)).args, {});
  for (const [role, name] of [["musician", "roll_call"], ["master", "nope"], ["master", "constructor"], ["master", "__proto__"]]) {
    await assert.rejects(reg.call(role, name, {}), (e) => e.status === 404 && e.message === `no tool "${name}" for role ${role}`);
  }
  await assert.rejects(reg.call("musician", "boom", {}), /kaboom/);
});

test("flat shapes: object map and array, with roles or shared", async () => {
  const run = (a) => a;
  const flat = createToolRegistry("flat", {
    hello: { description: "Shared.", input: obj({}), run: () => "hi" },
    admin: { description: "Admin only.", roles: ["admin"], run },
  });
  assert.deepEqual(Object.keys(flat.forRole("admin")), ["hello", "admin"]);
  assert.deepEqual(Object.keys(flat.forRole("guest")), ["hello"]);
  assert.deepEqual(flat.forRole("guest").hello.input, obj({}), "input defaults to obj({})");

  const fromArray = createToolRegistry("arr", [
    { name: "a", description: "A", input: obj({}), roles: ["x", "y"], run: () => "a" },
    { name: "b", description: "B", input: obj({}), run: () => "b" },
  ]);
  assert.deepEqual(Object.keys(fromArray.forRole("x")), ["b", "a"]);
  assert.deepEqual(Object.keys(fromArray.forRole("z")), ["b"]);
  assert.equal(await fromArray.call("y", "a"), "a");
  assert.deepEqual(createToolRegistry("empty", {}).forRole("any"), {});
});

test("invalid declarations are refused with a clear TypeError", () => {
  assert.throws(() => createToolRegistry("bad", { x: { description: "no run", input: obj({}) } }), /tool "x" needs a run/);
  assert.throws(() => createToolRegistry("bad", { x: { input: obj({}), run() {} } }), /tool "x" needs a string description/);
  assert.throws(() => createToolRegistry("bad", [{ description: "d", run() {} }]), /tool name must be a non-empty string/);
  assert.throws(() => createToolRegistry("bad", { r: { x: { description: "d", input: "nope", run() {} } } }), /input must be a JSON-schema object/);
  assert.throws(() => createToolRegistry("bad", { x: { description: "d", roles: "admin", run() {} } }), /roles must be an array/);
  assert.throws(() => createToolRegistry("bad", 42), /tools must be an object or an array/);
});

test("register(), unregister() and replace() hot-reload in place", async () => {
  const reg = createToolRegistry("t", roleMap());
  const before = reg.forRole("master");
  reg.register("roll_call", { description: "Updated.", input: obj({}), run: () => "v2" });
  assert.equal(reg.forRole("master").roll_call.description, "Updated.");
  assert.deepEqual(Object.keys(reg.forRole("master")), ["roll_call", "add"], "update keeps position");
  assert.equal(before.roll_call.description, "Check every musician.", "earlier snapshots are untouched");
  assert.equal(await reg.call("master", "roll_call"), "v2");

  reg.register("status", { description: "S", input: obj({}), run: () => "s" }, "musician");
  assert.ok(reg.forRole("musician").status);
  assert.ok(!reg.forRole("master").status);
  reg.register("ping", { description: "P", input: obj({}), run: () => "pong" });
  assert.ok(reg.forRole("master").ping && reg.forRole("musician").ping, "new tool without role is shared");
  reg.register("multi", { description: "M", roles: ["master", "ops"], run: () => 1 });
  assert.ok(reg.forRole("ops").multi && reg.forRole("master").multi && !reg.forRole("musician").multi);

  assert.equal(reg.unregister("status", "musician"), true);
  assert.equal(reg.unregister("status", "musician"), false);
  assert.equal(reg.unregister("ping"), true);
  assert.ok(!reg.forRole("master").ping);

  assert.throws(() => reg.replace({ x: { description: "broken" } }), TypeError);
  assert.ok(reg.forRole("master").roll_call, "a failed replace leaves the old tools");
  reg.replace({ master: { only: { description: "Only.", input: obj({}), run: () => "only" } } });
  assert.deepEqual(Object.keys(reg.forRole("master")), ["only"]);
  assert.deepEqual(reg.forRole("musician"), {});
});

test("fallbackRole: unknown roles get the fallback role's tools, known roles are unaffected", async () => {
  const seen = [];
  const reg = createToolRegistry("orchestra", roleMap(), {
    fallbackRole: "musician",
    wrapForCaller: (set, role, caller) => { seen.push([role, caller.role]); return set; },
  });
  assert.deepEqual(Object.keys(reg.forRole("master")), ["roll_call", "add"]);
  assert.deepEqual(Object.keys(reg.forRole("musician")), ["my_task", "echo", "boom"]);
  assert.deepEqual(Object.keys(reg.forRole("claude-b", { id: "t1" })), ["my_task", "echo", "boom"]);
  assert.deepEqual(reg.listForRole("codex").map((t) => t.name), ["my_task", "echo", "boom"]);
  assert.deepEqual(await reg.call("gemini", "my_task", {}, { id: "t9" }), { id: "t9" });
  const r = await reg.call("gemini", "echo", { text: "hi" });
  assert.equal(r.caller.role, "gemini", "the caller keeps its own role");
  await assert.rejects(reg.call("gemini", "roll_call"), (e) => e.status === 404 && /no tool "roll_call" for role gemini/.test(e.message));
  assert.deepEqual(seen.find(([, c]) => c === "claude-b"), ["musician", "claude-b"], "wrapForCaller gets the fallback role");
  assert.deepEqual(reg.roles(), ["master", "musician"]);

  // Shared tools still reach a fallen-back role, and replace() keeps the fallback.
  reg.replace([
    { name: "help", description: "Help.", run: () => "h" },
    { name: "work", description: "Work.", roles: ["musician"], run: () => "w" },
  ]);
  assert.deepEqual(Object.keys(reg.forRole("claude-b")), ["help", "work"]);
  assert.throws(() => reg.replace({ master: roleMap().master }), /fallbackRole "musician" is not a role/);
  assert.deepEqual(Object.keys(reg.forRole("claude-b")), ["help", "work"], "a refused replace() leaves the tools as they were");
});

test("fallbackRole: without the option unknown roles get nothing; a missing fallback is refused", async () => {
  const reg = createToolRegistry("orchestra", roleMap());
  assert.deepEqual(reg.forRole("claude-b"), {});
  assert.deepEqual(reg.listForRole("claude-b"), []);
  await assert.rejects(reg.call("claude-b", "my_task"), (e) => e.code === "ENOTOOL");

  assert.throws(() => createToolRegistry("orchestra", roleMap(), { fallbackRole: "worker" }),
    (e) => e instanceof TypeError && /fallbackRole "worker" is not a role in this registry \(roles: master, musician\)/.test(e.message));
  assert.throws(() => createToolRegistry("x", { help: { description: "h", run: () => 1 } }, { fallbackRole: "musician" }), /roles: none/);
  assert.throws(() => createToolRegistry("x", roleMap(), { fallbackRole: "" }), /non-empty role name/);
});

test("toMarkdown renders a deterministic reference per role", () => {
  const reg = createToolRegistry("orchestra", roleMap());
  const md = reg.toMarkdown();
  assert.equal(md, reg.toMarkdown());
  assert.match(md, /^# orchestra tools\n/);
  assert.match(md, /### master\n\n- `roll_call`: Check every musician\.\n- `add`: Add two numbers\.\n  - `a` \(number, required\): first\n/);
  assert.match(md, /### musician\n\n- `my_task`: Your instructions\./);
  assert.match(md, /- `echo`: Echo\.\n  - `text` \(string\): text/);
  const shared = createToolRegistry("s", { a: { description: "line one\n  line two", input: obj({ xs: arr("list") }), run() {} } }).toMarkdown();
  assert.match(shared, /### all roles\n\n- `a`: line one line two\n  - `xs` \(string\[\]\): list/);
});

// Minimal server wiring the handlers like fried-serve would: who from a bearer token.
async function startHttp(registry) {
  const h = createToolHttpHandlers(registry);
  const tokens = { M: { role: "master" }, W: { role: "musician", task: { id: "p.w" } } };
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const who = tokens[(req.headers.authorization || "").replace(/^Bearer /, "")] || null;
    const body = () => new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => { s += c; });
      req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    });
    if (req.method === "GET" && req.url === "/api/tools") return h.handleList({ who, send });
    if (req.method === "POST" && req.url === "/api/call") return h.handleCall({ who, body, send });
    send(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, token, data) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: data === undefined ? undefined : (typeof data === "string" ? data : JSON.stringify(data)) });
    return { status: res.status, json: await res.json() };
  };
  return { base, req, close: () => new Promise((r) => server.close(r)) };
}

test("createToolHttpHandlers serves /api/tools and /api/call, and sees hot reloads", async (t) => {
  const reg = createToolRegistry("t", roleMap());
  const srv = await startHttp(reg);
  t.after(srv.close);

  let r = await srv.req("GET", "/api/tools", "M");
  assert.equal(r.status, 200);
  assert.equal(r.json.role, "master");
  assert.deepEqual(r.json.tools.map((x) => x.name), ["roll_call", "add"]);
  assert.deepEqual(r.json.tools[0], { name: "roll_call", description: "Check every musician.", inputSchema: obj({}) });

  r = await srv.req("POST", "/api/call", "M", { tool: "add", args: { a: 4, b: 5 } });
  assert.deepEqual(r, { status: 200, json: { result: 9 } });
  r = await srv.req("POST", "/api/call", "W", { tool: "my_task" });
  assert.deepEqual(r, { status: 200, json: { result: { id: "p.w" } } }, "who is the default caller");
  r = await srv.req("POST", "/api/call", "W", { tool: "roll_call", args: {} });
  assert.deepEqual(r, { status: 404, json: { error: 'no tool "roll_call" for role musician' } });
  r = await srv.req("POST", "/api/call", "W", { tool: "boom", args: {} });
  assert.deepEqual(r, { status: 400, json: { error: "kaboom" } });
  r = await srv.req("POST", "/api/call", "W", "{not json");
  assert.equal(r.status, 400);
  r = await srv.req("GET", "/api/tools", "nobody");
  assert.deepEqual(r, { status: 401, json: { error: "unauthorized" } });

  // Hot reload: same handlers, new tools.
  reg.register("fresh", { description: "Added live.", input: obj({}), run: () => "new" }, "master");
  r = await srv.req("GET", "/api/tools", "M");
  assert.ok(r.json.tools.some((x) => x.name === "fresh"));
  assert.deepEqual((await srv.req("POST", "/api/call", "M", { tool: "fresh" })).json, { result: "new" });
});

// --- MCP stdio ---------------------------------------------------------------

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body } = await handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error("no json"); return body; } };
  };
  return { impl, calls };
}

function mcp(fetchImpl, extra = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = [];
  let buf = "";
  const waiters = [];
  stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      while (waiters.length && waiters[0].n <= lines.length) waiters.shift().resolve();
    }
  });
  const server = createMcpStdioServer({ url: "http://127.0.0.1:9/", token: "tok", stdin, stdout, fetchImpl, ...extra });
  const waitLines = (n) => (lines.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })));
  const send = (msg) => stdin.write(JSON.stringify(msg) + "\n");
  return { stdin, lines, waitLines, send, server };
}

test("MCP: initialize, notifications, ping, empty lists, unknown method, parse error", async () => {
  const f = fakeFetch(() => ({ body: {} }));
  const m = mcp(f.impl, { serverInfo: { name: "orchestra", version: "0.1.0" }, instructions: "Call my_task first." });
  m.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  m.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  m.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  m.send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
  m.send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
  m.send({ jsonrpc: "2.0", id: 5, method: "nope/what" });
  m.stdin.write("{this is not json\n\n   \n");
  m.send({ jsonrpc: "2.0", id: 6, method: "initialize" });
  await m.waitLines(7);
  const byId = Object.fromEntries(m.lines.map((l) => [l.id, l]));
  assert.deepEqual(byId[1].result, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "orchestra", version: "0.1.0" }, instructions: "Call my_task first." });
  assert.equal(byId[6].result.protocolVersion, "2025-06-18");
  assert.deepEqual(byId[2], { jsonrpc: "2.0", id: 2, result: {} });
  assert.deepEqual(byId[3].result, { resources: [] });
  assert.deepEqual(byId[4].result, { prompts: [] });
  assert.deepEqual(byId[5], { jsonrpc: "2.0", id: 5, error: { code: -32601, message: "method not found: nope/what" } });
  assert.deepEqual(byId[null], { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  assert.equal(m.lines.length, 7, "the notification and blank lines produce no output");
  assert.equal(f.calls.length, 0);
  m.server.close();
});

test("MCP: chunked partial lines and multi-byte UTF-8 split across chunks", async () => {
  const f = fakeFetch(() => ({ body: { result: "ok" } }));
  const m = mcp(f.impl);
  const raw = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "say", arguments: { text: "héllo ✓" } } }) + "\n", "utf8");
  const cut = raw.indexOf(Buffer.from("✓")) + 1; // split inside the 3-byte char
  m.stdin.write(raw.subarray(0, 5));
  m.stdin.write(raw.subarray(5, cut));
  await new Promise((r) => setImmediate(r));
  assert.equal(m.lines.length, 0, "nothing handled before the newline");
  m.stdin.write(raw.subarray(cut));
  await m.waitLines(1);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { tool: "say", args: { text: "héllo ✓" } });
  m.server.close();
});

test("MCP: tools/list and tools/call forward over HTTP with the bearer token", async () => {
  const tools = [{ name: "my_task", description: "d", inputSchema: obj({}) }];
  const f = fakeFetch((url, init) => {
    if (url.endsWith("/api/tools")) return { body: { role: "musician", tools } };
    const { tool, args } = JSON.parse(init.body);
    if (tool === "my_task") return { body: { result: { brief: "do it", args } } };
    if (tool === "nothing") return { body: {} };
    return { status: 404, body: { error: `no tool "${tool}" for role musician` } };
  });
  const m = mcp(f.impl);
  m.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  await m.waitLines(1);
  m.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "my_task" } });
  await m.waitLines(2);
  m.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "roll_call", arguments: {} } });
  await m.waitLines(3);
  m.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nothing" } });
  await m.waitLines(4);

  assert.deepEqual(m.lines[0], { jsonrpc: "2.0", id: 1, result: { tools } });
  assert.equal(f.calls[0].url, "http://127.0.0.1:9/api/tools", "trailing slash on url is trimmed");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(f.calls[1].init.method, "POST");
  assert.deepEqual(m.lines[1].result, { content: [{ type: "text", text: JSON.stringify({ brief: "do it", args: {} }, null, 2) }] });
  assert.deepEqual(m.lines[2].result, { content: [{ type: "text", text: 'no tool "roll_call" for role musician' }], isError: true });
  assert.deepEqual(m.lines[3].result, { content: [{ type: "text", text: "null" }] });
  m.server.close();
});

test("MCP: server down gives the composer_status fallback and isError results", async () => {
  const f = fakeFetch(() => { throw new Error("ECONNREFUSED"); });
  const m = mcp(f.impl, { downMessage: "composer is down" });
  m.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  m.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x", arguments: {} } });
  await m.waitLines(2);
  const byId = Object.fromEntries(m.lines.map((l) => [l.id, l]));
  assert.deepEqual(byId[1].result, { tools: [{ name: "composer_status", description: "composer is down", inputSchema: { type: "object", properties: {} } }] });
  assert.deepEqual(byId[2].result, { content: [{ type: "text", text: "composer is down" }], isError: true });
  assert.ok(!("error" in byId[1]) && !("error" in byId[2]));

  // Non-OK response without a JSON error body uses httpErrorMessage.
  const g = fakeFetch(() => ({ status: 503 }));
  const n = mcp(g.impl, { httpErrorMessage: (s) => `composer returned ${s}`, token: () => "fresh" });
  n.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } });
  await n.waitLines(1);
  assert.deepEqual(n.lines[0].result, { content: [{ type: "text", text: "composer returned 503" }], isError: true });
  assert.equal(g.calls[0].init.headers.authorization, "Bearer fresh", "token may be a function");
  m.server.close();
  n.server.close();
});

test("MCP: handleMessage works without stdin, invalid requests, close() and onEnd", async () => {
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(String(c)));
  const s = createMcpStdioServer({ url: "http://x", stdin: null, stdout: out, fetchImpl: async () => { throw new Error("x"); } });
  await s.handleMessage({ jsonrpc: "2.0", id: "a", method: "ping" });
  await s.handleMessage(null);
  await s.handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled" });
  s.close();
  assert.deepEqual(chunks.join("").trim().split("\n").map((l) => JSON.parse(l)), [
    { jsonrpc: "2.0", id: "a", result: {} },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
  ]);
  assert.throws(() => createMcpStdioServer({ stdin: null }), /url is required/);

  let ended = 0;
  const m = mcp(async () => ({ ok: true, status: 200, json: async () => ({}) }), { onEnd: () => { ended++; } });
  m.server.close();
  m.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  m.stdin.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(m.lines.length, 0, "closed server ignores input");
  assert.equal(ended, 0, "closed server does not call onEnd");

  const m2 = mcp(async () => ({ ok: true, status: 200, json: async () => ({}) }), { onEnd: () => { ended++; } });
  m2.stdin.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(ended, 1);
});
