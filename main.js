// GenAI Finance course, starter scaffold.
// This file intentionally does very little. Build on it during class.
//
// No API keys are stored in this file. Both the Twelve Data key and the
// OpenRouter key are entered in the form fields at run time, so nothing secret
// is ever committed to your public repo or shipped in the source.

const form = document.getElementById('ticker-form');
const results = document.getElementById('results');

// Holds the most recently rendered chart's data, so the chart can be redrawn
// on window resize without refetching anything.
let lastChartData = null;

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  const twelveDataKey = document.getElementById('twelvedata-key').value.trim();
  const openRouterKey = document.getElementById('openrouter-key').value.trim();

  results.innerHTML = '<p>Loading...</p>';

  try {
    const priceData = await fetchPriceData(ticker, twelveDataKey);
    const sma20 = calculateSMA(priceData, 20);
    const sma50 = calculateSMA(priceData, 50);
    const stats = computeStats(priceData, sma20, sma50);
    const note = await getResearchNote(ticker, priceData, stats, openRouterKey);
    renderResults(ticker, priceData, sma20, sma50, stats, note);
  } catch (err) {
    results.innerHTML = `<p class="error">Something went wrong: ${err.message}</p>`;
  }
});

window.addEventListener('resize', () => {
  if (!lastChartData) return;
  const canvas = document.getElementById('price-chart');
  if (canvas) drawChart(canvas, lastChartData.priceData, lastChartData.sma20, lastChartData.sma50);
});

