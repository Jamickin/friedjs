import test from "node:test";
import assert from "node:assert/strict";
import { createLighting } from "../addons/fried-light.js";

// A seeded source of chance, so a failure can be run again.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
// A lump of height: a thing standing on the ground.
function lump(L, cx, cy, rx, ry, top) {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(L.rows - 1, Math.ceil(cy + ry)); y++) for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(L.cols - 1, Math.ceil(cx + rx)); x++) {
    const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry, d = u * u + v * v;
    if (d < 1) L.height[y * L.cols + x] = Math.max(L.height[y * L.cols + x], top * Math.sqrt(1 - d * 0.8));
  }
}
// The worst difference between two kept lights.
function apart(A, B) { let worst = 0; for (const k of ["r", "g", "b"]) for (let i = 0; i < A.n; i++) { const d = Math.abs(A.kept[k][i] - B.kept[k][i]); if (d > worst) worst = d; } return worst; }
// The same heights, lit once from nothing.
function fresh(L, what) { const F = createLighting(L.cols, L.rows, { aspect: L.aspect }); F.shade = L.shade; F.height.set(L.height); F.relight(what); return F; }

test("fried-light relight: the first call is ambient + fields + a point for each light", () => {
  const L = createLighting(70, 30, { aspect: 2.1 }), P = createLighting(70, 30, { aspect: 2.1 });
  const field = { r: new Float32Array(L.n).fill(0.1), g: new Float32Array(L.n).fill(0.2), b: new Float32Array(L.n).fill(0.05) };
  const lights = [{ x: 12, y: 8, h: 6, radius: 30, color: [1, 0.9, 0.6], power: 0.8 }, { x: 55.5, y: 20.2, h: 4, radius: 18, shadows: false, color: [0.4, 0.5, 1] }];
  for (const A of [L, P]) { lump(A, 30, 14, 5, 3, 3); lump(A, 44, 9, 2, 2, 5); }
  const done = L.relight({ ambient: [0.05, 0.06, 0.08], fields: [[field, 0.5]], lights });
  P.normals(); P.ambient(0.05, 0.06, 0.08); P.addField(field, 0.5); for (const q of lights) P.point(q);
  let worst = 0;
  for (let i = 0; i < L.n; i++) worst = Math.max(worst, Math.abs(L.kept.r[i] - P.r[i]), Math.abs(L.kept.g[i] - P.g[i]), Math.abs(L.kept.b[i] - P.b[i]));
  assert.ok(worst < 1e-5, "the kept light and the frame-by-frame light agree to rounding: " + worst);
  assert.equal(done.changed, true); assert.equal(done.full, 2); assert.equal(done.partial, 0);
  assert.deepEqual([done.x0, done.y0, done.x1, done.y1], [0, 0, 69, 29]);
  assert.ok(L.maxHeight > 4.5 && L.maxHeight === P.maxHeight, "it finds the tallest thing itself: " + L.maxHeight);
  L.restore();
  assert.deepEqual(Array.from(L.r.slice(0, 50)), Array.from(L.kept.r.slice(0, 50)), "restore() puts it in r, g, b");
});

test("fried-light relight: nothing changed, nothing done", () => {
  const L = createLighting(60, 24);
  lump(L, 30, 12, 4, 3, 3);
  const what = { ambient: 0.1, lights: [{ x: 10, y: 10, h: 5, radius: 30 }] };
  L.relight(what);
  const before = Float32Array.from(L.kept.r), done = L.relight(what);
  assert.equal(done.changed, false); assert.equal(done.full + done.partial + done.rays, 0);
  assert.deepEqual(L.kept.r, before);
});

