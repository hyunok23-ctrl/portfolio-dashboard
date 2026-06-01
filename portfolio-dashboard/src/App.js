/* eslint-disable */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid
} from 'recharts';
import './App.css';

// ─── 상수 ──────────────────────────────────────────────
const STORAGE_KEY = 'portfolio_holdings_v2';
const REFRESH_INTERVAL = 30 * 1000; // 30초

const COLORS = [
  '#00d4aa', '#4fc3f7', '#ff8a65', '#ce93d8',
  '#fff176', '#80cbc4', '#f48fb1', '#a5d6a7',
  '#ffcc02', '#90caf9',
];

const isMarketOpen = () => {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = kst.getDay();
  const hour = kst.getHours();
  const min = kst.getMinutes();
  const totalMin = hour * 60 + min;
  if (day === 0 || day === 6) return false;
  return totalMin >= 9 * 60 && totalMin < 15 * 60 + 30;
};

// ─── 유틸 ──────────────────────────────────────────────
const fmt = (n) => Math.round(n).toLocaleString('ko-KR');
const fmtRate = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');

const getAccountType = (name) => {
  if (name.includes('(ISA)')) return 'ISA계좌';
  if (name.includes('(연금)')) return '연금계좌';
  return '종합계좌';
};

const ACCOUNT_ORDER = ['종합계좌', '연금계좌', 'ISA계좌'];

