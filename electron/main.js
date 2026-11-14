'use strict';
/**
 * SuperAgent 指挥台（Windows 宿主）· 多项目常驻引擎
 *
 * 底座 = DeepSeek Harness（dsh）+ dsh-superagent bundle。
 * 每个项目一个常驻引擎（独立端口 / DSH_HOME / userData），切换项目只换 UI 视角，
 * 不重启、不重装；所有项目并行值守。
 *
 * 业务逻辑一律不在这里重写：Ticket / Policy / Source / Executor 都在 bundle 里。
 */
const { app, BrowserWindow, ipcMain, shell, dialog, net, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { EvolutionStore } = require('./evolution/store');
const { EvolutionEngine } = require('./evolution/engine');
const { SshVault } = require('./ssh-vault');
const { ServerVault } = require('./server-vault');
const { ReviewAgent } = require('./review-agent');

const PROFILE = 'superagent';
const BUNDLE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bundle', 'dsh-superagent')
  : path.join(__dirname, '..', 'bundle', 'dsh-superagent');
const LOCAL_DSH = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DSH_VERSION = '0.2.2-rc.1';
const GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a';
const GITHUB_SCOPES = 'repo read:org';
const SHARED_DIR = path.join(app.getPath('appData'), 'superagent-win');

let win = null;

/* ------------------------------- 项目注册表 ------------------------------- */

const PROJECTS_FILE = () => path.join(SHARED_DIR, 'projects.json');
let projects = { activeId: '', projects: [] };

function loadProjects() {
  try { projects = JSON.parse(fs.readFileSync(PROJECTS_FILE(), 'utf8')); } catch { projects = { activeId: '', projects: [] }; }
  if (!projects.projects.length) {
    projects.projects.push({
      id: 'p-default', name: 'SuperAgent',
      folder: app.isPackaged ? path.join(process.resourcesPath, '..', '..') : path.join(__dirname, '..'),
      repo: '', port: 3082, home: path.join(os.homedir(), '.dsh'),
      verify: 'npm test', deploy: null, intake: null, createdAt: new Date().toISOString()
    });
    projects.activeId = 'p-default';
    saveProjects();
  }
  if (!projects.activeId) projects.activeId = projects.projects[0].id;
  const def = projects.projects.find((p) => p.id === 'p-default');
  if (def && /app\.asar|win-unpacked|[\\/]dist$/.test(def.name + ' ' + def.folder)) {
    def.name = 'SuperAgent';
    def.folder = app.isPackaged ? path.join(process.resourcesPath, '..', '..', '..') : path.join(__dirname, '..');
    saveProjects();
  }
}
function saveProjects() {
  fs.mkdirSync(path.dirname(PROJECTS_FILE()), { recursive: true });
  fs.writeFileSync(PROJECTS_FILE(), JSON.stringify(projects, null, 2), 'utf8');
}
function activeProject() { return projects.projects.find((p) => p.id === projects.activeId) || projects.projects[0]; }

/* ------------------------------- 每项目运行时 ------------------------------- */

const runtimes = new Map();

function makeRuntime(p) {
  const userData = p.id === 'p-default' ? SHARED_DIR : path.join(app.getPath('appData'), `superagent-win-${p.port}`);
  const rt = {
    p, userData,
    port: p.port, home: p.home,
    profileDir: path.join(p.home, 'profiles', PROFILE),
    stateDir: path.join(p.home, 'state', PROFILE),
    child: null, url: null, phase: 'idle', errorText: '', startedAt: null, lastState: null,
    logs: [],
    config: { ghCli: '', ghConfigDir: path.join(userData, 'gh-config'), repository: p.repo || '', allowed: [], directory: '', prepare: '', clientId: GITHUB_CLIENT_ID },
    posterToken: '', posterLogin: '', agentToken: '', agentLogin: '', authToken: '',
    gh: { install: { running: false, pct: 0, msg: '', error: '' }, auth: { pending: false, userCode: '', verificationUri: '', expiresAt: 0, error: '', login: '' } },
    authPoll: null,
    evolution: null, evolutionTimer: null, reviewAgent: null, reviewTimer: null, sshVault: null, serverVault: null
  };
  try { Object.assign(rt.config, JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')) || {}); } catch {}
  rt.config.ghConfigDir = path.join(userData, 'gh-config');
  if (!rt.config.clientId) rt.config.clientId = GITHUB_CLIENT_ID;
  if (p.repo && !rt.config.repository) rt.config.repository = p.repo;
  loadAuth(rt);
  rt.gh.auth.login = rt.agentLogin || rt.posterLogin || '';
  if (rt.agentLogin && rt.agentToken) writeAgentToGhConfig(rt);
  runtimes.set(p.id, rt);
  return rt;
}
function rt() { return runtimes.get(projects.activeId) || runtimes.get(activeProject().id); }
function getRt(id) { return runtimes.get(id); }

function saveConfig(r) {
  try {
    fs.mkdirSync(r.userData, { recursive: true });
    fs.writeFileSync(path.join(r.userData, 'config.json'), JSON.stringify(r.config, null, 2), 'utf8');
  } catch (e) { log(r, '保存配置失败：' + e.message, 'error'); }
}

function log(r, line, level = 'info') {
  const entry = { ts: Date.now(), level, line: String(line).slice(0, 4000), project: r.p.name };
  r.logs.push(entry);
  if (r.logs.length > 800) r.logs.splice(0, r.logs.length - 800);
  try {
    fs.mkdirSync(r.userData, { recursive: true });
    fs.appendFileSync(path.join(r.userData, 'superagent-host.log'), `${new Date(entry.ts).toISOString()} [${level}] ${entry.line}\n`, 'utf8');
  } catch {}
  if (win && !win.isDestroyed() && r === rt()) win.webContents.send('host:log', entry);
}

/* ------------------------------- 身份（每项目） ------------------------------- */

function encryptPayload(token) {
  return safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(token).toString('base64')
    : 'plain:' + Buffer.from(token, 'utf8').toString('base64');
}
function decryptToken(payload) {
  return String(payload || '').startsWith('enc:')
    ? safeStorage.decryptString(Buffer.from(String(payload).slice(4), 'base64'))
    : Buffer.from(String(payload || '').replace(/^plain:/, ''), 'base64').toString('utf8');
}
function loadAuth(r) {
  // 身份全局共享（所有项目同一发单人 + 同一 agent）；旧版每项目存储自动迁移
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  let pj = read(path.join(SHARED_DIR, 'auth.json'));
  let aj = read(path.join(SHARED_DIR, 'agent-auth.json'));
  if (!pj || !aj) {
    for (const dir of [r.userData, ...[...runtimes.values()].map((x) => x.userData), SHARED_DIR]) {
      if (!pj) pj = read(path.join(dir, 'auth.json'));
      if (!aj) aj = read(path.join(dir, 'agent-auth.json'));
    }
    if (pj) { try { fs.mkdirSync(SHARED_DIR, { recursive: true }); fs.writeFileSync(path.join(SHARED_DIR, 'auth.json'), JSON.stringify(pj), 'utf8'); } catch {} }
    if (aj) { try { fs.mkdirSync(SHARED_DIR, { recursive: true }); fs.writeFileSync(path.join(SHARED_DIR, 'agent-auth.json'), JSON.stringify(aj), 'utf8'); } catch {} }
  }
  if (pj) { r.posterToken = decryptToken(pj.token); r.posterLogin = pj.login || ''; r.authToken = r.posterToken; }
  else { r.posterToken = ''; r.posterLogin = ''; r.authToken = ''; }
  if (aj) { r.agentToken = decryptToken(aj.token); r.agentLogin = aj.login || ''; }
  else { r.agentToken = ''; r.agentLogin = ''; }
  const inAllowed = (l) => (r.config.allowed || []).some((x) => String(x).toLowerCase() === String(l).toLowerCase());
  if (r.posterLogin && !inAllowed(r.posterLogin) && r.agentLogin && r.posterLogin.toLowerCase() === r.agentLogin.toLowerCase()) {
    r.posterLogin = ''; r.posterToken = ''; r.authToken = '';
  }
}
function saveAuth(r, login, token) {
  r.authToken = token || '';
  try { fs.mkdirSync(SHARED_DIR, { recursive: true }); fs.writeFileSync(path.join(SHARED_DIR, 'auth.json'), JSON.stringify({ login, token: encryptPayload(token), at: Date.now() }), 'utf8'); }
  catch (e) { log(r, '保存登录信息失败：' + e.message, 'error'); }
  for (const x of runtimes.values()) { x.posterLogin = login; x.posterToken = token; x.authToken = token; }
}
function writeHostsYml(r, login, token) {
  fs.mkdirSync(r.config.ghConfigDir, { recursive: true });
  const yml = ['github.com:', '    git_protocol: https', `    user: ${login}`, '    users:', `        ${login}: {}`, `    oauth_token: ${token}`, ''].join('\n');
  fs.writeFileSync(path.join(r.config.ghConfigDir, 'hosts.yml'), yml, { mode: 0o600 });
  const cfgYml = ['version: "1"', 'git_protocol: https', 'prompt: enabled', 'pager: cat', 'browser: ""', 'color_labels: disabled', 'accessible_colors: disabled', 'spinner: enabled', ''].join('\n');
  fs.writeFileSync(path.join(r.config.ghConfigDir, 'config.yml'), cfgYml, { mode: 0o600 });
}
function writeAgentToGhConfig(r) {
  if (!r.agentLogin || !r.agentToken) return false;
  writeHostsYml(r, r.agentLogin, r.agentToken);
  return true;
}
function assignAuthRole(r, login, token) {
  const isPoster = (r.config.allowed || []).some((a) => String(a).toLowerCase() === String(login).toLowerCase());
  if (isPoster) { r.posterLogin = login; r.posterToken = token; r.authToken = token; saveAuth(r, login, token); }
  else {
    r.agentLogin = login; r.agentToken = token;
    try { fs.mkdirSync(SHARED_DIR, { recursive: true }); fs.writeFileSync(path.join(SHARED_DIR, 'agent-auth.json'), JSON.stringify({ login, token: encryptPayload(token), at: Date.now() }), 'utf8'); }
    catch (e) { log(r, '保存 agent 登录失败：' + e.message, 'error'); }
    for (const x of runtimes.values()) { x.agentLogin = login; x.agentToken = token; }
  }
  // 每个项目的 gh-config 都写 agent 身份（bundle 的 gh 用它）
  for (const x of runtimes.values()) if (x.agentLogin && x.agentToken) writeAgentToGhConfig(x);
}

/* ------------------------------- gh CLI（共享工具） ------------------------------- */

const TOOLS = () => path.join(SHARED_DIR, 'tools');
function findGh(r) {
  const candidates = [
    r.config.ghCli,
    path.join(TOOLS(), 'gh', 'bin', 'gh.exe'),
    path.join(TOOLS(), 'gh.exe'),
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'GitHubCLI', 'bin', 'gh.exe')
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, 'gh.exe');
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return '';
}
function ghEnv(r) {
  return Object.assign({}, process.env, { GH_CONFIG_DIR: r.config.ghConfigDir, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });
}
function runGh(r, args, { input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const bin = findGh(r);
    if (!bin) return resolve({ code: -1, out: '', err: '找不到 gh CLI' });
    const p = spawn(bin, args, { windowsHide: true, env: ghEnv(r) });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -1, out, err: 'timeout' }); }, timeoutMs);
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { err += b.toString(); });
    if (input) { p.stdin.write(input); p.stdin.end(); }
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
  });
}

