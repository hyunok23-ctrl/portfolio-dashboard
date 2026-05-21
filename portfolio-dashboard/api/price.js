export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { codes } = req.query;
  if (!codes) return res.status(400).json({ error: 'no codes' });
  const codeList = codes.split(',').map(c => c.trim()).filter(Boolean);
  const results = {};

  const fetch2 = async (sym) => {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=1d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const m = d?.chart?.result?.[0]?.meta;
    return m?.regularMarketPrice ? m : null;
  };

  // 두 suffix 모두 시도해서 거래소 정보로 판단
  const fetchBest = async (code) => {
    const results = {};
    await Promise.all(['.KS', '.KQ'].map(async (s) => {
      try {
        const m = await fetch2(code + s);
        if (m) results[s] = m;
      } catch (e) {}
    }));

    // exchangeName으로 판단
    for (const s of ['.KS', '.KQ']) {
      const m = results[s];
      if (!m) continue;
      const exch = (m.exchangeName || m.fullExchangeName || '').toUpperCase();
      // KSE = 코스피, KOE = 코스닥
      if (s === '.KS' && (exch.includes('KSE') || exch.includes('KOSPI') || exch.includes('KSC'))) return m;
      if (s === '.KQ' && (exch.includes('KOE') || exch.includes('KOSDAQ') || exch.includes('KOQ'))) return m;
    }

    // 거래소 판단 실패시 가격이 더 높은 걸 사용 (더 정확한 경향)
    const ks = results['.KS'];
    const kq = results['.KQ'];
    if (ks && kq) {
      // 두 개 다 있으면 exchangeName으로 재시도
      const ksExch = (ks.exchangeName || '').toUpperCase();
      const kqExch = (kq.exchangeName || '').toUpperCase();
      if (kqExch.includes('KOE') || kqExch.includes('KOQ')) return kq;
      if (ksExch.includes('KSE') || ksExch.includes('KSC')) return ks;
      return ks; // 기본은 KS
    }
    return ks || kq || null;
  };

  await Promise.all(codeList.map(async (code) => {
    try {
      const m = await fetchBest(code);
      if (!m) {
        results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
        return;
      }
      const price = Math.round(m.regularMarketPrice);
      const prev = Math.round(m.chartPreviousClose || m.previousClose || price);
      const cp = price - prev;
      const ch = prev > 0 ? parseFloat(((cp / prev) * 100).toFixed(2)) : 0;
      const raw = (m.longName || m.shortName || '').split(',')[0].replace(/\.(KS|KQ)$/i, '').trim();
      const name = (raw && !/^\d+$/.test(raw)) ? raw : code;
      results[code] = { code, name, price, change: ch, changePrice: cp };
    } catch (e) {
      results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
    }
  }));
  return res.status(200).json(results);
}
