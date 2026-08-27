/** Password gate + admin powers. */
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const local = HOST.startsWith('127.') || HOST.startsWith('localhost');
const [WSS, HTTPS] = local ? ['ws', 'http'] : ['wss', 'https'];
const PLAYER_PW = process.env.ISC_DRAFT_PW ?? 'local-player-pw';
const ADMIN_PW = process.env.ISC_ADMIN_PW ?? 'local-admin-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (l, ok, d) => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); };

function client(room) {
  return new Promise(res => {
    const ws = new WebSocket(`${WSS}://${HOST}/room/${room}/ws`);
    const c = { ws, id: null, state: null, role: null, msgs: [], errors: [], closed: false };
    ws.addEventListener('message', ev => {
      if (typeof ev.data === 'string' && !ev.data.startsWith('{')) return;
      const m = JSON.parse(ev.data);
      c.msgs.push(m.type);
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'joined') c.id = m.playerId;
      if (m.type === 'authOk') c.role = m.role;
      if (m.type === 'authFail') c.errors.push('authFail:' + m.error);
      if (m.type === 'error') c.errors.push(m.error);
    });
    ws.addEventListener('close', () => { c.closed = true; });
    ws.addEventListener('open', () => res(c));
  });
}
const send = (c, m) => { try { c.ws.send(JSON.stringify(m)); } catch {} };
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(50); }
  return false;
}

