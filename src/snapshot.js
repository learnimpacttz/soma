// Public, name-free snapshot data — the counterpart to aggregate.js for
// the per-school snapshot page and the recognition categories. Reads
// src/children.js's private registry but NEVER forwards a name or a raw
// child ID out of this module; everything it returns is a count.
//
// Two distinct kinds of "change" exist in this codebase, deliberately:
//  - aggregate.js's "Rising Fast" compares the OVERALL % on-track between
//    two rounds for a school — simple, already built, but can drift if
//    which children got sampled changes between rounds.
//  - This module's "movement" compares the SAME child's level between
//    their two most recent visits (different rounds, not just different
//    submissions within one round) — what Michael asked for specifically
//    ("linking the same students' assessments over time"), more precise,
//    needs the child-linking registry to exist.
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

export function buildSnapshot(registry) {
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
  if (hasMovementData) {
    const scored = [];
    for (const [schoolId, s] of Object.entries(bySchool)) {
      let up = 0, n = 0;
      for (const g of Object.values(s.by_grade)) {
        up += g.reading.up + g.arithmetic.up;
        n += g.reading.n + g.arithmetic.n;
      }
      if (n > 0) scored.push({ school_id: schoolId, school_name: SCHOOLS[schoolId]?.name || `School ${schoolId}`, rate: Math.round((up / n) * 100) });
    }
    noOneLeftBehind = scored.length ? scored.sort((a, b) => b.rate - a.rate) : null;
  }

  return {
    by_school: bySchool,
    recognition: {
      full_participation: participationRanking.length ? participationRanking : null,
      no_one_left_behind: noOneLeftBehind,
      // Fastest Growth and Consistent Excellence both need 2+ *rounds* of
      // real breadth across schools to rank meaningfully, not just 2
      // records for a handful of individually-retested children — not
      // built here; the existing "Rising Fast" aggregate on the Schools
      // tab already covers fastest growth once Visit 2 exists.
    },
  };
}
