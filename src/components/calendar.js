import { ui } from "../../fried.js";
import { navigate, db } from "../store.js";
import { monthGrid, monthLabel, addMonths, todayISO } from "../dates.js";
import { calendarStyles } from "../theme.js";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

export function Calendar(selectedISO) {
  const styles = calendarStyles();
  const weeks = monthGrid(selectedISO);
  const entryDates = new Set(db.collections.entries.value.map((e) => e.date));
  const today = todayISO();

  return ui("div", { key: "calendar", class: styles.cal }, [
    ui("div", { key: "cal-header", class: styles.calHeader }, [
      ui("button", { key: "cal-prev", class: styles.calNav, onclick: () => navigate(`#/day/${addMonths(selectedISO, -1)}`) }, "‹"),
      ui("span", { key: "cal-label", class: styles.calLabel }, monthLabel(selectedISO)),
      ui("button", { key: "cal-next", class: styles.calNav, onclick: () => navigate(`#/day/${addMonths(selectedISO, 1)}`) }, "›"),
    ]),
    ui("div", { key: "cal-weekdays", class: styles.calWeekRow }, WEEKDAY_LABELS.map((w, i) =>
      ui("span", { key: `wd-${i}`, class: styles.calWeekday }, w)
    )),
    ui("div", { key: "cal-grid", class: styles.calGrid }, weeks.map((week, wi) =>
      ui("div", { key: `w-${wi}`, class: styles.calRow }, week.map((day) => {
        const classes = [styles.calDay];
        if (!day.inMonth) classes.push(styles.calDayOut);
        if (day.iso === selectedISO) classes.push(styles.calDaySelected);
        if (day.iso === today) classes.push(styles.calDayToday);
        return ui("button", {
          key: `d-${day.iso}`,
          class: classes.join(" "),
          onclick: () => navigate(`#/day/${day.iso}`),
        }, [
          ui("span", { key: "num", class: styles.calDayNum }, String(Number(day.iso.slice(8, 10)))),
          entryDates.has(day.iso) && day.iso !== selectedISO ? ui("span", { key: "dot", class: styles.calDayDot }) : null,
        ]);
      }))
    )),
  ]);
}
