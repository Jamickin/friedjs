// A real AST-based patcher for fried.js apps -- no hand-rolled grammar,
// just acorn (a standard JS parser) to find the exact node a patch targets
// and magic-string to rewrite only that byte range, leaving everything
// else in the file untouched (comments, formatting, unrelated code).
//
// Addressing relies entirely on the two conventions fried.js's API
// encourages: action(name, fn) and ui(tag, {key, ...}, children). A patch
// never has to parse or understand the surrounding code, it just finds
// the one call site with a matching name/key.
import { parse } from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";

export class PatchError extends Error {}

function parseSource(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

/** Every `ui(tag, {key: "...", ...}, children)` call site, grouped by key. */
function findUiCallsByKey(ast) {
  const found = new Map();
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== "Identifier" || node.callee.name !== "ui") return;
      const propsArg = node.arguments[1];
      if (!propsArg || propsArg.type !== "ObjectExpression") return;
      const keyProp = propsArg.properties.find(
        (p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key" && p.value.type === "Literal"
      );
      if (!keyProp) return;
      const k = keyProp.value.value;
      (found.get(k) ?? found.set(k, []).get(k)).push(node);
    },
  });
  return found;
}

// A key is meant to address exactly one ui(...) call, same as a React list
// key. If the source has two call sites sharing a key, a lookup by that key
// is ambiguous: a caller asking to patch "the element with key x" has no way
// to say *which* one they meant, and silently picking one (the first, the
// last, whichever the Map happened to keep) means the patch can land on the
// wrong element with no signal that anything was wrong -- found empirically
// while stress-testing setProp() against source with a duplicated key.
function requireUiNode(ast, key) {
  const nodes = findUiCallsByKey(ast).get(key);
  if (!nodes) throw new PatchError(`no ui(...) call found with key "${key}"`);
  if (nodes.length > 1) throw new PatchError(`key "${key}" is ambiguous: ${nodes.length} ui(...) calls share it`);
  return nodes[0];
}

// Insertions go right before a closing "}" or "]". Whether a leading
// comma is needed depends on whether the source already ends in a
// trailing comma there (a real style choice callers may or may not have
// made), not just on whether the list is non-empty -- an earlier version
// of this got that wrong and produced a double comma when the source
// already had a trailing one. Caught by the patcher's own test suite.
// Computes where and what to insert to add one more item to an existing
// object's properties or an array's elements. Two things make this fiddly
// enough to need its own function and its own tests: whether the source
// already ends in a trailing comma before the closing bracket (adding a
// leading comma unconditionally double-commas), and whether the existing
// items are laid out one per line (jamming a new one onto the closing
// bracket's line is valid JS but ugly, and staying readable is the point).
function computeInsertion(source, containerNode, items, newText) {
  const closeAt = containerNode.end - 1; // position of the closing "}" / "]"
  if (items.length === 0) {
    return { insertAt: closeAt, text: newText };
  }
  const lastEnd = items[items.length - 1].end;
  const between = source.slice(lastEnd, closeAt);
  const commaMatch = between.match(/,/);
  const multiline = /\n/.test(between);
  let indent = "";
  if (multiline) {
    const lineStart = source.lastIndexOf("\n", items[items.length - 1].start) + 1;
    indent = source.slice(lineStart, items[items.length - 1].start);
  }
  if (commaMatch) {
    // A trailing comma already separates the last item from the closing
    // bracket -- insert right after it, so that existing comma/whitespace
    // leading into the bracket is left exactly as it was.
    const insertAt = lastEnd + commaMatch.index + 1;
    const text = multiline ? `\n${indent}${newText},` : ` ${newText},`;
    return { insertAt, text };
  }
  const text = multiline ? `,\n${indent}${newText}` : `, ${newText}`;
  return { insertAt: lastEnd, text };
}

/** Sets (or adds) a prop on the ui(...) call with the given key. */
export function setProp(source, key, propName, newValueSource) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key);
  const propsArg = node.arguments[1];
  const existing = propsArg.properties.find(
    (p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === propName
  );
  const ms = new MagicString(source);
  if (existing) {
    ms.overwrite(existing.value.start, existing.value.end, newValueSource);
  } else {
    const { insertAt, text } = computeInsertion(source, propsArg, propsArg.properties, `${propName}: ${newValueSource}`);
    ms.appendLeft(insertAt, text);
  }
  return ms.toString();
}

