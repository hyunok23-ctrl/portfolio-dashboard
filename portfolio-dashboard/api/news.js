export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { code, name } = req.query;
  if (!code || !name) return res.status(400).json({ error: 'missing params' });

  // ── 네이버 금융 뉴스 크롤링 ──────────────────────────────
  const fetchNews = async () => {
    try {
      const url = `https://finance.naver.com/item/news_news.naver?code=${code}&page=1&sm=title_entity_id.basic&clusterId=`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const html = await r.text();

      const news = [];
      // 뉴스 제목 + 날짜 파싱
      const rowRegex = /title="([^"]+)"[\s\S]*?(\d{4}\.\d{2}\.\d{2}\s\d{2}:\d{2})/g;
      let match;
      while ((match = rowRegex.exec(html)) !== null && news.length < 10) {
        const title = match[1].trim();
        const date = match[2].trim();
        if (title && title.length > 5) {
          news.push({ title, date });
        }
      }
      return news;
    } catch { return []; }
  };

  // ── Claude AI로 호재/악재 분석 ───────────────────────────
  const analyzeWithClaude = async (stockName, newsList) => {
    if (!newsList.length) return null;
    try {
      const titles = newsList.map((n, i) => `${i+1}. [${n.date}] ${n.title}`).join('\n');
      const prompt = `다음은 "${stockName}" 종목의 최근 뉴스 목록입니다.

${titles}

위 뉴스들을 분석하여 아래 JSON 형식으로만 응답해주세요. 다른 텍스트는 절대 포함하지 마세요:
{
  "sentiment": "호재" | "악재" | "중립",
  "score": 1~10 (10이 가장 강한 호재),
  "summary": "2~3문장으로 핵심 내용 요약",
  "positives": ["호재 요인 1", "호재 요인 2"],
  "negatives": ["악재 요인 1", "악재 요인 2"],
  "keywords": ["핵심 키워드1", "핵심 키워드2", "핵심 키워드3"]
}`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        })
      });
      const d = await r.json();
      const text = d?.content?.[0]?.text || '';
      const clean = text.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    } catch { return null; }
  };

  try {
    const newsList = await fetchNews();
    const analysis = await analyzeWithClaude(name, newsList);

    return res.status(200).json({
      code,
      name,
      news: newsList,
      analysis,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
