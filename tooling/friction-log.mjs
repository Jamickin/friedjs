// friction-log: the one writer for evolution/friction.jsonl (format in
// evolution/README.md). Validates and caps a line, appends it, rotates the
// file when it passes ~2 MB, and never throws: a logging failure must never
// break the thing that was being logged. Zero dependencies, and no static
// node: imports, so tooling/patcher.js can import it without dragging
// Node built-ins into a browser bundle. Node's fs/path are only looked up
// when a line is actually written.
//
// As a CLI (for people, and for agents that can't call the composer's
// fried_friction tool):
//   node tooling/friction-log.mjs --want "..." --tried "..." [--error ...]
//     [--workaround ...] [--file ...] [--op ...] [--consumer ...]
//     [--agent ...] [--source agent|patcher]
// appends to $FRIED_FRICTION_LOG, or to evolution/friction.jsonl.

export const CAPS = {
  want: 300, tried: 300, workaround: 300, error: 500, file: 200, op: 80, consumer: 60, agent: 60,
};
export const SOURCES = ["agent", "patcher"];
export const OUTCOMES = ["ok", "failed", "nearest-used"];
export const ROTATE_BYTES = 2 * 1024 * 1024;

const TEXT_FIELDS = ["consumer", "agent", "want", "tried", "error", "workaround", "file", "op"];
const REQUIRED = ["want", "tried"];
const NULLABLE = ["error", "workaround", "file", "op"];

// Control characters (C0, DEL, C1) become a space, so a multi-line error
// stays one JSONL line and can't smuggle terminal escapes into a report.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;
// Obvious credentials. Lines must never carry secrets; this is a backstop,
// not a licence to log them.
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,})|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/g;
// A repo-relative (or absolute) path: path characters only, so a snippet
// of source text or a file's contents can't be passed off as a "file".
const PATH_RE = /^[\w.\-\/\\:@+~ ]+$/;

function clean(value) {
  return value.replace(CONTROL_RE, " ").replace(SECRET_RE, "[redacted]").trim();
}

function toDate(now) {
  if (typeof now === "function") now = now();
  if (now instanceof Date) return now;
  if (typeof now === "number" || typeof now === "string") return new Date(now);
  return new Date();
}

/**
 * Checks one friction object against the line contract.
 * Returns { ok, line, value, errors }: `value` is the normalised object
 * (fixed key order, caps applied, control characters stripped), `line` its
 * JSON text without the newline. Over-long text is cut, not rejected;
 * missing want/tried, wrong types, a non-path `file`, a bad `at` or an
 * unknown source/outcome are errors (ok:false, line:null).
 */
export function validateLine(obj, { now } = {}) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, line: null, value: null, errors: ["a friction line must be a plain object"] };
  }
  const out = {};

  if (obj.at === undefined || obj.at === null || obj.at === "") {
    out.at = toDate(now).toISOString();
  } else {
    const d = typeof obj.at === "string" || typeof obj.at === "number" || obj.at instanceof Date ? new Date(obj.at) : null;
    if (!d || Number.isNaN(d.getTime())) errors.push("at: must be an ISO 8601 time");
    else out.at = d.toISOString();
  }

  for (const field of TEXT_FIELDS) {
    let v = obj[field];
    if (v === undefined || v === null) {
      if (REQUIRED.includes(field)) errors.push(`${field}: required`);
      out[field] = NULLABLE.includes(field) || REQUIRED.includes(field) ? null : "unknown";
      continue;
    }
    if (typeof v !== "string") {
      errors.push(`${field}: must be a string${NULLABLE.includes(field) ? " or null" : ""}`);
      continue;
    }
    v = clean(v);
    if (field === "file") {
      if (v && !PATH_RE.test(v)) {
        errors.push("file: must be a path (path characters only), never file contents");
        continue;
      }
      // Keep the end of a long path: the file name is the useful part.
      v = v.slice(-CAPS.file);
    } else {
      v = v.slice(0, CAPS[field]);
    }
    if (!v) {
      if (REQUIRED.includes(field)) errors.push(`${field}: required`);
      out[field] = NULLABLE.includes(field) || REQUIRED.includes(field) ? null : "unknown";
      continue;
    }
    out[field] = v;
  }

  if (obj.source !== undefined && obj.source !== null) {
    if (!SOURCES.includes(obj.source)) errors.push(`source: must be one of ${SOURCES.join(", ")}`);
    else out.source = obj.source;
  }
  if (obj.outcome !== undefined && obj.outcome !== null) {
    if (!OUTCOMES.includes(obj.outcome)) errors.push(`outcome: must be one of ${OUTCOMES.join(", ")}`);
    else if (obj.source !== "patcher") errors.push("outcome: only patcher lines (source \"patcher\") carry an outcome");
    else out.outcome = obj.outcome;
  }

  if (errors.length) return { ok: false, line: null, value: null, errors };
  return { ok: true, line: JSON.stringify(out), value: out, errors: [] };
}

function builtin(name) {
  const p = globalThis.process;
  return p && typeof p.getBuiltinModule === "function" ? p.getBuiltinModule(name) : null;
}

