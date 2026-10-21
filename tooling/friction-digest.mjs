// friction-digest: turns the friction log into a ranked markdown report.
//
//   node tooling/friction-digest.mjs [--dir evolution] [--since 7d|YYYY-MM-DD]
//                                    [--top 10] [--write]
//
// Reads friction.jsonl plus its rotated friction.<date>.jsonl files (via
// tooling/friction-log.mjs), groups the lines, ranks the groups and prints
// markdown; --write also saves it to <dir>/digests/<YYYY-MM-DD>.md.
// Everything here is deterministic: same lines + same `now` -> same report.
//
// Grouping:
//   - agent lines (source "agent" or no source): by (op, normalised error),
//     where normalising lower-cases the error and strips quoted strings,
//     paths and digits, so "no key \"saveBtn\" at line 12" and "no key
//     \"save\" at line 40" land in one group.
//   - patcher lines (source "patcher"): by (op, outcome). "ok" lines are not
//     friction, so they only feed the "patcher op health" table.
// Score (higher ranks first): 10 per line + 5 per distinct agent + up to 7
// for recency (7 minus whole days since last seen, floored at 0) + 20 x the
// op's patcher failure rate (patcher groups only; failure rate = failed /
// (ok + failed + nearest-used)). Ties: count, then last seen, then the
// group key, so the order is stable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFriction } from "./friction-log.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "7d" -> now minus 7 days; "2026-10-01" -> that day (UTC); else null. */
export function parseSince(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return null;
  const rel = /^(\d+)d$/.exec(value);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * DAY_MS);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value + "T00:00:00Z");
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`--since must look like 7d or YYYY-MM-DD, got "${value}"`);
}

