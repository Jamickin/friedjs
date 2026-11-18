import { ui, action } from "../../fried.js";
import { db, composerText, navigate } from "../store.js";
import { parseLine } from "../parsing.js";
import { todayISO, addDays, dayLabel } from "../dates.js";
import { Calendar } from "../components/calendar.js";
import { EntryCard } from "../components/entryCard.js";
import { dayStyles } from "../theme.js";

const commitLine = action("commitLine", (date) => {
  const raw = composerText.value;
  if (!raw.trim()) return;
  const { text, markerLevel } = parseLine(raw);
  db.collections.entries.insert({ date, text, markerLevel, createdAt: Date.now() });
  composerText.value = "";
});

export function DayView(date) {
  const styles = dayStyles();
  const entries = db.collections.entries.value
    .filter((e) => e.date === date)
    .sort((a, b) => a.createdAt - b.createdAt);
  const catByLevel = new Map(db.collections.categories.value.map((c) => [c.markerLevel, c]));

  return ui("div", { key: "day-view", class: styles.layout }, [
    ui("div", { key: "main", class: styles.main }, [
      ui("div", { key: "day-header", class: styles.header }, [
        ui("button", { key: "prev", class: styles.navBtn, onclick: () => navigate(`#/day/${addDays(date, -1)}`) }, "‹"),
        ui("h2", { key: "day-title", class: styles.title }, dayLabel(date)),
        ui("button", { key: "next", class: styles.navBtn, onclick: () => navigate(`#/day/${addDays(date, 1)}`) }, "›"),
        ui("button", { key: "today", class: styles.todayBtn, onclick: () => navigate(`#/day/${todayISO()}`) }, "Today"),
      ]),
      ui("div", { key: "composer", class: styles.composer }, [
        ui("input", {
          key: "composer-input",
          id: "composer-input",
          class: styles.input,
          value: composerText.value,
          placeholder: "Write a line… end with */**/*** to mark it, [[link]] to connect it",
          oninput: (e) => { composerText.value = e.target.value; },
          // fried.js's hydrate deliberately skips writing `value` back to a
          // focused input (avoids cursor jumps while typing), so resetting
          // composerText.value alone doesn't clear what's visibly in the
          // field while it stays focused across Enter — clear the DOM value
          // directly here too, in addition to the state.
          onkeydown: (e) => { if (e.key === "Enter") { commitLine(date); e.target.value = ""; } },
        }),
        ui("button", {
          key: "send", class: styles.sendBtn,
          onclick: () => {
            commitLine(date);
            const input = document.getElementById("composer-input");
            if (input) input.value = "";
          },
        }, "Add"),
      ]),
      ui("p", { key: "hint", class: styles.hint }, "Each line becomes its own card. [[2026-09-23]] jumps to a day, [[anything else]] grows the String graph."),
      ui("div", { key: "entries", class: styles.entries }, entries.length
        ? entries.map((e) => EntryCard(e, catByLevel.get(e.markerLevel), styles))
        : [ui("div", { key: "empty", class: styles.empty }, "No entries yet for this day — write the first line above.")]
      ),
    ]),
    ui("div", { key: "side", class: styles.side }, [Calendar(date)]),
  ]);
}
