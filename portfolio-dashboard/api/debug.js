export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const REDIS_URL   = process.env.KV_REST_API_URL || process.env.REDIS_URL;
  const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

  try {
    // screener:data 에서 첫 3개만 가져오기
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent('screener:data')}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const d = await r.json();
    const raw = d?.result;
    
    if (!raw) return res.status(200).json({ error: 'no data in redis' });
    
    const parsed = JSON.parse(raw);
    const sample = parsed.slice(0, 3);
    
    return res.status(200).json({
      total: parsed.length,
      sample,
      firstChangesKeys: sample[0] ? Object.keys(sample[0].changes || {}) : [],
      firstChanges: sample[0]?.changes,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