/* ------------------------------- 网络 helpers ------------------------------- */

function applySystemProxy() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return;
  try {
    const u = new URL(raw);
    session.defaultSession.setProxy({ proxyRules: `http=${u.host};https=${u.host}` })
      .then(() => console.log('proxy set', u.host))
      .catch(() => {});
  } catch {}
}
async function ghHttp(url, { method = 'GET', headers = {}, body } = {}) {
  const opts = { method, headers: Object.assign({ 'User-Agent': 'SuperAgent', accept: 'application/json' }, headers) };
  if (body) opts.body = body;
  const res = await net.fetch(url, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status} ${text.slice(0, 120)}`);
  return json;
}
function netDownload(url, dest, onPct) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', 'SuperAgent');
    req.on('response', (res) => {
      if (res.statusCode >= 400) return reject(new Error('下载失败：HTTP ' + res.statusCode));
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => { got += chunk.length; if (total) onPct(Math.round((got / total) * 95)); out.write(chunk); });
      res.on('end', () => out.end(() => resolve(dest)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), ms))]);
}
function findFile(dir, name) {
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let items; try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(cur, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (it.name.toLowerCase() === name.toLowerCase()) return p;
    }
  }
  return '';
}

/* ------------------------------- dsh 进程（每项目） ------------------------------- */

function dshEnv(r) {
  const env = Object.assign({}, process.env, { DSH_HOME: r.home, NO_COLOR: '1' });
  if (r.config.ghConfigDir) env.GH_CONFIG_DIR = r.config.ghConfigDir;
  if (r.sshVault) Object.assign(env, r.sshVault.env(r.p.id));
  if (r.serverVault) Object.assign(env, r.serverVault.env(path.join(SHARED_DIR, 'lan', 'bin'), r.p.id));
  return env;
}
function runDsh(r, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const useLocal = !app.isPackaged && fs.existsSync(LOCAL_DSH);
    const cmd = useLocal ? 'node' : 'npx.cmd';
    const argv = useLocal ? [LOCAL_DSH, ...args] : ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`, ...args];
    log(r, `[exec] ${cmd} ${argv.join(' ')}`);
    const p = spawn(cmd, argv, { cwd: os.homedir(), windowsHide: true, env: dshEnv(r), shell: !useLocal && process.platform === 'win32' });
    let out = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -1, out, timeout: true }); }, timeoutMs);
    const pump = (buf) => {
      const text = buf.toString(); out += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(r, line, 'dsh');
    };
    p.stdout.on('data', pump); p.stderr.on('data', pump);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    p.on('error', (e) => { clearTimeout(timer); log(r, e.message, 'error'); resolve({ code: -1, out, error: e.message }); });
  });
}

