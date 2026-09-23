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

// A helper to easily render the matching route
export function router(routes) {
  const path = currentRoute.value;
  const renderView = routes[path] || routes["*"];
  return renderView ? renderView() : null;
}
