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

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// -- Diagnostics -----------------------------------------------------------
// A patch that fails to find its target is the single most common way an
// AI (or a person) burns a retry on this codebase: the name was close but
// not exact, or just wrong, and "not found" alone gives nothing to correct
// from. Every lookup failure below is enriched with a "nearest:" suggestion
// computed from the names that actually exist at that lookup's scope --
// not a global search, since "nearest key in the whole file" is a worse
// answer than "nearest key among this element's actual children" when
// that's the scope of the lookup that failed.

/** Plain Levenshtein edit distance -- short identifiers only, so the
 * classic O(n*m) DP table is plenty fast and doesn't need a dependency. */
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Up to `limit` candidates closest to `target` by edit distance, dropping
 * anything so far off it'd be a misleading guess rather than a real typo
 * (the cutoff scales with word length: "cart" -> "wharf" is 3 edits on a
 * 4-letter word and should never be suggested; "checkoutButton" -> a
 * 3-edit typo on a 14-letter word plausibly still is one). */
function nearestMatches(target, candidates, limit = 3) {
  const pool = [...new Set(candidates)].filter((c) => c !== target);
  const maxDistance = Math.max(2, Math.floor(target.length / 2));
  return pool
    .map((c) => ({ c, d: editDistance(target, c) }))
    .filter(({ d }) => d <= maxDistance)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ c }) => c);
}

/** Formats the optional "-- nearest: ..." suffix for an error message;
 * returns "" (not appended) when there's nothing close enough to suggest,
 * so a genuinely-empty scope doesn't produce a confusing empty suggestion. */
function suggestSuffix(target, candidates) {
  const near = nearestMatches(target, candidates);
  return near.length ? ` -- nearest: ${near.map((n) => JSON.stringify(n)).join(", ")}` : "";
}

/** Every static-literal ui(...) key anywhere in the file, for the
 * "nearest key" suggestion when a key lookup fails file-wide. */
function allStaticKeys(ast) {
  const keys = [];
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== "Identifier" || node.callee.name !== "ui") return;
      const propsArg = node.arguments[1];
      const keyProp = propsArg?.type === "ObjectExpression"
        ? propsArg.properties.find((p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key")
        : null;
      if (keyProp?.value.type === "Literal" && typeof keyProp.value.value === "string") keys.push(keyProp.value.value);
    },
  });
  return keys;
}

/** Every child of an inline children array literal, as a suggestable
 * string -- a literal value as-is, a nested ui(...)'s own key prefixed so
 * it reads unambiguously in a suggestion list. */
function childCandidateLabels(childrenArg) {
  const labels = [];
  for (const el of childrenArg.elements) {
    if (!el) continue;
    if (el.type === "Literal" && typeof el.value === "string") labels.push(el.value);
    else if (el.type === "CallExpression" && el.callee.type === "Identifier" && el.callee.name === "ui") {
      const propsArg = el.arguments[1];
      const keyProp = propsArg?.type === "ObjectExpression"
        ? propsArg.properties.find((p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key" && p.value.type === "Literal")
        : null;
      if (keyProp) labels.push(String(keyProp.value.value));
    }
  }
  return labels;
}

/** Every top-level `const`/`let`/`var` name and function-declaration name,
 * for addStatementAfter/removeStatement's "nearest name" suggestion. */
function topLevelNames(ast) {
  const names = [];
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" && node.id) names.push(node.id.name);
    else if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) if (d.id.type === "Identifier") names.push(d.id.name);
    }
  }
  return names;
}

/** Every distinct identifier name that's actually declared or referenced
 * anywhere in the file (not just top-level), for renameSymbol's "nearest
 * name" suggestion -- a typo'd rename target is just as likely to be a
 * local or a parameter as a top-level const. */
function allIdentifierNames(ast) {
  const names = new Set();
  walk.ancestor(ast, {
    Identifier(node) { names.add(node.name); },
    VariablePattern(node) { names.add(node.name); },
  });
  return [...names];
}