export function normaliseError(error) {
  if (error === null || error === undefined || error === "") return "(no error)";
  const out = String(error)
    .toLowerCase()
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, " ")
    .replace(/(?:[a-z]:)?(?:[\w.-]*[\/\\])+[\w.-]*/g, " ")
    .replace(/[\w-]+\.(?:m?js|cjs|ts|json|jsonl|md|html|css)\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[():,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out || "(no error)";
}

const isPatcher = (l) => l.source === "patcher";
const timeOf = (l) => {
  const t = Date.parse(l.at);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Groups and ranks friction lines. opts: { now: Date, since: Date|null,
 * top: number }. Returns { now, since, total, groups, health }.
 */
export function rank(lines, { now = new Date(), since = null, top = 10 } = {}) {
  const sinceMs = since ? since.getTime() : -Infinity;
  const kept = lines.filter((l) => l && typeof l === "object" && timeOf(l) >= sinceMs);

  const healthByOp = new Map();
  for (const l of kept.filter(isPatcher)) {
    const op = l.op || "(none)";
    const h = healthByOp.get(op) || { op, calls: 0, ok: 0, failed: 0, nearestUsed: 0 };
    h.calls++;
    if (l.outcome === "failed") h.failed++;
    else if (l.outcome === "nearest-used") h.nearestUsed++;
    else h.ok++;
    healthByOp.set(op, h);
  }
  for (const h of healthByOp.values()) h.failureRate = h.calls ? h.failed / h.calls : 0;

  const groups = new Map();
  for (const l of kept) {
    const patcher = isPatcher(l);
    if (patcher && l.outcome !== "failed" && l.outcome !== "nearest-used") continue;
    const op = l.op || "(none)";
    const key = patcher
      ? `patcher|${op}|${l.outcome}`
      : `agent|${op}|${normaliseError(l.error)}`;
    const g = groups.get(key) || { key, kind: patcher ? "patcher" : "agent", op, lines: [] };
    g.lines.push(l);
    groups.set(key, g);
  }

  const ranked = [...groups.values()].map((g) => {
    const sorted = [...g.lines].sort((a, b) => timeOf(a) - timeOf(b));
    const latest = sorted[sorted.length - 1];
    const lastMs = timeOf(latest);
    const agents = [...new Set(g.lines.map((l) => l.agent || "unknown"))].sort();
    const days = Math.floor((now.getTime() - lastMs) / DAY_MS);
    const recency = Math.max(0, 7 - Math.max(0, days));
    const failureRate = g.kind === "patcher" ? healthByOp.get(g.op)?.failureRate ?? 0 : 0;
    const score = g.lines.length * 10 + agents.length * 5 + recency + failureRate * 20;
    const what = g.kind === "patcher"
      ? `patcher ${g.op} ${latest.outcome === "failed" ? "failed" : "used a nearest: suggestion"}`
      : latest.want || "(no want)";
    return {
      key: g.key,
      kind: g.kind,
      what,
      op: g.op,
      count: g.lines.length,
      agents,
      lastSeen: lastMs ? new Date(lastMs).toISOString() : null,
      score: Math.round(score * 1000) / 1000,
      example: { want: latest.want ?? null, error: latest.error ?? null, workaround: latest.workaround ?? null },
    };
  });
  ranked.sort((a, b) => b.score - a.score
    || b.count - a.count
    || (b.lastSeen || "").localeCompare(a.lastSeen || "")
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const health = [...healthByOp.values()].sort((a, b) => b.failureRate - a.failureRate
    || b.calls - a.calls
    || (a.op < b.op ? -1 : a.op > b.op ? 1 : 0));

  return {
    now: now.toISOString(),
    since: since ? since.toISOString() : null,
    total: kept.length,
    groups: ranked.slice(0, Math.max(0, top)).map((g, i) => ({ rank: i + 1, ...g })),
    groupCount: ranked.length,
    health,
  };
}

function cell(value, max = 120) {
  if (value === null || value === undefined || value === "") return "-";
  let s = String(value).replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
  if (s.length > max) s = s.slice(0, max - 3) + "...";
  return s;
}

const pct = (r) => `${(r * 100).toFixed(1)}%`;

/** Markdown for a rank() result. */
export function render(ranking) {
  const out = [];
  out.push(`# Friction digest ${ranking.now.slice(0, 10)}`);
  out.push("");
  out.push(`${ranking.total} line(s)${ranking.since ? ` since ${ranking.since.slice(0, 10)}` : ""}, `
    + `${ranking.groupCount} friction group(s); top ${ranking.groups.length} below. `
    + "Generated by `node tooling/friction-digest.mjs` (deterministic, no AI).");
  out.push("");
  out.push("## Ranked friction");
  out.push("");
  if (!ranking.groups.length) {
    out.push("No friction recorded in this window.");
  } else {
    out.push("| Rank | What | Op | Count | Agents | Last seen | Example want | Example error | Example workaround |");
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const g of ranking.groups) {
      out.push(`| ${g.rank} | ${cell(g.what)} | ${cell(g.op, 80)} | ${g.count} | ${cell(g.agents.join(", "))} | `
        + `${cell(g.lastSeen && g.lastSeen.slice(0, 10))} | ${cell(g.example.want)} | ${cell(g.example.error)} | `
        + `${cell(g.example.workaround)} |`);
    }
  }
  out.push("");
  out.push("## Patcher op health");
  out.push("");
  if (!ranking.health.length) {
    out.push("No patcher lines (set FRIED_FRICTION_LOG to record them).");
  } else {
    out.push("| Op | Calls | OK | Failed | Nearest used | Failure rate |");
    out.push("| --- | --- | --- | --- | --- | --- |");
    for (const h of ranking.health) {
      out.push(`| ${cell(h.op, 80)} | ${h.calls} | ${h.ok} | ${h.failed} | ${h.nearestUsed} | ${pct(h.failureRate)} |`);
    }
  }
  out.push("");
  return out.join("\n");
}

function parseArgs(argv) {
  const opts = { dir: null, since: null, top: 10, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.top) || opts.top < 0) throw new Error("--top must be a whole number");
  return opts;
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    console.log("usage: node tooling/friction-digest.mjs [--dir evolution] [--since 7d|YYYY-MM-DD] [--top 10] [--write]");
    return 0;
  }
  const dir = opts.dir ? path.resolve(opts.dir) : path.join(here, "..", "evolution");
  const now = new Date();
  let since;
  try { since = parseSince(opts.since, now); } catch (err) {
    console.error(err.message);
    return 2;
  }
  const report = render(rank(readFriction(dir), { now, since, top: opts.top }));
  process.stdout.write(report);
  if (opts.write) {
    const outDir = path.join(dir, "digests");
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${now.toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(file, report, "utf8");
    console.error(`wrote ${file}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
