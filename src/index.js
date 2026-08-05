import { fetchKoboData } from './kobo.js';

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

    return env.ASSETS.fetch(request);
  },

  // Cron-triggered. No-op until KOBO_ASSET_ID + KOBO_TOKEN are both set —
  // safe to leave running before the real KoBo form exists.
  async scheduled(event, env, ctx) {
    if (!env.KOBO_ASSET_ID || !env.KOBO_TOKEN) return;
    try {
      const server = env.KOBO_SERVER || 'kf.kobotoolbox.org';
      const results = await fetchKoboData(server, env.KOBO_ASSET_ID, env.KOBO_TOKEN);
      await env.DASHBOARD_KV.put(
        'data',
        JSON.stringify({
          status: 'ok',
          total_records: results.length,
          fetched_at: new Date().toISOString(),
          results,
        })
      );
      console.log(`refreshed: ${results.length} records`);
    } catch (err) {
      console.error(`fetch failed: ${err.message}`);
    }
  },
};
