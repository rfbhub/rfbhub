/**
 * Guild Hub - Roster Updater
 *
 * Fetches fresh Raider.IO data for all filtered raiders and writes
 * roster.json. Runs hourly via GitHub Actions (update-roster.yml)
 * so the site loads instantly from cached data instead of making
 * 170+ API calls in the browser on every visit.
 *
 * Output: roster.json (consumed by index.html on page load)
 *
 * What's in roster.json:
 *   - guild: guild profile (name, raid_progression, member count)
 *   - chars: full character detail objects for each filtered raider
 *           (same structure the site already works with)
 *   - updated: ISO timestamp of when data was fetched
 *   - rosterCount: how many raiders passed the filter
 *
 * The site loads this file first for instant rendering, and falls
 * back to live R.IO fetching only when the user clicks Refresh.
 */

const fs = require('fs');
const CONFIG = require('./config.js');

const GUILD_REGION = CONFIG.region;
const GUILD_REALM = CONFIG.realm;
const GUILD_NAME = CONFIG.guildName;
const RAID_TIER = CONFIG.raidTier;
const ROSTER_FILTER = CONFIG.rosterFilter || { minIlvl: 0, minLevel: 1, requireParses: false };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function raidScore(prog) {
  if (!prog) return 0;
  return (prog.mythic_bosses_killed || 0) * 100
       + (prog.heroic_bosses_killed || 0) * 10
       + (prog.normal_bosses_killed || 0);
}

async function fetchGuildRoster() {
  const url = `https://raider.io/api/v1/guilds/profile?region=${GUILD_REGION}&realm=${encodeURIComponent(GUILD_REALM)}&name=${encodeURIComponent(GUILD_NAME)}&fields=members,raid_progression,raid_rankings,raid_encounters`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Raider.IO guild fetch failed: ${r.status}`);
  return r.json();
}

async function fetchCharacterDetails(name, realm) {
  const url = `https://raider.io/api/v1/characters/profile?region=${GUILD_REGION}&realm=${encodeURIComponent(realm)}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:current,mythic_plus_best_runs:all,mythic_plus_alternate_runs:all,raid_progression,gear`;
  const r = await fetch(url);
  if (!r.ok) {
    console.log(`  ${name}: R.IO fetch failed ${r.status}`);
    return null;
  }
  return r.json();
}

async function main() {
  console.log('=== Roster Update ===');
  console.log(`${new Date().toISOString()}`);
  console.log('');

  // 1. Fetch guild roster + progression
  console.log('Fetching guild roster from Raider.IO...');
  const guild = await fetchGuildRoster();
  const members = guild.members || [];
  console.log(`  ${members.length} total guild members`);
  console.log(`  Progression: ${JSON.stringify(guild.raid_progression?.[RAID_TIER] || {})}`);
  console.log('');

  // 2. Pre-filter: only fetch characters with recent activity and a spec
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const recent = members.filter(m => {
    const d = new Date(m.character.last_crawled_at);
    return d > cutoff && m.character.active_spec_name;
  });
  console.log(`Pre-filter: ${recent.length} active members (crawled in last 60 days with a spec)`);

  // 3. Fetch character details - same fields the site requests
  console.log(`Fetching character details...`);
  const allChars = [];
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    const name = m.character.name;
    const realm = m.character.realm;
    console.log(`[${i + 1}/${recent.length}] ${name} @ ${realm}`);
    const details = await fetchCharacterDetails(name, realm);
    if (details && details.gear?.item_level_equipped < 300) {
      allChars.push(details);
    }
    await sleep(120); // be polite to R.IO
  }
  console.log(`Fetched ${allChars.length} characters`);
  console.log('');

  // 4. Apply roster filter (same logic as site + other scripts)
  // Load WCL data if available for parses-bypass-ilvl logic
  let parsedNames = new Set();
  if (fs.existsSync('wcl-data.json')) {
    try {
      const wclData = JSON.parse(fs.readFileSync('wcl-data.json', 'utf8'));
      if (wclData.difficulties) {
        for (const diffId of Object.keys(wclData.difficulties)) {
          for (const r of wclData.difficulties[diffId]?.raiders || []) {
            parsedNames.add(r.name.toLowerCase());
          }
        }
      }
      if (wclData.partitions) {
        for (const p of Object.values(wclData.partitions)) {
          for (const diffId of Object.keys(p.difficulties || {})) {
            for (const r of p.difficulties[diffId]?.raiders || []) {
              parsedNames.add(r.name.toLowerCase());
            }
          }
        }
      }
      console.log(`Loaded WCL data: ${parsedNames.size} parsed player names`);
    } catch (e) {
      console.log('wcl-data.json present but unreadable:', e.message);
    }
  } else {
    console.log('No wcl-data.json found, filtering without parse data');
  }

  const minIlvl = ROSTER_FILTER.minIlvl || CONFIG.ilvlBaseline;
  const requireParses = ROSTER_FILTER.requireParses;

  const filtered = allChars.filter(c => {
    const hasParses = parsedNames.has(c.name.toLowerCase());
    if (hasParses) return true;
    if (requireParses) return false;
    const il = c.gear?.item_level_equipped || 0;
    return il >= minIlvl;
  });
  console.log(`Roster filter: ${allChars.length} -> ${filtered.length} raiders`);
  console.log('');

  // 5. Build roster.json
  // Guild object: include what the site needs for display + GvG comparison
  const rosterData = {
    updated: new Date().toISOString(),
    rosterCount: filtered.length,
    guild: {
      name: guild.name,
      raid_progression: guild.raid_progression,
      raid_rankings: guild.raid_rankings,
      raid_encounters: guild.raid_encounters
    },
    chars: filtered
  };

  const json = JSON.stringify(rosterData, null, 2);
  const sizeKb = Math.round(Buffer.byteLength(json) / 1024);

  // 6. Check if data actually changed (avoid empty commits)
  if (fs.existsSync('roster.json')) {
    try {
      const existing = fs.readFileSync('roster.json', 'utf8');
      const existingData = JSON.parse(existing);

      // Compare character names and key stats to detect real changes
      // (ignore timestamp differences)
      const oldSig = (existingData.chars || []).map(c =>
        `${c.name}:${c.gear?.item_level_equipped}:${c.mythic_plus_scores_by_season?.[0]?.scores?.all}`
      ).sort().join('|');
      const newSig = filtered.map(c =>
        `${c.name}:${c.gear?.item_level_equipped}:${c.mythic_plus_scores_by_season?.[0]?.scores?.all}`
      ).sort().join('|');

      if (oldSig === newSig) {
        // Still update the timestamp so we know the action ran
        rosterData.unchanged = true;
        fs.writeFileSync('roster.json', JSON.stringify(rosterData, null, 2));
        console.log(`No meaningful changes detected (${sizeKb} KB)`);
        console.log('Updated timestamp only, skipping commit');
        // Signal to the action that no commit is needed
        process.env.ROSTER_UNCHANGED = 'true';
        // Write a flag file the action can check
        fs.writeFileSync('.roster-unchanged', 'true');
        return;
      }
    } catch (e) {
      console.log('Existing roster.json is corrupt or unreadable, will overwrite:', e.message);
    }
  }

  fs.writeFileSync('roster.json', json);
  console.log(`Wrote roster.json (${sizeKb} KB, ${filtered.length} raiders)`);

  // Clean up flag file if it exists from a previous run
  if (fs.existsSync('.roster-unchanged')) {
    fs.unlinkSync('.roster-unchanged');
  }
}

main().catch(err => {
  console.error('Roster update failed:', err);
  process.exit(1);
});
