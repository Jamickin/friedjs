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

/** Every `ui(tag, {key: "...", ...}, children)` call site, by key, within
 * `scopeNode` (an AST node to walk from -- the whole Program by default, or
 * a single function's node when a lookup is scoped `within` it). Scoping
 * matters once an app has more than one `.map()` render template: two
 * different templates each naturally reusing a readable per-slot key like
 * "label" for their own wrapper's child is completely normal, but an
 * unscoped file-wide lookup can only ever return one of them (whichever
 * comes last in source order), silently landing a patch meant for one
 * template onto the other's identically-keyed element -- see `within` on
 * the exported ops below and known-limitations.md. */
function findUiCallsByKey(scopeNode) {
  const found = new Map();
  walk.simple(scopeNode, {
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

/** Finds a top-level `function name(...) {...}` declaration, bare or
 * `export`ed -- the same lookup `replaceFunction` already did inline, now
 * shared with the template-addressing ops below (both need "find the named
 * top-level function", not just "replace its whole body"). */
function findFunctionDecl(ast, name) {
  let target = null;
  for (const node of ast.body) {
    const decl = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (decl && decl.type === "FunctionDeclaration" && decl.id && decl.id.name === name) {
      target = decl;
    }
  }
  return target;
}

function requireFunctionDecl(ast, name) {
  const fn = findFunctionDecl(ast, name);
  if (!fn) {
    throw new PatchError(`no top-level function declaration named "${name}" found${suggestSuffix(name, topLevelNames(ast))}`);
  }
  return fn;
}

/** Resolves the AST subtree a key lookup should search: the whole file, or
 * (when `within` is given) just the named top-level function's body -- see
 * findUiCallsByKey's comment for why this scoping exists. */
function resolveScope(ast, within) {
  return within ? requireFunctionDecl(ast, within) : ast;
}

function requireUiNode(ast, key, within) {
  const scope = resolveScope(ast, within);
  const node = findUiCallsByKey(scope).get(key);
  if (!node) {
    const scopeDesc = within ? ` within function "${within}"` : "";
    throw new PatchError(`no ui(...) call found with key "${key}"${scopeDesc}${suggestSuffix(key, allStaticKeys(scope))}`);
  }
  return node;
}

/**
 * Finds the single `ui(...)` call a `.map()`-style render template
 * function returns -- the "blueprint" a repeated list item is stamped
 * from. Its own wrapper necessarily has a *dynamic* key (`key: "item-" +
 * it.id`, needed by the runtime reconciler to track identity per rendered
 * instance), which is exactly why it's invisible to `requireUiNode`'s
 * static-literal-key lookup, and exactly why `addTemplateChild`/
 * `setTemplateProp` below address it by the template *function's* name
 * instead -- there's only ever one of those in the source, no matter how
 * many instances it renders at runtime.
 *
 * Only recognizes the common, directly-supported shape: a top-level
 * `function name(item) { return ui(...); }` (or `{ ...; return ui(...); }`
 * with other statements before the return) whose *last* top-level return
 * in the function body is a bare `ui(...)` call. A function that builds
 * the vnode across several variables (`const el = ui(...); return el;`) or
 * doesn't return a `ui(...)` call at all throws a specific, actionable
 * error rather than guessing.
 */
function requireTemplateReturn(ast, fnName) {
  const fn = requireFunctionDecl(ast, fnName);
  if (fn.body.type !== "BlockStatement") {
    throw new PatchError(`function "${fnName}" has no block body to find a return statement in`);
  }
  const returns = fn.body.body.filter((s) => s.type === "ReturnStatement");
  if (returns.length === 0) {
    throw new PatchError(`function "${fnName}" has no return statement -- expected it to end with "return ui(...)"`);
  }
  const last = returns[returns.length - 1];
  const arg = last.argument;
  if (!arg || arg.type !== "CallExpression" || arg.callee.type !== "Identifier" || arg.callee.name !== "ui") {
    throw new PatchError(
      `function "${fnName}" doesn't return a ui(...) call directly (found ${arg ? arg.type : "nothing"}) -- ` +
      `addTemplateChild/setTemplateProp only support "return ui(...)"; for anything built up across several ` +
      `statements, edit the function directly or use replaceFunction instead`
    );
  }
  return arg;
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

/** Sets (or adds) a prop on the ui(...) call with the given key. `within`
 * (optional) scopes the key lookup to a single named top-level function --
 * pass the template function's name when the same key string is used by
 * more than one `.map()` render template and an unscoped lookup would be
 * ambiguous (see findUiCallsByKey's comment and known-limitations.md). */
export function setProp(source, key, propName, newValueSource, within) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key, within);
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

/**
 * Turns an actual JS *value* into source text safe to splice in as a
 * `ui(...)` prop -- the fix for the landmine documented in
 * known-limitations.md: `setProp`'s last argument is raw source text, so
 * `setProp(src, key, "data-testid", "task-toolbar")` (a plain string,
 * un-quoted) produces `data-testid: task-toolbar` in the output, which is
 * syntactically VALID JavaScript (a subtraction expression) and so passes
 * `validate()` silently, only breaking at runtime. This happened for real,
 * twice, while building the token-efficiency benchmark.
 *
 * A function can't be safely round-tripped this way (there's no data
 * representation of a closure) -- pass its source text to `setProp`
 * directly instead, same as before. Everything else a `ui(...)` prop
 * actually takes at runtime (a string, number, boolean, null, or a plain
 * array/object of those) serializes unambiguously.
 */
function serializeDataValue(value) {
  if (typeof value === "function") {
    throw new PatchError(`can't serialize a function as a data value -- pass its source text to setProp/setTemplateProp instead, e.g. setProp(source, key, "onclick", "() => doThing()")`);
  }
  if (typeof value === "bigint") {
    throw new PatchError(`can't serialize a BigInt as a data value -- pass its source text (e.g. "${value}n") to setProp/setTemplateProp instead`);
  }
  if (typeof value === "symbol") {
    throw new PatchError(`can't serialize a Symbol as a data value -- there's no source-text form of one to splice in`);
  }
  if (value === undefined) return "undefined";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw new PatchError(`couldn't serialize this value as JSON (${err.message}) -- pass source text to setProp/setTemplateProp instead`);
  }
}

/**
 * Same as `setProp`, but takes an actual JS *value* (a string, number,
 * boolean, null, or plain array/object of those) instead of raw source
 * text, and serializes it correctly -- so `setPropValue(source, key,
 * "data-testid", "task-toolbar")` always does the right thing, where the
 * equivalent `setProp` call requires remembering to pass
 * `JSON.stringify("task-toolbar")` instead. Prefer this whenever the new
 * value is genuinely just data; fall back to `setProp` only when it has to
 * be an expression (a function, a reference to something in scope).
 */
export function setPropValue(source, key, propName, dataValue, within) {
  return setProp(source, key, propName, serializeDataValue(dataValue), within);
}

/**
 * Replaces a literal string child of the ui(...) call with the given key.
 *
 * Handles both shapes fried.js accepts for a single static text child:
 * `ui(tag, props, ["text"])` (an inline array -- the recommended
 * convention) and the functionally-identical but previously-unreachable
 * `ui(tag, props, "text")` (a bare literal, no array at all). `addChild`
 * got the equivalent fix a while back; this closes the same gap here --
 * found while building the token-efficiency benchmark, worked around
 * there by rewriting the app source rather than fixing the patcher, now
 * actually fixed.
 *
 * `within` (optional): see setProp's doc comment -- same cross-template
 * key-collision scoping applies here.
 */
export function setChildText(source, key, oldText, newText, within) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key, within);
  const childrenArg = node.arguments[2];
  const ms = new MagicString(source);

  if (childrenArg && childrenArg.type === "Literal" && childrenArg.value === oldText) {
    ms.overwrite(childrenArg.start, childrenArg.end, JSON.stringify(newText));
    return ms.toString();
  }

  if (!childrenArg || childrenArg.type !== "ArrayExpression") {
    const gotDesc = !childrenArg
      ? "no children argument at all"
      : childrenArg.type === "Literal"
        ? `a single bare literal child, ${JSON.stringify(childrenArg.value)}, which doesn't match ${JSON.stringify(oldText)}`
        : "a non-array, non-literal children expression (a variable, a .map() result, ...) -- there's no literal text in the source itself to replace";
    throw new PatchError(`ui(...) call with key "${key}" has ${gotDesc}`);
  }

  const target = childrenArg.elements.find((el) => el && el.type === "Literal" && el.value === oldText);
  if (!target) {
    const literalChildren = childrenArg.elements.filter((el) => el?.type === "Literal" && typeof el.value === "string").map((el) => el.value);
    throw new PatchError(`no literal child ${JSON.stringify(oldText)} found under key "${key}"${suggestSuffix(String(oldText), literalChildren)}`);
  }
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
 *
 * `within` (optional): see setProp's doc comment -- same cross-template
 * key-collision scoping applies here.
 */
export function addChild(source, key, newChildSource, within) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key, within);
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
function findChildIndex(childrenArg, matcher) {
  return childrenArg.elements.findIndex((el) => {
    if (!el) return false;
    if (el.type === "Literal" && el.value === matcher) return true;
    if (el.type === "CallExpression" && el.callee.type === "Identifier" && el.callee.name === "ui") {
      const propsArg = el.arguments[1];
      const keyProp = propsArg?.type === "ObjectExpression"
        ? propsArg.properties.find((p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "key" && p.value.type === "Literal")
        : null;
      if (keyProp && keyProp.value.value === matcher) return true;
    }
    return false;
  });
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
 *
 * `within` (optional): see setProp's doc comment -- same cross-template
 * key-collision scoping applies here.
 */
export function removeChild(source, key, matcher, within) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key, within);
  const childrenArg = requireChildrenArray(node, key);
  const idx = findChildIndex(childrenArg, matcher);
  if (idx === -1) {
    throw new PatchError(`no child matching ${JSON.stringify(matcher)} found under key "${key}"${suggestSuffix(String(matcher), childCandidateLabels(childrenArg))}`);
  }
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
 *
 * `within` (optional): see setProp's doc comment -- same cross-template
 * key-collision scoping applies here.
 */
export function replaceChild(source, key, matcher, newChildSource, within) {
  const ast = parseSource(source);
  const node = requireUiNode(ast, key, within);
  const childrenArg = requireChildrenArray(node, key);
  const idx = findChildIndex(childrenArg, matcher);
  if (idx === -1) {
    throw new PatchError(`no child matching ${JSON.stringify(matcher)} found under key "${key}"${suggestSuffix(String(matcher), childCandidateLabels(childrenArg))}`);
  }
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
    if (node.type === "VariableDeclaration") {
      return node.declarations.some((d) => d.id.type === "Identifier" && d.id.name === name);
    }
    if (node.type === "FunctionDeclaration") {
      return node.id?.name === name;
    }
    return false;
  });
  if (idx === -1) {
    throw new PatchError(`no top-level const or function named "${name}" found${suggestSuffix(name, topLevelNames(ast))}`);
  }
  const target = ast.body[idx];
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