function ensurePatch(r) {
  const file = path.join(r.profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(r.profileDir)) return { written: false };
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]';
  const needsWeb = !/^\s*-\s*id:\s*webserver\s*$/m.test(text);
  const needsSA = !/^\s*-\s*id:\s*dsh-superagent\s*$/m.test(text);
  if (!needsWeb && !needsSA) return { written: false };
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '[]');
  if (needsWeb) lines.push('# SuperAgent 宿主：控制面板端口', '- id: webserver', '  config:', '    host: 127.0.0.1', `    port: ${r.port}`);
  if (needsSA) lines.push('# SuperAgent 宿主：bundle 的状态目录', '- id: dsh-superagent', '  config:', `    stateDir: '${r.stateDir}'`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n').trimEnd() + '\n', 'utf8');
  log(r, `已更新 ${file}`);
  return { written: true };
}
async function ensureProfile(r) {
  if (fs.existsSync(path.join(r.profileDir, 'cordis.yml'))) return true;
  r.phase = 'preparing';
  log(r, '创建 profile：superagent（来自 web 模板）');
  await runDsh(r, [PROFILE, '--from-default-profile', 'web', '--dump-config'], { timeoutMs: 240000 });
  if (!fs.existsSync(path.join(r.profileDir, 'cordis.yml'))) { r.errorText = '创建 superagent profile 失败，请查看日志。'; return false; }
  return true;
}
function bundleInstalled(r) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(r.profileDir, 'package.json'), 'utf8'));
    const dep = (pkg.dependencies && pkg.dependencies['dsh-superagent']) || '';
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
    const has = norm(dep).includes(norm(BUNDLE_DIR)) || norm(dep).includes('bundles/dsh-superagent');
    const listed = ((pkg.dsh || {}).profile || {}).bundles || [];
    return has && listed.includes('dsh-superagent');
  } catch { return false; }
}
async function ensureBundle(r) {
  if (bundleInstalled(r)) return true;
  if (!fs.existsSync(path.join(BUNDLE_DIR, 'package.json'))) { r.errorText = `找不到内置 bundle：${BUNDLE_DIR}`; log(r, r.errorText, 'error'); return false; }
  // dsh 对本地路径一律 link，pnpm 跨盘 symlink 有 bug：手动 copy + file: 依赖 + bundles 清单
  try {
    const staged = path.join(r.home, 'bundles', 'dsh-superagent');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.cpSync(BUNDLE_DIR, staged, { recursive: true });
    const nm = path.join(r.profileDir, 'node_modules', 'dsh-superagent');
    fs.rmSync(nm, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(nm), { recursive: true });
    fs.cpSync(staged, nm, { recursive: true });
    const pkgFile = path.join(r.profileDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies['dsh-superagent'] = 'file:' + staged.replace(/\\/g, '/');
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    if (!bundles.includes('dsh-superagent')) bundles.push('dsh-superagent');
    pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {}; pkg.dsh.profile.bundles = bundles;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2), 'utf8');
  } catch (e) { log(r, '预置 bundle 失败：' + e.message, 'error'); }
  log(r, '安装 dsh-superagent bundle…');
  const res = await runDsh(r, ['plugin', '--profile', PROFILE, 'add', 'file:' + path.join(r.home, 'bundles', 'dsh-superagent').replace(/\\/g, '/')], { timeoutMs: 300000 });
  if (res.code !== 0 || !bundleInstalled(r)) { r.errorText = '安装 dsh-superagent bundle 失败（日志里有 pnpm 原始输出）。'; log(r, r.errorText, 'error'); return false; }
  return true;
}

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const sock = require('net').connect({ port, host });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}
async function waitPortFree(r, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await portOpen(r.port))) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return !(await portOpen(r.port));
}
async function clearStaleLock(r) {
  const lock = path.join(r.home, 'state', `${PROFILE}.lock`);
  if (!fs.existsSync(lock)) return false;
  if (await portOpen(r.port)) return false;
  try { fs.rmSync(lock, { recursive: true, force: true }); log(r, '清理残留的状态目录锁：' + lock); return true; }
  catch (e) { log(r, '清理锁失败：' + e.message, 'error'); return false; }
}
async function waitOrchestrator(r, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const st = await apiGet(r, 'state'); if (st && st.health) return st; } catch {}
    await new Promise((res) => setTimeout(res, 800));
  }
  return null;
}

