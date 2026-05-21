import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import './App.css';

// ─── 상수 ──────────────────────────────────────────────
const STORAGE_KEY = 'portfolio_holdings_v2';
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5분

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

// ─── 컴포넌트: 종목 추가 모달 ──────────────────────────
function AddStockModal({ onAdd, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState('');
  const [avgPrice, setAvgPrice] = useState('');
  const [searching, setSearching] = useState(false);
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
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 350);
    return () => clearTimeout(debounceRef.current);
  }, [query, search]);

  const handleSubmit = () => {
    if (!selected || !qty || !avgPrice) return;
    onAdd({
      id: Date.now().toString(),
      code: selected.code,
      name: selected.name,
      qty: parseInt(qty),
      avgPrice: parseInt(avgPrice.replace(/,/g, '')),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>종목 추가</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="input-group">
            <label>종목 검색</label>
            <input
              autoFocus
              placeholder="종목명 또는 코드 입력 (예: 삼성전자, KODEX 200)"
              value={query}
              onChange={e => { setQuery(e.target.value); setSelected(null); }}
            />
          </div>

          {searching && <div className="search-status">검색 중...</div>}

          {results.length > 0 && !selected && (
            <div className="search-results">
              {results.map(r => (
                <div
                  key={r.code}
                  className="search-item"
                  onClick={() => { setSelected(r); setQuery(r.name); setResults([]); }}
                >
                  <span className="search-name">{r.name}</span>
                  <span className="search-code">{r.code}</span>
                </div>
              ))}
            </div>
          )}

          {selected && (
            <div className="selected-badge">
              ✓ {selected.name} ({selected.code})
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

          {selected && qty && avgPrice && (
            <div className="preview">
              <span>투자 원금</span>
              <span className="preview-value">{fmt(parseInt(qty) * parseInt(avgPrice || 0))}원</span>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>취소</button>
          <button
            className="btn-add"
            onClick={handleSubmit}
            disabled={!selected || !qty || !avgPrice}
          >
            추가
          </button>
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
  const [holdings, setHoldings] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch { return []; }
  });
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editVal, setEditVal] = useState({});
  const intervalRef = useRef(null);

  // 로컬스토리지 저장
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
  }, [holdings]);

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
    } catch (e) {
      console.error('시세 조회 실패:', e);
    }
    setLoading(false);
  }, [holdings]);

  useEffect(() => {
    fetchPrices();
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
    setEditVal({ qty: h.qty, avgPrice: h.avgPrice });
  };
  const saveEdit = (id) => {
    setHoldings(prev => prev.map(h =>
      h.id === id
        ? { ...h, qty: parseInt(editVal.qty), avgPrice: parseInt(editVal.avgPrice) }
        : h
    ));
    setEditingId(null);
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

  const pieData = enriched
    .filter(h => h.evalAmount > 0)
    .map(h => ({
      name: h.name,
      value: h.evalAmount,
      pct: totalEval > 0 ? (h.evalAmount / totalEval) * 100 : 0,
    }));

  const marketOpen = isMarketOpen();

  return (
    <div className="app">
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
          <button className={`btn-refresh ${loading ? 'spinning' : ''}`} onClick={fetchPrices} disabled={loading}>
            ↻
          </button>
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            + 종목 추가
          </button>
        </div>
      </header>

      <main className="main">
        {/* 요약 카드 */}
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

        <div className="content-grid">
          {/* 종목 테이블 */}
          <section className="table-section">
            <div className="section-header">
              <h2>보유 종목</h2>
              <span className="section-sub">5분마다 자동 갱신</span>
            </div>

            {enriched.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📊</div>
                <div className="empty-text">아직 종목이 없어요</div>
                <div className="empty-sub">위의 '종목 추가' 버튼으로 시작해보세요</div>
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
                    {enriched.map((h, idx) => (
                      <tr key={h.id} style={{ '--row-color': COLORS[idx % COLORS.length] }}>
                        <td>
                          <div className="stock-name-cell">
                            <span className="color-dot" style={{ background: COLORS[idx % COLORS.length] }} />
                            <div>
                              <div className="stock-name">{h.name}</div>
                              <div className="stock-code">{h.code}</div>
                            </div>
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
                            <td className="num">{h.qty.toLocaleString()}</td>
                            <td className="num">{fmt(h.avgPrice)}</td>
                          </>
                        )}
                        <td className="num">{fmt(h.principal)}</td>
                        <td className="num">{h.evalAmount > 0 ? fmt(h.evalAmount) : '—'}</td>
                        <td className={`num ${cls(h.profit)}`}>
                          {h.evalAmount > 0 ? (h.profit >= 0 ? '+' : '') + fmt(h.profit) : '—'}
                        </td>
                        <td className={`num rate-cell ${cls(h.profitRate)}`}>
                          {h.evalAmount > 0 ? fmtRate(h.profitRate) : '—'}
                        </td>
                        <td>
                          <div className="action-btns">
                            {editingId === h.id ? (
                              <>
                                <button className="btn-save" onClick={() => saveEdit(h.id)}>저장</button>
                                <button className="btn-cancel-sm" onClick={() => setEditingId(null)}>취소</button>
                              </>
                            ) : (
                              <>
                                <button className="btn-edit" onClick={() => startEdit(h)}>수정</button>
                                <button className="btn-del" onClick={() => removeHolding(h.id)}>삭제</button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
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
                    <span className="legend-name">{d.name}</span>
                    <span className="legend-pct">{d.pct.toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      {/* 모달 */}
      {showModal && (
        <AddStockModal
          onAdd={addHolding}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
