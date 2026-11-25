// fried-grid.js -- optional addon: a character grid for real-time drawing.
//
// FriedJS's virtual DOM is the wrong tool for a full-screen grid of cells
// that all change sixty times a second (thousands of vnodes built and
// diffed per frame just to recolour text). This addon is the other half: a
// typed-array cell buffer you paint into however you like, a per-cell light
// field, a sub-cell dot layer (Braille), and a canvas renderer that redraws
// only the cells whose (glyph, ink, paper) changed since the last frame --
// a keyed diff, one key per cell.
//
// The grid lives inside an ordinary ui("canvas", { ref }) node: the VDOM
// owns the element, this owns its pixels. Everything except
// createGridRenderer is plain data and runs in Node.
//
// Colours are 0xRRGGBB integers throughout.

// -- colour ------------------------------------------------------------------

// A paper colour meaning "nothing here": a renderer made with { alpha: true }
// clears such a cell instead of filling it, so a grid can lie over another.
export const TRANSPARENT = 0x1000000;

export const rgb = (r, g, b) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
export const hex = (s) => parseInt(s.charAt(0) === "#" ? s.slice(1) : s, 16) & 0xffffff;
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// Multiply a colour by a light (three floats; 1 = unchanged, above 1 brightens).
export function litColor(c, lr, lg, lb) {
  return (clamp255(((c >> 16) & 255) * lr) << 16) | (clamp255(((c >> 8) & 255) * lg) << 8) | clamp255((c & 255) * lb);
}
export function addColor(a, b) {
  return (clamp255(((a >> 16) & 255) + ((b >> 16) & 255)) << 16) | (clamp255(((a >> 8) & 255) + ((b >> 8) & 255)) << 8) | clamp255((a & 255) + (b & 255));
}
export function scaleColor(c, k) { return litColor(c, k, k, k); }
export function mixColor(a, b, t) {
  const u = 1 - t;
  return (clamp255(((a >> 16) & 255) * u + ((b >> 16) & 255) * t) << 16) | (clamp255(((a >> 8) & 255) * u + ((b >> 8) & 255) * t) << 8) | clamp255((a & 255) * u + (b & 255) * t);
}
// Perceived brightness, 0..1.
export function luma(c) { return (((c >> 16) & 255) * 0.299 + ((c >> 8) & 255) * 0.587 + (c & 255) * 0.114) / 255; }
// Drop the low bits of each channel (bits = how many to keep, 1..8). A light
// that flickers by less than one step then leaves a cell's key unchanged, so
// the renderer skips it.
export function quantize(c, bits) {
  if (bits >= 8) return c;
  const m = (0xff << (8 - bits)) & 0xff;
  return c & ((m << 16) | (m << 8) | m);
}
const cssCache = new Map();
export function cssColor(c) {
  let s = cssCache.get(c);
  if (!s) { if (cssCache.size > 8192) cssCache.clear(); s = "#" + (c & 0xffffff).toString(16).padStart(6, "0"); cssCache.set(c, s); }
  return s;
}
// Pick a glyph from a density ramp (" .:-=+*#%@") by t in 0..1.
export function ramp(chars, t) {
  const n = chars.length;
  return chars.charAt(t <= 0 ? 0 : t >= 1 ? n - 1 : (t * n) | 0);
}

// -- the cell buffer -----------------------------------------------------------

const code = (ch) => (typeof ch === "string" ? ch.codePointAt(0) : ch);

