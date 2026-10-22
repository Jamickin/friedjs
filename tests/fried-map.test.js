// tooling/fried-map.mjs server lines: REG: (tool registries), TOOLS: (tool
// definitions by group) and ROUTES: (route tables and inline path tests).
// Plus one check that a browser-only file prints only its usual lines.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFriedMap, formatFriedMap } from "../tooling/fried-map.mjs";

const lines = (src) => formatFriedMap(buildFriedMap(src)).split("\n");
const line = (src, tag) => lines(src).find((l) => l.startsWith(tag + ":")) ?? null;

// Shaped like Orchestra's composer/tools.mjs before and after F4b.
const TOOLS_FACTORY = `
export function createTools({ store }) {
  const master = {
    friction_digest: { description: "Digest.", input: obj({}), run: async () => 1 },
    fried_friction: { description: "Friction.", input: frictionArgs, run: async () => 1 },
    roll_call: { description: "Roll call.", input: obj({ top: { type: "number", description: "1-30" } }), run: async () => 1 },
  };
  const musician = {
    fried_friction: { description: "Friction.", input: frictionArgs, run: async () => 1 },
    my_task: { description: "Your task.", input: obj({}), run: async () => 1 },
  };
  return { forRole: (role) => (role === "master" ? master : musician) };
}`;

test("fried-map: role groups give TOOLS: by group and a REG: named after their function", () => {
  assert.equal(line(TOOLS_FACTORY, "TOOLS"), "TOOLS: master(friction_digest fried_friction roll_call) musician(fried_friction my_task)");
  assert.equal(line(TOOLS_FACTORY, "REG"), "REG: createTools(master musician)");
  const map = buildFriedMap(TOOLS_FACTORY);
  assert.deepEqual(map.tools[0], { name: "friction_digest", group: "master" });
  assert.deepEqual(map.registries, [{ name: "createTools", groups: ["master", "musician"] }]);
});

test("fried-map: createToolRegistry gives REG: with its name and groups", () => {
  const src = TOOLS_FACTORY.replace(
    "return { forRole: (role) => (role === \"master\" ? master : musician) };",
    "return createToolRegistry(\"orchestra\", { master, musician }, { wrapForCaller: (t) => t });",
  );
  assert.equal(line(src, "REG"), "REG: orchestra(master musician)");
  const flat = `const r = createToolRegistry("mini", { ping: { description: "P", input: {}, run: () => 1 }, echo: { description: "E", inputSchema: {}, run: (a) => a } });`;
  assert.equal(line(flat, "REG"), "REG: mini");
  assert.equal(line(flat, "TOOLS"), "TOOLS: mini(ping echo)");
  const arr = `const reg = createToolRegistry("list", tools);\nconst lone = { a: { description: "A", run: () => 1 } };`;
  assert.equal(line(arr, "REG"), "REG: list(tools)");
  assert.equal(line(arr, "TOOLS"), "TOOLS: lone(a)");
});

test("fried-map: a lone tools object is not a registry; unnamed tools are listed flat, last", () => {
  const src = `const tools = { a: { description: "A", input: {}, run: () => 1 } };\nexport default [{ description: "x", run: () => 1 }];\nuse({ b: { input: {}, run: () => 2 } });`;
  assert.equal(line(src, "REG"), null);
  assert.equal(line(src, "TOOLS"), "TOOLS: tools(a) b");
});

test("fried-map: schema objects and single-field objects are not tools", () => {
  const src = `const schema = { top: { type: "number", description: "1-30" }, run: { description: "only one field" } };`;
  assert.equal(line(src, "TOOLS"), null);
});

// Shaped like Orchestra's composer/server.mjs request handler.
const SERVER = `
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && path === "/") return send(res, 200, "html");
  if (req.method === "GET" && path === "/api/quota-history") return send(res, 401, {});
  if ((req.url || "").split("?")[0].startsWith("/ui/") || path.startsWith("/ui/")) return serveUi(req, res);
  if (req.method === "GET" && STATIC[path]) return send(res, 200, "x");
  if (path === "/api/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && path === "/api/quota-history") return send(res, 200, {});
  if (req.method === "POST" && path === "/api/call") return call(req, res);
  if ("/api/order" === path && req.method === "POST") return order(req, res);
});`;

test("fried-map: inline path tests give ROUTES: in source order, deduplicated, GET when unguarded", () => {
  assert.equal(line(SERVER, "ROUTES"), "ROUTES: GET / GET /api/quota-history GET /ui/* GET /api/health POST /api/call POST /api/order");
});

test("fried-map: route tables (createAppServer routes, const routes) give ROUTES:", () => {
  const src = `const app = createAppServer({ routes: { "GET /api/state": s, "post  /x": p, "POST /api/call": c, "/api/health": h, "not a route": 1 }, staticFiles: { "/app.js": f } });\nconst routes = { "/plans/:id": v };`;
  assert.equal(line(src, "ROUTES"), "ROUTES: GET /api/state POST /api/call GET /api/health GET /plans/:id");
});

test("fried-map: browser-only files print no server lines and keep their existing lines", () => {
  const src = `const count = state(0);\nconst inc = action("inc", () => count.value++);\nconst view = () => ui("div", { key: "root" }, [String(count.value)]);`;
  assert.deepEqual(lines(src), ["S: count", "A: inc", "K: root", "C: view"]);
  const map = buildFriedMap(src);
  assert.deepEqual([map.registries, map.tools, map.routes], [[], [], []]);
});
