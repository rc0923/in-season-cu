/**
 * worker/src/index.js
 *
 * The In Season Cup draft room.
 *
 * A Durable Object holds one live draft: players join a lobby, the pick order is
 * drawn at random once the room is full, and a snake draft runs until every NHL
 * team is owned. The finished room emits a ready-to-commit state.json.
 *
 * Routes (all under /room/:name):
 *   GET  /room/:name/ws       WebSocket - the live room
 *   GET  /room/:name          JSON snapshot of room state
 *   GET  /room/:name/export   the finished season's state.json (409 until done)
 *   POST /room/:name/reset    wipe the room (requires X-Admin-Token)
 */

import { DurableObject } from 'cloudflare:workers';

const TEAMS = [
  'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ', 'DAL', 'DET',
  'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH', 'NJD', 'NYI', 'NYR', 'OTT',
  'PHI', 'PIT', 'SJS', 'SEA', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK',
  'WSH', 'WPG',
];

// Only capacities that divide the 32 teams evenly, so every player ends up with
// the same number of teams and no team goes unowned.
const ALLOWED_CAPACITIES = [2, 4, 8];

// Bots exist so one person can rehearse a whole draft alone. They are allowed
// only in rooms named "practice…", which is what keeps them out of a real draft.
const BOT_DELAY_MS = 1400;
const isPracticeRoom = (room) => /^practice/i.test(room ?? '');

// A socket that keeps guessing the password gets dropped.
const MAX_AUTH_ATTEMPTS = 6;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] ?? '*'),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Draft-Password',
    'Vary': 'Origin',
  };
}

function json(body, init, extra) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(extra ?? {}), ...(init?.headers ?? {}) },
  });
}

/**
 * Constant-time secret comparison. Hashing first gives both sides a fixed
 * length, so timingSafeEqual cannot throw on a length mismatch and the
 * comparison leaks neither the contents nor the length of the real token.
 */
async function secretsMatch(a, b) {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/**
 * A uniformly random integer in [0, n). Rejection sampling discards the tail
 * that would otherwise make the first few values very slightly likelier —
 * this decides pick order, so it should be genuinely fair.
 */
function randomBelow(n) {
  const limit = Math.floor(4294967296 / n) * n;
  const buf = new Uint32Array(1);
  let v;
  do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return v % n;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'room' || !parts[1]) {
      return json({ error: 'not_found', hint: 'use /room/:name' }, { status: 404 }, cors);
    }

    const roomName = decodeURIComponent(parts[1]).slice(0, 64);

    // Reset is authenticated here rather than inside the Durable Object: the DO
    // is only reachable through this binding, so rejecting a bad token before
    // the object is ever addressed keeps the destructive path at the edge.
    if (parts[2] === 'reset' && request.method === 'POST') {
      const token = request.headers.get('X-Admin-Token') ?? '';
      if (!await secretsMatch(token, env.ADMIN_TOKEN)) {
        return json({ error: 'unauthorized' }, { status: 401 }, cors);
      }
    }

    return env.DRAFT_ROOM.getByName(roomName).fetch(request);
  },
};

