const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const AUTO_INTERVAL = 30000; // 每 30 秒自动抓取一次
const DATA_FILE = path.join(__dirname, 'data.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

/*
  ─── 辰域智控 电费数据抓取 & 监控服务器 ───
  • 后台每 30 秒自动抓一次 cnyiot.com
  • 只在数据变化时写入 data.json（去重）
  • 前端可手动刷新触发立即抓取，也可 3 秒轮询 /api/meter
  • 高密度数据保正每日用量计算准确
*/

const METER_ID = 'P+KgcBqh/9/gOpbR+039FA==';
const NAT_URL = `http://www.wap.cnyiot.com/nat/nat.aspx?id=${encodeURIComponent(METER_ID)}&by=a`;
const PAY_URL = `http://www.wap.cnyiot.com/nat/pay.aspx?mid=19501460208`;

// ─── Data store ───
let cache = { current: null, history: [], lastFetch: null, lastError: null, autoRunning: false };

function loadData() {
  try { const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); cache.history = d.history || []; }
  catch { cache.history = []; }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ history: cache.history }, null, 2), 'utf-8');
}

// ─── HTTP client ───
function httpGet(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const doGet = (target, redirs) => {
      const parsed = new URL(target);
      const req = http.get(parsed, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        timeout: 15000,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirs <= 0) { reject(new Error('重定向次数过多')); return; }
          doGet(new URL(res.headers.location, parsed.href).href, redirs - 1);
          return;
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve(body));
      });
      req.on('error', e => reject(new Error('网络请求失败: ' + e.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    };
    doGet(url, maxRedirects);
  });
}

// ─── Fetch + Parse ───
async function doFetch() {
  let body;
  try {
    body = await httpGet(NAT_URL);
    if (body.includes('Object moved')) body = await httpGet(PAY_URL);
  } catch { body = await httpGet(PAY_URL); }
  return parsePage(body);
}

function parsePage(html) {
  const nameMatch = html.match(/表[\s&]*名[\s&]*称[\s:：]*<\/span>\s*<label[^>]*>([^<]+)/i);
  const idMatch = html.match(/metid[^>]*>([^<]+)</i) || html.match(/表[\s&]*\s*号[\s:：]*<\/span>\s*<label[^>]*>(\d+)</i);
  const kwhMatch = html.match(/剩余电量[\s\S]*?<label[^>]*>([\d.]+)<\/label>/i);
  const balMatch = html.match(/剩余金额[\s\S]*?<label[^>]*>([\d.]+)<\/label>/i);
  const priceMatch = html.match(/综合费用[\s\S]*?<label[^>]*>([\d.]+)<\/label>/i);
  const jsPriceMatch = html.match(/MetPrice\s*=\s*([\d.]+)/);

  return {
    meterName: nameMatch ? nameMatch[1].trim() : '宝庆苑5-2-1702-2',
    meterId: (idMatch ? idMatch[1].trim() : null) || '19501460208',
    remainingKwh: kwhMatch ? parseFloat(kwhMatch[1]) : null,
    remainingBalance: balMatch ? parseFloat(balMatch[1]) : null,
    unitPrice: (priceMatch ? parseFloat(priceMatch[1]) : null) || (jsPriceMatch ? parseFloat(jsPriceMatch[1]) : 0.977),
    timestamp: new Date().toISOString(),
  };
}

async function fetchAndStore() {
  const fresh = await doFetch();
  cache.current = fresh;
  cache.lastFetch = new Date().toISOString();
  cache.lastError = null;

  const last = cache.history[cache.history.length - 1];
  if (!last || last.remainingKwh !== fresh.remainingKwh || last.remainingBalance !== fresh.remainingBalance) {
    cache.history.push(fresh);
    if (cache.history.length > 525600) cache.history = cache.history.slice(-525600); // ~1 year at 1/min
    saveData();
    console.log(`[auto] ¥${fresh.remainingBalance} | ${fresh.remainingKwh} kWh | ${new Date().toLocaleTimeString('zh-CN')}`);
  }
}

// ─── Auto-refresh ───
function startAutoRefresh() {
  loadData();
  console.log(`⏱ 后台自动刷新已启动（每 ${AUTO_INTERVAL / 1000} 秒）`);
  cache.autoRunning = true;

  // 启动后立即抓一次
  fetchAndStore().catch(e => { cache.lastError = e.message; console.error('[auto] 首次抓取失败:', e.message); });

  // 定时抓取
  setInterval(() => {
    fetchAndStore().catch(e => { cache.lastError = e.message; console.error('[auto] 抓取失败:', e.message); });
  }, AUTO_INTERVAL);
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  // API: 获取最新数据（返回缓存，即时响应）
  if (urlPath === '/api/meter') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, current: cache.current, history: cache.history }));
    return;
  }

  // API: 手动强制刷新（等待 cnyiot 响应）
  if (urlPath === '/api/meter/force') {
    try {
      await fetchAndStore();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, current: cache.current, history: cache.history }));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: `抓取失败：${err.message}` }));
    }
    return;
  }

  // API: 服务状态
  if (urlPath === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      autoRunning: cache.autoRunning,
      lastFetch: cache.lastFetch,
      lastError: cache.lastError,
      historyCount: cache.history.length,
      interval: AUTO_INTERVAL,
    }));
    return;
  }

  // API: 历史 + 清空
  if (urlPath === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cache.history));
    return;
  }
  if (urlPath === '/api/history/clear' && req.method === 'POST') {
    cache.history = [];
    saveData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Static files
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`🔌 电费监控服务 → http://localhost:${PORT}/`);
  startAutoRefresh();
});
