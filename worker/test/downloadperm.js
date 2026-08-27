/** At the end of a draft only the admin is offered the download. */
const { JSDOM } = require('jsdom');
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const SITE = process.env.SITE_PORT ?? 8139;
const W = `http://${HOST}`;
const ROOM = 'dlperm-' + Date.now();          // NOT a practice room
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (l, ok, d) => { if (!ok) fails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); };

function open() {
  return JSDOM.fromURL(`http://localhost:${SITE}/draft.html?worker=${encodeURIComponent(W)}&room=${ROOM}`,
    { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
}
const btn = (d, t) => [...d.querySelectorAll('button')].find(b => b.textContent.trim() === t);
async function until(cond, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(100); }
  return false;
}

(async () => {
  // ── admin window: joins, fills with bots, runs the draft ──
  const adom = await open();
  const ad = adom.window.document;
  adom.window.confirm = () => true;
  await sleep(2200);
  ad.querySelector('#pw-input').value = 'local-admin-pw';
  btn(ad, 'Enter').click(); await sleep(1000);
  ad.querySelector('#name-input').value = 'Rob';
  btn(ad, 'Join Draft').click(); await sleep(800);

  // ── player window: joins the same room with the draft password ──
  const pdom = await open();
  const pd = pdom.window.document;
  await sleep(2200);
  pd.querySelector('#pw-input').value = 'local-player-pw';
  btn(pd, 'Enter').click(); await sleep(1000);
  pd.querySelector('#name-input').value = 'Tyler';
  btn(pd, 'Join Draft').click(); await sleep(800);

  console.log('SETUP');
  check('two humans seated', ad.querySelectorAll('.seat.filled').length === 2,
        `${ad.querySelectorAll('.seat.filled').length} seated`);

  // admin tops the room up with bots and starts
  for (let i = 0; i < 2; i++) { btn(ad, 'Add a bot')?.click(); await sleep(700); }
  check('room full', ad.querySelectorAll('.seat.filled').length === 4);
  btn(ad, 'Draw Order & Start').click();
  await until(() => ad.querySelectorAll('.team-btn').length === 32);
  check('draft started', ad.querySelectorAll('.team-btn').length === 32);

  // run to completion: each human takes their own turns, bots take theirs
  const myTurn = doc => doc.querySelector('.clock .who')?.textContent.trim() === 'Your pick';
  let guard = 0;
  while (guard++ < 120) {
    if (ad.querySelector('.lobby h2')?.textContent.trim() === 'Draft Complete') break;
    if (myTurn(ad)) { [...ad.querySelectorAll('.team-btn')].find(b => !b.disabled)?.click(); }
    else if (myTurn(pd)) { [...pd.querySelectorAll('.team-btn')].find(b => !b.disabled)?.click(); }
    await sleep(400);
  }

  console.log('');
  console.log('AT THE END');
  const adminDone = ad.querySelector('.lobby h2')?.textContent.trim();
  const playerDone = pd.querySelector('.lobby h2')?.textContent.trim();
  check('admin sees the finished screen', adminDone === 'Draft Complete', adminDone);
  check('player sees the finished screen', playerDone === 'Draft Complete', playerDone);

  check('ADMIN is offered the download', !!btn(ad, 'Download state.json'));
  check('ADMIN is offered show/copy', !!btn(ad, 'Show / copy JSON'));
  check('PLAYER is NOT offered the download', !btn(pd, 'Download state.json'));
  check('PLAYER is NOT offered show/copy', !btn(pd, 'Show / copy JSON'));

  const note = [...pd.querySelectorAll('.hint')].map(h => h.textContent.trim()).join(' | ');
  check('player told who saves it', /will save the results/.test(note), note);

  console.log('');
  console.log('AND THE ENDPOINT AGREES');
  const asPlayer = await fetch(`${W}/room/${ROOM}/export`, { headers: { 'X-Draft-Password': 'local-player-pw' } });
  check('export refused to a player', asPlayer.status === 403, `got ${asPlayer.status}`);
  const asAdmin = await fetch(`${W}/room/${ROOM}/export`, { headers: { 'X-Draft-Password': 'local-admin-pw' } });
  check('export allowed for admin', asAdmin.status === 200, `got ${asAdmin.status}`);
  const body = await asAdmin.json();
  check('export has all four rosters', body.players?.length === 4);

  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.stack); process.exit(1); });
