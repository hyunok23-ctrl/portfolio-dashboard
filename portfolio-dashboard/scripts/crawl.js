// GitHub Actions에서 실행되는 크롤링 스크립트
// 네이버 금융에서 전체 종목 PER/PBR/섹터 수집 → Upstash Redis 저장

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const REDIS_URL   = process.env.REDIS_URL;
const REDIS_TOKEN = process.env.REDIS_TOKEN;
const APP_KEY     = process.env.KIS_APP_KEY;
const APP_SECRET  = process.env.KIS_APP_SECRET;

// ── Redis 헬퍼 ──────────────────────────────────────────
const redisSet = async (key, value, exSeconds) => {
  await fetch(
    `${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}${exSeconds ? `/ex/${exSeconds}` : ''}`,
    { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
  );
};

// ── 한투 토큰 ───────────────────────────────────────────
const getToken = async () => {
  const r = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, appsecret: APP_SECRET })
  });
  const d = await r.json();
  return d?.access_token || null;
};

const kisH = (token, trId) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  appkey: APP_KEY, appsecret: APP_SECRET,
  tr_id: trId, custtype: 'P',
});

// ── 네이버 금융: 시장별 전체 종목 PER/PBR 크롤링 ────────
// GitHub Actions는 네이버 차단 없음!
const fetchNaverMarket = async (market) => {
  // market: 0=코스피, 1=코스닥
  const stocks = [];
  let page = 1;
  
  while (true) {
    try {
      const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${market}&page=${page}`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Referer': 'https://finance.naver.com',
        }
      });
      const html = await r.text();

      // 종목 코드 + 이름 파싱
      const codeRegex = /code=(\d{6})/g;
      const nameRegex = /title="([^"]+)" class="tltle"/g;

      const codes = [...html.matchAll(codeRegex)].map(m => m[1]);
      const names = [...html.matchAll(nameRegex)].map(m => m[1]);

      // PER, PBR 파싱 (테이블 데이터)
      const rowRegex = /href="\/item\/main\.naver\?code=(\d{6})">([^<]+)<\/a>[\s\S]*?<\/tr>/g;
      let match;
      let found = 0;

      while ((match = rowRegex.exec(html)) !== null) {
        const code = match[1];
        const name = match[2].trim();
        const rowHtml = match[0];

        // td 값들 추출
        const tds = [...rowHtml.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1].trim());

        // PER은 보통 8번째, PBR은 9번째 td
        const per = parseFloat(tds[7]) || null;
        const pbr = parseFloat(tds[8]) || null;

        if (code && name && per > 0 && pbr > 0) {
          stocks.push({
            code,
            name,
            market: market === 0 ? 'KOSPI' : 'KOSDAQ',
            per,
            pbr,
          });
          found++;
        }
      }

      console.log(`  페이지 ${page}: ${found}개 수집 (누적 ${stocks.length}개)`);
      if (found === 0) break;
      page++;
      if (page > 60) break;

      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  페이지 ${page} 실패:`, e.message);
      break;
    }
  }
  return stocks;
};

