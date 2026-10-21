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
