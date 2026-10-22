import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  RATE_LIMIT, RESUME_FAILED, sessionIdOk, lineReader, killTree, limitHit, resetTime,
  sanitizeOutput, tailOutput, spawnLineProcess,
} from '../addons/server/fried-proc.js';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};
const reap = (pid) => {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
};

test('lineReader joins chunks split mid-line and mid-character, strips \\r, flushes the last line', async () => {
  const s = new PassThrough();
  const lines = [];
  lineReader(s, (l) => lines.push(l));
  const bytes = Buffer.from('héllo wo€rld\r\nsecond\nlast');
  const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte €
  s.write(bytes.subarray(0, 2)); // inside the 2-byte é
  s.write(bytes.subarray(2, cut));
  s.write(bytes.subarray(cut));
  s.end();
  await new Promise((r) => s.on('end', r));
  assert.deepEqual(lines, ['héllo wo€rld', 'second', 'last']);
});

test('lineReader feeds a cut-off JSON line through as text', async () => {
  const s = new PassThrough();
  const lines = [];
  lineReader(s, (l) => lines.push(l));
  s.end('{"type":"rate_limit_event","rate_limit_info":\nnext\n');
  await new Promise((r) => s.on('end', r));
  assert.deepEqual(lines, ['{"type":"rate_limit_event","rate_limit_info":', 'next']);
});

const now = new Date('2026-10-21T10:00:00').getTime();
const mins = (d) => Math.round((d - now) / 60000);

test('resetTime reads the error message', () => {
  assert.equal(mins(resetTime('quota exceeded, try again in 2 minutes', now)), 3); // +30s margin, rounded
  assert.equal(mins(resetTime('Please retry after 90s', now)), 2);
  assert.equal(mins(resetTime('limit reached, try again in 3h 20m', now)), 201);
  assert.equal(resetTime("You've hit your limit · resets 3pm", now).getHours(), 15);
  assert.equal(resetTime('resets at 12am', now).getHours(), 0);
  assert.equal(resetTime('usage limit, resets at 09:30', now).getDate(), 22, 'a time already past means tomorrow');
  assert.equal(mins(resetTime('usage limit, resets 9', now)), 30, 'a bare hour is not a time');
  assert.equal(mins(resetTime('429 Too Many Requests', now)), 30, 'default rest');
  assert.equal(mins(resetTime('429 Too Many Requests', now, 5)), 5);
});

test('RATE_LIMIT: the word quota alone is not a usage limit', () => {
  const echoed = "ERROR codex_core::tools::router: error=exec_command failed: ... $state.Content.Contains('quota') ...";
  assert.equal(RATE_LIMIT.test(echoed), false);
  for (const real of ['quota exceeded', 'You have exceeded your quota', 'RESOURCE_EXHAUSTED', '429 Too Many Requests']) assert.equal(RATE_LIMIT.test(real), true, real);
});

test('limitHit reads error events, not what the model writes', () => {
  assert.equal(limitHit(null, 'Error: quota exceeded', null, 'err'), true);
  assert.equal(limitHit(null, 'Error: quota exceeded', null, 'out'), false, 'plain stdout never counts');
  assert.equal(limitHit({}, 'rate limit', { type: 'error' }, 'out'), true);
  assert.equal(limitHit({}, 'rate limit', { type: 'assistant' }, 'out'), false);
  assert.equal(limitHit({}, 'rate limit', { status: 'FAILED' }, 'out'), true);
  assert.equal(limitHit({}, 'all fine', { type: 'error' }, 'out'), false);
  assert.equal(limitHit({}, 'quota exceeded ' + 'x'.repeat(400), null, 'err'), false, 'long plain lines are echoes');
  assert.equal(limitHit({}, 'exec_command: quota exceeded', null, 'err'), false);
  assert.equal(limitHit({}, 'CreateProcess quota exceeded', null, 'err'), false);
  const seen = [];
  const ad = { limitHit: (...a) => (seen.push(a), true) };
  assert.equal(limitHit(ad, 'anything', { x: 1 }, 'out'), true);
  assert.deepEqual(seen, [['anything', { x: 1 }, 'out']]);
  assert.equal(limitHit(ad, 'exec_command anything', null, 'err'), false, 'the echo guard runs before the adapter');
});

