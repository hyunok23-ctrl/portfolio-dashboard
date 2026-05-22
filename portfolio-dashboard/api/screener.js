export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const REDIS_URL   = process.env.KV_REST_API_URL || process.env.REDIS_URL;
  const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

  const redisGet = async (key) => {
    try {
      const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const d = await r.json();
      return d?.result ? JSON.parse(d.result) : null;
    } catch { return null; }
  };

  const {
    period = '1',
    market = 'ALL',
    sector = 'ALL',
    maxPer = '15',
    maxPbr = '1.5',
    minUnderperform = '5',
  } = req.query;

  try {
    const [allData, indexChanges, updated] = await Promise.all([
      redisGet('screener:data'),
      redisGet('screener:index'),
      redisGet('screener:updated'),
    ]);

    if (!allData) {
      return res.status(200).json({
        ready: false,
        message: '데이터 준비 중이에요. 잠시 후 다시 시도해주세요.',
      });
    }

    const m = parseInt(period);
    const mStr = String(m); // Redis JSON 저장 시 키가 문자열로 저장됨
    const indexChange = indexChanges?.[mStr] || indexChanges?.[m];
    const sectors = [...new Set(allData.map(s => s.sector).filter(Boolean))].sort();

    const filtered = allData.filter(s => {
      if (market !== 'ALL' && s.market !== market) return false;
      if (sector !== 'ALL' && s.sector !== sector) return false;
      if (!s.per || s.per <= 0 || s.per > parseFloat(maxPer)) return false;
      if (!s.pbr || s.pbr <= 0 || s.pbr > parseFloat(maxPbr)) return false;

      // 문자열/숫자 키 모두 시도
      const stockChange = s.changes?.[mStr] ?? s.changes?.[m];
      if (stockChange === null || stockChange === undefined) return false;

      const refIndex = s.market === 'KOSPI' ? indexChange?.KOSPI : indexChange?.KOSDAQ;

      if (refIndex === null || refIndex === undefined) {
        // 지수 없으면 종목 등락률 기준 (하락/횡보 종목)
        return stockChange <= parseFloat(minUnderperform);
      }

      const underperform = refIndex - stockChange;
      return underperform >= parseFloat(minUnderperform);

    }).map(s => {
      const stockChange = s.changes?.[mStr] ?? s.changes?.[m];
      const refIndex = s.market === 'KOSPI' ? indexChange?.KOSPI : indexChange?.KOSDAQ;
      const underperform = (refIndex != null && stockChange != null)
        ? parseFloat((refIndex - stockChange).toFixed(2)) : null;
      return {
        ...s,
        stockChange: stockChange != null ? parseFloat(stockChange.toFixed(2)) : null,
        indexChange: refIndex != null ? parseFloat(refIndex.toFixed(2)) : null,
        underperform,
      };
    }).sort((a, b) => (b.underperform ?? 0) - (a.underperform ?? 0));

    return res.status(200).json({
      ready: true,
      updated,
      total: filtered.length,
      sectors,
      indexChanges: indexChange,
      stocks: filtered.slice(0, 100),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
