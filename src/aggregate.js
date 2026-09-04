import { SCHOOLS } from './schools.js';

const ROUNDS = ['baseline', 'midline', 'endline'];

function emptyRoundBucket() {
  return { reading: [0, 0, 0, 0], arithmetic: [0, 0, 0, 0], n: 0 };
}

function emptyRoundSet() {
  return { baseline: emptyRoundBucket(), midline: emptyRoundBucket(), endline: emptyRoundBucket() };
}

// Turns raw KoBo submissions into everything the dashboard needs to render
// without re-processing thousands of records in the browser on every load.
// DQ threshold notes (not exact science, deliberately conservative):
//  - MAX_PER_DAY: EGRA field guidance puts full-day capacity at ~30
//    assessments per 3-person team; flagging above that for a single
//    enumerator is a reasonable "worth a look" line, not a hard violation.
//  - MIN_DURATION_MIN: a full adaptive assessment (both subjects) takes
//    several minutes; under 2 minutes end-to-end is implausibly fast.
const MAX_PER_DAY = 30;
const MIN_DURATION_MIN = 2;

export function aggregate(results) {
  const overall = emptyRoundSet();
  const byGrade = {}; // grade -> round-set, summed across all schools
  const schools = {};
  const enumeratorDays = {}; // enumerator -> { 'YYYY-MM-DD': count }
  const flags = [];
  let missingGrade = 0;
  let missingSchool = 0;

  for (const r of results) {
    const schoolId = r['grp_id/school_id'];
    const grade = r['grp_student/grade'];
    const round = r['grp_id/assessment_type'];
    const readingLevel = parseInt(r['grp_reading/reading_level'], 10);
    const arithLevel = parseInt(r['grp_arith/arithmetic_level'], 10);
    const enumerator = r['grp_id/enumerator'];
    const startTime = r['grp_id/start_time'];
    const endTime = r['grp_summary/end_time'];

    if (!grade) missingGrade++;
    if (!schoolId) missingSchool++;

    if (ROUNDS.includes(round) && Number.isInteger(readingLevel) && Number.isInteger(arithLevel)) {
      overall[round].reading[readingLevel]++;
      overall[round].arithmetic[arithLevel]++;
      overall[round].n++;

      const g = grade || 'unknown';
      if (!byGrade[g]) byGrade[g] = emptyRoundSet();
      byGrade[g][round].reading[readingLevel]++;
      byGrade[g][round].arithmetic[arithLevel]++;
      byGrade[g][round].n++;

      if (schoolId) {
        if (!schools[schoolId]) {
          schools[schoolId] = {
            name: SCHOOLS[schoolId]?.name || `School ${schoolId}`,
            ward: SCHOOLS[schoolId]?.ward || null,
            grades: {},
          };
        }
        if (!schools[schoolId].grades[g]) schools[schoolId].grades[g] = emptyRoundSet();
        schools[schoolId].grades[g][round].reading[readingLevel]++;
        schools[schoolId].grades[g][round].arithmetic[arithLevel]++;
        schools[schoolId].grades[g][round].n++;
      }
    }

    if (enumerator && startTime) {
      const day = startTime.slice(0, 10); // YYYY-MM-DD
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

  return {
    overall,
    by_grade: byGrade,
    schools,
    dq: { flags, enumerator_totals: enumeratorTotals },
  };
}