test('RESUME_FAILED matches each CLI', () => {
  for (const l of ['No conversation found with session ID: abc', 'thread/resume failed: no rollout found for thread id x', 'warning: conversation "abc-1" not found', 'session not found', 'failed to resume']) assert.ok(RESUME_FAILED.test(l), l);
  assert.equal(RESUME_FAILED.test('resumed fine'), false);
});

test('sessionIdOk accepts plain ids only', () => {
  assert.equal(sessionIdOk('abc_DEF-123'), 'abc_DEF-123');
  for (const bad of ['../x', '--flag', '-x', 'a b', 'a'.repeat(129), '', 42, null, undefined]) assert.equal(sessionIdOk(bad), null, String(bad));
  assert.equal(sessionIdOk('a'.repeat(128)), 'a'.repeat(128));
});

test('sanitizeOutput strips ANSI, OSC, \\r redraws and control characters', () => {
  assert.equal(sanitizeOutput('\x1b]0;title\x07\x1b[31mred\x1b[0m'), 'red');
  assert.equal(sanitizeOutput('\x1b]8;;http://x\x1b\\link'), 'link');
  assert.equal(sanitizeOutput('10%\r50%\r100%\nok\r\n'), '100%\nok\n');
  assert.equal(sanitizeOutput('a\x00b\x07c\td'), 'abc\td', 'tabs and newlines stay');
  assert.equal(sanitizeOutput(null), '');
});

test('tailOutput caps lines and bytes without a broken leading character', () => {
  const many = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n') + '\n\n';
  const t = tailOutput(many);
  assert.equal(t.split('\n').length, 60);
  assert.ok(t.startsWith('line 40') && t.endsWith('line 99'));
  const wide = '€'.repeat(2000); // 6000 bytes
  const w = tailOutput(wide);
  assert.ok(Buffer.byteLength(w) <= 4096);
  assert.ok(!w.startsWith('�'));
  assert.equal(w, '€'.repeat(1365));
  assert.equal(tailOutput('a\nb\nc', { maxLines: 2 }), 'b\nc');
  assert.equal(tailOutput('abcdef', { maxBytes: 3 }), 'def');
});

test('killTree ignores a missing or finished child', () => {
  killTree(null);
  killTree(undefined);
  killTree({ pid: undefined, exitCode: 0 });
  killTree({ pid: undefined }, { sync: true });
});

// A child that starts a long-lived grandchild, prints its pid, then reports a usage limit and hangs.
// On SIGTERM (non-Windows killTree) it takes the grandchild with it, as a CLI wrapper would.
const PARENT = `
const { spawn } = require('node:child_process');
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.on('SIGTERM', () => { try { process.kill(gc.pid); } catch {} process.exit(1); });
console.log(JSON.stringify({ type: 'init', session: 'sess-1', grandchild: gc.pid }));
setTimeout(() => console.error('Error: usage limit reached, try again in 2 minutes'), 100);
setInterval(() => {}, 1000);
`;

