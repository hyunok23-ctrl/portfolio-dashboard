const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
const KEY = 'portfolio_holdings';
const redis = async (cmd, ...args) => {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd, ...args]),
  });
  const d = await r.json();
  return d.result;
};
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    try {
      const data = await redis('GET', KEY);
      return res.status(200).json(data ? JSON.parse(data) : []);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (req.method === 'POST') {
    try {
      await redis('SET', KEY, JSON.stringify(req.body));
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
