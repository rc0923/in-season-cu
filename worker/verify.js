#!/usr/bin/env node
/**
 * worker/verify.js
 *
 * Health check for a deployed draft worker. Run it after deploying, after
 * rotating passwords, or any time before a real draft.
 *
 *   npm run verify                    check the deployed worker
 *   npm run verify -- --skip-passwords   only the checks that need no secrets
 *   ISC_HOST=127.0.0.1:8788 npm run verify   check a local `wrangler dev`
 *
 * The first section needs no secrets at all. The second prompts for the two
 * passwords with hidden input, so nothing is echoed and nothing lands in your
 * shell history; only PASS/FAIL lines are printed.
 *
 * Everything runs against a disposable room, so a real draft is never touched.
 */

const readline = require('readline');

const HOST = process.env.ISC_HOST ?? 'isc-draft.rc0923.workers.dev';
const LOCAL = HOST.startsWith('127.') || HOST.startsWith('localhost');
const [WS, HTTP] = LOCAL ? ['ws', 'http'] : ['wss', 'https'];
const SKIP_PW = process.argv.includes('--skip-passwords');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let shown = false;
    rl._writeToOutput = function (s) {
      if (!shown) { rl.output.write(question); shown = true; return; }
      if (s.includes(question)) return;
      if (s === '\r\n' || s === '\n') rl.output.write(s);
    };
    rl.question(question, ans => { rl.close(); process.stdout.write('\n'); resolve(ans); });
  });
}

function client(room) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${WS}://${HOST}/room/${room}/ws`);
    const c = { ws, id: null, state: null, role: null, msgs: [], errors: [], fails: [], closed: false };
    ws.addEventListener('message', ev => {
      if (typeof ev.data === 'string' && !ev.data.startsWith('{')) return;
      const m = JSON.parse(ev.data);
      c.msgs.push(m.type);
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'joined') c.id = m.playerId;
      if (m.type === 'authOk') c.role = m.role;
      if (m.type === 'authFail') c.fails.push(m.error);
      if (m.type === 'error') c.errors.push(m.error);
    });
    ws.addEventListener('close', () => { c.closed = true; });
    ws.addEventListener('open', () => resolve(c));
  });
}
const send = (c, m) => { try { c.ws.send(JSON.stringify(m)); } catch {} };
async function until(cond, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(60); }
  return false;
}

// ── checks needing no secrets ────────────────────────────────────────────────

async function withoutSecrets(room) {
  console.log('CONFIGURATION');
  const probe = await client(room);
  await until(() => probe.msgs.includes('authRequired'));
  check('room demands authentication', probe.msgs.includes('authRequired'));
  check('no board before authenticating', probe.state === null, `msgs=${[...new Set(probe.msgs)]}`);

  // With no secrets set the worker says draft_password_not_configured, so a
  // plain bad_password proves a real password was configured and compared.
  send(probe, { type: 'auth', password: 'not-the-password-' + Date.now() });
  await until(() => probe.fails.length > 0);
  const err = probe.fails[0];
  check('passwords are configured', err === 'bad_password',
        err === 'draft_password_not_configured' ? 'NO PASSWORDS SET — run wrangler secret put' : `error=${err}`);
  check('a wrong password grants nothing', probe.role === null && probe.state === null);

  console.log('\nUNAUTHENTICATED PEERS');
  const sneak = await client(room);
  await until(() => sneak.msgs.includes('authRequired'));
  for (const m of [{ type: 'join', name: 'Intruder' }, { type: 'start' },
                   { type: 'pick', playerId: 'x', team: 'BOS' }, { type: 'undoPick' }]) send(sneak, m);
  await sleep(1200);
  check('every action ignored', sneak.state === null && sneak.id === null);
  check('only authRequired returned', [...new Set(sneak.msgs)].join(',') === 'authRequired',
        `msgs=${[...new Set(sneak.msgs)]}`);
  sneak.ws.close();

  console.log('\nBRUTE FORCE');
  for (let i = 0; i < 8; i++) { send(probe, { type: 'auth', password: 'guess' + i }); await sleep(150); }
  await until(() => probe.closed, 6000);
  check('connection dropped after repeated failures', probe.closed);

  console.log('\nHTTP ENDPOINTS');
  for (const [label, headers] of [['no password', {}], ['wrong password', { 'X-Draft-Password': 'nope' }]]) {
    const snap = await fetch(`${HTTP}://${HOST}/room/${room}`, { headers });
    check(`snapshot refused (${label})`, snap.status === 401, `got ${snap.status}`);
    const exp = await fetch(`${HTTP}://${HOST}/room/${room}/export`, { headers });
    check(`export refused (${label})`, exp.status === 401, `got ${exp.status}`);
  }
  const reset = await fetch(`${HTTP}://${HOST}/room/${room}/reset`,
    { method: 'POST', headers: { 'X-Draft-Password': 'nope' } });
  check('reset needs its own ADMIN_TOKEN', reset.status === 401, `got ${reset.status}`);

  console.log('\nPRACTICE ROOMS');
  const p = await client('practice');
  await until(() => p.msgs.includes('authRequired'));
  send(p, { type: 'auth', password: '' });
  await until(() => p.role !== null, 6000);
  check('open without a password', p.role === 'player', `role=${p.role}`);
  check('never grant admin for free', p.role !== 'admin');
  p.ws.close();
}

