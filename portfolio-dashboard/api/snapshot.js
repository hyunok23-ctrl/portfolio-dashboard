// api/snapshot.js - 일별 스냅샷 저장/조회

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

const redis = async (cmd, ...args) => {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([cmd, ...args]),
  });
  const d = await r.json();
  return d.result;
};

const getKSTDate = () => {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: 전체 스냅샷 목록 조회
  if (req.method === 'GET') {
    try {
      const keys = await redis('KEYS', 'snapshot:*');
      if (!keys || keys.length === 0) return res.status(200).json([]);

      const sorted = keys.sort().reverse(); // 최신순
      const snapshots = await Promise.all(
        sorted.map(async (key) => {
          const data = await redis('GET', key);
          return data ? JSON.parse(data) : null;
        })
      );
      return res.status(200).json(snapshots.filter(Boolean));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: 오늘 스냅샷 저장
  if (req.method === 'POST') {
    try {
      const today = getKSTDate();
      const key = 'snapshot:' + today;

      // 이미 오늘 저장된 데이터가 있으면 스킵
      const existing = await redis('GET', key);
      if (existing) {
        return res.status(200).json({ ok: true, skipped: true, date: today });
      }

      const snapshot = {
        date: today,
        ...req.body, // { totalPrincipal, totalEval, totalProfit, totalProfitRate, holdings }
      };

      await redis('SET', key, JSON.stringify(snapshot));
      return res.status(200).json({ ok: true, date: today });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
