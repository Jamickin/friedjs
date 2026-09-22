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

/** Every `ui(tag, {key: "...", ...}, children)` call site, by key. */
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
      if (keyProp) found.set(keyProp.value.value, node);
    },
  });
  return found;
}

function requireUiNode(ast, key) {
  const node = findUiCallsByKey(ast).get(key);
  if (!node) throw new PatchError(`no ui(...) call found with key "${key}"`);
  return node;
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
  
  let targetIndex = -1;
  for (let i = 0; i < childrenArg.elements.length; i++) {
    const el = childrenArg.elements[i];
    if (!el || el.type !== "CallExpression") continue;
    if (el.callee.type !== "Identifier" || el.callee.name !== "ui") continue;
    const propsArg = el.arguments[1];
    if (!propsArg || propsArg.type !== "ObjectExpression") continue;
    const keyProp = propsArg.properties.find(
      (p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key" && p.value.type === "Literal"
    );
    if (keyProp && keyProp.value.value === childKey) {
      targetIndex = i;
      break;
    }
  }
  
  if (targetIndex === -1) throw new PatchError(`no inline child ui(...) call with key "${childKey}" found under parent "${parentKey}"`);
  
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

/** Renames an action and all references to it throughout the file. */
export function renameAction(source, oldName, newName) {
  const ast = parseSource(source);
  const ms = new MagicString(source);
  let foundActionDeclaration = false;
  
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "action") {
        if (node.arguments.length > 0 && node.arguments[0].type === "Literal" && node.arguments[0].value === oldName) {
          ms.overwrite(node.arguments[0].start, node.arguments[0].end, JSON.stringify(newName));
          foundActionDeclaration = true;
        }
      }
    },
    Identifier(node) {
      if (node.name === oldName) {
        ms.overwrite(node.start, node.end, newName);
      }
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.id.name === oldName) {
        ms.overwrite(node.id.start, node.id.end, newName);
      }
    }
  
  });
  if (!foundActionDeclaration) {
    throw new PatchError(`No action("${oldName}", ...) declaration found.`);
  }
  return ms.toString();
}
