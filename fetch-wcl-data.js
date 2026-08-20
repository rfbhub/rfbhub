/**
 * Guild Hub - WCL Data Fetcher
 * Runs via GitHub Actions to cache Warcraft Logs parse data
 *
 * Raider.IO data is fetched live on site visit (fast, no auth needed)
 * WCL data is cached here (slow API, needs auth, rarely changes)
 */

const fs = require('fs');

// Shared config loaded from config.js. Single source of truth with index.html.
// To customize, edit config.js, not this file.
const CONFIG = require('./config.js');

// ═══════════════════════════════════════════════════════════════════════════
// Internal setup (don't edit below unless you know what you're doing)
// ═══════════════════════════════════════════════════════════════════════════

const GUILD_REGION = CONFIG.region;
const GUILD_REALM = CONFIG.realm;
const GUILD_NAME = CONFIG.guildName;
const RAID_TIER = CONFIG.raidTier;
const WCL_ZONE_ID = CONFIG.wclZoneId;
const WCL_PARTITIONS = CONFIG.wclPartitions || [{id: null, label: 'Latest'}];
const RAID_BOSSES = CONFIG.bosses;
const ROSTER_FILTER = CONFIG.rosterFilter || { minIlvl: 269, minLevel: 90 };
const WOWAUDIT_URL = CONFIG.wowAudit?.apiUrl;
const WOWAUDIT_KEY = CONFIG.wowAudit?.apiKey;
const ALT_MERGE = CONFIG.altMerge || [];
const SUPPLEMENTAL_ZONES = CONFIG.supplementalZones || [];

// Difficulties to fetch
const DIFFICULTIES = [
  { id: 3, name: 'Normal' },
  { id: 4, name: 'Heroic' },
  { id: 5, name: 'Mythic' }
];

// WCL credentials from GitHub Secrets
const WCL_CLIENT = process.env.WCL_CLIENT;
const WCL_SECRET = process.env.WCL_SECRET;

// Helpers
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function raidScore(prog) {
  if (!prog) return 0;
  return (prog.mythic_bosses_killed || 0) * 100 +
         (prog.heroic_bosses_killed || 0) * 10 +
         (prog.normal_bosses_killed || 0);
}

function shortBoss(name) {
  if (!name) return '';
  const cleaned = name.replace(/^(The |Imperator |High |Lord |Lady |King |Queen |Prince |Princess |General |Commander |Archbishop )/i, '');
  const firstWord = cleaned.split(' ')[0];
  return firstWord.length > 10 ? firstWord.substring(0, 9) + '…' : firstWord;
}

// WCL Token Management
let wclToken = null;
let wclTokenExpiry = 0;

