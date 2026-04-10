# In Season Cup

Auto-updating NHL In Season Stanley Cup tracker. Hosted on GitHub Pages, updates automatically after each game.

## How it works

- `index.html` — the app, reads all data from `state.json`
- `state.json` — single source of truth (champion, standings, game log)
- `.github/workflows/update-cup.yml` — runs 4x per day, checks the NHL API, updates `state.json` if a new game finished, commits the result
- GitHub Pages serves the latest `index.html` + `state.json` automatically

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

At the start of next season:
1. Edit `state.json` — reset all stats to 0, update `champion` to the first team, clear `gameLog`
2. Update `season` field to the new year (e.g. `"2026-27"`)
3. Commit — done
