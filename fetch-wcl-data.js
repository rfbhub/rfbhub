/**
 * RFB Hub - WCL Data Fetcher
 * Runs via GitHub Actions to cache Warcraft Logs parse data
 * 
 * Raider.IO data is fetched live on site visit (fast, no auth needed)
 * WCL data is cached here (slow API, needs auth, rarely changes)
 */

const fs = require('fs');

// Config
const GUILD_REGION = 'us';
const GUILD_REALM = 'stormrage';
const GUILD_NAME = 'Rolling For Blame';
const RAID_TIER = 'tier-mn-1';
const WCL_ZONE_ID = 46; // Midnight Falls

// Difficulties to fetch
const DIFFICULTIES = [
  { id: 3, name: 'Normal' },
  { id: 4, name: 'Heroic' },
  { id: 5, name: 'Mythic' }
];

// WCL credentials from GitHub Secrets
const WCL_CLIENT = process.env.WCL_CLIENT;
const WCL_SECRET = process.env.WCL_SECRET;

// All 9 bosses in raid order
const RAID_BOSSES = [
  {name: "Imperator Averzian", short: "Averzian"},
  {name: "Vorasius", short: "Vorasius"},
  {name: "Fallen Kirin", short: "Fallen-Ki…"},
  {name: "Vaelgor", short: "Vaelgor"},
  {name: "Lightblinder", short: "Lightblin…"},
  {name: "Crown", short: "Crown"},
  {name: "Chimaerus", short: "Chimaerus"},
  {name: "Belo'ren", short: "Belo'ren"},
  {name: "L'ura", short: "L'ura"}
];

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

// Fetch zone rankings from WCL for a specific difficulty
async function fetchWCLZoneRankings(name, serverSlug, serverRegion, difficulty) {
  const token = await getWCLToken();
  
  const query = `{
    characterData {
      character(name: "${name}", serverSlug: "${serverSlug}", serverRegion: "${serverRegion}") {
        zoneRankings(zoneID: ${WCL_ZONE_ID}, difficulty: ${difficulty})
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

// Main execution
async function main() {
  console.log('=== RFB Hub WCL Data Fetch ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');
  
  // Validate credentials
  if (!WCL_CLIENT || !WCL_SECRET) {
    throw new Error('Missing WCL_CLIENT or WCL_SECRET environment variables');
  }
  
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
    
    const raiderData = {
      name: char.name,
      class: char.class,
      realm: serverSlug,
      difficulties: {}
    };
    
    // Fetch each difficulty
    for (const diff of DIFFICULTIES) {
      const zoneRankings = await fetchWCLZoneRankings(char.name, serverSlug, 'US', diff.id);
      
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
  
  // Determine default difficulty (highest with data)
  let defaultDifficulty = 4; // Heroic by default
  if (difficultyData[5].raiders.length > 0) {
    defaultDifficulty = 5; // Mythic if they have kills
  } else if (difficultyData[4].raiders.length === 0 && difficultyData[3].raiders.length > 0) {
    defaultDifficulty = 3; // Normal if no Heroic
  }
  
  // Build output
  const output = {
    updated: new Date().toISOString(),
    zoneID: WCL_ZONE_ID,
    zoneName: 'Midnight Falls',
    bosses: RAID_BOSSES,
    defaultDifficulty: defaultDifficulty,
    difficulties: difficultyData
  };
  
  // Write to file
  const outputPath = 'wcl-data.json';
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
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
