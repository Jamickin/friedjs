// fried-proc: child processes for AI CLI runners and check runners. Node only, built-ins only.
//   lineReader       – UTF-8 line splitting with partial-line buffering
//   killTree         – end a child and everything it started (taskkill /T /F on Windows)
//   limitHit         – is this output line a usage limit?
//   resetTime        – when does that limit reset, from the error text
//   sanitizeOutput   – strip ANSI/OSC sequences, \r redraws and control characters
//   tailOutput       – the last lines / bytes of sanitized output
//   spawnLineProcess – spawn a CLI, read it line by line, stop it on a limit or a failed resume
// Extracted from Orchestra's composer (conductor.mjs, adapters.mjs, checker.mjs); behaviour is identical.
import { execFile, spawn, spawnSync } from 'node:child_process';

export const RATE_LIMIT = /(rate.?limit|usage limit|limit reached|hit your (usage )?limit|quota (exceeded|exhausted|reached)|exceeded (your )?quota|too many requests|resource.?exhausted|\b429\b)/i;

// What each CLI says when the conversation it was asked to resume isn't there:
// Claude "No conversation found with session ID: …", Codex "thread/resume failed:
// no rollout found for thread id …" (and exit 0), agy 'warning: conversation "…" not found'
// (then it quietly starts a new one).
export const RESUME_FAILED = /no conversation found|no rollout found|thread\/resume failed|conversation "?[\w-]+"? not found|(session|conversation|thread) (id )?not found|could not (find|resume) (the )?(session|conversation)|failed to resume/i;

const DEFAULT_REST_MINUTES = 30;
const TAIL_LINES = 60;
const TAIL_BYTES = 4096;

/**
 * Session ids come from a CLI's stdout and end up in file paths and argv, so only plain ids
 * pass, and never one that starts with '-' (it would read as a flag after --resume).
 * @param {unknown} id
 * @returns {string | null}
 */
export const sessionIdOk = (id) => (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? id : null);

/**
 * Calls onLine for every complete line (trailing \r removed), and for a last line without \n at end.
 * @param {import('node:stream').Readable} stream
 * @param {(line: string) => void} onLine
 */
export function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  stream.on('end', () => buf && onLine(buf));
}

/**
 * Ends a child and its whole process tree.
 * Default (a running AI CLI): async `taskkill /T /F` on Windows, child.kill(signal) elsewhere; no-op once it exited.
 * sync: true (a check that timed out, spawned detached on POSIX): `spawnSync('taskkill' …)` on Windows,
 * else the whole process group with signal (default SIGKILL), falling back to the child alone.
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 * @param {{ sync?: boolean, signal?: NodeJS.Signals }} [options]
 */
export function killTree(child, { sync = false, signal } = {}) {
  if (sync) {
    if (!child?.pid) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else {
      try {
        process.kill(-child.pid, signal || 'SIGKILL');
      } catch {
        child.kill(signal || 'SIGKILL');
      }
    }
    return;
  }
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill(signal || 'SIGTERM');
}

/**
 * Adapters that know their own error format say whether a line is a usage limit;
 * otherwise only stderr and error-looking JSON count, so a musician merely
 * writing the word "quota" in its work never triggers a hand-off.
 * @param {{ limitHit?: (line: string, obj: any, stream: 'out' | 'err') => boolean } | null | undefined} adapter
 * @param {string} line
 * @param {any} obj the line parsed as JSON, or null
 * @param {'out' | 'err'} stream
 * @returns {boolean}
 */
export function limitHit(adapter, line, obj, stream) {
  // A plain (non-JSON) line is only a limit message if it is short and not a CLI echoing a tool call:
  // Codex logs whole failed commands to stderr, and one that mentioned 'quota' once cost a task its musician.
  if (!obj && (line.length > 400 || /tools::router|exec_command|CreateProcess/.test(line))) return false;
  if (adapter?.limitHit) return adapter.limitHit(line, obj, stream);
  if (!RATE_LIMIT.test(line)) return false;
  if (!obj) return stream === 'err';
  return /error|fail/i.test(String(obj.type ?? obj.event ?? obj.status ?? ''));
}

/**
 * "try again in 3h 20m", "retry after 90 seconds", "resets at 14:30"; else defaultMinutes from now.
 * @param {string} line
 * @param {number} [now]
 * @param {number} [defaultMinutes]
 * @returns {Date}
 */
