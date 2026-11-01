import { createServer } from 'node:http';
import { fetchQuotaReport } from '../../lib/quota-core.mjs';

const PANEL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>额度监控 · Antigravity Quota Monitor</title>
  <script src="/preload.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--background, #0f172a);
      color: var(--foreground, #f8fafc);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      gap: 8px;
      flex-wrap: wrap;
    }
    .title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
    }
    h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--muted-foreground, #94a3b8);
    }
    .btn {
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(148, 163, 184, 0.25));
      background: var(--card, #1e293b);
      color: var(--foreground, #f8fafc);
      font-size: 12px;
      cursor: pointer;
    }
    .btn:hover { opacity: 0.88; }
    .card {
      background: var(--card, #1e293b);
      border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .card-argon {
      border-color: rgba(56, 189, 248, 0.5);
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      gap: 8px;
      flex-wrap: wrap;
    }
    .card-title {
      font-size: 13.5px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      font-weight: 600;
    }
    .bucket-row {
      margin-bottom: 10px;
    }
    .bucket-row:last-child { margin-bottom: 0; }
    .bucket-meta {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 4px;
      gap: 6px;
    }
    .muted { color: var(--muted-foreground, #94a3b8); }
    .progress-track {
      width: 100%;
      height: 9px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.18);
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.35s ease;
    }
    .usage-section {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--border, rgba(148, 163, 184, 0.14));
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .table th, .table td {
      text-align: left;
      padding: 5px 4px;
      border-bottom: 1px solid var(--border, rgba(148, 163, 184, 0.12));
    }
    .table th {
      color: var(--muted-foreground, #94a3b8);
      font-weight: 600;
    }
    .table td.num, .table th.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .table tr:last-child td { border-bottom: none; }
    .table tr.total-row td {
      font-weight: 700;
      border-top: 1px solid var(--border, rgba(148, 163, 184, 0.22));
    }
    .pill-ok { color: #10b981; font-weight: 600; }
    .pill-warn { color: #f59e0b; font-weight: 600; }
    .pill-danger { color: #ef4444; font-weight: 600; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-wrap">
      <span class="dot" id="statusDot"></span>
      <h1>模型额度实时监控</h1>
    </div>
    <div class="toolbar">
      <span id="costBadge" class="badge" style="background:rgba(16,185,129,0.14);color:#10b981;"></span>
      <span id="tierBadge" class="badge"></span>
      <span id="updatedAt">加载中...</span>
      <button class="btn" id="refreshBtn">↻ 刷新</button>
    </div>
  </div>

  <div id="contentRoot">
    <div class="card muted">正在读取本地额度与模型 Token 消耗明细...</div>
  </div>

  <script>
    function esc(s) {
      return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function colorForPct(pct) {
      if (pct <= 15) return '#ef4444';
      if (pct <= 35) return '#f59e0b';
      return '#10b981';
    }
    function classForPct(pct) {
      if (pct <= 15) return 'pill-danger';
      if (pct <= 35) return 'pill-warn';
      return 'pill-ok';
    }
    function fmtTok(n) {
      const v = Number(n || 0);
      if (v <= 0) return '—';
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
      return String(v);
    }
    function fmtUsd(n) {
      const v = Number(n || 0);
      if (v <= 0) return '$0.00';
      if (v < 0.01) return '$' + v.toFixed(3);
      return '$' + v.toFixed(2);
    }
    function fmtCell(tok, cost, bold) {
      if (!tok || tok <= 0) return '<span class="muted">—</span>';
      const t = bold ? '<strong>' + fmtTok(tok) + '</strong>' : fmtTok(tok);
      return t + ' <span class="muted">· ' + fmtUsd(cost) + '</span>';
    }
    function renderBucket(label, b) {
      if (!b) return '<div class="muted">暂无数据</div>';
      const pct = Number(b.remainingPct || 0);
      return \`
        <div class="bucket-row">
          <div class="bucket-meta">
            <span><strong>\${esc(label)}</strong></span>
            <span>剩余 <strong class="\${classForPct(pct)}">\${pct.toFixed(2)}%</strong> <span class="muted">(\${esc(b.resetCountdown)}后重置)</span></span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:\${Math.max(1, Math.min(100, pct))}%; background:\${colorForPct(pct)};"></div>
          </div>
        </div>
      \`;
    }
    function renderUsageTable(models) {
      const list = (models || []).filter((m) => m.tokens7d > 0);
      if (!list.length) {
        return '<div class="usage-section muted" style="font-size:12px;">近 7 天暂无调用</div>';
      }
      const sum5h = list.reduce((a, m) => a + m.tokens5h, 0);
      const sum5hCost = list.reduce((a, m) => a + (m.cost5hUsd || 0), 0);
      const sum7d = list.reduce((a, m) => a + m.tokens7d, 0);
      const sum7dCost = list.reduce((a, m) => a + (m.cost7dUsd || 0), 0);
      const rows = list.map((m) => {
        const tip = '7d 明细 — 未缓存输入: ' + fmtTok(m.inputTokens7d) + ' · 缓存读取: ' + fmtTok(m.cacheReadTokens7d) + ' · 输出: ' + fmtTok(m.outputTokens7d);
        return \`
          <tr title="\${esc(tip)}">
            <td>\${esc(m.model)}</td>
            <td class="num">\${fmtCell(m.tokens5h, m.cost5hUsd, false)}</td>
            <td class="num">\${fmtCell(m.tokens7d, m.cost7dUsd, true)}</td>
          </tr>
        \`;
      }).join('');
      const total = list.length > 1 ? \`
        <tr class="total-row">
          <td class="muted">合计</td>
          <td class="num">\${fmtCell(sum5h, sum5hCost, true)}</td>
          <td class="num">\${fmtCell(sum7d, sum7dCost, true)}</td>
        </tr>
      \` : '';
      return \`
        <div class="usage-section">
          <table class="table">
            <thead><tr><th>已调用模型</th><th class="num">5h (Token / API)</th><th class="num">7d (Token / API)</th></tr></thead>
            <tbody>\${rows}\${total}</tbody>
          </table>
        </div>
      \`;
    }

    async function loadQuota() {
      const convId = (window.sidecar && window.sidecar.conversationId) || '';
      const fetcher = (window.sidecar && window.sidecar.fetch) ? window.sidecar.fetch : fetch;
      try {
        const res = await fetcher('/api/quota?conversationId=' + encodeURIComponent(convId), { method: 'GET' });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        renderDashboard(data);
        document.getElementById('statusDot').style.background = '#10b981';
        document.getElementById('tierBadge').textContent = data.tierName || '';
        const c5 = data.ledger ? data.ledger.total5hCostUsd : 0;
        const c7 = data.ledger ? data.ledger.total7dCostUsd : 0;
        document.getElementById('costBadge').textContent = '等额 API: 5h ' + fmtUsd(c5) + ' · 7d ' + fmtUsd(c7);
        const d = new Date(data.fetchedAt);
        document.getElementById('updatedAt').textContent = d.toLocaleTimeString();
      } catch (err) {
        document.getElementById('statusDot').style.background = '#ef4444';
        document.getElementById('contentRoot').innerHTML =
          '<div class="card"><strong class="pill-danger">获取额度失败：</strong> ' + esc(err.message) + '</div>';
      }
    }

    function renderDashboard(d) {
      const g5 = d.groups.gemini.fiveHour;
      const gw = d.groups.gemini.weekly;
      const c5 = d.groups.thirdParty.fiveHour;
      const cw = d.groups.thirdParty.weekly;
      const aw = d.argon.weeklyBucket;
      const a5 = d.argon.fiveHourBucket;

      const argonCardHtml = d.showArgonCard
        ? \`
          <div class="card card-argon">
            <div class="card-header">
              <div class="card-title">🎯 Gemini 4 Argon</div>
            </div>
            \${renderBucket('每周独立限额', aw)}
            \${a5 ? renderBucket('5小时窗口限额', a5) : ''}
            \${renderUsageTable(d.argon.usageModels)}
          </div>\`
        : '';

      document.getElementById('contentRoot').innerHTML = \`
        \${argonCardHtml}

        <div class="card">
          <div class="card-header">
            <div class="card-title">⚡ Gemini 组</div>
          </div>
          \${renderBucket('5小时窗口限额', g5)}
          \${renderBucket('每周总额度池', gw)}
          \${renderUsageTable(d.groups.gemini.usageModels)}
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-title">🤖 Claude &amp; GPT 组</div>
          </div>
          \${renderBucket('5小时窗口限额', c5)}
          \${renderBucket('每周总额度池', cw)}
          \${renderUsageTable(d.groups.thirdParty.usageModels)}
        </div>
      \`;
    }

    document.getElementById('refreshBtn').addEventListener('click', loadQuota);
    loadQuota();
    setInterval(loadQuota, 10000);
  </script>
</body>
</html>`;

const standaloneIdx = process.argv.indexOf('--standalone');
if (standaloneIdx >= 0) {
  const port = Number(process.argv[standaloneIdx + 1] || 18910);
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.sidecar = { conversationId: "", fetch: window.fetch.bind(window) };');
      return;
    }
    if (url.pathname === '/api/quota') {
      try {
        const data = await fetchQuotaReport(url.searchParams.get('conversationId') || '');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PANEL_HTML);
  });
  srv.listen(port, '127.0.0.1', () => {
    console.log(`[agy-quota-monitor] Standalone UI listening on http://127.0.0.1:${port}`);
  });
} else {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  app.page('/', () => PANEL_HTML);
  app.api('/api/quota', async (data) => fetchQuotaReport(data.conversationId || app.config.conversationId || ''), 'GET');
  app.api('/api/quota', async (data) => fetchQuotaReport(data.conversationId || app.config.conversationId || ''), 'POST');
  await app.run();
}
