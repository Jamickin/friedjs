#!/usr/bin/env node
// fried.map -- an ultra-compact, machine-readable index of an app.js
// file's state, actions, addressable ui() keys, and other top-level
// consts/functions.
//
// The point: before writing a patch, an AI needs to know what names
// exist to target -- which action to reference, which key to address,
// which const to remove. Reading the whole file to find out defeats the
// purpose of patching instead of rewriting. This gives it that answer in
// a handful of tokens instead.
//
// This is a companion to check-keys.mjs, not a replacement: check-keys
// prints a full, line-numbered, human-readable report on key
// addressability alone. This prints one compact line per category,
// across everything patchable in the file, meant to sit in an AI's
// context, not to be read by a person scanning a terminal.
//
// Usage: node tooling/fried-map.mjs [path/to/app.js]   (defaults to app.js)
import { parse } from "acorn";
import * as walk from "acorn-walk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Builds the map from source text (pure, no filesystem access -- this is
 * the part tests exercise directly). Returns
 * { state, actions, keys, consts, funcs, templates, dynamicKeyCount,
 *   duplicateKeys, crossTemplateKeys }.
 */
export function buildFriedMap(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });

  const state = [];
  const actions = [];
  const consts = [];
  const funcs = [];
  const exportedFuncs = [];

  function calleeName(node) {
    return node && node.type === "CallExpression" && node.callee.type === "Identifier"
      ? node.callee.name
      : null;
  }

  for (const outer of ast.body) {
    const exported = outer.type === "ExportNamedDeclaration";
    const node = exported ? outer.declaration : outer;
    if (node?.type === "FunctionDeclaration" && node.id) {
      funcs.push(node.id.name);
      if (exported) exportedFuncs.push(node.id.name);
      continue;
    }
    if (node.type !== "VariableDeclaration") continue;
    for (const decl of node.declarations) {
      if (decl.id.type !== "Identifier" || !decl.init) continue;
      const name = decl.id.name;
      const exportedValue = exported && (decl.init.type === "ArrowFunctionExpression" || decl.init.type === "FunctionExpression");
      if (exportedValue) {
        funcs.push(name);
        exportedFuncs.push(name);
      }
      const callee = calleeName(decl.init);
      if (callee === "state") {
        state.push(name);
      } else if (callee === "action") {
        const labelArg = decl.init.arguments[0];
        const label = labelArg && labelArg.type === "Literal" ? labelArg.value : null;
        // Flag it only when the action's string label (used purely for
        // patch-addressing readability, never at runtime) doesn't match
        // the variable name -- CLAUDE.md's own convention is to keep
        // them the same, so a mismatch is worth surfacing, not hiding.
        actions.push(label != null && label !== name ? `${name}(${label})` : name);
      } else {
        consts.push(name);
      }
    }
  }

  // Which top-level named function (if any) a given source position falls
  // inside -- used below to tell "the same key reused inside one template,
  // a same-scope hazard no `within` scoping can fix" apart from "the same
  // key used by two *different* templates, exactly what patcher.js's
  // `within` param (see tooling/patcher.js) exists to disambiguate."
  const topLevelFns = funcs.length
    ? ast.body
        .map((n) => (n.type === "ExportNamedDeclaration" ? n.declaration : n))
        .filter((n) => n && n.type === "FunctionDeclaration" && n.id)
    : [];
  function ownerFnName(pos) {
    for (const fn of topLevelFns) {
      if (pos >= fn.start && pos < fn.end) return fn.id.name;
    }
    return null;
  }

  // A "template" is a top-level named function passed BY REFERENCE to
  // `.map(...)` (`items.value.map(renderItem)`) -- the addressing
  // convention `addTemplateChild`/`setTemplateProp` in tooling/patcher.js rely
  // on. An inline arrow (`items.value.map((it) => ...)`) is intentionally
  // NOT picked up here: it has no name for those ops to find it by, same
  // reason replaceFunction only matches a named top-level `function`.
  const templates = new Set();
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== "MemberExpression" || node.callee.computed) return;
      if (node.callee.property.type !== "Identifier" || node.callee.property.name !== "map") return;
      const arg = node.arguments[0];
      if (arg && arg.type === "Identifier" && funcs.includes(arg.name)) templates.add(arg.name);
    },
  });

  // Nesting: does a template's OWN body contain another template's
  // `.map()` call (or a direct call to another template/component
  // function)? Not needed for addTemplateChild/setTemplateProp to work --
  // they already address either one independently by its own name,
  // regardless of nesting -- but worth surfacing so an AI doesn't have to
  // read the source to find out a category template renders an item
  // template inside it, say. Reported per outer template as the list of
  // OTHER templates referenced within its own function body's range.
  const templateNesting = new Map(); // outer template name -> [nested template names]
  if (templates.size > 1) {
    for (const fn of topLevelFns) {
      if (!templates.has(fn.id.name)) continue;
      const nested = [...templates].filter((t) => t !== fn.id.name && ownerFnName(findMapCallStart(ast, t, fn)) !== null);
      if (nested.length) templateNesting.set(fn.id.name, nested);
    }
  }
  // Finds the source position of a `.map(templateName)` call, used only
  // to test whether it falls inside a given outer function's range above.
  function findMapCallStart(ast, templateName, outerFn) {
    let found = null;
    walk.simple(outerFn, {
      CallExpression(node) {
        if (found) return;
        if (node.callee.type !== "MemberExpression" || node.callee.computed) return;
        if (node.callee.property.type !== "Identifier" || node.callee.property.name !== "map") return;
        const arg = node.arguments[0];
        if (arg && arg.type === "Identifier" && arg.name === templateName) found = node.start;
      },
    });
    return found;
  }

  // A top-level `const <name> = css({...})` -- addressable by
  // setCssRule/removeCssRule (tooling/patcher.js), keyed by the rule names it
  // currently defines, so an AI knows what's there to target without
  // reading the call site itself.
  const cssVars = [];
  for (const node of ast.body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const d of node.declarations) {
      if (
        d.id.type !== "Identifier" || !d.init || d.init.type !== "CallExpression" ||
        d.init.callee.type !== "Identifier" || d.init.callee.name !== "css"
      ) continue;
      const arg = d.init.arguments[0];
      const rules = arg && arg.type === "ObjectExpression"
        ? arg.properties.filter((p) => p.type === "Property").map((p) => (p.key.type === "Identifier" ? p.key.name : p.key.value))
        : [];
      cssVars.push({ name: d.id.name, rules });
    }
  }

  // walk.simple visits post-order (a node's own visitor fires only after
  // its children's), so an outer ui(...) call's key would otherwise land
  // *after* all of its nested children's keys in the collected list --
  // technically complete, but confusing to read since it wouldn't follow
  // the file's own top-to-bottom layout. Collecting {key, start} and
  // sorting by source position fixes that without needing a different
  // (and otherwise unnecessary) traversal strategy.
  const foundKeys = [];
  let dynamicKeyCount = 0;

  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== "Identifier" || node.callee.name !== "ui") return;
      const propsArg = node.arguments[1];
      const keyProp = propsArg && propsArg.type === "ObjectExpression"
        ? propsArg.properties.find((p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key")
        : null;
      if (!keyProp) return;
      if (keyProp.value.type === "Literal") {
        foundKeys.push({ key: keyProp.value.value, start: keyProp.value.start, owner: ownerFnName(keyProp.value.start) });
      } else {
        dynamicKeyCount++;
      }
    },
  });
  foundKeys.sort((a, b) => a.start - b.start);
  const staticKeys = foundKeys.map((k) => k.key);

  const keyOccurrences = new Map(); // key -> [owner, owner, ...] (null = top-level/outside any named fn)
  for (const { key, owner } of foundKeys) {
    if (!keyOccurrences.has(key)) keyOccurrences.set(key, []);
    keyOccurrences.get(key).push(owner);
  }
  const duplicateKeys = [...keyOccurrences.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([k, owners]) => [k, owners.length]);
  // Specifically: duplicates whose occurrences span more than one distinct
  // owning scope (two different template functions, or a template and the
  // top level) -- these are exactly what patcher.js's `within` param
  // resolves; a duplicate confined to a single scope isn't (renaming one
  // of them is the only real fix), so it's left out of this list.
  const crossTemplateKeys = [...keyOccurrences.entries()]
    .filter(([, owners]) => owners.length > 1 && new Set(owners).size > 1)
    .map(([k, owners]) => [k, owners.map((o) => o ?? "(top level)")]);

  return {
    state, actions, keys: staticKeys, consts, funcs, exportedFuncs,
    templates: [...templates],
    templateNesting: [...templateNesting.entries()].map(([outer, nested]) => [outer, nested]),
    cssVars, dynamicKeyCount, duplicateKeys, crossTemplateKeys,
    ...buildServerMap(ast),
  };
}

