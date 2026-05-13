/**
 * Guild Hub - Roster Updater
 *
 * Fetches the curated raider list from WowAudit, then pulls fresh
 * Raider.IO data for each character. Also scans the full guild member
 * list for M+ focused players (3k+ IO) not on the raid roster.
 * Writes roster.json + wowaudit-roster.json.
 * Runs hourly via GitHub Actions (update-roster.yml).
 *
 * Output files:
 *   - roster.json          (consumed by index.html on page load)
 *   - wowaudit-roster.json (cached WowAudit list for client-side loadLive fallback)
 *
 * Why WowAudit?
 *   The guild maintains a curated roster on WowAudit. Everyone on it = raider.
 *   This replaces the old ilvl/parse guessing which gave inconsistent counts.
 *   Cross-realm raiders (Illidan, Sargeras, Zul'jin, etc.) are all included
 *   because WowAudit tracks by character, not by guild membership.
 *
 * M+ Inclusion:
 *   Any guild member with 3000+ R.IO who isn't already on the WowAudit roster
 *   gets included with a _mplusOnly flag. These players appear on Keystone,
 *   Power Rankings, Gear Check, and Weekly Recap alongside raiders.
 */

const fs = require('fs');
const CONFIG = require('./config.js');

const GUILD_REGION = CONFIG.region;
const GUILD_REALM = CONFIG.realm;
const GUILD_NAME = CONFIG.guildName;
const RAID_TIER = CONFIG.raidTier;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWowAuditRoster() {
  const url = `${CONFIG.wowAudit.apiUrl}?api_key=${CONFIG.wowAudit.apiKey}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`WowAudit fetch failed: ${r.status}`);
  return r.json();
}

async function fetchGuildProfile() {
  const url = `https://raider.io/api/v1/guilds/profile?region=${GUILD_REGION}&realm=${encodeURIComponent(GUILD_REALM)}&name=${encodeURIComponent(GUILD_NAME)}&fields=raid_progression,raid_rankings,raid_encounters,members`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Raider.IO guild fetch failed: ${r.status}`);
  return r.json();
}

const MPLUS_IO_THRESHOLD = CONFIG.mplusThreshold || 3000;

async function fetchCharacterDetails(name, realm, retries = 2) {
  const url = `https://raider.io/api/v1/characters/profile?region=${GUILD_REGION}&realm=${encodeURIComponent(realm)}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:current,mythic_plus_best_runs:all,mythic_plus_alternate_runs:all,raid_progression,gear`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    // Retry on server errors (502, 503, 504), fail immediately on 4xx
    if (r.status < 500 || attempt === retries) {
      console.log(`  ${name}: R.IO fetch failed ${r.status}`);
      return null;
    }
    console.log(`  ${name}: R.IO returned ${r.status}, retrying in 3s...`);
    await sleep(3000);
  }
  return null;
}

