/**
 * Guild Hub - WCL Data Fetcher
 * Runs via GitHub Actions to cache Warcraft Logs parse data
 * 
 * Raider.IO data is fetched live on site visit (fast, no auth needed)
 * WCL data is cached here (slow API, needs auth, rarely changes)
 */

const fs = require('fs');

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  GUILD HUB CONFIG - Edit these values to match your index.html CONFIG    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

const CONFIG = {
  // Guild Info (must match index.html)
  guildName: "Rolling For Blame",
  region: "us",                     // us, eu, kr, tw
  realm: "stormrage",               // Realm name (lowercase, hyphens for spaces)
  
  // Current Raid Tier (must match index.html)
  raidTier: "tier-mn-1",            // Raider.IO tier key
  raidName: "Midnight Falls",       // Raid name for display
  wclZoneId: 46,                    // Warcraft Logs zone ID
  
  // Raid Bosses (must match index.html)
  bosses: [
    {name: "Imperator Averzian", short: "Averzian"},
    {name: "Vorasius", short: "Vorasius"},
    {name: "Fallen Kirin", short: "Fallen-Ki…"},
    {name: "Vaelgor", short: "Vaelgor"},
    {name: "Lightblinder", short: "Lightblin…"},
    {name: "Crown", short: "Crown"},
    {name: "Chimaerus", short: "Chimaerus"},
    {name: "Belo'ren", short: "Belo'ren"},
    {name: "Midnight Falls", short: "L'ura"}
  ]
};

// ═══════════════════════════════════════════════════════════════════════════
// Internal setup (don't edit below unless you know what you're doing)
// ═══════════════════════════════════════════════════════════════════════════

const GUILD_REGION = CONFIG.region;
const GUILD_REALM = CONFIG.realm;
const GUILD_NAME = CONFIG.guildName;
const RAID_TIER = CONFIG.raidTier;
const WCL_ZONE_ID = CONFIG.wclZoneId;
const RAID_BOSSES = CONFIG.bosses;

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
}

// Fetch guild roster from Raider.IO
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
// metric: 'dps' (default) or 'hps' for healers. WCL defaults to dps if omitted,
// which means healers get ranked on their damage output, which is nonsense.
async function fetchWCLZoneRankings(name, serverSlug, serverRegion, difficulty, metric) {
  const token = await getWCLToken();
  const m = metric === 'hps' ? 'hps' : 'dps';

  const query = `{
    characterData {
      character(name: "${name}", serverSlug: "${serverSlug}", serverRegion: "${serverRegion}") {
        zoneRankings(zoneID: ${WCL_ZONE_ID}, difficulty: ${difficulty}, metric: ${m})
      }
    }
  }`;
  
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
    return null;
  }
  
  const data = await response.json();
  
  if (data.errors) {
    console.log(`    WCL GraphQL errors for ${name} (diff ${difficulty}):`, data.errors[0]?.message);
    return null;
  }
  
  return data.data?.characterData?.character?.zoneRankings;
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
      bosses: rankings.map(r => ({
        name: r.encounter.name,
        encounterID: r.encounter.id,
        parse: Math.floor(r.rankPercent),
        spec: r.spec,
        dps: Math.round(r.bestAmount)
      }))
    });
  }
  
  // Sort by average parse
  raidersWithParses.sort((a, b) => b.avgParse - a.avgParse);
  
  return raidersWithParses;
}

