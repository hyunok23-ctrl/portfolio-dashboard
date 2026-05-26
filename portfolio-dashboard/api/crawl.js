// Vercel Cron: 매일 16:30 KST (07:30 UTC) 실행
export default async function handler(req, res) {
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
        await redisSet('kis_access_token', d.access_token, 82800);
        return d.access_token;
      }
    } catch {}
    return null;
  };

  const kisHeaders = (token) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    appkey: APP_KEY,
    appsecret: APP_SECRET,
    custtype: 'P',
  });

  // ── 한투 API: 시가총액 상위 종목 조회 (페이지네이션) ────
  // fid_cond_mrkt_div_code: J=코스피, Q=코스닥
  // 한 번에 30개, fid_input_iscd로 업종코드 지정
  const fetchMarketCapRank = async (token, market, industryCode, fkCtx = '', nkCtx = '') => {
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/market-cap`
        + `?fid_cond_mrkt_div_code=${market}`
        + `&fid_cond_scr_div_code=20174`
        + `&fid_input_iscd=${industryCode}`
        + `&fid_div_cls_code=0`
        + `&fid_blng_cls_code=0`
        + `&fid_trgt_cls_code=0`
        + `&fid_trgt_exls_cls_code=0`
        + `&fid_input_price_1=`
        + `&fid_input_price_2=`
        + `&fid_vol_cnt=`
        + `&fid_input_date_1=`;
      const r = await fetch(url, {
        headers: { ...kisHeaders(token), tr_id: 'FHPST01740000', tr_cont: fkCtx ? 'N' : 'F', fk100: fkCtx, nk100: nkCtx }
      });
      const d = await r.json();
      return {
        items: d?.output || [],
        trCont: r.headers?.get?.('tr_cont') || '',
        fk100: r.headers?.get?.('fk100') || d?.ctx_area_fk100 || '',
        nk100: r.headers?.get?.('nk100') || d?.ctx_area_nk100 || '',
      };
    } catch { return { items: [], trCont: '' }; }
  };

  // ── 한투 API: 업종 코드 목록 ────────────────────────────
  // 코스피: 0001~0026, 코스닥: 1001~1020 (주요 섹터)
  const KOSPI_INDUSTRY_CODES = [
    '0001','0005','0006','0007','0008','0009','0010','0011',
    '0012','0013','0014','0015','0016','0017','0018','0019',
    '0020','0021','0022','0023','0024','0025','0026'
  ];
  const KOSDAQ_INDUSTRY_CODES = [
    '1001','1005','1006','1007','1008','1009','1010','1011',
    '1012','1013','1014','1015','1016','1017','1018','1019','1020'
  ];

  const SECTOR_NAMES = {
    '0001':'종합','0005':'음식료','0006':'섬유의복','0007':'종이목재',
    '0008':'화학','0009':'의약품','0010':'비금속광물','0011':'철강금속',
    '0012':'기계','0013':'전기전자','0014':'의료정밀','0015':'운수장비',
    '0016':'유통','0017':'전기가스','0018':'건설','0019':'운수창고',
    '0020':'통신','0021':'금융','0022':'은행','0023':'증권',
    '0024':'보험','0025':'서비스','0026':'제조',
    '1001':'종합','1005':'IT','1006':'제조','1007':'건설',
    '1008':'유통','1009':'운수창고','1010':'금융','1011':'통신',
    '1012':'서비스','1013':'의료정밀','1014':'에너지화학','1015':'반도체',
    '1016':'IT부품','1017':'디지털콘텐츠','1018':'소프트웨어',
    '1019':'통신서비스','1020':'IT하드웨어',
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
        { headers: { ...kisHeaders(token), tr_id: 'FHKUP03500100' } }
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
      const fmt = (d) => {
        const kst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        return kst.getFullYear().toString()
          + String(kst.getMonth()+1).padStart(2,'0')
          + String(kst.getDate()).padStart(2,'0');
      };
      // 1·3개월은 일봉, 6개월은 주봉, 12개월은 월봉 (짧은 기간 데이터 포인트 부족 방지)
      const periodCode = months <= 3 ? 'D' : months <= 6 ? 'W' : 'M';
      const r = await fetch(
        `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
        + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`
        + `&fid_input_date_1=${fmt(start)}&fid_input_date_2=${fmt(today)}`
        + `&fid_period_div_code=${periodCode}&fid_org_adj_prc=0`,
        { headers: { ...kisHeaders(token), tr_id: 'FHKST03010100' } }
      );
      const d = await r.json();
      const output = (d?.output2 || []).filter(x => parseFloat(x?.stck_clpr) > 0);
      if (output.length < 2) return null;
      const latest = parseFloat(output[0].stck_clpr);
      const oldest = parseFloat(output[output.length-1].stck_clpr);
      return oldest > 0 ? ((latest - oldest) / oldest) * 100 : null;
    } catch { return null; }
  };

  try {
    console.log('크롤링 시작...');
    const token = await getToken();
    if (!token) return res.status(500).json({ error: '토큰 발급 실패' });

    // 1. 업종별 시가총액 상위 종목 수집
    const stockMap = {};
    const allCodes = [
      ...KOSPI_INDUSTRY_CODES.map(c => ({ code: c, market: 'J', mktName: 'KOSPI' })),
      ...KOSDAQ_INDUSTRY_CODES.map(c => ({ code: c, market: 'Q', mktName: 'KOSDAQ' })),
    ];

    for (const { code: indCode, market, mktName } of allCodes) {
      const result = await fetchMarketCapRank(token, market, indCode);
      for (const item of result.items) {
        const code = item.stck_shrn_iscd;
        if (!code || code.length !== 6 || stockMap[code]) continue;
        const per = parseFloat(item.per);
        const pbr = parseFloat(item.pbr);
        if (!per || !pbr || per <= 0 || pbr <= 0) continue;
        stockMap[code] = {
          code,
          name: item.hts_kor_isnm || code,
          market: mktName,
          sector: SECTOR_NAMES[indCode] || '기타',
          per,
          pbr,
        };
      }
      await new Promise(r => setTimeout(r, 150));
    }

    const allStocks = Object.values(stockMap);
    console.log(`수집 완료: ${allStocks.length}개`);

    // 2. 지수 등락률
    const periods = [1, 3, 6, 12];
    const indexChanges = {};
    for (const m of periods) {
      const [kospi, kosdaq] = await Promise.all([
        fetchIndexChange(token, '0001', m),
        fetchIndexChange(token, '1001', m),
      ]);
      indexChanges[m] = { KOSPI: kospi, KOSDAQ: kosdaq };
    }
    console.log('지수 등락률 완료:', indexChanges);

    // 3. 종목별 기간 등락률 계산
    const stockChanges = {};
    const batchSize = 5;
    for (let i = 0; i < allStocks.length; i += batchSize) {
      const batch = allStocks.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(s => Promise.all(periods.map(m => fetchStockChange(token, s.code, m))))
      );
      batch.forEach((s, idx) => {
        stockChanges[s.code] = {};
        periods.forEach((m, pi) => { stockChanges[s.code][m] = results[idx][pi]; });
      });
      if (i % 50 === 0) console.log(`등락률: ${i}/${allStocks.length}`);
      await new Promise(r => setTimeout(r, 300));
    }

    // 4. 최종 데이터 저장
    const screenerData = allStocks.map(s => ({
      ...s,
      changes: stockChanges[s.code] || {},
    }));

    await redisSet('screener:data', screenerData, 90000);
    await redisSet('screener:index', indexChanges, 90000);
    await redisSet('screener:updated', new Date().toISOString(), 90000);

    console.log(`완료: ${screenerData.length}개 저장`);
    return res.status(200).json({
      ok: true,
      total: screenerData.length,
      updated: new Date().toISOString(),
      indexChanges,
    });

  } catch (e) {
    console.error('크롤링 실패:', e);
    return res.status(500).json({ error: e.message });
  }
}