test("fried-light relight: a thing that moves re-sweeps a wedge, and the light is exactly what it would be from nothing", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rnd = rng(seed), cols = 90 + Math.floor(rnd() * 60), rows = 30 + Math.floor(rnd() * 30);
    const L = createLighting(cols, rows, { aspect: 2.1 });
    L.shade = 0.05;
    const still = Array.from({ length: 6 }, () => [rnd() * cols, rnd() * rows, 1 + rnd() * 5, 1 + rnd() * 3, 0.5 + rnd() * 4]);
    const lights = [
      { x: 6.5, y: 5.5, h: 6.5, radius: 42 }, { x: cols - 8.2, y: 6.1, h: 6.5, radius: 42, color: [1.3, 1, 0.6], power: 0.6 },
      { x: cols * 0.9, y: rows * 0.8, h: 5, radius: 30 }, { x: cols * 0.4, y: rows * 0.5, h: 3, radius: 9, shadows: false, color: [0.6, 0.5, 1] },
    ];
    const what = { ambient: [0.06, 0.065, 0.08], lights };
    // A hand on an arm: a lump at (hx, hy) and a fat line from it to the bottom edge.
    const paint = (hx, hy) => {
      L.height.fill(0);
      for (const s of still) lump(L, ...s);
      for (let k = 0; k <= 40; k++) { const t = k / 40; lump(L, hx + (cols * 0.7 - hx) * t, hy + (rows + 2 - hy) * t, 4, 2, 4); }
      lump(L, hx, hy, 5, 2.5, 2.2);
    };
    let hx = cols * 0.5, hy = rows * 0.5, partial = 0, full = 0, rays = 0, steps = 0;
    paint(hx, hy); L.relight(what);
    const whole = (cols + rows) * 2 * 3;                  // about what three shadowed lights cost when swept whole
    for (let step = 0; step < 40; step++) {
      hx = Math.max(4, Math.min(cols - 4, hx + (rnd() - 0.5) * 9)); hy = Math.max(3, Math.min(rows - 3, hy + (rnd() - 0.5) * 5));
      paint(hx, hy);
      const done = L.relight(what);
      partial += done.partial; full += done.full; rays += done.rays; steps++;
      assert.equal(apart(L, fresh(L, what)), 0, "seed " + seed + " step " + step + ": the kept light differs from the same room lit from nothing");
      assert.ok(done.changed);
    }
    assert.ok(partial > full, "seed " + seed + ": mostly wedges, not whole sweeps: " + partial + " in part, " + full + " whole");
    assert.ok(rays / steps < whole * 0.75, "seed " + seed + ": fewer rays than sweeping the room: " + (rays / steps).toFixed(0) + " a step against " + whole);
  }
});

test("fried-light relight: lights that move, change colour, come and go; things that appear and vanish", () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const rnd = rng(seed), cols = 80, rows = 36;
    const L = createLighting(cols, rows, { aspect: 2 });
    const things = [], lights = [{ id: "a", x: 10, y: 10, h: 6, radius: 30 }, { id: "b", x: 60, y: 20, h: 5, radius: 26, color: [1, 0.8, 0.5] }];
    const what = () => ({ ambient: 0.05, lights });
    L.relight(what());
    for (let step = 0; step < 60; step++) {
      const r = rnd();
      if (r < 0.25) things.push([rnd() * cols, rnd() * rows, 1 + rnd() * 4, 1 + rnd() * 2, 0.3 + rnd() * 5]);
      else if (r < 0.4 && things.length) things.splice(Math.floor(rnd() * things.length), 1);
      else if (r < 0.55 && things.length) { const t = things[Math.floor(rnd() * things.length)]; t[0] += (rnd() - 0.5) * 6; t[1] += (rnd() - 0.5) * 4; }
      else if (r < 0.65 && lights.length) { const q = lights[Math.floor(rnd() * lights.length)]; q.x += (rnd() - 0.5) * 8; q.y += (rnd() - 0.5) * 5; }
      else if (r < 0.75 && lights.length) { const q = lights[Math.floor(rnd() * lights.length)]; q.power = 0.3 + rnd(); q.color = [rnd(), rnd(), rnd()]; }
      else if (r < 0.82 && lights.length > 1) lights.splice(Math.floor(rnd() * lights.length), 1);
      else if (r < 0.9) lights.push({ id: "n" + step, x: rnd() * cols, y: rnd() * rows, h: 2 + rnd() * 6, radius: 6 + rnd() * 30, shadows: rnd() < 0.7 });
      else if (r < 0.95 && lights.length) { const q = lights[Math.floor(rnd() * lights.length)]; q.radius = 5 + rnd() * 30; q.h = 2 + rnd() * 6; }
      else if (lights.length) { const q = lights[Math.floor(rnd() * lights.length)]; q.shadows = q.shadows === false; }
      L.height.fill(0);
      for (const t of things) lump(L, ...t);
      L.relight(what());
      assert.equal(apart(L, fresh(L, what())), 0, "seed " + seed + " step " + step);
    }
    // Everything gone: only the ambient is left, everywhere.
    lights.length = 0; L.height.fill(0); L.relight(what());
    assert.ok(L.kept.r.every((v) => Math.abs(v - 0.05) < 1e-7), "seed " + seed + ": with every light gone, no share of one is left behind");
  }
});

