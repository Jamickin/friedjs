import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sync } from '../tooling/fried-sync.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'fried-sync-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'fried'); const consumer = path.join(base, 'consumer');
  await mkdir(path.join(root, 'addons'), { recursive: true }); await mkdir(consumer);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(path.join(root, 'fried.js'), 'export const v = 1;');
  await writeFile(path.join(root, 'addons', 'fried-db.js'), 'export const db = true;');
  await writeFile(path.join(consumer, 'fried.json'), JSON.stringify({ dest: 'ui', files: ['fried.js', 'addons/fried-db.js'], test: 'npm test' }));
  const logs = [];
  const deps = { friedRoot: root, now: () => '2026-01-02T03:04:05.000Z', runTest: async () => ({ code: 0 }) };
  return { root, consumer, deps, logs, call: (opts = {}, moreDeps = {}) => sync(consumer, { log: x => logs.push(x), ...opts }, { ...deps, ...moreDeps }) };
}

test('fresh sync copies nested files and records hashes', async t => {
  const f = await fixture(t); const result = await f.call();
  assert.equal(result.code, 0);
  assert.equal(await readFile(path.join(f.consumer, 'ui', 'fried.js'), 'utf8'), 'export const v = 1;');
  const lock = JSON.parse(await readFile(path.join(f.consumer, 'fried.lock.json'), 'utf8'));
  assert.equal(lock.version, '1.2.3'); assert.equal(lock.files['fried.js'].length, 64);
});

test('second sync reports already in sync and still tests', async t => {
  const f = await fixture(t); await f.call(); let ran = 0;
  const result = await f.call({}, { runTest: async () => { ran++; return { code: 0 }; } });
  assert.equal(result.alreadyInSync, true); assert.equal(ran, 1); assert.ok(f.logs.includes('already in sync'));
});

test('changed source updates destination and lock', async t => {
  const f = await fixture(t); await f.call(); await writeFile(path.join(f.root, 'fried.js'), 'export const v = 2;');
  await f.call(); assert.equal(await readFile(path.join(f.consumer, 'ui', 'fried.js'), 'utf8'), 'export const v = 2;');
});

test('failing test rolls back destination and lock byte-for-byte', async t => {
  const f = await fixture(t); await f.call();
  const before = await readFile(path.join(f.consumer, 'ui', 'fried.js')); const lockBefore = await readFile(path.join(f.consumer, 'fried.lock.json'));
  await writeFile(path.join(f.root, 'fried.js'), 'new');
  const result = await f.call({}, { runTest: async () => ({ code: 7 }) });
  assert.equal(result.rolledBack, true); assert.deepEqual(await readFile(path.join(f.consumer, 'ui', 'fried.js')), before);
  assert.deepEqual(await readFile(path.join(f.consumer, 'fried.lock.json')), lockBefore);
});

test('a copy that dies half way restores every file and the lock', async t => {
  const f = await fixture(t); await f.call();
  const ui = p => path.join(f.consumer, 'ui', p);
  const before = [await readFile(ui('fried.js')), await readFile(ui('addons/fried-db.js')), await readFile(path.join(f.consumer, 'fried.lock.json'))];
  await writeFile(path.join(f.root, 'fried.js'), 'new one'); await writeFile(path.join(f.root, 'addons', 'fried-db.js'), 'new two');
  let writes = 0;
  const flaky = (target, bytes) => { if (++writes === 2) throw new Error('disk full'); return writeFile(target, bytes); };
  const result = await f.call({}, { writeFile: flaky });
  assert.equal(result.code, 1); assert.match(result.error, /nothing changed.*disk full/);
  assert.deepEqual([await readFile(ui('fried.js')), await readFile(ui('addons/fried-db.js')), await readFile(path.join(f.consumer, 'fried.lock.json'))], before);
});

test('a failed first-ever copy leaves no files and no lock behind', async t => {
  const f = await fixture(t); let writes = 0;
  const result = await f.call({}, { writeFile: (target, bytes) => { if (++writes === 2) throw new Error('disk full'); return writeFile(target, bytes); } });
  assert.equal(result.code, 1);
  await assert.rejects(readFile(path.join(f.consumer, 'ui', 'fried.js'))); await assert.rejects(readFile(path.join(f.consumer, 'fried.lock.json')));
});