async function start(r) {
  if (r.child) return { ok: true, already: true };
  r.phase = 'preparing'; r.errorText = ''; r.url = null; emit();
  if (!(await ensureProfile(r))) { r.phase = 'error'; emit(); return { ok: false, error: r.errorText }; }
  ensurePatch(r);
  if (!(await ensureBundle(r))) { r.phase = 'error'; emit(); return { ok: false, error: r.errorText }; }
  if (!(await waitPortFree(r))) {
    r.errorText = `端口 ${r.port} 仍被占用：可能有残留 dsh 进程。`;
    log(r, r.errorText, 'error'); r.phase = 'error'; emit(); return { ok: false, error: r.errorText };
  }
  await clearStaleLock(r);
  r.phase = 'starting'; r.startedAt = Date.now(); emit();
  log(r, `启动 DSH profile=${PROFILE} port=${r.port}`);
  const useLocal = !app.isPackaged && fs.existsSync(LOCAL_DSH);
  const cmd = useLocal ? 'node' : 'npx.cmd';
  const argv = useLocal ? [LOCAL_DSH, '--profile', PROFILE, '--no-open'] : ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`, '--profile', PROFILE, '--no-open'];
  r.child = spawn(cmd, argv, { cwd: os.homedir(), windowsHide: true, env: dshEnv(r), shell: !useLocal && process.platform === 'win32' });
  const spawnedAt = Date.now();
  const pump = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      log(r, line, 'dsh');
      const m = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/);
      if (m && !r.url) {
        r.url = m[1]; r.phase = 'running';
        log(r, 'DSH Web UI 就绪：' + r.url);
        emit();
        if (win && !win.isDestroyed() && r === rt()) win.webContents.send('host:url', r.url);
      }
    }
  };
  r.child.stdout.on('data', pump); r.child.stderr.on('data', pump);
  r.child.on('close', (code) => {
    log(r, `dsh 进程退出 code=${code}`, code === 0 ? 'info' : 'error');
    const wasRunning = r.phase === 'running';
    r.child = null; r.url = null; r.phase = 'idle';
    if (wasRunning && code !== 0) { r.phase = 'error'; r.errorText = `dsh 退出（code ${code}），查看日志。`; }
    stopLoops(r); emit();
  });
  r.child.on('error', (e) => { log(r, '无法启动 dsh：' + e.message, 'error'); r.phase = 'error'; r.errorText = '无法启动 dsh：' + e.message; r.child = null; emit(); });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && r.phase !== 'running' && r.child) await new Promise((res) => setTimeout(res, 600));
  if (r.phase !== 'running') {
    if (r.child) { r.errorText = 'dsh 180 秒内没有给出 Web URL，查看日志。'; r.phase = 'error'; log(r, r.errorText, 'error'); emit(); }
    else if (!r.errorText) { r.errorText = 'dsh 启动后立即退出。'; r.phase = 'error'; emit(); }
    return { ok: false, error: r.errorText };
  }
  log(r, `就绪，用时 ${Math.round((Date.now() - spawnedAt) / 1000)}s`);
  const st = await waitOrchestrator(r, 25000);
  if (!st) { r.errorText = '编排接口没有响应：bundle 可能没有激活。'; log(r, r.errorText, 'error'); emit(); return { ok: false, error: r.errorText }; }
  r.lastState = st; emit();
  startLoops(r);
  ensureEvolution(r).tick({ force: true }).catch(() => {});
  ensureReview(r).tick().catch(() => {});
  syncServerSkill(r).catch(() => {});
  return { ok: true, url: r.url };
}

function stop(r) {
  const p = r.child;
  if (!p) { r.phase = 'idle'; r.url = null; stopLoops(r); emit(); return Promise.resolve({ ok: true }); }
  log(r, '停止 dsh…');
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    else p.kill('SIGTERM');
  } catch (e) { log(r, '停止失败：' + e.message, 'error'); }
  r.child = null; r.url = null; r.phase = 'idle'; r.startedAt = null; r.lastState = null;
  stopLoops(r); emit();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve({ ok: true }); };
    p.once('close', finish);
    setTimeout(finish, 8000);
  });
}

/* ------------------------------- 编排 API（每项目） ------------------------------- */

function base(r) { return `http://127.0.0.1:${r.port}`; }
async function apiGet(r, p) {
  const res = await fetch(`${base(r)}/orchestrator/api/${p}`, { headers: { 'x-orchestrator-request': '1', accept: 'application/json' } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${p} ${res.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}
async function apiPut(r, p, value, revision) {
  const body = p === 'prompts' ? { config: value, baseRevision: revision } : { value, revision };
  const res = await fetch(`${base(r)}/orchestrator/api/${p}`, { method: 'PUT', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${p} ${res.status}: ${json.error || JSON.stringify(json.issues || json).slice(0, 300)}`);
  return json;
}
async function apiPost(r, p, body) {
  const res = await fetch(`${base(r)}/orchestrator/api/${p}`, { method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${p} ${res.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}
async function readState(r) {
  if (r.phase !== 'running') return null;
  try { r.lastState = await apiGet(r, 'state'); emit(); return r.lastState; } catch { return null; }
}
async function waitHealthy(r, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const st = await apiGet(r, 'state'); if (st && st.health && st.health.runtime) return st; } catch {}
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

async function applySetup(r, payload = {}) {
  if (r.phase !== 'running') throw new Error('宿主未运行');
  const settings = await apiGet(r, 'settings');
  const results = [];
  const gh = (settings.sources || []).find((s) => s.id === 'github');
  const repository = String(payload.repository ?? r.config.repository ?? '').trim();
  const cli = String(payload.cli ?? r.config.ghCli ?? '').trim();
  if (repository) {
    const value = { enabled: true, config: Object.assign({}, (gh && gh.value && gh.value.config) || {}, { repository, cli, observeIssues: true, observeComments: true }) };
    results.push({ step: 'source:github', ...(await apiPut(r, 'settings/source:github', value, gh ? gh.revision : 0)) });
    r.config.repository = repository;
    if (cli) r.config.ghCli = cli;
    const proj = projects.projects.find((x) => x.id === r.p.id);
    if (proj) { proj.repo = repository; saveProjects(); }
  }
  if (Array.isArray(payload.allowed)) {
    const allowed = payload.allowed.filter(Boolean).map((id) => ({ id: String(id).trim() }));
    const block = settings.blocks.policy;
    const value = JSON.parse(JSON.stringify(block.value || {}));
    value.sources = value.sources || {};
    value.sources.github = Object.assign({}, value.sources.github || {}, { allowed });
    results.push({ step: 'policy', ...(await apiPut(r, 'settings/policy', value, block.revision)) });
    r.config.allowed = allowed.map((a) => a.id);
  }
  if (r.serverVault && r.serverVault.list(r.p.id).assignedIds.length) {
    const block = (await apiGet(r, 'settings')).blocks.policy;
    const value = JSON.parse(JSON.stringify(block.value || {}));
    value.rules = value.rules || [];
    if (!value.rules.some((x) => x.id === 'lan-ops')) {
      value.rules.push({ id: 'lan-ops', name: 'LAN server maintenance', enabled: true, instruction: 'Explicit requests to inspect or maintain the LAN servers whose credentials are stored and assigned in this installation (see the lan-servers skill). Use the lan helper; never ask for or print passwords. Prefer read-only inspection first; destructive or service-affecting commands must be named in the ticket report.' });
      results.push({ step: 'policy:lan-ops', ...(await apiPut(r, 'settings/policy', value, block.revision)) });
    }
  }
  const needsExecutor = payload.directory !== undefined || payload.prepare !== undefined;
  if (needsExecutor) {
    const block = settings.blocks.executor;
    const value = Object.assign({}, block.value || {});
    if (payload.directory !== undefined) value.directory = String(payload.directory || '').trim();
    if (payload.prepare !== undefined) value.prepare = String(payload.prepare || '');
    results.push({ step: 'executor', ...(await apiPut(r, 'settings/executor', value, block.revision)) });
    if (payload.directory !== undefined) r.config.directory = String(payload.directory || '');
    if (payload.prepare !== undefined) r.config.prepare = String(payload.prepare || '');
  }
  saveConfig(r);
  const restarting = results.some((x) => x && x.restarting);
  if (restarting) { log(r, '配置已保存，dsh-superagent 正在重启…'); await new Promise((res) => setTimeout(res, 2500)); await waitHealthy(r, 120000); }
  return { results, restarting };
}

/* ------------------------------- GitHub 账号操作（每项目） ------------------------------- */

async function githubApi(r, p, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/vnd.github+json' };
  if (r.authToken) headers.authorization = `Bearer ${r.authToken}`;
  if (body) headers['content-type'] = 'application/json';
  return ghHttp('https://api.github.com' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
function emitGh(r) { if (win && !win.isDestroyed() && r === rt()) win.webContents.send('gh:update', ghSnapshot(r)); }
function ghSnapshot(r) {
  return {
    installed: !!findGh(r), path: findGh(r) || '', configDir: r.config.ghConfigDir,
    login: r.gh.auth.login, agentLogin: r.agentLogin, posterLogin: r.posterLogin,
    install: { ...r.gh.install }, auth: { ...r.gh.auth }
  };
}
async function ghIdentity(r) {
  if (r.authToken) {
    try {
      const user = await githubApi(r, '/user');
      r.gh.auth.login = user && user.login ? user.login : '';
      emitGh(r);
      return { installed: !!findGh(r), login: r.gh.auth.login };
    } catch {}
  }
  if (!findGh(r)) { r.gh.auth.login = ''; return { installed: false, login: '' }; }
  const res = await runGh(r, ['api', 'user', '--jq', '.login'], { timeoutMs: 20000 });
  const login = res.code === 0 ? res.out.trim() : '';
  r.gh.auth.login = login;
  if (login) r.config.ghCli = findGh(r);
  return { installed: true, login };
}
async function downloadGh(r) {
  if (r.gh.install.running) return { ok: false, error: '正在安装' };
  r.gh.install = { running: true, pct: 0, msg: '查询最新版本…', error: '' };
  emitGh(r);
  try {
    const info = await ghHttp('https://api.github.com/repos/cli/cli/releases/latest', { headers: { accept: 'application/vnd.github+json' } });
    const asset = (info.assets || []).find((a) => /windows_amd64\.zip$/i.test(a.name));
    if (!asset) throw new Error('没有找到 windows_amd64.zip 资产');
    r.gh.install.msg = '下载 gh ' + info.tag_name; emitGh(r);
    const tmpDir = path.join(os.tmpdir(), `gh-dl-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const zip = path.join(tmpDir, 'gh.zip');
    const urls = [asset.browser_download_url, 'https://ghfast.top/' + asset.browser_download_url, 'https://ghproxy.net/' + asset.browser_download_url, 'https://mirror.ghproxy.com/' + asset.browser_download_url];
    let lastErr = null, got = null;
    for (const u of urls) {
      try { await withTimeout(netDownload(u, zip, (pct) => { r.gh.install.pct = pct; emitGh(r); }), 120000); got = u; break; }
      catch (e) { lastErr = e; log(r, '下载源失败：' + u + ' → ' + e.message, 'error'); r.gh.install.msg = '换一个下载源…'; r.gh.install.pct = 0; emitGh(r); }
    }
    if (!got) throw new Error('连不上下载源（' + (lastErr && lastErr.message) + '）。可以点「选择已有的 gh.exe」，或换网络后重试。');
    r.gh.install.msg = '解压…'; r.gh.install.pct = 96; emitGh(r);
    const outDir = path.join(tmpDir, 'x');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${outDir}' -Force`], { windowsHide: true });
    await new Promise((res) => ps.on('close', res));
    const found = findFile(outDir, 'gh.exe');
    if (!found) throw new Error('解压后没有 gh.exe');
    const target = path.join(TOOLS(), 'gh');
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.dirname(found), path.join(target, 'bin'), { recursive: true });
    r.config.ghCli = path.join(target, 'bin', 'gh.exe');
    saveConfig(r);
    r.gh.install = { running: false, pct: 100, msg: '已安装', error: '' };
    emitGh(r);
    log(r, 'gh CLI 已安装：' + r.config.ghCli);
    await ghIdentity(r); emitGh(r);
    return { ok: true, cli: r.config.ghCli };
  } catch (e) {
    r.gh.install = { running: false, pct: 0, msg: '', error: e.message };
    emitGh(r); log(r, '安装 gh 失败：' + e.message, 'error');
    return { ok: false, error: e.message };
  }
}
function cancelAuth(r) { if (r.authPoll) { clearTimeout(r.authPoll); r.authPoll = null; } r.gh.auth.pending = false; emitGh(r); }
async function startDeviceFlow(r) {
  if (r.gh.auth.pending) return ghSnapshot(r);
  r.gh.auth = { pending: true, userCode: '', verificationUri: '', expiresAt: 0, error: '', login: '' };
  emitGh(r);
  try {
    const data = await ghHttp('https://github.com/login/device/code', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: r.config.clientId || GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }).toString()
    });
    if (!data || !data.device_code) throw new Error((data && (data.error_description || data.error)) || '无法获取设备码');
    r.gh.auth.userCode = data.user_code;
    r.gh.auth.verificationUri = data.verification_uri;
    r.gh.auth.expiresAt = Date.now() + (data.expires_in || 900) * 1000;
    emitGh(r);
    shell.openExternal(`${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`);
    pollDevice(r, data.device_code, data.interval || 5);
    return ghSnapshot(r);
  } catch (e) {
    r.gh.auth = { pending: false, userCode: '', verificationUri: '', expiresAt: 0, error: e.message, login: '' };
    emitGh(r);
    return ghSnapshot(r);
  }
}
function pollDevice(r, deviceCode, interval) {
  const tick = async () => {
    if (!r.gh.auth.pending) return;
    if (Date.now() > r.gh.auth.expiresAt) { r.gh.auth.pending = false; r.gh.auth.error = '一次性代码已过期，请重新登录。'; emitGh(r); return; }
    try {
      const res = await net.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'User-Agent': 'SuperAgent', accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: r.config.clientId || GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString()
      });
      const text = await res.text();
      let data = {}; try { data = JSON.parse(text); } catch { data = { error: 'bad response' }; }
      if (data.access_token) {
        const user = await ghHttp('https://api.github.com/user', { headers: { authorization: `Bearer ${data.access_token}`, accept: 'application/vnd.github+json' } }).catch(() => ({}));
        const login = user.login || 'github-user';
        assignAuthRole(r, login, data.access_token);
        r.gh.auth.pending = false; r.gh.auth.login = login; r.gh.auth.userCode = '';
        emitGh(r);
        log(r, `GitHub 已连接：@${login}`);
        await ghIdentity(r);
        if (!r.config.allowed.length) { r.config.allowed = [login]; saveConfig(r); }
        emitGh(r);
        return;
      }
      if (data.error === 'slow_down') interval += 5;
      if (data.error && !['authorization_pending', 'slow_down'].includes(data.error)) {
        r.gh.auth.pending = false;
        r.gh.auth.error = data.error === 'access_denied' ? '授权被拒绝。' : (data.error_description || data.error);
        emitGh(r); return;
      }
    } catch (e) { r.gh.auth.error = e.message; }
    r.authPoll = setTimeout(tick, interval * 1000);
  };
  r.authPoll = setTimeout(tick, interval * 1000);
}
async function loginWithToken(r, token) {
  try {
    const user = await ghHttp('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    if (!user || !user.login) throw new Error('token 无效');
    assignAuthRole(r, user.login, token);
    r.gh.auth.login = user.login;
    emitGh(r);
    await ghIdentity(r);
    if (!r.config.allowed.length) { r.config.allowed = [user.login]; saveConfig(r); }
    emitGh(r);
    return { ok: true, login: user.login };
  } catch (e) { r.gh.auth.error = e.message; emitGh(r); return { ok: false, error: e.message }; }
}
async function listRepos(r) {
  if (!r.authToken) {
    const g = await runGh(r, ['api', 'user', '--jq', '.login'], { timeoutMs: 20000 });
    if (g.code !== 0) return { ok: false, error: '先登录 GitHub' };
  }
  try {
    const items = await githubApi(r, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    return { ok: true, items: (items || []).map((x) => ({ name: x.full_name, private: x.private, description: x.description, pushed_at: x.pushed_at })) };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}
async function logoutGithub(r) {
  try { fs.rmSync(path.join(SHARED_DIR, 'agent-auth.json'), { force: true }); } catch {}
  for (const x of runtimes.values()) {
    x.agentLogin = ''; x.agentToken = '';
    try { fs.rmSync(path.join(x.config.ghConfigDir, 'hosts.yml'), { force: true }); } catch {}
    x.gh.auth.login = x.posterLogin || '';
  }
  emitGh(r);
  return { ok: true };
}
async function collabStatus(r) {
  const repo = String(r.config.repository || '').trim();
  const agent = r.agentLogin || r.gh.auth.login || '';
  if (!repo || !agent) return { ok: false, error: '先选仓库并登录 agent' };
  if (!r.posterToken) return { ok: false, error: '需要发单人登录（仓库 owner）才能检测/邀请' };
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/collaborators/${agent}/permission`, { headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${r.posterToken}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${j.message || ''}`.slice(0, 200) };
    return { ok: true, permission: j.permission, agent, repo };
  } catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}
async function collabInvite(r) {
  const repo = String(r.config.repository || '').trim();
  const agent = r.agentLogin || r.gh.auth.login || '';
  if (!repo || !agent) return { ok: false, error: '先选仓库并登录 agent' };
  if (!r.posterToken) return { ok: false, error: '需要发单人登录（仓库 owner）才能发邀请' };
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/collaborators/${agent}`, {
      method: 'PUT',
      headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${r.posterToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ permission: 'push' })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${j.message || ''}`.slice(0, 200) };
    log(r, `已向 @${agent} 发出 ${repo} 的 Write 协作者邀请`);
    return { ok: true, state: j.state || 'invited', url: j.html_url || `https://github.com/${repo}/invitations` };
  } catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}
