import test from "node:test";
import assert from "node:assert/strict";
import { createGrid, createGridRenderer, TRANSPARENT } from "../addons/fried-grid.js";

// A canvas with pixels and no font. Whatever glyph is drawn on it, the ink
// lands the same way: the cell's first pixel takes all of it, the second
// half of it (alpha 128), the rest none. A full block inks every pixel.
function pixelCanvas(log = []) {
  let inked = null, w = 0, h = 0;
  const ctx = {
    puts: log,
    createImageData: (cw, ch) => ({ width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) }),
    putImageData: (img, x, y, dx, dy, dw, dh) => { log.push([dx, dy, dw, dh]); },
    clearRect: () => { inked = null; },
    fillText: (s) => { inked = s; log.greys = log.greys || []; log.greys.push(ctx.fillStyle); },
    fillRect: (x, y, rw, rh) => { inked = rw >= w && rh >= h ? "block" : "rect"; },
    getImageData: (x, y, cw, ch) => {
      const data = new Uint8ClampedArray(cw * ch * 4);
      if (inked === "block") for (let i = 0; i < cw * ch; i++) data[i * 4 + 3] = 255;
      else if (inked !== null) { data[3] = 255; data[7] = 128; }
      return { data };
    },
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
  };
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 60 }) };
  Object.defineProperty(canvas, "width", { get: () => w, set: (v) => { w = v; } });
  Object.defineProperty(canvas, "height", { get: () => h, set: (v) => { h = v; } });
  return canvas;
}
// The pixel at (x, y) of the picture the renderer keeps, as [r, g, b, a].
function pixelReader(r) {
  let img = null;
  const real = r._ctx.putImageData;
  r._ctx.putImageData = (image, ...rest) => { img = image; real(image, ...rest); };
  return (x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
}
function make(alpha = false) {
  const puts = [], masks = [], canvas = pixelCanvas(puts);
  const r = createGridRenderer({ canvas, makeCanvas: () => pixelCanvas(masks), pixels: true, alpha });
  r._ctx = canvas.getContext();
  const at = pixelReader(r);
  r.resize(20, 10, 80, 60, 1);                       // cells of 4 by 6 pixels
  return { r, puts, at, masks };
}

test("fried-grid pixels: a cell is paper, with its glyph's ink laid over it by the mask", () => {
  const { r, puts, at, masks } = make();
  const g = createGrid(20, 10).clear(" ", 0xffffff, 0x102030);
  g.set(2, 1, "x", 0xff8040);
  assert.equal(r.draw(g), 200, "first frame: every cell");
  assert.deepEqual(puts, [[0, 0, 80, 60]], "and one put for the lot");
  assert.deepEqual(at(0, 0), [0x10, 0x20, 0x30, 255], "a blank cell is paper");
  assert.deepEqual(at(8, 6), [0xff, 0x80, 0x40, 255], "all the ink: the ink's colour");
  const mid = at(9, 6);
  assert.ok(Math.abs(mid[0] - (0x10 + (0xff - 0x10) * 128 / 255)) <= 1 && Math.abs(mid[1] - (0x20 + (0x80 - 0x20) * 128 / 255)) <= 1 && Math.abs(mid[2] - (0x30 + (0x40 - 0x30) * 128 / 255)) <= 1 && mid[3] === 255, "half the ink: half way from paper to ink: " + mid);
  assert.deepEqual(at(10, 6), [0x10, 0x20, 0x30, 255], "no ink: paper");
  assert.deepEqual(at(8, 7), [0x10, 0x20, 0x30, 255]);
  assert.equal(r.stats.atlas, 1, "one mask for one glyph");
  g.set(5, 5, "x", 0xf08848); g.set(6, 5, "x", 0xe89050);
  r.draw(g);
  assert.equal(r.stats.atlas, 1, "the same glyph in other colours about as bright needs no new mask");
  assert.deepEqual(at(20, 30), [0xf0, 0x88, 0x48, 255]); assert.deepEqual(at(24, 30), [0xe8, 0x90, 0x50, 255]);
  // A browser gives dark text less ink than light text, so the mask a glyph
  // is given is one drawn in a grey as bright as its ink.
  g.set(7, 5, "x", 0x201008); g.set(8, 5, "x", 0xffffff); g.set(9, 5, "x", 0x0000ff);
  r.draw(g);
  assert.equal(r.stats.atlas, 4, "a mask more for dark ink, for white, and for blue (which is darker than it looks)");
  assert.deepEqual(masks.greys, ["#b6b6b6", "#000000", "#ffffff", "#494949"], "each drawn in a grey of its band");
  g.set(10, 5, "⠿", 0x201008); g.set(11, 5, "⠿", 0xffffff);
  r.draw(g);
  assert.equal(r.stats.atlas, 5, "dots and blocks are shapes, not text: one mask whatever the ink");
});

test("fried-grid pixels: only what changed is written, and each band of changed rows is one put", () => {
  const { r, puts } = make();
  const g = createGrid(20, 10).clear(" ", 0xffffff, 0x000000);
  r.draw(g); puts.length = 0;
  assert.equal(r.draw(g), 0); assert.deepEqual(puts, [], "nothing changed: nothing put");
  g.set(3, 2, "a", 0xffffff); g.set(7, 3, "b", 0xffffff); g.set(15, 8, "c", 0xffffff);
  assert.equal(r.draw(g), 3);
  assert.deepEqual(puts, [[12, 12, 20, 12], [60, 48, 4, 6]], "rows 2 and 3 together (columns 3 to 7), row 8 by itself");
  puts.length = 0;
  g.set(3, 2, "a", 0xffffff);
  assert.equal(r.draw(g), 0, "the same cell written again is not a change");
  r.invalidate();
  assert.equal(r.draw(g), 200); assert.deepEqual(puts, [[0, 0, 80, 60]]);
  r.invalidate({ atlas: true }); r.draw(g);
  assert.equal(r.stats.atlas, 3, "masks made afresh (a font arrived): a, b, c");
  assert.deepEqual(r.cellAt(40, 30), { x: 10, y: 5 });
});

test("fried-grid pixels: over nothing, ink keeps its own alpha and paper is clear", () => {
  const { r, at } = make(true);
  const g = createGrid(20, 10).clear(" ", 0xffffff, TRANSPARENT);
  g.set(0, 0, "x", 0x336699); g.set(1, 0, "█", 0x336699); g.set(2, 0, "y", 0xffffff, 0x000000);
  r.draw(g);
  assert.deepEqual(at(0, 0), [0x33, 0x66, 0x99, 255]);
  assert.deepEqual(at(1, 0), [0x33, 0x66, 0x99, 128], "half the ink over nothing is half there");
  assert.deepEqual(at(2, 0), [0, 0, 0, 0], "no ink over nothing is nothing");
  assert.deepEqual(at(40, 30), [0, 0, 0, 0], "a blank transparent cell is nothing");
  assert.deepEqual(at(7, 5), [0x33, 0x66, 0x99, 255], "a full block inks its whole cell");
  assert.deepEqual(at(10, 0), [0, 0, 0, 255], "and a cell with paper of its own is opaque beside them");
});

test("fried-grid pixels: counts the same cells as the canvas-call renderer, frame for frame", () => {
  const quiet = () => { const c = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); return { width: 0, height: 0, style: {}, getContext: () => c }; };
  const a = createGridRenderer({ canvas: quiet(), makeCanvas: quiet }), b = make().r;
  a.resize(20, 10, 80, 60, 1);
  const g = createGrid(20, 10).clear(" ", 0xffffff, 0x101010);
  let s = 7;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let frame = 0; frame < 30; frame++) {
    for (let k = 0; k < 12; k++) g.set(Math.floor(rnd() * 20), Math.floor(rnd() * 10), "abc ."[Math.floor(rnd() * 5)], rnd() < 0.5 ? 0xffffff : 0x808080, rnd() < 0.8 ? 0x101010 : 0x303030);
    assert.equal(b.draw(g), a.draw(g), "frame " + frame);
  }
});

