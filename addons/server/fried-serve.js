import { createServer, ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const json = (res, code, data, type = 'application/json', headers = {}) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
};

export async function readJsonBody(req, maxBytes = 2_000_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

export function createAppServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 7777;
  const base = `http://${host}:${port}`;
  const allowed = new Set(options.allowedHosts || (port === 0 ? [] : [`127.0.0.1:${port}`, `localhost:${port}`]));
  const routes = options.routes || {};
  const staticFiles = options.staticFiles || {};
  const parseBody = (req) => readJsonBody(req, options.maxBodyBytes ?? 2_000_000);
  const send = (res, code, data, type, headers) => json(res, code, data, type, headers);
  const server = createServer(async (req, res) => {
    if (!(allowed.has(req.headers.host || '') || (port === 0 && /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')))) return send(res, 403, { error: 'bad host' });
    let url;
    try { url = new URL(req.url, base); } catch { return send(res, 400, { error: 'Invalid URL' }); }
    const path = url.pathname;
    try {
      const tokenHeader = req.headers.authorization || '';
      const token = tokenHeader.startsWith('Bearer ') ? tokenHeader.slice(7) : url.searchParams.get('token');
      const who = options.auth ? await options.auth(token, req, url) : null;
      for (const item of Object.values(options.staticDirs || {})) {
        const serve = serveStaticDir(item);
        if ((req.url || '').split('?')[0].startsWith(item.prefix) || path.startsWith(item.prefix)) {
          if (serve(req, res, path)) return;
        }
      }
      const file = staticFiles[path];
      if (req.method === 'GET' && file) {
        let content = readFileSync(file.file, 'utf8');
        if (file.transform) content = file.transform(content);
        return send(res, 200, content, file.type);
      }
      // options.notFound is a route spec used when nothing matched, e.g. { auth: true, handler } to 401 unknown paths.
      const route = routes[`${req.method} ${path}`] ?? routes[path] ?? options.notFound;
      if (!route) return send(res, 404, { error: 'not found' });
      const spec = typeof route === 'function' ? { handler: route } : route;
      const requiresAuth = spec.auth ?? path.startsWith('/api/');
      if (requiresAuth && !who) return send(res, 401, { error: spec.unauthError || options.unauthError || 'unauthorized' });
      if (spec.role && !(Array.isArray(spec.role) ? spec.role : [spec.role]).includes(who?.role)) return send(res, 403, { error: 'master only' });
      // ctx.send is bound to this response: send(code, data, type?, headers?); the older send(res, code, data, ...) still works.
      const boundSend = (first, ...rest) => first instanceof ServerResponse ? send(first, ...rest) : send(res, first, ...rest);
      const result = await spec.handler({ req, res, url, path, query: url.searchParams, who, body: () => parseBody(req), send: boundSend });
      if (result !== undefined && !res.writableEnded) send(res, 200, result);
    } catch (error) {
      if (!res.headersSent) send(res, 400, { error: error.message });
      else res.destroy(error);
    }
  });
  return {
    server,
    listen: () => new Promise((resolveListen, reject) => {
      const onError = (e) => { server.off('listening', onListen); reject(e); };
      const onListen = () => { server.off('error', onError); const actual = server.address().port; resolveListen({ port: actual, url: `http://${host}:${actual}` }); };
      server.once('error', onError); server.once('listening', onListen); server.listen(port, host);
    }),
    close: () => new Promise((resolveClose, reject) => server.close((e) => e ? reject(e) : resolveClose())),
    send,
    readJsonBody,
  };
}

export function serveStaticDir(options) {
  const { prefix, dir, types = {}, cacheControl = 'no-cache' } = options;
  return (req, res, pathname) => {
    const notFound = () => { json(res, 404, { error: 'not found' }); return true; };
    const raw = (req.url || '').split('?')[0];
    // A raw URL under the prefix whose dot segments normalise out of it (/ui/../x) is an escape, not a route.
    if (!pathname.startsWith(prefix)) return raw.startsWith(prefix) ? notFound() : false;
    if (!['GET', 'HEAD'].includes(req.method)) return notFound();
    if (/%2e|%2f|%5c/i.test(raw.slice(prefix.length))) return notFound();
    let rel;
    try { rel = decodeURIComponent(pathname.slice(prefix.length)); } catch { return notFound(); }
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('\0') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return notFound();
    try {
      const root = realpathSync(dir);
      const target = resolve(root, rel);
      const fromRoot = relative(root, target);
      if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) return notFound();
      const real = realpathSync(target);
      const actual = relative(root, real);
      if (!actual || actual === '..' || actual.startsWith('..' + sep) || isAbsolute(actual) || !statSync(real).isFile()) return notFound();
      const type = types[extname(real).toLowerCase()];
      if (!type) return notFound();
      res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(real));
    } catch { return notFound(); }
    return true;
  };
}

export function createSseHandler({ since, subscribe, pingMs = 20_000 }) {
  return ({ req, res, query }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const from = Number(query.get('since') || 0);
    for (const event of since(from)) res.write(`data: ${JSON.stringify(event)}\n\n`);
    const off = subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
    req.on('close', () => { off(); clearInterval(ping); });
  };
}




