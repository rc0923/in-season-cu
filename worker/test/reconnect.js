/** Seat reclaim: refreshing or dropping mid-draft must not lose your seat or duplicate you. */
const ROOM = 'rc-' + Date.now();
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const WS = `ws://${HOST}/room/${ROOM}/ws`;
const TEST_PW = process.env.ISC_DRAFT_PW ?? 'local-player-pw';
const ADMIN_PW = process.env.ISC_ADMIN_PW ?? 'local-admin-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

function client() {
  return new Promise(resolve => {
    const ws = new WebSocket(WS);
    const c = { ws, id: null, state: null, errors: [] };
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'authOk') resolve(c);
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'joined') c.id = m.playerId;
      if (m.type === 'error') c.errors.push(m.error);
    });
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', password: ADMIN_PW })));
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));

(async () => {
  console.log(`room: ${ROOM}\n`);
  const names = ['Tyler', 'Justin', 'Brendan', 'Rob'];
  const cs = [];
  for (const n of names) { const c = await client(); send(c, { type: 'join', name: n }); await sleep(150); cs.push(c); }
  check('four joined', cs[0].state.players.length, 4);

  console.log('\nRECONNECT IN LOBBY');
  const robId = cs[3].id;
  cs[3].ws.close();
  await sleep(300);
  const robAgain = await client();
  send(robAgain, { type: 'join', playerId: robId });
  await sleep(300);
  check('still four players (no duplicate)', robAgain.state.players.length, 4);
  check('same seat reclaimed', robAgain.id, robId);
  check('name preserved', robAgain.state.players.find(p => p.id === robId)?.name, 'Rob');
  cs[3] = robAgain;

  console.log('\nRECONNECT MID-DRAFT');
  send(cs[0], { type: 'start' });
  await sleep(300);
  check('drafting', cs[0].state.phase, 'drafting');

  // make a few picks
  const byId = Object.fromEntries(cs.map(c => [c.id, c]));
  for (let i = 0; i < 5; i++) {
    const st = cs[0].state;
    const c = byId[st.onClock];
    const taken = new Set(st.picks.map(p => p.team));
    send(c, { type: 'pick', playerId: c.id, team: st.teams.find(t => !taken.has(t)) });
    await sleep(120);
  }
  check('five picks in', cs[0].state.picks.length, 5);

  // drop whoever is on the clock and come back
  const onClockId = cs[0].state.onClock;
  const dropping = byId[onClockId];
  dropping.ws.close();
  await sleep(300);
  const back = await client();
  send(back, { type: 'join', playerId: onClockId });
  await sleep(300);
  check('roster intact after drop', back.state.players.length, 4);
  check('picks intact', back.state.picks.length, 5);
  check('still on the clock', back.state.onClock, onClockId);
  check('rejoin mid-draft did not error', back.errors, []);

  // and can still pick
  const taken = new Set(back.state.picks.map(p => p.team));
  send(back, { type: 'pick', playerId: onClockId, team: back.state.teams.find(t => !taken.has(t)) });
  await sleep(250);
  check('pick after reconnect worked', back.state.picks.length, 6);

  console.log('\nUNKNOWN SEAT');
  const stranger = await client();
  send(stranger, { type: 'join', playerId: 'not-a-real-id' });
  await sleep(300);
  check('unknown id mid-draft rejected', stranger.errors, ['draft_already_started']);
  check('room unchanged', stranger.state.players.length, 4);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