// ── checks needing the real passwords ────────────────────────────────────────

async function withSecrets(room) {
  console.log('\nPASSWORDS');

  // Prompting is the normal path. The env vars exist so this can run
  // unattended; prefer the prompt, which keeps secrets out of your history.
  let draftPw = process.env.ISC_DRAFT_PW;
  let adminPw = process.env.ISC_ADMIN_PW;
  if (draftPw && adminPw) {
    console.log('  Using ISC_DRAFT_PW / ISC_ADMIN_PW from the environment.\n');
  } else {
    console.log('  Nothing you type is displayed or saved.\n');
    draftPw = await askHidden('  Draft password (the players’): ');
    adminPw = await askHidden('  Admin password (yours):        ');
    console.log('');
  }

  check('draft password is set', draftPw.length > 0);
  check('admin password is set', adminPw.length > 0);
  check('the two differ', draftPw !== adminPw,
        draftPw === adminPw ? 'IDENTICAL — everyone would be admin' : '');
  if (!draftPw || !adminPw || draftPw === adminPw) {
    console.log('\n  Stopping: fix the above before drafting.');
    return;
  }

  console.log('\nDRAFT PASSWORD GRANTS A PLAYER SEAT');
  const p = await client(room);
  await until(() => p.msgs.includes('authRequired'));
  send(p, { type: 'auth', password: draftPw });
  await until(() => p.role !== null || p.fails.length > 0);
  check('accepted', p.role !== null, p.fails.length ? `rejected: ${p.fails[0]}` : '');
  check('grants player, not admin', p.role === 'player', `role=${p.role}`);
  check('board delivered once authenticated', p.state !== null);
  send(p, { type: 'join', name: 'PwCheck' });
  await until(() => p.id !== null);
  check('can take a seat', p.state.players.length === 1);
  p.errors.length = 0;
  send(p, { type: 'undoPick' });
  await until(() => p.errors.length > 0, 5000);
  check('refused admin controls', p.errors.includes('admin_only'), `errors=${p.errors}`);

  console.log('\nADMIN PASSWORD GRANTS ADMIN');
  const a = await client(room);
  await until(() => a.msgs.includes('authRequired'));
  send(a, { type: 'auth', password: adminPw });
  await until(() => a.role !== null || a.fails.length > 0);
  check('accepted', a.role !== null, a.fails.length ? `rejected: ${a.fails[0]}` : '');
  check('grants admin', a.role === 'admin', `role=${a.role}`);
  send(a, { type: 'join', name: 'AdminCheck' });
  await until(() => a.id !== null);
  check('admin flag set on the seat', a.state.players.find(x => x.id === a.id)?.admin === true);
  send(a, { type: 'removePlayer', playerId: p.id });
  await until(() => a.state.players.length === 1, 6000);
  check('admin controls work', a.state.players.length === 1);

  console.log('\nENDPOINTS ACCEPT BOTH PASSWORDS');
  for (const [label, pw] of [['draft', draftPw], ['admin', adminPw]]) {
    const r = await fetch(`${HTTP}://${HOST}/room/${room}`, { headers: { 'X-Draft-Password': pw } });
    check(`snapshot accepts the ${label} password`, r.status === 200, `got ${r.status}`);
  }

  p.ws.close(); a.ws.close();
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const room = 'verify-' + Date.now();      // disposable, and not a practice room
  console.log(`\nVerifying ${HOST}`);
  console.log(`Using disposable room "${room}" — real draft rooms are not touched.\n`);

  await withoutSecrets(room);
  if (!SKIP_PW) await withSecrets(room);
  else console.log('\n(skipping password checks: --skip-passwords)');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
