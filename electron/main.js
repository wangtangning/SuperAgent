'use strict';
/**
 * SuperAgent 指挥台（Windows 宿主）
 *
 * 底座 = DeepSeek Harness（dsh）+ 官方 dsh-superagent bundle。
 * 宿主负责 Windows 上缺的那一层，并把「人」这一端做成一个真正的入口：
 *
 *   1) 环境：profile / bundle / 端口 / 进程（拉起 dsh --profile superagent）
 *   2) 账号：GitHub 登录走浏览器授权（device flow），不要求用户开终端；gh CLI 自动探测/安装
 *   3) 入口：会话时间线、工单、决策、配置——全部走 bundle 自己的 /orchestrator/api
 *   4) 深潜：DSH 原生 Web UI 保留在「引擎」页，作为高级视图
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
// 多项目并行：SUPERAGENT_PORT 换端口、SUPERAGENT_HOME 换数据目录，即可同机跑多个实例。
// 一个 agent 账号可服务所有实例（分别加协作者）；同仓库多实例会重复处理，避免。
let PORT = Number(process.env.SUPERAGENT_PORT || 3082);
let DSH_HOME = process.env.SUPERAGENT_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
// 每个实例独立的宿主数据目录（配置/登录/进化数据），默认实例保持原路径不变
let INSTANCE_DIR = (PORT === 3082 && !process.env.SUPERAGENT_HOME)
  ? path.join(app.getPath('appData'), 'superagent-win')
  : path.join(app.getPath('appData'), `superagent-win-${PORT}`);
app.setPath('userData', INSTANCE_DIR);
let PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
let STATE_DIR = path.join(DSH_HOME, 'state', PROFILE);
const BUNDLE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bundle', 'dsh-superagent')
  : path.join(__dirname, '..', 'bundle', 'dsh-superagent');
const LOCAL_DSH = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DSH_VERSION = '0.2.2-rc.1';

// GitHub CLI 的公开 OAuth App（device flow 用）；可在设置里换成自己的 client_id。
const GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a';
const GITHUB_SCOPES = 'repo read:org';

let win = null;
let child = null;
let url = null;
let phase = 'idle'; // idle | preparing | starting | running | error
let errorText = '';
const logs = [];
let startedAt = null;
let lastState = null;

/* ------------------------------- 项目注册表 ------------------------------- */

const PROJECTS_FILE = () => path.join(app.getPath('appData'), 'superagent-win', 'projects.json');
let projects = { activeId: '', projects: [] };

function loadProjects() {
  try { projects = JSON.parse(fs.readFileSync(PROJECTS_FILE(), 'utf8')); } catch { projects = { activeId: '', projects: [] }; }
  if (!projects.projects.length) {
    // 迁移：现有默认实例成为第一个项目
    projects.projects.push({
      id: 'p-default', name: 'SuperAgent',
      folder: app.isPackaged ? path.join(process.resourcesPath, '..') : path.join(__dirname, '..'),
      repo: config.repository || '',
      port: 3082, home: path.join(os.homedir(), '.dsh'),
      verify: 'npm test', deploy: null, intake: null, createdAt: new Date().toISOString()
    });
    projects.activeId = 'p-default';
    saveProjects();
  }
  if (!projects.activeId) projects.activeId = projects.projects[0].id;
  // 旧版迁移遗留：名字/路径取自打包目录时修正
  const def = projects.projects.find((p) => p.id === 'p-default');
  if (def && /app\.asar|win-unpacked/.test(def.name + def.folder)) {
    def.name = 'SuperAgent';
    def.folder = app.isPackaged ? path.join(process.resourcesPath, '..', '..') : path.join(__dirname, '..');
    saveProjects();
  }
}
function saveProjects() {
  fs.mkdirSync(path.dirname(PROJECTS_FILE()), { recursive: true });
  fs.writeFileSync(PROJECTS_FILE(), JSON.stringify(projects, null, 2), 'utf8');
}
function activeProject() { return projects.projects.find((p) => p.id === projects.activeId) || projects.projects[0]; }

/** 切换项目：停引擎 → 换端口/数据目录 → 重置单例 → 重载配置 → 起引擎。 */
async function switchProject(id) {
  const p = projects.projects.find((x) => x.id === id);
  if (!p) return { ok: false, error: '项目不存在' };
  if (p.id === projects.activeId && phase === 'running') return { ok: true, already: true };
  await stop();
  projects.activeId = p.id;
  saveProjects();
  PORT = p.port;
  DSH_HOME = p.home;
  INSTANCE_DIR = (p.port === 3082 && p.id === 'p-default')
    ? path.join(app.getPath('appData'), 'superagent-win')
    : path.join(app.getPath('appData'), `superagent-win-${p.port}`);
  app.setPath('userData', INSTANCE_DIR);
  PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
  STATE_DIR = path.join(DSH_HOME, 'state', PROFILE);
  evolution = null; sshVault = null; serverVault = null; reviewAgent = null;
  config = { ghCli: '', ghConfigDir: '', repository: p.repo || '', allowed: [], directory: '', prepare: '', clientId: GITHUB_CLIENT_ID };
  loadConfig();
  const auth = loadAuth();
  gh.auth.login = (auth && auth.login) || '';
  if (p.repo) config.repository = p.repo;
  const r = await start();
  emit();
  return { ok: !!r.ok, error: r.error, project: p };
}

/** 添加项目：登记文件夹；可选新建 GitHub 仓库并首推。 */
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
  // 探测
  p.hasGit = fs.existsSync(path.join(dir, '.git'));
  p.hasPackage = fs.existsSync(path.join(dir, 'package.json'));
  if (!p.verify && p.hasPackage) p.verify = 'npm test';
  if (createGithub) {
    if (!posterToken) return { ok: false, error: '新建 GitHub 仓库需要发单人登录' };
    const repoName = p.name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    const created = await net.fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${posterToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: repoName, private: priv !== false, auto_init: false })
    });
    const j = await created.json().catch(() => ({}));
    if (!created.ok) return { ok: false, error: `GitHub ${created.status}: ${j.message || ''}`.slice(0, 200) };
    p.repo = j.full_name;
    // 首推：git init（若无）+ commit + push
    const run = (cmd, args) => new Promise((res) => {
      const c = spawn(cmd, args, { cwd: dir, windowsHide: true, env: Object.assign({}, process.env, { GH_CONFIG_DIR: config.ghConfigDir }) });
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
  log(`项目已添加：${p.name}（${dir}）${p.repo ? ' → ' + p.repo : '（本地）'}`);
  return { ok: true, project: p };
}

/* ------------------------------- 配置 ------------------------------- */

const CFG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const TOOLS = () => path.join(app.getPath('userData'), 'tools');
const GH_CONFIG_DIR = () => path.join(app.getPath('userData'), 'gh-config');

let config = {
  ghCli: '',
  ghConfigDir: '',
  repository: '',
  allowed: [],
  directory: '',
  prepare: '',
  clientId: GITHUB_CLIENT_ID
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8'));
    config = Object.assign(config, raw || {});
  } catch {}
  config.ghConfigDir = GH_CONFIG_DIR();
  if (!config.clientId) config.clientId = GITHUB_CLIENT_ID;
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CFG_FILE()), { recursive: true });
    fs.writeFileSync(CFG_FILE(), JSON.stringify(config, null, 2), 'utf8');
  } catch (e) { log('保存配置失败：' + e.message, 'error'); }
}

