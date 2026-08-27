/** One human + three bots completes a full draft, and bots stay out of real rooms. */
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const SCHEME = HOST.startsWith('127.') || HOST.startsWith('localhost') ? ['ws', 'http'] : ['wss', 'https'];
const TEST_PW = process.env.ISC_DRAFT_PW ?? 'local-player-pw';
const ADMIN_PW = process.env.ISC_ADMIN_PW ?? 'local-admin-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function client(room, pw) {
  return new Promise(res => {
    const ws = new WebSocket(`${SCHEME[0]}://${HOST}/room/${room}/ws`);
    const c = { ws, id: null, state: null, errors: [] };
    ws.addEventListener('message', ev => {
      if (typeof ev.data === 'string' && !ev.data.startsWith('{')) return;
      const m = JSON.parse(ev.data);
      if (m.type === 'authOk') res(c);
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'joined') c.id = m.playerId;
      if (m.type === 'error') c.errors.push(m.error);
    });
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', password: pw ?? TEST_PW })));
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
async function until(cond, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(60); }
  return false;
}

(async () => {
  const room = 'practice-' + Date.now();
  console.log(`practice room: ${room}\n`);

  console.log('LOBBY WITH BOTS');
  const me = await client(room, ADMIN_PW);
  send(me, { type: 'join', name: 'Rob' });
  await until(() => me.id !== null);
  check('room flagged as practice', me.state.practice === true);
  check('joined as human', me.state.players.some(p => p.id === me.id && !p.bot));

  for (let i = 0; i < 3; i++) {
    send(me, { type: 'addBot' });
    await until(() => me.state.players.filter(p => p.bot).length === i + 1);
  }
  check('three bots added', me.state.players.filter(p => p.bot).length === 3);
  check('room full', me.state.players.length === 4);
  check('bot names', me.state.players.filter(p => p.bot).map(p => p.name).join(',') === 'Bot 1,Bot 2,Bot 3');

  // a fourth bot must not fit
  me.errors.length = 0;
  send(me, { type: 'addBot' });
  await sleep(500);
  check('extra bot rejected', me.errors.includes('room_full'), `errors=${JSON.stringify(me.errors)}`);

  console.log('\nDRAFT: human picks, bots pick themselves');
  send(me, { type: 'start' });
  await until(() => me.state.phase === 'drafting');
  check('drafting', me.state.phase === 'drafting');
  console.log('  order:', me.state.order.map(o => o.name + (o.bot ? '(bot)' : '')).join(' -> '));

  let myPicks = 0, guard = 0;
  while (me.state.phase === 'drafting' && guard++ < 200) {
    if (me.state.onClock === me.id) {
      const taken = new Set(me.state.picks.map(p => p.team));
      const team = me.state.teams.find(t => !taken.has(t));
      const before = me.state.picks.length;
      send(me, { type: 'pick', playerId: me.id, team });
      await until(() => me.state.picks.length > before, 6000);
      myPicks++;
    } else {
      // bots are driven server-side; just wait for the board to move
      const before = me.state.picks.length;
      const moved = await until(() => me.state.picks.length > before || me.state.phase !== 'drafting', 8000);
      if (!moved) { check('bot took its turn', false, `stalled at pick ${before + 1}`); break; }
    }
  }

  check('draft completed', me.state.phase === 'done', `phase=${me.state.phase}, picks=${me.state.picks.length}`);
  check('32 picks', me.state.picks.length === 32);
  check('human made 8 picks', myPicks === 8, `made ${myPicks}`);
  const perPlayer = {};
  me.state.picks.forEach(p => perPlayer[p.name] = (perPlayer[p.name] ?? 0) + 1);
  check('8 teams each', Object.values(perPlayer).every(v => v === 8), JSON.stringify(perPlayer));
  check('no duplicate teams', new Set(me.state.picks.map(p => p.team)).size === 32);

  const exp = await (await fetch(`${SCHEME[1]}://${HOST}/room/${room}/export`, { headers: { 'X-Draft-Password': ADMIN_PW } })).json();
  check('export works from practice room', exp.players?.length === 4 && exp.season === '2026-27');

  console.log('\nBOTS ARE BLOCKED IN NON-PRACTICE ROOMS');
  const realish = 'notpractice-' + Date.now();
  const r = await client(realish, TEST_PW);
  send(r, { type: 'join', name: 'Rob' });
  await until(() => r.id !== null);
  check('room not flagged practice', r.state.practice === false);
  r.errors.length = 0;
  send(r, { type: 'addBot' });
  await sleep(600);
  check('addBot refused for a player', r.errors.includes('bots_admin_only'), `errors=${JSON.stringify(r.errors)}`);
  check('no bot appeared', r.state.players.filter(p => p.bot).length === 0);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
