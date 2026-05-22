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
    } catch (e) { console.error('redisSet error', e); }
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

  // ── KRX OTP 발급 + 데이터 다운로드 ──────────────────────
  const fetchKrxData = async (params) => {
    const KRX_OTP_URL = 'http://data.krx.co.kr/comm/fileDn/GenerateOTP/generate.cmd';
    const KRX_DN_URL  = 'http://data.krx.co.kr/comm/fileDn/download_json/download.cmd';
    const headers = {
      'Referer': 'http://data.krx.co.kr/',
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // OTP 발급
    const otpBody = new URLSearchParams(params).toString();
    const otpRes = await fetch(KRX_OTP_URL, { method: 'POST', headers, body: otpBody });
    const otp = await otpRes.text();
    if (!otp || otp.length < 10) throw new Error('OTP 발급 실패');

    // 데이터 다운로드
    const dnRes = await fetch(KRX_DN_URL, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ code: otp }).toString()
    });
    return await dnRes.json();
  };

  // ── KRX: 오늘 날짜 (YYYYMMDD) ───────────────────────────
  const getTodayKST = () => {
    const now = new Date();
    const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    return kst.getFullYear().toString()
      + String(kst.getMonth() + 1).padStart(2, '0')
      + String(kst.getDate()).padStart(2, '0');
  };

  // ── KRX: PER/PBR/섹터 전체 종목 ─────────────────────────
  const fetchKrxPbrPer = async (market) => {
    // market: 'STK'(코스피) or 'KSQ'(코스닥)
    try {
      const today = getTodayKST();
      const data = await fetchKrxData({
        locale: 'ko_KR',
        trdDd: today,
        mktId: market,
        segTpCd: market === 'KSQ' ? 'ALL' : '',
        adjStkPrc: '2',
        csvxls_isNo: 'false',
        name: 'fileDown',
        url: 'dbms/MDC/STAT/standard/MDCSTAT03501',
      });
      return (data?.OutBlock_1 || []).map(row => ({
        code: row.ISU_SRT_CD,
        name: row.ISU_ABBRV,
        market: market === 'STK' ? 'KOSPI' : 'KOSDAQ',
        per: parseFloat(row.PER) || null,
        pbr: parseFloat(row.PBR) || null,
        eps: parseFloat(row.EPS) || null,
        bps: parseFloat(row.BPS) || null,
      })).filter(s => s.code && s.code.length === 6);
    } catch (e) {
      console.error('KRX PBR/PER 실패', market, e.message);
      return [];
    }
  };

  // ── KRX: 섹터(업종) 정보 ────────────────────────────────
  const fetchKrxSector = async (market) => {
    try {
      const today = getTodayKST();
      const data = await fetchKrxData({
        locale: 'ko_KR',
        trdDd: today,
        mktId: market,
        segTpCd: market === 'KSQ' ? 'ALL' : '',
        csvxls_isNo: 'false',
        name: 'fileDown',
        url: 'dbms/MDC/STAT/standard/MDCSTAT03901',
      });
      const sectorMap = {};
      (data?.OutBlock_1 || []).forEach(row => {
        if (row.ISU_SRT_CD) sectorMap[row.ISU_SRT_CD] = row.IDX_IND_NM || '기타';
      });
      return sectorMap;
    } catch (e) {
      console.error('KRX 섹터 실패', market, e.message);
      return {};
    }
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

  try {
    console.log('크롤링 시작 (KRX)...');

    // 1. KRX에서 전체 종목 PER/PBR + 섹터 수집
    const [kospiData, kosdaqData, kospiSector, kosdaqSector] = await Promise.all([
      fetchKrxPbrPer('STK'),
      fetchKrxPbrPer('KSQ'),
      fetchKrxSector('STK'),
      fetchKrxSector('KSQ'),
    ]);

    const allStocks = [...kospiData, ...kosdaqData].map(s => ({
      ...s,
      sector: (s.market === 'KOSPI' ? kospiSector : kosdaqSector)[s.code] || '기타',
    }));

    console.log(`KRX 종목 수집: ${allStocks.length}개`);

    if (allStocks.length === 0) {
      return res.status(200).json({ ok: false, message: 'KRX 데이터 없음 - 장 마감 후 재시도하세요' });
    }

    // 2. 한투 토큰 + 지수 등락률
    const token = await getToken();
    const periods = [1, 3, 6, 12];
    const indexChanges = {};
    if (token) {
      for (const m of periods) {
        const [kospi, kosdaq] = await Promise.all([
          fetchIndexChange(token, '0001', m),
          fetchIndexChange(token, '1001', m),
        ]);
        indexChanges[m] = { KOSPI: kospi, KOSDAQ: kosdaq };
      }
    }

    // 3. 유효 종목만 등락률 계산 (PER/PBR 있는 것만)
    const validStocks = allStocks.filter(s => s.per > 0 && s.pbr > 0);
    const stockChanges = {};

    if (token && validStocks.length > 0) {
      const batchSize = 5;
      for (let i = 0; i < validStocks.length; i += batchSize) {
        const batch = validStocks.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(s => Promise.all(periods.map(m => fetchStockChange(token, s.code, m))))
        );
        batch.forEach((s, idx) => {
          stockChanges[s.code] = {};
          periods.forEach((m, pi) => { stockChanges[s.code][m] = results[idx][pi]; });
        });
        if (i % 50 === 0) console.log(`등락률 처리중: ${i}/${validStocks.length}`);
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 4. 최종 데이터 합치기
    const screenerData = allStocks
      .filter(s => s.per > 0 && s.pbr > 0)
      .map(s => ({
        code: s.code,
        name: s.name,
        market: s.market,
        sector: s.sector,
        per: s.per,
        pbr: s.pbr,
        changes: stockChanges[s.code] || {},
      }));

    // 5. Redis 저장 (25시간 TTL)
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
