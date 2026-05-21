// api/price.js - Vercel Serverless Function
// 네이버 모바일 증권 API로 시세 조회

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { codes } = req.query;
  if (!codes) return res.status(400).json({ error: 'codes 파라미터가 필요합니다' });

  const codeList = codes.split(',').map(c => c.trim()).filter(Boolean);

  const results = {};

  await Promise.all(
    codeList.map(async (code) => {
      try {
        // 네이버 모바일 증권 API (ETF/주식 모두 지원)
        const url = `https://m.stock.naver.com/api/stock/${code}/integration`;
        const res2 = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
            'Referer': 'https://m.stock.naver.com/',
            'Accept': 'application/json',
          },
        });

        if (res2.ok) {
          const data = await res2.json();
          const s = data?.stockInfo || {};
          const price = parseInt((s.closePrice || s.currentPrice || '0').replace(/,/g, '')) || 0;
          const change = parseFloat(s.fluctuationsRatio || s.changeRate || 0);
          const changePrice = parseInt((s.compareToPreviousClosePrice || '0').replace(/,/g, '')) || 0;
          results[code] = { code, name: s.stockName || s.name || code, price, change, changePrice };
          return;
        }

        // fallback: 네이버 PC 증권 API
        const url2 = `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`;
        const res3 = await fetch(url2, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://finance.naver.com/',
          },
        });

        if (res3.ok) {
          const data = await res3.json();
          const item = data?.result?.areas?.[0]?.datas?.[0] || {};
          results[code] = {
            code,
            name: item.nm || code,
            price: parseInt(item.nv || 0),
            change: parseFloat(item.cr || 0),
            changePrice: parseInt(item.cv || 0),
          };
          return;
        }

        // fallback2: 네이버 ETF API
        const url3 = `https://m.stock.naver.com/api/etf/${code}/integration`;
        const res4 = await fetch(url3, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
            'Referer': 'https://m.stock.naver.com/',
          },
        });

        if (res4.ok) {
          const data = await res4.json();
          const s = data?.etfTabMenu?.etfSummary || data?.stockInfo || {};
          const price = parseInt((s.closePrice || s.nav || '0').replace(/,/g, '')) || 0;
          results[code] = {
            code,
            name: s.etfName || s.stockName || code,
            price,
            change: parseFloat(s.fluctuationsRatio || 0),
            changePrice: parseInt((s.compareToPreviousClosePrice || '0').replace(/,/g, '')) || 0,
          };
          return;
        }

        results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
      } catch (e) {
        results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
      }
    })
  );

  return res.status(200).json(results);
}