/* ------------------------------- helpers ------------------------------- */

function log(line, level = 'info') {
  const entry = { ts: Date.now(), level, line: String(line).slice(0, 4000) };
  logs.push(entry);
  if (logs.length > 800) logs.splice(0, logs.length - 800);
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'superagent-host.log'), `${new Date(entry.ts).toISOString()} [${level}] ${entry.line}\n`, 'utf8');
  } catch {}
  if (win && !win.isDestroyed()) win.webContents.send('host:log', entry);
}

function writeLogFile() {
  const file = path.join(app.getPath('userData'), 'superagent-host.log');
  try {
    fs.writeFileSync(file, logs.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.line}`).join('\n'), 'utf8');
    return file;
  } catch {
    return null;
  }
}

function runDsh(args, { onLine, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const useLocal = !app.isPackaged && fs.existsSync(LOCAL_DSH);
    const cmd = useLocal ? 'node' : 'npx.cmd';
    const argv = useLocal ? [LOCAL_DSH, ...args] : ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`, ...args];
    log(`[exec] ${cmd} ${argv.join(' ')}`);
    const p = spawn(cmd, argv, {
      cwd: os.homedir(),
      windowsHide: true,
      env: dshEnv(),
      shell: !useLocal && process.platform === 'win32'
    });
    let out = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -1, out, timeout: true }); }, timeoutMs);
    const pump = (buf) => {
      const text = buf.toString();
      out += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) { log(line, 'dsh'); if (onLine) onLine(line); }
    };
    p.stdout.on('data', pump);
    p.stderr.on('data', pump);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    p.on('error', (e) => { clearTimeout(timer); log(e.message, 'error'); resolve({ code: -1, out, error: e.message }); });
  });
}

function dshEnv() {
  const env = Object.assign({}, process.env, { DSH_HOME, NO_COLOR: '1' });
  // 让 bundle 里的 gh 使用宿主自己的账号目录：用户不必碰 ~/.config/gh
  if (config.ghConfigDir) env.GH_CONFIG_DIR = config.ghConfigDir;
  // 分配给 agent 的 SSH 密钥：执行器的 git/ssh 自动使用
  if (sshVault) Object.assign(env, sshVault.env());
  // 分配给 agent 的局域网服务器：lan 助手上 PATH + 凭据文件位置
  if (serverVault) Object.assign(env, serverVault.env(LAN_BIN_DIR()));
  return env;
}

/* ------------------------------ 局域网服务器库 ------------------------------ */

const LAN_BIN_DIR = () => path.join(app.getPath('userData'), 'lan', 'bin');
let serverVault = null;
function ensureServers() {
  if (serverVault) return serverVault;
  serverVault = new ServerVault({
    dir: path.join(app.getPath('userData'), 'lan'),
    encrypt: (t) => encryptPayload(t),
    decrypt: (p) => decryptToken(p),
    log: (l) => log('[lan] ' + l),
    onChange: () => { if (win && !win.isDestroyed()) win.webContents.send('servers:update', serverVault.list()); }
  });
  return serverVault;
}

/** 把 lan 助手铺到 userData/lan/bin（lan.cmd 用 ELECTRON_RUN_AS_NODE 跑自带 node）。 */
function ensureLanHelper() {
  const dir = LAN_BIN_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const src = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'lan-helper.js')
    : path.join(__dirname, '..', 'scripts', 'lan-helper.js');
  fs.copyFileSync(src, path.join(dir, 'lan-helper.js'));
  const cmd = '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"' + process.execPath + '" "%~dp0lan-helper.js" %*\r\n';
  fs.writeFileSync(path.join(dir, 'lan.cmd'), cmd, 'utf8');
}

/** 分配变化后：同步凭据文件 + 把服务器清单写进 agent 技能（无密码）。 */
async function syncServerSkill() {
  ensureLanHelper();
  ensureServers().syncAssigned();
  if (phase !== 'running') return;
  try {
    const view = await apiGet('prompts');
    const cfg = JSON.parse(JSON.stringify(view.current.config));
    const text = serverVault.skillText();
    cfg.skills = cfg.skills || {};
    if (text) cfg.skills['lan-servers'] = text;
    else delete cfg.skills['lan-servers'];
    if (JSON.stringify(cfg) !== JSON.stringify(view.current.config)) {
      log(`[lan] 同步技能：baseRevision=${view.current.revision}，skills=${Object.keys(cfg.skills || {}).join(',')}`);
      await apiPut('prompts', cfg, view.current.revision);
      log('[lan] 已更新 agent 的 lan-servers 技能');
    }
  } catch (e) { log('[lan] 同步技能失败：' + e.message, 'error'); }
}

/* ------------------------------- SSH 密钥库 ------------------------------- */

let sshVault = null;
function ensureSsh() {
  if (sshVault) return sshVault;
  sshVault = new SshVault({
    dir: path.join(app.getPath('userData'), 'ssh'),
    encrypt: (t) => encryptPayload(t),
    decrypt: (p) => decryptToken(p),
    log: (l) => log('[ssh] ' + l),
    onChange: () => { if (win && !win.isDestroyed()) win.webContents.send('ssh:update', sshVault.list()); }
  });
  return sshVault;
}

/* ------------------------------ provisioning ------------------------------ */

function ensurePatch() {
  const file = path.join(PROFILE_DIR, 'cordis.patch.yml');
  if (!fs.existsSync(PROFILE_DIR)) return { written: false, reason: 'profile 不存在' };
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]';
  const needsWeb = !/^\s*-\s*id:\s*webserver\s*$/m.test(text);
  const needsSA = !/^\s*-\s*id:\s*dsh-superagent\s*$/m.test(text);
  if (!needsWeb && !needsSA) return { written: false, reason: '已存在' };

  const backup = `${file}.bak-${Date.now()}`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '[]');
  if (needsWeb) {
    lines.push('# SuperAgent 宿主：控制面板端口', '- id: webserver', '  config:', '    host: 127.0.0.1', `    port: ${PORT}`);
  }
  if (needsSA) {
    lines.push('# SuperAgent 宿主：bundle 的状态目录（Windows 绝对路径）', '- id: dsh-superagent', '  config:', `    stateDir: '${STATE_DIR}'`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n').trimEnd() + '\n', 'utf8');
  log(`已更新 ${file}（备份 ${path.basename(backup)}）`);
  return { written: true, backup };
}

async function ensureProfile() {
  if (fs.existsSync(path.join(PROFILE_DIR, 'cordis.yml'))) return true;
  phase = 'preparing';
  log('创建 profile：superagent（来自 web 模板）');
  await runDsh([PROFILE, '--from-default-profile', 'web', '--dump-config'], { timeoutMs: 240000 });
  if (!fs.existsSync(path.join(PROFILE_DIR, 'cordis.yml'))) {
    errorText = '创建 superagent profile 失败，请查看日志。';
    return false;
  }
  return true;
}

function bundleInstalled() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'));
    const dep = (pkg.dependencies && pkg.dependencies['dsh-superagent']) || '';
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
    return norm(dep).includes(norm(BUNDLE_DIR)) || norm(dep).includes('bundles/dsh-superagent');
  } catch { return false; }
}

