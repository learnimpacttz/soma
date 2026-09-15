// Round detection — computed from each submission's own date, not trusted
// from the officer's manual `assessment_type` entry. Removes a whole class
// of human error (an officer picking the wrong option) and can't drift out
// of sync with the calendar. The manual entry is still recorded and used
// only to raise a data-quality flag when it disagrees with the computed
// round (see aggregate.js).
//
// Rule (confirmed by Michael 2026-09-15):
//  - Any year 2026            -> Pilot (Kibaha's actual launch year; started
//                                 mid-year in Term 3, so no normal Jan-Dec
//                                 cycle applies to it)
//  - 2027 onward:
//      Jan 1 – Jun 30          -> Round 1 (Baseline)
//      Jul 1 – Oct 14          -> Round 2 (Midline)
//      Oct 15 – Dec 31         -> Round 3 (Endline)

export const ROUND_KEYS = ['pilot', 'round1', 'round2', 'round3'];

export const ROUND_META = {
  pilot: { technical: { sw: 'Jaribio', en: 'Pilot' }, method: 'census' },
  round1: { technical: { sw: 'Msingi', en: 'Baseline' }, method: 'census' },
  round2: { technical: { sw: 'Katikati', en: 'Midline' }, method: 'sample' },
  round3: { technical: { sw: 'Mwisho', en: 'Endline' }, method: 'sample' },
};

export function computeRound(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  if (year === 2026) return { year, round: 'pilot' };
  const month = d.getMonth() + 1; // 1-12
  const day = d.getDate();
  if (month >= 1 && month <= 6) return { year, round: 'round1' };
  if (month >= 7 && (month < 10 || (month === 10 && day < 15))) return { year, round: 'round2' };
  return { year, round: 'round3' };
}

// Maps the *manually entered* KoBo assessment_type value onto the same
// round-key space, so it can be compared against the computed round for
// the mismatch data-quality check.
export function manualRoundKey(assessmentType) {
  if (assessmentType === 'baseline') return 'round1';
  if (assessmentType === 'midline') return 'round2';
  if (assessmentType === 'endline') return 'round3';
  return null;
}