async function resyncIssues(r) {
  const back = new Date(Date.now() - 7 * 86400000).toISOString();
  const wasRunning = r.phase === 'running';
  if (wasRunning) await stop(r);
  const dbFile = path.join(r.stateDir, 'orchestrator.sqlite');
  let db = null;
  for (let i = 0; i < 6 && !db; i++) {
    try { db = new (require('node:sqlite').DatabaseSync)(dbFile); }
    catch { await new Promise((res) => setTimeout(res, 1000)); }
  }
  if (!db) {
    // 进程已死但 WAL 锁残留：清掉 -wal/-shm 再试（最多丢最后几秒未落盘写入）
    try { fs.rmSync(dbFile + '-wal', { force: true }); fs.rmSync(dbFile + '-shm', { force: true }); } catch {}
    try { db = new (require('node:sqlite').DatabaseSync)(dbFile); } catch {}
  }
  if (!db) {
    log(r, '重置读取基线失败：数据库仍被占用', 'error');
    if (wasRunning) await start(r);
    return { ok: false, error: '数据库仍被占用，请稍后重试' };
  }
  try {
    db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(back), 'github-since');
    for (const k of ['github-stream:issues', 'github-stream:comments', 'github-stream:review-comments']) {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(k);
      if (!row) continue;
      try {
        const v = JSON.parse(row.value);
        v.since = back;
        if (v.started) for (const kind of Object.keys(v.started)) v.started[kind] = back;
        delete v.etag;
        db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(v), k);
      } catch {}
    }
    log(r, '已回拨议题读取基线 7 天：现有开放议题将被接收');
  } catch (e) {
    log(r, '重置读取基线失败：' + e.message, 'error');
    try { db.close(); } catch {}
    if (wasRunning) await start(r);
    return { ok: false, error: e.message };
  }
  try { db.close(); } catch {}
  if (wasRunning) { const res = await start(r); return { ok: !!res.ok, error: res.error }; }
  return { ok: true };
}
async function createIssue(r, title, body) {
  const repo = String(r.config.repository || '').trim();
  if (!repo) return { ok: false, error: '先在接入页选一个仓库' };
  if (!r.posterToken) return { ok: false, error: '需要发单人登录：接入页用授权人账号登录一次' };
  const agent = r.agentLogin || r.gh.auth.login || '';
  const text = `@${agent} ${String(body || '').trim()}`.trim();
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${r.posterToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: String(title || '').trim() || '新任务', body: text })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${j.message || ''}`.slice(0, 300) };
    log(r, `已以 @${r.posterLogin} 开议题 ${repo}#${j.number} 派活给 @${agent}`);
    return { ok: true, url: j.html_url, number: j.number };
  } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
}
async function postComment(r, threadUrl, text) {
  const m = String(threadUrl || '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i);
  if (!m) return { ok: false, error: '这个会话不在 GitHub 议题上，请到来源里回复。' };
  const [, owner, repo, , num] = m;
  if (r.authToken) {
    try {
      const created = await githubApi(r, `/repos/${owner}/${repo}/issues/${num}/comments`, { method: 'POST', body: { body: text } });
      log(r, `已回复 ${owner}/${repo}#${num}（REST）`);
      return { ok: true, url: (created && created.html_url) || '' };
    } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
  }
  const res = await runGh(r, ['api', `repos/${owner}/${repo}/issues/${num}/comments`, '-f', `body=${text}`], { timeoutMs: 45000 });
  if (res.code !== 0) return { ok: false, error: (res.err || res.out || '发送失败').slice(0, 400) };
  let created = {}; try { created = JSON.parse(res.out); } catch {}
  log(r, `已回复 ${owner}/${repo}#${num}`);
  return { ok: true, url: created.html_url || '' };
}

/* ------------------------------- 进化 / 评审 / 凭据（每项目） ------------------------------- */

function ensureEvolution(r) {
  if (r.evolution) return r.evolution;
  const store = new EvolutionStore(path.join(r.userData, 'evolution'));
  r.evolution = new EvolutionEngine({
    api: { get: (p) => apiGet(r, p), put: (p, body) => apiPut(r, p, body.value, body.revision), post: (p, body) => apiPost(r, p, body) },
    store,
    log: (line, level) => log(r, line, level),
    isRunning: () => r.phase === 'running',
    onChange: () => { if (win && !win.isDestroyed() && r === rt()) win.webContents.send('evolution:update', r.evolution.snapshot()); }
  });
  store.log('进化引擎已装载');
  return r.evolution;
}
function posterGh(r) {
  const call = async (method, p, body, accept) => {
    if (!r.posterToken) throw new Error('发单人未登录，评审 agent 无法操作 GitHub');
    const res = await net.fetch('https://api.github.com/' + p, {
      method,
      headers: { 'User-Agent': 'SuperAgent', accept: accept || 'application/vnd.github+json', authorization: `Bearer ${r.posterToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(j && j.message) || text.slice(0, 120)}`);
    return accept === 'application/vnd.github.diff' ? text : j;
  };
  return { get: (p, opts) => call('GET', p, null, opts && opts.accept), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}
function ensureReview(r) {
  if (r.reviewAgent) return r.reviewAgent;
  r.reviewAgent = new ReviewAgent({
    api: { get: (p) => apiGet(r, p) },
    gh: posterGh(r),
    store: ensureEvolution(r).store,
    log: (l, lv) => log(r, '[review] ' + l, lv),
    onChange: () => { if (win && !win.isDestroyed() && r === rt()) win.webContents.send('review:update', r.reviewAgent.settings()); }
  });
  return r.reviewAgent;
}
function startLoops(r) {
  if (!r.evolutionTimer) r.evolutionTimer = setInterval(() => { if (r.phase === 'running') ensureEvolution(r).tick().catch((e) => log(r, '[evolution] tick 失败：' + e.message, 'error')); }, 30000);
  if (!r.reviewTimer) r.reviewTimer = setInterval(() => { if (r.phase === 'running') ensureReview(r).tick().catch((e) => log(r, '[review] tick 失败：' + e.message, 'error')); }, 45000);
}
function stopLoops(r) {
  if (r.evolutionTimer) { clearInterval(r.evolutionTimer); r.evolutionTimer = null; }
  if (r.reviewTimer) { clearInterval(r.reviewTimer); r.reviewTimer = null; }
}
function ensureSsh(r) {
  if (r.sshVault) return r.sshVault;
  r.sshVault = new SshVault({
    dir: path.join(SHARED_DIR, 'ssh'),
    encrypt: (t) => encryptPayload(t), decrypt: (p) => decryptToken(p),
    log: (l) => log(r, '[ssh] ' + l),
    onChange: () => { if (win && !win.isDestroyed() && r === rt()) win.webContents.send('ssh:update', r.sshVault.list()); }
  });
  return r.sshVault;
}
function ensureServers(r) {
  if (r.serverVault) return r.serverVault;
  r.serverVault = new ServerVault({
    dir: path.join(SHARED_DIR, 'lan'),
    encrypt: (t) => encryptPayload(t), decrypt: (p) => decryptToken(p),
    log: (l) => log(r, '[lan] ' + l),
    onChange: () => { if (win && !win.isDestroyed() && r === rt()) win.webContents.send('servers:update', r.serverVault.list()); }
  });
  return r.serverVault;
}
function ensureLanHelper(r) {
  const dir = path.join(SHARED_DIR, 'lan', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const src = app.isPackaged ? path.join(process.resourcesPath, 'scripts', 'lan-helper.js') : path.join(__dirname, '..', 'scripts', 'lan-helper.js');
  fs.copyFileSync(src, path.join(dir, 'lan-helper.js'));
  fs.writeFileSync(path.join(dir, 'lan.cmd'), '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"' + process.execPath + '" "%~dp0lan-helper.js" %*\r\n', 'utf8');
}
async function syncServerSkill(r) {
  ensureLanHelper(r);
  ensureServers(r).syncAssigned();
  if (r.phase !== 'running') return;
  try {
    const view = await apiGet(r, 'prompts');
    const cfg = JSON.parse(JSON.stringify(view.current.config));
    const text = r.serverVault.skillText(r.p.id);
    cfg.skills = cfg.skills || {};
    if (text) cfg.skills['lan-servers'] = text; else delete cfg.skills['lan-servers'];
    if (JSON.stringify(cfg) !== JSON.stringify(view.current.config)) {
      await apiPut(r, 'prompts', cfg, view.current.revision);
      log(r, '[lan] 已更新 agent 的 lan-servers 技能');
    }
  } catch (e) { log(r, '[lan] 同步技能失败：' + e.message, 'error'); }
}

/* ------------------------------- 项目操作 ------------------------------- */

/** 切换项目：只换视角。目标引擎没起才后台拉起，不重启别的。 */
async function switchProject(id) {
  const p = projects.projects.find((x) => x.id === id);
  if (!p) return { ok: false, error: '项目不存在' };
  projects.activeId = p.id;
  saveProjects();
  let r = getRt(p.id);
  if (!r) r = makeRuntime(p);
  emit();
  if (!r.child && r.phase !== 'starting' && r.phase !== 'preparing') start(r).catch(() => {});
  return { ok: true, project: p };
}

async function addProject({ folder, name, createGithub, private: priv, verify }) {
  const dir = String(folder || '').trim();
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: '文件夹不存在' };
  const port = 3082 + projects.projects.length;
  const p = {
    id: 'p-' + Date.now().toString(36),
    name: String(name || path.basename(dir)).slice(0, 60),
    folder: dir, repo: '', port,
    home: path.join(app.getPath('appData'), 'superagent-win-homes', 'p-' + port),
    verify: String(verify || '').trim(), deploy: null, intake: null,
    createdAt: new Date().toISOString()
  };
  p.hasGit = fs.existsSync(path.join(dir, '.git'));
  p.hasPackage = fs.existsSync(path.join(dir, 'package.json'));
  if (!p.verify && p.hasPackage) p.verify = 'npm test';
  if (createGithub) {
    const r0 = rt();
    if (!r0.posterToken) return { ok: false, error: '新建 GitHub 仓库需要发单人登录' };
    const repoName = p.name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    const created = await net.fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${r0.posterToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: repoName, private: priv !== false, auto_init: false })
    });
    const j = await created.json().catch(() => ({}));
    if (!created.ok) return { ok: false, error: `GitHub ${created.status}: ${j.message || ''}`.slice(0, 200) };
    p.repo = j.full_name;
    const run = (cmd, args) => new Promise((res) => {
      const c = spawn(cmd, args, { cwd: dir, windowsHide: true, env: Object.assign({}, process.env, { GH_CONFIG_DIR: r0.config.ghConfigDir }) });
      let out = ''; c.stdout.on('data', (b) => out += b); c.stderr.on('data', (b) => out += b);
      c.on('close', (code) => res({ code, out }));
    });
    if (!p.hasGit) await run('git', ['init', '-b', 'main']);
    await run('git', ['add', '-A']);
    await run('git', ['-c', 'user.name=SuperAgent', '-c', 'user.email=agent@superagent.local', 'commit', '-m', 'Initial commit via SuperAgent']);
    const push = await run('git', ['push', `https://github.com/${p.repo}.git`, 'HEAD:main']);
    if (push.code !== 0) return { ok: false, error: '首推失败：' + push.out.slice(-200), project: p };
  }
  projects.projects.push(p);
  saveProjects();
  const r = makeRuntime(p);
  log(r, `项目已添加：${p.name}（${dir}）${p.repo ? ' → ' + p.repo : '（本地）'}`);
  start(r).catch(() => {});
  return { ok: true, project: p };
}

/* ------------------------------- 快照 / 窗口 ------------------------------- */

function snapshot() {
  const r = rt();
  return {
    phase: r.phase, url: r.url, error: r.errorText,
    profileDir: r.profileDir, stateDir: r.stateDir, bundleDir: BUNDLE_DIR,
    bundleInstalled: bundleInstalled(r), port: r.port, dshHome: r.home,
    startedAt: r.startedAt, logs: r.logs.slice(-300), state: r.lastState,
    hostLog: path.join(r.userData, 'superagent-host.log'),
    config: { repository: r.config.repository, allowed: r.config.allowed, directory: r.config.directory, prepare: r.config.prepare },
    github: Object.assign(ghSnapshot(r), { cliConfigured: r.config.ghCli }),
    project: { id: r.p.id, name: r.p.name, folder: r.p.folder, repo: r.p.repo, verify: r.p.verify },
    projects: projects.projects.map((p) => { const x = getRt(p.id); return { id: p.id, name: p.name, repo: p.repo, port: p.port, running: !!(x && x.phase === 'running') }; })
  };
}
function emit() { if (win && !win.isDestroyed()) win.webContents.send('host:state', snapshot()); }

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 900, minWidth: 1120, minHeight: 700,
    backgroundColor: '#07080c', title: 'SuperAgent',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07080c', symbolColor: '#8b97ab', height: 48 },
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

/* ------------------------------- ipc ------------------------------- */

ipcMain.handle('host:get', () => snapshot());
ipcMain.handle('host:start', async () => { const r = rt(); const res = await start(r); await readState(r); return { ...res, state: snapshot() }; });
ipcMain.handle('host:stop', () => stop(rt()));
ipcMain.handle('host:restart', async () => { const r = rt(); await stop(r); await new Promise((res) => setTimeout(res, 1200)); return start(r); });
ipcMain.handle('host:refresh', async () => { await readState(rt()); return snapshot(); });
ipcMain.handle('host:api', async (_e, { path: p }) => apiGet(rt(), p));
ipcMain.handle('host:post', async (_e, { path: p, body }) => { const r = await apiPost(rt(), p, body); await readState(rt()); return r; });
ipcMain.handle('host:put', async (_e, { path: p, value, revision }) => { const r = await apiPut(rt(), p, value, revision); await readState(rt()); return r; });
ipcMain.handle('host:saveSetup', async (_e, payload) => { const r = await applySetup(rt(), payload); await readState(rt()); return r; });
ipcMain.handle('host:setupCheck', async () => { const r = await apiPost(rt(), 'setup/check'); await waitHealthy(rt(), 90000); await readState(rt()); return r; });
ipcMain.handle('host:pause', async (_e, paused) => { const r = await apiPost(rt(), 'executor/pause', { paused: !!paused }); await readState(rt()); return r; });
ipcMain.handle('host:openLog', () => {
  const r = rt();
  const file = path.join(r.userData, 'superagent-host.log');
  try { fs.writeFileSync(file, r.logs.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.line}`).join('\n'), 'utf8'); return shell.openPath(file); } catch { return 'no log'; }
});
ipcMain.handle('host:openProfile', () => shell.openPath(rt().profileDir));
ipcMain.handle('host:openState', () => shell.openPath(rt().stateDir));
ipcMain.handle('host:openBundle', () => shell.openPath(BUNDLE_DIR));
ipcMain.handle('host:openExternal', (_e, u) => shell.openExternal(u));
ipcMain.handle('host:pickDir', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('host:rememberRepo', (_e, repository) => {
  const r = rt();
  r.config.repository = String(repository || '').trim();
  saveConfig(r); emit();
  return { ok: true, repository: r.config.repository };
});
ipcMain.handle('gh:status', async () => { const r = rt(); await ghIdentity(r).catch(() => {}); return ghSnapshot(r); });
ipcMain.handle('gh:install', () => downloadGh(rt()));
ipcMain.handle('gh:pick', async () => {
  const r = rt();
  const res = await dialog.showOpenDialog(win, { title: '选择 gh.exe', properties: ['openFile'], filters: [{ name: 'gh.exe', extensions: ['exe'] }] });
  if (!res.canceled && res.filePaths[0]) { r.config.ghCli = res.filePaths[0]; saveConfig(r); await ghIdentity(r).catch(() => {}); log(r, '使用指定的 gh：' + r.config.ghCli); }
  emitGh(r);
  return ghSnapshot(r);
});
ipcMain.handle('gh:loginStart', () => startDeviceFlow(rt()));
ipcMain.handle('gh:loginCancel', () => { const r = rt(); cancelAuth(r); return ghSnapshot(r); });
ipcMain.handle('gh:tokenLogin', (_e, token) => loginWithToken(rt(), String(token || '').trim()));
ipcMain.handle('gh:repos', () => listRepos(rt()));
ipcMain.handle('gh:logout', () => logoutGithub(rt()));
ipcMain.handle('gh:openAuth', (_e, uri) => shell.openExternal(uri));
ipcMain.handle('thread:comment', (_e, { url, text }) => postComment(rt(), url, text));
ipcMain.handle('issue:create', (_e, { title, body }) => createIssue(rt(), title, body));
ipcMain.handle('collab:status', () => collabStatus(rt()));
ipcMain.handle('collab:invite', () => collabInvite(rt()));
ipcMain.handle('issues:resync', () => resyncIssues(rt()));

ipcMain.handle('ssh:list', () => ensureSsh(rt()).list(rt().p.id));
ipcMain.handle('ssh:generate', (_e, name) => ensureSsh(rt()).generate(name));
ipcMain.handle('ssh:import', (_e, { name, privateKey }) => ensureSsh(rt()).importKey(name, privateKey));
ipcMain.handle('ssh:remove', (_e, id) => ensureSsh(rt()).remove(String(id)));
ipcMain.handle('ssh:assign', async (_e, id) => { const r = rt(); const res = await ensureSsh(r).assign(String(id), r.p.id); if (r.phase === 'running') { log(r, '[ssh] 重启引擎以注入 GIT_SSH_COMMAND…'); await stop(r); await start(r); } return res; });
ipcMain.handle('ssh:unassign', async (_e, id) => { const r = rt(); const res = ensureSsh(r).unassign(r.p.id, String(id)); if (r.phase === 'running') { await stop(r); await start(r); } return res; });
ipcMain.handle('ssh:test', (_e, target) => ensureSsh(rt()).test(target, rt().p.id));
ipcMain.handle('ssh:registerGithub', async (_e, id) => {
  const r = rt();
  const key = ensureSsh(r).list().keys.find((k) => k.id === id);
  if (!key) return { ok: false, error: '密钥不存在' };
  if (!r.agentToken) return { ok: false, error: 'agent 未登录' };
  try {
    const res = await net.fetch('https://api.github.com/user/keys', {
      method: 'POST',
      headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${r.agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: `superagent-${key.name}`, key: key.publicKey })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${j.message || ''}`.slice(0, 200) };
    log(r, `[ssh] 公钥已登记到 agent GitHub：${key.name}`);
    return { ok: true, id: j.id };
  } catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
});

