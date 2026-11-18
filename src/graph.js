// String's graph, simplified: day-nodes for dates that have entries,
// concept-nodes for every distinct [[word]] link, edges wherever an entry
// links to one. Pivot's real String (src/lib/string/) draws every note and
// runs Barnes-Hut physics with a rolling time window and a node budget —
// this is a from-scratch, much smaller stand-in: a plain O(n^2)
// Fruchterman-Reingold-style force layout, fine at the scale a demo/local
// journal actually reaches.
import { findWikiLinks } from "./parsing.js";

export function buildGraph(entries) {
  const dates = new Set(entries.map((e) => e.date));
  const nodes = new Map();
  const edges = new Map();

  function ensureNode(id, kind, label) {
    let n = nodes.get(id);
    if (!n) {
      n = { id, kind, label, weight: 0 };
      nodes.set(id, n);
    }
    n.weight++;
    return n;
  }
  function addEdge(a, b) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!edges.has(key)) edges.set(key, { source: a, target: b });
  }

  for (const entry of entries) {
    const links = findWikiLinks(entry.text);
    if (links.length === 0) continue;
    const dayId = `day:${entry.date}`;
    for (const tok of links) {
      if (tok.kind === "concept") {
        const conceptId = `concept:${tok.word.toLowerCase()}`;
        ensureNode(dayId, "day", entry.date);
        ensureNode(conceptId, "concept", tok.word);
        addEdge(dayId, conceptId);
      } else if (tok.kind === "day" && dates.has(tok.targetDate) && tok.targetDate !== entry.date) {
        ensureNode(dayId, "day", entry.date);
        ensureNode(`day:${tok.targetDate}`, "day", tok.targetDate);
        addEdge(dayId, `day:${tok.targetDate}`);
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function layoutGraph(nodes, edges, width, height, iterations = 250) {
  const pos = new Map();
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    const r = Math.min(width, height) * 0.28;
    pos.set(n.id, { x: width / 2 + Math.cos(angle) * r, y: height / 2 + Math.sin(angle) * r });
  });

  const k = Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.65;

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id);
        let dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (k * k) / dist;
        dx = (dx / dist) * force; dy = (dy / dist) * force;
        const di = disp.get(nodes[i].id), dj = disp.get(nodes[j].id);
        di.x += dx; di.y += dy; dj.x -= dx; dj.y -= dy;
      }
    }

    for (const e of edges) {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) continue;
      let dx = a.x - b.x, dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      dx = (dx / dist) * force; dy = (dy / dist) * force;
      const ds = disp.get(e.source), dt = disp.get(e.target);
      ds.x -= dx; ds.y -= dy; dt.x += dx; dt.y += dy;
    }

    const cool = 1 - iter / iterations;
    for (const n of nodes) {
      const d = disp.get(n.id), p = pos.get(n.id);
      const dlen = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      const limited = Math.min(dlen, 12) * cool;
      p.x += (d.x / dlen) * limited;
      p.y += (d.y / dlen) * limited;
      p.x += (width / 2 - p.x) * 0.01;
      p.y += (height / 2 - p.y) * 0.01;
      p.x = Math.max(30, Math.min(width - 30, p.x));
      p.y = Math.max(30, Math.min(height - 30, p.y));
    }
  }
  return pos;
}