async function ensureBundle() {
  if (bundleInstalled()) return true;
  if (!fs.existsSync(path.join(BUNDLE_DIR, 'package.json'))) {
    errorText = `找不到内置 bundle：${BUNDLE_DIR}`;
    log(errorText, 'error');
    return false;
  }
  // dsh 对本地路径一律 link，而 pnpm 跨盘 symlink 层级有 bug：
  // 手动把 bundle copy 进 profile/node_modules，依赖写 file: 协议，再让 dsh reconcile
  try {
    const staged = path.join(DSH_HOME, 'bundles', 'dsh-superagent');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.cpSync(BUNDLE_DIR, staged, { recursive: true });
    const nm = path.join(PROFILE_DIR, 'node_modules', 'dsh-superagent');
    fs.rmSync(nm, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(nm), { recursive: true });
    fs.cpSync(staged, nm, { recursive: true });
    const pkgFile = path.join(PROFILE_DIR, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies['dsh-superagent'] = 'file:' + staged.replace(/\\/g, '/');
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    if (!bundles.includes('dsh-superagent')) bundles.push('dsh-superagent');
    pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {}; pkg.dsh.profile.bundles = bundles;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2), 'utf8');
  } catch (e) { log('预置 bundle 失败：' + e.message, 'error'); }
  log('安装 dsh-superagent bundle 到 superagent profile…');
  const r = await runDsh(['plugin', '--profile', PROFILE, 'add', 'file:' + path.join(DSH_HOME, 'bundles', 'dsh-superagent').replace(/\\/g, '/')], { timeoutMs: 300000 });
  if (r.code !== 0 || !bundleInstalled()) {
    errorText = '安装 dsh-superagent bundle 失败（日志里有 pnpm 的原始输出）。';
    log(errorText, 'error');
    return false;
  }
  return true;
}

/* -------------------------------- 进程 -------------------------------- */

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

async function waitPortFree(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await portOpen(PORT))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !(await portOpen(PORT));
}

/**
 * bundle 用 stateDir 旁的 <profile>.lock 目录做单实例锁。
 * 上一次被强杀（任务管理器 / 断电）会留下这个目录，下一次 bundle 就整个不激活，
 * 表现为 dsh 起来了但 /orchestrator/api 全 404。端口没人听就说明锁是死的，清掉。
 */
async function clearStaleLock() {
  const lock = path.join(DSH_HOME, 'state', `${PROFILE}.lock`);
  if (!fs.existsSync(lock)) return false;
  if (await portOpen(PORT)) return false; // 有人在用，别动
  try {
    fs.rmSync(lock, { recursive: true, force: true });
    log('清理残留的状态目录锁：' + lock);
    return true;
  } catch (e) {
    log('清理锁失败：' + e.message, 'error');
    return false;
  }
}

