'use strict';
// 用 CDP 给宿主主页面截图：node scripts/shot.js <out.png>
const fs = require('fs');
const base = process.env.CDP || 'http://127.0.0.1:9333';

(async () => {
  const out = process.argv[2] || 'shot.png';
  const pages = await (await fetch(base + '/json')).json();
  const host = pages.find((p) => p.type === 'page' && /index\.html/.test(p.url)) || pages.find((p) => p.type === 'page');
  if (!host) { console.log('no host page'); process.exit(1); }
  const ws = new WebSocket(host.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Emulation.setDeviceMetricsOverride', { width: 1380, height: 900, deviceScaleFactor: 1, mobile: false });
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (!r.result) { console.log(JSON.stringify(r).slice(0, 400)); process.exit(1); }
  fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'));
  console.log('saved', out);
  ws.close();
  process.exit(0);
})();
