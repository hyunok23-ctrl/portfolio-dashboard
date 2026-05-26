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
    requireChange = '0', // '1' 이면 변화율 데이터 없는 종목 제외
    debug = '0',
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
    const mStr = String(m);
    const indexChange = indexChanges?.[mStr] || indexChanges?.[m] || null;
    const sectors = [...new Set(allData.map(s => s.sector).filter(Boolean))].sort();

    const maxPerN = parseFloat(maxPer);
    const maxPbrN = parseFloat(maxPbr);
    const minUnderperformN = parseFloat(minUnderperform);
    const requireChangeFlag = requireChange === '1' || requireChange === 'true';

    const stats = {
      total: allData.length,
      droppedByMarket: 0,
      droppedBySector: 0,
      droppedByPer: 0,
      droppedByPbr: 0,
      droppedByMissingChange: 0,
      droppedByUnderperform: 0,
      missingChangeKept: 0,
      kept: 0,
    };

    const filtered = allData.filter(s => {
      if (market !== 'ALL' && s.market !== market) { stats.droppedByMarket++; return false; }
      if (sector !== 'ALL' && s.sector !== sector) { stats.droppedBySector++; return false; }
      if (!s.per || s.per <= 0 || s.per > maxPerN) { stats.droppedByPer++; return false; }
      if (!s.pbr || s.pbr <= 0 || s.pbr > maxPbrN) { stats.droppedByPbr++; return false; }

      const stockChange = s.changes?.[mStr] ?? s.changes?.[m];
      const hasChange = stockChange !== null && stockChange !== undefined && !Number.isNaN(stockChange);

      if (!hasChange) {
        if (requireChangeFlag) { stats.droppedByMissingChange++; return false; }
        stats.missingChangeKept++;
        stats.kept++;
        return true; // PER/PBR 통과 종목은 변화율 없어도 노출
      }

      const refIndex = s.market === 'KOSPI' ? indexChange?.KOSPI : indexChange?.KOSDAQ;
      if (refIndex === null || refIndex === undefined) {
        // 지수 데이터 없으면 종목 등락률만으로 판단: 하락폭 minUnderperform 이상
        if (-stockChange < minUnderperformN) { stats.droppedByUnderperform++; return false; }
        stats.kept++;
        return true;
      }

      const underperform = refIndex - stockChange;
      if (underperform < minUnderperformN) { stats.droppedByUnderperform++; return false; }
      stats.kept++;
      return true;

    }).map(s => {
      const stockChange = s.changes?.[mStr] ?? s.changes?.[m];
      const hasChange = stockChange !== null && stockChange !== undefined && !Number.isNaN(stockChange);
      const refIndex = s.market === 'KOSPI' ? indexChange?.KOSPI : indexChange?.KOSDAQ;
      const underperform = (refIndex != null && hasChange)
        ? parseFloat((refIndex - stockChange).toFixed(2)) : null;
      return {
        ...s,
        stockChange: hasChange ? parseFloat(stockChange.toFixed(2)) : null,
        indexChange: refIndex != null ? parseFloat(refIndex.toFixed(2)) : null,
        underperform,
      };
    }).sort((a, b) => {
      // underperform 큰 순, null은 뒤로
      const au = a.underperform, bu = b.underperform;
      if (au == null && bu == null) return 0;
      if (au == null) return 1;
      if (bu == null) return -1;
      return bu - au;
    });

    const response = {
      ready: true,
      updated,
      total: filtered.length,
      sectors,
      indexChanges: indexChange,
      stocks: filtered.slice(0, 100),
    };

    if (debug === '1' || debug === 'true') {
      response.debug = {
        ...stats,
        indexChangeForPeriod: indexChange,
        sampleStock: allData[0] || null,
        sampleChangesKeys: allData[0]?.changes ? Object.keys(allData[0].changes) : [],
      };
    }

    return res.status(200).json(response);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