// ── 네이버 금융: 종목 섹터(업종) 크롤링 ────────────────
const fetchNaverSector = async (market) => {
  const sectorMap = {};
  let page = 1;

  while (true) {
    try {
      const url = `https://finance.naver.com/sise/sise_group_detail.naver?type=upjong`;
      // 업종 목록 페이지에서 섹터 정보 가져오기
      const r = await fetch(`https://finance.naver.com/sise/sise_market_sum.naver?sosok=${market}&page=${page}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR' }
      });
      const html = await r.text();

      // 업종명 + 종목코드 파싱
      const sectorRegex = /upjong[^>]*>([^<]+)<\/a>[\s\S]*?code=(\d{6})/g;
      let found = 0;
      let match;

      // 간단히 종목별 업종 매핑
      const rowRegex = /code=(\d{6})[^>]*>([^<]+)<\/a>[\s\S]*?class="[^"]*grpName[^"]*">([^<]+)<\/a>/g;
      while ((match = rowRegex.exec(html)) !== null) {
        sectorMap[match[1]] = match[3].trim();
        found++;
      }

      if (found === 0) break;
      page++;
      if (page > 60) break;
      await new Promise(r => setTimeout(r, 300));
    } catch { break; }
  }
  return sectorMap;
};

// ── 한투 API: 지수 기간별 등락률 ────────────────────────
const fetchIndexChange = async (token, indexCode, months) => {
  try {
    const today = new Date();
    const start = new Date(today);
    start.setMonth(start.getMonth() - months);
    const fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
    const r = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice`
      + `?fid_cond_mrkt_div_code=U&fid_input_iscd=${indexCode}`
      + `&fid_input_date_1=${fmt(start)}&fid_input_date_2=${fmt(today)}&fid_period_div_code=M`,
      { headers: kisH(token, 'FHKUP03500100') }
    );
    const d = await r.json();
    const output = d?.output2 || [];
    if (output.length < 2) return null;
    const latest = parseFloat(output[0]?.bstp_nmix_prpr);
    const oldest = parseFloat(output[output.length-1]?.bstp_nmix_prpr);
    return oldest > 0 ? ((latest - oldest) / oldest) * 100 : null;
  } catch { return null; }
};

// ── 한투 API: 종목 기간별 등락률 ────────────────────────
const fetchStockChange = async (token, code, months) => {
  try {
    const today = new Date();
    const start = new Date(today);
    start.setMonth(start.getMonth() - months);
    const fmtKST = (d) => {
      const kst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      return kst.getFullYear().toString()
        + String(kst.getMonth()+1).padStart(2,'0')
        + String(kst.getDate()).padStart(2,'0');
    };
    const r = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
      + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`
      + `&fid_input_date_1=${fmtKST(start)}&fid_input_date_2=${fmtKST(today)}`
      + `&fid_period_div_code=M&fid_org_adj_prc=0`,
      { headers: kisH(token, 'FHKST03010100') }
    );
    const d = await r.json();
    const output = d?.output2 || [];
    if (output.length < 2) return null;
    const latest = parseFloat(output[0]?.stck_clpr);
    const oldest = parseFloat(output[output.length-1]?.stck_clpr);
    return oldest > 0 ? ((latest - oldest) / oldest) * 100 : null;
  } catch { return null; }
};

// ── 메인 실행 ────────────────────────────────────────────
(async () => {
  console.log('=== 스크리너 크롤링 시작 ===');
  console.log('시작 시각:', new Date().toISOString());

  // 1. 네이버에서 전체 종목 PER/PBR 수집
  console.log('\n[1] 코스피 종목 수집...');
  const kospiStocks = await fetchNaverMarket(0);
  console.log(`코스피: ${kospiStocks.length}개`);

  console.log('\n[2] 코스닥 종목 수집...');
  const kosdaqStocks = await fetchNaverMarket(1);
  console.log(`코스닥: ${kosdaqStocks.length}개`);

  const allStocks = [...kospiStocks, ...kosdaqStocks];
  console.log(`\n전체: ${allStocks.length}개`);

  // 2. 한투 API로 지수 등락률
  console.log('\n[3] 한투 API 토큰 발급...');
  const token = await getToken();
  if (!token) { console.error('토큰 발급 실패'); process.exit(1); }

  const periods = [1, 3, 6, 12];
  const indexChanges = {};
  console.log('[4] 지수 등락률 조회...');
  for (const m of periods) {
    const [kospi, kosdaq] = await Promise.all([
      fetchIndexChange(token, '0001', m),
      fetchIndexChange(token, '1001', m),
    ]);
    indexChanges[m] = { KOSPI: kospi, KOSDAQ: kosdaq };
    console.log(`  ${m}개월: KOSPI=${kospi?.toFixed(2)}%, KOSDAQ=${kosdaq?.toFixed(2)}%`);
  }

  // 3. 종목별 등락률 계산
  console.log(`\n[5] 종목별 등락률 계산 (${allStocks.length}개)...`);
  const stockChanges = {};
  const batchSize = 10;

  for (let i = 0; i < allStocks.length; i += batchSize) {
    const batch = allStocks.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(s => Promise.all(periods.map(m => fetchStockChange(token, s.code, m))))
    );
    batch.forEach((s, idx) => {
      stockChanges[s.code] = {};
      periods.forEach((m, pi) => { stockChanges[s.code][m] = results[idx][pi]; });
    });
    if (i % 100 === 0) console.log(`  진행: ${i}/${allStocks.length}`);
    await new Promise(r => setTimeout(r, 300));
  }

  // 4. 섹터 정보 (네이버 inquire-price의 업종명으로 보완)
  console.log('\n[6] Redis 저장...');
  const screenerData = allStocks.map(s => ({
    code: s.code,
    name: s.name,
    market: s.market,
    sector: s.sector || '기타',
    per: s.per,
    pbr: s.pbr,
    changes: stockChanges[s.code] || {},
  }));

  await redisSet('screener:data', screenerData, 90000);
  await redisSet('screener:index', indexChanges, 90000);
  await redisSet('screener:updated', new Date().toISOString(), 90000);

  console.log(`\n=== 완료: ${screenerData.length}개 종목 저장 ===`);
  console.log('종료 시각:', new Date().toISOString());
})();
