/** Checks the two behaviours changed in the best-practices pass. */
const HOST = process.env.ISC_HOST ?? '127.0.0.1:8788';
const TEST_PW = process.env.ISC_DRAFT_PW ?? 'local-player-pw';
const ADMIN_PW = process.env.ISC_ADMIN_PW ?? 'local-admin-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function raw(room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://${HOST}/room/${room}/ws`);
    const c = { ws, id: null, state: null, replies: [] };
    ws.addEventListener('message', ev => {
      if (typeof ev.data === 'string' && !ev.data.startsWith('{')) { c.replies.push(ev.data); return; }
      const m = JSON.parse(ev.data);
      if (m.type === 'authOk') res(c);
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'joined') c.id = m.playerId;
    });
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', password: ADMIN_PW })));
    ws.addEventListener('error', rej);
  });
}

/** Poll until cond() holds, instead of hoping a fixed sleep was long enough. */
async function until(cond, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  return false;
}

(async () => {
  console.log('HEARTBEAT AUTO-RESPONSE');
  const c = await raw('hb-' + Date.now());
  c.ws.send('ping');
  await until(() => c.replies.includes('pong'));
  check('bare "ping" answered with "pong"', c.replies.includes('pong'), `replies=${JSON.stringify(c.replies)}`);
  check('socket still open after ping', c.ws.readyState === WebSocket.OPEN);
  c.ws.close();

  console.log('\nRANDOM DRAW DISTRIBUTION');
  const ROUNDS = 60;
  const leadCount = {};
  const seen = new Set();
  let completed = 0;

  for (let n = 0; n < ROUNDS; n++) {
    const room = `draw-${Date.now()}-${n}`;
    const cs = [];
    for (const name of ['Tyler', 'Justin', 'Brendan', 'Rob']) {
      const x = await raw(room);
      x.ws.send(JSON.stringify({ type: 'join', name }));
      if (!await until(() => x.id !== null)) break;
      cs.push(x);
    }
    if (cs.length !== 4) { cs.forEach(x => x.ws.close()); continue; }

    await until(() => cs[0].state?.players?.length === 4);
    cs[0].ws.send(JSON.stringify({ type: 'start' }));
    const ok = await until(() => cs[0].state?.order?.length === 4);

    if (ok) {
      const order = cs[0].state.order.map(o => o.name);
      leadCount[order[0]] = (leadCount[order[0]] ?? 0) + 1;
      seen.add(order.join('>'));
      completed++;
    }
    cs.forEach(x => x.ws.close());
  }

  const counts = Object.entries(leadCount).sort((a, b) => b[1] - a[1]);
  console.log('  completed draws:', completed, 'of', ROUNDS);
  console.log('  first pick:', counts.map(([n, v]) => `${n} ${v}`).join(', '));
  console.log('  distinct orders seen:', seen.size, 'of 24 possible');
  check('enough draws completed', completed >= ROUNDS * 0.9, `${completed}/${ROUNDS}`);
  check('every player led at least once', counts.length === 4, `${counts.length} distinct leaders`);
  check('no runaway leader', (counts[0]?.[1] ?? 0) <= completed * 0.5, `max ${counts[0]?.[1]} of ${completed}`);
  check('order varies widely', seen.size >= 12, `${seen.size} distinct orders`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
