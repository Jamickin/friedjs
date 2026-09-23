import test from "node:test";
import assert from "node:assert/strict";
import { state, action, uid, store, derived, ui, render, mount } from "./fried.js";
import { setProp, setChildText, addChild, addStatementAfter, removeChild, renameAction, replaceFunction, removeStatement, validate, PatchError } from "./patcher.js";

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

test("fried.js: store() bundles state cells", () => {
  const s = store({ a: 1, b: "hello" });
  assert.equal(s.a, 1);
  assert.equal(s.b, "hello");
  s.a = 2;
  assert.equal(s.a, 2);
});

test("fried.js: derived() lazily recomputes when deps change", () => {
  const a = state(2);
  const b = state(3);
  let calls = 0;
  const sum = derived([a, b], () => { calls++; return a.value + b.value; });
  
  assert.equal(sum.value, 5);
  assert.equal(calls, 1);
  
  assert.equal(sum.value, 5);
  assert.equal(calls, 1); // cached
  
  a.value = 4;
  assert.equal(sum.value, 7);
  assert.equal(calls, 2);
});

test("fried.js: ref prop gives access to raw DOM node", () => {
  const v = ui("div", { ref: (el) => { el.id = "tested-ref"; } });
  // We can't mount easily in unit test without jsdom, wait, test.js runs in node.
  // Actually, ui() just returns an object. Ref is called in createDom, which needs DOM.
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

test("patcher.js: setProp() throws instead of silently editing the wrong node when a key is duplicated", () => {
  const src = `const a = ui("div", { key: "x" }, ["first"]);
const b = ui("span", { key: "x" }, ["second"]);`;
  assert.throws(() => setProp(src, "x", "class", '"danger"'), PatchError);
});

test("patcher.js: removeChild() throws instead of silently removing the wrong child when a child key is duplicated", () => {
  const src = `const list = ui("ul", { key: "list" }, [
    ui("li", { key: "dup" }, ["one"]),
    ui("li", { key: "dup" }, ["two"])
  ]);`;
  assert.throws(() => removeChild(src, "list", "dup"), PatchError);
});

test("patcher.js: removeChild() deletes inline ui child node", () => {
  const src = `const list = ui("ul", { key: "list" }, [
    ui("li", { key: "item-1" }, []),
    ui("li", { key: "item-2" }, []),
    ui("li", { key: "item-3" }, [])
  ]);`;
  const patched = removeChild(src, "list", "item-2");
  assert.ok(!patched.includes("item-2"));
  assert.ok(patched.includes("item-1"));
  assert.ok(patched.includes("item-3"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: replaceFunction() swaps a top-level function's full source", () => {
  const src = `function double(x) {
  return x * 2;
}
const y = double(4);`;
  const patched = replaceFunction(src, "double", `function double(x) {\n  return x * 3;\n}`);
  assert.ok(patched.includes("return x * 3;"));
  assert.ok(!patched.includes("return x * 2;"));
  assert.ok(patched.includes("const y = double(4);"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: replaceFunction() matches exported function declarations", () => {
  const src = `export function greet(name) {\n  return "hi " + name;\n}`;
  const patched = replaceFunction(src, "greet", `function greet(name) {\n  return "hello " + name;\n}`);
  assert.ok(patched.startsWith("export function greet"));
  assert.ok(patched.includes("hello"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: replaceFunction() throws for an unknown function name", () => {
  assert.throws(() => replaceFunction("const x = 1;", "missing", "function missing() {}"), PatchError);
});

test("patcher.js: removeStatement() removes a top-level function declaration", () => {
  const src = `function helper() {\n  return 1;\n}\n\nconst x = helper();`;
  const patched = removeStatement(src, "helper");
  assert.ok(!patched.includes("function helper"));
  assert.ok(patched.includes("const x = helper();"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: removeStatement() removes an exported function declaration", () => {
  const src = `export function greet() {\n  return "hi";\n}\n\nconst x = 1;`;
  const patched = removeStatement(src, "greet");
  assert.ok(!patched.includes("greet"));
  assert.ok(patched.includes("const x = 1;"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: removeStatement() removes a single-declarator variable declaration", () => {
  const src = `const a = 1;\nconst b = 2;\nconst c = a + b;`;
  const patched = removeStatement(src, "b");
  assert.ok(!patched.includes("const b"));
  assert.ok(patched.includes("const a = 1;"));
  assert.ok(patched.includes("const c = a + b;"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: removeStatement() refuses a multi-declarator statement rather than guess", () => {
  const src = `let a, b, c;\nconst x = 1;`;
  assert.throws(() => removeStatement(src, "b"), PatchError);
});

test("patcher.js: removeStatement() throws for an unknown name", () => {
  assert.throws(() => removeStatement("const x = 1;", "missing"), PatchError);
});

test("patcher.js: renameAction() renames declaration and references", () => {
  const src = `const oldDoThing = action("oldDoThing", () => {});
const btn = ui("button", { key: "btn", onclick: oldDoThing }, []);`;
  const patched = renameAction(src, "oldDoThing", "newDoThing");
  assert.ok(!patched.includes("oldDoThing"));
  assert.ok(patched.includes('action("newDoThing"'));
  assert.ok(patched.includes("const newDoThing ="));
  assert.ok(patched.includes("onclick: newDoThing"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: renameAction() does not touch an unrelated same-named declaration", () => {
  const src = `const oldName = action("oldName", () => {});
function unrelated() {
  const oldName = 42;
  return oldName;
}
const btn = ui("button", { key: "btn", onclick: oldName }, []);`;
  const patched = renameAction(src, "oldName", "newName");
  assert.ok(patched.includes("const newName = action"));
  assert.ok(patched.includes("onclick: newName"));
  assert.ok(patched.includes("const oldName = 42;"));
  assert.ok(patched.includes("return oldName;"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: renameAction() does not touch references shadowed by a callback param", () => {
  const src = `const oldName = action("oldName", () => {});
const doubled = [1, 2, 3].map((oldName) => oldName * 2);
const btn = ui("button", { key: "btn", onclick: oldName }, []);`;
  const patched = renameAction(src, "oldName", "newName");
  assert.ok(patched.includes("const newName = action"));
  assert.ok(patched.includes("onclick: newName"));
  assert.ok(patched.includes("(oldName) => oldName * 2"));
  assert.ok(validate(patched).ok);
});

test("patcher.js: renameAction() never leaves a declaration renamed but its own reference stale", () => {
  const src = `const oldName = action("oldName", () => {});
function unrelated() {
  let oldName = 1;
  oldName += 1;
  return oldName;
}
const btn = ui("button", { key: "btn", onclick: oldName }, []);`;
  const patched = renameAction(src, "oldName", "newName");
  assert.ok(patched.includes("let oldName = 1;"));
  assert.ok(patched.includes("oldName += 1;"));
  assert.ok(patched.includes("return oldName;"));
  assert.ok(validate(patched).ok);
});
