// Vercel Cron: 매일 16:30 KST (07:30 UTC) 실행
export default async function handler(req, res) {
  // Cron 또는 수동 실행만 허용
  if (req.method !== 'GET') return res.status(405).end();

  const REDIS_URL   = process.env.KV_REST_API_URL || process.env.REDIS_URL;
  const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
  const APP_KEY     = process.env.KIS_APP_KEY;
  const APP_SECRET  = process.env.KIS_APP_SECRET;

  // ── Redis 헬퍼 ──────────────────────────────────────────
  const redisSet = async (key, value, exSeconds) => {
    try {
      await fetch(
        `${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}${exSeconds ? `/ex/${exSeconds}` : ''}`,
        { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
      );
    } catch {}
  };

  const redisGet = async (key) => {
    try {
      const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const d = await r.json();
      return d?.result ? JSON.parse(d.result) : null;
    } catch { return null; }
  };

  // ── 한투 토큰 ───────────────────────────────────────────
  const getToken = async () => {
    const cached = await redisGet('kis_access_token');
    if (cached) return cached;
    try {
      const r = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, appsecret: APP_SECRET })
      });
      const d = await r.json();
      if (d?.access_token) {
        await fetch(`${REDIS_URL}/set/kis_access_token/${encodeURIComponent(d.access_token)}/ex/82800`, {
          headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        return d.access_token;
      }
    } catch {}
    return null;
  };

  // ── 네이버 금융: 시장별 전체 종목 목록 크롤링 ────────────
  const fetchMarketStocks = async (market) => {
    // market: 'stockMkt'(코스피) or 'kosdaqMkt'(코스닥)
    const stocks = [];
    let page = 1;
    while (true) {
      try {
        const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${market === 'stockMkt' ? 0 : 1}&page=${page}`;
        const r = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Charset': 'utf-8',
          }
        });
        const html = await r.text();

        // 종목 파싱
        const rowRegex = /href="\/item\/main\.naver\?code=(\d{6})">([^<]+)<\/a>/g;
        let match;
        let found = 0;
        while ((match = rowRegex.exec(html)) !== null) {
          stocks.push({ code: match[1], name: match[2].trim(), market: market === 'stockMkt' ? 'KOSPI' : 'KOSDAQ' });
          found++;
        }
        if (found === 0) break;
        page++;
        if (page > 50) break; // 최대 50페이지
        await new Promise(r => setTimeout(r, 200)); // 요청 간격
      } catch { break; }
    }
    return stocks;
  };

  // ── 네이버 금융: 종목별 PER/PBR/섹터 크롤링 ─────────────
  const fetchStockDetail = async (code) => {
    try {
      const url = `https://finance.naver.com/item/main.naver?code=${code}`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        }
      });
      const html = await r.text();

      // PER 추출
      const perMatch = html.match(/PER<\/th>[\s\S]*?<td[^>]*>([\d,.]+|N\/A|-)<\/td>/);
      const per = perMatch ? parseFloat(perMatch[1].replace(',', '')) || null : null;

      // PBR 추출
      const pbrMatch = html.match(/PBR<\/th>[\s\S]*?<td[^>]*>([\d,.]+|N\/A|-)<\/td>/);
      const pbr = pbrMatch ? parseFloat(pbrMatch[1].replace(',', '')) || null : null;

      // 업종(섹터) 추출
      const sectorMatch = html.match(/업종<\/em>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
      const sector = sectorMatch ? sectorMatch[1].trim() : null;

      return { per, pbr, sector };
    } catch { return { per: null, pbr: null, sector: null }; }
  };

  // ── 한투 API: 지수 기간별 등락률 ────────────────────────
  const fetchIndexChange = async (token, indexCode, months) => {
    try {
      const today = new Date();
      const start = new Date(today);
      start.setMonth(start.getMonth() - months);
      const fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');

      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice`
        + `?fid_cond_mrkt_div_code=U&fid_input_iscd=${indexCode}`
        + `&fid_input_date_1=${fmt(start)}&fid_input_date_2=${fmt(today)}`
        + `&fid_period_div_code=M`;
      const r = await fetch(url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: APP_KEY, appsecret: APP_SECRET,
          tr_id: 'FHKUP03500100'
        }
      });
      const d = await r.json();
      const output = d?.output2 || [];
      if (output.length < 2) return null;
      const latest = parseFloat(output[0]?.bstp_nmix_prpr);
      const oldest = parseFloat(output[output.length-1]?.bstp_nmix_prpr);
      return oldest > 0 ? ((latest - oldest) / oldest) * 100 : null;
    } catch { return null; }
  };

  // ── 종목 기간별 등락률 (한투 API) ────────────────────────
  const fetchStockChange = async (token, code, months) => {
    try {
      const today = new Date();
      const start = new Date(today);
      start.setMonth(start.getMonth() - months);
      const fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');

      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
        + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`
        + `&fid_input_date_1=${fmt(start)}&fid_input_date_2=${fmt(today)}`
        + `&fid_period_div_code=M&fid_org_adj_prc=0`;
      const r = await fetch(url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: APP_KEY, appsecret: APP_SECRET,
          tr_id: 'FHKST03010100'
        }
      });
      const d = await r.json();
      const output = d?.output2 || [];
      if (output.length < 2) return null;
      const latest = parseFloat(output[0]?.stck_clpr);
      const oldest = parseFloat(output[output.length-1]?.stck_clpr);
      return oldest > 0 ? ((latest - oldest) / oldest) * 100 : null;
    } catch { return null; }
  };

  try {
    console.log('크롤링 시작...');

    // 1. 전체 종목 목록 수집
    const [kospiStocks, kosdaqStocks] = await Promise.all([
      fetchMarketStocks('stockMkt'),
      fetchMarketStocks('kosdaqMkt'),
    ]);
    const allStocks = [...kospiStocks, ...kosdaqStocks];
    console.log(`총 ${allStocks.length}개 종목 수집`);

    // 2. 종목별 PER/PBR/섹터 (배치로 처리, 10개씩)
    const details = {};
    const batchSize = 10;
    for (let i = 0; i < allStocks.length; i += batchSize) {
      const batch = allStocks.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(s => fetchStockDetail(s.code)));
      batch.forEach((s, idx) => { details[s.code] = results[idx]; });
      await new Promise(r => setTimeout(r, 500)); // 배치 간 대기
    }

    // 3. 한투 토큰 + 지수 등락률
    const token = await getToken();
    const periods = [1, 3, 6, 12];
    const indexChanges = {};
    if (token) {
      for (const m of periods) {
        const [kospi, kosdaq] = await Promise.all([
          fetchIndexChange(token, '0001', m), // 코스피
          fetchIndexChange(token, '1001', m), // 코스닥
        ]);
        indexChanges[m] = { KOSPI: kospi, KOSDAQ: kosdaq };
      }
    }

    // 4. 종목별 기간 등락률 (보유종목 + 필터 후보만)
    // 일단 PER/PBR 유효한 종목만 등락률 계산
    const validStocks = allStocks.filter(s => {
      const d = details[s.code];
      return d?.per !== null && d?.pbr !== null && d?.per > 0 && d?.pbr > 0;
    });

    const stockChanges = {};
    if (token) {
      const changeBatchSize = 5;
      for (let i = 0; i < validStocks.length; i += changeBatchSize) {
        const batch = validStocks.slice(i, i + changeBatchSize);
        const results = await Promise.all(
          batch.map(s => Promise.all(periods.map(m => fetchStockChange(token, s.code, m))))
        );
        batch.forEach((s, idx) => {
          stockChanges[s.code] = {};
          periods.forEach((m, pi) => { stockChanges[s.code][m] = results[idx][pi]; });
        });
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 5. 최종 데이터 합치기
    const screenerData = allStocks.map(s => ({
      code: s.code,
      name: s.name,
      market: s.market,
      sector: details[s.code]?.sector || '기타',
      per: details[s.code]?.per,
      pbr: details[s.code]?.pbr,
      changes: stockChanges[s.code] || {},
    })).filter(s => s.per !== null && s.pbr !== null);

    // 6. Redis에 저장 (25시간 TTL)
    await redisSet('screener:data', screenerData, 90000);
    await redisSet('screener:index', indexChanges, 90000);
    await redisSet('screener:updated', new Date().toISOString(), 90000);

    console.log(`완료: ${screenerData.length}개 종목 저장`);
    return res.status(200).json({
      ok: true,
      total: screenerData.length,
      updated: new Date().toISOString(),
    });

  } catch (e) {
    console.error('크롤링 실패:', e);
    return res.status(500).json({ error: e.message });
  }
}
