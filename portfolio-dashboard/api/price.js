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

  // 코스닥 종목코드 특징:
  // 일반 코스닥: 030000~039999, 042000~059999, 060000~079999, 140000~145999 등
  // ETF는 대부분 코스피: 069500, 091160, 114800, 139220, 148020, 229200, 252670, 261240, 292150, 305080, 395270, 395500 등
  // ETF 코드는 6자리이고 뒤에 0으로 끝나는 경우가 많음
  const isLikelyKosdaq = (code) => {
    const num = parseInt(code) || 0;
    if (num < 30000) return false; // 코스피 대형주
    // ETF는 대부분 50단위, 100단위로 끝남 - 코스피로 우선
    if (num % 10 === 0) return false; // 10의 배수는 ETF일 가능성 높음
    // 코스닥 일반 종목: 030000~039999
    if (num >= 30000 && num <= 39999) return true;
    // 코스닥: 042000~059999
    if (num >= 42000 && num <= 59999) return true;
    // 코스닥: 060000~079999 (단, ETF 제외)
    if (num >= 60000 && num <= 79999) return true;
    // 코스닥: 130000~139999
    if (num >= 130000 && num <= 139999) return true;
    // 코스닥: 950000 이상 (스팩 등)
    if (num >= 950000) return true;
    return false;
  };

  await Promise.all(codeList.map(async (code) => {
    const isKq = isLikelyKosdaq(code);
    const suffixes = isKq ? ['.KQ', '.KS'] : ['.KS', '.KQ'];
    for (const s of suffixes) {
      try {
        const m = await fetch2(code + s);
        if (!m) continue;
        const price = Math.round(m.regularMarketPrice);
        const prev = Math.round(m.chartPreviousClose || m.previousClose || price);
        const cp = price - prev;
        const ch = prev > 0 ? parseFloat(((cp / prev) * 100).toFixed(2)) : 0;
        const raw = (m.longName || m.shortName || '').split(',')[0].replace(/\.(KS|KQ)$/i, '').trim();
        const name = (raw && !/^\d+$/.test(raw)) ? raw : code;
        results[code] = { code, name, price, change: ch, changePrice: cp };
        return;
      } catch (e) { continue; }
    }
    results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
  }));
  return res.status(200).json(results);
}
