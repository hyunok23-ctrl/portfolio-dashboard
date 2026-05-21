// api/price.js - Vercel Serverless Function
// 네이버 증권 비공식 API를 서버 사이드에서 호출 (CORS 우회)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { codes } = req.query;
  if (!codes) return res.status(400).json({ error: 'codes 파라미터가 필요합니다' });

  const codeList = codes.split(',').map(c => c.trim()).filter(Boolean);

  try {
    const results = {};

    await Promise.all(
      codeList.map(async (code) => {
        try {
          // 네이버 증권 비공식 API
          const url = `https://finance.naver.com/item/main.naver?code=${code}`;
          const apiUrl = `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`;

          const response = await fetch(apiUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://finance.naver.com/',
            },
          });

          if (!response.ok) {
            // fallback: 네이버 증권 시세 API
            const fallbackUrl = `https://m.stock.naver.com/api/stock/${code}/integration`;
            const fallbackRes = await fetch(fallbackUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)',
                'Referer': 'https://m.stock.naver.com/',
              },
            });
            if (fallbackRes.ok) {
              const data = await fallbackRes.json();
              const stockData = data?.stockInfo || data;
              results[code] = {
                code,
                name: stockData?.stockName || stockData?.name || code,
                price: parseInt(stockData?.closePrice?.replace(/,/g, '') || stockData?.price || 0),
                change: parseFloat(stockData?.fluctuationsRatio || stockData?.changeRate || 0),
                changePrice: parseInt(stockData?.compareToPreviousClosePrice?.replace(/,/g, '') || 0),
              };
            } else {
              results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
            }
            return;
          }

          const data = await response.json();
          const item = data?.result?.areas?.[0]?.datas?.[0] || {};
          results[code] = {
            code,
            name: item.nm || code,
            price: parseInt(item.nv || 0),
            change: parseFloat(item.cr || 0),
            changePrice: parseInt(item.cv || 0),
          };
        } catch (e) {
          results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
        }
      })
    );

    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