ipcMain.handle('servers:list', () => ensureServers(rt()).list(rt().p.id));
ipcMain.handle('servers:add', (_e, p) => ensureServers(rt()).add(p || {}));
ipcMain.handle('servers:remove', (_e, id) => ensureServers(rt()).remove(String(id)));
ipcMain.handle('servers:test', (_e, id) => ensureServers(rt()).test(String(id)));
ipcMain.handle('servers:assign', async (_e, id) => { const r = rt(); const res = ensureServers(r).assign(String(id), r.p.id); await syncServerSkill(r); if (r.phase === 'running') { log(r, '[lan] 重启引擎以注入 lan 助手…'); await stop(r); await start(r); } return res; });
ipcMain.handle('servers:unassign', async (_e, id) => { const r = rt(); const res = ensureServers(r).unassign(String(id), r.p.id); await syncServerSkill(r); if (r.phase === 'running') { await stop(r); await start(r); } return res; });

ipcMain.handle('review:get', () => { const a = ensureReview(rt()); const s = a.settings(); return { ...s, usingEngineKey: !s.llm && !!a.effectiveLlm() }; });
ipcMain.handle('review:settings', (_e, patch) => ensureReview(rt()).saveSettings(patch || {}));
ipcMain.handle('review:run', () => ensureReview(rt()).tick());