test("fried-light relight: a colour change costs no sweep; fields are read again when the list changes or on refresh", () => {
  const L = createLighting(50, 20);
  lump(L, 25, 10, 3, 2, 3);
  const q = { x: 8, y: 8, h: 5, radius: 30, color: [1, 1, 1] }, field = { r: new Float32Array(L.n).fill(0.2), g: new Float32Array(L.n), b: new Float32Array(L.n) };
  L.relight({ fields: [[field, 1]], lights: [q] });
  q.color = [1, 0.5, 0.2]; q.power = 0.7;
  let done = L.relight({ fields: [[field, 1]], lights: [q] });
  assert.equal(done.full + done.partial + done.rays, 0, "nothing swept");
  assert.equal(done.changed, true);
  assert.equal(apart(L, fresh(L, { fields: [[field, 1]], lights: [q] })), 0);
  const was = L.kept.r[0];
  done = L.relight({ fields: [[field, 0.5]], lights: [q] });
  assert.ok(Math.abs(was - L.kept.r[0] - 0.1) < 1e-6, "half the field: " + was + " -> " + L.kept.r[0]);
  field.r.fill(0.6);
  assert.equal(L.relight({ fields: [[field, 0.5]], lights: [q] }).changed, false, "a field is taken to be steady");
  L.relight({ fields: [[field, 0.5]], lights: [q], refresh: true });
  assert.ok(Math.abs(L.kept.r[0] - was - 0.1) < 1e-6, "refresh reads it again");
  // The shadow's darkness is part of what is kept.
  L.shade = 0.6;
  assert.equal(L.relight({ fields: [[field, 0.5]], lights: [q] }).full, 1, "a new shade works the lights out again");
});

test("fried-light relight: the ground going flat, and rising again, switches the sweep off and on", () => {
  const L = createLighting(40, 20), what = { ambient: 0.02, lights: [{ x: 5, y: 10, h: 5, radius: 30 }] };
  L.relight(what);
  const open = L.kept.r[10 * 40 + 30];
  lump(L, 18, 10, 2, 2, 4); L.relight(what);
  assert.ok(L.kept.r[10 * 40 + 30] < open * 0.6, "behind the thing: shadow");
  assert.equal(apart(L, fresh(L, what)), 0);
  L.height.fill(0); L.relight(what);
  assert.ok(Math.abs(L.kept.r[10 * 40 + 30] - open) < 1e-7, "and with the thing gone the ground is as it was");
});

test("fried-light relight: a long thin thing seen end on costs a narrow wedge, not the box round it", () => {
  const cols = 220, rows = 90, L = createLighting(cols, rows, { aspect: 2 });
  const lamp = { x: 10.5, y: 10.5, h: 6, radius: 400 }, what = { ambient: 0.05, lights: [lamp] };
  // An arm: a strip three cells wide running away from the lamp, almost along its line of sight.
  const arm = (shift) => { L.height.fill(0); for (let k = 0; k <= 400; k++) { const t = k / 400, x = 60 + 130 * t + shift * 0.3, y = 25 + 47 * t + shift; for (let d = -1; d <= 1; d++) { const yy = Math.round(y) + d, xx = Math.round(x); if (yy >= 0 && yy < rows) L.height[yy * cols + xx] = 3; } } };
  arm(0); L.relight(what);
  const rim = (cols + rows) * 2;
  let rays = 0, steps = 0;
  for (let shift = 1; shift <= 12; shift++) {
    arm(shift);
    const done = L.relight(what);
    rays += done.rays; steps++;
    assert.equal(done.partial, 1, "shift " + shift + ": worked out in part");
    assert.equal(apart(L, fresh(L, what)), 0, "shift " + shift + ": and exactly the light it would be from nothing");
  }
  // The box round the arm (130 by 50 cells, forty cells from the lamp) fills
  // most of the lamp's view of the far wall; the arm itself, a sliver of it.
  if (process.env.SHOW) console.log("rays a step", (rays / steps).toFixed(0), "of", rim);
  assert.ok(rays / steps < rim * 0.3, "rays a step: " + (rays / steps).toFixed(0) + " of " + rim + " on the rim");
});
