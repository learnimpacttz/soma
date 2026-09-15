import { SCHOOLS } from './schools.js';
import { ROUND_KEYS, computeRound, manualRoundKey } from './rounds.js';

function emptyBucket() {
  return { reading: [0, 0, 0, 0], arithmetic: [0, 0, 0, 0], n: 0 };
}
function emptyRoundSet() {
  const s = {};
  ROUND_KEYS.forEach((k) => { s[k] = emptyBucket(); });
  return s;
}
function emptyYear() {
  return { rounds: emptyRoundSet(), by_grade: {}, schools: {} };
}

// DQ threshold notes (not exact science, deliberately conservative):
//  - MAX_PER_DAY: EGRA field guidance puts full-day capacity at ~30
//    assessments per 3-person team; flagging above that for a single
//    enumerator is a reasonable "worth a look" line, not a hard violation.
//  - MIN_DURATION_MIN: a full adaptive assessment (both subjects) takes
//    several minutes; under 2 minutes end-to-end is implausibly fast.
const MAX_PER_DAY = 30;
const MIN_DURATION_MIN = 2;

export function aggregate(results) {
  const byYear = {};
  const enumeratorDays = {};
  const flags = [];
  let missingGrade = 0;
  let missingSchool = 0;
  let roundMismatches = 0;

  for (const r of results) {
    const schoolId = r['grp_id/school_id'];
    const grade = r['grp_student/grade'];
    const manualType = r['grp_id/assessment_type'];
    const readingLevel = parseInt(r['grp_reading/reading_level'], 10);
    const arithLevel = parseInt(r['grp_arith/arithmetic_level'], 10);
    const enumerator = r['grp_id/enumerator'];
    const startTime = r['grp_id/start_time'];
    const endTime = r['grp_summary/end_time'];

    if (!grade) missingGrade++;
    if (!schoolId) missingSchool++;

    const computed = computeRound(startTime || r['_submission_time']);
    if (computed) {
      const expectedManual = manualRoundKey(manualType);
      if (expectedManual && expectedManual !== computed.round && computed.round !== 'pilot') {
        roundMismatches++;
        flags.push({
          severity: 'med',
          type: 'round_mismatch',
          message: `${r['grp_student/student_code'] || 'unknown'}: marked "${manualType}" in KoBo but the submission date (${(startTime || '').slice(0, 10)}) computes to a different round — worth checking.`,
        });
      }
    }

    if (computed && Number.isInteger(readingLevel) && Number.isInteger(arithLevel)) {
      const { year, round } = computed;
      const y = String(year);
      if (!byYear[y]) byYear[y] = emptyYear();
      const Y = byYear[y];

      Y.rounds[round].reading[readingLevel]++;
      Y.rounds[round].arithmetic[arithLevel]++;
      Y.rounds[round].n++;

      const g = grade || 'unknown';
      if (!Y.by_grade[g]) Y.by_grade[g] = emptyRoundSet();
      Y.by_grade[g][round].reading[readingLevel]++;
      Y.by_grade[g][round].arithmetic[arithLevel]++;
      Y.by_grade[g][round].n++;

      if (schoolId) {
        if (!Y.schools[schoolId]) {
          Y.schools[schoolId] = {
            name: SCHOOLS[schoolId]?.name || `School ${schoolId}`,
            ward: SCHOOLS[schoolId]?.ward || null,
            grades: {},
          };
        }
        if (!Y.schools[schoolId].grades[g]) Y.schools[schoolId].grades[g] = emptyRoundSet();
        Y.schools[schoolId].grades[g][round].reading[readingLevel]++;
        Y.schools[schoolId].grades[g][round].arithmetic[arithLevel]++;
        Y.schools[schoolId].grades[g][round].n++;
      }
    }

    if (enumerator && startTime) {
      const day = startTime.slice(0, 10);
      enumeratorDays[enumerator] ??= {};
      enumeratorDays[enumerator][day] = (enumeratorDays[enumerator][day] || 0) + 1;
    }

    if (enumerator && startTime && endTime) {
      const mins = (new Date(endTime) - new Date(startTime)) / 60000;
      if (Number.isFinite(mins) && mins >= 0 && mins < MIN_DURATION_MIN) {
        flags.push({
          severity: 'high',
          type: 'short_duration',
          message: `${enumerator}: assessment completed in ${mins.toFixed(1)} min (student ${r['grp_student/student_code'] || 'unknown'}) — implausibly fast for a full test.`,
        });
      }
    }
  }

  for (const [enumerator, days] of Object.entries(enumeratorDays)) {
    for (const [day, count] of Object.entries(days)) {
      if (count > MAX_PER_DAY) {
        flags.push({
          severity: 'high',
          type: 'high_volume',
          message: `${enumerator}: ${count} assessments on ${day} — above the ${MAX_PER_DAY}/day reference rate. Worth a supervisor check-in.`,
        });
      }
    }
  }
  if (missingGrade > 0) {
    flags.push({ severity: 'med', type: 'missing_grade', message: `${missingGrade} submission(s) missing a grade value.` });
  }
  if (missingSchool > 0) {
    flags.push({ severity: 'med', type: 'missing_school', message: `${missingSchool} submission(s) missing a school_id value.` });
  }

  const enumeratorTotals = {};
  for (const [enumerator, days] of Object.entries(enumeratorDays)) {
    enumeratorTotals[enumerator] = Object.values(days).reduce((a, b) => a + b, 0);
  }

  const years = Object.keys(byYear).sort();

  return {
    years,
    by_year: byYear,
    dq: { flags, enumerator_totals: enumeratorTotals, round_mismatches: roundMismatches },
  };
}
