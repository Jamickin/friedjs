// addons/fried-router.js: exact routes unchanged, ":param" routes, query
// strings. The addon reads window.location and listens for hashchange at
// import, so a tiny window shim is installed before importing it.
import test from "node:test";
import assert from "node:assert/strict";

const listeners = {};
globalThis.window ??= {
  location: { hash: "" },
  addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
};
const { currentRoute, navigate, router, matchRoute, parseRoute } = await import("../addons/fried-router.js");

const go = (path) => { window.location.hash = path; currentRoute.value = path; };

test("router: exact routes behave as before", () => {
  const routes = { "/": () => "home", "/about": () => "about", "*": () => "missing" };
  go("/"); assert.equal(router(routes), "home");
  go("/about"); assert.equal(router(routes), "about");
  go("/nope"); assert.equal(router(routes), "missing");
  assert.equal(router({ "/x": () => "x" }), null);
  // a view declared with no parameters still works
  go("/about"); assert.equal(router({ "/about": function () { return arguments.length; } }), 1);
});

test("router: an exact key that contains '?' is matched as the whole path", () => {
  const routes = { "/s?q=1": () => "exact", "/s": () => "plain" };
  assert.equal(matchRoute(routes, "/s?q=1").pattern, "/s?q=1");
  assert.equal(matchRoute(routes, "/s?q=2").pattern, "/s");
});

test("router: the view gets { params, query, path }", () => {
  const routes = { "/plans/:id/tasks/:taskId": (ctx) => ctx };
  go("/plans/p1/tasks/t%201?tab=log&x=a+b");
  assert.deepEqual(router(routes), { params: { id: "p1", taskId: "t 1" }, query: { tab: "log", x: "a b" }, path: "/plans/p1/tasks/t%201" });
});

test("navigate: works with a query string", () => {
  navigate("/done?agent=codex&day=today");
  assert.equal(window.location.hash, "/done?agent=codex&day=today");
  assert.deepEqual(router({ "/done": ({ query }) => query }), { agent: "codex", day: "today" });
});

test("parseRoute: path and query", () => {
  assert.deepEqual(parseRoute("/done?agent=codex&day=today"), { path: "/done", query: { agent: "codex", day: "today" } });
  assert.deepEqual(parseRoute("/a"), { path: "/a", query: {} });
  assert.deepEqual(parseRoute(""), { path: "/", query: {} });
  assert.deepEqual(parseRoute("?x=1"), { path: "/", query: { x: "1" } });
  assert.deepEqual(parseRoute("/a?x=1&x=2&flag&&y=%2F"), { path: "/a", query: { x: "1", flag: "", y: "/" } });
  assert.deepEqual(parseRoute("/a?bad=%E0%A4%A&ok=%41"), { path: "/a", query: { bad: "%E0%A4%A", ok: "A" } });
  const proto = parseRoute("/a?__proto__=x&constructor=y").query;
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(proto.__proto__, "x");
  assert.equal(proto.constructor, "y");
});

test("matchRoute: params are decoded, tolerant of bad escapes", () => {
  const routes = { "/files/:name": () => 1 };
  assert.deepEqual(matchRoute(routes, "/files/a%2Fb").params, { name: "a/b" });
  assert.deepEqual(matchRoute(routes, "/files/%E0%A4%A").params, { name: "%E0%A4%A" });
  assert.deepEqual(matchRoute(routes, "/files/caf%C3%A9").params, { name: "café" });
  assert.equal(matchRoute(routes, "/files/"), null, "an empty segment does not fill a param");
  assert.equal(matchRoute(routes, "/files/a/b"), null);
});

test("matchRoute: result shape and no match", () => {
  const view = () => 1;
  assert.deepEqual(matchRoute({ "/m/:id": view }, "/m/codex?x=1"), { view, params: { id: "codex" }, query: { x: "1" }, path: "/m/codex", pattern: "/m/:id" });
  assert.equal(matchRoute({ "/m/:id": view }, "/other"), null);
  assert.equal(matchRoute({}, "/"), null);
  assert.equal(matchRoute({ "/": view }, "").pattern, "/");
  assert.equal(matchRoute({ "/toString": "not a function" }, "/toString"), null);
  assert.equal(matchRoute({}, "constructor"), null);
});

test("matchRoute: more literal segments win; ties go to declaration order", () => {
  const routes = {
    "/plans/:id": () => "param",
    "/plans/new": () => "literal",
    "/:a/:b": () => "both",
    "/:x/edit": () => "x-edit",
    "/:y/edit": () => "y-edit",
  };
  assert.equal(matchRoute(routes, "/plans/new").pattern, "/plans/new");
  assert.equal(matchRoute(routes, "/plans/7").pattern, "/plans/:id");
  assert.equal(matchRoute(routes, "/q/r").pattern, "/:a/:b");
  assert.equal(matchRoute(routes, "/q/edit").pattern, "/:x/edit");
  const tie = { "/a/:x": () => 1, "/:y/b": () => 2 };
  assert.equal(matchRoute(tie, "/a/b").pattern, "/a/:x");
});

test("matchRoute: trailing slashes are tolerated", () => {
  const routes = { "/about": () => 1, "/m/:id/": () => 2 };
  assert.equal(matchRoute(routes, "/about/").pattern, "/about");
  assert.equal(matchRoute(routes, "/m/x").pattern, "/m/:id/");
  assert.deepEqual(matchRoute(routes, "/m/x/?q=1").params, { id: "x" });
});

test("matchRoute: '*' applies last", () => {
  const routes = { "*": () => "fallback", "/m/:id": () => "m" };
  assert.equal(matchRoute(routes, "/m/1").pattern, "/m/:id");
  const fb = matchRoute(routes, "/zzz?a=1");
  assert.equal(fb.pattern, "*");
  assert.deepEqual(fb.query, { a: "1" });
});

test("matchRoute: pattern text is never a regex; hostile input stays fast", () => {
  const routes = { "/a.b/(x+)+$/:id": () => 1, "/:a/:b/:c/:d/:e/:f": () => 2 };
  assert.equal(matchRoute(routes, "/aXb/xxxx/1"), null);
  assert.equal(matchRoute(routes, "/a.b/(x+)+$/1").params.id, "1");
  const long = "/" + "a/".repeat(50000) + "!";
  const huge = "/x" + "%".repeat(200000) + "?q=" + "&".repeat(100000);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    matchRoute(routes, long);
    matchRoute(routes, huge);
    matchRoute(routes, "/" + "(a+)+".repeat(10000));
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});
