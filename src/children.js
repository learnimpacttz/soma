// Private child-identity resolution — NEVER imported by anything the
// dashboard exposes publicly. Only src/index.js's admin export route and
// (later) the snapshot-page aggregation touch this module's output, and
// both must keep names out of every dashboard-facing response. See
// aggregate.js for the public, name-free aggregate the dashboard reads.
//
// The problem this solves: roster children already have a stable code
// across visits (`student_code`, looked up from the school's roster CSV).
// Off-roster children ("on_roster=0") do NOT — the KoBo form's
// `student_code_new` field is hardcoded to the literal string "-99" for
// every one of them (confirmed in the live XLSForm, not a guess), so they
// are indistinguishable from each other, let alone linkable across visits.
// This module assigns each off-roster child a real, persistent ID by
// matching on (school, year, grade, normalized name) against children
// already seen in earlier refreshes, minting a new ID only when no match
// is found.
//
// Deliberately conservative: exact normalized-name match only, no fuzzy/
// typo-tolerant matching. A missed match just means two IDs for the same
// child (visible and fixable via the export below); a wrong match would
// silently corrupt a "what changed for this child" comparison, which is
// worse. Scoped to within-year matching only — a roster code also embeds
// the year (e.g. "SCH01-G1-STU0014-2026"), so cross-year identity for
// EITHER roster or off-roster children is a known gap, not solved here;
// there's only one year of real data so far to design that against.

function normalizeName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Builds/updates the private child registry from this refresh's raw KoBo
// records, carrying forward IDs already minted in a previous refresh.
// `previousRegistry` is the registry object as last stored in KV (or {}
// on the first-ever run).
export function resolveChildIdentities(results, previousRegistry) {
  const registry = {};
  // Index previously-minted off-roster IDs by their match key, and track
  // the next free sequence number per school, so re-running this on every
  // refresh doesn't re-mint new IDs for children already identified.
  const byMatchKey = {};
  const nextSeq = {};
  for (const [somaId, child] of Object.entries(previousRegistry || {})) {
    registry[somaId] = child;
    if (child.origin === 'off_roster') {
      for (const key of child.match_keys || []) byMatchKey[key] = somaId;
      const schoolSeq = Number(somaId.split('-')[2]) || 0;
      nextSeq[child.school_id] = Math.max(nextSeq[child.school_id] || 0, schoolSeq);
    }
  }

  for (const r of results) {
    const schoolId = r['grp_id/school_id'];
    const grade = r['grp_student/grade'];
    const startTime = r['grp_id/start_time'] || r['_submission_time'];
    const year = startTime ? new Date(startTime).getFullYear() : null;
    const onRoster = r['grp_student/on_roster'] === '1';
    const readingLevel = parseInt(r['grp_reading/reading_level'], 10);
    const arithLevel = parseInt(r['grp_arith/arithmetic_level'], 10);
    if (!schoolId || !grade || !year || !Number.isInteger(readingLevel) || !Number.isInteger(arithLevel)) continue;

    let somaId;
    let name;
    if (onRoster) {
      somaId = r['grp_student/student_code'];
      if (!somaId) continue;
      name = null; // roster children are identified by their existing code, not a name we captured
    } else {
      name = r['grp_student/student_name_new'];
      const normalized = normalizeName(name);
      if (!normalized) continue; // can't match or mint without a name
      const matchKey = `${schoolId}|${year}|${grade}|${normalized}`;
      somaId = byMatchKey[matchKey];
      if (!somaId) {
        const seq = (nextSeq[schoolId] || 0) + 1;
        nextSeq[schoolId] = seq;
        somaId = `SOMA-${schoolId}-${seq}`;
        byMatchKey[matchKey] = somaId;
      }
    }

    if (!registry[somaId]) {
      registry[somaId] = {
        origin: onRoster ? 'roster' : 'off_roster',
        school_id: schoolId,
        name: name || null,
        first_seen: startTime,
        match_keys: [],
        records: [],
      };
    }
    const child = registry[somaId];
    if (!onRoster) {
      const normalized = normalizeName(name);
      const matchKey = `${schoolId}|${year}|${grade}|${normalized}`;
      if (!child.match_keys.includes(matchKey)) child.match_keys.push(matchKey);
      if (name && !child.name) child.name = name;
    }
    child.records.push({
      submission_uuid: r['submission_uuid'] || r['_uuid'] || null,
      year, grade,
      reading_level: readingLevel,
      arithmetic_level: arithLevel,
      date: startTime,
    });
  }

  return registry;
}

// CSV for the internal team's download — the only place a child's name is
// ever exposed. Includes a `needs_review` column: schools/grades with more
// than one off-roster child sharing a first name are flagged, since exact
// matching can't tell two same-named classmates apart from a surname-less
// name field — the team should check these by hand.
export function childrenRegistryToCsv(registry) {
  const rows = [['soma_id', 'name', 'school_id', 'origin', 'first_seen', 'visits', 'needs_review']];
  const sameNameCount = {};
  for (const [somaId, child] of Object.entries(registry)) {
    if (child.origin !== 'off_roster' || !child.name) continue;
    const key = `${child.school_id}|${normalizeName(child.name)}`;
    sameNameCount[key] = (sameNameCount[key] || 0) + 1;
  }
  for (const [somaId, child] of Object.entries(registry)) {
    const key = child.name ? `${child.school_id}|${normalizeName(child.name)}` : null;
    const needsReview = key && sameNameCount[key] > 1;
    rows.push([
      somaId, child.name || '', child.school_id, child.origin, child.first_seen || '',
      child.records.length, needsReview ? 'yes' : 'no',
    ]);
  }
  return rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}
