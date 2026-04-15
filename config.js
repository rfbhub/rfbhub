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
  ilvlBaseline: 260,                // Baseline ilvl for GPS formula; advances each tier

  // Raid Schedule - drives the "next raid" countdown widget
  raidSchedule: {
    days: ["Wednesday", "Friday"],      // Raid nights (full day names)
    startTime: "8:00 PM",               // 12-hour ("8:00 PM") or 24-hour ("20:00")
    endTime: "11:00 PM",                // 12-hour ("11:00 PM") or 24-hour ("23:00")
    timezone: "America/New_York"        // IANA timezone, affects the countdown math
  },

  // Recruitment block - edit to reflect current needs. Set status to "closed" to hide.
  recruitment: {
    status: "open",                     // "open" | "selective" | "closed"
    needs: "2 DPS",           // Short list of roles being recruited
    notes: "Mythic experience preferred",
    contactName: "Hashmaker",           // Who to reach out to
    contactDiscord: "hmaker100"         // Discord username (no # suffix needed)
  },

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