export class DraftRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime itself, so a phone keeping its
    // socket warm never wakes the object out of hibernation.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  // -- state ----------------------------------------------------------------

  fresh() {
    const capacity = Number(this.env.CAPACITY ?? 4);
    return {
      phase: 'lobby',                       // lobby | drafting | done
      room: '',                             // set on first request, from the URL
      practice: false,                      // practice rooms may add bots
      capacity: ALLOWED_CAPACITIES.includes(capacity) ? capacity : 4,
      season: this.env.SEASON ?? '',
      seasonStart: this.env.SEASON_START ?? '',
      seasonEnd: this.env.SEASON_END ?? '',
      startChampion: this.env.START_CHAMPION ?? '',
      players: [],                          // { id, name }
      order: [],                            // player ids, drawn at random
      picks: [],                            // { team, playerId, round, overall }
      startedAt: null,
      finishedAt: null,
    };
  }

  async load() {
    let s = await this.ctx.storage.get('state');
    if (!s) { s = this.fresh(); await this.ctx.storage.put('state', s); }
    return s;
  }

  async save(s) { await this.ctx.storage.put('state', s); }

  // -- authentication --------------------------------------------------------

  /**
   * Which role a password earns, or null to refuse. The comparison happens here
   * rather than in the page: the WebSocket is public, so a client-side check
   * would be bypassed by talking to the room directly.
   *
   * Practice rooms are gated exactly like real ones, so a rehearsal exercises
   * the same door the players will meet on the night. What practice changes is
   * what you may do once inside, not who gets in.
   */
  async roleFor(s, password, adminOnly = false) {
    const pw = String(password ?? '');
    if (this.env.ADMIN_PASSWORD && await secretsMatch(pw, this.env.ADMIN_PASSWORD)) return 'admin';
    // Someone deliberately reaching for admin must produce the admin password,
    // rather than falling through and being handed "player" as a false success.
    if (adminOnly) return null;
    if (this.env.DRAFT_PASSWORD && await secretsMatch(pw, this.env.DRAFT_PASSWORD)) return 'player';
    return null;
  }

  /** Whether any room can be entered at all. Fails closed. */
  passwordsConfigured() {
    return Boolean(this.env.DRAFT_PASSWORD || this.env.ADMIN_PASSWORD);
  }

  // Socket role lives on the connection's attachment so it survives hibernation.
  setSocketRole(ws, role, attempts) {
    try { ws.serializeAttachment({ role: role ?? null, attempts: attempts ?? 0 }); } catch {}
  }
  socketInfo(ws) {
    try { return ws.deserializeAttachment() ?? { role: null, attempts: 0 }; }
    catch { return { role: null, attempts: 0 }; }
  }
  socketRole(ws) { return this.socketInfo(ws).role; }

  /** A Durable Object is not told its own name, so learn it from the first request. */
  async ensureRoom(s, roomName) {
    if (s.room === roomName) return s;
    s.room = roomName;
    s.practice = isPracticeRoom(roomName);
    await this.save(s);
    return s;
  }

  // -- draft mechanics ------------------------------------------------------

  rounds(s) { return TEAMS.length / s.capacity; }

  /** Whose turn it is, or null if the draft is not running. */
  onClock(s) {
    if (s.phase !== 'drafting' || !s.order.length) return null;
    const n = s.order.length;
    const i = s.picks.length;
    if (i >= TEAMS.length) return null;
    const round = Math.floor(i / n);
    // snake: even rounds run forward, odd rounds run back
    const seat = round % 2 === 0 ? i % n : n - 1 - (i % n);
    return s.order[seat];
  }

  takenTeams(s) { return new Set(s.picks.map(p => p.team)); }

  /** Public view of the room, safe to broadcast to everyone. */
  view(s) {
    const byId = Object.fromEntries(s.players.map(p => [p.id, p.name]));
    return {
      phase: s.phase,
      practice: s.practice,
      capacity: s.capacity,
      season: s.season,
      seasonStart: s.seasonStart,
      seasonEnd: s.seasonEnd,
      startChampion: s.startChampion,
      players: s.players.map(p => ({ id: p.id, name: p.name, bot: !!p.bot, admin: !!p.admin })),
      order: s.order.map(id => ({
        id, name: byId[id] ?? '?',
        bot: !!s.players.find(p => p.id === id)?.bot,
      })),
      picks: s.picks.map(p => ({ ...p, name: byId[p.playerId] ?? '?' })),
      onClock: this.onClock(s),
      rounds: this.rounds(s),
      totalPicks: TEAMS.length,
      teams: TEAMS,
    };
  }

  async broadcast(s) {
    const msg = JSON.stringify({ type: 'state', state: this.view(s) });
    for (const ws of this.ctx.getWebSockets()) {
      if (!this.socketRole(ws)) continue;   // never leak the board to an unauthenticated peer
      try { ws.send(msg); } catch { /* peer gone; close handler cleans up */ }
    }
  }

  // -- actions --------------------------------------------------------------

  join(s, { name, playerId }, role) {
    const clean = String(name ?? '').trim().slice(0, 20);

    // Reclaiming a seat after a refresh or a dropped connection.
    if (playerId) {
      const existing = s.players.find(p => p.id === playerId);
      if (existing) {
        if (clean && s.phase === 'lobby') existing.name = clean;
        existing.admin = role === 'admin';
        return { ok: true, playerId: existing.id };
      }
    }

    if (s.phase !== 'lobby') return { ok: false, error: 'draft_already_started' };
    if (!clean) return { ok: false, error: 'name_required' };
    if (s.players.length >= s.capacity) return { ok: false, error: 'room_full' };
    if (s.players.some(p => p.name.toLowerCase() === clean.toLowerCase())) {
      return { ok: false, error: 'name_taken' };
    }

    const id = crypto.randomUUID();
    s.players.push({ id, name: clean, admin: role === 'admin' });
    return { ok: true, playerId: id };
  }

  addBot(s, role) {
    // Bots are a rehearsal tool, and only the person running the draft should
    // be able to seat one — in any room, practice included.
    if (role !== 'admin') return { ok: false, error: 'bots_admin_only' };
    if (s.phase !== 'lobby') return { ok: false, error: 'draft_already_started' };
    if (s.players.length >= s.capacity) return { ok: false, error: 'room_full' };

    const n = s.players.filter(p => p.bot).length + 1;
    s.players.push({ id: crypto.randomUUID(), name: `Bot ${n}`, bot: true });
    return { ok: true };
  }

  // -- admin actions ---------------------------------------------------------

  /** Walk the most recent pick back and hand the clock to whoever made it. */
  undoLastPick(s) {
    if (!s.picks.length) return { ok: false, error: 'nothing_to_undo' };
    if (s.phase === 'lobby') return { ok: false, error: 'not_drafting' };

    const undone = s.picks.pop();
    // Completing the draft locks the room; walking a pick back reopens it.
    if (s.phase === 'done') { s.phase = 'drafting'; s.finishedAt = null; }
    return { ok: true, undone: undone.team };
  }

  /** Swap one completed pick for a team nobody owns; the old team returns to the pool. */
  replacePick(s, overall, team) {
    const entry = s.picks.find(p => p.overall === Number(overall));
    if (!entry) return { ok: false, error: 'no_such_pick' };

    const abbr = String(team ?? '').toUpperCase();
    if (!TEAMS.includes(abbr)) return { ok: false, error: 'unknown_team' };
    if (abbr === entry.team) return { ok: false, error: 'same_team' };
    if (this.takenTeams(s).has(abbr)) return { ok: false, error: 'team_taken' };

    entry.team = abbr;
    return { ok: true };
  }

  removePlayer(s, playerId) {
    if (s.phase !== 'lobby') return { ok: false, error: 'draft_already_started' };
    const before = s.players.length;
    s.players = s.players.filter(p => p.id !== playerId);
    if (s.players.length === before) return { ok: false, error: 'no_such_player' };
    // Bot numbering stays contiguous so a removed bot does not leave a gap.
    let n = 0;
    s.players.forEach(p => { if (p.bot) p.name = `Bot ${++n}`; });
    return { ok: true };
  }

  /**
   * If a bot is on the clock, wake up shortly and pick for it. Driving bots from
   * an alarm rather than from a client means the draft carries on even if the
   * only human reloads the page or locks their phone.
   */
  async scheduleBotTurn(s) {
    if (s.phase !== 'drafting') return;
    const onClock = s.players.find(p => p.id === this.onClock(s));
    if (onClock?.bot) await this.ctx.storage.setAlarm(Date.now() + BOT_DELAY_MS);
  }

  async alarm() {
    const s = await this.load();
    if (s.phase !== 'drafting') return;

    const onClock = s.players.find(p => p.id === this.onClock(s));
    if (!onClock?.bot) return;

    const taken = this.takenTeams(s);
    const available = TEAMS.filter(t => !taken.has(t));
    if (!available.length) return;

    this.pick(s, onClock.id, available[randomBelow(available.length)]);
    await this.save(s);
    await this.broadcast(s);
    await this.scheduleBotTurn(s);   // consecutive bots keep the chain going
  }

  leave(s, playerId) {
    if (s.phase !== 'lobby') return { ok: false, error: 'draft_already_started' };
    const before = s.players.length;
    s.players = s.players.filter(p => p.id !== playerId);
    return { ok: s.players.length !== before, error: 'not_in_room' };
  }

  start(s) {
    if (s.phase !== 'lobby') return { ok: false, error: 'already_started' };
    if (s.players.length !== s.capacity) return { ok: false, error: 'room_not_full' };

    // Fisher-Yates over the player ids: the random draw.
    const ids = s.players.map(p => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = randomBelow(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    s.order = ids;
    s.phase = 'drafting';
    s.startedAt = new Date().toISOString();
    return { ok: true };
  }

  pick(s, playerId, team) {
    if (s.phase !== 'drafting') return { ok: false, error: 'not_drafting' };
    if (this.onClock(s) !== playerId) return { ok: false, error: 'not_your_turn' };

    const abbr = String(team ?? '').toUpperCase();
    if (!TEAMS.includes(abbr)) return { ok: false, error: 'unknown_team' };
    if (this.takenTeams(s).has(abbr)) return { ok: false, error: 'team_taken' };

    const overall = s.picks.length + 1;
    s.picks.push({
      team: abbr,
      playerId,
      round: Math.floor((overall - 1) / s.order.length) + 1,
      overall,
    });

    if (s.picks.length === TEAMS.length) {
      s.phase = 'done';
      s.finishedAt = new Date().toISOString();
    }
    return { ok: true };
  }

  // -- the finished season --------------------------------------------------

  buildSeasonState(s) {
    const teamsFor = id => s.picks
      .filter(p => p.playerId === id)
      .sort((a, b) => a.overall - b.overall)
      .map(p => p.team);

    return {
      champion: s.startChampion,
      startingChampion: s.startChampion,
      // Dating both to opening night stops the day counter accruing days
      // between the draft and the first puck drop.
      lastUpdated: s.seasonStart,
      lastDayTick: s.seasonStart,
      season: s.season,
      seasonEndDate: s.seasonEnd,
      seasonOver: false,
      players: s.order.map(id => ({
        name: s.players.find(p => p.id === id)?.name ?? '?',
        days: 0, reigns: 0, wins: 0, losses: 0, streak: 0,
        teams: teamsFor(id).map(abbr => ({
          abbr, days: 0, reigns: 0, wins: 0, losses: 0,
          longestStreak: 0, currentStreak: 0,
        })),
      })),
      gameLog: [],
    };
  }

  // -- HTTP + WebSocket -----------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, this.env);
    const parts = url.pathname.split('/').filter(Boolean);
    const tail = parts[2] ?? '';
    const roomName = decodeURIComponent(parts[1] ?? '').slice(0, 64);

    if (tail === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426, headers: cors });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.setSocketRole(pair[1], null, 0);
      const s = await this.ensureRoom(await this.load(), roomName);
      // No room state until the peer authenticates. The password is never put
      // in the upgrade URL, so it arrives as the first message instead.
      try { pair[1].send(JSON.stringify({ type: 'authRequired' })); } catch {}
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (tail === 'export') {
      const s = await this.ensureRoom(await this.load(), roomName);
      const role = await this.roleFor(s, request.headers.get('X-Draft-Password'));
      if (!role) {
        return json({ error: 'unauthorized' }, { status: 401 }, cors);
      }
      // The finished season is the admin's to commit, so only the admin can
      // fetch it. Hiding the button alone would leave the endpoint open.
      if (role !== 'admin') {
        return json({ error: 'admin_only' }, { status: 403 }, cors);
      }
      if (s.phase !== 'done') {
        return json({ error: 'draft_not_finished', phase: s.phase }, { status: 409 }, cors);
      }
      return json(this.buildSeasonState(s), { status: 200 }, cors);
    }

    // Already authenticated by the parent Worker before it reached this object.
    if (tail === 'reset' && request.method === 'POST') {
      const s = this.fresh();
      await this.save(s);
      await this.broadcast(s);
      return json({ ok: true, reset: true }, { status: 200 }, cors);
    }

    if (tail === '') {
      const s = await this.ensureRoom(await this.load(), roomName);
      if (!await this.roleFor(s, request.headers.get('X-Draft-Password'))) {
        return json({ error: 'unauthorized' }, { status: 401 }, cors);
      }
      return json(this.view(s), { status: 200 }, cors);
    }

    return json({ error: 'not_found' }, { status: 404 }, cors);
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const s = await this.load();

    // ── authentication ──────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      if (!this.passwordsConfigured()) {
        try { ws.send(JSON.stringify({ type: 'authFail', error: 'draft_password_not_configured' })); } catch {}
        return;
      }
      const role = await this.roleFor(s, msg.password, msg.elevate === true);
      if (!role) {
        // Keep whatever role this socket already had: mistyping the admin
        // password should not kick an authenticated player out of the draft.
        const prev = this.socketInfo(ws);
        const attempts = prev.attempts + 1;
        this.setSocketRole(ws, prev.role, attempts);
        try { ws.send(JSON.stringify({ type: 'authFail', error: 'bad_password' })); } catch {}
        if (attempts >= MAX_AUTH_ATTEMPTS) { try { ws.close(4003, 'too many attempts'); } catch {} }
        return;
      }
      this.setSocketRole(ws, role, 0);
      try {
        ws.send(JSON.stringify({ type: 'authOk', role }));
        ws.send(JSON.stringify({ type: 'state', state: this.view(s) }));
      } catch {}
      return;
    }

    // Everything else requires an authenticated socket. Unauthenticated peers
    // are told nothing about the room, not even that it exists.
    const role = this.socketRole(ws);
    if (!role) {
      try { ws.send(JSON.stringify({ type: 'authRequired' })); } catch {}
      return;
    }

    // A practice room is disposable by definition, so anyone in one may wipe it
    // and start again. That keeps a single well-known practice room reusable
    // instead of needing a fresh name for every rehearsal.
    // Dropping a role has to happen on the server: clearing it only in the page
    // would leave this connection still authorised to run admin actions.
    if (msg.type === 'signOut') {
      this.setSocketRole(ws, null, 0);
      const me = s.players.find(p => p.id === msg.playerId);
      if (me?.admin) {
        me.admin = false;
        await this.save(s);
        await this.broadcast(s);
      }
      try { ws.send(JSON.stringify({ type: 'authRequired' })); } catch {}
      return;
    }

    const adminOnly = ['undoPick', 'replacePick', 'removePlayer']
      .concat(s.practice ? [] : ['resetRoom']);
    if (adminOnly.includes(msg.type) && role !== 'admin') {
      try { ws.send(JSON.stringify({ type: 'error', error: 'admin_only' })); } catch {}
      return;
    }

    let result = { ok: false, error: 'unknown_action' };

    switch (msg.type) {
      case 'join':    result = this.join(s, msg, role); break;
      case 'leave':   result = this.leave(s, msg.playerId); break;
      case 'addBot':  result = this.addBot(s, role); break;
      case 'start':   result = this.start(s); break;
      case 'pick':    result = this.pick(s, msg.playerId, msg.team); break;

      case 'undoPick':     result = this.undoLastPick(s); break;
      case 'replacePick':  result = this.replacePick(s, msg.overall, msg.team); break;
      case 'removePlayer': result = this.removePlayer(s, msg.playerId); break;
      case 'resetRoom': {
        const fresh = this.fresh();
        fresh.room = s.room;
        fresh.practice = s.practice;
        // Clear the stored draft outright rather than writing over it, so a
        // reset room keeps nothing — including any pending bot alarm.
        await this.ctx.storage.deleteAll();
        await this.save(fresh);
        await this.broadcast(fresh);
        return;
      }
    }

    if (!result.ok) {
      try { ws.send(JSON.stringify({ type: 'error', error: result.error })); } catch {}
      return;
    }

    await this.save(s);
    if (result.playerId) {
      try { ws.send(JSON.stringify({ type: 'joined', playerId: result.playerId })); } catch {}
    }
    await this.broadcast(s);
    await this.scheduleBotTurn(s);
  }

  // The runtime auto-replies to Close frames on this compatibility date, so
  // there is nothing to do here beyond letting the socket drop out of
  // ctx.getWebSockets() on its own.
  async webSocketError(ws, error) {
    console.error(JSON.stringify({ event: 'websocket_error', error: String(error) }));
  }
}
