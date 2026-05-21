// api/price.js - Yahoo Finance API (코스피/코스닥 자동 감지)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { codes } = req.query;
  if (!codes) return res.status(400).json({ error: 'codes 파라미터 필요' });

  const codeList = codes.split(',').map(c => c.trim()).filter(Boolean);
  const results = {};

  const fetchSymbol = async (symbol) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    return meta;
  };

  await Promise.all(
    codeList.map(async (code) => {
      // 코스피 우선, 실패시 코스닥
      for (const suffix of ['.KS', '.KQ']) {
        try {
          const meta = await fetchSymbol(code + suffix);
          if (!meta) continue;

          const price = Math.round(meta.regularMarketPrice);
          const prevClose = Math.round(meta.chartPreviousClose || meta.previousClose || price);
          const changePrice = price - prevClose;
          const change = prevClose > 0 ? parseFloat(((changePrice / prevClose) * 100).toFixed(2)) : 0;
          const name = meta.longName || meta.shortName || code;

          results[code] = { code, name, price, change, changePrice };
          return;
        } catch (e) {
          continue;
        }
      }
      results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
    })
  );

  return res.status(200).json(results);
}