// -- Server files (addons/server/) ------------------------------------
// Tool registries and HTTP routes have names, not ui() keys, so they get
// their own lines: REG: (createToolRegistry calls), TOOLS: (tool
// definitions by group -- what addTool/setToolDescription/setToolInput in
// tooling/patcher.js address) and ROUTES: (route-table keys and inline
// `path === "/x"` branches). Same tool rule as the patcher: an object
// literal with at least two of description, input (or inputSchema), run.

const TOOL_FIELDS = [["description"], ["input", "inputSchema"], ["run"]];
const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//;
const PATH_NAMES = new Set(["path", "pathname", "url", "route"]);

function keyName(p) {
  if (p.type !== "Property" || p.computed) return null;
  return p.key.type === "Identifier" ? p.key.name : typeof p.key.value === "string" ? p.key.value : null;
}

function isToolDef(node) {
  if (!node || node.type !== "ObjectExpression") return false;
  return TOOL_FIELDS.filter((names) => node.properties.some((p) => names.includes(keyName(p)))).length >= 2;
}

function isRegistryCall(node) {
  return node && node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "createToolRegistry";
}

function ownerName(node, parent) {
  if (!parent) return null;
  if (parent.type === "VariableDeclarator" && parent.init === node && parent.id.type === "Identifier") return parent.id.name;
  if (parent.type === "Property" && parent.value === node) return keyName(parent);
  if (parent.type === "AssignmentExpression" && parent.right === node && parent.left.type === "Identifier") return parent.left.name;
  if (isRegistryCall(parent)) {
    const n = parent.arguments[0];
    return n && n.type === "Literal" && typeof n.value === "string" ? n.value : null;
  }
  return null;
}

