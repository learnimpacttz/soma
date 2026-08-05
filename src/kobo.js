// Generic paginated KoBo fetch. No assumptions about field names or form
// schema — hardcoded field-code assumptions were the exact bug class that
// broke the stakeholders-survey dashboard for weeks (fields drifted from the
// live form). Callers decide what to do with raw records.

export async function fetchKoboData(server, assetId, token) {
  const base = `https://${server}/api/v2/assets/${assetId}/data/?format=json&limit=1000`;
  let url = base;
  const results = [];

  while (url) {
    const resp = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!resp.ok) {
      throw new Error(`KoBo fetch failed (${resp.status}) for asset ${assetId}`);
    }
    const data = await resp.json();
    results.push(...(data.results || []));
    url = data.next || null;
  }

  return results;
}