/** Replaces a literal string child of the ui(...) call with the given key. */
export function setChildText(source, key, oldText, newText) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key);
  const childrenArg = node.arguments[2];
  if (!childrenArg || childrenArg.type !== "ArrayExpression") {
    throw new PatchError(`ui(...) call with key "${key}" has no literal children array to edit`);
  }
  const target = childrenArg.elements.find((el) => el && el.type === "Literal" && el.value === oldText);
  if (!target) throw new PatchError(`no literal child "${JSON.stringify(oldText)}" found under key "${key}"`);
  const ms = new MagicString(source);
  ms.overwrite(target.start, target.end, JSON.stringify(newText));
  return ms.toString();
}

/**
 * Appends a new child expression (given as source text) to the ui(...) call
 * with the given key.
 *
 * Found empirically (the fried-js stopwatch blind test) that an inline
 * array literal isn't the only way children get passed -- an ordinary,
 * common pattern is building the list elsewhere and passing it by
 * reference (`const rows = items.map(...); ui("div", {key}, rows)`), and a
 * .map() call has no array literal anywhere to find, only an array it
 * produces at runtime. So this no longer requires an inline array literal:
 * - if the children argument already IS one, insert into it directly
 *   (unchanged from before, keeps formatting matching the existing layout).
 * - otherwise (an identifier, a direct .map()/.filter() call, a ternary,
 *   anything), rewrite the call site itself: `<expr>` becomes
 *   `[...(<expr>), newChild]`. This works no matter how the original
 *   expression produces its array, without tracing it back to wherever it
 *   was built, and never touches code outside this one ui(...) call.
 * - if there's no third argument at all, add one.
 */
export function addChild(source, key, newChildSource) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key);
  const childrenArg = node.arguments[2];
  const ms = new MagicString(source);

  if (childrenArg && childrenArg.type === "ArrayExpression") {
    const { insertAt, text } = computeInsertion(source, childrenArg, childrenArg.elements, newChildSource);
    ms.appendLeft(insertAt, text);
    return ms.toString();
  }

  if (childrenArg) {
    const originalText = source.slice(childrenArg.start, childrenArg.end);
    ms.overwrite(childrenArg.start, childrenArg.end, `[...(${originalText}), ${newChildSource}]`);
    return ms.toString();
  }

  const { insertAt, text } = computeInsertion(source, node, node.arguments, `[${newChildSource}]`);
  ms.appendLeft(insertAt, text);
  return ms.toString();
}

/** Inserts a new top-level statement right after `const <afterConstName> = ...`. */
export function addStatementAfter(source, afterConstName, newStatementSource) {
  const ast = parseSource(source);
  let target = null;
  for (const node of ast.body) {
    if (
      node.type === "VariableDeclaration" &&
      node.declarations.some((d) => d.id.type === "Identifier" && d.id.name === afterConstName)
    ) {
      target = node;
    }
  }
  if (!target) throw new PatchError(`no top-level const "${afterConstName}" found`);
  const ms = new MagicString(source);
  ms.appendLeft(target.end, `\n\n${newStatementSource}`);
  return ms.toString();
}

/**
 * Replaces an entire top-level function declaration, by name, with new
 * source text (signature included). Unlike the other operations, this
 * doesn't address through `ui()`/`action()` call sites -- it's for patching
 * a runtime's own internals (fried.js itself), where those conventions
 * don't apply. Only matches top-level declarations (`function name(...) {}`,
 * exported or not), same "no need to understand the surrounding code" rule
 * as addStatementAfter. The `export` keyword, if present, sits outside the
 * function node's range and is left untouched.
 */
export function replaceFunction(source, fnName, newFunctionSource) {
  const ast = parseSource(source);
  let target = null;
  for (const node of ast.body) {
    const decl = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (decl && decl.type === "FunctionDeclaration" && decl.id && decl.id.name === fnName) {
      target = decl;
    }
  }
  if (!target) throw new PatchError(`no top-level function declaration named "${fnName}" found`);
  const ms = new MagicString(source);
  ms.overwrite(target.start, target.end, newFunctionSource);
  return ms.toString();
}

