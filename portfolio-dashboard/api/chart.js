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
      // 1일: 분봉 (inquire-time-itemchartprice는 한 번에 ~30개만 반환 → 페이지네이션)
      if (period === '1D') {
        const now = new Date();
        const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const totalMin = kst.getHours() * 60 + kst.getMinutes();
        const isOpen = totalMin >= 9*60 && totalMin < 15*60+30;
        // 시작 시각: 장중이면 현재, 그 외엔 직전 마감(15:30)
        const startHour = isOpen ? kst.getHours() : 15;
        const startMin  = isOpen ? kst.getMinutes() : 30;

        const fetchMinuteBatch = async (hourStr) => {
          const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`
            + `?fid_etc_cls_code=&fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`
            + `&fid_input_hour_1=${hourStr}&fid_pw_data_incu_yn=Y`;
          const r = await fetch(url, { headers: { ...baseHeaders, tr_id: 'FHKST03010200' } });
          const d = await r.json();
          return d?.output2 || [];
        };

        // 15:30 → 09:00 까지 30분씩 거슬러 올라가며 호출
        const seen = new Set();
        const bars = [];
        let curMin = startHour * 60 + startMin;
        const minBoundary = 9 * 60; // 09:00
        for (let i = 0; i < 16 && curMin >= minBoundary; i++) {
          const h = Math.floor(curMin / 60);
          const m = curMin % 60;
          const hourStr = String(h).padStart(2,'0') + String(m).padStart(2,'0') + '00';
          const batch = await fetchMinuteBatch(hourStr);
          if (batch.length === 0) break;

          let earliestBarMin = Infinity;
          for (const item of batch) {
            const t = item.stck_cntg_hour || '';
            if (!t || seen.has(t)) continue;
            const close = parseInt(item.stck_prpr) || 0;
            if (close <= 0) continue;
            seen.add(t);
            bars.push({
              t,
              label: t.slice(0,2) + ':' + t.slice(2,4),
              open:  parseInt(item.stck_oprc) || close,
              high:  parseInt(item.stck_hgpr) || close,
              low:   parseInt(item.stck_lwpr) || close,
              close,
              volume: parseInt(item.cntg_vol) || 0,
            });
            const bh = parseInt(t.slice(0,2));
            const bm = parseInt(t.slice(2,4));
            const bmin = bh * 60 + bm;
            if (bmin < earliestBarMin) earliestBarMin = bmin;
          }

          if (!isFinite(earliestBarMin)) break;
          // 다음 호출은 이번 배치의 가장 이른 시각 직전(-1분)으로
          const nextMin = earliestBarMin - 1;
          if (nextMin <= curMin - 1) {
            curMin = nextMin;
          } else {
            // 진전이 없으면 강제로 30분 뒤로
            curMin = curMin - 30;
          }
        }

        bars.sort((a, b) => a.t.localeCompare(b.t));
        const candles = bars.map(({ t, ...rest }) => rest);
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
      const now = new Date();
      const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      const totalMin = kst.getHours() * 60 + kst.getMinutes();
      const day = kst.getDay();
      const isMarketOpen = day >= 1 && day <= 5 && totalMin >= 9 * 60 && totalMin < 15 * 60 + 30;

      let todayRow = null;

      // 장중: 추정 가집계 API (하루 4번 업데이트: 09:30 / 11:20 / 13:20 / 14:30)
      if (isMarketOpen) {
        try {
          const estUrl = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/foreign-institution-total`
            + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}&fid_rank_sort_cls_code=0&fid_etc_cls_code=0`;
          const estR = await fetch(estUrl, { headers: { ...baseHeaders, tr_id: 'FHPTJ04400000' } });
          const estD = await estR.json();
          const o = estD?.output1;
          if (o) {
            // 당일 추정치 (주식 수량)
            const foreign = parseInt(o.frgn_ntby_qty) || 0;
            const institution = parseInt(o.orgn_ntby_qty) || 0;
            const individual = -(foreign + institution); // 개인 = -(외국인+기관) 추정
            const mm = String(kst.getMonth() + 1).padStart(2, '0');
            const dd = String(kst.getDate()).padStart(2, '0');
            todayRow = {
              label: `${mm}/${dd}`,
              individual,
              foreign,
              institution,
              isEstimate: true, // 추정치 표시용
            };
          }
        } catch {}
      }

      // 전일 이전 확정 데이터 (최근 5일)
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor`
        + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`;
      const r = await fetch(url, { headers: { ...baseHeaders, tr_id: 'FHKST01010900' } });
      const d = await r.json();
      const o = Array.isArray(d?.output) ? d.output : [];

      // 당일 row 제거 (0으로 나오는 것 제거)
      const todayStr = fmt8(kst);
      const filtered = o.filter(item => item.stck_bsop_date !== todayStr);
      const rows = filtered.slice(0, 5).map(item => ({
        label: (item.stck_bsop_date || '').slice(4,6) + '/' + (item.stck_bsop_date || '').slice(6,8),
        individual:  parseInt(item.prsn_ntby_qty) || 0,
        foreign:     parseInt(item.frgn_ntby_qty) || 0,
        institution: parseInt(item.orgn_ntby_qty) || 0,
        isEstimate: false,
      }));

      // 당일 추정치를 맨 앞에 붙이기
      const result = todayRow ? [todayRow, ...rows] : rows;
      return res.status(200).json({ investor: result });

    } catch (e) {
      return res.status(500).json({ error: 'investor failed', detail: e.message });
    }
  }

  return res.status(400).json({ error: 'invalid type' });
}
