/** Practice rooms are resettable by anyone; real rooms still need an admin. */
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
    const c = { ws, id: null, state: null, role: null, errors: [] };
    ws.addEventListener('message', ev => {
      if (typeof ev.data === 'string' && !ev.data.startsWith('{')) return;
      const m = JSON.parse(ev.data);
      if (m.type === 'authRequired') ws.send(JSON.stringify({ type: 'auth', password: pw }));
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'joined') c.id = m.playerId;
      if (m.type === 'authOk') c.role = m.role;
      if (c.role && c.state && !c.ready) { c.ready = true; res(c); }
      if (m.type === 'error') c.errors.push(m.error);
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
  console.log('PRACTICE ROOM: anyone may start over');
  const proom = 'practice-reuse-' + Date.now();
  const p = await client(proom, ADMIN_PW);
  check('admin in the practice room', p.role === 'admin', `role=${p.role}`);
  send(p, { type: 'join', name: 'Rehearser' });
  await until(() => p.id !== null);
  for (let i = 0; i < 3; i++) { send(p, { type: 'addBot' }); await until(() => p.state.players.filter(x => x.bot).length === i + 1); }
  send(p, { type: 'start' });
  await until(() => p.state.phase === 'drafting');
  check('a rehearsal is running', p.state.phase === 'drafting' && p.state.players.length === 4);

  // reset must work for an ordinary player, so use one
  const plain = await client(proom, PLAYER_PW);
  plain.errors.length = 0;
  send(plain, { type: 'resetRoom' });
  await until(() => plain.state.phase === 'lobby' && plain.state.players.length === 0, 8000);
  check('player reset the practice room', plain.state.phase === 'lobby' && plain.state.players.length === 0,
        `phase=${plain.state.phase} players=${plain.state.players.length}`);
  check('no permission error', !plain.errors.includes('admin_only'), `errors=${plain.errors}`);
  check('room is reusable immediately', plain.state.picks.length === 0);

  // and it is still a practice room afterwards
  check('still flagged practice after reset', plain.state.practice === true);

  console.log('\nREAL ROOM: a player still may not');
  const rroom = 'realreset-' + Date.now();
  const r = await client(rroom, PLAYER_PW);
  check('joined real room as player', r.role === 'player', `role=${r.role}`);
  send(r, { type: 'join', name: 'Tyler' });
  await until(() => r.id !== null);
  r.errors.length = 0;
  send(r, { type: 'resetRoom' });
  await until(() => r.errors.length > 0, 5000);
  check('player refused reset', r.errors.includes('admin_only'), `errors=${r.errors}`);
  check('room untouched', r.state.players.length === 1);

  console.log('\nREAL ROOM: admin still may');
  const a = await client(rroom, ADMIN_PW);
  check('admin authenticated', a.role === 'admin');
  send(a, { type: 'resetRoom' });
  await until(() => a.state.players.length === 0, 8000);
  check('admin reset the real room', a.state.players.length === 0);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
