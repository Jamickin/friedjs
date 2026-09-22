import test from "node:test";
import assert from "node:assert/strict";
import { state, action, uid } from "./fried.js";
import { setProp, setChildText, addChild, addStatementAfter, validate, PatchError } from "./patcher.js";

test("fried.js: state() creates reactive getter and setter", () => {
  const count = state(0);
  assert.equal(count.value, 0);
  count.value = 5;
  assert.equal(count.value, 5);
});

test("fried.js: action() wraps a function and preserves action name", () => {
  let called = false;
  const inc = action("increment", (step = 1) => {
    called = true;
    return step * 2;
  });
  assert.equal(inc.friedActionName, "increment");
  const result = inc(3);
  assert.equal(called, true);
  assert.equal(result, 6);
});

test("fried.js: uid() generates unique strings", () => {
  const id1 = uid();
  const id2 = uid();
  assert.ok(typeof id1 === "string" && id1.length > 0);
  assert.notEqual(id1, id2);
});

test("patcher.js: validate() returns true for valid JS and false for syntax errors", () => {
  assert.deepEqual(validate("const x = 1;"), { ok: true });
  const invalid = validate("const x = ;");
  assert.equal(invalid.ok, false);
  assert.ok(typeof invalid.error === "string");
});

test("patcher.js: setProp() adds and updates props by key", () => {
  const src = `const app = ui("div", { key: "box" }, []);`;
  const updated = setProp(src, "box", "class", '"container"');
  assert.ok(updated.includes('class: "container"'));
  assert.ok(validate(updated).ok);

  const updatedAgain = setProp(updated, "box", "class", '"box-active"');
  assert.ok(updatedAgain.includes('class: "box-active"'));
  assert.ok(!updatedAgain.includes('"container"'));
  assert.ok(validate(updatedAgain).ok);
});

test("patcher.js: setChildText() modifies literal string child", () => {
  const src = `const heading = ui("h1", { key: "title" }, ["Hello World"]);`;
  const patched = setChildText(src, "title", "Hello World", "FriedJS Tester");
  assert.ok(patched.includes('"FriedJS Tester"'));
  assert.ok(!patched.includes('"Hello World"'));
  assert.ok(validate(patched).ok);
});

test("patcher.js: addChild() appends child element to array", () => {
  const src = `const list = ui("ul", { key: "todo-list" }, [
  ui("li", { key: "item-1" }, ["First"])
]);`;
  const patched = addChild(src, "todo-list", `ui("li", { key: "item-2" }, ["Second"])`);
  assert.ok(patched.includes('item-2'));
  assert.ok(validate(patched).ok);
});

test("patcher.js: addStatementAfter() inserts top-level statement", () => {
  const src = `const initialCount = 0;
const app = ui("div", { key: "root" }, []);`;
  const patched = addStatementAfter(src, "initialCount", `const maxCount = 100;`);
  assert.ok(patched.includes("const maxCount = 100;"));
  assert.ok(validate(patched).ok);
});