async function getWCLToken() {
  if (wclToken && Date.now() < wclTokenExpiry) {
    return wclToken;
  }

  console.log('Fetching new WCL token...');

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://www.warcraftlogs.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `grant_type=client_credentials&client_id=${WCL_CLIENT}&client_secret=${WCL_SECRET}`
      });

      if (!response.ok) {
        throw new Error(`WCL token fetch failed: ${response.status}`);
      }

      const data = await response.json();
      wclToken = data.access_token;
      wclTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // 1 min buffer

      console.log('WCL token acquired');
      return wclToken;
    } catch (err) {
      console.log(`Token attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      const wait = attempt * 10000; // 10s, 20s, 30s
      console.log(`Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
}

// Fetch curated roster from WowAudit. Returns array of {name, realm, ...} or null.
async function fetchWowAuditRoster() {
  if (!WOWAUDIT_URL || !WOWAUDIT_KEY) return null;
  try {
    console.log('Fetching roster from WowAudit...');
    const r = await fetch(`${WOWAUDIT_URL}?api_key=${WOWAUDIT_KEY}`);
    if (!r.ok) { console.log(`WowAudit fetch failed: ${r.status}`); return null; }
    const data = await r.json();
    console.log(`WowAudit roster: ${data.length} characters`);
    return data;
  } catch (e) { console.log('WowAudit error:', e.message); return null; }
}

// Fetch guild roster from Raider.IO (fallback if WowAudit unavailable)
async function fetchGuildRoster() {
  console.log('Fetching guild roster from Raider.IO...');

  const url = `https://raider.io/api/v1/guilds/profile?region=${GUILD_REGION}&realm=${GUILD_REALM}&name=${encodeURIComponent(GUILD_NAME)}&fields=members,raid_progression`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Raider.IO fetch failed: ${response.status}`);
  }

  const data = await response.json();
  console.log(`Found ${data.members?.length || 0} guild members`);

  return data;
}

// Fetch character details from Raider.IO
async function fetchCharacterDetails(name, realm) {
  const url = `https://raider.io/api/v1/characters/profile?region=${GUILD_REGION}&realm=${encodeURIComponent(realm)}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:current,mythic_plus_best_runs:all,gear,raid_progression`;

  const response = await fetch(url);

  if (!response.ok) {
    console.log(`  Failed to fetch details for ${name}: ${response.status}`);
    return null;
  }

  return response.json();
}

// Healer specs across all classes. Used to rank healers on hps instead of dps.
const HEALER_SPECS = new Set(['Holy', 'Discipline', 'Restoration', 'Mistweaver', 'Preservation']);
function isHealerSpec(spec){
  return !!spec && HEALER_SPECS.has(spec);
}

// Fetch zone rankings from WCL for a specific difficulty.
async function fetchWCLZoneRankings(name, serverSlug, serverRegion, difficulty, metric, partition, zoneId) {
  const token = await getWCLToken();
  const m = metric === 'hps' ? 'hps' : 'dps';
  const p = partition;
  const zone = zoneId || WCL_ZONE_ID;

  const query = `{
    characterData {
      character(name: "${name}", serverSlug: "${serverSlug}", serverRegion: "${serverRegion}") {
        zoneRankings(zoneID: ${zone}, difficulty: ${difficulty}, metric: ${m}${p ? ', partition: ' + p : ''})
      }
    }
  }`;

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        console.log(`    WCL fetch failed for ${name} (diff ${difficulty}): ${response.status}`);
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          console.log(`    Retrying in ${attempt * 5}s...`);
          await sleep(attempt * 5000);
          continue;
        }
        return null;
      }

      const data = await response.json();

      if (data.errors) {
        console.log(`    WCL GraphQL errors for ${name} (diff ${difficulty}):`, data.errors[0]?.message);
        return null;
      }

      return data.data?.characterData?.character?.zoneRankings;
    } catch (err) {
      console.log(`    WCL request failed for ${name} (diff ${difficulty}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`    Retrying in ${attempt * 5}s...`);
        await sleep(attempt * 5000);
      } else {
        console.log(`    Giving up after ${MAX_RETRIES} attempts`);
        return null;
      }
    }
  }
  return null;
}

// Process raiders for a specific difficulty
function processRaidersForDifficulty(allRaiderData, difficulty) {
  const raidersWithParses = [];

  for (const raiderData of allRaiderData) {
    const diffData = raiderData.difficulties[difficulty];
    if (!diffData || !diffData.rankings || diffData.rankings.length === 0) {
      continue;
    }

    const rankings = diffData.rankings;
    const avgParse = Math.floor(rankings.reduce((s, r) => s + r.rankPercent, 0) / rankings.length);

    raidersWithParses.push({
      name: raiderData.name,
      class: raiderData.class,
      realm: raiderData.realm,
      avgParse: avgParse,
      bossCount: rankings.length,
      bosses: rankings.map(r => {
        const boss = {
          name: r.encounter.name,
          encounterID: r.encounter.id,
          parse: Math.floor(r.rankPercent),
          spec: r.spec,
          dps: Math.round(r.bestAmount)
        };
        if (r._srcChar) { boss._srcChar = r._srcChar; boss._srcRealm = r._srcRealm; }
        return boss;
      })
    });
  }

  raidersWithParses.sort((a, b) => b.avgParse - a.avgParse);

  return raidersWithParses;
}

// Calculate stats for a difficulty
function calculateStats(raidersWithParses) {
  if (raidersWithParses.length === 0) {
    return {
      guildAvg: 0,
      raidersLogged: 0,
      parseBreakdown: { pink: 0, orange: 0, purple: 0, blue: 0, green: 0, gray: 0 },
      bestParse: { parse: 0, player: '', boss: '' }
    };
  }

  const guildAvg = Math.floor(raidersWithParses.reduce((s, r) => s + r.avgParse, 0) / raidersWithParses.length);

  let pinkParses = 0, orangeParses = 0, purpleParses = 0, blueParses = 0, greenParses = 0, grayParses = 0;
  let bestParse = { parse: 0, player: '', boss: '' };

  for (const r of raidersWithParses) {
    for (const b of r.bosses) {
      if (b.parse >= 99) pinkParses++;
      else if (b.parse >= 95) orangeParses++;
      else if (b.parse >= 75) purpleParses++;
      else if (b.parse >= 50) blueParses++;
      else if (b.parse >= 25) greenParses++;
      else grayParses++;

      if (b.parse > bestParse.parse) {
        bestParse = { parse: b.parse, player: r.name, boss: b.name };
      }
    }
  }

  return {
    guildAvg,
    raidersLogged: raidersWithParses.length,
    parseBreakdown: {
      pink: pinkParses,
      orange: orangeParses,
      purple: purpleParses,
      blue: blueParses,
      green: greenParses,
      gray: grayParses
    },
    bestParse
  };
}

// ═══════════════════════════════════════
// ACTIVITY TRACKING
// ═══════════════════════════════════════

function loadPreviousData() {
  try {
    if (fs.existsSync('wcl-data.json')) {
      return JSON.parse(fs.readFileSync('wcl-data.json', 'utf8'));
    }
  } catch (e) {
    console.log('No previous wcl-data.json found');
  }
  return null;
}

function loadActivity() {
  try {
    if (fs.existsSync('activity.json')) {
      return JSON.parse(fs.readFileSync('activity.json', 'utf8'));
    }
  } catch (e) {
    console.log('No previous activity.json found');
  }
  return { events: [] };
}

function saveActivity(activity) {
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  activity.events = activity.events.filter(e => new Date(e.timestamp).getTime() > cutoff);
  activity.events = activity.events.slice(0, 50);

  fs.writeFileSync('activity.json', JSON.stringify(activity, null, 2));
  console.log(`Saved ${activity.events.length} events to activity.json`);
}

function addEvent(activity, type, icon, text, detail) {
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const isDupe = activity.events.some(e =>
    e.type === type &&
    e.text === text &&
    new Date(e.timestamp).getTime() > dayAgo
  );

  if (!isDupe) {
    activity.events.unshift({
      timestamp: new Date().toISOString(),
      type,
      icon,
      text,
      detail
    });
    console.log(`  EVENT: ${icon} ${text}`);
  }
}

function detectEvents(prevData, newData, characters, activity) {
  console.log('');
  console.log('Detecting events...');

  const knownPlayers = new Set();
  if (prevData) {
    if (prevData.rioSnapshot) {
      for (const p of prevData.rioSnapshot) knownPlayers.add(p.name);
    }
    for (const diffId of [3, 4, 5]) {
      const raiders = prevData.difficulties?.[diffId]?.raiders || [];
      for (const r of raiders) knownPlayers.add(r.name);
    }
    if (prevData.kshSnapshot) {
      for (const name of prevData.kshSnapshot) knownPlayers.add(name);
    }
  }
  const isFirstRun = knownPlayers.size === 0;

  const diffNames = { 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };
  const diffIcons = { 3: '\u{1F7E2}', 4: '\u{1F7E3}', 5: '\u{1F7E0}' };

  const prevBosses = {};
  const newBosses = {};

  for (const diffId of [3, 4, 5]) {
    prevBosses[diffId] = new Set();
    newBosses[diffId] = new Set();

    if (prevData?.difficulties?.[diffId]?.raiders) {
      for (const raider of prevData.difficulties[diffId].raiders) {
        for (const boss of raider.bosses || []) {
          prevBosses[diffId].add(boss.name);
        }
      }
    }

    if (newData.difficulties?.[diffId]?.raiders) {
      for (const raider of newData.difficulties[diffId].raiders) {
        for (const boss of raider.bosses || []) {
          newBosses[diffId].add(boss.name);
        }
      }
    }

    for (const bossName of newBosses[diffId]) {
      if (!prevBosses[diffId].has(bossName)) {
        addEvent(activity, 'first_kill', diffIcons[diffId],
          `First ${diffNames[diffId]} ${bossName} kill!`,
          `${diffNames[diffId]} ${bossName}`
        );
      }
    }
  }

  const prevPinkParses = new Set();
  const prevOrangeParses = new Set();

  if (prevData?.difficulties) {
    for (const diffId of [3, 4, 5]) {
      const raiders = prevData.difficulties[diffId]?.raiders || [];
      for (const raider of raiders) {
        for (const boss of raider.bosses || []) {
          const key = `${raider.name}-${boss.name}-${diffId}`;
          if (boss.parse >= 99) prevPinkParses.add(key);
          else if (boss.parse >= 95) prevOrangeParses.add(key);
        }
      }
    }
  }

  for (const diffId of [3, 4, 5]) {
    const raiders = newData.difficulties?.[diffId]?.raiders || [];
    for (const raider of raiders) {
      if (!isFirstRun && !knownPlayers.has(raider.name)) continue;
      for (const boss of raider.bosses || []) {
        const key = `${raider.name}-${boss.name}-${diffId}`;

        if (boss.parse >= 99 && !prevPinkParses.has(key)) {
          addEvent(activity, 'pink_parse', '\u{1F497}',
            `${raider.name} logged a ${boss.parse}% ${diffNames[diffId]} parse on ${boss.name}!`,
            `${diffNames[diffId]} ${boss.name}`
          );
        } else if (boss.parse >= 95 && boss.parse < 99 && !prevOrangeParses.has(key) && !prevPinkParses.has(key)) {
          addEvent(activity, 'orange_parse', '\u{1F9E1}',
            `${raider.name} logged a ${boss.parse}% ${diffNames[diffId]} parse on ${boss.name}`,
            `${diffNames[diffId]} ${boss.name}`
          );
        }
      }
    }
  }

  const prev3kPlayers = new Set();
  if (prevData?.rioSnapshot) {
    for (const p of prevData.rioSnapshot) {
      if (p.rio >= 3000) prev3kPlayers.add(p.name);
    }
  }

  for (const char of characters) {
    if (!isFirstRun && !knownPlayers.has(char.name)) continue;
    const rio = char.mythic_plus_scores_by_season?.[0]?.scores?.all || 0;
    if (rio >= 3000 && !prev3kPlayers.has(char.name)) {
      addEvent(activity, 'rio_3k', '\u{1F511}',
        `${char.name} hit ${Math.round(rio)} R.IO!`,
        'Keystone Legend'
      );
    }
  }

  const prevKSH = new Set();
  if (prevData?.kshSnapshot) {
    for (const name of prevData.kshSnapshot) {
      prevKSH.add(name);
    }
  }

  for (const char of characters) {
    if (!isFirstRun && !knownPlayers.has(char.name)) continue;
    const runs = char.mythic_plus_best_runs || [];
    const timedCount = runs.filter(r => r.num_keystone_upgrades > 0).length;
    if (timedCount >= 8 && !prevKSH.has(char.name)) {
      addEvent(activity, 'resilient', '\u{1F3C6}',
        `${char.name} earned Resilient!`,
        'All 8 dungeons timed'
      );
    }
  }
}

function buildSnapshots(characters) {
  const rioSnapshot = characters.map(c => ({
    name: c.name,
    rio: c.mythic_plus_scores_by_season?.[0]?.scores?.all || 0
  }));

  const kshSnapshot = characters
    .filter(c => {
      const runs = c.mythic_plus_best_runs || [];
      return runs.filter(r => r.num_keystone_upgrades > 0).length >= 8;
    })
    .map(c => c.name);

  return { rioSnapshot, kshSnapshot };
}

// Main execution
async function main() {
  console.log('=== RFB Hub WCL Data Fetch ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  if (!WCL_CLIENT || !WCL_SECRET) {
    throw new Error('Missing WCL_CLIENT or WCL_SECRET environment variables');
  }

  const prevData = loadPreviousData();
  const activity = loadActivity();

  const waRoster = await fetchWowAuditRoster();

  let raiders;

  if (waRoster && waRoster.length > 0) {
    console.log('');
    console.log(`Fetching R.IO details for ${waRoster.length} WowAudit raiders...`);
    const characters = [];
    for (let i = 0; i < waRoster.length; i++) {
      const wa = waRoster[i];
      console.log(`[${i + 1}/${waRoster.length}] ${wa.name} @ ${wa.realm}...`);
      const details = await fetchCharacterDetails(wa.name, wa.realm);
      if (details) characters.push(details);
      await sleep(100);
    }
    console.log(`Fetched ${characters.length}/${waRoster.length} characters from R.IO`);
    raiders = characters;
  } else {
    console.log('WowAudit unavailable, falling back to guild roster');
    const guild = await fetchGuildRoster();
    if (!guild.members || guild.members.length === 0) {
      throw new Error('No guild members found');
    }
    console.log('');
    console.log('Fetching character details...');
    const characters = [];
    for (let i = 0; i < guild.members.length; i++) {
      const member = guild.members[i];
      const char = member.character;
      console.log(`[${i + 1}/${guild.members.length}] ${char.name}...`);
      const details = await fetchCharacterDetails(char.name, char.realm);
      if (details) characters.push(details);
      await sleep(100);
    }
    console.log(`Fetched details for ${characters.length} characters`);
    raiders = characters.filter(c => {
      const prog = c.raid_progression?.[RAID_TIER];
      return prog && raidScore(prog) > 0;
    });
    console.log(`Filtered to ${raiders.length} raiders with raid kills`);
  }
  console.log('');

  console.log(`Fetching WCL data for ${WCL_PARTITIONS.length} partition(s): ${WCL_PARTITIONS.map(p => p.label).join(', ')}`);

  const partitionResults = {};

  for (const part of WCL_PARTITIONS) {
    const partLabel = part.label;
    const partId = part.id;
    console.log('');
    console.log(`=== Partition: ${partLabel} (${partId === null ? 'default/latest' : 'partition ' + partId}) ===`);

    const allRaiderData = [];

    for (let i = 0; i < raiders.length; i++) {
      const char = raiders[i];
      const serverSlug = (char.realm || 'stormrage').toLowerCase().replace(/\s+/g, '-');

      console.log(`[${i + 1}/${raiders.length}] ${char.name} (${serverSlug})...`);

      const metric = isHealerSpec(char.active_spec_name) ? 'hps' : 'dps';

      const raiderData = {
        name: char.name,
        class: char.class,
        spec: char.active_spec_name || null,
        role: metric === 'hps' ? 'healer' : 'dps',
        realm: serverSlug,
        difficulties: {}
      };

      for (const diff of DIFFICULTIES) {
        let result = await fetchWCLZoneRankings(char.name, serverSlug, 'US', diff.id, metric, partId);
        await sleep(150);

        let rankings = (result?.rankings || []).filter(r => r.rankPercent);

        if (rankings.length > 0) {
          const wclSpec = rankings[0].spec;
          const wclIsHealer = isHealerSpec(wclSpec);
          const weUsedHps = metric === 'hps';

          if (wclIsHealer && !weUsedHps) {
            result = await fetchWCLZoneRankings(char.name, serverSlug, 'US', diff.id, 'hps', partId);
            await sleep(150);
            rankings = (result?.rankings || []).filter(r => r.rankPercent);
            raiderData.role = 'healer';
            if (rankings.length > 0) {
              console.log(`    ${diff.name}: ${rankings.length} bosses (corrected to hps, spec: ${wclSpec})`);
            }
          } else if (!wclIsHealer && weUsedHps) {
            result = await fetchWCLZoneRankings(char.name, serverSlug, 'US', diff.id, 'dps', partId);
            await sleep(150);
            rankings = (result?.rankings || []).filter(r => r.rankPercent);
            raiderData.role = 'dps';
            if (rankings.length > 0) {
              console.log(`    ${diff.name}: ${rankings.length} bosses (corrected to dps, spec: ${wclSpec})`);
            }
          }
        }

        if (rankings.length > 0) {
          raiderData.difficulties[diff.id] = {
            rankings: rankings
          };
          if (!raiderData.difficulties[diff.id].logged) {
            console.log(`    ${diff.name}: ${rankings.length} bosses`);
          }
        }
      }

      // Fetch supplemental zones and append rankings
      for (const supZone of SUPPLEMENTAL_ZONES) {
        for (const diff of DIFFICULTIES) {
          let result = await fetchWCLZoneRankings(char.name, serverSlug, 'US', diff.id, metric, partId, supZone.zoneId);
          await sleep(150);

          let rankings = (result?.rankings || []).filter(r => r.rankPercent);

          if (rankings.length > 0) {
            const wclSpec = rankings[0].spec;
            const wclIsHealer = isHealerSpec(wclSpec);
            const weUsedHps = metric === 'hps';
            if (wclIsHealer && !weUsedHps) {
              result = await fetchWCLZoneRankings(char.name, serverSlug, 'US', diff.id, 'hps', partId, supZone.zoneId);
              await sleep(150);
              rankings = (result?.rankings || []).filter(r => r.rankPercent);
            } else if (!wclIsHealer && weUsedHps) {
              result = await fetchWCLZoneRankings(char.name, serverSlug, 'US', diff.id, 'dps', partId, supZone.zoneId);
              await sleep(150);
              rankings = (result?.rankings || []).filter(r => r.rankPercent);
            }
          }

          if (rankings.length > 0) {
            if (!raiderData.difficulties[diff.id]) {
              raiderData.difficulties[diff.id] = { rankings: [] };
            }
            raiderData.difficulties[diff.id].rankings.push(...rankings);
            console.log(`    ${diff.name} ${supZone.name}: ${rankings.length} boss(es)`);
          }
        }
      }

      if (Object.keys(raiderData.difficulties).length > 0) {
        allRaiderData.push(raiderData);
      }

      await sleep(100);
    }

    console.log(`Partition ${partLabel}: fetched data for ${allRaiderData.length} raiders`);

    // Alt Merge
    for (const merge of ALT_MERGE) {
      const mainEntry = allRaiderData.find(r => r.name.toLowerCase() === merge.main.toLowerCase());
      if (!mainEntry) {
        console.log(`  Alt merge: main "${merge.main}" not found in raider data, skipping`);
        continue;
      }

      for (const alt of merge.alts) {
        console.log(`  Alt merge: fetching WCL data for ${alt.name} (${alt.realm}) to merge into ${merge.main}...`);
        const altServerSlug = alt.realm.toLowerCase().replace(/\s+/g, '-');

        const altMetric = mainEntry.role === 'healer' ? 'hps' : 'dps';

        for (const diff of DIFFICULTIES) {
          let result = await fetchWCLZoneRankings(alt.name, altServerSlug, 'US', diff.id, altMetric, partId);
          await sleep(150);

          let altRankings = (result?.rankings || []).filter(r => r.rankPercent);
          if (altRankings.length === 0) continue;

          const wclSpec = altRankings[0].spec;
          const wclIsHealer = isHealerSpec(wclSpec);
          const weUsedHps = altMetric === 'hps';
          if (wclIsHealer && !weUsedHps) {
            result = await fetchWCLZoneRankings(alt.name, altServerSlug, 'US', diff.id, 'hps', partId);
            await sleep(150);
            altRankings = (result?.rankings || []).filter(r => r.rankPercent);
          } else if (!wclIsHealer && weUsedHps) {
            result = await fetchWCLZoneRankings(alt.name, altServerSlug, 'US', diff.id, 'dps', partId);
            await sleep(150);
            altRankings = (result?.rankings || []).filter(r => r.rankPercent);
          }

          if (altRankings.length === 0) continue;

          if (!mainEntry.difficulties[diff.id]) {
            mainEntry.difficulties[diff.id] = { rankings: [] };
          }

          const mainRankings = mainEntry.difficulties[diff.id].rankings;
          let merged = 0;

          for (const altBoss of altRankings) {
            const encId = altBoss.encounter?.id;
            const mainBoss = mainRankings.find(r => r.encounter?.id === encId);

            const tagged = { ...altBoss, _srcChar: alt.name, _srcRealm: altServerSlug };

            if (!mainBoss) {
              mainRankings.push(tagged);
              merged++;
            } else if (altBoss.rankPercent > mainBoss.rankPercent) {
              Object.assign(mainBoss, tagged);
              merged++;
            }
          }

          if (merged > 0) {
            console.log(`    ${diff.name}: merged ${merged} better parse(s) from ${alt.name}`);
          }
        }

        // Supplemental zones for alt
        for (const supZone of SUPPLEMENTAL_ZONES) {
          for (const diff of DIFFICULTIES) {
            let result = await fetchWCLZoneRankings(alt.name, altServerSlug, 'US', diff.id, altMetric, partId, supZone.zoneId);
            await sleep(150);
            let altRankings = (result?.rankings || []).filter(r => r.rankPercent);
            if (altRankings.length === 0) continue;

            const wclSpec = altRankings[0].spec;
            const wclIsHealer = isHealerSpec(wclSpec);
            const weUsedHps = altMetric === 'hps';
            if (wclIsHealer && !weUsedHps) {
              result = await fetchWCLZoneRankings(alt.name, altServerSlug, 'US', diff.id, 'hps', partId, supZone.zoneId);
              await sleep(150);
              altRankings = (result?.rankings || []).filter(r => r.rankPercent);
            } else if (!wclIsHealer && weUsedHps) {
              result = await fetchWCLZoneRankings(alt.name, altServerSlug, 'US', diff.id, 'dps', partId, supZone.zoneId);
              await sleep(150);
              altRankings = (result?.rankings || []).filter(r => r.rankPercent);
            }
            if (altRankings.length === 0) continue;

            if (!mainEntry.difficulties[diff.id]) {
              mainEntry.difficulties[diff.id] = { rankings: [] };
            }
            const mainRankings = mainEntry.difficulties[diff.id].rankings;
            let merged = 0;
            for (const altBoss of altRankings) {
              const encId = altBoss.encounter?.id;
              const mainBoss = mainRankings.find(r => r.encounter?.id === encId);
              const tagged = { ...altBoss, _srcChar: alt.name, _srcRealm: altServerSlug };
              if (!mainBoss) {
                mainRankings.push(tagged);
                merged++;
              } else if (altBoss.rankPercent > mainBoss.rankPercent) {
                Object.assign(mainBoss, tagged);
                merged++;
              }
            }
            if (merged > 0) {
              console.log(`    ${diff.name} ${supZone.name}: merged ${merged} better parse(s) from ${alt.name}`);
            }
          }
        }

        const altIdx = allRaiderData.findIndex(r => r.name.toLowerCase() === alt.name.toLowerCase());
        if (altIdx !== -1) {
          allRaiderData.splice(altIdx, 1);
          console.log(`    Removed ${alt.name} from raider list (merged into ${merge.main})`);
        }
      }
    }

    // Build difficulty data for this partition
    const difficultyData = {};

    for (const diff of DIFFICULTIES) {
      const diffRaiders = processRaidersForDifficulty(allRaiderData, diff.id);
      const stats = calculateStats(diffRaiders);

      difficultyData[diff.id] = {
        id: diff.id,
        name: diff.name,
        stats: stats,
        raiders: diffRaiders
      };

      console.log(`  ${diff.name}: ${diffRaiders.length} raiders, ${stats.guildAvg}% avg`);
    }

    let defaultDifficulty = 4;
    const mythicCount = difficultyData[5].raiders.length;
    const heroicCount = difficultyData[4].raiders.length;
    if (mythicCount > 0 && mythicCount >= heroicCount * 0.5) {
      defaultDifficulty = 5;
    } else if (heroicCount === 0 && difficultyData[3].raiders.length > 0) {
      defaultDifficulty = 3;
    }

    partitionResults[partLabel] = {
      partitionId: partId,
      label: partLabel,
      defaultDifficulty: defaultDifficulty,
      difficulties: difficultyData
    };
  }

  let defaultPartition = WCL_PARTITIONS[0].label;
  let maxRaiderCount = 0;
  for (const [label, pData] of Object.entries(partitionResults)) {
    const total = Object.values(pData.difficulties).reduce((s, d) => s + d.raiders.length, 0);
    if (total > maxRaiderCount) {
      maxRaiderCount = total;
      defaultPartition = label;
    }
  }

  const snapshots = buildSnapshots(raiders);

  const defaultPartitionData = partitionResults[defaultPartition];

  // Build output — zoneName now uses CONFIG.raidName instead of hardcoded value
  const output = {
    updated: new Date().toISOString(),
    zoneID: WCL_ZONE_ID,
    zoneName: CONFIG.raidName,
    bosses: RAID_BOSSES,
    defaultPartition: defaultPartition,
    defaultDifficulty: defaultPartitionData.defaultDifficulty,
    partitions: partitionResults,
    difficulties: defaultPartitionData.difficulties,
    rioSnapshot: snapshots.rioSnapshot,
    kshSnapshot: snapshots.kshSnapshot
  };

  detectEvents(prevData, output, raiders, activity);

  const outputPath = 'wcl-data.json';
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  saveActivity(activity);

  console.log('');
  console.log(`Output written to ${outputPath}`);
  console.log(`Default partition: ${defaultPartition} (difficulty: ${DIFFICULTIES.find(d => d.id === defaultPartitionData.defaultDifficulty).name})`);
  console.log('');
  console.log(`Completed: ${new Date().toISOString()}`);
}

// Run
main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