export function createGrid(cols, rows) {
  const n = cols * rows;
  const g = {
    cols, rows, n,
    ch: new Uint32Array(n).fill(32),
    fg: new Uint32Array(n),
    bg: new Uint32Array(n),
    inside: (x, y) => x >= 0 && y >= 0 && x < cols && y < rows,
    index: (x, y) => y * cols + x,
    clear(ch = 32, fg = 0, bg = 0) { g.ch.fill(code(ch)); g.fg.fill(fg); g.bg.fill(bg); return g; },
    // bg left undefined keeps the cell's paper.
    set(x, y, ch, fg, bg) {
      x = Math.floor(x); y = Math.floor(y);
      if (!(x >= 0 && y >= 0 && x < cols && y < rows)) return;
      const i = y * cols + x;
      g.ch[i] = code(ch); g.fg[i] = fg;
      if (bg !== undefined) g.bg[i] = bg;
    },
    // A string along a row; spaces in it are skipped unless `solid`.
    put(x, y, text, fg, bg, solid = false) {
      let k = 0;
      for (const c of text) { if (solid || c !== " ") g.set(x + k, y, c, fg, bg); k++; }
    },
    // A rectangle of one cell: clipped once, then filled a row at a time.
    fill(x, y, w, h, ch, fg, bg) {
      const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(cols, Math.floor(x) + Math.floor(w)), y0 = Math.max(0, Math.floor(y)), y1 = Math.min(rows, Math.floor(y) + Math.floor(h)), c = code(ch);
      if (!(x0 < x1 && y0 < y1)) return;
      for (let yy = y0; yy < y1; yy++) {
        const a = yy * cols + x0, b = yy * cols + x1;
        g.ch.fill(c, a, b); g.fg.fill(fg, a, b);
        if (bg !== undefined) g.bg.fill(bg, a, b);
      }
    },
    copyFrom(o) { g.ch.set(o.ch); g.fg.set(o.fg); g.bg.set(o.bg); return g; },
  };
  return g;
}

// How many cells differ between two grids of the same size (what a renderer
// would have to redraw).
export function countDirty(a, b) {
  let d = 0;
  for (let i = 0; i < a.n; i++) if (a.ch[i] !== b.ch[i] || a.fg[i] !== b.fg[i] || a.bg[i] !== b.bg[i]) d++;
  return d;
}

// -- light ------------------------------------------------------------------------
// One RGB float triple per cell. `aspect` is cell height / cell width (about
// 2 for a terminal font), so a "radius" in rows draws round on screen.

export function createLight(cols, rows, aspect = 2) {
  const n = cols * rows;
  const L = {
    cols, rows, n, aspect,
    r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n),
    clear(cr = 0, cg = cr, cb = cr) { L.r.fill(cr); L.g.fill(cg); L.b.fill(cb); return L; },
    add(x, y, cr, cg, cb) {
      x |= 0; y |= 0;
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      const i = y * cols + x; L.r[i] += cr; L.g[i] += cg; L.b[i] += cb;
    },
    // A point light at (x, y) cells, reaching `radius` rows, falling off
    // smoothly to nothing at the edge. color is [r, g, b] floats.
    point(x, y, radius, color, power = 1) {
      if (!(radius > 0)) return L;
      const rx = radius * aspect, x0 = Math.max(0, Math.floor(x - rx)), x1 = Math.min(cols - 1, Math.ceil(x + rx));
      const y0 = Math.max(0, Math.floor(y - radius)), y1 = Math.min(rows - 1, Math.ceil(y + radius));
      const inv = 1 / (radius * radius), cr = color[0] * power, cg = color[1] * power, cb = color[2] * power;
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy + 0.5 - y;
        for (let xx = x0; xx <= x1; xx++) {
          const dx = (xx + 0.5 - x) / aspect, d2 = (dx * dx + dy * dy) * inv;
          if (d2 >= 1) continue;
          const f = (1 - d2) * (1 - d2), i = yy * cols + xx;
          L.r[i] += cr * f; L.g[i] += cg * f; L.b[i] += cb * f;
        }
      }
      return L;
    },
    // A convex four-cornered patch (a window's light on a table).
    quad(pts, color, power = 1) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      const cr = color[0] * power, cg = color[1] * power, cb = color[2] * power;
      for (let yy = Math.max(0, Math.floor(y0)); yy <= Math.min(rows - 1, Math.ceil(y1)); yy++) {
        for (let xx = Math.max(0, Math.floor(x0)); xx <= Math.min(cols - 1, Math.ceil(x1)); xx++) {
          const px = xx + 0.5, py = yy + 0.5;
          let sign = 0, inside = true;
          for (let k = 0; k < pts.length; k++) {
            const a = pts[k], c = pts[(k + 1) % pts.length];
            const cross = (c[0] - a[0]) * (py - a[1]) - (c[1] - a[1]) * (px - a[0]);
            if (cross !== 0) { const s = cross > 0 ? 1 : -1; if (sign === 0) sign = s; else if (s !== sign) { inside = false; break; } }
          }
          if (inside) { const i = yy * cols + xx; L.r[i] += cr; L.g[i] += cg; L.b[i] += cb; }
        }
      }
      return L;
    },
    // Soften: a separable blur, wider across than down by the cell aspect.
    blur(passes = 1) {
      const tmp = L._tmp || (L._tmp = new Float32Array(n));
      for (let p = 0; p < passes; p++) {
        for (const ch of [L.r, L.g, L.b]) {
          for (let y = 0; y < rows; y++) {
            const o = y * cols;
            for (let x = 0; x < cols; x++) {
              const a = ch[o + (x > 1 ? x - 2 : 0)], b = ch[o + (x > 0 ? x - 1 : 0)], c = ch[o + x], d = ch[o + (x < cols - 1 ? x + 1 : x)], e = ch[o + (x < cols - 2 ? x + 2 : cols - 1)];
              tmp[o + x] = (a + 2 * b + 3 * c + 2 * d + e) / 9;
            }
          }
          for (let y = 0; y < rows; y++) {
            const up = (y > 0 ? y - 1 : 0) * cols, o = y * cols, dn = (y < rows - 1 ? y + 1 : y) * cols;
            for (let x = 0; x < cols; x++) ch[o + x] = (tmp[up + x] + 2 * tmp[o + x] + tmp[dn + x]) / 4;
          }
        }
      }
      return L;
    },
  };
  return L;
}

