import test from "node:test";
import assert from "node:assert/strict";
import { createLighting, toneGlyph } from "../addons/fried-light.js";

const at = (L, x, y) => L.lum[y * L.cols + x];
function lit(L, light) { L.normals(); L.ambient(0); L.point(light); L.finish(); return L; }

test("fried-light: flat ground is brightest under the light and dark past its radius", () => {
  const L = lit(createLighting(60, 30), { x: 30, y: 15, h: 6, radius: 12 });
  assert.ok(at(L, 30, 15) > 0.9);
  assert.ok(at(L, 30, 20) < at(L, 30, 15) && at(L, 30, 20) > 0);
  assert.equal(at(L, 30, 29), 0);
  assert.ok(at(L, 44, 15) > 0, "round on screen: twice as many columns as rows");
  assert.equal(at(L, 56, 15), 0);
});

test("fried-light: a tall thing throws a shadow away from the light, longer the lower the light", () => {
  const scene = (lightH) => {
    const L = createLighting(80, 21);
    for (let y = 8; y <= 12; y++) for (let x = 38; x <= 41; x++) L.height[y * 80 + x] = 3;   // a block, right of the light
    return lit(L, { x: 20, y: 10.5, h: lightH, radius: 40 });
  };
  const low = scene(5), open = lit(createLighting(80, 21), { x: 20, y: 10.5, h: 5, radius: 40 });
  assert.ok(at(low, 46, 10) < at(open, 46, 10) * 0.5, "just beyond the block: in shadow");
  assert.ok(Math.abs(at(low, 30, 10) - at(open, 30, 10)) < 1e-6, "between the light and the block: untouched");
  assert.ok(Math.abs(at(low, 46, 2) - at(open, 46, 2)) < 1e-6, "off to the side: untouched");
  const shadowLen = (L, ref) => { let n = 0; for (let x = 42; x < 80; x++) if (at(L, x, 10) < at(ref, x, 10) * 0.9) n++; return n; };
  const high = scene(14), openHigh = lit(createLighting(80, 21), { x: 20, y: 10.5, h: 14, radius: 40 });
  assert.ok(shadowLen(low, open) > shadowLen(high, openHigh) + 3, `low light ${shadowLen(low, open)} cells, high light ${shadowLen(high, openHigh)}`);
  // shadows: false leaves the ground behind the block as bright as open ground.
  const off = createLighting(80, 21);
  for (let y = 8; y <= 12; y++) for (let x = 38; x <= 41; x++) off.height[y * 80 + x] = 3;
  lit(off, { x: 20, y: 10.5, h: 5, radius: 40, shadows: false });
  assert.ok(Math.abs(at(off, 46, 10) - at(open, 46, 10)) < 1e-6);
});

test("fried-light: a dome is brighter on the side toward the light", () => {
  const L = createLighting(60, 30);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 60; x++) {
    const u = (x + 0.5 - 40) / 8, v = (y + 0.5 - 15) / 4, d = u * u + v * v;
    if (d < 1) L.height[y * 60 + x] = 2 * Math.sqrt(1 - d);
  }
  lit(L, { x: 14, y: 15, h: 6, radius: 40 });
  assert.ok(at(L, 34, 15) > at(L, 46, 15) * 1.3, `toward ${at(L, 34, 15).toFixed(3)} away ${at(L, 46, 15).toFixed(3)}`);
  assert.ok(L.maxHeight > 1.9);
});

test("fried-light: ambient and an added field are light too; colour is kept", () => {
  const L = createLighting(4, 2);
  L.normals(); L.ambient(0.1, 0.2, 0.3);
  L.addField({ r: new Float32Array(8).fill(1), g: new Float32Array(8), b: new Float32Array(8) }, 0.5);
  L.point({ x: 2, y: 1, h: 4, radius: 6, color: [0, 1, 0] });
  L.finish();
  assert.ok(Math.abs(L.r[0] - 0.6) < 1e-6);
  assert.ok(L.g[0] > 0.2 && Math.abs(L.b[0] - 0.3) < 1e-6);
});

test("fried-light: toneGlyph picks from a ramp, with jitter and hard bands", () => {
  const ramp = [" ", ".", ":", "#"];
  assert.equal(toneGlyph(ramp, 0), " ");
  assert.equal(toneGlyph(ramp, 1), "#");
  assert.equal(toneGlyph(ramp, 5), "#");
  assert.equal(toneGlyph(ramp, 0.5, -0.5), ".");
  assert.equal(toneGlyph(ramp, 0.5, 0.5), ":");
  assert.equal(toneGlyph(ramp, 0.4, 0, 2), toneGlyph(ramp, 0.6, 0, 2), "two bands: 0.4 and 0.6 land in the same one");
});
