import test from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer, createSseHandler } from '../addons/server/fried-serve.js';

async function app(options = {}) {
  const instance = createAppServer({ port: 0, ...options });
  const { port, url } = await instance.listen();
  return { instance, port, url, close: () => instance.close() };
}

test('host guard runs before routes and auth', async () => {
  const a = await app({ routes: { '/api/x': { handler: () => ({ ok: true }) } } });
  try {
    const r = await new Promise((resolve, reject) => { const req = httpRequest(a.url + '/api/x', { headers: { host: 'foreign.test' } }, resolve); req.on('error', reject); req.end(); });
    let raw = ''; for await (const chunk of r) raw += chunk;
    assert.equal(r.statusCode, 403);
    assert.deepEqual(JSON.parse(raw), { error: 'bad host' });
  } finally { await a.close(); }
});

test('bearer and query auth, public routes, and role restriction', async () => {
  const a = await app({ auth: (token) => token === 'good' ? { role: 'master' } : token === 'music' ? { role: 'musician' } : null,
    routes: { '/api/open': { auth: false, handler: () => ({ ok: 1 }) }, '/api/secure': { role: 'master', handler: () => ({ ok: 2 }) } } });
  try {
    assert.equal((await fetch(a.url + '/api/open')).status, 200);
    assert.equal((await fetch(a.url + '/api/secure')).status, 401);
    const music = await fetch(a.url + '/api/secure?token=music');
    assert.equal(music.status, 403); assert.deepEqual(await music.json(), { error: 'master only' });
    const master = await fetch(a.url + '/api/secure', { headers: { authorization: 'Bearer good' } });
    assert.equal(master.status, 200); assert.deepEqual(await master.json(), { ok: 2 });
  } finally { await a.close(); }
});

test('JSON body parses empty and valid input and bounds size', async () => {
  const a = await app({ maxBodyBytes: 8, auth: () => ({ role: 'user' }), routes: { '/api/echo': { handler: async ({ body }) => await body() } } });
  try {
    assert.deepEqual(await (await fetch(a.url + '/api/echo', { method: 'POST', body: '' })).json(), {});
    assert.deepEqual(await (await fetch(a.url + '/api/echo', { method: 'POST', body: '{"a":1}' })).json(), { a: 1 });
    const tooBig = await fetch(a.url + '/api/echo', { method: 'POST', body: '{"long":1}' });
    assert.equal(tooBig.status, 400); assert.deepEqual(await tooBig.json(), { error: 'body too large' });
  } finally { await a.close(); }
});

test('static dirs support GET/HEAD and reject traversal and symlink escapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fried-serve-'));
  const outside = join(tmpdir(), `fried-out-${process.pid}.txt`);
  mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'ok.txt'), 'hello'); writeFileSync(outside, 'secret');
  try { symlinkSync(outside, join(dir, 'leak.txt')); } catch {}
  const a = await app({ staticDirs: [{ prefix: '/ui/', dir, types: { '.txt': 'text/plain' }, cacheControl: 'no-cache' }] });
  try {
    const get = await fetch(a.url + '/ui/sub/ok.txt'); assert.equal(get.status, 200); assert.equal(await get.text(), 'hello'); assert.equal(get.headers.get('cache-control'), 'no-cache');
    const head = await fetch(a.url + '/ui/sub/ok.txt', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    for (const p of ['/ui/../secret.txt', '/ui/%2e%2e/secret.txt', '/ui/%5csecret.txt', '/ui/C:%5csecret.txt', '/ui/%00.txt', '/ui/sub/ok.js']) assert.equal((await fetch(a.url + p)).status, 404, p);
    if (existsLink(join(dir, 'leak.txt'))) assert.equal((await fetch(a.url + '/ui/leak.txt')).status, 404);
    assert.equal((await fetch(a.url + '/ui/sub/ok.txt', { method: 'POST' })).status, 404);
  } finally { await a.close(); rmSync(dir, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});

function existsLink(path) { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }

test('SSE replays, streams, pings, and unsubscribes on disconnect', async () => {
  let listener, unsubscribed = false;
  const handler = createSseHandler({ since: (seq) => seq === 2 ? [{ seq: 3, text: 'replay' }] : [], subscribe: (fn) => { listener = fn; return () => { unsubscribed = true; }; }, pingMs: 15 });
  const a = await app({ auth: () => ({ role: 'master' }), routes: { '/api/events': handler } });
  try {
    const controller = new AbortController();
    const response = await fetch(a.url + '/api/events?since=2', { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let data = '';
    for (let i = 0; i < 3 && !data.includes(': ping'); i++) { const chunk = await reader.read(); data += new TextDecoder().decode(chunk.value); }
    assert.match(data, /replay/); assert.match(data, /: ping/);
    listener({ seq: 4, text: 'live' });
    const live = await reader.read(); assert.match(new TextDecoder().decode(live.value), /live/);
    controller.abort(); await new Promise((r) => setTimeout(r, 20)); assert.equal(unsubscribed, true);
  } finally { await a.close(); }
});



