// docs-truth: the docs an AI session follows must not point at things that
// don't exist. Checks, for each doc below:
//   1. every repo-looking path in `backticks` exists (a bare file name must
//      exist somewhere in the repo; a path with a slash must exist exactly);
//   2. every `npm run <script>` / `npm <script>` names a real package.json
//      script;
//   3. every patcher op the docs list is exported by tooling/patcher.js;
//   4. every public API name the docs list is exported by the module the
//      docs say it lives in, and every export of fried.js,
//      tooling/patcher.js and addons/server/*.js is mentioned in
//      docs/framework-api.md.
// Failure messages name the doc, the line and the offending text. When a
// doc is wrong, fix the doc, not this test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["CLAUDE.md", "README.md", "docs/framework-api.md", "docs/known-limitations.md"];

// Deliberate non-repo paths. Every entry says why it is allowed.
const IGNORED_PATHS = new Map([
  ["path/to/app.js", "placeholder for the reader's own app file"],
  ["benchmark/results/results.md", "historical: the pre-merge token-efficiency benchmark, not in this repo (known-limitations.md says so)"],
  ["verify.mjs", "historical: a pre-merge stress script, not in this repo (known-limitations.md says so)"],
  ["tests/browser-verify.mjs", "historical: a pre-merge Playwright check, not in this repo (known-limitations.md says so)"],
  ["tests/patcher.test.js", "historical: a pre-merge test file, not in this repo (known-limitations.md says so)"],
]);

// npm commands that are npm built-ins, not package.json scripts.
const NPM_BUILTINS = new Set(["install", "i", "ci", "init", "ls", "link", "publish", "run"]);

// Bullets in framework-api.md that document a method of a returned object,
// not a module export.
const METHOD_BULLETS = new Set(["collections", "attach", "slice"]);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;
const where = (doc, text, offset) => {
  const n = lineOf(text, offset);
  return `${doc}:${n}: ${text.split("\n")[n - 1].trim()}`;
};

// Blank out fenced code blocks (keeping newlines, so line numbers hold):
// they hold example code, not claims about the repo layout.
function proseOnly(text) {
  return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
}

function exportsOf(rel) {
  const ast = parse(read(rel), { ecmaVersion: "latest", sourceType: "module" });
  const names = new Set();
  for (const node of ast.body) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration?.id) names.add(node.declaration.id.name);
      for (const d of node.declaration?.declarations ?? []) names.add(d.id.name);
      for (const s of node.specifiers) names.add(s.exported.name);
    } else if (node.type === "ExportDefaultDeclaration") {
      names.add("default");
    }
  }
  return names;
}

// Every file in the repo by base name (for bare names like `fried-db.js`).
function repoFiles() {
  const byBase = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else byBase.set(e.name, [...(byBase.get(e.name) ?? []), full]);
    }
  };
  walk(ROOT);
  return byBase;
}

const PATH_TOKEN = /^\.{0,2}\/?[\w.-]+(\/[\w.-]+)*(\.(js|mjs|cjs|md|json|sh|html|css)|\/)$/;

test("docs-truth: every backticked repo path in the docs exists", () => {
  const byBase = repoFiles();
  const wrong = [];
  for (const doc of DOCS) {
    const text = read(doc);
    for (const m of proseOnly(text).matchAll(/`([^`]+)`/g)) {
      for (let token of m[1].split(/\s+/)) {
        if (!PATH_TOKEN.test(token) || token.includes("://")) continue;
        token = token.replace(/^\.\//, "");
        if (IGNORED_PATHS.has(token)) continue;
        const ok = token.includes("/")
          ? fs.existsSync(path.join(ROOT, token))
          : byBase.has(token);
        if (!ok) wrong.push(`${where(doc, text, m.index)}\n    -> \`${token}\` does not exist in the repo`);
      }
    }
  }
  assert.deepEqual(wrong, [], "dead paths in the docs:\n" + wrong.join("\n"));
});

