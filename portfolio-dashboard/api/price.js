export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { codes } = req.query;
  if (!codes) return res.status(400).json({ error: 'no codes' });
  const codeList = codes.split(',').map(c => c.trim()).filter(Boolean);
  const results = {};

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

  const redisSet = async (key, value, exSeconds) => {
    if (!REDIS_URL || !REDIS_TOKEN) return;
    try {
      await fetch(`${REDIS_URL}/set/${key}/${encodeURIComponent(value)}${exSeconds ? `/ex/${exSeconds}` : ''}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
    } catch {}
  };

  // ── 한투 액세스 토큰 발급 (Redis 캐싱) ──────────────────
  const getKisToken = async () => {
    if (!APP_KEY || !APP_SECRET) return null;
    const cached = await redisGet('kis_access_token');
    if (cached) return cached;

    try {
      const r = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: APP_KEY,
          appsecret: APP_SECRET
        })
      });
      const d = await r.json();
      if (d?.access_token) {
        // 23시간 캐싱 (토큰 유효기간 24시간)
        await redisSet('kis_access_token', d.access_token, 82800);
        return d.access_token;
      }
    } catch {}
    return null;
  };

  // ── 종목명 조회 (Redis 캐싱 + 네이버 크롤링) ─────────────
  const getStockName = async (code) => {
    // Redis에서 먼저 확인
    const cached = await redisGet(`sname:${code}`);
    if (cached) return cached;

    // 네이버 금융에서 크롤링
    try {
      const r = await fetch(`https://finance.naver.com/item/main.naver?code=${code}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const html = await r.text();
      const match = html.match(/<title>([^(]+)\(${code}\)/);
      if (match) {
        const name = match[1].trim();
        // Redis에 30일 캐싱
        await redisSet(`sname:${code}`, name, 2592000);
        return name;
      }
    } catch {}
    return code;
  };
  const fetchKisPrice = async (code, token) => {
    if (!token) return null;
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`;
      const r = await fetch(url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: APP_KEY,
          appsecret: APP_SECRET,
          tr_id: 'FHKST01010100'
        }
      });
      const d = await r.json();
      const o = d?.output;
      if (!o || !o.stck_prpr) return null;

      const price       = parseInt(o.stck_prpr, 10);
      const changePrice = parseInt(o.prdy_vrss, 10) || 0;
      const change      = parseFloat(o.prdy_ctrt) || 0;

      // 종목명: API에서 못 받으면 네이버 크롤링 캐시 사용
      const rawName = o.hts_kor_isnm || o.prdt_abrv_name || o.itmt_name || '';
      const name = (rawName && rawName.trim() && !/^\d+$/.test(rawName.trim()))
        ? rawName.trim()
        : await getStockName(code);

      return { code, name, price, change, changePrice };
    } catch { return null; }
  };

  // ── Yahoo Finance 폴백 ───────────────────────────────────
  const fetchYahoo = async (sym) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const m = d?.chart?.result?.[0]?.meta;
    return m?.regularMarketPrice ? m : null;
  };

  const fetchYahooBest = async (code) => {
    const res2 = {};
    await Promise.all(['.KS', '.KQ'].map(async (s) => {
      try {
        const m = await fetchYahoo(code + s);
        if (m) res2[s] = m;
      } catch {}
    }));
    for (const s of ['.KS', '.KQ']) {
      const m = res2[s];
      if (!m) continue;
      const exch = (m.exchangeName || m.fullExchangeName || '').toUpperCase();
      if (s === '.KS' && (exch.includes('KSE') || exch.includes('KOSPI') || exch.includes('KSC'))) return m;
      if (s === '.KQ' && (exch.includes('KOE') || exch.includes('KOSDAQ') || exch.includes('KOQ'))) return m;
    }
    const ks = res2['.KS'], kq = res2['.KQ'];
    if (ks && kq) {
      const kqExch = (kq.exchangeName || '').toUpperCase();
      const ksExch = (ks.exchangeName || '').toUpperCase();
      if (kqExch.includes('KOE') || kqExch.includes('KOQ')) return kq;
      if (ksExch.includes('KSE') || ksExch.includes('KSC')) return ks;
      return ks;
    }
    return ks || kq || null;
  };

  // ── 메인 처리 ────────────────────────────────────────────
  const token = await getKisToken();

  await Promise.all(codeList.map(async (code) => {
    try {
      // 1) 한투 API 시도
      const kisResult = await fetchKisPrice(code, token);
      if (kisResult) {
        results[code] = kisResult;
        return;
      }

      // 2) 한투 실패 시 Yahoo Finance 폴백
      const m = await fetchYahooBest(code);
      if (!m) {
        results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
        return;
      }
      const price = Math.round(m.regularMarketPrice);
      const prev  = Math.round(m.chartPreviousClose || m.previousClose || price);
      const cp    = price - prev;
      const ch    = prev > 0 ? parseFloat(((cp / prev) * 100).toFixed(2)) : 0;
      const raw   = (m.longName || m.shortName || '').split(',')[0].replace(/\.(KS|KQ)$/i, '').trim();
      const name  = (raw && !/^\d+$/.test(raw)) ? raw : code;
      results[code] = { code, name, price, change: ch, changePrice: cp, source: 'yahoo' };

    } catch (e) {
      results[code] = { code, name: code, price: 0, change: 0, changePrice: 0, error: true };
    }
  }));

  return res.status(200).json(results);
}
