# In Season Cup

Auto-updating NHL In Season Stanley Cup tracker. Hosted on GitHub Pages, updates automatically after each game.

## How it works

- `index.html` — the app, reads all data from `state.json`
- `state.json` — single source of truth (champion, standings, game log)
- `.github/workflows/update-cup.yml` — runs 4x per day, checks the NHL API, updates `state.json` if a new game finished, commits the result
- `summary.html` — end-of-season recap; `?season=2025-26` renders an archived season
- `seasons/` — frozen `state.json` of every finished season, indexed by `seasons/index.json`
- `draft.html` + `worker/` — the live draft room used to set up a new season
- GitHub Pages serves the latest `index.html` + `state.json` automatically

### The NHL API is reached two different ways

The two halves of this app talk to the NHL differently, and the difference matters:

- **The workflow** (`update-state.js`) calls `https://api-web.nhle.com/v1` directly. It runs in Node on a GitHub runner, so there is no browser and no CORS enforcement.
- **The browser** (`index.html`) calls it through a Cloudflare Worker proxy at `https://nhl-proxy.rc0923.workers.dev`. The NHL API does not send an `Access-Control-Allow-Origin` header, so a direct `fetch()` from the GitHub Pages origin is blocked by the browser even though the request itself succeeds. The Worker fetches upstream and re-serves the response with CORS headers attached.

The Worker lives outside this repo. If it ever goes away, the "Next Game" box and the eliminated-team shading stop working, while the rest of the page (which reads only `state.json`) keeps working normally.

### Give the workflow permission to commit

1. Go to **Settings → Actions → General**
2. Scroll to **Workflow permissions**
3. Select **Read and write permissions**
4. Click **Save**

### Test the workflow

1. Go to **Actions** tab in your repo
2. Click **Update Cup State** in the left sidebar
3. Click **Run workflow → Run workflow**
4. Watch it run — if the champion played today and the game is final, `state.json` will be updated

---

## How updates work after setup

The workflow runs automatically at:
- 11pm ET (catches late West Coast games finishing)
- 2am ET (catches any overtime games)
- 5am ET (backup)
- 8am ET (morning check)

When it runs:
1. Checks today's NHL schedule for a game involving the current champion
2. If the game is final — updates `state.json`:
   - Adds the game to the log
   - Updates wins/losses/days for the champion team
   - If the champion lost — transfers the cup to the winning team, increments their reigns
3. Commits the updated `state.json` back to the repo
4. GitHub Pages automatically serves the new version (usually within 1-2 minutes)

---

## Manually fixing data