/**
 * Removes a top-level declaration by name -- a function declaration
 * (`function name(...) {}`, exported or not) or a single-declarator
 * variable declaration (`const/let/var name = ...`). The natural inverse
 * of addStatementAfter()/replaceFunction()'s addressing: together the
 * three cover add/modify/remove for a runtime's own top-level
 * declarations, the way ui()-key and action()-name addressing cover
 * add/modify/remove for application code. Needed empirically: reverting a
 * helper function added earlier in the same session required falling back
 * to a raw string replace, since nothing in this file could remove a
 * declaration cleanly.
 *
 * A multi-declarator statement (`let a, b, c;`) is refused rather than
 * guessed at -- removing the whole statement to drop one name would
 * silently delete the others too, and this file's rule throughout is to
 * fail loudly on anything ambiguous rather than take the "probably right"
 * guess (see requireUiNode's duplicate-key check).
 */
export function removeStatement(source, name) {
  const ast = parseSource(source);
  let target = null;
  for (const node of ast.body) {
    const decl = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (!decl) continue;
    if (decl.type === "FunctionDeclaration" && decl.id && decl.id.name === name) {
      target = node;
    } else if (
      decl.type === "VariableDeclaration" &&
      decl.declarations.length === 1 &&
      decl.declarations[0].id.type === "Identifier" &&
      decl.declarations[0].id.name === name
    ) {
      target = node;
    } else if (decl.type === "VariableDeclaration" && decl.declarations.length > 1 && decl.declarations.some((d) => d.id.type === "Identifier" && d.id.name === name)) {
      throw new PatchError(`"${name}" shares a declaration with other names (e.g. "let a, b, c") -- removing the statement would delete those too`);
    }
  }
  if (!target) throw new PatchError(`no top-level declaration named "${name}" found`);
  const ms = new MagicString(source);
  let end = target.end;
  if (source.slice(end, end + 2) === "\n\n") end += 2;
  else if (source[end] === "\n") end += 1;
  ms.remove(target.start, end);
  return ms.toString();
}

/** Never trust a patched file without re-parsing it first. */
export function validate(source) {
  try {
    parseSource(source);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}


/** Removes a child from the ui(...) call if it is an inline ui(...) call with the given childKey. */
export function removeChild(source, parentKey, childKey) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, parentKey);
  const childrenArg = node.arguments[2];
  if (!childrenArg || childrenArg.type !== "ArrayExpression") {
    throw new PatchError(`ui(...) call with key "${parentKey}" has no literal children array`);
  }
  
  // Collect every match rather than stopping at the first: a duplicated
  // child key is ambiguous the same way a duplicated top-level key is (see
  // requireUiNode) and should fail loudly instead of silently removing
  // whichever one happens to be found first.
  const matches = [];
  for (let i = 0; i < childrenArg.elements.length; i++) {
    const el = childrenArg.elements[i];
    if (!el || el.type !== "CallExpression") continue;
    if (el.callee.type !== "Identifier" || el.callee.name !== "ui") continue;
    const propsArg = el.arguments[1];
    if (!propsArg || propsArg.type !== "ObjectExpression") continue;
    const keyProp = propsArg.properties.find(
      (p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key" && p.value.type === "Literal"
    );
    if (keyProp && keyProp.value.value === childKey) matches.push(i);
  }

  if (matches.length === 0) throw new PatchError(`no inline child ui(...) call with key "${childKey}" found under parent "${parentKey}"`);
  if (matches.length > 1) throw new PatchError(`child key "${childKey}" is ambiguous under parent "${parentKey}": ${matches.length} matches`);
  const targetIndex = matches[0];
  
  const ms = new MagicString(source);
  const target = childrenArg.elements[targetIndex];
  
  // Find the exact range to remove, including trailing/leading commas
  let start = target.start;
  let end = target.end;
  
  if (targetIndex > 0) {
    const prev = childrenArg.elements[targetIndex - 1];
    const between = source.slice(prev.end, target.start);
    const commaIdx = between.lastIndexOf(",");
    if (commaIdx !== -1) start = prev.end + commaIdx;
  } else if (targetIndex < childrenArg.elements.length - 1) {
    const next = childrenArg.elements[targetIndex + 1];
    const between = source.slice(target.end, next.start);
    const commaIdx = between.indexOf(",");
    if (commaIdx !== -1) end = target.end + commaIdx + 1;
  }
  
  ms.remove(start, end);
  return ms.toString();
}

