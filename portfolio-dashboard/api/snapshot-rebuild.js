// api/snapshot-rebuild.js
// 과거 스냅샷 종가 기준으로 재계산 저장
// POST /api/snapshot-rebuild → 전체 재처리
// 전략: 종목별 KIS 일봉 1회 조회 → 날짜별 가격 매핑 → 재계산 → ph:* 저장

const REDIS_URL   = process.env.KV_REST_API_URL || process.env.REDIS_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.REDIS_TOKEN;
const APP_KEY     = process.env.KIS_APP_KEY;
const APP_SECRET  = process.env.KIS_APP_SECRET;
const INDEX_KEY   = 'ph:index';

// ── Redis ─────────────────────────────────────────────────
const rdb = async (cmd, ...args) => {
  const parts = [cmd, ...args].map(a => encodeURIComponent(String(a)));
  const res = await fetch(`${REDIS_URL}/${parts.join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  return (await res.json())?.result ?? null;
};
const rget  = k          => rdb('get', k);
const rset  = (k, v)     => rdb('set', k, v);
const rdel  = k          => rdb('del', k);
const zadd  = (k, s, m)  => rdb('zadd', k, s, m);
const zrem  = (k, m)     => rdb('zrem', k, m);

// ── KIS ───────────────────────────────────────────────────
const getToken = async () => {
  const cached = await rget('kis_access_token');
  if (cached) return cached;
  const r = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, appsecret: APP_SECRET }),
  });
  const d = await r.json();
  if (d?.access_token) {
    await rset('kis_access_token', d.access_token);
    return d.access_token;
  }
  return null;
};

const kisHeaders = (token) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  appkey: APP_KEY,
  appsecret: APP_SECRET,
  tr_id: 'FHKST03010100',
  custtype: 'P',
});

// 종목 일봉 종가 조회 → { "YYYYMMDD": closingPrice } 맵 반환
const fetchDailyPrices = async (code, token, fromDate, toDate) => {
  try {
    const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
      + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`
      + `&fid_input_date_1=${fromDate}&fid_input_date_2=${toDate}`
      + `&fid_period_div_code=D&fid_org_adj_prc=0`;
    const r = await fetch(url, { headers: kisHeaders(token) });
    const d = await r.json();
    const map = {};
    for (const item of d?.output2 || []) {
      const price = parseInt(item.stck_clpr, 10);
      if (item.stck_bsop_date && price > 0) {
        map[item.stck_bsop_date] = price; // key: "20260521"
      }
    }
    return map;
  } catch { return {}; }
};

// ── 유틸 ─────────────────────────────────────────────────
const dateToScore = d => parseInt(d.replace(/-/g, ''), 10);
const toKISDate   = d => d.replace(/-/g, '');           // "2026-05-21" → "20260521"
const toISODate   = d => `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`; // → "2026-05-21"

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // ① ph:index 에서 전체 날짜 목록 가져오기
    const rawDates = await rdb('zrevrange', INDEX_KEY, 0, 100);
    const dateList = !rawDates ? [] : Array.isArray(rawDates) ? rawDates : [rawDates];

    const debugInfo = { indexResult: rawDates, dateList, snapSamples: [] };

    // ② ph:* 스냅샷 데이터 로드 (전체 재처리)
    const snapshots = [];
    for (const dateStr of dateList) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      const raw = await rget(`ph:${dateStr}`);
      if (raw) {
        const d = JSON.parse(raw);
        debugInfo.snapSamples.push({ date: d.date, holdingCount: d.holdings?.length, closing: d.closing });
        if (d.date && d.holdings?.length > 0) snapshots.push(d);
      }
    }

    if (snapshots.length === 0) {
      return res.status(200).json({ ok: true, message: '재수집할 데이터 없음', debug: debugInfo });
    }

    if (snapshots.length === 0) {
      return res.status(200).json({ ok: true, message: '모든 데이터가 이미 종가 확정 상태' });
    }

    // ③ 날짜 범위 계산
    const dates = snapshots.map(s => s.date).sort();
    const fromKIS = toKISDate(dates[0]);
    const toKIS   = toKISDate(dates[dates.length - 1]);

    // ④ 종목 코드 수집 (전체 스냅샷에 등장한 unique codes)
    const codeSet = new Set();
    for (const snap of snapshots) {
      for (const h of snap.holdings || []) {
        if (h.code) codeSet.add(h.code);
      }
    }
    const codes = [...codeSet];

    // ⑤ KIS 토큰 발급
    const token = await getToken();
    if (!token) return res.status(500).json({ error: 'KIS 토큰 발급 실패' });

    // ⑥ 종목별 일봉 종가 조회 (1종목 = 1번 호출)
    const priceMap = {}; // { code: { "20260521": 76000, ... } }
    for (const code of codes) {
      priceMap[code] = await fetchDailyPrices(code, token, fromKIS, toKIS);
      await new Promise(r => setTimeout(r, 200)); // rate limit
    }

    // ⑦ 스냅샷별 재계산 + 저장
    const results = [];
    for (const snap of snapshots) {
      const dateKIS = toKISDate(snap.date);
      let totalPrincipal = 0;
      let totalEval = 0;

      const holdings = (snap.holdings || []).map(h => {
        const closingPrice = priceMap[h.code]?.[dateKIS] || h.currentPrice || 0;
        const principal  = h.qty * h.avgPrice;
        const evalAmount = h.qty * closingPrice;
        const profit     = evalAmount - principal;
        const profitRate = principal > 0 ? (profit / principal) * 100 : 0;
        totalPrincipal  += principal;
        totalEval       += evalAmount;
        return { ...h, currentPrice: closingPrice, principal, evalAmount, profit, profitRate };
      });

      const totalProfit     = totalEval - totalPrincipal;
      const totalProfitRate = totalPrincipal > 0 ? (totalProfit / totalPrincipal) * 100 : 0;

      const newSnap = {
        date: snap.date,
        closing: true,                // 종가 확정 → 불변
        savedAt: new Date().toISOString(),
        totalPrincipal,
        totalEval,
        totalProfit,
        totalProfitRate,
        holdings,
      };

      // ph:* 에 덮어씀 + 인덱스 등록
      await rset(`ph:${snap.date}`, JSON.stringify(newSnap));
      await zadd(INDEX_KEY, dateToScore(snap.date), snap.date);

      results.push({ date: snap.date, totalEval, totalProfitRate: totalProfitRate.toFixed(2) });
    }

    return res.status(200).json({
      ok: true,
      rebuilt: results.length,
      dates: results,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