/** 等编排 API 真的活过来（bundle 激活成功），而不是只有一个 Web 端口。 */
async function waitOrchestrator(ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const st = await apiGet('state');
      if (st && st.health) return st;
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

async function start() {
  if (child) return { ok: true, already: true };
  phase = 'preparing';
  errorText = '';
  url = null;
  emit();

  const okProfile = await ensureProfile();
  if (!okProfile) { phase = 'error'; emit(); return { ok: false, error: errorText }; }
  ensurePatch();
  const okBundle = await ensureBundle();
  if (!okBundle) { phase = 'error'; emit(); return { ok: false, error: errorText }; }

  if (!(await waitPortFree())) {
    errorText = `端口 ${PORT} 仍被占用：可能有上一次残留的 dsh 进程。关掉它再启动。`;
    log(errorText, 'error');
    phase = 'error';
    emit();
    return { ok: false, error: errorText };
  }
  await clearStaleLock();

  phase = 'starting';
  startedAt = Date.now();
  emit();
  log(`启动 DSH profile=${PROFILE} port=${PORT}`);

  const useLocal = !app.isPackaged && fs.existsSync(LOCAL_DSH);
  const cmd = useLocal ? 'node' : 'npx.cmd';
  const argv = useLocal
    ? [LOCAL_DSH, '--profile', PROFILE, '--no-open']
    : ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`, '--profile', PROFILE, '--no-open'];

  child = spawn(cmd, argv, {
    cwd: os.homedir(),
    windowsHide: true,
    env: dshEnv(),
    shell: !useLocal && process.platform === 'win32'
  });
  const spawnedAt = Date.now();

  const pump = (buf) => {
    const text = buf.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      log(line, 'dsh');
      const m = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/);
      if (m && !url) {
        url = m[1];
        log('DSH Web UI 就绪：' + url);
        phase = 'running';
        emit();
        if (win && !win.isDestroyed()) win.webContents.send('host:url', url);
      }
    }
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);
  child.on('close', (code) => {
    log(`dsh 进程退出 code=${code}`, code === 0 ? 'info' : 'error');
    const wasRunning = phase === 'running';
    child = null;
    url = null;
    phase = 'idle';
    if (wasRunning && code !== 0) { phase = 'error'; errorText = `dsh 退出（code ${code}），查看日志。`; }
    emit();
  });
  child.on('error', (e) => {
    log('无法启动 dsh：' + e.message, 'error');
    phase = 'error';
    errorText = '无法启动 dsh：' + e.message;
    child = null;
    emit();
  });

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && phase !== 'running' && child) {
    await new Promise((r) => setTimeout(r, 600));
  }
  if (phase !== 'running') {
    if (child) { errorText = 'dsh 180 秒内没有给出 Web URL，查看日志。'; phase = 'error'; log(errorText, 'error'); emit(); }
    else if (!errorText) { errorText = 'dsh 启动后立即退出。'; phase = 'error'; emit(); }
    return { ok: false, error: errorText };
  }
  log(`就绪，用时 ${Math.round((Date.now() - spawnedAt) / 1000)}s`);
  // Web 端口起来不代表 bundle 激活成功：锁残留时 bundle 会整个不加载。
  const st = await waitOrchestrator(25000);
  if (!st) {
    errorText = '编排接口没有响应：bundle 可能没有激活（状态目录锁残留 / 端口被占）。';
    log(errorText, 'error');
    emit();
    return { ok: false, error: errorText };
  }
  lastState = st;
  emit();
  startEvolutionLoop();
  ensureEvolution().tick({ force: true }).catch(() => {});
  startReviewLoop();
  ensureReview().tick().catch(() => {});
  syncServerSkill().catch(() => {});
  return { ok: true, url };
}

function stop() {
  const p = child;
  if (!p) { phase = 'idle'; url = null; emit(); return Promise.resolve({ ok: true }); }
  log('停止 dsh…');
  const pid = p.pid;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else p.kill('SIGTERM');
  } catch (e) { log('停止失败：' + e.message, 'error'); }
  child = null;
  url = null;
  phase = 'idle';
  startedAt = null;
  lastState = null;
  stopEvolutionLoop();
  stopReviewLoop();
  emit();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve({ ok: true }); };
    p.once('close', finish);
    setTimeout(finish, 8000);
  });
}

/* --------------------------------- 编排 API --------------------------------- */

function base() { return `http://127.0.0.1:${PORT}`; }

async function apiGet(p) {
  const res = await fetch(`${base()}/orchestrator/api/${p}`, {
    headers: { 'x-orchestrator-request': '1', accept: 'application/json' }
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${p} ${res.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}

async function apiPut(p, value, revision) {
  // prompts 端点的 body 形状是 {config, baseRevision}；settings 端点是 {value, revision}
  const body = p === 'prompts' ? { config: value, baseRevision: revision } : { value, revision };
  const res = await fetch(`${base()}/orchestrator/api/${p}`, {
    method: 'PUT',
    headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${p} ${res.status}: ${json.error || JSON.stringify(json.issues || json).slice(0, 300)}`);
  return json;
}

async function apiPost(p, body) {
  const res = await fetch(`${base()}/orchestrator/api/${p}`, {
    method: 'POST',
    headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${p} ${res.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}

async function readState() {
  if (phase !== 'running') return null;
  try {
    const st = await apiGet('state');
    lastState = st;
    emit();
    return st;
  } catch {
    return null;
  }
}

async function waitHealthy(ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const st = await apiGet('state');
      if (st && st.health && st.health.runtime) return st;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * 把「已连接」的事实落到 bundle 的三块配置里：
 *   Source:github（仓库 + gh 路径）→ Policy（允许的人）→ Executor（工作目录 / prepare）
 */
async function applySetup(payload = {}) {
  if (phase !== 'running') throw new Error('宿主未运行');
  const settings = await apiGet('settings');
  const results = [];
  const gh = (settings.sources || []).find((s) => s.id === 'github');

  const repository = String(payload.repository ?? config.repository ?? '').trim();
  const cli = String(payload.cli ?? config.ghCli ?? '').trim();
  if (repository) {
    const value = {
      enabled: true,
      config: Object.assign({}, (gh && gh.value && gh.value.config) || {}, {
        repository, cli,
        // agent 账号不会自动 watch 仓库，通知流收不到自己仓库的议题；直接观察议题/评论流
        observeIssues: true, observeComments: true
      })
    };
    const r = await apiPut('settings/source:github', value, gh ? gh.revision : 0);
    results.push({ step: 'source:github', ...r });
    config.repository = repository;
    if (cli) config.ghCli = cli;
  }

  if (Array.isArray(payload.allowed)) {
    const allowed = payload.allowed.filter(Boolean).map((id) => ({ id: String(id).trim() }));
    const block = settings.blocks.policy;
    const value = JSON.parse(JSON.stringify(block.value || {}));
    value.sources = value.sources || {};
    value.sources.github = Object.assign({}, value.sources.github || {}, { allowed });
    const r = await apiPut('settings/policy', value, block.revision);
    results.push({ step: 'policy', ...r });
    config.allowed = allowed.map((a) => a.id);
  }

  // 分配了局域网服务器 → 给 Policy 加运维授权规则（只放行已存凭据的服务器）
  if (serverVault && serverVault.list().assignedIds.length) {
    const block = (await apiGet('settings')).blocks.policy;
    const value = JSON.parse(JSON.stringify(block.value || {}));
    value.rules = value.rules || [];
    if (!value.rules.some((r) => r.id === 'lan-ops')) {
      value.rules.push({
        id: 'lan-ops',
        name: 'LAN server maintenance',
        enabled: true,
        instruction: 'Explicit requests to inspect or maintain the LAN servers whose credentials are stored and assigned in this installation (see the lan-servers skill). Use the lan helper; never ask for or print passwords. Prefer read-only inspection first; destructive or service-affecting commands must be named in the ticket report.'
      });
      const r = await apiPut('settings/policy', value, block.revision);
      results.push({ step: 'policy:lan-ops', ...r });
    }
  }

  const dir = payload.directory ?? config.directory;
  const prepare = payload.prepare ?? config.prepare;
  const needsExecutor = payload.directory !== undefined || payload.prepare !== undefined;
  if (needsExecutor) {
    const block = settings.blocks.executor;
    const value = Object.assign({}, block.value || {});
    if (payload.directory !== undefined) value.directory = String(dir || '').trim();
    if (payload.prepare !== undefined) value.prepare = String(prepare || '');
    const r = await apiPut('settings/executor', value, block.revision);
    results.push({ step: 'executor', ...r });
    config.directory = payload.directory === undefined ? config.directory : String(dir || '');
    config.prepare = payload.prepare === undefined ? config.prepare : String(prepare || '');
  }

  saveConfig();

  const restarting = results.some((r) => r && r.restarting);
  if (restarting) {
    log('配置已保存，dsh-superagent 正在重启…');
    await new Promise((r) => setTimeout(r, 2500));
    await waitHealthy(120000);
  }
  return { results, restarting };
}

/* --------------------------------- GitHub --------------------------------- */

/**
 * 网络一律走 Chromium 栈（Electron 的 net），它能吃环境里的 HTTP(S)_PROXY。
 * Node 自带的 fetch 不读代理，很多机器上直连 github.com 是超时的。
 */
function applySystemProxy() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return;
  try {
    const u = new URL(raw);
    const host = u.host;
    session.defaultSession.setProxy({ proxyRules: `http=${host};https=${host}` })
      .then(() => log('已按环境变量设置代理：' + host))
      .catch((e) => log('设置代理失败：' + e.message, 'error'));
  } catch (e) {
    log('HTTP(S)_PROXY 格式不认识：' + raw, 'error');
  }
}

async function ghHttp(url, { method = 'GET', headers = {}, body } = {}) {
  const opts = { method, headers: Object.assign({ 'User-Agent': 'SuperAgent', accept: 'application/json' }, headers) };
  if (body) opts.body = body;
  const res = await net.fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status} ${text.slice(0, 120)}`);
  return json;
}

function netDownload(url, dest, onPct) {  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', 'SuperAgent');
    req.on('response', (res) => {
      if (res.statusCode >= 400) return reject(new Error('下载失败：HTTP ' + res.statusCode));
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total) onPct(Math.round((got / total) * 95));
        out.write(chunk);
      });
      res.on('end', () => out.end(() => resolve(dest)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), ms))
  ]);
}

/* ── 宿主自己的 GitHub 账号（令牌只用来做登录、选仓库、回帖） ── */

let authToken = '';
const AUTH_FILE = () => path.join(app.getPath('userData'), 'auth.json');
// 发单人（人）与 agent 双身份：auth.json 存发单人，agent-auth.json 存 agent。
// bundle 的 gh 用 agent-auth；宿主回帖/开议题用发单人 token（bundle 只认人的消息）。
const AGENT_AUTH_FILE = () => path.join(app.getPath('userData'), 'agent-auth.json');
let posterToken = '';
let posterLogin = '';
let agentToken = '';
let agentLogin = '';

function saveAuth(login, token) {
  authToken = token || '';
  try {
    fs.writeFileSync(AUTH_FILE(), JSON.stringify({ login, token: encryptPayload(token), at: Date.now() }), 'utf8');
  } catch (e) { log('保存登录信息失败：' + e.message, 'error'); }
}

function decryptToken(payload) {
  return String(payload || '').startsWith('enc:')
    ? safeStorage.decryptString(Buffer.from(String(payload).slice(4), 'base64'))
    : Buffer.from(String(payload || '').replace(/^plain:/, ''), 'base64').toString('utf8');
}

function loadAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf8'));
    posterToken = decryptToken(j.token);
    posterLogin = j.login || '';
    authToken = posterToken;
  } catch { posterToken = ''; posterLogin = ''; authToken = ''; }
  try {
    const a = JSON.parse(fs.readFileSync(AGENT_AUTH_FILE(), 'utf8'));
    agentToken = decryptToken(a.token);
    agentLogin = a.login || '';
  } catch { agentToken = ''; agentLogin = ''; }
  // 旧版本单身份遗留：auth.json 里若是 agent，归位到 agent 槽，发单人待登录
  const inAllowed = (l) => (config.allowed || []).some((x) => String(x).toLowerCase() === String(l).toLowerCase());
  if (posterLogin && !inAllowed(posterLogin) && agentLogin && posterLogin.toLowerCase() === agentLogin.toLowerCase()) {
    posterLogin = ''; posterToken = ''; authToken = '';
  }
  return posterLogin ? { login: posterLogin, token: posterToken } : null;
}

