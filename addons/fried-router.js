import { state, action } from "../fried.js";

/**
 * A lightweight Hash Router for Fried.js.
 * We use Hash Routing (#/about) instead of History API (/about)
 * so it works perfectly on zero-config static file servers.
 */

// The reactive state driving the router
export const currentRoute = state(window.location.hash.slice(1) || "/");

// Listen for browser Back/Forward buttons
window.addEventListener("hashchange", () => {
  const newRoute = window.location.hash.slice(1) || "/";
  if (currentRoute.value !== newRoute) {
    currentRoute.value = newRoute;
  }
});

// Programmatic navigation (call this from button clicks)
export const navigate = action("navigate", (path) => {
  if (currentRoute.value !== path) {
    window.location.hash = path;
    currentRoute.value = path;
  }
});

// decodeURIComponent that keeps the raw text on a bad escape ("%E0%A4%A").
function decode(text) {
  try { return decodeURIComponent(text); } catch (_) { return text; }
}

// "/done?agent=codex&day=today" -> { path: "/done", query: { agent: "codex", day: "today" } }.
// Query keys and values are URL-decoded ("+" is a space); the first value of a repeated key wins.
export function parseRoute(path) {
  const full = path == null || path === "" ? "/" : String(path);
  const q = full.indexOf("?");
  const query = {};
  if (q >= 0) {
    for (const part of full.slice(q + 1).split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const key = decode((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, " "));
      if (Object.prototype.hasOwnProperty.call(query, key)) continue;
      const value = eq < 0 ? "" : decode(part.slice(eq + 1).replace(/\+/g, " "));
      Object.defineProperty(query, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return { path: (q < 0 ? full : full.slice(0, q)) || "/", query };
}

// "/a/b/" and "/a/b" are the same route; "/" stays "/".
function segmentsOf(path) {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.split("/");
}

const own = (routes, key) =>
  Object.prototype.hasOwnProperty.call(routes, key) && typeof routes[key] === "function";

// Finds the view for `path` in a route table. Order: the exact key (the
// whole path, query included, as before 0.3.0), the exact key without the
// query, then ":param" patterns compared segment by segment (no regex, so
// pattern text is never interpreted): the pattern with the most literal
// segments wins, ties go to the one declared first. "*" is the last resort.
// Returns { view, params, query, path, pattern } or null.
export function matchRoute(routes, path) {
  if (!routes) return null;
  const full = path == null || path === "" ? "/" : String(path);
  const parsed = parseRoute(full);
  const hit = (pattern, params) => ({ view: routes[pattern], params, query: parsed.query, path: parsed.path, pattern });

  if (own(routes, full)) return hit(full, {});
  if (own(routes, parsed.path)) return hit(parsed.path, {});

  const segs = segmentsOf(parsed.path);
  let best = null, bestLiterals = -1;
  for (const pattern of Object.keys(routes)) {
    if (pattern === "*" || typeof routes[pattern] !== "function") continue;
    const pats = segmentsOf(pattern);
    if (pats.length !== segs.length) continue;
    let literals = 0, params = {}, ok = true;
    for (let i = 0; i < pats.length && ok; i++) {
      const p = pats[i];
      if (p.length > 1 && p[0] === ":") {
        if (segs[i] === "") ok = false;
        else Object.defineProperty(params, p.slice(1), { value: decode(segs[i]), enumerable: true, writable: true, configurable: true });
      } else if (p === segs[i]) literals++;
      else ok = false;
    }
    if (ok && literals > bestLiterals) { best = hit(pattern, params); bestLiterals = literals; }
  }
  if (best) return best;

  if (own(routes, "*")) return hit("*", {});
  return null;
}

// A helper to easily render the matching route. The view gets one
// argument, { params, query, path }; views that take none still work.
export function router(routes) {
  const m = matchRoute(routes, currentRoute.value);
  return m ? m.view({ params: m.params, query: m.query, path: m.path }) : null;
}
