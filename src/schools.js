// Static reference data — school_id -> name/ward, matching the live KoBo
// form's choices sheet (numeric IDs, not the TAMISEMI codes; see
// School_ID_TAMISEMI_Mapping.md in the SOMA_Build project for why).
// Small and stable enough to hardcode rather than re-fetch from KoBo.
export const SCHOOLS = {
  '1': { name: 'Mwendapole', ward: 'Kibaha' },
  '2': { name: 'Miswe', ward: 'Mbwawa' },
  '3': { name: 'Mailimoja', ward: 'Mailimoja' },
  '4': { name: 'Lulanzi', ward: 'Picha_ya_ndege' },
  '5': { name: 'Kidimu', ward: 'Pangani' },
  '6': { name: 'Galagaza', ward: 'Msangani' },
  '7': { name: 'Bokotimiza', ward: 'Tumbi_B' },
  '8': { name: 'Misugusugu', ward: 'Misugusugu' },
  '9': { name: 'Lumumba', ward: 'Pangani' },
  '10': { name: 'Visiga', ward: 'Visiga' },
};

// Group names follow Tanzania's own NECTA/KKK national assessment framework's
// growth-verb vocabulary — plural forms (wanaoanza, wanaochipukia,
// wanaoendelea, waliofikia kiwango), matching NECTA's actual grammar for
// describing a group/statistic (corrected 2026-09-15 from an earlier
// singular "Ana-" form) — same journey framing recognized nationally since
// the KKK strategic plan (Jan 2026), applied consistently across both
// reading and arithmetic. English side mirrors standard literacy-pedagogy
// terms (Emergent/Developing/Proficient).
export const GROUP_NAMES = {
  sw: ['Wanaoanza', 'Wanaochipukia', 'Wanaoendelea', 'Waliofikia Kiwango'],
  en: ['Starting Out', 'Emerging', 'Progressing', 'On Track'],
};
export const OUTLIER_NAME = { sw: 'Waliovuka Kiwango', en: 'Beyond Standard' };

// The specific skill each level actually represents — shown alongside the
// group name so it's never just an abstract label (ask: "be clear at which
// learning skill we are communicating our benchmark").
export const READING_SKILL = {
  sw: ['bado hajasoma silabi', 'anasoma silabi', 'anasoma maneno', 'anasoma aya kwa ufasaha'],
  en: ['not yet reading syllables', 'reading syllables', 'reading words', 'reading a paragraph fluently'],
};
export const ARITH_SKILL = {
  sw: ['bado hajatambua namba', 'anatambua namba', 'anajumlisha', 'anatoa'],
  en: ['not yet recognizing numbers', 'recognizing numbers', 'can add', 'can subtract'],
};
export const READING_OUTLIER_SKILL = { sw: 'anasoma hadithi', en: 'reading a full story' };
export const ARITH_OUTLIER_SKILL = { sw: 'anazidisha', en: 'can multiply' };

// Kept for anything still expecting the old plain level names internally.
export const READING_LEVELS = ['Mwanzo', 'Silabi', 'Maneno', 'Aya'];
export const ARITH_LEVELS = ['Mwanzo', 'Namba', 'Kujumlisha', 'Kutoa'];
