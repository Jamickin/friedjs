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
// Two ways to use it. Frame by frame: normals(), ambient(), point() for each
// light, finish(). Or KEPT: relight({ ambient, fields, lights }) remembers
// each light's share and, called again, works out only what a changed height
// or a changed light can have altered (a hand moving across a desk re-sweeps
// the wedge of rays that pass through where the hand was and is, not the
// room). restore() then puts the kept light in r, g, b for this frame's
// quick lights to go on top.
//
// Units: positions are in cells; heights and light heights are in ROWS (the
// height of one cell), so a height of 2 is as tall as two rows are deep.
// `aspect` is cell height / cell width. Plain data, runs in Node.

export function createLighting(cols, rows, { aspect = 2 } = {}) {
  const n = cols * rows;

  // Normals from the height field, for the cells of a box.
  function normalsIn(x0, y0, x1, y1) {
    const h = L.height, { nx, ny, nz } = L;
    for (let y = y0; y <= y1; y++) {
      const o = y * cols, up = (y > 0 ? y - 1 : y) * cols, dn = (y < rows - 1 ? y + 1 : y) * cols;
      for (let x = x0; x <= x1; x++) {
        const i = o + x;
        // Slope per row of distance (a column is 1 / aspect of a row wide).
        const sx = (h[o + (x < cols - 1 ? x + 1 : x)] - h[o + (x > 0 ? x - 1 : x)]) * aspect * 0.5;
        const sy = (h[dn + x] - h[up + x]) * 0.5;
        const inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
        nx[i] = -sx * inv; ny[i] = -sy * inv; nz[i] = inv;
      }
    }
  }

  // One ray of the horizon sweep: from the light at (x, y), `h` rows up, to
  // the middle of cell (tx, ty). Along it, the smallest slope (from the light
  // down to a cell's top) met so far is the horizon; a cell whose own slope
  // is steeper lies below it, and `vis` there is lowered (never raised).
  function ray(vis, x, y, h, tx, ty, xa, xb, ya, yb) {
    const H = L.height, ddx = tx + 0.5 - x, ddy = ty + 0.5 - y, steps = Math.ceil(Math.max(Math.abs(ddx), Math.abs(ddy)));
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
  }
  // The whole sweep: a ray to every cell on the rim of the light's box.
  function sweep(vis, x, y, h, xa, xb, ya, yb) {
    for (let cy = ya; cy <= yb; cy++) vis.fill(1, cy * cols + xa, cy * cols + xb + 1);
    for (let tx = xa; tx <= xb; tx++) { ray(vis, x, y, h, tx, ya, xa, xb, ya, yb); if (yb !== ya) ray(vis, x, y, h, tx, yb, xa, xb, ya, yb); }
    for (let ty = ya + 1; ty < yb; ty++) { ray(vis, x, y, h, xa, ty, xa, xb, ya, yb); if (xb !== xa) ray(vis, x, y, h, xb, ty, xa, xb, ya, yb); }
  }
  // Where the straight line from (ax, ay) to (bx, by) enters the box, as a
  // part of the way along it (0..1); -1 if it never does.
  function enters(ax, ay, bx, by, x0, y0, x1, y1) {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    if (dx === 0) { if (ax < x0 || ax > x1) return -1; }
    else { let a = (x0 - ax) / dx, b = (x1 - ax) / dx; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return -1; }
    if (dy === 0) { if (ay < y0 || ay > y1) return -1; }
    else { let a = (y0 - ay) / dy, b = (y1 - ay) / dy; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return -1; }
    return t0;
  }
  const crosses = (ax, ay, bx, by, x0, y0, x1, y1) => enters(ax, ay, bx, by, x0, y0, x1, y1) >= 0;
  // How much of a light gets to each cell of a box (its colour and power left
  // out): written to `out`, 0 where none does. `vis` is the sweep's answer,
  // or null for a light that casts no shadow. With `mark`, a cell whose share
  // came out different is marked, and its row's `lo` and `hi` widened to it.
  function factors(out, vis, x, y, h, radius, x0, x1, y0, y1, mark = null, lo = null, hi = null) {
    const H = L.height, { nx, ny, nz } = L, inv = 1 / (radius * radius), dark = L.shade;
    for (let cy = y0; cy <= y1; cy++) {
      const dy = cy + 0.5 - y;
      let a = cols, z = -1;
      for (let cx = x0, i = cy * cols + x0; cx <= x1; cx++, i++) {
        const dx = (cx + 0.5 - x) / aspect, d2 = dx * dx + dy * dy, q = d2 * inv;
        let f = 0;
        if (q < 1) {
          const dz = h - H[i];
          if (dz > 0.05) {                          // (else the light is below this cell's top)
            let facing = (-dx * nx[i] - dy * ny[i] + dz * nz[i]) / Math.sqrt(d2 + dz * dz);
            if (facing <= 0) facing = 0;
            f = (1 - q) * (1 - q) * (0.35 + 0.65 * facing) * 1.25;
            if (f <= 0.002) f = 0; else if (vis) f *= dark + (1 - dark) * vis[i];
          }
        }
        if (mark) { if (out[i] !== Math.fround(f)) { out[i] = f; mark[i] = 1; if (cx < a) a = cx; z = cx; } }
        else out[i] = f;
      }
      if (z >= 0) { if (a < lo[cy]) lo[cy] = a; if (z > hi[cy]) hi[cy] = z; }
    }
  }

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
    // (relight() does this itself, and only where the heights changed.)
    normals() {
      const h = L.height;
      let top = 0;
      for (let i = 0; i < n; i++) if (h[i] > top) top = h[i];
      normalsIn(0, 0, cols - 1, rows - 1);
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
      const walk = String(shadows) === "walk", swept = !!shadows && !walk && top > 0.05;
      let vis = null;
      if (swept) { vis = L._vis || (L._vis = new Float32Array(n)); sweep(vis, x, y, h, xa, xb, ya, yb); }
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
          if (swept) f *= dark + (1 - dark) * vis[i];
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
              const at = h0 + dz * (k / d);
              const over = H[py * cols + px] - at;
              if (over > 0.08) { lit = over > 0.45 ? 0 : Math.min(lit, 1 - over / 0.45); if (lit <= 0) break; }
            }
            f *= dark + (1 - dark) * lit;
          }
          L.r[i] += cr * f; L.g[i] += cg * f; L.b[i] += cb * f;
        }
      }
      return L;
    },

    // The KEPT light: the same answer as normals(), ambient(), addField() for
    // each of `fields` ([field, k] pairs) and point() for each of `lights`,
    // but remembered. Called again, it looks at what is different:
    //
    //   - the heights: the box of cells whose height changed. Normals are
    //     worked out again inside it. A shadow at a cell depends only on the
    //     heights between the light and that cell, so for each light only the
    //     rays that pass through the box are swept again, and only from where
    //     they enter it;
    //   - a light that moved, or changed height, reach or `shadows`: that
    //     light alone is worked out again;
    //   - a light whose colour or power changed: nothing is worked out, its
    //     share is only added up again;
    //   - a light that is gone: its share is taken out.
    //
    // A light is known from call to call by its `id` (or, with none, by its
    // place in the list). `fields` are taken to be steady: they are read
    // again when the list changes (other objects, other k) or with
    // `refresh: true`, which works everything out afresh. `shadows: "walk"`
    // is swept here like `true`.
    //
    // The kept light is in L.kept ({ r, g, b }); restore() copies it to r, g,
    // b. Returns what was done: { changed, x0, y0, x1, y1 (the box of cells
    // whose light changed, when changed), full, partial (lights worked out
    // whole, in part), rays (rays swept) }. The same object every call.
    relight({ ambient = 0, fields = [], lights = [], refresh = false } = {}) {
      let K = L._keep;
      const first = !K;
      if (!K) {
        K = L._keep = {
          H: new Float32Array(n), slots: new Map(), order: [], pool: [], amb: [NaN, NaN, NaN], fields: [], swept: false, shade: NaN,
          lo: new Int32Array(rows), hi: new Int32Array(rows), rim: new Int32Array((cols + rows) * 4 + 8),
          mark: new Uint8Array(n), mlo: new Int32Array(rows).fill(cols), mhi: new Int32Array(rows).fill(-1),
          done: { changed: false, x0: 0, y0: 0, x1: -1, y1: -1, full: 0, partial: 0, rays: 0 },
        };
        L.kept = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) };
      }
      const H = L.height, P = K.H, done = K.done, kept = L.kept;
      done.full = 0; done.partial = 0; done.rays = 0; done.changed = false; done.x0 = 0; done.y0 = 0; done.x1 = -1; done.y1 = -1;

      // What changed in the heights: one box round every cell that differs.
      let dx0 = cols, dy0 = rows, dx1 = -1, dy1 = -1, top = 0;
      for (let y = 0, i = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++, i++) {
          const v = H[i];
          if (v > top) top = v;
          if (v !== P[i]) { P[i] = v; if (x < dx0) dx0 = x; if (x > dx1) dx1 = x; if (y < dy0) dy0 = y; if (y > dy1) dy1 = y; }
        }
      }
      L.maxHeight = top;
      const swept = top > 0.05, dirty = dx1 >= 0;
      const all = first || refresh || swept !== K.swept || L.shade !== K.shade;
      K.swept = swept; K.shade = L.shade;
      if (all) normalsIn(0, 0, cols - 1, rows - 1);
      else if (dirty) normalsIn(Math.max(0, dx0 - 1), Math.max(0, dy0 - 1), Math.min(cols - 1, dx1 + 1), Math.min(rows - 1, dy1 + 1));

      // The box of cells whose light has to be added up again.
      let cx0 = cols, cy0 = rows, cx1 = -1, cy1 = -1;
      const grow = (xa, ya, xb, yb) => { if (xa < cx0) cx0 = xa; if (ya < cy0) cy0 = ya; if (xb > cx1) cx1 = xb; if (yb > cy1) cy1 = yb; };

      // The light that is everywhere: ambient, and the steady fields.
      const amb = Array.isArray(ambient) ? ambient : [ambient, ambient, ambient];
      let baseSame = !all && amb[0] === K.amb[0] && amb[1] === K.amb[1] && amb[2] === K.amb[2] && fields.length === K.fields.length;
      for (let k = 0; baseSame && k < fields.length; k++) if (fields[k][0] !== K.fields[k][0] || (fields[k][1] === undefined ? 1 : fields[k][1]) !== K.fields[k][1]) baseSame = false;
      if (!baseSame) {
        K.amb = [amb[0], amb[1], amb[2]];
        K.fields = fields.map((f) => [f[0], f[1] === undefined ? 1 : f[1]]);
        grow(0, 0, cols - 1, rows - 1);
      }

      // Each light.
      const order = K.order, slots = K.slots;
      order.length = 0;
      for (let li = 0; li < lights.length; li++) {
        const q = lights[li], x = q.x, y = q.y, h = q.h === undefined ? 6 : q.h, radius = q.radius === undefined ? 20 : q.radius;
        if (!(radius > 0)) continue;
        const sh = q.shadows !== false, y0 = q.y0 === undefined ? 0 : q.y0, y1 = q.y1 === undefined ? rows : q.y1;
        const rx = radius * aspect, xa = Math.max(0, Math.floor(x - rx)), xb = Math.min(cols - 1, Math.ceil(x + rx));
        const ya = Math.max(y0, 0, Math.floor(y - radius)), yb = Math.min(y1 - 1, rows - 1, Math.ceil(y + radius));
        if (xa > xb || ya > yb) continue;
        const color = q.color || [1, 1, 1], power = q.power === undefined ? 1 : q.power, cr = color[0] * power, cg = color[1] * power, cb = color[2] * power;
        const id = q.id === undefined ? li : q.id;
        let s = slots.get(id), whole = all;
        if (s && s.seen) continue;                           // (the same id twice: the first one stands)
        if (!s) {
          const spare = K.pool.pop();
          s = { x, y, h, radius, sh, xa, xb, ya, yb, cr, cg, cb, f: spare ? spare.f : new Float32Array(n), vis: spare ? spare.vis : new Float32Array(n), seen: false };
          slots.set(id, s); whole = true;
        } else if (whole || s.x !== x || s.y !== y || s.h !== h || s.radius !== radius || s.sh !== sh || s.xa !== xa || s.xb !== xb || s.ya !== ya || s.yb !== yb) {
          // It is somewhere else now: its old share comes out first.
          for (let cy = s.ya; cy <= s.yb; cy++) s.f.fill(0, cy * cols + s.xa, cy * cols + s.xb + 1);
          grow(s.xa, s.ya, s.xb, s.yb);
          s.x = x; s.y = y; s.h = h; s.radius = radius; s.sh = sh; s.xa = xa; s.xb = xb; s.ya = ya; s.yb = yb;
          whole = true;
        }
        s.seen = true; order.push(s);
        if (s.cr !== cr || s.cg !== cg || s.cb !== cb) { s.cr = cr; s.cg = cg; s.cb = cb; grow(xa, ya, xb, yb); }
        const shadowed = sh && swept;

        if (!whole && dirty) {
          // The heights changed and this light did not: how much of it can that have altered?
          const ex0 = Math.max(xa, dx0 - 1), ex1 = Math.min(xb, dx1 + 1), ey0 = Math.max(ya, dy0 - 1), ey1 = Math.min(yb, dy1 + 1);
          if (ex0 > ex1 || ey0 > ey1) continue;               // out of its reach: nothing
          if (!shadowed) { factors(s.f, null, x, y, h, radius, ex0, ex1, ey0, ey1, K.mark, K.mlo, K.mhi); done.partial++; continue; }
          if (x >= dx0 - 3 && x <= dx1 + 4 && y >= dy0 - 3 && y <= dy1 + 4) whole = true;      // the light stands in what changed: every ray passes through it
          else {
            // The rays that pass through the box (and those a cell to either
            // side, which share cells with them further out).
            const rim = K.rim, bx0 = dx0 - 2, by0 = dy0 - 2, bx1 = dx1 + 3, by1 = dy1 + 3;
            let m = 0, total = 0;
            for (let tx = xa; tx <= xb; tx++) {
              total++; if (crosses(x, y, tx + 0.5, ya + 0.5, bx0, by0, bx1, by1)) { rim[m++] = tx; rim[m++] = ya; }
              if (yb !== ya) { total++; if (crosses(x, y, tx + 0.5, yb + 0.5, bx0, by0, bx1, by1)) { rim[m++] = tx; rim[m++] = yb; } }
            }
            for (let ty = ya + 1; ty < yb; ty++) {
              total++; if (crosses(x, y, xa + 0.5, ty + 0.5, bx0, by0, bx1, by1)) { rim[m++] = xa; rim[m++] = ty; }
              if (xb !== xa) { total++; if (crosses(x, y, xb + 0.5, ty + 0.5, bx0, by0, bx1, by1)) { rim[m++] = xb; rim[m++] = ty; } }
            }
            if (m > total * 1.2) whole = true;                 // most of them (m counts two numbers a ray): the whole sweep is cheaper than two passes
            else {
              const lo = K.lo, hi = K.hi, vis = s.vis;
              for (let cy = ya; cy <= yb; cy++) { lo[cy] = cols; hi[cy] = -1; }
              // First pass: every cell a ray reaches from the changed box
              // onward is no longer known to be lit or dark.
              for (let k = 0; k < m; k += 2) {
                const ddx = rim[k] + 0.5 - x, ddy = rim[k + 1] + 0.5 - y, steps = Math.ceil(Math.max(Math.abs(ddx), Math.abs(ddy)));
                if (steps < 1) continue;
                const sx = ddx / steps, sy = ddy / steps;
                // (It cannot be in the box before the line itself is: start there, a step early.)
                const t0 = enters(x, y, rim[k] + 0.5, rim[k + 1] + 0.5, dx0, dy0, dx1 + 1, dy1 + 1);
                if (t0 < 0) continue;
                let inside = false;
                for (let st = Math.max(1, Math.floor(t0 * steps) - 1); st <= steps; st++) {
                  const px = Math.floor(x + sx * st), py = Math.floor(y + sy * st);
                  if (px < xa || px > xb || py < ya || py > yb) continue;
                  if (!inside) { if (px >= dx0 && px <= dx1 && py >= dy0 && py <= dy1) inside = true; else continue; }
                  vis[py * cols + px] = 1;
                  if (px < lo[py]) lo[py] = px;
                  if (px > hi[py]) hi[py] = px;
                }
              }
              // Second pass: sweep those rays again. Where nothing changed
              // before a cell, a ray finds what it found last time.
              for (let k = 0; k < m; k += 2) ray(vis, x, y, h, rim[k], rim[k + 1], xa, xb, ya, yb);
              done.rays += m >> 1;
              // And the light itself, where a shadow or a slope may be different.
              for (let cy = ey0; cy <= ey1; cy++) { if (ex0 < lo[cy]) lo[cy] = ex0; if (ex1 > hi[cy]) hi[cy] = ex1; }
              for (let cy = ya; cy <= yb; cy++) if (hi[cy] >= lo[cy]) factors(s.f, vis, x, y, h, radius, lo[cy], hi[cy], cy, cy, K.mark, K.mlo, K.mhi);
              done.partial++;
              continue;
            }
          }
        }
        if (whole) {
          if (shadowed) { sweep(s.vis, x, y, h, xa, xb, ya, yb); done.rays += (xb - xa + yb - ya) * 2; }
          factors(s.f, shadowed ? s.vis : null, x, y, h, radius, xa, xb, ya, yb);
          grow(xa, ya, xb, yb);
          done.full++;
        }
      }
      // A light that was not in the list this time is gone.
      for (const [id, s] of slots) {
        if (s.seen) { s.seen = false; continue; }
        for (let cy = s.ya; cy <= s.yb; cy++) s.f.fill(0, cy * cols + s.xa, cy * cols + s.xb + 1);
        grow(s.xa, s.ya, s.xb, s.yb);
        slots.delete(id); K.pool.push(s);
      }

      // Add it up again, where anything changed. A light worked out in part
      // marked the cells whose share really changed (a few hundred, for a
      // hand): those are added up one by one. Anything bigger (a light that
      // moved, another ambient) is a box, added up row by row.
      const { mark, mlo, mhi } = K, { r, g, b } = kept, [ar, ag, ab] = K.amb, box = cx1 >= cx0;
      let bx0 = cols, by0 = rows, bx1 = -1, by1 = -1;
      for (let cy = 0; cy < rows; cy++) {
        const a = mlo[cy], z = mhi[cy];
        if (z < 0) continue;
        mlo[cy] = cols; mhi[cy] = -1;
        if (box) { mark.fill(0, cy * cols + a, cy * cols + z + 1); grow(a, cy, z, cy); continue; }
        if (a < bx0) bx0 = a;
        if (z > bx1) bx1 = z;
        if (cy < by0) by0 = cy;
        by1 = cy;
        for (let i = cy * cols + a, e = cy * cols + z; i <= e; i++) {
          if (!mark[i]) continue;
          mark[i] = 0;
          let sr = Math.fround(ar), sg = Math.fround(ag), sb = Math.fround(ab);        // (rounded at every step, as the rows below are: the same light to the last bit)
          for (let k = 0; k < K.fields.length; k++) { const fk = K.fields[k], field = fk[0], w = fk[1]; sr = Math.fround(sr + field.r[i] * w); sg = Math.fround(sg + field.g[i] * w); sb = Math.fround(sb + field.b[i] * w); }
          for (let k = 0; k < order.length; k++) { const s = order[k], v = s.f[i]; if (v !== 0) { sr = Math.fround(sr + s.cr * v); sg = Math.fround(sg + s.cg * v); sb = Math.fround(sb + s.cb * v); } }
          r[i] = sr; g[i] = sg; b[i] = sb;
        }
      }
      if (!box) {
        done.changed = by1 >= 0;
        if (done.changed) { done.x0 = bx0; done.y0 = by0; done.x1 = bx1; done.y1 = by1; }
        return done;
      }
      done.changed = true;
      done.x0 = cx0; done.y0 = cy0; done.x1 = cx1; done.y1 = cy1;
      {
        for (let cy = cy0; cy <= cy1; cy++) { const a = cy * cols + cx0, z = cy * cols + cx1 + 1; r.fill(ar, a, z); g.fill(ag, a, z); b.fill(ab, a, z); }
        for (const [field, k] of K.fields) {
          for (let cy = cy0; cy <= cy1; cy++) for (let i = cy * cols + cx0, z = cy * cols + cx1; i <= z; i++) { r[i] += field.r[i] * k; g[i] += field.g[i] * k; b[i] += field.b[i] * k; }
        }
        for (const s of order) {
          const xa = Math.max(cx0, s.xa), xb = Math.min(cx1, s.xb), ya = Math.max(cy0, s.ya), yb = Math.min(cy1, s.yb), f = s.f, { cr, cg, cb } = s;
          for (let cy = ya; cy <= yb; cy++) for (let i = cy * cols + xa, z = cy * cols + xb; i <= z; i++) { const v = f[i]; if (v !== 0) { r[i] += cr * v; g[i] += cg * v; b[i] += cb * v; } }
        }
      }
      return done;
    },

    // Put the kept light (relight) in r, g, b: the start of a frame whose
    // quick lights (point with shadows: false, spill) go on top of it.
    restore() {
      if (L.kept) { L.r.set(L.kept.r); L.g.set(L.kept.g); L.b.set(L.kept.b); }
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
