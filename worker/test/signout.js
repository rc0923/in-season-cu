/** Signing out must revoke the role on the server, not just hide buttons. */
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const local = HOST.startsWith('127.') || HOST.startsWith('localhost');
const [WS] = local ? ['ws'] : ['wss'];
const PLAYER_PW = process.env.ISC_DRAFT_PW ?? 'local-player-pw';
const ADMIN_PW = process.env.ISC_ADMIN_PW ?? 'local-admin-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (l, ok, d) => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); };

function client(room, pw) {
  return new Promise(res => {
    const ws = new WebSocket(`${WS}://${HOST}/room/${room}/ws`);
    const c = { ws, id: null, state: null, role: null, msgs: [], errors: [], ready: false };
    ws.addEventListener('message', ev => {
      if (typeof ev.data === 'string' && !ev.data.startsWith('{')) return;
      const m = JSON.parse(ev.data);
      c.msgs.push(m.type);
      if (m.type === 'authRequired' && !c.ready) ws.send(JSON.stringify({ type: 'auth', password: pw }));
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'joined') c.id = m.playerId;
      if (m.type === 'authOk') c.role = m.role;
      if (m.type === 'error') c.errors.push(m.error);
      if (c.role && c.state && !c.ready) { c.ready = true; res(c); }
    });
  });
}
const send = (c, m) => { try { c.ws.send(JSON.stringify(m)); } catch {} };
async function until(cond, ms = 9000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(60); }
  return false;
}

(async () => {
  const room = 'signout-' + Date.now();
  console.log(`room: ${room}\n`);

  console.log('SETUP');
  const a = await client(room, ADMIN_PW);
  check('admin authenticated', a.role === 'admin', `role=${a.role}`);
  send(a, { type: 'join', name: 'Rob' });
  await until(() => a.id !== null);
  check('seat flagged admin', a.state.players.find(p => p.id === a.id)?.admin === true);

  // a bystander so we can watch the broadcast state change
  const w = await client(room, PLAYER_PW);
  send(w, { type: 'join', name: 'Tyler' });
  await until(() => w.id !== null);
  check('second player seated', w.state.players.length === 2);

  console.log('\nSIGN OUT');
  const adminId = a.id;
  send(a, { type: 'signOut', playerId: adminId });
  await until(() => a.msgs.filter(m => m === 'authRequired').length >= 2, 6000);
  check('server asks for a password again', a.msgs.filter(m => m === 'authRequired').length >= 2);
  await until(() => w.state.players.find(p => p.id === adminId)?.admin === false, 6000);
  check('admin flag cleared on the seat', w.state.players.find(p => p.id === adminId)?.admin === false);
  check('seat itself is kept', w.state.players.length === 2);

  console.log('\nTHE OLD CONNECTION IS ACTUALLY POWERLESS');
  a.errors.length = 0;
  send(a, { type: 'undoPick' });
  await until(() => a.errors.length > 0 || a.msgs.filter(m => m === 'authRequired').length >= 3, 5000);
  const gotAuthRequired = a.msgs.filter(m => m === 'authRequired').length >= 3;
  check('admin action refused after sign-out', gotAuthRequired || a.errors.includes('admin_only'),
        `errors=${a.errors} authRequired x${a.msgs.filter(m => m === 'authRequired').length}`);

  a.errors.length = 0;
  send(a, { type: 'removePlayer', playerId: w.id });
  await sleep(1200);
  check('cannot remove players after sign-out', w.state.players.length === 2, `${w.state.players.length} left`);

  a.errors.length = 0;
  send(a, { type: 'addBot' });
  await sleep(1200);
  check('cannot add bots after sign-out', w.state.players.filter(p => p.bot).length === 0);

  console.log('\nCOMING BACK AS A PLAYER');
  send(a, { type: 'auth', password: PLAYER_PW });
  await until(() => a.role === 'player' || a.state !== null, 6000);
  // role on the client object updates from the authOk message
  await sleep(600);
  send(a, { type: 'join', playerId: adminId });
  await until(() => w.state.players.find(p => p.id === adminId)?.admin === false, 6000);
  check('re-entered as a plain player', w.state.players.find(p => p.id === adminId)?.admin === false);
  check('same seat reclaimed, no duplicate', w.state.players.length === 2);
  a.errors.length = 0;
  send(a, { type: 'undoPick' });
  await until(() => a.errors.length > 0, 5000);
  check('still refused admin actions', a.errors.includes('admin_only'), `errors=${a.errors}`);

  console.log('\nAND ADMIN AGAIN');
  send(a, { type: 'auth', password: ADMIN_PW });
  await sleep(800);
  send(a, { type: 'join', playerId: adminId });
  await until(() => w.state.players.find(p => p.id === adminId)?.admin === true, 6000);
  check('admin restored with the admin password', w.state.players.find(p => p.id === adminId)?.admin === true);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
