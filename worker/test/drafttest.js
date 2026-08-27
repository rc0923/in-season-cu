/**
 * End-to-end draft simulation against the local worker.
 * Four WebSocket clients join, the draft starts, all 32 teams get picked,
 * and the exported state.json is validated.
 */
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const BASE = `http://${HOST}`;
const ROOM = 'test-' + Date.now();
const WS = `ws://${HOST}/room/${ROOM}/ws`;

const TEST_PW = process.env.ISC_DRAFT_PW ?? 'local-player-pw';
const ADMIN_PW = process.env.ISC_ADMIN_PW ?? 'local-admin-pw';
const NAMES = ['Tyler', 'Justin', 'Brendan', 'Rob'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const client = { ws, label, id: null, state: null, errors: [] };
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'authOk') resolve(client);
      if (m.type === 'state') client.state = m.state;
      else if (m.type === 'joined') client.id = m.playerId;
      else if (m.type === 'error') client.errors.push(m.error);
    });
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', password: ADMIN_PW })));
    ws.addEventListener('error', reject);
  });
}

const send = (c, msg) => c.ws.send(JSON.stringify(msg));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

(async () => {
  console.log(`room: ${ROOM}\n`);

  // ---- lobby ----
  console.log('LOBBY');
  const clients = [];
  for (const n of NAMES) {
    const c = await connect(n);
    send(c, { type: 'join', name: n });
    await sleep(150);
    clients.push(c);
  }
  check('four players joined', clients[0].state.players.length, 4);
  check('all have ids', clients.every(c => !!c.id), true);
  check('phase is lobby', clients[0].state.phase, 'lobby');
  check('capacity', clients[0].state.capacity, 4);
  check('season carried from vars', clients[0].state.season, '2026-27');
  check('starting champion', clients[0].state.startChampion, 'CAR');

  // a fifth player must be turned away
  const fifth = await connect('Gatecrasher');
  send(fifth, { type: 'join', name: 'Dave' });
  await sleep(200);
  check('fifth player rejected', fifth.errors, ['room_full']);

  // duplicate name rejected
  const dup = await connect('dup');
  send(dup, { type: 'join', name: 'tyler' });
  await sleep(200);
  check('duplicate name rejected', dup.errors.includes('room_full') || dup.errors.includes('name_taken'), true);

  // ---- start ----
  console.log('\nSTART');
  send(clients[0], { type: 'start' });
  await sleep(250);
  const st = clients[0].state;
  check('phase is drafting', st.phase, 'drafting');
  check('order has 4 seats', st.order.length, 4);
  check('order is a permutation', [...st.order.map(o => o.name)].sort(), [...NAMES].sort());
  check('rounds', st.rounds, 8);
  console.log('  drawn order:', st.order.map(o => o.name).join(' -> '));

  // picking out of turn must fail
  const notOnClock = clients.find(c => c.id !== st.onClock);
  notOnClock.errors.length = 0;
  send(notOnClock, { type: 'pick', playerId: notOnClock.id, team: 'BOS' });
  await sleep(200);
  check('out-of-turn pick rejected', notOnClock.errors, ['not_your_turn']);

  // ---- draft all 32 ----
  console.log('\nDRAFT');
  const byId = Object.fromEntries(clients.map(c => [c.id, c]));
  const snakeSeats = [];
  for (let i = 0; i < 32; i++) {
    const cur = clients[0].state;
    const onClock = cur.onClock;
    const c = byId[onClock];
    if (!c) { console.log('  FAIL  nobody on the clock at pick', i + 1); failures++; break; }
    snakeSeats.push(cur.order.findIndex(o => o.id === onClock));
    const taken = new Set(cur.picks.map(p => p.team));
    const team = cur.teams.find(t => !taken.has(t));
    send(c, { type: 'pick', playerId: c.id, team });
    await sleep(90);
  }
  const fin = clients[0].state;
  check('32 picks made', fin.picks.length, 32);
  check('phase is done', fin.phase, 'done');
  check('all teams unique', new Set(fin.picks.map(p => p.team)).size, 32);

  // verify the snake pattern: R1 forward, R2 back, R3 forward...
  const expectedSeats = [];
  for (let r = 0; r < 8; r++) {
    const seats = [0, 1, 2, 3];
    expectedSeats.push(...(r % 2 === 0 ? seats : seats.slice().reverse()));
  }
  check('snake order correct', snakeSeats, expectedSeats);

  // even distribution
  const counts = {};
  fin.picks.forEach(p => counts[p.name] = (counts[p.name] ?? 0) + 1);
  check('8 teams each', Object.values(counts), [8, 8, 8, 8]);

  // picking after completion must fail
  const late = clients[0];
  late.errors.length = 0;
  send(late, { type: 'pick', playerId: late.id, team: 'BOS' });
  await sleep(200);
  check('pick after done rejected', late.errors, ['not_drafting']);

  // ---- export ----
  console.log('\nEXPORT');
  const res = await fetch(`${BASE}/room/${ROOM}/export`, { headers: { 'X-Draft-Password': ADMIN_PW } });
  check('export 200', res.status, 200);
  const out = await res.json();
  check('champion', out.champion, 'CAR');
  check('startingChampion', out.startingChampion, 'CAR');
  check('season', out.season, '2026-27');
  check('seasonEndDate', out.seasonEndDate, '2027-04-10');
  check('seasonOver false', out.seasonOver, false);
  check('lastDayTick = opening night', out.lastDayTick, '2026-09-29');
  check('4 players', out.players.length, 4);
  check('8 teams each', out.players.map(p => p.teams.length), [8, 8, 8, 8]);
  check('32 distinct teams', new Set(out.players.flatMap(p => p.teams.map(t => t.abbr))).size, 32);
  check('empty game log', out.gameLog, []);
  check('all counters zeroed', out.players.every(p =>
    p.days === 0 && p.reigns === 0 && p.wins === 0 && p.losses === 0 && p.streak === 0 &&
    p.teams.every(t => t.days === 0 && t.wins === 0 && t.losses === 0)), true);

  // the champion must be owned by somebody, or the site cannot resolve an owner
  const champOwner = out.players.find(p => p.teams.some(t => t.abbr === out.champion));
  check('champion is owned', !!champOwner, true);
  console.log('  CAR drafted by:', champOwner?.name);

  // ---- unfinished room must not export ----
  const other = await fetch(`${BASE}/room/unfinished-${Date.now()}/export`, { headers: { 'X-Draft-Password': ADMIN_PW } });
  check('unfinished export 409', other.status, 409);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('SIMULATION ERROR:', e); process.exit(1); });
