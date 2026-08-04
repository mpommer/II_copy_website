// GenAI Finance course — Stock Dashboard
// API keys are entered at runtime; nothing secret is committed here.

const form = document.getElementById('ticker-form');
const results = document.getElementById('results');

// Tickers that have pre-computed earnings JSON in public/data/
const EARNINGS_TICKERS = new Set(['AAPL']);

// Holds the most recently rendered chart's data for resize redraws.
let lastChartData = null;

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  const twelveDataKey = document.getElementById('twelvedata-key').value.trim();
  const openRouterKey = document.getElementById('openrouter-key').value.trim();

  const hasEarnings = EARNINGS_TICKERS.has(ticker);
  results.innerHTML = `<p class="status-loading">Fetching price history${hasEarnings ? ' and earnings data' : ''}…</p>`;

  try {
    // Step 1: price + earnings data in parallel
    const [priceData, earningsData] = await Promise.all([
      fetchPriceData(ticker, twelveDataKey),
      fetchEarningsData(ticker)
    ]);

    const sma20 = calculateSMA(priceData, 20);
    const sma50 = calculateSMA(priceData, 50);
    const stats = computeStats(priceData, sma20, sma50);

    results.innerHTML = `<p class="status-loading">Generating research note${earningsData ? ' and earnings analysis' : ''}…</p>`;

    // Step 2: both LLM calls in parallel
    const calls = [getResearchNote(ticker, priceData, stats, openRouterKey)];
    if (earningsData) calls.push(getEarningsNote(ticker, earningsData, openRouterKey));
    const [note, earningsNote] = await Promise.all(calls);

    renderResults(ticker, priceData, sma20, sma50, stats, note, earningsData, earningsNote ?? null);
  } catch (err) {
    results.innerHTML = `<div class="alert"><strong>Something went wrong.</strong> ${err.message}</div>`;
  }
});

window.addEventListener('resize', () => {
  if (!lastChartData) return;
  const canvas = document.getElementById('price-chart');
  if (canvas) drawChart(canvas, lastChartData.priceData, lastChartData.sma20, lastChartData.sma50);
});

// ─── Price data ───────────────────────────────────────────────────────────────

