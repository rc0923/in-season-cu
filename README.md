# BStash In Season Cup

Auto-updating NHL In Season Stanley Cup tracker. Hosted on GitHub Pages, updates automatically after each game.

## How it works

- `index.html` — the app, reads all data from `state.json`
- `state.json` — single source of truth (champion, standings, game log)
- `.github/workflows/update-cup.yml` — runs 4x per day, checks the NHL API, updates `state.json` if a new game finished, commits the result
- GitHub Pages serves the latest `index.html` + `state.json` automatically

## First-time setup (~10 minutes)

### 1. Create the GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Name it `bstash-cup` (or anything you like)
3. Set it to **Public** (required for free GitHub Pages)
4. Don't add a README — leave it empty
5. Click **Create repository**

### 2. Upload the files

On the repo page, click **Add file → Upload files** and upload:
- `index.html`
- `state.json`

Then create the folder structure for the workflow. GitHub's UI can't create empty folders, so use this approach:
1. Click **Add file → Create new file**
2. In the filename box type: `.github/workflows/update-cup.yml`
3. Paste the contents of `update-cup.yml`
4. Click **Commit changes**

Then create the script:
1. Click **Add file → Create new file**
2. Filename: `.github/scripts/update-state.js`
3. Paste the contents of `update-state.js`
4. Commit

### 3. Enable GitHub Pages

1. Go to your repo **Settings → Pages**
2. Under **Source**, select **Deploy from a branch**
3. Branch: `main`, folder: `/ (root)`
4. Click **Save**

After a minute or two your site will be live at:
`https://YOUR-USERNAME.github.io/bstash-cup/`

### 4. Give the workflow permission to commit

1. Go to **Settings → Actions → General**
2. Scroll to **Workflow permissions**
3. Select **Read and write permissions**
4. Click **Save**

### 5. Test the workflow

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
