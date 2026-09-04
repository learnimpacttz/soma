const READING_LEVELS = ['Mwanzo (Beginner)', 'Silabi (Syllables)', 'Maneno (Words)', 'Aya (Paragraph)'];
const ARITH_LEVELS = ['Mwanzo (Beginner)', 'Namba (Number recognition)', 'Kujumlisha (Addition)', 'Kutoa (Subtraction)'];

function pct(count, n) { return n > 0 ? Math.round((count / n) * 100) : 0; }

// Condenses the full aggregate into a compact, human-readable brief for the
// model — not the raw JSON. Keeps the prompt small and keeps Claude from
// having to do its own arithmetic on nested count arrays.
function buildDataBrief(summary) {
  const lines = [];
  const overall = summary.overall;
  for (const round of ['baseline', 'midline', 'endline']) {
    const b = overall[round];
    if (!b.n) continue;
    lines.push(`${round.toUpperCase()} (n=${b.n}): Reading — ` +
      READING_LEVELS.map((l, i) => `${l}: ${pct(b.reading[i], b.n)}%`).join(', ') +
      `. Arithmetic — ` + ARITH_LEVELS.map((l, i) => `${l}: ${pct(b.arithmetic[i], b.n)}%`).join(', '));
  }

  lines.push('\nPER-SCHOOL (baseline, reading Aya+ / arithmetic Kutoa+):');
  for (const [id, s] of Object.entries(summary.schools)) {
    let n = 0, readingTop = 0, arithTop = 0;
    for (const g of Object.values(s.grades)) {
      if (g.baseline) { n += g.baseline.n; readingTop += g.baseline.reading[3]; arithTop += g.baseline.arithmetic[3]; }
    }
    if (n) lines.push(`- ${s.name} (${s.ward || 'ward unknown'}): n=${n}, reading Aya+ ${pct(readingTop, n)}%, arithmetic Kutoa+ ${pct(arithTop, n)}%`);
  }

  lines.push('\nDATA QUALITY FLAGS:');
  if (summary.dq.flags.length === 0) {
    lines.push('- None currently.');
  } else {
    for (const f of summary.dq.flags) lines.push(`- [${f.severity}] ${f.message}`);
  }

  lines.push('\nSUBMISSIONS PER ENUMERATOR: ' +
    Object.entries(summary.dq.enumerator_totals).map(([n, c]) => `${n}: ${c}`).join(', '));

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are the analysis layer for SOMA, LearnImpact's foundational-learning \
programme in Kibaha, Tanzania. SOMA assesses children's reading (ladder: Mwanzo -> Silabi -> \
Maneno -> Aya) and arithmetic (ladder: Mwanzo -> Namba -> Kujumlisha -> Kutoa) ability, groups \
them for differentiated classroom teaching, and recognises schools for LEARNING GROWTH (not \
absolute scores) at an annual Mwalimu Kinara ceremony co-funded by Kibaha District Council. \
Assessment rounds are baseline (full census), then midline/endline (sampled).

You will be given a data brief and must return ONLY valid JSON (no markdown fences, no prose \
outside the JSON) matching this exact shape:

{
  "public": {
    "headline": "one sentence, specific, no jargon — what changed and why it matters",
    "what_the_data_shows": ["2-4 short bullets, each a specific finding with numbers"],
    "whats_been_done": "1-2 sentences connecting the finding to real programme activity (coaching, ability grouping, Mwalimu Kinara) — do not invent activity not implied by the data"
  },
  "programme_intelligence": {
    "headline": "one sentence on the learning-direction story — is progress on track, uneven, concerning?",
    "findings": ["2-4 bullets — which schools/grades/subjects need attention and why, grounded in the numbers given"],
    "recommendation": "one concrete, actionable sentence for the LearnImpact team"
  },
  "operational_intelligence": {
    "headline": "one sentence on data quality / field operations",
    "findings": ["bullets covering the DQ flags given — name the specific enumerator/school/date from the flags, don't be vague"]
  }
}

Rules:
- public.* must NEVER name an enumerator or reference a data-quality flag — that's internal-only.
- Ground every claim in the numbers you were given. Never invent a statistic, a school name, or an \
activity that isn't implied by the brief.
- If a data quality flags list says "None currently", operational_intelligence.findings should say \
so plainly, not invent a problem.
- If baseline is the only round with data, say so explicitly rather than implying a trend that \
doesn't exist yet.`;

export async function generateInsights(summary, apiKey) {
  const brief = buildDataBrief(summary);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Here is the current SOMA data brief:\n\n${brief}` }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const raw = data.content?.[0]?.text || '';
  // Models sometimes wrap JSON in ```json fences despite instructions not
  // to — strip them defensively rather than relying on prompt compliance.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Model did not return valid JSON: ${raw.slice(0, 200)}`);
  }
  return parsed;
}