async function fetchPriceData(ticker, apiKey) {
  const url = `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&outputsize=130&apikey=${apiKey}`;
  const response = await fetch(url);
  const body = await response.text();
  let raw;
  try { raw = JSON.parse(body); } catch { throw new Error(body.trim() || 'Price fetch failed'); }
  if (raw && raw.status === 'error') throw new Error(raw.message || 'Price fetch failed');
  if (!response.ok) throw new Error('Price fetch failed');
  const values = raw.values ?? [];
  if (!values.length) throw new Error(`No price data returned for ${ticker}`);
  return values
    .map((b) => ({ date: b.datetime, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ─── Earnings data (pre-computed JSON from R pipeline) ────────────────────────

async function fetchEarningsData(ticker) {
  if (!EARNINGS_TICKERS.has(ticker)) return null;
  try {
    const response = await fetch(`./data/${ticker}.json`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ─── Technical indicators ─────────────────────────────────────────────────────

function calculateSMA(priceData, window) {
  return priceData.map((_, i, arr) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += arr[j].close;
    return sum / window;
  });
}

function computeStats(priceData, sma20, sma50) {
  const first = priceData[0];
  const latest = priceData[priceData.length - 1];
  const change = latest.close - first.close;
  const pctChange = (change / first.close) * 100;
  const periodHigh = Math.max(...priceData.map((b) => b.high));
  const periodLow = Math.min(...priceData.map((b) => b.low));
  const avgVolume = priceData.reduce((sum, b) => sum + b.volume, 0) / priceData.length;
  const latestSma20 = [...sma20].reverse().find((v) => v != null) ?? null;
  const latestSma50 = [...sma50].reverse().find((v) => v != null) ?? null;
  let signal = 'Not enough history yet';
  if (latestSma20 != null && latestSma50 != null) {
    if (latestSma20 > latestSma50) signal = 'Bullish (SMA20 above SMA50)';
    else if (latestSma20 < latestSma50) signal = 'Bearish (SMA20 below SMA50)';
    else signal = 'Neutral (SMA20 = SMA50)';
  }
  return { first, latest, change, pctChange, periodHigh, periodLow, avgVolume, latestSma20, latestSma50, signal };
}

// ─── LLM calls ────────────────────────────────────────────────────────────────

async function getResearchNote(ticker, priceData, stats, apiKey) {
  const summary =
    `${ticker} daily closes from ${stats.first.date} to ${stats.latest.date}: ` +
    `start $${stats.first.close.toFixed(2)}, latest $${stats.latest.close.toFixed(2)}, ` +
    `change ${stats.pctChange.toFixed(1)}% over ${priceData.length} trading days. ` +
    `Period range $${stats.periodLow.toFixed(2)}–$${stats.periodHigh.toFixed(2)}. ` +
    `20-day SMA ${stats.latestSma20 != null ? '$' + stats.latestSma20.toFixed(2) : 'n/a'}, ` +
    `50-day SMA ${stats.latestSma50 != null ? '$' + stats.latestSma50.toFixed(2) : 'n/a'} (${stats.signal}).`;

  return callOpenRouter(apiKey, {
    system: 'You are a financial research assistant. Be concise and factual.',
    user: `${summary}\n\nWrite a one paragraph research note for ${ticker} based on this recent price action and the moving averages.`
  });
}

async function getEarningsNote(ticker, earningsData, apiKey) {
  const { meta, sentiment, key_figures, forward_looking } = earningsData;

  const companyDensity = sentiment.by_role.find((r) => r.role_group === 'Company')?.sentiment_density ?? 0;
  const analystDensity = sentiment.by_role.find((r) => r.role_group === 'Analyst')?.sentiment_density ?? 0;

  const figureLines = key_figures.slice(0, 8).map((f) => `• ${f.figure} — ${f.metric}`).join('\n');
  const flsLines = forward_looking.slice(0, 6).map((f) => `[${f.speaker}] "${f.statement}"`).join('\n');

  const prompt =
    `Earnings call: ${ticker} ${meta.quarter} (${meta.report_date})\n\n` +
    `SENTIMENT: Overall ${sentiment.overall.label}. ` +
    `${sentiment.overall.positive_count} positive phrases, ${sentiment.overall.negative_count} negative. ` +
    `Management tone density: ${companyDensity.toFixed(3)}, Analyst tone density: ${analystDensity.toFixed(3)}.\n\n` +
    `KEY FIGURES:\n${figureLines}\n\n` +
    `MANAGEMENT FORWARD-LOOKING STATEMENTS:\n${flsLines}\n\n` +
    `Write a three-paragraph earnings intelligence note: ` +
    `(1) what the reported numbers reveal about business momentum, ` +
    `(2) what the tone gap between management and analysts signals, ` +
    `(3) the top risks and catalysts implied by the forward-looking statements. ` +
    `Be concise and specific. No investment advice.`;

  return callOpenRouter(apiKey, {
    system: 'You are a concise equity research analyst writing for institutional clients.',
    user: prompt
  });
}

async function callOpenRouter(apiKey, { system, user }) {
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
  } catch { /* non-JSON body; status code below still says something */ }
  const hint = { 401: 'Your API key looks invalid or missing', 402: 'This model is paid and your OpenRouter account is out of credits', 429: 'Rate limited, wait a moment and try again' }[response.status];
  return [`(HTTP ${response.status})`, hint, message].filter(Boolean).join(' ');
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function statCardHtml(label, value, sub, valueClass) {
  return `
    <div class="stat-card">
      <span class="stat-label">${label}</span>
      <span class="stat-value${valueClass ? ' ' + valueClass : ''}">${value}</span>
      ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
    </div>`;
}

function renderResults(ticker, priceData, sma20, sma50, stats, note, earningsData, earningsNote) {
  const changeSign = stats.change >= 0 ? '+' : '';
  const changeClass = stats.change >= 0 ? 'positive' : 'negative';

  const cards = [
    statCardHtml('Latest close', `$${stats.latest.close.toFixed(2)}`, stats.latest.date),
    statCardHtml('Change (period)', `${changeSign}${stats.change.toFixed(2)} (${changeSign}${stats.pctChange.toFixed(1)}%)`, `${priceData.length} trading days`, changeClass),
    statCardHtml('Period high / low', `$${stats.periodHigh.toFixed(2)} / $${stats.periodLow.toFixed(2)}`),
    statCardHtml('SMA 20 / SMA 50', `${stats.latestSma20 != null ? '$' + stats.latestSma20.toFixed(2) : '—'} / ${stats.latestSma50 != null ? '$' + stats.latestSma50.toFixed(2) : '—'}`),
    statCardHtml('Signal', stats.signal),
    statCardHtml('Avg. volume', Math.round(stats.avgVolume).toLocaleString())
  ].join('');

  results.innerHTML = `
    <h2>${ticker}</h2>
    <div class="stat-grid">${cards}</div>
    <div class="chart-panel">
      <canvas id="price-chart" class="chart-canvas"></canvas>
      <div class="legend">
        <span><i class="dot dot-close"></i>Close</span>
        <span><i class="dot dot-sma20"></i>SMA 20</span>
        <span><i class="dot dot-sma50"></i>SMA 50</span>
      </div>
    </div>
    <div class="note-panel">
      <h3>Price action note</h3>
      <p class="note">${note}</p>
      <p class="disclaimer">AI-generated summary based on the price data above — not financial advice.</p>
    </div>
    ${earningsData ? renderEarningsPanel(earningsData, earningsNote) : ''}
  `;

  lastChartData = { priceData, sma20, sma50 };
  drawChart(document.getElementById('price-chart'), priceData, sma20, sma50);
}

function renderEarningsPanel(earningsData, earningsNote) {
  const { meta, sentiment, key_figures, forward_looking } = earningsData;

  // Sentiment bar
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
        <div class="sentiment-bar">
          <div class="sentiment-bar-fill" style="width:${posWidth}%"></div>
        </div>
        <p class="sentiment-meta">
          <span class="sentiment-count positive-count">${sentiment.overall.positive_count} positive</span>
          &nbsp;/&nbsp;
          <span class="sentiment-count negative-count">${sentiment.overall.negative_count} negative</span>
          &nbsp;·&nbsp; net <strong class="${labelClass}">${sentiment.overall.label}</strong>
        </p>
        <p class="sentiment-meta muted">Management density ${companyDensity.toFixed(3)} · Analyst density ${analystDensity.toFixed(3)} · Management ${densityRatio}× more positive</p>
      </div>
    </div>`;

  // Key figures as cards
  const figureCards = key_figures.map((f) => statCardHtml(f.metric, f.figure, f.sub ?? '')).join('');
  const figuresHtml = `
    <div class="earnings-section">
      <h4 class="earnings-section-title">Reported Figures</h4>
      <div class="stat-grid">${figureCards}</div>
    </div>`;

  // Forward-looking statements (Company speakers only)
  const companyFls = forward_looking.filter((f) => !f.role_group || f.role_group === 'Company');
  const flsItems = companyFls.map((f) => `
    <li class="fls-item">
      <span class="fls-speaker">${f.speaker}</span>
      <span class="fls-text">"${f.statement}"</span>
    </li>`).join('');
  const flsHtml = `
    <div class="earnings-section">
      <h4 class="earnings-section-title">Management Guidance &amp; Outlook</h4>
      <ul class="fls-list">${flsItems}</ul>
    </div>`;

  // LLM earnings note
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

// ─── Canvas chart ─────────────────────────────────────────────────────────────

function drawChart(canvas, priceData, sma20, sma50) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 16, right: 12, bottom: 26, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const closes = priceData.map((b) => b.close);
  const allValues = [...closes, ...sma20, ...sma50].filter((v) => v != null);
  const minV = Math.min(...allValues);
  const maxV = Math.max(...allValues);
  const pad = (maxV - minV) * 0.08 || 1;
  const yMin = minV - pad;
  const yMax = maxV + pad;

  const n = priceData.length;
  const xStep = n > 1 ? chartWidth / (n - 1) : 0;
  const xAt = (i) => padding.left + i * xStep;
  const yAt = (v) => padding.top + chartHeight * (1 - (v - yMin) / (yMax - yMin));

  ctx.strokeStyle = '#2c2c2a';
  ctx.fillStyle = '#898781';
  ctx.font = '11px Menlo, "Courier New", monospace';
  ctx.lineWidth = 1;
  const ySteps = 4;
  for (let s = 0; s <= ySteps; s++) {
    const v = yMin + (yMax - yMin) * (s / ySteps);
    const y = yAt(v);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(`$${v.toFixed(2)}`, 4, y + 4);
  }

  const xTicks = Math.min(6, n - 1);
  for (let t = 0; t <= xTicks; t++) {
    const i = Math.round((n - 1) * (t / xTicks));
    const x = xAt(i);
    ctx.fillText(priceData[i].date.slice(5), Math.max(padding.left, x - 18), height - 6);
  }

  function drawLine(values, color, lineWidth) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    let started = false;
    values.forEach((v, i) => {
      if (v == null) return;
      const x = xAt(i);
      const y = yAt(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
  }

  drawLine(closes, '#f2f2f0', 2);
  drawLine(sma20, '#d95926', 1.5);
  drawLine(sma50, '#e66767', 1.5);
}