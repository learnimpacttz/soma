import { fetchKoboData } from './kobo.js';
import { aggregate } from './aggregate.js';
import { generateInsights, INSIGHTS_SCHEMA_VERSION } from './insights.js';
import { resolveChildIdentities, childrenRegistryToCsv } from './children.js';
import { buildSnapshot } from './snapshot.js';

// Real server-side team auth, replacing the old client-side-only
// TEAM_PASSPHRASE (which protected nothing — the "hidden" data was
// already sitting in every visitor's browser regardless of whether the
// UI showed it). Michael sets TEAM_SECRET himself via
// `wrangler secret put TEAM_SECRET`; the dashboard's team-unlock prompt
// now sends whatever was typed as this header and checks whether the
// server actually accepted it.
function isTeamAuthed(request, env) {
  return !!env.TEAM_SECRET && request.headers.get('X-Team-Secret') === env.TEAM_SECRET;
}

// Enumerator identity is the sensitive part of a summary — DQ flag
// messages name them by name, and both enumerator_totals AND
// enumerator_pace are keyed by name too. round_mismatches is just a
// count, safe to leave in either way.
function redactSummaryForPublic(summary) {
  if (!summary || !summary.dq) return summary;
  return {
    ...summary,
    dq: {
      flags: [], enumerator_totals: {}, enumerator_pace: {},
      enumerator_detail: {}, school_detail: {}, ward_detail: {}, daily_totals: {},
      round_mismatches: summary.dq.round_mismatches,
    },
  };
}

// programme_intelligence/operational_intelligence are the internal-only
// sections — operational_intelligence explicitly names enumerators by
// design (see src/insights.js's system prompt). public stays either way.
function redactInsightsForPublic(stored) {
  if (!stored || !stored.public) return stored;
  const { programme_intelligence, operational_intelligence, ...rest } = stored;
  return rest;
}

