'use strict';
/**
 * 生成应用图标：assets/icon.svg → build/icon.png(1024) → build/icon.ico
 *
 * 设计：深色圆角方底 + 青→蓝渐变的「进化环」（开口圆弧 + 箭头），
 * 环心一个上扬的对勾——「每一轮闭环都带来一次可验证的改进」。
 * 与指挥台 UI 的 accent(#5eead4) / accent-2(#60a5fa) 同一套颜色。
 *
 * 运行：node scripts/make-icon.js   （依赖 devDependencies 里的 electron）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
fs.mkdirSync(OUT, { recursive: true });

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#10141d"/>
      <stop offset="1" stop-color="#07080c"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#60a5fa"/>
    </linearGradient>
    <linearGradient id="tick" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#a7f3eb"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.32" cy="0.26" r="0.9">
      <stop offset="0" stop-color="#5eead4" stop-opacity="0.16"/>
      <stop offset="0.55" stop-color="#60a5fa" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- 底：深色圆角方 -->
  <rect x="32" y="32" width="960" height="960" rx="224" fill="url(#bg)"/>
  <rect x="32" y="32" width="960" height="960" rx="224" fill="url(#glow)"/>
  <rect x="40" y="40" width="944" height="944" rx="216" fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="3"/>

  <!-- 进化环：270° 圆弧，缺口留在右上象限（-80° → 190°，顺时针） -->
  <path d="M 565.8 206.7 A 310 310 0 1 1 206.7 458.2"
        fill="none" stroke="url(#ring)" stroke-width="86" stroke-linecap="round"/>

  <!-- 环的箭头：在弧的终点沿切线方向（右上）推进 -->
  <path d="M 223.2 363.6 L 268.8 469.1 L 144.6 447.3 Z" fill="url(#ring)"/>

  <!-- 环心对勾：一次被验证的改进 -->
  <path d="M 383 529 L 489 634 L 668 420"
        fill="none" stroke="url(#tick)" stroke-width="78" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

fs.writeFileSync(path.join(ROOT, 'assets', 'icon.svg'), SVG, 'utf8');
fs.writeFileSync(path.join(OUT, 'icon.svg'), SVG, 'utf8');

/* ── 用 Electron 的离屏窗口把 SVG 渲染成 1024 PNG ── */

const renderer = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, webPreferences: { offscreen: true } });
  const html = '<body style="margin:0">' + fs.readFileSync(process.argv[2], 'utf8') + '</body>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(process.argv[3], img.toPNG());
  app.exit(0);
});
`;
const rendererFile = path.join(os.tmpdir(), `sa-icon-render-${Date.now()}.js`);
fs.writeFileSync(rendererFile, renderer, 'utf8');
const electronBin = require('electron'); // dev 依赖：返回二进制路径
const png = path.join(OUT, 'icon.png');
const r = spawnSync(electronBin, [rendererFile, path.join(OUT, 'icon.svg'), png], { stdio: 'inherit', windowsHide: true });
fs.rmSync(rendererFile, { force: true });
if (r.status !== 0 || !fs.existsSync(png)) { console.error('渲染 PNG 失败'); process.exit(1); }
console.log('PNG:', png, fs.statSync(png).size, 'bytes');

/* ── PNG → ICO（Vista+ 的 ICO 允许内嵌 PNG，逐尺寸缩放） ── */

async function main() {
  const { nativeImage } = require('electron');
  // nativeImage 只能在主进程用；这里改在渲染进程里逐尺寸导出
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const multi = `
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const img = nativeImage.createFromPath(process.argv[2]);
  const out = [];
  for (const s of ${JSON.stringify(sizes)}) {
    const resized = img.resize({ width: s, height: s, quality: 'best' });
    out.push({ size: s, data: resized.toPNG().toString('base64') });
  }
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  app.exit(0);
});
`;
  const multiFile = path.join(os.tmpdir(), `sa-icon-multi-${Date.now()}.js`);
  fs.writeFileSync(multiFile, multi, 'utf8');
  const jsonFile = path.join(os.tmpdir(), `sa-icon-multi-${Date.now()}.json`);
  const r2 = spawnSync(electronBin, [multiFile, png, jsonFile], { stdio: 'inherit', windowsHide: true });
  fs.rmSync(multiFile, { force: true });
  if (r2.status !== 0 || !fs.existsSync(jsonFile)) { console.error('缩放失败'); process.exit(1); }
  const images = JSON.parse(fs.readFileSync(jsonFile, 'utf8')).map((x) => ({ size: x.size, buf: Buffer.from(x.data, 'base64') }));
  fs.rmSync(jsonFile, { force: true });

  // ICO 容器：header(6) + entries(16*n) + PNG payloads
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, buf } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  const ico = Buffer.concat([header, ...entries, ...images.map((x) => x.buf)]);
  const icoPath = path.join(OUT, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log('ICO:', icoPath, ico.length, 'bytes,', images.map((x) => x.size).join('/'));
}
main();