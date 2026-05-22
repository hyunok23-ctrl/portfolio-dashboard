export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { code, type, period = '1M' } = req.query;
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

  const fmt8 = (d) => {
    const kst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    return kst.getFullYear().toString()
      + String(kst.getMonth()+1).padStart(2,'0')
      + String(kst.getDate()).padStart(2,'0');
  };

  // ── 캔들차트 ────────────────────────────────────────────
  if (type === 'candle') {
    try {
      // 1일: 분봉 (inquire-time-itemchartprice)
      if (period === '1D') {
        const now = new Date();
        const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const hh = String(kst.getHours()).padStart(2,'0');
        const mm = String(kst.getMinutes()).padStart(2,'0');
        // 장 마감 후면 153000, 장중이면 현재시각
        const isOpen = kst.getHours() * 60 + kst.getMinutes() >= 9*60 && kst.getHours() * 60 + kst.getMinutes() < 15*60+30;
        const inputHour = isOpen ? `${hh}${mm}00` : '153000';

        const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?fid_etc_cls_code=&fid_cond_mrkt_div_code=J&fid_input_iscd=${code}&fid_input_hour_1=${inputHour}&fid_pw_data_incu_yn=Y`;
        const r = await fetch(url, { headers: { ...baseHeaders, tr_id: 'FHKST03010200' } });
        const d = await r.json();
        const output = (d?.output2 || []).slice().reverse();
        const candles = output.map(item => {
          const h = item.stck_cntg_hour || '';
          return {
            label: h.slice(0,2) + ':' + h.slice(2,4),
            open:  parseInt(item.stck_oprc) || 0,
            high:  parseInt(item.stck_hgpr) || 0,
            low:   parseInt(item.stck_lwpr) || 0,
            close: parseInt(item.stck_prpr) || 0,
            volume: parseInt(item.cntg_vol) || 0,
          };
        }).filter(c => c.close > 0);
        return res.status(200).json({ candles });
      }

      // 일봉/주봉/월봉 (inquire-daily-itemchartprice)
      const today = new Date();
      let startDate = new Date(today);
      let periodDivCode;

      if (period === '1W') {
        periodDivCode = 'W';
        startDate.setMonth(startDate.getMonth() - 6);
      } else if (period === '1M') {
        periodDivCode = 'D';
        startDate.setMonth(startDate.getMonth() - 1);
      } else if (period === '1Y') {
        periodDivCode = 'M';
        startDate.setFullYear(startDate.getFullYear() - 1);
      }

      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
        + `?fid_cond_mrkt_div_code=J`
        + `&fid_input_iscd=${code}`
        + `&fid_input_date_1=${fmt8(startDate)}`
        + `&fid_input_date_2=${fmt8(today)}`
        + `&fid_period_div_code=${periodDivCode}`
        + `&fid_org_adj_prc=0`;

      const r = await fetch(url, { headers: { ...baseHeaders, tr_id: 'FHKST03010100' } });
      const d = await r.json();
      const output = (d?.output2 || []).slice().reverse();

      const candles = output.map(item => {
        const dt = item.stck_bsop_date || '';
        const label = period === '1Y'
          ? dt.slice(0,4) + '/' + dt.slice(4,6)
          : dt.slice(4,6) + '/' + dt.slice(6,8);
        return {
          label,
          open:  parseInt(item.stck_oprc) || 0,
          high:  parseInt(item.stck_hgpr) || 0,
          low:   parseInt(item.stck_lwpr) || 0,
          close: parseInt(item.stck_clpr) || 0,
          volume: parseInt(item.acml_vol) || 0,
        };
      }).filter(c => c.close > 0);

      return res.status(200).json({ candles });

    } catch (e) {
      return res.status(500).json({ error: 'candle failed', detail: e.message });
    }
  }

  // ── 투자자 동향 ──────────────────────────────────────────
  if (type === 'investor') {
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor`
        + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`;
      const r = await fetch(url, { headers: { ...baseHeaders, tr_id: 'FHKST01010900' } });
      const d = await r.json();
      const o = Array.isArray(d?.output) ? d.output : [];
      const rows = o.slice(0, 5).map(item => ({
        label: (item.stck_bsop_date || '').slice(4,6) + '/' + (item.stck_bsop_date || '').slice(6,8),
        individual:  parseInt(item.prsn_ntby_qty) || 0,
        foreign:     parseInt(item.frgn_ntby_qty) || 0,
        institution: parseInt(item.orgn_ntby_qty) || 0,
      }));
      return res.status(200).json({ investor: rows });
    } catch (e) {
      return res.status(500).json({ error: 'investor failed', detail: e.message });
    }
  }

  return res.status(400).json({ error: 'invalid type' });
}
