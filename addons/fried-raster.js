// fried-raster.js -- optional addon: shapes drawn in character cells.
//
// Hand-drawn ASCII figures are a fixed number of cells big. The moment a
// grid's resolution can change (finer cells for the same picture), a figure
// has to be described as a shape and turned into characters at whatever
// size it comes out: an outline made of the glyph that leans the way the
// edge runs, and an inside you fill however you like. That is this file.
//
// Everything is in cell coordinates (floats; a cell covers [x, x+1) by
// [y, y+1) and is sampled at its centre). `aspect` is cell height / width
// (about 2 for a terminal font) and is only used to decide which way an edge
// leans on screen.
//
// Nothing here knows about a grid: each function calls `put(x, y, ...)` for
// every cell it touches, and you write whatever channels you keep (glyph,
// colour, height, material). Plain data, runs in Node.

export const EDGE = { h: "-", v: "|", up: "/", down: "\\" };
// For closed, rounded outlines: the top and bottom run along the cell, the
// sides curl, and small shapes get soft corners.
export const ROUND = { top: "-", bottom: "-", left: "(", right: ")", tl: ".", tr: ".", bl: "`", br: "'", up: "/", down: "\\" };

// The glyph for an edge running (dx, dy) cells.
export function edgeGlyph(dx, dy, aspect = 2, glyphs = EDGE) {
  const sx = dx, sy = dy * aspect, a = Math.abs(Math.atan2(sy, sx)) * 180 / Math.PI;
  if (a < 22.5 || a > 157.5) return glyphs.h;
  if (a > 67.5 && a < 112.5) return glyphs.v;
  return sx * sy > 0 ? glyphs.down : glyphs.up;
}

// A line from (x0, y0) to (x1, y1): put(x, y, glyph, t) for each cell on it,
// t running 0..1 along the line. opts.glyph forces one glyph.
export function strokeLine(put, x0, y0, x1, y1, opts = {}) {
  const aspect = opts.aspect || 2, dx = x1 - x0, dy = y1 - y0;
  if (!Number.isFinite(x0 + y0 + dx + dy)) return;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
  const g = opts.glyph || edgeGlyph(dx, dy, aspect, opts.glyphs || EDGE);
  let lx = NaN, ly = NaN;
  for (let k = 0; k <= n; k++) {
    const x = Math.floor(x0 + dx * k / n), y = Math.floor(y0 + dy * k / n);
    if (x === lx && y === ly) continue;
    lx = x; ly = y;
    put(x, y, g, k / n);
  }
}

// A run of lines through points; closed joins the last to the first.
export function strokePath(put, pts, opts = {}, closed = false) {
  const n = pts.length;
  for (let i = 0; i + 1 < n; i++) strokeLine(put, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], opts);
  if (closed && n > 2) strokeLine(put, pts[n - 1][0], pts[n - 1][1], pts[0][0], pts[0][1], opts);
}

// The outline of an ellipse: put(x, y, glyph, angle). Each cell on the edge
// gets one glyph, chosen by where that cell sits round the ellipse, so the
// outline is the same on both sides and does not depend on drawing order.
export function strokeEllipse(put, cx, cy, rx, ry, opts = {}) {
  const aspect = opts.aspect || 2, g = opts.glyphs || ROUND, small = ry < (opts.smallBelow === undefined ? 2.6 : opts.smallBelow);
  const n = Math.max(16, Math.ceil((rx + ry) * 8)), cells = new Map();
  for (let k = 0; k < n; k++) {
    const a = k / n * Math.PI * 2;
    // Just under half a cell inside the true edge: the outermost cells a fill covers.
    const x = Math.floor(cx + Math.cos(a) * Math.max(0, rx - 0.49)), y = Math.floor(cy + Math.sin(a) * Math.max(0, ry - 0.49));
    cells.set(x + "," + y, [x, y]);
  }
  // One glyph a side on every row but the flat top and bottom, so a slanted
  // edge is one character thick.
  const rows = new Map();
  for (const [x, y] of cells.values()) {
    const a = Math.atan2((y + 0.5 - cy) / ry, (x + 0.5 - cx) / rx), c = Math.cos(a), s = Math.sin(a);
    // Which way the edge runs here, on screen.
    const tx = -rx * s, ty = ry * c * aspect, t = Math.abs(Math.atan2(ty, tx)) * 180 / Math.PI;
    let ch, flat = false;
    if (t < 24 || t > 156) { ch = s < 0 ? g.top : g.bottom; flat = true; }
    else if (t > 66 && t < 114) ch = c < 0 ? g.left : g.right;
    else if (small) ch = s < 0 ? (c < 0 ? g.tl : g.tr) : (c < 0 ? g.bl : g.br);
    else ch = tx * ty > 0 ? g.down : g.up;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x, ch, a, flat, left: c < 0 });
  }
  for (const [y, list] of rows) {
    let lo = null, hi = null;
    for (const e of list) {
      if (e.flat) { put(e.x, y, e.ch, e.a); continue; }
      if (e.left) { if (lo === null || e.x < lo.x) lo = e; } else if (hi === null || e.x > hi.x) hi = e;
    }
    if (lo) put(lo.x, y, lo.ch, lo.a);
    if (hi) put(hi.x, y, hi.ch, hi.a);
  }
}

