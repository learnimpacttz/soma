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

export const READING_LEVELS = ['Mwanzo', 'Silabi', 'Maneno', 'Aya'];
export const ARITH_LEVELS = ['Mwanzo', 'Namba', 'Kujumlisha', 'Kutoa'];