/** Object property keys like "data-testid" or "aria-label" aren't valid bare
 * identifiers — used to decide whether a prop name needs quoting when
 * inserted, and to match either form when looking one up. */
function propKeyMatches(propKey, name) {
  if (propKey.type === "Identifier") return propKey.name === name;
  if (propKey.type === "Literal") return propKey.value === name;
  return false;
}

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
      if (keyProp) {
        const k = keyProp.value.value;
        if (!found.has(k)) found.set(k, []);
        found.get(k).push(node);
      }
    },
  });
  return found;
}

function requireUiNode(ast, key) {
  const nodes = findUiCallsByKey(ast).get(key);
  if (!nodes || nodes.length === 0) {
    throw new PatchError(`no ui(...) call found with key "${key}"${suggestSuffix(key, allStaticKeys(ast))}`);
  }
  if (nodes.length > 1) {
    throw new PatchError(`key "${key}" is ambiguous: ${nodes.length} ui(...) calls share it`);
  }
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
    (p) => p.type === "Property" && propKeyMatches(p.key, propName)
  );
  const ms = new MagicString(source);
  if (existing) {
    ms.overwrite(existing.value.start, existing.value.end, newValueSource);
  } else {
    const keySource = IDENTIFIER_RE.test(propName) ? propName : JSON.stringify(propName);
    const { insertAt, text } = computeInsertion(source, propsArg, propsArg.properties, `${keySource}: ${newValueSource}`);
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
  if (!target) {
    const literalChildren = childrenArg.elements.filter((el) => el?.type === "Literal" && typeof el.value === "string").map((el) => el.value);
    throw new PatchError(`no literal child ${JSON.stringify(oldText)} found under key "${key}"${suggestSuffix(String(oldText), literalChildren)}`);
  }
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
  if (!target) {
    throw new PatchError(`no top-level const "${afterConstName}" found${suggestSuffix(afterConstName, topLevelNames(ast))}`);
  }
  const ms = new MagicString(source);
  ms.appendLeft(target.end, `\n\n${newStatementSource}`);
  return ms.toString();
}

// Shared by removeChild/removeStatement: deleting item[idx] from a
// comma-or-newline-separated list needs a range, not just the item's own
// start/end, or you leave a dangling separator behind (either a trailing
// ",\n  " orphaned after the previous item, or a leading one before the
// next). The fix that works uniformly whether the removed item is first,
// middle, or last: always delete from the item's own start up to the
// START of whatever comes next (the next item, or the container's closing
// bracket/brace if this was the last one). That consumes exactly the
// separator that *followed* this item and nothing else, which leaves
// correct formatting in all three positions -- verified by this file's
// own test suite, not just reasoned about.
function computeRemoval(source, containerEndPos, items, idx) {
  const target = items[idx];
  const isLast = idx + 1 === items.length;
  const nextStart = isLast ? containerEndPos : items[idx + 1].start;
  let start = target.start;
  if (isLast) {
    // Removing the last item leaves nothing after it to inherit the
    // indentation that used to lead into it (unlike the first/middle
    // case, where the *next* item's own leading indent naturally takes
    // over) -- so that indent would otherwise dangle between the new
    // last item's trailing comma and the closing bracket. Back up over
    // it (spaces/tabs only, stopping at the newline from the previous
    // item's own separator) so it doesn't.
    while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  }
  return { start, end: nextStart };
}

/** Finds the index of a child in a ui(...) call's inline array literal,
 * matching either a literal value (string/number, like setChildText) or a
 * nested `ui(..., { key: "..." }, ...)` call by its own key. */
