import { ui } from "../../fried.js";
import { db, focusConcept, navigate } from "../store.js";
import { buildGraph, layoutGraph } from "../graph.js";
import { stringStyles } from "../theme.js";

const WIDTH = 760, HEIGHT = 480;

// Layout is expensive-ish (O(n^2) per iteration) and only needs to change
// when the underlying node/edge set changes, not on every unrelated
// re-render (fried.js rebuilds the whole tree on any state change) — so
// it's cached by a cheap structural key instead of recomputed every call.
let cachedKey = "";
let cachedPos = null;

export function StringView() {
  const styles = stringStyles();
  const entries = db.collections.entries.value;
  const { nodes, edges } = buildGraph(entries);

  const key = nodes.map((n) => n.id).sort().join(",") + "#" + edges.length;
  if (key !== cachedKey) {
    cachedPos = layoutGraph(nodes, edges, WIDTH, HEIGHT);
    cachedKey = key;
  }
  const pos = cachedPos;

  if (nodes.length === 0) {
    return ui("div", { key: "string-view", class: styles.wrap }, [
      ui("h2", { key: "title", class: styles.title }, "String"),
      ui("p", { key: "hint", class: styles.hint }, "A force-directed graph over your notes."),
      ui("div", { key: "empty", class: styles.empty }, "Add [[concept]] or [[YYYY-MM-DD]] links in your day entries to grow this graph."),
    ]);
  }

  const lines = edges.map((e, i) => {
    const a = pos.get(e.source), b = pos.get(e.target);
    return ui("line", { key: `e-${i}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: styles.edge });
  });

  const nodeEls = nodes.map((n) => {
    const p = pos.get(n.id);
    const focused = focusConcept.value && n.kind === "concept" && n.label.toLowerCase() === focusConcept.value.toLowerCase();
    const r = (n.kind === "day" ? 8 : 6) + Math.min(10, n.weight);
    return ui("g", {
      key: `n-${n.id}`,
      class: styles.node,
      onclick: () => (n.kind === "day" ? navigate(`#/day/${n.label}`) : (focusConcept.value = n.label)),
    }, [
      ui("circle", {
        key: "c", cx: p.x, cy: p.y, r,
        class: n.kind === "day" ? styles.dayNode : styles.conceptNode,
        style: focused ? "stroke:#f59e0b; stroke-width:3;" : "",
      }),
      ui("text", { key: "t", x: p.x, y: p.y + r + 13, class: styles.nodeLabel }, n.kind === "day" ? n.label.slice(5) : n.label),
    ]);
  });

  return ui("div", { key: "string-view", class: styles.wrap }, [
    ui("h2", { key: "title", class: styles.title }, "String"),
    ui("p", { key: "hint", class: styles.hint }, `${nodes.length} nodes, ${edges.length} connections — click a day node to open it, a concept node to focus it.`),
    ui("svg", { key: "svg", viewBox: `0 0 ${WIDTH} ${HEIGHT}`, class: styles.svg }, [...lines, ...nodeEls]),
  ]);
}