// Shared by the cron trigger and the on-demand /api/refresh route, so both
// paths do exactly the same fetch-and-store — no duplicated logic to drift.
async function refreshData(env) {
  if (!env.KOBO_ASSET_ID || !env.KOBO_TOKEN) {
    return { ok: false, reason: 'not_configured' };
  }
  try {
    const server = env.KOBO_SERVER || 'kf.kobotoolbox.org';
    const results = await fetchKoboData(server, env.KOBO_ASSET_ID, env.KOBO_TOKEN);
    const payload = {
      status: 'ok',
      total_records: results.length,
      fetched_at: new Date().toISOString(),
      results,
    };
    // Aggregates are what the dashboard actually renders from — computed
    // here, once, per refresh, not recomputed from raw records on every
    // page load in the browser.
    const summary = {
      status: 'ok',
      total_records: results.length,
      fetched_at: payload.fetched_at,
      ...aggregate(results),
    };
    // Private child-identity registry — resolves/mints persistent IDs for
    // off-roster children so they can be linked across visits. Never
    // exposed to the dashboard; only the admin export route below reads
    // it. Carries forward IDs already minted in the last refresh rather
    // than starting fresh each time.
    const previousRegistry = (await env.DASHBOARD_KV.get('children_registry', 'json')) || {};
    const registry = resolveChildIdentities(results, previousRegistry);

    // Public, name-free — derived FROM the private registry but never
    // includes a name or raw child ID itself, safe for /api/snapshot.
    const snapshot = buildSnapshot(registry, summary);

    await env.DASHBOARD_KV.put('data', JSON.stringify(payload));
    await env.DASHBOARD_KV.put('summary', JSON.stringify(summary));
    await env.DASHBOARD_KV.put('children_registry', JSON.stringify(registry));
    await env.DASHBOARD_KV.put('snapshot', JSON.stringify(snapshot));
    // Keep the AI insights from going stale on their own — but only spend
    // an Anthropic call when there's actually something new to say (see
    // maybeRegenerateInsights below), not on every 30-min cron tick
    // regardless of whether the data changed.
    await maybeRegenerateInsights(env, summary);
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Auto-regenerates insights whenever the underlying data has actually
// moved since the last generation (different record count, or an older
// prompt/schema version) — so insights stay fresh without the 48
// calls/day a fixed-cadence regeneration would mean regardless of
// whether anything changed. Runs after every refresh (cron or manual);
// a failure here never fails the data refresh itself — stale insights
// are a lesser problem than no data at all.
async function maybeRegenerateInsights(env, summary) {
  if (!env.ANTHROPIC_API_KEY) return;
  if (!summary.years || summary.years.length === 0) return;
  try {
    const existing = await env.DASHBOARD_KV.get('insights', 'json');
    const upToDate = existing && existing.status === 'ok'
      && existing.based_on_records === summary.total_records
      && existing.schema_version === INSIGHTS_SCHEMA_VERSION;
    if (upToDate) return;
    const result = await generateInsights(summary, env.ANTHROPIC_API_KEY);
    const stored = { status: 'ok', schema_version: INSIGHTS_SCHEMA_VERSION, generated_at: new Date().toISOString(), based_on_records: summary.total_records, ...result };
    await env.DASHBOARD_KV.put('insights', JSON.stringify(stored));
  } catch (err) {
    console.error(`auto insights regeneration failed: ${err.message}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const authed = isTeamAuthed(request, env);

    // /api/data (raw KoBo records: child names, GPS, enumerators) used to be
    // served publicly here. Nothing in the dashboard needs it, so it is gone;
    // read the raw copy straight from KV with wrangler when an admin needs it.

    if (url.pathname === '/api/summary') {
      const stored = await env.DASHBOARD_KV.get('summary', 'json');
      const body = stored || {
        status: env.KOBO_ASSET_ID ? 'pending_first_fetch' : 'not_configured',
        total_records: 0,
        years: [],
        by_year: {},
        dq: {
          flags: [], enumerator_totals: {}, enumerator_pace: {},
          enumerator_detail: {}, school_detail: {}, ward_detail: {}, daily_totals: {},
          round_mismatches: 0,
        },
      };
      // team_authenticated lets the dashboard's unlock prompt confirm
      // whether the secret it just sent was actually accepted, without
      // having to infer it from which fields are present.
      return Response.json({ ...(authed ? body : redactSummaryForPublic(body)), team_authenticated: authed });
    }

    // On-demand refresh — same logic the 30-min cron runs. Gated: it's
    // free to call but can hammer KoBo's API if left open to anyone.
    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      if (!authed) return Response.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
      const result = await refreshData(env);
      // Never echo the raw records back — they contain child names and GPS.
      const safe = result.ok
        ? { ok: true, total_records: result.payload.total_records, fetched_at: result.payload.fetched_at }
        : { ok: false, reason: result.reason };
      return Response.json(safe, { status: result.ok ? 200 : 502 });
    }

    // Internal-only export: the one place a child's real name is ever
    // returned. Gated by its own secret (ADMIN_KEY, separate from and
    // higher-privilege than TEAM_SECRET) — set via
    // `wrangler secret put ADMIN_KEY`.
    if (url.pathname === '/api/admin/children-export') {
      if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return Response.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
      }
      const registry = (await env.DASHBOARD_KV.get('children_registry', 'json')) || {};
      const csv = childrenRegistryToCsv(registry);
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="soma-children-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    // Per-student roster + ability detail for one school — what the
    // printable school report (report.html) uses to build the
    // name-and-ability-level breakdown teachers act on. Same privilege
    // tier as children-export (ADMIN_KEY, not TEAM_SECRET) since
    // off-roster children's real names come back here too. Roster
    // children (on_roster=1) only ever carry their assessment code, never
    // a name — the KoBo form deliberately never transmits a roster
    // child's name, only their pre-assigned code (see src/children.js) —
    // so `name` is null for them here; report.html shows the code and a
    // note for schools to match it against their own roster list.
    if (url.pathname === '/api/admin/school-roster') {
      if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return Response.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
      }
      const schoolId = url.searchParams.get('school_id');
      if (!schoolId) return Response.json({ ok: false, reason: 'school_id required' }, { status: 400 });
      const registry = (await env.DASHBOARD_KV.get('children_registry', 'json')) || {};
      const students = Object.entries(registry)
        .filter(([, c]) => c.school_id === schoolId && c.records && c.records.length)
        .map(([id, c]) => {
          const latest = [...c.records].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          return {
            id,
            name: c.name || null,
            origin: c.origin,
            grade: latest.grade,
            reading_level: latest.reading_level,
            arithmetic_level: latest.arithmetic_level,
            last_assessed: latest.date,
            visits: c.records.length,
          };
        });
      return Response.json({ ok: true, school_id: schoolId, students });
    }

    // Public and name-free — per-school movement (same children, across
    // visits) and recognition rankings. See src/snapshot.js for what this
    // deliberately does NOT include yet (anything needing 2+ real visits).
    if (url.pathname === '/api/snapshot') {
      const stored = await env.DASHBOARD_KV.get('snapshot', 'json');
      return Response.json(stored || { by_school: {}, recognition: { full_participation: null, no_one_left_behind: null } });
    }

    if (url.pathname === '/api/insights') {
      const stored = await env.DASHBOARD_KV.get('insights', 'json');
      const body = stored || { status: 'not_generated' };
      return Response.json(authed ? body : redactInsightsForPublic(body));
    }

    // On-demand — regenerating on every 30-min cron tick would mean 48
    // LLM calls/day regardless of whether the underlying data changed.
    // Kept manual for now (or call it after a real /api/refresh); costs
    // real Anthropic credit per call, so it's gated like /api/refresh.
    if (url.pathname === '/api/generate-insights' && request.method === 'POST') {
      if (!authed) return Response.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
      if (!env.ANTHROPIC_API_KEY) {
        return Response.json({ ok: false, reason: 'ANTHROPIC_API_KEY not set' }, { status: 501 });
      }
      const summary = await env.DASHBOARD_KV.get('summary', 'json');
      if (!summary || !summary.years || summary.years.length === 0) {
        return Response.json({ ok: false, reason: 'no data to analyze yet' }, { status: 409 });
      }
      try {
        const result = await generateInsights(summary, env.ANTHROPIC_API_KEY);
        const stored = { status: 'ok', schema_version: INSIGHTS_SCHEMA_VERSION, generated_at: new Date().toISOString(), based_on_records: summary.total_records, ...result };
        await env.DASHBOARD_KV.put('insights', JSON.stringify(stored));
        return Response.json({ ok: true, insights: stored });
      } catch (err) {
        return Response.json({ ok: false, reason: err.message }, { status: 502 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  // Cron-triggered. No-op until KOBO_ASSET_ID + KOBO_TOKEN are both set —
  // safe to leave running before the real KoBo form exists.
  async scheduled(event, env, ctx) {
    const result = await refreshData(env);
    if (result.ok) {
      console.log(`refreshed: ${result.payload.total_records} records`);
    } else if (result.reason !== 'not_configured') {
      console.error(`fetch failed: ${result.reason}`);
    }
  },
};