// Light a painted grid into `out`: ink and paper multiplied by the light of
// their cell, then quantized so small changes in light don't dirty the cell.
// `emissive` (optional Uint32Array of colours) is added to the ink after
// lighting: a flame is as bright in the dark as in the light.
export function shade(src, light, out, { bits = 6, emissive = null, paper = 1 } = {}) {
  const { r, g, b } = light;
  for (let i = 0; i < src.n; i++) {
    let fg = litColor(src.fg[i], r[i], g[i], b[i]);
    if (emissive && emissive[i]) fg = addColor(fg, emissive[i]);
    out.ch[i] = src.ch[i];
    out.fg[i] = quantize(fg, bits);
    out.bg[i] = quantize(litColor(src.bg[i], r[i] * paper, g[i] * paper, b[i] * paper), bits);
  }
  return out;
}

// -- sub-cell dots (Braille) -----------------------------------------------------
// Each cell holds 2 x 4 dots, so a dot layer has twice the columns and four
// times the rows of the grid. Dots carry a weight (0..1): how hard the chalk
// was pressed, how worn it is. blit() turns them into Braille glyphs, one per
// cell, inked by the mean weight of the dots that are set. The layer keeps
// the bounds of what was set, so clearing and blitting a few marks on a big
// grid only costs those marks (if you write D.v yourself, call D.touch).

const BRAILLE_BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

export function createDots(cols, rows) {
  const w = cols * 2, h = rows * 4;
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;          // the bounds of what has been set since the last clear
  const D = {
    cols, rows, w, h,
    v: new Float32Array(w * h),
    clear() {
      for (let y = by0; y <= by1; y++) D.v.fill(0, y * w + bx0, y * w + bx1 + 1);
      bx0 = w; by0 = h; bx1 = -1; by1 = -1;
      return D;
    },
    // Say that dots in this box (dot coordinates, inclusive) were written by hand.
    touch(x0, y0, x1, y1) {
      bx0 = Math.max(0, Math.min(bx0, Math.floor(x0))); by0 = Math.max(0, Math.min(by0, Math.floor(y0)));
      bx1 = Math.min(w - 1, Math.max(bx1, Math.floor(x1))); by1 = Math.min(h - 1, Math.max(by1, Math.floor(y1)));
      return D;
    },
    set(x, y, weight = 1) {
      x = Math.floor(x); y = Math.floor(y);
      if (!(x >= 0 && y >= 0 && x < w && y < h)) return;
      const i = y * w + x;
      if (weight > D.v[i]) D.v[i] = weight;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    },
    get(x, y) { return x < 0 || y < 0 || x >= w || y >= h ? 0 : D.v[y * w + x]; },
    // A line in dot coordinates (floats).
    line(x0, y0, x1, y1, weight = 1) {
      const dx = x1 - x0, dy = y1 - y0, steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 1.5));
      for (let k = 0; k <= steps; k++) D.set(x0 + dx * k / steps, y0 + dy * k / steps, weight);
    },
    // Write the dots into a grid as Braille. colorOf(weight, cx, cy) gives the
    // ink for a cell; cells with no dots are left alone. Returns cells written.
    // `grid` is anything with set(x, y, glyph, color), or just that function.
    blit(grid, colorOf, threshold = 0.05) {
      let written = 0;
      const put = typeof grid === "function" ? grid : (x, y, g, c) => grid.set(x, y, g, c);
      for (let cy = by0 >> 2; cy <= by1 >> 2; cy++) {
        for (let cx = bx0 >> 1; cx <= bx1 >> 1; cx++) {
          let bits = 0, sum = 0, cnt = 0;
          for (let r = 0; r < 4; r++) {
            const o = (cy * 4 + r) * w + cx * 2;
            const a = D.v[o], b = D.v[o + 1];
            if (a > threshold) { bits |= BRAILLE_BIT[r][0]; sum += a; cnt++; }
            if (b > threshold) { bits |= BRAILLE_BIT[r][1]; sum += b; cnt++; }
          }
          if (bits) { put(cx, cy, 0x2800 + bits, colorOf(sum / cnt, cx, cy)); written++; }
        }
      }
      return written;
    },
  };
  return D;
}