test('--force keeps failed update and exits nonzero', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'fried.js'), 'new');
  const result = await f.call({ force: true }, { runTest: async () => ({ code: 5 }) });
  assert.equal(result.code, 5); assert.equal(await readFile(path.join(f.consumer, 'ui', 'fried.js'), 'utf8'), 'new');
});

test('--dry-run writes nothing', async t => {
  const f = await fixture(t); const result = await f.call({ dryRun: true });
  assert.equal(result.dryRun, true); await assert.rejects(readFile(path.join(f.consumer, 'fried.lock.json')));
  await assert.rejects(readFile(path.join(f.consumer, 'ui', 'fried.js')));
});

test('path escapes and missing source are refused', async t => {
  const f = await fixture(t); await writeFile(path.join(f.consumer, 'fried.json'), JSON.stringify({ dest: 'ui', files: ['../package.json'] }));
  assert.equal((await f.call()).code, 1);
  await writeFile(path.join(f.consumer, 'fried.json'), JSON.stringify({ dest: 'ui', files: ['absent.js'] }));
  assert.equal((await f.call()).code, 1);
});

test('consumer without fried.json gets a clear error', async t => {
  const f = await fixture(t); await rm(path.join(f.consumer, 'fried.json'));
  const result = await f.call(); assert.match(result.error, /missing.*fried\.json/);
});

test('dest with nested directories is created', async t => {
  const f = await fixture(t); await writeFile(path.join(f.consumer, 'fried.json'), JSON.stringify({ dest: 'vendor/deep', files: ['fried.js'] }));
  await f.call(); assert.equal(await readFile(path.join(f.consumer, 'vendor', 'deep', 'fried.js'), 'utf8'), 'export const v = 1;');
});

async function withServerAddons(f, spec) {
  await mkdir(path.join(f.root, 'addons', 'server'), { recursive: true });
  await writeFile(path.join(f.root, 'addons', 'server', 'fried-score.js'), 'export const score = 1;');
  await writeFile(path.join(f.root, 'addons', 'server', 'fried-proc.js'), 'export const proc = 1;');
  await writeFile(path.join(f.consumer, 'fried.json'), JSON.stringify(spec));
}
const serverTarget = { dest: 'composer/vendor', flat: true, files: ['addons/server/fried-score.js', 'addons/server/fried-proc.js'] };