function findChildIndices(childrenArg, matcher) {
  const indices = [];
  childrenArg.elements.forEach((el, idx) => {
    if (!el) return;
    if (el.type === "Literal" && el.value === matcher) { indices.push(idx); return; }
    if (el.type === "CallExpression" && el.callee.type === "Identifier" && el.callee.name === "ui") {
      const propsArg = el.arguments[1];
      const keyProp = propsArg?.type === "ObjectExpression"
        ? propsArg.properties.find((p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key" && p.value.type === "Literal")
        : null;
      if (keyProp && keyProp.value.value === matcher) { indices.push(idx); }
    }
  });
  return indices;
}

function requireChildrenArray(node, key) {
  const childrenArg = node.arguments[2];
  if (!childrenArg || childrenArg.type !== "ArrayExpression") {
    throw new PatchError(`ui(...) call with key "${key}" has no inline children array to edit`);
  }
  return childrenArg;
}

/**
 * Removes one child from the ui(...) call with the given key. `matcher` is
 * either the exact value of a literal string/number child (as passed to
 * setChildText), or the `key` of a nested ui(...) child.
 *
 * Only works when children are an inline array literal, same constraint as
 * setChildText/addChild's array-literal path -- a by-reference children
 * list (a variable, a .map() result) has no element in this file's AST to
 * remove, so there's nothing safe to do but say so.
 */
export function removeChild(source, key, matcher) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key);
  const childrenArg = requireChildrenArray(node, key);
  const indices = findChildIndices(childrenArg, matcher);
  if (indices.length === 0) {
    throw new PatchError(`no child matching ${JSON.stringify(matcher)} found under key "${key}"${suggestSuffix(String(matcher), childCandidateLabels(childrenArg))}`);
  }
  if (indices.length > 1) {
    throw new PatchError(`child key "${matcher}" is ambiguous under parent "${key}": ${indices.length} matches`);
  }
  const idx = indices[0];
  const { start, end } = computeRemoval(source, childrenArg.end - 1, childrenArg.elements, idx);
  const ms = new MagicString(source);
  ms.remove(start, end);
  return ms.toString();
}

/**
 * Replaces one child of the ui(...) call with the given key -- the same
 * lookup as removeChild (a literal value or a nested ui(...)'s key), but
 * overwrites it with new source text instead of deleting it. Unlike
 * setChildText, the replacement isn't limited to a literal string: it can
 * be any expression, including a whole new nested ui(...) call.
 */
export function replaceChild(source, key, matcher, newChildSource) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key);
  const childrenArg = requireChildrenArray(node, key);
  const indices = findChildIndices(childrenArg, matcher);
  if (indices.length === 0) {
    throw new PatchError(`no child matching ${JSON.stringify(matcher)} found under key "${key}"${suggestSuffix(String(matcher), childCandidateLabels(childrenArg))}`);
  }
  if (indices.length > 1) {
    throw new PatchError(`child key "${matcher}" is ambiguous under parent "${key}": ${indices.length} matches`);
  }
  const idx = indices[0];
  const target = childrenArg.elements[idx];
  const ms = new MagicString(source);
  ms.overwrite(target.start, target.end, newChildSource);
  return ms.toString();
}

/**
 * Removes a top-level `const <name> = ...` (or `function <name>(...) {}`)
 * statement entirely -- the delete-counterpart to addStatementAfter.
 */
export function removeStatement(source, name) {
  const ast = parseSource(source);
  const idx = ast.body.findIndex((node) => {
    const decl = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (!decl) return false;
    if (decl.type === "VariableDeclaration") {
      return decl.declarations.some((d) => d.id.type === "Identifier" && d.id.name === name);
    }
    if (decl.type === "FunctionDeclaration") {
      return decl.id?.name === name;
    }
    return false;
  });
  if (idx === -1) {
    throw new PatchError(`no top-level const or function named "${name}" found${suggestSuffix(name, topLevelNames(ast))}`);
  }
  const target = ast.body[idx];
  const decl = target.type === "ExportNamedDeclaration" ? target.declaration : target;
  if (decl.type === "VariableDeclaration" && decl.declarations.length > 1) {
    throw new PatchError(`"${name}" shares a declaration with other names (e.g. "let a, b, c") -- removing the statement would delete those too`);
  }
  let start = target.start;
  let end;
  if (idx + 1 < ast.body.length) {
    end = ast.body[idx + 1].start;
  } else {
    // Last statement in the file: nothing after it to anchor on, so just
    // consume the statement itself plus one trailing newline (if any) so
    // removal doesn't leave a blank line at the end of the file.
    end = target.end;
    if (source[end] === "\n") end += 1;
  }
  const ms = new MagicString(source);
  ms.remove(start, end);
  return ms.toString();
}