// -- the canvas renderer ------------------------------------------------------------
// createGridRenderer({ canvas, overlay?, font? })
//   canvas   the <canvas> the cells are drawn on
//   overlay  an optional second <canvas> stacked on top, cleared every frame,
//            for sprites: glyphs at fractional cell positions (smooth motion
//            that never dirties the cell layer underneath)
//
//   alpha    true lets cells whose paper is TRANSPARENT show what is behind
//            the canvas (a UI grid over a scene grid)
//   pixels   true draws by writing pixels, not by canvas calls: each glyph
//            is kept once as a mask (how much ink each pixel of a cell
//            gets), a changed cell is written straight into one ImageData,
//            and each band of changed rows goes to the canvas in one
//            putImageData. What a frame costs is then the pixels that
//            changed. Without it every changed cell is a fillRect and a
//            drawImage, and every (glyph, colour) pair a slot in an atlas:
//            fine for a few hundred cells a frame, slow for thousands (a
//            light that moves over a fine grid). The picture is the same to
//            within a few levels: a browser draws dark text thinner than
//            light text, so a glyph has eight masks, one for each band of
//            ink brightness, each drawn by the browser in a grey that bright.
//
// r.resize(cols, rows, cssWidth, cssHeight, dpr)   fit the grid to a box
// r.draw(grid)       redraw the cells whose key changed; returns how many
// r.sprites(list)    [{ x, y, ch, color, alpha?, scale?, add?, glow? }], x/y in cells
// r.cellAt(clientX, clientY) -> { x, y } in (fractional) cells
// r.invalidate()     force a full redraw next frame; invalidate({ atlas: true })
//                    also draws every glyph afresh. (The renderer does that
//                    itself whenever a font finishes loading.)
// r.stats            { drawn, cells, atlas }

const BRAILLE_DOT = [[0x01, 0, 0], [0x02, 0, 1], [0x04, 0, 2], [0x40, 0, 3], [0x08, 1, 0], [0x10, 1, 1], [0x20, 1, 2], [0x80, 1, 3]];
// An ImageData's bytes run R, G, B, A. Read as 32-bit words that is A B G R on
// nearly every machine (the low byte first), and R G B A on the few that put
// the high byte first.
const BYTES_RGBA = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 1;
// Which of eight bands of brightness an ink is in: its luminance worked out
// in linear light and brought back, the way text rasterisers judge it.
const LINEAR = Float32Array.from({ length: 256 }, (_, v) => Math.pow(v / 255, 2.2));
function inkBand(c) {
  const y = LINEAR[(c >> 16) & 255] * 0.2126 + LINEAR[(c >> 8) & 255] * 0.7152 + LINEAR[c & 255] * 0.0722;
  const band = (Math.pow(y, 1 / 2.2) * 255 + 0.5) >> 5;
  return band > 7 ? 7 : band;
}