// ─── 컴포넌트: 종목 추가 모달 ──────────────────────────
function AddStockModal({ onAdd, onClose }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [qty, setQty] = useState('');
  const [avgPrice, setAvgPrice] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const debounceRef = useRef(null);

  const search = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`/api/search?query=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch {
      setResults([]);
    }
    setSearching(false);
  }, []);

  useEffect(() => {
    if (selected) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(name), 350);
    return () => clearTimeout(debounceRef.current);
  }, [name, search, selected]);

  const handleSubmit = () => {
    const finalCode = selected ? selected.code : code.trim();
    const finalName = selected ? selected.name : name.trim();
    if (!finalCode || !finalName || !qty || !avgPrice) return;
    onAdd({
      id: Date.now().toString(),
      code: finalCode,
      name: finalName,
      qty: parseInt(qty),
      avgPrice: parseInt(avgPrice.replace(/,/g, '')),
    });
    onClose();
  };

  const canSubmit = selected
    ? (qty && avgPrice)
    : (name.trim() && code.trim() && qty && avgPrice);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>종목 추가</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="input-group">
            <label>종목명 검색 (자동완성) 또는 직접 입력</label>
            <input
              autoFocus
              placeholder="예: 삼성전자, 현대차, KODEX 200"
              value={name}
              onChange={e => { setName(e.target.value); setSelected(null); setCode(''); }}
            />
          </div>

          {searching && <div className="search-status">검색 중...</div>}

          {results.length > 0 && !selected && (
            <div className="search-results">
              {results.map(r => (
                <div
                  key={r.code}
                  className="search-item"
                  onClick={() => { setSelected(r); setName(r.name); setCode(r.code); setResults([]); }}
                >
                  <span className="search-name">{r.name}</span>
                  <span className="search-code">{r.code}</span>
                </div>
              ))}
            </div>
          )}

          {selected ? (
            <div className="selected-badge">✓ {selected.name} ({selected.code})</div>
          ) : (
            <div className="input-group">
              <label>종목 코드 (검색 안 될 때 직접 입력)</label>
              <input
                placeholder="예: 005930 (삼성전자), 005380 (현대차)"
                value={code}
                onChange={e => setCode(e.target.value)}
              />
            </div>
          )}

          <div className="input-row">
            <div className="input-group">
              <label>보유 수량</label>
              <input
                type="number"
                placeholder="수량"
                value={qty}
                onChange={e => setQty(e.target.value)}
                min="1"
              />
            </div>
            <div className="input-group">
              <label>평균 매입가 (원)</label>
              <input
                type="number"
                placeholder="매입 단가"
                value={avgPrice}
                onChange={e => setAvgPrice(e.target.value)}
                min="1"
              />
            </div>
          </div>

          {canSubmit && (
            <div className="preview">
              <span>투자 원금</span>
              <span className="preview-value">{fmt(parseInt(qty || 0) * parseInt(avgPrice || 0))}원</span>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>취소</button>
          <button
            className="btn-add"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            추가
          </button>
        </div>
      </div>
    </div>
  );
}



// ─── 컴포넌트: 종목 상세 모달 (캔들 + 투자자동향) ────────
const PERIODS = [
  { key: '1D', label: '1일' },
  { key: '1M', label: '1개월' },
  { key: '1W', label: '1주' },
  { key: '1Y', label: '1년' },
];

function CandleChart({ candles }) {
  const [tooltip, setTooltip] = useState(null);
  if (!candles || candles.length === 0) return <div className="chart-empty">데이터 없음</div>;
  const max = Math.max(...candles.map(c => c.high));
  const min = Math.min(...candles.map(c => c.low));
  const range = max - min || 1;
  const H = 180;
  const CW = 14;
  const W = Math.max(candles.length * CW, 300);
  const toY = (v) => ((max - v) / range) * H;

  return (
    <div className="candle-scroll" style={{ position: 'relative' }}>
      {tooltip && (
        <div className="candle-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="ct-label">{tooltip.label}</div>
          <div className="ct-row"><span>시가</span><span>{tooltip.open?.toLocaleString()}</span></div>
          <div className="ct-row"><span>고가</span><span className="pos">{tooltip.high?.toLocaleString()}</span></div>
          <div className="ct-row"><span>저가</span><span className="neg">{tooltip.low?.toLocaleString()}</span></div>
          <div className="ct-row"><span>종가</span><span style={{fontWeight:700}}>{tooltip.close?.toLocaleString()}</span></div>
        </div>
      )}
      <svg width={W} height={H + 20} style={{ display: 'block' }}
        onMouseLeave={() => setTooltip(null)}>
        {candles.map((c, i) => {
          const x = i * CW + 7;
          const isUp = c.close >= c.open;
          const color = isUp ? '#ff4747' : '#4fc3f7';
          const bodyTop = toY(Math.max(c.open, c.close));
          const bodyH = Math.max(Math.abs(toY(c.open) - toY(c.close)), 1);
          return (
            <g key={i}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.ownerSVGElement.parentElement.getBoundingClientRect();
                const svgRect = e.currentTarget.ownerSVGElement.getBoundingClientRect();
                const relX = x - (svgRect.left - rect.left);
                setTooltip({ ...c, x: Math.min(relX, rect.width - 130), y: 4 });
              }}
              style={{ cursor: 'crosshair' }}
            >
              <rect x={x - 6} y={0} width={12} height={H} fill="transparent" />
              <line x1={x} y1={toY(c.high)} x2={x} y2={toY(c.low)} stroke={color} strokeWidth={1} />
              <rect x={x - 4} y={bodyTop} width={8} height={bodyH} fill={color} />
            </g>
          );
        })}
        {candles.map((c, i) => i % Math.ceil(candles.length / 6) === 0 ? (
          <text key={i} x={i * CW + 7} y={H + 14} textAnchor="middle" fontSize={9} fill="#4a5d78">{c.label}</text>
        ) : null)}
      </svg>
    </div>
  );
}

function StockDetailModal({ stock, onClose }) {
  const [period, setPeriod] = useState('1M');
  const [candles, setCandles] = useState([]);
  const [investor, setInvestor] = useState([]);
  const [loadingCandle, setLoadingCandle] = useState(false);
  const [loadingInvestor, setLoadingInvestor] = useState(false);

  const fetchCandle = useCallback(async (p) => {
    setLoadingCandle(true);
    try {
      const r = await fetch(`/api/chart?code=${stock.code}&type=candle&period=${p}`);
      const d = await r.json();
      setCandles(d.candles || []);
    } catch {}
    setLoadingCandle(false);
  }, [stock.code]);

  const fetchInvestor = useCallback(async () => {
    setLoadingInvestor(true);
    try {
      const r = await fetch(`/api/chart?code=${stock.code}&type=investor`);
      const d = await r.json();
      setInvestor(d.investor || []);
    } catch {}
    setLoadingInvestor(false);
  }, [stock.code]);

  useEffect(() => {
    fetchCandle(period);
    fetchInvestor();
  }, []);

  const handlePeriod = (p) => {
    setPeriod(p);
    fetchCandle(p);
  };

  const fmtQty = (n) => {
    if (!n && n !== 0) return '—';
    const abs = Math.abs(n);
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    if (abs >= 10000) return sign + (abs / 10000).toFixed(1) + '만';
    return sign + abs.toLocaleString();
  };
  const invCls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="detail-name">{stock.name}</span>
            <span className="detail-code">{stock.code}</span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="detail-body">
          {/* 캔들차트 */}
          <div className="detail-section">
            <div className="detail-section-header">
              <span className="detail-section-title">캔들차트</span>
              <div className="period-tabs">
                {PERIODS.map(p => (
                  <button
                    key={p.key}
                    className={`period-tab ${period === p.key ? 'active' : ''}`}
                    onClick={() => handlePeriod(p.key)}
                  >{p.label}</button>
                ))}
              </div>
            </div>
            <div className="candle-wrap">
              {loadingCandle
                ? <div className="chart-loading">로딩 중...</div>
                : <CandleChart candles={candles} />}
            </div>
          </div>

          {/* 투자자 동향 */}
          <div className="detail-section">
            <div className="detail-section-header">
              <span className="detail-section-title">투자자 동향 <span className="detail-hint">(순매수 수량, 최근 5일)</span></span>
            </div>
            {loadingInvestor ? (
              <div className="chart-loading">로딩 중...</div>
            ) : investor.length === 0 ? (
              <div className="chart-empty">데이터 없음</div>
            ) : (
              <table className="investor-table">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th className="num">개인</th>
                    <th className="num">외국인</th>
                    <th className="num">기관</th>
                  </tr>
                </thead>
                <tbody>
                  {investor.map((row, i) => (
                    <tr key={i} className={row.isEstimate ? 'investor-estimate' : ''}>
                      <td>
                        {row.label}
                        {row.isEstimate && <span className="estimate-badge">추정</span>}
                      </td>
                      <td className={`num ${invCls(row.individual)}`}>{fmtQty(row.individual)}</td>
                      <td className={`num ${invCls(row.foreign)}`}>{fmtQty(row.foreign)}</td>
                      <td className={`num ${invCls(row.institution)}`}>{fmtQty(row.institution)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 컴포넌트: 히스토리 차트 ───────────────────────────
// value: 'w1'=1주, 'm1'=1개월, ... , 'all'=전체
const CSV_PERIODS = [
  { label: '전체',  value: 'all' },
  { label: '1년',   value: 'y1' },
  { label: '6개월', value: 'm6' },
  { label: '3개월', value: 'm3' },
  { label: '1개월', value: 'm1' },
  { label: '1주',   value: 'w1' },
];

const getCutoffDate = (period) => {
  if (period === 'all') return null;
  const now = new Date();
  if (period === 'w1') { now.setDate(now.getDate() - 7); }
  else if (period === 'm1') { now.setMonth(now.getMonth() - 1); }
  else if (period === 'm3') { now.setMonth(now.getMonth() - 3); }
  else if (period === 'm6') { now.setMonth(now.getMonth() - 6); }
  else if (period === 'y1') { now.setFullYear(now.getFullYear() - 1); }
  // KST 기준 날짜 문자열 반환
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
};

function HistoryChart({ snapshots, onClose }) {
  const [selected, setSelected] = useState(null);
  const [csvPeriod, setCsvPeriod] = useState('all'); // 디폴트 전체

  // 주말(토/일) 스냅샷 제외
  const isWeekend = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    return day === 0 || day === 6;
  };

  const chartData = snapshots
    .filter(s => !isWeekend(s.date))
    .map(s => ({
      date: s.date,
      label: s.date.slice(5), // MM-DD
      eval: s.totalEval,
      principal: s.totalPrincipal,
      profit: s.totalProfit,
      rate: s.totalProfitRate,
    })).reverse();

  const handleClick = (data) => {
    if (!data?.activePayload) return;
    const date = data.activePayload[0]?.payload?.date;
    const snap = snapshots.find(s => s.date === date);
    setSelected(snap || null);
  };

  const downloadCSV = () => {
    const cutoff = getCutoffDate(csvPeriod);
    const sorted = [...snapshots]
      .filter(s => !cutoff || s.date >= cutoff)
      .sort((a, b) => a.date.localeCompare(b.date));
    const rows = [];

    // ① 일별 요약
    rows.push(['[일별 요약]']);
    rows.push(['날짜', '투자원금', '평가금액', '손익', '수익률(%)']);
    sorted.forEach(s => {
      rows.push([
        s.date,
        s.totalPrincipal,
        s.totalEval,
        s.totalProfit,
        s.totalProfitRate?.toFixed(2) ?? '',
      ]);
    });

    rows.push([]); // 빈 줄 구분

    // ② 종목별 상세
    rows.push(['[종목별 상세]']);
    rows.push(['날짜', '종목명', '코드', '수량', '현재가', '평균단가', '원금', '평가금액', '손익', '수익률(%)']);
    sorted.forEach(s => {
      (s.holdings || []).forEach(h => {
        rows.push([
          s.date,
          h.name,
          h.code,
          h.qty,
          h.currentPrice,
          h.avgPrice,
          h.principal,
          h.evalAmount,
          h.profit,
          h.profitRate?.toFixed(2) ?? '',
        ]);
      });
    });

    // UTF-8 BOM + CSV 생성 (Excel 한글 깨짐 방지)
    const csv = '﻿' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const periodLabel = CSV_PERIODS.find(p => p.value === csvPeriod)?.label || csvPeriod;
    const todayKST = new Date(Date.now() + 9*60*60*1000).toISOString().slice(0,10);
    a.download = `portfolio_${periodLabel}_${todayKST}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="history-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>📈 평가금액 이력</span>
          <div style={{display:'flex', gap:6, alignItems:'center'}}>
            <select
              className="csv-period-select"
              value={csvPeriod}
              onChange={e => setCsvPeriod(e.target.value)}
            >
              {CSV_PERIODS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <button className="btn-download-csv" onClick={downloadCSV}>
              ⬇ CSV
            </button>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="history-body">
          <div className="history-chart-wrap">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} onClick={handleClick} style={{cursor:'pointer'}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2d45" />
                <XAxis dataKey="label" tick={{fill:'#4a5d78', fontSize:11}} />
                <YAxis
                  tick={{fill:'#4a5d78', fontSize:11}}
                  tickFormatter={v => (v/1000000).toFixed(0) + 'M'}
                  width={45}
                />
                <Tooltip
                  contentStyle={{background:'#1a2235', border:'1px solid #1f2d45', borderRadius:8}}
                  labelStyle={{color:'#7a8ba8'}}
                  formatter={(v, n) => {
                    if (n === 'eval') return [fmt(v) + '원', '평가금액'];
                    if (n === 'principal') return [<span style={{color:'#ff8a65'}}>{fmt(v) + '원'}</span>, '투자원금'];
                    const color = v >= 0 ? '#ff4747' : '#4fc3f7';
                    return [<span style={{color}}>{(v >= 0 ? '+' : '') + fmt(v) + '원'}</span>, '손익'];
                  }}
                />
                <Line type="monotone" dataKey="eval" stroke="#00d4aa" strokeWidth={2} dot={{r:3, fill:'#00d4aa'}} activeDot={{r:5}} name="eval" />
                <Line type="monotone" dataKey="principal" stroke="#ff8a65" strokeWidth={1.5} dot={{r:2, fill:'#ff8a65'}} strokeDasharray="3 2" name="principal" />
                <Line type="monotone" dataKey="profit" stroke="#4fc3f7" strokeWidth={1.5} dot={{r:2, fill:'#4fc3f7'}} strokeDasharray="4 2" name="profit" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {selected ? (
            <div className="history-detail">
              <div className="history-detail-header">
                <span className="history-date">{selected.date}</span>
                <div className="history-summary">
                  <span>투자원금 <b style={{color:'#ff8a65'}}>{fmt(selected.totalPrincipal)}원</b></span>
                  <span>평가금액 <b style={{color:'#00d4aa'}}>{fmt(selected.totalEval)}원</b></span>
                  <span>손익 <b className={cls(selected.totalProfit)}>{selected.totalProfit >= 0 ? '+' : ''}{fmt(selected.totalProfit)}원</b></span>
                  <span>수익률 <b className={cls(selected.totalProfitRate)}>{fmtRate(selected.totalProfitRate)}</b></span>
                </div>
              </div>
              {selected.holdings && (
                <div className="history-holdings">
                  {selected.holdings.map((h, i) => (
                    <div key={i} className="history-holding-row">
                      <span className="history-holding-name">{h.name}</span>
                      <span className="history-holding-price">{h.currentPrice > 0 ? fmt(h.currentPrice) : '—'}원</span>
                      <span className={`history-holding-rate ${cls(h.profitRate)}`}>{h.evalAmount > 0 ? fmtRate(h.profitRate) : '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="history-hint">차트의 날짜를 클릭하면 상세 정보를 볼 수 있어요</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 컴포넌트: 커스텀 파이차트 툴팁 ───────────────────
function PieTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="pie-tooltip">
      <div className="pie-tooltip-name">{d.name}</div>
      <div className="pie-tooltip-value">{fmt(d.value)}원</div>
      <div className="pie-tooltip-pct">{d.payload.pct.toFixed(1)}%</div>
    </div>
  );
}

// ─── 메인 앱 ───────────────────────────────────────────
export default function App() {
  const [holdings, setHoldings] = useState([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [prices, setPrices] = useState({});
  const [snapshots, setSnapshots] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editVal, setEditVal] = useState({});
  const [selectedStock, setSelectedStock] = useState(null);
  const intervalRef = useRef(null);

  // 서버에서 데이터 불러오기 (Redis 빈 배열 포함 실패 시 localStorage fallback)
  useEffect(() => {
    const loadFromLocal = () => {
      try {
        const local = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (Array.isArray(local) && local.length > 0) setHoldings(local);
      } catch {}
      setDataLoaded(true);
    };
    fetch('/api/holdings')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          // Redis에 데이터 있음 → 서버 데이터 사용
          setHoldings(data);
          setDataLoaded(true);
        } else {
          // Redis 빈 배열이거나 에러 객체 → localStorage fallback
          // (이후 save effect가 자동으로 Redis에 동기화)
          loadFromLocal();
        }
      })
      .catch(loadFromLocal);
  }, []);

  // 서버에 데이터 저장 (빈 배열은 저장 안 함)
  useEffect(() => {
    if (!dataLoaded) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
    if (holdings.length === 0) return;
    fetch('/api/holdings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(holdings),
    }).catch(() => {});
  }, [holdings, dataLoaded]);

  // 시세 조회
  const fetchPrices = useCallback(async () => {
    if (holdings.length === 0) return;
    setLoading(true);
    try {
      const codes = holdings.map(h => h.code).join(',');
      const res = await fetch(`/api/price?codes=${codes}`);
      const data = await res.json();
      setPrices(data);
      setLastUpdated(new Date());
      saveSnapshot(data, holdings);
    } catch (e) {
      console.error('시세 조회 실패:', e);
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdings]);

  // 스냅샷 조회
  const fetchSnapshots = useCallback(async () => {
    try {
      const res = await fetch('/api/snapshot');
      const data = await res.json();
      if (Array.isArray(data)) setSnapshots(data);
    } catch (e) {}
  }, []);

  // 오늘 스냅샷 자동 저장
  const saveSnapshot = useCallback(async (currentPrices, currentHoldings) => {
    if (currentHoldings.length === 0) return;
    const enriched = currentHoldings.map(h => {
      const p = currentPrices[h.code];
      const currentPrice = p?.price || 0;
      const principal = h.qty * h.avgPrice;
      const evalAmount = h.qty * currentPrice;
      const profit = evalAmount - principal;
      const profitRate = principal > 0 ? (profit / principal) * 100 : 0;
      return { ...h, currentPrice, principal, evalAmount, profit, profitRate };
    });
    const totalPrincipal = enriched.reduce((s, h) => s + h.principal, 0);
    const totalEval = enriched.reduce((s, h) => s + h.evalAmount, 0);
    const totalProfit = totalEval - totalPrincipal;
    const totalProfitRate = totalPrincipal > 0 ? (totalProfit / totalPrincipal) * 100 : 0;
    try {
      await fetch('/api/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalPrincipal, totalEval, totalProfit, totalProfitRate, holdings: enriched }),
      });
      fetchSnapshots();
    } catch (e) {}
  }, [fetchSnapshots]);

  useEffect(() => {
    fetchPrices();
    fetchSnapshots(); // eslint-disable-line react-hooks/exhaustive-deps
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchPrices, REFRESH_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [fetchPrices]);

  // 종목 추가
  const addHolding = (h) => setHoldings(prev => [...prev, h]);

  // 종목 삭제
  const removeHolding = (id) => {
    if (window.confirm('이 종목을 삭제할까요?')) {
      setHoldings(prev => prev.filter(h => h.id !== id));
    }
  };

  // 인라인 수정
  const startEdit = (h) => {
    setEditingId(h.id);
    setEditVal({ qty: h.qty, avgPrice: h.avgPrice, code: h.code, name: h.name });
  };
  const saveEdit = (id) => {
    setHoldings(prev => prev.map(h =>
      h.id === id
        ? { ...h, qty: parseInt(editVal.qty), avgPrice: parseInt(editVal.avgPrice), code: editVal.code.trim(), name: editVal.name.trim() }
        : h
    ));
    setEditingId(null);
    fetchPrices();
  };

  // 계산
  const enriched = holdings.map(h => {
    const p = prices[h.code];
    const currentPrice = p?.price || 0;
    const principal = h.qty * h.avgPrice;
    const evalAmount = h.qty * currentPrice;
    const profit = evalAmount - principal;
    const profitRate = principal > 0 ? (profit / principal) * 100 : 0;
    return { ...h, currentPrice, principal, evalAmount, profit, profitRate, priceData: p };
  });

  const totalPrincipal = enriched.reduce((s, h) => s + h.principal, 0);
  const totalEval = enriched.reduce((s, h) => s + h.evalAmount, 0);
  const totalProfit = totalEval - totalPrincipal;
  const totalProfitRate = totalPrincipal > 0 ? (totalProfit / totalPrincipal) * 100 : 0;

  // 비중 차트는 종목코드 기준으로 합산 (같은 종목이 여러 계좌에 있어도 하나로)
  // 보유 계좌 목록도 함께 집계해 범례 금액 옆에 표시: (종합+ISA), (3계좌), (연금만)
  const ACCOUNT_SHORT = { '종합계좌': '종합', '연금계좌': '연금', 'ISA계좌': 'ISA' };
  const ACCOUNT_SORT = ['종합', '연금', 'ISA'];
  const stripAccountSuffix = (name) => name.replace(/\s*\((?:ISA|연금|종합)\)\s*$/, '').trim();

  const pieData = Object.values(
    enriched
      .filter(h => h.evalAmount > 0)
      .reduce((acc, h) => {
        const accShort = ACCOUNT_SHORT[getAccountType(h.name)];
        if (!acc[h.code]) {
          acc[h.code] = { code: h.code, name: stripAccountSuffix(h.name), value: 0, qty: 0, accounts: new Set() };
        }
        acc[h.code].value += h.evalAmount;
        acc[h.code].qty   += h.qty;
        acc[h.code].accounts.add(accShort);
        return acc;
      }, {})
  )
    .map(d => {
      const accList = [...d.accounts].sort((a, b) => ACCOUNT_SORT.indexOf(a) - ACCOUNT_SORT.indexOf(b));
      const accountLabel = accList.length === 3 ? '3계좌'
        : accList.length === 1 ? `${accList[0]}만`
        : accList.join('+');
      return { ...d, accountLabel, pct: totalEval > 0 ? (d.value / totalEval) * 100 : 0 };
    })
    .sort((a, b) => b.value - a.value);

  // 종목코드 기준 원금/평가금액/손익/수익률 합산 (하단 요약 테이블용)
  const codeData = Object.values(
    enriched.reduce((acc, h) => {
      if (!acc[h.code]) {
        acc[h.code] = { code: h.code, name: stripAccountSuffix(h.name), principal: 0, evalAmount: 0 };
      }
      acc[h.code].principal  += h.principal;
      acc[h.code].evalAmount += h.evalAmount;
      return acc;
    }, {})
  )
    .map(d => {
      const profit     = d.evalAmount - d.principal;
      const profitRate = d.principal > 0 ? (profit / d.principal) * 100 : 0;
      return { ...d, profit, profitRate };
    })
    .sort((a, b) => b.evalAmount - a.evalAmount);

  const marketOpen = isMarketOpen();

  return (
    <div className="app">
      {/* 스티키 상단 영역: 헤더 + 요약카드 */}
      <div className="sticky-top">
        {/* 헤더 */}
        <header className="header">
          <div className="header-left">
            <div className="logo">PORTFOLIO</div>
            <div className={`market-status ${marketOpen ? 'open' : 'closed'}`}>
              <span className="dot" />
              {marketOpen ? '장 중' : '장 마감'}
            </div>
          </div>
          <div className="header-right">
            {lastUpdated && (
              <span className="last-updated">
                {lastUpdated.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 업데이트
              </span>
            )}
            <button className={`btn-refresh ${loading ? 'spinning' : ''}`} onClick={fetchPrices} disabled={loading} style={{flexShrink:0}}>
              ↻
            </button>
            <button className="btn-secondary" onClick={() => setShowHistory(true)} style={{flexShrink:0}}>
              <span className="btn-icon">📈</span><span className="btn-text"> 이력</span>
            </button>
            <button className="btn-primary" onClick={() => setShowModal(true)} style={{flexShrink:0, transform:'none'}}>
              <span className="btn-icon">+</span><span className="btn-text"> 종목 추가</span>
            </button>
          </div>
        </header>

        {/* 요약 카드 - sticky */}
        <section className="summary-grid">
          <div className="summary-card">
            <div className="summary-label">총 투자 원금</div>
            <div className="summary-value">{fmt(totalPrincipal)}<span className="unit">원</span></div>
          </div>
          <div className="summary-card accent">
            <div className="summary-label">총 평가금액</div>
            <div className="summary-value">{fmt(totalEval)}<span className="unit">원</span></div>
          </div>
          <div className={`summary-card ${cls(totalProfit)}`}>
            <div className="summary-label">총 손익</div>
            <div className="summary-value">
              {totalProfit >= 0 ? '+' : ''}{fmt(totalProfit)}<span className="unit">원</span>
            </div>
            <div className={`summary-rate ${cls(totalProfitRate)}`}>{fmtRate(totalProfitRate)}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">보유 종목 수</div>
            <div className="summary-value">{holdings.length}<span className="unit">개</span></div>
          </div>
        </section>
      </div>

      <main className="main">
        <div className="content-grid">
          {/* 종목 테이블 */}
          <section className="table-section">
            <div className="section-header">
              <h2>보유 종목</h2>
              <span className="section-sub">30초마다 자동 갱신</span>
            </div>

            {enriched.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📊</div>
                <div className="empty-text">아직 종목이 없어요</div>
                <div className="empty-sub">위의 '종목 추가' 버튼으로 시작해보세요</div>
                <button className="btn-secondary" onClick={() => setShowHistory(true)}>
            📈 이력
          </button>
          <button className="btn-primary" onClick={() => setShowModal(true)}>+ 첫 종목 추가</button>
              </div>
            ) : (
              <div className="table-wrapper">
                <table className="stock-table">
                  <thead>
                    <tr>
                      <th>종목</th>
                      <th className="num">현재가</th>
                      <th className="num">수량</th>
                      <th className="num">평균단가</th>
                      <th className="num">원금</th>
                      <th className="num">평가금액</th>
                      <th className="num">손익</th>
                      <th className="num">수익률</th>
                      <th>관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ACCOUNT_ORDER.map(accountType => {
                      const group = enriched.filter(h => getAccountType(h.name) === accountType);
                      if (group.length === 0) return null;
                      const subPrincipal = group.reduce((s, h) => s + h.principal, 0);
                      const subEval = group.reduce((s, h) => s + h.evalAmount, 0);
                      const subProfit = subEval - subPrincipal;
                      const subRate = subPrincipal > 0 ? (subProfit / subPrincipal) * 100 : 0;
                      return (
                        <React.Fragment key={accountType}>
                          <tr className="account-group-header">
                            <td colSpan="9"><span className="account-group-label">{accountType}</span></td>
                          </tr>
                          {group.map((h) => {
                            const idx = enriched.indexOf(h);
                            return (
                      <tr key={h.id} style={{ '--row-color': COLORS[idx % COLORS.length] }} onClick={() => { if (editingId !== h.id) setSelectedStock(h); }} className={editingId !== h.id ? 'row-clickable' : ''}>
                        <td>
                          <div className="stock-name-cell">
                            <span className="color-dot" style={{ background: COLORS[idx % COLORS.length] }} />
                            {editingId === h.id ? (
                              <div style={{display:'flex', flexDirection:'column', gap:4}}>
                                <input className="inline-input" style={{width:120, textAlign:'left'}}
                                  placeholder="종목명"
                                  value={editVal.name}
                                  onChange={e => setEditVal(v => ({ ...v, name: e.target.value }))}
                                />
                                <input className="inline-input" style={{width:90, textAlign:'left'}}
                                  placeholder="종목코드"
                                  value={editVal.code}
                                  onChange={e => setEditVal(v => ({ ...v, code: e.target.value }))}
                                />
                              </div>
                            ) : (
                              <div>
                                <div className="stock-name">{h.name}</div>
                                <div className="stock-code">{h.code}</div>
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="num">
                          <div className="price-cell">
                            <span>{h.currentPrice > 0 ? fmt(h.currentPrice) : '—'}</span>
                            {h.priceData && h.currentPrice > 0 && (
                              <span className={`change-badge ${cls(h.priceData.change)}`}>
                                {fmtRate(h.priceData.change)}
                              </span>
                            )}
                          </div>
                        </td>
                        {editingId === h.id ? (
                          <>
                            <td className="num">
                              <input className="inline-input" type="number"
                                value={editVal.qty}
                                onChange={e => setEditVal(v => ({ ...v, qty: e.target.value }))}
                              />
                            </td>
                            <td className="num">
                              <input className="inline-input" type="number"
                                value={editVal.avgPrice}
                                onChange={e => setEditVal(v => ({ ...v, avgPrice: e.target.value }))}
                              />
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="num" data-label="수량">{h.qty.toLocaleString()}</td>
                            <td className="num" data-label="평균단가">{fmt(h.avgPrice)}</td>
                          </>
                        )}
                        <td className="num" data-label="원금">{fmt(h.principal)}</td>
                        <td className="num" data-label="평가금액">{h.evalAmount > 0 ? fmt(h.evalAmount) : '—'}</td>
                        <td className={`num ${cls(h.profit)}`} data-label="손익">
                          {h.evalAmount > 0 ? (h.profit >= 0 ? '+' : '') + fmt(h.profit) : '—'}
                        </td>
                        <td className={`num rate-cell ${cls(h.profitRate)}`} data-label="수익률">
                          {h.evalAmount > 0 ? fmtRate(h.profitRate) : '—'}
                        </td>
                        <td>
                          <div className="action-btns">
                            {editingId === h.id ? (
                              <>
                                <button className="btn-save" onClick={e => { e.stopPropagation(); saveEdit(h.id); }}>저장</button>
                                <button className="btn-cancel-sm" onClick={e => { e.stopPropagation(); setEditingId(null); }}>취소</button>
                              </>
                            ) : (
                              <>
                                <button className="btn-edit" onClick={e => { e.stopPropagation(); startEdit(h); }}>수정</button>
                                <button className="btn-del" onClick={e => { e.stopPropagation(); removeHolding(h.id); }}>삭제</button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                            );
                          })}
                          <tr className="account-subtotal">
                            <td colSpan="4"><span className="subtotal-label">{accountType} 소계</span></td>
                            <td className="num">{fmt(subPrincipal)}</td>
                            <td className="num">{subEval > 0 ? fmt(subEval) : '—'}</td>
                            <td className={`num ${cls(subProfit)}`}>{subEval > 0 ? (subProfit >= 0 ? '+' : '') + fmt(subProfit) : '—'}</td>
                            <td className={`num rate-cell ${cls(subRate)}`}>{subEval > 0 ? fmtRate(subRate) : '—'}</td>
                            <td></td>
                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 우측 패널: 비중 차트 */}
          {pieData.length > 0 && (
            <section className="chart-section">
              <div className="section-header">
                <h2>종목 비중</h2>
              </div>
              <div className="pie-container">
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={70}
                      outerRadius={110}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {pieData.map((_, idx) => (
                        <Cell key={idx} fill={COLORS[idx % COLORS.length]} stroke="transparent" />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>

                {/* 도넛 중앙 텍스트 */}
                <div className="pie-center">
                  <div className="pie-center-label">평가총액</div>
                  <div className="pie-center-value">{fmt(totalEval)}</div>
                  <div className="pie-center-unit">원</div>
                </div>
              </div>

              {/* 범례 */}
              <div className="pie-legend">
                {pieData.map((d, idx) => (
                  <div key={idx} className="legend-item">
                    <span className="legend-dot" style={{ background: COLORS[idx % COLORS.length] }} />
                    <span className="legend-name">
                      {d.name}
                      <span className="legend-qty">×{d.qty.toLocaleString()}</span>
                    </span>
                    <span className="legend-value">
                      {fmt(d.value)}원 <span className="legend-acc">({d.accountLabel})</span>
                    </span>
                    <span className="legend-pct">{d.pct.toFixed(1)}%</span>
                  </div>
                ))}
              </div>

              {/* 종목별 손익 요약 (종목코드 기준) */}
              {codeData.length > 0 && (
                <div className="code-summary-wrap">
                  <div className="code-summary-title">종목별 손익 <span className="section-sub">코드 기준</span></div>
                  <table className="code-summary-table">
                    <thead>
                      <tr>
                        <th>종목</th>
                        <th className="num">원금</th>
                        <th className="num">평가금액</th>
                        <th className="num">손익</th>
                        <th className="num">수익률</th>
                      </tr>
                    </thead>
                    <tbody>
                      {codeData.map((d, i) => (
                        <tr key={d.code}>
                          <td>
                            <span className="color-dot" style={{ background: COLORS[i % COLORS.length] }} />
                            <span className="cs-name">{d.name}</span>
                          </td>
                          <td className="num">{fmt(d.principal)}</td>
                          <td className="num">{d.evalAmount > 0 ? fmt(d.evalAmount) : '—'}</td>
                          <td className={`num ${cls(d.profit)}`}>
                            {d.evalAmount > 0 ? (d.profit >= 0 ? '+' : '') + fmt(d.profit) : '—'}
                          </td>
                          <td className={`num rate-cell ${cls(d.profitRate)}`}>
                            {d.evalAmount > 0 ? fmtRate(d.profitRate) : '—'}
                          </td>
                        </tr>
                      ))}
                      <tr className="code-summary-total">
                        <td><span className="subtotal-label">합계</span></td>
                        <td className="num">{fmt(totalPrincipal)}</td>
                        <td className="num">{totalEval > 0 ? fmt(totalEval) : '—'}</td>
                        <td className={`num ${cls(totalProfit)}`}>
                          {totalEval > 0 ? (totalProfit >= 0 ? '+' : '') + fmt(totalProfit) : '—'}
                        </td>
                        <td className={`num rate-cell ${cls(totalProfitRate)}`}>
                          {totalEval > 0 ? fmtRate(totalProfitRate) : '—'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>

      </main>

      {/* 모달 */}
      {selectedStock && (
        <StockDetailModal stock={selectedStock} onClose={() => setSelectedStock(null)} />
      )}

      {showHistory && snapshots.length > 0 && (
        <HistoryChart snapshots={snapshots} onClose={() => setShowHistory(false)} />
      )}

      {showModal && (
        <AddStockModal
          onAdd={addHolding}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
