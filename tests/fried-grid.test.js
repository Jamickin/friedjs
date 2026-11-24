import test from "node:test";
import assert from "node:assert/strict";
import {
  rgb, hex, litColor, addColor, mixColor, scaleColor, luma, quantize, cssColor, ramp,
  createGrid, countDirty, createLight, shade, createDots, createGridRenderer,
} from "../addons/fried-grid.js";

test("fried-grid: colour helpers", () => {
  assert.equal(rgb(255, 128, 0), 0xff8000);
  assert.equal(hex("#1d150d"), 0x1d150d);
  assert.equal(hex("ffffff"), 0xffffff);
  assert.equal(litColor(0x804020, 0.5, 0.5, 0.5), 0x402010);
  assert.equal(litColor(0x808080, 4, 4, 4), 0xffffff, "light clamps at white");
  assert.equal(addColor(0xf0f0f0, 0x202020), 0xffffff);
  assert.equal(scaleColor(0x646464, 0), 0);
  assert.equal(mixColor(0x000000, 0xffffff, 0.5), 0x7f7f7f);
  assert.ok(Math.abs(luma(0xffffff) - 1) < 1e-9);
  assert.equal(quantize(0x123456, 4), 0x103050);
  assert.equal(quantize(0x123456, 8), 0x123456);
  assert.equal(cssColor(0x0a0b0c), "#0a0b0c");
  assert.equal(ramp(" .:#", 0), " ");
  assert.equal(ramp(" .:#", 0.99), "#");
  assert.equal(ramp(" .:#", 2), "#");
});

test("fried-grid: createGrid sets, puts, fills and clips", () => {
  const g = createGrid(8, 3);
  assert.equal(g.n, 24);
  g.clear(".", 1, 2);
  g.set(1, 1, "A", 10, 20);
  g.set(2, 1, "B", 11);                 // bg undefined keeps the paper
  g.set(-1, 0, "X", 1, 1);              // off the grid: ignored
  g.set(8, 2, "X", 1, 1);
  assert.equal(g.ch[g.index(1, 1)], 65);
  assert.equal(g.bg[g.index(1, 1)], 20);
  assert.equal(g.bg[g.index(2, 1)], 2);
  assert.equal(g.fg[g.index(2, 1)], 11);
  g.put(4, 0, "a b", 5);
  assert.equal(String.fromCodePoint(g.ch[4], g.ch[5], g.ch[6]), "a.b", "spaces in put() are skipped");
  g.fill(6, 1, 5, 5, "#", 7, 8);        // runs off the edge: clipped
  assert.equal(g.ch[g.index(7, 2)], 35);
  g.set(0, 0, "✶", 1);
  assert.equal(g.ch[0], "✶".codePointAt(0));
  const h = createGrid(8, 3).copyFrom(g);
  assert.equal(countDirty(g, h), 0);
  h.set(3, 2, "z", 1);
  assert.equal(countDirty(g, h), 1);
});

test("fried-grid: a point light falls off to nothing at its radius and is round on screen", () => {
  const L = createLight(40, 20, 2).clear(0);
  L.point(20, 10, 5, [1, 0.5, 0.25]);
  const at = (x, y) => L.r[y * 40 + x];
  assert.ok(at(20, 10) > 0.9, "bright at the centre");
  assert.ok(at(20, 12) < at(20, 10) && at(20, 12) > 0);
  assert.equal(at(20, 16), 0, "dark past the radius (rows)");
  assert.equal(at(31, 10), 0, "dark past the radius (columns, twice as many)");
  assert.ok(at(28, 10) > 0, "reaches further across than down, in cells");
  assert.ok(Math.abs(L.g[10 * 40 + 20] / at(20, 10) - 0.5) < 1e-6, "keeps its colour");
});

test("fried-grid: quad fills a convex patch; blur spreads light to neighbours", () => {
  const L = createLight(20, 10).clear(0);
  L.quad([[2, 2], [8, 2], [10, 6], [4, 6]], [1, 1, 1], 0.5);
  assert.equal(L.r[3 * 20 + 5], 0.5);
  assert.equal(L.r[3 * 20 + 15], 0);
  const M = createLight(9, 9).clear(0);
  M.add(4, 4, 9, 0, 0);
  M.blur(1);
  assert.ok(M.r[4 * 9 + 4] > M.r[4 * 9 + 5] && M.r[4 * 9 + 5] > 0 && M.r[3 * 9 + 4] > 0);
  let sum = 0; for (const v of M.r) sum += v;
  assert.ok(Math.abs(sum - 9) < 1e-3, "blur moves light, it does not make any");
});

