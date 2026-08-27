/**
 * Drives draft.html in jsdom against the local wrangler worker.
 * Our player is a real page; the other three are raw WebSocket clients.
 */
const { JSDOM } = require('jsdom');

const ROOM = 'ui-' + Date.now();
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const SITE = process.env.SITE_PORT ?? 8139;
const WORKER = `http://${HOST}`;
const PAGE = `http://localhost:${SITE}/draft.html?worker=${encodeURIComponent(WORKER)}&room=${ROOM}`;
const DRAFT_PW = process.env.ISC_DRAFT_PW ?? 'local-player-pw';
const ADMIN_PW = process.env.ISC_ADMIN_PW ?? 'local-admin-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

function bot(name) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${HOST}/room/${ROOM}/ws`);
    const b = { ws, name, id: null, state: null };
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'state') b.state = m.state;
      if (m.type === 'joined') b.id = m.playerId;
    });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', password: DRAFT_PW }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'join', name })), 300);
      setTimeout(() => resolve(b), 250);
    });
  });
}

(async () => {
  console.log(`room: ${ROOM}\n`);

  const dom = await JSDOM.fromURL(PAGE, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  const txt = sel => d.querySelector(sel)?.textContent?.trim() ?? '(missing)';
  const all = sel => [...d.querySelectorAll(sel)].map(n => n.textContent.trim());
  await sleep(1500);

  console.log('GATE');
  check('password prompt shown', !!d.querySelector('#pw-input'), true);
  check('no lobby before auth', d.querySelectorAll('.seat').length, 0);
  d.querySelector('#pw-input').value = ADMIN_PW;
  [...d.querySelectorAll('button')].find(b => b.textContent.trim() === 'Enter').click();
  await sleep(1200);

  console.log('LOBBY');
  check('connection live', txt('#conn'), 'live');
  check('season subtitle', txt('#season-sub'), '2026-27 · 4 players · 8 rounds · admin');
  check('lobby heading', txt('.lobby h2'), 'Draft Lobby');
  check('four seats shown', d.querySelectorAll('.seat').length, 4);
  check('all seats open', d.querySelectorAll('.seat.empty').length, 4);

  // join as Rob through the actual form
  const input = d.querySelector('#name-input');
  input.value = 'Rob';
  d.querySelector('.join-form .btn').click();
  await sleep(400);
  check('seat claimed', d.querySelectorAll('.seat.filled').length, 1);
  check('marked as me', d.querySelectorAll('.seat.me').length, 1);
  check('my name shown', txt('.seat.filled .who'), 'Rob ★');
  check('join form gone', !!d.querySelector('#name-input'), false);
  check('start disabled while short', d.querySelector('.done-actions .btn').disabled, true);

  // three more players arrive
  const bots = [];
  for (const n of ['Tyler', 'Justin', 'Brendan']) bots.push(await bot(n));
  await sleep(400);
  check('four seats filled', d.querySelectorAll('.seat.filled').length, 4);
  check('start now enabled', d.querySelector('.done-actions .btn').disabled, false);
  check('hint says ready', txt('.lobby .hint'), 'Everyone is in. Draw the order and start.');

  console.log('\nSTART');
  d.querySelector('.done-actions .btn').click();
  await sleep(500);
  check('order strip rendered', d.querySelectorAll('.order-chip').length, 4);
  check('exactly one on the clock', d.querySelectorAll('.order-chip.active').length, 1);
  check('board has 32 teams', d.querySelectorAll('.team-btn').length, 32);
  check('rosters rendered', d.querySelectorAll('.roster').length, 4);
  check('8 empty slots each', d.querySelectorAll('.roster').length && [...d.querySelectorAll('.roster')][0].querySelectorAll('.slot').length, 8);
  check('cup holder flagged', all('.team-btn.champ .abbr'), ['CAR']);
  console.log('  order:', all('.order-chip').join(' -> '));

  // whoever is on the clock, the board must only be clickable for them
  const myTurn = txt('.clock .who') === 'Your pick';
  const enabled = [...d.querySelectorAll('.team-btn')].filter(b => !b.disabled).length;
  check(`board ${myTurn ? 'enabled on my turn' : 'locked when not my turn'}`, enabled > 0, myTurn);

  console.log('\nDRAFT');
  // run the whole draft: page clicks when it is our turn, bots pick otherwise
  const myId = w.localStorage.getItem(`isc-draft-seat:${ROOM}`);
  let guard = 0;
  while (guard++ < 60) {
    const st = bots[0].state;
    if (!st || st.phase !== 'drafting') break;
    if (st.onClock === myId) {
      const btn = [...d.querySelectorAll('.team-btn')].find(b => !b.disabled);
      if (!btn) { console.log('  FAIL  my turn but no team clickable'); failures++; break; }
      btn.click();
    } else {
      const b = bots.find(x => x.id === st.onClock);
      const taken = new Set(st.picks.map(p => p.team));
      b.ws.send(JSON.stringify({ type: 'pick', playerId: b.id, team: st.teams.find(t => !taken.has(t)) }));
    }
    await sleep(120);
  }
  await sleep(500);

  check('draft finished', bots[0].state.phase, 'done');
  check('done screen shown', txt('.lobby h2'), 'Draft Complete');
  check('download button present', !!d.querySelector('.done-actions .btn'), true);
  const filled = [...d.querySelectorAll('.roster')].map(r => r.querySelectorAll('.slot.filled').length);
  check('every roster full', filled, [8, 8, 8, 8]);

  // export reflects what the UI drafted
  const out = await (await fetch(`${WORKER}/room/${ROOM}/export`, { headers: { 'X-Draft-Password': ADMIN_PW } })).json();
  check('export champion', out.champion, 'CAR');
  check('export player count', out.players.length, 4);
  const names = out.players.map(p => p.name).sort();
  check('export names', names, ['Brendan', 'Justin', 'Rob', 'Tyler']);
  const mine = out.players.find(p => p.name === 'Rob');
  const uiMine = [...d.querySelectorAll('.roster.me .slot.filled')].map(s => s.textContent.replace(/^\d+/, ''));
  check('my roster matches export', mine.teams.map(t => t.abbr), uiMine);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('UI TEST ERROR:', e.stack); process.exit(1); });