// Every cell whose centre lies inside the ellipse: put(x, y, u, v) with
// (u, v) the point in the ellipse's own -1..1 coordinates (for domes, sheen).
export function fillEllipse(put, cx, cy, rx, ry) {
  if (!(rx > 0 && ry > 0) || !Number.isFinite(cx + cy + rx + ry)) return;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    const v = (y + 0.5 - cy) / ry;
    if (v < -1 || v > 1) continue;
    const half = rx * Math.sqrt(1 - v * v);
    for (let x = Math.ceil(cx - half - 0.5); x + 0.5 <= cx + half; x++) put(x, y, (x + 0.5 - cx) / rx, v);
  }
}

// Every cell whose centre lies inside the polygon (even-odd): put(x, y).
export function fillPoly(put, pts) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { if (!Number.isFinite(p[0] + p[1])) return; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const xs = [];
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    const py = y + 0.5;
    xs.length = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a[1] <= py && b[1] > py) || (b[1] <= py && a[1] > py)) xs.push(a[0] + (py - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x + 0.5 <= xs[k + 1]; x++) put(x, y);
  }
}

export function fillRect(put, x0, y0, x1, y1) {
  for (let y = Math.ceil(y0 - 0.5); y + 0.5 <= y1; y++) for (let x = Math.ceil(x0 - 0.5); x + 0.5 <= x1; x++) put(x, y);
}

// A fat line (a capsule): every cell within `half` rows of the segment.
// put(x, y, t, d): t is 0..1 along it, d is 0 on the centre line and 1 at the
// edge. For sleeves, fingers, a stick of chalk.
export function fillCapsule(put, x0, y0, x1, y1, half, aspect = 2) {
  if (!(half > 0) || !Number.isFinite(x0 + y0 + x1 + y1 + half)) return;
  const hx = half * aspect, h2 = half * half;
  const ax = x0 / aspect, bx = x1 / aspect, dx = bx - ax, dy = y1 - y0, len2 = dx * dx + dy * dy || 1e-9;
  for (let y = Math.floor(Math.min(y0, y1) - half); y <= Math.ceil(Math.max(y0, y1) + half); y++) {
    for (let x = Math.floor(Math.min(x0, x1) - hx); x <= Math.ceil(Math.max(x0, x1) + hx); x++) {
      const px = (x + 0.5) / aspect - ax, py = y + 0.5 - y0;
      let t = (px * dx + py * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - dx * t, qy = py - dy * t, q = qx * qx + qy * qy;
      if (q <= h2) put(x, y, t, Math.sqrt(q) / half);
    }
  }
}

// The outline of any closed shape given as points (a lumpy stone, a crumpled
// rag): put(x, y, glyph). Like strokeEllipse it picks each cell's glyph from
// which way the edge runs there and which side of the shape the cell is on,
// keeps one glyph a side per row so a slanted edge is one character thick,
// and gives a small shape soft corners. The cells it writes are the
// outermost cells fillPoly covers, so a fill and its outline line up.
export function strokePoly(put, pts, opts = {}) {
  const n = pts.length;
  if (n < 3) return;
  const aspect = opts.aspect || 2, g = opts.glyphs || ROUND;
  let cx = 0, cy = 0, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { cx += p[0]; cy += p[1]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  cx /= n; cy /= n;
  const small = (y1 - y0) / 2 < (opts.smallBelow === undefined ? 2.6 : opts.smallBelow);
  const rows = new Map(), seen = new Set();
  // Is this cell one the fill covers (its centre inside the shape)?
  const covered = (x, y) => {
    const px = x + 0.5, py = y + 0.5;
    let odd = false;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; if (((a[1] <= py && b[1] > py) || (b[1] <= py && a[1] > py)) && px < a[0] + (py - a[1]) / (b[1] - a[1]) * (b[0] - a[0])) odd = !odd; }
    return odd;
  };
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1];
    if (!Number.isFinite(dx + dy)) return;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 3));
    const t = Math.abs(Math.atan2(dy * aspect, dx)) * 180 / Math.PI;      // which way this edge runs, on screen
    for (let k = 0; k < steps; k++) {
      const px = a[0] + dx * k / steps, py = a[1] + dy * k / steps;
      // Just under half a cell inside the true edge; at a sharp tip, where
      // that cell's centre is still outside, a little further in.
      const ox = px - cx, oy = py - cy, len = Math.hypot(ox, oy) || 1;
      let x = 0, y = 0, found = false;
      for (const inset of [0.49, 1, 1.6]) {
        const k = Math.min(inset, len) / len;
        x = Math.floor(px - ox * k); y = Math.floor(py - oy * k);
        if (covered(x, y)) { found = true; break; }
      }
      if (!found) continue;
      const key = x + "," + y;
      if (seen.has(key)) continue;
      seen.add(key);
      const left = x + 0.5 < cx, upper = y + 0.5 < cy;
      let ch, flat = false;
      if (t < 24 || t > 156) { ch = upper ? g.top : g.bottom; flat = true; }
      else if (t > 66 && t < 114) ch = left ? g.left : g.right;
      else if (small) ch = upper ? (left ? g.tl : g.tr) : (left ? g.bl : g.br);
      else ch = dx * dy > 0 ? g.down : g.up;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x, ch, flat, left });
    }
  }
  for (const [y, list] of rows) {
    let lo = null, hi = null;
    for (const e of list) {
      if (e.flat) { put(e.x, y, e.ch); continue; }
      if (e.left) { if (lo === null || e.x < lo.x) lo = e; } else if (hi === null || e.x > hi.x) hi = e;
    }
    if (lo) put(lo.x, y, lo.ch);
    if (hi) put(hi.x, y, hi.ch);
  }
}