const FRIED_RESERVED = new Set([
  "state", "action", "ui", "uid", "mount", "css", "cssVar", "onRender", "nextTick", "createDatabase",
]);

/**
 * Renames every real reference to `oldName` (a declared variable, action,
 * or function -- its declaration AND every place that reads it) to
 * `newName` throughout the file.
 *
 * Deliberately narrower than a full IDE rename, but gets its precision
 * for free from acorn-walk's own base grammar rather than from ad hoc
 * checks: acorn-walk's base visitors simply never walk into a
 * non-computed member property (`obj.oldName`) or a non-computed
 * object-literal key (`{ oldName: 1 }`) at all -- those bytes never reach
 * this function, so they can't accidentally get renamed. What it does
 * have to handle itself is that acorn-walk dispatches a *binding*
 * identifier (a `const`/`let`/`function`/parameter/destructured name)
 * through a different visitor type than an ordinary reference -- "Identifier"
 * covers uses (the right-hand side, a call argument), "VariablePattern"
 * covers declarations -- so both are registered below, or `const oldName
 * = ...` would silently be left unrenamed while every reference to it
 * changed.
 *
 * A *shorthand* property or destructured binding (`{ oldName }`) is the
 * one case where the same identifier is simultaneously the property name
 * and the variable -- renaming the variable there has to expand it to
 * `{ oldName: newName }` to keep the property name unchanged, which is
 * what the shorthand branch below does. A shorthand entry *with a default*
 * (`{ oldName = 0 }`) is refused rather than silently mishandled: the
 * identifier there sits one level deeper (inside an AssignmentPattern),
 * where renaming it in place would rename the extracted property, not
 * just the local binding -- a real ambiguity, not something to guess at.
 *
 * Refuses to rename any of fried.js's own API names (state, action, ui,
 * ...) since that would silently break every call site in the file
 * rather than the one thing actually being renamed.
 */
export function renameSymbol(source, oldName, newName) {
  if (FRIED_RESERVED.has(oldName)) {
    throw new PatchError(`refusing to rename "${oldName}" -- it's a fried.js API name, not something a patch should touch`);
  }
  const ast = parseSource(source);
  const ms = new MagicString(source);
  let count = 0;

  // acorn-walk's base.ObjectPattern walks straight into a property's
  // `value` (`c(prop.value, st, "Pattern")`) without ever visiting the
  // Property node itself the way base.ObjectExpression does -- so for a
  // destructured `{ oldName }`, the Property (and its `shorthand` flag)
  // never appears in the ancestors chain at all; the identifier's
  // immediate parent is the ObjectPattern directly. This looks the
  // Property back up by searching the nearest object node's `properties`
  // for the one whose `value` is this node (the plain case) or this
  // node's immediate parent (the `{ oldName = default }` case, where the
  // value is an AssignmentPattern wrapping the identifier).
  function ownerProperty(node, parent, grandparent) {
    if (parent?.type === "Property") return parent; // object-expression shorthand: Property IS the parent
    if (parent?.type === "ObjectPattern") {
      return parent.properties.find((p) => p.type === "Property" && p.value === node) || null;
    }
    if (parent?.type === "AssignmentPattern" && grandparent?.type === "ObjectPattern") {
      return grandparent.properties.find((p) => p.type === "Property" && p.value === parent) || null;
    }
    return null;
  }

  function handle(node, ancestors) {
    if (node.name !== oldName) return;
    const parent = ancestors[ancestors.length - 2];
    const grandparent = ancestors[ancestors.length - 3];
    const owner = ownerProperty(node, parent, grandparent);

    if (owner?.shorthand) {
      if (owner.value !== node) {
        // { oldName = default }: the property's value is an
        // AssignmentPattern wrapping this identifier, not the identifier
        // itself -- renaming the local binding and renaming the
        // extracted property name are two different edits here, and
        // guessing which one is meant would be exactly the kind of
        // silent-wrong-behavior this project has been burned by before.
        throw new PatchError(
          `can't safely rename "${oldName}" -- it's a shorthand destructured property with a default value ` +
          `({ ${oldName} = ... }), where renaming the local binding and renaming the extracted property name ` +
          `are two different edits. Rewrite it to the explicit form ({ ${oldName}: localName = ... }) by hand first.`
        );
      }
      // { oldName } -- key and value are the same identifier (as a plain
      // value, or as a destructured binding). Renaming the variable has
      // to keep the property name, so expand to the explicit form.
      ms.overwrite(node.start, node.end, `${oldName}: ${newName}`);
      count++;
      return;
    }
    ms.overwrite(node.start, node.end, newName);
    count++;
  }

  walk.ancestor(ast, {
    Identifier(node, _state, ancestors) { handle(node, ancestors); },
    VariablePattern(node, _state, ancestors) { handle(node, ancestors); },
  });

  if (count === 0) {
    throw new PatchError(`no reference to "${oldName}" found to rename${suggestSuffix(oldName, allIdentifierNames(ast))}`);
  }
  return ms.toString();
}