export function createGridRenderer({ canvas, overlay = null, font = "monospace", weight = "400", makeCanvas = null, alpha = false, pixels = false, fonts = undefined }) {
  const newCanvas = makeCanvas || (() => document.createElement("canvas"));
  const ctx = canvas.getContext("2d", { alpha });
  const octx = overlay ? overlay.getContext("2d") : null;
  let cols = 0, rows = 0, cw = 0, chh = 0, dpr = 1, fontPx = 0;
  let pCh = null, pFg = null, pBg = null, full = true;
  let atlas = null, actx = null, slots = new Map(), perRow = 0, capacity = 0;
  // (pixels: the picture, its pixels as 32-bit words, each glyph's mask, the
  // small canvas a glyph is drawn on to get its mask, and the cells changed
  // in each row this frame.)
  let img = null, px = null, masks = new Map(), mctx = null, rowLo = null, rowHi = null;
  const stats = { drawn: 0, cells: 0, atlas: 0 };

  function buildAtlas() {
    if (!cw || !chh) return;
    if (pixels) {
      img = ctx.createImageData(cols * cw, rows * chh); px = new Uint32Array(img.data.buffer);
      const m = newCanvas(); m.width = cw; m.height = chh;
      mctx = m.getContext("2d", { willReadFrequently: true });
      masks = new Map(); rowLo = new Int32Array(rows); rowHi = new Int32Array(rows);
      return;
    }
    atlas = newCanvas();
    perRow = Math.max(8, Math.floor(2048 / cw));
    const rowsA = Math.max(8, Math.floor(2048 / chh));
    atlas.width = perRow * cw; atlas.height = rowsA * chh;
    capacity = perRow * rowsA;
    actx = atlas.getContext("2d");
    slots = new Map();
  }

  function resize(c, r, cssW, cssH, ratio = 1) {
    dpr = ratio;
    // (A hair is added before flooring: a size worked out as cells times
    // whole pixels must not come back one pixel short.)
    const ncw = Math.max(2, Math.floor(cssW * dpr / c + 1e-6)), nch = Math.max(4, Math.floor(cssH * dpr / r + 1e-6));
    if (c === cols && r === rows && ncw === cw && nch === chh) return false;
    cols = c; rows = r; cw = ncw; chh = nch;
    fontPx = Math.max(4, Math.floor(Math.min(chh * 0.86, cw * 1.72)));
    for (const cv of overlay ? [canvas, overlay] : [canvas]) {
      cv.width = cols * cw; cv.height = rows * chh;
      if (cv.style) { cv.style.width = (cols * cw / dpr) + "px"; cv.style.height = (rows * chh / dpr) + "px"; }
    }
    pCh = new Uint32Array(cols * rows); pFg = new Uint32Array(cols * rows); pBg = new Uint32Array(cols * rows);
    full = true;
    buildAtlas();
    return true;
  }

  // A glyph in one colour, drawn once into the atlas and blitted from then on.
  function slotOf(ch, color) {
    const key = ch * 16777216 + color;
    let s = slots.get(key);
    if (s !== undefined) return s;
    if (slots.size >= capacity) { slots = new Map(); actx.clearRect(0, 0, atlas.width, atlas.height); }
    s = slots.size;
    slots.set(key, s);
    const x = (s % perRow) * cw, y = Math.floor(s / perRow) * chh;
    actx.clearRect(x, y, cw, chh);
    inkGlyph(actx, ch, x, y, color);
    return s;
  }

  // One glyph, in one colour, in the cell whose corner is (x, y) of `c`.
  function inkGlyph(c, ch, x, y, color) {
    c.fillStyle = cssColor(color);
    if (ch >= 0x2800 && ch <= 0x28ff) {
      // Braille, drawn as real dots so it is crisp whatever the font has.
      const bits = ch - 0x2800, dw = Math.max(1, Math.round(cw * 0.3)), dh = Math.max(1, Math.round(chh * 0.15));
      for (const [bit, dx, dy] of BRAILLE_DOT) {
        if (bits & bit) c.fillRect(x + Math.round(cw * (0.25 + 0.5 * dx) - dw / 2), y + Math.round(chh * (0.125 + 0.25 * dy) - dh / 2), dw, dh);
      }
    } else if (ch === 0x2588) c.fillRect(x, y, cw, chh);
    else if (ch === 0x2580) c.fillRect(x, y, cw, Math.round(chh / 2));
    else if (ch === 0x2584) c.fillRect(x, y + Math.round(chh / 2), cw, chh - Math.round(chh / 2));
    else if (ch === 0x258c) c.fillRect(x, y, Math.round(cw / 2), chh);
    else if (ch === 0x2590) c.fillRect(x + Math.round(cw / 2), y, cw - Math.round(cw / 2), chh);
    else if (ch >= 0x2591 && ch <= 0x2593) { c.globalAlpha = (ch - 0x2590) * 0.25; c.fillRect(x, y, cw, chh); c.globalAlpha = 1; }
    else {
      c.save();
      c.beginPath(); c.rect(x, y, cw, chh); c.clip();
      c.font = `${weight} ${fontPx}px ${font}`;
      c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(String.fromCodePoint(ch), x + cw / 2, y + chh / 2 + chh * 0.04);
      c.restore();
    }
  }

  // (pixels) A glyph's mask: how much ink each pixel of a cell gets, 0..255,
  // drawn once and read back. null for a glyph with no ink at all. A browser
  // gives dark text less ink than light text (at five pixels, white gets
  // twice what black does), so a glyph drawn as text has a mask for each of
  // eight bands of ink brightness, drawn in a grey of that brightness.
  function maskOf(ch, ink) {
    const shape = (ch >= 0x2800 && ch <= 0x28ff) || (ch >= 0x2580 && ch <= 0x2593), band = shape ? 7 : inkBand(ink), key = ch * 8 + band;
    let m = masks.get(key);
    if (m !== undefined) return m;
    if (masks.size >= 16384) masks = new Map();
    mctx.clearRect(0, 0, cw, chh);
    const v = band << 5 | band << 2 | band >> 1;
    inkGlyph(mctx, ch, 0, 0, v << 16 | v << 8 | v);
    const d = mctx.getImageData(0, 0, cw, chh).data, size = cw * chh;
    m = new Uint8Array(size);
    let any = 0;
    for (let i = 0; i < size; i++) { m[i] = d[i * 4 + 3]; any |= m[i]; }
    if (!any) m = null;
    masks.set(key, m);
    return m;
  }

  // (pixels) Changed cells are written into the picture; then each band of
  // rows that changed goes to the canvas at once.
  function drawPixels(grid) {
    const { ch, fg, bg } = grid, W = cols * cw;
    let drawn = 0, y0 = rows, y1 = -1;
    for (let cy = 0, i = 0; cy < rows; cy++) {
      let lo = cols, hi = -1;
      for (let cx = 0; cx < cols; cx++, i++) {
        const c = ch[i], f = fg[i], b = bg[i];
        if (!full && c === pCh[i] && f === pFg[i] && b === pBg[i]) continue;
        pCh[i] = c; pFg[i] = f; pBg[i] = b;
        if (cx < lo) lo = cx;
        hi = cx; drawn++;
        const clear = b === TRANSPARENT, paper = clear ? 0 : BYTES_RGBA ? ((b & 0xffffff) << 8 | 255) >>> 0 : (0xff000000 | (b & 255) << 16 | (b & 0xff00) | (b >> 16) & 255) >>> 0;
        const mask = c === 32 || c === 0x2800 || f === b ? null : maskOf(c, f);
        let o = cy * chh * W + cx * cw;
        if (!mask) { for (let yy = 0; yy < chh; yy++, o += W) px.fill(paper, o, o + cw); continue; }
        const fr = (f >> 16) & 255, fgn = (f >> 8) & 255, fb = f & 255, br = (b >> 16) & 255, bgn = (b >> 8) & 255, bb = b & 255;
        const rgbInk = BYTES_RGBA ? ((f & 0xffffff) << 8) >>> 0 : (fb << 16 | fgn << 8 | fr) >>> 0, ink = BYTES_RGBA ? (rgbInk | 255) >>> 0 : (0xff000000 | rgbInk) >>> 0;
        for (let yy = 0, mo = 0; yy < chh; yy++, o += W - cw) {
          for (let xx = 0; xx < cw; xx++, o++, mo++) {
            const a = mask[mo];
            if (a === 0) px[o] = paper;
            else if (clear) px[o] = BYTES_RGBA ? (rgbInk | a) >>> 0 : (a << 24 | rgbInk) >>> 0;       // (ink over nothing: its own alpha)
            else if (a === 255) px[o] = ink;
            else {
              const r = br + (((fr - br) * a + 127) / 255 | 0), g = bgn + (((fgn - bgn) * a + 127) / 255 | 0), bl = bb + (((fb - bb) * a + 127) / 255 | 0);
              px[o] = BYTES_RGBA ? (r << 24 | g << 16 | bl << 8 | 255) >>> 0 : (0xff000000 | bl << 16 | g << 8 | r) >>> 0;
            }
          }
        }
      }
      rowLo[cy] = lo; rowHi[cy] = hi;
      if (hi >= 0) { if (cy < y0) y0 = cy; y1 = cy; }
    }
    // Rows that changed and lie together go up together.
    for (let cy = y0; cy <= y1; cy++) {
      if (rowHi[cy] < 0) continue;
      let lo = rowLo[cy], hi = rowHi[cy], end = cy;
      while (end + 1 <= y1 && rowHi[end + 1] >= 0) { end++; if (rowLo[end] < lo) lo = rowLo[end]; if (rowHi[end] > hi) hi = rowHi[end]; }
      ctx.putImageData(img, 0, 0, lo * cw, cy * chh, (hi - lo + 1) * cw, (end - cy + 1) * chh);
      cy = end;
    }
    full = false;
    stats.drawn = drawn; stats.cells = cols * rows; stats.atlas = masks.size;
    return drawn;
  }

  function draw(grid) {
    if (!pCh || grid.cols !== cols || grid.rows !== rows) return 0;
    if (pixels) return drawPixels(grid);
    const { ch, fg, bg } = grid;
    let drawn = 0, lastBg = -1;
    for (let i = 0, n = cols * rows; i < n; i++) {
      const c = ch[i], f = fg[i], b = bg[i];
      if (!full && c === pCh[i] && f === pFg[i] && b === pBg[i]) continue;
      pCh[i] = c; pFg[i] = f; pBg[i] = b;
      const x = (i % cols) * cw, y = ((i / cols) | 0) * chh;
      if (b === TRANSPARENT) ctx.clearRect(x, y, cw, chh);
      else {
        if (b !== lastBg) { ctx.fillStyle = cssColor(b); lastBg = b; }
        ctx.fillRect(x, y, cw, chh);
      }
      if (c !== 32 && c !== 0x2800 && f !== b) {
        const s = slotOf(c, f);
        ctx.drawImage(atlas, (s % perRow) * cw, Math.floor(s / perRow) * chh, cw, chh, x, y, cw, chh);
      }
      drawn++;
    }
    full = false;
    stats.drawn = drawn; stats.cells = cols * rows; stats.atlas = slots.size;
    return drawn;
  }

  function sprites(list) {
    if (!octx) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.textAlign = "center"; octx.textBaseline = "middle";
    let lastFont = "";
    for (const s of list) {
      if (s.alpha !== undefined && s.alpha <= 0) continue;
      const px = Math.round(fontPx * (s.scale || 1)), f = `${weight} ${px}px ${font}`;
      if (f !== lastFont) { octx.font = f; lastFont = f; }
      octx.globalAlpha = s.alpha === undefined ? 1 : s.alpha;
      octx.globalCompositeOperation = s.add ? "lighter" : "source-over";
      octx.fillStyle = cssColor(s.color);
      if (s.glow) { octx.shadowColor = cssColor(s.color); octx.shadowBlur = s.glow * dpr; } else if (octx.shadowBlur) octx.shadowBlur = 0;
      octx.fillText(s.ch, (s.x + 0.5) * cw, (s.y + 0.5) * chh + chh * 0.04);
    }
    octx.globalAlpha = 1; octx.shadowBlur = 0; octx.globalCompositeOperation = "source-over";
  }

  // A web font arrives when it is first asked for, which is after the first
  // glyphs were drawn in whatever stood in for it; and document.fonts.ready
  // resolved long before, when nothing was loading yet. A glyph is drawn
  // once and kept, so those would stay in the stand-in font for good, beside
  // later ones in the real font. Whenever a font finishes loading, every
  // glyph is drawn afresh. (`fonts`: the FontFaceSet to listen to; the
  // document's own by default, null for none.)
  const fontSet = fonts === undefined ? (typeof document !== "undefined" ? document.fonts : null) : fonts;
  if (fontSet && typeof fontSet.addEventListener === "function") fontSet.addEventListener("loadingdone", () => { if (cw) { full = true; buildAtlas(); } });

  function cellAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width * cols, y: (clientY - r.top) / r.height * rows };
  }

  return { resize, draw, sprites, cellAt, invalidate(o) { full = true; if (o && o.atlas) buildAtlas(); }, stats, get cell() { return { w: cw / dpr, h: chh / dpr }; } };
}
