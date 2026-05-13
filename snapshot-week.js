/**
 * Guild Hub - Weekly Snapshot
 *
 * Captures a point-in-time snapshot of the guild's current state
 * and writes it to history/YYYY-MM-DD.json. Runs once per week via
 * GitHub Actions (weekly-snapshot.yml).
 *
 * What's captured:
 *   - Fresh Raider.IO character data (ilvl, M+ score, gear, etc.) for each raider
 *   - Guild progression snapshot from Raider.IO
 *   - A copy of the current wcl-data.json (parses at this moment)
 *   - Season metadata from config.js so snapshots remain interpretable
 *     even if config advances to a new tier later
 *
 * What's NOT captured:
 *   - Computed GPS scores. We store raw signals so future formula changes
 *     don't invalidate old snapshots. GPS can be recomputed anytime.
 *
 * Snapshots are intentionally append-only. Don't overwrite old ones.
 */

const fs = require('fs');
const path = require('path');

const CONFIG = require('./config.js');

const GUILD_REGION = CONFIG.region;
const GUILD_REALM = CONFIG.realm;
const GUILD_NAME = CONFIG.guildName;
const RAID_TIER = CONFIG.raidTier;
const ROSTER_FILTER = CONFIG.rosterFilter || { minIlvl: 269, minLevel: 90 };
const WOWAUDIT_URL = CONFIG.wowAudit?.apiUrl;
const WOWAUDIT_KEY = CONFIG.wowAudit?.apiKey;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWowAuditRoster() {
  if (!WOWAUDIT_URL || !WOWAUDIT_KEY) return null;
  try {
    const r = await fetch(`${WOWAUDIT_URL}?api_key=${WOWAUDIT_KEY}`);
    if (!r.ok) return null;
    return r.json();
  } catch (e) { return null; }
}

function raidScore(prog) {
  if (!prog) return 0;
  return (prog.mythic_bosses_killed || 0) * 100
       + (prog.heroic_bosses_killed || 0) * 10
       + (prog.normal_bosses_killed || 0);
}

async function fetchGuildRoster() {
  const url = `https://raider.io/api/v1/guilds/profile?region=${GUILD_REGION}&realm=${GUILD_REALM}&name=${encodeURIComponent(GUILD_NAME)}&fields=members,raid_progression`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Raider.IO guild fetch failed: ${r.status}`);
  return r.json();
}

async function fetchCharacterDetails(name, realm) {
  const url = `https://raider.io/api/v1/characters/profile?region=${GUILD_REGION}&realm=${encodeURIComponent(realm)}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:current,mythic_plus_best_runs:all,gear,raid_progression`;
  const r = await fetch(url);
  if (!r.ok) {
    console.log(`  ${name}: R.IO fetch failed ${r.status}`);
    return null;
  }
  return r.json();
}

