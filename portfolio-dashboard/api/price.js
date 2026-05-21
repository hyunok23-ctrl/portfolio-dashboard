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
  await Promise.all(codeList.map(async (code) => {
    const num = parseInt(code) || 0;
    const isKq = num >= 30000 && num <= 499999;
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
