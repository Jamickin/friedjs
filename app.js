import { mount, ui } from "./fried.js";
import { initStore, route, navigate } from "./src/store.js";
import { DayView } from "./src/views/day.js";
import { StringView } from "./src/views/string.js";
import { SettingsView } from "./src/views/settings.js";
import { shellStyles } from "./src/theme.js";
import { todayISO } from "./src/dates.js";

const shell = shellStyles();

function Tab(label, active, onclick) {
  return ui("button", { key: `tab-${label}`, class: active ? shell.tabActive : shell.tab, onclick }, label);
}

function renderApp() {
  const r = route.value;
  return ui("div", { key: "app-root" }, [
    ui("nav", { key: "nav", class: shell.nav }, [
      ui("span", { key: "brand", class: shell.brand }, "Pivot · rebuilt in fried.js"),
      Tab("Day", r.view === "day", () => navigate(`#/day/${r.date || todayISO()}`)),
      Tab("String", r.view === "string", () => navigate("#/string")),
      Tab("Settings", r.view === "settings", () => navigate("#/settings")),
    ]),
    r.view === "string" ? StringView() : r.view === "settings" ? SettingsView() : DayView(r.date || todayISO()),
  ]);
}

mount(renderApp, document.getElementById("app"));
initStore();
