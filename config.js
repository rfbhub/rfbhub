/**
 * Guild Hub - Shared Config
 *
 * Single source of truth for guild identity, branding, and current tier.
 * Loaded in the browser by index.html via <script src="config.js">,
 * and in Node by fetch-wcl-data.js via require('./config.js').
 *
 * Edit these values to customize for your guild or to flip to a new tier.
 *
 * *** SEASON 2 — The Venomous Abyss (Patch 12.1) ***
 * Prepared: Aug 11, 2026
 * Deploy: Aug 18, 2026 (raid opens)
 * TODO before deploy: confirm raidTier from Raider.IO API, verify boss names against WCL zone 54
 */

const CONFIG = {
  // Guild Info
  guildName: "Rolling For Blame",   // Your guild name
  region: "us",                     // us, eu, kr, tw
  realm: "stormrage",               // Realm the guild is registered to (identity lookup only; player realms are per-character)

  // Site Branding
  siteName: "RFB Hub",              // Browser tab title
  logoLeft: "RFB",                  // Left side of logo (colored)
  logoRight: "Hub",                 // Right side of logo (dark)
  siteUrl: "https://rfbhub.io",     // Your site URL (for share links)

  // Current Raid Tier (update each tier)
  raidTier: "the-venomous-abyss",    // Raider.IO tier key (confirmed from R.IO API raid_progression)
  raidName: "The Venomous Abyss",   // Raid name for display
  seasonName: "Midnight S2",        // Season name for header
  wclZoneId: 53,                    // Warcraft Logs zone ID (confirmed from WCL URLs)
  wclPartitions: [
    {id: null, label: "All"}        // Single partition at launch; add 12.1 partition once WCL creates it
  ],
  ilvlBaseline: 260,                // Keep S1 baseline for now; raise gradually as S2 gear scales up

  // Supplemental zones - extra raids fetched alongside the main tier.
  // Sporefall/Rotmire removed for S2 (archived with S1 data).
  // Add any 12.1.x supplemental raids here when they release.
  supplementalZones: [],

  // WowAudit - curated roster source of truth for RFB raiders.
  wowAudit: {
    apiUrl: "https://wowaudit.com/v1/characters",
    apiKey: "e6d9c5d272bfd3250cd18aa9b3aa2767d300be1c4939bf9b1b6515182484af54"
  },

  // Roster Filter - fallback for GvG opponents and any context without WowAudit.
  rosterFilter: {
    minIlvl: 269,                     // Keep S1 threshold for now; raise as S2 gear scales up
    minLevel: 90,                     // Minimum character level (90 = Midnight cap)
  },

  // M+ Roster - guild members above this IO threshold are included on the site
  mplusThreshold: 3000,               // Minimum R.IO score for M+ roster inclusion

  // Raid Schedule - drives the "next raid" countdown widget
  raidSchedule: {
    days: ["Wednesday", "Friday"],      // Raid nights (full day names)
    startTime: "8:00 PM",
    endTime: "11:00 PM",
    timezone: "America/New_York"
  },

  // Recruitment block
  recruitment: {
    status: "open",
    needs: "Exceptional Players",
    notes: "Mythic experience required",
    closedMessage: "Exceptional players are always welcome to apply",
    contactName: "Hashmaker",
    contactDiscord: "hmaker100",
    applyUrl: "https://apply.wowaudit.com/us/stormrage/rolling-for-blame/rolling-for-blame?preview"
  },

  // Alt Merge - combine WCL parses from alts into main character for rankings.
  altMerge: [
    { main: "Hashmaker", mainRealm: "illidan", alts: [{ name: "Hashmakr", realm: "illidan" }] }
  ],

  // Raid Bosses — The Venomous Abyss (8 bosses)
  // Order follows raid progression / Blizzard's boss listing.
  // TODO: Verify exact names match WCL zone 54 on Aug 18.
  bosses: [
    {name: "Nek'zali the Soulcoiler", short: "Nek'zali"},
    {name: "Entombed Sentinels", short: "Sentinels"},
    {name: "Vashnik the Malignant", short: "Vashnik"},
    {name: "The Lost Explorers", short: "Explorers"},
    {name: "Sszorak", short: "Sszorak"},
    {name: "The Twin Fangs", short: "Twin Fangs"},
    {name: "The Coiled Altar", short: "Altar"},
    {name: "Ula'tek", short: "Ula'tek"}
  ]
};

// Node export (browser ignores this line because `module` is undefined in the browser,
// and the try/catch keeps the browser from throwing).
try { if (typeof module !== 'undefined' && module.exports) { module.exports = CONFIG; } } catch (e) {}
