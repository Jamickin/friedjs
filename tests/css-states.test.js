import test from "node:test";
import assert from "node:assert/strict";

// css() needs a stylesheet; give it one that just records what is inserted.
const inserted = [];
globalThis.document = {
  createElement: () => ({ sheet: { cssRules: inserted, insertRule(text) { inserted.push(text); } } }),
  head: { appendChild() {} },
  documentElement: { style: { setProperty() {} } },
};
const { css } = await import("../fried.js");

test("css(): plain rules still dedupe by content", () => {
  const a = css({ one: "color:red", two: "color:red", three: "color:blue" });
  assert.equal(a.one, a.two);
  assert.notEqual(a.one, a.three);
  const b = css({ again: "color:red" });
  assert.equal(b.again, a.one);
});

test("css(): a state or pseudo-element rule attaches to its class and adds no key", () => {
  const before = inserted.length;
  const s = css({ btn: "color:#aaa", "btn:hover": "color:#fff", "btn::after": "content:'>'", "btn:not(:last-child)": "margin-right:4px" });
  assert.deepEqual(Object.keys(s), ["btn"]);
  const mine = inserted.slice(before);
  assert.ok(mine.includes(`.${s.btn}{color:#aaa}`));
  assert.ok(mine.includes(`.${s.btn}:hover{color:#fff}`));
  assert.ok(mine.includes(`.${s.btn}::after{content:'>'}`));
  assert.ok(mine.includes(`.${s.btn}:not(:last-child){margin-right:4px}`));
});

test("css(): a class with states gets a name of its own, so the state can't leak", () => {
  const plain = css({ grey: "color:#aaa" });
  const withHover = css({ link: "color:#aaa", "link:hover": "color:#fff" });
  assert.notEqual(plain.grey, withHover.link, "same declarations, but one has a hover rule");
  const again = css({ link: "color:#aaa", "link:hover": "color:#fff" });
  assert.equal(again.link, withHover.link, "the same call twice still dedupes");
  const n = inserted.length;
  css({ link: "color:#aaa", "link:hover": "color:#fff" });
  assert.equal(inserted.length, n, "and inserts nothing new");
});

test("css(): at-rules are inserted once, verbatim, and add no key", () => {
  const n = inserted.length;
  const s = css({ "@keyframes blink": "50%{opacity:0}", caret: "animation:blink 1s infinite", "@media (max-width: 700px)": ".x{display:none}" });
  assert.deepEqual(Object.keys(s), ["caret"]);
  assert.ok(inserted.includes("@keyframes blink{50%{opacity:0}}"));
  assert.ok(inserted.includes("@media (max-width: 700px){.x{display:none}}"));
  css({ "@keyframes blink": "50%{opacity:0}" });
  assert.equal(inserted.filter((r) => r.startsWith("@keyframes blink")).length, 1);
  assert.equal(inserted.length, n + 3);
});

test("css(): a state whose class is not in the same call is ignored, not thrown", () => {
  const s = css({ "ghost:hover": "color:red" });
  assert.deepEqual(s, {});
});
