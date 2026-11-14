'use strict';
// 用 CDP 读宿主页面的真实 DOM 文本，验证界面渲染（不依赖截图）。
const base = process.env.CDP || 'http://127.0.0.1:9333';

(async () => {
  const pages = await (await fetch(base + '/json')).json();
  const host = process.env.TARGET
    ? pages.find((p) => p.type === process.env.TARGET)
    : (pages.find((p) => p.type === 'page' && /index\.html/.test(p.url)) || pages.find((p) => p.type === 'page'));
  if (!host) { console.log('no host page'); process.exit(1); }
  console.log('PAGE:', host.title, host.url);
  const ws = new WebSocket(host.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  const expr = process.argv[2] || 'document.body.innerText';
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(String(r.result && r.result.result ? r.result.result.value : JSON.stringify(r)).slice(0, 6000));
  ws.close();
  process.exit(0);
})();