If the auto-update gets something wrong (it shouldn't, but just in case), edit `state.json` directly on GitHub:

1. Click `state.json` in the repo
2. Click the pencil ✏️ icon to edit
3. Make your change
4. Click **Commit changes**

The site updates within a minute or two.

---

## New season setup

A new season is drafted live in the browser at [`draft.html`](draft.html). Four
players open the link on their own phones, enter their names, and once every seat
is taken the pick order is drawn at random and a snake draft runs for 8 rounds
until all 32 teams are owned. The finished room hands you a ready-to-commit
`state.json`.

### Running a draft

1. Archive the season that just ended (see **Archiving a season** below).
2. Update the season vars in `worker/wrangler.jsonc` and `DEFAULT_ROOM` in
   `draft.html`, then redeploy the worker (see **The draft worker**).
3. Send everyone the link to `draft.html`, plus the draft password.
4. Each player enters the password, then a name, and joins. The **Draw Order & Start** button turns on
   once the room is full — anybody in the room can press it.
5. Draft. Only the player on the clock can pick; taken teams grey out for everyone.
6. When the last team goes, press **Download state.json**.
7. Replace `state.json` in the repo root with that file and commit. The site picks
   it up within a minute or two.

Refreshing the page or losing signal is safe — your seat is remembered in the
browser and reclaimed automatically when you come back.

### Passwords

The real draft room is password protected so a stranger with the link cannot
take a seat. There are two passwords, both stored as Cloudflare secrets:

```
cd worker
npx wrangler secret put DRAFT_PASSWORD    # give this one to the players
npx wrangler secret put ADMIN_PASSWORD    # keep this one to yourself
```

Entering `DRAFT_PASSWORD` gets you a normal seat. Entering `ADMIN_PASSWORD`
gets you a seat *plus* admin controls — you still draft like everyone else.

The password is checked in the worker, never in the page, because the
WebSocket is public and a client-side check could simply be skipped. It is
typed into a field rather than passed in the URL, so it stays out of browser
history and screenshots, and it is remembered per browser so a reload
mid-draft does not lock anyone out. Six wrong guesses drops the connection.

Until a password is set, a real room refuses everyone. Practice rooms stay
open — no password needed — so rehearsals are frictionless. The **Admin** link
in the header is how you enter the admin password from inside a room you are
already in, which is the only way to get admin in an open practice room.

Nobody without a password sees anything: no board, no names, no picks. The
JSON snapshot and `/export` also require the password, via an
`X-Draft-Password` header.

### Admin controls

Whoever entered `ADMIN_PASSWORD` gets:

| Control | What it does |
| --- | --- |
| **Undo last pick** | Removes the most recent pick and hands the clock back. Press repeatedly to walk several picks back. Works after the draft has finished, which reopens it. |
| **Re-assign a pick** | Tap any drafted team in the rosters, then tap a free team on the board. The old team returns to the pool; the pick keeps its owner and slot. |
| **Remove a player** | The ✕ on a seat in the lobby. Bots are renumbered so there is no gap. |
| **Reset room** | Wipes the room back to an empty lobby. Asks for confirmation first. |

Admin actions are authorised from the connection's own role on the server, not
from anything the page claims, so a player cannot invoke them by crafting a
message.

### Checking the room is healthy

Before a real draft — and after rotating passwords or deploying — run:

```
cd worker
npm run verify
```

It checks the deployed worker against a disposable room, so a real draft is
never touched. The first half needs no secrets: it confirms passwords are
actually configured, that an unauthenticated peer gets nothing at all, that
guessing drops the connection, and that every HTTP endpoint refuses a wrong
password. The second half prompts for both passwords with hidden input and
confirms the draft password grants a player seat, the admin password grants
admin, a player is refused admin controls, and — importantly — that the two
passwords are different. Identical passwords would quietly make everyone admin.

Nothing you type is echoed or written to your shell history, and only PASS/FAIL
lines are printed. It exits non-zero if anything fails.

```
npm run verify -- --skip-passwords    # only the checks needing no secrets
ISC_HOST=127.0.0.1:8788 npm run verify   # against a local `wrangler dev`
```

### Rehearsing a draft on your own

You do not need four people to try the draft. Open a practice room:

```
draft.html?room=practice
```

Join with your name, then press **Add a bot** until the room is full and start as
normal. Bots pick for themselves after a short pause, so one person can run a
complete 32-team draft alone and see exactly what everyone else will see.

Bots are driven by the room itself rather than by your browser, so the draft
carries on if you reload the page or your phone locks. Any room name starting
with `practice` works — `?room=practice-2`, `?room=practice-phones` — which
means you can leave old rehearsals lying around without them getting in the way.

**Bots are refused in any room not named `practice…`**, so there is no way to
accidentally fill the real draft with them. A practice room can still export a
`state.json`; just do not commit it.

### The draft worker

The live room is a Cloudflare Durable Object in `worker/`. Deploy it once:

```
cd worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN     # any random string; gates room resets
```

Season settings live in `worker/wrangler.jsonc` under `vars`:

| var | meaning |
| --- | --- |
| `SEASON` | e.g. `2026-27` — written into the exported `state.json` |
| `SEASON_START` | opening night; the day counter starts here, not on draft day |
| `SEASON_END` | last day of the regular season; flips `seasonOver` when reached |
| `START_CHAMPION` | the team holding the cup at puck drop — the reigning Stanley Cup winner |
| `CAPACITY` | players in the draft. Must divide 32 evenly: `2`, `4` or `8` |
| `ALLOWED_ORIGINS` | comma-separated origins allowed to call `/export` |

To run a second draft in the same room (a do-over), reset it:

```
curl -X POST -H "X-Admin-Token: YOUR_TOKEN" \
  https://isc-draft.rc0923.workers.dev/room/2026-27/reset
```

Or just draft into a fresh room by opening `draft.html?room=anything-else`.

To develop against a local worker instead of the deployed one:

```
cd worker && npx wrangler dev          # serves on 127.0.0.1:8787
# then open draft.html?worker=http://127.0.0.1:8787&room=test
```

### Archiving a season

Finished seasons are frozen in `seasons/` so the summary page keeps working after
`state.json` is replaced:

1. `cp state.json seasons/<season>.json` (e.g. `seasons/2025-26.json`)
2. Add that season id to `seasons/index.json`
3. Commit

The archived recap is then permanently available at
`summary.html?season=2025-26`, and the tracker links to it automatically.

### Doing it by hand instead

If you would rather not run a draft, edit `state.json` directly: reset all stats to
0, set `champion` and `startingChampion` to the opening cup holder, clear
`gameLog`, update `season`, set `seasonEndDate` to the last day of the regular
season, set `lastUpdated` and `lastDayTick` to opening night, and set `seasonOver`
back to `false`.

There is also an older interactive CLI, `node new-season.js`, which walks through
the same fields and writes `state.json` for a manually agreed set of teams.
