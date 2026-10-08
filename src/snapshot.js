// Public, name-free snapshot data — the counterpart to aggregate.js for
// the per-school snapshot page and the recognition categories. Reads
// src/children.js's private registry but NEVER forwards a name or a raw
// child ID out of this module; everything it returns is a count.
//
// Two distinct kinds of "change" exist in this codebase, deliberately:
//  - aggregate.js's "Rising Fast" (public Schools tab) compares the
//    OVERALL % on-track between two rounds for a school — simple,
//    already built, but can drift if which children got sampled changes
//    between rounds.
//  - This module's "movement" compares the SAME child's level between
//    their two most recent visits (different rounds, not just different
//    submissions within one round) — what Michael asked for specifically
//    ("linking the same students' assessments over time"), more precise,
//    needs the child-linking registry to exist. The Fastest Growth
//    recognition category below is built on THIS more precise movement
//    data, not the Rising Fast aggregate — a school can differ between
//    the two if which children got tested changed between rounds.
import { ROUND_KEYS, computeRound } from './rounds.js';
import { SCHOOLS } from './schools.js';

function emptyMovement() {
  return { up: 0, same: 0, down: 0, n: 0 };
}

// A child's own round order follows ROUND_KEYS (pilot, round1, round2,
// round3) — whichever of those they have records in, in that fixed order,
// not sorted by raw date. Two records in the SAME round (e.g. an
// accidental repeat test within one visit) are not "movement"; only the
// latest record within each round is kept before comparing.
function latestPerRound(records) {
  const byRound = {};
  for (const rec of records) {
    const computed = computeRound(rec.date);
    if (!computed) continue;
    const key = computed.round;
    if (!byRound[key] || new Date(rec.date) > new Date(byRound[key].date)) byRound[key] = rec;
  }
  return ROUND_KEYS.map((k) => byRound[k]).filter(Boolean);
}

function delta(prevLevel, nowLevel) {
  if (nowLevel > prevLevel) return 'up';
  if (nowLevel < prevLevel) return 'down';
  return 'same';
}

export function buildSnapshot(registry, summary) {
  const bySchool = {};
  const schoolParticipation = {};

  for (const child of Object.values(registry || {})) {
    const schoolId = child.school_id;
    if (!schoolId) continue;
    if (!schoolParticipation[schoolId]) schoolParticipation[schoolId] = { tested: 0, off_roster: 0 };
    schoolParticipation[schoolId].tested++;
    if (child.origin === 'off_roster') schoolParticipation[schoolId].off_roster++;

    const rounds = latestPerRound(child.records);
    if (rounds.length < 2) continue; // nothing to compare yet for this child
    const prev = rounds[rounds.length - 2];
    const now = rounds[rounds.length - 1];
    const grade = now.grade; // grade can shift year to year; use the most recent

    if (!bySchool[schoolId]) bySchool[schoolId] = { by_grade: {} };
    if (!bySchool[schoolId].by_grade[grade]) {
      bySchool[schoolId].by_grade[grade] = { reading: emptyMovement(), arithmetic: emptyMovement() };
    }
    const g = bySchool[schoolId].by_grade[grade];
    g.reading[delta(prev.reading_level, now.reading_level)]++;
    g.reading.n++;
    g.arithmetic[delta(prev.arithmetic_level, now.arithmetic_level)]++;
    g.arithmetic.n++;
  }

  // Recognition: Full Participation is computable from a single visit
  // (lowest off-roster rate). The others need matched-child movement data
  // across at least two visits, which — honestly — doesn't exist yet for
  // any school while 2026 is still a single Pilot snapshot; they return
  // null rather than a misleading empty ranking.
  const participationRanking = Object.entries(schoolParticipation)
    .filter(([, p]) => p.tested > 0)
    .map(([schoolId, p]) => ({
      school_id: schoolId,
      school_name: SCHOOLS[schoolId]?.name || `School ${schoolId}`,
      tested: p.tested,
      off_roster_rate: Math.round((p.off_roster / p.tested) * 100),
    }))
    .sort((a, b) => a.off_roster_rate - b.off_roster_rate);

  const hasMovementData = Object.keys(bySchool).length > 0;
  let noOneLeftBehind = null;
  let fastestGrowth = null;
  if (hasMovementData) {
    const leftBehindScored = [];
    const growthScored = [];
    for (const [schoolId, s] of Object.entries(bySchool)) {
      let up = 0, down = 0, n = 0;
      for (const g of Object.values(s.by_grade)) {
        up += g.reading.up + g.arithmetic.up;
        down += g.reading.down + g.arithmetic.down;
        n += g.reading.n + g.arithmetic.n;
      }
      if (n === 0) continue;
      const name = SCHOOLS[schoolId]?.name || `School ${schoolId}`;
      leftBehindScored.push({ school_id: schoolId, school_name: name, rate: Math.round((up / n) * 100) });
      // Net movement: up minus down as a share of all comparisons — unlike
      // No One Left Behind (pure up-rate), this also penalizes a school
      // with a lot of backward movement alongside its forward movement.
      growthScored.push({ school_id: schoolId, school_name: name, net_rate: Math.round(((up - down) / n) * 100) });
    }
    noOneLeftBehind = leftBehindScored.length ? leftBehindScored.sort((a, b) => b.rate - a.rate) : null;
    fastestGrowth = growthScored.length ? growthScored.sort((a, b) => b.net_rate - a.net_rate) : null;
  }

  // Consistent Excellence: sustained on-track performance, not a single
  // good round. Ranked by the WORSE of a school's two most recent rounds
  // (not the average), so a school that was high then dropped scores
  // lower than one that held steady — needs real summary data across 2+
  // rounds for the SAME school, which doesn't exist yet while there's
  // only Pilot data; returns null rather than a one-round ranking.
  let consistentExcellence = null;
  if (summary) {
    const scored = [];
    for (const year of summary.years || []) {
      const Y = summary.by_year[year];
      for (const [schoolId, school] of Object.entries(Y.schools || {})) {
        let roundsWithData = [];
        for (const key of ROUND_KEYS) {
          let n = 0, top = 0;
          for (const g of Object.values(school.grades)) {
            const b = g[key];
            if (b && b.n) { n += b.n; top += b.reading[3] + b.arithmetic[3]; }
          }
          if (n > 0) roundsWithData.push(Math.round((top / (n * 2)) * 100));
        }
        if (roundsWithData.length >= 2) {
          const [prevPct, nowPct] = roundsWithData.slice(-2);
          scored.push({
            school_id: schoolId,
            school_name: SCHOOLS[schoolId]?.name || `School ${schoolId}`,
            sustained_rate: Math.min(prevPct, nowPct),
          });
        }
      }
    }
    consistentExcellence = scored.length ? scored.sort((a, b) => b.sustained_rate - a.sustained_rate) : null;
  }

  return {
    by_school: bySchool,
    recognition: {
      full_participation: participationRanking.length ? participationRanking : null,
      no_one_left_behind: noOneLeftBehind,
      fastest_growth: fastestGrowth,
      consistent_excellence: consistentExcellence,
    },
  };
}
