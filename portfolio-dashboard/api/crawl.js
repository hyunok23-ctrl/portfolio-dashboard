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

  // ── 한투 업종코드 → 섹터명 매핑 ────────────────────────
  const SECTOR_MAP = {
    '0001':'종합(KOSPI)', '0002':'대형주', '0003':'중형주', '0004':'소형주',
    '0005':'음식료', '0006':'섬유의복', '0007':'종이목재', '0008':'화학',
    '0009':'의약품', '0010':'비금속광물', '0011':'철강금속', '0012':'기계',
    '0013':'전기전자', '0014':'의료정밀', '0015':'운수장비', '0016':'유통',
    '0017':'전기가스', '0018':'건설', '0019':'운수창고', '0020':'통신',
    '0021':'금융', '0022':'은행', '0023':'증권', '0024':'보험',
    '0025':'서비스', '0026':'제조',
    '1001':'종합(KOSDAQ)', '1002':'대형주', '1003':'중형주', '1004':'소형주',
    '1005':'IT', '1006':'제조', '1007':'건설', '1008':'유통',
    '1009':'운수창고', '1010':'금융', '1011':'통신', '1012':'서비스',
    '1013':'의료정밀', '1014':'에너지화학', '1015':'반도체', '1016':'IT부품',
    '1017':'디지털콘텐츠', '1018':'소프트웨어', '1019':'통신서비스', '1020':'IT하드웨어',
  };

  // 코스피 업종 코드 목록 (주요 섹터)
  const KOSPI_SECTORS = ['0005','0006','0007','0008','0009','0010','0011','0012',
    '0013','0014','0015','0016','0017','0018','0019','0020','0021','0025'];
  // 코스닥 업종 코드 목록
  const KOSDAQ_SECTORS = ['1005','1006','1007','1008','1009','1010','1011','1012',
    '1013','1014','1015','1016','1017','1018','1019','1020'];

  // ── 한투 API: 업종별 종목 목록 조회 ──────────────────────
  const fetchStocksByIndustry = async (token, industryCode, market) => {
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-member`
        + `?fid_input_iscd=${industryCode}`;
      // 업종별 시세 API 사용
      const r = await fetch(
        `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/market-cap`
        + `?fid_cond_mrkt_div_code=${market === 'KOSPI' ? 'J' : 'Q'}`
        + `&fid_cond_scr_div_code=20174`
        + `&fid_input_iscd=${industryCode}`
        + `&fid_div_cls_code=0`
        + `&fid_blng_cls_code=0`
        + `&fid_trgt_cls_code=0`
        + `&fid_trgt_exls_cls_code=0`
        + `&fid_input_price_1=&fid_input_price_2=`
        + `&fid_vol_cnt=&fid_input_date_1=`,
        {
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            appkey: APP_KEY, appsecret: APP_SECRET,
            tr_id: 'FHPST01740000',
            custtype: 'P',
          }
        }
      );
      const d = await r.json();
      return (d?.output || []).map(o => ({
        code: o.stck_shrn_iscd,
        name: o.hts_kor_isnm,
        market,
        sector: SECTOR_MAP[industryCode] || '기타',
        per: parseFloat(o.per) || null,
        pbr: parseFloat(o.pbr) || null,
      })).filter(s => s.code && s.code.length === 6);
    } catch { return []; }
  };

  // ── 한투 API: 종목 PER/PBR 조회 ────────────────────────
  const fetchStockFundamental = async (token, code) => {
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price`
        + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`;
      const r = await fetch(url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: APP_KEY, appsecret: APP_SECRET,
          tr_id: 'FHKST01010100',
        }
      });
      const d = await r.json();
      const o = d?.output;
      if (!o) return null;
      return {
        per: parseFloat(o.per) || null,
        pbr: parseFloat(o.pbr) || null,
        name: o.hts_kor_isnm || null,
        sector: o.bstp_kor_isnm || null, // 업종명
      };
    } catch { return null; }
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
          tr_id: 'FHKUP03500100',
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
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
        + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`
        + `&fid_input_date_1=${fmt(start)}&fid_input_date_2=${fmt(today)}`
        + `&fid_period_div_code=M&fid_org_adj_prc=0`;
      const r = await fetch(url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: APP_KEY, appsecret: APP_SECRET,
          tr_id: 'FHKST03010100',
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
    console.log('크롤링 시작 (한투 API)...');
    const token = await getToken();
    if (!token) return res.status(500).json({ error: '토큰 발급 실패' });

    // 1. 업종별 종목 목록 수집
    const allStocksMap = {};

    for (const sectorCode of [...KOSPI_SECTORS, ...KOSDAQ_SECTORS]) {
      const market = KOSPI_SECTORS.includes(sectorCode) ? 'KOSPI' : 'KOSDAQ';
      const stocks = await fetchStocksByIndustry(token, sectorCode, market);
      stocks.forEach(s => {
        if (s.code && !allStocksMap[s.code]) {
          allStocksMap[s.code] = s;
        }
      });
      await new Promise(r => setTimeout(r, 100));
    }

    let allStocks = Object.values(allStocksMap);
    console.log(`업종별 수집: ${allStocks.length}개`);

    // PER/PBR 없는 종목 보완 (inquire-price로 개별 조회)
    const missingFund = allStocks.filter(s => !s.per || !s.pbr);
    const batchSize = 10;
    for (let i = 0; i < missingFund.length; i += batchSize) {
      const batch = missingFund.slice(i, i + batchSize);
      await Promise.all(batch.map(async (s) => {
        const f = await fetchStockFundamental(token, s.code);
        if (f) {
          s.per = f.per;
          s.pbr = f.pbr;
          if (f.name && !s.name) s.name = f.name;
          if (f.sector && s.sector === '기타') s.sector = f.sector;
        }
      }));
      await new Promise(r => setTimeout(r, 200));
    }

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

    // 3. 유효 종목 등락률 계산
    const validStocks = allStocks.filter(s => s.per > 0 && s.pbr > 0 && s.code);
    const stockChanges = {};

    for (let i = 0; i < validStocks.length; i += batchSize) {
      const batch = validStocks.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(s => Promise.all(periods.map(m => fetchStockChange(token, s.code, m))))
      );
      batch.forEach((s, idx) => {
        stockChanges[s.code] = {};
        periods.forEach((m, pi) => { stockChanges[s.code][m] = results[idx][pi]; });
      });
      if (i % 100 === 0) console.log(`등락률: ${i}/${validStocks.length}`);
      await new Promise(r => setTimeout(r, 300));
    }

    // 4. 최종 저장
    const screenerData = validStocks.map(s => ({
      code: s.code,
      name: s.name || s.code,
      market: s.market,
      sector: s.sector || '기타',
      per: s.per,
      pbr: s.pbr,
      changes: stockChanges[s.code] || {},
    }));

    await redisSet('screener:data', screenerData, 90000);
    await redisSet('screener:index', indexChanges, 90000);
    await redisSet('screener:updated', new Date().toISOString(), 90000);

    console.log(`완료: ${screenerData.length}개 종목 저장`);
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
