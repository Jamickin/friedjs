import { ui } from "../../fried.js";
import { db, skin, theme, setSkin, setTheme } from "../store.js";
import { settingsStyles } from "../theme.js";

const SKINS = [
  { id: "flat", label: "Flat", desc: "Crisp white cards on a light ground, hairline borders." },
  { id: "soft", label: "Soft", desc: "Neumorphic: panels extrude from the ground, controls press into it." },
];

export function SettingsView() {
  const styles = settingsStyles();
  const categories = db.collections.categories.value.slice().sort((a, b) => a.markerLevel - b.markerLevel);
  const entryCount = db.collections.entries.value.length;

  return ui("div", { key: "settings-view", class: styles.wrap }, [
    ui("h2", { key: "title", class: styles.title }, "Settings"),

    ui("section", { key: "appearance", class: styles.section }, [
      ui("h3", { key: "appearance-title", class: styles.sectionTitle }, "Appearance"),
      ui("div", { key: "skin-row", class: styles.row }, SKINS.map((s) =>
        ui("button", {
          key: `skin-${s.id}`,
          class: skin.value === s.id ? styles.choiceActive : styles.choice,
          onclick: () => setSkin(s.id),
        }, [
          ui("strong", { key: "label" }, s.label),
          ui("span", { key: "desc", class: styles.choiceDesc }, s.desc),
        ])
      )),
      ui("div", { key: "theme-row", class: styles.row }, [
        ui("button", { key: "theme-light", class: theme.value === "light" ? styles.choiceActive : styles.choice, onclick: () => setTheme("light") }, "Light"),
        ui("button", { key: "theme-dark", class: theme.value === "dark" ? styles.choiceActive : styles.choice, onclick: () => setTheme("dark") }, "Dark"),
      ]),
    ]),

    ui("section", { key: "categories", class: styles.section }, [
      ui("h3", { key: "categories-title", class: styles.sectionTitle }, "Marker categories"),
      ui("p", { key: "categories-hint", class: styles.hint }, "End a line with *, **, or *** to mark it — click a category's swatch or label to change it."),
      ui("div", { key: "cat-list", class: styles.catList }, categories.map((c) =>
        ui("div", { key: `cat-${c.id}`, class: styles.catRow }, [
          ui("span", { key: "stars", class: styles.catStars }, "*".repeat(c.markerLevel)),
          ui("input", { key: "swatch", type: "color", value: c.color, class: styles.swatch, oninput: (e) => db.collections.categories.update(c.id, { color: e.target.value }) }),
          ui("input", { key: "label", value: c.label, class: styles.catLabel, oninput: (e) => db.collections.categories.update(c.id, { label: e.target.value }) }),
        ])
      )),
    ]),

    ui("section", { key: "data", class: styles.section }, [
      ui("h3", { key: "data-title", class: styles.sectionTitle }, "Data"),
      ui("p", { key: "data-hint", class: styles.hint }, `${entryCount} ${entryCount === 1 ? "entry" : "entries"} stored locally in this browser's IndexedDB — nothing leaves the device.`),
      ui("button", {
        key: "clear",
        class: styles.dangerBtn,
        onclick: () => { if (confirm("Delete all entries? This can't be undone.")) db.collections.entries.clear(); },
      }, "Clear all entries"),
    ]),
  ]);
}