/** 把 agent 身份写进 bundle 用的 gh-config（不动发单人 auth）。 */
function writeAgentToGhConfig() {
  if (!agentLogin || !agentToken) return false;
  writeHostsYml(agentLogin, agentToken);
  return true;
}

/** 登录成功后的角色分流：授权人=发单人，其余=agent。 */
function assignAuthRole(login, token) {
  const isPoster = (config.allowed || []).some((a) => String(a).toLowerCase() === String(login).toLowerCase());
  if (isPoster) {
    posterLogin = login; posterToken = token; authToken = token;
    saveAuth(login, token);
  } else {
    agentLogin = login; agentToken = token;
    try { fs.writeFileSync(AGENT_AUTH_FILE(), JSON.stringify({ login, token: encryptPayload(token), at: Date.now() }), 'utf8'); } catch (e) { log('保存 agent 登录失败：' + e.message, 'error'); }
  }
  if (agentLogin && agentToken) writeAgentToGhConfig();
}

function encryptPayload(token) {
  return safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(token).toString('base64')
    : 'plain:' + Buffer.from(token, 'utf8').toString('base64');
}

function clearAuth() {
  authToken = '';
  try { fs.rmSync(AUTH_FILE(), { force: true }); } catch {}
}

async function githubApi(p, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/vnd.github+json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (body) headers['content-type'] = 'application/json';
  return ghHttp('https://api.github.com' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

const gh = {
  install: { running: false, pct: 0, msg: '', error: '' },
  auth: { pending: false, userCode: '', verificationUri: '', expiresAt: 0, error: '', login: '' }
};

function emitGh() {
  if (win && !win.isDestroyed()) win.webContents.send('gh:update', ghSnapshot());
}

function ghSnapshot() {
  return {
    installed: !!findGh(),
    path: findGh() || '',
    configDir: config.ghConfigDir,
    login: gh.auth.login,
    agentLogin,
    posterLogin,
    install: { ...gh.install },
    auth: { ...gh.auth }
  };
}

function findGh() {
  const candidates = [
    config.ghCli,
    path.join(TOOLS(), 'gh', 'bin', 'gh.exe'),
    path.join(TOOLS(), 'gh.exe'),
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'GitHubCLI', 'bin', 'gh.exe')
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  // PATH 里找
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, 'gh.exe');
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return '';
}

function ghEnv() {
  return Object.assign({}, process.env, {
    GH_CONFIG_DIR: config.ghConfigDir,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1'
  });
}

function runGh(args, { input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const bin = findGh();
    if (!bin) return resolve({ code: -1, out: '', err: '找不到 gh CLI' });
    const p = spawn(bin, args, { windowsHide: true, env: ghEnv() });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -1, out, err: 'timeout' }); }, timeoutMs);
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { err += b.toString(); });
    if (input) { p.stdin.write(input); p.stdin.end(); }
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
  });
}

async function ghIdentity() {
  if (authToken) {
    try {
      const user = await githubApi('/user');
      gh.auth.login = user && user.login ? user.login : '';
      emitGh();
      return { installed: !!findGh(), login: gh.auth.login };
    } catch {}
  }
  if (!findGh()) { gh.auth.login = ''; return { installed: false, login: '' }; }
  const r = await runGh(['api', 'user', '--jq', '.login'], { timeoutMs: 20000 });
  const login = r.code === 0 ? r.out.trim() : '';
  gh.auth.login = login;
  if (login) config.ghCli = findGh();
  return { installed: true, login };
}

async function downloadGh() {
  if (gh.install.running) return { ok: false, error: '正在安装' };
  gh.install = { running: true, pct: 0, msg: '查询最新版本…', error: '' };
  emitGh();
  try {
    const info = await ghHttp('https://api.github.com/repos/cli/cli/releases/latest', {
      headers: { accept: 'application/vnd.github+json' }
    });
    const asset = (info.assets || []).find((a) => /windows_amd64\.zip$/i.test(a.name));
    if (!asset) throw new Error('没有找到 windows_amd64.zip 资产');
    gh.install.msg = '下载 gh ' + info.tag_name;
    emitGh();

    const tmpDir = path.join(os.tmpdir(), `gh-dl-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const zip = path.join(tmpDir, 'gh.zip');
    const urls = [
      asset.browser_download_url,
      'https://ghfast.top/' + asset.browser_download_url,
      'https://ghproxy.net/' + asset.browser_download_url,
      'https://mirror.ghproxy.com/' + asset.browser_download_url
    ];
    let lastErr = null;
    let got = null;
    for (const u of urls) {
      try {
        await withTimeout(netDownload(u, zip, (pct) => { gh.install.pct = pct; emitGh(); }), 120000);
        got = u;
        break;
      } catch (e) {
        lastErr = e;
        log('下载源失败：' + u + ' → ' + e.message, 'error');
        gh.install.msg = '换一个下载源…';
        gh.install.pct = 0;
        emitGh();
      }
    }
    if (!got) {
      throw new Error('连不上下载源（' + (lastErr && lastErr.message) + '）。可以点「选择已有的 gh.exe」，或换网络后重试。');
    }

    gh.install.msg = '解压…';
    gh.install.pct = 96;
    emitGh();
    const outDir = path.join(tmpDir, 'x');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${outDir}' -Force`], { windowsHide: true });
    await new Promise((r) => ps.on('close', r));

    const found = findFile(outDir, 'gh.exe');
    if (!found) throw new Error('解压后没有 gh.exe');
    const target = path.join(TOOLS(), 'gh');
    fs.mkdirSync(target, { recursive: true });
    // 保留 bin 目录结构（gh.exe 依赖同目录的 dll 时更稳妥）
    fs.cpSync(path.dirname(found), path.join(target, 'bin'), { recursive: true });
    config.ghCli = path.join(target, 'bin', 'gh.exe');
    saveConfig();
    gh.install = { running: false, pct: 100, msg: '已安装', error: '' };
    emitGh();
    log('gh CLI 已安装：' + config.ghCli);
    await ghIdentity();
    emitGh();
    return { ok: true, cli: config.ghCli };
  } catch (e) {
    gh.install = { running: false, pct: 0, msg: '', error: e.message };
    emitGh();
    log('安装 gh 失败：' + e.message, 'error');
    return { ok: false, error: e.message };
  }
}

function findFile(dir, name) {
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let items;
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(cur, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (it.name.toLowerCase() === name.toLowerCase()) return p;
    }
  }
  return '';
}

function writeHostsYml(login, token) {
  fs.mkdirSync(config.ghConfigDir, { recursive: true });
  const yml = [
    'github.com:',
    '    git_protocol: https',
    `    user: ${login}`,
    '    users:',
    `        ${login}: {}`,
    `    oauth_token: ${token}`,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(config.ghConfigDir, 'hosts.yml'), yml, { mode: 0o600 });
  const cfgYml = ['version: "1"', 'git_protocol: https', 'prompt: enabled', 'pager: cat', 'browser: ""', 'color_labels: disabled', 'accessible_colors: disabled', 'spinner: enabled', ''].join('\n');
  fs.writeFileSync(path.join(config.ghConfigDir, 'config.yml'), cfgYml, { mode: 0o600 });
}

