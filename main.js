// Stock Dashboard — multi-ticker, risk metrics, RSI, earnings intelligence.
// API keys are entered at runtime; nothing secret is committed here.

const TICKER_COLORS = ['#f2f2f0', '#4e9af1', '#76c442', '#f4b942', '#e668a7'];
const EARNINGS_TICKERS = new Set(['AAPL']);
let lastRenderData = null;

const form = document.getElementById('ticker-form');
const results = document.getElementById('results');

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const raw = document.getElementById('tickers').value;
  const tickers = raw.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean).slice(0, 5);
  if (!tickers.length) return;

  const rfRateInput = parseFloat(document.getElementById('rfrate').value);
  const rfRate = isNaN(rfRateInput) ? 0.045 : rfRateInput / 100;

  const twelveDataKey = document.getElementById('twelvedata-key').value.trim();
  const openRouterKey = document.getElementById('openrouter-key').value.trim();

  const needSpy = true;
  const spyTicker = 'SPY';
  const fetchTickers = tickers.includes(spyTicker)
    ? tickers
    : [...tickers, spyTicker];

  results.innerHTML = `<p class="status-loading">Fetching price data for ${tickers.join(', ')}${needSpy ? ' + SPY (for beta)' : ''}…</p>`;

  try {
    // Fetch price + earnings in parallel
    const pricePromises = fetchTickers.map((t) => fetchPriceData(t, twelveDataKey));
    const earningsPromises = tickers.map((t) => fetchEarningsData(t));

    const [allPriceResults, allEarningsResults] = await Promise.all([
      Promise.all(pricePromises),
      Promise.all(earningsPromises)
    ]);

    const priceMap = {};
    fetchTickers.forEach((t, i) => { priceMap[t] = allPriceResults[i]; });
    const earningsMap = {};
    tickers.forEach((t, i) => { earningsMap[t] = allEarningsResults[i]; });

    const spyData = priceMap[spyTicker];
    const spyReturns = calculateReturns(spyData).filter((r) => r !== null);

    // Build stockData array
    const stockDataArr = tickers.map((ticker) => {
      const priceData = priceMap[ticker];
      const returns = calculateReturns(priceData);
      const sma20 = calculateSMA(priceData, 20);
      const sma50 = calculateSMA(priceData, 50);
      const rsi14 = calculateRSI(priceData, 14);
      const metrics = computeMetrics(priceData, returns, sma20, sma50, rsi14, spyReturns, rfRate);
      return { ticker, priceData, returns, sma20, sma50, rsi14, metrics, earningsData: earningsMap[ticker] };
    });

    results.innerHTML = `<p class="status-loading">Generating AI analysis…</p>`;

    if (tickers.length === 1) {
      const sd = stockDataArr[0];
      const llmCalls = [getResearchNote(sd, openRouterKey)];
      if (sd.earningsData) llmCalls.push(getEarningsNote(sd.ticker, sd.earningsData, openRouterKey));
      const [note, earningsNote] = await Promise.all(llmCalls);
      lastRenderData = { mode: 'single', stockDataArr, note, earningsNote: earningsNote ?? null };
      renderSingle(sd, note, earningsNote ?? null);
    } else {
      const note = await getComparisonNote(stockDataArr, rfRate, openRouterKey);
      lastRenderData = { mode: 'comparison', stockDataArr, note };
      renderComparison(stockDataArr, note);
    }
  } catch (err) {
    results.innerHTML = `<div class="alert"><strong>Something went wrong.</strong> ${err.message}</div>`;
  }
});

