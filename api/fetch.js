// Vercel Serverless Function — 定时抓取辰域智控电费数据并写入 GitHub
// cron-job.org 每 5 分钟调用一次: GET /api/fetch?token=YOUR_SECRET
module.exports = async (req, res) => {
  // 安全验证
  if (req.query.token !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  try {
    // 1. 抓取 cnyiot.com
    const natUrl = 'http://www.wap.cnyiot.com/nat/nat.aspx?id=P%2BKgcBqh%2F9%2FgOpbR%2B039FA%3D%3D&by=a';
    const payUrl = 'http://www.wap.cnyiot.com/nat/pay.aspx?mid=19501460208';
    
    let body;
    try {
      const r = await fetch(natUrl, { signal: AbortSignal.timeout(12000) });
      body = await r.text();
      if (body.includes('Object moved')) {
        const r2 = await fetch(payUrl, { signal: AbortSignal.timeout(12000) });
        body = await r2.text();
      }
    } catch {
      const r2 = await fetch(payUrl, { signal: AbortSignal.timeout(12000) });
      body = await r2.text();
    }

    // 2. 解析
    const kwh = body.match(/剩余电量[\s\S]*?<label[^>]*>([\d.]+)<\/label>/i);
    const bal = body.match(/剩余金额[\s\S]*?<label[^>]*>([\d.]+)<\/label>/i);
    const prc = body.match(/MetPrice\s*=\s*([\d.]+)/);
    
    const entry = {
      remainingKwh: kwh ? parseFloat(kwh[1]) : null,
      remainingBalance: bal ? parseFloat(bal[1]) : null,
      unitPrice: (prc ? parseFloat(prc[1]) : null) || 0.977,
      timestamp: new Date().toISOString(),
    };
    
    if (!entry.remainingKwh) throw new Error('Parse failed');

    // 3. 读取现有 data.json
    const token = process.env.GH_TOKEN;
    const owner = process.env.GH_OWNER || 'CandaYin';
    const repo = process.env.GH_REPO || 'electricity-monitor';
    
    const fileResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/data.json`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vercel-cron' } }
    );
    
    let data = { history: [] };
    let sha;
    if (fileResp.ok) {
      const fileInfo = await fileResp.json();
      data = JSON.parse(Buffer.from(fileInfo.content, 'base64').toString());
      sha = fileInfo.sha;
    }

    // 4. 检查是否有变化
    const last = data.history[data.history.length - 1];
    if (last && last.remainingKwh === entry.remainingKwh && last.remainingBalance === entry.remainingBalance) {
      return res.json({ ok: true, changed: false, entry });
    }

    // 5. 追加并写入
    data.history.push(entry);
    if (data.history.length > 20000) data.history = data.history.slice(-20000);

    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const updateResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/data.json`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vercel-cron', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `auto: ¥${entry.remainingBalance} | ${entry.remainingKwh} kWh`, content, sha }),
      }
    );

    if (!updateResp.ok) throw new Error(`GitHub API: ${updateResp.status}`);
    return res.json({ ok: true, changed: true, entry });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
