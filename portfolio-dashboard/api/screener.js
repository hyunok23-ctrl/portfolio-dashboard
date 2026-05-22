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
    period = '1',       // 기간 (개월): 1, 3, 6, 12
    market = 'ALL',     // ALL, KOSPI, KOSDAQ
    sector = 'ALL',     // ALL or 섹터명
    maxPer = '15',      // PER 상한
    maxPbr = '1.5',     // PBR 상한
    minUnderperform = '5', // 지수 대비 최소 하회율 (%)
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
    const indexChange = indexChanges?.[m];

    // 섹터 목록 추출
    const sectors = [...new Set(allData.map(s => s.sector).filter(Boolean))].sort();

    // 필터링
    const filtered = allData.filter(s => {
      // 시장 필터
      if (market !== 'ALL' && s.market !== market) return false;

      // 섹터 필터
      if (sector !== 'ALL' && s.sector !== sector) return false;

      // PER 필터
      if (s.per === null || s.per <= 0 || s.per > parseFloat(maxPer)) return false;

      // PBR 필터
      if (s.pbr === null || s.pbr <= 0 || s.pbr > parseFloat(maxPbr)) return false;

      // 지수 대비 하회 필터
      const stockChange = s.changes?.[m];
      if (stockChange === null || stockChange === undefined) return false;

      const refIndex = s.market === 'KOSPI' ? indexChange?.KOSPI : indexChange?.KOSDAQ;
      if (refIndex === null || refIndex === undefined) return false;

      const underperform = refIndex - stockChange; // 양수면 지수보다 낮게 상승
      if (underperform < parseFloat(minUnderperform)) return false;

      return true;
    }).map(s => {
      const stockChange = s.changes?.[m];
      const refIndex = s.market === 'KOSPI' ? indexChange?.KOSPI : indexChange?.KOSDAQ;
      return {
        ...s,
        stockChange: stockChange !== null ? parseFloat(stockChange?.toFixed(2)) : null,
        indexChange: refIndex !== null ? parseFloat(refIndex?.toFixed(2)) : null,
        underperform: refIndex !== null && stockChange !== null
          ? parseFloat((refIndex - stockChange).toFixed(2)) : null,
      };
    }).sort((a, b) => (b.underperform || 0) - (a.underperform || 0)); // 하회율 큰 순

    return res.status(200).json({
      ready: true,
      updated,
      total: filtered.length,
      sectors,
      indexChanges: indexChange,
      stocks: filtered.slice(0, 100), // 최대 100개
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