test("fried-grid: when a font finishes loading, every glyph is drawn afresh (both ways of drawing)", () => {
  // A FontFaceSet that can be told a font has arrived.
  const fontSet = () => { const hear = []; return { addEventListener: (k, f) => { if (k === "loadingdone") hear.push(f); }, arrive: () => hear.forEach((f) => f({})), heard: hear }; };
  for (const pixels of [true, false]) {
    const fonts = fontSet(), masks = [], canvas = pixelCanvas([]);
    const quiet = () => { const c = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); return { width: 0, height: 0, style: {}, getContext: () => c }; };
    const r = createGridRenderer({ canvas: pixels ? canvas : quiet(), makeCanvas: pixels ? () => pixelCanvas(masks) : quiet, pixels, fonts });
    assert.equal(fonts.heard.length, 1, "it listens for fonts arriving");
    fonts.arrive();                                              // (before it has a size: nothing to do, and no harm)
    r.resize(20, 10, 80, 60, 1);
    const g = createGrid(20, 10).clear(" ", 0xffffff, 0x101010);
    g.put(0, 0, "abc", 0xffffff);
    assert.equal(r.draw(g), 200); assert.equal(r.draw(g), 0, "drawn, and nothing changed");
    const made = r.stats.atlas;
    assert.ok(made >= 3);
    fonts.arrive();
    assert.equal(r.draw(g), 200, (pixels ? "pixels" : "canvas calls") + ": the whole grid is drawn again, though no cell changed");
    assert.equal(r.stats.atlas, made, "with every glyph made again, not kept from before");
    if (pixels) assert.equal(masks.greys.length, made * 2, "each mask drawn a second time, in the font that is there now");
    assert.equal(r.draw(g), 0);
  }
  const none = createGridRenderer({ canvas: pixelCanvas([]), makeCanvas: () => pixelCanvas([]), pixels: true, fonts: null });
  none.resize(4, 2, 16, 12, 1);
  assert.equal(none.draw(createGrid(4, 2).clear(" ", 0xffffff, 0)), 8, "with no font set to listen to it simply draws");
});

