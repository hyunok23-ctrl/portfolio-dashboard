// api/price.js - Yahoo Finance API로 한국 주식/ETF 시세 조회

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { codes } = req.query;
  if (!codes) return res.status(400).json({ error: 'codes 파라미터 필요' });

  const codeList = codes.split(',').map(c => c.trim()).filter(Boolean);

  // 한국 주식: 005930 → 005930.KS (코스피) / 코스닥은 .KQ
  // 먼저 .KS 시도, 실패시 .KQ 시도
  const results = {};

  await Promise.all(
    codeList.map(async (code) => {
      const suffixes = ['.KS', '.KQ'];
      let found = false;

      for (const suffix of suffixes) {
        try {
          const symbol = code + suffix;
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
          const r = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Accept': 'application/json',
            },
          });

          if (!r.ok) continue;
          const data = await r.json();
          const meta = data?.chart?.result?.[0]?.meta;
          if (!meta || !meta.regularMarketPrice) continue;

          const price = Math.round(meta.regularMarketPrice);
          const prevClose = meta.chartPreviousClose || meta.previousClose || price;
          const changePrice = price - Math.round(prevClose);
          const change = prevClose > 0 ? (changePrice / prevClose) * 100 : 0;
          const name = meta.longName || meta.shortName || code;

          results[code] = { code, name, price, change: parseFloat(change.toFixed(2)), changePrice };
          found = true;
          break;
        } catch (e) {
          continue;
        }
      }

      if (!found) {
        results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
      }
    })
  );

  return res.status(200).json(results);
}
