// fried-light.js -- optional addon: lighting for a character grid.
//
// fried-grid's createLight adds up soft blobs of light. That is enough for a
// glow; it is not a lighting system: nothing casts a shadow, nothing has a
// lit side and a dark side. This addon is the system. You give it, per cell,
// how HIGH the thing in that cell stands off the ground, and a list of
// lights with a height of their own. It works out:
//
//   - a normal for every cell from the slope of the heights (so a stone is
//     brighter on the side toward the candle);
//   - how much each light reaches each cell: falling off with distance, and
//     with how squarely it strikes the surface there;
//   - shadows: it sweeps outward from each light along a ray to every cell
//     on the edge of the light's reach, keeping the horizon (the steepest
//     thing met so far); a cell that lies below that horizon is in shadow.
//     Every cell on a ray is visited, so a thing one cell wide throws a whole
//     shadow. A tall thing near a low light throws a long one; raise the
//     light and it shortens. Hands and sleeves throw shadows too.
//   - spill: whatever shines by itself (a flame, a live rune) lights the
//     cells round it.
//
// Units: positions are in cells; heights and light heights are in ROWS (the
// height of one cell), so a height of 2 is as tall as two rows are deep.
// `aspect` is cell height / cell width. Plain data, runs in Node.

export function createLighting(cols, rows, { aspect = 2 } = {}) {
  const n = cols * rows;
  const L = {
    cols, rows, n, aspect,
    height: new Float32Array(n),                       // how tall each cell's thing stands (rows)
    nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n),
    r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n),
    lum: new Float32Array(n),
    shade: 0.22,                                         // how much light still reaches a shadowed cell
    maxHeight: 0,
    clearHeights() { L.height.fill(0); return L; },

    // Normals from the height field. Call after the heights are painted.
    normals() {
      const h = L.height, { nx, ny, nz } = L;
      let top = 0;
      for (let y = 0; y < rows; y++) {
        const o = y * cols, up = (y > 0 ? y - 1 : y) * cols, dn = (y < rows - 1 ? y + 1 : y) * cols;
        for (let x = 0; x < cols; x++) {
          const i = o + x, hc = h[i];
          if (hc > top) top = hc;
          // Slope per row of distance (a column is 1 / aspect of a row wide).
          const sx = (h[o + (x < cols - 1 ? x + 1 : x)] - h[o + (x > 0 ? x - 1 : x)]) * aspect * 0.5;
          const sy = (h[dn + x] - h[up + x]) * 0.5;
          const inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
          nx[i] = -sx * inv; ny[i] = -sy * inv; nz[i] = inv;
        }
      }
      L.maxHeight = top;
      return L;
    },

    // Start a frame's light: the same dim light everywhere.
    ambient(ar, ag = ar, ab = ar) { L.r.fill(ar); L.g.fill(ag); L.b.fill(ab); return L; },

    // Add a light worked out some other way (moonlight through a window).
    addField(field, k = 1) {
      for (let i = 0; i < n; i++) { L.r[i] += field.r[i] * k; L.g[i] += field.g[i] * k; L.b[i] += field.b[i] * k; }
      return L;
    },

    // A point light at (x, y) cells, `h` rows above the ground, reaching
    // `radius` rows. color is [r, g, b]. shadows: false casts none; "walk" is
    // the older way (from each cell a walk toward the light: dearer, and it
    // can step over a thing narrower than its stride).
    point({ x, y, h = 6, radius = 20, color = [1, 1, 1], power = 1, shadows = true, y0 = 0, y1 = rows }) {
      if (!(radius > 0)) return L;
      const H = L.height, { nx, ny, nz } = L, top = L.maxHeight;
      const rx = radius * aspect, xa = Math.max(0, Math.floor(x - rx)), xb = Math.min(cols - 1, Math.ceil(x + rx));
      const ya = Math.max(y0, 0, Math.floor(y - radius)), yb = Math.min(y1 - 1, rows - 1, Math.ceil(y + radius));
      if (xa > xb || ya > yb) return L;
      const inv = 1 / (radius * radius), cr = color[0] * power, cg = color[1] * power, cb = color[2] * power, dark = L.shade;
      const walk = String(shadows) === "walk", sweep = !!shadows && !walk && top > 0.05;
      let vis = null;
      if (sweep) {
        // The horizon sweep: along each ray out from the light, the smallest
        // slope (from the light down to a cell's top) met so far is the
        // horizon; a cell whose own slope is steeper lies below it.
        vis = L._vis || (L._vis = new Float32Array(n));
        for (let cy = ya; cy <= yb; cy++) vis.fill(1, cy * cols + xa, cy * cols + xb + 1);
        const ray = (tx, ty) => {
          const ddx = tx + 0.5 - x, ddy = ty + 0.5 - y, steps = Math.ceil(Math.max(Math.abs(ddx), Math.abs(ddy)));
          if (steps < 1) return;
          const sx = ddx / steps, sy = ddy / steps, dStep = Math.sqrt((sx / aspect) * (sx / aspect) + sy * sy);
          let sMin = Infinity, rMin = 0;
          for (let s = 1; s <= steps; s++) {
            const px = Math.floor(x + sx * s), py = Math.floor(y + sy * s);
            if (px < xa || px > xb || py < ya || py > yb) continue;
            const d = s * dStep;
            if (d < 0.55) continue;                     // the light's own cell is not in its way
            const i = py * cols + px, m = (h - H[i]) / d;
            if (m > sMin) {
              const over = rMin * (m - sMin);           // how far the horizon's thing stands above the ray to here
              if (over > 0.08) { const v = over > 0.45 ? 0 : 1 - over / 0.45; if (v < vis[i]) vis[i] = v; }
            } else { sMin = m; rMin = d; }
          }
        };
        for (let tx = xa; tx <= xb; tx++) { ray(tx, ya); if (yb !== ya) ray(tx, yb); }
        for (let ty = ya + 1; ty < yb; ty++) { ray(xa, ty); if (xb !== xa) ray(xb, ty); }
      }
      for (let cy = ya; cy <= yb; cy++) {
        const dy = cy + 0.5 - y;
        for (let cx = xa; cx <= xb; cx++) {
          const dx = (cx + 0.5 - x) / aspect, d2 = dx * dx + dy * dy, q = d2 * inv;
          if (q >= 1) continue;
          const i = cy * cols + cx, h0 = H[i], dz = h - h0;
          if (dz <= 0.05) continue;                     // the light is below this cell's top
          const dist = Math.sqrt(d2 + dz * dz);
          // How squarely the light strikes the surface here.
          let facing = (-dx * nx[i] - dy * ny[i] + dz * nz[i]) / dist;
          if (facing <= 0) facing = 0;
          let f = (1 - q) * (1 - q) * (0.35 + 0.65 * facing) * 1.25;
          if (f <= 0.002) continue;
          if (sweep) f *= dark + (1 - dark) * vis[i];
          else if (walk && top > h0 + 0.05 && d2 > 0.3) {
            // Walk toward the light as far as anything could still be in the way:
            // the tallest thing in the scene can only block the first part.
            const reach = Math.min(1, (top - h0) / dz), d = Math.sqrt(d2);
            const span = d * reach, steps = Math.min(24, Math.ceil(span)), stride = span / steps;
            const ux = -(cx + 0.5 - x) / d, uy = -dy / d;        // one row of distance toward the light, in cells
            let lit = 1;
            for (let s = 1; s <= steps; s++) {
              const k = s * stride, px = (cx + 0.5 + ux * k) | 0, py = (cy + 0.5 + uy * k) | 0;
              if (px < 0 || py < 0 || px >= cols || py >= rows) break;
              const ray = h0 + dz * (k / d);
              const over = H[py * cols + px] - ray;
              if (over > 0.08) { lit = over > 0.45 ? 0 : Math.min(lit, 1 - over / 0.45); if (lit <= 0) break; }
            }
            f *= dark + (1 - dark) * lit;
          }
          L.r[i] += cr * f; L.g[i] += cg * f; L.b[i] += cb * f;
        }
      }
      return L;
    },

    // What shines by itself spills into the cells round it. `em` is a colour
    // per cell (0xRRGGBB, 0 for nothing); each shining cell gives `k` of its
    // colour away over the cells within `radius` rows, most to the nearest.
    // Only the cells that shine cost anything.
    spill(em, k = 1, radius = 2) {
      if (!(radius > 0)) return L;
      let K = L._kernel;
      if (!K || K.radius !== radius) {
        const ry = Math.ceil(radius), rxc = Math.ceil(radius * aspect), w = [];
        let sum = 0;
        for (let dy = -ry; dy <= ry; dy++) for (let dx = -rxc; dx <= rxc; dx++) {
          const q = ((dx / aspect) * (dx / aspect) + dy * dy) / ((radius + 0.5) * (radius + 0.5));
          const f = q >= 1 ? 0 : (1 - q) * (1 - q);
          w.push(f); sum += f;
        }
        K = L._kernel = { radius, ry, rxc, w: Float32Array.from(w, (f) => f / sum) };
      }
      const { ry, rxc, w } = K, { r, g, b } = L, span = rxc * 2 + 1;
      for (let i = 0; i < n; i++) {
        const e = em[i];
        if (!e) continue;
        const er = ((e >> 16) & 255) / 255 * k, eg = ((e >> 8) & 255) / 255 * k, eb = (e & 255) / 255 * k;
        const cx = i % cols, cy = (i / cols) | 0;
        for (let dy = -ry; dy <= ry; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= rows) continue;
          const x0 = Math.max(0, cx - rxc), x1 = Math.min(cols - 1, cx + rxc), ko = (dy + ry) * span + rxc - cx, o = yy * cols;
          for (let xx = x0; xx <= x1; xx++) { const f = w[ko + xx]; r[o + xx] += er * f; g[o + xx] += eg * f; b[o + xx] += eb * f; }
        }
      }
      return L;
    },

    // Finish: brightness per cell (0..1 and beyond), for choosing a glyph.
    finish() {
      const { r, g, b, lum } = L;
      for (let i = 0; i < n; i++) lum[i] = r[i] * 0.3 + g[i] * 0.59 + b[i] * 0.11;
      return L;
    },
  };
  return L;
}

// A glyph for a brightness: chars is a ramp from nothing to dense, t is 0..1,
// jitter (-0.5..0.5, a stable hash of the cell) roughens the bands so they
// do not look like contour lines; bands > 0 snaps t to that many hard steps
// first (a woodcut's flat tones).
export function toneGlyph(chars, t, jitter = 0, bands = 0) {
  const m = chars.length;
  if (bands > 0) t = Math.round(t * bands) / bands;
  let k = Math.floor(t * (m - 1) + 0.5 + jitter * 0.9);
  if (k < 0) k = 0; else if (k >= m) k = m - 1;
  return chars[k];
}