test("fried-grid: setFont draws in another font from then on, both ways of drawing; the same font again changes nothing", () => {
  for (const pixels of [true, false]) {
    const fonts = [];
    const watch = () => { const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === "getImageData" ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : k === "createImageData" ? (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) : () => {})), set: (t, k, v) => { if (k === "font") fonts.push(v); t[k] = v; return true; } }); return { width: 0, height: 0, style: {}, getContext: () => ctx }; };
    const r = createGridRenderer({ canvas: watch(), makeCanvas: watch, pixels, font: "Alpha", fonts: null });
    r.resize(10, 4, 40, 24, 1);
    const g = createGrid(10, 4).clear(" ", 0xffffff, 0x101010);
    g.put(0, 0, "ab", 0xffffff);
    r.draw(g);
    assert.equal(r.font, "Alpha");
    assert.ok(fonts.some((f) => f.endsWith("px Alpha")), "drawn in the first font");
    assert.equal(r.draw(g), 0, "nothing changed, nothing drawn");
    assert.equal(r.setFont("Beta Mono"), true);
    assert.equal(r.font, "Beta Mono");
    assert.equal(r.draw(g), 40, (pixels ? "pixels" : "canvas calls") + ": the whole grid again");
    assert.ok(fonts.slice(-3).some((f) => f.endsWith("px Beta Mono")), "and in the new font: " + fonts.slice(-3));
    assert.equal(r.setFont("Beta Mono"), false, "the same font: nothing to do");
    assert.equal(r.draw(g), 0);
  }
  const early = createGridRenderer({ canvas: pixelCanvas([]), makeCanvas: () => pixelCanvas([]), pixels: true, fonts: null });
  assert.equal(early.setFont("Gamma"), true, "before it has a size it only remembers the font");
  early.resize(4, 2, 16, 12, 1);
  assert.equal(early.font, "Gamma");
});
