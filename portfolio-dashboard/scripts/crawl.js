// GitHub Actions 크롤링 스크립트 - cheerio 사용
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const REDIS_URL   = process.env.REDIS_URL;
const REDIS_TOKEN = process.env.REDIS_TOKEN;
const APP_KEY     = process.env.KIS_APP_KEY;
const APP_SECRET  = process.env.KIS_APP_SECRET;

const redisSet = async (key, value, exSeconds) => {
  await fetch(
    `${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}${exSeconds ? `/ex/${exSeconds}` : ''}`,
    { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
  );
};

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

// Naver는 EUC-KR로 응답 — 직접 디코딩 필요
const eucKrDecoder = new TextDecoder('euc-kr');
const fetchEucKr = async (url) => {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://finance.naver.com/sise/',
    }
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return eucKrDecoder.decode(buf);
};

// 시가총액 페이지 컬럼: 0=N, 1=종목명, 2=현재가, 3=전일비, 4=등락률,
// 5=액면가, 6=시가총액, 7=상장주식수, 8=외국인비율, 9=거래량, 10=PER, 11=ROE
// (PBR은 이 페이지에 없음 → 모바일 API에서 별도 수집)
const fetchNaverMarket = async (sosok) => {
  const stocks = [];
  let page = 1;
  while (true) {
    try {
      const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`;
      const html = await fetchEucKr(url);
      const $ = cheerio.load(html);
      let found = 0;
      $('table.type_2 tbody tr').each((i, el) => {
        const tds = $(el).find('td');
        if (tds.length < 11) return;
        const nameEl = $(tds[1]).find('a');
        const name = nameEl.text().trim();
        const href = nameEl.attr('href') || '';
        const codeMatch = href.match(/code=(\d{6})/);
        if (!codeMatch || !name) return;
        const code = codeMatch[1];
        const per = parseFloat($(tds[10]).text().replace(/,/g, '').trim());
        if (code && name && per > 0) {
          stocks.push({ code, name, market: sosok === 0 ? 'KOSPI' : 'KOSDAQ', sector: '기타', per, pbr: null });
          found++;
        }
      });
      console.log(`  페이지 ${page}: ${found}개 (누적 ${stocks.length}개)`);
      if (found === 0) break;
      page++;
      if (page > 60) break;
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.error(`  페이지 ${page} 실패:`, e.message);
      break;
    }
  }
  return stocks;
};

// 네이버 모바일 API에서 PBR 단건 조회 (totalInfos 배열에서 code=='pbr' 추출)
const fetchPbr = async (code) => {
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Mobile',
        'Accept': 'application/json',
      }
    });
    if (!r.ok) return null;
    const d = await r.json();
    const it = (d?.totalInfos || []).find(x => x?.code === 'pbr');
    if (!it?.value) return null;
    const v = parseFloat(String(it.value).replace(/[^\d.\-]/g, ''));
    return v > 0 && Number.isFinite(v) ? v : null;
  } catch { return null; }
};

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
    // 짧은 기간(1·3개월)에 월봉을 쓰면 데이터 포인트가 부족함 → 1·3 일봉, 6 주봉, 12 월봉
    const periodCode = months <= 3 ? 'D' : months <= 6 ? 'W' : 'M';
    const r = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
      + `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`
      + `&fid_input_date_1=${fmtKST(start)}&fid_input_date_2=${fmtKST(today)}`
      + `&fid_period_div_code=${periodCode}&fid_org_adj_prc=0`,
      { headers: kisH(token, 'FHKST03010100') }
    );
    const d = await r.json();
    const output = (d?.output2 || []).filter(x => parseFloat(x?.stck_clpr) > 0);
    if (output.length < 2) return null;
    const latest = parseFloat(output[0].stck_clpr);
    const oldest = parseFloat(output[output.length-1].stck_clpr);
    return oldest > 0 ? ((latest - oldest) / oldest) * 100 : null;
  } catch { return null; }
};

(async () => {
  console.log('=== 크롤링 시작 ===', new Date().toISOString());
  console.log('\n[1] 코스피 수집...');
  const kospi = await fetchNaverMarket(0);
  console.log(`코스피: ${kospi.length}개`);
  console.log('\n[2] 코스닥 수집...');
  const kosdaq = await fetchNaverMarket(1);
  console.log(`코스닥: ${kosdaq.length}개`);
  const all = [...kospi, ...kosdaq];
  console.log(`전체: ${all.length}개`);
  if (all.length === 0) { console.error('수집 실패!'); process.exit(1); }
  console.log('\n[3] 한투 토큰...');
  const token = await getToken();
  if (!token) { console.error('토큰 실패'); process.exit(1); }
  const periods = [1, 3, 6, 12];
  const indexChanges = {};
  console.log('[4] 지수 등락률...');
  for (const m of periods) {
    const [k, q] = await Promise.all([fetchIndexChange(token, '0001', m), fetchIndexChange(token, '1001', m)]);
    indexChanges[m] = { KOSPI: k, KOSDAQ: q };
    console.log(`  ${m}개월: KOSPI=${k?.toFixed(2)}%, KOSDAQ=${q?.toFixed(2)}%`);
  }
  console.log(`\n[5] 종목 등락률 (${all.length}개)...`);
  const changes = {};
  for (let i = 0; i < all.length; i += 10) {
    const batch = all.slice(i, i + 10);
    const results = await Promise.all(batch.map(s => Promise.all(periods.map(m => fetchStockChange(token, s.code, m)))));
    batch.forEach((s, idx) => {
      changes[s.code] = {};
      periods.forEach((m, pi) => { changes[s.code][m] = results[idx][pi]; });
    });
    if (i % 100 === 0) console.log(`  ${i}/${all.length}`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n[5b] PBR 수집 (네이버 모바일 API, ${all.length}개)...`);
  const pbrs = {};
  let pbrOk = 0;
  for (let i = 0; i < all.length; i += 20) {
    const batch = all.slice(i, i + 20);
    const results = await Promise.all(batch.map(s => fetchPbr(s.code)));
    batch.forEach((s, idx) => {
      pbrs[s.code] = results[idx];
      if (results[idx] != null) pbrOk++;
    });
    if (i % 200 === 0) console.log(`  ${i}/${all.length} (PBR 확보: ${pbrOk})`);
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`  PBR 확보 완료: ${pbrOk}/${all.length}`);

  console.log('\n[6] Redis 저장...');
  const data = all.map(s => ({ ...s, pbr: pbrs[s.code] ?? null, changes: changes[s.code] || {} }));
  await redisSet('screener:data', data, 90000);
  await redisSet('screener:index', indexChanges, 90000);
  await redisSet('screener:updated', new Date().toISOString(), 90000);
  console.log(`\n=== 완료: ${data.length}개 저장 ===`);
})();