function todayIsoDate() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function main() {
  console.log('═══════════════════════════════════════');
  console.log(`Weekly snapshot — ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════');
  console.log('');

  // 1. Guild profile (progression, not members - we get raiders from WowAudit)
  console.log('Fetching guild profile from Raider.IO...');
  const guild = await fetchGuildRoster();
  console.log(`  Progression: ${JSON.stringify(guild.raid_progression?.[RAID_TIER] || {})}`);
  console.log('');

  // 2. Fetch raider list: WowAudit (curated) first, guild members fallback
  const waRoster = await fetchWowAuditRoster();
  let characters = [];

  if (waRoster && waRoster.length > 0) {
    console.log(`Fetching R.IO details for ${waRoster.length} WowAudit raiders...`);
    for (let i = 0; i < waRoster.length; i++) {
      const wa = waRoster[i];
      console.log(`[${i + 1}/${waRoster.length}] ${wa.name} @ ${wa.realm}`);
      const details = await fetchCharacterDetails(wa.name, wa.realm);
      if (details) characters.push(details);
      await sleep(120);
    }
    console.log(`Fetched ${characters.length}/${waRoster.length} characters from R.IO`);

    // Also scan guild members for M+ players (3k+ IO) not on raid roster
    const mplusThreshold = CONFIG.mplusThreshold || 3000;
    const raiderKeys = new Set(characters.map(c => `${c.name.toLowerCase()}-${(c.realm||'').toLowerCase()}`));
    const guildMembers = guild.members || [];
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60);
    const mpCandidates = guildMembers.filter(m => {
      const ch = m.character;
      if (!ch.active_spec_name) return false;
      const crawled = new Date(ch.last_crawled_at);
      if (crawled <= cutoff) return false;
      return !raiderKeys.has(`${ch.name.toLowerCase()}-${ch.realm.toLowerCase()}`);
    });
    console.log(`Scanning ${mpCandidates.length} non-raider guild members for M+ players...`);
    let mpCount = 0;
    for (let i = 0; i < mpCandidates.length; i += 8) {
      const chunk = mpCandidates.slice(i, i + 8);
      const res = await Promise.all(chunk.map(m =>
        fetchCharacterDetails(m.character.name, m.character.realm)
      ));
      for (const details of res) {
        if (!details) continue;
        const rio = details.mythic_plus_scores_by_season?.[0]?.scores?.all || 0;
        if (rio >= mplusThreshold) {
          details._mplusOnly = true;
          characters.push(details);
          mpCount++;
          console.log(`  + M+ player: ${details.name} (${Math.round(rio)} IO)`);
        }
      }
      if (i + 8 < mpCandidates.length) await sleep(120);
    }
    console.log(`  Found ${mpCount} M+ players above ${mplusThreshold} IO`);
  } else {
    console.log('WowAudit unavailable, falling back to guild members...');
    const members = (guild.members || []);
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      console.log(`[${i + 1}/${members.length}] ${m.character.name} @ ${m.character.realm}`);
      const details = await fetchCharacterDetails(m.character.name, m.character.realm);
      if (details) characters.push(details);
      await sleep(120);
    }
    console.log(`Fetched ${characters.length} characters`);
    // Fallback filter: raid kills on current tier
    characters = characters.filter(c => {
      const prog = c.raid_progression?.[RAID_TIER];
      return prog && raidScore(prog) > 0;
    });
    console.log(`Filtered to ${characters.length} raiders with kills`);
  }

  // 3. Grab the current WCL cache for the snapshot
  let wclData = null;
  if (fs.existsSync('wcl-data.json')) {
    try {
      wclData = JSON.parse(fs.readFileSync('wcl-data.json', 'utf8'));
      console.log('Attached current wcl-data.json to snapshot');
    } catch (e) {
      console.log('wcl-data.json present but unreadable, skipping:', e.message);
    }
  } else {
    console.log('No wcl-data.json found, snapshot will lack parse data');
  }

  const raiders = characters;

  // 6. Build and write snapshot
  const snapshot = {
    timestamp: new Date().toISOString(),
    date: todayIsoDate(),
    config: {
      guildName: CONFIG.guildName,
      region: CONFIG.region,
      realm: CONFIG.realm,
      raidTier: CONFIG.raidTier,
      raidName: CONFIG.raidName,
      seasonName: CONFIG.seasonName,
      wclZoneId: CONFIG.wclZoneId,
      ilvlBaseline: CONFIG.ilvlBaseline,
      bosses: CONFIG.bosses
    },
    progression: guild.raid_progression || {},
    raiders,
    wclData
  };

  const dir = 'history';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = path.join(dir, `${snapshot.date}.json`);

  if (fs.existsSync(filename)) {
    console.log(`Snapshot already exists for ${snapshot.date}, overwriting with fresh data`);
  }

  fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2));
  const sizeKb = Math.round(fs.statSync(filename).size / 1024);
  console.log('');
  console.log(`✓ Wrote ${filename} (${sizeKb} KB)`);
  console.log(`  ${raiders.length} raiders, ${wclData ? 'with' : 'without'} parse data`);
}

main().catch(err => {
  console.error('Snapshot failed:', err);
  process.exit(1);
});