ipcMain.handle('projects:list', () => ({ activeId: projects.activeId, projects: projects.projects.map((p) => { const x = getRt(p.id); return { ...p, running: !!(x && x.phase === 'running') }; }) }));
ipcMain.handle('projects:switch', (_e, id) => switchProject(String(id)));
ipcMain.handle('projects:start', async (_e, id) => {
  const p = projects.projects.find((x) => x.id === id);
  if (!p) return { ok: false, error: '项目不存在' };
  let r = getRt(p.id);
  if (!r) r = makeRuntime(p);
  const res = await start(r);
  emit();
  return res;
});
ipcMain.handle('projects:add', (_e, p) => addProject(p || {}));
ipcMain.handle('projects:pickFolder', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('projects:update', (_e, { id, patch }) => {
  const p = projects.projects.find((x) => x.id === id);
  if (!p) return { ok: false, error: '项目不存在' };
  Object.assign(p, patch || {});
  saveProjects();
  return { ok: true, project: p };
});

ipcMain.handle('evolution:get', () => ensureEvolution(rt()).snapshot());
ipcMain.handle('evolution:run', async () => { const r = rt(); const res = await ensureEvolution(r).runNow(); return { result: res, snapshot: r.evolution.snapshot() }; });
ipcMain.handle('evolution:apply', async (_e, id) => { const r = rt(); await ensureEvolution(r).approveAndApply(String(id)); return r.evolution.snapshot(); });
ipcMain.handle('evolution:reject', (_e, { id, reason }) => { const r = rt(); ensureEvolution(r).reject(String(id), reason); return r.evolution.snapshot(); });
ipcMain.handle('evolution:rollback', async (_e, { id, reason }) => { const r = rt(); await ensureEvolution(r).rollback(String(id), reason); return r.evolution.snapshot(); });
ipcMain.handle('evolution:evaluate', async (_e, id) => { const r = rt(); await ensureEvolution(r).evaluateNow(String(id)); return r.evolution.snapshot(); });
ipcMain.handle('evolution:settings', (_e, patch) => { const r = rt(); const next = ensureEvolution(r).store.saveSettings(patch || {}); log(r, `[evolution] 设置更新：${JSON.stringify(patch || {})}`); return next; });
ipcMain.handle('evolution:openDir', () => shell.openPath(ensureEvolution(rt()).store.dir));

/* ------------------------------- boot ------------------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    applySystemProxy();
    loadProjects();
    for (const p of projects.projects) makeRuntime(p);
    createWindow();
    setTimeout(() => {
      // 所有项目引擎并行拉起；切换只换视角
      for (const r of runtimes.values()) start(r).catch((e) => log(r, '启动失败：' + e.message, 'error'));
      ghIdentity(rt()).then(() => emitGh(rt())).catch(() => {});
    }, 700);
  });
  app.on('window-all-closed', async () => { for (const r of runtimes.values()) await stop(r); app.quit(); });
  app.on('before-quit', () => { for (const r of runtimes.values()) stop(r); });
}