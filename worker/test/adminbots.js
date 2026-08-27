/** Admins may add bots anywhere; players may not, outside practice rooms. */
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const local = HOST.startsWith('127.') || HOST.startsWith('localhost');
const [WS, HTTP] = local ? ['ws', 'http'] : ['wss', 'https'];
const PLAYER_PW = process.env.ISC_DRAFT_PW ?? 'local-player-pw';
const ADMIN_PW = process.env.ISC_ADMIN_PW ?? 'local-admin-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (l, ok, d) => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); };

function client(room, pw) {
  return new Promise(res => {
    const ws = new WebSocket(`${WS}://${HOST}/room/${room}/ws`);
    const c = { ws, id: null, state: null, role: null, msgs: [], errors: [] };
    ws.addEventListener('message', ev => {
      if (typeof ev.data === 'string' && !ev.data.startsWith('{')) return;
      const m = JSON.parse(ev.data);
      c.msgs.push(m.type);
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'joined') c.id = m.playerId;
      if (m.type === 'authOk') { c.role = m.role; res(c); }
      if (m.type === 'error') c.errors.push(m.error);
    });
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', password: pw })));
  });
}
const send = (c, m) => { try { c.ws.send(JSON.stringify(m)); } catch {} };
async function until(cond, ms = 9000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(60); }
  return false;
}

(async () => {
  const room = 'botperm-' + Date.now();     // NOT a practice room
  console.log(`room: ${room} (password-protected)\n`);

  console.log('PLAYER IN A REAL ROOM');
  const p = await client(room, PLAYER_PW);
  check('player authenticated', p.role === 'player', `role=${p.role}`);
  send(p, { type: 'join', name: 'Tyler' });
  await until(() => p.id !== null);
  p.errors.length = 0;
  send(p, { type: 'addBot' });
  await until(() => p.errors.length > 0, 5000);
  check('player refused a bot', p.errors.includes('bots_admin_only'), `errors=${p.errors}`);
  check('no bot appeared', p.state.players.filter(x => x.bot).length === 0);

  console.log('\nADMIN IN THE SAME ROOM');
  const a = await client(room, ADMIN_PW);
  check('admin authenticated', a.role === 'admin', `role=${a.role}`);
  send(a, { type: 'join', name: 'Rob' });
  await until(() => a.id !== null);
  send(a, { type: 'addBot' });
  await until(() => a.state.players.filter(x => x.bot).length === 1, 6000);
  check('admin added a bot to a real room', a.state.players.filter(x => x.bot).length === 1);
  send(a, { type: 'addBot' });
  await until(() => a.state.players.filter(x => x.bot).length === 2, 6000);
  check('room now full', a.state.players.length === 4);

  console.log('\nTHE REHEARSAL STILL RUNS');
  send(a, { type: 'start' });
  await until(() => a.state.phase === 'drafting');
  check('draft started', a.state.phase === 'drafting');
  // bots must still pick themselves in a non-practice room
  const before = a.state.picks.length;
  const onClockIsBot = () => a.state.players.find(x => x.id === a.state.onClock)?.bot;
  let guard = 0;
  while (!onClockIsBot() && guard++ < 4) {
    const c = a.state.onClock === a.id ? a : p;
    const taken = new Set(a.state.picks.map(x => x.team));
    const n = a.state.picks.length;
    send(c, { type: 'pick', playerId: c.id, team: a.state.teams.find(t => !taken.has(t)) });
    await until(() => a.state.picks.length > n, 6000);
  }
  const atBot = a.state.picks.length;
  const moved = await until(() => a.state.picks.length > atBot, 9000);
  check('bots pick themselves outside practice', moved, `picks ${before} -> ${a.state.picks.length}`);

  console.log('\nADMIN CAN STILL REMOVE THEM');
  send(a, { type: 'resetRoom' });
  await until(() => a.state.phase === 'lobby', 6000);
  check('reset clears the rehearsal', a.state.players.length === 0 && a.state.picks.length === 0);

  console.log('\nPRACTICE ROOMS UNCHANGED');
  const proom = 'practice-bp-' + Date.now();
  const pp = await client(proom, PLAYER_PW);
  check('practice gated but players get in', pp.role === 'player');
  send(pp, { type: 'join', name: 'Anyone' });
  await until(() => pp.id !== null);
  pp.errors.length = 0;
  send(pp, { type: 'addBot' });
  await until(() => pp.errors.length > 0, 5000);
  check('player refused a bot in practice too', pp.errors.includes('bots_admin_only'), `errors=${pp.errors}`);
  check('no bot appeared in practice', pp.state.players.filter(x => x.bot).length === 0);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
