import { fetchKoboData } from './kobo.js';
import { aggregate } from './aggregate.js';

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
    await env.DASHBOARD_KV.put('data', JSON.stringify(payload));
    await env.DASHBOARD_KV.put('summary', JSON.stringify(summary));
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      const stored = await env.DASHBOARD_KV.get('data', 'json');
      return Response.json(
        stored || {
          status: env.KOBO_ASSET_ID ? 'pending_first_fetch' : 'not_configured',
          total_records: 0,
          results: [],
        }
      );
    }

    if (url.pathname === '/api/summary') {
      const stored = await env.DASHBOARD_KV.get('summary', 'json');
      return Response.json(
        stored || {
          status: env.KOBO_ASSET_ID ? 'pending_first_fetch' : 'not_configured',
          total_records: 0,
          overall: null,
          schools: {},
          dq: { flags: [], enumerator_totals: {} },
        }
      );
    }

    // On-demand refresh — same logic the 30-min cron runs, triggerable
    // manually (testing, or a "refresh now" button in the dashboard later).
    // Doesn't touch KOBO_TOKEN client-side; the fetch stays server-side.
    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      const result = await refreshData(env);
      return Response.json(result, { status: result.ok ? 200 : 502 });
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