const OPS = { setProp, setChildText, addChild, addStatementAfter, removeChild, replaceChild, removeStatement, renameSymbol };

/**
 * Applies several patch ops in sequence, e.g.
 *   patch(source, [
 *     { op: "setProp", args: ["save", "disabled", "true"] },
 *     { op: "setChildText", args: ["save", "Save", "Saved!"] },
 *   ])
 * Each op is the same function above, just data-described instead of
 * called directly -- useful when an AI is producing a list of edits and
 * it's simpler to emit a compact op list than a sequence of function
 * calls. This is honestly just a loop, not a single coordinated AST
 * transaction: each op re-parses the previous op's output. That's the
 * simple, correct thing to do here (these files are small; re-parsing is
 * cheap) rather than something cleverer that would need every op above to
 * share one MagicString instance. Fails on the first op that throws, with
 * the step number and op name in the error, and always validates the
 * final result before returning it -- a batch that produces broken source
 * is not a successful patch.
 */
export function patch(source, ops) {
  let current = source;
  ops.forEach((step, i) => {
    const fn = OPS[step.op];
    if (!fn) {
      throw new PatchError(`unknown patch op "${step.op}" (step ${i})${suggestSuffix(step.op, Object.keys(OPS))}`);
    }
    try {
      current = fn(current, ...(step.args || []));
    } catch (err) {
      throw new PatchError(`step ${i} ("${step.op}") failed: ${err.message}`);
    }
  });
  const result = validate(current);
  if (!result.ok) {
    const where = typeof result.line === "number" ? ` at line ${result.line}, column ${result.column}` : "";
    throw new PatchError(`batched patch produced invalid source${where}: ${result.error}`);
  }
  return current;
}

/**
 * Never trust a patched file without re-parsing it first. On failure,
 * returns the structured position (line/column/pos, straight off acorn's
 * own SyntaxError) alongside the message, not just a string to re-parse
 * by hand -- the message alone already has "(line:col)" baked in by
 * acorn, so `error` stays exactly that compact one-liner; `line`/`column`/
 * `pos` are there for anything (an editor jump, an AI) that wants the
 * position as data instead of parsing it back out of English text.
 */
export function validate(source) {
  try {
    parseSource(source);
    return { ok: true };
  } catch (err) {
    const result = { ok: false, error: err.message };
    if (typeof err.loc?.line === "number") result.line = err.loc.line;
    if (typeof err.loc?.column === "number") result.column = err.loc.column;
    if (typeof err.pos === "number") result.pos = err.pos;
    return result;
  }
}



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
