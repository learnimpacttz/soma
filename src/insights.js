import { ROUND_KEYS, ROUND_META } from './rounds.js';

const READING_LEVELS = ['Wanaoanza (not yet reading syllables)', 'Wanaochipukia/Emerging (reading syllables)',
  'Wanaoendelea/Progressing (reading words)', 'Waliofikia Kiwango/On Track (reading a paragraph fluently)'];
const ARITH_LEVELS = ['Wanaoanza (not yet recognizing numbers)', 'Wanaochipukia/Emerging (recognizing numbers)',
  'Wanaoendelea/Progressing (can add)', 'Waliofikia Kiwango/On Track (can subtract)'];

// Bump whenever the JSON shape or required bilingual-ness of insights
// output changes, so the frontend can tell a cached KV entry was generated
// under an older schema and prompt for regeneration instead of silently
// rendering mismatched-language or missing-field content (this is exactly
// how the "some insight text stayed in English under Swahili" bug
// happened — old plain-string content surviving a schema change).
export const INSIGHTS_SCHEMA_VERSION = 2;

function pct(count, n) { return n > 0 ? Math.round((count / n) * 100) : 0; }
function roundLabel(key) { return `${key} (${ROUND_META[key].technical.en}, ${ROUND_META[key].method})`; }

// Condenses the full aggregate into a compact, human-readable brief for the
// model — not the raw JSON. Keeps the prompt small and keeps Claude from
// having to do its own arithmetic on nested count arrays. Uses the latest
// year with data; multi-year comparison is a reasonable future addition,
// not built yet since there's only ever been one year of data so far.
function buildDataBrief(summary) {
  const lines = [];
  const years = summary.years || [];
  const latestYear = years[years.length - 1];
  if (!latestYear) return 'No data collected yet.';
  const yearData = summary.by_year[latestYear];
  lines.push(`YEAR: ${latestYear}`);

  for (const round of ROUND_KEYS) {
    const b = yearData.rounds[round];
    if (!b.n) continue;
    lines.push(`${roundLabel(round)} (n=${b.n}): Reading — ` +
      READING_LEVELS.map((l, i) => `${l}: ${pct(b.reading[i], b.n)}%`).join(', ') +
      `. Arithmetic — ` + ARITH_LEVELS.map((l, i) => `${l}: ${pct(b.arithmetic[i], b.n)}%`).join(', '));
  }

  const firstRoundWithData = ROUND_KEYS.find((k) => yearData.rounds[k].n > 0);
  lines.push(`\nPER-SCHOOL (${firstRoundWithData || 'earliest available round'}, reading Waliofikia Kiwango+ / arithmetic Waliofikia Kiwango+):`);
  for (const [id, s] of Object.entries(yearData.schools)) {
    let n = 0, readingTop = 0, arithTop = 0;
    for (const g of Object.values(s.grades)) {
      const b = g[firstRoundWithData];
      if (b) { n += b.n; readingTop += b.reading[3]; arithTop += b.arithmetic[3]; }
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
consistently to both subjects: Wanaoanza (Starting Out) -> Wanaochipukia (Emerging) -> Wanaoendelea \
(Progressing) -> Waliofikia Kiwango (On Track), plus an outlier stage Waliovuka Kiwango (Beyond \
Standard) for children who exceed the top skill. Every child is on a journey through these stages \
across the school year; the programme goal is every child reaching "Waliofikia Kiwango" for their \
grade. SOMA groups children for differentiated classroom teaching and recognises schools for \
LEARNING GROWTH (not absolute scores) at an annual Mwalimu Kinara ceremony co-funded by Kibaha \
District Council. Assessment rounds each year are Round 1/Baseline (full census, Jan-Jun), Round 2/
Midline (sample, Jul-mid Oct), and Round 3/Endline (sample, mid Oct-Dec); 2026 itself is the Pilot
year (full census, doesn't follow the normal 3-round annual cycle since the programme launched
mid-year).

ALWAYS use this exact terminology (Wanaoanza/Wanaochipukia/Wanaoendelea/Waliofikia Kiwango/Waliovuka \
Kiwango) when referring to stages — never invent alternative names, never use the singular "Ana-" \
forms, and never use the old terms "Mwanzo", "Silabi", "Maneno", "Aya", "Namba", "Kujumlisha", \
"Kutoa" in your written output (those are internal skill labels, not the stage names a reader sees).

Do NOT reference "coaching" or "School Coaches" as a programme activity — that is not part of the \
current design. Real programme activities you may reference: ability-based classroom grouping, and \
Mwalimu Kinara recognition. Do not invent other activities not implied by the data brief.

Write only Tanzanian Standard Swahili (Kiswahili Sanifu) — never Kenyan or other regional Swahili \
vocabulary, spelling, or idiom. Write naturally, the way an educated Tanzanian teacher or education \
officer would actually speak or write — never stiff, literal-translation-style, or robotic phrasing.

You will be given a data brief and must return ONLY valid JSON (no markdown fences, no prose \
outside the JSON) matching this exact shape. Every text field must be an object with BOTH "sw" \
(Swahili) and "en" (English) keys, each a natural, idiomatic translation of the same content — not \
a literal word-for-word translation of each other:

{
  "public": {
    "headline": {"sw": "...", "en": "..."},
    "what_the_data_shows": [{"sw": "...", "en": "..."}, ...],
    "whats_been_done": {"sw": "...", "en": "..."},
    "what_schools_can_do": [{"sw": "...", "en": "..."}, ...]
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
  whats_been_done: 1-2 sentences connecting the finding to real programme activity (see above list —
  do not invent activity not implied by the data).
- what_schools_can_do: 1-3 short, CONSTRUCTIVE, forward-looking bullets naming concrete next steps
  (e.g. which skill stage to focus classroom grouping on) — written for a public audience (parents,
  community, government, press). Never blame, shame, or single out a school as failing; frame every
  point in terms of growth and what comes next, consistent with the journey framing. If nothing
  specific is implied by the data, keep this general and encouraging rather than inventing detail.
- programme_intelligence.headline: the learning-direction story — on track, uneven, concerning?
  findings: 2-4 bullets on which schools/grades/subjects need attention and why, grounded in the
  numbers given. recommendation: one concrete, actionable sentence for the LearnImpact team. This
  section is internal-only, so it may be direct/specific about school performance.
- operational_intelligence: data quality / field operations. findings must name the specific
  enumerator/school/date from the DQ flags given, not be vague.
- public.* must NEVER name an enumerator or reference a data-quality flag — that's internal-only.
- Ground every claim in the numbers you were given. Never invent a statistic, a school name, or an \
activity that isn't implied by the brief.
- If a data quality flags list says "None currently", operational_intelligence.findings should say \
so plainly in both languages, not invent a problem.
- If only one round has data so far, say so explicitly rather than implying a trend that doesn't \
exist yet.
- A "round_mismatch" data quality flag means an officer's manual round selection in KoBo disagreed \
with what the submission date computes to — report it as a data-entry discrepancy to check, not as \
a finding about a school's performance.`;

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
      max_tokens: 2800,
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