// `req.method === "POST"` (either side) -> "POST".
function methodOf(node) {
  if (!node || node.type !== "BinaryExpression" || (node.operator !== "===" && node.operator !== "==")) return null;
  const pairs = [[node.left, node.right], [node.right, node.left]];
  for (const [a, b] of pairs) {
    if (a.type === "MemberExpression" && !a.computed && a.property.name === "method" && b.type === "Literal" && typeof b.value === "string") return b.value.toUpperCase();
  }
  return null;
}

function isPathExpr(node) {
  if (!node) return false;
  if (node.type === "Identifier") return PATH_NAMES.has(node.name);
  return node.type === "MemberExpression" && !node.computed && PATH_NAMES.has(node.property.name);
}

// The method a route test is guarded by: a `x.method === "M"` operand of
// the same && chain the test sits in. No guard reads as GET.
function guardMethod(ancestors) {
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type !== "LogicalExpression" || a.operator !== "&&") break;
    const stack = [a];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === "LogicalExpression" && n.operator === "&&") stack.push(n.left, n.right);
      else if (methodOf(n)) return methodOf(n);
    }
  }
  return "GET";
}

function buildServerMap(ast) {
  const tools = [];
  const groups = [];
  const routes = [];
  const registries = [];

  walk.ancestor(ast, {
    ObjectExpression(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      const defs = node.properties.filter((p) => keyName(p) !== null && isToolDef(p.value));
      if (defs.length) {
        const group = ownerName(node, parent);
        groups.push({ group, start: node.start, enclosing: ancestors.find((a) => a.type === "FunctionDeclaration" && a.id)?.id.name ?? null });
        for (const p of defs) tools.push({ name: keyName(p), group, start: p.start });
      }
      // A route table: `routes: {...}` or `const routes = {...}`.
      if (ownerName(node, parent) === "routes" && !isRegistryCall(parent)) {
        for (const p of node.properties) {
          const k = keyName(p);
          if (k && METHOD_RE.test(k)) routes.push({ route: k.replace(/\s+/, " "), start: p.start });
          else if (k && k.startsWith("/")) routes.push({ route: `GET ${k}`, start: p.start });
        }
      }
    },
    BinaryExpression(node, _state, ancestors) {
      if (node.operator !== "===" && node.operator !== "==") return;
      for (const [a, b] of [[node.left, node.right], [node.right, node.left]]) {
        if (isPathExpr(a) && b.type === "Literal" && typeof b.value === "string" && b.value.startsWith("/")) {
          routes.push({ route: `${guardMethod(ancestors)} ${b.value}`, start: node.start });
        }
      }
    },
    CallExpression(node, _state, ancestors) {
      if (isRegistryCall(node)) {
        const n = node.arguments[0];
        const name = n && n.type === "Literal" && typeof n.value === "string" ? n.value : "?";
        const arg = node.arguments[1];
        let names = [];
        if (arg && arg.type === "Identifier") names = [arg.name];
        else if (arg && arg.type === "ObjectExpression" && !arg.properties.some((p) => isToolDef(p.value))) {
          names = arg.properties.map(keyName).filter(Boolean);
        }
        registries.push({ name, groups: names, start: node.start });
        return;
      }
      // `path.startsWith("/ui/")` -> "GET /ui/*".
      const c = node.callee;
      const lit = node.arguments[0];
      if (c.type === "MemberExpression" && !c.computed && c.property.name === "startsWith" && isPathExpr(c.object) &&
          lit && lit.type === "Literal" && typeof lit.value === "string" && lit.value.startsWith("/")) {
        routes.push({ route: `${guardMethod(ancestors)} ${lit.value}*`, start: node.start });
      }
    },
  });

  // Two or more role groups with no createToolRegistry call in the file
  // are still a registry: named after the function holding them
  // (Orchestra's createTools), or "(file)" at the top level.
  if (!registries.length) {
    const byOwner = new Map();
    for (const g of groups) {
      if (g.group === null) continue;
      const owner = g.enclosing ?? "(file)";
      if (!byOwner.has(owner)) byOwner.set(owner, { name: owner, groups: [], start: g.start });
      const r = byOwner.get(owner);
      if (!r.groups.includes(g.group)) r.groups.push(g.group);
    }
    for (const r of byOwner.values()) if (r.groups.length > 1) registries.push(r);
  }

  const seen = new Set();
  return {
    registries: registries.sort((a, b) => a.start - b.start).map(({ name, groups: g }) => ({ name, groups: g })),
    tools: tools.sort((a, b) => a.start - b.start).map(({ name, group }) => ({ name, group })),
    routes: routes.sort((a, b) => a.start - b.start).map((r) => r.route).filter((r) => !seen.has(r) && seen.add(r)),
  };
}