let authPoll = null;

function cancelAuth() {
  if (authPoll) { clearTimeout(authPoll); authPoll = null; }
  gh.auth.pending = false;
  emitGh();
}

async function startDeviceFlow() {
  if (gh.auth.pending) return ghSnapshot();
  gh.auth = { pending: true, userCode: '', verificationUri: '', expiresAt: 0, error: '', login: '' };
  emitGh();
  try {
    const data = await ghHttp('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId || GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }).toString()
    });
    if (!data || !data.device_code) throw new Error((data && (data.error_description || data.error)) || '无法获取设备码');
    gh.auth.userCode = data.user_code;
    gh.auth.verificationUri = data.verification_uri;
    gh.auth.expiresAt = Date.now() + (data.expires_in || 900) * 1000;
    emitGh();
    // 浏览器自动打开，并带上一次性代码
    shell.openExternal(`${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`);
    pollDevice(data.device_code, data.interval || 5);
    return ghSnapshot();
  } catch (e) {
    gh.auth = { pending: false, userCode: '', verificationUri: '', expiresAt: 0, error: e.message, login: '' };
    emitGh();
    return ghSnapshot();
  }
}

function pollDevice(deviceCode, interval) {
  const tick = async () => {
    if (!gh.auth.pending) return;
    if (Date.now() > gh.auth.expiresAt) {
      gh.auth.pending = false;
      gh.auth.error = '一次性代码已过期，请重新登录。';
      emitGh();
      return;
    }
    try {
      const res = await net.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'User-Agent': 'SuperAgent', accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId || GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        }).toString()
      });
      const text = await res.text();
      let data = {};
      try { data = JSON.parse(text); } catch { data = { error: 'bad response' }; }
      if (data.access_token) {
        const user = await ghHttp('https://api.github.com/user', {
          headers: { authorization: `Bearer ${data.access_token}`, accept: 'application/vnd.github+json' }
        }).catch(() => ({}));
        const login = user.login || 'github-user';
        assignAuthRole(login, data.access_token);
        gh.auth.pending = false;
        gh.auth.login = login;
        gh.auth.userCode = '';
        emitGh();
        log(`GitHub 已连接：@${login}`);
        await ghIdentity();
        if (!config.allowed.length) { config.allowed = [login]; saveConfig(); }
        emitGh();
        return;
      }
      if (data.error === 'slow_down') interval += 5;
      if (data.error && !['authorization_pending', 'slow_down'].includes(data.error)) {
        gh.auth.pending = false;
        gh.auth.error = data.error === 'access_denied' ? '授权被拒绝。' : (data.error_description || data.error);
        emitGh();
        return;
      }
    } catch (e) {
      gh.auth.error = e.message;
    }
    authPoll = setTimeout(tick, interval * 1000);
  };
  authPoll = setTimeout(tick, interval * 1000);
}

async function loginWithToken(token) {
  try {
    const user = await ghHttp('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
    });
    if (!user || !user.login) throw new Error('token 无效');
    assignAuthRole(user.login, token);
    gh.auth.login = user.login;
    emitGh();
    await ghIdentity();
    if (!config.allowed.length) { config.allowed = [user.login]; saveConfig(); }
    emitGh();
    return { ok: true, login: user.login };
  } catch (e) {
    gh.auth.error = e.message;
    emitGh();
    return { ok: false, error: e.message };
  }
}

async function listRepos() {
  if (!authToken) {
    const g = await runGh(['api', 'user', '--jq', '.login'], { timeoutMs: 20000 });
    if (g.code !== 0) return { ok: false, error: '先登录 GitHub' };
  }
  try {
    const items = await githubApi('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    return {
      ok: true,
      items: (items || []).map((r) => ({ name: r.full_name, private: r.private, description: r.description, pushed_at: r.pushed_at }))
    };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

async function logoutGithub() {
  // 只清 agent 身份；发单人 token 保留（开议题/回帖还要用）
  agentLogin = ''; agentToken = '';
  try { fs.rmSync(AGENT_AUTH_FILE(), { force: true }); } catch {}
  try { fs.rmSync(path.join(config.ghConfigDir, 'hosts.yml'), { force: true }); } catch {}
  gh.auth.login = '';
  emitGh();
  return { ok: true };
}

/* 协作者授权：检测 agent 对仓库的权限；用发单人身份发 Write 邀请。 */
async function collabStatus() {
  const repo = String(config.repository || '').trim();
  const agent = agentLogin || gh.auth.login || '';
  if (!repo || !agent) return { ok: false, error: '先选仓库并登录 agent' };
  if (!posterToken) return { ok: false, error: '需要发单人登录（仓库 owner）才能检测/邀请' };
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/collaborators/${agent}/permission`, {
      headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${posterToken}` }
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${j.message || ''}`.slice(0, 200) };
    return { ok: true, permission: j.permission, agent, repo };
  } catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}

async function collabInvite() {
  const repo = String(config.repository || '').trim();
  const agent = agentLogin || gh.auth.login || '';
  if (!repo || !agent) return { ok: false, error: '先选仓库并登录 agent' };
  if (!posterToken) return { ok: false, error: '需要发单人登录（仓库 owner）才能发邀请' };
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/collaborators/${agent}`, {
      method: 'PUT',
      headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${posterToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ permission: 'push' })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${j.message || ''}`.slice(0, 200) };
    log(`已向 @${agent} 发出 ${repo} 的 Write 协作者邀请`);
    return { ok: true, state: j.state || 'invited', url: j.html_url || `https://github.com/${repo}/invitations` };
  } catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}

/** 接收已有议题：bundle 的读取基线（github-since / 观察流 started）只往前走，
 *  开关观察流不会重置。这里停引擎 → 把基线回拨 → 起引擎，让现有开放议题进入接收范围。 */
async function resyncIssues() {
  const back = new Date(Date.now() - 7 * 86400000).toISOString();
  const wasRunning = phase === 'running';
  if (wasRunning) await stop();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(STATE_DIR, 'orchestrator.sqlite'));
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
    db.close();
    log('已回拨议题读取基线 7 天：现有开放议题将被接收');
  } catch (e) {
    log('重置读取基线失败：' + e.message, 'error');
    if (wasRunning) await start();
    return { ok: false, error: e.message };
  }
  if (wasRunning) {
    const r = await start();
    return { ok: !!r.ok, error: r.error };
  }
  return { ok: true };
}

/** 在会话页直接派活：以发单人身份开议题并 @ agent。 */
async function createIssue(title, body) {
  const repo = String(config.repository || '').trim();
  if (!repo) return { ok: false, error: '先在接入页选一个仓库' };
  if (!posterToken) return { ok: false, error: '需要发单人登录：接入页用授权人账号（如 wangtangning）登录一次' };
  const agent = agentLogin || gh.auth.login || '';
  const text = `@${agent} ${String(body || '').trim()}`.trim();
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'User-Agent': 'SuperAgent',
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${posterToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ title: String(title || '').trim() || '新任务', body: text })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${j.message || ''}`.slice(0, 300) };
    log(`已以 @${posterLogin} 开议题 ${repo}#${j.number} 派活给 @${agent}`);
    return { ok: true, url: j.html_url, number: j.number };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  }
}

