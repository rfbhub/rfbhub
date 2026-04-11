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
const WCL_DIFFICULTY = 4; // Heroic

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

// Fetch zone rankings from WCL
async function fetchWCLZoneRankings(name, serverSlug, serverRegion) {
  const token = await getWCLToken();
  
  const query = `{
    characterData {
      character(name: "${name}", serverSlug: "${serverSlug}", serverRegion: "${serverRegion}") {
        zoneRankings(zoneID: ${WCL_ZONE_ID})
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
    console.log(`  WCL fetch failed for ${name}: ${response.status}`);
    return null;
  }
  
  const data = await response.json();
  
  if (data.errors) {
    console.log(`  WCL GraphQL errors for ${name}:`, data.errors[0]?.message);
    return null;
  }
  
  return data.data?.characterData?.character?.zoneRankings;
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
  
  // Fetch WCL data for each raider
  console.log('Fetching WCL parse data...');
  
  const raidersWithParses = [];
  
  for (let i = 0; i < raiders.length; i++) {
    const char = raiders[i];
    const serverSlug = (char.realm || 'stormrage').toLowerCase().replace(/\s+/g, '-');
    
    console.log(`[${i + 1}/${raiders.length}] ${char.name} (${serverSlug})...`);
    
    const zoneRankings = await fetchWCLZoneRankings(char.name, serverSlug, 'US');
    
    if (!zoneRankings || !zoneRankings.rankings) {
      console.log(`  No rankings found`);
      continue;
    }
    
    // Check difficulty
    if (zoneRankings.difficulty !== WCL_DIFFICULTY) {
      console.log(`  Wrong difficulty: ${zoneRankings.difficulty} (want ${WCL_DIFFICULTY})`);
      continue;
    }
    
    // Filter to valid parses
    const rankings = zoneRankings.rankings.filter(r => r.rankPercent);
    
    if (rankings.length === 0) {
      console.log(`  No valid parses`);
      continue;
    }
    
    // Calculate average
    const avgParse = Math.floor(rankings.reduce((s, r) => s + r.rankPercent, 0) / rankings.length);
    
    console.log(`  Found ${rankings.length} bosses, ${avgParse}% avg`);
    
    raidersWithParses.push({
      name: char.name,
      class: char.class,
      realm: serverSlug,
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
    
    // Rate limit: 200ms between WCL requests
    await sleep(200);
  }
  
  // Sort by average parse
  raidersWithParses.sort((a, b) => b.avgParse - a.avgParse);
  
  console.log('');
  console.log(`Successfully processed ${raidersWithParses.length} raiders with parse data`);
  
  // Calculate summary stats
  const guildAvg = raidersWithParses.length > 0 
    ? Math.floor(raidersWithParses.reduce((s, r) => s + r.avgParse, 0) / raidersWithParses.length)
    : 0;
  
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
  
  // Build output
  const output = {
    updated: new Date().toISOString(),
    difficulty: WCL_DIFFICULTY,
    difficultyName: 'Heroic',
    zoneID: WCL_ZONE_ID,
    zoneName: 'Midnight Falls',
    bosses: RAID_BOSSES,
    stats: {
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
    },
    raiders: raidersWithParses
  };
  
  // Write to file
  const outputPath = 'wcl-data.json';
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  console.log('');
  console.log(`Output written to ${outputPath}`);
  console.log(`Guild average: ${guildAvg}%`);
  console.log(`Parse breakdown: ${pinkParses} pink, ${purpleParses} purple, ${blueParses} blue, ${greenParses} green, ${grayParses} gray`);
  console.log(`Best parse: ${bestParse.parse}% by ${bestParse.player} on ${bestParse.boss}`);
  console.log('');
  console.log(`Completed: ${new Date().toISOString()}`);
}

// Run
main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
