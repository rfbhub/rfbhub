/**
 * Guild Hub - Shared Config
 *
 * Single source of truth for guild identity, branding, and current tier.
 * Loaded in the browser by index.html via <script src="config.js">,
 * and in Node by fetch-wcl-data.js via require('./config.js').
 *
 * Edit these values to customize for your guild or to flip to a new tier.
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
  raidTier: "tier-mn-1",            // Raider.IO tier key
  raidName: "Midnight Falls",       // Raid name for display
  seasonName: "Midnight S1",        // Season name for header
  wclZoneId: 46,                    // Warcraft Logs zone ID
  wclPartitions: [
    {id: null, label: "All"},       // No partition param = WCL "All" (best across patches). Default view.
    {id: 1, label: "12.0"},         // Patch 12.0 partition
    {id: 2, label: "12.0.5"}        // Patch 12.0.5 partition
  ],
  ilvlBaseline: 260,                // Baseline ilvl for GPS formula; advances each tier

  // WowAudit - curated roster source of truth for RFB raiders.
  // The API returns the exact list of tracked characters. Everyone on it = raider.
  // Used by update-roster.js, snapshot, recap, and wcl scripts.
  // For GvG opponents (no WowAudit access), the automated filter below is used instead.
  wowAudit: {
    apiUrl: "https://wowaudit.com/v1/characters",
    apiKey: "e6d9c5d272bfd3250cd18aa9b3aa2767d300be1c4939bf9b1b6515182484af54"
  },

  // Roster Filter - fallback for GvG opponents and any context without WowAudit.
  // A raider is someone who has mythic kills/parses OR meets the ilvl minimum.
  // Players with mythic kills bypass the ilvl check (handles PvP gear logout).
  rosterFilter: {
    minIlvl: 269,                     // Minimum equipped ilvl (OR has mythic kills)
    minLevel: 90,                     // Minimum character level (90 = Midnight cap)
  },

  // M+ Roster - guild members above this IO threshold are included on the site
  // even if they're not on the WowAudit raid roster. They appear on Keystone,
  // Power Rankings, Gear Check, and Weekly Recap tabs.
  mplusThreshold: 3000,               // Minimum R.IO score for M+ roster inclusion

  // Raid Schedule - drives the "next raid" countdown widget
  raidSchedule: {
    days: ["Wednesday", "Friday"],      // Raid nights (full day names)
    startTime: "8:00 PM",               // 12-hour ("8:00 PM") or 24-hour ("20:00")
    endTime: "11:00 PM",                // 12-hour ("11:00 PM") or 24-hour ("23:00")
    timezone: "America/New_York"        // IANA timezone, affects the countdown math
  },

  // Recruitment block - status controls the badge color and text.
  // "open" = green RECRUITING, "selective" = yellow SELECTIVE, "closed" = red CLOSED
  // The card always shows regardless of status so visitors can see current state.
  recruitment: {
    status: "open",                     // "open" | "selective" | "closed"
    needs: "Exceptional Players",           // Short list of roles being recruited
    notes: "Mythic experience required",
    closedMessage: "Exceptional players are always welcome to apply",  // Shown when status is "closed"
    contactName: "Hashmaker",           // Who to reach out to
    contactDiscord: "hmaker100",        // Discord username (no # suffix needed)
    applyUrl: "https://apply.wowaudit.com/us/stormrage/rolling-for-blame/rolling-for-blame?preview"
  },

  // Alt Merge - combine WCL parses from alts into main character for rankings.
  // Only affects parse/power rankings. Alts still appear normally for M+, gear, etc.
  // Each entry: main character gets the best parse per boss across all listed alts.
  altMerge: [
    { main: "Hashmaker", mainRealm: "illidan", alts: [{ name: "Hashmakr", realm: "illidan" }] }
  ],

  // Raid Bosses (update each tier)
  bosses: [
    {name: "Imperator Averzian", short: "Averzian"},
    {name: "Vorasius", short: "Vorasius"},
    {name: "Fallen Kirin", short: "Fallen-Ki\u2026"},
    {name: "Vaelgor", short: "Vaelgor"},
    {name: "Lightblinder", short: "Lightblin\u2026"},
    {name: "Crown", short: "Crown"},
    {name: "Chimaerus", short: "Chimaerus"},
    {name: "Belo'ren", short: "Belo'ren"},
    {name: "Midnight Falls", short: "L'ura"}
  ]
};

// Node export (browser ignores this line because `module` is undefined in the browser,
// and the try/catch keeps the browser from throwing).
try { if (typeof module !== 'undefined' && module.exports) { module.exports = CONFIG; } } catch (e) {}
