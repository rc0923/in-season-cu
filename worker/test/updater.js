/**
 * Replays the 2026-27 season's opening month through the real cup updater
 * (.github/scripts/update-state.js) on the workflow's actual cron schedule,
 * against a mock NHL schedule server that releases each final score at a
 * chosen moment. Asserts the counts the league's spreadsheet holds.
 *
 * Timing modes:
 *   real    - only the Oct 1 game at San Jose finishes after midnight ET,
 *             as happened; this is the case that misplaced a day
 *   prompt  - every game is final before the midnight run
 *   late    - every game finishes after the midnight run (worst case)
 * Correct counting must not depend on when a game happens to end, so all
 * three modes must produce identical results.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const UPDATER = process.env.ISC_UPDATER
  ?? path.resolve(__dirname, '..', '..', '.github', 'scripts', 'update-state.js');

const ROSTERS = {
  Brendan: ['CAR', 'MIN', 'MTL', 'NJD', 'SJS', 'CBJ', 'DET', 'VAN'],
  Tyler:   ['FLA', 'EDM', 'VGK', 'UTA', 'TOR', 'OTT', 'PIT', 'SEA'],
  Rob:     ['COL', 'DAL', 'NYR', 'BOS', 'STL', 'NYI', 'WPG', 'NSH'],
  Justin:  ['WSH', 'TBL', 'PHI', 'BUF', 'LAK', 'ANA', 'CHI', 'CGY'],
};

// [date, away, home, awayScore, homeScore] - every cup game to 2026-10-27.
const GAMES = [
  ['2026-09-29', 'FLA', 'CAR', 1, 0],
  ['2026-10-01', 'FLA', 'SJS', 3, 4],
  ['2026-10-03', 'LAK', 'SJS', 4, 5],
  ['2026-10-05', 'SJS', 'DAL', 0, 5],
  ['2026-10-08', 'DAL', 'BUF', 4, 0],
  ['2026-10-10', 'DAL', 'PIT', 1, 2],
  ['2026-10-13', 'PIT', 'CHI', 3, 5],
  ['2026-10-15', 'WPG', 'CHI', 3, 4],
  ['2026-10-17', 'DAL', 'CHI', 4, 0],
  ['2026-10-20', 'BOS', 'DAL', 2, 3],
  ['2026-10-22', 'WPG', 'DAL', 2, 3],
  ['2026-10-25', 'NYI', 'DAL', 3, 6],
].map(([date, away, home, as, hs], i) => ({ id: 2026020000 + i + 1, date, away, home, as, hs }));

const SIM_START = '2026-09-29';
const SIM_END = '2026-10-27';

// What the spreadsheet holds: every cup game is one win for the winner and one
// loss for the loser, and the cup belongs to the winner from the game's date.
const EXPECT_PLAYERS = {
  Rob:     { days: 15, reigns: 2, wins: 6, losses: 5 },
  Tyler:   { days: 5,  reigns: 2, wins: 2, losses: 2 },
  Brendan: { days: 4,  reigns: 1, wins: 2, losses: 2 },
  Justin:  { days: 4,  reigns: 1, wins: 2, losses: 3 },
};
const EXPECT_TEAMS = {
  CAR: { days: 0,  reigns: 0, wins: 0, losses: 1 },
  FLA: { days: 2,  reigns: 1, wins: 1, losses: 1 },
  SJS: { days: 4,  reigns: 1, wins: 2, losses: 1 },
  DAL: { days: 15, reigns: 2, wins: 6, losses: 1 },
  PIT: { days: 3,  reigns: 1, wins: 1, losses: 1 },
  CHI: { days: 4,  reigns: 1, wins: 2, losses: 1 },
  BUF: { days: 0,  reigns: 0, wins: 0, losses: 1 },
  LAK: { days: 0,  reigns: 0, wins: 0, losses: 1 },
  BOS: { days: 0,  reigns: 0, wins: 0, losses: 1 },
  WPG: { days: 0,  reigns: 0, wins: 0, losses: 2 },
  NYI: { days: 0,  reigns: 0, wins: 0, losses: 1 },
};

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

// ── time helpers ──────────────────────────────────────────────────────────────

const addDays = (d, n) => {
  const x = new Date(d + 'T12:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const at = (date, hourUtc) => new Date(`${date}T${String(hourUtc).padStart(2, '0')}:00:00Z`).getTime();
const etDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);

// ── mock schedule server ──────────────────────────────────────────────────────

function finalAt(game, mode) {
  const late = mode === 'late' || (mode === 'real' && game.date === '2026-10-01' && game.home === 'SJS');
  // 03:00 UTC is 11pm ET: final before the midnight-ET run. 05:00 UTC is
  // 1am ET: the midnight run has already ticked the day.
  return at(addDays(game.date, 1), late ? 5 : 3);
}

function startMockNhl(mode, clock) {
  const server = http.createServer((req, res) => {
    const m = req.url.match(/\/schedule\/(\d{4}-\d{2}-\d{2})/);
    if (!m) { res.writeHead(404); return res.end('{}'); }
    const week = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(m[1], i);
      const games = GAMES.filter(g => g.date === date).map(g => {
        const final = clock.now >= finalAt(g, mode);
        return {
          id: g.id, gameType: 2,
          gameState: final ? 'OFF' : (clock.now >= at(g.date, 23) ? 'LIVE' : 'FUT'),
          awayTeam: { abbrev: g.away, ...(final ? { score: g.as } : {}) },
          homeTeam: { abbrev: g.home, ...(final ? { score: g.hs } : {}) },
        };
      });
      week.push({ date, games });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gameWeek: week, nextStartDate: addDays(m[1], 7) }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── one updater invocation, exactly as the workflow makes it ──────────────────

function runUpdater(dateArg, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [UPDATER, dateArg], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`updater exit ${code}: ${err}`)));
  });
}

function openingState() {
  const team = abbr => ({ abbr, days: 0, reigns: 0, wins: 0, losses: 0, longestStreak: 0, currentStreak: 0 });
  return {
    champion: 'CAR', startingChampion: 'CAR',
    lastUpdated: SIM_START, lastDayTick: SIM_START,
    season: '2026-27', seasonEndDate: '2027-04-10', seasonOver: false,
    players: Object.entries(ROSTERS).map(([name, abbrs]) => ({
      name, days: 0, reigns: 0, wins: 0, losses: 0, streak: 0, teams: abbrs.map(team),
    })),
    gameLog: [],
  };
}

async function simulate(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isc-updater-'));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(openingState(), null, 2));

  const clock = { now: 0 };
  const server = await startMockNhl(mode, clock);
  const env = {
    ...process.env,
    ISC_STATE_PATH: statePath,
    ISC_NHL_BASE: `http://127.0.0.1:${server.address().port}`,
  };

  try {
    // The workflow's crons: 04, 07, 10, 13 UTC, each running the updater for
    // the UTC date of yesterday, then for today in Eastern time.
    for (let d = SIM_START; d <= SIM_END; d = addDays(d, 1)) {
      for (const h of [4, 7, 10, 13]) {
        clock.now = at(d, h);
        await runUpdater(utcDate(clock.now - 86400000), env);
        await runUpdater(etDate(clock.now), env);
      }
    }
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function summarize(state) {
  const players = Object.fromEntries(state.players.map(p =>
    [p.name, { days: p.days, reigns: p.reigns, wins: p.wins, losses: p.losses }]));
  const teams = {};
  for (const p of state.players) for (const t of p.teams) {
    if (t.days || t.reigns || t.wins || t.losses) teams[t.abbr] = { days: t.days, reigns: t.reigns, wins: t.wins, losses: t.losses };
  }
  return { players, teams };
}

const fmt = o => `${o.days}d ${o.reigns}R ${o.wins}W-${o.losses}L`;

(async () => {
  const results = {};
  for (const mode of ['real', 'prompt', 'late']) {
    console.log(`\nMODE: ${mode}`);
    const state = await simulate(mode);
    const { players, teams } = summarize(state);
    results[mode] = { players, teams, log: state.gameLog };

    for (const [name, want] of Object.entries(EXPECT_PLAYERS)) {
      const got = players[name];
      check(`${name.padEnd(8)} ${fmt(want)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${fmt(got)}`);
    }
    const teamOk = JSON.stringify(Object.keys(teams).sort()) === JSON.stringify(Object.keys(EXPECT_TEAMS).sort())
      && Object.entries(EXPECT_TEAMS).every(([a, w]) => JSON.stringify(teams[a]) === JSON.stringify(w));
    check('every team row matches the sheet', teamOk,
      teamOk ? '' : Object.entries(EXPECT_TEAMS)
        .filter(([a, w]) => JSON.stringify(teams[a]) !== JSON.stringify(w))
        .map(([a, w]) => `${a} want ${fmt(w)} got ${teams[a] ? fmt(teams[a]) : 'nothing'}`).join('; '));
    check('all 12 games logged', state.gameLog.length === 12, `${state.gameLog.length}`);
    check('each game logged under its own date',
      state.gameLog.every((g, i) => g.date === GAMES[i].date), '');
    check('holder at the end is DAL', state.champion === 'DAL', state.champion);
    const days = Object.values(players).reduce((s, p) => s + p.days, 0);
    check('days add up to the elapsed season (28)', days === 28, `${days}`);
  }

  console.log('\nTIMING INDEPENDENCE');
  const same = (a, b) => JSON.stringify(results[a]) === JSON.stringify(results[b]);
  check('real and prompt timing agree', same('real', 'prompt'));
  check('late and prompt timing agree', same('late', 'prompt'));

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
