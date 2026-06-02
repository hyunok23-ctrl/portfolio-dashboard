// api/snapshot.js — Redis DB화 버전
// ph:index  : Sorted Set  { score: YYYYMMDD(숫자), member: "YYYY-MM-DD" }
// ph:{date} : String(JSON) { date, totalPrincipal, totalEval, totalProfit,
//                            totalProfitRate, holdings, closing, savedAt }

const REDIS_URL   = process.env.KV_REST_API_URL || process.env.REDIS_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.REDIS_TOKEN;
const INDEX_KEY   = 'ph:index';

// ── Redis 헬퍼 ────────────────────────────────────────────
const r = async (cmd, ...args) => {
  const parts = [cmd, ...args].map(a => encodeURIComponent(String(a)));
  const res = await fetch(`${REDIS_URL}/${parts.join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const d = await res.json();
  return d?.result ?? null;
};

const get    = (key)               => r('get', key);
const set    = (key, val)          => r('set', key, val);
const del    = (key)               => r('del', key);
const zadd   = (key, score, mem)   => r('zadd', key, score, mem);
const zrem   = (key, mem)          => r('zrem', key, mem);
// ZREVRANGE key 0 -1 → 최신순 전체
const zrevrange = (key, s, e)      => r('zrevrange', key, s, e);
// ZRANGEBYSCORE key min max → 범위 조회 (날짜 숫자)
const zrangebyscore = (key, min, max) => r('zrangebyscore', key, min, max);

// ── 유틸 ─────────────────────────────────────────────────
const getKSTNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);

const getKSTDate = () => getKSTNow().toISOString().slice(0, 10);

const dateToScore = (dateStr) => parseInt(dateStr.replace(/-/g, ''), 10); // "2026-06-02" → 20260602

const isWeekend = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.getUTCDay() === 0 || d.getUTCDay() === 6;
};

const isMarketClosed = () => {
  const now = getKSTNow();
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  return min >= 15 * 60 + 30; // 15:30 이후
};

// ── 기존 snapshot:* 키 마이그레이션 (최초 1회) ───────────
const migrate = async () => {
  try {
    // 기존 KEYS 방식 조회 (마이그레이션 때만 사용)
    const res = await fetch(`${REDIS_URL}/keys/${encodeURIComponent('snapshot:*')}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const d = await res.json();
    const keys = d?.result || [];
    for (const k of keys) {
      const dateStr = k.replace('snapshot:', ''); // "snapshot:2026-05-21" → "2026-05-21"
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      if (isWeekend(dateStr)) continue;
      // 새 키에 없으면 이관
      const existing = await get(`ph:${dateStr}`);
      if (!existing) {
        const oldData = await get(k);
        if (oldData) {
          const parsed = JSON.parse(oldData);
          const newData = { ...parsed, closing: false, savedAt: dateStr + 'T15:00:00+09:00' };
          await set(`ph:${dateStr}`, JSON.stringify(newData));
          await zadd(INDEX_KEY, dateToScore(dateStr), dateStr);
        }
      }
    }
  } catch {}
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: 스냅샷 목록 조회 ─────────────────────────────
  if (req.method === 'GET') {
    try {
      // 마이그레이션 (기존 snapshot:* → ph:* 이관)
      await migrate();

      // ph:index 에서 최신순 전체 날짜 목록
      let dates = await zrevrange(INDEX_KEY, 0, -1);
      if (!dates || dates.length === 0) {
        return res.status(200).json([]);
      }
      if (!Array.isArray(dates)) dates = [dates];

      // 날짜별 데이터 조회 (주말 제외)
      const snapshots = await Promise.all(
        dates
          .filter(d => !isWeekend(d))
          .map(async (dateStr) => {
            const raw = await get(`ph:${dateStr}`);
            return raw ? JSON.parse(raw) : null;
          })
      );

      return res.status(200).json(snapshots.filter(Boolean));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: 스냅샷 저장 ─────────────────────────────────
  if (req.method === 'POST') {
    try {
      const today = getKSTDate();

      // 주말 제외
      if (isWeekend(today)) {
        return res.status(200).json({ ok: true, skipped: true, reason: 'weekend', date: today });
      }

      const key = `ph:${today}`;
      const existing = await get(key);
      const closed = isMarketClosed();

      if (existing) {
        const parsed = JSON.parse(existing);
        // 이미 종가 확정 → 절대 덮어쓰지 않음
        if (parsed.closing) {
          return res.status(200).json({ ok: true, skipped: true, reason: 'closing_locked', date: today });
        }
        // 장 중이고 이미 저장된 데이터 있으면 스킵
        if (!closed) {
          return res.status(200).json({ ok: true, skipped: true, date: today });
        }
        // 장 마감 후 + 장중 스냅샷 존재 → 종가로 1회만 덮어씀
      }

      const now = getKSTNow();
      const snapshot = {
        date: today,
        closing: closed,            // true = 종가 확정, 이후 변경 불가
        savedAt: now.toISOString(),
        ...req.body,
      };

      await set(key, JSON.stringify(snapshot));
      // Sorted Set 인덱스 등록 (이미 있어도 무해)
      await zadd(INDEX_KEY, dateToScore(today), today);

      return res.status(200).json({ ok: true, date: today, closing: closed });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE: 특정 날짜 삭제 (?date=YYYY-MM-DD) ─────────
  if (req.method === 'DELETE') {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: 'date required' });
      await del(`ph:${date}`);
      await zrem(INDEX_KEY, date);
      return res.status(200).json({ ok: true, deleted: date });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