test("docs-truth: every npm script the docs mention exists in package.json", () => {
  const scripts = JSON.parse(read("package.json")).scripts ?? {};
  const wrong = [];
  for (const doc of DOCS) {
    const text = read(doc);
    // Only commands written as code (fenced blocks or `inline`), so prose
    // like "npm script" isn't mistaken for one.
    const code = [...text.matchAll(/```[\s\S]*?```|`[^`]+`/g)].map((c) => [c.index, c.index + c[0].length]);
    for (const m of text.matchAll(/\bnpm\s+(?:run\s+)?([a-z][\w:-]*)/g)) {
      if (!code.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const name = m[1];
      if (NPM_BUILTINS.has(name) || name in scripts) continue;
      wrong.push(`${where(doc, text, m.index)}\n    -> "${name}" is not a package.json script`);
    }
  }
  assert.deepEqual(wrong, [], "missing npm scripts:\n" + wrong.join("\n"));
});

// framework-api.md sections, by heading, mapped to the module they document.
function apiSections() {
  const text = read("docs/framework-api.md");
  const sections = [];
  let current = { module: "fried.js", start: 0 };
  for (const m of text.matchAll(/^## (.*)$/gm)) {
    current.end = m.index;
    sections.push(current);
    const h = m[1];
    const module = h.startsWith("fried-db.js") ? "addons/fried-db.js"
      : h.startsWith("fried-virtual.js") ? "addons/fried-virtual.js"
      : h.startsWith("fried-router.js") ? "addons/fried-router.js"
      : h.startsWith("fried-score.js") ? "addons/server/fried-score.js"
      : h.startsWith("fried-serve.js") ? "addons/server/fried-serve.js"
      : h.startsWith("fried-tools.js") ? "addons/server/fried-tools.js"
      : h.startsWith("fried-proc.js") ? "addons/server/fried-proc.js"
      : h.startsWith("Patch API") ? "tooling/patcher.js"
      : h.startsWith("More fried.js exports") ? "fried.js"
      : null;
    current = { module, start: m.index };
  }
  current.end = text.length;
  sections.push(current);
  return { text, sections };
}

test("docs-truth: every API bullet in framework-api.md is a real export of its module", () => {
  const { text, sections } = apiSections();
  const wrong = [];
  for (const s of sections) {
    if (!s.module) continue;
    const exported = exportsOf(s.module);
    const body = text.slice(s.start, s.end);
    for (const m of body.matchAll(/^- `([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      if (METHOD_BULLETS.has(name) || exported.has(name)) continue;
      wrong.push(`${where("docs/framework-api.md", text, s.start + m.index)}\n    -> "${name}" is not exported by ${s.module}`);
    }
  }
  assert.deepEqual(wrong, [], "documented but not exported:\n" + wrong.join("\n"));
});

test("docs-truth: the API and patcher-op lists in CLAUDE.md are real exports", () => {
  const text = read("CLAUDE.md");
  const fried = exportsOf("fried.js");
  const patcher = exportsOf("tooling/patcher.js");
  const db = exportsOf("addons/fried-db.js");
  const wrong = [];
  const check = (label, re, has) => {
    const m = text.match(re);
    if (!m) return wrong.push(`CLAUDE.md: could not find the ${label} list (did its wording change? update this test's pattern)`);
    for (const n of m[1].matchAll(/`([A-Za-z_$][\w$]*)`/g)) {
      if (!has(n[1])) wrong.push(`${where("CLAUDE.md", text, m.index)}\n    -> "${n[1]}" in the ${label} list is not exported`);
    }
  };
  check("fried.js API", /- `fried\.js` -- the framework itself \(([^)]*)\)/, (n) => fried.has(n));
  check("patcher op", /- `tooling\/patcher\.js` -- AST-based patch functions \(([^)]*)\)/, (n) => patcher.has(n));
  check("\"Don't invent\" API", /\*\*Don't invent new framework functions\.\*\*([\s\S]*?)are the entire API/, (n) => fried.has(n) || db.has(n));
  assert.deepEqual(wrong, [], "CLAUDE.md lists names that are not exported:\n" + wrong.join("\n"));
});

test("docs-truth: every export of fried.js, tooling/patcher.js and the server addons is documented", () => {
  const api = read("docs/framework-api.md");
  const missing = [];
  for (const rel of ["fried.js", "tooling/patcher.js", "addons/server/fried-score.js", "addons/server/fried-serve.js",
    "addons/server/fried-tools.js", "addons/server/fried-proc.js"]) {
    for (const name of exportsOf(rel)) {
      if (!new RegExp("`" + name.replace(/\$/g, "\\$") + "[`(]").test(api)) {
        missing.push(`${rel} exports "${name}" but docs/framework-api.md never mentions \`${name}\``);
      }
    }
  }
  assert.deepEqual(missing, [], "undocumented exports:\n" + missing.join("\n"));
});