// Does `pattern` (a param, or a piece of a destructured param) bind `name`?
// Covers the shapes real callback signatures actually use -- plain params,
// defaults, rest, and one level of array/object destructuring is enough for
// this to be a useful guard without becoming a full pattern-binding engine.
function patternDeclares(pattern, name) {
  if (!pattern) return false;
  switch (pattern.type) {
    case "Identifier": return pattern.name === name;
    case "AssignmentPattern": return patternDeclares(pattern.left, name);
    case "RestElement": return patternDeclares(pattern.argument, name);
    case "ArrayPattern": return pattern.elements.some((el) => patternDeclares(el, name));
    case "ObjectPattern":
      return pattern.properties.some((p) => patternDeclares(p.type === "RestElement" ? p.argument : p.value, name));
    default: return false;
  }
}

// Best-effort shadow check, not full scope resolution: walking outward from
// an identifier's ancestors (stopping before the top-level Program, since a
// same-named top-level binding is the target itself, not a shadow of it),
// true if any enclosing function/catch param or block-local let/const/
// function declaration re-binds `name` closer than the top level. This
// doesn't model temporal-dead-zone ordering within a block (a `let name`
// declared *after* a read in the same block is treated as shadowing that
// read too), but that source is already broken before any patch touches it.
function isShadowed(ancestors, name) {
  for (let i = ancestors.length - 2; i >= 1; i--) {
    const node = ancestors[i];
    if (
      (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
      node.params.some((p) => patternDeclares(p, name))
    ) return true;
    if (node.type === "CatchClause" && patternDeclares(node.param, name)) return true;
    if (
      node.type === "BlockStatement" &&
      node.body.some((stmt) =>
        (stmt.type === "VariableDeclaration" && stmt.declarations.some((d) => d.id.type === "Identifier" && d.id.name === name)) ||
        (stmt.type === "FunctionDeclaration" && stmt.id && stmt.id.name === name)
      )
    ) return true;
  }
  return false;
}

/**
 * Renames an action -- its `action("oldName", ...)` name, the top-level
 * `const oldName = action(...)` binding it's declared on, and every
 * unshadowed reference to that binding -- throughout the file.
 *
 * Two failure modes turned up empirically (renaming fried.js's own source
 * with this tool) drove the current shape: a plain "rename every Identifier
 * with this name" pass also rewrites unrelated same-named declarations
 * anywhere in the file (an inner `const oldName = 42` having nothing to do
 * with the action), and it rewrites references *inside* a function/callback
 * that re-declares the same name as a parameter (`.map((oldName) => ...)`,
 * extremely common) even though those refer to the local binding -- in one
 * observed case that combination renamed a `let` declaration but left its
 * own reassignment untouched, producing a ReferenceError. Fixed by scoping
 * the declarator match to the one actually assigned the matched
 * `action(...)` call, and by skipping any reference isShadowed() flags as
 * belonging to a closer binding.
 */
export function renameAction(source, oldName, newName) {
  const ast = parseSource(source);
  const ms = new MagicString(source);
  let foundActionDeclaration = false;
  let targetDeclarator = null;

  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== "Identifier" || node.callee.name !== "action") return;
      const nameArg = node.arguments[0];
      if (!nameArg || nameArg.type !== "Literal" || nameArg.value !== oldName) return;
      ms.overwrite(nameArg.start, nameArg.end, JSON.stringify(newName));
      foundActionDeclaration = true;
    },
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier" && node.id.name === oldName &&
        node.init && node.init.type === "CallExpression" &&
        node.init.callee.type === "Identifier" && node.init.callee.name === "action" &&
        node.init.arguments[0]?.type === "Literal" && node.init.arguments[0].value === oldName
      ) {
        targetDeclarator = node;
      }
    },
  });

  if (!foundActionDeclaration) {
    throw new PatchError(`No action("${oldName}", ...) declaration found.`);
  }
  if (targetDeclarator) {
    ms.overwrite(targetDeclarator.id.start, targetDeclarator.id.end, newName);
  }

  walk.ancestor(ast, {
    Identifier(node, _state, ancestors) {
      if (node.name !== oldName) return;
      if (targetDeclarator && node === targetDeclarator.id) return;
      if (isShadowed(ancestors, oldName)) return;
      ms.overwrite(node.start, node.end, newName);
    },
  });

  return ms.toString();
}
