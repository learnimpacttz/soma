const READING_LEVELS = ['Anaanza (not yet reading syllables)', 'Anachipukia/Emerging (reading syllables)',
  'Anaendelea/Progressing (reading words)', 'Amefikia Kiwango/On Track (reading a paragraph fluently)'];
const ARITH_LEVELS = ['Anaanza (not yet recognizing numbers)', 'Anachipukia/Emerging (recognizing numbers)',
  'Anaendelea/Progressing (can add)', 'Amefikia Kiwango/On Track (can subtract)'];

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

  lines.push('\nPER-SCHOOL (baseline, reading Amefikia Kiwango+ / arithmetic Amefikia Kiwango+):');
  for (const [id, s] of Object.entries(summary.schools)) {
    let n = 0, readingTop = 0, arithTop = 0;
    for (const g of Object.values(s.grades)) {
      if (g.baseline) { n += g.baseline.n; readingTop += g.baseline.reading[3]; arithTop += g.baseline.arithmetic[3]; }
    }
    if (n) lines.push(`- ${s.name} (${s.ward || 'ward unknown'}): n=${n}, reading ${pct(readingTop, n)}%, arithmetic ${pct(arithTop, n)}%`);
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
programme in Kibaha, Tanzania. SOMA assesses children's reading and arithmetic ability and groups \
them into four stages using Tanzania's own NECTA/KKK national growth-vocabulary, applied \
consistently to both subjects: Anaanza (Starting Out) -> Anachipukia (Emerging) -> Anaendelea \
(Progressing) -> Amefikia Kiwango (On Track), plus an outlier stage Amevuka Kiwango (Beyond \
Standard) for children who exceed the top skill. Every child is on a journey through these stages \
across the school year; the programme goal is every child reaching "Amefikia Kiwango" for their \
grade. SOMA groups children for differentiated classroom teaching and recognises schools for \
LEARNING GROWTH (not absolute scores) at an annual Mwalimu Kinara ceremony co-funded by Kibaha \
District Council. Assessment rounds are baseline (full census), then midline/endline (sampled).

ALWAYS use this exact terminology (Anaanza/Anachipukia/Anaendelea/Amefikia Kiwango/Amevuka Kiwango) \
when referring to stages — never invent alternative names, and never use the old terms "Mwanzo", \
"Silabi", "Maneno", "Aya", "Namba", "Kujumlisha", "Kutoa" in your written output (those are internal \
skill labels, not the stage names a reader sees).

You will be given a data brief and must return ONLY valid JSON (no markdown fences, no prose \
outside the JSON) matching this exact shape. Every text field must be an object with BOTH "sw" \
(Swahili) and "en" (English) keys, each a natural, idiomatic translation of the same content — not \
a literal word-for-word translation of each other:

{
  "public": {
    "headline": {"sw": "...", "en": "..."},
    "what_the_data_shows": [{"sw": "...", "en": "..."}, ...],
    "whats_been_done": {"sw": "...", "en": "..."}
  },
  "programme_intelligence": {
    "headline": {"sw": "...", "en": "..."},
    "findings": [{"sw": "...", "en": "..."}, ...],
    "recommendation": {"sw": "...", "en": "..."}
  },
  "operational_intelligence": {
    "headline": {"sw": "...", "en": "..."},
    "findings": [{"sw": "...", "en": "..."}, ...]
  }
}

Rules:
- headline: one sentence, specific, no jargon. what_the_data_shows: 2-4 short bullets with numbers.
  whats_been_done: 1-2 sentences connecting the finding to real programme activity (coaching,
  ability grouping, Mwalimu Kinara) — do not invent activity not implied by the data.
- programme_intelligence.headline: the learning-direction story — on track, uneven, concerning?
  findings: 2-4 bullets on which schools/grades/subjects need attention and why, grounded in the
  numbers given. recommendation: one concrete, actionable sentence for the LearnImpact team.
- operational_intelligence: data quality / field operations. findings must name the specific
  enumerator/school/date from the DQ flags given, not be vague.
- public.* must NEVER name an enumerator or reference a data-quality flag — that's internal-only.
- Ground every claim in the numbers you were given. Never invent a statistic, a school name, or an \
activity that isn't implied by the brief.
- If a data quality flags list says "None currently", operational_intelligence.findings should say \
so plainly in both languages, not invent a problem.
- If baseline is the only round with data, say so explicitly rather than implying a trend that \
doesn't exist yet.
- Swahili text should read naturally to a Swahili-speaking teacher or parent — not a stiff literal \
translation of the English.`;

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
      max_tokens: 2500,
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