// Twelve Data daily price history.
// This endpoint sends CORS headers, so it works directly from the browser.
// The free plan covers all US equities and ETFs (no ticker whitelist).
// Returns an array of daily bars sorted oldest to newest, each shaped as
// { date, open, high, low, close, volume } with numeric values.
async function fetchPriceData(ticker, apiKey) {
  // outputsize is the number of most-recent bars. 130 trading days is about
  // 6 months, which leaves enough history for a 50-day moving average to be
  // defined for the second half of the chart. Max allowed is 5000.
  const url = `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&outputsize=130&apikey=${apiKey}`;
  const response = await fetch(url);

  // Read the body as text first, then parse it safely, so an unexpected
  // non-JSON response gives a readable error instead of "Unexpected token".
  const body = await response.text();
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(body.trim() || 'Price fetch failed');
  }

  // Twelve Data reports problems as { code, status: "error", message }.
  if (raw && raw.status === 'error') throw new Error(raw.message || 'Price fetch failed');
  if (!response.ok) throw new Error('Price fetch failed');

  // Successful responses look like { meta, values: [ { datetime, open, ... } ] },
  // newest first. Normalize to numbers and sort oldest to newest so indicator
  // math (moving averages, RSI, ...) reads left to right.
  const values = raw.values ?? [];
  if (!values.length) throw new Error(`No price data returned for ${ticker}`);

  return values
    .map((b) => ({
      date: b.datetime,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume)
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Simple moving average of closing price over `window` trading days.
// Returns an array the same length as priceData; entries before there is
// enough history are null so the chart can skip them cleanly.
function calculateSMA(priceData, window) {
  return priceData.map((_, i, arr) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += arr[j].close;
    return sum / window;
  });
}

// Pulls the headline numbers out of the price series and moving averages so
// the stat cards and the research note prompt can both read from one place.
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

// OpenRouter call. The price data and moving averages above are summarized
// and handed to the model so the note reflects the actual numbers you
// fetched. Replace the model, prompt, and system prompt with whatever you
// designed in the Prompt Engineering session.
async function getResearchNote(ticker, priceData, stats, apiKey) {
  const summary =
    `${ticker} daily closes from ${stats.first.date} to ${stats.latest.date}: ` +
    `start $${stats.first.close.toFixed(2)}, latest $${stats.latest.close.toFixed(2)}, ` +
    `change ${stats.pctChange.toFixed(1)}% over ${priceData.length} trading days. ` +
    `Period range $${stats.periodLow.toFixed(2)}-$${stats.periodHigh.toFixed(2)}. ` +
    `20-day SMA ${stats.latestSma20 != null ? '$' + stats.latestSma20.toFixed(2) : 'n/a'}, ` +
    `50-day SMA ${stats.latestSma50 != null ? '$' + stats.latestSma50.toFixed(2) : 'n/a'} (${stats.signal}).`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-5',
      // Sonnet 5 is a reasoning model. If max_tokens is too small to also cover
      // its reasoning tokens, the request is rejected with a 400 "Provider
      // returned error". This note is short, so turn reasoning off and leave
      // comfortable headroom for the reply.
      max_tokens: 2000,
      reasoning: { enabled: false },
      messages: [
        { role: 'system', content: 'You are a financial research assistant. Be concise and factual.' },
        { role: 'user', content: `${summary}\n\nWrite a one paragraph research note for ${ticker} based on this recent price action and the moving averages.` }
      ]
    })
  });
  // Surface what OpenRouter actually said, so a failed call tells you the real
  // reason (bad key, no credits, rate limit, provider error) instead of a
  // generic message you cannot act on.
  if (!response.ok) throw new Error(`OpenRouter call failed. ${await readOpenRouterError(response)}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? 'No response.';
}

// Pulls the useful part out of an OpenRouter error response: the HTTP status,
// a plain-language hint for the common cases, and the message OpenRouter (or
// the upstream provider) actually returned.
async function readOpenRouterError(response) {
  let message = '';
  try {
    const body = await response.json();
    const err = body.error ?? body;
    message = err.message || '';
    // On a "Provider returned error", the provider's own message is under
    // metadata rather than the top-level message field.
    const provider = err.metadata?.provider_name;
    const raw = err.metadata?.raw;
    if (provider) message += ` [provider: ${provider}]`;
    if (raw) message += ` ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`;
  } catch {
    // Response body was not JSON; the status code below still says something.
  }
  const hint = {
    401: 'Your API key looks invalid or missing',
    402: 'This model is paid and your OpenRouter account is out of credits',
    429: 'Rate limited, wait a moment and try again'
  }[response.status];
  return [`(HTTP ${response.status})`, hint, message].filter(Boolean).join(' ');
}

function statCardHtml(label, value, sub, valueClass) {
  return `
    <div class="stat-card">
      <span class="stat-label">${label}</span>
      <span class="stat-value${valueClass ? ' ' + valueClass : ''}">${value}</span>
      ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
    </div>
  `;
}

function renderResults(ticker, priceData, sma20, sma50, stats, note) {
  const changeSign = stats.change >= 0 ? '+' : '';
  const changeClass = stats.change >= 0 ? 'positive' : 'negative';

  const cards = [
    statCardHtml('Latest close', `$${stats.latest.close.toFixed(2)}`, stats.latest.date),
    statCardHtml(
      'Change (period)',
      `${changeSign}${stats.change.toFixed(2)} (${changeSign}${stats.pctChange.toFixed(1)}%)`,
      `${priceData.length} trading days`,
      changeClass
    ),
    statCardHtml('Period high / low', `$${stats.periodHigh.toFixed(2)} / $${stats.periodLow.toFixed(2)}`),
    statCardHtml(
      'SMA 20 / SMA 50',
      `${stats.latestSma20 != null ? '$' + stats.latestSma20.toFixed(2) : '—'} / ${stats.latestSma50 != null ? '$' + stats.latestSma50.toFixed(2) : '—'}`
    ),
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
      <h3>Research note</h3>
      <p class="note">${note}</p>
    </div>
  `;

  lastChartData = { priceData, sma20, sma50 };
  drawChart(document.getElementById('price-chart'), priceData, sma20, sma50);
}

// Hand-rolled line chart on a <canvas>, so the template has no charting
// dependency to install. Draws the close price plus both moving averages on
// one set of axes, scaled to fit whatever range they span together.
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

  // Horizontal gridlines with price labels.
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

  // Date labels along the x-axis.
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
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  drawLine(closes, '#f2f2f0', 2);
  drawLine(sma20, '#d95926', 1.5);
  drawLine(sma50, '#e66767', 1.5);
}