test('spawnLineProcess stops the whole tree on a usage limit and reports it', async (t) => {
  let grandchild = null;
  let pid = null;
  t.after(() => {
    reap(grandchild);
    reap(pid);
  });
  const raw = [];
  const parsed = [];
  const limits = [];
  const sessions = [];
  const t0 = Date.now();
  const outcome = await new Promise((resolve) => {
    const run = spawnLineProcess({
      command: process.execPath,
      args: ['-e', PARENT],
      adapter: {
        parser: () => ({ feed: (o) => [`event ${o.type}`], flush: () => ['flushed'], final: () => 'the end' }),
        sessionId: (o) => o.session,
      },
      onRawLine: (line, stream, obj) => {
        raw.push([stream, !!obj]);
        if (obj?.grandchild) grandchild = obj.grandchild;
      },
      onParsedLine: (l, s) => parsed.push([l, s]),
      onSession: (id) => sessions.push(id),
      onLimit: (l) => limits.push(l),
      onClose: resolve,
    });
    pid = run.child.pid;
  });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(outcome.limit, 'Error: usage limit reached, try again in 2 minutes');
  assert.deepEqual(limits, [outcome.limit]);
  assert.equal(outcome.sessionId, 'sess-1');
  assert.deepEqual(sessions, ['sess-1']);
  assert.equal(outcome.badResume, false);
  assert.equal(outcome.finalText, 'the end');
  assert.deepEqual(raw, [['out', true], ['err', false]]);
  assert.deepEqual(parsed, [['event init', 'out'], [outcome.limit, 'err'], ['flushed', 'out']]);
  assert.ok(grandchild);
  assert.ok(await until(() => !alive(grandchild), 2000), 'grandchild is gone within 2s');
});

const RESUMING = `
console.log('No conversation found with session ID: old-1');
setTimeout(() => console.log(JSON.stringify({ session: 'new-2', spoke: true })), 50);
setInterval(() => {}, 1000);
`;

test('spawnLineProcess: a failed resume kills the run and ignores its late chatter', async (t) => {
  let pid = null;
  t.after(() => reap(pid));
  const failed = [];
  const spokeIn = [];
  const outcome = await new Promise((resolve) => {
    const run = spawnLineProcess({
      command: process.execPath,
      args: ['-e', RESUMING],
      resumeId: 'old-1',
      adapter: { sessionId: (o) => o.session, spoke: (o) => o.spoke },
      onResumeFailed: (l) => failed.push(l),
      onSpoke: (id) => spokeIn.push(id),
      onClose: resolve,
    });
    pid = run.child.pid;
  });
  assert.equal(outcome.resumeFailed, 'No conversation found with session ID: old-1');
  assert.deepEqual(failed, [outcome.resumeFailed]);
  assert.equal(outcome.badResume, true);
  assert.equal(outcome.spoke, false);
  assert.equal(outcome.sessionId, null);
  assert.deepEqual(spokeIn, []);
  assert.equal(outcome.limit, null);
});

test('spawnLineProcess: a run that spoke records its session and a clean exit is not a bad resume', async () => {
  const spokeIn = [];
  const outcome = await new Promise((resolve) => {
    spawnLineProcess({
      command: process.execPath,
      args: ['-e', `console.log(JSON.stringify({ session: 's-9' })); console.log(JSON.stringify({ spoke: true })); console.log('quota exceeded');`],
      resumeId: 's-9',
      adapter: { sessionId: (o) => o.session, spoke: (o) => o.spoke },
      onSpoke: (id) => spokeIn.push(id),
      onClose: resolve,
    });
  });
  assert.deepEqual(spokeIn, ['s-9']);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.spoke, true);
  assert.equal(outcome.limit, null, 'plain stdout mentioning quota is not a limit');
  assert.equal(outcome.badResume, false);
  assert.equal(outcome.finalText, '');
});

test('spawnLineProcess reports a command that cannot start', async () => {
  const parsed = [];
  const outcome = await new Promise((resolve) => {
    spawnLineProcess({
      command: 'fried-proc-no-such-command-xyz',
      resumeId: 'r-1',
      onParsedLine: (l, s) => parsed.push([l, s]),
      onClose: resolve,
    });
  });
  assert.match(outcome.startError, /ENOENT/);
  assert.equal(outcome.badResume, true);
  assert.equal(parsed[0][1], 'err');
  assert.match(parsed[0][0], /^! failed to start: /);
});