/** 在会话的 GitHub 议题/PR 下替人发一条评论：窗口里的输入框就是回复入口。 */
async function postComment(threadUrl, text) {
  const m = String(threadUrl || '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i);
  if (!m) return { ok: false, error: '这个会话不在 GitHub 议题上，请到来源里回复。' };
  const [, owner, repo, , num] = m;
  if (authToken) {
    try {
      const created = await githubApi(`/repos/${owner}/${repo}/issues/${num}/comments`, { method: 'POST', body: { body: text } });
      log(`已回复 ${owner}/${repo}#${num}（REST）`);
      return { ok: true, url: (created && created.html_url) || '' };
    } catch (e) {
      return { ok: false, error: e.message.slice(0, 300) };
    }
  }
  const r = await runGh(['api', `repos/${owner}/${repo}/issues/${num}/comments`, '-f', `body=${text}`], { timeoutMs: 45000 });
  if (r.code !== 0) return { ok: false, error: (r.err || r.out || '发送失败').slice(0, 400) };
  let created = {};
  try { created = JSON.parse(r.out); } catch {}
  log(`已回复 ${owner}/${repo}#${num}`);
  return { ok: true, url: created.html_url || '' };
}

/* ------------------------------ 自我进化引擎 ------------------------------ */

let evolution = null;
let evolutionTimer = null;

function ensureEvolution() {
  if (evolution) return evolution;
  const store = new EvolutionStore(path.join(app.getPath('userData'), 'evolution'));
  evolution = new EvolutionEngine({
    api: {
      get: (p) => apiGet(p),
      put: (p, body) => apiPut(p, body.value, body.revision),
      post: (p, body) => apiPost(p, body)
    },
    store,
    log: (line, level) => log(line, level),
    isRunning: () => phase === 'running',
    onChange: () => emitEvolution()
  });
  store.log('进化引擎已装载');
  return evolution;
}

function emitEvolution() {
  if (!evolution || !win || win.isDestroyed()) return;
  try { win.webContents.send('evolution:update', evolution.snapshot()); } catch {}
}

function startEvolutionLoop() {
  if (evolutionTimer) return;
  // 每 30s 尝试一轮；引擎内部按 collectIntervalMs 自行节流
  evolutionTimer = setInterval(() => {
    if (phase !== 'running') return;
    ensureEvolution().tick().catch((e) => log('[evolution] tick 失败：' + e.message, 'error'));
  }, 30000);
}

function stopEvolutionLoop() {
  if (evolutionTimer) { clearInterval(evolutionTimer); evolutionTimer = null; }
}

/* ------------------------------- 评审 agent ------------------------------- */

let reviewAgent = null;
let reviewTimer = null;

function posterGh() {
  const call = async (method, p, body, accept) => {
    if (!posterToken) throw new Error('发单人未登录，评审 agent 无法操作 GitHub');
    const res = await net.fetch('https://api.github.com/' + p, {
      method,
      headers: {
        'User-Agent': 'SuperAgent',
        accept: accept || 'application/vnd.github+json',
        authorization: `Bearer ${posterToken}`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(j && j.message) || text.slice(0, 120)}`);
    return accept === 'application/vnd.github.diff' ? text : j;
  };
  return {
    get: (p, opts) => call('GET', p, null, opts && opts.accept),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b)
  };
}

function ensureReview() {
  if (reviewAgent) return reviewAgent;
  reviewAgent = new ReviewAgent({
    api: { get: (p) => apiGet(p) },
    gh: posterGh(),
    store: ensureEvolution().store,
    log: (l, lv) => log('[review] ' + l, lv),
    onChange: () => { if (win && !win.isDestroyed()) win.webContents.send('review:update', reviewAgent.settings()); }
  });
  return reviewAgent;
}

function startReviewLoop() {
  if (reviewTimer) return;
  reviewTimer = setInterval(() => {
    if (phase !== 'running') return;
    ensureReview().tick().catch((e) => log('[review] tick 失败：' + e.message, 'error'));
  }, 45000);
}
function stopReviewLoop() {
  if (reviewTimer) { clearInterval(reviewTimer); reviewTimer = null; }
}

/* --------------------------------- 快照 --------------------------------- */

function snapshot() {
  return {
    phase, url, error: errorText,
    profileDir: PROFILE_DIR,
    stateDir: STATE_DIR,
    bundleDir: BUNDLE_DIR,
    bundleInstalled: bundleInstalled(),
    port: PORT,
    dshHome: DSH_HOME,
    startedAt,
    logs: logs.slice(-300),
    state: lastState,
    hostLog: path.join(app.getPath('userData'), 'superagent-host.log'),
    config: { repository: config.repository, allowed: config.allowed, directory: config.directory, prepare: config.prepare },
    github: Object.assign(ghSnapshot(), { cliConfigured: config.ghCli }),
    project: activeProject() ? { id: activeProject().id, name: activeProject().name, folder: activeProject().folder, repo: activeProject().repo, verify: activeProject().verify } : null,
    projects: projects.projects.map((p) => ({ id: p.id, name: p.name, repo: p.repo, port: p.port }))
  };
}

function emit() {
  if (win && !win.isDestroyed()) win.webContents.send('host:state', snapshot());
}

/* -------------------------------- 窗口 -------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#07080c',
    title: 'SuperAgent',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07080c', symbolColor: '#8b97ab', height: 48 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

/* --------------------------------- ipc --------------------------------- */

ipcMain.handle('host:get', () => snapshot());
ipcMain.handle('host:start', async () => { const r = await start(); await readState(); return { ...r, state: snapshot() }; });
ipcMain.handle('host:stop', () => stop());
ipcMain.handle('host:restart', async () => { await stop(); await new Promise((r) => setTimeout(r, 1200)); const r = await start(); return r; });
ipcMain.handle('host:refresh', async () => { await readState(); return snapshot(); });
ipcMain.handle('host:api', async (_e, { path: p }) => apiGet(p));
ipcMain.handle('host:post', async (_e, { path: p, body }) => { const r = await apiPost(p, body); await readState(); return r; });
ipcMain.handle('host:put', async (_e, { path: p, value, revision }) => { const r = await apiPut(p, value, revision); await readState(); return r; });
ipcMain.handle('host:saveSetup', async (_e, payload) => { const r = await applySetup(payload); await readState(); return r; });
ipcMain.handle('host:setupCheck', async () => { const r = await apiPost('setup/check'); await waitHealthy(90000); await readState(); return r; });
ipcMain.handle('host:pause', async (_e, paused) => { const r = await apiPost('executor/pause', { paused: !!paused }); await readState(); return r; });
ipcMain.handle('host:openLog', () => { const f = writeLogFile(); return f ? shell.openPath(f) : 'no log'; });
ipcMain.handle('host:openProfile', () => shell.openPath(PROFILE_DIR));
ipcMain.handle('host:openState', () => shell.openPath(STATE_DIR));
ipcMain.handle('host:openBundle', () => shell.openPath(BUNDLE_DIR));
ipcMain.handle('host:openExternal', (_e, u) => shell.openExternal(u));
ipcMain.handle('host:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// 接入页选中仓库后立即记住（只写宿主配置，不触发 bundle 自检；保存并自检仍走 saveSetup）
ipcMain.handle('host:rememberRepo', (_e, repository) => {
  config.repository = String(repository || '').trim();
  saveConfig();
  emit();
  return { ok: true, repository: config.repository };
});
ipcMain.handle('gh:status', async () => { await ghIdentity().catch(() => {}); return ghSnapshot(); });
ipcMain.handle('gh:install', () => downloadGh());
ipcMain.handle('gh:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 gh.exe',
    properties: ['openFile'],
    filters: [{ name: 'gh.exe', extensions: ['exe'] }]
  });
  if (!r.canceled && r.filePaths[0]) {
    config.ghCli = r.filePaths[0];
    saveConfig();
    await ghIdentity().catch(() => {});
    log('使用指定的 gh：' + config.ghCli);
  }
  emitGh();
  return ghSnapshot();
});
ipcMain.handle('gh:loginStart', () => startDeviceFlow());
ipcMain.handle('gh:loginCancel', () => { cancelAuth(); return ghSnapshot(); });
ipcMain.handle('gh:tokenLogin', (_e, token) => loginWithToken(String(token || '').trim()));
ipcMain.handle('gh:repos', () => listRepos());
ipcMain.handle('gh:logout', () => logoutGithub());
ipcMain.handle('gh:openAuth', (_e, uri) => shell.openExternal(uri));
ipcMain.handle('thread:comment', (_e, { url, text }) => postComment(url, text));
ipcMain.handle('issue:create', (_e, { title, body }) => createIssue(title, body));
ipcMain.handle('collab:status', () => collabStatus());
ipcMain.handle('collab:invite', () => collabInvite());
ipcMain.handle('issues:resync', () => resyncIssues());

/* SSH 密钥库 */
ipcMain.handle('ssh:list', () => ensureSsh().list());
ipcMain.handle('ssh:generate', (_e, name) => ensureSsh().generate(name));
ipcMain.handle('ssh:import', (_e, { name, privateKey }) => ensureSsh().importKey(name, privateKey));
ipcMain.handle('ssh:remove', (_e, id) => ensureSsh().remove(String(id)));
ipcMain.handle('ssh:assign', async (_e, id) => {
  const r = ensureSsh().assign(String(id));
  if (phase === 'running') { log('[ssh] 重启引擎以注入 GIT_SSH_COMMAND…'); await stop(); await start(); }
  return r;
});
ipcMain.handle('ssh:unassign', async () => {
  const r = ensureSsh().unassign();
  if (phase === 'running') { await stop(); await start(); }
  return r;
});
ipcMain.handle('ssh:test', (_e, target) => ensureSsh().test(target));
// 把库里某把密钥的公钥登记到 agent 的 GitHub 账号（用 agent token）
ipcMain.handle('ssh:registerGithub', async (_e, id) => {
  const vault = ensureSsh();
  const key = vault.list().keys.find((k) => k.id === id);
  if (!key) return { ok: false, error: '密钥不存在' };
  if (!agentToken) return { ok: false, error: 'agent 未登录' };
  try {
    const res = await net.fetch('https://api.github.com/user/keys', {
      method: 'POST',
      headers: { 'User-Agent': 'SuperAgent', accept: 'application/vnd.github+json', authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: `superagent-${key.name}`, key: key.publicKey })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${j.message || ''}`.slice(0, 200) };
    log(`[ssh] 公钥已登记到 agent GitHub：${key.name}`);
    return { ok: true, id: j.id };
  } catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
});

/* 局域网服务器凭据库 */
ipcMain.handle('servers:list', () => ensureServers().list());
ipcMain.handle('servers:add', (_e, p) => ensureServers().add(p || {}));
ipcMain.handle('servers:remove', (_e, id) => ensureServers().remove(String(id)));
ipcMain.handle('servers:test', (_e, id) => ensureServers().test(String(id)));
ipcMain.handle('servers:assign', async (_e, id) => {
  const r = ensureServers().assign(String(id));
  await syncServerSkill();
  if (phase === 'running') { log('[lan] 重启引擎以注入 lan 助手…'); await stop(); await start(); }
  return r;
});
ipcMain.handle('servers:unassign', async (_e, id) => {
  const r = ensureServers().unassign(String(id));
  await syncServerSkill();
  if (phase === 'running') { await stop(); await start(); }
  return r;
});

/* 评审 agent */
ipcMain.handle('review:get', () => {
  const a = ensureReview();
  const s = a.settings();
  return { ...s, usingEngineKey: !s.llm && !!a.effectiveLlm() };
});
ipcMain.handle('review:settings', (_e, patch) => ensureReview().saveSettings(patch || {}));
ipcMain.handle('review:run', () => ensureReview().tick());

/* 项目框架 */
ipcMain.handle('projects:list', () => ({ activeId: projects.activeId, projects: projects.projects.map((p) => ({ ...p, running: p.id === projects.activeId && phase === 'running' })) }));
ipcMain.handle('projects:switch', (_e, id) => switchProject(String(id)));
ipcMain.handle('projects:add', (_e, p) => addProject(p || {}));
ipcMain.handle('projects:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('projects:update', (_e, { id, patch }) => {
  const p = projects.projects.find((x) => x.id === id);
  if (!p) return { ok: false, error: '项目不存在' };
  Object.assign(p, patch || {});
  saveProjects();
  return { ok: true, project: p };
});

