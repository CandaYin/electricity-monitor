const http = require('http');
const fs = require('fs');
const path = require('path');

// 仅做数据抓取，不启动 HTTP 服务器。供 GitHub Actions 定时调用。
const DATA_FILE = path.join(__dirname, 'data.json');
const NAT_URL = 'http://www.wap.cnyiot.com/nat/nat.aspx?id=P%2BKgcBqh%2F9%2FgOpbR%2B039FA%3D%3D&by=a';
const PAY_URL = 'http://www.wap.cnyiot.com/nat/pay.aspx?mid=19501460208';

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return { history: [] }; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36', 'Accept-Language': 'zh-CN' },
      timeout: 15000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        httpGet(new URL(res.headers.location, u.href).href).then(resolve).catch(reject);
        return;
      }
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve(b));
    }).on('error', e => reject(e)).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function parsePage(html) {
  const kwh = html.match(/剩余电量[\s\S]*?<label[^>]*>([\d.]+)<\/label>/i);
  const bal = html.match(/剩余金额[\s\S]*?<label[^>]*>([\d.]+)<\/label>/i);
  const prc = html.match(/MetPrice\s*=\s*([\d.]+)/);
  return {
    remainingKwh: kwh ? parseFloat(kwh[1]) : null,
    remainingBalance: bal ? parseFloat(bal[1]) : null,
    unitPrice: (prc ? parseFloat(prc[1]) : null) || 0.977,
    timestamp: new Date().toISOString(),
  };
}

(async () => {
  try {
    let body;
    try { body = await httpGet(NAT_URL); } catch { body = await httpGet(PAY_URL); }
    const fresh = parsePage(body);
    if (fresh.remainingKwh == null) { console.error('Parse failed'); process.exit(1); }

    const data = loadData();
    const last = data.history[data.history.length - 1];
    if (!last || last.remainingKwh !== fresh.remainingKwh || last.remainingBalance !== fresh.remainingBalance) {
      data.history.push(fresh);
      if (data.history.length > 8760) data.history = data.history.slice(-8760);
      saveData(data);
      console.log(`[OK] ¥${fresh.remainingBalance} | ${fresh.remainingKwh} kWh | ${fresh.timestamp}`);
    } else {
      console.log(`[SKIP] no change | ¥${fresh.remainingBalance} | ${fresh.remainingKwh} kWh`);
    }
  } catch (err) {
    console.error('Fetch failed:', err.message);
    process.exit(1);
  }
})();