async function main() {
  console.log('=== Roster Update ===');
  console.log(`${new Date().toISOString()}`);
  console.log('');

  // 1. Fetch curated roster from WowAudit
  console.log('Fetching roster from WowAudit...');
  const wowAuditChars = await fetchWowAuditRoster();
  console.log(`  ${wowAuditChars.length} characters on WowAudit roster`);

  // Save the raw WowAudit list so the site can use it in loadLive fallback
  fs.writeFileSync('wowaudit-roster.json', JSON.stringify(wowAuditChars, null, 2));
  console.log('  Saved wowaudit-roster.json');
  console.log('');

  // 2. Fetch guild profile (progression, rankings, encounters - not members)
  console.log('Fetching guild profile from Raider.IO...');
  const guild = await fetchGuildProfile();
  console.log(`  Progression: ${JSON.stringify(guild.raid_progression?.[RAID_TIER] || {})}`);
  console.log('');

  // 3. Fetch R.IO character details for every WowAudit raider
  console.log(`Fetching R.IO details for ${wowAuditChars.length} raiders...`);
  const chars = [];
  for (let i = 0; i < wowAuditChars.length; i++) {
    const wa = wowAuditChars[i];
    console.log(`[${i + 1}/${wowAuditChars.length}] ${wa.name} @ ${wa.realm}`);
    const details = await fetchCharacterDetails(wa.name, wa.realm);
    if (details) {
      // Attach WowAudit metadata (role, rank, class) for potential site use
      details._wowAudit = {
        role: wa.role,
        rank: wa.rank,
        class: wa.class,
        blizzardId: wa.blizzard_id
      };
      chars.push(details);
    }
    await sleep(120); // be polite to R.IO
  }
  console.log('');
  console.log(`Fetched ${chars.length}/${wowAuditChars.length} characters from R.IO`);

  // 4. Find M+ players from guild roster who aren't on the raid team
  console.log('');
  console.log('Scanning guild members for M+ players (3k+ IO)...');
  const raiderNames = new Set(chars.map(c => `${c.name.toLowerCase()}-${c.realm.toLowerCase()}`));
  const guildMembers = guild.members || [];
  const mplusCandidates = guildMembers.filter(m => {
    const char = m.character;
    const key = `${char.name.toLowerCase()}-${char.realm.toLowerCase()}`;
    if (raiderNames.has(key)) return false; // Already on raid roster
    // R.IO guild member data doesn't include M+ score directly,
    // so we need to fetch full profiles for active members and check
    return char.level >= (CONFIG.rosterFilter?.minLevel || 80);
  });
  console.log(`  ${guildMembers.length} total guild members, ${mplusCandidates.length} non-raider candidates at max level`);

  const mplusChars = [];
  for (let i = 0; i < mplusCandidates.length; i += 8) {
    const chunk = mplusCandidates.slice(i, i + 8);
    const res = await Promise.all(chunk.map(m =>
      fetchCharacterDetails(m.character.name, m.character.realm)
    ));
    for (const details of res) {
      if (!details) continue;
      const rio = details.mythic_plus_scores_by_season?.[0]?.scores?.all || 0;
      if (rio >= MPLUS_IO_THRESHOLD) {
        details._mplusOnly = true; // Tag as M+ roster (not raid roster)
        mplusChars.push(details);
        console.log(`  + ${details.name} @ ${details.realm} (${Math.round(rio)} IO)`);
      }
    }
    if (i + 8 < mplusCandidates.length) await sleep(120);
  }
  console.log(`  Found ${mplusChars.length} M+ players above ${MPLUS_IO_THRESHOLD} IO`);

  // Merge M+ players into the roster
  const allChars = [...chars, ...mplusChars];
  console.log(`  Total roster: ${chars.length} raiders + ${mplusChars.length} M+ = ${allChars.length}`);
  console.log('');

  // 5. Build roster.json
  const rosterData = {
    updated: new Date().toISOString(),
    rosterCount: chars.length,
    mplusCount: mplusChars.length,
    guild: {
      name: guild.name,
      raid_progression: guild.raid_progression,
      raid_rankings: guild.raid_rankings,
      raid_encounters: guild.raid_encounters
    },
    chars: allChars
  };

  const json = JSON.stringify(rosterData, null, 2);
  const sizeKb = Math.round(Buffer.byteLength(json) / 1024);

  // 5. Check if data actually changed (avoid empty commits)
  if (fs.existsSync('roster.json')) {
    try {
      const existing = fs.readFileSync('roster.json', 'utf8');
      const existingData = JSON.parse(existing);

      const oldSig = (existingData.chars || []).map(c =>
        `${c.name}:${c.gear?.item_level_equipped}:${c.mythic_plus_scores_by_season?.[0]?.scores?.all}:${c._mplusOnly||false}`
      ).sort().join('|');
      const newSig = allChars.map(c =>
        `${c.name}:${c.gear?.item_level_equipped}:${c.mythic_plus_scores_by_season?.[0]?.scores?.all}:${c._mplusOnly||false}`
      ).sort().join('|');

      if (oldSig === newSig) {
        rosterData.unchanged = true;
        fs.writeFileSync('roster.json', JSON.stringify(rosterData, null, 2));
        console.log(`No meaningful changes detected (${sizeKb} KB)`);
        console.log('Updated timestamp only, skipping commit');
        fs.writeFileSync('.roster-unchanged', 'true');
        return;
      }
    } catch (e) {
      console.log('Existing roster.json is corrupt or unreadable, will overwrite:', e.message);
    }
  }

  fs.writeFileSync('roster.json', json);
  console.log(`Wrote roster.json (${sizeKb} KB, ${chars.length} raiders + ${mplusChars.length} M+ players)`);

  if (fs.existsSync('.roster-unchanged')) {
    fs.unlinkSync('.roster-unchanged');
  }
}

main().catch(err => {
  console.error('Roster update failed:', err);
  process.exit(1);
});