/* 自我进化：全部走引擎，UI 只读快照 / 触发动作 */
ipcMain.handle('evolution:get', () => ensureEvolution().snapshot());
ipcMain.handle('evolution:run', async () => { const r = await ensureEvolution().runNow(); return { result: r, snapshot: evolution.snapshot() }; });
ipcMain.handle('evolution:apply', async (_e, id) => { await ensureEvolution().approveAndApply(String(id)); return evolution.snapshot(); });
ipcMain.handle('evolution:reject', (_e, { id, reason }) => { ensureEvolution().reject(String(id), reason); return evolution.snapshot(); });
ipcMain.handle('evolution:rollback', async (_e, { id, reason }) => { await ensureEvolution().rollback(String(id), reason); return evolution.snapshot(); });
ipcMain.handle('evolution:evaluate', async (_e, id) => { await ensureEvolution().evaluateNow(String(id)); return evolution.snapshot(); });
ipcMain.handle('evolution:settings', (_e, patch) => {
  const next = ensureEvolution().store.saveSettings(patch || {});
  log(`[evolution] 设置更新：${JSON.stringify(patch || {})}`);
  emitEvolution();
  return next;
});
ipcMain.handle('evolution:openDir', () => shell.openPath(ensureEvolution().store.dir));

/* --------------------------------- boot --------------------------------- */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    loadConfig();
    loadProjects();
    const act = activeProject();
    if (act && act.id !== 'p-default') {
      // 上次活跃的是非默认项目：直接切过去
      await switchProject(act.id);
    }
    applySystemProxy();
    const auth = loadAuth();
    if (auth && auth.login) gh.auth.login = auth.login;
    createWindow();
    setTimeout(async () => {
      try {
        await ensureProfile();
        ensurePatch();
        await ensureBundle();
        emit();
        if (!child) await start();
        ghIdentity().then(emitGh).catch(() => {});
      } catch (e) { log('预热失败：' + e.message, 'error'); }
    }, 700);
  });

  app.on('window-all-closed', async () => { await stop(); app.quit(); });
  app.on('before-quit', () => { stop(); });
}
