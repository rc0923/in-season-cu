#!/usr/bin/env node
/**
 * new-season.js
 *
 * Interactive setup script for a new In Season Cup season.
 * Run from the repo root:
 *
 *   node new-season.js
 *
 * Walks you through:
 *   1. Season name (e.g. 2026-27)
 *   2. Starting champion team
 *   3. Number of players
 *   4. Each player's name and teams
 *
 * Writes a fresh state.json when done.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const STATE_PATH = path.join(__dirname, 'state.json');

const VALID_TEAMS = new Set([
    'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ', 'DAL', 'DET',
    'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH', 'NJD', 'NYI', 'NYR', 'OTT',
    'PHI', 'PIT', 'SJS', 'SEA', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK',
    'WSH', 'WPG',
]);

const TEAM_NAMES = {
    ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres',
    CGY: 'Calgary Flames', CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks',
    COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets', DAL: 'Dallas Stars',
    DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
    LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens',
    NSH: 'Nashville Predators', NJD: 'New Jersey Devils', NYI: 'New York Islanders',
    NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers',
    PIT: 'Pittsburgh Penguins', SJS: 'San Jose Sharks', SEA: 'Seattle Kraken',
    STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs',
    UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights',
    WSH: 'Washington Capitals', WPG: 'Winnipeg Jets',
};

// ── readline helpers ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
    return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

function askRequired(question) {
    return new Promise(async resolve => {
        while (true) {
            const ans = await ask(question);
            if (ans) return resolve(ans);
            console.log('  ⚠  This field is required.');
        }
    });
}

function hr() { console.log('─'.repeat(50)); }
function blank() { console.log(''); }

// ── team input ────────────────────────────────────────────────────────────────

async function askTeams(playerName, takenTeams) {
    console.log(`\n  Enter teams for ${playerName} one at a time.`);
    console.log(`  Type the 3-letter abbreviation (e.g. COL) and press Enter.`);
    console.log(`  Type DONE when finished.\n`);

    const teams = [];

    while (true) {
        const raw = await ask(`    Team ${teams.length + 1} (or DONE): `);
        const abbr = raw.toUpperCase();

        if (abbr === 'DONE') {
            if (teams.length === 0) {
                console.log('  ⚠  Add at least one team.');
                continue;
            }
            break;
        }

        if (!VALID_TEAMS.has(abbr)) {
            console.log(`  ⚠  "${abbr}" is not a valid NHL team abbreviation.`);
            console.log(`     Valid teams: ${[...VALID_TEAMS].join(', ')}`);
            continue;
        }

        if (teams.includes(abbr)) {
            console.log(`  ⚠  ${abbr} already added for ${playerName}.`);
            continue;
        }

        if (takenTeams.has(abbr)) {
            console.log(`  ⚠  ${abbr} (${TEAM_NAMES[abbr]}) is already assigned to another player.`);
            continue;
        }

        teams.push(abbr);
        console.log(`  ✓  Added ${abbr} (${TEAM_NAMES[abbr]})`);
    }

    return teams;
}

// ── confirm summary ───────────────────────────────────────────────────────────

async function confirmSummary(season, champion, players) {
    blank();
    hr();
    console.log('  SUMMARY');
    hr();
    console.log(`  Season   : ${season}`);
    console.log(`  Champion : ${champion} (${TEAM_NAMES[champion]})`);
    blank();
    players.forEach((p, i) => {
        console.log(`  Player ${i + 1}: ${p.name}`);
        console.log(`  Teams   : ${p.teams.join(', ')}`);
        blank();
    });
    hr();

    while (true) {
        const ans = await ask('  Looks good? Type YES to write state.json, or NO to start over: ');
        if (ans.toUpperCase() === 'YES') return true;
        if (ans.toUpperCase() === 'NO') return false;
    }
}

// ── build state ───────────────────────────────────────────────────────────────

function buildState(season, champion, players) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    return {
        champion,
        lastUpdated: today,
        season,
        players: players.map(p => ({
            name: p.name,
            days: 0,
            reigns: 0,
            wins: 0,
            losses: 0,
            streak: 0,
            teams: p.teams.map(abbr => ({
                abbr,
                days: 0,
                reigns: 0,
                wins: 0,
                losses: 0,
                longestStreak: 0,
                currentStreak: 0,
            }))
        })),
        gameLog: []
    };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('');
    hr();
    console.log('  IN SEASON CUP — NEW SEASON SETUP');
    hr();
    console.log('  This will overwrite state.json with a fresh season.');
    console.log('  Your old state.json will be backed up first.');
    blank();

    // Warn if state.json already exists
    if (fs.existsSync(STATE_PATH)) {
        const ans = await ask('  ⚠  state.json already exists. Continue? (yes/no): ');
        if (ans.toLowerCase() !== 'yes') {
            console.log('  Cancelled.');
            rl.close();
            return;
        }
    }

    let season, champion, players;

    // Outer loop — restart from scratch if user says NO at confirm
    while (true) {
        blank();

        // ── Season ──
        season = await askRequired('  Season (e.g. 2026-27): ');

        // ── Starting champion ──
        blank();
        console.log('  Which team holds the cup at the start of the season?');
        while (true) {
            const raw = await ask('  Starting champion (3-letter abbr): ');
            champion = raw.toUpperCase();
            if (VALID_TEAMS.has(champion)) {
                console.log(`  ✓  ${champion} (${TEAM_NAMES[champion]})`);
                break;
            }
            console.log(`  ⚠  "${champion}" is not valid. Try again.`);
        }

        // ── Number of players ──
        blank();
        let numPlayers;
        while (true) {
            const raw = await ask('  How many players? (2–8): ');
            numPlayers = parseInt(raw, 10);
            if (!isNaN(numPlayers) && numPlayers >= 2 && numPlayers <= 8) break;
            console.log('  ⚠  Enter a number between 2 and 8.');
        }

        // ── Players ──
        players = [];
        const takenTeams = new Set();

        for (let i = 0; i < numPlayers; i++) {
            blank();
            hr();
            console.log(`  PLAYER ${i + 1} of ${numPlayers}`);
            hr();

            const name = await askRequired('  Player name: ');
            const teams = await askTeams(name, takenTeams);
            teams.forEach(t => takenTeams.add(t));
            players.push({ name, teams });
        }

        // ── Confirm ──
        const confirmed = await confirmSummary(season, champion, players);
        if (confirmed) break;

        console.log('\n  Starting over...\n');
    }

    // ── Backup existing state.json ──
    if (fs.existsSync(STATE_PATH)) {
        const backupPath = STATE_PATH.replace('state.json', `state.backup.${Date.now()}.json`);
        fs.copyFileSync(STATE_PATH, backupPath);
        console.log(`\n  📦 Old state.json backed up to: ${path.basename(backupPath)}`);
    }

    // ── Write new state.json ──
    const newState = buildState(season, champion, players);
    fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2));

    blank();
    hr();
    console.log('  ✅  state.json written successfully!');
    console.log(`  Season   : ${season}`);
    console.log(`  Champion : ${champion} (${TEAM_NAMES[champion]})`);
    console.log(`  Players  : ${players.map(p => p.name).join(', ')}`);
    hr();
    console.log('  Commit state.json to your repo and the site will update.');
    blank();

    rl.close();
}

main().catch(e => {
    console.error('Error:', e);
    rl.close();
    process.exit(1);
});