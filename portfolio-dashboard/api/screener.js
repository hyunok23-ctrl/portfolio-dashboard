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
    const indexChange = indexChanges?.[m];
    const sectors = [...new Set(allData.map(s => s.sector).filter(Boolean))].sort();

    const filtered = allData.filter(s => {
      // 시장 필터
      if (market !== 'ALL' && s.market !== market) return false;
      // 섹터 필터
      if (sector !== 'ALL' && s.sector !== sector) return false;
      // PER 필터
      if (!s.per || s.per <= 0 || s.per > parseFloat(maxPer)) return false;
      // PBR 필터
      if (!s.pbr || s.pbr <= 0 || s.pbr > parseFloat(maxPbr)) return false;

      const stockChange = s.changes?.[m];
      if (stockChange === null || stockChange === undefined) return false;

      const refIndex = s.market === 'KOSPI' ? indexChange?.KOSPI : indexChange?.KOSDAQ;

      // 지수 데이터 없으면 종목 등락률만으로 필터 (마이너스 종목 표시)
      if (refIndex === null || refIndex === undefined) {
        return stockChange <= parseFloat(minUnderperform);
      }

      const underperform = refIndex - stockChange;
      return underperform >= parseFloat(minUnderperform);

    }).map(s => {
      const stockChange = s.changes?.[m];
      const refIndex = s.market === 'KOSPI' ? indexChange?.KOSPI : indexChange?.KOSDAQ;
      const underperform = (refIndex !== null && refIndex !== undefined && stockChange !== null)
        ? parseFloat((refIndex - stockChange).toFixed(2))
        : null;
      return {
        ...s,
        stockChange: stockChange !== null && stockChange !== undefined ? parseFloat(stockChange.toFixed(2)) : null,
        indexChange: refIndex !== null && refIndex !== undefined ? parseFloat(refIndex.toFixed(2)) : null,
        underperform,
      };
    }).sort((a, b) => (b.underperform ?? -b.stockChange ?? 0) - (a.underperform ?? -a.stockChange ?? 0));

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