/**
 * Replaces an entire top-level function declaration's source, body and
 * signature both, in one call. Coarser-grained than every other op here
 * on purpose: addStatementAfter/removeStatement/renameSymbol are all
 * built for small, targeted edits, but a function whose internals change
 * substantially (more than a couple of statements' worth) doesn't have a
 * clean way to express that as a handful of those -- this fills that gap
 * with "just give me the whole new function," while everything else in
 * the file (imports, other functions, ui() call sites) stays untouched.
 * Only matches a top-level `function name(...) {...}` declaration
 * (bare or `export`ed) -- not a `const name = () => {...}` arrow, which
 * has no single AST node type this could target unambiguously the same
 * way. `newFunctionSource` always starts with `function`, never `export
 * function`, even when replacing an exported one: the matched range
 * starts right after the `export` keyword (which stays put, untouched),
 * not at `export` itself.
 */
export function replaceFunction(source, fnName, newFunctionSource) {
  const ast = parseSource(source);
  const target = requireFunctionDecl(ast, fnName);
  const ms = new MagicString(source);
  ms.overwrite(target.start, target.end, newFunctionSource);
  return ms.toString();
}

// -- Dynamic-template addressing --------------------------------------
//
// Everything above addresses a `ui(...)` call by a *static* key -- which,
// by design, a `.map()` render template's own wrapper never has (its key
// has to be built from the item, `"item-" + it.id`, for the runtime
// reconciler to track identity across renders). That's correct and not a
// limitation of the runtime; it did used to be a hard limitation of the
// *patcher*, though: there was no way to reach a template's own wrapper at
// all, only the already-statically-keyed children inside it (which
// requireUiNode/findUiCallsByKey already find today, since they walk the
// whole file, template function bodies included -- nothing new needed for
// that half).
//
// The fix doesn't need a new key convention. A `.map()` template function
// is already required to be a uniquely-named top-level `function` (so
// `replaceFunction` can find it) -- that name is already a perfectly good
// static, unique handle for its own wrapper, since there's exactly one
// copy of the template in *source*, however many instances it renders at
// *runtime*. addTemplateChild/setTemplateProp below just use that handle
// instead of a `key`.

