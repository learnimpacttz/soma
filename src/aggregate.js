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

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdev(arr, m) {
  if (arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

// DQ threshold notes (not exact science, deliberately conservative):
//  - MAX_PER_DAY: EGRA field guidance puts full-day capacity at ~30
//    assessments per 3-person team; flagging above that for a single
//    enumerator is a reasonable "worth a look" line, not a hard violation.
//  - MIN_DURATION_MIN: the absolute floor used only as a fallback when an
//    enumerator doesn't yet have enough records for their own baseline.
//    Once they do (MIN_SAMPLE_FOR_STATS+), a per-enumerator statistical
//    threshold takes over — flags anything unusually fast FOR THEM, not
//    just anything under a flat global number. The threshold is always
//    at least MIN_DURATION_MIN (their own statistics can only make
//    flagging MORE sensitive than the flat floor, never less).
//  - BURST: several submissions from the same enumerator each under a
//    minute apart is a different signal from raw daily volume — it can
//    mean copy/paste-style rapid entry rather than real field testing.
//  - Form-version drift: a device running an outdated offline copy of
//    the form is worth a look even though it doesn't affect data
//    validity directly.
const MAX_PER_DAY = 30;
const MIN_DURATION_MIN = 2;
const MIN_SAMPLE_FOR_STATS = 5;
const OUTLIER_STDEV = 2;
const BURST_GAP_SECONDS = 60;
const BURST_MIN_COUNT = 3;

export function aggregate(results) {
  const byYear = {};
  const enumeratorDays = {};
  const enumeratorDurations = {}; // enumerator -> [{mins, code}]
  const enumeratorRoster = {}; // enumerator -> {tested, offRoster}
  const enumeratorTimestamps = {}; // enumerator -> [ISO string]
  const formVersionCounts = {};
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
    const onRoster = r['grp_student/on_roster'];
    const formVersion = r['form_version'];

    if (!grade) missingGrade++;
    if (!schoolId) missingSchool++;

    const computed = computeRound(startTime || r['_submission_time']);
    if (computed) {
      const expectedManual = manualRoundKey(manualType);
      if (expectedManual && computed.round !== 'pilot' && expectedManual !== computed.round) {
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
      enumeratorTimestamps[enumerator] ??= [];
      enumeratorTimestamps[enumerator].push(startTime);
    }

    if (enumerator && (onRoster === '1' || onRoster === '0')) {
      enumeratorRoster[enumerator] ??= { tested: 0, offRoster: 0 };
      enumeratorRoster[enumerator].tested++;
      if (onRoster === '0') enumeratorRoster[enumerator].offRoster++;
    }

    if (formVersion) formVersionCounts[formVersion] = (formVersionCounts[formVersion] || 0) + 1;

    if (enumerator && startTime && endTime) {
      const mins = (new Date(endTime) - new Date(startTime)) / 60000;
      // Sanity cap at 60 — a genuinely multi-hour gap is a timestamp/clock
      // issue, not a real test duration, and would otherwise skew that
      // enumerator's own mean/stdev baseline below.
      if (Number.isFinite(mins) && mins >= 0 && mins < 60) {
        enumeratorDurations[enumerator] ??= [];
        enumeratorDurations[enumerator].push({ mins, code: r['grp_student/student_code'] || 'unknown' });
      }
    }
  }

  // --- Per-enumerator duration outliers, replacing the old flat check ---
  const enumeratorPace = {};
  for (const [enumerator, durs] of Object.entries(enumeratorDurations)) {
    const vals = durs.map((d) => d.mins);
    const m = mean(vals);
    enumeratorPace[enumerator] = { n: vals.length, mean_duration: Math.round(m * 10) / 10, median_duration: Math.round(median(vals) * 10) / 10 };

    let threshold = MIN_DURATION_MIN;
    if (vals.length >= MIN_SAMPLE_FOR_STATS) {
      const sd = stdev(vals, m);
      threshold = Math.max(MIN_DURATION_MIN, m - OUTLIER_STDEV * sd);
    }
    durs.forEach((d) => {
      if (d.mins < threshold) {
        const reason = vals.length >= MIN_SAMPLE_FOR_STATS
          ? `more than ${OUTLIER_STDEV} standard deviations below their own ${m.toFixed(1)}-min average`
          : `implausibly fast for a full test`;
        flags.push({
          severity: 'high',
          type: 'short_duration',
          message: `${enumerator}: assessment completed in ${d.mins.toFixed(1)} min (student ${d.code}) — ${reason}.`,
        });
      }
    });
  }

  // --- Off-roster rate per enumerator ---
  for (const [enumerator, p] of Object.entries(enumeratorRoster)) {
    if (enumeratorPace[enumerator]) enumeratorPace[enumerator].off_roster_rate = Math.round((p.offRoster / p.tested) * 100);
  }

  // --- Submission bursts: 3+ consecutive submissions each under a minute
  // apart, flagged once per run rather than once per record ---
  for (const [enumerator, timestamps] of Object.entries(enumeratorTimestamps)) {
    const sorted = [...timestamps].sort();
    let runStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      const gapOk = i < sorted.length && (new Date(sorted[i]) - new Date(sorted[i - 1])) / 1000 < BURST_GAP_SECONDS;
      if (!gapOk) {
        const runLength = i - runStart;
        if (runLength >= BURST_MIN_COUNT) {
          flags.push({
            severity: 'med',
            type: 'submission_burst',
            message: `${enumerator}: ${runLength} submissions within a minute of each other, starting ${sorted[runStart].slice(0, 16).replace('T', ' ')} — worth checking these weren't batch-entered after the fact.`,
          });
        }
        runStart = i;
      }
    }
  }

  // --- Form-version drift: anything not matching the most common version ---
  const versionEntries = Object.entries(formVersionCounts);
  if (versionEntries.length > 1) {
    const [modeVersion] = versionEntries.sort((a, b) => b[1] - a[1])[0];
    for (const [version, count] of versionEntries) {
      if (version !== modeVersion) {
        flags.push({
          severity: 'med',
          type: 'form_version_drift',
          message: `${count} submission(s) used form version ${version}; most (${formVersionCounts[modeVersion]}) used ${modeVersion} — some devices may be running an outdated offline copy.`,
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
    dq: { flags, enumerator_totals: enumeratorTotals, enumerator_pace: enumeratorPace, round_mismatches: roundMismatches },
  };
}
