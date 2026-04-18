/**
 * Guild Hub - Weekly Recap Generator
 *
 * Diffs the two most recent snapshots in history/ and produces
 * recap.json with the week's highlights. Designed to run as a
 * GitHub Action step right after snapshot-week.js.
 *
 * Output: recap.json (consumed by index.html's recap UI)
 *
 * Categories generated:
 *   - topClimbers      : biggest M+ score gains
 *   - parseSpotlight   : biggest raid parse average gains
 *   - newPinkParses    : new 99+ boss parses earned this week
 *   - mplusMilestones  : players who crossed KSL (3000) or KSM (3400)
 *   - progression      : raid progression changes (new boss kills)
 *   - gearMovers       : biggest ilvl gains
 *   - newFaces         : players who joined the roster this week
 *   - highKeyPushers   : notable highest key improvements
 *   - guildProgression : guild-wide raid progression change
 */

const fs = require('fs');
const path = require('path');

const HISTORY_DIR = 'history';

// ── Helpers ──────────────────────────────────────────────────

function getSnapshots() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.json') && /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map(f => path.join(HISTORY_DIR, f));
}

function loadJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function raiderMap(snapshot) {
  const m = {};
  for (const r of snapshot.raiders || []) {
    m[r.name.toLowerCase()] = r;
  }
  return m;
}

function wclMap(snapshot, difficulty) {
  const diffs = snapshot.wclData?.difficulties;
  if (!diffs) return {};
  const d = diffs[String(difficulty)];
  if (!d || !d.raiders) return {};
  const m = {};
  for (const r of d.raiders) {
    m[r.name.toLowerCase()] = r;
  }
  return m;
}

function getRio(raider) {
  return raider?.mythic_plus_scores_by_season?.[0]?.scores?.all || 0;
}

function getIlvl(raider) {
  return raider?.gear?.item_level_equipped || 0;
}

function getProgSummary(raider, tier) {
  return raider?.raid_progression?.[tier]?.summary || '';
}

function progScore(raider, tier) {
  const p = raider?.raid_progression?.[tier];
  if (!p) return 0;
  return (p.mythic_bosses_killed || 0) * 100
       + (p.heroic_bosses_killed || 0) * 10
       + (p.normal_bosses_killed || 0);
}

function getHighestKey(raider) {
  const runs = raider?.mythic_plus_best_runs || [];
  if (runs.length === 0) return 0;
  return Math.max(...runs.map(r => r.mythic_level || 0));
}

