import test from "node:test";
import assert from "node:assert/strict";
import { edgeGlyph, strokeLine, strokePath, strokeEllipse, strokePoly, fillEllipse, fillPoly, fillRect, fillCapsule } from "../addons/fried-raster.js";

// Collect what a shape draws into a little text picture.
function canvas(w, h) {
  const rows = Array.from({ length: h }, () => Array(w).fill(" "));
  const put = (x, y, ch = "#") => { if (x >= 0 && y >= 0 && x < w && y < h) rows[y][x] = typeof ch === "string" ? ch : "#"; };
  return { put, text: () => rows.map((r) => r.join("")), count: () => rows.flat().filter((c) => c !== " ").length };
}

test("fried-raster: an edge's glyph leans the way it runs on screen", () => {
  assert.equal(edgeGlyph(5, 0), "-");
  assert.equal(edgeGlyph(0, 5), "|");
  assert.equal(edgeGlyph(4, 2), "\\", "down and to the right");
  assert.equal(edgeGlyph(4, -2), "/");
  assert.equal(edgeGlyph(10, 1, 2), "-", "a shallow slope is still flat");
  assert.equal(edgeGlyph(1, 1, 2), "\\", "one cell across and one down is 63 degrees on screen");
  assert.equal(edgeGlyph(1, 2, 2), "|", "one across, two down is steep: a cell is twice as tall as it is wide");
  assert.equal(edgeGlyph(1, 1, 1), "\\");
});

test("fried-raster: a line touches each cell once, end to end", () => {
  const c = canvas(10, 4), seen = [];
  strokeLine((x, y, g, t) => { c.put(x, y, g); seen.push([x, y, +t.toFixed(2)]); }, 0.5, 1.5, 8.5, 1.5);
  assert.equal(c.text()[1].trimEnd(), "---------");
  assert.equal(seen.length, 9);
  assert.equal(seen[0][2], 0); assert.ok(seen[8][2] > 0.9, "t runs along the line");
  const d = canvas(6, 6);
  strokeLine(d.put, 0.5, 0.5, 5.5, 5.5);
  assert.equal(d.count(), 6);
  const forced = canvas(4, 1);
  strokeLine(forced.put, 0, 0.5, 3.9, 0.5, { glyph: "=" });
  assert.equal(forced.text()[0], "====");
});

test("fried-raster: a closed path joins its last point to its first", () => {
  const c = canvas(8, 5);
  strokePath(c.put, [[1.5, 0.5], [6.5, 0.5], [6.5, 3.5], [1.5, 3.5]], {}, true);
  const t = c.text();
  assert.equal(t[0].slice(2, 6), "----");
  assert.equal(t[2][1], "|"); assert.equal(t[2][6], "|");
  assert.equal(t[3].slice(2, 6), "----");
  assert.equal(c.count(), 2 * 6 + 2 * 2, "a 6 by 4 outline, every cell once");
});

test("fried-raster: a small ellipse outline looks like the hand-drawn one", () => {
  const c = canvas(11, 3);
  strokeEllipse(c.put, 5.5, 1.5, 5, 1.5);
  const t = c.text();
  assert.equal(t[1][0], "("); assert.equal(t[1][10], ")");
  assert.ok(t[0].includes("-"), "a flat top");
  assert.ok(t[0].includes(".") && (t[2].includes("`") || t[2].includes("'")), "soft corners: " + JSON.stringify(t));
  // A big one uses slanted sides instead of corners.
  const big = canvas(40, 16);
  strokeEllipse(big.put, 20, 8, 18, 7);
  assert.ok(big.text().join("").includes("/") && big.text().join("").includes("\\"));
});

test("fried-raster: fills cover cell centres, and scale with the shape", () => {
  const c = canvas(20, 10);
  let uvOk = true;
  fillEllipse((x, y, u, v) => { c.put(x, y); if (u * u + v * v > 1.0001) uvOk = false; }, 10, 5, 6, 3);
  assert.ok(uvOk, "u, v stay inside the unit circle");
  const area = c.count();
  assert.ok(Math.abs(area - Math.PI * 6 * 3) < 8, "about the ellipse's area: " + area);
  const c2 = canvas(40, 20);
  fillEllipse((x, y) => c2.put(x, y), 20, 10, 12, 6);
  assert.ok(Math.abs(c2.count() / area - 4) < 0.5, "twice the size, four times the cells");
  const r = canvas(8, 4); fillRect((x, y) => r.put(x, y), 1, 1, 5, 3);
  assert.deepEqual(r.text(), ["        ", " ####   ", " ####   ", "        "]);
  const tri = canvas(12, 6); fillPoly((x, y) => tri.put(x, y), [[1, 5], [11, 5], [6, 0]]);
  assert.ok(tri.count() > 20 && tri.text()[0].trim().length <= 2 && tri.text()[4].trim().length >= 8);
});

test("fried-raster: a capsule reports how far along and how far across", () => {
  let maxT = 0, maxD = 0, n = 0;
  fillCapsule((x, y, t, d) => { n++; maxT = Math.max(maxT, t); maxD = Math.max(maxD, d); }, 2, 2, 20, 2, 1.5);
  assert.ok(n > 40);
  assert.equal(maxT, 1);
  assert.ok(maxD <= 1 && maxD > 0.6);
});

test("fried-raster: strokePoly outlines a lumpy shape on the rim of its own fill", () => {
  const pts = [];
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, w = 1 + 0.12 * Math.cos(a * 3 + 1); pts.push([20 + Math.cos(a) * 9 * w, 8 + Math.sin(a) * 4 * w]); }
  const fill = new Set(), edge = new Map();
  fillPoly((x, y) => fill.add(x + "," + y), pts);
  strokePoly((x, y, g) => edge.set(x + "," + y, g), pts, { aspect: 2 });
  assert.ok(edge.size > 20);
  for (const k of edge.keys()) assert.ok(fill.has(k), "an outline cell is a cell the fill covers: " + k);
  const small = new Map();
  strokePoly((x, y, g) => small.set(x + "," + y, g), [[4, 1], [8, 1], [10, 2], [10, 4], [8, 5], [4, 5], [2, 4], [2, 2]], { aspect: 2 });
  assert.ok([...small.values()].some((g) => g === "." || g === "'" || g === "`"), "a small shape gets soft corners");
  strokePoly(() => assert.fail("two points are not a shape"), [[0, 0], [4, 4]]);
});

test("fried-raster: shapes that are not finite, or have no size, draw nothing instead of hanging", () => {
  const none = () => assert.fail("drew something");
  strokeLine(none, 0, 0, Infinity, 3);
  fillEllipse(none, 5, 5, NaN, 2); fillEllipse(none, 5, 5, 0, 2);
  fillPoly(none, [[0, 0], [Infinity, 0], [3, 3]]);
  fillCapsule(none, 0, 0, 4, 4, 0); fillCapsule(none, 0, 0, NaN, 4, 1);
  const got = [];
  fillCapsule((x, y, t, d) => got.push(d), 2, 2, 2, 2, 1.5, 2);               // a capsule of no length is a dot
  assert.ok(got.length > 0 && got.every((d) => d >= 0 && d <= 1));
});
