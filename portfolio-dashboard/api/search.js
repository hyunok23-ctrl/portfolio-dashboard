// api/search.js - Vercel Serverless Function
// 종목명으로 종목코드 검색

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 필요합니다' });

  try {
    const url = `https://ac.finance.naver.com/ac?q=${encodeURIComponent(query)}&q_enc=UTF-8&target=stock,index,etf,etn,fund,bond,coin`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://finance.naver.com/',
      },
    });

    if (!response.ok) throw new Error('네이버 검색 실패');

    const data = await response.json();
    const items = data?.items?.[0] || [];

    const results = items.slice(0, 10).map(item => ({
      code: item[1],
      name: item[0],
      type: item[2],
    }));

    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
