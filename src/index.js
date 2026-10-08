import { fetchKoboData } from './kobo.js';
import { aggregate } from './aggregate.js';
import { generateInsights, INSIGHTS_SCHEMA_VERSION } from './insights.js';
import { resolveChildIdentities, childrenRegistryToCsv } from './children.js';

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

    await env.DASHBOARD_KV.put('data', JSON.stringify(payload));
    await env.DASHBOARD_KV.put('summary', JSON.stringify(summary));
    await env.DASHBOARD_KV.put('children_registry', JSON.stringify(registry));
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // /api/data (raw KoBo records: child names, GPS, enumerators) used to be
    // served publicly here. Nothing in the dashboard needs it, so it is gone;
    // read the raw copy straight from KV with wrangler when an admin needs it.

    if (url.pathname === '/api/summary') {
      const stored = await env.DASHBOARD_KV.get('summary', 'json');
      return Response.json(
        stored || {
          status: env.KOBO_ASSET_ID ? 'pending_first_fetch' : 'not_configured',
          total_records: 0,
          years: [],
          by_year: {},
          dq: { flags: [], enumerator_totals: {}, round_mismatches: 0 },
        }
      );
    }

    // On-demand refresh — same logic the 30-min cron runs, triggerable
    // manually (testing, or a "refresh now" button in the dashboard later).
    // Doesn't touch KOBO_TOKEN client-side; the fetch stays server-side.
    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      const result = await refreshData(env);
      // Never echo the raw records back — they contain child names and GPS.
      const safe = result.ok
        ? { ok: true, total_records: result.payload.total_records, fetched_at: result.payload.fetched_at }
        : { ok: false, reason: result.reason };
      return Response.json(safe, { status: result.ok ? 200 : 502 });
    }

    // TEMPORARY — demo-data seeding for reviewing the dashboard with more
    // volume than the real KoBo form has yet. Never touches KoBo itself;
    // merges synthetic records into KV on top of whatever's really there.
    // Calling /api/refresh afterward re-pulls from KoBo and overwrites this,
    // so seeding is always cleanly reversible. Remove this route entirely
    // before real field rollout.
    if (url.pathname === '/api/seed-demo' && request.method === 'POST') {
      if (!env.SEED_KEY || request.headers.get('X-Seed-Key') !== env.SEED_KEY) {
        return Response.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
      }
      const body = await request.json();
      const dummy = Array.isArray(body.records) ? body.records : [];
      const existing = (await env.DASHBOARD_KV.get('data', 'json'))?.results || [];
      const real = existing.filter((r) => !r._demo);
      const combined = [...real, ...dummy];
      const payload = {
        status: 'ok',
        total_records: combined.length,
        fetched_at: new Date().toISOString(),
        results: combined,
      };
      const summary = {
        status: 'ok',
        total_records: combined.length,
        fetched_at: payload.fetched_at,
        ...aggregate(combined),
      };
      await env.DASHBOARD_KV.put('data', JSON.stringify(payload));
      await env.DASHBOARD_KV.put('summary', JSON.stringify(summary));
      return Response.json({ ok: true, total_records: combined.length, demo_records: dummy.length });
    }

    // Internal-only export: the one place a child's real name is ever
    // returned. Gated by a real server-side secret (ADMIN_KEY) — the
    // dashboard's TEAM_PASSPHRASE is cosmetic client-side UI gating, not
    // real auth, so it can't protect this. Michael sets ADMIN_KEY himself
    // via `wrangler secret put ADMIN_KEY`; this route 404s until it's set,
    // same pattern as the other not-yet-rotated secrets on this Worker.
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

    if (url.pathname === '/api/insights') {
      const stored = await env.DASHBOARD_KV.get('insights', 'json');
      return Response.json(stored || { status: 'not_generated' });
    }

    // On-demand — regenerating on every 30-min cron tick would mean 48
    // LLM calls/day regardless of whether the underlying data changed.
    // Kept manual for now (or call it after a real /api/refresh); an
    // automatic slower-cadence trigger is a reasonable follow-up, not
    // built unrequested.
    if (url.pathname === '/api/generate-insights' && request.method === 'POST') {
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
