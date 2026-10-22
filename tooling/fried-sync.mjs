import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const safeRelative = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value);

function runCommand(command, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, timedOut: true }); }, 600_000);
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1 }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1 }); });
  });
}

export async function sync(consumerDir, options = {}, deps = {}) {
  const root = path.resolve(deps.friedRoot ?? defaultRoot);
  const consumer = path.resolve(consumerDir);
  const say = options.log ?? (line => console.log(line));
  const fail = message => { say(`Error: ${message}`); return { code: 1, error: message }; };
  let spec;
  try { spec = JSON.parse(await fs.readFile(path.join(consumer, 'fried.json'), 'utf8')); }
  catch (e) { return fail(e.code === 'ENOENT' ? `missing ${path.join(consumer, 'fried.json')}` : `invalid fried.json: ${e.message}`); }
  if (!spec || typeof spec !== 'object') return fail('fried.json must contain a non-empty files array');
  // Optional targets: [{ dest, files, flat? }] go to more folders; the top-level dest + files stay the first target.
  // flat: true drops the source folders (addons/server/fried-score.js -> <dest>/fried-score.js).
  if (spec.targets !== undefined && (!Array.isArray(spec.targets) || !spec.targets.length)) return fail('targets must be a non-empty array');
  const targets = [];
  if (spec.files !== undefined || !spec.targets) targets.push({ dest: spec.dest ?? '.', files: spec.files, flat: spec.flat ?? false, label: 'files' });
  (spec.targets ?? []).forEach((t, i) => targets.push({ ...(t && typeof t === 'object' ? t : {}), dest: t?.dest ?? '.', flat: t?.flat ?? false, label: `targets[${i}].files` }));
  const files = [];
  const seen = new Map();
  for (const t of targets) {
    if (!Array.isArray(t.files) || !t.files.length) return fail(t.label === 'files' ? 'fried.json must contain a non-empty files array' : `${t.label} must be a non-empty array`);
    if (typeof t.flat !== 'boolean') return fail(`${t.label.replace(/files$/, 'flat')} must be true or false`);
    if (typeof t.dest !== 'string' || path.isAbsolute(t.dest) || /^[A-Za-z]:/.test(t.dest)) return fail('dest must be a relative path inside the consumer');
    const dest = path.resolve(consumer, t.dest);
    if (!inside(consumer, dest)) return fail('dest escapes the consumer directory');
    for (const rel of t.files) {
      if (!safeRelative(rel)) return fail(`invalid or absolute source path: ${rel}`);
      const src = path.resolve(root, rel);
      if (!inside(root, src)) return fail(`source path escapes FriedJS: ${rel}`);
      const target = path.resolve(dest, t.flat ? path.basename(rel) : rel);
      if (seen.has(target)) return fail(`${rel} and ${seen.get(target)} would both be written to ${path.relative(consumer, target).split(path.sep).join('/')}`);
      seen.set(target, rel);
      try {
        const bytes = await fs.readFile(src);
        files.push({ rel, src, bytes, digest: hash(bytes), target, primary: t.label === 'files' });
      } catch (e) { return fail(`source file ${rel} is unavailable: ${e.message}`); }
    }
  }
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); }
  catch (e) { return fail(`cannot read FriedJS package.json: ${e.message}`); }
  const commit = await new Promise(resolve => execFile('git', ['rev-parse','HEAD'], {cwd:root}, (e, out) => resolve(e ? null : out.trim())));
  const lockPath = path.join(consumer, 'fried.lock.json');
  let previousLock = null;
  try { previousLock = await fs.readFile(lockPath); } catch (e) { if (e.code !== 'ENOENT') return fail(`cannot read lock: ${e.message}`); }
  let oldLock;
  try { oldLock = previousLock ? JSON.parse(previousLock) : null; } catch { oldLock = null; }
  const matches = oldLock?.version === pkg.version && files.every(f => oldLock.files?.[f.rel] === f.digest);
  let identical = true;
  for (const f of files) { try { if (!(await fs.readFile(f.target)).equals(f.bytes)) identical = false; } catch { identical = false; } }
  if (matches && identical) {
    say('already in sync');
    if (!options.noTest && spec.test) { const result = await (deps.runTest ?? runCommand)(spec.test, consumer); if (result.code !== 0) return { code: result.code, testFailed: true }; }
    return { code: 0, alreadyInSync: true };
  }
  if (options.dryRun) {
    for (const f of files) {
      let old = 'missing'; try { old = hash(await fs.readFile(f.target)); } catch {}
      say(`${f.primary ? f.rel : `${f.rel} (${path.relative(consumer, f.target).split(path.sep).join('/')})`}: ${old} -> ${f.digest}`);
    }
    return { code: 0, dryRun: true };
  }
  const backups = new Map();
  for (const f of files) { try { backups.set(f.target, await fs.readFile(f.target)); } catch (e) { if (e.code !== 'ENOENT') return fail(e.message); backups.set(f.target, null); } }
  // Puts every file and the lock back exactly as they were; used after a failed copy and after failing tests.
  const restore = async () => {
    for (const [target, bytes] of backups) { if (bytes === null) await fs.rm(target, { force: true }); else await fs.writeFile(target, bytes); }
    if (previousLock === null) await fs.rm(lockPath, { force: true }); else await fs.writeFile(lockPath, previousLock);
  };
  try {
    for (const f of files) { await fs.mkdir(path.dirname(f.target), { recursive: true }); await (deps.writeFile ?? fs.writeFile)(f.target, f.bytes); }
    await fs.writeFile(lockPath, JSON.stringify({ version: pkg.version, commit, syncedAt: (deps.now ?? (() => new Date().toISOString()))(), files: Object.fromEntries(files.map(f => [f.rel, f.digest])) }, null, 2) + '\n');
  } catch (e) {
    // A copy that dies half way must not leave some files new and some old.
    try { await restore(); } catch (r) { return fail(`copy failed (${e.message}) and restoring also failed: ${r.message}`); }
    return fail(`copy failed, nothing changed: ${e.message}`);
  }
  if (!options.noTest && spec.test) {
    const result = await (deps.runTest ?? runCommand)(spec.test, consumer);
    if (result.code !== 0) {
      if (options.force) { say(`TEST FAILED (${result.code}); --force kept the new files`); return { code: result.code || 1, testFailed: true, kept: true }; }
      await restore();
      say(`ROLLED BACK (test exit code ${result.code})`);
      return { code: result.code || 1, testFailed: true, rolledBack: true };
    }
  }
  say('sync complete');
  return { code: 0 };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const dirs = args.filter(a => !a.startsWith('--'));
  if (dirs.length !== 1 || [...flags].some(f => !['--dry-run','--no-test','--force'].includes(f))) {
    console.error('Usage: node tooling/fried-sync.mjs <consumerDir> [--dry-run] [--no-test] [--force]'); process.exitCode = 2; return;
  }
  const result = await sync(dirs[0], { dryRun: flags.has('--dry-run'), noTest: flags.has('--no-test'), force: flags.has('--force') });
  process.exitCode = result.code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