function envFile() {
  const p = globalThis.process;
  return p && p.env ? p.env.FRIED_FRICTION_LOG : undefined;
}

/** friction.jsonl -> friction.2026-10-21.jsonl, or -1, -2... if taken. */
function rotatedName(fs, path, file, date) {
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  const day = date.toISOString().slice(0, 10);
  let candidate = `${stem}.${day}${ext}`;
  for (let n = 1; fs.existsSync(candidate); n++) candidate = `${stem}.${day}-${n}${ext}`;
  return candidate;
}

/**
 * Validates `obj` and appends it as ONE line to `file` (default
 * $FRIED_FRICTION_LOG). Does nothing when no file is configured. Creates
 * the parent folder; when the file is already over ~2 MB it is renamed to
 * <name>.<YYYY-MM-DD>[-n].jsonl next to itself first, and a fresh file is
 * started. Old lines are never rewritten. Never throws: returns
 * { ok: true } / { ok: true, skipped: true } / { ok: false, error }.
 */
export function appendFriction(obj, { file = envFile(), now, fs, rotateBytes = ROTATE_BYTES } = {}) {
  try {
    if (!file) return { ok: true, skipped: true };
    const date = toDate(now);
    const checked = validateLine(obj, { now: date });
    if (!checked.ok) return { ok: false, error: checked.errors.join("; ") };
    fs = fs || builtin("node:fs");
    const path = builtin("node:path");
    if (!fs || !path) return { ok: false, error: "no filesystem available (not running under Node)" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size >= rotateBytes) fs.renameSync(file, rotatedName(fs, path, file, date));
    fs.appendFileSync(file, checked.line + "\n", "utf8");
    return { ok: true, line: checked.line };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Every line in `dir`'s friction.jsonl plus its rotated
 * friction.<date>[-n].jsonl files, oldest file first. Lines that aren't
 * JSON objects are skipped. A missing folder or file reads as [].
 */
export function readFriction(dir, { fs } = {}) {
  fs = fs || builtin("node:fs");
  const path = builtin("node:path");
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rotated = names.filter((n) => /^friction\.\d{4}-\d{2}-\d{2}(-\d+)?\.jsonl$/.test(n));
  const order = (n) => {
    const m = n.match(/^friction\.(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.jsonl$/);
    return [m[1], Number(m[2] || 0)];
  };
  rotated.sort((a, b) => {
    const [da, na] = order(a); const [db, nb] = order(b);
    return da < db ? -1 : da > db ? 1 : na - nb;
  });
  const files = [...rotated, ...(names.includes("friction.jsonl") ? ["friction.jsonl"] : [])];
  const lines = [];
  for (const name of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) lines.push(obj);
      } catch { /* bad line: skip */ }
    }
  }
  return lines;
}

// -- CLI --------------------------------------------------------------------

const CLI_FIELDS = ["want", "tried", "error", "workaround", "file", "op", "consumer", "agent", "source"];

export function parseCliArgs(argv) {
  const obj = {};
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true, obj, problems };
    const m = a.match(/^--([a-z]+)(?:=(.*))?$/s);
    if (!m || !CLI_FIELDS.includes(m[1])) { problems.push(`unknown argument: ${a}`); continue; }
    const value = m[2] !== undefined ? m[2] : argv[++i];
    if (value === undefined) { problems.push(`--${m[1]} needs a value`); continue; }
    obj[m[1]] = value;
  }
  return { help: false, obj, problems };
}

const USAGE = `usage: node tooling/friction-log.mjs --want "<goal>" --tried "<what you ran>"
         [--error "<exact error>"] [--workaround "<what you did instead>"]
         [--file <repo-relative path>] [--op <api or patcher op>]
         [--consumer <project>] [--agent <who>] [--source agent|patcher]
Appends one line to $FRIED_FRICTION_LOG, or evolution/friction.jsonl.
Format: evolution/README.md.`;

function runCli() {
  const path = builtin("node:path");
  const url = builtin("node:url");
  const { help, obj, problems } = parseCliArgs(process.argv.slice(2));
  if (help) { console.log(USAGE); return 0; }
  if (problems.length) { console.error(problems.join("\n") + "\n" + USAGE); return 2; }
  if (obj.source === undefined) obj.source = "agent";
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const file = process.env.FRIED_FRICTION_LOG || path.join(here, "..", "evolution", "friction.jsonl");
  const checked = validateLine(obj);
  if (!checked.ok) { console.error("friction line rejected:\n  " + checked.errors.join("\n  ")); return 1; }
  const res = appendFriction(obj, { file });
  if (!res.ok) { console.error("could not append: " + res.error); return 1; }
  console.log(`appended to ${file}:\n${res.line}`);
  return 0;
}

{
  const p = globalThis.process;
  const url = builtin("node:url");
  const path = builtin("node:path");
  if (p && p.argv && p.argv[1] && url && path
      && path.resolve(p.argv[1]) === url.fileURLToPath(import.meta.url)) {
    p.exitCode = runCli();
  }
}
