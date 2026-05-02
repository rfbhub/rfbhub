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
const ROSTER_FILTER = CONFIG.rosterFilter || { minIlvl: 0, minLevel: 1, requireParses: false };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  // 1. Guild roster + progression
  console.log('Fetching guild roster from Raider.IO...');
  const guild = await fetchGuildRoster();
  console.log(`  ${guild.members?.length || 0} members, progression: ${JSON.stringify(guild.raid_progression?.[RAID_TIER] || {})}`);
  console.log('');

  // 2. Fetch per-character details for every guild member.
  // We can't filter on raid_progression up front because the guild/profile
  // endpoint doesn't include per-character progression. We fetch everyone and
  // filter after. (R.IO's guild roster also doesn't reliably include level,
  // so don't try to pre-filter on that either.)
  const members = (guild.members || []);
  console.log(`Fetching character details for ${members.length} guild members...`);

  const characters = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const name = m.character.name;
    const realm = m.character.realm;
    console.log(`[${i + 1}/${members.length}] ${name} @ ${realm}`);
    const details = await fetchCharacterDetails(name, realm);
    if (details) {
      // Apply roster filter: level + ilvl
      const level = details.level || 0;
      const ilvl = details.gear?.item_level_equipped || 0;
      if (level < ROSTER_FILTER.minLevel) {
        console.log(`  Skipped: level ${level} < ${ROSTER_FILTER.minLevel}`);
        continue;
      }
      if (ilvl < ROSTER_FILTER.minIlvl) {
        console.log(`  Skipped: ilvl ${ilvl} < ${ROSTER_FILTER.minIlvl}`);
        continue;
      }
      characters.push(details);
    }
    await sleep(120); // be polite to R.IO
  }
  console.log('');
  console.log(`Fetched details for ${characters.length} characters (after roster filter)`);

  // 3. Filter down to actual raiders (has kills on the current tier).
  const raiders = characters.filter(c => {
    const prog = c.raid_progression?.[RAID_TIER];
    return prog && raidScore(prog) > 0;
  });
  console.log(`Filtered to ${raiders.length} raiders with kills on ${RAID_TIER}`);

  // 4. Grab the current WCL cache (parses at this moment)
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

  // 4b. Apply requireParses filter: remove raiders with no WCL parses
  if (ROSTER_FILTER.requireParses && wclData) {
    const parsedNames = new Set();
    const diffs = wclData.difficulties || {};
    for (const diffId of Object.keys(diffs)) {
      for (const r of diffs[diffId]?.raiders || []) {
        parsedNames.add(r.name.toLowerCase());
      }
    }
    const before = raiders.length;
    const filtered = raiders.filter(r => parsedNames.has(r.name.toLowerCase()));
    // Mutate raiders array in place so the snapshot uses the filtered list
    raiders.length = 0;
    raiders.push(...filtered);
    console.log(`Parse filter: ${before} -> ${raiders.length} raiders (removed ${before - raiders.length} with no parses)`);
  }

  // 5. Build and write snapshot
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
