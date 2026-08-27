#!/usr/bin/env node
/**
 * worker/test/run.js — the whole suite against a local worker.
 *
 *   npm test                  start everything, run every suite, tear down
 *   npm test -- auth signout  run only the named suites
 *
 * Starts `wrangler dev` and a static file server, waits for both, runs each
 * suite in turn, then stops what it started. Passwords come from .dev.vars via
 * wrangler, so the defaults here must match that file.
 */
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const HERE = __dirname;
const WORKER_DIR = path.resolve(HERE, '..');

// Node suites, then the two that drive a real DOM.
const NODE_SUITES = ['auth', 'signout', 'adminbots', 'startover', 'drafttest', 'reconnect', 'practice', 'newbits'];
const DOM_SUITES = ['uitest', 'downloadperm'];

const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'));
const suites = wanted.length
  ? wanted
  : NODE_SUITES.concat(hasJsdom() ? DOM_SUITES : []);

function hasJsdom() {
  try { require.resolve('jsdom', { paths: [WORKER_DIR] }); return true; }
  catch { return false; }
}

function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  return (async () => {
    while (Date.now() < end) {
      try { if (await fn()) return true; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${what}`);
  })();
}

(async () => {
  if (!fs.existsSync(path.join(WORKER_DIR, '.dev.vars'))) {
    console.error('worker/.dev.vars is missing — the suites need DRAFT_PASSWORD and ADMIN_PASSWORD.');
    process.exit(1);
  }

  const workerPort = await freePort();
  const sitePort = await freePort();
  const env = {
    ...process.env,
    ISC_HOST: `127.0.0.1:${workerPort}`,
    SITE_PORT: String(sitePort),
  };

  console.log(`worker on :${workerPort}   site on :${sitePort}\n`);

  const started = [];
  const stopAll = () => started.forEach(p => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} });
  process.on('exit', stopAll);
  process.on('SIGINT', () => { stopAll(); process.exit(130); });

  const wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(workerPort), '--local'],
    { cwd: WORKER_DIR, stdio: 'ignore', detached: true });
  started.push(wrangler);

  const site = spawn('node', [path.join(HERE, 'serve.js')],
    { cwd: WORKER_DIR, stdio: 'ignore', detached: true, env });
  started.push(site);

  // A gated room answering 401 means the worker is up and configured.
  await waitFor(async () => (await fetch(`http://127.0.0.1:${workerPort}/room/ping`)).status === 401,
    60000, 'wrangler dev');
  await waitFor(async () => (await fetch(`http://localhost:${sitePort}/draft.html`)).ok,
    20000, 'the static server');

  let failed = [];
  for (const name of suites) {
    const file = path.join(HERE, `${name}.js`);
    if (!fs.existsSync(file)) { console.log(`${name.padEnd(14)} SKIP (no such suite)`); continue; }
    const r = spawnSync('node', [file], { env, encoding: 'utf8' });
    const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '(no output)';
    const ok = r.status === 0;
    if (!ok) failed.push(name);
    console.log(`${name.padEnd(14)} ${ok ? 'PASS' : 'FAIL'}  ${last}`);
    if (!ok && process.env.VERBOSE) console.log((r.stdout || '') + (r.stderr || ''));
  }

  console.log('');
  console.log(failed.length ? `FAILED: ${failed.join(', ')}  (VERBOSE=1 for detail)` : 'ALL SUITES PASSED');
  stopAll();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('runner error:', e.message); process.exit(1); });
