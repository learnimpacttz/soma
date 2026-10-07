// Round/visit detection — computed from each submission's own date, not
// trusted from the officer's manual `assessment_type` entry. Removes a
// whole class of human error (an officer picking the wrong option) and
// can't drift out of sync with the calendar. The manual entry is still
// recorded and used only to raise a data-quality flag when it disagrees
// with the computed round (see aggregate.js).
//
// Rule (confirmed by Michael 2026-09-25): EVERYTHING in 2026 is the Pilot —
// one snapshot, full census, regardless of the month. Normal Visit #1/#2/#3
// numbering starts in 2027:
//   Jan 1 – Jun 30          -> Visit #1 (Baseline)
//   Jul 1 – Oct 14          -> Visit #2 (Midline)
//   Oct 15 – Dec 31         -> Visit #3 (Endline)
//
// Census vs. sample is year-aware: the 2026 Pilot is a full census; from
// 2027 onward only Visit #1 (Baseline) is a census, #2/#3 are samples.

export const ROUND_KEYS = ['pilot', 'round1', 'round2', 'round3'];

export const ROUND_META = {
  pilot: { number: null, technical: { sw: 'Pilot', en: 'Pilot' }, shortTechnical: { sw: 'Pilot', en: 'Pilot' } },
  round1: { number: 1, technical: { sw: 'Msingi', en: 'Baseline' }, shortTechnical: { sw: 'MS', en: 'BL' } },
  round2: { number: 2, technical: { sw: 'Katikati', en: 'Midline' }, shortTechnical: { sw: 'KT', en: 'ML' } },
  round3: { number: 3, technical: { sw: 'Mwisho', en: 'Endline' }, shortTechnical: { sw: 'MW', en: 'EL' } },
};

export function roundMethod(year, round) {
  if (Number(year) === 2026) return 'census';
  return round === 'round1' ? 'census' : 'sample';
}

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
