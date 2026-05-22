export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { code, type } = req.query;
  // type: 'candle' | 'investor'
  // period: '1D' | '1W' | '1M' | '1Y' (캔들용)
  const { period = '1M' } = req.query;

  if (!code || !type) return res.status(400).json({ error: 'missing params' });

  const APP_KEY    = process.env.KIS_APP_KEY;
  const APP_SECRET = process.env.KIS_APP_SECRET;
  const REDIS_URL  = process.env.KV_REST_API_URL || process.env.REDIS_URL;
  const REDIS_TOKEN= process.env.KV_REST_API_TOKEN;

  // ── Redis 헬퍼 ──────────────────────────────────────────
  const redisGet = async (key) => {
    if (!REDIS_URL || !REDIS_TOKEN) return null;
    try {
      const r = await fetch(`${REDIS_URL}/get/${key}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const d = await r.json();
      return d?.result ?? null;
    } catch { return null; }
  };

  // ── 액세스 토큰 가져오기 (캐싱) ─────────────────────────
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

  const token = await getToken();
  if (!token) return res.status(500).json({ error: 'token failed' });

  const baseHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    appkey: APP_KEY,
    appsecret: APP_SECRET,
  };

  // ── 캔들차트 데이터 ──────────────────────────────────────
  if (type === 'candle') {
    try {
      // 기간별 설정
      const today = new Date();
      const fmt8 = (d) => d.toISOString().slice(0,10).replace(/-/g,'');

      let startDate;
      let trId;
      let periodDivCode;

      if (period === '1D') {
        // 1일: 분봉 (30분)
        trId = 'FHKST03010200';
        const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?fid_etc_cls_code=&fid_cond_mrkt_div_code=J&fid_input_iscd=${code}&fid_input_hour_1=153000&fid_pw_data_incu_yn=Y`;
        const r = await fetch(url, { headers: { ...baseHeaders, tr_id: trId } });
        const d = await r.json();
        const output = d?.output2 || [];
        const candles = output.slice(0, 48).reverse().map(item => ({
          time: item.stck_bsop_date + item.stck_cntg_hour,
          label: item.stck_cntg_hour?.slice(0,2) + ':' + item.stck_cntg_hour?.slice(2,4),
          open:  parseInt(item.stck_oprc),
          high:  parseInt(item.stck_hgpr),
          low:   parseInt(item.stck_lwpr),
          close: parseInt(item.stck_prpr),
          volume: parseInt(item.cntg_vol),
        })).filter(c => c.close > 0);
        return res.status(200).json({ candles });
      }

      // 일봉/주봉/월봉
      trId = 'FHKST03010100';
      if (period === '1W') { periodDivCode = 'W'; startDate = new Date(today); startDate.setMonth(startDate.getMonth() - 3); }
      else if (period === '1M') { periodDivCode = 'D'; startDate = new Date(today); startDate.setMonth(startDate.getMonth() - 1); }
      else if (period === '1Y') { periodDivCode = 'M'; startDate = new Date(today); startDate.setFullYear(startDate.getFullYear() - 1); }

      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}&fid_input_date_1=${fmt8(startDate)}&fid_input_date_2=${fmt8(today)}&fid_period_div_code=${periodDivCode}&fid_org_adj_prc=0`;
      const r = await fetch(url, { headers: { ...baseHeaders, tr_id: trId } });
      const d = await r.json();
      const output = d?.output2 || [];
      const candles = output.reverse().map(item => ({
        time: item.stck_bsop_date,
        label: period === '1Y'
          ? item.stck_bsop_date?.slice(0,6)
          : item.stck_bsop_date?.slice(4,6) + '/' + item.stck_bsop_date?.slice(6,8),
        open:  parseInt(item.stck_oprc),
        high:  parseInt(item.stck_hgpr),
        low:   parseInt(item.stck_lwpr),
        close: parseInt(item.stck_clpr),
        volume: parseInt(item.acml_vol),
      })).filter(c => c.close > 0);
      return res.status(200).json({ candles });

    } catch (e) {
      return res.status(500).json({ error: 'candle fetch failed', detail: e.message });
    }
  }

  // ── 투자자 동향 ──────────────────────────────────────────
  if (type === 'investor') {
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`;
      const r = await fetch(url, { headers: { ...baseHeaders, tr_id: 'FHKST01010900' } });
      const d = await r.json();
      const o = d?.output || [];

      // 최근 5일치 반환
      const rows = o.slice(0, 5).map(item => ({
        date:     item.stck_bsop_date,
        label:    item.stck_bsop_date?.slice(4,6) + '/' + item.stck_bsop_date?.slice(6,8),
        individual: parseInt(item.prsn_ntby_qty) || 0,   // 개인 순매수
        foreign:    parseInt(item.frgn_ntby_qty) || 0,   // 외국인 순매수
        institution:parseInt(item.orgn_ntby_qty) || 0,   // 기관 순매수
      }));
      return res.status(200).json({ investor: rows });

    } catch (e) {
      return res.status(500).json({ error: 'investor fetch failed', detail: e.message });
    }
  }

  return res.status(400).json({ error: 'invalid type' });
}
