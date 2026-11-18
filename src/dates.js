// Date helpers, all operating on plain "YYYY-MM-DD" strings (local time,
// no timezone math) since that's the only shape entries are keyed by.

export function isoFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dateFromISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO() {
  return isoFromDate(new Date());
}

export function addDays(iso, n) {
  const d = dateFromISO(iso);
  d.setDate(d.getDate() + n);
  return isoFromDate(d);
}

export function addMonths(iso, n) {
  const d = dateFromISO(iso);
  d.setMonth(d.getMonth() + n);
  return isoFromDate(d);
}

export function monthLabel(iso) {
  return dateFromISO(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function dayLabel(iso) {
  return dateFromISO(iso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// A 6-week grid (42 days) covering the month `iso` falls in, always
// starting on a Sunday, so the calendar's row count never jumps between
// months.
export function monthGrid(iso) {
  const d = dateFromISO(iso);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const cur = new Date(first);
  cur.setDate(first.getDate() - first.getDay());

  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push({ iso: isoFromDate(cur), inMonth: cur.getMonth() === d.getMonth() });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}