function getTimedCount(raider) {
  const runs = raider?.mythic_plus_best_runs || [];
  return runs.filter(r => (r.num_keystone_upgrades || 0) > 0).length;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ── Main diff logic ──────────────────────────────────────────

function generateRecap(oldSnap, newSnap) {
  const tier = newSnap.config.raidTier;
  const oldRaiders = raiderMap(oldSnap);
  const newRaiders = raiderMap(newSnap);

  const oldNames = new Set(Object.keys(oldRaiders));
  const newNames = new Set(Object.keys(newRaiders));
  const common = [...newNames].filter(n => oldNames.has(n));

  const recap = {
    generated: new Date().toISOString(),
    weekStart: oldSnap.date,
    weekEnd: newSnap.date,
    seasonName: newSnap.config.seasonName,
    raidName: newSnap.config.raidName,
    guildName: newSnap.config.guildName,
    categories: {}
  };

  // ── Guild Progression ──
  const oldGuildProg = oldSnap.progression?.[tier];
  const newGuildProg = newSnap.progression?.[tier];
  if (oldGuildProg && newGuildProg) {
    const oldSum = oldGuildProg.summary || '';
    const newSum = newGuildProg.summary || '';
    if (oldSum !== newSum) {
      recap.categories.guildProgression = {
        previous: oldSum,
        current: newSum,
        newMythicKills: (newGuildProg.mythic_bosses_killed || 0) - (oldGuildProg.mythic_bosses_killed || 0),
        newHeroicKills: (newGuildProg.heroic_bosses_killed || 0) - (oldGuildProg.heroic_bosses_killed || 0),
        newNormalKills: (newGuildProg.normal_bosses_killed || 0) - (oldGuildProg.normal_bosses_killed || 0)
      };
    }
  }

  // ── Top M+ Climbers ──
  const rioChanges = [];
  for (const name of common) {
    const oldRio = getRio(oldRaiders[name]);
    const newRio = getRio(newRaiders[name]);
    const gain = newRio - oldRio;
    if (gain >= 20) { // minimum threshold to be noteworthy
      rioChanges.push({
        name: newRaiders[name].name,
        class: newRaiders[name].class,
        previous: Math.round(oldRio),
        current: Math.round(newRio),
        gain: Math.round(gain)
      });
    }
  }
  rioChanges.sort((a, b) => b.gain - a.gain);
  if (rioChanges.length > 0) {
    recap.categories.topClimbers = rioChanges.slice(0, 5);
  }

  // ── Parse Spotlight (check all difficulties, prefer highest) ──
  const parseChanges = [];
  for (const diffId of ['5', '4', '3']) { // mythic, heroic, normal
    const oldWcl = wclMap(oldSnap, diffId);
    const newWcl = wclMap(newSnap, diffId);
    const diffName = { '5': 'Mythic', '4': 'Heroic', '3': 'Normal' }[diffId];

    for (const name of Object.keys(newWcl)) {
      if (!oldWcl[name]) continue;
      // Skip if we already have this player from a higher difficulty
      if (parseChanges.some(p => p.name.toLowerCase() === name)) continue;

      const oldAvg = oldWcl[name].avgParse || 0;
      const newAvg = newWcl[name].avgParse || 0;
      const gain = newAvg - oldAvg;
      if (gain >= 5) { // minimum 5% gain to be noteworthy
        parseChanges.push({
          name: newWcl[name].name,
          class: newWcl[name].class,
          difficulty: diffName,
          previous: oldAvg,
          current: newAvg,
          gain: gain
        });
      }
    }
  }
  parseChanges.sort((a, b) => b.gain - a.gain);
  if (parseChanges.length > 0) {
    recap.categories.parseSpotlight = parseChanges.slice(0, 5);
  }

  // ── New Pink Parses (99+) ──
  const pinkParses = [];
  for (const diffId of ['5', '4', '3']) {
    const oldWcl = wclMap(oldSnap, diffId);
    const newWcl = wclMap(newSnap, diffId);
    const diffName = { '5': 'Mythic', '4': 'Heroic', '3': 'Normal' }[diffId];

    for (const name of Object.keys(newWcl)) {
      const oldBosses = {};
      if (oldWcl[name]) {
        for (const b of oldWcl[name].bosses || []) {
          oldBosses[b.name] = b.parse;
        }
      }
      for (const b of newWcl[name].bosses || []) {
        if (b.parse >= 99 && (oldBosses[b.name] || 0) < 99) {
          pinkParses.push({
            name: newWcl[name].name,
            class: newWcl[name].class,
            boss: b.name,
            parse: b.parse,
            previousParse: oldBosses[b.name] || null,
            difficulty: diffName,
            dps: b.dps || null
          });
        }
      }
    }
  }
  if (pinkParses.length > 0) {
    recap.categories.newPinkParses = pinkParses;
  }

  // ── M+ Milestones ──
  const milestones = [];
  for (const name of common) {
    const oldRio = getRio(oldRaiders[name]);
    const newRio = getRio(newRaiders[name]);

    if (newRio >= 3400 && oldRio < 3400) {
      milestones.push({
        name: newRaiders[name].name,
        class: newRaiders[name].class,
        milestone: 'Keystone Myth',
        threshold: 3400,
        score: Math.round(newRio),
        previousScore: Math.round(oldRio)
      });
    } else if (newRio >= 3000 && oldRio < 3000) {
      milestones.push({
        name: newRaiders[name].name,
        class: newRaiders[name].class,
        milestone: 'Keystone Legend',
        threshold: 3000,
        score: Math.round(newRio),
        previousScore: Math.round(oldRio)
      });
    }
  }
  if (milestones.length > 0) {
    recap.categories.mplusMilestones = milestones;
  }

  // ── Raid Progression Changes ──
  const progChanges = [];
  for (const name of common) {
    const oldSum = getProgSummary(oldRaiders[name], tier);
    const newSum = getProgSummary(newRaiders[name], tier);
    const oldScore = progScore(oldRaiders[name], tier);
    const newScore = progScore(newRaiders[name], tier);
    if (newScore > oldScore && oldSum !== newSum) {
      progChanges.push({
        name: newRaiders[name].name,
        class: newRaiders[name].class,
        previous: oldSum,
        current: newSum
      });
    }
  }
  progChanges.sort((a, b) => {
    // Sort mythic first, then heroic, then normal
    const score = s => {
      if (s.includes('M')) return 3;
      if (s.includes('H')) return 2;
      return 1;
    };
    return score(b.current) - score(a.current);
  });
  if (progChanges.length > 0) {
    recap.categories.progression = progChanges.slice(0, 8);
  }

  // ── Gear Movers ──
  const gearChanges = [];
  for (const name of common) {
    const oldIlvl = getIlvl(oldRaiders[name]);
    const newIlvl = getIlvl(newRaiders[name]);
    const gain = newIlvl - oldIlvl;
    if (gain >= 2) { // minimum 2 ilvl to be noteworthy
      gearChanges.push({
        name: newRaiders[name].name,
        class: newRaiders[name].class,
        previous: round1(oldIlvl),
        current: round1(newIlvl),
        gain: round1(gain)
      });
    }
  }
  gearChanges.sort((a, b) => b.gain - a.gain);
  if (gearChanges.length > 0) {
    recap.categories.gearMovers = gearChanges.slice(0, 5);
  }

  // ── High Key Pushers ──
  const keyPushers = [];
  for (const name of common) {
    const oldMax = getHighestKey(oldRaiders[name]);
    const newMax = getHighestKey(newRaiders[name]);
    if (newMax > oldMax && newMax >= 10) {
      keyPushers.push({
        name: newRaiders[name].name,
        class: newRaiders[name].class,
        previousKey: oldMax,
        currentKey: newMax
      });
    }
  }
  keyPushers.sort((a, b) => b.currentKey - a.currentKey);
  if (keyPushers.length > 0) {
    recap.categories.highKeyPushers = keyPushers.slice(0, 5);
  }

  // ── New Faces ──
  const newFaces = [];
  for (const name of newNames) {
    if (oldNames.has(name)) continue;
    const r = newRaiders[name];
    newFaces.push({
      name: r.name,
      class: r.class,
      spec: r.active_spec_name || '',
      ilvl: round1(getIlvl(r)),
      rio: Math.round(getRio(r)),
      progression: getProgSummary(r, tier)
    });
  }
  newFaces.sort((a, b) => b.rio - a.rio);
  if (newFaces.length > 0) {
    recap.categories.newFaces = newFaces;
  }

  // ── Summary stats for the header ──
  const totalRaiders = newSnap.raiders.length;
  const avgRio = Math.round(
    newSnap.raiders.reduce((s, r) => s + getRio(r), 0) / totalRaiders
  );
  const avgIlvl = round1(
    newSnap.raiders.reduce((s, r) => s + getIlvl(r), 0) / totalRaiders
  );

  recap.summary = {
    totalRaiders,
    avgRio,
    avgIlvl,
    totalCategories: Object.keys(recap.categories).length,
    totalHighlights: Object.values(recap.categories)
      .reduce((s, cat) => s + (Array.isArray(cat) ? cat.length : 1), 0)
  };

  return recap;
}

// ── Entry point ──────────────────────────────────────────────

function main() {
  const snapshots = getSnapshots();

  if (snapshots.length < 2) {
    console.log('Need at least 2 snapshots to generate a recap.');
    console.log(`Found ${snapshots.length} snapshot(s) in ${HISTORY_DIR}/`);
    if (snapshots.length === 1) {
      console.log('Next week\'s snapshot will enable recap generation.');
    }
    // Write an empty recap so the site doesn't break
    fs.writeFileSync('recap.json', JSON.stringify({ empty: true, reason: 'Not enough snapshots yet' }, null, 2));
    return;
  }

  const prevPath = snapshots[snapshots.length - 2];
  const currPath = snapshots[snapshots.length - 1];

  console.log('Generating weekly recap...');
  console.log(`  Previous: ${prevPath}`);
  console.log(`  Current:  ${currPath}`);

  const oldSnap = loadJSON(prevPath);
  const newSnap = loadJSON(currPath);

  const recap = generateRecap(oldSnap, newSnap);

  fs.writeFileSync('recap.json', JSON.stringify(recap, null, 2));

  const cats = recap.categories;
  console.log('');
  console.log('Recap generated:');
  console.log(`  Period: ${recap.weekStart} to ${recap.weekEnd}`);
  console.log(`  Categories with highlights: ${recap.summary.totalCategories}`);
  console.log(`  Total highlights: ${recap.summary.totalHighlights}`);
  if (cats.topClimbers) console.log(`    Top Climbers: ${cats.topClimbers.length}`);
  if (cats.parseSpotlight) console.log(`    Parse Spotlight: ${cats.parseSpotlight.length}`);
  if (cats.newPinkParses) console.log(`    New Pink Parses: ${cats.newPinkParses.length}`);
  if (cats.mplusMilestones) console.log(`    M+ Milestones: ${cats.mplusMilestones.length}`);
  if (cats.progression) console.log(`    Progression: ${cats.progression.length}`);
  if (cats.gearMovers) console.log(`    Gear Movers: ${cats.gearMovers.length}`);
  if (cats.highKeyPushers) console.log(`    High Key Pushers: ${cats.highKeyPushers.length}`);
  if (cats.newFaces) console.log(`    New Faces: ${cats.newFaces.length}`);
  if (cats.guildProgression) console.log(`    Guild Progression: ${cats.guildProgression.previous} -> ${cats.guildProgression.current}`);
  console.log('');
  console.log('Wrote recap.json');
}

main();
