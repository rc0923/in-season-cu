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

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] ?? '*'),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
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
      capacity: s.capacity,
      season: s.season,
      seasonStart: s.seasonStart,
      seasonEnd: s.seasonEnd,
      startChampion: s.startChampion,
      players: s.players.map(p => ({ id: p.id, name: p.name })),
      order: s.order.map(id => ({ id, name: byId[id] ?? '?' })),
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
      try { ws.send(msg); } catch { /* peer gone; close handler cleans up */ }
    }
  }

  // -- actions --------------------------------------------------------------

  join(s, { name, playerId }) {
    const clean = String(name ?? '').trim().slice(0, 20);

    // Reclaiming a seat after a refresh or a dropped connection.
    if (playerId) {
      const existing = s.players.find(p => p.id === playerId);
      if (existing) {
        if (clean && s.phase === 'lobby') existing.name = clean;
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
    s.players.push({ id, name: clean });
    return { ok: true, playerId: id };
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

    if (tail === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426, headers: cors });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const s = await this.load();
      try { pair[1].send(JSON.stringify({ type: 'state', state: this.view(s) })); } catch {}
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (tail === 'export') {
      const s = await this.load();
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
      const s = await this.load();
      return json(this.view(s), { status: 200 }, cors);
    }

    return json({ error: 'not_found' }, { status: 404 }, cors);
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const s = await this.load();
    let result = { ok: false, error: 'unknown_action' };

    switch (msg.type) {
      case 'join':  result = this.join(s, msg); break;
      case 'leave': result = this.leave(s, msg.playerId); break;
      case 'start': result = this.start(s); break;
      case 'pick':  result = this.pick(s, msg.playerId, msg.team); break;
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
  }

  // The runtime auto-replies to Close frames on this compatibility date, so
  // there is nothing to do here beyond letting the socket drop out of
  // ctx.getWebSockets() on its own.
  async webSocketError(ws, error) {
    console.error(JSON.stringify({ event: 'websocket_error', error: String(error) }));
  }
}