// Calculate stats for a difficulty
function calculateStats(raidersWithParses) {
  if (raidersWithParses.length === 0) {
    return {
      guildAvg: 0,
      raidersLogged: 0,
      parseBreakdown: { pink: 0, purple: 0, blue: 0, green: 0, gray: 0 },
      bestParse: { parse: 0, player: '', boss: '' }
    };
  }
  
  const guildAvg = Math.floor(raidersWithParses.reduce((s, r) => s + r.avgParse, 0) / raidersWithParses.length);
  
  let pinkParses = 0, purpleParses = 0, blueParses = 0, greenParses = 0, grayParses = 0;
  let bestParse = { parse: 0, player: '', boss: '' };
  
  for (const r of raidersWithParses) {
    for (const b of r.bosses) {
      if (b.parse >= 99) pinkParses++;
      else if (b.parse >= 95) purpleParses++;
      else if (b.parse >= 75) blueParses++;
      else if (b.parse >= 50) greenParses++;
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
  // Prune events older than 30 days
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  activity.events = activity.events.filter(e => new Date(e.timestamp).getTime() > cutoff);
  
  // Keep only most recent 50 events
  activity.events = activity.events.slice(0, 50);
  
  fs.writeFileSync('activity.json', JSON.stringify(activity, null, 2));
  console.log(`Saved ${activity.events.length} events to activity.json`);
}

function addEvent(activity, type, icon, text, detail) {
  // Check for duplicate (same type + text in last 24 hours)
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
  
  const diffNames = { 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };
  const diffIcons = { 3: '🟢', 4: '🟣', 5: '🟠' };
  
  // Track previous boss kills per difficulty
  const prevBosses = {};
  const newBosses = {};
  
  for (const diffId of [3, 4, 5]) {
    prevBosses[diffId] = new Set();
    newBosses[diffId] = new Set();
    
    // Get previous boss kills
    if (prevData?.difficulties?.[diffId]?.raiders) {
      for (const raider of prevData.difficulties[diffId].raiders) {
        for (const boss of raider.bosses || []) {
          prevBosses[diffId].add(boss.name);
        }
      }
    }
    
    // Get new boss kills
    if (newData.difficulties?.[diffId]?.raiders) {
      for (const raider of newData.difficulties[diffId].raiders) {
        for (const boss of raider.bosses || []) {
          newBosses[diffId].add(boss.name);
        }
      }
    }
    
    // Detect first kills
    for (const bossName of newBosses[diffId]) {
      if (!prevBosses[diffId].has(bossName)) {
        addEvent(activity, 'first_kill', diffIcons[diffId], 
          `First ${diffNames[diffId]} ${shortBoss(bossName)} kill!`,
          bossName
        );
      }
    }
  }
  
  // Track previous pink/purple parses
  const prevPinkParses = new Set();
  const prevPurpleParses = new Set();
  
  if (prevData?.difficulties) {
    for (const diffId of [3, 4, 5]) {
      const raiders = prevData.difficulties[diffId]?.raiders || [];
      for (const raider of raiders) {
        for (const boss of raider.bosses || []) {
          const key = `${raider.name}-${boss.name}-${diffId}`;
          if (boss.parse >= 99) prevPinkParses.add(key);
          else if (boss.parse >= 95) prevPurpleParses.add(key);
        }
      }
    }
  }
  
  // Detect new pink/purple parses
  for (const diffId of [3, 4, 5]) {
    const raiders = newData.difficulties?.[diffId]?.raiders || [];
    for (const raider of raiders) {
      for (const boss of raider.bosses || []) {
        const key = `${raider.name}-${boss.name}-${diffId}`;
        
        if (boss.parse >= 99 && !prevPinkParses.has(key)) {
          addEvent(activity, 'pink_parse', '💗',
            `${raider.name} logged a 99% on ${shortBoss(boss.name)}!`,
            `${diffNames[diffId]} ${boss.name}`
          );
        } else if (boss.parse >= 95 && boss.parse < 99 && !prevPurpleParses.has(key) && !prevPinkParses.has(key)) {
          addEvent(activity, 'purple_parse', '💜',
            `${raider.name} logged a ${boss.parse}% on ${shortBoss(boss.name)}`,
            `${diffNames[diffId]} ${boss.name}`
          );
        }
      }
    }
  }
  
  // Track R.IO milestones (3000+)
  const prev3kPlayers = new Set();
  if (prevData?.rioSnapshot) {
    for (const p of prevData.rioSnapshot) {
      if (p.rio >= 3000) prev3kPlayers.add(p.name);
    }
  }
  
  for (const char of characters) {
    const rio = char.mythic_plus_scores_by_season?.[0]?.scores?.all || 0;
    if (rio >= 3000 && !prev3kPlayers.has(char.name)) {
      addEvent(activity, 'rio_3k', '🔑',
        `${char.name} hit ${Math.round(rio)} R.IO!`,
        '3000+ Club'
      );
    }
  }
  
  // Detect Keystone Hero (all 8 dungeons timed)
  const prevKSH = new Set();
  if (prevData?.kshSnapshot) {
    for (const name of prevData.kshSnapshot) {
      prevKSH.add(name);
    }
  }
  
  for (const char of characters) {
    const runs = char.mythic_plus_best_runs || [];
    const timedCount = runs.filter(r => r.num_keystone_upgrades > 0).length;
    if (timedCount >= 8 && !prevKSH.has(char.name)) {
      addEvent(activity, 'keystone_hero', '🏆',
        `${char.name} earned Keystone Hero!`,
        'All 8 dungeons timed'
      );
    }
  }
}

// Build snapshots for next comparison
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
  
  // Validate credentials
  if (!WCL_CLIENT || !WCL_SECRET) {
    throw new Error('Missing WCL_CLIENT or WCL_SECRET environment variables');
  }
  
  // Load previous data for comparison
  const prevData = loadPreviousData();
  const activity = loadActivity();
  
  // Fetch guild roster
  const guild = await fetchGuildRoster();
  
  if (!guild.members || guild.members.length === 0) {
    throw new Error('No guild members found');
  }
  
  // Fetch details for each member
  console.log('');
  console.log('Fetching character details...');
  
  const characters = [];
  for (let i = 0; i < guild.members.length; i++) {
    const member = guild.members[i];
    const char = member.character;
    
    // Skip low level characters
    if (char.level < 90) continue;
    
    console.log(`[${i + 1}/${guild.members.length}] ${char.name}...`);
    
    const details = await fetchCharacterDetails(char.name, char.realm);
    if (details) {
      characters.push(details);
    }
    
    // Small delay to be nice to the API
    await sleep(100);
  }
  
  console.log(`Fetched details for ${characters.length} characters`);
  
  // Filter to actual raiders (has raid kills)
  const raiders = characters.filter(c => {
    const prog = c.raid_progression?.[RAID_TIER];
    return prog && raidScore(prog) > 0;
  });
  
  console.log(`Filtered to ${raiders.length} raiders with raid kills`);
  console.log('');
  
  // Fetch WCL data for each raider (ALL difficulties)
  console.log('Fetching WCL parse data for all difficulties...');
  
  const allRaiderData = [];
  
  for (let i = 0; i < raiders.length; i++) {
    const char = raiders[i];
    const serverSlug = (char.realm || 'stormrage').toLowerCase().replace(/\s+/g, '-');
    
    console.log(`[${i + 1}/${raiders.length}] ${char.name} (${serverSlug})...`);
    
    // Decide which metric to pull from WCL based on the character's active spec.
    // Healers get hps rankings, everyone else (DPS + tanks) gets dps rankings.
    const metric = isHealerSpec(char.active_spec_name) ? 'hps' : 'dps';

    const raiderData = {
      name: char.name,
      class: char.class,
      spec: char.active_spec_name || null,
      role: metric === 'hps' ? 'healer' : 'dps',
      realm: serverSlug,
      difficulties: {}
    };

    // Fetch each difficulty
    for (const diff of DIFFICULTIES) {
      const zoneRankings = await fetchWCLZoneRankings(char.name, serverSlug, 'US', diff.id, metric);
      
      if (zoneRankings && zoneRankings.rankings) {
        const validRankings = zoneRankings.rankings.filter(r => r.rankPercent);
        if (validRankings.length > 0) {
          raiderData.difficulties[diff.id] = {
            rankings: validRankings
          };
          console.log(`    ${diff.name}: ${validRankings.length} bosses`);
        }
      }
      
      // Rate limit between difficulty calls
      await sleep(150);
    }
    
    // Only add if they have data for at least one difficulty
    if (Object.keys(raiderData.difficulties).length > 0) {
      allRaiderData.push(raiderData);
    }
    
    // Rate limit between characters
    await sleep(100);
  }
  
  console.log('');
  console.log(`Successfully fetched data for ${allRaiderData.length} raiders`);
  
  // Build output for each difficulty
  const difficultyData = {};
  
  for (const diff of DIFFICULTIES) {
    const raiders = processRaidersForDifficulty(allRaiderData, diff.id);
    const stats = calculateStats(raiders);
    
    difficultyData[diff.id] = {
      id: diff.id,
      name: diff.name,
      stats: stats,
      raiders: raiders
    };
    
    console.log(`${diff.name}: ${raiders.length} raiders, ${stats.guildAvg}% avg`);
  }
  
  // Determine default difficulty
  let defaultDifficulty = 4; // Heroic by default
  
  const mythicRaiders = difficultyData[5].raiders.length;
  const heroicRaiders = difficultyData[4].raiders.length;
  
  if (mythicRaiders > 0 && mythicRaiders >= heroicRaiders * 0.5) {
    defaultDifficulty = 5;
  } else if (heroicRaiders === 0 && difficultyData[3].raiders.length > 0) {
    defaultDifficulty = 3;
  }
  
  // Build snapshots for activity tracking
  const snapshots = buildSnapshots(characters);
  
  // Build output
  const output = {
    updated: new Date().toISOString(),
    zoneID: WCL_ZONE_ID,
    zoneName: 'Midnight Falls',
    bosses: RAID_BOSSES,
    defaultDifficulty: defaultDifficulty,
    difficulties: difficultyData,
    rioSnapshot: snapshots.rioSnapshot,
    kshSnapshot: snapshots.kshSnapshot
  };
  
  // Detect events by comparing to previous data
  detectEvents(prevData, output, characters, activity);
  
  // Write files
  const outputPath = 'wcl-data.json';
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  saveActivity(activity);
  
  console.log('');
  console.log(`Output written to ${outputPath}`);
  console.log(`Default difficulty: ${DIFFICULTIES.find(d => d.id === defaultDifficulty).name}`);
  console.log('');
  console.log(`Completed: ${new Date().toISOString()}`);
}

// Run
main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