test("fried-grid: shade multiplies by light, adds emissive, quantizes", () => {
  const src = createGrid(2, 1), out = createGrid(2, 1), L = createLight(2, 1).clear(0.5);
  src.set(0, 0, "a", 0x808080, 0x404040);
  src.set(1, 0, "b", 0x808080, 0x404040);
  const em = new Uint32Array(2); em[1] = 0x400000;
  shade(src, L, out, { bits: 8, emissive: em });
  assert.equal(out.fg[0], 0x404040);
  assert.equal(out.bg[0], 0x202020);
  assert.equal(out.fg[1], 0x804040);
  // A flicker smaller than one quantization step leaves the cell unchanged.
  const a = createGrid(2, 1), b = createGrid(2, 1);
  shade(src, createLight(2, 1).clear(0.5), a, { bits: 5 });
  shade(src, createLight(2, 1).clear(0.505), b, { bits: 5 });
  assert.equal(countDirty(a, b), 0);
});

test("fried-grid: dots become Braille, one glyph per cell, inked by weight", () => {
  const D = createDots(4, 2), g = createGrid(4, 2);
  D.set(0, 0, 1);                        // top-left dot of cell (0,0)
  D.set(1, 3, 0.5);                      // bottom-right dot of cell (0,0)
  D.line(2, 4, 7, 4, 0.8);               // along the top of the second row of cells
  const seen = [];
  const n = D.blit(g, (w, cx, cy) => { seen.push([cx, cy, +w.toFixed(2)]); return 0xffffff; });
  assert.equal(g.ch[0], 0x2800 + 0x01 + 0x80);
  assert.deepEqual(seen[0], [0, 0, 0.75]);
  assert.equal(g.ch[g.index(1, 1)], 0x2800 + 0x01 + 0x08);
  assert.equal(n, 4);
  assert.equal(g.ch[g.index(1, 0)], 32, "cells without dots are left alone");
});

// A canvas that only counts what is drawn on it.
function fakeCanvas() {
  const calls = { fillRect: 0, drawImage: 0, fillText: 0, clearRect: 0 };
  const ctx = new Proxy({ calls }, {
    get(t, k) { if (k in t) return t[k]; if (k in calls) return () => { calls[k]++; }; return () => {}; },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { width: 0, height: 0, style: {}, calls, getContext: () => ctx, getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 200 }) };
}

test("fried-grid: the renderer redraws only the cells whose key changed", () => {
  const canvas = fakeCanvas(), overlay = fakeCanvas();
  const r = createGridRenderer({ canvas, overlay, makeCanvas: fakeCanvas });
  assert.equal(r.resize(40, 20, 400, 200, 1), true);
  assert.equal(canvas.width, 400);
  const g = createGrid(40, 20).clear(" ", 0xffffff, 0x101010);
  g.put(0, 0, "hello", 0xffffff);
  assert.equal(r.draw(g), 800, "first frame draws everything");
  assert.equal(canvas.calls.drawImage, 5, "only the five glyphs are blitted; blank cells are just paper");
  assert.equal(r.draw(g), 0, "an unchanged grid draws nothing");
  g.set(3, 3, "x", 0xff0000);
  g.set(4, 3, "y", 0xffffff, 0x202020);
  assert.equal(r.draw(g), 2);
  assert.equal(r.stats.atlas, 6, "h e l o x y: one atlas slot per glyph and colour (the second l reuses the first)");
  r.invalidate();
  assert.equal(r.draw(g), 800);
  assert.equal(r.resize(40, 20, 400, 200, 1), false, "same size: nothing to do");
  assert.deepEqual(r.cellAt(210, 120), { x: 20, y: 10 });
  r.sprites([{ x: 1.5, y: 2.25, ch: "*", color: 0xffffff, alpha: 0.5, add: true }]);
  assert.equal(overlay.calls.fillText, 1);
  assert.equal(overlay.calls.clearRect, 1);
});