window.addEventListener('resize', () => {
  if (!lastRenderData) return;
  if (lastRenderData.mode === 'single') {
    const canvas = document.getElementById('price-chart');
    const rsiCanvas = document.getElementById('rsi-chart');
    const { stockDataArr } = lastRenderData;
    if (canvas) drawPriceChart(canvas, stockDataArr[0].priceData, stockDataArr[0].sma20, stockDataArr[0].sma50);
    if (rsiCanvas) drawRSIChart(rsiCanvas, stockDataArr[0].rsi14);
  } else {
    const canvas = document.getElementById('comparison-chart');
    if (canvas) drawComparisonChart(canvas, lastRenderData.stockDataArr);
  }
});

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchPriceData(ticker, apiKey) {
  const url = `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&outputsize=130&apikey=${apiKey}`;
  const response = await fetch(url);
  const body = await response.text();
  let raw;
  try { raw = JSON.parse(body); } catch { throw new Error(`${ticker}: ${body.trim() || 'price fetch failed'}`); }
  if (raw && raw.status === 'error') throw new Error(`${ticker}: ${raw.message || 'price fetch failed'}`);
  if (!response.ok) throw new Error(`${ticker}: price fetch failed`);
  const values = raw.values ?? [];
  if (!values.length) throw new Error(`No price data returned for ${ticker}`);
  return values
    .map((b) => ({ date: b.datetime, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function fetchEarningsData(ticker) {
  if (!EARNINGS_TICKERS.has(ticker)) return null;
  try {
    const r = await fetch(`./data/${ticker}.json`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function calculateReturns(priceData) {
  return priceData.map((bar, i) => {
    if (i === 0) return null;
    return (bar.close - priceData[i - 1].close) / priceData[i - 1].close;
  });
}

function calculateSMA(priceData, window) {
  return priceData.map((_, i, arr) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += arr[j].close;
    return sum / window;
  });
}

function calculateRSI(priceData, period = 14) {
  const rsi = new Array(priceData.length).fill(null);
  if (priceData.length < period + 1) return rsi;

  const changes = priceData.map((bar, i) => i === 0 ? 0 : bar.close - priceData[i - 1].close);

  // Initial averages using simple mean over first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0);

  // Wilder smoothing
  for (let i = period + 1; i < priceData.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return rsi;
}

function pearsonCorrelation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const xSlice = xs.slice(xs.length - n);
  const ySlice = ys.slice(ys.length - n);
  const mx = xSlice.reduce((a, b) => a + b, 0) / n;
  const my = ySlice.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - mx;
    const dy = ySlice[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}

function computeMetrics(priceData, returns, sma20, sma50, rsi14, spyReturns, rfRate) {
  const first = priceData[0];
  const latest = priceData[priceData.length - 1];
  const periodReturn = (latest.close - first.close) / first.close;
  const periodHigh = Math.max(...priceData.map((b) => b.high));
  const periodLow = Math.min(...priceData.map((b) => b.low));
  const avgVolume = priceData.reduce((s, b) => s + b.volume, 0) / priceData.length;

  const cleanReturns = returns.filter((r) => r !== null);
  const n = cleanReturns.length;
  const mean = n > 0 ? cleanReturns.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? cleanReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1) : 0;
  const dailyVol = Math.sqrt(variance);
  const annualizedReturn = mean * 252;
  const annualizedVol = dailyVol * Math.sqrt(252);

  const rfDaily = rfRate / 252;
  const excessReturns = cleanReturns.map((r) => r - rfDaily);
  const excessMean = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
  const sharpe = annualizedVol > 0 ? (excessMean * 252) / annualizedVol : null;

  // Max drawdown
  let peak = priceData[0].close;
  let maxDD = 0;
  for (const bar of priceData) {
    if (bar.close > peak) peak = bar.close;
    const dd = (bar.close - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Beta vs SPY
  let beta = null;
  if (spyReturns && spyReturns.length >= 5) {
    const len = Math.min(cleanReturns.length, spyReturns.length);
    const stockSlice = cleanReturns.slice(cleanReturns.length - len);
    const spySlice = spyReturns.slice(spyReturns.length - len);
    const spyMean = spySlice.reduce((a, b) => a + b, 0) / len;
    const stockMean = stockSlice.reduce((a, b) => a + b, 0) / len;
    let cov = 0, spyVar = 0;
    for (let i = 0; i < len; i++) {
      cov += (stockSlice[i] - stockMean) * (spySlice[i] - spyMean);
      spyVar += (spySlice[i] - spyMean) ** 2;
    }
    beta = spyVar > 0 ? cov / spyVar : null;
  }

  const latestSma20 = [...sma20].reverse().find((v) => v != null) ?? null;
  const latestSma50 = [...sma50].reverse().find((v) => v != null) ?? null;
  let signal = 'Neutral';
  if (latestSma20 != null && latestSma50 != null) {
    if (latestSma20 > latestSma50) signal = 'Bullish (SMA20 > SMA50)';
    else if (latestSma20 < latestSma50) signal = 'Bearish (SMA20 < SMA50)';
  }

  const rsiLatest = [...rsi14].reverse().find((v) => v != null) ?? null;

  return { first, latest, periodReturn, periodHigh, periodLow, avgVolume, annualizedReturn, annualizedVol, sharpe, maxDrawdown: maxDD, beta, latestSma20, latestSma50, signal, rsiLatest };
}

// ─── LLM calls ────────────────────────────────────────────────────────────────

async function callOpenRouter(apiKey, system, user) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-5',
      max_tokens: 1200,
      reasoning: { enabled: false },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!response.ok) throw new Error(`OpenRouter call failed. ${await readOpenRouterError(response)}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? 'No response.';
}

async function getResearchNote(stockData, apiKey) {
  const { ticker, priceData, metrics } = stockData;
  const m = metrics;
  const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
  const prompt =
    `${ticker} — ${priceData.length} trading days from ${m.first.date} to ${m.latest.date}.\n` +
    `Latest close: $${m.latest.close.toFixed(2)}. Period return: ${pct(m.periodReturn)}. ` +
    `Annualized return: ${pct(m.annualizedReturn)}. Annualized volatility: ${pct(m.annualizedVol)}.\n` +
    `Sharpe ratio: ${m.sharpe != null ? m.sharpe.toFixed(2) : 'n/a'}. Max drawdown: ${pct(m.maxDrawdown)}. ` +
    `Beta vs SPY: ${m.beta != null ? m.beta.toFixed(2) : 'n/a'}.\n` +
    `RSI(14): ${m.rsiLatest != null ? m.rsiLatest.toFixed(1) : 'n/a'}. SMA signal: ${m.signal}.\n\n` +
    `Write a concise one-paragraph research note covering price action, momentum, and risk profile.`;
  return callOpenRouter(apiKey, 'You are a concise financial research analyst. Be factual and specific.', prompt);
}

async function getComparisonNote(stockDataArr, rfRate, apiKey) {
  const lines = stockDataArr.map(({ ticker, metrics: m }) => {
    const pct = (v) => v != null ? `${(v * 100).toFixed(1)}%` : 'n/a';
    return `${ticker}: return ${pct(m.periodReturn)}, ann.return ${pct(m.annualizedReturn)}, ` +
      `vol ${pct(m.annualizedVol)}, Sharpe ${m.sharpe != null ? m.sharpe.toFixed(2) : 'n/a'}, ` +
      `max DD ${pct(m.maxDrawdown)}, beta ${m.beta != null ? m.beta.toFixed(2) : 'n/a'}, ` +
      `RSI ${m.rsiLatest != null ? m.rsiLatest.toFixed(0) : 'n/a'}, signal: ${m.signal}`;
  }).join('\n');
  const prompt =
    `Comparison of ${stockDataArr.map((s) => s.ticker).join(', ')} — 130-day window. Risk-free rate: ${(rfRate * 100).toFixed(1)}%.\n\n${lines}\n\n` +
    `Write three short paragraphs: ` +
    `(1) which stock had the best risk-adjusted return and why, ` +
    `(2) what momentum signals (RSI, SMA) suggest about each, ` +
    `(3) key risk differences (volatility, drawdown, beta).`;
  return callOpenRouter(apiKey, 'You are a concise equity research analyst. Compare stocks objectively.', prompt);
}

async function getEarningsNote(ticker, earningsData, apiKey) {
  const { meta, sentiment, key_figures, forward_looking } = earningsData;
  const companyDensity = sentiment.by_role.find((r) => r.role_group === 'Company')?.sentiment_density ?? 0;
  const analystDensity = sentiment.by_role.find((r) => r.role_group === 'Analyst')?.sentiment_density ?? 0;
  const figureLines = key_figures.slice(0, 8).map((f) => `• ${f.figure} — ${f.metric}`).join('\n');
  const flsLines = forward_looking.slice(0, 6).map((f) => `[${f.speaker}] "${f.statement}"`).join('\n');
  const prompt =
    `Earnings call: ${ticker} ${meta.quarter} (${meta.report_date})\n\n` +
    `SENTIMENT: Overall ${sentiment.overall.label}. ${sentiment.overall.positive_count} positive phrases, ${sentiment.overall.negative_count} negative. ` +
    `Management density: ${companyDensity.toFixed(3)}, Analyst density: ${analystDensity.toFixed(3)}.\n\n` +
    `KEY FIGURES:\n${figureLines}\n\n` +
    `FORWARD-LOOKING STATEMENTS:\n${flsLines}\n\n` +
    `Write three paragraphs: (1) what the reported numbers reveal about business momentum, ` +
    `(2) what the tone gap between management and analysts signals, ` +
    `(3) the top risks and catalysts implied by the forward-looking statements. No investment advice.`;
  return callOpenRouter(apiKey, 'You are a concise equity research analyst writing for institutional clients.', prompt);
}

async function readOpenRouterError(response) {
  let message = '';
  try {
    const body = await response.json();
    const err = body.error ?? body;
    message = err.message || '';
    const provider = err.metadata?.provider_name;
    const raw = err.metadata?.raw;
    if (provider) message += ` [provider: ${provider}]`;
    if (raw) message += ` ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`;
  } catch { /* non-JSON */ }
  const hint = { 401: 'Invalid or missing API key', 402: 'Out of credits', 429: 'Rate limited' }[response.status];
  return [`(HTTP ${response.status})`, hint, message].filter(Boolean).join(' ');
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

function metricCardHtml(label, value, sub, valueClass) {
  return `<div class="metric-card">
    <span class="metric-label">${label}</span>
    <span class="metric-value${valueClass ? ' ' + valueClass : ''}">${value}</span>
    ${sub ? `<span class="metric-sub">${sub}</span>` : ''}
  </div>`;
}

function fmtPct(v, d = 1) {
  if (v == null) return '—';
  const s = (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
  return s;
}

function fmtNum(v, d = 2) {
  return v != null ? v.toFixed(d) : '—';
}

function signClass(v) {
  if (v == null) return 'muted';
  return v >= 0 ? 'positive' : 'negative';
}

// ─── Single ticker rendering ──────────────────────────────────────────────────

function renderSingle(stockData, note, earningsNote) {
  const { ticker, priceData, sma20, sma50, rsi14, metrics: m } = stockData;

  const rsiClass = m.rsiLatest == null ? 'muted' : m.rsiLatest > 70 ? 'warn' : m.rsiLatest < 30 ? 'positive' : 'muted';
  const rsiSub = m.rsiLatest == null ? '' : m.rsiLatest > 70 ? 'overbought' : m.rsiLatest < 30 ? 'oversold' : 'neutral';
  const sharpeClass = m.sharpe == null ? 'muted' : m.sharpe > 1 ? 'positive' : m.sharpe < 0 ? 'negative' : 'muted';
  const signalClass = m.signal.startsWith('Bullish') ? 'positive' : m.signal.startsWith('Bearish') ? 'negative' : 'muted';

  const cards = [
    metricCardHtml('Current price', `$${m.latest.close.toFixed(2)}`, `open $${m.first.close.toFixed(2)}`, 'muted'),
    metricCardHtml('Period high', `$${m.periodHigh.toFixed(2)}`, `${priceData.length}-day high`, 'positive'),
    metricCardHtml('Period low', `$${m.periodLow.toFixed(2)}`, `${priceData.length}-day low`, 'negative'),
    metricCardHtml('Period return', fmtPct(m.periodReturn), `${priceData.length} days`, signClass(m.periodReturn)),
    metricCardHtml('Ann. return', fmtPct(m.annualizedReturn), 'annualized', signClass(m.annualizedReturn)),
    metricCardHtml('Volatility', fmtPct(m.annualizedVol), 'annualized', 'muted'),
    metricCardHtml('Sharpe ratio', fmtNum(m.sharpe), `rf ${(document.getElementById('rfrate').value || '4.5')}%`, sharpeClass),
    metricCardHtml('Max drawdown', fmtPct(m.maxDrawdown), 'peak to trough', 'negative'),
    metricCardHtml('Beta', fmtNum(m.beta), 'vs SPY', 'muted'),
    metricCardHtml('RSI (14)', m.rsiLatest != null ? m.rsiLatest.toFixed(1) : '—', rsiSub, rsiClass),
    metricCardHtml('SMA signal', m.signal, `SMA20 ${m.latestSma20 != null ? '$' + m.latestSma20.toFixed(2) : '—'} · SMA50 ${m.latestSma50 != null ? '$' + m.latestSma50.toFixed(2) : '—'}`, signalClass)
  ].join('');

  results.innerHTML = `
    <div class="ticker-header">
      <h2>${ticker} <span class="latest-price">$${m.latest.close.toFixed(2)}</span></h2>
      <span class="date-range">${m.first.date} – ${m.latest.date} · ${priceData.length} days</span>
    </div>
    <div class="metrics-grid">${cards}</div>
    <div class="chart-panel">
      <canvas id="price-chart" class="chart-canvas"></canvas>
      <div class="legend">
        <span><i class="dot dot-close"></i>Close</span>
        <span><i class="dot dot-sma20"></i>SMA 20</span>
        <span><i class="dot dot-sma50"></i>SMA 50</span>
      </div>
    </div>
    <div class="rsi-panel">
      <canvas id="rsi-chart" class="rsi-canvas"></canvas>
      <div class="rsi-legend">RSI(14) · <span class="rsi-oversold">oversold &lt;30</span> · <span class="rsi-overbought">overbought &gt;70</span></div>
    </div>
    <div class="note-panel">
      <h3>Price action note</h3>
      <p class="note">${note}</p>
      <p class="disclaimer">AI-generated summary based on price data above — not financial advice.</p>
    </div>
    ${stockData.earningsData ? renderEarningsPanel(stockData.earningsData, earningsNote) : ''}
  `;

  drawPriceChart(document.getElementById('price-chart'), priceData, sma20, sma50);
  drawRSIChart(document.getElementById('rsi-chart'), rsi14);
}

// ─── Comparison rendering ─────────────────────────────────────────────────────

function renderComparison(stockDataArr, note) {
  const tickers = stockDataArr.map((s) => s.ticker);

  // Table
  const thead = `<tr>
    <th>Ticker</th>
    <th>Price</th>
    <th>Return</th>
    <th>Ann. Return</th>
    <th>Volatility</th>
    <th>Sharpe</th>
    <th>Max DD</th>
    <th>Beta</th>
    <th>RSI</th>
  </tr>`;

  const tbody = stockDataArr.map(({ ticker, metrics: m }, idx) => {
    const color = TICKER_COLORS[idx];
    const rsiClass = m.rsiLatest == null ? '' : m.rsiLatest > 70 ? ' class="warn"' : m.rsiLatest < 30 ? ' class="positive"' : '';
    const sharpeClass = m.sharpe == null ? '' : m.sharpe > 1 ? ' class="positive"' : m.sharpe < 0 ? ' class="negative"' : '';
    return `<tr>
      <td><span class="ticker-dot" style="background:${color}"></span>${ticker}</td>
      <td class="muted">$${m.latest.close.toFixed(2)}</td>
      <td class="${signClass(m.periodReturn)}">${fmtPct(m.periodReturn)}</td>
      <td class="${signClass(m.annualizedReturn)}">${fmtPct(m.annualizedReturn)}</td>
      <td>${fmtPct(m.annualizedVol)}</td>
      <td${sharpeClass}>${fmtNum(m.sharpe)}</td>
      <td class="negative">${fmtPct(m.maxDrawdown)}</td>
      <td>${fmtNum(m.beta)}</td>
      <td${rsiClass}>${m.rsiLatest != null ? m.rsiLatest.toFixed(0) : '—'}</td>
    </tr>`;
  }).join('');

  // Correlation matrix (clean returns, aligned length)
  const returnArrays = stockDataArr.map((s) => s.returns.filter((r) => r !== null));
  const minLen = Math.min(...returnArrays.map((r) => r.length));
  const aligned = returnArrays.map((r) => r.slice(r.length - minLen));

  let corrHtml = '';
  if (stockDataArr.length >= 2) {
    const corrHeader = `<tr><th></th>${tickers.map((t) => `<th>${t}</th>`).join('')}</tr>`;
    const corrRows = tickers.map((rowTicker, i) => {
      const cells = tickers.map((_, j) => {
        const corr = pearsonCorrelation(aligned[i], aligned[j]);
        const val = corr != null ? corr.toFixed(2) : '—';
        let bg = '';
        if (corr != null) {
          if (i === j) bg = `style="background:rgba(217,89,38,0.3)"`;
          else if (corr > 0.7) bg = `style="background:rgba(217,89,38,0.2);color:var(--error)"`;
          else if (corr > 0.4) bg = `style="background:rgba(244,185,66,0.15);color:#f4b942"`;
          else bg = `style="background:rgba(12,163,12,0.1);color:var(--positive)"`;
        }
        return `<td ${bg}>${val}</td>`;
      }).join('');
      return `<tr><th>${rowTicker}</th>${cells}</tr>`;
    }).join('');
    corrHtml = `
      <div class="corr-panel">
        <h4 class="section-title">Return Correlation</h4>
        <div class="table-wrap">
          <table class="corr-table">
            <thead>${corrHeader}</thead>
            <tbody>${corrRows}</tbody>
          </table>
        </div>
      </div>`;
  }

  // Legend
  const legendItems = stockDataArr.map(({ ticker }, idx) =>
    `<span><i class="dot" style="background:${TICKER_COLORS[idx]};display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:0.35rem;vertical-align:middle"></i>${ticker}</span>`
  ).join('');

  results.innerHTML = `
    <h2 class="comparison-title">${tickers.join(' · ')}</h2>
    <div class="table-wrap">
      <table class="comparison-table">
        <thead>${thead}</thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
    <div class="chart-panel">
      <p class="chart-label">Normalized performance (100 = period start)</p>
      <canvas id="comparison-chart" class="chart-canvas"></canvas>
      <div class="legend">${legendItems}</div>
    </div>
    ${corrHtml}
    <div class="note-panel">
      <h3>Comparative analysis</h3>
      <p class="note">${note}</p>
      <p class="disclaimer">AI-generated comparison based on price data above — not financial advice.</p>
    </div>
  `;

  drawComparisonChart(document.getElementById('comparison-chart'), stockDataArr);
}

// ─── Earnings panel ───────────────────────────────────────────────────────────

function renderEarningsPanel(earningsData, earningsNote) {
  const { meta, sentiment, key_figures, forward_looking } = earningsData;

  const total = sentiment.overall.positive_count + sentiment.overall.negative_count;
  const posWidth = total > 0 ? Math.round((sentiment.overall.positive_count / total) * 100) : 50;
  const labelClass = sentiment.overall.label === 'positive' ? 'positive' : sentiment.overall.label === 'negative' ? 'negative' : '';
  const companyDensity = sentiment.by_role.find((r) => r.role_group === 'Company')?.sentiment_density ?? 0;
  const analystDensity = sentiment.by_role.find((r) => r.role_group === 'Analyst')?.sentiment_density ?? 0;
  const densityRatio = analystDensity !== 0 ? (companyDensity / Math.abs(analystDensity)).toFixed(0) : '—';

  const sentimentHtml = `
    <div class="earnings-section">
      <h4 class="earnings-section-title">Call Sentiment</h4>
      <div class="sentiment-bar-wrap">
        <div class="sentiment-bar"><div class="sentiment-bar-fill" style="width:${posWidth}%"></div></div>
        <p class="sentiment-meta">
          <span class="sentiment-count positive-count">${sentiment.overall.positive_count} positive</span>
          &nbsp;/&nbsp;
          <span class="sentiment-count negative-count">${sentiment.overall.negative_count} negative</span>
          &nbsp;·&nbsp; net <strong class="${labelClass}">${sentiment.overall.label}</strong>
        </p>
        <p class="sentiment-meta muted">Management density ${companyDensity.toFixed(3)} · Analyst density ${analystDensity.toFixed(3)} · Management ${densityRatio}× more positive</p>
      </div>
    </div>`;

  const figureCards = key_figures.map((f) => `
    <div class="metric-card">
      <span class="metric-label">${f.metric}</span>
      <span class="metric-value muted">${f.figure}</span>
      ${f.sub ? `<span class="metric-sub">${f.sub}</span>` : ''}
    </div>`).join('');

  const figuresHtml = `
    <div class="earnings-section">
      <h4 class="earnings-section-title">Reported Figures</h4>
      <div class="metrics-grid">${figureCards}</div>
    </div>`;

  const flsItems = forward_looking.map((f) => `
    <li class="fls-item">
      <span class="fls-speaker">${f.speaker}</span>
      <span class="fls-text">"${f.statement}"</span>
    </li>`).join('');

  const flsHtml = `
    <div class="earnings-section">
      <h4 class="earnings-section-title">Management Guidance &amp; Outlook</h4>
      <ul class="fls-list">${flsItems}</ul>
    </div>`;

  const noteHtml = earningsNote ? `
    <div class="earnings-section">
      <h4 class="earnings-section-title">Earnings Analysis</h4>
      <p class="note">${earningsNote}</p>
      <p class="disclaimer">AI analysis of pre-computed earnings call data (R pipeline · ${meta.quarter} · ${meta.report_date}) — not financial advice.</p>
    </div>` : '';

  return `
    <div class="earnings-panel">
      <div class="earnings-header">
        <h3>Earnings Intelligence</h3>
        <span class="earnings-badge">${meta.quarter} · ${meta.report_date}</span>
      </div>
      ${sentimentHtml}
      ${figuresHtml}
      ${flsHtml}
      ${noteHtml}
    </div>`;
}

// ─── Charts ───────────────────────────────────────────────────────────────────

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawPriceChart(canvas, priceData, sma20, sma50) {
  const s = setupCanvas(canvas);
  if (!s) return;
  const { ctx, width, height } = s;
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 16, right: 12, bottom: 26, left: 60 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const closes = priceData.map((b) => b.close);
  const allV = [...closes, ...sma20, ...sma50].filter((v) => v != null);
  const minV = Math.min(...allV);
  const maxV = Math.max(...allV);
  const vpad = (maxV - minV) * 0.08 || 1;
  const yMin = minV - vpad;
  const yMax = maxV + vpad;

  const n = priceData.length;
  const xStep = n > 1 ? cw / (n - 1) : 0;
  const xAt = (i) => pad.left + i * xStep;
  const yAt = (v) => pad.top + ch * (1 - (v - yMin) / (yMax - yMin));

  ctx.strokeStyle = '#2c2c2a';
  ctx.fillStyle = '#898781';
  ctx.font = '11px Menlo, "Courier New", monospace';
  ctx.lineWidth = 1;
  for (let s = 0; s <= 4; s++) {
    const v = yMin + (yMax - yMin) * (s / 4);
    const y = yAt(v);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillText(`$${v.toFixed(2)}`, 4, y + 4);
  }

  const xTicks = Math.min(6, n - 1);
  for (let t = 0; t <= xTicks; t++) {
    const i = Math.round((n - 1) * (t / xTicks));
    ctx.fillText(priceData[i].date.slice(5), Math.max(pad.left, xAt(i) - 18), height - 6);
  }

  function drawLine(values, color, lw) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = lw;
    let started = false;
    values.forEach((v, i) => {
      if (v == null) return;
      if (!started) { ctx.moveTo(xAt(i), yAt(v)); started = true; } else { ctx.lineTo(xAt(i), yAt(v)); }
    });
    ctx.stroke();
  }

  drawLine(closes, '#f2f2f0', 2);
  drawLine(sma20, '#d95926', 1.5);
  drawLine(sma50, '#e66767', 1.5);
}

function drawRSIChart(canvas, rsi14) {
  const s = setupCanvas(canvas);
  if (!s) return;
  const { ctx, width, height } = s;
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 8, right: 48, bottom: 20, left: 36 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const yAt = (v) => pad.top + ch * (1 - v / 100);
  const validIdx = rsi14.map((v, i) => v != null ? i : -1).filter((i) => i >= 0);
  if (!validIdx.length) return;

  const n = rsi14.length;
  const xStep = n > 1 ? cw / (n - 1) : 0;
  const xAt = (i) => pad.left + i * xStep;

  // Zones
  ctx.fillStyle = 'rgba(230,103,103,0.08)';
  ctx.fillRect(pad.left, yAt(100), cw, yAt(70) - yAt(100));
  ctx.fillStyle = 'rgba(12,163,12,0.08)';
  ctx.fillRect(pad.left, yAt(30), cw, yAt(0) - yAt(30));

  // Reference lines
  ctx.strokeStyle = '#2c2c2a';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  [30, 70].forEach((level) => {
    const y = yAt(level);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
  });
  ctx.setLineDash([]);

  // Y labels
  ctx.fillStyle = '#898781';
  ctx.font = '10px Menlo, "Courier New", monospace';
  [0, 30, 70, 100].forEach((level) => {
    ctx.fillText(String(level), 4, yAt(level) + 4);
  });

  // X date labels
  const xTicks = Math.min(4, validIdx.length - 1);
  for (let t = 0; t <= xTicks; t++) {
    const idx = validIdx[Math.round((validIdx.length - 1) * (t / xTicks))];
    ctx.fillText(rsi14[idx] != null ? String(idx) : '', Math.max(pad.left, xAt(idx) - 12), height - 4);
  }

  // RSI line
  ctx.beginPath();
  ctx.strokeStyle = '#4e9af1';
  ctx.lineWidth = 1.5;
  let started = false;
  rsi14.forEach((v, i) => {
    if (v == null) return;
    if (!started) { ctx.moveTo(xAt(i), yAt(v)); started = true; } else { ctx.lineTo(xAt(i), yAt(v)); }
  });
  ctx.stroke();

  // Current RSI value label
  const lastRsi = rsi14[rsi14.length - 1] ?? [...rsi14].reverse().find((v) => v != null);
  if (lastRsi != null) {
    ctx.fillStyle = '#4e9af1';
    ctx.font = 'bold 11px Menlo, "Courier New", monospace';
    ctx.fillText(lastRsi.toFixed(1), width - pad.right + 4, yAt(lastRsi) + 4);
  }
}

function drawComparisonChart(canvas, stockDataArr) {
  const s = setupCanvas(canvas);
  if (!s) return;
  const { ctx, width, height } = s;
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 16, right: 80, bottom: 26, left: 50 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  // Normalize: each series starts at 100
  const series = stockDataArr.map(({ priceData }) =>
    priceData.map((b) => (b.close / priceData[0].close) * 100)
  );

  const allV = series.flat();
  const minV = Math.min(...allV);
  const maxV = Math.max(...allV);
  const vpad = (maxV - minV) * 0.08 || 1;
  const yMin = minV - vpad;
  const yMax = maxV + vpad;

  const n = Math.max(...stockDataArr.map((s) => s.priceData.length));
  const xStep = n > 1 ? cw / (n - 1) : 0;
  const xAt = (i) => pad.left + i * xStep;
  const yAt = (v) => pad.top + ch * (1 - (v - yMin) / (yMax - yMin));

  // Grid lines and labels
  ctx.strokeStyle = '#2c2c2a';
  ctx.fillStyle = '#898781';
  ctx.font = '11px Menlo, "Courier New", monospace';
  ctx.lineWidth = 1;
  for (let step = 0; step <= 4; step++) {
    const v = yMin + (yMax - yMin) * (step / 4);
    const y = yAt(v);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillText(v.toFixed(0), 4, y + 4);
  }

  // 100 baseline
  if (yMin < 100 && yMax > 100) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.left, yAt(100)); ctx.lineTo(width - pad.right, yAt(100)); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Date labels from first series
  const ref = stockDataArr[0].priceData;
  const xTicks = Math.min(6, ref.length - 1);
  ctx.fillStyle = '#898781';
  for (let t = 0; t <= xTicks; t++) {
    const i = Math.round((ref.length - 1) * (t / xTicks));
    ctx.fillText(ref[i].date.slice(5), Math.max(pad.left, xAt(i) - 18), height - 6);
  }

  // Series lines + end labels
  series.forEach((vals, idx) => {
    const color = TICKER_COLORS[idx];
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    vals.forEach((v, i) => {
      if (i === 0) ctx.moveTo(xAt(i), yAt(v)); else ctx.lineTo(xAt(i), yAt(v));
    });
    ctx.stroke();

    const lastVal = vals[vals.length - 1];
    ctx.fillStyle = color;
    ctx.font = 'bold 11px Menlo, "Courier New", monospace';
    ctx.fillText(stockDataArr[idx].ticker, width - pad.right + 6, yAt(lastVal) + 4);
  });
}