/**
 * Appends a new child to a `.map()` render template's own returned
 * `ui(...)` call -- e.g. "add a delete button to every row" -- found by
 * the template *function's* name (see the comment above), not a `key`,
 * since the template's own wrapper necessarily has a dynamic one.
 *
 * Same array-literal-vs-by-reference handling as addChild (inserts
 * directly into an inline array; rewrites a by-reference expression as
 * `[...(<expr>), newChild]`; adds a third argument if there isn't one).
 */
export function addTemplateChild(source, fnName, newChildSource) {
  const ast = parseSource(source);
  const node = requireTemplateReturn(ast, fnName);
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

/**
 * Sets (or adds) a prop on a `.map()` render template's own returned
 * `ui(...)` call -- e.g. "give every row a data-testid" or "add a class to
 * every card" -- found by the template *function's* name, same reasoning
 * as addTemplateChild above. Never touches `key` itself (refused, same as
 * renameSymbol refusing fried.js API names): the template's key expression
 * is load-bearing for the runtime reconciler, not a cosmetic prop, and
 * overwriting it here would likely just break per-item identity tracking
 * rather than do anything the caller meant.
 */
export function setTemplateProp(source, fnName, propName, newValueSource) {
  if (propName === "key") {
    throw new PatchError(`refusing to set "key" via setTemplateProp -- it's the runtime's per-item identity expression, not a cosmetic prop; edit the template function directly if it genuinely needs to change`);
  }
  const ast = parseSource(source);
  const node = requireTemplateReturn(ast, fnName);
  const propsArg = node.arguments[1];
  const ms = new MagicString(source);
  const existing = propsArg?.type === "ObjectExpression"
    ? propsArg.properties.find((p) => p.type === "Property" && propKeyMatches(p.key, propName))
    : null;
  if (existing) {
    ms.overwrite(existing.value.start, existing.value.end, newValueSource);
    return ms.toString();
  }
  if (!propsArg || propsArg.type !== "ObjectExpression") {
    throw new PatchError(`function "${fnName}"'s ui(...) call has no props object literal to add "${propName}" to`);
  }
  const keySource = IDENTIFIER_RE.test(propName) ? propName : JSON.stringify(propName);
  const { insertAt, text } = computeInsertion(source, propsArg, propsArg.properties, `${keySource}: ${newValueSource}`);
  ms.appendLeft(insertAt, text);
  return ms.toString();
}

/** Same as `setTemplateProp`, but takes an actual JS *value* instead of
 * raw source text -- see `setPropValue`'s doc comment for the reasoning
 * (the same raw-source landmine applies here). */
export function setTemplatePropValue(source, fnName, propName, dataValue) {
  return setTemplateProp(source, fnName, propName, serializeDataValue(dataValue));
}

// -- CSS rule addressing ------------------------------------------------
//
// css({...}) (see docs/framework-api.md) takes a plain object mapping a
// name to a CSS declaration string and returns generated class names --
// CLAUDE.md's own conventions section names "CSS rule additions" as one
// of the things to "edit directly and say so" about rather than
// force-fitting the patch API, since nothing here addressed it. It fits
// the same pattern as setProp/addTemplateChild -- find one call site,
// touch one property -- so there's no real reason it should be the one
// carve-out left. Only recognizes the common, conventional shape: a
// top-level `const <varName> = css({...})`, matching the same "top-level
// const" constraint addStatementAfter/removeStatement already have.
//
// Unlike setProp/setTemplateProp, these take a plain CSS declaration
// *string* directly rather than raw source text -- css()'s values are
// always strings, never an expression or a function, so there's no
// legitimate case for a raw-source form here, and building that
// distinction in from the start avoids ever needing setCssRule's own
// "Value" variant the way setProp needed setPropValue after the fact.

function findCssCall(ast, varName) {
  for (const node of ast.body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const d of node.declarations) {
      if (
        d.id.type === "Identifier" && d.id.name === varName &&
        d.init && d.init.type === "CallExpression" &&
        d.init.callee.type === "Identifier" && d.init.callee.name === "css"
      ) {
        const arg = d.init.arguments[0];
        if (arg && arg.type === "ObjectExpression") return arg;
      }
    }
  }
  return null;
}