(async () => {
  const room = 'season-auth-' + Date.now();   // deliberately NOT a practice room
  console.log(`room: ${room}\n`);

  console.log('GATE');
  const stranger = await client(room);
  await until(() => stranger.msgs.includes('authRequired'));
  check('authRequired sent on connect', stranger.msgs.includes('authRequired'));
  check('no state leaked before auth', stranger.state === null, `msgs=${stranger.msgs}`);

  send(stranger, { type: 'join', name: 'Randomer' });
  await sleep(500);
  check('join refused without auth', stranger.state === null && stranger.id === null);

  send(stranger, { type: 'auth', password: 'guessing' });
  await until(() => stranger.errors.length > 0);
  check('wrong password rejected', stranger.errors.some(e => e.includes('bad_password')));
  check('still no state after bad password', stranger.state === null);

  // brute force gets the socket dropped
  for (let i = 0; i < 8; i++) { send(stranger, { type: 'auth', password: 'x' + i }); await sleep(120); }
  await until(() => stranger.closed, 4000);
  check('socket closed after repeated failures', stranger.closed);

  console.log('\nPLAYER');
  const p1 = await client(room);
  await until(() => p1.msgs.includes('authRequired'));
  send(p1, { type: 'auth', password: PLAYER_PW });
  await until(() => p1.role !== null);
  check('player password accepted', p1.role === 'player', `role=${p1.role}`);
  check('state delivered after auth', p1.state !== null);
  send(p1, { type: 'join', name: 'Tyler' });
  await until(() => p1.id !== null);
  check('player can take a seat', p1.state.players.length === 1);

  p1.errors.length = 0;
  send(p1, { type: 'undoPick' });
  await until(() => p1.errors.length > 0);
  check('player refused admin action', p1.errors.includes('admin_only'), `errors=${p1.errors}`);

  console.log('\nADMIN');
  const admin = await client(room);
  await until(() => admin.msgs.includes('authRequired'));
  send(admin, { type: 'auth', password: ADMIN_PW });
  await until(() => admin.role !== null);
  check('admin password grants admin', admin.role === 'admin', `role=${admin.role}`);
  send(admin, { type: 'join', name: 'Rob' });
  await until(() => admin.id !== null);
  check('admin flagged on the player', admin.state.players.find(p => p.id === admin.id)?.admin === true);

  // fill remaining seats with two more players
  const extra = [];
  for (const n of ['Justin', 'Brendan']) {
    const c = await client(room);
    await until(() => c.msgs.includes('authRequired'));
    send(c, { type: 'auth', password: PLAYER_PW });
    await until(() => c.role !== null);
    send(c, { type: 'join', name: n });
    await until(() => c.id !== null);
    extra.push(c);
  }
  await until(() => admin.state.players.length === 4);
  check('four seated', admin.state.players.length === 4);

  console.log('\nADMIN: remove a player in the lobby');
  send(admin, { type: 'removePlayer', playerId: extra[1].id });
  await until(() => admin.state.players.length === 3);
  check('player removed', admin.state.players.length === 3);
  check('right one removed', !admin.state.players.some(p => p.name === 'Brendan'));
  // put them back
  send(extra[1], { type: 'join', name: 'Brendan' });
  await until(() => admin.state.players.length === 4);

  console.log('\nONLY ADMIN MAY START');
  p1.errors.length = 0;
  send(p1, { type: 'start' });
  await until(() => p1.errors.length > 0, 5000);
  check('player refused start', p1.errors.includes('start_admin_only'), `errors=${p1.errors}`);
  check('room still in the lobby', admin.state.phase === 'lobby', `phase=${admin.state.phase}`);

  console.log('\nADMIN: undo + re-assign');
  send(admin, { type: 'start' });
  await until(() => admin.state.phase === 'drafting');
  const byId = Object.fromEntries([p1, admin, ...extra].map(c => [c.id, c]));
  for (let i = 0; i < 4; i++) {
    const st = admin.state;
    const c = byId[st.onClock];
    const taken = new Set(st.picks.map(p => p.team));
    const before = st.picks.length;
    send(c, { type: 'pick', playerId: c.id, team: st.teams.find(t => !taken.has(t)) });
    await until(() => admin.state.picks.length > before);
  }
  check('four picks made', admin.state.picks.length === 4);
  const lastTeam = admin.state.picks[3].team;
  const clockBefore = admin.state.onClock;

  send(admin, { type: 'undoPick' });
  await until(() => admin.state.picks.length === 3);
  check('undo removed the last pick', admin.state.picks.length === 3);
  check('undone team is free again', !admin.state.picks.some(p => p.team === lastTeam));
  check('clock handed back', admin.state.onClock !== clockBefore || admin.state.picks.length === 3);

  const target = admin.state.picks[0];
  const freeTeam = admin.state.teams.find(t => !admin.state.picks.some(p => p.team === t));
  send(admin, { type: 'replacePick', overall: target.overall, team: freeTeam });
  await until(() => admin.state.picks[0].team === freeTeam);
  check('pick re-assigned', admin.state.picks[0].team === freeTeam, `${target.team} -> ${freeTeam}`);
  check('owner unchanged', admin.state.picks[0].playerId === target.playerId);
  check('old team back in the pool', !admin.state.picks.some(p => p.team === target.team));

  admin.errors.length = 0;
  send(admin, { type: 'replacePick', overall: admin.state.picks[1].overall, team: admin.state.picks[2].team });
  await until(() => admin.errors.length > 0);
  check('cannot re-assign onto an owned team', admin.errors.includes('team_taken'), `errors=${admin.errors}`);

  console.log('\nHTTP ENDPOINTS');
  const noPw = await fetch(`${HTTPS}://${HOST}/room/${room}`);
  check('snapshot needs password', noPw.status === 401, `got ${noPw.status}`);
  const withPw = await fetch(`${HTTPS}://${HOST}/room/${room}`, { headers: { 'X-Draft-Password': PLAYER_PW } });
  check('snapshot ok with password', withPw.status === 200, `got ${withPw.status}`);
  const expNoPw = await fetch(`${HTTPS}://${HOST}/room/${room}/export`);
  check('export needs password', expNoPw.status === 401, `got ${expNoPw.status}`);
  const expPlayer = await fetch(`${HTTPS}://${HOST}/room/${room}/export`, { headers: { 'X-Draft-Password': PLAYER_PW } });
  check('export refused to a player', expPlayer.status === 403, `got ${expPlayer.status}`);
  const expAdmin = await fetch(`${HTTPS}://${HOST}/room/${room}/export`, { headers: { 'X-Draft-Password': ADMIN_PW } });
  check('export allowed for admin (409 = not finished)', expAdmin.status === 409, `got ${expAdmin.status}`);

  console.log('\nPRACTICE ROOMS STAY OPEN');
  const proom = 'practice-auth-' + Date.now();
  const pc = await client(proom);
  await until(() => pc.msgs.includes('authRequired'));
  send(pc, { type: 'auth', password: PLAYER_PW });
  await until(() => pc.role !== null, 4000);
  check('practice requires the draft password', pc.role === 'player', `role=${pc.role}`);
  const pa = await client(proom);
  await until(() => pa.msgs.includes('authRequired'));
  send(pa, { type: 'auth', password: ADMIN_PW });
  await until(() => pa.role !== null);
  check('admin password works in practice too', pa.role === 'admin', `role=${pa.role}`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
