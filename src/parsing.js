// Line/link parsing, ported from Pivot's own src/lib/editor/marker-parsing.ts
// and src/lib/editor/wikilink-parsing.ts (same trailing-star marker syntax
// and [[...]] token grammar, re-implemented here in plain JS since fried.js
// apps have no build step to run the original TypeScript through).

// Lookbehind excludes matches where a 4th+ asterisk precedes the group, so a
// run of 4+ stars is left alone as literal text rather than read as a marker.
const TRAILING_STARS = /\s*(?<!\*)(\*{1,3})\s*$/;

/**
 * Parses a committed log line for a trailing marker token: 1-3 asterisks
 * mark the line at that level and are stripped from the stored text (they
 * become a colored dot, not text); more than 3 is left as literal text.
 */
export function parseLine(rawText) {
  const match = rawText.match(TRAILING_STARS);
  if (match) {
    return { text: rawText.slice(0, match.index).trimEnd(), markerLevel: match[1].length };
  }
  return { text: rawText, markerLevel: 0 };
}

const WIKILINK = /\[\[([^[\]]+)\]\]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Extracts every [[...]] token from a line of text. `[[YYYY-MM-DD]]` is a
 * day-link (jumps to that date); anything else, e.g. `[[coffee]]`, is a
 * concept-link — the thing String's graph draws nodes and edges from.
 */
export function findWikiLinks(text) {
  const tokens = [];
  for (const match of text.matchAll(WIKILINK)) {
    const inner = match[1].trim();
    if (!inner) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (DATE_RE.test(inner)) {
      tokens.push({ kind: "day", raw: match[0], targetDate: inner, start, end });
    } else {
      tokens.push({ kind: "concept", raw: match[0], word: inner, start, end });
    }
  }
  return tokens;
}

// Pivot's own default categories (src/lib/categories/defaults.ts): three
// marker levels, fixed colors. Fixed ids so re-running this on an already
// seeded database is a no-op rather than growing duplicates.
export function defaultCategories() {
  return [
    { id: "cat-1", markerLevel: 1, label: "Note", color: "#ef4444" },
    { id: "cat-2", markerLevel: 2, label: "Notable", color: "#eab308" },
    { id: "cat-3", markerLevel: 3, label: "Important", color: "#22c55e" },
  ];
}
