// fried-score: server-side state for a single Node process.
//
// One JSON file of state (score.json, written atomically through a .tmp
// rename, debounced) plus an append-only event log (events.jsonl), an
// in-memory ring buffer of recent events, subscribers, and per-item text
// logs (logs/<id>.log). Only the owning process writes these files, so
// there are no locks. Node built-ins only, no dependencies.
//
// Extracted from Orchestra's composer/store.mjs, behaviour unchanged:
//   createScore(stateDir) === createStore(stateDir).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const defaultState = () => ({ agents: {}, plans: {}, tasks: {}, asks: {}, notes: [], orders: [], seq: 0 });

// options: a state directory string, or
// { dir, scoreFile, eventsFile, logsDir, ringSize, debounceMs, skipLogTypes, initialState }.
export function createScore(options) {
  const opts = typeof options === "string" ? { dir: options } : { ...options };
  if (!opts.dir) throw new Error("createScore: a state directory is required");
  const dir = opts.dir;
  const ringSize = opts.ringSize ?? 3000;
  const debounceMs = opts.debounceMs ?? 150;
  const skipLogTypes = opts.skipLogTypes ?? ["log"];
  const initialState = opts.initialState ?? defaultState;
  const logsDir = join(dir, opts.logsDir ?? "logs");

  mkdirSync(logsDir, { recursive: true });
  const scoreFile = join(dir, opts.scoreFile ?? "score.json");
  const eventsFile = join(dir, opts.eventsFile ?? "events.jsonl");

  let state;
  if (existsSync(scoreFile)) {
    state = JSON.parse(readFileSync(scoreFile, "utf8"));
  } else {
    state = initialState();
    state.seq ??= 0;
  }

  // Reload the newest events; a truncated tail line never crashes startup.
  const ring = [];
  if (existsSync(eventsFile)) {
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n").slice(-ringSize);
    for (const l of lines) {
      try { ring.push(JSON.parse(l)); } catch {}
    }
  }

  const listeners = new Set();
  let timer = null;

  function save() {
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  function flush() {
    clearTimeout(timer);
    const tmp = scoreFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, scoreFile);
  }

  // skipLogTypes (default 'log') stay in the ring and reach subscribers,
  // but are not written to events.jsonl.
  function emit(type, text, extra = {}) {
    const ev = { seq: ++state.seq, at: new Date().toISOString(), type, text, ...extra };
    ring.push(ev);
    if (ring.length > ringSize) ring.shift();
    if (!skipLogTypes.includes(type)) appendFileSync(eventsFile, JSON.stringify(ev) + "\n");
    save();
    for (const fn of listeners) fn(ev);
    return ev;
  }

  function taskLog(taskId, line) {
    appendFileSync(join(logsDir, taskId + ".log"), line + "\n");
  }

  function readTaskLog(taskId, tail = 200) {
    const f = join(logsDir, taskId + ".log");
    if (!existsSync(f)) return "";
    return readFileSync(f, "utf8").split("\n").slice(-tail).join("\n");
  }

  return {
    state,
    save,
    flush,
    emit,
    taskLog,
    readTaskLog,
    since: (seq) => ring.filter((e) => e.seq > seq),
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
}

// "plan" -> "plan-<base36 time><4 hex>".
export function id(prefix) {
  return prefix + "-" + Date.now().toString(36) + randomBytes(2).toString("hex");
}

// A hex token, 48 chars by default.
export function token(bytes = 24) {
  return randomBytes(bytes).toString("hex");
}
