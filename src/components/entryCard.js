import { ui } from "../../fried.js";
import { navigate, focusConcept, db } from "../store.js";
import { findWikiLinks } from "../parsing.js";

function cycleMarker(entry) {
  const next = (entry.markerLevel + 1) % 4;
  db.collections.entries.update(entry.id, { markerLevel: next });
}

// Splits entry text into plain strings and clickable wikilink spans, so a
// [[YYYY-MM-DD]] jumps to that day and a [[word]] focuses that concept in
// the String graph — the same [[...]] grammar Pivot's editor uses.
function renderText(text) {
  const links = findWikiLinks(text);
  if (links.length === 0) return [text];

  const parts = [];
  let cursor = 0;
  links.forEach((tok, i) => {
    if (tok.start > cursor) parts.push(text.slice(cursor, tok.start));
    if (tok.kind === "day") {
      parts.push(ui("a", {
        key: `lnk-${i}`,
        class: "wikilink",
        onclick: () => navigate(`#/day/${tok.targetDate}`),
      }, `→ ${tok.targetDate}`));
    } else {
      parts.push(ui("a", {
        key: `lnk-${i}`,
        class: "wikilink",
        onclick: () => {
          focusConcept.value = tok.word;
          navigate("#/string");
        },
      }, `#${tok.word}`));
    }
    cursor = tok.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function EntryCard(entry, category, styles) {
  const color = category ? category.color : "transparent";
  return ui("div", { key: entry.id, class: styles.card }, [
    ui("span", {
      key: "dot",
      class: styles.dot,
      style: `background:${color};`,
      title: category ? category.label : "No marker — click to cycle",
      onclick: () => cycleMarker(entry),
    }),
    ui("div", { key: "text", class: styles.text }, renderText(entry.text)),
    ui("button", { key: "del", class: styles.del, title: "Delete", onclick: () => db.collections.entries.remove(entry.id) }, "×"),
  ]);
}
