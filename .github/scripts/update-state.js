#!/usr/bin/env node
/**
 * .github/scripts/update-state.js
 *
 * Checks the NHL API for the champion's most recent completed game.
 * If a new final game is found, updates state.json:
 *   - Adds the game to the log
 *   - Updates the champion (if they lost, the winner takes over)
 *   - Updates days, wins, losses, reigns, streak for all relevant teams
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_PATH = path.join(__dirname, '../../state.json');
const NHL_BASE = 'https://api-web.nhle.com/v1';

// ── helpers ──────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    }).on('error', reject)
      .setTimeout(10000, function() { this.destroy(new Error('timeout')); });
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ownerOf(state, abbr) {
  return state.players.find(p => p.teams.some(t => t.abbr === abbr)) ?? null;
}

function teamStatOf(player, abbr) {
  return player.teams.find(t => t.abbr === abbr) ?? null;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const champion = state.champion;
  const alreadyLogged = new Set(state.gameLog.map(g => String(g.num)));

  console.log(`Current champion: ${champion}`);
  console.log(`Checking schedule for today: ${today()}`);

  // Fetch today's schedule
  let schedule;
  try {
    schedule = await get(`${NHL_BASE}/schedule/${today()}`);
  } catch (e) {
    console.error('Failed to fetch schedule:', e.message);
    process.exit(0); // exit cleanly — don't crash the action
  }

  const games = schedule?.gameWeek?.flatMap(w => w.games) ?? [];
  console.log(`Found ${games.length} games on schedule today`);

  // Find a FINAL game featuring the champion
  const champGame = games.find(g => {
    const teams = [g.awayTeam?.abbrev, g.homeTeam?.abbrev];
    const isFinal = ['OFF', 'FINAL'].includes(g.gameState);
    return teams.includes(champion) && isFinal;
  });

  if (!champGame) {
    console.log(`No final game found for ${champion} today. Nothing to update.`);
    process.exit(0);
  }

  const gameId = String(champGame.id);

  // Check if we already logged this game (by NHL game id stored in a field)
  const alreadyLoggedById = state.gameLog.some(g => g.nhlGameId === gameId);
  if (alreadyLoggedById) {
    console.log(`Game ${gameId} already logged. Nothing to do.`);
    process.exit(0);
  }

  const away = champGame.awayTeam;
  const home = champGame.homeTeam;
  const awayScore = away.score ?? 0;
  const homeScore = home.score ?? 0;

  console.log(`Final game found: ${away.abbrev} ${awayScore} @ ${home.abbrev} ${homeScore}`);

  // Determine winner and loser
  const champIsHome = home.abbrev === champion;
  const champScore  = champIsHome ? homeScore : awayScore;
  const oppScore    = champIsHome ? awayScore : homeScore;
  const oppAbbr     = champIsHome ? away.abbrev : home.abbrev;
  const champWon    = champScore > oppScore;

  console.log(`Champion (${champion}) ${champWon ? 'WON' : 'LOST'} ${champScore}-${oppScore} vs ${oppAbbr}`);

  // ── Update state ──────────────────────────────────────────────────────────

  const nextGameNum = Math.max(...state.gameLog.map(g => g.num), 0) + 1;

  // Add game to log
  state.gameLog.push({
    num:       nextGameNum,
    date:      today(),
    visitor:   away.abbrev,
    home:      home.abbrev,
    score:     `${awayScore}-${homeScore}`,
    nhlGameId: gameId
  });

  // Update champion team's owner stats
  const champOwner = ownerOf(state, champion);
  if (champOwner) {
    const champTeamStat = teamStatOf(champOwner, champion);
    if (champTeamStat) {
      champTeamStat.days += 1;
      if (champWon) {
        champTeamStat.wins  += 1;
        champOwner.wins     += 1;
        champOwner.days     += 1;
        // streak is tracked on the team level as current streak
        // longestStreak is the record
        champTeamStat.currentStreak = (champTeamStat.currentStreak ?? 0) + 1;
        if (champTeamStat.currentStreak > champTeamStat.longestStreak) {
          champTeamStat.longestStreak = champTeamStat.currentStreak;
          if (champTeamStat.longestStreak > champOwner.streak) {
            champOwner.streak = champTeamStat.longestStreak;
          }
        }
      } else {
        champTeamStat.losses     += 1;
        champOwner.losses        += 1;
        champOwner.days          += 1;
        champTeamStat.currentStreak = 0;
      }
    }
  }

  // If champion lost — transfer cup to winner
  if (!champWon) {
    const newChampion = oppAbbr;
    console.log(`Cup transfers to ${newChampion}`);

    state.champion = newChampion;

    const newOwner = ownerOf(state, newChampion);
    if (newOwner) {
      const newTeamStat = teamStatOf(newOwner, newChampion);
      if (newTeamStat) {
        newTeamStat.reigns       += 1;
        newTeamStat.currentStreak = 1;
        newOwner.reigns          += 1;
      }
    }
  } else {
    // Champion defended — increment reigns only on first win of a new reign
    // (reigns already counted on transfer, so nothing extra here)
  }

  state.lastUpdated = today();

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`state.json updated. New champion: ${state.champion}`);
}

main().catch(e => {
  console.error('Updater error:', e);
  process.exit(1);
});