export function resetTime(line, now = Date.now(), defaultMinutes = DEFAULT_REST_MINUTES) {
  const s = String(line);
  const after = s.match(/(?:in|after)\s+((?:\d+\s*(?:h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\s*)+)/i);
  if (after) {
    let ms = 0;
    for (const [, n, u] of after[1].matchAll(/(\d+)\s*(h|m|s)/gi)) ms += Number(n) * { h: 3600e3, m: 60e3, s: 1e3 }[u.toLowerCase()];
    if (ms > 0) return new Date(now + ms + 30e3);
  }
  const at = s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at && (at[2] || at[3])) {
    const d = new Date(now);
    let h = Number(at[1]);
    const ap = at[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    d.setHours(h, Number(at[2] || 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  return new Date(now + defaultMinutes * 60000);
}

/**
 * @param {unknown} text
 * @returns {string} text without OSC/CSI sequences, \r redraws (the last draw stays) and control characters
 */
export function sanitizeOutput(text) {
  return String(text || '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles, links)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (colours, cursor)
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r(?!\n)/g, '') // progress bars redraw the line with \r; keep the last draw
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/**
 * The end of sanitized output: at most maxLines lines and maxBytes UTF-8 bytes, no cut-in-half leading character.
 * @param {unknown} text
 * @param {{ maxLines?: number, maxBytes?: number }} [options]
 * @returns {string}
 */
export function tailOutput(text, { maxLines = TAIL_LINES, maxBytes = TAIL_BYTES } = {}) {
  let t = sanitizeOutput(text).replace(/\s+$/, '');
  const lines = t.split('\n');
  if (lines.length > maxLines) t = lines.slice(-maxLines).join('\n');
  if (Buffer.byteLength(t) > maxBytes) {
    const buf = Buffer.from(t);
    t = buf.subarray(buf.length - maxBytes).toString('utf8').replace(/^�+/, '');
  }
  return t;
}

/**
 * Spawns a CLI and reads stdout/stderr line by line. Each non-blank line goes, in order, through:
 * JSON parse (stdout lines starting with '{'), onRawLine, session id / spoke tracking (ignored once a
 * resume failed), resume-failure detection (kills the tree), usage-limit detection (kills the tree),
 * then the adapter's parser into onParsedLine.
 * onClose's badResume covers the process side only ("a resume was asked for and did not take");
 * a caller that tracks its own task state adds its own conditions to it.
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   adapter?: {
 *     parser?: () => { feed: (obj: any) => string[], flush?: () => string[], final: () => string },
 *     limitHit?: (line: string, obj: any, stream: 'out' | 'err') => boolean,
 *     sessionId?: (obj: any) => string | null | undefined,
 *     spoke?: (obj: any) => boolean,
 *   } | null,
 *   resumeId?: string | null,
 *   onRawLine?: (line: string, stream: 'out' | 'err', obj: any) => void,
 *   onParsedLine?: (line: string, stream: 'out' | 'err', info: { flushed: boolean }) => void,
 *   onSession?: (sessionId: string) => void,
 *   onSpoke?: (sessionId: string) => void,
 *   onLimit?: (line: string) => void,
 *   onResumeFailed?: (line: string) => void,
 *   onClose?: (outcome: {
 *     code: number | null,
 *     limit: string | null,
 *     resumeFailed: string | null,
 *     badResume: boolean,
 *     startError: string | null,
 *     spoke: boolean,
 *     sessionId: string | null,
 *     finalText: string,
 *   }) => void,
 * }} options
 *   env replaces the child's environment (default process.env). onParsedLine gets the parser's
 *   non-blank feed() lines with { flushed: false }, then on close whatever parser.flush() returns,
 *   unfiltered, with { flushed: true }. Existing two-argument callbacks remain compatible. onSpoke fires once,
 *   when the run has both spoken and reported a session id (the conversation worth resuming).
 * @returns {{ child: import('node:child_process').ChildProcess, kill: () => void, state: () => { spoke: boolean, sessionId: string | null, limit: string | null, resumeFailed: string | null } }}
 */
export function spawnLineProcess({
  command, args = [], cwd, env, adapter = null, resumeId = null,
  onRawLine, onParsedLine, onSession, onSpoke, onLimit, onResumeFailed, onClose,
}) {
  const child = spawn(command, args, { cwd, env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const parser = adapter?.parser ? adapter.parser() : null;
  let limit = null; // the line that reported a usage limit
  let spoke = false; // the CLI has started working (not just starting up)
  let resumeFailed = null; // the line saying the resumed conversation isn't there
  let sessionId = null; // the first id is this run's; later events can't swap it
  let recorded = false; // onSpoke has fired
  const safe = (fn, ...a) => {
    try {
      fn?.(...a);
    } catch {}
  };
  const lane = (line, stream) => {
    if (!line.trim()) return;
    let obj = null;
    if (stream === 'out' && line.startsWith('{')) {
      try {
        obj = JSON.parse(line);
      } catch {}
    }
    safe(onRawLine, line, stream, obj);
    // After a failed resume the run is being killed; whatever it prints before it dies must not count.
    if (obj && !resumeFailed) {
      try {
        const sid = adapter?.sessionId?.(obj);
        if (sid && !sessionId) {
          sessionId = sid;
          safe(onSession, sid);
        }
        if (adapter?.spoke?.(obj)) spoke = true;
        if (spoke && sessionId && !recorded) {
          recorded = true;
          safe(onSpoke, sessionId);
        }
      } catch {}
    }
    if (resumeId && !spoke && !resumeFailed && !limit && RESUME_FAILED.test(line)) {
      resumeFailed = line;
      safe(onResumeFailed, line);
      killTree(child);
    }
    // Stop the moment a usage limit shows up: CLIs tend to sit retrying with backoff.
    if (!limit && !resumeFailed && limitHit(adapter, line, obj, stream)) {
      limit = line;
      safe(onLimit, line);
      killTree(child);
    }
    const lines = obj && parser ? parser.feed(obj) : [line];
    for (const l of lines) if (l && l.trim()) safe(onParsedLine, l, stream, { flushed: false });
  };
  lineReader(child.stdout, (l) => lane(l, 'out'));
  lineReader(child.stderr, (l) => lane(l, 'err'));

  let startError = null;
  child.on('error', (e) => {
    startError = e.message;
    lane('! failed to start: ' + e.message, 'err');
  });
  child.on('close', (code) => {
    for (const l of parser?.flush?.() || []) safe(onParsedLine, l, 'out', { flushed: true });
    const badResume = !!resumeId && !!(resumeFailed || (!spoke && !limit && (startError || code !== 0)));
    onClose?.({ code, limit, resumeFailed, badResume, startError, spoke, sessionId, finalText: parser ? parser.final() : '' });
  });
  return { child, kill: () => killTree(child), state: () => ({ spoke, sessionId, limit, resumeFailed }) };
}
