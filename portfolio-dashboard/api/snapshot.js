// api/snapshot.js - 일별 스냅샷 저장/조회

const REDIS_URL   = process.env.KV_REST_API_URL || process.env.REDIS_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.REDIS_TOKEN;

const redisGet = async (key) => {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const d = await r.json();
  return d?.result ?? null;
};
const redisSet = async (key, value) => {
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
};
const redisDel = async (key) => {
  await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
};
const redisKeys = async (pattern) => {
  const r = await fetch(`${REDIS_URL}/keys/${encodeURIComponent(pattern)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const d = await r.json();
  return d?.result ?? [];
};

const getKSTDate = () => {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
};

// 해당 날짜가 주말(토/일)인지 확인
const isWeekend = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  return day === 0 || day === 6; // 0=일, 6=토
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: 전체 스냅샷 목록 조회 (주말 제외)
  if (req.method === 'GET') {
    try {
      const keys = await redisKeys('snapshot:*');
      if (!keys || keys.length === 0) return res.status(200).json([]);

      const sorted = keys.sort().reverse(); // 최신순
      const snapshots = await Promise.all(
        sorted.map(async (key) => {
          const data = await redisGet(key);
          return data ? JSON.parse(data) : null;
        })
      );
      // 주말 스냅샷 제외하고 반환
      return res.status(200).json(
        snapshots.filter(s => s && !isWeekend(s.date))
      );
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: 오늘 스냅샷 저장 (주말 제외)
  if (req.method === 'POST') {
    try {
      const today = getKSTDate();

      // 주말이면 저장 건너뜀
      if (isWeekend(today)) {
        return res.status(200).json({ ok: true, skipped: true, reason: 'weekend', date: today });
      }

      const key = 'snapshot:' + today;

      // 이미 오늘 저장된 데이터가 있으면 스킵
      const existing = await redisGet(key);
      if (existing) {
        return res.status(200).json({ ok: true, skipped: true, date: today });
      }

      const snapshot = {
        date: today,
        ...req.body, // { totalPrincipal, totalEval, totalProfit, totalProfitRate, holdings }
      };

      await redisSet(key, JSON.stringify(snapshot));
      return res.status(200).json({ ok: true, date: today });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE: 특정 날짜 스냅샷 삭제 (?date=YYYY-MM-DD)
  if (req.method === 'DELETE') {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: 'date required' });
      await redisDel('snapshot:' + date);
      return res.status(200).json({ ok: true, deleted: date });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
