#!/usr/bin/env node
// Reports which ui(...) call sites in a fried.js app file are addressable by
// patcher.js (a static string `key`) versus not, so you can verify a file
// is actually patchable before relying on patcher.js against it.
//
// Usage: node scripts/check-keys.mjs [path/to/app.js]   (defaults to app.js)
import { parse } from "acorn";
import * as walk from "acorn-walk";
import fs from "fs";

const target = process.argv[2] || "app.js";
if (!fs.existsSync(target)) {
  console.error(`No such file: ${target}`);
  process.exit(1);
}
const source = fs.readFileSync(target, "utf8");
const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });

const staticKeys = [];
const dynamicKeyed = [];
const unkeyedContainers = [];
const funcNames = new Set();

for (const node of ast.body) {
  const decl = node.type === "ExportNamedDeclaration" ? node.declaration : node;
  if (decl && decl.type === "FunctionDeclaration" && decl.id) funcNames.add(decl.id.name);
}

// A named top-level function passed BY REFERENCE to .map(...) -- e.g.
// `items.value.map(renderItem)` -- is a "template": not addressable by key
// (its own wrapper's key is necessarily dynamic, for the runtime's
// per-item identity tracking), but addressable by its function name via
// addTemplateChild/setTemplateProp in src/patcher.js. Recorded by line so
// it's reported alongside the dynamic-keyed root it wraps, below.
const templates = new Map(); // fn name -> line of the ui() it returns, once found
walk.simple(ast, {
  CallExpression(node) {
    if (node.callee.type !== "MemberExpression" || node.callee.computed) return;
    if (node.callee.property.type !== "Identifier" || node.callee.property.name !== "map") return;
    const arg = node.arguments[0];
    if (arg && arg.type === "Identifier" && funcNames.has(arg.name)) templates.set(arg.name, null);
  },
});

walk.simple(ast, {
  CallExpression(node) {
    if (node.callee.type !== "Identifier" || node.callee.name !== "ui") return;
    const [tagArg, propsArg, childrenArg] = node.arguments;
    const tag = tagArg && tagArg.type === "Literal" ? tagArg.value : "<dynamic tag>";
    const line = source.slice(0, node.start).split("\n").length;

    const keyProp = propsArg && propsArg.type === "ObjectExpression"
      ? propsArg.properties.find(p => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key")
      : null;

    if (keyProp && keyProp.value.type === "Literal") {
      staticKeys.push({ tag, line, key: keyProp.value.value });
    } else if (keyProp) {
      dynamicKeyed.push({ tag, line });
    } else if (childrenArg && childrenArg.type === "ArrayExpression" && childrenArg.elements.length > 0) {
      // Only flag containers with actual children -- leaf elements
      // (buttons, spans, etc.) usually don't need to be individually
      // addressable, so don't generate noise for those.
      unkeyedContainers.push({ tag, line });
    }
  }
});

console.log(`\n${target}: patcher-addressability report\n`);

console.log(`Static keys (addressable by patcher.js) -- ${staticKeys.length}`);
for (const { tag, line, key } of staticKeys) console.log(`  line ${line}: ui("${tag}", { key: "${key}" }, ...)`);

console.log(`\nDynamic-template functions (addressable by name via addTemplateChild/setTemplateProp) -- ${templates.size}`);
for (const name of templates.keys()) console.log(`  function ${name}(...) { return ui(...); }`);
if (templates.size === 0) {
  console.log(`  (none -- an inline arrow passed to .map() has no name to address it by; ` +
    `pull it out to a named top-level function to make its wrapper addressable)`);
}

console.log(`\nDynamic keys (list items -- correct, but NOT individually addressable by key) -- ${dynamicKeyed.length}`);
for (const { tag, line } of dynamicKeyed) console.log(`  line ${line}: ui("${tag}", ...)`);

console.log(`\nUnkeyed containers (consider adding a static key if you'll want to patch these later) -- ${unkeyedContainers.length}`);
for (const { tag, line } of unkeyedContainers) console.log(`  line ${line}: ui("${tag}", ...)`);

console.log("");