test('targets: a flat target drops source folders, next to the top-level dest', async t => {
  const f = await fixture(t);
  await withServerAddons(f, { dest: 'ui', files: ['fried.js'], targets: [serverTarget], test: 'npm test' });
  const result = await f.call(); assert.equal(result.code, 0);
  assert.equal(await readFile(path.join(f.consumer, 'ui', 'fried.js'), 'utf8'), 'export const v = 1;');
  assert.equal(await readFile(path.join(f.consumer, 'composer', 'vendor', 'fried-score.js'), 'utf8'), 'export const score = 1;');
  assert.equal(await readFile(path.join(f.consumer, 'composer', 'vendor', 'fried-proc.js'), 'utf8'), 'export const proc = 1;');
  await assert.rejects(readFile(path.join(f.consumer, 'composer', 'vendor', 'addons', 'server', 'fried-score.js')));
  const lock = JSON.parse(await readFile(path.join(f.consumer, 'fried.lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.files), ['fried.js', 'addons/server/fried-score.js', 'addons/server/fried-proc.js']);
  assert.equal((await f.call()).alreadyInSync, true);
});

test('targets: without flat the source path is kept; targets alone need no top-level files', async t => {
  const f = await fixture(t);
  await withServerAddons(f, { targets: [{ dest: 'lib', files: ['addons/server/fried-score.js'] }] });
  assert.equal((await f.call()).code, 0);
  assert.equal(await readFile(path.join(f.consumer, 'lib', 'addons', 'server', 'fried-score.js'), 'utf8'), 'export const score = 1;');
});

test('targets: one source may go to two targets, and a missing copy there breaks "in sync"', async t => {
  const f = await fixture(t);
  await withServerAddons(f, { dest: 'ui', files: ['fried.js'], targets: [{ dest: 'other', flat: true, files: ['fried.js'] }] });
  assert.equal((await f.call()).code, 0);
  await rm(path.join(f.consumer, 'other', 'fried.js'));
  const again = await f.call(); assert.equal(again.code, 0); assert.notEqual(again.alreadyInSync, true);
  assert.equal(await readFile(path.join(f.consumer, 'other', 'fried.js'), 'utf8'), 'export const v = 1;');
});

test('targets: a failing test rolls back every target and the lock', async t => {
  const f = await fixture(t);
  await withServerAddons(f, { dest: 'ui', files: ['fried.js'], targets: [serverTarget], test: 'npm test' });
  await f.call();
  const files = [path.join(f.consumer, 'ui', 'fried.js'), path.join(f.consumer, 'composer', 'vendor', 'fried-score.js'), path.join(f.consumer, 'fried.lock.json')];
  const before = await Promise.all(files.map(p => readFile(p)));
  await writeFile(path.join(f.root, 'fried.js'), 'new'); await writeFile(path.join(f.root, 'addons', 'server', 'fried-score.js'), 'new score');
  const result = await f.call({}, { runTest: async () => ({ code: 3 }) });
  assert.equal(result.rolledBack, true);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p))), before);
});

test('targets: a copy that dies in the second target restores the first', async t => {
  const f = await fixture(t);
  await withServerAddons(f, { dest: 'ui', files: ['fried.js'], targets: [serverTarget] });
  let writes = 0;
  const result = await f.call({}, { writeFile: (target, bytes) => { if (++writes === 3) throw new Error('disk full'); return writeFile(target, bytes); } });
  assert.equal(result.code, 1);
  await assert.rejects(readFile(path.join(f.consumer, 'ui', 'fried.js')));
  await assert.rejects(readFile(path.join(f.consumer, 'composer', 'vendor', 'fried-score.js')));
  await assert.rejects(readFile(path.join(f.consumer, 'fried.lock.json')));
});

test('targets: bad shapes, escapes and flat name clashes are refused', async t => {
  const f = await fixture(t);
  const refuse = async (spec, re) => { await withServerAddons(f, spec); const r = await f.call(); assert.equal(r.code, 1); assert.match(r.error, re); };
  await refuse({ dest: 'ui', files: ['fried.js'], targets: [] }, /targets must be a non-empty array/);
  await refuse({ targets: [{ dest: 'x', files: [] }] }, /targets\[0\]\.files must be a non-empty array/);
  await refuse({ targets: [{ dest: '../out', files: ['fried.js'] }] }, /escapes the consumer/);
  await refuse({ targets: [{ dest: 'x', flat: 'yes', files: ['fried.js'] }] }, /targets\[0\]\.flat must be true or false/);
  await mkdir(path.join(f.root, 'other'), { recursive: true }); await writeFile(path.join(f.root, 'other', 'fried.js'), 'x');
  await refuse({ targets: [{ dest: 'x', flat: true, files: ['fried.js', 'other/fried.js'] }] }, /other\/fried\.js and fried\.js would both be written to x\/fried\.js/);
  await refuse({}, /non-empty files array/);
});

test('targets: --dry-run names the target of a non-primary file and writes nothing', async t => {
  const f = await fixture(t);
  await withServerAddons(f, { dest: 'ui', files: ['fried.js'], targets: [serverTarget] });
  const result = await f.call({ dryRun: true }); assert.equal(result.dryRun, true);
  assert.ok(f.logs.some(l => l.startsWith('fried.js: missing -> ')));
  assert.ok(f.logs.some(l => l.startsWith('addons/server/fried-score.js (composer/vendor/fried-score.js): missing -> ')));
  await assert.rejects(readFile(path.join(f.consumer, 'composer', 'vendor', 'fried-score.js')));
});