/** Formats the map as the compact multi-line text an AI reads directly. */
export function formatFriedMap(map) {
  const lines = [];
  if (map.state.length) lines.push(`S: ${map.state.join(" ")}`);
  if (map.actions.length) lines.push(`A: ${map.actions.join(" ")}`);
  if (map.keys.length) lines.push(`K: ${map.keys.join(" ")}`);
  if (map.consts.length) lines.push(`C: ${map.consts.join(" ")}`);
  if (map.funcs.length) {
    const exported = new Set(map.exportedFuncs ?? []);
    lines.push(`F: ${map.funcs.map((name) => exported.has(name) ? `${name}(exported)` : name).join(" ")}`);
  }
  if (map.templates.length) {
    // Named .map() render templates -- not addressable by key (their own
    // wrapper's key is necessarily dynamic), but addressable by function
    // name via addTemplateChild/setTemplateProp in tooling/patcher.js. A
    // "name(> nested1 nested2)" suffix means that template's own body
    // contains another template's .map() call -- purely informational,
    // addTemplateChild/setTemplateProp already reach either one
    // independently regardless of nesting; this just saves reading the
    // source to find out the shape.
    const text = map.templates.map((t) => {
      const nested = map.templateNesting.find(([outer]) => outer === t)?.[1];
      return nested?.length ? `${t}(> ${nested.join(" ")})` : t;
    }).join(" ");
    lines.push(`T: ${text}`);
  }
  if (map.cssVars.length) {
    // Top-level css({...}) calls -- addressable by setCssRule/
    // removeCssRule (tooling/patcher.js), a subset of C: above, listed here
    // with the rule names each one currently defines.
    const text = map.cssVars.map(({ name, rules }) => `${name}(${rules.join(" ")})`).join(" ");
    lines.push(`CSS: ${text}`);
  }
  if (map.registries?.length) {
    // createToolRegistry calls (or role groups that form one), with their groups.
    lines.push(`REG: ${map.registries.map(({ name, groups }) => (groups.length ? `${name}(${groups.join(" ")})` : name)).join(" ")}`);
  }
  if (map.tools?.length) {
    // Tool definitions, by group in first-seen order; ungrouped ones last.
    // addTool/setToolDescription/setToolInput (tooling/patcher.js) address
    // these by name, and need the group when a name is in more than one.
    const order = [];
    const byGroup = new Map();
    for (const { name, group } of map.tools) {
      if (!byGroup.has(group)) { byGroup.set(group, []); order.push(group); }
      byGroup.get(group).push(name);
    }
    const text = [...order.filter((g) => g !== null), ...order.filter((g) => g === null)]
      .map((g) => (g === null ? byGroup.get(g).join(" ") : `${g}(${byGroup.get(g).join(" ")})`)).join(" ");
    lines.push(`TOOLS: ${text}`);
  }
  if (map.routes?.length) lines.push(`ROUTES: ${map.routes.join(" ")}`);
  if (map.dynamicKeyCount) {
    lines.push(`(+ ${map.dynamicKeyCount} dynamic-keyed list item${map.dynamicKeyCount === 1 ? "" : "s"}, not individually patchable -- see check-keys)`);
  }
  if (map.duplicateKeys.length) {
    // A real correctness hazard, not just a style note: patcher.js finds
    // a key via a Map (last one wins), so a duplicate key silently makes
    // one of those ui() nodes unreachable by the patcher -- worth
    // surfacing here rather than letting it fail confusingly later.
    const dupText = map.duplicateKeys.map(([k, n]) => `${k}(${n}x)`).join(" ");
    lines.push(`! duplicate keys, patcher only reaches the last one: ${dupText}`);
  }
  if (map.crossTemplateKeys.length) {
    // The subset of duplicateKeys that IS fixable without a rename: pass
    // within: "<template fn name>" to setProp/setChildText/addChild/
    // removeChild/replaceChild to pick the right one.
    const text = map.crossTemplateKeys.map(([k, owners]) => `${k}(${owners.join(", ")})`).join(" ");
    lines.push(`! same key used by different templates, disambiguate with within: "<fn>": ${text}`);
  }
  return lines.join("\n");
}

// CLI entry point -- only runs when this file is executed directly, not
// when buildFriedMap/formatFriedMap are imported (by tests, or anything
// else that wants the map programmatically). Comparing decoded filesystem
// paths (via fileURLToPath) rather than raw strings against a hand-built
// `file://${...}` URL matters here specifically: a path containing a
// space or other reserved character (this folder is literally named
// "fried-app copy") gets percent-encoded in import.meta.url but not in
// process.argv[1], so a naive string comparison silently never matches --
// found by actually running this on the real folder, not a clean tmp path.
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] || "app.js";
  if (!fs.existsSync(target)) {
    console.error(`No such file: ${target}`);
    process.exit(1);
  }
  const source = fs.readFileSync(target, "utf8");
  console.log(formatFriedMap(buildFriedMap(source)));
}
