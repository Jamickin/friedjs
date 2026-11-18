import { state, action } from "../fried.js";
import { createDatabase } from "../addons/fried-db.js";
import { defaultCategories } from "./parsing.js";
import { todayISO } from "./dates.js";

const SKIN_KEY = "pivot-fried:skin";
const THEME_KEY = "pivot-fried:theme";

export const db = createDatabase("pivot-fried", ["entries", "categories"]);

export const composerText = state("");
export const focusConcept = state(null);
export const skin = state(localStorage.getItem(SKIN_KEY) || "flat");
export const theme = state(localStorage.getItem(THEME_KEY) || "light");

function applySkinTheme() {
  document.documentElement.dataset.skin = skin.value;
  document.documentElement.dataset.theme = theme.value;
}
applySkinTheme();

export const setSkin = action("setSkin", (id) => {
  skin.value = id;
  localStorage.setItem(SKIN_KEY, id);
  applySkinTheme();
});

export const setTheme = action("setTheme", (id) => {
  theme.value = id;
  localStorage.setItem(THEME_KEY, id);
  applySkinTheme();
});

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [view, param] = raw.split("/");
  if (view === "string") return { view: "string" };
  if (view === "settings") return { view: "settings" };
  if (view === "day" && param) return { view: "day", date: param };
  return { view: "day", date: todayISO() };
}

export const route = state(parseHash());
window.addEventListener("hashchange", () => {
  route.value = parseHash();
});

export const navigate = action("navigate", (hash) => {
  location.hash = hash;
  route.value = parseHash();
});

export async function initStore() {
  await db.init();
  if (db.collections.categories.value.length === 0) {
    db.collections.categories.bulkInsert(defaultCategories());
  }
}