function requireCssCall(ast, varName) {
  const obj = findCssCall(ast, varName);
  if (!obj) {
    throw new PatchError(`no top-level "const ${varName} = css({...})" call found${suggestSuffix(varName, topLevelNames(ast))}`);
  }
  return obj;
}

function cssRuleNames(propsArg) {
  return propsArg.properties
    .filter((p) => p.type === "Property")
    .map((p) => (p.key.type === "Identifier" ? p.key.name : p.key.value));
}

/**
 * Sets (or adds) one rule's declaration string in a top-level
 * `const <varName> = css({...})` call -- e.g. `setCssRule(source,
 * "styles", "button", "padding: 8px 16px; border-radius: 4px;")`.
 * `declText` is a plain CSS declaration string, always quoted correctly;
 * there's no raw-source form of this one (see the section comment above).
 */
export function setCssRule(source, varName, ruleName, declText) {
  if (typeof declText !== "string") {
    throw new PatchError(`setCssRule's declText must be a plain CSS declaration string, got ${typeof declText}`);
  }
  const ast = parseSource(source);
  const propsArg = requireCssCall(ast, varName);
  const ms = new MagicString(source);
  const existing = propsArg.properties.find((p) => p.type === "Property" && propKeyMatches(p.key, ruleName));
  if (existing) {
    ms.overwrite(existing.value.start, existing.value.end, JSON.stringify(declText));
    return ms.toString();
  }
  const keySource = IDENTIFIER_RE.test(ruleName) ? ruleName : JSON.stringify(ruleName);
  const { insertAt, text } = computeInsertion(source, propsArg, propsArg.properties, `${keySource}: ${JSON.stringify(declText)}`);
  ms.appendLeft(insertAt, text);
  return ms.toString();
}

/** Removes one rule from a top-level `const <varName> = css({...})` call --
 * the delete-counterpart to setCssRule. */
export function removeCssRule(source, varName, ruleName) {
  const ast = parseSource(source);
  const propsArg = requireCssCall(ast, varName);
  const idx = propsArg.properties.findIndex((p) => p.type === "Property" && propKeyMatches(p.key, ruleName));
  if (idx === -1) {
    throw new PatchError(`no css rule "${ruleName}" found in "${varName}"${suggestSuffix(ruleName, cssRuleNames(propsArg))}`);
  }
  const { start, end } = computeRemoval(source, propsArg.end - 1, propsArg.properties, idx);
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

const OPS = {
  setProp, setPropValue, setChildText, addChild, addStatementAfter, removeChild, replaceChild,
  removeStatement, renameSymbol, replaceFunction, addTemplateChild, setTemplateProp,
  setTemplatePropValue, setCssRule, removeCssRule,
};

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
